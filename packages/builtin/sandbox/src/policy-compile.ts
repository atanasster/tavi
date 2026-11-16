import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { TaviError, refusedUnixSocketFolder, type SandboxCommand, type SandboxPolicy, type SandboxProtectedNames } from "@tavi/contracts";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

/**
 * The policy compiler: the one
 * place a `SandboxPolicy` becomes srt's config, per platform. Pure but for
 * the filesystem it reads, which is a seam (`CompileFs`), so the golden
 * tests run any platform's compile on any host.
 *
 * - **macOS**: patterns and canonical paths, as `toRuntimeConfig` built them;
 *   Seatbelt matches a pattern against files created later too.
 * - **Linux**: srt ignores write-deny patterns there (srt README:461), so a
 *   protected name becomes literal paths — one at each writable root (srt
 *   mounts over it even when absent), one per existing match from a walk that
 *   never follows a symlink, and `.git`-anchored ones — bounded by
 *   bubblewrap's mount budget. A case-folding writable root is refused:
 *   a literal deny is case-exact.
 */

export type CompilePlatform = "darwin" | "linux";

/** What the compiler reads of the filesystem (tests replace it). */
export interface CompileFs {
  /** The entry's own type, never following a final symlink; undefined when absent. */
  kind(path: string): "file" | "directory" | "symlink" | "other" | undefined;
  /** A directory's entry names; undefined when it cannot be listed. */
  list(path: string): readonly string[] | undefined;
  /** A directory's entries with their own types, read in one pass; absent, `list` and `kind` answer. */
  entries?(path: string): readonly { readonly name: string; readonly kind: ReturnType<CompileFs["kind"]> }[] | undefined;
  /** A symlink's own target, as written; undefined when `path` is not one. */
  link(path: string): string | undefined;
  /** A small text file's contents; undefined when it cannot be read. */
  read(path: string): string | undefined;
  /** Where `path` resolves to, every symlink followed; undefined when it does not. */
  real(path: string): string | undefined;
  /** Whether lookups under `path` fold case (Linux: `casefold`, vfat, exFAT, NTFS, CIFS/SMB, FUSE, 9p); true when it cannot tell. */
  foldsCase(path: string): boolean;
}

/** bubblewrap's limits, shared by every read and write entry (srt README:760). */
export const MOUNT_BUDGET = 3_000;
export const ARGUMENT_BUDGET = 9_000;
/** Mounts srt adds of its own (`/proc`, `/dev`, the tmpfs, the proxy sockets, its mandatory denies). */
const SRT_RESERVED_MOUNTS = 200;
/** bubblewrap arguments per mount entry (`--ro-bind <from> <to>`). */
const ARGUMENTS_PER_MOUNT = 3;
/** A walk past this many directories is refused rather than left to slow every run. */
export const WALK_DIRECTORY_CAP = 50_000;

/**
 * A directory's entries and their types, in one read where the filesystem
 * gives them (an entry it reports no type for is asked for its own);
 * undefined when it cannot be listed.
 */
function entriesOf(fs: CompileFs, path: string): ReadonlyMap<string, ReturnType<CompileFs["kind"]>> | undefined {
  const typed = fs.entries?.(path);
  if (typed !== undefined)
    return new Map(typed.map((entry) => [entry.name, entry.kind === "other" ? fs.kind(join(path, entry.name)) : entry.kind]));
  const names = fs.list(path);
  return names === undefined ? undefined : new Map(names.map((name) => [name, fs.kind(join(path, name))]));
}

/** A folder's entry as listed, under its lower-case name. */
interface FoldedEntry {
  readonly name: string;
  readonly kind: ReturnType<CompileFs["kind"]>;
}

/** Entries keyed by their lower-case name; a symlink wins over another entry folding to the same name. */
function foldedEntries(children: ReadonlyMap<string, ReturnType<CompileFs["kind"]>>): ReadonlyMap<string, FoldedEntry> {
  const folded = new Map<string, FoldedEntry>();
  for (const [name, kind] of children) {
    const key = name.toLowerCase();
    if (folded.get(key)?.kind !== "symlink") folded.set(key, { name, kind });
  }
  return folded;
}

/**
 * The folders a walk visited, across every folder the run writes (the cap is
 * on them together), so a walk past the cap can name where the bulk is: the
 * deepest folder holding at least half of them. Counted only then.
 */
class WalkTally {
  private readonly visited: string[] = [];

  visit(directory: string): void {
    this.visited.push(directory);
  }

  /** The refusal past the cap, naming `root`, the folder being walked. */
  tooLarge(root: string): TaviError {
    // Breadth first, so every folder comes after its parent: summed from the end, each count is whole when it is read.
    const counts = new Map<string, number>();
    for (let index = this.visited.length - 1; index >= 0; index -= 1) {
      const directory = this.visited[index] as string;
      const count = (counts.get(directory) ?? 0) + 1;
      counts.set(directory, count);
      counts.set(dirname(directory), (counts.get(dirname(directory)) ?? 0) + count);
    }
    const total = this.visited.length;
    let largest: string | undefined;
    for (const directory of this.visited) {
      const count = counts.get(directory) ?? 0;
      if (count * 2 >= total && count < total && (largest === undefined || directory.length > largest.length)) largest = directory;
    }
    const where =
      largest === undefined
        ? ""
        : `; most of them are in ${largest} (${String(counts.get(largest))} folders) — if it is a dependency or build tree, attach a folder beside it instead`;
    return new TaviError(
      "UNAVAILABLE",
      `${root} is too large to protect: the folders this run writes hold more than ${String(WALK_DIRECTORY_CAP)} folders${where}; attach a narrower folder`,
      { details: { folder: root, reason: "walk-cap", ...(largest === undefined ? {} : { largest }) } },
    );
  }
}

