import { z } from "zod";

import type { RiskLevel } from "./tool-policy.js";
import type { ToolEffect } from "./tools.js";

/**
 * What Tavi keeps about each MCP server version and its tools: the
 * sandbox state the operator
 * chose, the era verdict, what the probe saw, and each tool's approved and
 * observed definition with the operator's decisions. Live state (running,
 * backing off, failures) is never stored.
 */

/** How a version's server code runs, chosen by the operator, never by a manifest. */
export const MCP_SANDBOX_STATES = ["srt", "nested", "none"] as const;
export type McpSandboxState = (typeof MCP_SANDBOX_STATES)[number];

export const MCP_TOOL_STATES = ["pending", "approved", "withheld", "disabled", "removed", "rejected"] as const;
export type McpToolState = (typeof MCP_TOOL_STATES)[number];

export const MCP_NOTICE_KINDS = ["drift", "login", "scope", "failed", "budget"] as const;
export type McpNoticeKind = (typeof MCP_NOTICE_KINDS)[number];

/** Most tools a server may offer; more fails the probe, or the server after drift (invariant 19). */
export const MCP_MAX_TOOLS = 128;
/** `exposure: "auto"`: a server with at most this many approved tools is listed; a larger one waits behind `tools.search`. */
export const MCP_AUTO_LISTED_MAX = 8;
/** `doctor` warns when a workspace's listed MCP tools' schemas pass this many tokens. */
export const MCP_SCHEMA_TOKENS_WARN = 20_000;
/** A tool call's default and largest timeout. */
export const MCP_TOOL_TIMEOUT_MS = { default: 60_000, max: 600_000 } as const;

/** A server version's record: what the operator chose and what the probe found. */
export interface McpVersionRecord {
  readonly pluginId: string;
  readonly version: string;
  readonly sandboxState: McpSandboxState;
  readonly transport: "stdio" | "http";
  /** The era verdict (`{kind:"legacy"}` or `{kind:"modern",discover}`), as JSON; absent until probed. */
  readonly eraPrior?: unknown;
  /** `streamable` or `sse`, for an http server. */
  readonly httpMode?: "streamable" | "sse";
  readonly externalPath?: string;
  readonly externalSha256?: string;
  readonly interpreterPath?: string;
  readonly interpreterSha256?: string;
  readonly serverInfo?: { readonly name: string; readonly version: string };
  /** The server's instructions, cleaned: shown to the operator, never to the model. */
  readonly instructions?: string;
  readonly instructionsHash?: string;
  readonly capabilities?: unknown;
  readonly treeIndexStale: boolean;
  /** The workspace the server was added from: its operator hears of it before any workspace allows it. */
  readonly addedFromWorkspace?: string;
  readonly probedAt?: string;
  readonly probedBy?: string;
  readonly approvedAt?: string;
  readonly approvedBy?: string;
}

/** The operator's decisions about one tool, as review sets them. */
export interface McpToolDecision {
  readonly effect: ToolEffect;
  /** A risk floor: `high`, or `critical` (asked every time, once only, no grants). */
  readonly minRisk?: RiskLevel;
  /** Fail-closed argument floors from a preset. */
  readonly argFloors?: readonly McpArgFloor[];
  readonly timeoutMs: number;
  /** It asks once under taint, whatever its effect (egress). */
  readonly askTainted: boolean;
}

/** A tool's record: approved and observed definitions, the suggestion and the decision. */
export interface McpToolRecord {
  readonly pluginId: string;
  readonly version: string;
  /** The server's own name for the tool. */
  readonly name: string;
  /** `mcp.<slug>.<normalized name>`. */
  readonly toolId: string;
  readonly approvedDefHash?: string;
  readonly approvedDef?: McpToolDefinition;
  readonly observedDefHash: string;
  readonly observedDef: McpToolDefinition;
  readonly suggestedEffect: ToolEffect;
  /** The suggestion's floor (`high` for a destructive tool). */
  readonly suggestedMinRisk?: RiskLevel;
  readonly decision?: McpToolDecision;
  /** A read-only claim on a write-named tool: not pre-selected, blocks approval until chosen. */
  readonly doubtful: boolean;
  /** Its description reads like instructions: not pre-selected, blocks approval until chosen. */
  readonly flagged: boolean;
  readonly state: McpToolState;
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
}

