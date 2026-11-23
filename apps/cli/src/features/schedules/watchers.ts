import { type FSWatcher, type Stats, unwatchFile, watch, watchFile } from "node:fs";
import { basename, dirname } from "node:path";

import {
  SCHEDULE_WATCH_DEBOUNCE_MS,
  SCHEDULE_WATCH_MAX_PER_HOUR,
  SCHEDULE_WATCH_MAX_RUNS_IN_A_ROW,
  SCHEDULE_WATCH_MIN_INTERVAL_MS,
  type ScheduleRecord,
  type ScheduleRepositoryPort,
  type TextRef,
  TaviError,
  englishOf,
  textRef,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import type { ScheduleFireNow } from "./actions.js";

/**
 * File watchers' prompt checks, while the owner serves: a schedule marked
 * `watch` whose pre-check is `file-changed` has its file watched, and a change
 * makes its pre-check-gated fire — after a quiet spell of
 * `SCHEDULE_WATCH_DEBOUNCE_MS`, at most once a `SCHEDULE_WATCH_MIN_INTERVAL_MS`
 * and `SCHEDULE_WATCH_MAX_PER_HOUR` an hour, a change past either waiting until
 * one is allowed. Its cadence's fires go on as they are: they catch a change
 * made while the owner was not running, or one a watch missed. A watcher whose
 * changes ran it `SCHEDULE_WATCH_MAX_RUNS_IN_A_ROW` times in a row within an
 * hour is checked only at its cadence for the next hour, its person told once.
 *
 * The path is held to the `--fs-root` rule when the watch is set up, at each
 * `sync` and again before each fire, as the pre-check holds it at each read; a
 * symlink pointed at another file moves the watch to it. The schedule is read
 * again before each fire, so one edited, paused or removed since is not fired;
 * the watches follow the stored schedules at each `sync` (after a write here,
 * and every `SYNC_EVERY_MS` for writes made elsewhere) and all end at `stop`.
 * That timer's tick lists the schedules only when a schedule write has settled
 * since the last listing (`changes`); an idle tick re-checks only the watched
 * paths, and those of watchers left without a watch, against the `--fs-root`
 * rule, and touches no database.
 */

/** How often the watches are matched to the stored schedules, for a change no write here announced. */
const SYNC_EVERY_MS = 60_000;
/** How often a file is polled where it cannot be watched. */
const POLL_EVERY_MS = 10_000;
const HOUR_MS = 3_600_000;

/** Watches one file for changes; returns what stops it. */
export type WatchFile = (path: string, changed: () => void, failed: (error: unknown) => void) => () => void;

export interface ScheduleWatcherDependencies {
  readonly schedules: Pick<ScheduleRepositoryPort, "list" | "get">;
  /** The owner's `--fs-root` rule for a file: its real path, or a refusal. */
  readonly checkFile: (path: string) => string;
  /** Fires the schedule now as a file watcher's check, under the run-now in-flight guard. */
  readonly fire: (schedule: ScheduleRecord) => Promise<ScheduleFireNow>;
  /** Whether the schedule's owner may still act in its workspace. */
  readonly actsIn?: (workspaceId: string, principalId: string) => boolean;
  /** Absent: `watchFileChanges`. */
  readonly watchFile?: WatchFile;
  /** Tells the schedule's person something about its watch, once per `identity`. */
  readonly alert?: (
    schedule: ScheduleRecord,
    alert: { readonly identity: string; readonly text: string; readonly ref?: TextRef },
  ) => Promise<void>;
  /** Arms a timer, returning what disarms it. Absent: `setTimeout`, not keeping the process alive. */
  readonly setTimer?: (callback: () => void, ms: number) => () => void;
  /**
   * Arms the `SYNC_EVERY_MS` resync's timer (the owner's due-work planner's, which wakes for it beside its other
   * periodic work). Absent: `setTimer`. A changed file's check keeps `setTimer`, so it is not held to that timer's grid.
   */
  readonly syncTimer?: (callback: () => void, ms: number) => () => void;
  /**
   * A count each schedule write this process makes moves on (`scheduleWriteCount`): the timer's sync lists the
   * schedules only once it has moved since the last listing. Absent: every tick lists them.
   */
  readonly changes?: () => number;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly log: (level: "info" | "warn", message: string, fields: Record<string, unknown>) => void;
}

export interface ScheduleWatchers {
  /** Starts watching each file watcher's file, and matching the watches to the stored schedules from now on. */
  start(): Promise<void>;
  /** Matches the watches to the stored schedules now: a new watcher is watched, one edited, paused or removed is not. */
  sync(): Promise<void>;
  /** The schedules whose files are watched, with the real path of each. */
  watching(): ReadonlyMap<string, string>;
  /** Ends every watch and timer; nothing fires after. */
  stop(): void;
}

/** Whether the `--fs-root` rule refused a file because it does not exist, not because it is not allowed. */
function isGone(error: unknown): boolean {
  return error instanceof TaviError && error.code === "NOT_FOUND";
}

/** What a watcher needs to be watched: enabled, marked a watcher, and its pre-check a file's. */
function watchedPath(schedule: ScheduleRecord): string | undefined {
  return schedule.enabled && schedule.watch === true && schedule.precheck?.kind === "file-changed" ? schedule.precheck.target : undefined;
}

interface Watch {
  readonly target: string;
  readonly real: string;
  close: () => void;
  /** The pending check, while one waits for the quiet spell or the rate limit. */
  pending?: () => void;
}

export function createScheduleWatchers(deps: ScheduleWatcherDependencies): ScheduleWatchers {
  const watches = new Map<string, Watch>();
  const fired = new Map<string, number[]>();
  /** The times of the runs, each on a change, that a watch has made in a row. */
  const runs = new Map<string, number[]>();
  /** Until when a watcher that ran too often in a row is checked only at its cadence. */
  const backedOff = new Map<string, number>();
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const watchFileAt = deps.watchFile ?? watchFileChanges;
  let stopped = true;
  let syncing: Promise<void> | undefined;
  let stopSync: (() => void) | undefined;
  /** `changes` when the schedules were last listed whole; undefined until then, or when a listing failed. */
  let listedAt: number | undefined;
  /** The paths of the listed watchers left without a watch, by schedule: the timer's idle tick tries them again. */
  const unwatched = new Map<string, string>();
  /** Why a watcher was last left without a watch, by schedule: said once until it changes or the watch is set up. */
  const told = new Map<string, string>();

  const unwatch = (scheduleId: string): void => {
    const current = watches.get(scheduleId);
    if (current === undefined) return;
    watches.delete(scheduleId);
    current.pending?.();
    current.close();
  };

  /** The milliseconds until the schedule may be checked again, or 0 when it may now. */
  const rateWait = (scheduleId: string): number => {
    const at = deps.now();
    const recent = (fired.get(scheduleId) ?? []).filter((time) => at - time < HOUR_MS);
    fired.set(scheduleId, recent);
    const last = recent.at(-1);
    if (last !== undefined && at - last < SCHEDULE_WATCH_MIN_INTERVAL_MS) return SCHEDULE_WATCH_MIN_INTERVAL_MS - (at - last);
    const first = recent[0];
    if (first !== undefined && recent.length >= SCHEDULE_WATCH_MAX_PER_HOUR) return HOUR_MS - (at - first);
    return 0;
  };

  /** Arms the schedule's check after `ms`, replacing one already pending. */
  const arm = (scheduleId: string, ms: number): void => {
    const current = watches.get(scheduleId);
    if (current === undefined || stopped) return;
    current.pending?.();
    const disarm = setTimer(() => {
      if (current.pending === disarm) delete current.pending;
      void check(scheduleId, current);
    }, ms);
    current.pending = disarm;
  };

  /** The check a change asked for: the schedule read again, its path held to the roots again, the rate limit kept. */
  const check = async (scheduleId: string, watched: Watch): Promise<void> => {
    if (stopped || watches.get(scheduleId) !== watched) return;
    let schedule: ScheduleRecord | undefined;
    try {
      schedule = await deps.schedules.get(scheduleId);
    } catch (error) {
      deps.log("warn", "a watched schedule could not be read", { scheduleId, error: errorMessage(error) });
      return;
    }
    if (stopped || watches.get(scheduleId) !== watched) return;
    if (schedule === undefined || watchedPath(schedule) !== watched.target) {
      unwatch(scheduleId);
      return;
    }
    if (deps.actsIn !== undefined && !deps.actsIn(schedule.workspaceId, schedule.principalId)) return;
    let real: string | undefined;
    try {
      real = deps.checkFile(watched.target);
    } catch (error) {
      unwatch(scheduleId);
      if (!isGone(error)) {
        deps.log("warn", "a watched file is no longer under an --fs-root; its change is not checked", {
          scheduleId,
          error: errorMessage(error),
        });
        return;
      }
      // A file removed is a change too: its check is made now, and its pre-check records it failed, saying why.
      deps.log("warn", "a watched file is gone; its check is recorded failed", { scheduleId, error: errorMessage(error) });
    }
    if (real !== undefined && real !== watched.real) {
      unwatch(scheduleId);
      watchOne(schedule, watched.target);
    }
    const until = backedOff.get(scheduleId);
    if (until !== undefined && deps.now() < until) {
      deps.log("info", "a watched file changed while its watcher is checked only at its cadence", { scheduleId });
      return;
    }
    backedOff.delete(scheduleId);
    const wait = rateWait(scheduleId);
    if (wait > 0) {
      deps.log("info", "a watched file changed again soon; its check waits for the rate limit", { scheduleId, waitMs: wait });
      arm(scheduleId, wait);
      return;
    }
    // Counted before the fire is awaited, so two changes at once are one check.
    fired.set(scheduleId, [...(fired.get(scheduleId) ?? []), deps.now()]);
    let outcome: ScheduleFireNow;
    try {
      outcome = await deps.fire(schedule);
    } catch (error) {
      deps.log("warn", "a watched file's change could not be checked", { scheduleId, error: errorMessage(error) });
      return;
    }
    if (outcome.taskId !== undefined) {
      deps.log("info", "a watched file changed; its schedule runs", { scheduleId, taskId: outcome.taskId });
      await backOffIfRunning(schedule);
    } else if (outcome.outcome?.kind === "skipped" && outcome.outcome.reason === "overlap") {
      // A run of it in flight sees the file as it was when it read it: the change is checked once it has ended,
      // and this attempt, which checked nothing, takes none of the hour's checks.
      fired.get(scheduleId)?.pop();
      arm(scheduleId, SCHEDULE_WATCH_DEBOUNCE_MS);
    } else runs.delete(scheduleId);
  };

  /** Counts a run a change made; one too many in a row within the hour stops the prompt checks for an hour. */
  const backOffIfRunning = async (schedule: ScheduleRecord): Promise<void> => {
    const scheduleId = schedule.scheduleId;
    const at = deps.now();
    const recent = [...(runs.get(scheduleId) ?? []), at].filter((time) => at - time < HOUR_MS);
    if (recent.length < SCHEDULE_WATCH_MAX_RUNS_IN_A_ROW) {
      runs.set(scheduleId, recent);
      return;
    }
    runs.delete(scheduleId);
    const until = at + HOUR_MS;
    backedOff.set(scheduleId, until);
    deps.log("warn", "a watched file changed on every check; its watcher is checked only at its cadence for an hour", {
      scheduleId,
      runs: recent.length,
    });
    try {
      const said = textRef("channel.schedule.alert.watchBackoff", {
        name: schedule.name,
        n: String(recent.length),
        path: watchedPath(schedule) ?? textRef("channel.schedule.alert.itsFile"),
        until: new Date(until).toISOString(),
      });
      await deps.alert?.(schedule, { identity: `watch-backoff:${new Date(until).toISOString()}`, text: englishOf(said), ref: said });
    } catch (error) {
      deps.log("warn", "a watcher's back-off could not be told", { scheduleId, error: errorMessage(error) });
    }
  };

  const watchOne = (schedule: ScheduleRecord, target: string): void => {
    const scheduleId = schedule.scheduleId;
    let real: string;
    try {
      real = deps.checkFile(target);
    } catch (error) {
      const message = isGone(error)
        ? "a watcher's file does not exist; it is checked only at its cadence"
        : "a watcher's file is not under an --fs-root; it is checked only at its cadence";
      // Said once while it stays so, not at every sync that lists it again.
      if (told.get(scheduleId) !== message) deps.log("warn", message, { scheduleId, error: errorMessage(error) });
      told.set(scheduleId, message);
      return;
    }
    told.delete(scheduleId);
    const watched: Watch = { target, real, close: () => {} };
    watches.set(scheduleId, watched);
    try {
      watched.close = watchFileAt(
        real,
        () => arm(scheduleId, SCHEDULE_WATCH_DEBOUNCE_MS),
        (error) =>
          deps.log("warn", "a watcher's file could not be watched; it is polled instead", {
            scheduleId,
            error: errorMessage(error),
          }),
      );
    } catch (error) {
      watches.delete(scheduleId);
      deps.log("warn", "a watcher's file could not be watched; it is checked only at its cadence", {
        scheduleId,
        error: errorMessage(error),
      });
    }
  };

  /** The file's real path now, or undefined where the `--fs-root` rule refuses it; `watchOne` says why. */
  const realPath = (target: string): string | undefined => {
    try {
      return deps.checkFile(target);
    } catch {
      return undefined;
    }
  };

  const syncNow = async (): Promise<void> => {
    // Read before the listing: a write that settles while it is read moves the count on again, and the next tick lists.
    const seen = deps.changes?.();
    let schedules: readonly ScheduleRecord[];
    try {
      schedules = await deps.schedules.list();
    } catch (error) {
      listedAt = undefined;
      deps.log("warn", "the watched schedules could not be listed", { error: errorMessage(error) });
      return;
    }
    if (stopped) return;
    listedAt = seen;
    const wanted = new Map<string, ScheduleRecord>();
    for (const schedule of schedules) if (watchedPath(schedule) !== undefined) wanted.set(schedule.scheduleId, schedule);
    for (const [scheduleId, watched] of [...watches]) {
      const schedule = wanted.get(scheduleId);
      if (schedule === undefined || watchedPath(schedule) !== watched.target || realPath(watched.target) !== watched.real)
        unwatch(scheduleId);
    }
    unwatched.clear();
    for (const [scheduleId, schedule] of wanted) {
      const target = watchedPath(schedule);
      if (target === undefined || watches.has(scheduleId)) continue;
      watchOne(schedule, target);
      if (!watches.has(scheduleId)) unwatched.set(scheduleId, target);
    }
    for (const kept of [fired, runs, backedOff, told])
      for (const scheduleId of [...kept.keys()]) if (!wanted.has(scheduleId)) kept.delete(scheduleId);
  };

  /** One sync at a time; one asked for while another runs runs after it. */
  const sync = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    const next = (syncing ?? Promise.resolve()).then(syncNow);
    syncing = next;
    return next.finally(() => {
      if (syncing === next) syncing = undefined;
    });
  };

  /**
   * The timer's sync: the whole listing only when a schedule write has settled since the last one; otherwise the
   * watched paths alone are held to the `--fs-root` rule again (a file moved out, a symlink pointed elsewhere), with
   * no database read, and a listing only if one of them no longer holds, or a watcher left without a watch now
   * passes it (one whose watch could not be set up is listed again at every tick).
   */
  const tick = (): Promise<void> => {
    if (deps.changes === undefined || listedAt === undefined || deps.changes() !== listedAt || syncing !== undefined) return sync();
    for (const watched of watches.values()) if (realPath(watched.target) !== watched.real) return sync();
    for (const target of unwatched.values()) if (realPath(target) !== undefined) return sync();
    return Promise.resolve();
  };

  const resync = (): void => {
    if (stopped) return;
    stopSync = (deps.syncTimer ?? setTimer)(() => {
      void tick().finally(resync);
    }, SYNC_EVERY_MS);
  };

  return {
    start: async () => {
      if (!stopped) return;
      stopped = false;
      await sync();
      resync();
    },
    sync,
    watching: () => new Map([...watches].map(([scheduleId, watched]) => [scheduleId, watched.real])),
    stop: () => {
      stopped = true;
      stopSync?.();
      stopSync = undefined;
      listedAt = undefined;
      unwatched.clear();
      told.clear();
      for (const scheduleId of [...watches.keys()]) unwatch(scheduleId);
      fired.clear();
      runs.clear();
      backedOff.clear();
    },
  };
}

