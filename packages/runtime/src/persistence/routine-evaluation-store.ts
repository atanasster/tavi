import type { RoutineScope } from "@tavi/contracts";
import type { RoutineService } from "../routines/service.js";
export interface QualityWrite {
  evaluationId: string;
  scope: RoutineScope;
  fingerprint: string;
  ownerEpoch: string;
  status: string;
  data: string;
  now: string;
}
export class RoutineEvaluationStore {
  private readonly routines: RoutineService;
  constructor(routines: RoutineService) {
    this.routines = routines;
  }
  private get db() {
    return this.routines.store.handle;
  }
  recover(ownerEpoch: string): void {
    this.routines.store.transactionImmediate(() => {
      const rows = this.db
        .prepare(
          "SELECT e.evaluation_id,e.routine_id,e.revision,r.workspace_id,r.principal_id FROM tavi_routine_evaluations e JOIN tavi_routines r ON r.routine_id=e.routine_id LEFT JOIN tavi_routine_quality q ON q.evaluation_id=e.evaluation_id WHERE e.status='running' AND (q.owner_epoch IS NULL OR q.owner_epoch<>?)",
        )
        .all(ownerEpoch) as { workspace_id: string; principal_id: string; routine_id: string; revision: number; evaluation_id: string }[];
      for (const row of rows) {
        this.db
          .prepare("UPDATE tavi_routine_quality SET status='failed',owner_epoch=? WHERE evaluation_id=?")
          .run(ownerEpoch, row.evaluation_id);
        this.routines.finishEvaluation(
          { workspaceId: row.workspace_id, principalId: row.principal_id },
          row.routine_id,
          row.revision,
          false,
          "Evaluation interrupted by owner restart; use Evaluate again to rerun it. Reserved spend is retained and not reconciled.",
        );
      }
    });
  }
  pending(
    cursor: string,
  ): readonly { evaluation_id: string; routine_id: string; revision: number; workspace_id: string; principal_id: string }[] {
    return this.db
      .prepare(
        "SELECT e.evaluation_id,e.routine_id,e.revision,r.workspace_id,r.principal_id FROM tavi_routine_evaluations e JOIN tavi_routines r ON r.routine_id=e.routine_id WHERE e.status='pending' AND e.revision=r.latest_revision AND r.status<>'archived' AND e.evaluation_id>? ORDER BY e.evaluation_id LIMIT 20",
      )
      .all(cursor) as { evaluation_id: string; routine_id: string; revision: number; workspace_id: string; principal_id: string }[];
  }
  /**
   * The evaluator could not start: record why on the pending evaluation, and
   * say so in the routine's status. Only a routine still waiting for its first
   * evaluation moves (a pause or an archive is the operator's and stays), and
   * a real change bumps `version` so clients holding the old one see it.
   * The evaluation stays `pending`, so the next sweep tries again once setup
   * is fixed — a model or search provider added to the running owner counts,
   * with no restart.
   */
  setupNeeded(scope: RoutineScope, routineId: string, revision: number, reason: string): void {
    this.routines.get(scope, routineId);
    this.routines.store.transactionImmediate(() => {
      const now = this.routines.now();
      this.db
        .prepare("UPDATE tavi_routine_evaluations SET detail=? WHERE routine_id=? AND revision=? AND status='pending' AND detail<>?")
        .run(reason, routineId, revision, reason);
      this.db
        .prepare(
          "UPDATE tavi_routines SET status='setup-needed',version=version+1,updated_at=? WHERE routine_id=? AND active_revision IS NULL AND status IN ('draft','evaluating')",
        )
        .run(now, routineId);
    });
  }
  /**
   * A passed measurement under this fingerprint anywhere in the workspace: the pass measures the models on a fixed
   * task, not the person who asked, so whoever ran it, it holds for everyone here. The row still names who ran it.
   */
  cached(scope: RoutineScope, fingerprint: string): { data_json: string } | undefined {
    return this.db
      .prepare("SELECT data_json FROM tavi_routine_quality WHERE workspace_id=? AND fingerprint=? AND status='passed' LIMIT 1")
      .get(scope.workspaceId, fingerprint) as { data_json: string } | undefined;
  }
  claim(routineId: string, revision: number, write: QualityWrite): boolean {
    return this.routines.store.transactionImmediate(() => {
      const detail = this.routines.get(write.scope, routineId, revision);
      if (
        detail.evaluation.evaluationId !== write.evaluationId ||
        detail.routine.status === "archived" ||
        detail.routine.latestRevision !== revision
      )
        return false;
      const result = this.db
        .prepare("UPDATE tavi_routine_evaluations SET status='running' WHERE evaluation_id=? AND status='pending'")
        .run(write.evaluationId);
      if (result.changes === 0) return false;
      // As in `setupNeeded`: never over a pause or an archive, and versioned.
      this.db
        .prepare(
          "UPDATE tavi_routines SET status='evaluating',version=version+1,updated_at=? WHERE routine_id=? AND active_revision IS NULL AND status IN ('draft','setup-needed')",
        )
        .run(write.now, routineId);
      // A reason recorded while setup was missing no longer applies.
      this.db.prepare("UPDATE tavi_routine_evaluations SET detail='' WHERE evaluation_id=?").run(write.evaluationId);
      this.save(write);
      return true;
    });
  }
  save(write: QualityWrite): void {
    this.db
      .prepare(
        "INSERT INTO tavi_routine_quality VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(evaluation_id) DO UPDATE SET status=excluded.status,data_json=excluded.data_json,updated_at=excluded.updated_at WHERE owner_epoch=excluded.owner_epoch",
      )
      .run(
        write.evaluationId,
        write.scope.workspaceId,
        write.scope.principalId,
        write.fingerprint,
        write.ownerEpoch,
        write.status,
        write.data,
        write.now,
      );
  }
  owner(evaluationId: string): { owner_epoch: string; status: string } | undefined {
    return this.db.prepare("SELECT owner_epoch,status FROM tavi_routine_quality WHERE evaluation_id=?").get(evaluationId) as
      | { owner_epoch: string; status: string }
      | undefined;
  }
}
