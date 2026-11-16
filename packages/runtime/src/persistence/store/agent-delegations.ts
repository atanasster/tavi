import type { AgentDelegationRepositoryPort } from "../internal-contracts.js";
import { AgentDelegationAdmissionRecordSchema, type AgentDelegatedBudget, type AgentDelegationAdmissionRecord } from "@tavi/contracts";
import type { StoreContext } from "./context.js";
import { parseJsonColumn, parseStoredRow } from "./stored-values.js";

export class SqliteAgentDelegationRepository implements AgentDelegationRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  recordSpawn(record: AgentDelegationAdmissionRecord): void {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_agent_delegation_admissions
           (workspace_id, principal_id, operation_key, worker_task_id, worker_agent_id, created_at,
            shared_memory_record_ids, agent_definition_id, depth, budget, parent_task_id, root_task_id, held_channel, front_end, held_connection_id)
         VALUES (@workspaceId, @principalId, @operationKey, @workerTaskId, @workerAgentId, @createdAt,
            @sharedMemoryRecordIds, @agentDefinitionId, @depth, @budget, @parentTaskId, @rootTaskId, @heldChannel, @frontEnd, @heldConnectionId)`,
      )
      .run({
        ...record,
        sharedMemoryRecordIds: record.sharedMemoryRecordIds === undefined ? null : JSON.stringify(record.sharedMemoryRecordIds),
        agentDefinitionId: record.agentDefinitionId ?? null,
        budget: record.budget === undefined ? null : JSON.stringify(record.budget),
        parentTaskId: record.parentTaskId ?? null,
        rootTaskId: record.rootTaskId ?? null,
        heldChannel: record.heldChannel ?? null,
        frontEnd: record.frontEnd ?? null,
        heldConnectionId: record.heldConnectionId ?? null,
      });
  }

  listChildren(workspaceId: string, parentTaskId: string, limit: number): readonly AgentDelegationAdmissionRecord[] {
    const bound = Number.isFinite(limit) ? Math.max(1, Math.min(201, Math.floor(limit))) : 201;
    const rows = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_agent_delegation_admissions WHERE workspace_id = ? AND parent_task_id = ? ORDER BY worker_task_id LIMIT ?`,
      )
      .all(workspaceId, parentTaskId, bound) as AgentDelegationAdmissionRow[];
    return rows.map(parseAgentDelegationAdmissionRow);
  }

  countRunningInTree(workspaceId: string, rootTaskId: string): number {
    // A row written before roots were recorded is counted as its root's direct child only.
    const row = this.#store.handle
      .prepare(
        `SELECT COUNT(*) AS running FROM tavi_agent_delegation_admissions d
           JOIN tavi_tasks t ON t.task_id = d.worker_task_id
          WHERE d.workspace_id = ?
            AND (d.root_task_id = ? OR (d.root_task_id IS NULL AND d.parent_task_id = ?))
            AND t.status NOT IN ('completed', 'failed', 'stopped', 'cancelled')`,
      )
      .get(workspaceId, rootTaskId, rootTaskId) as { running: number };
    return row.running;
  }

  listRunningInTree(
    workspaceId: string,
    rootTaskId: string,
    limit: number,
  ): readonly { readonly workerTaskId: string; readonly agentDefinitionId?: string; readonly status: string }[] {
    const rows = this.#store.handle
      .prepare(
        `SELECT d.worker_task_id, d.agent_definition_id, t.status FROM tavi_agent_delegation_admissions d
           JOIN tavi_tasks t ON t.task_id = d.worker_task_id
          WHERE d.workspace_id = ?
            AND (d.root_task_id = ? OR (d.root_task_id IS NULL AND d.parent_task_id = ?))
            AND t.status NOT IN ('completed', 'failed', 'stopped', 'cancelled')
          ORDER BY d.created_at ASC, d.rowid ASC LIMIT ?`,
      )
      .all(workspaceId, rootTaskId, rootTaskId, Math.max(1, Math.min(limit, 200))) as {
      readonly worker_task_id: string;
      readonly agent_definition_id: string | null;
      readonly status: string;
    }[];
    return rows.map((row) => ({
      workerTaskId: row.worker_task_id,
      ...(row.agent_definition_id === null ? {} : { agentDefinitionId: row.agent_definition_id }),
      status: row.status,
    }));
  }

  listUnannouncedEnded(since: string, limit: number): readonly string[] {
    // The result envelope's id is the worker's last admission, as
    // `listAdmissions` orders them: creation time, the row breaking a tie.
    const rows = this.#store.handle
      .prepare(
        `SELECT d.worker_task_id FROM tavi_agent_delegation_admissions d
           JOIN tavi_tasks t ON t.task_id = d.worker_task_id
          WHERE d.parent_task_id IS NOT NULL
            -- A parent not admitted (yet, or ever: a routine whose research failed) has no mailbox to tell.
            AND EXISTS (SELECT 1 FROM tavi_tasks p WHERE p.task_id = d.parent_task_id)
            AND t.status IN ('completed', 'failed', 'stopped')
            AND t.updated_at >= ?
            AND NOT EXISTS (
              SELECT 1 FROM tavi_agent_mailbox m
               WHERE m.message_id = 'worker-result-' || COALESCE(
                 (SELECT a.admission_id FROM tavi_admissions a WHERE a.task_id = d.worker_task_id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1),
                 d.worker_task_id))
          ORDER BY t.updated_at ASC LIMIT ?`,
      )
      .all(since, Math.max(1, Math.min(limit, 500))) as { readonly worker_task_id: string }[];
    return rows.map((row) => row.worker_task_id);
  }

  getByOperationKey(workspaceId: string, principalId: string, operationKey: string): AgentDelegationAdmissionRecord | undefined {
    const row = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_agent_delegation_admissions
          WHERE workspace_id = ? AND principal_id = ? AND operation_key = ?`,
      )
      .get(workspaceId, principalId, operationKey) as AgentDelegationAdmissionRow | undefined;
    return row === undefined ? undefined : parseAgentDelegationAdmissionRow(row);
  }

  getByWorkerTaskId(workerTaskId: string): AgentDelegationAdmissionRecord | undefined {
    const row = this.#store.handle.prepare(`SELECT * FROM tavi_agent_delegation_admissions WHERE worker_task_id = ?`).get(workerTaskId) as
      | AgentDelegationAdmissionRow
      | undefined;
    return row === undefined ? undefined : parseAgentDelegationAdmissionRow(row);
  }
}

function parseAgentDelegationAdmissionRow(row: AgentDelegationAdmissionRow): AgentDelegationAdmissionRecord {
  return parseStoredRow<AgentDelegationAdmissionRecord>(
    AgentDelegationAdmissionRecordSchema,
    {
      operationKey: row.operation_key,
      workspaceId: row.workspace_id,
      principalId: row.principal_id,
      workerTaskId: row.worker_task_id,
      workerAgentId: row.worker_agent_id,
      ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
      ...(row.root_task_id === null ? {} : { rootTaskId: row.root_task_id }),
      createdAt: row.created_at,
      depth: row.depth,
      ...(row.shared_memory_record_ids === null
        ? {}
        : { sharedMemoryRecordIds: parseJsonColumn<readonly string[]>(row.shared_memory_record_ids, "shared memory record ids") }),
      ...(row.agent_definition_id === null ? {} : { agentDefinitionId: row.agent_definition_id }),
      ...(row.budget === null ? {} : { budget: parseJsonColumn<AgentDelegatedBudget>(row.budget, "agent delegation budget") }),
      ...(row.held_channel === null ? {} : { heldChannel: row.held_channel }),
      ...(row.front_end === null ? {} : { frontEnd: row.front_end }),
      ...(row.held_connection_id === null ? {} : { heldConnectionId: row.held_connection_id }),
    },
    "agent delegation admission",
  );
}

interface AgentDelegationAdmissionRow {
  readonly parent_task_id: string | null;
  readonly root_task_id: string | null;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly operation_key: string;
  readonly worker_task_id: string;
  readonly worker_agent_id: string;
  readonly created_at: string;
  readonly shared_memory_record_ids: string | null;
  readonly agent_definition_id: string | null;
  readonly depth: number;
  readonly budget: string | null;
  /** The channel the delegating turn held, carried down to the worker. */
  readonly held_channel: string | null;
  readonly front_end: string | null;
  readonly held_connection_id: string | null;
}
