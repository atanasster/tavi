/**
 * Runs `tick` every `ms` until the answer is called. The default is an
 * `unref`'d `setInterval`; an owner hands its wake planner's `every` instead,
 * so its slow periodic work wakes the process together rather than each on a
 * timer of its own.
 */
export type RepeatTimer = (tick: () => void, ms: number) => () => void;

/** `setInterval`, not keeping the process alive. */
export const repeatEvery: RepeatTimer = (tick, ms) => {
  const handle = setInterval(tick, ms);
  const unref = (handle as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(handle);
  return () => clearInterval(handle);
};

/**
 * A sweep run on an interval that never overlaps itself.
 *
 * A tick that finds a sweep still running skips (an explicit `sweep()` joins
 * it instead), so a sweep that takes longer than its interval — a schedule's
 * fire can run for minutes — is never joined by a second one working from its
 * own stale snapshot. The first sweep runs at once, so work that fell due while
 * the owner was stopped is picked up on start rather than an interval later.
 * The interval is `unref`'d, so a forgotten `stop()` cannot keep a process
 * alive.
 */
export interface SweepLoop<T> {
  /** Stops future sweeps and waits for the one in progress. Idempotent. */
  stop(): Promise<void>;
  /** Sweep now rather than at the next tick; joins a sweep already running. */
  sweep(): Promise<T | undefined>;
}

export function startSweepLoop<T>(options: {
  readonly intervalMs: number;
  /** What runs the interval; absent, `repeatEvery`. */
  readonly every?: RepeatTimer;
  /** One sweep; `stopping` turns true once `stop()` was called, so it can stop between items. */
  readonly run: (stopping: () => boolean) => Promise<T>;
  readonly onSwept?: (result: T) => void;
  readonly onError: (error: unknown) => void;
}): SweepLoop<T> {
  let stopped = false;
  let running: Promise<T | undefined> | undefined;
  const stopping = (): boolean => stopped;
  const sweep = (): Promise<T | undefined> => {
    if (running !== undefined) return running;
    if (stopped) return Promise.resolve(undefined);
    running = options
      .run(stopping)
      .then(
        (result) => {
          try {
            options.onSwept?.(result);
          } catch (error) {
            options.onError(error);
          }
          return result;
        },
        (error: unknown) => {
          options.onError(error);
          return undefined;
        },
      )
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const stopTicks = (options.every ?? repeatEvery)(() => {
    void sweep();
  }, options.intervalMs);
  void sweep();
  return {
    async stop(): Promise<void> {
      if (!stopped) {
        stopped = true;
        stopTicks();
      }
      await running;
    },
    sweep,
  };
}

/** One sweep the planner runs when its work falls due. */
export interface PlannedSweep {
  /** Sweep now; joins a sweep already running (a `SweepLoop`'s `sweep`). */
  readonly sweep: () => Promise<unknown>;
  /** True while work held in memory (not in the database) wants a sweep each `floorMs`, as the timer gave it. */
  readonly busy?: () => boolean;
}

export interface WakePlanner<K extends string> {
  /**
   * Plans `kind`'s sweeps from now on; its own first sweep is taken to have
   * just run. Answers the unregister, which waits for a planned sweep of it in
   * progress.
   */
  register(kind: K, sweep: PlannedSweep): () => Promise<void>;
  /** Something was written: the deadlines are read again `settleMs` later, one read for every write meanwhile. */
  changed(): void;
  /**
   * Runs `tick` about every `ms` on the planner's own timer rather than one of
   * its own (a `RepeatTimer`): at the first time the planner wakes once it is
   * due, which is never later than the next instant on its `recheckMs` grid.
   * After its first run it falls due at multiples of `ms` since the epoch, so
   * ticks of one period run together, and every tick shares that grid: slow
   * periodic work wakes the process together. Answers the stop.
   */
  readonly every: RepeatTimer;
  /** `callback` once, `ms` from now, on the planner's timer as `every` runs its ticks. Answers the cancel. */
  readonly after: (callback: () => void, ms: number) => () => void;
}

/**
 * Sleeps until the earliest stored deadline of several sweeps instead of each
 * sweeping on its own timer: an idle owner reads the database only when
 * something falls due or something was written.
 *
 * `deadlines` reads every sweep's earliest due instant in one database call;
 * it is read when a sweep registers, `settleMs` after a write (`changed`), and
 * after each round of planned sweeps. A sweep whose instant has come runs at
 * once — on time, where the timer it replaces was up to an interval late — and
 * at most once per `floorMs`, so a row a sweep cannot clear (unreadable, or
 * owned by another sweep) is retried at the old timer's pace rather than in a
 * loop. Between reads the timer only compares the wall clock with the planned
 * instants, while any is planned, at each instant on a `recheckMs` grid (epoch
 * multiples of it), so a machine that slept wakes to its due work within
 * `recheckMs` without a read: timers do not run while it sleeps. The owner's
 * other periodic work (`every`, `after`) runs on the same grid instants, so an
 * idle owner's timer fires at most once each `recheckMs`, whatever else ticks.
 * With nothing registered and nothing ticking no timer runs. Each sweep keeps
 * its own slow timer as a fallback.
 */
export function createWakePlanner<K extends string>(options: {
  /** Each sweep's earliest due instant (ISO-8601), `null` with nothing stored. */
  readonly deadlines: () => Promise<Readonly<Record<K, string | null>>>;
  readonly floorMs: number;
  readonly settleMs: number;
  readonly recheckMs: number;
  readonly now?: () => number;
  readonly onError: (error: unknown) => void;
}): WakePlanner<K> {
  const now = options.now ?? Date.now;
  const sweeps = new Map<K, PlannedSweep>();
  const lastSwept = new Map<K, number>();
  const due = new Map<K, number>();
  const running = new Map<K, Promise<unknown>>();
  let reading: Promise<void> | undefined;
  let readAgain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  /** The ticks and callbacks run on the planner's timer, each with the instant it is next due. */
  const beats = new Set<{ at: number; readonly ms: number; readonly run: () => void; readonly repeats: boolean }>();
  /** The first instant on the `recheckMs` grid at or after `instant`. */
  const onGrid = (instant: number): number => Math.ceil(instant / options.recheckMs) * options.recheckMs;

  const unref = (handle: ReturnType<typeof setTimeout>): void => {
    const release = (handle as { unref?: () => void }).unref;
    if (typeof release === "function") release.call(handle);
  };
  /**
   * When `kind` may sweep next: its stored instant, or now while busy, but never inside its floor. A last sweep
   * the clock has since been set back past counts as now, so a backward jump costs one floor, not the jump.
   */
  const nextOf = (kind: K, sweep: PlannedSweep): number => {
    const at = now();
    const last = lastSwept.get(kind) ?? 0;
    if (last > at) lastSwept.set(kind, at);
    const stored = sweep.busy?.() === true ? at : (due.get(kind) ?? Number.POSITIVE_INFINITY);
    return Math.max(stored, Math.min(last, at) + options.floorMs);
  };
  /**
   * Sleeps until the earliest planned sweep, the grid instant a tick waits for, or — while any sweep is planned at
   * all — the next grid instant, where the wall clock is compared with the plan again.
   */
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const at = now();
    let next = Number.POSITIVE_INFINITY;
    for (const [kind, sweep] of sweeps) next = Math.min(next, nextOf(kind, sweep));
    if (Number.isFinite(next)) next = Math.min(next, onGrid(at + 1));
    // A tick due just past a grid instant (one re-armed as its last run ended, say) runs at that instant.
    for (const entry of beats) next = Math.min(next, onGrid(entry.at - BEAT_SLACK_MS));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(fire, Math.max(next - at, 0));
    unref(timer);
  };
  const fire = (): void => {
    timer = undefined;
    const at = now();
    const round: Promise<unknown>[] = [];
    for (const [kind, sweep] of sweeps) {
      if (running.has(kind) || nextOf(kind, sweep) > at) continue;
      lastSwept.set(kind, at);
      // Until the read after this round, it is not due again.
      due.delete(kind);
      const work = Promise.resolve()
        .then(() => sweep.sweep())
        .catch((error: unknown) => options.onError(error))
        .finally(() => running.delete(kind));
      running.set(kind, work);
      round.push(work);
    }
    if (round.length > 0) void Promise.all(round).then(() => read());
    // A tick runs at any wake that finds it due, or due within `BEAT_SLACK_MS`.
    for (const entry of [...beats]) {
      if (entry.at > at + BEAT_SLACK_MS) continue;
      // Next at a multiple of its period, so ticks of one period (or of its multiples) fall due together.
      if (entry.repeats) entry.at = (Math.floor((at + BEAT_SLACK_MS) / entry.ms) + 1) * entry.ms;
      else beats.delete(entry);
      try {
        entry.run();
      } catch (error) {
        options.onError(error);
      }
    }
    arm();
  };
  const read = (): void => {
    if (sweeps.size === 0) return;
    if (reading !== undefined) {
      readAgain = true;
      return;
    }
    reading = options
      .deadlines()
      .then(
        (deadlines) => {
          for (const kind of sweeps.keys()) {
            const at = deadlines[kind];
            const ms = at === null || at === undefined ? Number.NaN : Date.parse(at);
            if (Number.isNaN(ms)) due.delete(kind);
            else due.set(kind, ms);
          }
        },
        (error: unknown) => options.onError(error),
      )
      .finally(() => {
        reading = undefined;
        if (readAgain) {
          readAgain = false;
          read();
        } else arm();
      });
  };
  const beat = (run: () => void, ms: number, repeats: boolean): (() => void) => {
    const entry = { at: now() + ms, ms, run, repeats };
    beats.add(entry);
    arm();
    return () => {
      if (beats.delete(entry)) arm();
    };
  };
  return {
    register(kind, sweep) {
      sweeps.set(kind, sweep);
      lastSwept.set(kind, now());
      read();
      return async () => {
        if (sweeps.get(kind) !== sweep) return;
        sweeps.delete(kind);
        due.delete(kind);
        if (sweeps.size === 0) {
          if (settle !== undefined) clearTimeout(settle);
          settle = undefined;
        }
        arm();
        await running.get(kind);
      };
    },
    changed(): void {
      // Not pushed back by later writes: a turn that writes for minutes still has its deadlines read each `settleMs`.
      if (sweeps.size === 0 || settle !== undefined) return;
      settle = setTimeout(() => {
        settle = undefined;
        read();
      }, options.settleMs);
      unref(settle);
    },
    every: (tick, ms) => beat(tick, ms, true),
    after: (callback, ms) => beat(callback, ms, false),
  };
}

/**
 * How early a tick may run at a wake: a timer and the wall clock can disagree by a few milliseconds, and a tick
 * re-armed at the end of its own run is due a little past the grid instant it would share with the others.
 */
const BEAT_SLACK_MS = 1_000;