/**
 * Directories the walk never enters: dependency and build trees that
 * hold no hook the host runs, which would spend the mount budget. A hook
 * planted under one is an accepted residual risk.
 */
export const PRUNED_DIRECTORIES = [
  "node_modules",
  ".cache",
  "target",
  "vendor",
  ".venv",
  ".next",
  ".turbo",
  ".gradle",
  "__pycache__",
  ".tox",
  "Pods",
  "DerivedData",
  ".terraform",
] as const;
const PRUNED: ReadonlySet<string> = new Set([".git", ...PRUNED_DIRECTORIES]);

/**
 * Inside any gitdir — a repository's `.git` directory, a gitfile's target (a
 * worktree's or submodule's) and its `commondir`: what git runs or reads on
 * the host. `commondir` is read in every gitdir, and git takes `config` and
 * `hooks/` from where it points.
 */
const GITDIR_ANCHORED = ["hooks", "config", "config.worktree", "commondir", "HEAD"] as const;
/** A gitdir's config files, each of which may set `core.hooksPath`. */
const GITDIR_CONFIGS = ["config", "config.worktree"] as const;
/** How many symlinks a chain may hold before it is treated as a loop (the kernel's own limit). */
const MAX_LINKS = 40;

/**
 * Proxy and trust variables srt sets inside the sandbox for its own proxy;
 * a `denyEnv` naming one would unset what egress depends on.
 */
const RESERVED_ENVIRONMENT = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "NODE_USE_ENV_PROXY",
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GLOB = /[*?[\]]/;

/**
 * statfs magic numbers of filesystems that fold case for every lookup, and
 * of the two (ext4, f2fs) that fold per directory with the `casefold` flag.
 */
const FOLDING_FILESYSTEMS = new Set([
  0x4d44 /* vfat */, 0x2011bab0 /* exfat */, 0x7366746e /* ntfs3 */, 0x5346544e /* ntfs */, 0x65735546 /* fuse */, 0xff534d42 /* cifs */,
  0xfe534d42 /* smb2 */, 0x01021997 /* 9p: WSL2's /mnt/c */,
]);
/** ext4 and f2fs fold per directory, with the `casefold` flag, where the kernel has the feature. */
const CASEFOLD_CAPABLE = new Map([
  [0xef53, "/sys/fs/ext4/features/casefold"],
  [0xf2f52010, "/sys/fs/f2fs/features/casefold"],
]);

export const nodeCompileFs: CompileFs = {
  kind(path) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return "symlink";
      if (stat.isDirectory()) return "directory";
      return stat.isFile() ? "file" : "other";
    } catch {
      return undefined;
    }
  },
  list(path) {
    try {
      return readdirSync(path);
    } catch {
      return undefined;
    }
  },
  entries(path) {
    try {
      return readdirSync(path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      }));
    } catch {
      return undefined;
    }
  },
  link(path) {
    try {
      return readlinkSync(path);
    } catch {
      return undefined;
    }
  },
  read(path) {
    try {
      // Enough for a gitfile, a `commondir` and a repository's `config` with its remotes and branches.
      return readFileSync(path, "utf8").slice(0, 65_536);
    } catch {
      return undefined;
    }
  },
  real(path) {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  },
  foldsCase(path) {
    let type: number;
    try {
      type = statfsSync(path).type;
    } catch {
      return true;
    }
    if (FOLDING_FILESYSTEMS.has(type)) return true;
    const feature = CASEFOLD_CAPABLE.get(type);
    if (feature === undefined || !existsSync(feature)) return false;
    // `lsattr -d` prints the directory's flags; `F` is casefold (FS_CASEFOLD_FL), which Node cannot read itself.
    // Without an answer (no e2fsprogs, a timeout) the root may fold: refused, never assumed exact.
    const flags = spawnSync("lsattr", ["-d", path], { encoding: "utf8", timeout: 2_000 });
    return flags.status !== 0 || /^\S*F\S*\s/.test(flags.stdout);
  },
};

/**
 * Resolve `path` to what the kernel actually opens, as far as an existing
 * ancestor allows (Seatbelt matches the symlink-resolved path: `/etc/hosts`
 * is `/private/etc/hosts` to it). Resolved segment by segment from the root;
 * the first missing segment and the rest are appended as spelled, so a glob
 * or a path not created yet keeps its tail. A relative path is refused.
 * Resolved through the compile's filesystem, so a Linux compile on a Mac does
 * not take macOS's `/private` spellings.
 */
