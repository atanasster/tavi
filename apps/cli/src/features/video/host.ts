import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  AnalyzerConfigSchema,
  AnalyzerManifestSchema,
  VIDEO_LIMITS,
  type PdfEnginePort,
  type AnalyzerConfig,
  type AnalyzerEntry,
  type AnalyzerManifest,
  type ConfinementPort,
  type VideoAnalyzerRegistry,
  type ResourceLimitPort,
  type SandboxHostPort,
  type VideoAnalyzerPort,
  type VideoCapability,
  type VideoDecoderFacts,
  type VideoDecoderPort,
  type VideoLaunch,
  type VideoPoseEnginePort,
  type VideoSandbox,
  type VideoWrapped,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { NoFollowReadError, readNoFollowSync, serialLock, type SerialLock } from "@tavi/node-kit";
import {
  createAnalyzerRegistry,
  createCommandAnalyzer,
  createFfmpegDecoder,
  createMcpAnalyzer,
  createVideoOcrAnalyzer,
  createVideoPoseEngine,
  findFfmpeg,
  libraryRoots,
  listBinaryLibraries,
  type FfmpegPaths,
} from "@tavi/plugin-video";

import type { McpAnalyzerTool, McpHost } from "../mcp/host.js";
import { ownerDenyRead, readOwnerReadRoots } from "../sandbox/host.js";

/**
 * Where the owner puts video understanding's modules together: the decoder
 * (`@tavi/plugin-video`, over the person's own FFmpeg), its confinement (the
 * owner's `ConfinementPort` and `ResourceLimitPort`), and, as they land, the
 * analysers. This module alone names an implementation; the video tools see
 * only `VideoDecoderPort`.
 */

export interface VideoHostOptions {
  /** `serve --video-ffmpeg` / `--video-ffprobe`: the person's binaries, when not on `PATH`. */
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  /** `serve --video-allow-unconfined`: on a Linux host whose sandbox is unavailable, run FFmpeg bare rather than refuse. */
  readonly allowUnconfined?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly host?: SandboxHostPort;
  readonly limits?: ResourceLimitPort;
  /** What the owner's confinement denies every child (`ownerDenyRead`); by default what `serve` recorded for this data directory. */
  readonly ownerDenyRead?: readonly string[];
}

/**
 * The denied roots a binary's libraries are reopened inside: the video
 * list and the owner's, so a binary under a folder given for chats is
 * reopened too.
 */
export function videoLibraryDenyRead(dataDirectory: string, options: VideoHostOptions): readonly string[] {
  return [
    ...new Set([
      ...videoDenyRead(dataDirectory, options.platform),
      ...(options.ownerDenyRead ?? ownerDenyRead(readOwnerReadRoots(dataDirectory))),
    ]),
  ];
}

/**
 * What a video run may not read: home and the data directory, and, on macOS,
 * the temporary and users' directories too. Every fixture ran the same under
 * that extended list on macOS; Linux keeps the standard one until it is tried
 * there.
 */
export function videoDenyRead(dataDirectory: string, platform: NodeJS.Platform = process.platform): readonly string[] {
  const standard = [homedir(), dataDirectory];
  return platform === "darwin" ? [...standard, "/tmp", "/private/tmp", "/var/tmp", "/Users"] : standard;
}

/**
 * How video children are confined: under srt with no network,
 * the run directory the only readable and writable place inside the denied
 * roots (with the binaries' own library closure), each in its own cgroup.
 * The tier is read at each launch: on Linux while it is `unavailable`, a run
 * is refused (`unconfined`) unless the owner started `serve` with
 * `--video-allow-unconfined`. The policy file lives in the run directory, so
 * removing the run removes it; srt reads it before the child starts.
 */
