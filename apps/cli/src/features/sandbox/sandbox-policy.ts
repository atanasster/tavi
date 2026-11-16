import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  type ChatFolder,
  type ChatFolderTaint,
  type InvocationContext,
  HOST_PROTECTED_NAMES,
  PROJECT_PROTECTED_NAMES,
  type SandboxNetworkMode,
  type SandboxPolicy,
  TaviError,
} from "@tavi/contracts";
import { joinPath, pathEntries, systemPathEntries } from "@tavi/node-kit";
import { OWNER_TEMPORARY_STAGING, credentialFiles, credentialHomes, ownerStagingDirectory, persistenceLocations } from "@tavi/runtime";

import { canonical, within, withinFolded } from "../folders/fs-tools.js";
import { sandboxSharedWritePaths } from "./host.js";
import { foldersOf } from "./sandbox-folders.js";
import { xcrunCacheFile } from "./xcrun.js";

/**
 * What `sandbox.run` runs with, built from the chat's folder and the
 * operator's flags, never from the call's input: the filesystem policy, the
 * network, the environment.
 */

const execFileAsync = promisify(execFile);

/** How long a run takes when the call asks for no `timeoutMs` and the operator sets none (`serve --sandbox-timeout`): a build or test suite fits. */
const DEFAULT_SANDBOX_TIMEOUT_MS = 120_000;
/** What a run keeps of each of stdout and stderr. */
export const DEFAULT_SANDBOX_OUTPUT_BYTES = 65_536;
/** The longest run `timeoutMs` may ask for when the operator sets no `maxTimeoutMs`. */
const DEFAULT_SANDBOX_MAX_TIMEOUT_MS = 600_000;

/**
 * The data directory's entries denied to the shell's writes even before they
 * exist: the database and its sidecars and copies (`tavi.sqlite-wal`/`-shm`,
 * a restore's staging, a pre-restore copy), the credentials and both keys,
 * and every other directory tavi keeps there (browser profiles hold cookies,
 * `artifacts` holds every chat's files). `chats` is not one: the chat's own
 * folder is in it, and its siblings are denied one by one instead.
 */
const DATA_DIRECTORY_ENTRIES = [
  "artifacts",
  "sandbox-home",
  // The CA sandbox.run's proxy decrypts credential hosts with: made during a run, so denied by name before it exists.
  "sandbox-ca",
  // Each confined browser launch's scratch: its HOME, temporary profile and downloads.
  "browser-scratch",
  "credentials",
  "credentials.key",
  "provider-bindings.key",
  "web-providers.json",
  "projects.json",
  "browser-profiles",
  "channels",
  "plugins",
  "ui",
  "logs",
  "runtime",
  "cache",
  "*.sqlite*",
  "*.key",
  "*.json",
  "*.pre-restore-*",
  "owner.*",
] as const;

/** What git, a shell or an editor runs on its own from a folder (`PROJECT_PROTECTED_NAMES`). */
const WRITE_ROOT_PROTECTED = PROJECT_PROTECTED_NAMES;

/** At each writable root only: a bare repository's `HEAD`, which git would find there and run its hooks from. */
const WRITE_ROOT_ONLY = ["HEAD"] as const;

/**
 * In a host folder, any path component named `.git`, file or folder: a
 * planted gitfile (`gitdir: ../elsewhere`) would point the owner's git at
 * hooks and config the shell wrote outside `.git`. Git therefore cannot
 * commit in a host folder from the sandbox.
 */
const HOST_FOLDER_PROTECTED = [".git", ...HOST_PROTECTED_NAMES] as const;

/** What the runtime reads as a glob in a policy path; a folder spelled with one cannot be expressed exactly. */
const GLOB_CHARACTERS = /[*?[\]]/;

/**
 * Toolchain installs under `$HOME`, re-opened read-only when they exist and
 * the owner's `PATH` runs something from one (`onPath`): the binaries, a
 * version manager's shims and installs, and what its shims read to pick a
 * version — never a folder that holds a token. `~/.config`, `~/.cache`,
 * `~/.npm`, `~/.cargo` (but `bin`) and `~/.gitconfig` are never re-opened:
 * tokens live there, and a scratch `HOME` replaces what tools read from them.
 */
const TOOLCHAIN_ROOTS: readonly {
  readonly onPath: string;
  readonly open: readonly string[];
  /** The variable that tells the manager where its installs are, set to `<home>/<value>` once re-opened: the chat's own `HOME` holds none. */
  readonly home?: { readonly variable: string; readonly path: string };
}[] = [
  { onPath: ".nvm/versions", open: [".nvm/versions"] },
  // fnm puts a per-shell folder of links on PATH; the links point into its installs.
  { onPath: ".fnm", open: [".fnm"], home: { variable: "FNM_DIR", path: ".fnm" } },
  {
    onPath: ".local/state/fnm_multishells",
    open: [".local/state/fnm_multishells", ".local/share/fnm"],
    home: { variable: "FNM_DIR", path: ".local/share/fnm" },
  },
  {
    onPath: "Library/Caches/fnm_multishells",
    open: ["Library/Caches/fnm_multishells", "Library/Application Support/fnm"],
    home: { variable: "FNM_DIR", path: "Library/Application Support/fnm" },
  },
  { onPath: ".volta", open: [".volta"], home: { variable: "VOLTA_HOME", path: ".volta" } },
  {
    onPath: ".local/share/mise",
    open: [".local/share/mise/installs", ".local/share/mise/shims"],
    home: { variable: "MISE_DATA_DIR", path: ".local/share/mise" },
  },
  {
    onPath: ".asdf",
    open: [".asdf/installs", ".asdf/shims", ".asdf/plugins", ".asdf/lib", ".asdf/bin", ".asdf/asdf.sh"],
    home: { variable: "ASDF_DATA_DIR", path: ".asdf" },
  },
  {
    onPath: ".cargo/bin",
    open: [".cargo/bin", ".rustup/toolchains", ".rustup/settings.toml", ".rustup/update-hashes"],
    home: { variable: "RUSTUP_HOME", path: ".rustup" },
  },
  {
    onPath: ".pyenv",
    open: [".pyenv/versions", ".pyenv/shims", ".pyenv/libexec", ".pyenv/bin", ".pyenv/plugins", ".pyenv/version"],
    home: { variable: "PYENV_ROOT", path: ".pyenv" },
  },
  { onPath: ".bun/bin", open: [".bun/bin"] },
  { onPath: "go/bin", open: ["go/bin"] },
  { onPath: ".sdkman/candidates", open: [".sdkman/candidates"] },
  { onPath: ".ghcup/bin", open: [".ghcup/bin", ".ghcup/ghc"] },
  { onPath: ".local/bin", open: [".local/bin"] },
];

