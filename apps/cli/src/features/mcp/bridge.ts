import {
  MAX_MODEL_TOOLS,
  MCP_AUTO_LISTED_MAX,
  MCP_PLUGIN_PREFIX,
  TOOL_MEDIA_KEY,
  TaviError,
  joinLabels,
  localeOf,
  mcpSearchLineSetting,
  maxRisk,
  mcpServerAllowed,
  mcpServerForPeople,
  mcpSlugOf,
  type CallAssessment,
  type ContentLabel,
  type InvocationContext,
  type McpArgFloor,
  type McpBlock,
  type McpToolDefinition,
  type McpToolRecord,
  type RiskLevel,
  type ToolEffect,
  type ToolOfferContext,
  type AgentWaitOutcome,
  type TaskExecutionPolicy,
  type ToolDefinition,
  type ToolHandler,
  type ToolQuestion,
  type ToolMediaReference,
  type ToolSink,
  WorkflowWaitSuspend,
  type WorkspaceSettings,
} from "@tavi/contracts";
import { DEFAULT_LOCALE } from "@tavi/contracts/i18n";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { definedOnly, errorMessage, isRecord } from "@tavi/contracts/util";
import { sha256Hex } from "@tavi/node-kit";
import type { ElicitResult, ReadResourceResult } from "@modelcontextprotocol/client";
import { readPluginManifest, sniffMediaType, type ExternalToolRegistration, type PluginRegistry, type ToolRegistry } from "@tavi/runtime";
import { inAttendedDeferredFamily } from "@tavi/agent-host/workflow";
import { z } from "zod";

import { cardEffect, cardRisk, cardWords } from "../approvals/card-words.js";
import { serverHasEgress, type McpActionContext } from "./actions.js";
import { MAX_VIEW_IMAGE_BYTES, VIEWABLE_IMAGE_TYPES } from "../tools/assistant.js";
import { cleanServerText, mcpResultLabel, mcpServerDisplayName, serverLine, type McpCallResult } from "./results.js";
import { cleanDefinition, collisionSuffixed, defaultSearchLine, normalizedHints } from "./review.js";
import type { McpElicit, McpProgress } from "./client.js";
import { LEGACY_QUESTION_MS, planElicitation } from "./elicitation.js";
import { presetOf } from "./presets/index.js";
import { parsePromptCommand, promptArguments, promptCommands, promptText } from "./prompts.js";
import { inputFormOf, outputCheckOf, serverArguments } from "./schemas.js";
import type { McpSupervisor } from "./supervisor.js";
import { awaitConnect } from "../apps/connect-waits.js";

/**
 * MCP tools in Tavi's registry:
 * each approved tool of an enabled server, registered from its approved
 * snapshot through `registerExternalBatch` (no process is needed to offer
 * it), offered in a workspace whose `mcp.servers` lists the server, to its
 * operator, and to other people only when `mcp.people` lists it too. Its
 * calls go to the supervisor; its results are untrusted, from `mcp`, said by
 * `tool:<name>`. Reconciled on every change to the server, without a restart.
 */

type AsyncMcpRepository = McpActionContext["mcp"];

export interface McpBridgeOptions {
  readonly registry: PluginRegistry;
  readonly mcp: AsyncMcpRepository;
  readonly tools: ToolRegistry;
  readonly supervisor: McpSupervisor;
  readonly workspaceSettings: (workspaceId: string) => Promise<WorkspaceSettings>;
  /** Every workspace's settings with a stored row (the budget at start). */
  readonly allWorkspaceSettings: () => Promise<readonly { readonly workspaceId: string; readonly settings: WorkspaceSettings }[]>;
  /** The workspace's operator, from its grant. */
  readonly operatorOf: (workspaceId: string) => string | undefined;
  readonly now: () => string;
  readonly log?: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  /** A call the server refused for its credentials (HTTP 401 or 403). */
  readonly onAuthFailure?: (
    pluginId: string,
    status: number,
    insufficientScope: boolean,
    requiredScope?: string,
  ) => Promise<boolean | void>;
  /** The owner's `mcp.enabled`: off, no server's tools are registered. */
  readonly enabled: () => Promise<boolean>;
  /** The operator's line for a server in `tools.search`'s description; absent, Tavi's own. */
  readonly searchLine?: (pluginId: string) => Promise<string | undefined>;
  /**
   * Stores an image a call returned as an approved artifact of the task, for
   * a model that reads images; its id. Absent, images are noted only.
   */
  readonly storeImage?: (image: {
    readonly workspaceId: string;
    readonly taskId?: string;
    readonly mediaType: string;
    readonly data: Uint8Array;
    readonly label: ContentLabel;
  }) => Promise<string>;
  /** Whether a task is still open (not cancelled, completed or failed): a held call of one that is not is released. */
  readonly taskOpen?: (taskId: string) => Promise<boolean>;
  /** A call's progress as its chat's tool line; `undefined` clears the line when the call ends. */
  readonly progress?: (input: { readonly pluginId: string; readonly taskId: string; readonly line: string | undefined }) => void;
  /**
   * Whether the server's account is Personal: its tools are then offered only
   * in the operator's own one-to-one chats, never to other people or a group chat. Absent, none is.
   */
  readonly personal?: (pluginId: string, dataClass: AppDataClass | undefined) => Promise<boolean>;
  /** The account a server's sign-in named: Tavi's words, added to its tools' prefix. */
  readonly identityOf?: (pluginId: string) => Promise<string | undefined>;
}

/** A tool's description prefix: its server, and the account it signed in as when one is known (Tavi's words). */
export function mcpDescriptionPrefix(serverName: string, identity: string | undefined): string {
  return identity === undefined ? `[${serverName}]` : `[${serverName} (${identity})]`;
}

/**
 * A tool's description as the model reads it: Tavi's `[<server>]` prefix, then — when its id took a collision
 * suffix, so its id no longer reads as its name — `[Original MCP tool: <name>]`, then the approved definition's
 * description (else its title, else its name), cleaned onto one line and cut at the registry's length.
 */
export function mcpToolDescription(input: {
  readonly serverName: string;
  readonly identity: string | undefined;
  readonly slug: string;
  readonly tool: Pick<McpToolRecord, "name" | "toolId">;
  readonly definition: McpToolDefinition;
}): string {
  const { tool, definition } = input;
  const oneLine = (text: string): string => cleanServerText(text).replace(/\s+/g, " ").trim();
  const original = collisionSuffixed(input.slug, tool.name, tool.toolId) ? `[Original MCP tool: ${oneLine(tool.name).slice(0, 128)}] ` : "";
  return `${mcpDescriptionPrefix(input.serverName, input.identity)} ${original}${oneLine(
    definition.description ?? definition.title ?? tool.name,
  )}`.slice(0, MAX_DESCRIPTION);
}

/** An app's data class, as its preset or its manifest's `apps` block declares it. */
export type AppDataClass = "public" | "personal";