export function videoSandbox(dataDirectory: string, confinement: ConfinementPort, options: VideoHostOptions = {}): VideoSandbox {
  const platform = options.platform ?? process.platform;
  const denyRead = videoDenyRead(dataDirectory, platform);
  // Where srt cannot confine at all (neither macOS nor Linux), a run is as unconfinable as on Linux without a sandbox.
  const confines = platform === "darwin" || platform === "linux";
  return {
    kind: "wrapped",
    wrap: (launch: VideoLaunch): VideoWrapped | { readonly refused: "unconfined" } => {
      const tier = !confines ? "unavailable" : platform === "linux" ? (options.host?.current().tier ?? "unavailable") : "full";
      let wrapped: VideoWrapped;
      if (tier === "unavailable") {
        if (options.allowUnconfined !== true) return { refused: "unconfined" };
        wrapped = { command: launch.argv[0] ?? "", args: launch.argv.slice(1), env: launch.env };
      } else {
        wrapped = confinement.wrap({
          argv: launch.argv,
          env: launch.env,
          policyFile: join(launch.runDirectory, "srt.json"),
          policy: {
            denyRead,
            allowRead: [launch.runDirectory, ...launch.readRoots],
            allowWrite: [launch.runDirectory],
            domains: [...(launch.domains ?? [])],
            nested: tier === "nested",
          },
        });
      }
      // Its own cgroup, confined or bare: the video workload's memory and pids.
      const limits = options.limits;
      if (limits === undefined) return wrapped;
      const { argv, groupId } = limits.place([wrapped.command, ...wrapped.args], "video", {
        memoryBytes: launch.limits.memoryBytes,
        processes: launch.limits.processes,
      });
      return {
        command: argv[0] as string,
        args: argv.slice(1),
        env: wrapped.env,
        ...(groupId === undefined
          ? {}
          : {
              onExit: () => {
                const outcome = limits.outcome(groupId);
                limits.release(groupId);
                return outcome;
              },
              kill: () => limits.kill(groupId),
            }),
      };
    },
  };
}

/** How video runs go on this host now (`doctor`): confined by srt, refused, or bare by the owner's choice. */
export function videoConfinement(options: VideoHostOptions = {}): "srt" | "refused" | "unconfined" {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return "srt";
  if (platform === "linux" && options.host !== undefined && options.host.current().tier !== "unavailable") return "srt";
  return options.allowUnconfined === true ? "unconfined" : "refused";
}

/** The person's FFmpeg, found as the decoder finds it: for registration and `doctor`, without running it. */
export function videoFfmpeg(options: VideoHostOptions = {}): FfmpegPaths | { readonly missing: string } {
  return findFfmpeg({
    ...(options.ffmpeg === undefined ? {} : { ffmpeg: options.ffmpeg }),
    ...(options.ffprobe === undefined ? {} : { ffprobe: options.ffprobe }),
  });
}

/** The owner's video decoder: the built-in one over the person's FFmpeg, confined, its runs under `<data>/video/runs`. */
export async function createVideoDecoder(
  dataDirectory: string,
  confinement: ConfinementPort,
  options: VideoHostOptions = {},
): Promise<VideoDecoderPort> {
  const denied = videoLibraryDenyRead(dataDirectory, options);
  return createFfmpegDecoder({
    sandbox: videoSandbox(dataDirectory, confinement, options),
    runsDirectory: join(dataDirectory, "video", "runs"),
    ...(options.ffmpeg === undefined ? {} : { ffmpeg: options.ffmpeg }),
    ...(options.ffprobe === undefined ? {} : { ffprobe: options.ffprobe }),
    readRoots: (paths) => [
      ...new Set([...libraryRoots(paths.ffmpeg, denied, listBinaryLibraries), ...libraryRoots(paths.ffprobe, denied, listBinaryLibraries)]),
    ],
  });
}

/**
 * What `doctor` says of video: the FFmpeg found and its build, or why there
 * is none, and how runs are confined, with the sandbox's live check: srt
 * that does not work here fails every video call, which is said with its fix.
 */