/**
 * Provider and token variables the runtime unsets in the child whatever its
 * environment (`SandboxCommand.denyEnv`): a backstop, since `sandbox.run`
 * already starts the child from an environment of its own.
 */
const DENIED_VARIABLES = [
  "SSH_AUTH_SOCK",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "COHERE_API_KEY",
  "PERPLEXITY_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "HF_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
] as const;

/** An owner variable whose name says it holds a secret, or one of tavi's own: denied too. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The owner's git identity, given to the shell as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, never by re-opening `~/.gitconfig`. */
export interface GitIdentity {
  readonly name?: string;
  readonly email?: string;
}

/** The owner's global `user.name` and `user.email`, each when set; nothing when git is missing or slow. Read off the event loop. */
export async function readOwnerGitIdentity(): Promise<GitIdentity> {
  const read = async (key: string): Promise<string | undefined> => {
    try {
      const value = (await execFileAsync("git", ["config", "--global", "--get", key], { encoding: "utf8", timeout: 2_000 })).stdout.trim();
      return value === "" ? undefined : value;
    } catch {
      return undefined;
    }
  };
  const [name, email] = await Promise.all([read("user.name"), read("user.email")]);
  return { ...(name === undefined ? {} : { name }), ...(email === undefined ? {} : { email }) };
}

export interface SandboxToolOptions {
  readonly dataDirectory: string;
  /** `serve --fs-root`: every one is read-denied but where a chat's folder lies in it. */
  readonly fsRoots?: readonly string[];
  /** `serve --dev-plugin`: write-denied wherever they appear. */
  readonly devPluginFolders?: readonly string[];
  /** `serve --sandbox-read`: folders re-opened read-only for every chat's shell; never the data directory or a credential home. */
  readonly sandboxRead?: readonly string[];
  /** The owner's `$HOME`; default `os.homedir()`. */
  readonly homeDirectory?: string;
  /**
   * Where the owner process stages its own files — the database worker's
   * spool of large payloads (every chat's checkpoints and artifact bodies),
   * browser uploads, `plugins.validate` and report staging: closed to every
   * chat's shell, read and write (I-isolate). Default `os.tmpdir()`; the
   * shell's own `TMPDIR` is the chat's `.tmp/`.
   */
  readonly ownerTemporaryDirectories?: readonly string[];
  /** The owner's private staging directory, denied by name whatever else is; default `ownerStagingDirectory()`. */
  readonly ownerStaging?: string;
  /** The owner's environment, read for `PATH`, the locale and the user — never passed on whole. Default `process.env`. */
  readonly ownerEnv?: Readonly<Record<string, string | undefined>>;
  /** The Node the owner runs on, whose install a chat's shell may read when its `bin` is on `PATH`. Default `process.execPath`. */
  readonly nodeExecutable?: string;
  /** Read once, at the first `sandbox.run`. Default: none. */
  readonly gitIdentity?: () => GitIdentity | Promise<GitIdentity>;
  readonly network?: SandboxPolicy["network"];
  /**
   * Domains every chat's shell may reach (`serve --sandbox-domain`),
   * in stored form; `workspaceDomains` adds the workspace's
   * `sandbox.domains`. Granted by the operator, never the model; a tainted
   * run gets no network whatever is granted. Default: none.
   */
  readonly domains?: readonly string[];
  readonly workspaceDomains?: (workspaceId: string) => Promise<readonly string[]>;
  /**
   * What other users keep in the folder every macOS user writes
   * (`/private/tmp`), read when a run's policy is built: read-denied, where
   * the owner's own entries, and `/tmp` itself for tools that use it, stay.
   * Default: those entries on macOS (at most 512), none elsewhere.
   */
  readonly othersTemporary?: () => readonly string[];
  /**
   * Files in a closed folder every chat's shell may read: macOS's xcrun cache (`XCRUN_CACHE_FILE`), in the owner's
   * temporary folder, which a shimmed `python3` or `git` reads. Default: that file on macOS, none elsewhere.
   */
  readonly readableCaches?: readonly string[];
  /** The workspace's `sandbox.network`: under `ask`, a run may ask the person for more (`requestDomains`). Default: `granted`. */
  readonly workspaceNetwork?: (workspaceId: string) => Promise<SandboxNetworkMode>;
  /**
   * Credentials the shell uses without holding them (`serve
   * --sandbox-credential`): the command reads a placeholder, and its
   * proxy puts the value read by `readSecret` in toward the binding's hosts,
   * which are granted with it. A tainted run gets none.
   */
  readonly credentials?: readonly SandboxCredentialBinding[];
  readonly readSecret?: (reference: string) => Promise<string | null>;
  readonly resources?: SandboxPolicy["resources"];
  /**
   * macOS capabilities beyond files and the network, each the operator's say
   * (`serve --sandbox-pty`, `--sandbox-local-bind`): never given to a tainted run.
   */
  readonly local?: { readonly pty?: boolean; readonly localBind?: boolean };
  /**
   * Where `serve --sandbox-cache` keeps one package cache per workspace,
   * which that workspace's untainted chats share: npm's and pnpm's
   * content-addressed stores only, whose every package is checked against its
   * integrity hash when read, so a chat cannot hand another a changed one. A
   * chat holding untrusted content neither writes nor reads it.
   */
  readonly sharedCache?: string;
  /**
   * The longest run a call's `timeoutMs` may ask for; default ten minutes, and
   * never under `resources.timeoutMs` (`serve --sandbox-max-timeout`).
   */
  readonly maxTimeoutMs?: number;
  /**
   * The free-space floor and the folders' budget: a new run
   * is refused under the floor, or once the chat's folder is past its budget
   * with its `.tmp/` emptied. A run already going is never stopped, so it may
   * overshoot within that one call; the folder's own size is forgotten once
   * it ends, so the next run is admitted against what it wrote, not a size
   * measured before it (every chat's together is kept for its 30 s).
   */
  readonly space?: { admitRun(folder: ChatFolder, taskId?: string): Promise<void>; forgetFolder(managed: string): void };
  /**
   * Record the calling task's chat — a worker's root chat — as tainted:
   * called before a tainted run, which may write the chat's managed folder,
   * so what it writes taints whoever reads it later. A failure refuses the run.
   */
  readonly markFolderTainted?: (context: InvocationContext) => Promise<void>;
  /**
   * The managed folders the call's chat reaches that are recorded tainted now
   * (`ChatFolders.taintedFoldersNow`): a taint recorded since the turn's
   * folder was resolved holds the run as tainted, as one stamped on it does.
   */
  readonly taintedFoldersNow?: (context: InvocationContext) => Promise<readonly ChatFolderTaint[]>;
  /**
   * The marks on host files under these folders (`ChatFolders.taintedWritesUnder`):
   * a run that reaches a file still holding marked bytes can read them, so it
   * is held as tainted and its output is untrusted.
   */
  readonly hostMarks?: (
    context: InvocationContext,
    roots: readonly string[],
  ) => Promise<readonly { readonly path: string; readonly sha256: string; readonly taskId?: string }[]>;
}