/**
 * A fail-closed argument floor: any call that does not prove a safe target
 * gets `risk`. A target is safe when one of the `identify` arguments is
 * present and every value it holds starts with one of `safe` (an entity id
 * prefix such as `light.`) or equals one of them (a domain such as `light`).
 */
export const McpArgFloorSchema = z.strictObject({
  risk: z.enum(["low", "medium", "high", "critical"]),
  identify: z.array(z.string().min(1).max(64)).min(1).max(8),
  safe: z.array(z.string().min(1).max(64)).max(32),
});
export type McpArgFloor = z.infer<typeof McpArgFloorSchema>;

/**
 * The parts of a tool definition that are hashed and pinned; `_meta` is left out but for
 * `_meta["tavi/analyzer"]`.
 */
export interface McpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
  /**
   * `_meta["tavi/analyzer"]`: the video analyser manifest the tool declares, as
   * the server sent it. Hashed with the rest, so a server that changes it (claiming `local: true` after approval)
   * drifts; read only by the video host, which validates it.
   */
  readonly analyzer?: unknown;
}

/** One file of a stored tree's start-time index. */
export interface McpTreeIndexEntry {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** A rewrite that restores the mtime still moves the ctime. */
  readonly ctimeMs: number;
  readonly ino: number;
  readonly sha256: string;
}

/** An owner-wide server notice: one open per server and kind. */
export interface McpNoticeRecord {
  readonly noticeId: string;
  readonly pluginId: string;
  readonly kind: McpNoticeKind;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly delivered: Readonly<Record<string, unknown>>;
  readonly decidedAt?: string;
  readonly decidedBy?: string;
}

/** The store's port (sync in the database worker; async through the client). */
export interface McpRepositoryPort {
  /** Records (or replaces) a version's probe and sandbox state; the plugin version must be installed. */
  putVersion(record: McpVersionRecord): McpVersionRecord;
  getVersion(pluginId: string, version: string): McpVersionRecord | undefined;
  listVersions(pluginId?: string): readonly McpVersionRecord[];
  /** Replaces the version's tools as the probe saw them, keeping each unchanged tool's earlier decision. */
  putObservedTools(
    pluginId: string,
    version: string,
    tools: readonly Omit<McpToolRecord, "state" | "decision" | "approvedDef" | "approvedDefHash" | "reviewedBy" | "reviewedAt">[],
  ): readonly McpToolRecord[];
  listTools(pluginId: string, version?: string): readonly McpToolRecord[];
  /**
   * The trust decision, in one transaction: the plugin version approved, the
   * version's approval fields, and every tool's decision and state (approved
   * or disabled), each pinned to its observed definition.
   */
  approveVersion(input: {
    readonly pluginId: string;
    readonly version: string;
    readonly by: string;
    readonly now: string;
    readonly decisions: Readonly<Record<string, McpToolDecision | "disabled">>;
    /** Each tool's definition hash as reviewed: a definition that changed since (a probe meanwhile) refuses the approval. */
    readonly expected: Readonly<Record<string, string>>;
    readonly externalSha256?: string;
  }): readonly McpToolRecord[];
  /** Rejects the plugin version and marks its tools `rejected`. */
  rejectVersion(pluginId: string, version: string, by: string, now: string): void;
  /** Sets one tool's state (drift withholds, removes; review restores). */
  setToolState(pluginId: string, version: string, name: string, state: McpToolState, by: string, now: string): void;
  putTreeIndex(pluginId: string, version: string, entries: readonly McpTreeIndexEntry[]): void;
  getTreeIndex(pluginId: string, version: string): readonly McpTreeIndexEntry[];
  /** After a restore: every index is stale, so the next start re-hashes in full. */
  markTreeIndexesStale(): number;
  setTreeIndexStale(pluginId: string, version: string, stale: boolean): void;
  /** Opens or updates the one open notice of this server and kind (invariant 32). */
  upsertNotice(input: {
    readonly noticeId: string;
    readonly pluginId: string;
    readonly kind: McpNoticeKind;
    readonly detail: Readonly<Record<string, unknown>>;
    readonly now: string;
  }): McpNoticeRecord;
  listNotices(options: { readonly pluginId?: string; readonly open?: boolean }): readonly McpNoticeRecord[];
  decideNotice(noticeId: string, by: string, now: string): boolean;
  setNoticeDelivered(noticeId: string, delivered: Readonly<Record<string, unknown>>): void;
  /** The remove hook: notices have no version, so they go with the server. */
  deleteNotices(pluginId: string): number;
}