export function videoDoctorFacts(
  facts: VideoDecoderFacts | { readonly missing: string },
  options: VideoHostOptions = {},
  sandbox?: { readonly works: boolean; readonly cause?: string | undefined; readonly fix?: string | undefined },
): Record<string, unknown> {
  const confinement = videoConfinement(options);
  const how =
    confinement === "srt"
      ? "each video is read in its own srt sandbox: no network, only its run directory writable"
      : confinement === "refused"
        ? "the sandbox is unavailable on this host, so video calls are refused: fix the sandbox (tavi sandbox setup), or start serve with --video-allow-unconfined"
        : "the sandbox is unavailable and serve was started with --video-allow-unconfined: videos are read unconfined, within their memory and time caps";
  const broken =
    confinement === "srt" && sandbox !== undefined && !sandbox.works
      ? {
          works: false,
          ...(sandbox.cause === undefined ? {} : { cause: sandbox.cause }),
          note: `the video tools fail until srt works here${sandbox.fix === undefined ? "" : ` (${sandbox.fix})`}; \`tavi config set video.enabled off\` turns them off meanwhile`,
        }
      : {};
  if ("missing" in facts) return { ffmpeg: "missing", fix: facts.missing, confinement, detail: how, ...broken };
  return {
    ffmpeg: facts.version,
    decoders: facts.decoders,
    features: facts.features,
    confinement,
    detail: how,
    limits: `${String(VIDEO_LIMITS.childMemoryMb)} MiB, ${String(VIDEO_LIMITS.processes)} pids; ${String(VIDEO_LIMITS.maxInputBytes / 1024 / 1024)} MiB and ${String(VIDEO_LIMITS.maxDurationSec / 60)} min a video`,
    ...(facts.warnings.length === 0 ? {} : { warnings: facts.warnings }),
    ...broken,
  };
}

// ------------------------------------------------------------------ analysers

/** Where the owner's analyser configuration lives: host configuration, never a workspace setting. */
export function analyzerConfigPath(dataDirectory: string): string {
  return join(dataDirectory, "video", "analyzers.json");
}

/** The most an `analyzers.json` may hold. */
const ANALYZER_CONFIG_MAX_BYTES = 64 * 1024;

/**
 * The owner's `<data>/video/analyzers.json`, validated: absent means
 * the built-in chains; one that cannot be read or does not parse is an error
 * `doctor` shows, and the video tools then run with no analysers rather than
 * on a guess. Read without following a link, within a size cap.
 */
export function loadAnalyzerConfig(
  dataDirectory: string,
): { readonly config: AnalyzerConfig; readonly present: boolean } | { readonly error: string } {
  const path = analyzerConfigPath(dataDirectory);
  let bytes: Buffer | undefined;
  try {
    bytes = readNoFollowSync(path, { maxBytes: ANALYZER_CONFIG_MAX_BYTES });
  } catch (error) {
    if (error instanceof NoFollowReadError)
      return {
        error:
          error.reason === "too-large"
            ? `${path} is over ${String(ANALYZER_CONFIG_MAX_BYTES / 1024)} KiB`
            : `${path} is not a regular file`,
      };
    return { error: `${path} could not be read: ${errorMessage(error)}` };
  }
  // Only a file that is not there means the built-in chains; one that cannot be read is an error.
  if (bytes === undefined) return { config: AnalyzerConfigSchema.parse({}), present: false };
  const text = bytes.toString("utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: `${path} is not JSON` };
  }
  const parsed = AnalyzerConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `${path}: ${issue === undefined ? "invalid" : `${issue.path.join(".") || "(top)"}: ${issue.message}`}` };
  }
  return { config: parsed.data, present: true };
}

type McpEntry = Extract<AnalyzerEntry, { readonly type: "mcp" }>;

/** An MCP entry's server as a plugin id: `mcp.<name>`, written either way in `analyzers.json`. */
function mcpAnalyzerServer(entry: Pick<McpEntry, "server">): string {
  return entry.server.startsWith("mcp.") ? entry.server : `mcp.${entry.server}`;
}

/** Where the owner puts an MCP analyser's media for its server to read: the one such place inside the data directory. */
export function videoMcpExchange(dataDirectory: string, pluginId: string): string {
  return join(dataDirectory, "video", "mcp", pluginId);
}

/**
 * The MCP servers `analyzers.json` names: each one's stdio launch may
 * read its exchange directory. Read when the MCP host is made; a change takes
 * effect at the next `serve`, when every server starts afresh.
 */
export function videoMcpServers(dataDirectory: string): ReadonlySet<string> {
  const loaded = loadAnalyzerConfig(dataDirectory);
  if ("error" in loaded) return new Set();
  return new Set(
    CONFIGURED.flatMap((capability) =>
      loaded.config[capability].flatMap((entry) => (entry.type === "mcp" ? [mcpAnalyzerServer(entry)] : [])),
    ),
  );
}