/** The data class an MCP server's results carry: its preset's, else the first app its manifest presents. */
export function mcpDataClassOf(manifest: {
  readonly mcp?: McpBlock | undefined;
  readonly apps?: { readonly apps: readonly { readonly dataClass?: AppDataClass | undefined }[] } | undefined;
}): AppDataClass | undefined {
  return presetOf(manifest.mcp?.preset)?.app?.dataClass ?? manifest.apps?.apps[0]?.dataClass;
}

/** How often a call's progress line changes, at most. */
const MCP_PROGRESS_INTERVAL_MS = 1_000;

/** One progress notification as its chat line: the tool, the server's words (cleaned), and how far it is. */
export function mcpProgressLine(serverName: string, tool: string, progress: McpProgress): string {
  const words = typeof progress.message === "string" ? cleanServerText(progress.message).replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const total = typeof progress.total === "number" && Number.isFinite(progress.total) && progress.total > 0 ? progress.total : undefined;
  const done = Number.isFinite(progress.progress) ? progress.progress : 0;
  const share =
    total === undefined ? (done > 0 ? `${String(done)}` : "") : `${String(Math.max(0, Math.min(100, Math.round((done / total) * 100))))}%`;
  return `${serverName}: ${shownName(tool)}${words === "" ? "" : ` — ${words}`}${share === "" ? "" : ` (${share})`}`;
}

/** A tool's name as a progress line shows it. */
const shownName = (tool: string): string => cleanServerText(tool).replace(/\s+/g, " ").slice(0, 64);

/**
 * The operator's `tools.search` lines in the owner's settings, one per
 * server under `mcp.searchLine.<id>`; an empty value is none (the store keeps
 * no deletions).
 */
export function mcpSearchLines(
  read: (key: string) => Promise<string | undefined> | string | undefined,
  write: (key: string, value: string) => Promise<void> | void,
): {
  readonly get: (pluginId: string) => Promise<string | undefined>;
  readonly set: (pluginId: string, text: string | undefined) => Promise<void>;
} {
  return {
    get: async (pluginId) => {
      const stored = await read(mcpSearchLineSetting(pluginId));
      return stored === undefined || stored === "" ? undefined : stored;
    },
    set: async (pluginId, text) => {
      await write(mcpSearchLineSetting(pluginId), text ?? "");
    },
  };
}

/**
 * Room kept for later built-ins and per-turn tools: one search's discoveries
 * (`tools.search` returns at most eight). A list past `MAX_MODEL_TOOLS` still
 * fits, as its listed MCP tools give way first (`shortlistTools`).
 */
const MCP_BUDGET_HEADROOM = 8;
/** A description's length in the registry, its `[<server>] ` prefix included. */
const MAX_DESCRIPTION = 2_000;
/** Arguments longer than this are shown on an approval card by digest. */
const SHOWN_ARGUMENTS = 300;

const EFFECT_RISK: Readonly<Record<ToolEffect, RiskLevel>> = { "read-only": "low", mutating: "medium", external: "medium" };

/** The sink a tool declares: a payload to the network, or on a no-network stdio server none for a read and persist for a write. */
export function mcpToolSink(effect: ToolEffect, egress: boolean): { readonly sink: ToolSink; readonly urlOnly?: false } {
  if (egress) return { sink: "network", urlOnly: false };
  return effect === "read-only" ? { sink: "none" } : { sink: "persist" };
}

function safeTarget(value: unknown, safe: readonly string[]): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every((entry) => safeTarget(entry, safe));
  if (typeof value !== "string") return false;
  const dot = value.indexOf(".");
  return safe.includes(value) || (dot > 0 && safe.includes(value.slice(0, dot)));
}

/** The floor an argument sets: fail closed, so a call that does not name a safe value takes the floor. */
export function argumentFloor(floors: readonly McpArgFloor[], input: unknown): RiskLevel {
  const args = isRecord(input) ? input : {};
  let risk: RiskLevel = "low";
  for (const floor of floors) {
    // Every identifying argument the call names must be safe, and it must name one: a safe value, an entity id in a safe
    // domain (`light.kitchen`), or a non-empty list of those.
    const named = floor.identify.map((key) => args[key]).filter((value) => value !== undefined);
    if (named.length === 0 || named.some((value) => !safeTarget(value, floor.safe))) risk = maxRisk(risk, floor.risk);
  }
  return risk;
}

/** One call's reading for the gate: no subjects and no scope group, so `always` is never offered. */
export function mcpAssessment(
  input: {
    readonly serverName: string;
    readonly tool: McpToolRecord;
    readonly host?: string;
    readonly sink: ToolSink;
    readonly identity?: string | undefined;
  },
  args: unknown,
  context?: Pick<InvocationContext, "locale">,
): CallAssessment {
  const t = cardWords(context);
  const decision = input.tool.decision;
  if (decision === undefined) throw new TaviError("CONFLICT", `${input.tool.toolId} has no approved decision`);
  const shown = JSON.stringify(args ?? {});
  const detail =
    shown.length <= SHOWN_ARGUMENTS
      ? shown
      : t("approval.card.mcp.argumentsHashed", { count: shown.length, n: String(shown.length), hash: sha256Hex(shown).slice(0, 16) });
  const risk = maxRisk(EFFECT_RISK[decision.effect], decision.minRisk ?? "low", argumentFloor(decision.argFloors ?? [], args));
  return {
    // The account it acts as, so two of one app's accounts are told apart on the card.
    display: {
      title: `${input.serverName}${input.identity === undefined ? "" : ` (${serverLine(input.identity, 120)})`}: ${serverLine(input.tool.name, 80)}`,
      detail,
      ...(input.host === undefined ? {} : { host: input.host }),
    },
    subjects: [],
    risk,
    reasons: [
      decision.minRisk === undefined
        ? t("approval.reason.mcp.tool", { server: input.serverName, effect: cardEffect(decision.effect, t) })
        : t("approval.reason.mcp.toolFloor", {
            server: input.serverName,
            effect: cardEffect(decision.effect, t),
            risk: cardRisk(decision.minRisk, t),
          }),
    ],
    ...(risk === "critical" ? { onceOnly: true } : {}),
    // Every tool whose sink is not `none` asks once in a tainted chat, in every taint mode.
    ...(decision.askTainted || input.sink !== "none" ? { askWhenTainted: true } : {}),
    alwaysAnyCall: false,
  };
}

/**
 * What a call returns to the model: the content, with links listed;
 * the image stored for it, as a media reference a model that reads images is
 * shown; other images noted; and a result that does not match the tool's
 * approved output schema passed on, flagged. The server's own content never
 * carries a media reference.
 */
