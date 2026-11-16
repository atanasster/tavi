import type { ContentLabel } from "../content-label.js";
import type { AsyncRepository } from "../persistence-types.js";

/**
 * Outcome of one external effect.
 *
 * `pending` means the effect was attempted but no outcome was durably recorded —
 * an interrupted submission. It is deliberately distinct from `rejected`:
 * exactly-once external effects are never promised, so an unknown result must
 * be reconciled by a human rather than retried or assumed.
 */
export const EFFECT_STATES = ["pending", "accepted", "rejected", "uncertain"] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

export interface EffectRecord {
  /**
   * Stable logical operation key.
   *
   * Derived from stable identities (task, admission, call, normalized inputs),
   * so a replay resolves the same effect instead of creating a new one.
   */
  readonly effectKey: string;
  readonly taskId: string;
  readonly admissionId: string;
  readonly toolId: string;
  /** Normalized inputs the effect was authorized for. */
  readonly inputs: unknown;
  readonly inputsHash: string;
  /** The approval that authorized it, when the effect required one. */
  readonly approvalId: string | null;
  readonly state: EffectState;
  /** Provider receipt, once there is one. */
  readonly receipt: unknown;
  /**
   * The result's content label as it entered the conversation, kept with the
   * receipt so a replay restores it. Absent on an
   * effect resolved before labels, or without a result.
   */
  readonly label?: ContentLabel;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface EffectRepositoryPortDefinition {
  /**
   * Record the intent to perform an effect, before it is attempted.
   *
   * Returns the existing record when the key is already known, which is what
   * makes a replay resolve the same operation rather than starting a new one.
   */
  begin(input: {
    readonly effectKey: string;
    readonly taskId: string;
    readonly admissionId: string;
    readonly toolId: string;
    readonly inputs: unknown;
    readonly approvalId?: string | null;
    readonly now: () => string;
  }): { readonly effect: EffectRecord; readonly created: boolean };
  resolve(input: {
    readonly effectKey: string;
    readonly state: EffectState;
    readonly receipt?: unknown;
    /** The result's label, kept with the receipt (`EffectRecord.label`). */
    readonly label?: ContentLabel;
    readonly error?: string;
    readonly now: () => string;
  }): void;
  /**
   * Forgets an effect begun but never attempted to an outcome, so its call
   * runs again on the next pass: a call that stopped to ask its person a
   * question. Only a `pending` row goes; false
   * otherwise, so a call that reached an outcome keeps it.
   */
  abandon(effectKey: string): boolean;
  get(effectKey: string): EffectRecord | undefined;
  listForTask(taskId: string): readonly EffectRecord[];
  /**
   * A workspace's effects of the tools under these prefixes (each `<pluginId>.`), newest first:
   * an app's Recent activity. Never the inputs or receipt.
   */
  listForTools(input: EffectActivityQuery): readonly EffectActivity[];
  /**
   * Effects whose outcome is unknown.
   *
   * Surfaced for reconciliation; never retried automatically.
   */
  listUnresolved(limit: number): readonly EffectRecord[];
}

export type EffectRepositoryPort = AsyncRepository<EffectRepositoryPortDefinition>;

export interface EffectActivityQuery {
  readonly workspaceId: string;
  /** Tool-id prefixes, each ending in `.`, so `mcp.gcal.` never matches `mcp.gcalendar.*`. */
  readonly prefixes: readonly string[];
  /** The previous page's last effect: this page lists only those after it, in `(createdAt, effectKey)` descending order. */
  readonly before?: { readonly at: string; readonly effectKey: string };
  readonly limit: number;
}

export interface ToolCallActivityQuery {
  readonly workspaceId: string;
  /** Exact tool ids: an app's read-only tools. */
  readonly toolIds: readonly string[];
  /** The previous page's last call: this page lists only those after it, in `(at, callKey)` descending order. */
  readonly before?: { readonly at: string; readonly callKey: string };
  readonly limit: number;
}

/** One recorded call as an app's activity shows it; `callKey` is unique among a workspace's calls. */
export interface ToolCallActivity {
  readonly callKey: string;
  readonly taskId: string;
  readonly taskTitle?: string;
  readonly toolId: string;
  readonly at: string;
}

/** One effect as an app's activity shows it. */
export interface EffectActivity {
  readonly effectKey: string;
  readonly taskId: string;
  readonly taskTitle?: string;
  readonly toolId: string;
  readonly state: EffectState;
  readonly createdAt: string;
}

/** The upper bound of a tool-id prefix's range: the prefix's last character, plus one. */
export function toolPrefixEnd(prefix: string): string {
  return `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
}
