import { ModelAccounting } from "../persistence/model-accounting.js";
import type { RouterRepositoryPort } from "../persistence/internal-contracts.js";
import {
  RouterConfigurationSchema,
  RouterFenceSchema,
  RouterReceiptSchema,
  RouterScopeSchema,
  RouterSettingsSchema,
  TaskRouteSchema,
  ModelTargetSchema,
  ToolDisclosureSchema,
  ContextProjectionSnapshotSchema,
  type ContextProjectionSnapshot,
  TaviError,
  type RouterConfiguration,
  type RouterFence,
  type RouterReceipt,
  type RouterScope,
  type RouterSettings,
  type ChosenModelTarget,
  type ModelTarget,
  type TaskRoute,
  type ToolDisclosure,
} from "@tavi/contracts";
import type { SqliteStore } from "../persistence/store.js";

/** Scoped router state using the same task authority and generation fence as workflow execution. */
export class RouterRepository implements RouterRepositoryPort {
  private readonly store: SqliteStore;
  private readonly authorized: (scope: RouterScope) => boolean;

  constructor(store: SqliteStore, authorized: (scope: RouterScope) => boolean) {
    this.store = store;
    this.authorized = authorized;
  }

  private assertScope(scope: RouterScope): void {
    RouterScopeSchema.parse(scope);
    if (!this.authorized(scope)) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
  }

  private assertTask(scope: RouterScope, taskId: string): void {
    this.assertScope(scope);
    const task = this.store.getTask(taskId);
    if (task === undefined || task.workspaceId !== scope.workspaceId || task.principalId !== scope.principalId)
      throw new TaviError("NOT_AUTHORIZED", "Router task is outside this scope");
  }

  private assertFence(scope: RouterScope, fence: RouterFence): void {
    RouterFenceSchema.parse(fence);
    this.assertTask(scope, fence.taskId);
    this.store.asPort().repositories.executions.assertCurrentGeneration(fence.taskId, fence.generation, fence.ownerSession);
  }

  configuration(scope: RouterScope): RouterConfiguration {
    this.assertScope(scope);
    const row = this.store.handle
      .prepare(
        "SELECT revision, data FROM tavi_router_configurations WHERE workspace_id=? AND principal_id=? ORDER BY revision DESC LIMIT 1",
      )
      .get(scope.workspaceId, scope.principalId) as { revision: number; data: string } | undefined;
    return row === undefined
      ? { revision: 0, settings: RouterSettingsSchema.parse({}) }
      : RouterConfigurationSchema.parse({ revision: row.revision, settings: JSON.parse(row.data) });
  }

  /** Each scope's latest configuration: which provider it selects, and whether routing is on. For diagnostics. */
  selections(): readonly {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly provider: string;
    readonly enabled: boolean;
    readonly priceRevision?: string;
  }[] {
    const rows = this.store.handle
      .prepare(
        "SELECT workspace_id, principal_id, data FROM tavi_router_configurations AS c WHERE revision=(SELECT MAX(revision) FROM tavi_router_configurations WHERE workspace_id=c.workspace_id AND principal_id=c.principal_id) ORDER BY workspace_id, principal_id",
      )
      .all() as { workspace_id: string; principal_id: string; data: string }[];
    return rows.map((row) => {
      const settings = RouterSettingsSchema.parse(JSON.parse(row.data));
      return {
        workspaceId: row.workspace_id,
        principalId: row.principal_id,
        provider: settings.provider,
        enabled: settings.enabled,
        ...(settings.priceRevision === undefined ? {} : { priceRevision: settings.priceRevision }),
      };
    });
  }