export function mcpToolOutput(
  result: McpCallResult,
  extra: { readonly image?: ToolMediaReference; readonly outputSchemaMismatch?: string } = {},
): unknown {
  const content = withoutMedia(result.content ?? "");
  const unshown = result.images.length - (extra.image === undefined ? 0 : 1);
  if (result.links.length === 0 && unshown === 0 && extra.image === undefined && extra.outputSchemaMismatch === undefined) return content;
  return {
    content,
    ...(result.links.length === 0 ? {} : { links: result.links }),
    ...(extra.outputSchemaMismatch === undefined
      ? {}
      : { outputSchemaMismatch: `the server's result does not match the tool's approved output schema: ${extra.outputSchemaMismatch}` }),
    ...(extra.image === undefined ? {} : { [TOOL_MEDIA_KEY]: extra.image }),
    ...(unshown === 0 ? {} : { images: `${String(unshown)} image(s) not shown` }),
  };
}

/** A server's content without a top-level media reference of its own: only Tavi names an image to show. */
function withoutMedia(content: unknown): unknown {
  if (!isRecord(content) || !(TOOL_MEDIA_KEY in content)) return content;
  const { [TOOL_MEDIA_KEY]: _ignored, ...rest } = content as Record<string, unknown>;
  return rest;
}

/**
 * The first image a model may be shown: a viewable type its bytes confirm —
 * a server's label alone is not trusted, since a provider refuses an image
 * that is not one — within the size `artifacts.view_image` allows.
 */
export function viewableImage(result: McpCallResult): { readonly mediaType: string; readonly data: Uint8Array } | undefined {
  for (const image of result.images) {
    const mediaType = image.mimeType.toLowerCase();
    if (!VIEWABLE_IMAGE_TYPES.test(mediaType) || image.data.length > Math.ceil(MAX_VIEW_IMAGE_BYTES / 3) * 4 + 4) continue;
    const data = Buffer.from(image.data, "base64");
    if (data.byteLength > 0 && data.byteLength <= MAX_VIEW_IMAGE_BYTES && sniffMediaType(data) === mediaType)
      return { mediaType, data: new Uint8Array(data) };
  }
  return undefined;
}

/**
 * The tool records a server's registration offers: approved, decided, and
 * registered from the approved definition. A drifted (withheld), new or
 * removed tool is not among them, so its server-side text never reaches the
 * model.
 */
export function offeredMcpRecords(records: readonly McpToolRecord[]): readonly McpToolRecord[] {
  return records.filter((tool) => tool.state === "approved" && tool.decision !== undefined && tool.approvedDef !== undefined);
}

interface ServerTools {
  readonly version: string;
  readonly listed: number;
  readonly deferred: boolean;
  /** Tavi's own line for it in `tools.search`'s description, used until the operator writes one. */
  readonly defaultLine: string;
  /** The operator's name for the server, cleaned, as its tools are prefixed. */
  readonly serverName: string;
  readonly withdraw: () => void;
  /** Its results' data class, which also decides whether its account is Personal by default. */
  readonly dataClass?: AppDataClass;
}

/** A server's words for a person or the model — a name, a URI, a kind — cleaned, on one line, cut. */
const serverWords = serverLine;

/** At most this many resources are listed to the model. */
const MCP_RESOURCES_LISTED = 200;
/** A resource's text is cut here: a read is capped. */
export const MCP_RESOURCE_READ_MAX_CHARS = 64_000;

/**
 * A resource's contents as the model reads them: its text, cleaned
 * and cut at `MCP_RESOURCE_READ_MAX_CHARS` over all its parts; a binary part
 * named, never shown.
 */
export function resourceText(contents: ReadResourceResult["contents"]): unknown {
  let room = MCP_RESOURCE_READ_MAX_CHARS;
  let truncated = false;
  const parts = contents.map((part) => {
    // The server's URI and kind are its words too: cleaned before the model reads them, as a listing's are.
    const uri = serverWords(part.uri, 2_048);
    const kind = part.mimeType === undefined ? {} : { mimeType: serverWords(part.mimeType, 100) };
    if ("text" in part && typeof part.text === "string") {
      const text = cleanServerText(part.text);
      const kept = text.slice(0, Math.max(0, room));
      room -= kept.length;
      if (kept.length < text.length) truncated = true;
      return { uri, ...kind, text: kept };
    }
    const bytes = "blob" in part && typeof part.blob === "string" ? Math.floor((part.blob.length * 3) / 4) : 0;
    return { uri, ...kind, binary: `${String(bytes)} bytes, not shown` };
  });
  return { contents: parts, ...(truncated ? { truncated: `cut at ${String(MCP_RESOURCE_READ_MAX_CHARS)} characters` } : {}) };
}

/** A held call's question to the person, and how its answer reaches the server. */
interface Hold {
  readonly suspend: WorkflowWaitSuspend;
  readonly question: ToolQuestion;
  readonly answer: (outcome: AgentWaitOutcome) => void;
}

/** One run of a call: its way to ask, and the hold a legacy question raises in it. */
interface AskingRun {
  readonly ask: NonNullable<Parameters<ToolHandler>[0]["ask"]> | undefined;
  readonly hold: (hold: Hold) => void;
  readonly holding: Promise<Hold>;
}

/** A legacy call held open on its question, across the runs that answer it. */
interface HeldCall {
  readonly question: ToolQuestion;
  readonly answer: (outcome: AgentWaitOutcome) => void;
  readonly result: Promise<McpCallResult>;
  readonly timer: NodeJS.Timeout;
  /** Watches whether its task is still open: a task cancelled or ended releases the call. */
  readonly watch: NodeJS.Timeout | undefined;
  readonly session: { run: AskingRun };
  readonly own: AbortController;
}

/** How often a held call checks that its task is still open. */
export const MCP_HELD_WATCH_MS = 5_000;

function newRun(ask: AskingRun["ask"]): AskingRun {
  let hold: ((value: Hold) => void) | undefined;
  const holding = new Promise<Hold>((resolve) => {
    hold = resolve;
  });
  return { ask, hold: (value) => hold?.(value), holding };
}

const heldKey = (pluginId: string, taskId: string, callId: string): string => `${pluginId}\u0000${taskId}\u0000${callId}`;

/** A run a person attends: one that may ask them, and is not unattended. */
export const attended = (policy: TaskExecutionPolicy | undefined): policy is TaskExecutionPolicy =>
  policy !== undefined && policy.humanQuestionsAllowed && policy.mode !== "unattended";

/**
 * A sign-in error in a run a person attends becomes the chat's Connect card:
 * the model is told the person was shown it. Any other
 * error, and one in a run nobody attends, is thrown as it came.
 */
export function signInForChat(error: unknown, serverName: string, pluginId: string, policy: TaskExecutionPolicy | undefined): unknown {
  if (!(error instanceof TaviError) || error.details?.["mcpFailure"] !== "login" || !attended(policy)) return error;
  return new TaviError(
    "NOT_AUTHORIZED",
    `${serverName} needs the person to sign in again. Tavi has shown them a Connect button in this chat; tell them, and continue once they say it's done.`,
    { details: { ...error.details, pluginId, connectCard: true } },
  );
}