/** `serve --sandbox-credential <env>=<ref>` with the exact hosts `--http-credential-host` binds `ref` to. */
export interface SandboxCredentialBinding {
  readonly env: string;
  readonly ref: string;
  readonly hosts: readonly string[];
}

/**
 * What every call of one owner shares: the paths as the filesystem spells
 * them, the toolchains re-opened, the environment that does not depend on the
 * chat. Built once, at registration.
 */
export interface SandboxBase {
  readonly home: string;
  readonly dataDirectory: string;
  readonly roots: readonly string[];
  readonly devPluginFolders: readonly string[];
  /** Toolchain roots and `--sandbox-read` folders: re-opened for every chat. */
  readonly reopened: readonly string[];
  /** Where the re-opened toolchain managers keep their installs (`RUSTUP_HOME`, `PYENV_ROOT`, …): the shell's `HOME` is the chat's. */
  readonly toolchainEnv: Readonly<Record<string, string>>;
  /** The owner's temporary directories, real (`ownerTemporaryDirectories`). */
  readonly ownerTemporary: readonly string[];
  /** The owner's private staging directory, real. */
  readonly ownerStaging: string;
  readonly network: SandboxPolicy["network"];
  readonly resources: SandboxPolicy["resources"];
  /** `SandboxToolOptions.local`. */
  readonly local: { readonly pty?: boolean; readonly localBind?: boolean };
  /** `SandboxToolOptions.sharedCache`, real, made when the owner starts. */
  readonly sharedCache?: string;
  /** The longest run a call may ask for (`SandboxToolOptions.maxTimeoutMs`). */
  readonly maxTimeoutMs: number;
  readonly ownerEnv: Readonly<Record<string, string | undefined>>;
  readonly denyEnv: readonly string[];
  readonly gitIdentity: () => Promise<GitIdentity>;
  /** `SandboxToolOptions.othersTemporary`. */
  readonly othersTemporary: () => readonly string[];
  /** `SandboxToolOptions.readableCaches`, real. */
  readonly readableCaches: readonly string[];
}

/**
 * A `--sandbox-read` folder as the shell will see it: absolute, existing, a
 * directory, neither in nor around the data directory or a credential home —
 * re-opening one of those would undo the deny it lies in — and neither an
 * `--fs-root` nor a folder holding one: it would re-open that root, and every
 * chat's host folders in it, to every chat's shell (I-isolate).
 */
/** The folders under `$HOME` that hold a credential file beside a toolchain or the system's own files. */
const TOOLCHAIN_CREDENTIAL_FOLDERS: readonly string[] = [".cargo", ".m2", ".gradle", ".gem", ".nuget", ".composer", "Library"];