/** The MCP client as the video host uses it: a tool looked up, and called. */
export type VideoMcpClient = Pick<McpHost, "analyzerTool" | "callAnalyzer">;

/** Each MCP entry's tool, looked up before the chains are built: keyed by `mcpToolKey`. */
export interface VideoMcpTools {
  readonly tools: ReadonlyMap<string, McpAnalyzerTool | { readonly missing: string }>;
  readonly client: VideoMcpClient;
}

const mcpToolKey = (pluginId: string, tool: string): string => `${pluginId}\u0000${tool}`;

/** Looks up every MCP entry's tool in `analyzers.json`, for `createVideoAnalyzers`; one that cannot be looked up is said as missing. */
export async function resolveVideoMcpTools(dataDirectory: string, client: VideoMcpClient): Promise<VideoMcpTools> {
  const loaded = loadAnalyzerConfig(dataDirectory);
  const tools = new Map<string, McpAnalyzerTool | { readonly missing: string }>();
  if ("error" in loaded) return { tools, client };
  for (const capability of CONFIGURED) {
    for (const entry of loaded.config[capability]) {
      if (entry.type !== "mcp") continue;
      const pluginId = mcpAnalyzerServer(entry);
      const key = mcpToolKey(pluginId, entry.tool);
      if (tools.has(key)) continue;
      try {
        tools.set(key, await client.analyzerTool(pluginId, entry.tool));
      } catch (error) {
        tools.set(key, { missing: errorMessage(error) });
      }
    }
  }
  return { tools, client };
}

/**
 * An MCP entry's manifest: the owner's pin, else the tool's own
 * (`_meta["tavi/analyzer"]`, approved with its definition); never local when
 * its server can reach the network (`serverHasEgress`), whatever it
 * claims, so its every call is external.
 */
function mcpManifest(entry: McpEntry, tool: McpAnalyzerTool): AnalyzerManifest | { readonly refused: string } {
  let manifest = entry.manifest;
  if (manifest === undefined) {
    if (tool.definition.analyzer === undefined)
      return { refused: `${tool.name} declares no _meta["tavi/analyzer"] and the entry pins no manifest` };
    const parsed = AnalyzerManifestSchema.safeParse(tool.definition.analyzer);
    if (!parsed.success) return { refused: `${tool.name}'s _meta["tavi/analyzer"] is not an analyser manifest` };
    manifest = parsed.data;
  }
  return tool.egress ? { ...manifest, local: false } : manifest;
}

/** One entry of a capability's chain as `doctor` shows it: who, where it runs, and whether it is in use. */
interface AnalyzerChainEntry {
  readonly id: string;
  readonly type: AnalyzerEntry["type"];
  readonly local?: boolean;
  readonly status: "ready" | "not-installed" | "refused";
  readonly note?: string;
}

type BuiltinEntry = Extract<AnalyzerEntry, { readonly type: "builtin" }>;

/**
 * Built analysers the owner can name as `builtin` (the pose and
 * transcription add-ons, the PDF engine's OCR): each made from its entry
 * (the person's own model), or why it cannot run.
 */
export type BuiltinAnalyzers = Partial<
  Record<BuiltinEntry["id"], (entry: BuiltinEntry) => VideoAnalyzerPort | { readonly missing: string }>
>;

export interface VideoAnalyzers {
  readonly registry: VideoAnalyzerRegistry;
  /** Each capability's chain as configured, for `doctor`. */
  readonly chains: Readonly<Partial<Record<VideoCapability, readonly AnalyzerChainEntry[]>>>;
  /** Why `analyzers.json` was not used, when it was not. */
  readonly configError?: string | undefined;
  /** Closes every analyser. */
  close(): Promise<void>;
}

const CONFIGURED: readonly Exclude<VideoCapability, "describe">[] = ["pose", "transcribe", "ocr"];

/**
 * The owner's analysers, from `analyzers.json`, in its order per capability:
 * a command entry runs under the decoder's confinement with its
 * own `readRoots` (and its `domains` only when it is remote); a built-in is
 * used when its add-on is installed and skipped otherwise; an MCP entry is its
 * server's approved tool, looked up beforehand (`resolveVideoMcpTools`). An
 * entry that cannot run is listed with why, never guessed.
 */
