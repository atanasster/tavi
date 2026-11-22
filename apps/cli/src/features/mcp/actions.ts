import { rmSync } from "node:fs";

import {
  MCP_MAX_TOOLS,
  keyedError,
  TaviError,
  comparePluginVersions,
  englishOf,
  mcpBlockLines,
  mcpSlugOf,
  type ConfinementPort,
  type ResourceLimitPort,
  type SandboxHostPort,
  type TextRef,
  sandboxConfines,
  type McpBlock,
  type McpNoticeKind,
  type McpPayload,
  type McpRepositoryPort,
  type McpSandboxState,
  type McpToolRecord,
  type McpVersionRecord,
  type PluginManifest,
  type PluginView,
  type WorkspaceSettings,
  type WorkspaceSettingsRepositoryPort,
  maxRisk,
  MCP_ENABLED_DEFAULT,
  mcpServerAllowed,
  mcpServerForPeople,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import type { FetchLike } from "@modelcontextprotocol/client";
import { readPluginManifest, type PluginRegistry } from "@tavi/runtime";

import { McpConnection, type McpEndpoint, type McpEraPrior } from "./client.js";
import { guardedFetch } from "./fetch.js";
import { createOwnerSandboxHost, offlineOwnerConfinement, ownerDenyRead, readOwnerReadRoots } from "../sandbox/host.js";
import { fileSha256, stdioLaunch } from "./launcher.js";
import { cleanServerText, mcpServerDisplayName, serverLine } from "./results.js";
import { offeredMcpRecords } from "./bridge.js";
import { writeMcpPluginDirectory } from "./add.js";
import { readServerLog } from "./logs.js";
import { MCP_REGISTRY_DEFAULT, registryBase, searchRegistry, type RegistryEntry } from "./registry.js";
import { noticeWords } from "./notices.js";
import { loginRequired, type McpLogins, type McpRevocation } from "./oauth-provider.js";
import { otherWayInRefusal, presetOf } from "./presets/index.js";
import {
  carriedDecisions,
  cleanDefinition,
  decide,
  defaultSearchLine,
  definitionFlags,
  observeTools,
  OVERLAP,
  schemaProse,
  schemaTokens,
  shadowingWarningRefs,
} from "./review.js";
import { definitionChangeLine, definitionDiff, type McpDefinitionDiff } from "./definition-diff.js";
import { inputFormOf } from "./schemas.js";

/**
 * The `mcp` actions, shared by the owner's IPC
 * handler and the offline CLI so both answer alike: probe a server in the
 * sandbox state its version records, show its review, approve or reject its
 * tools in one transaction, verify its files.
 */

type AsyncMcpRepository = {
  readonly [K in keyof McpRepositoryPort]: (
    ...args: Parameters<McpRepositoryPort[K]>
  ) => Promise<Awaited<ReturnType<McpRepositoryPort[K]>>>;
};

export interface McpActionContext {
  readonly registry: PluginRegistry;
  readonly mcp: AsyncMcpRepository;
  readonly dataDirectory: string;
  /** A credential reference's value. */
  readonly resolveSecret: (reference: string) => Promise<string | null>;
  readonly now: () => string;
  /** Tool ids already registered (built-ins and plugins), which a server's ids must not collide with. */
  readonly registeredToolIds?: () => ReadonlySet<string>;
  /** Host detection: whether a sandboxed server can run here (tests replace it); the owner's by default (`features/sandbox/host.ts`). */
  readonly sandboxHost?: SandboxHostPort;
  /** What a sandboxed server is wrapped in; the owner's by default (`features/sandbox/host.ts`). */
  readonly confinement?: ConfinementPort;
  /** Each server in a cgroup of its own; none offline. */
  readonly limits?: ResourceLimitPort;
  /**
   * A server's video analyser exchange directory when the owner's `analyzers.json` names it:
   * its stdio launch may read it. Absent, no server may.
   */
  readonly analyzerExchange?: (pluginId: string) => string | undefined;
  /** The guarded fetch's resolver (tests). */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  readonly connectTimeoutMs?: number;
  /** The workspaces' settings (`mcp.people`). */
  readonly workspaceSettings?: WorkspaceSettingsRepositoryPort;
  /** Whether a server's account is Personal, which other people may not use; absent, none is. */
  readonly personal?: (pluginId: string) => Promise<boolean>;
  /** The owner's `mcp.enabled`: read, and written by `tavi mcp on|off`. */
  readonly enabled?: () => Promise<boolean>;
  readonly setEnabled?: (on: boolean) => Promise<void>;
  /** A running owner's view of its servers (`tavi mcp list`); absent offline. */
  readonly live?: {
    readonly status: (pluginId: string) => { readonly state: string; readonly failures: number; readonly reason?: string };
    readonly registered: (pluginId: string) => { readonly listed: number; readonly deferred: boolean } | undefined;
    /** The listed MCP tools a workspace holds, and how many fit. */
    readonly budget: (settings: WorkspaceSettings) => { readonly used: number; readonly limit: number };
  };
  /** A server's OAuth access token, refreshed as needed; absent, an OAuth server cannot be reached here. */
  readonly oauthToken?: (pluginId: string) => Promise<string>;
  /** The owner's logins; absent offline, where a login cannot come back. */
  readonly logins?: Pick<McpLogins, "start" | "status" | "finish" | "cancel">;
  /** Revokes and deletes a server's grant: whether there was one, and whether the server confirmed revoking it. */
  readonly logout?: (pluginId: string, options?: { readonly upstream?: boolean }) => Promise<McpRevocation>;
  /**
   * The MCP Registry searched and added from: the operator's address (unset, the official one) and the fetch
   * that reaches it (the guard's otherwise).
   */
  readonly registryUrl?: {
    readonly get: () => Promise<string | undefined>;
    readonly set: (url: string | undefined) => Promise<void>;
  };
  readonly registryFetch?: FetchLike;
  /** Installs a written plugin directory as a proposed version (`plugins install`); absent, `add` is refused. */
  readonly install?: (directory: string) => Promise<{ readonly pluginId: string; readonly version: string; readonly created?: boolean }>;
  /** Deletes every session grant of these tools (a definition approved again after it changed). */
  readonly deleteSessionGrants?: (toolIds: readonly string[]) => Promise<number>;
  /** The operator's line for a server in `tools.search`'s description: read, and written by `tavi mcp line`. */
  readonly searchLines?: {
    readonly get: (pluginId: string) => Promise<string | undefined>;
    readonly set: (pluginId: string, text: string | undefined) => Promise<void>;
  };
}

/** A tool as the review shows it: its record and how its schema registers. */
export interface McpReviewTool extends McpToolRecord {
  /**
   * The tool's name, title and description as a person is shown them: cleaned, on one line where a line is meant,
   * before it is stored or shown. The definitions themselves stay as the server sent them, for their hashes.
   */
  readonly shown: {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    /** `show --full`: its input and output schemas, cleaned (`cleanDefinition`), as the model is shown them. */
    readonly inputSchema?: unknown;
    readonly outputSchema?: unknown;
  };
  /**
   * Where its definition reads like instructions, as JSON pointers (`/description`,
   * `/inputSchema/properties/to/description`): why it is flagged. Empty for a clean one.
   */
  readonly flaggedAt: readonly string[];
  readonly schema: { readonly form: "zod" | "json"; readonly wrapped: boolean } | { readonly problem: string };
  /** The version whose decision this tool takes unless changed; absent, it is new or changed. */
  readonly carriedFrom?: string;
  /**
   * What changed since the definition was approved, field by field: on a withheld tool, between what was approved
   * and what the server lists now; on a tool just approved again after it changed (`approve`'s answer), between
   * the definition approved before and the one approved now.
   */
  readonly changedFields?: McpDefinitionDiff;
}

export interface McpReview {
  readonly pluginId: string;
  readonly version: string;
  readonly reviewState: PluginView["versions"][number]["reviewState"];
  readonly sandboxState: McpSandboxState;
  readonly transport: "stdio" | "http";
  /** The exact command or url, headers, grants and limits: what runs, before anything else. */
  readonly launch: readonly string[];
  /** Where calls go and which credentials the server receives. */
  readonly disclosure: readonly string[];
  readonly era?: "modern" | "legacy";
  readonly httpMode?: "streamable" | "sse";
  readonly serverInfo?: { readonly name: string; readonly version: string };
  /** The server's instructions, cleaned: shown here, never to the model. */
  readonly instructions?: string;
  /**
   * What differs from the version approved before this one: its sandbox state, the launch and what it
   * reaches, line by line, and whether its instructions changed. Absent with no earlier approved version.
   */
  readonly changes?: { readonly since: string; readonly lines: readonly string[] };
  readonly probedAt?: string;
  readonly approvedAt?: string;
  readonly tools: readonly McpReviewTool[];
  /** The server's open notices (drift, failed, budget…), in Tavi's words. */
  readonly notices: readonly {
    readonly kind: McpNoticeKind;
    readonly title: string;
    readonly summary: string;
    readonly updatedAt: string;
  }[];
  /** Its line in `tools.search`'s description while its tools wait behind search: the operator's, or Tavi's own. */
  readonly searchLine: { readonly text: string; readonly operator: boolean };
  /** What offering every approved tool costs the model, in schema tokens. */
  readonly schemaTokens: number;
  /**
   * What approving it may do to the model's choice of tools: its tools overlap a built-in family (a Gmail server
   * beside a connected mailbox), or a description names another tool (shadowing). Warnings, never refusals.
   */
  readonly warnings: readonly string[];
  /** `warnings` by key, in the same order, for the canvas to say in the workspace's language. */
  readonly warningRefs?: readonly TextRef[];
}

export type McpAnswer =
  | { readonly review: McpReview }
  | {
      readonly verified: {
        readonly pluginId: string;
        readonly version: string;
        readonly ok: boolean;
        readonly files: number;
        readonly rehashed: number;
        readonly problem?: string;
      };
    }
  | { readonly rejected: { readonly pluginId: string; readonly version: string } }
  | { readonly people: { readonly pluginId: string; readonly workspaceId: string; readonly on: boolean; readonly allowed: boolean } }
  | { readonly servers: McpServerList }
  | {
      readonly added: {
        readonly pluginId: string;
        readonly version: string;
        readonly created: boolean;
        readonly launch: readonly string[];
        readonly credentials: readonly string[];
        readonly settings: readonly string[];
        readonly notes: readonly string[];
      };
    }
  | { readonly logs: { readonly pluginId: string; readonly lines: readonly string[] } }
  | {
      readonly login: {
        readonly pluginId: string;
        readonly flowId: string;
        readonly authorizeUrl: string;
        readonly public: boolean;
        readonly redirect: string;
      };
    }
  | {
      readonly loginStatus: {
        readonly state: "pending" | "connected" | "failed" | "expired";
        readonly pluginId: string;
        readonly detail?: string;
        readonly identity?: string;
      };
    }
  | { readonly loggedOut: { readonly pluginId: string; readonly hadGrant: boolean; readonly confirmed: boolean } }
  | { readonly finished: { readonly message: string } }
  | { readonly cancelled: { readonly flowId: string; readonly cancelled: boolean } }
  | { readonly line: { readonly pluginId: string; readonly text: string; readonly operator: boolean } }
  | { readonly switched: { readonly on: boolean } }
  | { readonly discover: { readonly registry: string; readonly entries: readonly RegistryEntry[]; readonly next?: string } }
  | { readonly registry: { readonly url: string; readonly official: boolean } };

/** The registry an owner searches: the operator's, or the official one. */
export async function registryOf(
  context: Pick<McpActionContext, "registryUrl" | "registryFetch" | "resolve">,
): Promise<{ readonly base: string; readonly fetch: FetchLike }> {
  const stored = await context.registryUrl?.get();
  return {
    base: registryBase(stored === undefined || stored === "" ? MCP_REGISTRY_DEFAULT : stored),
    fetch:
      context.registryFetch ??
      guardedFetch({ lan: false, manualRedirects: true, ...(context.resolve === undefined ? {} : { resolve: context.resolve }) }),
  };
}

/** One server in `tavi mcp list`. */
export interface McpServerRow {
  readonly pluginId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly activeVersion?: string;
  /** `running`, `stopped` (idle), `backing-off`, `failed`, `login-required`; `off` when MCP is off; `unknown` with no owner running. */
  readonly state: string;
  readonly reason?: string;
  readonly sandboxState?: McpSandboxState;
  readonly transport: "stdio" | "http";
  readonly exposure: McpBlock["exposure"];
  /** Versions proposed and not yet decided, and tools of the active version that wait (new or changed). */
  readonly pendingVersions: readonly string[];
  readonly waitingTools: number;
  /** In this workspace's `mcp.servers`, and offered to other people. */
  readonly allowed: boolean;
  readonly people: boolean;
  /** Tools registered now, and whether they are deferred behind `tools.search`; absent offline. */
  readonly listed?: number;
  readonly deferred?: boolean;
  readonly openNotices: readonly McpNoticeKind[];
}

export interface McpServerList {
  readonly enabled: boolean;
  readonly workspaceId: string;
  /** Listed MCP tools in the workspace, and how many fit; absent offline. */
  readonly budget?: { readonly used: number; readonly limit: number };
  readonly servers: readonly McpServerRow[];
}

/** A review's warnings: their English, and their keys for the canvas. */
const warningsOf = (refs: readonly TextRef[]): Pick<McpReview, "warnings" | "warningRefs"> => ({
  warnings: refs.map(englishOf),
  warningRefs: refs,
});

/** The version an action is about: the one named, else the newest still proposed, else the active one, else the newest. */
function versionOf(view: PluginView, version: string | undefined): PluginView["versions"][number] {
  if (view.kind !== "mcp") throw keyedError("INVALID_INPUT", "error.mcp.notAServer", { pluginId: view.id });
  if (version !== undefined) {
    const found = view.versions.find((candidate) => candidate.version === version);
    if (found === undefined) throw keyedError("NOT_FOUND", "error.mcp.versionNotInstalled", { pluginId: view.id, version });
    return found;
  }
  const chosen =
    [...view.versions].reverse().find((candidate) => candidate.reviewState === "proposed") ??
    view.versions.find((candidate) => candidate.version === view.activeVersion) ??
    view.versions.at(-1);
  if (chosen === undefined) throw keyedError("NOT_FOUND", "error.mcp.noVersion", { pluginId: view.id });
  return chosen;
}

/** Whether a server can reach the network: a remote one, a stdio one granted any domain, or any unsandboxed one. */
export function serverHasEgress(block: McpBlock, sandboxState: McpSandboxState): boolean {
  return block.transport === "http" || (block.network?.domains ?? []).length > 0 || sandboxState === "none";
}

/** Each `env` and header value resolved: a literal, a setting, or a credential setting's secret. */
async function resolveValues(
  manifest: PluginManifest,
  config: PluginView["config"],
  context: McpActionContext,
): Promise<{
  readonly url?: string;
  readonly headers: Record<string, string>;
  readonly env: Record<string, string>;
  readonly secrets: readonly string[];
}> {
  const block = manifest.mcp as McpBlock;
  const secrets: string[] = [];
  const settingValue = async (setting: string): Promise<string> => {
    const value = config[setting];
    if (value === undefined) throw keyedError("NOT_CONFIGURED", "error.mcp.settingFirst", { pluginId: manifest.id, setting });
    if (manifest.config[setting]?.type === "credential") {
      const secret = await context.resolveSecret(String(value));
      if (secret === null)
        throw keyedError("NOT_CONFIGURED", "error.mcp.noCredential", { pluginId: manifest.id, setting, reference: String(value) });
      secrets.push(secret);
      return secret;
    }
    return String(value);
  };
  const headers: Record<string, string> = {};
  for (const [name, source] of Object.entries(block.headers ?? {}))
    headers[name] = "value" in source ? source.value : `${source.prefix ?? ""}${await settingValue(source.setting)}`;
  const env: Record<string, string> = {};
  for (const [name, source] of Object.entries(block.env ?? {}))
    env[name] = "value" in source ? source.value : await settingValue(source.setting);
  const url = block.url === undefined ? undefined : "value" in block.url ? block.url.value : await settingValue(block.url.setting);
  return { ...(url === undefined ? {} : { url }), headers, env, secrets };
}

/** The server's endpoint, in its version's sandbox state; credentials are read now and handed over only to the transport. */
export async function endpointFor(
  manifest: PluginManifest,
  view: PluginView,
  record: McpVersionRecord,
  context: McpActionContext,
  observeSecrets?: (secrets: readonly string[]) => void,
): Promise<{ readonly endpoint: McpEndpoint; readonly secrets: readonly string[] }> {
  const block = manifest.mcp as McpBlock;
  const values = await resolveValues(manifest, view.config, context);
  if (block.transport === "http") {
    const fetcher = guardedFetch({
      lan: block.network?.lan === true,
      ...(context.resolve === undefined ? {} : { resolve: context.resolve }),
    });
    // Read for every request (`auth: "headers"`): a token rotated with `tavi credentials set` applies on the next call.
    const bearer = async (): Promise<Readonly<Record<string, string>>> => {
      if (block.auth !== "oauth") return {};
      if (context.oauthToken === undefined) throw loginRequired(manifest.id, "OAuth servers are reached through the running owner");
      const token = await context.oauthToken(manifest.id);
      observeSecrets?.([token]);
      return { Authorization: `Bearer ${token}` };
    };
    // Read before the first request too: a server that needs a login says so at connect, not as a crash.
    await bearer();
    const headers = async (): Promise<Readonly<Record<string, string>>> => {
      const fresh = await resolveValues(manifest, view.config, context);
      observeSecrets?.(fresh.secrets);
      return { ...fresh.headers, ...(await bearer()) };
    };
    return {
      endpoint: {
        transport: "http",
        url: values.url as string,
        fetch: fetcher,
        headers,
        ...(record.httpMode === undefined ? {} : { mode: record.httpMode }),
      },
      secrets: values.secrets,
    };
  }
  if (record.sandboxState !== "none") {
    const host = context.sandboxHost ?? createOwnerSandboxHost({ dataDirectory: context.dataDirectory });
    const wanted = record.sandboxState === "nested" ? "nested" : "full";
    // The owner's settled answer when it is the mode this server runs in; a probe otherwise.
    const settled = host.current();
    const check = settled.tier === wanted ? settled : await host.check({ nested: wanted === "nested" });
    if (!sandboxConfines(check))
      throw new TaviError(
        "UNAVAILABLE",
        `${manifest.id} cannot run sandboxed here: ${check.cause ?? "the sandbox did not work"}${check.fix === undefined ? "" : ` (fix: ${check.fix})`}. Probe it with --unsandboxed (or --nested inside a container) to run it weaker, by your choice`,
      );
  }
  const verified = await context.registry.verifyMcp(manifest.id, manifest.version, false);
  if (!verified.ok)
    throw keyedError(
      "CONFLICT",
      "error.mcp.filesChanged",
      { pluginId: manifest.id, version: manifest.version, problem: verified.problem ?? "unknown" },
      { details: { mcpFailure: "integrity" } },
    );
  const spawn = stdioLaunch(
    {
      pluginId: manifest.id,
      manifest,
      pluginDirectory: context.registry.snapshotDirectory(manifest.id, manifest.version),
      sandboxState: record.sandboxState,
      env: values.env,
      // An approved version's binary must be the one approved; before approval, each probe takes its hash afresh.
      ...(record.externalSha256 === undefined || record.approvedAt === undefined ? {} : { externalSha256: record.externalSha256 }),
      ...analyzerExchangeOf(manifest.id, context),
    },
    {
      dataDirectory: context.dataDirectory,
      confinement: context.confinement ?? offlineOwnerConfinement(context.dataDirectory),
      ownerDenyRead: ownerDenyRead(readOwnerReadRoots(context.dataDirectory)),
      ...(context.limits === undefined ? {} : { limits: context.limits }),
    },
  );
  return { endpoint: { transport: "stdio", spawn }, secrets: values.secrets };
}

/** The exchange directory a server's launch reads, when the owner named it as a video analyser. */
function analyzerExchangeOf(pluginId: string, context: Pick<McpActionContext, "analyzerExchange">): { readonly analyzerExchange?: string } {
  const directory = context.analyzerExchange?.(pluginId);
  return directory === undefined ? {} : { analyzerExchange: directory };
}

/** The disclosure lines: where the server's calls go, and what it is given. */
function disclosureOf(manifest: PluginManifest, sandboxState: McpSandboxState): string[] {
  const block = manifest.mcp as McpBlock;
  const credentials = Object.entries(manifest.config)
    .filter(([, field]) => field.type === "credential")
    .map(([name]) => name);
  const lines: string[] = [];
  if (block.transport === "http")
    lines.push(
      `every call sends its arguments to ${block.url === undefined ? "?" : "value" in block.url ? block.url.value : `the address in setting ${block.url.setting}`}`,
    );
  else if (sandboxState === "none") lines.push("unsandboxed, the server may reach any network, and every call's arguments may go there");
  else
    lines.push(
      block.network?.domains !== undefined && block.network.domains.length > 0
        ? `the server may reach ${block.network.domains.join(", ")}, and every call's arguments may go there`
        : "the server reaches no network",
    );
  if (credentials.length > 0) lines.push(`it receives the credentials ${credentials.join(", ")}`);
  return lines;
}

/**
 * A version's review. `approvedBefore`, from `approve`: the definitions approved before this approval, by tool name,
 * so the tools approved again after they changed still show what changed.
 */
async function reviewOf(
  context: McpActionContext,
  view: PluginView,
  version: PluginView["versions"][number],
  approvedBefore: ReadonlyMap<string, McpToolRecord["observedDef"]> = new Map(),
  full = false,
): Promise<McpReview> {
  const manifest = readPluginManifest(context.registry.snapshotDirectory(view.id, version.version));
  const record = await context.mcp.getVersion(view.id, version.version);
  const all = await context.mcp.listTools(view.id);
  const tools = all.filter((tool) => tool.version === version.version);
  const carried = carriedDecisions(
    tools,
    all.filter((tool) => tool.version !== version.version),
  );
  const preset = presetOf(manifest.mcp?.preset);
  const notices = (await context.mcp.listNotices({ pluginId: view.id, open: true })).map((notice) => ({
    kind: notice.kind,
    ...noticeWords(notice),
    updatedAt: notice.updatedAt,
  }));
  const era = (record?.eraPrior as McpEraPrior | undefined)?.kind;
  const changes = await changesSince(context, view, version.version, manifest, record);
  const siblings = (name: string): readonly string[] => tools.map((tool) => tool.name).filter((other) => other !== name);
  return {
    pluginId: view.id,
    version: version.version,
    reviewState: version.reviewState,
    sandboxState: record?.sandboxState ?? "srt",
    transport: manifest.mcp?.transport ?? "stdio",
    launch: manifest.mcp === undefined ? [] : mcpBlockLines(manifest.mcp),
    disclosure: disclosureOf(manifest, record?.sandboxState ?? "srt"),
    ...(era === undefined ? {} : { era }),
    ...(record?.httpMode === undefined ? {} : { httpMode: record.httpMode }),
    ...(record?.serverInfo === undefined ? {} : { serverInfo: record.serverInfo }),
    ...(record?.instructions === undefined ? {} : { instructions: record.instructions }),
    ...(changes === undefined ? {} : { changes }),
    ...(record?.probedAt === undefined ? {} : { probedAt: record.probedAt }),
    ...(record?.approvedAt === undefined ? {} : { approvedAt: record.approvedAt }),
    tools: tools.map((tool) => {
      // What registers and what the model is shown: the definition cleaned, as the bridge offers it.
      const cleaned = cleanDefinition(tool.observedDef);
      let schema: McpReviewTool["schema"];
      try {
        const form = inputFormOf(tool.toolId, cleaned.inputSchema);
        schema = { form: form.form, wrapped: form.wrapped };
      } catch (error) {
        schema = { problem: errorMessage(error) };
      }
      const from = carried.get(tool.name)?.from;
      // A preset's effect and floor join the suggestion here too, so the review shows what approval applies; the
      // annotations' floor follows their own effect only.
      const suggestedEffect = preset?.effect?.(tool.name) ?? tool.suggestedEffect;
      const ownFloor = suggestedEffect === tool.suggestedEffect ? tool.suggestedMinRisk : undefined;
      const presetFloor = preset?.floors({ name: tool.name, effect: suggestedEffect })?.minRisk;
      const suggestedMinRisk = presetFloor === undefined ? ownFloor : ownFloor === undefined ? presetFloor : maxRisk(presetFloor, ownFloor);
      const { suggestedMinRisk: _annotated, ...rest } = tool;
      const definition = tool.observedDef;
      const before =
        tool.state === "withheld" && tool.approvedDef !== undefined
          ? tool.approvedDef
          : tool.state === "approved"
            ? approvedBefore.get(tool.name)
            : undefined;
      const changedFields = before === undefined ? undefined : definitionDiff(before, definition);
      const flaggedAt = definitionFlags(definition, siblings(tool.name));
      const shown = {
        name: serverLine(tool.name, 128),
        ...(definition.title === undefined ? {} : { title: serverLine(definition.title, 200) }),
        ...(definition.description === undefined ? {} : { description: cleanServerText(definition.description).slice(0, 2_000) }),
        ...(full ? { inputSchema: cleaned.inputSchema } : {}),
        ...(full && cleaned.outputSchema !== undefined ? { outputSchema: cleaned.outputSchema } : {}),
      };
      return {
        ...rest,
        shown,
        flaggedAt,
        // A tool observed before its schemas' prose was read is flagged as `approve` will find it.
        flagged: tool.flagged || flaggedAt.length > 0,
        suggestedEffect,
        ...(suggestedMinRisk === undefined ? {} : { suggestedMinRisk }),
        schema,
        ...(from === undefined ? {} : { carriedFrom: from }),
        ...(changedFields === undefined || changedFields.fields.length === 0 ? {} : { changedFields }),
      };
    }),
    notices,
    searchLine: await searchLineOf(context, view.id, manifest.name, tools),
    schemaTokens: tools
      .filter((tool) => tool.state === "approved" && tool.approvedDef !== undefined)
      .reduce((sum, tool) => sum + schemaTokens(tool.approvedDef as McpToolRecord["observedDef"]), 0),
    ...warningsOf(
      shadowingWarningRefs({
        serverName: manifest.name,
        slug: mcpSlugOf(view.id) ?? view.id,
        tools: tools
          .filter((tool) => tool.state !== "removed" && tool.state !== "disabled" && tool.state !== "rejected")
          .map((tool) => ({
            name: tool.name,
            description: tool.observedDef.description,
            prose: [...schemaProse(tool.observedDef.inputSchema, ""), ...schemaProse(tool.observedDef.outputSchema, "")].map(
              (prose) => prose.text,
            ),
          })),
        registered: context.registeredToolIds?.() ?? new Set(),
      }),
    ),
  };
}

/** A server's line in `tools.search`'s description: the operator's, else Tavi's own from its approved tools. */
async function searchLineOf(
  context: McpActionContext,
  pluginId: string,
  name: string,
  tools: readonly McpToolRecord[],
): Promise<{ readonly text: string; readonly operator: boolean }> {
  const written = await context.searchLines?.get(pluginId);
  if (written !== undefined) return { text: written, operator: true };
  // The tools the bridge registers: approved, with a schema that compiles.
  const registered = offeredMcpRecords(tools).filter((tool) => {
    try {
      inputFormOf(tool.toolId, cleanDefinition(tool.approvedDef as McpToolRecord["observedDef"]).inputSchema);
      return true;
    } catch {
      return false;
    }
  });
  return {
    text: defaultSearchLine(
      mcpServerDisplayName(name),
      registered.map((tool) => tool.toolId),
    ),
    operator: false,
  };
}

/** The probe: connect in the version's sandbox state, negotiate the era once, list the tools; no tool is called. */
async function probe(context: McpActionContext, input: Extract<McpPayload, { action: "probe" }>, actor: string): Promise<McpReview> {
  const view = await context.registry.show(input.pluginId);
  const version = versionOf(view, input.version);
  const manifest = readPluginManifest(context.registry.snapshotDirectory(view.id, version.version));
  const block = manifest.mcp as McpBlock;
  const existing = await context.mcp.getVersion(view.id, version.version);
  if (version.reviewState === "rejected")
    throw keyedError("CONFLICT", "error.mcp.rejected", { pluginId: view.id, version: version.version });
  // The sandbox state is chosen before any server code runs, and an approved version keeps the one it was approved with.
  if (input.sandbox !== undefined && version.reviewState === "approved" && input.sandbox !== existing?.sandboxState) {
    throw new TaviError(
      "CONFLICT",
      `${view.id}@${version.version} was approved to run ${existing?.sandboxState ?? "srt"}; a different sandbox state needs a new version`,
    );
  }
  if (block.transport === "http" && input.sandbox !== undefined && input.sandbox !== "srt")
    throw keyedError("INVALID_INPUT", "error.mcp.remoteNoSandbox");
  const sandboxState: McpSandboxState = input.sandbox ?? existing?.sandboxState ?? "srt";
  // What an earlier probe found is replaced by this one's: none of it carries over.
  const {
    instructions: _instructions,
    instructionsHash: _hash,
    serverInfo: _info,
    capabilities: _capabilities,
    httpMode: _mode,
    eraPrior: _prior,
    ...kept
  } = existing ?? { pluginId: view.id, version: version.version, transport: block.transport, treeIndexStale: false };
  const base: McpVersionRecord = {
    ...kept,
    sandboxState,
    ...(input.workspaceId === undefined || existing?.addedFromWorkspace !== undefined ? {} : { addedFromWorkspace: input.workspaceId }),
  };
  // Recorded before the probe, so no later step runs this version's code in another state.
  await context.mcp.putVersion(base);
  const { endpoint } = await endpointFor(manifest, view, base, context);
  const connection = new McpConnection({
    endpoint,
    maxMessageBytes: block.maxMessageBytes,
    ...(context.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: context.connectTimeoutMs }),
  });
  let found: Awaited<ReturnType<McpConnection["probe"]>>;
  try {
    found = await connection.probe();
  } finally {
    await connection.close();
  }
  if (found.tools.length > MCP_MAX_TOOLS)
    throw keyedError("UNSUPPORTED", "error.mcp.tooManyTools", {
      pluginId: view.id,
      count: String(found.tools.length),
      max: String(MCP_MAX_TOOLS),
    });
  const slug = mcpSlugOf(view.id) as string;
  const known = new Map((await context.mcp.listTools(view.id, version.version)).map((tool) => [tool.name, tool.toolId]));
  const observed = observeTools(view.id, version.version, slug, found.tools, context.registeredToolIds?.() ?? new Set(), known);
  const now = context.now();
  await context.mcp.putVersion({
    ...base,
    eraPrior: found.prior,
    ...(found.httpMode === undefined ? {} : { httpMode: found.httpMode }),
    ...(found.serverInfo === undefined ? {} : { serverInfo: { name: found.serverInfo.name, version: found.serverInfo.version } }),
    ...(found.instructions === undefined ? {} : { instructions: found.instructions, instructionsHash: sha256Hex(found.instructions) }),
    ...(found.capabilities === undefined ? {} : { capabilities: found.capabilities }),
    // The binary that ran is the one approval may pin: its hash is taken now, and approve checks it is unchanged.
    ...(block.external === true && block.command?.[0] !== undefined
      ? { externalPath: block.command[0], externalSha256: fileSha256(block.command[0]) }
      : {}),
    // A Python server's pinned interpreter, as the manifest pins it; the launcher checks it at each start.
    ...(block.interpreter === undefined ? {} : { interpreterPath: block.interpreter.path, interpreterSha256: block.interpreter.sha256 }),
    probedAt: now,
    probedBy: actor,
  });
  await context.mcp.putObservedTools(view.id, version.version, observed);
  // A server that failed and now starts again is no longer failed.
  for (const notice of await context.mcp.listNotices({ pluginId: view.id, open: true })) {
    if (notice.kind === "failed") await context.mcp.decideNotice(notice.noticeId, actor, context.now());
  }
  const after = await context.registry.show(view.id);
  return reviewOf(context, after, versionOf(after, version.version));
}

