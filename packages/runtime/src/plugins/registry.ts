// The asm.js build parses synchronously: there is no WebAssembly module to compile first.
import { parse } from "es-module-lexer/js";
import type { ZodType } from "zod";
import { isBuiltin } from "node:module";
import type { PluginRepositoryPort } from "../persistence/internal-contracts.js";
import { prepareTree, verifyTree, type TreeCheck } from "./mcp-tree.js";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { openNoFollowSync, sameIdentity } from "@tavi/node-kit";

import {
  PLUGIN_BOUNDS,
  channelDisclosureOf,
  PLUGIN_MANIFEST_FILE,
  PluginManifestSchema,
  SiteNoteSchema,
  SITE_NOTE_ABI,
  SiteProfileSchema,
  type SiteProfile,
  pluginUiFiles,
  TaviError,
  pluginConfigProblems,
  modHookViewsOf,
  pluginToolViews,
  providerInstanceProblems,
  ProviderInstancesSchema,
  type ProviderInstanceConfig,
  type BuiltinPluginInfo,
  type PluginConfig,
  mcpFilesystemProblems,
  mcpTreeBounds,
  type McpBlock,
  type McpRepositoryPort,
  type McpTreeIndexEntry,
  type PluginManifest,
  type PluginSettingRecord,
  type PluginVersionRecord,
  type PluginView,
  type PluginIsolation,
  type PluginApprovalChoice,
  approvedIsolation,
  workerRefusal,
  zodIssues,
  parseOrThrow,
  overlayPluginManifest,
  pluginLocaleProblems,
  pluginManifestVersionProblem,
  PluginLocaleFileSchema,
  type PluginLocaleFile,
  type PluginMessages,
} from "@tavi/contracts";
import { definedOnly, errorMessage, nowTimestamp } from "@tavi/contracts/util";
import type { Catalog, Locale } from "@tavi/contracts/i18n";

export interface PluginFile {
  readonly relative: string;
  readonly content: Buffer;
}

/**
 * A reader's own refusal of one opened plugin file, by its real path and
 * what its descriptor reads (`plugins.validate` in a chat's folder: a
 * hard-linked file in a managed folder, as `fs.read` refuses one).
 */
export type PluginFileCheck = (real: string, opened: Stats) => string | undefined;

/**
 * Read a plugin directory once: every regular file, by sorted relative path.
 * Symbolic links, special files and anything past the bounds (files, bytes,
 * directories, depth) are refused. Each file is opened without following links
 * and without blocking, then checked to be a regular file, so a FIFO or a link
 * swapped in after the walk is refused rather than read; it must still
 * resolve to itself under the directory's real path and name the open file,
 * so a folder swapped for a link after the walk is caught too, as `fs.read`
 * catches one. `check` refuses what its reader refuses.
 */
function readPluginTree(
  root: string,
  check?: PluginFileCheck,
  bounds: {
    readonly maxFiles: number;
    readonly maxDirectories: number;
    readonly maxDepth: number;
    readonly maxBytes: number;
  } = PLUGIN_BOUNDS,
): readonly PluginFile[] {
  const files: PluginFile[] = [];
  let bytes = 0,
    directories = 0;
  const realRoot = realpathSync.native(root);
  const walk = (directory: string, depth: number) => {
    if (++directories > bounds.maxDirectories || depth > bounds.maxDepth) {
      throw new TaviError("INVALID_INPUT", `plugin exceeds ${bounds.maxDirectories} directories or a depth of ${bounds.maxDepth}`);
    }
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw new TaviError(
          "INVALID_INPUT",
          `plugin contains a symbolic link (${relative(root, path)}); links are refused so the reviewed bytes are the ones that run`,
        );
      if (stat.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new TaviError("INVALID_INPUT", `plugin contains a special file (${relative(root, path)})`);
      if (files.length + 1 > bounds.maxFiles || bytes + stat.size > bounds.maxBytes) {
        throw new TaviError("INVALID_INPUT", `plugin exceeds ${bounds.maxFiles} files or ${bounds.maxBytes} bytes`);
      }
      const descriptor = openNoFollowSync(path, "read");
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile()) throw new TaviError("INVALID_INPUT", `plugin contains a special file (${relative(root, path)})`);
        const expected = join(realRoot, relative(root, path));
        let again: string | undefined;
        try {
          again = realpathSync.native(path);
        } catch {
          again = undefined;
        }
        const named = again === expected ? statSync(expected, { throwIfNoEntry: false }) : undefined;
        if (named === undefined || !sameIdentity(named, opened))
          throw new TaviError("CONFLICT", `plugin file ${relative(root, path)} changed while it was being read`);
        const refused = check?.(expected, opened);
        if (refused !== undefined) throw new TaviError("NOT_AUTHORIZED", `plugin file ${relative(root, path)} ${refused}`);
        const remaining = bounds.maxBytes - bytes;
        if (opened.size > remaining) throw new TaviError("INVALID_INPUT", "plugin exceeds its byte limit");
        const buffer = Buffer.alloc(Math.min(opened.size + 1, remaining + 1));
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(descriptor, buffer, length, buffer.length - length, null);
          if (count === 0) break;
          length += count;
        }
        if (length > opened.size) throw new TaviError("INVALID_INPUT", "plugin file grew while being read");
        const content = buffer.subarray(0, length);
        bytes += content.length;
        if (bytes > bounds.maxBytes) throw new TaviError("INVALID_INPUT", `plugin exceeds ${bounds.maxBytes} bytes`);
        files.push({ relative: relative(root, path).split(sep).join("/"), content });
      } finally {
        closeSync(descriptor);
      }
    }
  };
  walk(root, 0);
  return files;
}