export function createVideoAnalyzers(
  dataDirectory: string,
  confinement: ConfinementPort,
  options: VideoHostOptions = {},
  builtins: BuiltinAnalyzers = {},
  mcp?: VideoMcpTools,
): VideoAnalyzers {
  const loaded = loadAnalyzerConfig(dataDirectory);
  const config = "error" in loaded ? undefined : loaded.config;
  const sandbox = videoSandbox(dataDirectory, confinement, options);
  const ports: Partial<Record<VideoCapability, VideoAnalyzerPort[]>> = {};
  const chains: Partial<Record<VideoCapability, AnalyzerChainEntry[]>> = {};
  // One analyser per command entry, shared by the capabilities that list it: the same id is the same definition.
  const commands = new Map<string, VideoAnalyzerPort>();
  // One per MCP tool, and one lock per server: its exchange directory holds one call's media at a time.
  const tools = new Map<string, VideoAnalyzerPort>();
  const locks = new Map<string, SerialLock>();
  const resolvedTool = (entry: McpEntry): McpAnalyzerTool | { readonly missing: string } =>
    mcp?.tools.get(mcpToolKey(mcpAnalyzerServer(entry), entry.tool)) ?? { missing: "MCP servers are not reachable here" };
  // Every command entry first, whatever its order: an id given two definitions, or a manifest id two entries
  // claim, refuses all of them. The approval card, the registry's remote check and dispatch name an analyser
  // by its manifest id, so one id must be one command.
  const definitions = new Map<string, Set<string>>();
  const claimants = new Map<string, Set<string>>();
  for (const capability of CONFIGURED) {
    for (const entry of config?.[capability] ?? []) {
      if (entry.type === "mcp") {
        // An MCP tool claims its manifest's id too: the same tool listed twice is one claimant.
        const tool = resolvedTool(entry);
        const manifest = "missing" in tool ? undefined : mcpManifest(entry, tool);
        if (manifest !== undefined && !("refused" in manifest))
          claimants.set(manifest.id, (claimants.get(manifest.id) ?? new Set()).add(`MCP tool ${mcpAnalyzerServer(entry)}/${entry.tool}`));
        continue;
      }
      if (entry.type !== "command") continue;
      definitions.set(entry.id, (definitions.get(entry.id) ?? new Set()).add(JSON.stringify(entry)));
      claimants.set(entry.manifest.id, (claimants.get(entry.manifest.id) ?? new Set()).add(`command ${entry.id}`));
    }
  }
  const owners = new Map<string, string>(
    [...claimants].flatMap(([id, held]) => (held.size === 1 ? [[id, [...held][0] as string] as const] : [])),
  );
  const claim = (manifestId: string, owner: string): string | undefined => {
    const held = claimants.get(manifestId);
    if (held !== undefined && held.size > 1) return `its manifest id ${manifestId} is claimed by ${[...held].join(" and ")}`;
    const holder = owners.get(manifestId);
    if (holder !== undefined && holder !== owner) return `its manifest id ${manifestId} is already ${holder}'s`;
    owners.set(manifestId, owner);
    return undefined;
  };
  for (const capability of CONFIGURED) {
    const listed: AnalyzerChainEntry[] = [];
    const chain: VideoAnalyzerPort[] = [];
    for (const entry of config?.[capability] ?? []) {
      if (entry.type === "builtin") {
        const make = builtins[entry.id];
        let made: ReturnType<NonNullable<typeof make>> | undefined;
        try {
          made = make?.(entry);
        } catch (error) {
          // A built-in that cannot be made (a path the command analyser refuses) is listed, never a failed start.
          made = { missing: errorMessage(error) };
        }
        if (made === undefined)
          listed.push({
            id: entry.id,
            type: "builtin",
            status: "not-installed",
            note: entry.id === "pdf-ocr" ? "the PDF engine is not available here" : "its add-on is not installed",
          });
        else if ("missing" in made) listed.push({ id: entry.id, type: "builtin", status: "not-installed", note: made.missing });
        else {
          const taken = claim(made.manifest().id, `builtin ${entry.id}`);
          if (taken !== undefined)
            listed.push({ id: entry.id, type: "builtin", local: made.manifest().local, status: "refused", note: taken });
          else {
            chain.push(made);
            // The licence the person gave for their model, as results carry it.
            listed.push({
              id: entry.id,
              type: "builtin",
              local: made.manifest().local,
              status: "ready",
              note: `licence ${made.manifest().attribution.licence}`,
            });
          }
        }
      } else if (entry.type === "mcp") {
        const pluginId = mcpAnalyzerServer(entry);
        const id = `${pluginId}/${entry.tool}`;
        const tool = resolvedTool(entry);
        if ("missing" in tool) {
          listed.push({ id, type: "mcp", status: "not-installed", note: tool.missing });
          continue;
        }
        const manifest = mcpManifest(entry, tool);
        if ("refused" in manifest) {
          listed.push({ id, type: "mcp", status: "refused", note: manifest.refused });
          continue;
        }
        // An entry that pins a manifest with another id than the same tool's other entries is refused by the claim.
        const declares = manifest.capabilities.some((candidate) => candidate.capability === capability);
        const taken = !declares ? `its manifest does not declare ${capability}` : claim(manifest.id, `MCP tool ${id}`);
        if (taken !== undefined) {
          listed.push({ id, type: "mcp", local: manifest.local, status: "refused", note: taken });
          continue;
        }
        // The same tool under the same manifest is one analyser, whichever capabilities list it.
        const key = `${id}\u0000${JSON.stringify(manifest)}`;
        let made = tools.get(key);
        if (made === undefined) {
          // A stdio server reads the media from its exchange directory, one call at a time; any other is sent it inline.
          const lock = locks.get(pluginId) ?? serialLock();
          locks.set(pluginId, lock);
          const client = mcp?.client as VideoMcpClient;
          made = createMcpAnalyzer({
            manifest,
            call: async (args, callOptions) => client.callAnalyzer(tool, args, callOptions),
            ...(tool.transport === "stdio" ? { exchange: { directory: videoMcpExchange(dataDirectory, pluginId), lock } } : {}),
          });
          tools.set(key, made);
        }
        chain.push(made);
        listed.push({
          id,
          type: "mcp",
          local: manifest.local,
          status: "ready",
          ...(tool.egress ? { note: "its server can reach the network, so its calls are external and asked" } : {}),
        });
      } else {
        const declares = entry.manifest.capabilities.some((candidate) => candidate.capability === capability);
        // The child's PATH is the system's: a command is named by its absolute path, never looked up.
        const refusal = !isAbsolute(entry.command)
          ? "its command must be an absolute path"
          : entry.readRoots.some((root) => !isAbsolute(root))
            ? "its readRoots must be absolute paths"
            : !declares
              ? `its manifest does not declare ${capability}`
              : undefined;
        if (refusal !== undefined) {
          listed.push({ id: entry.id, type: "command", local: entry.manifest.local, status: "refused", note: refusal });
          continue;
        }
        if ((definitions.get(entry.id)?.size ?? 0) > 1) {
          listed.push({
            id: entry.id,
            type: "command",
            local: entry.manifest.local,
            status: "refused",
            note: `another command entry is named ${entry.id}`,
          });
          continue;
        }
        let made = commands.get(entry.id);
        if (made === undefined) {
          const taken = claim(entry.manifest.id, `command ${entry.id}`);
          if (taken !== undefined) {
            listed.push({ id: entry.id, type: "command", local: entry.manifest.local, status: "refused", note: taken });
            continue;
          }
          try {
            made = createCommandAnalyzer({ entry, sandbox });
            commands.set(entry.id, made);
          } catch (error) {
            listed.push({ id: entry.id, type: "command", local: entry.manifest.local, status: "refused", note: errorMessage(error) });
            continue;
          }
        }
        chain.push(made);
        listed.push({ id: entry.id, type: "command", local: entry.manifest.local, status: "ready" });
      }
    }
    ports[capability] = chain;
    chains[capability] = listed;
  }
  const registry = createAnalyzerRegistry(ports);
  return { registry, chains, close: async () => registry.close(), ...("error" in loaded ? { configError: loaded.error } : {}) };
}

