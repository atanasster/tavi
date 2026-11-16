import type { ToolPolicyRepositoryPort } from "./internal-contracts.js";
import {
  OWNER_WIDE_RULE_PREFIX,
  GateObservationSchema,
  SessionGrantSchema,
  TaviError,
  ToolRuleSchema,
  type GateObservation,
  type GateObservationSummary,
  type SessionGrant,
  type ToolRule,
} from "@tavi/contracts";

import type { Database } from "./sqlite-loader.js";
import { stmt } from "./statement-cache.js";

interface RuleRow {
  readonly rule_json: string;
}

/** A row that no longer parses is skipped, never thrown from a list: one bad rule must not cost the gate every other rule. */
function readAll<Value>(rows: readonly { readonly json: string }[], parse: (value: unknown) => Value): Value[] {
  const values: Value[] = [];
  for (const row of rows) {
    try {
      values.push(parse(JSON.parse(row.json)));
    } catch {
      // Unreadable rows are left in place for `doctor`-style inspection.
    }
  }
  return values;
}

/** Operator tool rules and per-task session grants. */
export class SqliteToolPolicyRepository implements ToolPolicyRepositoryPort {
  readonly #db: () => Database;

  constructor(db: () => Database) {
    this.#db = db;
  }

  /** The workspace's rules, and the owner-wide ones a Connected apps page stored at `*`. */
  listRules(workspaceId: string): readonly ToolRule[] {
    const rows = stmt(
      this.#db(),
      "SELECT rule_json AS json FROM tavi_tool_rules WHERE workspace_id IN (?, '*') ORDER BY created_at, rule_id",
    ).all(workspaceId) as { json: string }[];
    return readAll(rows, (value) => ToolRuleSchema.parse(value));
  }

  getRule(workspaceId: string, ruleId: string): ToolRule | undefined {
    const row = stmt(this.#db(), "SELECT rule_json FROM tavi_tool_rules WHERE workspace_id IN (?, '*') AND rule_id = ?").get(
      workspaceId,
      ruleId,
    ) as RuleRow | undefined;
    if (row === undefined) return undefined;
    const parsed = ToolRuleSchema.safeParse(JSON.parse(row.rule_json));
    return parsed.success ? parsed.data : undefined;
  }

  putRule(rule: ToolRule): ToolRule {
    const parsed = ToolRuleSchema.safeParse(rule);
    if (!parsed.success) {
      throw new TaviError("INVALID_INPUT", "Invalid tool rule", { details: { issues: parsed.error.issues.map((issue) => issue.message) } });
    }
    // Shipped rules live in code, and a flag rule lives for one owner's
    // lifetime: neither is ever a row.
    if (parsed.data.source !== "operator") throw new TaviError("INVALID_INPUT", `A ${parsed.data.source} rule is not stored`);
    // Only a Connected apps page's own rule is owner-wide, as apps are; every other rule names its workspace.
    if (parsed.data.workspaceId === "*" && !parsed.data.ruleId.startsWith(OWNER_WIDE_RULE_PREFIX))
      throw new TaviError("INVALID_INPUT", "A stored rule names its workspace");
    // The page's rules only ever tighten: an owner-wide allow is refused here too.
    if (parsed.data.workspaceId === "*" && parsed.data.decision === "allow")
      throw new TaviError("INVALID_INPUT", "An owner-wide rule cannot allow");
    stmt(
      this.#db(),
      `INSERT INTO tavi_tool_rules (workspace_id, rule_id, tool_pattern, decision, rule_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, rule_id) DO UPDATE SET
           tool_pattern = excluded.tool_pattern, decision = excluded.decision, rule_json = excluded.rule_json`,
    ).run(
      parsed.data.workspaceId,
      parsed.data.ruleId,
      parsed.data.toolPattern,
      parsed.data.decision,
      JSON.stringify(parsed.data),
      parsed.data.createdAt,
    );
    return parsed.data;
  }

  seedRule(rule: ToolRule, at: string): boolean {
    const db = this.#db();
    return db
      .transaction(() => {
        // The seed is recorded whether or not the rule is still there later, so a
        // rule the operator revoked is never put back.
        const seeded =
          stmt(db, "INSERT INTO tavi_tool_rule_seeds (workspace_id, rule_id, seeded_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(
            rule.workspaceId,
            rule.ruleId,
            at,
          ).changes > 0;
        if (seeded) this.putRule(rule);
        return seeded;
      })
      .immediate();
  }

