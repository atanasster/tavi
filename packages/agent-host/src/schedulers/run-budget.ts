import { type ScheduleRecord, scheduleMaxRunMinutes } from "@tavi/contracts";

/**
 * How long a fire's run may still work, carried from the fire into its
 * continuations. It counts while a turn of the run, or of a worker it spawned,
 * runs — a hung worker is a stuck run — and not while the run or a worker waits
 * (on a person's answer, a worker, or a deadline, each with its own), nor while
 * the fire records how the run stands, nor while the machine sleeps. Once spent,
 * `signal` aborts the turn in flight, and the run is stopped and recorded
 * (`stopOverrunRun`).
 *
 * With a token ceiling (`maxTokens`), the tokens the run's and its workers'
 * model calls used are counted on it too (`tokens`), and passing the ceiling
 * spends it as running out of time does.
 */
export interface RunBudget {
  readonly signal: AbortSignal;
  /** Whether it was spent: the run is being, or has been, stopped. */
  readonly spent: boolean;
  /** What spent it, once it is: its time, or its tokens. */
  readonly spentOn: RunBudgetLimit | undefined;
  /** The tokens counted on it so far. */
  readonly usedTokens: number;
  /** Whether it is counting now: a turn of the run, or of a worker of it, runs. */
  readonly counting: boolean;
  /** Settles once a spent budget's run is stopped and recorded. */
  readonly stopped: Promise<void>;
  /** Stop counting the run's own turn. */
  pause(): void;
  /** Count the run's own turn again, from what is left. */
  resume(): void;
  /** Count a worker's turn until the returned function ends it; several may run at once. */
  working(): () => void;
  /** Count the tokens a model call of the run, or of a worker of it, used. */
  tokens(count: number): void;
  /**
   * Hold off stopping the run while its fire records how it stands: a limit a
   * worker's turn reaches meanwhile stops it once the returned function ends
   * the hold, so the stop's record lands after the fire's. Idempotent.
   */
  deferStop(): () => void;
  /** Stop counting for good, whatever turn still runs: the run ended by other means, or its owner shuts down. */
  close(): void;
}

/** Which of a run's limits it reached: its working time, or its tokens. */
export type RunBudgetLimit = "time" | "tokens";

/** What a run's budget measures its working time by, and where it says a stop failed. */
export interface RunBudgetClock {
  /** Arms a timer, returning what disarms it. Absent: `setTimeout`, not keeping the process alive. */
  readonly setTimer?: (callback: () => void, ms: number) => () => void;
  /** Milliseconds on a monotonic clock. Absent: `performance.now()`. */
  readonly monotonicMs?: () => number;
  readonly log: (event: { readonly level: "error"; readonly message: string; readonly detail?: unknown }) => void;
}

export function startRunBudget(
  schedule: ScheduleRecord,
  clock: RunBudgetClock,
  onSpent: (limit: RunBudgetLimit, usedTokens: number) => Promise<void>,
): RunBudget {
  const minutes = scheduleMaxRunMinutes(schedule);
  const maxTokens = schedule.maxTokens;
  const controller = new AbortController();
  const arm =
    clock.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const monotonicMs = clock.monotonicMs ?? (() => performance.now());
  let leftMs = minutes * 60_000;
  let countingSince: number | undefined;
  let disarm: (() => void) | undefined;
  let spent = false;
  let spentOn: RunBudgetLimit | undefined;
  let usedTokens = 0;
  let stopped: Promise<void> = Promise.resolve();
  let ownTurn = false;
  let workerTurns = 0;
  let closed = false;
  let deferrals = 0;
  let deferredLimit: RunBudgetLimit | undefined;
  const update = (): void => {
    const counting = !spent && !closed && (ownTurn || workerTurns > 0);
    if (counting && countingSince === undefined) {
      countingSince = monotonicMs();
      disarm = arm(() => spend("time"), Math.max(0, leftMs));
    } else if (!counting && countingSince !== undefined) {
      leftMs -= monotonicMs() - countingSince;
      countingSince = undefined;
      disarm?.();
      disarm = undefined;
    }
  };
  const spend = (limit: RunBudgetLimit): void => {
    if (spent || closed) return;
    if (deferrals > 0) {
      deferredLimit ??= limit;
      return;
    }
    spent = true;
    spentOn = limit;
    countingSince = undefined;
    disarm?.();
    disarm = undefined;
    controller.abort();
    stopped = onSpent(limit, usedTokens).catch((error: unknown) =>
      clock.log({ level: "error", message: "a scheduled run past its limit could not be stopped", detail: { error } }),
    );
  };
  const budget: RunBudget = {
    signal: controller.signal,
    get spent() {
      return spent;
    },
    get spentOn() {
      return spentOn;
    },
    get usedTokens() {
      return usedTokens;
    },
    get counting() {
      return countingSince !== undefined;
    },
    get stopped() {
      return stopped;
    },
    pause() {
      ownTurn = false;
      update();
    },
    resume() {
      ownTurn = true;
      update();
    },
    working() {
      workerTurns += 1;
      update();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        workerTurns -= 1;
        update();
      };
    },
    tokens(count) {
      if (spent || closed || !(count > 0)) return;
      usedTokens += count;
      if (maxTokens !== undefined && usedTokens > maxTokens) spend("tokens");
    },
    deferStop() {
      deferrals += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        deferrals -= 1;
        const limit = deferredLimit;
        if (deferrals > 0 || limit === undefined) return;
        deferredLimit = undefined;
        spend(limit);
      };
    },
    close() {
      closed = true;
      update();
    },
  };
  budget.resume();
  return budget;
}