/** Approval: every tool decided in one transaction, the weaker sandbox states confirmed again. */
async function approve(context: McpActionContext, input: Extract<McpPayload, { action: "approve" }>, actor: string): Promise<McpReview> {
  const view = await context.registry.show(input.pluginId);
  const version = versionOf(view, input.version);
  const record = await context.mcp.getVersion(view.id, version.version);
  if (record?.probedAt === undefined) throw keyedError("CONFLICT", "error.mcp.notProbed", { pluginId: view.id, version: version.version });
  if (record.sandboxState !== "srt" && input.sandbox !== record.sandboxState) {
    throw new TaviError(
      "CONFLICT",
      `${view.id}@${version.version} was probed ${record.sandboxState === "none" ? "unsandboxed" : "in a weaker nested sandbox"}; confirm it with ${record.sandboxState === "none" ? "--unsandboxed" : "--nested"}`,
    );
  }
  if (input.sandbox !== undefined && input.sandbox !== record.sandboxState)
    throw new TaviError(
      "CONFLICT",
      `${view.id}@${version.version} was probed in state ${record.sandboxState}, not ${input.sandbox}; probe it again in that state first`,
    );
  const manifest = readPluginManifest(context.registry.snapshotDirectory(view.id, version.version));
  const block = manifest.mcp as McpBlock;
  const all = await context.mcp.listTools(view.id);
  const tools = all.filter((tool) => tool.version === version.version && tool.state !== "removed");
  // What was decided before for an unchanged definition carries over: an upgrade, or a re-approval after drift, asks only about what changed.
  const carried = carriedDecisions(
    tools,
    all.filter((tool) => tool.version !== version.version),
  );
  // Flagged as it reads now: a tool observed before its schemas' prose was read is checked again here.
  const names = tools.map((tool) => tool.name);
  const reviewed = tools.map((tool) =>
    tool.flagged
      ? tool
      : {
          ...tool,
          flagged:
            definitionFlags(
              tool.observedDef,
              names.filter((name) => name !== tool.name),
            ).length > 0,
        },
  );
  const decisions = decide(
    reviewed,
    { effects: input.effects, floors: input.floors, timeouts: input.timeouts, disabled: new Set(input.disabled) },
    serverHasEgress(block, record.sandboxState),
    carried,
    presetOf(block.preset),
  );
  // A tool whose schema cannot register would never be offered: approve it only disabled.
  const unregistrable = tools
    .filter((tool) => decisions[tool.name] !== "disabled")
    .filter((tool) => {
      try {
        inputFormOf(tool.toolId, cleanDefinition(tool.observedDef).inputSchema);
        return false;
      } catch {
        return true;
      }
    });
  if (unregistrable.length > 0)
    throw new TaviError(
      "CONFLICT",
      `${unregistrable.map((tool) => tool.name).join(", ")} ${unregistrable.length === 1 ? "has an input schema that cannot" : "have input schemas that cannot"} register: --disable ${unregistrable.map((tool) => tool.name).join(" --disable ")}`,
    );
  let externalSha256: string | undefined;
  if (block.external === true && block.command?.[0] !== undefined) {
    externalSha256 = fileSha256(block.command[0]);
    if (record.externalSha256 !== undefined && record.externalSha256 !== externalSha256)
      throw keyedError("CONFLICT", "error.mcp.binaryChanged", { path: block.command[0] });
  }
  const expected = Object.fromEntries(tools.map((tool) => [tool.name, tool.observedDefHash]));
  await context.mcp.approveVersion({
    pluginId: view.id,
    version: version.version,
    by: actor,
    now: context.now(),
    decisions,
    expected,
    ...(externalSha256 === undefined ? {} : { externalSha256 }),
  });
  // A definition approved again after it changed (found by drift or by a probe) keeps none of the grants made for the
  // old one: whatever found the change, its approval deletes them.
  const reapproved = tools.filter(
    (tool) => tool.approvedDefHash !== undefined && tool.approvedDefHash !== tool.observedDefHash && decisions[tool.name] !== "disabled",
  );
  const changed = reapproved.map((tool) => tool.toolId);
  if (changed.length > 0) await context.deleteSessionGrants?.(changed);
  // What changed in them stays on the answer, so approving after drift shows what was approved.
  const approvedBefore = new Map(
    reapproved.flatMap((tool) => (tool.approvedDef === undefined ? [] : [[tool.name, tool.approvedDef] as const])),
  );
  // The review decided what drifted in this version: its notice is done.
  for (const notice of await context.mcp.listNotices({ pluginId: view.id, open: true })) {
    if (notice.kind === "drift" && (notice.detail["version"] === undefined || notice.detail["version"] === version.version))
      await context.mcp.decideNotice(notice.noticeId, actor, context.now());
  }
  const after = await context.registry.show(view.id);
  return reviewOf(context, after, versionOf(after, version.version), approvedBefore);
}