export function checkedSandboxRead(path: string, dataDirectory: string, home: string = homedir(), fsRoots: readonly string[] = []): string {
  if (!isAbsolute(path)) throw new TaviError("INVALID_INPUT", `--sandbox-read must be an absolute path, received ${JSON.stringify(path)}`);
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    throw new TaviError("INVALID_INPUT", `--sandbox-read ${path} does not exist`);
  }
  if (!statSync(real).isDirectory()) throw new TaviError("INVALID_INPUT", `--sandbox-read ${path} is not a folder`);
  const closed = [
    { path: canonical(resolve(dataDirectory)), why: "the tavi data directory" },
    ...[...credentialHomes(home), ...credentialFiles(home)].map((entry) => ({
      path: canonical(entry),
      why: "a credential directory or a file that holds keys",
    })),
  ];
  // A toolchain's or the system's folder holding a credential file (`~/.cargo/credentials`, `~/.m2/settings.xml`,
  // `~/Library/Keychains`) may be opened, inside it: that file stays denied by name. `~` or `~/.config` may not.
  const opened = (entry: string): boolean =>
    withinFolded(real, canonical(join(home, relative(canonical(home), entry).split(sep)[0] ?? ""))) &&
    TOOLCHAIN_CREDENTIAL_FOLDERS.includes(relative(canonical(home), entry).split(sep)[0] ?? "");
  const overlap = closed.find((entry) => withinFolded(real, entry.path) || (withinFolded(entry.path, real) && !opened(entry.path)));
  if (overlap !== undefined)
    throw new TaviError("INVALID_INPUT", `--sandbox-read ${path} would re-open ${overlap.why} (${overlap.path}) to the sandbox`);
  const root = fsRoots.map((entry) => canonical(resolve(entry))).find((entry) => withinFolded(entry, real));
  if (root !== undefined)
    throw new TaviError(
      "INVALID_INPUT",
      `--sandbox-read ${path} would re-open the --fs-root ${root} to every chat's sandbox; a chat reaches a root's folders only through its own working folder`,
    );
  return real;
}

/**
 * Where each tool keeps its downloads in a workspace's shared cache: only
 * stores that check every package against its integrity hash when they read
 * it (npm's cacache, pnpm's store). pip's built wheels, uv's, Yarn 1's and
 * Go's build cache are trusted as they lie, so a chat could leave another a
 * changed one: those stay in each chat's own `.home/`.
 */
const CACHE_VARIABLES: Readonly<Record<string, string>> = {
  npm_config_cache: "npm",
  npm_config_store_dir: "pnpm-store",
};

