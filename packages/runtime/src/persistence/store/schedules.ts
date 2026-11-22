import { assertPositiveLimit, storedTextRef, textRefColumns } from "../values.js";
import type { ScheduleRepositoryPort } from "../internal-contracts.js";
import { z } from "zod";
import {
  TaviError,
  type CreateScheduleInput,
  type MissedRunPolicy,
  MissedRunPolicySchema,
  type ScheduleAlertTarget,
  ScheduleAlertTargetSchema,
  SCHEDULE_DELIVERY_TARGETS,
  SCHEDULE_HUMAN_CHECKPOINTS,
  type ScheduleDeliveryTarget,
  type ScheduleEmailTrigger,
  ScheduleEmailTriggerSchema,
  type ScheduleFireRecord,
  type ScheduleFireEntry,
  type TextRef,
  type ScheduleHumanCheckpoints,
  ScheduleMaxRunMinutesSchema,
  ScheduleMaxTokensSchema,
  type ScheduleNotify,
  ScheduleNotifySchema,
  type SchedulePrecheck,
  SchedulePrecheckSchema,
  type SchedulePrecheckState,
  SchedulePrecheckStateSchema,
  type ScheduleRecord,
  SCHEDULE_FIRES_KEPT,
  SCHEDULE_REFUSALS,
  SCHEDULE_REFUSALS_KEPT,
  SCHEDULE_PAUSED_REASONS,
  type ScheduleRetry,
  type ScheduleSpec,
  ScheduleSpecSchema,
  type ScheduledSpend,
  SCHEDULE_TOOL_PATTERN,
} from "@tavi/contracts";
import type { StoreContext } from "./context.js";

/**
 * Recurring schedules.
 *
 * Every mutating method that the scheduler calls is a conditional UPDATE
 * rather than a read-then-write: the scheduler runs inside `tavi serve`, and a
 * future second dispatcher (another process, or `schedules run-now` racing a
 * tick) must not be able to run one fire twice. `claimFire` is the load-bearing
 * one — it advances `next_run_at` only if it still holds the fire time the
 * caller read, which is exactly the compare-and-set a fire needs and is why
 * `transactionImmediate` is not even needed: SQLite evaluates the WHERE clause
 * and applies the write in one statement.
 */