export function canonicalize(path: string, fs: Pick<CompileFs, "real"> = nodeCompileFs): string {
  if (!path.startsWith("/")) {
    throw new TaviError("INVALID_INPUT", `sandbox filesystem policy path must be absolute, got: ${path}`);
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  let resolved = "/";
  let index = 0;
  for (; index < segments.length; index += 1) {
    const real = fs.real(join(resolved, segments[index] ?? ""));
    if (real === undefined) break;
    resolved = real;
  }
  const remaining = segments.slice(index);
  return remaining.length > 0 ? join(resolved, ...remaining) : resolved;
}

/**
 * srt's own default write paths (`getDefaultWritePaths`), closed on every
 * run: a channel between every sandboxed command on the host otherwise.
 * `/private/tmp/claude` is macOS's spelling; Linux has no `/private`.
 */
export function runtimeSharedWritePaths(home: string = homedir(), platform: NodeJS.Platform = process.platform): readonly string[] {
  return [
    ...(platform === "darwin" ? ["/private/tmp/claude"] : []),
    "/tmp/claude",
    join(home, ".npm", "_logs"),
    join(home, ".claude", "debug"),
  ];
}

/** A name as a pattern any case of it matches: APFS folds case, Seatbelt's regex does not. Every letter, so `HEAD` matches `head`. */
export const anyCase = (name: string): string => name.replace(/[a-zA-Z]/g, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** A masked credential: the sandbox sees a sentinel, the proxy substitutes it toward `hosts`. */
export interface CredentialMask {
  readonly name: string;
  readonly hosts: readonly string[];
}

/**
 * One `credentials` assembly: `denyEnv` and masks merged, never one
 * overwriting the other; a name in both is denied. `denyEnv` may not name
 * a variable srt's proxy sets.
 */
export function credentialsOf(
  denyEnv: readonly string[],
  masks: readonly CredentialMask[] = [],
): SandboxRuntimeConfig["credentials"] | undefined {
  const malformed = denyEnv.find((name) => !ENV_NAME.test(name));
  if (malformed !== undefined) throw new TaviError("INVALID_INPUT", `sandbox environment variable name is not an identifier: ${malformed}`);
  const reserved = denyEnv.find((name) => RESERVED_ENVIRONMENT.has(name));
  if (reserved !== undefined)
    throw new TaviError("INVALID_INPUT", `sandbox environment variable ${reserved} is the sandbox proxy's own; it cannot be denied`);
  const denied = new Set(denyEnv);
  const envVars = [
    ...denyEnv.map((name) => ({ name, mode: "deny" as const })),
    ...masks
      .filter((mask) => !denied.has(mask.name))
      .map((mask) => ({ name: mask.name, mode: "mask" as const, injectHosts: [...mask.hosts] })),
  ];
  return envVars.length === 0 ? undefined : ({ envVars } as SandboxRuntimeConfig["credentials"]);
}

/** What a compile produced, and what it could not express. */
export interface CompiledPolicy {
  readonly config: SandboxRuntimeConfig;
  /** Entries left out, or left unenforced, on this platform, each with why: the engine logs each once, `doctor` shows it, and the run's `warnings` carry it. */
  readonly dropped: readonly string[];
}

/**
 * Where a write to `path` lands: every symlink on the way followed, a
 * dangling one too (the sandbox could create its target). Undefined for a
 * chain past the kernel's own limit.
 */
function destinationOf(path: string, fs: CompileFs): string | undefined {
  let current = canonicalize(dirname(path), fs);
  let name = path.slice(dirname(path).length + 1);
  for (let hops = 0; hops < MAX_LINKS; hops += 1) {
    const candidate = join(current, name);
    const target = fs.kind(candidate) === "symlink" ? fs.link(candidate) : undefined;
    if (target === undefined) return candidate;
    const next = resolve(current, target);
    current = canonicalize(dirname(next), fs);
    name = next.slice(dirname(next).length + 1);
  }
  return undefined;
}

/** One `key = value` of a git config file: section and key folded to lower case, as git folds them. */
interface ConfigEntry {
  readonly section: string;
  /** Whether the section has a `"subsection"` (`[includeIf "gitdir:…"]`). */
  readonly subsection: boolean;
  readonly key: string;
  readonly value: string;
}

/** A git config file's entries, as git reads them: a value whose line ends in an unescaped `\` goes on into the next line. */
function configEntries(text: string): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  const lines = text.split(/\r?\n/);
  let section = "";
  let subsection = false;
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index] as string;
    const header = /^\s*\[\s*([^\]\s"]+)(\s+"(?:[^"\\]|\\.)*")?\s*\]/.exec(line);
    if (header !== null) {
      section = (header[1] ?? "").toLowerCase();
      subsection = header[2] !== undefined;
      line = line.slice(header[0].length);
    }
    const entry = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=(.*)$/.exec(line);
    if (entry === null) continue;
    let raw = entry[2] ?? "";
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(raw) && index + 1 < lines.length) {
      index += 1;
      raw = raw.slice(0, -1) + (lines[index] as string);
    }
    entries.push({ section, subsection, key: (entry[1] ?? "").toLowerCase(), value: configValue(raw) });
  }
  return entries;
}

/**
 * Every `core.hooksPath` a git config file sets, as written: git takes the
 * last, and each is protected, so a later one cannot hide an earlier one.
 * Section and key names fold case, as git's do; a `[core "x"]` subsection is
 * no `core`.
 */
export function hooksPathsOf(text: string | undefined): string[] {
  if (text === undefined) return [];
  return configEntries(text)
    .filter((entry) => entry.section === "core" && !entry.subsection && entry.key === "hookspath" && entry.value !== "")
    .map((entry) => entry.value);
}