/** A suspend whose call stays open: its effect stays `pending` for the next run to take up. */
function heldSuspend(error: WorkflowWaitSuspend): WorkflowWaitSuspend {
  return new WorkflowWaitSuspend({
    waitId: error.waitId,
    deadlineAt: error.deadlineAt,
    ...definedOnly({
      question: error.question,
      choices: error.choices,
      context: error.context,
    }),
    held: true,
  });
}

/** Two ids in code-unit order, the same on every host (`localeCompare` follows the host's locale). */
function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export class McpBridge {
  readonly #options: McpBridgeOptions;
  readonly #servers = new Map<string, ServerTools>();
  /** Legacy calls held open while their question waits, by server, task and call. */
  readonly #held = new Map<string, HeldCall>();
  /** Reconciles run one at a time, so a change never interleaves with another's registration. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: McpBridgeOptions) {
    this.#options = options;
  }

  /**
   * Tool count outside MCP, `tools.search` included, less the built-in families an attended chat defers
   * (`ATTENDED_DEFERRED_FAMILIES`): a list that would pass one request's limit defers them on every surface
   * (`createOfferScope`), so they never take a listed MCP tool's place.
   */
  #nonMcp(): number {
    return this.#options.tools.list().filter((tool) => !tool.id.startsWith("mcp.") && !inAttendedDeferredFamily(tool.id)).length + 1;
  }

  /** The MCP tools a workspace may list (not deferred): `128 − nonMcp − 8`, the deferred families left out of nonMcp. */
  limit(): number {
    return MAX_MODEL_TOOLS - this.#nonMcp() - MCP_BUDGET_HEADROOM;
  }

  /** Listed (non-deferred) MCP tools a workspace offers now, with `extra` counted as if allowed. */
  used(settings: WorkspaceSettings, extra?: { readonly pluginId: string; readonly listed: number }): number {
    let total = 0;
    for (const [pluginId, server] of this.#servers)
      if (mcpServerAllowed(settings, pluginId) && pluginId !== extra?.pluginId && !server.deferred) total += server.listed;
    return total + (extra?.listed ?? 0);
  }

  /** Every workspace whose listed MCP tools are over its budget: the servers and the count. */
  async overBudget(): Promise<
    readonly { readonly workspaceId: string; readonly used: number; readonly limit: number; readonly servers: readonly string[] }[]
  > {
    const limit = this.limit();
    return (await this.#options.allWorkspaceSettings()).flatMap(({ workspaceId, settings }) => {
      const used = this.used(settings);
      return used <= limit
        ? []
        : [
            {
              workspaceId,
              used,
              limit,
              servers: [...this.#servers.keys()].filter((id) => mcpServerAllowed(settings, id) && this.#servers.get(id)?.deferred !== true),
            },
          ];
    });
  }

  /**
   * Refuses an enable that would put a workspace over its budget,
   * naming the count. A server that may run behind `tools.search` (exposure
   * `auto` or `search`) always fits: it is deferred instead.
   */
  async checkEnable(
    workspaceId: string,
    pluginId: string,
    block: McpBlock,
    approvedTools: number,
    alsoAllowed: readonly string[] = [],
  ): Promise<void> {
    if (block.exposure !== "always") return;
    const saved = await this.#options.workspaceSettings(workspaceId);
    // Servers allowed in the same change count as allowed already.
    const settings =
      alsoAllowed.length === 0 ? saved : { ...saved, mcpServers: [...new Set([...(saved.mcpServers ?? []), ...alsoAllowed])] };
    const limit = this.limit();
    const used = this.used(settings, { pluginId, listed: approvedTools });
    if (used > limit) {
      const others = [...this.#servers.keys()].filter((id) => id !== pluginId && mcpServerAllowed(settings, id));
      throw new TaviError(
        "CONFLICT",
        `${pluginId} has ${String(approvedTools)} tools, which would make ${String(used)} MCP tools listed in ${workspaceId} where ${String(limit)} fit${others.length === 0 ? "" : ` (with ${others.join(", ")})`}; set its exposure to search, or disable another server`,
      );
    }
  }

  /** Every MCP server, as at owner start (offline changes included). */
  reconcileAll(): Promise<void> {
    return this.#enqueue(async () => {
      const ids = (await this.#options.registry.list()).filter((view) => mcpSlugOf(view.id) !== undefined).map((view) => view.id);
      for (const id of new Set([...ids, ...this.#servers.keys()])) {
        try {
          await this.#reconcile(id);
        } catch (error) {
          // One server that cannot register (a damaged snapshot, a name taken) leaves the others and the owner running.
          this.#options.log?.("mcp tools not registered", { pluginId: id, error: errorMessage(error) });
        }
      }
    });
  }

  /** One server after a change (`pluginChanged`): its tools withdrawn and registered again as approved now. */
  reconcile(pluginId: string): Promise<void> {
    return this.#enqueue(() => this.#reconcile(pluginId));
  }

  /** Withdraws every server's tools (`tavi mcp off`), after any reconcile already queued, so none registers after it. */
  withdrawAll(): Promise<void> {
    return this.#enqueue(async () => {
      for (const pluginId of [...this.#servers.keys()]) this.withdraw(pluginId);
    });
  }

  /** Withdraws a server's tools (disable, remove). */
  withdraw(pluginId: string): void {
    this.#servers.get(pluginId)?.withdraw();
    this.#servers.delete(pluginId);
  }

  /**
   * The lines `tools.search`'s description carries for this person here:
   * one per server whose tools wait behind search and are offered to
   * them — so another person's chat sees no line for a server not opened to
   * them.
   */
  async searchLines(context: ToolOfferContext): Promise<readonly string[]> {
    const lines: string[] = [];
    // The operator's line is read each time, so `tavi mcp line` applies on the next turn. In server-id order:
    // a reconnect re-adds a server to the map, and the order must not move the tool list's cached prefix.
    for (const [pluginId, server] of [...this.#servers].sort(([left], [right]) => compareIds(left, right)))
      if (server.deferred && (await this.#offered(pluginId, context)))
        lines.push((await this.#options.searchLine?.(pluginId)) ?? server.defaultLine);
    return lines;
  }

  /** The read-only tools of the servers registered now: what a heartbeat's `extraTools` may name. */
  readOnlyTools(): readonly ToolDefinition[] {
    return this.#options.tools
      .list()
      .filter(
        (tool) => tool.effect === "read-only" && tool.id.startsWith("mcp.") && this.#servers.has(tool.id.split(".").slice(0, 2).join(".")),
      );
  }

  /** The servers whose tools are registered, and how many each lists. */
  registered(): ReadonlyMap<string, { readonly version: string; readonly listed: number; readonly deferred: boolean }> {
    return this.#servers;
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(work);
    // Ordering only: the work's own failure reaches its caller through the promise it was handed.
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #reconcile(pluginId: string): Promise<void> {
    this.withdraw(pluginId);
    if (mcpSlugOf(pluginId) === undefined || !(await this.#options.enabled())) return;
    const view = (await this.#options.registry.list()).find((candidate) => candidate.id === pluginId);
    if (view === undefined || view.kind !== "mcp" || !view.enabled || view.activeVersion === undefined) return;
    const version = view.versions.find((candidate) => candidate.version === view.activeVersion);
    if (version?.reviewState !== "approved") return;
    const record = await this.#options.mcp.getVersion(pluginId, version.version);
    if (record?.approvedAt === undefined) return;
    const manifest = readPluginManifest(this.#options.registry.snapshotDirectory(pluginId, version.version));
    const block = manifest.mcp as McpBlock;
    const approved = offeredMcpRecords(await this.#options.mcp.listTools(pluginId, version.version));
    const egress = serverHasEgress(block, record.sandboxState);
    const serverName = mcpServerDisplayName(manifest.name);
    const dataClass = mcpDataClassOf(manifest);
    const identity = await this.#options.identityOf?.(pluginId);
    // A remote server's host, when its address is a literal (one from a setting is shown in the review).
    const host = block.transport === "http" && block.url !== undefined && "value" in block.url ? hostOf(block.url.value) : undefined;
    // `auto`: listed with at most eight tools, behind search otherwise, and behind search too when its tools
    // would not fit what the other servers leave in a workspace that allows it.
    // Its resource tools count with its own: two more listed for a server that offers resources.
    const offersResources = (record.capabilities as { readonly resources?: unknown } | undefined)?.resources !== undefined;
    const counted = approved.length + (offersResources ? 2 : 0);
    const deferred =
      block.exposure === "search" ||
      (block.exposure === "auto" && (counted > MCP_AUTO_LISTED_MAX || counted > (await this.#room(pluginId))));
    const registrations: ExternalToolRegistration[] = [];
    for (const tool of approved) {
      const registration = this.#registration({
        pluginId,
        serverName,
        host,
        egress,
        deferred,
        tool,
        dataClass,
        ...(identity === undefined ? {} : { identity }),
      });
      if (registration !== undefined) registrations.push(registration);
    }
    // A server that offers resources (its capabilities at probe) gets the two resource tools, unless one of
    // its own tools already has the id.
    if (offersResources) {
      const taken = new Set(registrations.map((registration) => registration.id));
      for (const registration of this.#resourceRegistrations({ pluginId, serverName, host, egress, deferred, dataClass }))
        if (!taken.has(registration.id)) registrations.push(registration);
    }
    const withdraw = this.#options.tools.registerExternalBatch(registrations);
    const defaultLine = defaultSearchLine(
      serverName,
      registrations.map((registration) => registration.id),
    );
    this.#servers.set(pluginId, {
      version: version.version,
      listed: deferred ? 0 : registrations.length,
      deferred,
      defaultLine,
      serverName,
      withdraw,
      ...(dataClass === undefined ? {} : { dataClass }),
    });
    this.#options.log?.("mcp tools registered", { pluginId, version: version.version, tools: registrations.length, deferred });
  }

  /** The fewest listed MCP tools still free, over the workspaces that allow `pluginId`, others counted. */
  async #room(pluginId: string): Promise<number> {
    const limit = this.limit();
    let room = limit;
    for (const { settings } of await this.#options.allWorkspaceSettings()) {
      if (mcpServerAllowed(settings, pluginId)) room = Math.min(room, limit - this.used(settings, { pluginId, listed: 0 }));
    }
    return room;
  }

  #registration(input: {
    readonly pluginId: string;
    readonly serverName: string;
    readonly host: string | undefined;
    readonly egress: boolean;
    readonly deferred: boolean;
    readonly tool: McpToolRecord;
    readonly dataClass: AppDataClass | undefined;
    readonly identity?: string;
  }): ExternalToolRegistration | undefined {
    const { pluginId, tool } = input;
    const decision = tool.decision;
    if (decision === undefined || tool.approvedDef === undefined) return undefined;
    // What the model is offered and calls are checked against: the approved definition, cleaned (its hash stays the raw one's).
    const definition = cleanDefinition(tool.approvedDef);
    let form: ReturnType<typeof inputFormOf>;
    try {
      form = inputFormOf(tool.toolId, definition.inputSchema);
    } catch (error) {
      // Approval registers only a schema that compiles; one that no longer does is left out, not guessed at.
      this.#options.log?.("mcp tool not registered: its schema does not compile", { toolId: tool.toolId, error: errorMessage(error) });
      return undefined;
    }
    const sink = mcpToolSink(decision.effect, input.egress);
    const slug = mcpSlugOf(pluginId) as string;
    const description = mcpToolDescription({ serverName: input.serverName, identity: input.identity, slug, tool, definition });
    const checkOutput = outputCheckOf(definition.outputSchema);
    return {
      id: tool.toolId,
      version: tool.version,
      description,
      // The server's call holds its own deadline (`decision.timeoutMs`), and an elicitation may wait on a person.
      timeoutMs: 0,
      effect: decision.effect,
      requiredPermissions: ["tools.invoke"],
      inputSchema: form.inputSchema,
      ...(form.inputJsonSchema === undefined ? {} : { inputJsonSchema: form.inputJsonSchema }),
      untrustedOutput: true,
      outputSource: "mcp",
      outputPrincipal: `tool:${slug}`,
      // Mail and calendar results are personal data: the Rule of Two's [B] sees them.
      ...(input.dataClass === undefined ? {} : { outputConfidentiality: input.dataClass }),
      ...sink,
      ...(input.deferred ? { deferred: true } : {}),
      // The server's hints, as the spec defaults them (an unhinted tool is a destructive write), on Tavi's annotations.
      annotations: mcpAnnotations(definition.annotations, decision.effect),
      assess: (args, context) =>
        mcpAssessment(
          {
            serverName: input.serverName,
            tool,
            ...(input.host === undefined ? {} : { host: input.host }),
            sink: sink.sink,
            identity: input.identity,
          },
          args,
          context,
        ),
      offered: (context) => this.#offered(pluginId, context),
      holdsCall: (taskId, callId) => this.#holds(pluginId, taskId, callId),
      handler: async ({ input: args, context, signal, taskId, callId, executionPolicy, ask, contextLabel }) => {
        if (!(await this.#mayUse(pluginId, context))) throw new TaviError("NOT_AUTHORIZED", `${tool.toolId} is not offered here`);
        try {
          const result = await this.#callAsking({
            pluginId,
            serverName: input.serverName,
            workspaceId: context.workspaceId,
            tool: tool.name,
            args: serverArguments(form, args),
            signal,
            timeoutMs: decision.timeoutMs,
            ...definedOnly({ taskId, callId, executionPolicy, ask }),
          });
          // A structured result is checked against the approved output schema: one that does not match is passed on, flagged.
          const outputSchemaMismatch = result.structured === true ? checkOutput?.(result.content) : undefined;
          if (outputSchemaMismatch !== undefined)
            this.#options.log?.("mcp result does not match its output schema", { toolId: tool.toolId, issues: outputSchemaMismatch });
          const image = await this.#storedImage(result, {
            workspaceId: context.workspaceId,
            slug,
            ...(taskId === undefined ? {} : { taskId }),
            ...(contextLabel === undefined ? {} : { contextLabel }),
          });
          return mcpToolOutput(result, {
            ...(image === undefined ? {} : { image }),
            ...(outputSchemaMismatch === undefined ? {} : { outputSchemaMismatch }),
          });
        } catch (error) {
          const status =
            error instanceof TaviError && error.details?.["mcpFailure"] === "auth" ? Number(error.details["status"]) : undefined;
          const lapsed =
            status === undefined
              ? false
              : (await this.#options
                  .onAuthFailure?.(
                    pluginId,
                    status,
                    error instanceof TaviError && error.details?.["insufficientScope"] === true,
                    error instanceof TaviError && typeof error.details?.["requiredScope"] === "string"
                      ? error.details["requiredScope"]
                      : undefined,
                  )
                  .catch(() => false)) === true;
          // An OAuth server that refused its token (a sign-in revoked at the provider) needs a sign-in, as a lapsed one does.
          const failure = lapsed
            ? new TaviError("NOT_AUTHORIZED", `${input.serverName} refused its sign-in: it needs signing in again`, {
                details: { mcpFailure: "login", pluginId, cause: "the server refused its token (HTTP 401)" },
              })
            : error;
          // A person may be asked: the task waits for the server's sign-in, and the call runs again.
          if (ask !== undefined && failure instanceof TaviError && failure.details?.["mcpFailure"] === "login") {
            await awaitConnect(
              ask,
              {
                appName: input.serverName,
                accountId: pluginId,
                reason: String(failure.details["cause"] ?? "its sign-in expired or was revoked").slice(0, 300),
                health: "needs-sign-in",
              },
              { mcpFailure: "login", pluginId },
            );
          }
          throw signInForChat(failure, input.serverName, pluginId, executionPolicy);
        }
      },
    };
  }

  /**
   * The first image a call returned that a model may be shown, stored as an
   * approved artifact of the task — labelled as the server's, joined
   * with the chat's context — for a model that reads images; none without a
   * store, or when no image is viewable or storing it fails.
   */
  async #storedImage(
    result: McpCallResult,
    call: { readonly workspaceId: string; readonly slug: string; readonly taskId?: string; readonly contextLabel?: ContentLabel },
  ): Promise<ToolMediaReference | undefined> {
    const store = this.#options.storeImage;
    const image = store === undefined ? undefined : viewableImage(result);
    if (store === undefined || image === undefined) return undefined;
    const label = call.contextLabel === undefined ? mcpResultLabel(call.slug) : joinLabels(call.contextLabel, mcpResultLabel(call.slug));
    try {
      const artifactId = await store({
        workspaceId: call.workspaceId,
        ...(call.taskId === undefined ? {} : { taskId: call.taskId }),
        mediaType: image.mediaType,
        data: image.data,
        label,
      });
      return { artifactId, mediaType: image.mediaType };
    } catch (error) {
      this.#options.log?.("mcp image not stored", { slug: call.slug, error: errorMessage(error) });
      return undefined;
    }
  }

  /** The workspace's words for a server's question; English when it names none or its settings cannot be read. */
  async #wordsOf(workspaceId: string | undefined): Promise<CoreT> {
    if (workspaceId === undefined) return coreEnglish;
    try {
      const locale = localeOf(await this.#options.workspaceSettings(workspaceId));
      return locale === DEFAULT_LOCALE ? coreEnglish : coreIn(locale);
    } catch (error) {
      this.#options.log?.("the workspace's language could not be read; a server's question is asked in English", {
        workspaceId,
        error: errorMessage(error),
      });
      return coreEnglish;
    }
  }

  /**
   * One call whose server may ask its person a question.
   * The question is the task's: `ask` suspends the task until it is answered
   * (a `WorkflowWaitSuspend` passes through), and the call runs again then.
   * A 2026-07-28 server is simply called again, and finds its answers. A
   * legacy server holds its call open while it waits, so that call is kept
   * here, by task and call, and the call's next run answers it and takes its
   * result — through as many questions as the server asks, each held for up
   * to ten minutes; its effect stays `pending` meanwhile (`holdsCall`), so a
   * hold lost to a restart or a lapse leaves the call uncertain, never made
   * twice. A run nobody attends — or one that may ask only with a default —
   * declines every question at once; a question nobody answers sends the
   * server nothing.
   */
  async #callAsking(call: {
    readonly pluginId: string;
    readonly serverName: string;
    /** The workspace the call runs in: its question is framed in that workspace's language. */
    readonly workspaceId?: string;
    readonly tool: string;
    readonly args: unknown;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly taskId?: string;
    readonly callId?: string;
    readonly executionPolicy?: TaskExecutionPolicy;
    readonly ask?: NonNullable<Parameters<ToolHandler>[0]["ask"]>;
  }): Promise<McpCallResult> {
    const key = call.taskId === undefined || call.callId === undefined ? undefined : heldKey(call.pluginId, call.taskId, call.callId);
    const policy = call.executionPolicy;
    const ask = !attended(policy) || policy?.requiresDefault === true ? undefined : call.ask;
    const run = newRun(ask);
    const held = key === undefined ? undefined : this.#held.get(key);
    if (held !== undefined) {
      // Still open in this process: this run answers its question, and waits for its result or its next question.
      if (ask === undefined) throw new TaviError("CONFLICT", `${call.tool}'s call is waiting on a question this run cannot ask`);
      let outcome: AgentWaitOutcome;
      try {
        outcome = await ask(held.question);
      } catch (error) {
        throw error instanceof WorkflowWaitSuspend ? heldSuspend(error) : error;
      }
      clearTimeout(held.timer);
      if (held.watch !== undefined) clearInterval(held.watch);
      this.#held.delete(key as string);
      held.session.run = run;
      held.answer(outcome);
      // This run may cancel the call while it waits for it.
      const forward = (): void => held.own.abort(call.signal.reason);
      call.signal.addEventListener("abort", forward, { once: true });
      try {
        return await this.#untilHeld(key, call.taskId, held.result, run, held.session, held.own);
      } finally {
        call.signal.removeEventListener("abort", forward);
      }
    }
    const own = new AbortController();
    const forward = (): void => own.abort(call.signal.reason);
    call.signal.addEventListener("abort", forward, { once: true });
    const session: { run: AskingRun } = { run };
    const elicit: McpElicit = async (request, era) => {
      const current = session.run;
      if (current.ask === undefined) return { action: "decline" };
      const plan = planElicitation(call.serverName, request, era, await this.#wordsOf(call.workspaceId));
      if (plan.kind === "decline") {
        this.#options.log?.("mcp question declined", { pluginId: call.pluginId, tool: call.tool, reason: plan.reason });
        return { action: "decline" };
      }
      // A legacy question needs somewhere to be held; a call outside a turn has none, so it is declined.
      if (era === "legacy" && key === undefined) return { action: "decline" };
      const unanswered = (): TaviError =>
        new TaviError("UNAVAILABLE", `${call.serverName}'s question went unanswered; nothing was sent to it`);
      try {
        const answer = plan.read(await current.ask(plan.question));
        if (answer !== undefined) return answer;
        own.abort(unanswered());
        throw unanswered();
      } catch (error) {
        // A legacy server waits mid-call: the call is held open while the task waits on the question.
        if (!(error instanceof WorkflowWaitSuspend) || era === "modern") throw error;
        return await new Promise<ElicitResult>((resolve, reject) => {
          current.hold({
            suspend: heldSuspend(error),
            question: plan.question,
            answer: (outcome) => {
              const answer = plan.read(outcome);
              if (answer !== undefined) return resolve(answer);
              own.abort(unanswered());
              reject(unanswered());
            },
          });
        });
      }
    };
    const progress = this.#progressOf(call);
    const result = this.#options.supervisor.call(call.pluginId, call.tool, call.args, {
      signal: own.signal,
      timeoutMs: call.timeoutMs,
      elicit,
      ...(progress === undefined ? {} : { onProgress: progress.report }),
    });
    if (progress !== undefined) result.then(progress.end, progress.end);
    try {
      return await this.#untilHeld(key, call.taskId, result, run, session, own);
    } finally {
      // Held, the call is no longer the turn's to cancel; otherwise it has ended.
      call.signal.removeEventListener("abort", forward);
    }
  }

  /**
   * The call's result, or — when it stops on a question — the call held, by
   * task and call, for a little past the question's own deadline, and the
   * run's suspend thrown so the task waits.
   */
  async #untilHeld(
    key: string | undefined,
    taskId: string | undefined,
    result: Promise<McpCallResult>,
    run: AskingRun,
    session: { run: AskingRun },
    own: AbortController,
  ): Promise<McpCallResult> {
    const first = await Promise.race([result.then((value) => ({ value })), run.holding.then((hold) => ({ hold }))]);
    if ("value" in first) return first.value;
    // Awaited or raced elsewhere: this only keeps an early rejection from going unhandled.
    result.catch(() => undefined);
    if (key !== undefined) {
      const release = (why: string): void => {
        const held = this.#held.get(key);
        if (held === undefined) return;
        clearTimeout(held.timer);
        if (held.watch !== undefined) clearInterval(held.watch);
        this.#held.delete(key);
        own.abort(new TaviError("UNAVAILABLE", why));
      };
      const timer = setTimeout(() => release("the server's question went unanswered; the call stopped"), LEGACY_QUESTION_MS + 60_000);
      timer.unref();
      // A task cancelled, or ended otherwise, while its question waits: the call is cancelled at the server at once,
      // not held for the question's whole deadline.
      const taskOpen = this.#options.taskOpen;
      const watch =
        taskOpen === undefined || taskId === undefined
          ? undefined
          : setInterval(() => {
              void taskOpen(taskId).then(
                (open) => {
                  if (!open) release("its task ended while the server's question waited; the call was cancelled");
                },
                () => undefined,
              );
            }, MCP_HELD_WATCH_MS);
      watch?.unref();
      this.#held.set(key, { question: first.hold.question, answer: first.hold.answer, result, timer, watch, session, own });
    }
    throw first.hold.suspend;
  }

  /**
   * A call's progress: each notification as the task's tool line, at
   * most once a `MCP_PROGRESS_INTERVAL_MS`, and the line cleared when the
   * call ends. None for a call outside a task, or with nowhere to show it.
   */
  #progressOf(call: {
    readonly pluginId: string;
    readonly serverName: string;
    readonly tool: string;
    readonly taskId?: string;
  }): { readonly report: (progress: McpProgress) => void; readonly end: () => void } | undefined {
    const show = this.#options.progress;
    const taskId = call.taskId;
    if (show === undefined || taskId === undefined) return undefined;
    let shownAt: number | undefined;
    let ended = false;
    return {
      report: (progress) => {
        const now = Date.now();
        if (ended || (shownAt !== undefined && now - shownAt < MCP_PROGRESS_INTERVAL_MS)) return;
        shownAt = now;
        show({ pluginId: call.pluginId, taskId, line: mcpProgressLine(call.serverName, call.tool, progress) });
      },
      end: () => {
        ended = true;
        if (shownAt !== undefined) show({ pluginId: call.pluginId, taskId, line: undefined });
      },
    };
  }

  /** Whether this bridge holds `callId` of `taskId` open on a question (`RegisteredTool.holdsCall`). */
  #holds(pluginId: string, taskId: string, callId: string): boolean {
    return this.#held.has(heldKey(pluginId, taskId, callId));
  }

  /**
   * A server's resources as two read-only tools:
   * `resources_list` lists them, `resource_read` reads one by its URI — a URI
   * only ever the server's to resolve, never fetched here — capped. Both are
   * untrusted, from `mcp`, said by `tool:<name>`, as the server's tool
   * results are, and ask once in a tainted chat when the server can
   * reach the network.
   */
  #resourceRegistrations(input: {
    readonly pluginId: string;
    readonly serverName: string;
    readonly host: string | undefined;
    readonly egress: boolean;
    readonly deferred: boolean;
    readonly dataClass: AppDataClass | undefined;
  }): readonly ExternalToolRegistration[] {
    const { pluginId, serverName } = input;
    const slug = mcpSlugOf(pluginId) as string;
    const sink = mcpToolSink("read-only", input.egress);
    const assess = (name: string, args: unknown, context: InvocationContext | undefined): CallAssessment => ({
      display: {
        title: `${serverName}: ${name}`,
        detail: JSON.stringify(args ?? {}).slice(0, SHOWN_ARGUMENTS),
        ...(input.host === undefined ? {} : { host: input.host }),
      },
      subjects: [],
      risk: "low",
      reasons: [cardWords(context)("approval.reason.mcp.resource", { server: serverName })],
      ...(sink.sink === "none" ? {} : { askWhenTainted: true }),
      alwaysAnyCall: false,
    });
    const common = {
      version: "1",
      effect: "read-only" as const,
      requiredPermissions: ["tools.invoke"],
      untrustedOutput: true,
      outputSource: "mcp" as const,
      outputPrincipal: `tool:${slug}`,
      ...(input.dataClass === undefined ? {} : { outputConfidentiality: input.dataClass }),
      ...sink,
      ...(input.deferred ? { deferred: true } : {}),
      offered: (context: ToolOfferContext) => this.#offered(pluginId, context),
    };
    const allowed = async (context: InvocationContext, id: string): Promise<void> => {
      if (!(await this.#mayUse(pluginId, context))) throw new TaviError("NOT_AUTHORIZED", `${id} is not offered here`);
    };
    const listId = `mcp.${slug}.resources_list`;
    const readId = `mcp.${slug}.resource_read`;
    return [
      {
        ...common,
        id: listId,
        description: `[${serverName}] Lists the resources the MCP server offers: each one's URI, name and kind. Read one with ${readId}.`,
        inputSchema: z.strictObject({}),
        assess: (args, context) => assess("resources_list", args, context),
        handler: async ({ context, signal }) => {
          await allowed(context, listId);
          const listed = await this.#options.supervisor.read(pluginId, (connection, read) => connection.listResources(read), { signal });
          return listed.slice(0, MCP_RESOURCES_LISTED).map((resource) => ({
            uri: serverWords(resource.uri, 2_048),
            name: serverWords(resource.name, 200),
            ...(resource.description === undefined ? {} : { description: serverWords(resource.description, 500) }),
            ...(resource.mimeType === undefined ? {} : { mimeType: serverWords(resource.mimeType, 100) }),
          }));
        },
      },
      {
        ...common,
        id: readId,
        description: `[${serverName}] Reads one resource of the MCP server by its URI, as ${listId} lists it. Its text is cut at ${String(MCP_RESOURCE_READ_MAX_CHARS)} characters.`,
        inputSchema: z.strictObject({ uri: z.string().min(1).max(2_048).describe("The resource's URI, as the server lists it") }),
        assess: (args, context) => assess("resource_read", args, context),
        handler: async ({ input: args, context, signal }) => {
          await allowed(context, readId);
          const { uri } = args as { readonly uri: string };
          const read = await this.#options.supervisor.read(pluginId, (connection, reading) => connection.readResource(uri, reading), {
            signal,
          });
          return resourceText(read.contents);
        },
      },
    ];
  }

  /**
   * The prompt a `/mcp-<server>-<prompt>` command runs, with its
   * text from the server: only in the operator's own chats, for a server
   * enabled, approved and allowed here. Undefined when the line is not such a
   * command for such a server (it is then the person's words as typed); a
   * prompt the server does not have, or arguments it refuses, throw.
   */
  async promptFor(
    line: string,
    context: { readonly workspaceId: string; readonly principalId: string; readonly memoryReach?: "chat-only" | undefined },
  ): Promise<{ readonly serverName: string; readonly slug: string; readonly name: string; readonly text: string } | undefined> {
    const command = parsePromptCommand(line);
    // Who the operator is, decided here from the workspace's grant: never a flag the caller sets.
    if (command === undefined || this.#options.operatorOf(context.workspaceId) !== context.principalId) return undefined;
    const pluginId = `${MCP_PLUGIN_PREFIX}${command.slug}`;
    const server = this.#servers.get(pluginId);
    if (server === undefined || !(await this.#offered(pluginId, { ...context, operator: true }))) return undefined;
    const prompts = promptCommands(await this.#options.supervisor.read(pluginId, (connection, signal) => connection.listPrompts(signal)));
    const prompt = prompts.get(command.name);
    if (prompt === undefined)
      throw new TaviError(
        "NOT_FOUND",
        `the MCP server ${server.serverName} has no prompt ${command.name}${
          prompts.size === 0
            ? ""
            : `; it has ${[...prompts.keys()]
                .slice(0, 20)
                .map((name) => `/mcp-${command.slug}-${name}`)
                .join(", ")}`
        }`,
      );
    const args = promptArguments(prompt, command.args);
    const result = await this.#options.supervisor.read(pluginId, (connection, signal) => connection.getPrompt(prompt.name, args, signal));
    return { serverName: server.serverName, slug: command.slug, name: serverWords(prompt.name, 100), text: promptText(result) };
  }

  /**
   * Offered: allowed in the workspace, not failed, and to this person. A Personal account
   * only to the operator, and never in a group chat's turn (`chat-only`).
   */
  async #offered(pluginId: string, context: ToolOfferContext): Promise<boolean> {
    if (this.#options.supervisor.status(pluginId).state === "failed") return false;
    const settings = await this.#options.workspaceSettings(context.workspaceId);
    if (!mcpServerAllowed(settings, pluginId)) return false;
    if (await this.#personal(pluginId)) return context.operator === true && context.memoryReach !== "chat-only";
    // Fails closed: a list assembled without knowing the person (outside a turn) offers the operator's tools to no one.
    return context.operator === true || mcpServerForPeople(settings, pluginId);
  }

  /** The same rule at call time, from the call's own context: a tool not offered here is refused if called. */
  /**
   * Whether a caller may use a server's tools here: the rule every MCP tool call meets, for the video host's analyser
   * calls too, which reach the supervisor without a registration.
   */
  async mayUse(pluginId: string, caller: Pick<InvocationContext, "workspaceId" | "principalId" | "memoryReach">): Promise<boolean> {
    return this.#mayUse(pluginId, caller);
  }

  async #mayUse(pluginId: string, context: Pick<InvocationContext, "workspaceId" | "principalId" | "memoryReach">): Promise<boolean> {
    if (this.#options.supervisor.status(pluginId).state === "failed") return false;
    const settings = await this.#options.workspaceSettings(context.workspaceId);
    if (!mcpServerAllowed(settings, pluginId)) return false;
    const operator = this.#options.operatorOf(context.workspaceId) === context.principalId;
    if (await this.#personal(pluginId)) return operator && context.memoryReach !== "chat-only";
    return operator || mcpServerForPeople(settings, pluginId);
  }

  /** From the data class its registration recorded: a server not registered here offers nothing anyway. */
  async #personal(pluginId: string): Promise<boolean> {
    return (await this.#options.personal?.(pluginId, this.#servers.get(pluginId)?.dataClass)) === true;
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * An MCP tool's hints as Tavi's annotations, held to the effect the operator
 * approved: read-only only when approved so, and a write the server called
 * read-only (or left unhinted) destructive, as the spec defaults an unhinted
 * tool. `idempotentHint` and `openWorldHint` are kept as said.
 */
export function mcpAnnotations(annotations: unknown, effect: ToolEffect): NonNullable<ToolDefinition["annotations"]> {
  const hints = normalizedHints(annotations);
  const given = (annotations ?? {}) as { readonly idempotentHint?: unknown };
  const readOnly = effect === "read-only";
  return {
    readOnly,
    destructive: !readOnly && (hints.readOnly || hints.destructive),
    idempotent: given.idempotentHint === true,
    openWorld: hints.openWorld || effect === "external",
  };
}
