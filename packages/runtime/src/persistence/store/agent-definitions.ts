import type { AgentDefinitionRepositoryPort } from "../internal-contracts.js";
import { TaviError, type AgentDefinition, AgentDefinitionSchema, type CreateAgentDefinitionInput } from "@tavi/contracts";
import type { StoreContext } from "./context.js";
import { assertWritable, parseStoredRow, partitionReadable } from "./stored-values.js";

/**
 * Named agent definitions.
 *
 * `create` refuses a duplicate `(workspaceId, agentId)` rather than upserting:
 * an operator adding an agent that already exists has probably mistyped an id,
 * and silently replacing a persona would change how every task naming it
 * behaves. `update` is the deliberate path for changing one.
 */
export class SqliteAgentDefinitionRepository implements AgentDefinitionRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  create(input: CreateAgentDefinitionInput): AgentDefinition {
    const existing = this.#store.handle
      .prepare("SELECT agent_id FROM tavi_agent_definitions WHERE workspace_id = ? AND agent_id = ?")
      .get(input.workspaceId, input.agentId) as { readonly agent_id: string } | undefined;
    if (existing !== undefined) {
      throw new TaviError("CONFLICT", `Agent ${input.agentId} already exists in this workspace`, {
        details: { agentId: input.agentId },
      });
    }
    // Before the INSERT: the previous `this.get` read-back threw `INTERNAL` *after*
    // the row had committed, so a rejected definition stayed in the table.
    const definition = assertWritable(
      AgentDefinitionSchema,
      {
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        systemPrompt: input.systemPrompt,
        enabled: input.enabled ? 1 : 0,
        createdAt: input.now,
        updatedAt: input.now,
      },
      `Agent definition ${input.agentId}`,
    );
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_agent_definitions
           (agent_id, workspace_id, name, description, system_prompt, enabled, created_at, updated_at)
         VALUES (@agentId, @workspaceId, @name, @description, @systemPrompt, @enabled, @now, @now)`,
      )
      .run({
        agentId: definition.agentId,
        workspaceId: definition.workspaceId,
        name: definition.name,
        description: definition.description ?? null,
        systemPrompt: definition.systemPrompt,
        enabled: definition.enabled ? 1 : 0,
        now: input.now,
      });
    const created = this.get(input.workspaceId, input.agentId);
    if (created === undefined) {
      throw new TaviError("INTERNAL", `Agent ${input.agentId} vanished immediately after insert`);
    }
    return created;
  }

  get(workspaceId: string, agentId: string): AgentDefinition | undefined {
    const row = this.#store.handle
      .prepare("SELECT * FROM tavi_agent_definitions WHERE workspace_id = ? AND agent_id = ?")
      .get(workspaceId, agentId) as AgentDefinitionRow | undefined;
    return row === undefined ? undefined : toAgentDefinition(row);
  }

  list(workspaceId?: string): { readonly agents: readonly AgentDefinition[]; readonly unreadable: readonly string[] } {
    const rows = (
      workspaceId === undefined
        ? this.#store.handle.prepare("SELECT * FROM tavi_agent_definitions ORDER BY name").all()
        : this.#store.handle.prepare("SELECT * FROM tavi_agent_definitions WHERE workspace_id = ? ORDER BY name").all(workspaceId)
    ) as AgentDefinitionRow[];
    // Isolated per row, like `ScheduleRepository.listDue`: one unreadable row
    // must not hide every definition, and `unreadable` is how it stays visible
    // instead of silently disappearing from the list. The id is
    // workspace-qualified because this listing is cross-workspace when no
    // workspace was named, so a bare id could not say which row to repair.
    const partitioned = partitionReadable(rows, (row) => `${row.workspace_id}/${row.agent_id}`, toAgentDefinition);
    return { agents: partitioned.readable, unreadable: partitioned.unreadable };
  }

  remove(workspaceId: string, agentId: string): boolean {
    return (
      this.#store.handle.prepare("DELETE FROM tavi_agent_definitions WHERE workspace_id = ? AND agent_id = ?").run(workspaceId, agentId)
        .changes > 0
    );
  }

  update(input: {
    readonly workspaceId: string;
    readonly agentId: string;
    readonly name?: string;
    readonly description?: string | null;
    readonly systemPrompt?: string;
    readonly enabled?: boolean;
    readonly expectedUpdatedAt?: string;
    readonly now: string;
  }): boolean {
    // Validated before the UPDATE: without this `update` returned `true` for a
    // systemPrompt past the schema bound and left a row that `get` throws on and
    // `list` hides — a success report for a write that destroyed the record.
    assertWritable(
      AgentDefinitionSchema,
      {
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        name: input.name ?? "unused",
        ...(input.description === undefined || input.description === null ? {} : { description: input.description }),
        systemPrompt: input.systemPrompt ?? "unused",
        enabled: input.enabled === true ? 1 : 0,
        createdAt: input.now,
        updatedAt: input.now,
      },
      `Agent definition ${input.agentId}`,
    );
    return this.#store.transactionImmediate(() => this.#update(input));
  }

  #update(input: Parameters<AgentDefinitionRepositoryPort["update"]>[0]): boolean {
    const current = this.#store.handle
      .prepare("SELECT updated_at FROM tavi_agent_definitions WHERE workspace_id = ? AND agent_id = ?")
      .get(input.workspaceId, input.agentId) as { readonly updated_at: string } | undefined;
    if (current === undefined) return false;
    // The compare-and-set, under the immediate transaction that also holds the
    // write, so a racing writer cannot land between the check and the UPDATE.
    if (input.expectedUpdatedAt !== undefined && Date.parse(input.expectedUpdatedAt) !== Date.parse(current.updated_at)) {
      throw new TaviError("CONFLICT", `Agent ${input.agentId} changed since it was read; reload it and apply the edit again`, {
        details: { agentId: input.agentId, updatedAt: current.updated_at, expectedUpdatedAt: input.expectedUpdatedAt },
      });
    }
    // `updated_at` is the version a compare-and-set asserts, so it moves strictly
    // forward: a write in the same millisecond as the last (or under a clock
    // that stepped back) lands one millisecond past it rather than reusing it.
    const previous = Date.parse(current.updated_at);
    const requested = Date.parse(input.now);
    const now = Number.isNaN(previous) || requested > previous ? input.now : new Date(previous + 1).toISOString();
    // Built column by column rather than read-merge-write, so an operator
    // editing one field cannot clobber a concurrent edit to another.
    const sets: string[] = ["updated_at = @now"];
    const params: Record<string, unknown> = { workspaceId: input.workspaceId, agentId: input.agentId, now };
    if (input.name !== undefined) {
      sets.push("name = @name");
      params["name"] = input.name;
    }
    if (input.description !== undefined) {
      // `null` clears it; `undefined` means "not supplied" — the one field where
      // those differ, as in `ScheduleRepositoryPort.update`.
      sets.push("description = @description");
      params["description"] = input.description;
    }
    if (input.systemPrompt !== undefined) {
      sets.push("system_prompt = @systemPrompt");
      params["systemPrompt"] = input.systemPrompt;
    }
    if (input.enabled !== undefined) {
      sets.push("enabled = @enabled");
      params["enabled"] = input.enabled ? 1 : 0;
    }
    const result = this.#store.handle
      .prepare(`UPDATE tavi_agent_definitions SET ${sets.join(", ")} WHERE workspace_id = @workspaceId AND agent_id = @agentId`)
      .run(params);
    return result.changes > 0;
  }
}

interface AgentDefinitionRow {
  readonly agent_id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly system_prompt: string;
  readonly enabled: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function toAgentDefinition(row: AgentDefinitionRow): AgentDefinition {
  // Validated on the way out, like the schedule and project rows. Without this an
  // id violating the documented pattern, or an unbounded `systemPrompt`, became
  // the persona prepended to every model call of every turn of every task naming
  // it.
  return parseStoredRow(
    AgentDefinitionSchema,
    {
      agentId: row.agent_id,
      workspaceId: row.workspace_id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      systemPrompt: row.system_prompt,
      enabled: row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    `agent definition ${row.agent_id}`,
  );
}