/** Inspect prepared modules without importing them. Node builtins are part of the host ABI. */
function validateModuleClosure(files: readonly PluginFile[]): void {
  const paths = new Set(files.map((file) => file.relative));
  for (const file of files) {
    if (!file.relative.endsWith(".mjs")) continue;
    const [imports] = parse(file.content.toString("utf8"), file.relative);
    for (const imported of imports) {
      // import.meta is not a module dependency. The asm.js build reports it as a dynamic import whose
      // argument starts at -2 (v2's marker), not as the typed `import-meta`; both are read as it.
      if (imported.type === "import-meta" || (imported.type === "dynamic" && imported.dynamicStart === -2)) continue;
      // A template literal comes back as a glob (`./x/*.mjs`): it names no one file, so it is computed too.
      const specifier = imported.type === "dynamic" && imported.glob ? undefined : imported.specifier;
      if (specifier === undefined)
        throw new TaviError("INVALID_INPUT", `${file.relative}: computed imports cannot be included in a reviewed artifact`);
      if (specifier.startsWith("node:") && isBuiltin(specifier)) continue;
      if (!specifier.startsWith("./") && !specifier.startsWith("../"))
        throw new TaviError("INVALID_INPUT", `${file.relative}: bundle dependency ${specifier} into the artifact`);
      if (!specifier.endsWith(".mjs")) throw new TaviError("INVALID_INPUT", `${file.relative}: local modules must be prepared .mjs files`);
      const target = relative("/", join("/", dirname(file.relative), specifier))
        .split(sep)
        .join("/");
      const resolved = new URL(specifier, `file:///artifact/${file.relative}`);
      if (!resolved.pathname.startsWith("/artifact/") || resolved.search || resolved.hash || !paths.has(target))
        throw new TaviError("INVALID_INPUT", `${file.relative}: dependency ${specifier} is outside the reviewed artifact or missing`);
    }
  }
}

function hashFiles(files: readonly PluginFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.relative}\0${file.content.length}\0`);
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** A version's language packs by language, as read from its files: only those its manifest declares and that check out. */
type PluginLocalePacks = { readonly [L in Locale]?: PluginLocaleFile };

/**
 * `content` as `manifest`'s language pack for `locale`: within its byte limit,
 * JSON, a pack, and every manifest path one this manifest has and the model never
 * reads (`pluginLocaleProblems`). Throws, naming the file, when it is not.
 */
function parseLocalePack(manifest: PluginManifest, locale: Locale, path: string, content: Buffer | undefined): PluginLocaleFile {
  if (content === undefined) throw new TaviError("INVALID_INPUT", `the manifest's language pack ${path} does not exist`);
  if (content.length > PLUGIN_BOUNDS.maxLocaleBytes)
    throw new TaviError("INVALID_INPUT", `the language pack ${path} is over ${String(PLUGIN_BOUNDS.maxLocaleBytes)} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString("utf8"));
  } catch {
    throw new TaviError("INVALID_INPUT", `the language pack ${path} is not JSON`);
  }
  const problems = pluginLocaleProblems(manifest, locale, raw);
  if (problems.length > 0)
    throw new TaviError("INVALID_INPUT", `the language pack ${path} is not valid: ${problems.join("; ").slice(0, 600)}`);
  return PluginLocaleFileSchema.parse(raw);
}

/** The language packs `manifest` declares, from `fileOf`: each checked (`parseLocalePack`); one that does not check out throws. */
function localePacksOf(manifest: PluginManifest, fileOf: (path: string) => Buffer | undefined): PluginLocalePacks {
  const packs: { [L in Locale]?: PluginLocaleFile } = {};
  for (const [locale, path] of Object.entries(manifest.locales ?? {}) as [Locale, string][])
    packs[locale] = parseLocalePack(manifest, locale, path, fileOf(path));
  return packs;
}

/**
 * A plugin directory's files and their hash, from one read: what is served is
 * exactly what was hashed (no second read could see a swapped file).
 */
export function readPluginSnapshot(root: string): { readonly hash: string; readonly files: ReadonlyMap<string, Buffer> } {
  const files = readPluginTree(root);
  return { hash: hashFiles(files), files: new Map(files.map((file) => [file.relative, file.content])) };
}

/** Hash a plugin directory: sorted relative paths with their sizes and bytes (see `readPluginTree`), its language packs among them. */
export function hashPluginDirectory(root: string): { readonly hash: string; readonly files: number; readonly bytes: number } {
  const files = readPluginTree(root);
  return { hash: hashFiles(files), files: files.length, bytes: files.reduce((sum, file) => sum + file.content.length, 0) };
}

function parseManifest(content: Buffer | undefined, directory: string): PluginManifest {
  let raw: unknown;
  try {
    if (content === undefined) throw new Error("missing");
    raw = JSON.parse(content.toString("utf8"));
  } catch {
    throw new TaviError("INVALID_INPUT", `no readable ${PLUGIN_MANIFEST_FILE} in ${directory}`);
  }
  // Newer than this Tavi: said plainly, before the schema would call it a mismatch.
  const newer = pluginManifestVersionProblem(raw);
  if (newer !== undefined) throw new TaviError("INVALID_INPUT", newer);
  return parseOrThrow(PluginManifestSchema, raw, (issues) => `${PLUGIN_MANIFEST_FILE} is not valid: ${issues.join("; ")}`, {
    root: "manifest",
  });
}

/**
 * A plugin directory as install checks it, without installing it: one read,
 * the strict manifest, its entry and ui files present, the module closure
 * inside the artifact, and the hash of exactly the bytes read. A built-in's id
 * is refused. `tavi plugins validate` and `tavi serve --dev-plugin` use it.
 */
export function validatePluginDirectory(
  sourcePath: string,
  builtins: ReadonlySet<string> = new Set(),
  check?: PluginFileCheck,
): { readonly manifest: PluginManifest; readonly hash: string; readonly files: readonly PluginFile[] } {
  if (!isAbsolute(sourcePath)) throw new TaviError("INVALID_INPUT", "a plugin is read from an absolute directory path");
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isDirectory())
    throw new TaviError("NOT_FOUND", `no plugin directory at ${sourcePath}`);
  // An MCP server's tree is read under its kind's bounds (a fetched package or a bundle is larger), as install reads it.
  const peeked = peekManifest(sourcePath);
  const files = readPluginTree(sourcePath, check, peeked?.mcp === undefined ? PLUGIN_BOUNDS : mcpTreeBounds(peeked.provenance.format));
  const manifest = parseManifest(files.find((file) => file.relative === PLUGIN_MANIFEST_FILE)?.content, sourcePath);
  if (builtins.has(manifest.id)) throw new TaviError("CONFLICT", `${manifest.id} is a built-in plugin id`);
  if (manifest.entry !== undefined && !files.some((file) => file.relative === manifest.entry))
    throw new TaviError("INVALID_INPUT", `the manifest's entry ${manifest.entry} does not exist`);
  for (const path of manifest.ui === undefined ? [] : pluginUiFiles(manifest.ui)) {
    if (!files.some((file) => file.relative === path))
      throw new TaviError("INVALID_INPUT", `the manifest's ui file ${path} does not exist`);
  }
  for (const app of manifest.apps?.apps ?? []) {
    if (app.icon !== undefined && !files.some((file) => file.relative === app.icon))
      throw new TaviError("INVALID_INPUT", `the manifest's app icon ${app.icon} does not exist`);
  }
  // A site profile and a site note are checked alike: the file is there, parses as its kind, and its id is the only one.
  const checkDataFiles = (paths: readonly string[], what: string, schema: ZodType<{ readonly id: string }>, kind: string): void => {
    const ids = new Set<string>();
    for (const path of paths) {
      const file = files.find((each) => each.relative === path);
      if (file === undefined) throw new TaviError("INVALID_INPUT", `the manifest's ${what} ${path} does not exist`);
      let raw: unknown;
      try {
        raw = JSON.parse(file.content.toString("utf8"));
      } catch {
        throw new TaviError("INVALID_INPUT", `the ${what} ${path} is not JSON`);
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success)
        throw new TaviError("INVALID_INPUT", `the ${what} ${path} is not a ${kind}: ${zodIssues(parsed.error).join("; ").slice(0, 300)}`);
      if (ids.has(parsed.data.id)) throw new TaviError("INVALID_INPUT", `two ${what}s are named ${parsed.data.id}`);
      ids.add(parsed.data.id);
    }
  };
  checkDataFiles(manifest.sites ?? [], "site profile", SiteProfileSchema, "tavi.sites/1 profile");
  checkDataFiles(manifest.siteNotes ?? [], "site note", SiteNoteSchema, `${SITE_NOTE_ABI} note`);
  // Its language packs: each declared one there, within its limits, and translating only what a person reads.
  localePacksOf(manifest, (path) => files.find((file) => file.relative === path)?.content);
  validateModuleClosure(files);
  return { manifest, hash: hashFiles(files), files };
}