/**
 * A count of the schedule writes settled on `store` (a `DatabaseClient`) — every `repository.schedules.*` request
 * but its reads, and every routine request that writes a routine's trigger schedules in the worker, failed ones
 * included — kept in memory as they settle: what tells the watchers' timer a schedule may have changed, with no
 * request of its own.
 */
export function scheduleWriteCount(store: { onSettled(listener: (operation: string) => void): () => void }): () => number {
  let count = 0;
  store.onSettled((operation) => {
    if ((operation.startsWith("repository.schedules.") && !SCHEDULE_READ.test(operation)) || ROUTINE_SCHEDULE_WRITES.has(operation))
      count += 1;
  });
  return () => count;
}

/**
 * The routine requests that write `tavi_schedules` inside the worker, past the schedule repository's requests: a
 * routine's create, evaluation, status change and one-off use sync its trigger schedules; a run's claim takes the
 * schedule's fire; a run's start or finish can pause the routine for its failures, which disables its triggers
 * with a statement of its own; a control request can do any of these.
 */
const ROUTINE_SCHEDULE_WRITES: ReadonlySet<string> = new Set([
  "routine.routines.create",
  "routine.routines.finishEvaluation",
  "routine.routines.setStatus",
  "routine.routines.consumeOneOff",
  "routine.runs.claim",
  "routine.runs.start",
  "routine.runs.finish",
  "routine.control",
]);

