import { assertPositiveLimit, hashEffectInputs } from "../values.js";
import type { EffectRepositoryPort } from "../internal-contracts.js";
import { TASK_PROMPT_SQL, displayTitleOf } from "../task-list.js";
import {
  TaviError,
  type EffectActivity,
  type EffectActivityQuery,
  type EffectRecord,
  type EffectState,
  type ContentLabel,
  toolPrefixEnd,
} from "@tavi/contracts";
import type { StoreContext } from "./context.js";
import { storedLabelOf } from "./stored-values.js";

interface EffectRow {
  effect_key: string;
  task_id: string;
  admission_id: string;
  tool_id: string;
  inputs: string;
  inputs_hash: string;
  approval_id: string | null;
  state: string;
  receipt: string | null;
  label_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * External effect ledger.
 *
 * The intent is written **before** the effect is attempted, and the key derives
 * from stable identities. A replay therefore finds the existing row instead of
 * creating a second logical effect, and an interrupted attempt is visible as
 * `pending` rather than silently repeated.
 */
export class SqliteEffectRepository implements EffectRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  begin(input: {
    readonly effectKey: string;
    readonly taskId: string;
    readonly admissionId: string;
    readonly toolId: string;
    readonly inputs: unknown;
    readonly approvalId?: string | null;
    readonly now: () => string;
  }): { readonly effect: EffectRecord; readonly created: boolean } {
    return this.#store.transaction(() => {
      const existing = this.get(input.effectKey);
      if (existing !== undefined) {
        // A replay must resolve the same effect. Different content under one key
        // is a derivation bug, not something to paper over.
        if (existing.inputsHash !== hashEffectInputs(input.inputs)) {
          throw new TaviError("CONFLICT", `Effect ${input.effectKey} already exists with different normalized inputs`, {
            details: { effectKey: input.effectKey, toolId: input.toolId },
          });
        }
        return { effect: existing, created: false };
      }

      const now = input.now();
      const record: EffectRecord = {
        effectKey: input.effectKey,
        taskId: input.taskId,
        admissionId: input.admissionId,
        toolId: input.toolId,
        inputs: input.inputs ?? null,
        inputsHash: hashEffectInputs(input.inputs),
        approvalId: input.approvalId ?? null,
        state: "pending",
        receipt: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_effects
             (effect_key, task_id, admission_id, tool_id, inputs, inputs_hash, approval_id, state, receipt, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          record.effectKey,
          record.taskId,
          record.admissionId,
          record.toolId,
          JSON.stringify(record.inputs),
          record.inputsHash,
          record.approvalId,
          record.state,
          record.createdAt,
          record.updatedAt,
        );
      return { effect: record, created: true };
    });
  }

  resolve(input: {
    readonly effectKey: string;
    readonly state: EffectState;
    readonly receipt?: unknown;
    readonly label?: ContentLabel;
    readonly error?: string;
    readonly now: () => string;
  }): void {
    this.#store.transaction(() => {
      const existing = this.get(input.effectKey);
      if (existing === undefined) {
        throw new TaviError("NOT_FOUND", `Effect ${input.effectKey} was never begun`);
      }
      if (existing.state !== "pending" && existing.state !== "uncertain") {
        throw new TaviError("CONFLICT", `Effect ${input.effectKey} is already ${existing.state} and cannot be re-resolved`);
      }
      this.#store.handle
        .prepare("UPDATE tavi_effects SET state = ?, receipt = ?, label_json = ?, error = ?, updated_at = ? WHERE effect_key = ?")
        .run(
          input.state,
          input.receipt === undefined ? null : JSON.stringify(input.receipt),
          input.label === undefined ? null : JSON.stringify(input.label),
          input.error ?? null,
          input.now(),
          input.effectKey,
        );
    });
  }

  abandon(effectKey: string): boolean {
    return this.#store.handle.prepare("DELETE FROM tavi_effects WHERE effect_key = ? AND state = 'pending'").run(effectKey).changes > 0;
  }

  get(effectKey: string): EffectRecord | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_effects WHERE effect_key = ?").get(effectKey) as EffectRow | undefined;
    return row === undefined ? undefined : toEffectRecord(row);
  }

  listForTask(taskId: string): readonly EffectRecord[] {
    const rows = this.#store.handle.prepare("SELECT * FROM tavi_effects WHERE task_id = ? ORDER BY created_at").all(taskId) as EffectRow[];
    return rows.map(toEffectRecord);
  }

  listForTools(input: EffectActivityQuery): readonly EffectActivity[] {
    assertPositiveLimit(input.limit, "listForTools");
    if (input.prefixes.length === 0) return [];
    if (input.prefixes.some((prefix) => !prefix.endsWith("."))) throw new TaviError("INVALID_INPUT", "a tool prefix ends in a dot");
    // Each prefix is a range on `tavi_effects_tool_idx`; the workspace is its tasks'. `CROSS JOIN` keeps the
    // effects as the outer loop, so the page is read in order from the index rather than every task's gathered.
    const ranges = input.prefixes.map(() => "(e.tool_id >= ? AND e.tool_id < ?)").join(" OR ");
    const params: (string | number)[] = [input.workspaceId, ...input.prefixes.flatMap((prefix) => [prefix, toolPrefixEnd(prefix)])];
    let after = "";
    if (input.before !== undefined) {
      after = " AND (e.created_at < ? OR (e.created_at = ? AND e.effect_key < ?))";
      params.push(input.before.at, input.before.at, input.before.effectKey);
    }
    const rows = this.#store.handle
      .prepare(`SELECT e.effect_key, e.task_id, e.tool_id, e.state, e.created_at, COALESCE(NULLIF(trim(t.title_override), ''), t.title) AS generated_title, ${TASK_PROMPT_SQL("t")} AS prompt
        FROM tavi_effects e CROSS JOIN tavi_tasks t ON t.task_id = e.task_id
        WHERE t.workspace_id = ? AND (${ranges})${after}
        ORDER BY e.created_at DESC, e.effect_key DESC LIMIT ?`)
      .all(...params, input.limit) as {
      effect_key: string;
      task_id: string;
      tool_id: string;
      state: EffectState;
      created_at: string;
      generated_title: string | null;
      prompt: string | null;
    }[];
    return rows.map((row) => {
      // The chat's title as its other lists show it: the one it was given, else its prompt's first line.
      const taskTitle = displayTitleOf(row.generated_title, row.prompt);
      return {
        effectKey: row.effect_key,
        taskId: row.task_id,
        toolId: row.tool_id,
        state: row.state,
        createdAt: row.created_at,
        ...(taskTitle === undefined ? {} : { taskTitle }),
      };
    });
  }

  listUnresolved(limit: number): readonly EffectRecord[] {
    assertPositiveLimit(limit, "listUnresolved");
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_effects WHERE state IN ('pending', 'uncertain') ORDER BY updated_at LIMIT ?")
      .all(limit) as EffectRow[];
    return rows.map(toEffectRecord);
  }
}

function toEffectRecord(row: EffectRow): EffectRecord {
  return {
    effectKey: row.effect_key,
    taskId: row.task_id,
    admissionId: row.admission_id,
    toolId: row.tool_id,
    inputs: JSON.parse(row.inputs) as unknown,
    inputsHash: row.inputs_hash,
    approvalId: row.approval_id,
    state: row.state as EffectState,
    receipt: row.receipt === null ? null : (JSON.parse(row.receipt) as unknown),
    // A stored label that does not parse reads as untrusted from an unknown source: it only narrows.
    ...(row.label_json === null ? {} : { label: storedLabelOf(row.label_json) }),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Equality token for normalized effect or approval inputs.
 *
 * This is the canonical serialization, not a digest: it exists to compare two
 * values for equality across the durable repository, the in-memory fixtures and
 * the workflow adapter, so all three must compute it the same way. Storing the
 * canonical form also removes any temptation to compare differently in one place.
 */