/** What `doctor` says of the analysers: each capability's chain, and why `analyzers.json` was not used. */
export function videoAnalyzerFacts(
  analyzers: Pick<VideoAnalyzers, "chains" | "configError">,
  dataDirectory: string,
): Record<string, unknown> {
  return {
    config: analyzerConfigPath(dataDirectory),
    // Video's speech and voice messages share this one chain: "ready", or why none can run.
    transcription: transcribeSetupNote(analyzers) ?? "ready",
    ...(analyzers.configError === undefined
      ? {}
      : { configError: analyzers.configError, note: "no analyser runs until analyzers.json parses" }),
    chains: Object.fromEntries(
      CONFIGURED.map((capability) => [
        capability,
        (analyzers.chains[capability] ?? []).map(
          (entry) =>
            `${entry.id} (${entry.type}${entry.local === false ? ", remote" : ""}): ${entry.status}${entry.note === undefined ? "" : `, ${entry.note}`}`,
        ),
      ]),
    ),
  };
}

/**
 * Why no transcription analyser can run, in the person's terms: each configured entry that is not ready, with its
 * reason, or that none is configured. Undefined when one is ready.
 */
export function transcribeSetupNote(analyzers: Pick<VideoAnalyzers, "chains" | "configError">): string | undefined {
  if (analyzers.configError !== undefined) return `analyzers.json could not be used (${analyzers.configError})`;
  const chain = analyzers.chains.transcribe ?? [];
  if (chain.some((entry) => entry.status === "ready")) return undefined;
  if (chain.length === 0) return "no transcription analyser (whisper.cpp with a ggml model) is named in analyzers.json";
  return chain.map((entry) => `${entry.id}: ${entry.note ?? entry.status}`).join("; ");
}