  configureWithPrices(
    scope: RouterScope,
    input: RouterSettings,
    expectedRevision: number,
    prices: readonly import("@tavi/contracts").ModelPriceSheet[],
  ): RouterConfiguration {
    return this.store.transactionImmediate(() => {
      const result = this.configure(scope, input, expectedRevision);
      const accounting = new ModelAccounting(this.store.handle);
      for (const price of prices) accounting.putPrice(price);
      return result;
    });
  }
  configure(scope: RouterScope, input: RouterSettings, expectedRevision: number): RouterConfiguration {
    const settings = RouterSettingsSchema.parse(input);
    return this.store.handle.transaction(() => {
      const current = this.configuration(scope);
      if (current.revision !== expectedRevision)
        throw new TaviError(
          "REVISION_CONFLICT",
          `The router configuration changed: revision ${expectedRevision} is stale, it is now at revision ${current.revision}; ` +
            "read it with `tavi router status` and try again",
          { details: { expectedRevision, currentRevision: current.revision } },
        );
      const revision = current.revision + 1;
      this.store.handle
        .prepare("INSERT INTO tavi_router_configurations VALUES (?, ?, ?, ?)")
        .run(scope.workspaceId, scope.principalId, revision, JSON.stringify(settings));
      return { revision, settings };
    })();
  }

  decision(scope: RouterScope, taskId: string, operationId: string): RouterReceipt | undefined {
    this.assertTask(scope, taskId);
    const row = this.store.handle
      .prepare("SELECT data FROM tavi_router_decisions WHERE task_id=? AND operation_id=?")
      .get(taskId, operationId) as { data: string } | undefined;
    return row === undefined ? undefined : RouterReceiptSchema.parse(JSON.parse(row.data));
  }

  reserve(scope: RouterScope, fence: RouterFence, input: RouterReceipt, maximumUsd: number): boolean {
    const receipt = RouterReceiptSchema.parse(input);
    if (
      receipt.state !== "pending" ||
      receipt.taskId !== fence.taskId ||
      !Number.isFinite(maximumUsd) ||
      maximumUsd < 0 ||
      maximumUsd > 1_000_000
    )
      throw new TaviError("INVALID_INPUT", "Invalid router reservation");
    const micros = Math.ceil(maximumUsd * 1_000_000);
    return this.store.handle.transaction(() => {
      this.assertFence(scope, fence);
      if (this.decision(scope, fence.taskId, receipt.operationId) !== undefined) return false;
      const config = this.configuration(scope);
      if (
        receipt.configRevision !== config.revision ||
        receipt.mode !== config.settings.modes[receipt.feature] ||
        receipt.policyVersion !== config.settings.policyVersion
      )
        return false;
      if (receipt.callId !== undefined) {
        if (!config.settings.enabled || config.settings.modes[receipt.feature] === "off") return false;
        // Each call counts against the task. Against the turn, calls sharing a
        // group (one turn's surfaces, asked separately) count once.
        const counts = this.store.handle
          .prepare(
            "SELECT COUNT(*) AS total, COUNT(DISTINCT CASE WHEN turn_id=? THEN COALESCE(json_extract(data, '$.batchDecisionId'), operation_id) END) AS turn, COALESCE(SUM(CASE WHEN turn_id=? AND json_extract(data, '$.batchDecisionId')=? THEN 1 ELSE 0 END),0) AS grouped FROM tavi_router_decisions WHERE task_id=? AND json_extract(data, '$.callId') IS NOT NULL",
          )
          .get(receipt.turnId, receipt.turnId, receipt.batchDecisionId ?? null, fence.taskId) as {
          total: number;
          turn: number;
          grouped: number;
        };
        if (counts.total >= config.settings.callsPerTask || (counts.grouped === 0 && counts.turn >= config.settings.callsPerTurn))
          return false;
        if (
          this.micros(scope, fence.taskId) + micros > Math.floor(config.settings.maxTaskUsd * 1_000_000) ||
          this.micros(scope, "") + micros > this.workspaceLimit(scope)
        )
          return false;
      }
      this.store.handle
        .prepare("INSERT INTO tavi_router_decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          fence.taskId,
          receipt.operationId,
          receipt.turnId,
          fence.ownerSession,
          fence.generation,
          micros,
          micros,
          JSON.stringify(receipt),
        );
      this.adjust(scope, fence.taskId, micros);
      return true;
    })();
  }