export async function runMcpAction(context: McpActionContext, input: McpPayload, actor: string): Promise<McpAnswer> {
  switch (input.action) {
    case "probe":
      return { review: await probe(context, input, actor) };
    case "show": {
      const view = await context.registry.show(input.pluginId);
      return { review: await reviewOf(context, view, versionOf(view, input.version), new Map(), input.full === true) };
    }
    case "approve":
      return { review: await approve(context, input, actor) };
    case "reject": {
      const view = await context.registry.show(input.pluginId);
      const version = versionOf(view, input.version);
      await context.mcp.rejectVersion(view.id, version.version, actor, context.now());
      return { rejected: { pluginId: view.id, version: version.version } };
    }
    case "people": {
      const view = await context.registry.show(input.pluginId);
      if (view.kind !== "mcp") throw keyedError("INVALID_INPUT", "error.mcp.notAServer", { pluginId: view.id });
      if (context.workspaceSettings === undefined) throw new TaviError("UNAVAILABLE", "workspace settings are not available here");
      // The household rule: a Personal account is lent to no one.
      if (input.on && (await context.personal?.(view.id)) === true) {
        throw keyedError("NOT_AUTHORIZED", "error.mcp.personalAccount", { pluginId: view.id });
      }
      const current = await context.workspaceSettings.get(input.workspaceId);
      const people = (current.settings.mcpPeople ?? []).filter((id) => id !== view.id);
      await context.workspaceSettings.set({
        workspaceId: input.workspaceId,
        settings: { ...current.settings, mcpPeople: input.on ? [...people, view.id] : people },
        expectedRevision: current.revision,
        actor,
        now: context.now(),
      });
      return {
        people: {
          pluginId: view.id,
          workspaceId: input.workspaceId,
          on: input.on,
          allowed: current.settings.mcpServers?.includes(view.id) === true,
        },
      };
    }
    case "list":
      return { servers: await serverList(context, input.workspaceId) };
    case "add": {
      if (context.install === undefined) throw new TaviError("UNAVAILABLE", "servers are added here with `tavi mcp add`");
      const form = input.form.kind === "npm" ? { ...input.form, args: [] } : input.form;
      const refused = form.kind === "preset" ? otherWayInRefusal(await context.registry.list(), form.preset) : undefined;
      if (refused !== undefined) throw refused;
      const registry = form.kind === "registry" ? { registry: await registryOf(context) } : {};
      const written = await writeMcpPluginDirectory(
        { slug: input.slug, form, ...(input.name === undefined ? {} : { name: input.name }) },
        { dataDirectory: context.dataDirectory, ...registry },
      );
      try {
        const installed = await context.install(written.directory);
        const config = Object.entries(written.manifest.config);
        return {
          added: {
            pluginId: installed.pluginId,
            version: installed.version,
            created: installed.created !== false,
            launch: written.manifest.mcp === undefined ? [] : mcpBlockLines(written.manifest.mcp),
            credentials: config.filter(([, field]) => field.type === "credential").map(([name]) => name),
            settings: config.filter(([, field]) => field.type !== "credential").map(([name]) => name),
            notes: written.notes,
          },
        };
      } finally {
        rmSync(written.directory, { recursive: true, force: true });
      }
    }
    case "login": {
      const view = await context.registry.show(input.pluginId);
      if (view.kind !== "mcp" || view.mcp?.auth !== "oauth")
        throw keyedError("INVALID_INPUT", "error.mcp.noOAuth", { pluginId: input.pluginId });
      if (context.logins === undefined)
        throw new TaviError("UNAVAILABLE", "a login comes back to the running owner: start `tavi serve` first");
      const started = await context.logins.start({
        pluginId: view.id,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        ...(input.via === undefined ? {} : { via: input.via }),
      });
      return { login: { pluginId: view.id, ...started } };
    }
    case "login-finish": {
      if (context.logins === undefined)
        throw new TaviError("UNAVAILABLE", "a login comes back to the running owner: start `tavi serve` first");
      const outcome = await context.logins.finish(input.flowId, input.address);
      if (!outcome.ok) throw new TaviError(outcome.conflict === true ? "CONFLICT" : "INVALID_INPUT", outcome.message);
      return { finished: { message: outcome.message } };
    }
    case "login-cancel":
      return { cancelled: { flowId: input.flowId, cancelled: context.logins?.cancel(input.flowId) === true } };
    case "login-status": {
      const status = context.logins?.status(input.flowId);
      if (status === undefined) throw keyedError("NOT_FOUND", "error.mcp.noSuchLogin");
      return { loginStatus: status };
    }
    case "logout": {
      if (context.logout === undefined) throw new TaviError("UNAVAILABLE", "logging out needs the credential store");
      return {
        loggedOut: {
          pluginId: input.pluginId,
          ...(await context.logout(input.pluginId, input.upstream === false ? { upstream: false } : {})),
        },
      };
    }
    case "line": {
      if (context.searchLines === undefined) throw new TaviError("UNAVAILABLE", "a server's line cannot be written here");
      const view = await context.registry.show(input.pluginId);
      await context.searchLines.set(view.id, input.text);
      const version = view.activeVersion ?? view.versions.at(-1)?.version;
      const tools = version === undefined ? [] : await context.mcp.listTools(view.id, version);
      return { line: { pluginId: view.id, ...(await searchLineOf(context, view.id, view.name, tools)) } };
    }
    case "search": {
      const { base, fetch } = await registryOf(context);
      return { discover: { registry: base, ...(await searchRegistry(fetch, base, input.query, input.cursor)) } };
    }
    case "registry": {
      if (input.url !== undefined || input.reset) {
        if (context.registryUrl === undefined) throw new TaviError("UNAVAILABLE", "the registry's address cannot be written here");
        await context.registryUrl.set(input.reset ? undefined : registryBase(input.url as string));
      }
      const { base } = await registryOf(context);
      return { registry: { url: base, official: base === MCP_REGISTRY_DEFAULT } };
    }
    case "logs":
      return { logs: { pluginId: input.pluginId, lines: await readServerLog(context.dataDirectory, input.pluginId, input.lines) } };
    case "switch": {
      if (context.setEnabled === undefined) throw new TaviError("UNAVAILABLE", "the MCP setting cannot be written here");
      await context.setEnabled(input.on);
      return { switched: { on: input.on } };
    }
    case "verify": {
      const view = await context.registry.show(input.pluginId);
      const version = versionOf(view, input.version);
      const result = await context.registry.verifyMcp(view.id, version.version, input.full);
      return { verified: { pluginId: view.id, version: version.version, ...result } };
    }
  }
}