/** The owner's analysers, whose chains can be read again from `analyzers.json` while it runs (voice setup writes it). */
export interface ReloadableAnalyzers extends VideoAnalyzers {
  reload(): Promise<void>;
}

/** How long a replaced set of analysers lives on: a call already running on one finishes before it is closed. */
const REPLACED_ANALYZERS_CLOSE_MS = 10 * 60_000;

/**
 * `initial`, behind a registry that always asks the latest: `reload` reads them again with `read` (absent: nothing to
 * read again, as for a test's own registry) and closes the ones replaced once a running call has had time to end.
 */
export function reloadableAnalyzers(initial: VideoAnalyzers, read?: () => Promise<VideoAnalyzers>): ReloadableAnalyzers {
  let current = initial;
  return {
    registry: {
      for: (capability) => current.registry.for(capability),
      first: (call, options) => current.registry.first(call, options),
      analyze: (request, options) => current.registry.analyze(request, options),
    },
    get chains() {
      return current.chains;
    },
    get configError() {
      return current.configError;
    },
    close: async () => await current.close(),
    reload: async () => {
      if (read === undefined) return;
      const replaced = current;
      current = await read();
      setTimeout(() => void replaced.close().catch(() => undefined), REPLACED_ANALYZERS_CLOSE_MS).unref();
    },
  };
}

/** The person's whisper.cpp CLI, as the transcription add-on finds it; undefined when either is not installed. */
export async function findWhisperCli(): Promise<string | undefined> {
  return (await loadVideoTranscribeAddOn())?.findWhisper();
}

/** The owner's pose arithmetic and overlays, the built-in ones: what `video.pose` measures and draws with. */
export function videoPoseEngine(): VideoPoseEnginePort {
  return createVideoPoseEngine();
}

/** The pose add-on's module, as `video-host` uses it: absent when it is not installed. */
interface VideoPoseAddOn {
  readonly poseAnalyzerEntry: (
    model: NonNullable<BuiltinEntry["model"]> | undefined,
    options: { readonly dataDirectory: string },
  ) => { readonly entry: Extract<AnalyzerEntry, { readonly type: "command" }> } | { readonly missing: string };
}

/** The transcription add-on's module, as `video-host` uses it: absent when it is not installed. */
interface VideoTranscribeAddOn {
  readonly findWhisper: () => string | undefined;
  readonly transcribeAnalyzerEntry: (
    model: NonNullable<BuiltinEntry["model"]> | undefined,
    options: { readonly dataDirectory: string; readonly libraryRoots?: (binary: string) => readonly string[] },
  ) => { readonly entry: Extract<AnalyzerEntry, { readonly type: "command" }> } | { readonly missing: string };
}