  finish(scope: RouterScope, fence: RouterFence, input: RouterReceipt, actualUsd?: number): void {
    const receipt = RouterReceiptSchema.parse(input);
    if (
      receipt.state === "pending" ||
      receipt.taskId !== fence.taskId ||
      (actualUsd !== undefined && (!Number.isFinite(actualUsd) || actualUsd < 0 || actualUsd > 1_000_000))
    )
      throw new TaviError("INVALID_INPUT", "Invalid router settlement");
    this.store.handle.transaction(() => {
      this.assertFence(scope, fence);
      const row = this.store.handle
        .prepare("SELECT owner_session, generation, charged_micros, data FROM tavi_router_decisions WHERE task_id=? AND operation_id=?")
        .get(fence.taskId, receipt.operationId) as
        | { owner_session: string; generation: number; charged_micros: number; data: string }
        | undefined;
      if (row === undefined || row.owner_session !== fence.ownerSession || row.generation !== fence.generation)
        throw new TaviError("CONFLICT", "Router decision belongs to another execution");
      const pending = RouterReceiptSchema.parse(JSON.parse(row.data));
      if (
        pending.state !== "pending" ||
        receipt.decisionId !== pending.decisionId ||
        receipt.configRevision !== pending.configRevision ||
        receipt.candidateHash !== pending.candidateHash ||
        receipt.feature !== pending.feature ||
        receipt.turnId !== pending.turnId ||
        receipt.permissionRevision !== pending.permissionRevision ||
        receipt.policyVersion !== pending.policyVersion ||
        receipt.mode !== pending.mode ||
        receipt.startedAt !== pending.startedAt ||
        receipt.callId !== pending.callId
      )
        throw new TaviError("CONFLICT", "Router decision identity changed or is already settled");
      if (receipt.selectedIds.length > 0 && this.configuration(scope).revision !== receipt.configRevision)
        throw new TaviError("CONFLICT", "Router configuration changed before selection committed");
      const micros = actualUsd === undefined ? row.charged_micros : Math.ceil(actualUsd * 1_000_000);
      this.store.handle
        .prepare("UPDATE tavi_router_decisions SET charged_micros=?, data=? WHERE task_id=? AND operation_id=?")
        .run(micros, JSON.stringify(receipt), fence.taskId, receipt.operationId);
      this.adjust(scope, fence.taskId, micros - row.charged_micros);
    })();
  }

  receipts(scope: RouterScope, taskId: string): readonly RouterReceipt[] {
    this.assertTask(scope, taskId);
    return (
      this.store.handle.prepare("SELECT data FROM tavi_router_decisions WHERE task_id=? ORDER BY rowid").all(taskId) as { data: string }[]
    ).map((row) => RouterReceiptSchema.parse(JSON.parse(row.data)));
  }

  private micros(scope: RouterScope, taskKey: string): number {
    const row = this.store.handle
      .prepare("SELECT micros FROM tavi_router_budget_totals WHERE workspace_id=? AND principal_id=? AND task_key=?")
      .get(scope.workspaceId, taskKey === "" ? "" : scope.principalId, taskKey) as { micros: number } | undefined;
    return row?.micros ?? 0;
  }

  private workspaceLimit(scope: RouterScope): number {
    const rows = this.store.handle
      .prepare(
        "SELECT principal_id, data FROM tavi_router_configurations AS c WHERE workspace_id=? AND revision=(SELECT MAX(revision) FROM tavi_router_configurations WHERE workspace_id=c.workspace_id AND principal_id=c.principal_id)",
      )
      .all(scope.workspaceId) as { principal_id: string; data: string }[];
    // All currently authorized principals constrain one shared cap. Reassignment
    // changes who can configure it, but never resets the workspace's spent total.
    return Math.min(
      ...rows
        .filter((row) => this.authorized({ ...scope, principalId: row.principal_id }))
        .map((row) => Math.floor(RouterSettingsSchema.parse(JSON.parse(row.data)).maxWorkspaceUsd * 1_000_000)),
    );
  }