async function serverList(context: McpActionContext, workspaceId: string): Promise<McpServerList> {
  const enabled = (await context.enabled?.()) ?? MCP_ENABLED_DEFAULT;
  const settings = context.workspaceSettings === undefined ? {} : (await context.workspaceSettings.get(workspaceId)).settings;
  const servers: McpServerRow[] = [];
  for (const view of await context.registry.list()) {
    if (view.kind !== "mcp" || view.mcp === undefined) continue;
    const record = view.activeVersion === undefined ? undefined : await context.mcp.getVersion(view.id, view.activeVersion);
    const tools = view.activeVersion === undefined ? [] : await context.mcp.listTools(view.id, view.activeVersion);
    const status = context.live?.status(view.id);
    const registered = context.live?.registered(view.id);
    servers.push({
      pluginId: view.id,
      name: view.name,
      enabled: view.enabled,
      ...(view.activeVersion === undefined ? {} : { activeVersion: view.activeVersion }),
      state: !enabled ? "off" : !view.enabled ? "disabled" : status === undefined ? "unknown" : status.state,
      ...(status?.reason === undefined ? {} : { reason: status.reason }),
      ...(record === undefined ? {} : { sandboxState: record.sandboxState }),
      transport: view.mcp.transport,
      exposure: view.mcp.exposure,
      pendingVersions: view.versions.filter((version) => version.reviewState === "proposed").map((version) => version.version),
      waitingTools: tools.filter((tool) => tool.state === "pending" || tool.state === "withheld").length,
      allowed: mcpServerAllowed(settings, view.id),
      people: mcpServerForPeople(settings, view.id),
      ...(registered === undefined ? {} : { listed: registered.listed, deferred: registered.deferred }),
      openNotices: (await context.mcp.listNotices({ pluginId: view.id, open: true })).map((notice) => notice.kind),
    });
  }
  return { enabled, workspaceId, ...(context.live === undefined ? {} : { budget: context.live.budget(settings) }), servers };
}