/** An add-on's module when it is installed beside Tavi; undefined when it is not, and a broken install is the owner's to see. */
async function loadAddOn<T>(load: () => Promise<unknown>): Promise<T | undefined> {
  try {
    return (await load()) as T;
  } catch (error) {
    if ((error as { readonly code?: unknown } | null)?.code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

/** `@tavi/video-transcribe` when it is installed beside Tavi; undefined when it is not. */
export async function loadVideoTranscribeAddOn(): Promise<VideoTranscribeAddOn | undefined> {
  return loadAddOn<VideoTranscribeAddOn>(() => import("@tavi/video-transcribe"));
}

/** `@tavi/video-pose` when it is installed beside Tavi; undefined when it is not, and `doctor` says so. */
export async function loadVideoPoseAddOn(): Promise<VideoPoseAddOn | undefined> {
  return loadAddOn<VideoPoseAddOn>(() => import("@tavi/video-pose"));
}

/**
 * The built-ins the installed add-ons give: RTMPose from `@tavi/video-pose`,
 * on the person's model, run as a command analyser under the decoder's
 * sandbox (its own package, its runtime and the model the only reads beyond
 * the run).
 */
export function videoBuiltins(
  dataDirectory: string,
  confinement: ConfinementPort,
  options: VideoHostOptions,
  pose: VideoPoseAddOn | undefined,
  transcribe?: VideoTranscribeAddOn,
  pdfEngine?: () => PdfEnginePort,
): BuiltinAnalyzers {
  const sandbox = videoSandbox(dataDirectory, confinement, options);
  return {
    // The PDF engine's OCR, where its add-on is installed.
    ...(pdfEngine === undefined
      ? {}
      : {
          "pdf-ocr": () =>
            pdfEngine().ocrAvailable
              ? pdfOcrAnalyzer(pdfEngine)
              : { missing: "the PDF tools' OCR add-on (@tavi/pdf-ocr) is not installed" },
        }),
    ...(pose === undefined
      ? {}
      : {
          rtmpose: (entry: BuiltinEntry) => {
            const made = pose.poseAnalyzerEntry(entry.model, { dataDirectory });
            return "missing" in made ? made : createCommandAnalyzer({ entry: made.entry, sandbox });
          },
        }),
    // The person's whisper.cpp on their model: local, in the same sandbox.
    ...(transcribe === undefined
      ? {}
      : {
          "whisper-cpp": (entry: BuiltinEntry) => {
            // whisper.cpp's libraries as FFmpeg's are found: inside the denied roots only what it loads, never home whole.
            const made = transcribe.transcribeAnalyzerEntry(entry.model, {
              dataDirectory,
              libraryRoots: (binary) => libraryRoots(binary, videoLibraryDenyRead(dataDirectory, options), listBinaryLibraries),
            });
            return "missing" in made ? made : createCommandAnalyzer({ entry: made.entry, sandbox });
          },
        }),
  };
}

/**
 * A decoder for `tavi models probe --video`: it only encodes the probe's own
 * clip, frames Tavi drew itself, so no hostile media is parsed and it runs the
 * person's FFmpeg without the sandbox the video tools use; its scratch runs
 * live under `<data>/video/runs` as theirs do.
 */
export async function probeVideoDecoder(
  dataDirectory: string,
  options: Pick<VideoHostOptions, "ffmpeg" | "ffprobe"> = {},
): Promise<Pick<VideoDecoderPort, "encodeClip" | "close">> {
  return createFfmpegDecoder({
    sandbox: { kind: "none" },
    runsDirectory: join(dataDirectory, "video", "runs"),
    ...(options.ffmpeg === undefined ? {} : { ffmpeg: options.ffmpeg }),
    ...(options.ffprobe === undefined ? {} : { ffprobe: options.ffprobe }),
  });
}

/**
 * The PDF engine's OCR as a video analyser (`@tavi/plugin-video`'s): the
 * decoder's frames read as pages by the PDF tools' own confined OCR child.
 */
export function pdfOcrAnalyzer(engine: () => PdfEnginePort): VideoAnalyzerPort {
  return createVideoOcrAnalyzer(engine);
}