/** The shared caches' root, real (the owner's alone). */
function sharedCacheFolder(path: string): string {
  if (!isAbsolute(path)) throw new TaviError("INVALID_INPUT", `--sandbox-cache must be an absolute path, received ${JSON.stringify(path)}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return canonical(path);
}

/** A chat's workspace's shared cache, made on first use; none for a folder outside the data directory's `chats/`. */
function workspaceCache(base: SandboxBase, managed: string): string | undefined {
  if (base.sharedCache === undefined) return undefined;
  const [workspace, task] = relative(join(base.dataDirectory, "chats"), managed).split(sep);
  if (workspace === undefined || task === undefined || workspace === "" || workspace === ".." || GLOB_CHARACTERS.test(workspace))
    return undefined;
  const folder = join(base.sharedCache, workspace);
  for (const sub of Object.values(CACHE_VARIABLES)) mkdirSync(join(folder, sub), { recursive: true, mode: 0o700 });
  return folder;
}

/** The variables that point each tool at its folder of the run's shared cache, when the run may write one. */
function cacheEnvironment(base: SandboxBase, policy: SandboxPolicy): Record<string, string> {
  const root = base.sharedCache;
  const folder = root === undefined ? undefined : policy.filesystem.allowWrite.find((path) => path.startsWith(`${root}${sep}`));
  return folder === undefined ? {} : Object.fromEntries(Object.entries(CACHE_VARIABLES).map(([name, sub]) => [name, join(folder, sub)]));
}

/**
 * The owner's own Node when it is installed by hand under `$HOME` (a tarball in `~/.local/node`) and its `bin` is
 * on `PATH`: no version manager names it, and a chat that runs `node --test` needs the Node the owner runs on. Its
 * install folder is re-opened read-only, held to what `--sandbox-read` may open (never `~` itself, the data
 * directory or a credential home); a Node outside `$HOME` is readable already.
 */
function ownNodeInstall(executable: string, home: string, onPath: readonly string[], checked: (path: string) => string): readonly string[] {
  let bin: string;
  try {
    bin = canonical(dirname(realpathSync(executable)));
  } catch {
    return [];
  }
  if (!within(bin, home) || !onPath.some((entry) => entry === bin || canonical(dirname(resolveLink(join(entry, "node")))) === bin))
    return [];
  const install = basename(bin) === "bin" ? dirname(bin) : bin;
  for (const candidate of install === bin ? [bin] : [install, bin]) {
    try {
      return [checked(candidate)];
    } catch {
      // Not openable (`~` itself, a credential home): its bin alone, or nothing.
    }
  }
  return [];
}

/** Where a link leads, or the path itself when it is none or does not exist. */
function resolveLink(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function sandboxBase(options: SandboxToolOptions): SandboxBase {
  const home = canonical(resolve(options.homeDirectory ?? homedir()));
  const ownerEnv = options.ownerEnv ?? process.env;
  const onPath = pathEntries(ownerEnv["PATH"]).map((entry) => canonical(entry));
  const exists = (entry: string): boolean => {
    try {
      statSync(entry);
      return true;
    } catch {
      return false;
    }
  };
  const used = TOOLCHAIN_ROOTS.filter((root) => onPath.some((entry) => within(entry, canonical(join(home, root.onPath)))));
  const toolchains = used.flatMap((root) => root.open.map((entry) => canonical(join(home, entry)))).filter(exists);
  // A manager on PATH is pointed at its installs: the owner's own setting when there is one (re-opened
  // too when it lies in $HOME, as long as it is no credential home), else the default the entries re-open.
  const managerHomes = used.flatMap((root) => {
    if (root.home === undefined) return [];
    const own = ownerEnv[root.home.variable];
    const path = own !== undefined && own !== "" && isAbsolute(own) ? canonical(own) : canonical(join(home, root.home.path));
    return exists(path) ? [{ variable: root.home.variable, path }] : [];
  });
  // Held to what `--sandbox-read` may open: never `~` itself, the data directory, a credential home or an `--fs-root`.
  const ownManagerHomes = managerHomes.flatMap((entry) => {
    if (!within(entry.path, home)) return [];
    try {
      return [checkedSandboxRead(entry.path, options.dataDirectory, home, options.fsRoots ?? [])];
    } catch {
      return [];
    }
  });
  const toolchainEnv = Object.fromEntries(managerHomes.map((entry) => [entry.variable, entry.path] as const));
  // A toolchain on a mounted drive (`PATH`, a manager's own home) is re-opened read-only, as one in $HOME is.
  const places = sharedPlaceDenies(ownerEnv);
  const onDrives = [...onPath, ...managerHomes.map((entry) => entry.path)].filter(
    (entry) => places.some((place) => within(entry, place)) && exists(entry),
  );
  const roots = (options.fsRoots ?? []).map((root) => canonical(resolve(root)));
  // Refused when the owner starts, rather than at every chat's sandbox.run: the runtime would read it as a pattern.
  const globbedRoot = roots.find((root) => GLOB_CHARACTERS.test(root));
  if (globbedRoot !== undefined)
    throw new TaviError(
      "INVALID_INPUT",
      `--fs-root ${globbedRoot} has *, ?, [ or ] in its path, which the sandbox reads as a pattern; rename the folder to use it`,
    );
  const sandboxRead = (options.sandboxRead ?? []).map((path) =>
    checkedSandboxRead(path, options.dataDirectory, home, options.fsRoots ?? []),
  );
  const ownNode = ownNodeInstall(options.nodeExecutable ?? process.execPath, home, onPath, (path) =>
    checkedSandboxRead(path, options.dataDirectory, home, options.fsRoots ?? []),
  );
  const resources = options.resources ?? { timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS, maxOutputBytes: DEFAULT_SANDBOX_OUTPUT_BYTES };
  const denyEnv = [
    ...new Set([
      ...DENIED_VARIABLES,
      ...Object.keys(ownerEnv).filter((name) => ENV_NAME.test(name) && (SECRET_NAME.test(name) || name.startsWith("TAVI_"))),
    ]),
  ];
  let identity: Promise<GitIdentity> | undefined;
  const gitIdentity = options.gitIdentity;
  return {
    home,
    dataDirectory: canonical(resolve(options.dataDirectory)),
    roots,
    devPluginFolders: (options.devPluginFolders ?? []).map((folder) => canonical(resolve(folder))),
    reopened: [...new Set([...toolchains, ...ownManagerHomes, ...onDrives, ...ownNode, ...sandboxRead])],
    toolchainEnv,
    ownerTemporary: [...new Set((options.ownerTemporaryDirectories ?? [tmpdir()]).map((directory) => canonical(resolve(directory))))],
    ownerStaging: canonical(options.ownerStaging ?? ownerStagingDirectory()),
    network: options.network ?? { allow: false },
    resources,
    local: options.local ?? {},
    ...(options.sharedCache === undefined ? {} : { sharedCache: sharedCacheFolder(options.sharedCache) }),
    maxTimeoutMs: Math.max(resources.timeoutMs, options.maxTimeoutMs ?? DEFAULT_SANDBOX_MAX_TIMEOUT_MS),
    ownerEnv,
    denyEnv,
    gitIdentity: () => (identity ??= Promise.resolve(gitIdentity?.() ?? {}).catch(() => ({}))),
    othersTemporary: options.othersTemporary ?? (process.platform === "darwin" ? othersEntriesIn("/private/tmp") : () => []),
    readableCaches: (options.readableCaches ?? (process.platform === "darwin" ? [xcrunCacheFile()] : [])).map((file) =>
      canonical(resolve(file)),
    ),
  };
}

/** The entries of a folder every user writes that are another user's: `[]` when it cannot be listed. */
function othersEntriesIn(directory: string): () => readonly string[] {
  return () => {
    const uid = process.getuid?.();
    if (uid === undefined) return [];
    return entriesOf(directory)
      .slice(0, 4_096)
      .flatMap((entry) => {
        const path = join(directory, entry);
        try {
          return lstatSync(path).uid === uid ? [] : [path];
        } catch {
          return [];
        }
      })
      .slice(0, 512);
  };
}

function entriesOf(directory: string): readonly string[] {
  try {
    return readdirSync(directory);
  } catch {
    // Not created yet: the named entries cover what tavi will put there.
    return [];
  }
}

/**
 * Every part of the data directory but the chat's own managed folder, entry
 * by entry: its other entries (named, and whatever is there now), the other
 * workspaces under `chats/`, and the other chats of this one. A deny on the
 * whole directory would also close the chat's own folder to writes — a write
 * deny beats any allow — so the carve-out is made by leaving its ancestors
 * out. A managed folder not at `chats/<workspace>/<task>` denies `chats/`
 * whole.
 */
function dataDirectoryDenies(dataDirectory: string, managed: string): readonly string[] {
  const top = new Set<string>([...DATA_DIRECTORY_ENTRIES, ...entriesOf(dataDirectory)]);
  top.delete("chats");
  const denies = [...top].map((entry) => join(dataDirectory, entry));
  const chats = join(dataDirectory, "chats");
  const [workspace, task, ...rest] = relative(chats, managed).split(sep);
  if (workspace === undefined || task === undefined || rest.length > 0 || workspace === ".." || workspace === "" || task === "..")
    return [...denies, chats];
  denies.push(
    ...entriesOf(chats)
      .filter((entry) => entry !== workspace)
      .map((entry) => join(chats, entry)),
  );
  denies.push(
    ...entriesOf(join(chats, workspace))
      .filter((entry) => entry !== task)
      .map((entry) => join(chats, workspace, entry)),
  );
  return denies;
}

export const unique = (paths: readonly string[]): string[] => [...new Set(paths)];

/** A repository's own files, protected in the chat's own folder at its top only. */
const MANAGED_TOP_ONLY = WRITE_ROOT_PROTECTED.filter((name) => name.startsWith(".git/"));
/** What the chat's own folder protects at every depth. */
const MANAGED_DEPTH_PROTECTED = WRITE_ROOT_PROTECTED.filter((name) => !name.startsWith(".git/"));

/** Folders `$XDG_RUNTIME_DIR` is never denied as: what every run needs, and what holds them. */
const SHARED_SYSTEM_FOLDERS = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/run", "/var/run", "/private/var/run"] as const;
const SYSTEM_FOLDERS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc", "/dev", "/proc", "/System", "/Library"] as const;

/**
 * Places outside `$HOME` that hold other people's or other devices' files,
 * read-denied whole: mounted drives (`/Volumes`, `/media`, `/mnt` — on WSL
 * that is every Windows drive, the Windows profile with it), macOS's folder
 * every user shares, and the owner's per-session runtime directory
 * (`$XDG_RUNTIME_DIR`: a container registry's `auth.json`, keyring and bus
 * sockets) — only when it is a folder of its own, never `/`, `/tmp`, `/run`,
 * a system folder, one in it or one holding it. A chat's folder, a `--sandbox-read`
 * folder or a toolchain on `PATH` inside one is re-opened, as one in `$HOME`
 * is; so is a networked run's own proxy folder.
 */
export function sharedPlaceDenies(ownerEnv: Readonly<Record<string, string | undefined>>): readonly string[] {
  const runtime = ownerEnv["XDG_RUNTIME_DIR"] === undefined ? undefined : resolve(ownerEnv["XDG_RUNTIME_DIR"]);
  const ownRuntime =
    runtime !== undefined &&
    isAbsolute(ownerEnv["XDG_RUNTIME_DIR"] ?? "") &&
    runtime !== "/" &&
    !(SHARED_SYSTEM_FOLDERS as readonly string[]).includes(runtime) &&
    !SYSTEM_FOLDERS.some((folder) => within(folder, runtime) || within(runtime, folder));
  return ["/Volumes", "/media", "/mnt", "/Users/Shared", ...(ownRuntime ? [runtime] : [])];
}

/**
 * An owner temporary directory as the shell is denied it: whole, unless a
 * folder the chat reads lies in it (a data directory under the temporary
 * directory, as tests keep one) — a deny on the whole would close that folder
 * too — and then what the owner stages there by name
 * (`OWNER_TEMPORARY_STAGING`).
 */
function ownerTemporaryDenies(directory: string, read: readonly string[]): readonly string[] {
  return read.some((folder) => within(folder, directory)) ? OWNER_TEMPORARY_STAGING.map((entry) => join(directory, entry)) : [directory];
}

/**
 * One call's policy, from the chat's
 * folder — never from the call's input.
 *
 * - Writes: the primary folder, the managed folder and read-write
 *   attachments; a tainted chat's shell writes only its managed folder — its
 *   read-write attachments and a host primary are folders other chats read.
 * - Write denies, the full list on every call (a per-call list replaces the
 *   runtime's base one): the runtime's shared default write paths, every
 *   dev plugin's folder, the data directory but the chat's own folder, the
 *   credential homes and key files (a read-write attachment may hold them).
 * - Protected names, per folder written (`protectedNames`, compiled by the
 *   adapter per platform): what the host runs from a folder
 *   (`WRITE_ROOT_PROTECTED`, and a bare repository's `HEAD` at the folder
 *   itself); in a host folder, any `.git` and what a package manager runs
 *   (`HOST_FOLDER_PROTECTED`).
 * - Reads are deny-list based, so `$HOME`, every `--fs-root` and the data
 *   directory are denied whole, and the chat's folders, the toolchains on
 *   the owner's `PATH` and `--sandbox-read` re-opened inside them. The
 *   credential homes and key files are denied by name as well: a deny nested
 *   in a re-opened folder still holds. When a folder the chat reads holds
 *   the data directory (`--fs-root ~` with `~/.tavi`), the data directory is
 *   denied entry by entry instead, since a deny nested in a re-opened folder
 *   would close the chat's own folder too — leaving out the folders the chat
 *   reads, so a side chat still reads its parent's.
 * - The owner's temporary directory (`os.tmpdir()`, where the owner spools
 *   other chats' checkpoints and artifacts) is denied, read and write —
 *   only what the owner stages there, by name, when a folder the chat reads
 *   lies in it.
 * - A folder spelled with a glob character is refused: the runtime would read
 *   it as a pattern, and its allows and denies would match other paths.
 */
export function policyFor(
  base: SandboxBase,
  folder: ChatFolder,
  tainted: boolean,
  domains: readonly string[] = [],
  credentials: readonly SandboxCredentialBinding[] = [],
): SandboxPolicy {
  const { primary, managed, attachments } = foldersOf(folder);
  const globbed = [
    primary,
    managed,
    ...attachments.map((attachment) => attachment.path),
    base.home,
    base.dataDirectory,
    ...base.roots,
    ...base.devPluginFolders,
    ...base.reopened,
  ].find((path) => GLOB_CHARACTERS.test(path));
  if (globbed !== undefined) {
    throw new TaviError(
      "UNAVAILABLE",
      `sandbox.run cannot run while ${globbed} is in its policy: the sandbox reads *, ?, [ and ] in a path as a pattern. Rename the folder to use it with sandbox.run`,
    );
  }
  const allowWrite = tainted
    ? [managed]
    : unique([primary, managed, ...attachments.filter((attachment) => attachment.mode === "rw").map((attachment) => attachment.path)]);
  // The workspace's shared package cache: an untainted run's to read and fill, never a tainted one's.
  const cache = tainted ? undefined : workspaceCache(base, managed);
  const shared = cache === undefined ? [] : [cache];
  allowWrite.push(...shared);
  const allowRead = unique([primary, managed, ...attachments.map((attachment) => attachment.path), ...base.reopened, ...shared]);
  const dataDenies = dataDirectoryDenies(base.dataDirectory, managed);
  const dataInsideRead = allowRead.some((path) => path !== base.dataDirectory && within(base.dataDirectory, path));
  const readDataDenies = dataDenies.filter((deny) => !allowRead.some((allow) => within(allow, deny)));
  // The owner's own staging, other chats' data among it (I-isolate): closed but where a folder the chat reaches lies in it.
  // The owner's staging directory is denied by its own path too, so a spool made during the run is covered.
  const ownerTemporary = unique([
    base.ownerStaging,
    ...base.ownerTemporary.flatMap((directory) => ownerTemporaryDenies(directory, allowRead)),
  ]);
  return {
    filesystem: {
      // A cache re-opened in the owner's closed temporary folder, that file only: added after the folder's deny was
      // chosen, so the folder is still denied whole.
      allowRead: unique([...allowRead, ...base.readableCaches]),
      allowWrite,
      denyRead: unique([
        base.home,
        ...base.roots,
        ...(dataInsideRead ? readDataDenies : [base.dataDirectory]),
        ...credentialHomes(base.home),
        ...credentialFiles(base.home),
        ...ownerTemporary,
        ...sharedPlaceDenies(base.ownerEnv),
        ...base.othersTemporary().filter((path) => !GLOB_CHARACTERS.test(path)),
      ]),
      denyWrite: unique([
        ...sandboxSharedWritePaths(base.home),
        ...base.devPluginFolders,
        ...dataDenies,
        ...credentialHomes(base.home),
        ...credentialFiles(base.home),
        // What the owner's login, shell, git or desktop runs: whatever folder is attached read-write, `~/.config` too.
        ...persistenceLocations(base.home),
        ...ownerTemporary,
        // `downloads/` holds only what the browser downloaded: a read of it is a web page's words, so nothing else writes it.
        join(managed, "downloads"),
      ]),
      protectedNames: allowWrite.map((root) => ({
        root,
        // The chat's own folder: a repository in a subfolder is the shell's to make (`git init`, `git clone`), since no
        // host git runs there and every run's git takes no hook, fsmonitor or template (`GIT_RUN_CONFIG`). At its top a
        // repository's own files stay protected: the `git status` a read-only rule runs without asking reads them.
        names: root !== managed ? [...WRITE_ROOT_PROTECTED, ...HOST_FOLDER_PROTECTED] : MANAGED_DEPTH_PROTECTED,
        rootNames: root !== managed ? [...WRITE_ROOT_ONLY] : [...WRITE_ROOT_ONLY, ...MANAGED_TOP_ONLY],
      })),
    },
    network: networkFor(base, tainted, domains, credentials),
    resources: base.resources,
    // Unix sockets in the run's own scratch, so IPC within it works; a pty and localhost only on the operator's say, never tainted.
    // A pty, and listening (on TCP, and on Unix sockets in the run's own scratch) only on the operator's
    // say and never tainted: a socket a clean run left in the same scratch would be a tainted run's too.
    local: tainted
      ? {}
      : {
          ...(base.local.pty === true ? { pty: true } : {}),
          ...(base.local.localBind === true ? { localBinding: true, unixSocketsIn: [folder.scratch] } : {}),
        },
  };
}

/** Granted domains open a run's own proxy, a credential's hosts with it; a tainted run gets no network at all. */
function networkFor(
  base: SandboxBase,
  tainted: boolean,
  domains: readonly string[],
  credentials: readonly SandboxCredentialBinding[],
): SandboxPolicy["network"] {
  if (tainted) return { allow: false };
  const hosts = unique([...domains, ...credentials.flatMap((credential) => credential.hosts)]);
  if (hosts.length === 0) return base.network;
  return {
    allow: true,
    allowedHosts: hosts,
    ...(credentials.length === 0 ? {} : { credentials: credentials.map(({ env, hosts: bound }) => ({ env, hosts: [...bound] })) }),
  };
}

/** The values of a run's credentials, read when it starts; one with none refuses the run, rather than run without it. */
export async function credentialSecrets(
  options: SandboxToolOptions,
  credentials: readonly SandboxCredentialBinding[],
): Promise<Readonly<Record<string, string>>> {
  const secrets: Record<string, string> = {};
  for (const credential of credentials) {
    const value = await options.readSecret?.(credential.ref);
    if (value === null || value === undefined)
      throw new TaviError(
        "NOT_CONFIGURED",
        `sandbox.run's credential ${credential.env} (${credential.ref}) has no stored value; set it with tavi credentials set ${credential.ref}`,
        { details: { credential: credential.env } },
      );
    secrets[credential.env] = value;
  }
  return secrets;
}