/** A git config value as git reads it: quotes joined, `\\`, `\"`, `\t` and `\n` escapes, `#` and `;` comments outside quotes. */
function configValue(raw: string): string {
  let value = "";
  let quoted = false;
  let pending = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] as string;
    if (character === "\\") {
      const next = raw[index + 1];
      index += 1;
      value += pending + (next === "t" ? "\t" : next === "n" ? "\n" : (next ?? ""));
      pending = "";
    } else if (character === '"') {
      value += pending;
      pending = "";
      quoted = !quoted;
    } else if (!quoted && (character === "#" || character === ";")) {
      break;
    } else if (!quoted && /\s/.test(character)) {
      // Whitespace counts only between words: leading and trailing runs are dropped.
      if (value !== "") pending += character;
    } else {
      value += pending + character;
      pending = "";
    }
  }
  return value;
}

/** How deep git follows `include.path` from one config file. */
const MAX_INCLUDE_DEPTH = 10;

/** `path` with a leading `~` as `home`'s. */
function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** What a git config file and the files it includes set: `core.hooksPath` values as written, and the included files, as absolute paths. */
interface ConfigClosure {
  readonly hooksPaths: string[];
  readonly includes: string[];
}

/**
 * Every `core.hooksPath` a config file sets, and the files it includes
 * (`[include]` and every `[includeIf]`, whatever its condition: protecting
 * more is the safe side), followed to `MAX_INCLUDE_DEPTH`, each file once.
 * An included file is relative to the including file's folder, `~/` is
 * `home`'s; one that cannot be read is listed (it could be created) but not
 * followed. A sandboxed command that could write an included file could set
 * `core.hooksPath` or `core.fsmonitor` through it, so each is write-denied
 * like the config naming it.
 */
function configClosure(
  file: string,
  home: string,
  fs: CompileFs,
  out: ConfigClosure = { hooksPaths: [], includes: [] },
  seen = new Set<string>(),
  depth = 0,
): ConfigClosure {
  if (seen.has(file)) return out;
  seen.add(file);
  const text = fs.read(file);
  if (text === undefined) return out;
  out.hooksPaths.push(...hooksPathsOf(text));
  if (depth >= MAX_INCLUDE_DEPTH) return out;
  for (const entry of configEntries(text)) {
    const including = (entry.section === "include" && !entry.subsection) || (entry.section === "includeif" && entry.subsection);
    if (!including || entry.key !== "path" || entry.value === "") continue;
    const included = resolve(dirname(file), expandHome(entry.value, home));
    if (!out.includes.includes(included)) out.includes.push(included);
    configClosure(included, home, fs, out, seen, depth + 1);
  }
  return out;
}

/** Every `core.hooksPath` the configs set and every file they include, includes followed. */
function configsClosure(configs: readonly string[], home: string, fs: CompileFs): ConfigClosure {
  const out: ConfigClosure = { hooksPaths: [], includes: [] };
  for (const config of configs) configClosure(config, home, fs, out);
  return { hooksPaths: out.hooksPaths, includes: [...new Set(out.includes)] };
}

/**
 * The config files every repository of the owner's inherits, which may set
 * `core.hooksPath` for all of them: the global (`$GIT_CONFIG_GLOBAL`, else
 * `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`) and the system one
 * (`$GIT_CONFIG_SYSTEM`, else `/etc/gitconfig`).
 */