  private adjust(scope: RouterScope, taskId: string, micros: number): void {
    for (const key of ["", taskId])
      this.store.handle
        .prepare(
          "INSERT INTO tavi_router_budget_totals VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, principal_id, task_key) DO UPDATE SET micros=micros+excluded.micros",
        )
        .run(scope.workspaceId, key === "" ? "" : scope.principalId, key, micros);
  }

  spent(scope: RouterScope, taskId?: string): number {
    if (taskId === undefined) this.assertScope(scope);
    else this.assertTask(scope, taskId);
    return this.micros(scope, taskId ?? "") / 1_000_000;
  }

  route(scope: RouterScope, taskId: string): TaskRoute | undefined {
    this.assertTask(scope, taskId);
    const row = this.store.handle.prepare("SELECT data FROM tavi_task_routes WHERE task_id=?").get(taskId) as { data: string } | undefined;
    return row === undefined ? undefined : TaskRouteSchema.parse(JSON.parse(row.data));
  }

  saveRoute(scope: RouterScope, fence: RouterFence, input: TaskRoute): TaskRoute {
    const route = TaskRouteSchema.parse(input);
    if (route.taskId !== fence.taskId) throw new TaviError("INVALID_INPUT", "Router route task mismatch");
    return this.store.handle.transaction(() => {
      this.assertFence(scope, fence);
      const existing = this.route(scope, fence.taskId);
      if (existing !== undefined) return existing;
      this.store.handle.prepare("INSERT INTO tavi_task_routes VALUES (?, ?)").run(fence.taskId, JSON.stringify(route));
      return route;
    })();
  }

  chooseRoute(scope: RouterScope, taskId: string, target: ModelTarget, at: string): TaskRoute {
    return this.store.handle.transaction(() => {
      this.assertTask(scope, taskId);
      const route = TaskRouteSchema.parse({
        taskId,
        target,
        fallback: [],
        origin: "explicit",
        configRevision: this.configuration(scope).revision,
        createdAt: at,
      });
      this.store.handle
        .prepare("INSERT INTO tavi_task_routes VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data")
        .run(taskId, JSON.stringify(route));
      return route;
    })();
  }

  chosenTargets(scope: RouterScope): readonly ChosenModelTarget[] {
    this.assertScope(scope);
    const rows = this.store.handle
      .prepare(
        `SELECT json_extract(r.data, '$.target.connectionId') AS connection_id, json_extract(r.data, '$.target.model') AS model, COUNT(*) AS chats
           FROM tavi_task_routes r JOIN tavi_tasks t ON t.task_id = r.task_id
          WHERE t.workspace_id = ? AND t.principal_id = ? AND json_extract(r.data, '$.origin') = 'explicit'
          GROUP BY 1, 2 ORDER BY 1, 2`,
      )
      .all(scope.workspaceId, scope.principalId) as { connection_id: unknown; model: unknown; chats: number }[];
    return rows.flatMap((row) =>
      typeof row.connection_id === "string" && typeof row.model === "string"
        ? [{ connectionId: row.connection_id, model: row.model, chats: row.chats }]
        : [],
    );
  }

  retargetChosen(scope: RouterScope, from: ModelTarget, to: ModelTarget): number {
    this.assertScope(scope);
    const target = ModelTargetSchema.parse(to);
    const result = this.store.handle
      .prepare(
        `UPDATE tavi_task_routes
            SET data = json_set(data, '$.target.connectionId', ?, '$.target.model', ?)
          WHERE json_extract(data, '$.origin') = 'explicit'
            AND json_extract(data, '$.target.connectionId') = ? AND json_extract(data, '$.target.model') = ?
            AND task_id IN (SELECT task_id FROM tavi_tasks WHERE workspace_id = ? AND principal_id = ?)`,
      )
      .run(target.connectionId, target.model, from.connectionId, from.model, scope.workspaceId, scope.principalId);
    return Number(result.changes);
  }

