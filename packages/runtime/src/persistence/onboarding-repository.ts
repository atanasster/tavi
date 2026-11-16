import {
  ONBOARDING_DISMISSED_KINDS_META_KEY,
  ONBOARDING_EVENTS_MAX,
  ONBOARDING_REACHED_WINDOW_MS,
  OnboardingInstallSchema,
  OnboardingStepKindSchema,
  OnboardingStepRecordSchema,
  OnboardingVerificationSchema,
  type OnboardingInstall,
  type OnboardingStepKind,
  type OnboardingFunnelEvent,
  type OnboardingStatus,
  type OnboardingStepRecord,
  type OnboardingVerification,
  type OnboardingVerifySubject,
  type RecordOnboardingCreatedInput,
  type SetOnboardingStepInput,
} from "@tavi/contracts";

import type { OnboardingRepositoryPort } from "./internal-contracts.js";
import type { Database } from "./sqlite-loader.js";

/** Onboarding's install row, step marks and verifications. */

interface InstallRow {
  provider_id: string | null;
  first_seen_at: string | null;
  completed_at: string | null;
  dismissed_at: string | null;
  dismissed_flow_version: number | null;
  flow_version: number | null;
}

interface StepRow {
  workspace_id: string;
  step_kind: string;
  state: string | null;
  created_ref: string | null;
  at: string;
}

interface VerificationRow {
  workspace_id: string;
  subject: string;
  role: string | null;
  subject_id: string;
  model: string | null;
  base_url: string | null;
  credential_revision: string | null;
  ok: number;
  tools_ok: number | null;
  error_code: string | null;
  at: string;
}

/**
 * The kinds a release still knows, from the meta row; a kind a later release
 * dropped is left out. A row that cannot be read is no row: an empty list would
 * make every open step look new, and bring a dismissed card back.
 */