export class SqliteScheduleRepository implements ScheduleRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  create(input: CreateScheduleInput): ScheduleRecord {
    const existing = this.#store.handle
      .prepare("SELECT schedule_id FROM tavi_schedules WHERE workspace_id = ? AND name = ?")
      .get(input.workspaceId, input.name) as { readonly schedule_id: string } | undefined;
    if (existing !== undefined) {
      throw new TaviError("CONFLICT", `A schedule named ${input.name} already exists in this workspace`, {
        details: { scheduleId: existing.schedule_id, name: input.name },
      });
    }
    refuseCheckpointsWithoutAlert(input.humanCheckpoints, input.alert);
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_schedules
           (schedule_id, workspace_id, principal_id, name, prompt, spec_json, missed_run_policy,
            auto_approve_tools_json, agent_id, alert_json, enabled, next_run_at, last_run_at, last_run_task_id,
            last_outcome, consecutive_failures, created_at, updated_at, human_checkpoints, deliver_to, max_run_minutes, max_tokens, notify,
            precheck_json, watch, folder_path)
         VALUES (@scheduleId, @workspaceId, @principalId, @name, @prompt, @specJson, @missedRunPolicy,
            @autoApproveToolsJson, @agentId, @alertJson, @enabled, @nextRunAt, NULL, NULL,
            NULL, 0, @now, @now, @humanCheckpoints, @deliverTo, @maxRunMinutes, @maxTokens, @notify,
            @precheckJson, @watch, @folderPath)`,
      )
      .run({
        scheduleId: input.scheduleId,
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        name: input.name,
        prompt: input.prompt,
        specJson: JSON.stringify(input.spec),
        missedRunPolicy: input.missedRunPolicy,
        autoApproveToolsJson: JSON.stringify(input.autoApproveTools),
        agentId: input.agentId ?? null,
        alertJson: input.alert === undefined ? null : JSON.stringify(input.alert),
        humanCheckpoints: input.humanCheckpoints === "ask-with-default" ? input.humanCheckpoints : null,
        deliverTo: input.deliverTo ?? null,
        maxRunMinutes: input.maxRunMinutes ?? null,
        maxTokens: input.maxTokens ?? null,
        folderPath: input.folder ?? null,
        notify: storedNotify(input.notify),
        precheckJson: input.precheck === undefined ? null : storedPrecheck(input.precheck),
        watch: input.watch === true && input.precheck !== undefined ? 1 : 0,
        enabled: input.enabled ? 1 : 0,
        nextRunAt: input.nextRunAt,
        now: input.now,
      });
    const created = this.get(input.scheduleId);
    if (created === undefined) {
      // The insert just succeeded, so this is unreachable against this store;
      // throwing rather than returning a non-null assertion keeps the failure
      // honest if a future write path (a trigger, a second connection) ever
      // makes the read disagree with the write.
      throw new TaviError("INTERNAL", `Schedule ${input.scheduleId} vanished immediately after insert`);
    }
    return created;
  }

  get(scheduleId: string): ScheduleRecord | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_schedules WHERE schedule_id = ?").get(scheduleId) as ScheduleRow | undefined;
    if (row === undefined) return undefined;
    const record = tryScheduleRecord(row);
    if (record === undefined) {
      throw new TaviError("INTERNAL", `Schedule ${scheduleId} has an unreadable configuration`, { details: { scheduleId } });
    }
    return record;
  }

  list(workspaceId?: string): readonly ScheduleRecord[] {
    const rows = (
      workspaceId === undefined
        ? this.#store.handle.prepare("SELECT * FROM tavi_schedules ORDER BY name").all()
        : this.#store.handle.prepare("SELECT * FROM tavi_schedules WHERE workspace_id = ? ORDER BY name").all(workspaceId)
    ) as ScheduleRow[];
    // `list` is the operator-facing view, so an unreadable row still appears —
    // named, with an empty policy, rather than being hidden from the person who
    // has to fix it. `get` throws instead, because acting on it is not safe.
    const records: ScheduleRecord[] = [];
    for (const row of rows) {
      const record = tryScheduleRecord(row);
      if (record !== undefined) {
        records.push(record);
        continue;
      }
      records.push({
        scheduleId: row.schedule_id,
        workspaceId: row.workspace_id,
        principalId: row.principal_id,
        name: row.name,
        prompt: row.prompt,
        spec: { at: "00:00", timezone: "UTC" },
        missedRunPolicy: "skip",
        autoApproveTools: [],
        enabled: false,
        nextRunAt: row.next_run_at,
        lastRunAt: row.last_run_at,
        lastRunTaskId: row.last_run_task_id,
        lastOutcome: "unreadable configuration — fix or remove this row",
        consecutiveFailures: row.consecutive_failures,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    return records;
  }

  listDue(now: string, limit: number): { readonly due: readonly ScheduleRecord[]; readonly unreadable: readonly string[] } {
    assertPositiveLimit(limit, "listDue");
    const due: ScheduleRecord[] = [];
    const unreadable: string[] = [];
    /**
     * Page until `limit` *readable* schedules are collected or the due set is
     * exhausted.
     *
     * A single `LIMIT ?` counted unreadable rows against the cap, and nothing ever
     * advances an unreadable row — its `next_run_at` stays in the past — so they
     * permanently occupy the first slots of every sweep: with `limit` poisoned rows
     * the sweep never saw a healthy schedule again, and no schedule in the
     * deployment ever fired, with an error logged per row per tick. Each page is `limit` rows and the offset advances by the
     * page's own length, so the work is linear in the number of rows examined and
     * terminates when a page comes back short.
     */
    // `schedule_id` is a deterministic tiebreaker: two schedules due at the same
    // instant have no inherent order, and without one a paged scan can return the
    // same row twice or skip it, depending on how SQLite breaks the tie.
    const query = this.#store.handle.prepare(
      `SELECT * FROM tavi_schedules
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at, schedule_id LIMIT ? OFFSET ?`,
    );
    // Bounded: each page re-scans from the start (`OFFSET`), so an unbounded page
    // count is quadratic against the due index and is re-paid every tick. A large
    // poisoned backlog therefore makes *slower* progress instead of degrading every
    // sweep, and the cap cannot hide a healthy schedule that a single page already
    // reaches.
    const maxPages = 50;
    for (let page = 0; due.length < limit && page < maxPages; page += 1) {
      const offset = page * limit;
      const rows = query.all(now, limit, offset) as ScheduleRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        // Per-row: one unreadable schedule is reported and skipped, and every other
        // schedule still fires. A throwing read here aborted the whole sweep, so a
        // single hand-edited row stopped every schedule in the deployment —
        // silently, because the sweep's error path never reached an alert.
        const record = tryScheduleRecord(row);
        if (record === undefined) unreadable.push(row.schedule_id);
        else if (due.length < limit) due.push(record);
      }
      if (rows.length < limit) break;
    }
    return { due, unreadable };
  }

  remove(scheduleId: string): boolean {
    return this.#store.transaction(() => {
      this.#store.handle.prepare("DELETE FROM tavi_schedule_fires WHERE schedule_id = ?").run(scheduleId);
      return this.#store.handle.prepare("DELETE FROM tavi_schedules WHERE schedule_id = ?").run(scheduleId).changes > 0;
    });
  }

  claimFire(input: {
    readonly scheduleId: string;
    readonly fireTime: string;
    readonly nextRunAt: string | null;
    readonly now: string;
  }): boolean {
    // `AND next_run_at = @fireTime` is the whole lock: whoever gets there first
    // moves the pointer, and every later claimant for that same fire matches
    // zero rows. `enabled = 1` is repeated here so a fire claimed while an
    // operator was disabling the schedule cannot land. `last_run_at` is not
    // touched: a claimed fire may still be skipped (missed, overlapping), and
    // "last run" names a fire that ran — `markRunning` sets it. A retry armed at
    // this fire time is this claim's: the fire knows which retry it is from the
    // row it listed, and the claim arms the regular next fire again. A claim
    // with no next fire is a finished schedule's last: no longer due, and left
    // on until `finish`, so a retry of it can still be armed.
    const result = this.#store.handle
      .prepare(
        `UPDATE tavi_schedules
            SET next_run_at = @nextRunAt, retry_count = 0, retry_of_fire_time = NULL, updated_at = @now
          WHERE schedule_id = @scheduleId AND next_run_at = @fireTime AND enabled = 1`,
      )
      .run(input);
    return result.changes > 0;
  }

  markRunning(input: {
    readonly scheduleId: string;
    readonly taskId: string;
    readonly fireTime: string;
    readonly now: string;
    readonly manual?: true;
  }): void {
    // A run asked for now is a run too: it moves the last run, and nothing the scheduler reads.
    if (input.manual === true) {
      this.#store.handle
        .prepare("UPDATE tavi_schedules SET last_run_at = @fireTime, updated_at = @now WHERE schedule_id = @scheduleId")
        .run({ scheduleId: input.scheduleId, fireTime: input.fireTime, now: input.now });
      return;
    }
    this.#store.handle
      .prepare(
        `UPDATE tavi_schedules
            SET last_run_task_id = @taskId,
                last_run_at = @fireTime,
                last_outcome = @outcome,
                updated_at = @now
          WHERE schedule_id = @scheduleId`,
      )
      .run({
        scheduleId: input.scheduleId,
        taskId: input.taskId,
        fireTime: input.fireTime,
        // The fire time travels in the marker text so a process that dies here
        // leaves behind *which* fire never reported a result; the next sweep
        // reads this back and says so (see `schedule-reconcile.ts`).
        outcome: `dispatching the ${input.fireTime} fire`,
        now: input.now,
      });
  }

  recordRun(input: {
    readonly scheduleId: string;
    readonly taskId: string | null;
    readonly outcome: string;
    readonly outcomeRef?: TextRef;
    readonly outcomeKind: "succeeded" | "failed" | "skipped";
    readonly counted?: false;
    readonly fire?: ScheduleFireEntry;
    readonly deliveredHash?: string;
    readonly precheckState?: { readonly of: SchedulePrecheck; readonly state: SchedulePrecheckState };
    readonly now: string;
  }): void {
    // `consecutive_failures` counts consecutive *failed runs*: it increments on
    // a failure and resets only on a genuine success. A skipped fire is neither,
    // so it leaves the counter alone — resetting it there would let a broken
    // schedule look healthy after a quiet morning, and incrementing it would
    // report an overlap as a failure. A run not `counted` (one asked for now) leaves it alone too.
    const update = this.#store.handle.prepare(
      `UPDATE tavi_schedules
            SET last_run_task_id = COALESCE(@taskId, last_run_task_id),
                last_outcome = @outcome,
                consecutive_failures = CASE
                  WHEN @counted = 0 THEN consecutive_failures
                  WHEN @outcomeKind = 'failed' THEN consecutive_failures + 1
                  WHEN @outcomeKind = 'succeeded' THEN 0
                  ELSE consecutive_failures
                END,
                last_delivered_hash = COALESCE(@deliveredHash, last_delivered_hash),
                precheck_state_json = CASE WHEN @precheckState IS NOT NULL AND precheck_json = @precheckOf
                  THEN @precheckState ELSE precheck_state_json END,
                updated_at = @now
          WHERE schedule_id = @scheduleId`,
    );
    const { fire, deliveredHash, precheckState, counted, outcomeRef: _outcomeRef, ...rest } = input;
    const run = {
      ...rest,
      counted: counted === false ? 0 : 1,
      deliveredHash: deliveredHash ?? null,
      // Kept only while the schedule's pre-check is still the one that took the reading.
      precheckOf: precheckState === undefined ? null : storedPrecheck(precheckState.of),
      precheckState: precheckState === undefined ? null : JSON.stringify(precheckState.state),
    };
    this.#store.transaction(() => {
      if (update.run(run).changes === 1 && fire !== undefined) this.recordFire({ ...input, fire });
    });
  }

  recordFire(input: {
    readonly scheduleId: string;
    readonly taskId: string | null;
    readonly outcome: string;
    readonly outcomeRef?: TextRef;
    readonly outcomeKind: "succeeded" | "failed" | "skipped";
    readonly fire: ScheduleFireEntry;
    readonly now: string;
  }): void {
    const [outcomeKey, outcomeParams] = textRefColumns(input.outcomeRef);
    const row = {
      scheduleId: input.scheduleId,
      fireTime: input.fire.fireTime,
      outcomeKind: input.outcomeKind,
      outcome: input.outcome,
      outcomeKey,
      outcomeParams,
      reasonCode: input.fire.reasonCode,
      retryCount: input.fire.retryCount ?? 0,
      taskId: input.taskId,
      now: input.now,
    };
    this.#store.transaction(() => {
      // A fire kept due is refused again every sweep: the same try of a fire for the same reason is one row, kept current.
      const same = this.#store.handle
        .prepare(
          `SELECT rowid AS id FROM tavi_schedule_fires
            WHERE schedule_id = @scheduleId AND fire_time = @fireTime AND reason_code = @reasonCode AND retry_count = @retryCount
            ORDER BY rowid DESC LIMIT 1`,
        )
        .get(row) as { readonly id: number } | undefined;
      if (same !== undefined) {
        this.#store.handle
          .prepare(
            `UPDATE tavi_schedule_fires
                SET outcome_kind = @outcomeKind, outcome = @outcome, outcome_key = @outcomeKey, outcome_params_json = @outcomeParams,
                    task_id = COALESCE(@taskId, task_id), at = @now
              WHERE rowid = @id`,
          )
          .run({ ...row, id: same.id });
        return;
      }
      const inserted = this.#store.handle
        .prepare(
          `INSERT INTO tavi_schedule_fires (schedule_id, fire_time, outcome_kind, outcome, outcome_key, outcome_params_json, reason_code, task_id, at, retry_count)
           SELECT @scheduleId, @fireTime, @outcomeKind, @outcome, @outcomeKey, @outcomeParams, @reasonCode, @taskId, @now, @retryCount
            WHERE EXISTS (SELECT 1 FROM tavi_schedules WHERE schedule_id = @scheduleId)`,
        )
        .run(row);
      if (inserted.changes === 0) return;
      // Refusals are pruned under their own cap, so a stream of them never pushes the schedule's own fires out.
      const refusal = SCHEDULE_REFUSALS.includes(input.fire.reasonCode);
      const refusals = SCHEDULE_REFUSALS.map((reason) => `'${reason}'`).join(", ");
      this.#store.handle
        .prepare(
          `DELETE FROM tavi_schedule_fires
            WHERE schedule_id = @scheduleId AND reason_code ${refusal ? "IN" : "NOT IN"} (${refusals})
              AND rowid NOT IN (SELECT rowid FROM tavi_schedule_fires
                                 WHERE schedule_id = @scheduleId AND reason_code ${refusal ? "IN" : "NOT IN"} (${refusals})
                                 ORDER BY at DESC, rowid DESC LIMIT @kept)`,
        )
        .run({ scheduleId: input.scheduleId, kept: refusal ? SCHEDULE_REFUSALS_KEPT : SCHEDULE_FIRES_KEPT });
    });
  }

  listFires(scheduleId: string, limit: number): readonly ScheduleFireRecord[] {
    assertPositiveLimit(limit, "listFires");
    const rows = this.#store.handle
      .prepare(
        `SELECT schedule_id, fire_time, outcome_kind, outcome, outcome_key, outcome_params_json, reason_code, task_id, at, retry_count FROM tavi_schedule_fires
          WHERE schedule_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(scheduleId, Math.min(limit, SCHEDULE_FIRES_KEPT)) as ScheduleFireRow[];
    return rows.map(toScheduleFire);
  }

  latestFires(scheduleIds: readonly string[], limit: number): readonly (readonly ScheduleFireRecord[])[] {
    assertPositiveLimit(limit, "latestFires");
    if (scheduleIds.length === 0) return [];
    // Each schedule's newest fires through `tavi_schedule_fires_recent_idx`, `limit` rows a schedule at most.
    const rows = this.#store.handle
      .prepare(
        `SELECT f.schedule_id, f.fire_time, f.outcome_kind, f.outcome, f.outcome_key, f.outcome_params_json, f.reason_code, f.task_id, f.at, f.retry_count
           FROM json_each(?) j JOIN tavi_schedule_fires f
             ON f.rowid IN (SELECT rowid FROM tavi_schedule_fires WHERE schedule_id = j.value ORDER BY at DESC, rowid DESC LIMIT ?)
          ORDER BY f.at DESC, f.rowid DESC`,
      )
      .all(JSON.stringify([...new Set(scheduleIds)]), Math.min(limit, SCHEDULE_FIRES_KEPT)) as ScheduleFireRow[];
    const fires = new Map<string, ScheduleFireRecord[]>();
    for (const row of rows) {
      const list = fires.get(row.schedule_id);
      if (list === undefined) fires.set(row.schedule_id, [toScheduleFire(row)]);
      else list.push(toScheduleFire(row));
    }
    return scheduleIds.map((scheduleId) => fires.get(scheduleId) ?? []);
  }

  recordRunIfMarked(input: {
    readonly scheduleId: string;
    readonly expectedMarker: string;
    readonly outcome: string;
    readonly outcomeKind: "failed";
    readonly fire?: ScheduleFireEntry;
    readonly now: string;
  }): boolean {
    // A compare-and-set, not a read-then-write: the orphan scan runs concurrently
    // with the sweeps, and `recordRun`'s unconditional UPDATE let a late scan
    // overwrite a run that had just completed — including its dispatch marker,
    // which hid the next real orphan.
    const update = this.#store.handle.prepare(
      `UPDATE tavi_schedules
            SET last_outcome = @outcome,
                consecutive_failures = consecutive_failures + 1,
                updated_at = @now
          WHERE schedule_id = @scheduleId AND last_outcome = @expectedMarker`,
    );
    const { fire, ...run } = input;
    return this.#store.transaction(() => {
      if (update.run(run).changes !== 1) return false;
      if (fire !== undefined) this.recordFire({ ...run, taskId: null, fire });
      return true;
    });
  }

  setEnabled(input: {
    readonly scheduleId: string;
    readonly enabled: boolean;
    readonly nextRunAt: string | null;
    readonly now: string;
  }): boolean {
    // A person decided: whatever paused it is no longer why it is off, and
    // resuming a paused schedule gives it its whole failure count again.
    const result = this.#store.handle
      .prepare(
        `UPDATE tavi_schedules
            SET consecutive_failures = CASE WHEN @enabled = 1 AND enabled = 0 THEN 0 ELSE consecutive_failures END,
                enabled = @enabled, next_run_at = @nextRunAt, paused_reason = NULL,
                retry_count = 0, retry_of_fire_time = NULL, updated_at = @now
          WHERE schedule_id = @scheduleId`,
      )
      .run({ ...input, enabled: input.enabled ? 1 : 0 });
    return result.changes > 0;
  }

  setWebhook(input: {
    readonly scheduleId: string;
    readonly secretHash: string | null;
    readonly signingKeyEncrypted?: string | null;
    readonly now: string;
  }): boolean {
    if (input.secretHash !== null && !/^[0-9a-f]{64}$/.test(input.secretHash))
      throw new TaviError("INVALID_INPUT", "A webhook secret is kept as its SHA-256, 64 lower-case hex digits");
    const result = this.#store.handle
      .prepare(
        `UPDATE tavi_schedules
            SET webhook_secret_hash = @secretHash,
                webhook_signing_key_enc = @signingKeyEncrypted,
                webhook_since = CASE WHEN @secretHash IS NULL THEN NULL ELSE @now END,
                updated_at = @now
          WHERE schedule_id = @scheduleId`,
      )
      .run({
        scheduleId: input.scheduleId,
        secretHash: input.secretHash,
        signingKeyEncrypted: input.secretHash === null ? null : (input.signingKeyEncrypted ?? null),
        now: input.now,
      });
    return result.changes > 0;
  }

  webhookSecretHash(scheduleId: string): string | undefined {
    const row = this.#store.handle.prepare("SELECT webhook_secret_hash FROM tavi_schedules WHERE schedule_id = ?").get(scheduleId) as
      | { readonly webhook_secret_hash: string | null }
      | undefined;
    return row?.webhook_secret_hash ?? undefined;
  }

  webhookSigningKey(scheduleId: string): string | undefined {
    const row = this.#store.handle
      .prepare("SELECT webhook_signing_key_enc FROM tavi_schedules WHERE schedule_id = ? AND webhook_secret_hash IS NOT NULL")
      .get(scheduleId) as { readonly webhook_signing_key_enc: string | null } | undefined;
    return row?.webhook_signing_key_enc ?? undefined;
  }

  hasWebhooks(): boolean {
    return this.#store.handle.prepare("SELECT 1 FROM tavi_schedules WHERE webhook_secret_hash IS NOT NULL LIMIT 1").get() !== undefined;
  }

  webhookScheduleIds(): readonly string[] {
    const rows = this.#store.handle
      .prepare("SELECT schedule_id FROM tavi_schedules WHERE webhook_secret_hash IS NOT NULL")
      .all() as readonly {
      readonly schedule_id: string;
    }[];
    return rows.map((row) => row.schedule_id);
  }

  setEmailTrigger(input: { readonly scheduleId: string; readonly trigger: ScheduleEmailTrigger | null; readonly now: string }): boolean {
    const trigger = input.trigger === null ? null : ScheduleEmailTriggerSchema.parse(input.trigger);
    const result = this.#store.handle
      .prepare("UPDATE tavi_schedules SET email_trigger_json = @trigger, updated_at = @now WHERE schedule_id = @scheduleId")
      .run({ scheduleId: input.scheduleId, trigger: trigger === null ? null : JSON.stringify(trigger), now: input.now });
    return result.changes > 0;
  }

  emailTriggered(connectionId: string): readonly ScheduleRecord[] {
    const rows = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_schedules
          WHERE email_trigger_json IS NOT NULL
            AND (CASE WHEN json_valid(email_trigger_json) THEN json_extract(email_trigger_json, '$.connectionId') END) = ?
          ORDER BY name`,
      )
      .all(connectionId) as ScheduleRow[];
    // An unreadable row fires nothing: only a trigger read back whole listens.
    return rows.flatMap((row) => {
      const record = tryScheduleRecord(row);
      return record?.emailTrigger?.connectionId === connectionId ? [record] : [];
    });
  }

  finish(input: { readonly scheduleId: string; readonly now: string }): boolean {
    const result = this.#store.handle
      .prepare(
        `UPDATE tavi_schedules
            SET enabled = 0, updated_at = @now
          WHERE schedule_id = @scheduleId AND enabled = 1 AND next_run_at IS NULL`,
      )
      .run(input);
    return result.changes > 0;
  }

  armRetry(input: {
    readonly scheduleId: string;
    readonly expectedNextRunAt: string | null;
    readonly retryAt: string;
    readonly retry: ScheduleRetry;
    readonly now: string;
  }): boolean {
    // On the pointer the fire's claim armed: an edit, a pause or another fire
    // since then moved it, and the retry is then not this fire's to arm.
    const result = this.#store.handle
      .prepare(
        `UPDATE tavi_schedules
            SET next_run_at = @retryAt, retry_count = @count, retry_of_fire_time = @ofFireTime, updated_at = @now
          WHERE schedule_id = @scheduleId AND enabled = 1 AND next_run_at IS @expectedNextRunAt`,
      )
      .run({
        scheduleId: input.scheduleId,
        expectedNextRunAt: input.expectedNextRunAt,
        retryAt: input.retryAt,
        count: input.retry.count,
        ofFireTime: input.retry.ofFireTime,
        now: input.now,
      });
    return result.changes > 0;
  }

  pauseForFailures(input: {
    readonly scheduleId: string;
    readonly failures: number;
    readonly fireTime: string;
    readonly outcome: string;
    readonly now: string;
  }): boolean {
    const pause = this.#store.handle.prepare(
      `UPDATE tavi_schedules
            SET enabled = 0, next_run_at = NULL, paused_reason = 'failures',
                retry_count = 0, retry_of_fire_time = NULL, updated_at = @now
          WHERE schedule_id = @scheduleId AND enabled = 1 AND next_run_at IS NOT NULL AND consecutive_failures >= @failures
            AND NOT EXISTS (SELECT 1 FROM tavi_routine_triggers t WHERE t.schedule_id = tavi_schedules.schedule_id)`,
    );
    return this.#store.transaction(() => {
      if (pause.run({ scheduleId: input.scheduleId, failures: input.failures, now: input.now }).changes !== 1) return false;
      this.recordFire({
        scheduleId: input.scheduleId,
        taskId: null,
        outcome: input.outcome,
        outcomeKind: "skipped",
        fire: { fireTime: input.fireTime, reasonCode: "paused" },
        now: input.now,
      });
      return true;
    });
  }

  update(input: {
    readonly scheduleId: string;
    readonly prompt?: string;
    readonly spec?: ScheduleSpec;
    readonly autoApproveTools?: readonly string[];
    readonly agentId?: string | null;
    readonly alert?: ScheduleAlertTarget | null;
    readonly humanCheckpoints?: ScheduleHumanCheckpoints;
    readonly deliverTo?: ScheduleDeliveryTarget | null;
    readonly maxRunMinutes?: number;
    readonly maxTokens?: number | null;
    readonly folder?: string | null;
    readonly notify?: ScheduleNotify;
    readonly precheck?: SchedulePrecheck | null;
    readonly watch?: boolean;
    readonly missedRunPolicy?: MissedRunPolicy;
    readonly nextRunAt?: string | null;
    readonly now: string;
  }): boolean {
    // Per-column COALESCE-style conditional SETs rather than a read-merge-write:
    // an operator editing the prompt must not be able to clobber a `next_run_at`
    // the scheduler advanced between the CLI's read and its write. `alert` is
    // the one field that distinguishes "not supplied" (undefined) from "clear
    // it" (null), which is why it cannot use the same `!== undefined` test.
    const sets: string[] = ["updated_at = @now"];
    const params: Record<string, unknown> = { scheduleId: input.scheduleId, now: input.now };
    if (input.prompt !== undefined) {
      sets.push("prompt = @prompt");
      params["prompt"] = input.prompt;
    }
    if (input.spec !== undefined) {
      sets.push("spec_json = @specJson");
      params["specJson"] = JSON.stringify(input.spec);
    }
    if (input.autoApproveTools !== undefined) {
      sets.push("auto_approve_tools_json = @autoApproveToolsJson");
      params["autoApproveToolsJson"] = JSON.stringify(input.autoApproveTools);
    }
    if (input.agentId !== undefined) {
      // `null` clears the persona; `undefined` means "not supplied", the same
      // distinction `alert` makes.
      sets.push("agent_id = @agentId");
      params["agentId"] = input.agentId;
    }
    if (input.alert !== undefined) {
      sets.push("alert_json = @alertJson");
      params["alertJson"] = input.alert === null ? null : JSON.stringify(input.alert);
    }
    if (input.missedRunPolicy !== undefined) {
      sets.push("missed_run_policy = @missedRunPolicy");
      params["missedRunPolicy"] = input.missedRunPolicy;
    }
    if (input.humanCheckpoints !== undefined || input.alert === null) {
      // Asking needs somewhere to ask: refused whichever of the two this edit changes.
      const before = this.#store.handle
        .prepare("SELECT alert_json, human_checkpoints FROM tavi_schedules WHERE schedule_id = ?")
        .get(input.scheduleId) as { readonly alert_json: string | null; readonly human_checkpoints: string | null } | undefined;
      const alertAfter = input.alert === undefined ? (before?.alert_json ?? null) : input.alert;
      refuseCheckpointsWithoutAlert(
        input.humanCheckpoints ?? (before?.human_checkpoints === "ask-with-default" ? "ask-with-default" : "off"),
        alertAfter ?? undefined,
      );
    }
    if (input.humanCheckpoints !== undefined) {
      sets.push("human_checkpoints = @humanCheckpoints");
      params["humanCheckpoints"] = input.humanCheckpoints === "ask-with-default" ? input.humanCheckpoints : null;
    }
    if (input.deliverTo !== undefined) {
      sets.push("deliver_to = @deliverTo");
      params["deliverTo"] = input.deliverTo;
    }
    if (input.maxRunMinutes !== undefined) {
      sets.push("max_run_minutes = @maxRunMinutes");
      params["maxRunMinutes"] = input.maxRunMinutes;
    }
    if (input.maxTokens !== undefined) {
      sets.push("max_tokens = @maxTokens");
      params["maxTokens"] = input.maxTokens;
    }
    if (input.folder !== undefined) {
      sets.push("folder_path = @folderPath");
      params["folderPath"] = input.folder;
    }
    if (input.notify !== undefined) {
      sets.push("notify = @notify");
      params["notify"] = storedNotify(input.notify);
    }
    if (input.precheck !== undefined) {
      // A reading is of the pre-check that took it: another pre-check starts from no reading.
      sets.push(
        "precheck_state_json = CASE WHEN precheck_json IS @precheckJson THEN precheck_state_json ELSE NULL END",
        "precheck_json = @precheckJson",
      );
      params["precheckJson"] = input.precheck === null ? null : storedPrecheck(input.precheck);
    }
    if (input.watch !== undefined || input.precheck === null) {
      // A watcher's trigger is its pre-check: with none, it is not one.
      sets.push(
        input.precheck === undefined
          ? "watch = CASE WHEN precheck_json IS NULL THEN 0 ELSE @watch END"
          : "watch = CASE WHEN @precheckJson IS NULL THEN 0 ELSE @watch END",
      );
      params["watch"] = input.watch === undefined ? 0 : input.watch ? 1 : 0;
    }
    if (input.prompt !== undefined || input.alert !== undefined || input.deliverTo !== undefined || input.notify !== undefined) {
      // What was last delivered is only "the same result" for the same prompt sent the same way.
      sets.push("last_delivered_hash = NULL");
    }
    if (input.nextRunAt !== undefined) {
      // A new time means a new pointer: a retry armed at the old one is gone with it.
      sets.push("next_run_at = @nextRunAt", "retry_count = 0", "retry_of_fire_time = NULL");
      params["nextRunAt"] = input.nextRunAt;
    }
    const result = this.#store.handle.prepare(`UPDATE tavi_schedules SET ${sets.join(", ")} WHERE schedule_id = @scheduleId`).run(params);
    return result.changes > 0;
  }

  scheduledUsage(input: { readonly workspaceId: string; readonly since: string; readonly until: string }): ScheduledSpend {
    // The month's calls are read by started_at, through the (state, started_at) index; each counts when
    // its run, or the root of the worker that made it, is one of the workspace's schedule-fired tasks or
    // routine run tasks. So the work grows with the month's calls, not the workspace's history.
    const row = this.#store.handle
      .prepare(
        `SELECT
           coalesce(sum(coalesce(json_extract(a.data, '$.usage.totalTokens'), coalesce(json_extract(a.data, '$.usage.inputTokens'), 0) + coalesce(json_extract(a.data, '$.usage.outputTokens'), 0))), 0) AS tokens,
           coalesce(sum(json_extract(a.data, '$.estimatedUsd')), 0) AS usd,
           coalesce(sum(CASE WHEN json_extract(a.data, '$.usage') IS NOT NULL AND json_extract(a.data, '$.estimatedUsd') IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
         FROM tavi_provider_attempts a
         LEFT JOIN tavi_agent_delegation_admissions d ON d.worker_task_id = a.run_id AND d.workspace_id = @workspaceId
         WHERE a.state IN ('started', 'completed', 'failed', 'aborted', 'uncertain')
           AND a.started_at >= @since AND a.started_at < @until
           AND (
             EXISTS (SELECT 1 FROM tavi_tasks t WHERE t.task_id = coalesce(d.root_task_id, a.run_id) AND t.workspace_id = @workspaceId AND t.origin = 'schedule')
             OR EXISTS (SELECT 1 FROM tavi_routine_runs r WHERE r.task_id = coalesce(d.root_task_id, a.run_id) AND r.workspace_id = @workspaceId)
           )`,
      )
      .get(input) as { readonly tokens: number; readonly usd: number; readonly unpriced: number };
    return { tokens: row.tokens, usd: row.unpriced > 0 ? null : Math.round(row.usd * 10_000) / 10_000 };
  }
}

function toScheduleFire(row: ScheduleFireRow): ScheduleFireRecord {
  const outcomeRef = storedTextRef(row.outcome_key, row.outcome_params_json);
  return {
    scheduleId: row.schedule_id,
    fireTime: row.fire_time,
    outcomeKind: row.outcome_kind,
    outcome: row.outcome,
    ...(outcomeRef === undefined ? {} : { outcomeRef }),
    reasonCode: row.reason_code,
    taskId: row.task_id,
    at: row.at,
    ...(row.retry_count > 0 ? { retryCount: row.retry_count } : {}),
  };
}

interface ScheduleFireRow {
  readonly schedule_id: string;
  readonly fire_time: string;
  readonly outcome_kind: ScheduleFireRecord["outcomeKind"];
  readonly outcome: string;
  /** The outcome by key (`0032_stored_text_keys`); NULL on a fire from before, or one in a run's own words. */
  readonly outcome_key: string | null;
  readonly outcome_params_json: string | null;
  readonly reason_code: ScheduleFireRecord["reasonCode"];
  readonly task_id: string | null;
  readonly at: string;
  readonly retry_count: number;
}

interface ScheduleRow {
  readonly schedule_id: string;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly name: string;
  readonly prompt: string;
  readonly spec_json: string;
  readonly missed_run_policy: string;
  readonly auto_approve_tools_json: string;
  readonly agent_id: string | null;
  readonly alert_json: string | null;
  readonly human_checkpoints: string | null;
  /** `home`: the run's result is posted into the person's Home when it settles. */
  readonly deliver_to: string | null;
  /** NULL: the default limit (`SCHEDULE_DEFAULT_MAX_RUN_MINUTES`). */
  readonly max_run_minutes: number | null;
  /** NULL: no token ceiling. */
  readonly max_tokens: number | null;
  /** NULL: each fire's own managed folder. */
  readonly folder_path: string | null;
  /** NULL: `always`. */
  readonly notify: string | null;
  readonly last_delivered_hash: string | null;
  /** NULL: no pre-check. */
  readonly precheck_json: string | null;
  /** What the pre-check last read; NULL before a run took a reading. */
  readonly precheck_state_json: string | null;
  /** 1: a watcher, whose pre-check is its trigger. */
  readonly watch: number;
  /** The SHA-256 (hex) of its webhook's secret; NULL: no webhook. Never read into a record. */
  readonly webhook_secret_hash: string | null;
  /** Its webhook's signing key, encrypted with the credential key; NULL: no webhook, or no signed calls. Never read into a record. */
  readonly webhook_signing_key_enc: string | null;
  /** When its webhook's current secret was made; NULL with no webhook. */
  readonly webhook_since: string | null;
  /** Its email trigger (`ScheduleEmailTrigger`); NULL: none is on. */
  readonly email_trigger_json: string | null;
  readonly enabled: number;
  /** NULL: not paused, or paused by a person. */
  readonly paused_reason: string | null;
  /** Which retry is armed at `next_run_at`, with the fire it retries; 0 and NULL when none is. */
  readonly retry_count: number;
  readonly retry_of_fire_time: string | null;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_task_id: string | null;
  readonly last_outcome: string | null;
  readonly consecutive_failures: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** `always` is the default, stored as NULL like every schedule made before there was a choice. */
function storedNotify(notify: ScheduleNotify | undefined): string | null {
  return notify === undefined || notify === "always" ? null : notify;
}

/** A pre-check as stored: its fields in one order, so the same pre-check is always the same text. */
function storedPrecheck(precheck: SchedulePrecheck): string {
  return JSON.stringify({ kind: precheck.kind, target: precheck.target });
}

/** A schedule that may ask needs an alert destination to ask in. */
function refuseCheckpointsWithoutAlert(checkpoints: string | undefined, alert: unknown): void {
  if (checkpoints === "ask-with-default" && (alert === undefined || alert === null)) {
    throw new TaviError(
      "INVALID_INPUT",
      "A schedule that asks questions needs an alert destination to ask in (--alert-connection and --alert-destination)",
    );
  }
}

/**
 * A stored row is re-validated through the same Zod schemas the CLI and the
 * scheduler use, so a hand-edited or older row cannot become an unvalidated
 * value inside the trigger calculator or — far worse — an unvalidated
 * **allowlist**. Returns `undefined` for a row that does not validate; the
 * caller decides whether that is a hard error (`get`) or a row to skip and
 * report (`listDue`).
 *
 * Every field that decides behaviour is validated, not just the spec:
 *
 *  - `autoApproveTools` was previously read back with a bare `JSON.parse`, so a
 *    hand-edited `["*"]` silently auto-approved *every* tool for an unattended
 *    run, including `sandbox.run`. A malformed allowlist is now a fail-closed
 *    unreadable row rather than a wider grant than the operator wrote.
 *  - a malformed `alert_json` was silently dropped, which meant an operator who
 *    edited the alert target lost all failure alerts without a word. It is now
 *    an unreadable row, so the loss is visible instead of silent.
 */
function tryScheduleRecord(row: ScheduleRow): ScheduleRecord | undefined {
  let specRaw: unknown;
  let alertRaw: unknown;
  let toolsRaw: unknown;
  let precheckRaw: unknown;
  let precheckStateRaw: unknown;
  try {
    specRaw = JSON.parse(row.spec_json) as unknown;
    toolsRaw = JSON.parse(row.auto_approve_tools_json) as unknown;
    alertRaw = row.alert_json === null ? undefined : (JSON.parse(row.alert_json) as unknown);
    precheckRaw = row.precheck_json === null ? undefined : (JSON.parse(row.precheck_json) as unknown);
    precheckStateRaw = row.precheck_state_json === null ? undefined : (JSON.parse(row.precheck_state_json) as unknown);
  } catch {
    return undefined;
  }
  const spec = ScheduleSpecSchema.safeParse(specRaw);
  const missedRunPolicy = MissedRunPolicySchema.safeParse(row.missed_run_policy);
  // The syntax alone: a stale `web.*` entry saved before such patterns were
  // refused matches nothing, and must not make its schedule unreadable.
  const tools = z.array(z.string().min(1).max(128).regex(SCHEDULE_TOOL_PATTERN)).max(128).safeParse(toolsRaw);
  const alert = alertRaw === undefined ? undefined : ScheduleAlertTargetSchema.safeParse(alertRaw);
  // Anything but the one value it can hold is a hand edit: unreadable, never read as asking.
  const checkpoints = row.human_checkpoints === null ? undefined : z.enum(SCHEDULE_HUMAN_CHECKPOINTS).safeParse(row.human_checkpoints);
  const deliverTo = row.deliver_to === null ? undefined : z.enum(SCHEDULE_DELIVERY_TARGETS).safeParse(row.deliver_to);
  const maxRunMinutes = row.max_run_minutes === null ? undefined : ScheduleMaxRunMinutesSchema.safeParse(row.max_run_minutes);
  const maxTokens = row.max_tokens === null ? undefined : ScheduleMaxTokensSchema.safeParse(row.max_tokens);
  const notify = row.notify === null ? undefined : ScheduleNotifySchema.safeParse(row.notify);
  const pausedReason = row.paused_reason === null ? undefined : z.enum(SCHEDULE_PAUSED_REASONS).safeParse(row.paused_reason);
  // A hand-edited pre-check is unreadable, never a fetch of an address nobody checked.
  const precheck = precheckRaw === undefined ? undefined : SchedulePrecheckSchema.safeParse(precheckRaw);
  // A reading that does not parse is only forgotten: the next check takes a new one.
  const precheckState = precheckStateRaw === undefined ? undefined : SchedulePrecheckStateSchema.safeParse(precheckStateRaw);
  // A hand-edited email trigger that does not parse listens to nothing, and leaves the rest of the schedule readable.
  const emailTrigger = emailTriggerOf(row.email_trigger_json);
  if (
    !spec.success ||
    !missedRunPolicy.success ||
    !tools.success ||
    (alert !== undefined && !alert.success) ||
    (checkpoints !== undefined && !checkpoints.success) ||
    (deliverTo !== undefined && !deliverTo.success) ||
    (maxRunMinutes !== undefined && !maxRunMinutes.success) ||
    (maxTokens !== undefined && !maxTokens.success) ||
    (notify !== undefined && !notify.success) ||
    (pausedReason !== undefined && !pausedReason.success) ||
    (precheck !== undefined && !precheck.success)
  )
    return undefined;
  return {
    scheduleId: row.schedule_id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    name: row.name,
    prompt: row.prompt,
    spec: spec.data,
    missedRunPolicy: missedRunPolicy.data,
    autoApproveTools: tools.data,
    ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
    ...(alert === undefined || !alert.success ? {} : { alert: alert.data }),
    ...(checkpoints === undefined || !checkpoints.success || checkpoints.data === "off" ? {} : { humanCheckpoints: checkpoints.data }),
    ...(deliverTo === undefined || !deliverTo.success ? {} : { deliverTo: deliverTo.data }),
    ...(maxRunMinutes === undefined || !maxRunMinutes.success ? {} : { maxRunMinutes: maxRunMinutes.data }),
    ...(maxTokens === undefined || !maxTokens.success ? {} : { maxTokens: maxTokens.data }),
    ...(row.folder_path === null ? {} : { folder: row.folder_path }),
    ...(notify === undefined || !notify.success || notify.data === "always" ? {} : { notify: notify.data }),
    ...(row.last_delivered_hash === null ? {} : { lastDeliveredHash: row.last_delivered_hash }),
    ...(precheck === undefined || !precheck.success ? {} : { precheck: precheck.data }),
    ...(precheck === undefined || precheckState === undefined || !precheckState.success ? {} : { precheckState: precheckState.data }),
    ...(row.webhook_secret_hash === null ? {} : { webhook: { since: row.webhook_since ?? row.updated_at } }),
    ...(row.watch === 1 && precheck?.success === true ? { watch: true as const } : {}),
    ...(emailTrigger?.success === true ? { emailTrigger: emailTrigger.data } : {}),
    enabled: row.enabled === 1,
    ...(pausedReason === undefined || !pausedReason.success ? {} : { pausedReason: pausedReason.data }),
    ...(row.retry_of_fire_time === null || row.retry_count < 1
      ? {}
      : { retry: { count: row.retry_count, ofFireTime: row.retry_of_fire_time } }),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunTaskId: row.last_run_task_id,
    lastOutcome: row.last_outcome,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A row's email trigger as kept, parsed; `undefined` for none, or one that is not JSON. */
function emailTriggerOf(json: string | null): ReturnType<typeof ScheduleEmailTriggerSchema.safeParse> | undefined {
  if (json === null) return undefined;
  try {
    return ScheduleEmailTriggerSchema.safeParse(JSON.parse(json));
  } catch {
    return undefined;
  }
}