  deleteRule(workspaceId: string, ruleId: string): boolean {
    return (
      stmt(this.#db(), "DELETE FROM tavi_tool_rules WHERE workspace_id IN (?, '*') AND rule_id = ?").run(workspaceId, ruleId).changes > 0
    );
  }

  listSessionGrants(taskId: string): readonly SessionGrant[] {
    const rows = stmt(this.#db(), "SELECT grant_json AS json FROM tavi_session_grants WHERE task_id = ? ORDER BY created_at, grant_id").all(
      taskId,
    ) as { json: string }[];
    return readAll(rows, (value) => SessionGrantSchema.parse(value));
  }

  listSessionGrantsForWorkspace(workspaceId: string): readonly SessionGrant[] {
    const rows = stmt(
      this.#db(),
      "SELECT grant_json AS json FROM tavi_session_grants WHERE workspace_id = ? ORDER BY created_at, grant_id",
    ).all(workspaceId) as { json: string }[];
    return readAll(rows, (value) => SessionGrantSchema.parse(value));
  }

  addSessionGrant(grant: SessionGrant): SessionGrant {
    const parsed = SessionGrantSchema.safeParse(grant);
    if (!parsed.success) {
      throw new TaviError("INVALID_INPUT", "Invalid session grant", {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }
    // Idempotent on the grant id: a resumed node that re-applies its decision
    // writes the same grant again.
    stmt(
      this.#db(),
      `INSERT INTO tavi_session_grants (grant_id, task_id, workspace_id, tool_id, grant_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (grant_id) DO NOTHING`,
    ).run(
      parsed.data.grantId,
      parsed.data.taskId,
      parsed.data.workspaceId,
      parsed.data.toolId,
      JSON.stringify(parsed.data),
      parsed.data.createdAt,
    );
    return parsed.data;
  }

  revokeSessionGrant(workspaceId: string, grantId: string): boolean {
    return (
      stmt(this.#db(), "DELETE FROM tavi_session_grants WHERE workspace_id = ? AND grant_id = ?").run(workspaceId, grantId).changes > 0
    );
  }

  clearSessionGrants(taskId: string): number {
    return stmt(this.#db(), "DELETE FROM tavi_session_grants WHERE task_id = ?").run(taskId).changes;
  }

  deleteSessionGrantsForTools(toolIds: readonly string[]): number {
    const statement = stmt(this.#db(), "DELETE FROM tavi_session_grants WHERE tool_id = ?");
    let removed = 0;
    for (const toolId of new Set(toolIds)) removed += statement.run(toolId).changes;
    return removed;
  }

  clearTreeSessionGrants(workspaceId: string, rootTaskId: string): number {
    return stmt(
      this.#db(),
      `DELETE FROM tavi_session_grants
          WHERE task_id IN (SELECT worker_task_id FROM tavi_agent_delegation_admissions WHERE workspace_id = ? AND root_task_id = ?)`,
    ).run(workspaceId, rootTaskId).changes;
  }

  deleteExpiredSessionGrants(at: string): number {
    // `expiresAt` is an ISO instant in the grant's JSON, written as the clock or a caller wrote it. Both sides are
    // compared as `observationInstant`'s text (UTC, milliseconds, `Z`), so one written with an offset or without
    // milliseconds still lapses at its instant. Text that is not an instant lapses nothing, on either side.
    if (Number.isNaN(Date.parse(at))) return 0;
    return stmt(
      this.#db(),
      "DELETE FROM tavi_session_grants WHERE strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(grant_json, '$.expiresAt')) <= ?",
    ).run(observationInstant(at)).changes;
  }

  recordGateObservation(observation: GateObservation): boolean {
    const parsed = GateObservationSchema.safeParse(observation);
    if (!parsed.success) {
      throw new TaviError("INVALID_INPUT", "Invalid gate observation", {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }
    const row = parsed.data;
    return (
      stmt(
        this.#db(),
        `INSERT INTO tavi_gate_observations (task_id, call_id, tool_id, effect, sink, decision_enforced, decision_observed, gate_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (task_id, call_id) DO NOTHING`,
      ).run(
        row.taskId,
        row.callId,
        row.toolId,
        row.effect,
        row.sink ?? null,
        row.decisionEnforced,
        row.decisionObserved,
        row.gateReason,
        observationInstant(row.createdAt),
      ).changes > 0
    );
  }

  deleteGateObservationsBefore(at: string): number {
    return stmt(this.#db(), "DELETE FROM tavi_gate_observations WHERE created_at < ?").run(observationInstant(at)).changes;
  }

  summarizeGateObservations(since: string, top: number): GateObservationSummary {
    const db = this.#db();
    const totals = stmt(
      db,
      `SELECT COUNT(*) AS calls, COUNT(DISTINCT task_id) AS tasks, COALESCE(SUM(decision_enforced = 'allow'), 0) AS unasked
           FROM tavi_gate_observations WHERE created_at >= ?`,
    ).get(observationInstant(since)) as { calls: number; tasks: number; unasked: number };
    const topTools = stmt(
      db,
      `SELECT tool_id AS toolId, COUNT(*) AS calls FROM tavi_gate_observations
          WHERE created_at >= ? GROUP BY tool_id ORDER BY calls DESC, tool_id LIMIT ?`,
    ).all(observationInstant(since), Math.max(0, Math.trunc(top))) as { toolId: string; calls: number }[];
    return { calls: totals.calls, tasks: totals.tasks, unasked: totals.unasked, topTools };
  }
}

/**
 * `tavi_gate_observations.created_at` and the bounds compared against it, both
 * written as the clock writes it (`toISOString()`), so the column compares as
 * text and its index serves the range. Text that is not an instant passes
 * through unchanged.
 */
function observationInstant(at: string): string {
  const time = Date.parse(at);
  return Number.isNaN(time) ? at : new Date(time).toISOString();
}
