import type { AgentWaitRepositoryPort } from "../internal-contracts.js";
import {
  AgentWaitIntentRecordSchema,
  type AgentWaitIntentRecord,
  type AskUserChoices,
  type BrowserHandoff,
  type AgentWaitOutcome,
  type ConnectRequest,
  wireEnvelope,
} from "@tavi/contracts";
import type { StoreContext } from "./context.js";
import { parseJsonColumn, parseStoredRow } from "./stored-values.js";

export class SqliteAgentWaitRepository implements AgentWaitRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  prepare(input: {
    readonly waitId: string;
    readonly taskId: string;
    readonly correlationId?: string;
    readonly waitingOnWorkerTaskId?: string;
    readonly deadlineAt: string;
    readonly choices?: AskUserChoices;
    readonly question?: string;
    readonly handoff?: BrowserHandoff;
    readonly connect?: ConnectRequest;
  }): void {
    // `ON CONFLICT ... DO NOTHING`, not a plain INSERT: a LangGraph node
    // that calls `interrupt()` is expected to replay from its top on a
    // resume, so a caller that deterministically re-derives the same
    // `waitId` (workflow.ts derives it from checkpointed
    // `runId`+`callId`) must be able to call `prepare` again as a safe
    // no-op rather than hit a duplicate-primary-key error.
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_agent_wait_intents
           (wait_id, task_id, correlation_id, waiting_on_worker_task_id, deadline_at, state, choices_json, question, handoff_json, connect_json)
         VALUES (@waitId, @taskId, @correlationId, @waitingOnWorkerTaskId, @deadlineAt, 'prepared', @choicesJson, @question, @handoffJson, @connectJson)
         ON CONFLICT (wait_id) DO NOTHING`,
      )
      .run({
        waitId: input.waitId,
        taskId: input.taskId,
        correlationId: input.correlationId ?? null,
        waitingOnWorkerTaskId: input.waitingOnWorkerTaskId ?? null,
        deadlineAt: input.deadlineAt,
        choicesJson: input.choices === undefined ? null : JSON.stringify(input.choices),
        question: input.question ?? null,
        handoffJson: input.handoff === undefined ? null : JSON.stringify(input.handoff),
        connectJson: input.connect === undefined ? null : JSON.stringify(input.connect),
      });
  }

  activate(waitId: string): void {
    this.#store.handle.prepare("UPDATE tavi_agent_wait_intents SET state = 'active' WHERE wait_id = ? AND state = 'prepared'").run(waitId);
  }

  get(waitId: string): AgentWaitIntentRecord | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_agent_wait_intents WHERE wait_id = ?").get(waitId) as
      | AgentWaitIntentRow
      | undefined;
    return row === undefined ? undefined : toAgentWaitIntentRecord(row);
  }

  settle(input: {
    readonly waitId: string;
    readonly outcome: AgentWaitOutcome;
    readonly resume?: boolean;
    readonly by?: string;
    readonly via?: string;
  }): boolean {
    const result = this.#store.handle
      .prepare(
        // `settled_at` dates the answer in the approvals
        // history; the database's clock, since no caller passes one here.
        `UPDATE tavi_agent_wait_intents
            SET state = 'settled', settled_outcome_json = ?, settled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), resume_pending = ?,
                settled_by = ?, settled_via = ?
          WHERE wait_id = ? AND state = 'active'`,
      )
      .run(
        JSON.stringify(input.outcome),
        input.resume === true ? 1 : 0,
        input.by?.slice(0, 128) ?? null,
        input.via?.slice(0, 128) ?? null,
        input.waitId,
      );
    return result.changes > 0;
  }

  markResumed(waitId: string): void {
    this.#store.handle.prepare("UPDATE tavi_agent_wait_intents SET resume_pending = 0 WHERE wait_id = ?").run(waitId);
  }

  listPendingResumes(settledBefore: string): readonly AgentWaitIntentRecord[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_agent_wait_intents WHERE resume_pending = 1 AND state = 'settled' AND settled_at <= ?")
      .all(settledBefore) as AgentWaitIntentRow[];
    return rows.map(toAgentWaitIntentRecord);
  }

  listActivePastDeadline(now: string): readonly AgentWaitIntentRecord[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_agent_wait_intents WHERE state = 'active' AND deadline_at <= ?")
      .all(now) as AgentWaitIntentRow[];
    return rows.map(toAgentWaitIntentRecord);
  }

  getActiveByCorrelation(taskId: string, correlationId: string): AgentWaitIntentRecord | undefined {
    const row = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_agent_wait_intents
          WHERE task_id = ? AND correlation_id = ? AND state = 'active'`,
      )
      .get(taskId, correlationId) as AgentWaitIntentRow | undefined;
    return row === undefined ? undefined : toAgentWaitIntentRecord(row);
  }

  getActiveByTask(taskId: string): AgentWaitIntentRecord | undefined {
    const row = this.#store.handle.prepare(`SELECT * FROM tavi_agent_wait_intents WHERE task_id = ? AND state = 'active'`).get(taskId) as
      | AgentWaitIntentRow
      | undefined;
    return row === undefined ? undefined : toAgentWaitIntentRecord(row);
  }

  listActiveHandoffs(): readonly AgentWaitIntentRecord[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_agent_wait_intents WHERE state = 'active' AND handoff_json IS NOT NULL")
      .all() as AgentWaitIntentRow[];
    return rows.map(toAgentWaitIntentRecord);
  }

  listActiveConnects(): readonly AgentWaitIntentRecord[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_agent_wait_intents WHERE state = 'active' AND connect_json IS NOT NULL")
      .all() as AgentWaitIntentRow[];
    return rows.map(toAgentWaitIntentRecord);
  }

  getRecentlySettledByTask(taskId: string, settledSince: string): AgentWaitIntentRecord | undefined {
    const row = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_agent_wait_intents WHERE task_id = ? AND state = 'settled' AND settled_at >= ? ORDER BY settled_at DESC LIMIT 1`,
      )
      .get(taskId, settledSince) as AgentWaitIntentRow | undefined;
    return row === undefined ? undefined : toAgentWaitIntentRecord(row);
  }
}

interface AgentWaitIntentRow {
  readonly wait_id: string;
  readonly task_id: string;
  readonly correlation_id: string | null;
  readonly waiting_on_worker_task_id: string | null;
  readonly deadline_at: string;
  readonly state: string;
  readonly settled_outcome_json: string | null;
  readonly choices_json: string | null;
  readonly handoff_json: string | null;
  readonly connect_json: string | null;
}

function toAgentWaitIntentRecord(row: AgentWaitIntentRow): AgentWaitIntentRecord {
  // The whole object — including a parsed `settledOutcome` — goes through
  // `parseStoredRow` so a corrupted or schema-drifted `state`/
  // `settled_outcome_json` throws a typed error at the read site, the same
  // guarantee `toAgentMailboxEnvelopeRecord` already gives mailbox rows,
  // rather than an unchecked cast trusting the column's shape.
  return parseStoredRow<AgentWaitIntentRecord>(
    AgentWaitIntentRecordSchema,
    {
      waitId: row.wait_id,
      taskId: row.task_id,
      deadlineAt: row.deadline_at,
      state: row.state,
      ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
      ...(row.waiting_on_worker_task_id === null ? {} : { waitingOnWorkerTaskId: row.waiting_on_worker_task_id }),
      ...(row.settled_outcome_json === null
        ? {}
        : { settledOutcome: wireSettledOutcome(parseJsonColumn<unknown>(row.settled_outcome_json, "settled wait outcome")) }),
      ...(row.choices_json === null ? {} : { choices: parseJsonColumn<unknown>(row.choices_json, "wait choices") }),
      ...(row.handoff_json === null ? {} : { handoff: parseJsonColumn<unknown>(row.handoff_json, "wait handoff") }),
      ...(row.connect_json === null ? {} : { connect: parseJsonColumn<unknown>(row.connect_json, "wait connect") }),
    },
    "agent wait intent",
  );
}

/**
 * A settled outcome as the schema reads it. Rows settled by a peer's envelope
 * before `wireEnvelope` existed stored the mailbox record — its delivery and
 * retention bookkeeping included — and the strict schema refused them, so the
 * wait could not be read back at all (a replay of the wait's node reads it).
 */
function wireSettledOutcome(outcome: unknown): unknown {
  if (typeof outcome !== "object" || outcome === null || !("envelope" in outcome)) return outcome;
  const { envelope } = outcome as { readonly envelope: unknown };
  if (typeof envelope !== "object" || envelope === null) return outcome;
  return { ...outcome, envelope: wireEnvelope(envelope as Parameters<typeof wireEnvelope>[0]) };
}