/** `tavi mcp list` as text: one line per server, then what waits. */
export function serverListText(list: McpServerList): string {
  const lines = [
    `MCP is ${list.enabled ? "on" : "off (tavi mcp on)"}${list.budget === undefined ? "" : `; ${list.workspaceId} lists ${String(list.budget.used)} of ${String(list.budget.limit)} MCP tools`}`,
  ];
  if (list.servers.length === 0) lines.push("no MCP servers (tavi mcp add)");
  for (const server of list.servers) {
    const facts = [
      server.state === "unknown" ? "state unknown (no owner running)" : server.state,
      // Named as the review names them: the weaker state said to be weaker, none never called a sandbox.
      server.sandboxState === undefined
        ? undefined
        : server.sandboxState === "srt"
          ? "sandboxed"
          : server.sandboxState === "nested"
            ? "nested sandbox (weaker)"
            : "not sandboxed",
      `exposure ${server.exposure}`,
      server.listed === undefined
        ? undefined
        : `${String(server.listed)} tools listed${server.deferred === true ? " (behind tools.search)" : ""}`,
      server.allowed ? `in ${list.workspaceId}` : `not in ${list.workspaceId}'s mcp.servers`,
      server.people ? "offered to people" : undefined,
    ].filter((fact): fact is string => fact !== undefined);
    lines.push(
      `${server.pluginId}${server.activeVersion === undefined ? "" : `@${server.activeVersion}`} (${server.name}): ${facts.join(", ")}${server.reason === undefined ? "" : ` — ${server.reason}`}`,
    );
    if (server.pendingVersions.length > 0)
      lines.push(`  proposed: ${server.pendingVersions.join(", ")} (tavi mcp show ${server.pluginId})`);
    if (server.waitingTools > 0) lines.push(`  ${String(server.waitingTools)} tools wait for review (tavi mcp review ${server.pluginId})`);
    if (server.openNotices.length > 0) lines.push(`  notices: ${server.openNotices.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What differs between `version` and the newest version approved before it:
 * the sandbox state, each launch and disclosure line added
 * or gone, and the instructions. Undefined with no earlier approved version.
 */
async function changesSince(
  context: McpActionContext,
  view: PluginView,
  version: string,
  manifest: PluginManifest,
  record: McpVersionRecord | undefined,
): Promise<McpReview["changes"]> {
  const earlier = view.versions
    .filter((candidate) => candidate.reviewState === "approved" && comparePluginVersions(candidate.version, version) < 0)
    .map((candidate) => candidate.version)
    .sort(comparePluginVersions)
    .at(-1);
  if (earlier === undefined || manifest.mcp === undefined) return undefined;
  let before: PluginManifest;
  try {
    before = readPluginManifest(context.registry.snapshotDirectory(view.id, earlier));
  } catch (error) {
    // Not "nothing before it": a review that hid an approved version would read as a first one. Said instead.
    return { since: earlier, lines: [`what it was cannot be read (${errorMessage(error)}): review every line as new`] };
  }
  const was = await context.mcp.getVersion(view.id, earlier);
  const lines: string[] = [];
  const wasState = was?.sandboxState ?? "srt";
  const nowState = record?.sandboxState ?? "srt";
  if (wasState !== nowState) lines.push(`sandbox: ${wasState} → ${nowState}`);
  const diff = (old: readonly string[], now: readonly string[]): void => {
    for (const line of now) if (!old.includes(line)) lines.push(`now: ${line}`);
    for (const line of old) if (!now.includes(line)) lines.push(`was: ${line}`);
  };
  diff(before.mcp === undefined ? [] : mcpBlockLines(before.mcp), mcpBlockLines(manifest.mcp));
  diff(disclosureOf(before, wasState), disclosureOf(manifest, nowState));
  if (was?.instructionsHash !== record?.instructionsHash) lines.push("its instructions changed");
  return { since: earlier, lines };
}

/** A review as text: the launch spec first, then the disclosure, the instructions, and each tool with its marks. */
export function reviewText(review: McpReview): string {
  const lines = [
    `${review.pluginId}@${review.version} (${review.reviewState}), sandbox: ${review.sandboxState === "srt" ? "srt" : review.sandboxState === "nested" ? "nested (weaker)" : "none (not sandboxed)"}`,
    ...review.notices.map((notice) => `  NOTICE (${notice.kind}): ${notice.title}. ${notice.summary}`),
    ...review.launch.map((line) => `  ${line}`),
    ...review.disclosure.map((line) => `  ${line}`),
    ...(review.era === undefined
      ? ["  not probed yet"]
      : [
          `  protocol: ${review.era === "modern" ? "2026-07-28" : "2025 (initialize)"}${review.httpMode === "sse" ? " over HTTP+SSE" : ""}${review.serverInfo === undefined ? "" : `; server says it is ${review.serverInfo.name} ${review.serverInfo.version}`}`,
        ]),
    ...(review.changes === undefined
      ? []
      : [
          `  changed since ${review.changes.since} (approved):${review.changes.lines.length === 0 ? " nothing in what runs or what it reaches" : ""}`,
          ...review.changes.lines.map((line) => `    ${line}`),
        ]),
    ...(review.instructions === undefined
      ? []
      : [
          "  instructions (shown to you, never to the model):",
          ...review.instructions
            .split("\n")
            .slice(0, 20)
            .map((line) => `    ${line}`),
        ]),
    // Tavi's own line names the approved tools: before any is approved there is none to show.
    ...(review.searchLine.operator || review.tools.some((tool) => tool.state === "approved")
      ? [`  tools.search line${review.searchLine.operator ? "" : " (Tavi's own; yours with `tavi mcp line`)"}: ${review.searchLine.text}`]
      : []),
    `  schema tokens: ${String(review.schemaTokens)} for its approved tools`,
    ...(review.warnings.length === 0
      ? []
      : [
          "warnings:",
          ...review.warnings.map((warning) => `  ${warning}${warning.endsWith(OVERLAP) ? "; --disable the ones you do not need" : ""}`),
        ]),
    `tools (${String(review.tools.length)}):`,
  ];
  for (const tool of review.tools) {
    const marks = [
      tool.doubtful ? "DOUBTFUL: claims read-only but has a write name" : undefined,
      !tool.flagged
        ? undefined
        : tool.flaggedAt.length === 0 || (tool.flaggedAt.length === 1 && tool.flaggedAt[0] === "/description")
          ? "FLAGGED: its description reads like instructions"
          : `FLAGGED: reads like instructions at ${tool.flaggedAt.slice(0, 5).join(", ")}${tool.flaggedAt.length > 5 ? ", …" : ""}`,
      "problem" in tool.schema ? `SCHEMA: ${tool.schema.problem}` : undefined,
    ].filter((mark): mark is string => mark !== undefined);
    const decided =
      tool.decision === undefined
        ? `suggested ${tool.suggestedEffect}${tool.suggestedMinRisk === undefined ? "" : `, floor ${tool.suggestedMinRisk}`}`
        : `${tool.decision.effect}${tool.decision.minRisk === undefined ? "" : `, floor ${tool.decision.minRisk}`}, ${String(tool.decision.timeoutMs / 1000)} s${tool.decision.askTainted ? ", asks under taint" : ""}${(tool.decision.argFloors ?? []).map((floor) => `, ${floor.risk} unless ${floor.identify.join(" or ")} in ${floor.safe.join(", ")}`).join("")}`;
    // What waits on the operator says why: changed since approval, or new; what carries a decision says from where.
    const why =
      tool.state === "withheld"
        ? " CHANGED since it was approved"
        : tool.carriedFrom !== undefined && tool.carriedFrom !== review.version
          ? ` (unchanged: as decided for ${tool.carriedFrom})`
          : tool.state === "pending" && review.reviewState === "approved"
            ? " NEW"
            : "";
    lines.push(`  ${tool.name} → ${tool.toolId} [${tool.state}] ${decided}${why}`);
    if (tool.observedDef.description !== undefined)
      lines.push(`    ${cleanServerText(tool.observedDef.description).replace(/\s+/g, " ").slice(0, 300)}`);
    for (const mark of marks) lines.push(`    ${mark}`);
    for (const [label, schema] of [
      ["input schema", tool.shown.inputSchema],
      ["output schema", tool.shown.outputSchema],
    ] as const) {
      if (schema === undefined) continue;
      lines.push(`    ${label} (cleaned, as the model is shown it):`);
      for (const line of JSON.stringify(schema, null, 2).split("\n")) lines.push(`      ${line}`);
    }
    if (tool.changedFields !== undefined) {
      lines.push(
        tool.state === "withheld"
          ? "    changed since it was approved:"
          : "    approved again; changed from the definition approved before:",
      );
      for (const change of tool.changedFields.fields) lines.push(`      ${definitionChangeLine(change)}`);
      if (tool.changedFields.more > 0) lines.push(`      … and ${String(tool.changedFields.more)} more`);
    }
  }
  return `${lines.join("\n")}\n`;
}