/** The owner's login name, when the system knows one. */
function ownerName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

/**
 * The whole environment one call's command sees (I-env): never the owner's,
 * which holds provider API keys and channel tokens. `PATH` is the owner's
 * without the entries the shell cannot read anyway (under a read-denied
 * folder and not re-opened); `HOME`, `XDG_CACHE_HOME` and `TMPDIR` are the
 * chat's own `.home/` and `.tmp/`, so caches persist across turns and
 * scratch does not; pnpm copies rather than hard-links; git's identity
 * is the owner's.
 */
export function environmentFor(
  base: SandboxBase,
  folder: ChatFolder,
  policy: SandboxPolicy,
  identity: GitIdentity,
): Readonly<Record<string, string>> {
  const denied = policy.filesystem.denyRead ?? [];
  const path = pathEntries(base.ownerEnv["PATH"]).filter((entry) => {
    const real = canonical(entry);
    return !denied.some((deny) => within(real, deny)) || policy.filesystem.allowRead.some((allow) => within(real, allow));
  });
  const owner = (name: string): Record<string, string> => {
    const value = base.ownerEnv[name];
    return value === undefined || value === "" ? {} : { [name]: value };
  };
  const user = base.ownerEnv["USER"] ?? base.ownerEnv["LOGNAME"] ?? ownerName();
  return {
    PATH: joinPath(path.length === 0 ? [...systemPathEntries(), "/usr/sbin", "/sbin"] : path),
    HOME: folder.home,
    XDG_CACHE_HOME: join(folder.home, ".cache"),
    TMPDIR: folder.scratch,
    LANG: base.ownerEnv["LANG"] ?? "en_US.UTF-8",
    ...owner("LC_ALL"),
    ...owner("LC_CTYPE"),
    // The owner's zone, when it set one: a commit's date and a program's clock read as the owner's do.
    ...owner("TZ"),
    ...owner("TERM"),
    ...(user === undefined ? {} : { USER: user, LOGNAME: base.ownerEnv["LOGNAME"] ?? user }),
    SHELL: "/bin/sh",
    npm_config_package_import_method: "copy",
    ...cacheEnvironment(base, policy),
    // A run allowed to listen binds the loopback by default (dev servers read HOST): macOS grants every interface.
    ...(policy.local?.localBinding === true ? { HOST: "127.0.0.1" } : {}),
    ...base.toolchainEnv,
    // mise caches what it downloads: in the chat's home, never the owner's read-only installs.
    ...(base.toolchainEnv["MISE_DATA_DIR"] === undefined ? {} : { MISE_CACHE_DIR: join(folder.home, ".cache", "mise") }),
    ...(identity.name === undefined ? {} : { GIT_AUTHOR_NAME: identity.name, GIT_COMMITTER_NAME: identity.name }),
    ...(identity.email === undefined ? {} : { GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_EMAIL: identity.email }),
    ...GIT_RUN_CONFIG,
  };
}