/** The schedule repository's reads, which change nothing a watch follows. */
const SCHEDULE_READ =
  /\.(get|list|listDue|listFires|latestFires|emailTriggered|hasWebhooks|scheduledUsage|webhookScheduleIds|webhookSecretHash|webhookSigningKey)$/;

/**
 * A file's changes: the file itself watched, each event on it a change. An
 * editor that saves by replacing the file, or a move, ends a watch on the file
 * it was (a `rename` event): the path is watched again, and while nothing is at
 * it its folder is watched for its name until it is back. Polled for its size
 * and modification time where neither can be watched. The folder is watched
 * only then: its watch sees every other file's events too (on macOS, through
 * FSEvents, those of the folder's whole tree).
 */
export const watchFileChanges: WatchFile = (path, changed, failed) => {
  const name = basename(path);
  let closed = false;
  let watcher: FSWatcher | undefined;
  let poll: ((current: Stats, previous: Stats) => void) | undefined;
  const startPolling = (): void => {
    if (poll !== undefined || closed) return;
    poll = (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) changed();
    };
    watchFile(path, { persistent: false, interval: POLL_EVERY_MS }, poll);
  };
  const replace = (next: FSWatcher | undefined): void => {
    watcher?.close();
    watcher = next;
  };
  const polled = (source: FSWatcher) => (error: unknown) => {
    if (watcher !== source) return;
    failed(error);
    replace(undefined);
    startPolling();
  };
  /** Watches the file itself; false while nothing is at its path. */
  const watchTheFile = (): boolean => {
    let next: FSWatcher;
    try {
      next = watch(path, { persistent: false }, (event) => {
        if (watcher !== next) return;
        changed();
        if (event === "rename") rearm();
      });
    } catch {
      return false;
    }
    next.on("error", polled(next));
    replace(next);
    return true;
  };
  /** Watches the file's folder for its name, until the file is back to watch. */
  const watchTheFolder = (): void => {
    let next: FSWatcher;
    try {
      next = watch(dirname(path), { persistent: false }, (_event, filename) => {
        if (watcher !== next || (filename !== null && filename.toString() !== name)) return;
        changed();
        watchTheFile();
      });
    } catch (error) {
      failed(error);
      replace(undefined);
      startPolling();
      return;
    }
    next.on("error", polled(next));
    replace(next);
  };
  const rearm = (): void => {
    if (!closed && !watchTheFile()) watchTheFolder();
  };
  rearm();
  return () => {
    closed = true;
    replace(undefined);
    if (poll !== undefined) unwatchFile(path, poll);
  };
};