  disclosure(scope: RouterScope, taskId: string, attemptId: string): ToolDisclosure | undefined {
    this.assertTask(scope, taskId);
    const row = this.store.handle
      .prepare("SELECT data FROM tavi_tool_disclosures WHERE task_id=? AND attempt_id=?")
      .get(taskId, attemptId) as { data: string } | undefined;
    return row === undefined ? undefined : ToolDisclosureSchema.parse(JSON.parse(row.data));
  }

  saveDisclosure(scope: RouterScope, fence: RouterFence, input: ToolDisclosure): void {
    const disclosure = ToolDisclosureSchema.parse(input);
    this.assertFence(scope, fence);
    if (disclosure.taskId !== fence.taskId) throw new TaviError("INVALID_INPUT", "Disclosure task mismatch");
    const existing = this.disclosure(scope, fence.taskId, disclosure.attemptId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(disclosure)) throw new TaviError("CONFLICT", "Tool disclosure is immutable");
      return;
    }
    this.store.handle
      .prepare("INSERT INTO tavi_tool_disclosures VALUES (?, ?, ?)")
      .run(fence.taskId, disclosure.attemptId, JSON.stringify(disclosure));
  }

  contextProjections(scope: RouterScope, taskId: string): readonly ContextProjectionSnapshot[] {
    this.assertTask(scope, taskId);
    return (
      this.store.handle.prepare("SELECT data FROM tavi_context_projections WHERE task_id=? ORDER BY rowid").all(taskId) as {
        data: string;
      }[]
    ).map((row) => ContextProjectionSnapshotSchema.parse(JSON.parse(row.data)));
  }

  saveContextProjection(scope: RouterScope, fence: RouterFence, input: ContextProjectionSnapshot): void {
    const projection = ContextProjectionSnapshotSchema.parse(input);
    this.store.handle.transaction(() => {
      this.assertFence(scope, fence);
      if (projection.taskId !== fence.taskId) throw new TaviError("INVALID_INPUT", "Context projection task mismatch");
      const data = JSON.stringify(projection);
      const prior = this.store.handle
        .prepare("SELECT data FROM tavi_context_projections WHERE task_id=? AND attempt_id=?")
        .get(fence.taskId, projection.attemptId) as { data: string } | undefined;
      if (prior !== undefined) {
        if (prior.data !== data) throw new TaviError("CONFLICT", "Context projection is immutable");
        return;
      }
      this.store.handle.prepare("INSERT INTO tavi_context_projections VALUES (?, ?, ?)").run(fence.taskId, projection.attemptId, data);
    })();
  }

  /** Only the new directory owner calls recovery; reservations remain charged until billing is known. */
  recoverPreviousOwner(ownerSession: string, at: string): number {
    return this.store.handle.transaction(() => {
      let count = 0;
      const rows = this.store.handle
        .prepare("SELECT task_id, operation_id, data FROM tavi_router_decisions WHERE owner_session<>?")
        .all(ownerSession) as { task_id: string; operation_id: string; data: string }[];
      for (const row of rows) {
        const receipt = RouterReceiptSchema.parse(JSON.parse(row.data));
        if (receipt.state !== "pending") continue;
        const recovered = RouterReceiptSchema.parse({
          ...receipt,
          state: "uncertain",
          reason: "uncertain",
          selectedIds: [],
          probabilities: {},
          finishedAt: at,
        });
        this.store.handle
          .prepare("UPDATE tavi_router_decisions SET data=? WHERE task_id=? AND operation_id=?")
          .run(JSON.stringify(recovered), row.task_id, row.operation_id);
        count++;
      }
      return count;
    })();
  }
}