/** Every hook event git runs, each turned off for a hook defined in config (`hook.<event>.*`, git 2.54+). */
const GIT_HOOK_EVENTS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "post-index-change",
] as const;

/**
 * git config every run is given, over any a repository holds: no hook (a
 * file's, or one defined in config), no fsmonitor, no template copied into a
 * new repository. In the form every git reads (`GIT_CONFIG_PARAMETERS`; the
 * newer `GIT_CONFIG_COUNT` needs 2.31), where an empty `core.fsmonitor` is
 * off. Inside the sandbox it is defence in depth (a command can unset its own
 * environment); it keeps a repository a command made in a subfolder from
 * running anything on a later run's git there.
 */
const GIT_RUN_CONFIG: Readonly<Record<string, string>> = {
  GIT_CONFIG_PARAMETERS: [
    "core.hookspath=/dev/null",
    "core.fsmonitor=",
    "init.templatedir=",
    ...GIT_HOOK_EVENTS.map((event) => `hook.${event}.enabled=false`),
  ]
    .map((entry) => `'${entry}'`)
    .join(" "),
};

/** The policy and environment one call would run with: for tests, and for the reader of a policy (I-model holds: the folder is the context's). */
export async function sandboxCallFor(
  options: SandboxToolOptions,
  folder: ChatFolder,
  tainted = false,
): Promise<{ readonly policy: SandboxPolicy; readonly env: Readonly<Record<string, string>>; readonly denyEnv: readonly string[] }> {
  const base = sandboxBase(options);
  const policy = policyFor(base, folder, tainted || folder.tainted === true || (folder.taintedFolders?.length ?? 0) > 0);
  return { policy, env: environmentFor(base, folder, policy, await base.gitIdentity()), denyEnv: base.denyEnv };
}