/** A directory's manifest when it parses, read alone (no tree walk); `undefined` otherwise. */
export function peekManifest(directory: string): PluginManifest | undefined {
  const path = join(directory, PLUGIN_MANIFEST_FILE);
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const parsed = PluginManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function readPluginManifest(directory: string): PluginManifest {
  let content: Buffer | undefined;
  try {
    content = readFileSync(join(directory, PLUGIN_MANIFEST_FILE));
  } catch {
    content = undefined;
  }
  return parseManifest(content, directory);
}

/** Language packs read from verified snapshots, by snapshot and content hash: a version's files never change under its hash. */
const verifiedPacks = new Map<string, PluginLocalePacks>();
const MAX_CACHED_PACKS = 256;

/**
 * The language packs of the version `manifest` and `contentHash` name, read
 * from its snapshot in one read whose hash must be `contentHash` (as the
 * canvas's plugin files are), so a pack changed on disk after approval is never
 * shown. Each pack that checks out is kept; one that does not, or a snapshot
 * that no longer matches its hash, leaves English to answer.
 */
function verifiedLocalePacks(directory: string, manifest: PluginManifest, contentHash: string): PluginLocalePacks {
  if (manifest.locales === undefined) return {};
  const key = `${directory}\u0000${contentHash}`;
  const cached = verifiedPacks.get(key);
  if (cached !== undefined) return cached;
  let snapshot: ReturnType<typeof readPluginSnapshot>;
  try {
    snapshot = readPluginSnapshot(directory);
  } catch {
    return {};
  }
  if (snapshot.hash !== contentHash) return {};
  const packs: { [L in Locale]?: PluginLocaleFile } = {};
  for (const [locale, path] of Object.entries(manifest.locales) as [Locale, string][]) {
    try {
      packs[locale] = parseLocalePack(manifest, locale, path, snapshot.files.get(path));
    } catch {
      // Left out: English, then the key, answer for it.
    }
  }
  if (verifiedPacks.size >= MAX_CACHED_PACKS) verifiedPacks.clear();
  verifiedPacks.set(key, packs);
  return packs;
}

/**
 * `manifest` as a person reads it in `locale`: its version's language pack for
 * that language laid over its English (`overlayPluginManifest`), for screens
 * only. English, no pack, a pack that does not check out, or a snapshot that no
 * longer matches `contentHash` answer `manifest` itself, so English output is unchanged.
 */
export function localizedPluginManifest(
  directory: string,
  manifest: PluginManifest,
  locale: Locale | undefined,
  contentHash: string,
): PluginManifest {
  if (locale === undefined || locale === "en" || manifest.locales?.[locale] === undefined) return manifest;
  return overlayPluginManifest(manifest, verifiedLocalePacks(directory, manifest, contentHash)[locale]?.manifest);
}

/**
 * A version's own messages in each language it carries a pack for (`ctx.t`),
 * from its verified snapshot (`contentHash`): a pack that does not check out is
 * left out, so its keys fall back to English, then to the key.
 */
export function readPluginMessages(directory: string, manifest: PluginManifest, contentHash: string): PluginMessages {
  const messages: { [L in Locale]?: Catalog } = {};
  // A pack's messages, as checked, are a catalogue: its optional plural forms are never present as `undefined`.
  for (const [locale, pack] of Object.entries(verifiedLocalePacks(directory, manifest, contentHash)) as [Locale, PluginLocaleFile][])
    messages[locale] = pack.messages as Catalog;
  return messages;
}

/**
 * A version's site profiles, from its verified snapshot: each file its
 * manifest's `sites` names, read as install checked it. One that no longer
 * reads is left out, never guessed at.
 */
export function readPluginSiteProfiles(directory: string, manifest: PluginManifest = readPluginManifest(directory)): SiteProfile[] {
  return (manifest.sites ?? []).flatMap((path) => {
    try {
      const parsed = SiteProfileSchema.safeParse(JSON.parse(readFileSync(join(directory, path), "utf8")));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

/** What a version's review shows of its isolation: the approval's, why it cannot be a worker, what a worker reaches and holds raw. */
function isolationFacts(record: PluginVersionRecord): {
  readonly isolation?: PluginIsolation;
  readonly workerRefusal?: string;
  readonly networkDomains?: readonly string[];
  readonly rawSecrets?: readonly string[];
} {
  if (record.manifest.mcp !== undefined || record.manifest.entry === undefined) return {};
  const refusal = workerRefusal(record.manifest);
  return {
    ...(record.isolation === undefined ? {} : { isolation: record.isolation }),
    ...(refusal === undefined ? {} : { workerRefusal: refusal }),
    ...(record.manifest.network === undefined ? {} : { networkDomains: record.manifest.network.domains }),
    ...(record.manifest.rawSecrets === undefined ? {} : { rawSecrets: record.manifest.rawSecrets }),
  };
}

/**
 * Whether a version imports code into the owner, said outright rather than
 * inferred from a missing `entry`: an MCP server's plugin has none and is not
 * UI-only; a UI-only plugin has `ui` and no `entry`.
 */
export function ownerCodeFacts(manifest: PluginManifest): {
  readonly runsOwnerCode: boolean;
  readonly uiOnly?: true;
  readonly mcp?: McpBlock;
} {
  if (manifest.mcp !== undefined) return { runsOwnerCode: false, mcp: manifest.mcp };
  if (manifest.entry === undefined) return { runsOwnerCode: false, uiOnly: true };
  return { runsOwnerCode: true };
}

/** The running owner's view of composed plugins: a phase, and why it failed when it did. */
export interface PluginLiveStatus {
  readonly status: (id: string) => {
    readonly phase: NonNullable<PluginView["phase"]>;
    readonly error?: string;
    readonly hookLatency?: NonNullable<PluginView["hookLatency"]>;
  };
  /** Plugins `tavi serve --dev-plugin` loaded for this run, each in place of an installed one of its id. */
  readonly dev?: () => readonly PluginView[];
}

/** The listing with each dev plugin in place of an installed one of its id, with its phase. */
export function withDevViews(views: readonly PluginView[], live: PluginLiveStatus | undefined): readonly PluginView[] {
  const dev = live?.dev?.() ?? [];
  if (dev.length === 0) return views;
  const ids = new Set(dev.map((view) => view.id));
  return [...views.filter((view) => !ids.has(view.id)), ...dev.map((view) => ({ ...view, ...live?.status(view.id) }))];
}

/** An enabled external plugin ready to import, or why it cannot be. */
export type ResolvedExternalPlugin =
  | {
      readonly ok: true;
      readonly record: PluginVersionRecord;
      readonly directory: string;
      readonly entryPath: string;
      readonly config: PluginConfig;
      readonly instances: readonly ProviderInstanceConfig[];
      /** Where its state store is kept, when not under its id: a dev plugin's apart from an installed one's. */
      readonly stateId?: string;
    }
  | { readonly ok: false; readonly pluginId: string; readonly error: string };

export interface PluginRegistryOptions {
  readonly repository: PluginRepositoryPort;
  /** MCP server records: an MCP plugin's install writes its tree index here. */
  readonly mcp?: McpRepositoryPort;
  /** `<dataDir>/plugins`: one immutable snapshot per installed version. */
  readonly directory: string;
  readonly builtins: readonly BuiltinPluginInfo[];
  readonly now?: () => string;
}

/**
 * Operator-facing plugin registry. Installing never runs plugin code;
 * only an approved, enabled version whose snapshot still hashes to the
 * recorded value is handed to composition.
 */
export class PluginRegistry {
  readonly #repository: PluginRepositoryPort;
  readonly #mcp: McpRepositoryPort | undefined;
  readonly #directory: string;
  readonly #builtins: ReadonlyMap<string, BuiltinPluginInfo>;
  readonly #now: () => string;

  constructor(options: PluginRegistryOptions) {
    this.#repository = options.repository;
    this.#mcp = options.mcp;
    this.#directory = options.directory;
    this.#builtins = new Map(options.builtins.map((plugin) => [plugin.id, plugin]));
    this.#now = options.now ?? nowTimestamp;
  }

  snapshotDirectory(pluginId: string, version: string): string {
    return join(this.#directory, pluginId, version);
  }

  install(sourcePath: string, by: string): { readonly record: PluginVersionRecord; readonly created: boolean } {
    if (!isAbsolute(sourcePath)) throw new TaviError("INVALID_INPUT", "a plugin is installed from an absolute directory path");
    // An MCP server's tree may be an npm closure of thousands of files: walked and hashed by streaming, under its kind's bounds.
    const peeked = peekManifest(sourcePath);
    if (peeked?.mcp !== undefined) return this.#installMcp(sourcePath, peeked, by);
    // One read: the manifest, the hash and the snapshot all come from the same bytes.
    const { manifest, hash, files } = validatePluginDirectory(sourcePath, new Set(this.#builtins.keys()));
    // An MCP manifest read here but not when peeked was swapped meanwhile: refused, never installed past its checks.
    if (manifest.mcp !== undefined)
      throw new TaviError("CONFLICT", "the plugin's manifest changed while it was being read; nothing was installed");
    const existing = this.#repository.getVersion(manifest.id, manifest.version);
    if (existing !== undefined) {
      if (existing.contentHash === hash) return { record: existing, created: false };
      throw new TaviError(
        "CONFLICT",
        `plugin ${manifest.id}@${manifest.version} is already installed with different contents; installed versions are immutable, so bump the version`,
      );
    }
    this.#checkInstallLimits(manifest.id);
    // Write the bytes that were hashed into a private staging directory, verify it, then move it
    // into place: a crash never leaves a half-written snapshot under a version's name.
    const staging = join(this.#directory, ".staging", randomUUID());
    try {
      for (const file of files) {
        const path = join(staging, ...file.relative.split("/"));
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, file.content, { mode: 0o600, flag: "wx" });
      }
      if (hashPluginDirectory(staging).hash !== hash)
        throw new TaviError("INTERNAL", "the staged plugin does not match what was read; nothing was installed");
      const target = this.snapshotDirectory(manifest.id, manifest.version);
      mkdirSync(join(this.#directory, manifest.id), { recursive: true, mode: 0o700 });
      // No row names this version, so a directory here is a leftover of an interrupted install.
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return this.#repository.addVersion({
      pluginId: manifest.id,
      version: manifest.version,
      contentHash: hash,
      manifest,
      reviewState: "proposed",
      installedBy: by,
      installedAt: this.#now(),
    });
  }

  /**
   * An MCP server's version, installed here in one go (the async registry
   * prepares the tree outside the database worker and calls
   * `commitMcpStaged` itself): its tree listed under its kind's bounds,
   * hashed by streaming, copied into a private staging directory and hashed
   * again there, then committed.
   */
  #installMcp(
    sourcePath: string,
    manifest: PluginManifest,
    by: string,
  ): { readonly record: PluginVersionRecord; readonly created: boolean } {
    const staging = join(this.#directory, ".staging", randomUUID());
    try {
      const prepared = prepareTree(sourcePath, staging, mcpTreeBounds(manifest.provenance.format));
      return this.commitMcpStaged({ manifest, hash: prepared.hash, staging, index: prepared.index }, by);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  /**
   * A prepared MCP server's version committed: its staged manifest must be
   * the one prepared (a manifest swapped meanwhile is refused), its folder
   * grants are checked, an existing version with the same hash is answered,
   * and the staging directory is moved into place and recorded with its
   * index. Cheap: a rename and a few rows, inside the worker's transaction.
   */
  commitMcpStaged(
    input: {
      readonly manifest: PluginManifest;
      readonly hash: string;
      readonly staging: string;
      readonly index: readonly McpTreeIndexEntry[];
    },
    by: string,
  ): { readonly record: PluginVersionRecord; readonly created: boolean } {
    const staged = peekManifest(input.staging);
    if (staged === undefined || JSON.stringify(staged) !== JSON.stringify(input.manifest) || staged.mcp === undefined)
      throw new TaviError("CONFLICT", "the staged server's manifest is not the one that was read; nothing was installed");
    const manifest = staged;
    if (this.#builtins.has(manifest.id)) throw new TaviError("CONFLICT", `${manifest.id} is a built-in plugin id`);
    // Folder grants (`filesystem`) are checked whatever wrote the manifest, not only `tavi mcp add`.
    const grants = mcpFilesystemProblems(manifest.mcp as McpBlock, { home: homedir(), dataDirectory: dirname(this.#directory) });
    if (grants.length > 0) throw new TaviError("INVALID_INPUT", `plugin ${manifest.id} cannot be installed: ${grants.join("; ")}`);
    const existing = this.#repository.getVersion(manifest.id, manifest.version);
    if (existing !== undefined) {
      if (existing.contentHash === input.hash) return { record: existing, created: false };
      throw new TaviError(
        "CONFLICT",
        `plugin ${manifest.id}@${manifest.version} is already installed with different contents; installed versions are immutable, so bump the version`,
      );
    }
    this.#checkInstallLimits(manifest.id);
    const target = this.snapshotDirectory(manifest.id, manifest.version);
    mkdirSync(join(this.#directory, manifest.id), { recursive: true, mode: 0o700 });
    rmSync(target, { recursive: true, force: true });
    renameSync(input.staging, target);
    const added = this.#repository.addVersion({
      pluginId: manifest.id,
      version: manifest.version,
      contentHash: input.hash,
      manifest,
      reviewState: "proposed",
      installedBy: by,
      installedAt: this.#now(),
    });
    this.#mcp?.putVersion({
      pluginId: manifest.id,
      version: manifest.version,
      sandboxState: "srt",
      transport: (manifest.mcp as McpBlock).transport,
      treeIndexStale: false,
    });
    this.#mcp?.putTreeIndex(manifest.id, manifest.version, input.index);
    return added;
  }

  #checkInstallLimits(pluginId: string): void {
    const installed = this.#repository.listVersions().versions;
    const versionsOfPlugin = installed.filter((record) => record.pluginId === pluginId).length;
    const plugins = new Set(installed.map((record) => record.pluginId));
    if (versionsOfPlugin >= PLUGIN_BOUNDS.maxVersionsPerPlugin)
      throw new TaviError(
        "CONFLICT",
        `plugin ${pluginId} already has ${PLUGIN_BOUNDS.maxVersionsPerPlugin} versions installed; remove old ones first`,
      );
    if (!plugins.has(pluginId) && plugins.size >= PLUGIN_BOUNDS.maxPlugins)
      throw new TaviError("CONFLICT", `${PLUGIN_BOUNDS.maxPlugins} plugins are already installed; remove one first`);
  }

  /** What verifying an MCP server's snapshot needs, read in one small step: the hash, bounds, index and whether it is stale. */
  mcpTreeState(
    pluginId: string,
    version: string,
  ): {
    readonly directory: string;
    readonly contentHash: string;
    readonly format: string;
    readonly stale: boolean;
    readonly index: readonly McpTreeIndexEntry[];
  } {
    const record = this.#repository.getVersion(pluginId, version);
    if (record === undefined) throw new TaviError("NOT_FOUND", `plugin ${pluginId}@${version} is not installed`);
    if (record.manifest.mcp === undefined) throw new TaviError("INVALID_INPUT", `${pluginId} is not an MCP server`);
    const stale = this.#mcp?.getVersion(pluginId, version)?.treeIndexStale !== false;
    return {
      directory: this.snapshotDirectory(pluginId, version),
      contentHash: record.contentHash,
      format: record.manifest.provenance.format,
      stale,
      index: this.#mcp?.getTreeIndex(pluginId, version) ?? [],
    };
  }

  /**
   * An MCP server's snapshot checked: by its index, re-hashing only
   * files whose stat changed, unless the index is stale (after a restore) or
   * `full` asks for a whole re-hash against the approved hash, which then
   * rewrites the index. (The async registry does the file work outside the
   * worker, with `mcpTreeState`.)
   */
  verifyMcp(pluginId: string, version: string, full: boolean): TreeCheck {
    const state = this.mcpTreeState(pluginId, version);
    const verified = verifyTree({
      directory: state.directory,
      contentHash: state.contentHash,
      version,
      index: state.index,
      stale: state.stale || this.#mcp === undefined,
      full,
      bounds: mcpTreeBounds(state.format),
    });
    if (verified.index !== undefined) this.#mcp?.putTreeIndex(pluginId, version, verified.index);
    return verified.check;
  }

  /**
   * With `choice` (the approve command's), an approval records where the
   * version runs (`approvedIsolation`): a worker unless it cannot be one
   * or the approver opted out by name. Without it, nothing is recorded, and
   * the version runs in-process as one approved before workers did. With
   * `choice`, an approved version is approved again when the choice differs
   * from its recorded isolation (none, before workers): only that changes.
   */
  decide(
    pluginId: string,
    version: string,
    state: "approved" | "rejected",
    by: string,
    choice?: PluginApprovalChoice,
  ): PluginVersionRecord {
    const isolation =
      state === "approved" && choice !== undefined ? approvedIsolation(this.#versionManifest(pluginId, version), choice) : undefined;
    const record = this.#repository.decide(pluginId, version, state, by, this.#now(), isolation);
    // A rejected active version stops being eligible to run.
    const setting = this.#repository.getSetting(pluginId);
    if (state === "rejected" && setting?.activeVersion === version && setting.enabled)
      this.#put(pluginId, { ...setting, enabled: false }, by);
    return record;
  }

  enable(pluginId: string, by: string, version?: string): PluginSettingRecord {
    const builtin = this.#builtins.get(pluginId);
    if (builtin !== undefined) {
      if (version !== undefined) throw new TaviError("INVALID_INPUT", `${pluginId} is built in and has no versions to choose`);
      const setting = this.#repository.getSetting(pluginId);
      return this.#put(pluginId, { enabled: true, config: setting?.config ?? {} }, by);
    }
    const versions = this.#repository.listVersions(pluginId).versions;
    if (versions.length === 0) throw new TaviError("NOT_FOUND", `plugin ${pluginId} is not installed`);
    const chosen =
      version === undefined
        ? [...versions].reverse().find((record) => record.reviewState === "approved")
        : versions.find((record) => record.version === version);
    if (chosen === undefined)
      throw new TaviError(
        version === undefined ? "CONFLICT" : "NOT_FOUND",
        version === undefined
          ? `plugin ${pluginId} has no approved version; approve one first`
          : `plugin ${pluginId}@${version} is not installed`,
      );
    if (chosen.reviewState !== "approved")
      throw new TaviError(
        "CONFLICT",
        `plugin ${pluginId}@${chosen.version} is ${chosen.reviewState}; only an approved version can be enabled`,
      );
    // Settings the chosen version does not declare (an older version's) are dropped, not refused.
    const stored = this.#repository.getSetting(pluginId)?.config ?? {};
    const config = Object.fromEntries(Object.entries(stored).filter(([key]) => chosen.manifest.config[key] !== undefined));
    const problems = [
      ...pluginConfigProblems(chosen.manifest, config),
      ...providerInstanceProblems(chosen.manifest.capabilities, this.#repository.getSetting(pluginId)?.instances ?? [], pluginId),
    ];
    if (problems.length > 0)
      throw new TaviError("INVALID_INPUT", `plugin ${pluginId} needs configuration before it can run: ${problems.join("; ")}`);
    return this.#put(pluginId, { enabled: true, activeVersion: chosen.version, config }, by);
  }

  disable(pluginId: string, by: string): PluginSettingRecord {
    const builtin = this.#builtins.get(pluginId);
    if (builtin?.core === true) throw new TaviError("CONFLICT", `${pluginId} provides a service other plugins need and cannot be disabled`);
    const setting = this.#repository.getSetting(pluginId);
    if (builtin === undefined && setting === undefined && this.#repository.listVersions(pluginId).versions.length === 0)
      throw new TaviError("NOT_FOUND", `plugin ${pluginId} is not installed`);
    return this.#put(
      pluginId,
      {
        enabled: false,
        ...(setting?.activeVersion === undefined ? {} : { activeVersion: setting.activeVersion }),
        config: setting?.config ?? {},
      },
      by,
    );
  }

  configure(
    pluginId: string,
    set: PluginConfig,
    unset: readonly string[],
    by: string,
    version?: string,
    instances?: readonly ProviderInstanceConfig[],
  ): PluginSettingRecord {
    if (this.#builtins.has(pluginId))
      throw new TaviError("INVALID_INPUT", `${pluginId} is built in; its settings are managed by its own command (see tavi --help)`);
    // An upgrade's settings are prepared against the version that will run: its keys may differ.
    const manifest = version === undefined ? this.#manifestFor(pluginId) : this.#versionManifest(pluginId, version);
    const setting = this.#repository.getSetting(pluginId);
    const config: PluginConfig = { ...(setting?.config ?? {}) };
    for (const key of unset) delete config[key];
    // The CLI and the canvas send text; a number or boolean setting is converted by the manifest's type.
    for (const [key, value] of Object.entries(set)) {
      const field = manifest.config[key];
      if (typeof value === "string" && field?.type === "number" && value.trim() !== "" && Number.isFinite(Number(value)))
        config[key] = Number(value);
      else if (typeof value === "string" && field?.type === "boolean" && (value === "true" || value === "false"))
        config[key] = value === "true";
      else config[key] = value;
    }
    const configuredInstances = ProviderInstancesSchema.parse(instances ?? setting?.instances ?? []);
    const instanceProblems = providerInstanceProblems(manifest.capabilities, configuredInstances, pluginId);
    if (instanceProblems.length > 0) throw new TaviError("INVALID_INPUT", instanceProblems.join("; "));
    // Missing required settings only matter once the plugin is enabled to run.
    // Missing required settings only matter for the version that runs, and only once it is enabled.
    const running = setting?.enabled === true && (version === undefined || version === setting.activeVersion);
    // Against a named version, keys only another version declares are left for enable to drop.
    const checked =
      version === undefined
        ? config
        : Object.fromEntries(Object.entries(config).filter(([key]) => manifest.config[key] !== undefined || Object.hasOwn(set, key)));
    const problems = pluginConfigProblems(manifest, checked).filter((problem) => running || !problem.endsWith("is required"));
    if (problems.length > 0) throw new TaviError("INVALID_INPUT", `plugin ${pluginId} settings were not changed: ${problems.join("; ")}`);
    return this.#put(
      pluginId,
      {
        enabled: setting?.enabled ?? false,
        ...(setting?.activeVersion === undefined ? {} : { activeVersion: setting.activeVersion }),
        config,
        instances: configuredInstances,
      },
      by,
    );
  }

  remove(pluginId: string, version?: string): { readonly removed: readonly string[] } {
    if (this.#builtins.has(pluginId))
      throw new TaviError("INVALID_INPUT", `${pluginId} is built in and cannot be removed; disable it instead`);
    const setting = this.#repository.getSetting(pluginId);
    const versions = this.#repository
      .listVersions(pluginId)
      .versions.filter((record) => version === undefined || record.version === version);
    if (versions.length === 0)
      throw new TaviError(
        "NOT_FOUND",
        version === undefined ? `plugin ${pluginId} is not installed` : `plugin ${pluginId}@${version} is not installed`,
      );
    if (setting?.enabled === true && (version === undefined || setting.activeVersion === version)) {
      throw new TaviError("CONFLICT", `plugin ${pluginId}${version === undefined ? "" : `@${version}`} is enabled; disable it first`);
    }
    for (const record of versions) {
      this.#repository.removeVersion(pluginId, record.version);
      rmSync(this.snapshotDirectory(pluginId, record.version), { recursive: true, force: true });
    }
    if (version === undefined || this.#repository.listVersions(pluginId).versions.length === 0) {
      this.#repository.removeSetting(pluginId);
      this.#repository.clearPluginState(pluginId);
      this.#repository.clearHookEvents(pluginId);
      rmSync(join(this.#directory, pluginId), { recursive: true, force: true });
    } else if (setting?.activeVersion === version) {
      this.#put(pluginId, { enabled: false, config: setting.config }, setting.updatedBy);
    }
    return { removed: versions.map((record) => record.version) };
  }

  /** Built-in ids the operator disabled; composition leaves them out. */
  disabledBuiltins(): ReadonlySet<string> {
    const settings = new Map(this.#repository.listSettings().settings.map((setting) => [setting.pluginId, setting]));
    return new Set(
      [...this.#builtins.values()]
        .filter((builtin) => !builtin.core && !this.#builtinEnabled(builtin, settings.get(builtin.id)))
        .map((builtin) => builtin.id),
    );
  }

  /** On unless turned off — or, for one off by default, until turned on. */
  #builtinEnabled(builtin: BuiltinPluginInfo, setting: PluginSettingRecord | undefined): boolean {
    return setting?.enabled ?? builtin.enabledByDefault !== false;
  }

  /** Enabled external plugins, each re-verified against its approved hash before composition imports it. */
  resolveEnabled(): readonly ResolvedExternalPlugin[] {
    const resolved: ResolvedExternalPlugin[] = [];
    for (const setting of this.#repository.listSettings().settings) {
      if (!setting.enabled || this.#builtins.has(setting.pluginId) || setting.activeVersion === undefined) continue;
      const fail = (error: string) => resolved.push({ ok: false, pluginId: setting.pluginId, error });
      const record = this.#repository.getVersion(setting.pluginId, setting.activeVersion);
      if (record === undefined) {
        fail(`active version ${setting.activeVersion} is not installed`);
        continue;
      }
      if (record.reviewState !== "approved") {
        fail(`version ${record.version} is ${record.reviewState}`);
        continue;
      }
      // An MCP server runs out of process and is never imported: its tree is checked by its
      // index where it is launched, never re-hashed here.
      if (record.manifest.mcp !== undefined) continue;
      const directory = this.snapshotDirectory(record.pluginId, record.version);
      let hash: string;
      try {
        hash = hashPluginDirectory(directory).hash;
      } catch (error) {
        fail(`snapshot unreadable: ${errorMessage(error)}`);
        continue;
      }
      if (hash !== record.contentHash) {
        fail(`snapshot of ${record.version} no longer matches its approved hash; it was changed on disk and will not run`);
        continue;
      }
      const problems = [
        ...pluginConfigProblems(record.manifest, setting.config),
        ...providerInstanceProblems(record.manifest.capabilities, setting.instances ?? [], setting.pluginId),
      ];
      if (problems.length > 0) {
        fail(`configuration: ${problems.join("; ")}`);
        continue;
      }
      // A UI-only plugin runs no owner code: there is nothing to import.
      if (record.manifest.entry === undefined) continue;
      resolved.push({
        ok: true,
        record,
        directory,
        entryPath: join(directory, record.manifest.entry),
        config: setting.config,
        instances: setting.instances ?? [],
      });
    }
    return resolved;
  }

  /**
   * Every plugin as its listing shows it. With `locale`, each version's words a
   * person reads come from its language pack for that language (the canvas's
   * listing); what runs, and what the model reads, never do.
   */
  list(live?: PluginLiveStatus, locale?: Locale): readonly PluginView[] {
    const settings = new Map(this.#repository.listSettings().settings.map((setting) => [setting.pluginId, setting]));
    const byPlugin = new Map<string, PluginVersionRecord[]>();
    const all = this.#repository.listVersions().versions;
    const toolViews = (record: PluginVersionRecord) => pluginToolViews(record);
    const shown = (record: PluginVersionRecord): PluginVersionRecord => {
      const manifest = localizedPluginManifest(
        this.snapshotDirectory(record.pluginId, record.version),
        record.manifest,
        locale,
        record.contentHash,
      );
      return manifest === record.manifest ? record : { ...record, manifest };
    };
    for (const record of all) byPlugin.set(record.pluginId, [...(byPlugin.get(record.pluginId) ?? []), shown(record)]);
    const views: PluginView[] = [];
    for (const builtin of this.#builtins.values()) {
      const setting = settings.get(builtin.id);
      views.push({
        id: builtin.id,
        kind: "builtin",
        name: builtin.id,
        description: builtin.description,
        enabled: this.#builtinEnabled(builtin, setting),
        core: builtin.core,
        versions: [],
        tools: [],
        configFields: {},
        config: {},
        ...(builtin.ui === undefined ? {} : { ui: builtin.ui }),
        ...(builtin.uiOnly === true ? { uiOnly: true as const } : {}),
        runsOwnerCode: builtin.uiOnly !== true,
        ...(builtin.uiContentHash === undefined ? {} : { uiContentHash: builtin.uiContentHash }),
        ...(builtin.mods === undefined ? {} : { mods: modHookViewsOf(builtin.mods) }),
        ...live?.status(builtin.id),
      });
    }
    for (const [pluginId, versions] of [...byPlugin].sort(([a], [b]) => a.localeCompare(b))) {
      const setting = settings.get(pluginId);
      // A plugin is listed by its versions, so it has at least one.
      const current = versions.find((record) => record.version === setting?.activeVersion) ?? versions.at(-1);
      if (current === undefined) continue;
      views.push({
        id: pluginId,
        kind: current.manifest.mcp === undefined ? "external" : "mcp",
        name: current.manifest.name,
        description: current.manifest.description,
        enabled: setting?.enabled ?? false,
        core: false,
        ...(setting?.activeVersion === undefined ? {} : { activeVersion: setting.activeVersion }),
        versions: versions.map((record) => ({
          version: record.version,
          reviewState: record.reviewState,
          contentHash: record.contentHash,
          installedAt: record.installedAt,
          tools: toolViews(record),
          capabilities: record.manifest.capabilities,
          provenance: record.manifest.provenance,
          configFields: record.manifest.config,
          ...definedOnly({ router: record.manifest.router, ui: record.manifest.ui, apps: record.manifest.apps }),
          ...(record.manifest.channels.length === 0
            ? {}
            : { channels: record.manifest.channels.map((descriptor) => channelDisclosureOf(descriptor)) }),
          ...ownerCodeFacts(record.manifest),
          ...isolationFacts(record),
          ...(record.manifest.mods === undefined || record.manifest.mods.hooks.length === 0
            ? {}
            : { mods: modHookViewsOf(record.manifest.mods) }),
          ...(record.manifest.mods === undefined || record.manifest.mods.commands.length === 0
            ? {}
            : { commands: record.manifest.mods.commands }),
          ...definedOnly({
            heartbeat: record.manifest.heartbeat,
            heartbeatSignals: record.manifest.heartbeatSignals,
            memory: record.manifest.memory,
            ideas: record.manifest.ideas,
            onboarding: record.manifest.onboarding,
          }),
        })),
        directory: join(this.#directory, pluginId),
        tools: toolViews(current),
        instances: setting?.instances ?? [],
        configFields: current.manifest.config,
        config: setting?.config ?? {},
        ...(current.manifest.ui === undefined ? {} : { ui: current.manifest.ui }),
        ...ownerCodeFacts(current.manifest),
        ...(current.isolation === undefined ? {} : { isolation: current.isolation }),
        ...(current.manifest.mods === undefined || current.manifest.mods.hooks.length === 0
          ? {}
          : { mods: modHookViewsOf(current.manifest.mods) }),
        ...(current.manifest.mods === undefined || current.manifest.mods.commands.length === 0
          ? {}
          : { commands: current.manifest.mods.commands }),
        ...live?.status(pluginId),
      });
    }
    return withDevViews(views, live);
  }

  show(pluginId: string, live?: PluginLiveStatus, locale?: Locale): PluginView {
    const view = this.list(live, locale).find((candidate) => candidate.id === pluginId);
    if (view === undefined) throw new TaviError("NOT_FOUND", `no plugin ${pluginId}`);
    return view;
  }

  #versionManifest(pluginId: string, version: string): PluginManifest {
    const record = this.#repository.getVersion(pluginId, version);
    if (record === undefined) throw new TaviError("NOT_FOUND", `plugin ${pluginId}@${version} is not installed`);
    if (record.reviewState === "rejected") throw new TaviError("CONFLICT", `plugin ${pluginId}@${version} was rejected`);
    return record.manifest;
  }

  #manifestFor(pluginId: string): PluginManifest {
    const setting = this.#repository.getSetting(pluginId);
    const versions = this.#repository.listVersions(pluginId).versions;
    const record = versions.find((candidate) => candidate.version === setting?.activeVersion) ?? versions.at(-1);
    if (record === undefined) throw new TaviError("NOT_FOUND", `plugin ${pluginId} is not installed`);
    return record.manifest;
  }

  #put(pluginId: string, value: Omit<PluginSettingRecord, "pluginId" | "updatedBy" | "updatedAt">, by: string): PluginSettingRecord {
    return this.#repository.putSetting({
      pluginId,
      instances: this.#repository.getSetting(pluginId)?.instances ?? [],
      ...value,
      updatedBy: by,
      updatedAt: this.#now(),
    });
  }
}