export function inheritedGitConfigs(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const xdg = env["XDG_CONFIG_HOME"];
  const global = env["GIT_CONFIG_GLOBAL"]
    ? [env["GIT_CONFIG_GLOBAL"]]
    : [join(home, ".gitconfig"), join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config"), "git", "config")];
  return [...global, env["GIT_CONFIG_SYSTEM"] || "/etc/gitconfig"];
}

/** A `core.hooksPath` value as an absolute path: a relative one is `worktree`'s, a leading `~` is `home`. */
function hooksDirectory(value: string, worktree: string, home: string): string {
  const expanded = expandHome(value, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(worktree, expanded);
}

/**
 * The hook folders a gitdir's config names (`core.hooksPath`, in its
 * `config` and `config.worktree`, its `commondir` target's `config`, the
 * files they include, and the owner's `inherited` values), as absolute paths:
 * a relative one is the worktree's (`worktree`, the folder holding `.git`), a
 * leading `~` is `home`. Git runs what they hold on the host, as it does
 * `.git/hooks`. With them, the files those configs include, which could set
 * the same keys.
 */
function gitdirConfigsOf(
  gitdir: string,
  worktree: string,
  home: string,
  fs: CompileFs,
  inherited: readonly string[],
): { readonly hooks: string[]; readonly includes: string[] } {
  const configs = GITDIR_CONFIGS.map((name) => join(gitdir, name));
  const common = fs.read(join(gitdir, "commondir"))?.trim();
  const commonDirectory = common === undefined || common === "" ? undefined : fs.real(resolve(gitdir, common));
  if (commonDirectory !== undefined) configs.push(join(commonDirectory, "config"));
  const closure = configsClosure(configs, home, fs);
  const values = [...inherited, ...closure.hooksPaths];
  return { hooks: [...new Set(values.map((value) => hooksDirectory(value, worktree, home)))], includes: closure.includes };
}

/** The literal expansion of protected names under a set of writable roots (Linux). */
class LinuxProtection {
  readonly paths = new Set<string>();
  /**
   * srt makes every existing ancestor of a write deny, up to its writable
   * root, a mount point of its own (README "Pinned directories (Linux)"):
   * they spend the budget too.
   */
  private readonly pins = new Set<string>();
  private visited = 0;
  private readonly tally = new WalkTally();
  private readonly fs: CompileFs;
  private readonly writable: readonly string[];
  private readonly unreadable: readonly string[];
  private readonly budget: number;
  private readonly home: string;
  /** The `core.hooksPath` values the owner's global and system config set, as written, and the files they include. */
  private readonly inherited: ConfigClosure;

  constructor(
    fs: CompileFs,
    writable: readonly string[],
    unreadable: readonly string[],
    budget: number,
    home: string,
    inherited: ConfigClosure,
  ) {
    this.fs = fs;
    this.writable = writable;
    this.unreadable = unreadable;
    this.budget = budget;
    this.home = home;
    this.inherited = inherited;
  }

  /** The hook folders the inherited config names by absolute path, which every repository uses, a walked one or not. */
  inheritedHooks(): void {
    for (const value of this.inherited.hooksPaths) {
      const expanded = expandHome(value, this.home);
      if (!isAbsolute(expanded)) continue;
      const hooks = resolve(expanded);
      this.protectAt(dirname(hooks), basename(hooks), this.writableRootOf(hooks) ?? hooks);
    }
    // A file the owner's global config includes sets keys for every repository, as the config itself does.
    for (const file of this.inherited.includes) this.protectAt(dirname(file), basename(file), this.writableRootOf(file) ?? file);
  }

  private writableRootOf(path: string): string | undefined {
    return this.writable.filter((root) => within(path, root)).sort((left, right) => right.length - left.length)[0];
  }

  /** Every mount a deny of `path` costs: itself and its existing ancestors below its writable root. */
  private pin(path: string): void {
    const root = this.writableRootOf(path);
    if (root === undefined) return;
    for (let parent = dirname(path); parent !== root && within(parent, root); parent = dirname(parent)) {
      if (this.fs.kind(parent) !== undefined) this.pins.add(parent);
    }
  }

  /** Charges entries denied outside the walk (the policy's own write denies) to the same budget. */
  reserve(paths: readonly string[]): void {
    for (const path of paths) this.pin(path);
  }

  private add(path: string, folder: string): void {
    if (this.paths.has(path)) return;
    this.paths.add(path);
    this.pin(path);
    if (this.paths.size + this.pins.size > this.budget) {
      throw new TaviError(
        "UNAVAILABLE",
        `${folder} is too large to protect: it holds more protected paths than the sandbox can mount (about ${String(this.budget)} left); attach a narrower folder`,
        { details: { folder, reason: "mount-budget" } },
      );
    }
  }

  /**
   * Refuses a symlink at `base/relative`, or at a folder on the way to it,
   * that lies in a folder the sandbox may write: bubblewrap cannot mount over
   * a link, so the sandbox could delete it and make the real name in its place.
   */
  private refuseLink(base: string, relative: string, folder: string): void {
    let path = base;
    for (const segment of relative.split("/")) {
      path = join(path, segment);
      const kind = this.fs.kind(path);
      if (kind === undefined || kind === "file" || kind === "other") return;
      if (kind === "symlink" && this.writableRootOf(dirname(path)) !== undefined) {
        throw new TaviError(
          "UNAVAILABLE",
          `${path} is a symbolic link where the sandbox protects ${join(base, relative)}: on Linux a sandboxed command could replace the link with a real ${relative}; replace the link with what it points to, or attach a folder that does not hold it`,
          { details: { folder, reason: "protected-symlink", path } },
        );
      }
    }
  }

  /** The ancestor of `relative` below `base` that is a file, if any (srt skips a deny beneath one silently). */
  private fileAncestor(base: string, relative: string): string | undefined {
    let path = base;
    for (const segment of relative.split("/").slice(0, -1)) {
      path = join(path, segment);
      const kind = this.fs.kind(path);
      if (kind === "file" || kind === "other") return path;
      if (kind === "symlink") {
        const real = this.fs.real(path);
        const resolved = real === undefined ? undefined : this.fs.kind(real);
        if (resolved === "file" || resolved === "other") return path;
      }
    }
    return undefined;
  }

  /**
   * `base/name` protected where a write to it lands (resolve-before-mask):
   * through any symlink in it, when that is inside a writable root; a
   * destination outside every writable root is read-only already. A link the
   * sandbox could replace is refused; a file in the way is denied itself, so
   * it cannot become a folder holding the name.
   */
  private protectAt(base: string, name: string, folder: string): void {
    this.refuseLink(base, name, folder);
    const file = this.fileAncestor(base, name);
    if (file !== undefined) {
      if (this.writableRootOf(file) !== undefined) this.add(file, folder);
      return;
    }
    const destination = destinationOf(join(base, name), this.fs);
    if (destination !== undefined && this.writableRootOf(destination) !== undefined) this.add(destination, folder);
  }

  /**
   * A gitdir's anchored entries, when it is inside a writable root, and —
   * wherever it is — the hook folders its config names and the files it includes, where they are.
   */
  private gitdir(directory: string, worktree: string, folder: string): void {
    const configs = gitdirConfigsOf(directory, worktree, this.home, this.fs, this.inherited.hooksPaths);
    for (const path of [...configs.hooks, ...configs.includes]) this.protectAt(dirname(path), basename(path), folder);
    if (this.writableRootOf(directory) === undefined) return;
    for (const entry of GITDIR_ANCHORED) {
      this.refuseLink(directory, entry, folder);
      this.add(join(directory, entry), folder);
    }
    // `commondir` points git at another gitdir, whose config and hooks it then reads.
    const common = this.fs.read(join(directory, "commondir"))?.trim();
    if (common === undefined || common === "") return;
    const commonDirectory = this.fs.real(resolve(directory, common));
    if (commonDirectory !== undefined && this.writableRootOf(commonDirectory) !== undefined) {
      for (const entry of GITDIR_ANCHORED) this.add(join(commonDirectory, entry), folder);
    }
  }

  /** `directory/.git` as git reads it: a gitdir, a gitfile (`gitdir: <path>`), or a link to either. */
  private git(directory: string, folder: string): void {
    const path = join(directory, ".git");
    const kind = this.fs.kind(path);
    if (kind === undefined) return;
    if (kind === "symlink") this.refuseLink(directory, ".git", folder);
    if (kind === "directory") {
      this.gitdir(path, directory, folder);
      return;
    }
    const real = this.fs.real(path);
    const resolved = real === undefined ? undefined : this.fs.kind(real);
    if (kind === "symlink" && real !== undefined && resolved === "directory") {
      this.gitdir(real, directory, folder);
      return;
    }
    // A gitfile, or a link to one: the file itself (it could be repointed) and its target.
    this.protectAt(directory, ".git", folder);
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(this.fs.read(path) ?? "")?.[1];
    if (pointer === undefined) return;
    const target = this.fs.real(resolve(directory, pointer));
    if (target !== undefined) this.gitdir(target, directory, folder);
  }

  /** Every protected entry under `root`: literals at the root, then each existing match, `.git`-anchored. */
  protect(entry: SandboxProtectedNames): void {
    const root = entry.root;
    if (this.fs.foldsCase(root)) {
      throw new TaviError(
        "UNAVAILABLE",
        `${root} is on a filesystem that ignores letter case, where the sandbox cannot protect its files exactly; move the folder to a case-sensitive filesystem to use it with sandbox.run`,
        { details: { folder: root, reason: "case-folding" } },
      );
    }
    for (const name of [...entry.names, ...(entry.rootNames ?? [])]) this.protectAt(root, name, root);
    const queue = [root];
    while (queue.length > 0) {
      const directory = queue.shift() as string;
      this.visited += 1;
      this.tally.visit(directory);
      if (this.visited > WALK_DIRECTORY_CAP) throw this.tally.tooLarge(root);
      const children = entriesOf(this.fs, directory);
      // A folder that cannot be listed is asked for its `.git` by name, as for every protected name.
      if (children === undefined || children.has(".git")) this.git(directory, root);
      if (directory !== root) {
        for (const name of entry.names) {
          // A folder that cannot be listed may still be opened by name: every name is denied there, as at the root.
          // Listed, only a name whose first part is there is looked at.
          if (children === undefined) this.protectAt(directory, name, root);
          else if (children.has(name.split("/")[0] ?? name) && this.fs.kind(join(directory, name)) !== undefined)
            this.protectAt(directory, name, root);
        }
      }
      for (const [child, kind] of children ?? []) {
        if (kind !== "directory" || PRUNED.has(child)) continue;
        const path = join(directory, child);
        if (this.unreadable.some((denied) => within(path, denied))) continue;
        queue.push(path);
      }
    }
  }
}

/**
 * macOS: Seatbelt matches the path a write resolves to, and the patterns name
 * the protected names as spelled. A gitdir reached through a
 * symlinked `.git` or a gitfile is named no `.git`, and a protected name
 * reached through a symlink lands under another name, so the same bounded
 * walk Linux makes finds each under a writable root and denies it where it
 * lands, as a literal: a gitdir's anchored entries (and its `commondir`
 * target's), a gitfile itself, a protected name's destination. The hook
 * folder a gitdir's `core.hooksPath` names is read in every gitdir, a plain
 * `.git` too, since the patterns match only `.git/hooks`.
 */
function darwinResolvedDenies(
  protectedNames: readonly SandboxProtectedNames[],
  writable: readonly string[],
  unreadable: readonly string[],
  fs: CompileFs,
  home: string,
  inherited: ConfigClosure,
): string[] {
  const out = new Set<string>();
  const writableHolds = (path: string): boolean => writable.some((root) => within(path, root));
  let visited = 0;
  /** A hook folder (or an included config file) as named, its parent resolved (a link there could be swapped for a real folder), and where a write to it lands. */
  const hooksFolder = (hooks: string): void => {
    const named = join(canonicalize(dirname(hooks), fs), basename(hooks));
    if (writableHolds(named)) out.add(named);
    const destination = destinationOf(named, fs);
    if (destination !== undefined && writableHolds(destination)) out.add(destination);
  };
  // Every repository uses a hook folder the inherited config names by absolute path, a walked one or not.
  for (const value of inherited.hooksPaths) {
    const expanded = expandHome(value, home);
    if (isAbsolute(expanded)) hooksFolder(resolve(expanded));
  }
  // And a file the inherited config includes: writing it sets keys for every repository.
  for (const file of inherited.includes) hooksFolder(file);
  /**
   * `directory`'s anchored entries (`own`: it is no `.git`, so the patterns miss it), and its `commondir` target's;
   * wherever it is, the hook folders its config names and the files it includes — as named, and where a write to them lands.
   */
  const anchor = (directory: string, worktree: string, own: boolean): void => {
    const configs = gitdirConfigsOf(directory, worktree, home, fs, inherited.hooksPaths);
    for (const path of [...configs.hooks, ...configs.includes]) hooksFolder(path);
    if (!writableHolds(directory)) return;
    if (own) for (const entry of GITDIR_ANCHORED) out.add(join(directory, entry));
    const common = fs.read(join(directory, "commondir"))?.trim();
    if (common === undefined || common === "") return;
    const commonDirectory = fs.real(resolve(directory, common));
    if (commonDirectory !== undefined && writableHolds(commonDirectory))
      for (const entry of GITDIR_ANCHORED) out.add(join(commonDirectory, entry));
  };
  const git = (directory: string, name = ".git"): void => {
    const path = join(directory, name);
    const kind = fs.kind(path);
    if (kind === undefined) return;
    if (kind === "directory") return anchor(path, directory, false);
    const real = fs.real(path);
    if (kind === "symlink" && real !== undefined && fs.kind(real) === "directory") return anchor(real, directory, true);
    // A gitfile, or a link to one: the file itself (it could be repointed) and the gitdir it names.
    if (kind === "file") out.add(path);
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.read(path) ?? "")?.[1];
    const target = pointer === undefined ? undefined : fs.real(resolve(directory, pointer));
    if (target !== undefined) anchor(target, directory, true);
  };
  const tally = new WalkTally();
  /** A protected name whose first segment is a symlink (by any case, in `folded`), denied where a write to it lands. */
  const linked = (directory: string, protectedName: string, folded?: ReadonlyMap<string, FoldedEntry>): void => {
    const [first = protectedName, ...rest] = protectedName.split("/");
    const listed = folded?.get(first.toLowerCase());
    if ((folded === undefined ? fs.kind(join(directory, first)) : listed?.kind) !== "symlink") return;
    // As the folder spells it: a write through `.Claude` lands where that link points.
    const name = [listed?.name ?? first, ...rest].join("/");
    const destination = destinationOf(join(directory, name), fs);
    if (destination !== undefined && destination !== join(directory, name) && writableHolds(destination)) out.add(destination);
  };
  for (const entry of protectedNames) {
    const root = entry.root;
    for (const name of [...entry.names, ...(entry.rootNames ?? [])]) linked(root, name);
    const queue = [root];
    while (queue.length > 0) {
      const directory = queue.shift() as string;
      visited += 1;
      tally.visit(directory);
      if (visited > WALK_DIRECTORY_CAP) throw tally.tooLarge(root);
      const children = entriesOf(fs, directory);
      // macOS volumes usually ignore case: `.GIT` or `.Claude` opens as `.git` or `.claude`, so names are matched folded.
      const folded = children === undefined ? undefined : foldedEntries(children);
      // Denied as the folder spells it, which is what a write to it resolves to.
      if (folded === undefined) git(directory);
      else for (const [child] of children ?? []) if (child.toLowerCase() === ".git") git(directory, child);
      // A folder that cannot be listed has each name looked up as spelled, which the volume folds.
      if (directory !== root) for (const name of entry.names) linked(directory, name, folded);
      for (const [child, kind] of children ?? []) {
        if (kind !== "directory" || PRUNED.has(child)) continue;
        const path = join(directory, child);
        if (unreadable.some((denied) => within(path, denied))) continue;
        queue.push(path);
      }
    }
  }
  return [...out];
}

/**
 * The write denies with none of their ancestors among them: a deny beneath
 * another is covered already, and bubblewrap cannot make the placeholder for
 * an absent one inside the read-only mount above it (`Can't create file …:
 * Read-only file system`), which fails the whole run — a host folder's `.git`
 * denied whole with its `hooks` and `commondir` listed too.
 */
function outermost(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  const set = new Set(unique);
  return unique.filter((path) => {
    for (let parent = dirname(path); parent !== path && parent !== "/"; path = parent, parent = dirname(parent)) {
      if (set.has(parent)) return false;
    }
    return true;
  });
}

/** A glob in a path's last segment, as a matcher; undefined for a glob anywhere else. */
function lastSegmentGlob(path: string): { readonly directory: string; readonly matches: (name: string) => boolean } | undefined {
  const directory = dirname(path);
  if (GLOB.test(directory)) return undefined;
  const pattern = path.slice(directory.length + 1);
  const source = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const expression = new RegExp(`^${source}$`);
  return { directory, matches: (name) => expression.test(name) };
}

/**
 * srt skips a write-deny pattern on Linux (srt README:438): a last-segment
 * glob becomes the entries that match it now; any other is dropped, and said
 * so. Read denies keep their globs, which srt expands at wrap time itself.
 */
function literalsOf(paths: readonly string[], fs: CompileFs, dropped: string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (!GLOB.test(path)) {
      out.push(path);
      continue;
    }
    const glob = lastSegmentGlob(path);
    if (glob === undefined) {
      dropped.push(`${path}: a pattern above the last path segment cannot be expressed on Linux`);
      continue;
    }
    out.push(...(fs.list(glob.directory) ?? []).filter(glob.matches).map((name) => join(glob.directory, name)));
  }
  return out;
}

