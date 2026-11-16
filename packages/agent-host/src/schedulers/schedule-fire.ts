import {
  type AdmissionResult,
  type InvocationContext,
  MISSED_RUN_GRACE_MS,
  ON_TIME_TOLERANCE_MS,
  ROUTINE_MIN_FREE_BYTES,
  SCHEDULE_CHECKPOINT_TASK_POLICY,
  SCHEDULE_RETRY_BACKOFF_MINUTES,
  SCHEDULE_TASK_POLICY,
  type ScheduleRecord,
  TaviError,
  lateRunNote,
  nextOccurrence,
  scheduleSpecEnds,
  scheduleSpecText,
  untrustedLabel,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";

import { startRunBudget } from "./run-budget.js";
import { pauseIfFailing, sendAlert } from "./schedule-alerts.js";
import { carryBudget, overlapText, overrunOutcome, stopOverrunRun } from "./schedule-budget.js";
import { latestDueOccurrence, recordFinished, recordUnrunOccurrences } from "./schedule-cadence.js";
import type { FireOutcome, ScheduleSchedulerDependencies } from "./schedule-dependencies.js";
import { type Suspension, holdWhileSuspended, releaseEndedHolds, suspensionOf } from "./schedule-holds.js";
import { type RoundRefusal, resolveSuspensions } from "./schedule-policy.js";
import { type PrecheckRun, precheckFire } from "./schedule-precheck.js";
import { dispatchMarkerFireTime } from "./schedule-reconcile.js";
import { reportFire } from "./schedule-report.js";
import {
  type FireOptions,
  type ScheduleEmailFire,
  type ScheduleWebhookFire,
  countedKind,
  countsTowardPause,
  definedRetry,
  emailRunNote,
  fireEntry,
  manualRunOf,
  runLabel,
  scheduleRunContext,
  scheduleRunKey,
  triggerOf,
  webhookRunNote,
  withEventCeiling,
} from "./schedule-run-kind.js";
import { admitUnattended } from "./unattended-admission.js";

/**
 * How much free space a fire needs before it will start.
 *
 * The number itself lives in `@tavi/contracts`, because the runtime's admission
 * checks and the readiness view refuse on the same floor; this name remains so the
 * owner process and the CLI disk report read it from the scheduler they already
 * import. See the constant's own comment for why the value is what it is.
 */
export const MIN_FREE_BYTES_FOR_A_FIRE = ROUTINE_MIN_FREE_BYTES;

/**
 * One fire of one schedule: claim it, make sure the previous run is not still
 * in flight, admit, answer the run's suspensions by policy, and record how it
 * ended.
 *
 * Never throws for a run-level failure — a failed brief must be *recorded and
 * alerted*, not propagated into the sweep, where it would take the whole tick
 * (and therefore every other schedule) down with it.
 */
export async function fireSchedule(
  schedule: ScheduleRecord,
  fireTime: string,
  deps: ScheduleSchedulerDependencies,
  options: FireOptions = {},
): Promise<FireOutcome> {
  return fireTracked(schedule, fireTime, deps, options, {});
}

/** What a fire leaves for whoever ran it, filled in as it goes. */
export interface FireEnd {
  /** The occurrence the fire is for, which try of it, and the identity its alerts dedupe on, once resolved. */
  slot?: string;
  retryCount?: number;
  alertIdentity?: string;
  /** Set when its claim was the schedule's last: the schedule finishes once the fire has settled. */
  last?: boolean;
  /** Set when its run is suspended to go on: what carries it on settles the last occurrence, not the fire. */
  suspended?: boolean;
  /** Its claim on the schedule in the in-flight registry (`claimSchedule`), released once the fire ends. */
  release?: () => void;
}

/** `fireSchedule`, telling `end` how far the fire got, so a fire that throws is recorded against its own occurrence. */
export async function fireTracked(
  schedule: ScheduleRecord,
  fireTime: string,
  deps: ScheduleSchedulerDependencies,
  options: FireOptions,
  end: FireEnd,
): Promise<FireOutcome> {
  if (options.claim !== undefined) end.release = options.claim;
  try {
    return await fireOnce(schedule, fireTime, deps, options, end);
  } finally {
    end.release?.();
    if (end.last === true && end.suspended !== true && end.slot !== undefined) await recordFinished(schedule, end.slot, deps);
  }
}

/** One fire, as `fireSchedule` describes, telling `ended` how far it got. */
async function fireOnce(
  schedule: ScheduleRecord,
  fireTime: string,
  deps: ScheduleSchedulerDependencies,
  options: FireOptions,
  ended: FireEnd,
): Promise<FireOutcome> {
  const manual = manualRunOf(options);
  const owned = await deps.routineDispatch?.(schedule, fireTime, manual !== false);
  if (owned !== undefined) return owned;
  const now = deps.now();
  const nowMs = Date.parse(now);
  /**
   * The identity alerts dedupe on.
   *
   * A scheduled fire is identified by its fire pointer, which is deterministic —
   * a re-dispatch of the same fire must not send a second copy. A manual
   * `run-now` has no fire pointer, and its wall clock is not an identity: two
   * runs in the same millisecond (or any coarse injected clock) would share one
   * and the outbox would swallow the second run's alert. So the manual path
   * generates its nonce **once**, uses it for the admission's `operationKey` and
   * for its alerts, and the two identities agree.
   */
  const manualId = manual ? deps.newId(manual.reason) : undefined;

  // The next fire is computed *before* claiming, because claiming is
  // single-shot: there is no second chance to compute it once the pointer moved.
  //
  // A spec that cannot produce a next occurrence (a hand-edited zone or time)
  // would otherwise throw on every tick forever, logging an error every 30s and
  // never advancing. Such a schedule is disabled with the reason recorded: it is
  // broken, and an unattended deployment needs that said once, loudly, rather
  // than as perpetual noise. A spec that ends (`once`, `until`) and has no next
  // occurrence is not broken: this fire is its last, its claim arms no next
  // fire (`null`), and once it has settled the schedule is finished quietly.
  let nextRunAt: string | null;
  try {
    const next = nextOccurrence(schedule.spec, new Date(nowMs));
    if (next === undefined && !scheduleSpecEnds(schedule.spec))
      throw new TaviError("INVALID_INPUT", `Schedule time ${scheduleSpecText(schedule.spec)} has no next occurrence`);
    nextRunAt = next?.toISOString() ?? null;
  } catch (error) {
    const reason = errorMessage(error);
    await deps.schedules.setEnabled({ scheduleId: schedule.scheduleId, enabled: false, nextRunAt: null, now });
    await deps.schedules.recordRun({
      scheduleId: schedule.scheduleId,
      taskId: null,
      outcome: `disabled: ${reason}`,
      outcomeKind: "skipped",
      fire: fireEntry(manual, fireTime, "disabled"),
      now,
    });
    deps.log({
      level: "error",
      message: "schedule disabled: its spec has no next occurrence",
      detail: { scheduleId: schedule.scheduleId, reason },
    });
    await sendAlert(
      schedule,
      {
        identity: manualId ?? fireTime,
        kind: "spec-disabled",
        text: `Schedule "${schedule.name}" was disabled because its time (${scheduleSpecText(schedule.spec)}) has no next occurrence.`,
      },
      deps,
    );
    return { kind: "refused", reason };
  }

  // The occurrence this fire is for. The stored pointer is the one the owner
  // last armed, and after a long sleep it can be days old while a later
  // occurrence is barely due: waking on Monday at 07:01 with Saturday's 07:00
  // still stored is Monday's 07:00 fire, on time, not Saturday's, two days too
  // late to run. The occurrences in between were missed while nothing ran, and
  // are only logged — the one that is due now is what this fire runs or skips.
  // The pointer itself still names the claim, which is a compare-and-set on it.
  //
  // A retry armed at the pointer (`armRetry`) is that fire tried again: its
  // occurrence is the fire it retries, whose grace it is held to. Unless a
  // regular occurrence came due since, which runs (or is skipped) instead.
  const armed = manual ? undefined : schedule.retry;
  const latest = manual || nowMs - Date.parse(fireTime) <= ON_TIME_TOLERANCE_MS ? fireTime : latestDueOccurrence(schedule, fireTime, nowMs);
  const retry = armed !== undefined && latest === fireTime ? armed : undefined;
  const slot = retry?.ofFireTime ?? latest;
  if (retry === undefined && slot !== fireTime) {
    deps.log({
      level: "warn",
      message: "schedule fires were missed while the owner was not running; running or skipping the latest",
      detail: { scheduleId: schedule.scheduleId, storedFireTime: fireTime, fireTime: slot },
    });
  }
  const alertIdentity = manualId ?? (retry === undefined ? slot : `${slot}:retry:${retry.count}`);
  const retryCount = retry?.count;
  ended.slot = slot;
  ended.alertIdentity = alertIdentity;
  if (retryCount !== undefined) ended.retryCount = retryCount;

  // Whether the run this schedule last started still holds a live lease. Read
  // once and only when needed: a crashed previous run left an expired lease,
  // and that is not a run in flight.
  let previousLive: Promise<boolean> | undefined;
  const previousRunLive = (): Promise<boolean> =>
    (previousLive ??= (async () => {
      if (schedule.lastRunTaskId === null) return false;
      const lease = await deps.executions.current(schedule.lastRunTaskId);
      return lease !== undefined && lease.endedAt === null && lease.leaseExpiresAt > now;
    })());

  // A dispatch marker left by a previous fire means a run started and never
  // reported a result — a crash between the claim and the outcome. Nothing else
  // would ever surface it: `next_run_at` already advanced, so the lost fire is
  // invisible in every other view. Reported once, since silence at 07:00 is
  // the worst outcome. A marker whose run still holds its lease is that run's,
  // still going, and this fire is about to be skipped as an overlap instead.
  const staleMarkerFireTime = dispatchMarkerFireTime(schedule.lastOutcome);
  if (
    staleMarkerFireTime !== undefined &&
    staleMarkerFireTime !== fireTime &&
    staleMarkerFireTime !== slot &&
    !(await previousRunLive()) &&
    // As the startup scan records it: counted as a failed run, and only while the marker is still there.
    (await deps.schedules.recordRunIfMarked({
      scheduleId: schedule.scheduleId,
      expectedMarker: `dispatching the ${staleMarkerFireTime} fire`,
      outcome: `orphaned: the ${staleMarkerFireTime} fire never reported a result`,
      outcomeKind: "failed",
      fire: { fireTime: staleMarkerFireTime, reasonCode: "orphaned" },
      now,
    }))
  ) {
    deps.log({
      level: "error",
      message: "a previous schedule fire never reported an outcome",
      detail: { scheduleId: schedule.scheduleId, fireTime: staleMarkerFireTime },
    });
    // Keyed on the fire the alert is *about*, not the fire that noticed it: the
    // startup scan reports the same orphan with the orphaned fire's time as its
    // identity, and two identities for one event meant the outbox either
    // swallowed the second alert or sent both.
    await sendAlert(
      schedule,
      {
        identity: staleMarkerFireTime,
        kind: "stale-dispatch",
        text: `Schedule "${schedule.name}": the ${staleMarkerFireTime} fire started but never reported a result.`,
      },
      deps,
    );
    await pauseIfFailing(schedule, { fireTime: staleMarkerFireTime, alertIdentity: staleMarkerFireTime }, deps);
  }

  // Missed-run policy (the most likely real-world failure).
  //
  // The decision is about **lateness**, in two bands, and deliberately nothing
  // about when this process started ticking:
  //
  // - late by more than the on-time tolerance but within the 6h window: the
  //   scheduler is merely behind, so the run happens late.
  // - later than the window: nothing ran when it was due (or the machine was
  //   asleep, or the tick loop was starved), and a brief that stale is wrong
  //   rather than merely late, so it is skipped and alerted.
  //
  // "On time" is judged when the sweep listed the fire due (`listedAt`): a sweep
  // runs a few fires at a time, and a fire that waited for a free slot behind
  // others due in the same minute was not late — before, the fifth of six
  // schedules due at 07:00 was recorded "missed" under the `skip` policy and
  // alerted although nothing was down. The 6h ceiling is still judged now, so a
  // brief that waited that long is not run.
  //
  // A previous version also required the fire to *predate this process's first
  // tick* before applying the window. That read "a host that suspends keeps
  // ticking from its own perspective" as "on time", so a laptop that slept
  // through 07:00 ran the brief at 23:00 — the policy's whole case, bypassed.
  // Lateness alone distinguishes the two cases, and
  // a suspended machine cannot produce a *small* lateness for a fire hours old.
  //
  // A manual run (`tavi schedules run-now`) skips this whole branch: the
  // operator asked for it *now*, so "you are late" is not a meaningful thing to
  // say, and consuming the schedule's next fire to honour a manual request
  // would silently skip the real 07:00 run.
  //
  // A retry is on time at the time it was armed for; its 6h is the fire's it retries.
  const slotMs = Date.parse(slot);
  const lateMs = nowMs - slotMs;
  const dueMs = retry === undefined ? slotMs : Date.parse(fireTime);
  const listedLateMs = (options.listedAt === undefined ? nowMs : Math.min(nowMs, Date.parse(options.listedAt))) - dueMs;

  // A full disk is the one failure the alert path cannot report after the
  // fact. `messaging.send` records the outbox row *before* the connector is
  // called, so once the filesystem is full the alert cannot be delivered by the
  // very failure it exists to announce. The floor is therefore a pre-flight with
  // headroom: refuse while there is still room to write the alert, keep the fire
  // due so it runs once space is freed, and fall through to the ordinary missed
  // policy once it is too stale to be worth running at all.
  const freeBytes = deps.freeBytes?.();
  if (freeBytes !== undefined && freeBytes < MIN_FREE_BYTES_FOR_A_FIRE && lateMs <= MISSED_RUN_GRACE_MS) {
    const mib = Math.floor(freeBytes / (1024 * 1024));
    const reason = `refused: only ${mib} MiB free on the data directory's filesystem`;
    // Only to the fire ledger when a dispatch marker is still pending:
    // `recordRun` would overwrite it, and the marker is the only evidence of
    // *which* fire never reported — the startup scan's whole subject. The
    // refusal is still logged and alerted, and the marker survives for the scan.
    // Never for a manual `run-now`: an operator's ad-hoc attempt that did not
    // start is not the schedule's history.
    if (!manual) {
      const refused = { scheduleId: schedule.scheduleId, taskId: null, outcome: reason, outcomeKind: "skipped" as const, now };
      const fire = fireEntry(false, slot, "disk", retryCount);
      if (staleMarkerFireTime === undefined) await deps.schedules.recordRun({ ...refused, fire });
      else await deps.schedules.recordFire({ ...refused, fire });
    }
    deps.log({
      level: "error",
      message: "schedule fire refused: the data directory's filesystem is nearly full",
      detail: { scheduleId: schedule.scheduleId, fireTime: slot, freeBytes },
    });
    // Sent now, while there is still room for the outbox row this alert needs.
    await sendAlert(
      schedule,
      {
        identity: alertIdentity,
        kind: "disk-low",
        text: `Scheduled run "${schedule.name}" did not start: ${reason}. Free space and it will run on the next sweep.`,
      },
      deps,
    );
    return { kind: "refused", reason };
  }

  const late = !manual && (listedLateMs > ON_TIME_TOLERANCE_MS || lateMs > MISSED_RUN_GRACE_MS);
  if (late) {
    const withinGrace = lateMs <= MISSED_RUN_GRACE_MS;
    if (schedule.missedRunPolicy === "skip" || !withinGrace) {
      if (!(await deps.schedules.claimFire({ scheduleId: schedule.scheduleId, fireTime, nextRunAt, now }))) {
        return { kind: "skipped", reason: "already-claimed" };
      }
      if (nextRunAt === null) ended.last = true;
      await recordUnrunOccurrences(schedule, fireTime, slot, armed, deps, now);
      const minutes = Math.round(lateMs / 60_000);
      const reason =
        schedule.missedRunPolicy === "skip"
          ? `skipped: missed by ${minutes}m (policy: skip)`
          : `skipped: missed by ${minutes}m (beyond the 6h catch-up window)`;
      await deps.schedules.recordRun({
        scheduleId: schedule.scheduleId,
        taskId: null,
        outcome: reason,
        outcomeKind: "skipped",
        fire: fireEntry(false, slot, "missed", retryCount),
        now,
      });
      deps.log({ level: "warn", message: "schedule fire missed", detail: { scheduleId: schedule.scheduleId, fireTime: slot, minutes } });
      // A missed fire means the brief will not arrive today, which is exactly
      // the silence that is the worst outcome — so it is alerted even though
      // nothing "failed".
      await sendAlert(
        schedule,
        { identity: alertIdentity, kind: "missed-run", text: `Scheduled run "${schedule.name}" did not run: ${reason}.` },
        deps,
      );
      return { kind: "skipped", reason: "missed" };
    }
    deps.log({
      level: "warn",
      message: "schedule fire is late; catching up",
      detail: { scheduleId: schedule.scheduleId, fireTime: slot, minutes: Math.round(lateMs / 60_000) },
    });
  }
  // A run that catches up, or runs after earlier fires were missed, is told so,
  // since its prompt's "since yesterday" may now reach further back; an on-time
  // one is told nothing. A retry is told it is one, and what it covers.
  const catchUpNote = manual
    ? undefined
    : retry !== undefined
      ? lateRunNote({
          scheduledFor: slot,
          runningAt: now,
          timeZone: schedule.spec.timezone,
          retry: { count: retry.count, of: SCHEDULE_RETRY_BACKOFF_MINUTES.length },
        })
      : late || slot !== fireTime
        ? lateRunNote({
            scheduledFor: slot,
            runningAt: now,
            timeZone: schedule.spec.timezone,
            ...(slot === fireTime ? {} : { missed: true }),
            ...(schedule.lastRunAt === null ? {} : { lastRunAt: schedule.lastRunAt }),
          })
        : undefined;

  // A lapsed hold, or one whose run ended, no longer keeps the schedule in flight.
  await releaseEndedHolds(deps, now);
  if (!manual && !(await deps.schedules.claimFire({ scheduleId: schedule.scheduleId, fireTime, nextRunAt, now }))) {
    // Another dispatcher owns this fire. Not an error: the claim is the lock,
    // and losing it means the other owner is already doing the work.
    return { kind: "skipped", reason: "already-claimed" };
  }
  // In flight from here, before anything else is awaited: a run asked for now while this fire makes its
  // pre-check or is admitted is an overlap, and so is this fire while one asked for now has yet to start.
  // Refused while another fire of the schedule is in flight, as the overlap guard below says.
  const watching = manual !== false && manual.reason === "watch";
  const claim = ended.release ?? deps.inFlight?.claimSchedule(schedule.scheduleId, watching);
  if (claim !== undefined) ended.release = claim;
  const claimRefused = deps.inFlight !== undefined && ended.release === undefined;
  if (!manual && nextRunAt === null) ended.last = true;
  if (!manual) await recordUnrunOccurrences(schedule, fireTime, slot, armed, deps, now);

  // Overlap guard, before this fire writes anything of its own. A *different*
  // fire time than the one claimed, so it cannot be part of the claim itself.
  // Only a live lease counts: a crashed previous run left an expired lease, and
  // treating that as overlap would skip every fire from then on. Each fire
  // admits a fresh task, so a stale lease on the old task never blocks the new
  // one.
  //
  // This reads `lastRunTaskId` from the *stored* row and depends on
  // `markRunning` being called from `admit`'s `onAdmitted` — the lease is held
  // then. Writing the id only after `admit` returned made this predicate
  // impossible to satisfy: `admit` releases the lease in its `finally`, so
  // `endedAt` was already set by the time the id was stored.
  //
  // A fire in flight in this process overlaps too — a manual one included, which
  // records no `lastRunTaskId` until it ends, so the lease check cannot see it.
  // So does a run suspended on a worker or a question until it is carried on.
  // Both refuse this fire's claim on the schedule.
  if (claimRefused || (await previousRunLive())) {
    // The run in flight's dispatch marker is the only evidence of which fire it
    // is, should its owner crash before it reports: the startup scan looks for
    // exactly that text. So the skip is recorded only over an outcome that is
    // not a marker — read fresh, since the run may have written it after this
    // sweep listed the row — and otherwise only to the fire ledger.
    const stored = await deps.schedules.get(schedule.scheduleId);
    const skipped = {
      scheduleId: schedule.scheduleId,
      taskId: null,
      outcome: "skipped: the previous run is still in flight",
      outcomeKind: "skipped" as const,
      fire: fireEntry(manual, slot, "overlap", retryCount),
      now,
    };
    if (dispatchMarkerFireTime(stored?.lastOutcome) === undefined) await deps.schedules.recordRun(skipped);
    else await deps.schedules.recordFire(skipped);
    // A file watcher's run in flight is handling the change this fire would check for: nothing to tell.
    const inFlight = deps.inFlight;
    const watchRunOnly = !manual && claimRefused && !(await previousRunLive()) && inFlight?.watchOnly(schedule.scheduleId) === true;
    deps.log({
      level: watchRunOnly ? "info" : "warn",
      message: watchRunOnly ? "schedule fire skipped: a file-watch run of it is in flight" : "schedule fire skipped for overlap",
      detail: { scheduleId: schedule.scheduleId, fireTime: slot },
    });
    // A run that never ends makes every later fire an overlap: each is told, once.
    if (!watchRunOnly) await sendAlert(schedule, { identity: alertIdentity, kind: "overlap", text: overlapText(schedule, deps) }, deps);
    return { kind: "skipped", reason: "overlap" };
  }

  // A scheduled fire whose pre-check finds nothing new ends here, with no run and
  // no model call; so does a file watcher's check. A manual run is asked for now and is not checked.
  let precheckRun: PrecheckRun | undefined;
  if (watching && schedule.precheck === undefined) {
    deps.log({ level: "warn", message: "a watcher's check found no pre-check to make", detail: { scheduleId: schedule.scheduleId } });
    return { kind: "refused", reason: "the schedule has no pre-check to watch" };
  }
  if ((!manual || watching) && schedule.precheck !== undefined && (deps.precheck !== undefined || watching)) {
    const checked = await precheckFire(schedule, schedule.precheck, { slot, retryCount, alertIdentity, manual }, deps);
    if ("ended" in checked) return checked.ended;
    precheckRun = checked;
  }

  // Persisted *before* the run so a crash between here and the outcome leaves
  // evidence of which fire never reported; see the stale-marker check above.
  if (!manual) {
    await deps.schedules.markRunning({ scheduleId: schedule.scheduleId, taskId: schedule.lastRunTaskId ?? "pending", fireTime: slot, now });
  }

  const context: InvocationContext = {
    workspaceId: schedule.workspaceId,
    // A schedule runs *as the operator who authored it* — their principal, and
    // therefore their existing grants. Deliberately not a new privilege: the
    // scheduler has no authority the authoring operator lacks, and a scheduled
    // run that wants a tool the operator's workspace cannot use is refused by
    // `AccessPolicy` exactly as a foreground run would be.
    principalId: schedule.principalId,
    runId: "pending-schedule-admission",
    caller: `schedule:${schedule.name}`,
    // The schedule runs *as* its named agent when it has one. Admission validates the reference, so a schedule pointing at a
    // deleted agent fails the fire loudly rather than quietly running the
    // morning brief under the wrong instructions.
    ...(schedule.agentId === undefined ? {} : { agentDefinitionId: schedule.agentId }),
    ...scheduleRunContext(schedule),
    // A webhook's caller is not the schedule's author: its run starts as one that read untrusted content, so the
    // denials a tainted run meets (scheduling writes, unknown links, writes outside the managed folder) hold from its first turn.
    ...(options.webhook === undefined ? {} : { inheritedTaint: true as const, inheritedLabel: untrustedLabel("webhook") }),
    // An email's sender is not the schedule's author either, and email is where injected instructions come from most.
    ...(options.email === undefined ? {} : { inheritedTaint: true as const, inheritedLabel: untrustedLabel("email") }),
  };

  // Deterministic per fire (the `(scheduleId, fireTime)` key): an identical
  // re-dispatch of this exact fire replays the committed admission instead of
  // running the brief twice. A late fire's prompt carries the time it ran, so a
  // re-dispatch of one would differ and be refused; for those `claimFire` is
  // the only guard against a double dispatch. A retry has a key of its own, or
  // it would replay the failed admission it retries.
  // The manual branch reuses `manualId`, so the admission identity and the alert
  // identity are the same nonce by construction rather than by convention.
  const operationKey = scheduleRunKey(
    schedule.scheduleId,
    manualId === undefined
      ? { fireTime: slot, ...(retryCount === undefined ? {} : { retry: retryCount }) }
      : {
          manualId,
          at: slot,
          ...(manual !== false && manual.reason === "webhook" ? { webhook: true as const } : {}),
          ...(manual !== false && manual.reason === "email" ? { email: true as const } : {}),
          ...(watching ? { watch: true as const } : {}),
        },
  );

  let admission: AdmissionResult;
  let refusal: RoundRefusal | undefined;
  // Released once this fire stops deciding its task's rounds — whatever ends it —
  // or held past the fire while its run waits on a worker or a question.
  let leave: (() => void) | undefined;
  // Ended once this fire has recorded how its run stands.
  let reported: (() => void) | undefined;
  // The run's task, once admitted; and how long the run may still work, which stops it once spent.
  let runTaskId: string | undefined;
  const budget = startRunBudget(schedule, deps, (limit, usedTokens) =>
    stopOverrunRun(schedule, { taskId: runTaskId, manual, fireTime: slot, alertIdentity, ...definedRetry(retryCount) }, deps, {
      limit,
      usedTokens,
    }),
  );
  try {
    // A schedule that pins a folder works there, checked again now: one that no longer passes fails the fire,
    // saying why, before its task exists — never runs in a folder nobody chose.
    const folder = pinnedFolder(schedule, deps);
    admission = await admitUnattended(
      deps.workflow,
      {
        context,
        // Nobody is watching a scheduled fire: it may not ask a person anything —
        // unless the schedule opted in, and then only with a default —
        // and this is the policy its whole task (and every worker it spawns)
        // carries for the rest of its life.
        // An email's run is a reader session as well: read-only tools only, its own delivery aside, whatever
        // the schedule's tool list allows.
        executionPolicy: {
          ...(schedule.humanCheckpoints === "ask-with-default" ? SCHEDULE_CHECKPOINT_TASK_POLICY : SCHEDULE_TASK_POLICY),
          ...(options.email === undefined ? {} : { readOnlyTools: true }),
        },
        operationKey,
        prompt: [
          schedule.prompt,
          catchUpNote,
          precheckRun?.note,
          options.webhook === undefined ? undefined : webhookRunNote(options.webhook),
          options.email === undefined ? undefined : emailRunNote(),
        ]
          .filter((part) => part !== undefined)
          .join("\n\n"),
        // What the call or the email carried: quoted data of its own, never the person's prompt.
        ...triggerOf(options),
        // A schedule-fired task is identified as such so an approval round it
        // raises is attributed to this fire while the fire is in flight.
        origin: "schedule",
        originScheduleId: schedule.scheduleId,
        // The run's task identity becomes durable before any node runs, and the
        // execution lease is held at that moment — which is the only window in
        // which the overlap guard can see an in-flight run.
        onAdmitted: async (admitted) => {
          runTaskId = admitted.taskId;
          if (folder !== undefined) await deps.folders?.begin(schedule, admitted.taskId, folder);
          deps.inFlight?.keepBudget(admitted.taskId, budget);
          // Manual fires included: their rounds are decided by this loop too.
          leave ??= deps.inFlight?.enter(admitted.taskId, schedule.scheduleId, watching);
          reported ??= deps.inFlight?.reporting(admitted.taskId);
          // Any run that starts is the schedule's last run; only a scheduled fire's leaves a dispatch marker.
          if (manual) {
            await deps.schedules.markRunning({
              scheduleId: schedule.scheduleId,
              taskId: admitted.taskId,
              fireTime: slot,
              now: deps.now(),
              manual: true,
            });
            return;
          }
          await deps.schedules.markRunning({ scheduleId: schedule.scheduleId, taskId: admitted.taskId, fireTime: slot, now: deps.now() });
        },
      },
      { signal: budget.signal },
    );
    ({ admission, refusal } = await resolveSuspensions(admission, schedule, operationKey, deps, budget.signal));
  } catch (error) {
    budget.pause();
    if (budget.spent) {
      await budget.stopped;
      leave?.();
      reported?.();
      const finalText = overrunOutcome(schedule, manual, budget);
      return runTaskId === undefined
        ? { kind: "refused", reason: finalText }
        : { kind: "ran", taskId: runTaskId, status: "failed", finalText };
    }
    if (runTaskId !== undefined) deps.inFlight?.keepBudget(runTaskId, undefined);
    leave?.();
    reported?.();
    const detail = errorMessage(error);
    await deps.schedules.recordRun({
      scheduleId: schedule.scheduleId,
      taskId: null,
      outcome: `${runLabel(manual)}admission failed: ${detail}`,
      ...countedKind(manual, "failed"),
      fire: fireEntry(manual, slot, "failed", retryCount),
      now: deps.now(),
    });
    deps.log({ level: "error", message: "schedule admission failed", detail: { scheduleId: schedule.scheduleId, error } });
    await sendAlert(
      schedule,
      { identity: alertIdentity, kind: "start-failed", text: `Scheduled run "${schedule.name}" could not start: ${detail}` },
      deps,
    );
    if (countsTowardPause(manual)) await pauseIfFailing(schedule, { fireTime: slot, alertIdentity }, deps);
    return { kind: "refused", reason: detail };
  }

  // Not counted while the fire reports: a stop recorded meanwhile would land under this fire's own record.
  budget.pause();
  if (budget.spent) {
    await budget.stopped;
    leave?.();
    reported?.();
    return { kind: "ran", taskId: admission.taskId, status: "failed", finalText: overrunOutcome(schedule, manual, budget) };
  }
  // A worker's turn still counts meanwhile: a limit it reaches stops the run once this record is down, not under it.
  const resumeStops = budget.deferStop();
  let suspension: Suspension | undefined;
  try {
    suspension = await suspensionOf(admission, refusal, deps);
    return await reportFire(schedule, admission, refusal, suspension, manual, alertIdentity, slot, deps, {
      retryCount: retryCount ?? 0,
      retryable: !manual,
      ...(manual ? {} : { claimedNextRunAt: nextRunAt }),
      ...(precheckRun === undefined ? {} : { precheckReading: precheckRun.reading }),
    });
  } finally {
    // Held: the schedule is in flight until the run's continuation settles it, which finishes a last occurrence then.
    if (holdWhileSuspended(admission.taskId, suspension, leave, deps)) ended.suspended = true;
    carryBudget(admission.taskId, budget, suspension, deps);
    if (suspension !== undefined && precheckRun !== undefined) deps.inFlight?.keepReading(admission.taskId, precheckRun.reading);
    reported?.();
    resumeStops();
  }
}

/**
 * Run one schedule immediately, without touching its next scheduled fire
 * (`tavi schedules run-now`).
 *
 * The overlap guard still applies: an operator asking for a run while the
 * scheduled one is mid-flight should be told, not given two concurrent reports.
 */
export async function runScheduleNow(
  schedule: ScheduleRecord,
  deps: ScheduleSchedulerDependencies,
  options: {
    readonly webhook?: ScheduleWebhookFire;
    readonly watch?: true;
    readonly email?: ScheduleEmailFire;
    /** The claim on the schedule the caller took (`InFlightFireRegistry.claimSchedule`); released once the fire ends. */
    readonly claim?: () => void;
  } = {},
): Promise<FireOutcome> {
  return fireSchedule(withEventCeiling(schedule, options.webhook !== undefined || options.email !== undefined), deps.now(), deps, {
    manual: true,
    ...definedOnly({ claim: options.claim, webhook: options.webhook, email: options.email, watch: options.watch }),
  });
}

/** The real path of the folder a schedule pins, checked now; undefined when it pins none. A refusal says how to mend it. */
function pinnedFolder(schedule: ScheduleRecord, deps: ScheduleSchedulerDependencies): string | undefined {
  if (schedule.folder === undefined) return undefined;
  if (deps.folders === undefined)
    throw new TaviError("UNAVAILABLE", `this schedule works in ${schedule.folder}, and this owner cannot set a run's folder`);
  try {
    return deps.folders.check(schedule.folder);
  } catch (error) {
    throw new TaviError(
      "NOT_AUTHORIZED",
      `this schedule's folder ${schedule.folder} cannot be used: ${errorMessage(error)}. Change it with \`tavi schedules update ${schedule.name} --folder <path>\`, or remove it with --folder off.`,
    );
  }
}