function stepKindsOf(json: string | undefined): OnboardingStepKind[] | null {
  if (json === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const kinds = parsed.filter((kind): kind is OnboardingStepKind => OnboardingStepKindSchema.safeParse(kind).success);
  return kinds.length === 0 ? null : kinds;
}

const optional = <K extends string, V>(key: K, value: V | null): { [P in K]?: V } =>
  (value === null ? {} : { [key]: value }) as { [P in K]?: V };

const installOf = (row: InstallRow, dismissedKinds: string | undefined): OnboardingInstall =>
  OnboardingInstallSchema.parse({
    providerId: row.provider_id,
    ...optional("firstSeenAt", row.first_seen_at),
    ...optional("completedAt", row.completed_at),
    ...optional("dismissedAt", row.dismissed_at),
    ...optional("dismissedFlowVersion", row.dismissed_flow_version),
    ...(row.dismissed_at === null ? {} : optional("dismissedStepKinds", stepKindsOf(dismissedKinds))),
    ...optional("flowVersion", row.flow_version),
  });

const stepOf = (row: StepRow): OnboardingStepRecord =>
  OnboardingStepRecordSchema.parse({
    workspaceId: row.workspace_id,
    kind: row.step_kind,
    ...optional("mark", row.state),
    ...optional("createdRef", row.created_ref),
    at: row.at,
  });

const verificationOf = (row: VerificationRow): OnboardingVerification =>
  OnboardingVerificationSchema.parse({
    workspaceId: row.workspace_id,
    subject: row.subject,
    ...optional("role", row.role),
    subjectId: row.subject_id,
    ...optional("model", row.model),
    ...optional("baseUrl", row.base_url),
    ...optional("credentialRevision", row.credential_revision),
    ok: row.ok === 1,
    ...(row.tools_ok === null ? {} : { toolsOk: row.tools_ok === 1 }),
    ...optional("errorCode", row.error_code),
    at: row.at,
  });

export class SqliteOnboardingRepository implements OnboardingRepositoryPort {
  readonly #db: () => Database;
  readonly #transaction: <T>(work: () => T) => T;

  constructor(db: () => Database, transaction: <T>(work: () => T) => T) {
    this.#db = db;
    this.#transaction = transaction;
  }

  install(): OnboardingInstall {
    // The migration writes the one row; a store restored from before it never reaches here unmigrated.
    const db = this.#db();
    const kinds = db.prepare("SELECT value FROM tavi_meta WHERE key = ?").get(ONBOARDING_DISMISSED_KINDS_META_KEY) as
      | { value: string }
      | undefined;
    return installOf(db.prepare("SELECT * FROM tavi_onboarding WHERE id = 1").get() as InstallRow, kinds?.value);
  }

  setProvider(providerId: string | null): OnboardingInstall {
    this.#db().prepare("UPDATE tavi_onboarding SET provider_id = ? WHERE id = 1").run(providerId);
    return this.install();
  }

  noteSeen(now: string): OnboardingInstall {
    this.#db().prepare("UPDATE tavi_onboarding SET first_seen_at = COALESCE(first_seen_at, ?) WHERE id = 1").run(now);
    return this.install();
  }

  setFlowVersion(version: number): OnboardingInstall {
    this.#db().prepare("UPDATE tavi_onboarding SET flow_version = ? WHERE id = 1").run(version);
    return this.install();
  }

  complete(now: string): OnboardingInstall {
    this.#db().prepare("UPDATE tavi_onboarding SET completed_at = COALESCE(completed_at, ?) WHERE id = 1").run(now);
    return this.install();
  }

  dismiss(flowVersion: number, now: string, stepKinds: readonly OnboardingStepKind[] = []): OnboardingInstall {
    this.#transaction(() => {
      const db = this.#db();
      db.prepare("UPDATE tavi_onboarding SET dismissed_at = ?, dismissed_flow_version = ? WHERE id = 1").run(now, flowVersion);
      // No kinds, no row: such a dismissal never comes back, rather than for every step.
      if (stepKinds.length === 0) db.prepare("DELETE FROM tavi_meta WHERE key = ?").run(ONBOARDING_DISMISSED_KINDS_META_KEY);
      else {
        db.prepare(
          "INSERT INTO tavi_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        ).run(ONBOARDING_DISMISSED_KINDS_META_KEY, JSON.stringify([...new Set(stepKinds)]), now);
      }
    });
    return this.install();
  }

  steps(workspaceId: string): readonly OnboardingStepRecord[] {
    const rows = this.#db()
      .prepare("SELECT * FROM tavi_onboarding_steps WHERE workspace_id = ? ORDER BY step_kind")
      .all(workspaceId) as StepRow[];
    // A kind a later release dropped is skipped rather than failing the whole read.
    return rows.filter((row) => OnboardingStepKindSchema.safeParse(row.step_kind).success).map(stepOf);
  }

  setStep(input: SetOnboardingStepInput): OnboardingStepRecord {
    return this.#upsert(input.workspaceId, input.kind, input.now, { mark: input.mark });
  }

  recordCreated(input: RecordOnboardingCreatedInput): OnboardingStepRecord {
    return this.#upsert(input.workspaceId, input.kind, input.now, { createdRef: input.createdRef });
  }

  restoreStep(workspaceId: string, kind: OnboardingStepKind, now: string): OnboardingStepRecord | undefined {
    return this.#transaction(() => {
      const db = this.#db();
      db.prepare(
        "UPDATE tavi_onboarding_steps SET state = NULL, at = ? WHERE workspace_id = ? AND step_kind = ? AND state = 'skipped'",
      ).run(now, workspaceId, kind);
      db.prepare(
        "DELETE FROM tavi_onboarding_steps WHERE workspace_id = ? AND step_kind = ? AND state IS NULL AND created_ref IS NULL",
      ).run(workspaceId, kind);
      return this.#step(workspaceId, kind);
    });
  }

  reset(workspaceId: string, now: string): number {
    return this.#transaction(() => {
      const db = this.#db();
      const cleared = db
        .prepare("UPDATE tavi_onboarding_steps SET state = NULL, at = ? WHERE workspace_id = ? AND state IN ('skipped', 'seen')")
        .run(now, workspaceId).changes;
      db.prepare("DELETE FROM tavi_onboarding_steps WHERE workspace_id = ? AND state IS NULL AND created_ref IS NULL").run(workspaceId);
      db.prepare("UPDATE tavi_onboarding SET dismissed_at = NULL, dismissed_flow_version = NULL WHERE id = 1").run();
      db.prepare("DELETE FROM tavi_meta WHERE key = ?").run(ONBOARDING_DISMISSED_KINDS_META_KEY);
      db.prepare("DELETE FROM tavi_onboarding_events WHERE workspace_id = ?").run(workspaceId);
      return cleared;
    });
  }

  recordEvent(input: {
    readonly workspaceId: string;
    readonly kind: OnboardingStepKind;
    readonly event: OnboardingFunnelEvent;
    readonly errorCode?: string;
    readonly now: string;
  }): void {
    this.#transaction(() => {
      const db = this.#db();
      if (input.event === "reached") {
        const last = db
          .prepare(
            "SELECT at FROM tavi_onboarding_events WHERE workspace_id = ? AND step_kind = ? AND event = 'reached' ORDER BY id DESC LIMIT 1",
          )
          .get(input.workspaceId, input.kind) as { at: string } | undefined;
        if (last !== undefined && Date.parse(input.now) - Date.parse(last.at) < ONBOARDING_REACHED_WINDOW_MS) return;
      }
      db.prepare("INSERT INTO tavi_onboarding_events (workspace_id, step_kind, event, error_code, at) VALUES (?, ?, ?, ?, ?)").run(
        input.workspaceId,
        input.kind,
        input.event,
        input.errorCode?.slice(0, 64) ?? null,
        input.now,
      );
      db.prepare(
        "DELETE FROM tavi_onboarding_events WHERE id <= (SELECT id FROM tavi_onboarding_events ORDER BY id DESC LIMIT 1 OFFSET ?)",
      ).run(ONBOARDING_EVENTS_MAX);
    });
  }

  funnel(workspaceId: string): NonNullable<OnboardingStatus["funnel"]> {
    const db = this.#db();
    const rows = db
      .prepare("SELECT step_kind, event, COUNT(*) AS count FROM tavi_onboarding_events WHERE workspace_id = ? GROUP BY step_kind, event")
      .all(workspaceId) as { step_kind: string; event: OnboardingFunnelEvent; count: number }[];
    const errors = db
      .prepare(
        "SELECT step_kind, error_code FROM tavi_onboarding_events WHERE workspace_id = ? AND event = 'failed' AND error_code IS NOT NULL ORDER BY id",
      )
      .all(workspaceId) as { step_kind: string; error_code: string }[];
    const funnel: Partial<Record<OnboardingStepKind, { reached: number; skipped: number; failed: number; lastError?: string }>> = {};
    for (const row of rows) {
      if (!OnboardingStepKindSchema.safeParse(row.step_kind).success) continue;
      const kind = row.step_kind as OnboardingStepKind;
      const counts = (funnel[kind] ??= { reached: 0, skipped: 0, failed: 0 });
      counts[row.event] = row.count;
    }
    for (const row of errors) {
      const counts = funnel[row.step_kind as OnboardingStepKind];
      if (counts !== undefined) counts.lastError = row.error_code;
    }
    return funnel;
  }

  recordVerification(verification: OnboardingVerification): OnboardingVerification {
    const parsed = OnboardingVerificationSchema.parse(verification);
    this.#transaction(() => this.#replaceVerification(parsed));
    return parsed;
  }

  verifications(workspaceId: string, subject?: OnboardingVerifySubject): readonly OnboardingVerification[] {
    const rows = (
      subject === undefined
        ? this.#db()
            .prepare("SELECT * FROM tavi_onboarding_verifications WHERE workspace_id = ? ORDER BY at DESC, rowid DESC")
            .all(workspaceId)
        : this.#db()
            .prepare("SELECT * FROM tavi_onboarding_verifications WHERE workspace_id = ? AND subject = ? ORDER BY at DESC, rowid DESC")
            .all(workspaceId, subject)
    ) as VerificationRow[];
    return rows.map(verificationOf);
  }

  #step(workspaceId: string, kind: OnboardingStepKind): OnboardingStepRecord | undefined {
    const row = this.#db().prepare("SELECT * FROM tavi_onboarding_steps WHERE workspace_id = ? AND step_kind = ?").get(workspaceId, kind) as
      | StepRow
      | undefined;
    return row === undefined ? undefined : stepOf(row);
  }

  /** One row per step: a mark replaces the mark, a created ref the ref, and each keeps the other. */
  #upsert(
    workspaceId: string,
    kind: OnboardingStepKind,
    now: string,
    change: { readonly mark?: string; readonly createdRef?: string },
  ): OnboardingStepRecord {
    return this.#transaction(() => {
      this.#db()
        .prepare(`INSERT INTO tavi_onboarding_steps (workspace_id, step_kind, state, created_ref, at) VALUES (@workspaceId, @kind, @mark, @createdRef, @now)
        ON CONFLICT (workspace_id, step_kind) DO UPDATE SET
          state = CASE WHEN @mark IS NULL THEN state ELSE @mark END,
          created_ref = CASE WHEN @createdRef IS NULL THEN created_ref ELSE @createdRef END,
          at = @now`)
        .run({ workspaceId, kind, mark: change.mark ?? null, createdRef: change.createdRef ?? null, now });
      return this.#step(workspaceId, kind) as OnboardingStepRecord;
    });
  }

  #replaceVerification(verification: OnboardingVerification): void {
    const db = this.#db();
    db.prepare(
      "DELETE FROM tavi_onboarding_verifications WHERE workspace_id = ? AND subject = ? AND COALESCE(role, '') = ? AND subject_id = ?",
    ).run(verification.workspaceId, verification.subject, verification.role ?? "", verification.subjectId);
    db.prepare(`INSERT INTO tavi_onboarding_verifications (workspace_id, subject, role, subject_id, model, base_url, credential_revision, ok, tools_ok, error_code, at)
      VALUES (@workspaceId, @subject, @role, @subjectId, @model, @baseUrl, @credentialRevision, @ok, @toolsOk, @errorCode, @at)`).run({
      workspaceId: verification.workspaceId,
      subject: verification.subject,
      role: verification.role ?? null,
      subjectId: verification.subjectId,
      model: verification.model ?? null,
      baseUrl: verification.baseUrl ?? null,
      credentialRevision: verification.credentialRevision ?? null,
      ok: verification.ok ? 1 : 0,
      toolsOk: verification.toolsOk === undefined ? null : verification.toolsOk ? 1 : 0,
      errorCode: verification.errorCode ?? null,
      at: verification.at,
    });
  }
}