/**
 * `policy` and `command` as srt's config for `platform`.
 *
 * `denyPaths` denies reads whatever is granted, so an `allowRead` entry
 * identical to one is stripped (srt carves `allowRead` out of `denyRead`, the
 * opposite of its write precedence); a `denyRead` entry is meant to be carved
 * into. Every path is canonicalized first.
 */
export function compile(
  policy: SandboxPolicy,
  command: Pick<SandboxCommand, "denyEnv">,
  platform: CompilePlatform,
  fs: CompileFs = nodeCompileFs,
  options: {
    readonly home?: string;
    readonly masks?: readonly CredentialMask[];
    /** The git config files every repository inherits (default `inheritedGitConfigs(home)`), read for `core.hooksPath`. */
    readonly gitConfigs?: readonly string[];
  } = {},
): CompiledPolicy {
  const dropped: string[] = [];
  const home = options.home ?? homedir();
  const inherited = configsClosure(options.gitConfigs ?? inheritedGitConfigs(home), home, fs);
  const canonical = (path: string): string => canonicalize(path, fs);
  const protectedNames = policy.filesystem.protectedNames ?? [];
  const denyPaths = [...(policy.filesystem.denyPaths ?? [])].map(canonical);
  const denySet = new Set(denyPaths);
  const allowRead = policy.filesystem.allowRead.map(canonical);
  const allowWrite = policy.filesystem.allowWrite.map(canonical);
  const denyRead = (policy.filesystem.denyRead ?? []).map(canonical);
  const shared = runtimeSharedWritePaths(options.home, platform);
  const credentials = credentialsOf(command.denyEnv ?? [], options.masks);
  // Canonical, and inside a folder the run may write: srt grants everything under each.
  const sockets = (policy.local?.unixSocketsIn ?? []).map(canonical);
  for (const path of sockets) {
    const refused = refusedUnixSocketFolder(path, allowWrite);
    if (refused !== undefined) throw new TaviError("INVALID_INPUT", refused);
  }
  const network = {
    allowedDomains: policy.network.allow ? [...(policy.network.allowedHosts ?? [])] : [],
    deniedDomains: [],
    strictAllowlist: true,
    // macOS only: Linux's seccomp filter refuses every Unix socket, and its namespace has a localhost of its own.
    ...(platform === "darwin" && sockets.length > 0 ? { allowUnixSockets: sockets } : {}),
    ...(platform === "darwin" && policy.local?.localBinding === true ? { allowLocalBinding: true } : {}),
  };
  if (platform === "darwin") {
    const patterns = protectedNames.flatMap((entry) => [
      ...entry.names.map((name) => `${entry.root}/**/${anyCase(name)}`),
      ...(entry.rootNames ?? []).map((name) => `${entry.root}/${anyCase(name)}`),
    ]);
    const denyWrite = [...(policy.filesystem.denyWrite ?? []), ...patterns, ...shared].map(canonical);
    const readDenied = [...new Set([...denyPaths, ...denyRead])];
    const reopened = [...new Set(allowRead.filter((path) => !denySet.has(path)))];
    const unreadable = readDenied.filter((denied) => !GLOB.test(denied) && !reopened.some((open) => within(open, denied)));
    // Marked literal, so a resolved path holding `*`, `?` or `[` is never read as a pattern.
    const resolved = darwinResolvedDenies(
      protectedNames.map((entry) => ({ ...entry, root: canonical(entry.root) })),
      allowWrite,
      unreadable,
      fs,
      home,
      inherited,
    ).map((path) => ({ path, literal: true as const }));
    return {
      config: {
        network,
        filesystem: {
          denyRead: readDenied,
          allowRead: reopened,
          allowWrite,
          denyWrite: [...new Set([...denyPaths, ...denyWrite]), ...resolved],
        },
        ...(credentials === undefined ? {} : { credentials }),
        ...(policy.local?.pty === true ? { allowPty: true } : {}),
      },
      dropped,
    };
  }
  const readDenied = [...new Set([...denyPaths, ...denyRead])];
  const reopened = [...new Set(allowRead.filter((path) => !denySet.has(path)))];
  // srt expands a read glob from its literal folder; one with a wildcard in its first segment has none, and holds nothing.
  for (const path of [...readDenied, ...reopened]) {
    if (GLOB.test(path.split("/")[1] ?? ""))
      dropped.push(
        `${path}: a read pattern with a wildcard in its first path segment expands to nothing on Linux, so srt leaves it unenforced`,
      );
  }
  const explicitWriteDenies = literalsOf(
    [...new Set([...denyPaths, ...(policy.filesystem.denyWrite ?? []).map(canonical), ...shared.map(canonical)])],
    fs,
    dropped,
  );
  // What the walk may spend: the budget less every other entry and srt's own.
  const fixed = readDenied.length + reopened.length + allowWrite.length + explicitWriteDenies.length + SRT_RESERVED_MOUNTS;
  const budget = Math.min(MOUNT_BUDGET - fixed, Math.floor(ARGUMENT_BUDGET / ARGUMENTS_PER_MOUNT) - fixed);
  const unreadable = readDenied.filter((denied) => !GLOB.test(denied) && !reopened.some((open) => within(open, denied)));
  const protection = new LinuxProtection(fs, allowWrite, unreadable, Math.max(budget, 0), home, inherited);
  protection.reserve(explicitWriteDenies);
  protection.inheritedHooks();
  for (const entry of protectedNames) protection.protect({ ...entry, root: canonical(entry.root) });
  return {
    config: {
      network,
      filesystem: {
        denyRead: readDenied,
        allowRead: reopened,
        allowWrite,
        // Marked literal (srt README:460): a name holding `*`, `?` or `[` is that name, never a pattern.
        denyWrite: outermost([...explicitWriteDenies, ...protection.paths]).map((path) => ({ path, literal: true as const })),
      },
      ...(credentials === undefined ? {} : { credentials }),
    },
    dropped,
  };
}
