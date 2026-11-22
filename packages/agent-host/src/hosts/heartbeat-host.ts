import {
  HEARTBEAT_LIMITS,
  heartbeatTickLooked,
  heartbeatWatchedPages,
  knownUrlSet,
  previousHeartbeatWindow,
  redactToolOutput,
  heartbeatWindowAt,
  nextHeartbeatAt,
  nextHeartbeatWindow,
  startOfLocalDay,
  startOfNextLocalDay,
  type HeartbeatItem,
  type HeartbeatPause,
  type HeartbeatPauseReason,
  type BudgetLeft,
  type HeartbeatHookDecision,
  type HeartbeatSignal,
  type MemoryExcerpt,
  type HeartbeatRepositoryPort,
  type HeartbeatSkipReason,
  type HeartbeatState,
  type HeartbeatTickRecord,
  type HeartbeatWakeReason,
  type LedgerEntry,
  type ModEnvelope,
  type RecordHeartbeatTickInput,
  type TurnHooksPort,
  textRef,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import {
  cleanHeartbeatItems,
  deliverHeartbeatAlert,
  deliverHeartbeatDigest,
  deliverHeartbeatItems,
  planHeartbeatDelivery,
  retractHeartbeatItems,
  type HeartbeatDeliveryPort,
  type HeartbeatItemVerdict,
} from "./heartbeat-delivery.js";
import { MIN_FREE_BYTES_FOR_A_FIRE } from "../schedulers/schedule-scheduler.js";
import { type RepeatTimer, repeatEvery } from "../schedulers/sweep-loop.js";
import {
  type HeartbeatTickBodyResult,
  type HeartbeatTickBodyInput,
  tickBudget,
  type HeartbeatTurnRequest,
  type HeartbeatTurnResult,
  askProvider,
} from "./heartbeat-tick.js";
export {
  type HeartbeatTickBodyResult,
  type HeartbeatTickBodyInput,
  type HeartbeatCost,
  type HeartbeatTickBudget,
  tickBudget,
  type HeartbeatTurnRequest,
  type HeartbeatTurnResult,
  heartbeatTurnPersonal,
  heartbeatTurnTools,
} from "./heartbeat-tick.js";
import {
  type HeartbeatProviderEntry,
  type HeartbeatProviderRegistry,
  type HeartbeatSignalRegistry,
  type HeartbeatProviderStates,
  type HeartbeatCollection,
  maskedText,
  storedMemo,
  collectHeartbeatSignals,
  boundHeartbeatMemory,
} from "./heartbeat-signals.js";

export {
  type HeartbeatProviderEntry,
  HEARTBEAT_DEV_RELOAD_GRACE_MS,
  HeartbeatProviderRegistry,
  HeartbeatSignalRegistry,
  HEARTBEAT_PROVIDER_STATE_KEYS,
  HeartbeatProviderStates,
  type HeartbeatCollection,
  collectHeartbeatSignals,
  boundHeartbeatMemory,
} from "./heartbeat-signals.js";

/**
 * The heartbeat host: the 30 s sweep
 * that finds due heartbeats, claims each tick, runs the cheap gates (G0 off,
 * paused, hours, disk, model, provider; G1 nothing to look at; G2 busy or in
 * flight) before any model call, and records every outcome. The tick itself —
 * signals, memory, the provider, delivery — is the provider registry's and the
 * later steps'; a skip or a deferral is never a failure.
 */

/** Whether a person is using Home now: a turn running, or their newest entry under 5 minutes old. */
export interface HomeActivity {
  readonly running: boolean;
  readonly lastUserEntryAt?: string;
}

export interface HeartbeatHostDependencies {
  readonly repository: HeartbeatRepositoryPort;
  readonly providers: HeartbeatProviderRegistry;
  /** Where a provider's published panel values are kept; absent, publishing keeps nothing. */
  readonly providerStates?: HeartbeatProviderStates;
  /** Mods' heartbeat hooks: `heartbeat.item` before an item is told, `heartbeat.tick` once a check is recorded. */
  readonly hooks?: TurnHooksPort;
  readonly now: () => Date;
  readonly newId: (prefix: string) => string;
  /** The workspace's timezone, falling back to the owner host's. */
  readonly timezoneOf: (workspaceId: string) => Promise<string>;
  /** Home's activity for G2; undefined when the person has no Home (never busy then). */
  readonly homeActivity: (workspaceId: string, principalId: string) => Promise<HomeActivity | undefined>;
  /** Free bytes on the data directory's filesystem, for G0's disk check; undefined skips it. */
  readonly freeBytes?: () => number | undefined;
  /** Whether a model is bound for this heartbeat: its own `model`, or the `fast` role. */
  readonly modelAvailable: (state: HeartbeatState) => Promise<boolean>;
  /** The sources signals are collected from; none, nothing but the instructions to look at. */
  readonly signalSources?: HeartbeatSignalRegistry;
  /** What memory bears on a tick: the person's accepted, in-scope records for the instructions or the new signals. */
  readonly memoryContext?: (
    state: HeartbeatState,
    query: { readonly kind: "signal" | "deep"; readonly signals: readonly HeartbeatSignal[] },
  ) => Promise<readonly MemoryExcerpt[]>;
  /** Runs a provider's model turn (`host.runTurn`); absent, a provider that asks for one fails its tick. */
  readonly runTurn?: (request: HeartbeatTurnRequest) => Promise<HeartbeatTurnResult>;
  /** One tick's body; the default asks the provider and records what it reported. */
  readonly runTick?: (input: HeartbeatTickBodyInput) => Promise<HeartbeatTickBodyResult>;
  /** Where what a heartbeat tells goes: Home and its targets. Absent, items are still decided and kept in the ledger. */
  readonly delivery?: HeartbeatDeliveryPort;
  /** Told once when a heartbeat pauses by itself (provider, failures, budget), besides its alert. */
  readonly announcePause?: (state: HeartbeatState, reason: HeartbeatPauseReason, message: string) => Promise<void>;
  /** Signals seen before are gone: told on every collection, even when the tick then skips, so retraction never waits. */
  readonly onSignalsGone?: (state: HeartbeatState, gone: readonly string[]) => Promise<void>;
  /** A new active window opened: the digest's trigger. */
  readonly onWindowOpened?: (state: HeartbeatState, window: { readonly start: string; readonly end: string }) => Promise<void>;
  readonly log: (level: "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
}

export interface HeartbeatSweepResult {
  readonly ran: readonly HeartbeatTickRecord[];
  readonly unreadable: readonly string[];
}

export type CheckNowAnswer = { readonly status: "started" | "queued" } | { readonly status: "refused"; readonly reason: string };

export interface HeartbeatHostHandle {
  /** One sweep now: tests and the timer both use it. */
  sweep(): Promise<HeartbeatSweepResult>;
  /** A sweep because a tick fell due, tracked as the timer's are (`idle` waits for it); joins one the timer or a planner started. */
  sweepDue(): Promise<void>;
  /** Check now: one deep tick at once, or queued behind one in flight; refused while paused or off. */
  checkNow(workspaceId: string, principalId: string): Promise<CheckNowAnswer>;
  /**
   * An event that may need the person: an inbound message, a need
   * close to its deadline, a failed run. Debounced per person; `now` asks for
   * a look soon (at most one event tick every 10 minutes, metered like any),
   * `next` that the next scheduled tick looks even with nothing new. Outside
   * the active hours it waits for the window; an off or paused heartbeat
   * ignores it.
   */
  wake(workspaceId: string, principalId: string, event: HeartbeatWakeEvent): void;
  /** Settles when every tick this host started has finished; tests await it. */
  idle(): Promise<void>;
  stop(): void;
}

/** What woke a heartbeat, and whether it asks for a look now or at the next tick. */
export interface HeartbeatWakeEvent {
  readonly reason: "message" | "need" | "failed-run";
  readonly mode: "now" | "next";
}

/** Events for one person within this long are one wake. */
export const HEARTBEAT_EVENT_DEBOUNCE_MS = 60_000;
/** At most one event tick per person this often; a later event waits for the next scheduled look. */
export const HEARTBEAT_EVENT_TICK_EVERY_MS = 10 * 60_000;

/** What a provider is shown of what was told lately (`recent`): this far back, at most this many. */
export const HEARTBEAT_RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const HEARTBEAT_RECENT_ENTRIES = 20;
/** This many failed ticks in a row pause a heartbeat (`failures`). */
export const HEARTBEAT_FAILURES_TO_PAUSE = 5;
/** A failures alert is repeated at most this often. */
export const HEARTBEAT_FAILURE_ALERT_EVERY_MS = 6 * 60 * 60_000;
/** A provider's next-wake hint is never sooner than this (or the interval, when shorter). */
export const HEARTBEAT_HINT_FLOOR_MS = 15 * 60_000;

/**
 * Where a provider's next-wake hint lands: within
 * [min(15 min, interval), interval] of now, or nowhere when it does not
 * parse. A hint is a time to look again, never a way around the interval.
 */
export function clampHeartbeatHint(hint: string, now: Date, everyMs: number): Date | undefined {
  const at = Date.parse(hint);
  if (!Number.isFinite(at)) return undefined;
  const floor = Math.min(HEARTBEAT_HINT_FLOOR_MS, everyMs);
  return new Date(now.getTime() + Math.min(everyMs, Math.max(floor, at - now.getTime())));
}

/** Busy means a person's newest Home entry is younger than this. */
export const HEARTBEAT_BUSY_WINDOW_MS = 5 * 60_000;
/** A full disk is logged at most this often, so it cannot fill the log every sweep. */
export const HEARTBEAT_DISK_LOG_EVERY_MS = 60 * 60_000;

/** What a tick is given after G1 and G3: its kind, its new signals, the gone keys, its memory, and what it records it was given. */
interface Prepared {
  readonly kind: "signal" | "deep";
  readonly signals: readonly HeartbeatSignal[];
  readonly gone: readonly string[];
  /** Items resolved because their signals are gone. */
  readonly retracted: number;
  readonly memory: readonly MemoryExcerpt[];
  readonly inputs: {
    readonly instructionsRevision: number;
    readonly signalKeys: readonly string[];
    readonly memory: readonly { readonly recordId: string; readonly revisionId: string }[];
    readonly sourceErrors?: readonly { readonly source: string; readonly error: string }[];
  };
}

const keyOf = (workspaceId: string, principalId: string): string => `${workspaceId}\u0000${principalId}`;

/** Whether instructions hold anything but blank lines, headings and comments. */
export function instructionsHaveContent(instructions: string): boolean {
  return instructions.split("\n").some((line) => {
    const text = line.trim();
    return text !== "" && !text.startsWith("#") && !text.startsWith("<!--") && !text.startsWith("//");
  });
}

/** Whether a deep look is due: none yet, or the last older than the deep interval. */
export function deepTickDue(state: Pick<HeartbeatState, "lastDeepTickAt" | "config">, now: Date): boolean {
  return state.lastDeepTickAt === undefined || now.getTime() - Date.parse(state.lastDeepTickAt) >= state.config.deepCheckEveryMs;
}

/** A pause that has run out: a `user` pause with `until`, or any `budget` pause past its `until`. */
function pauseExpired(paused: HeartbeatPause, now: Date): boolean {
  return (
    (paused.reason === "user" || paused.reason === "budget") && paused.until !== undefined && Date.parse(paused.until) <= now.getTime()
  );
}

/**
 * Start the host's sweep. Nothing runs outside active hours, while paused,
 * on a full disk, with no model or no provider, or while the person is using
 * Home. Skips at the gates are recorded — closed hours as one row per window,
 * a full disk at most hourly — except a paused heartbeat's, whose pause is its
 * status; none counts as a failure. Two ticks of one heartbeat never run at
 * once in this host: a tick's key is reserved before anything is awaited.
 */
export function startHeartbeatHost(
  deps: HeartbeatHostDependencies & {
    readonly sweepMs: number;
    /**
     * How often the host's own timer sweeps; absent, `sweepMs`. An owner that
     * sweeps when the next tick falls due (`sweepDue`) keeps this timer only as
     * a slow fallback. `sweepMs` still paces a busy Home's one wait.
     */
    readonly sweepEveryMs?: number;
    /** What runs that timer; absent, `setInterval`. */
    readonly every?: RepeatTimer;
    readonly eventDebounceMs?: number;
  },
): HeartbeatHostHandle {
  const inFlight = new Set<string>();
  /** Providers still running past their deadline: their heartbeat waits until they settle. */
  const overdue = new Map<string, object>();
  const queuedManual = new Set<string>();
  /** Heartbeats that already waited once this interval for the person to finish in Home. */
  const deferred = new Set<string>();
  const diskLoggedAt = new Map<string, number>();
  const running = new Set<Promise<void>>();
  const runTick = deps.runTick ?? askProvider(deps.runTurn, deps.providerStates);
  /** Wakes being debounced, by person, with whether any asked for a look now. */
  const debouncing = new Map<string, { readonly timer: ReturnType<typeof setTimeout>; now: boolean }>();
  /** People whose next scheduled tick is an event's: it looks even with nothing new. */
  const pendingEvents = new Set<string>();
  /** When each person's last event tick ran (ms), for the one-per-10-minutes limit. */
  const lastEventTick = new Map<string, number>();
  /** When the gate last recorded turning each person's event away (ms), so those rows are limited the same way. */
  const lastEventGateSkip = new Map<string, number>();
  let stopped = false;

  const busyHere = (key: string): boolean => inFlight.has(key) || overdue.has(key);

  /**
   * A heartbeat check's envelope for mods: its turn's task, or
   * `heartbeat:<tickId>` when no turn ran; unattended, and naming the provider
   * so that plugin's own hooks pass it over.
   */
  const heartbeatEnvelope = (state: HeartbeatState, taskId: string): ModEnvelope =>
    Object.freeze({
      workspaceId: state.workspaceId,
      principalId: state.principalId,
      taskId,
      runId: taskId,
      source: "heartbeat" as const,
      chatKind: "run" as const,
      attended: false,
      ...(state.config.providerId === "off" ? {} : { heartbeatProvider: state.config.providerId }),
    });

  /** Tell mods a check was recorded (`heartbeat.tick`, an observer): when and why it ran and how it ended, never what it looked at. */
  const observeTick = (state: HeartbeatState, recorded: HeartbeatTickRecord): void => {
    const hooks = deps.hooks;
    if (hooks === undefined || recorded.wakeReason === null || hooks.hasEvent?.("heartbeat.tick") === false) return;
    const wake = recorded.wakeReason;
    track(
      (async () => {
        const envelope = heartbeatEnvelope(state, recorded.taskId ?? `heartbeat:${recorded.tickId}`);
        if (!hooks.has("heartbeat.tick", envelope)) return;
        const timezone = await deps.timezoneOf(state.workspaceId);
        await hooks.dispatch(
          "heartbeat.tick",
          {
            envelope,
            now: recorded.createdAt,
            timezone,
            wake,
            kind: recorded.kind,
            ...(recorded.outcome === "skipped" || recorded.outcome === "deferred"
              ? recorded.reason === null
                ? {}
                : { gate: recorded.reason }
              : {}),
            outcome: recorded.outcome,
            itemsNow: recorded.itemsNow,
            itemsLater: recorded.itemsLater,
            ...(recorded.tokens > 0 || recorded.costUsd !== null ? { usage: { tokens: recorded.tokens, costUsd: recorded.costUsd } } : {}),
          },
          async () => undefined,
        );
      })().catch((error: unknown) =>
        deps.log("warn", "mods could not be told of a heartbeat check", { workspaceId: state.workspaceId, error: errorMessage(error) }),
      ),
    );
  };

  const record = async (
    state: HeartbeatState,
    row: Omit<RecordHeartbeatTickInput, "tickId" | "workspaceId" | "principalId" | "now"> & {
      readonly now?: string;
      readonly tickId?: string;
    },
  ): Promise<HeartbeatTickRecord> => {
    const { tickId, ...rest } = row;
    const recorded = await deps.repository.recordTick({
      tickId: tickId ?? deps.newId("hbt"),
      workspaceId: state.workspaceId,
      principalId: state.principalId,
      ...rest,
      now: row.now ?? deps.now().toISOString(),
    });
    observeTick(state, recorded);
    return recorded;
  };

  const blank = {
    kind: null,
    wakeReason: null,
    reason: null,
    pauseReason: null,
    providerId: null,
    taskId: null,
    itemsNow: 0,
    itemsLater: 0,
    itemsRetracted: 0,
    inputs: null,
    hookDecisions: null,
    tokens: 0,
    cacheReadTokens: 0,
    costUsd: null,
    durationMs: 0,
    error: null,
    providerDev: false,
    advancesLastTick: false,
  } as const;

  const skip = async (
    state: HeartbeatState,
    reason: HeartbeatSkipReason,
    wakeReason: HeartbeatWakeReason,
    outcome: "skipped" | "deferred" = "skipped",
    pauseReason: HeartbeatPauseReason | null = state.config.paused?.reason ?? null,
  ): Promise<HeartbeatTickRecord> =>
    await record(state, {
      ...blank,
      outcome,
      reason,
      wakeReason,
      pauseReason,
      providerId: state.config.providerId === "off" ? null : state.config.providerId,
    });

  const pause = async (
    state: HeartbeatState,
    reason: HeartbeatPauseReason,
    message: string,
    until?: string,
    alert = true,
  ): Promise<void> => {
    await deps.repository.setPaused({
      workspaceId: state.workspaceId,
      principalId: state.principalId,
      paused: { reason, ...(until === undefined ? {} : { until }) },
      now: deps.now().toISOString(),
    });
    deps.log("warn", "a heartbeat paused itself", {
      workspaceId: state.workspaceId,
      principalId: state.principalId,
      reason,
      ...(until === undefined ? {} : { until }),
    });
    // The alert takes the items' path: Home or the Center, plus the targets; told once per pause.
    if (alert && deps.delivery !== undefined) {
      track(
        deliverHeartbeatAlert(
          deps.delivery,
          state,
          { key: `pause:${reason}:${deps.now().toISOString()}`, title: textRef("notice.heartbeat.paused.title"), text: message },
          deps.log,
        ),
      );
    }
    await deps.announcePause?.(state, reason, message);
  };

  /**
   * What is left of today's budget: the day starts at midnight in the
   * heartbeat's timezone; a dollar limit holds against what the priced calls
   * cost, so an unpriced call never lifts it (and is capped by tokens and ticks).
   */
  const budgetLeft = async (state: HeartbeatState, timezone: string, now: Date): Promise<BudgetLeft> => {
    const since = startOfLocalDay(now, timezone).toISOString();
    const usage = await deps.repository.usageSince({ workspaceId: state.workspaceId, principalId: state.principalId, since });
    const { budget } = state.config;
    return {
      modelTicks: budget.modelTicksPerDay - usage.modelTicks,
      tokens: budget.tokensPerDay - usage.tokens,
      ...(budget.usdPerDay === undefined ? {} : { usd: budget.usdPerDay - usage.pricedUsd }),
    };
  };

  /** When a budget pause ends: the first active window after tonight's reset. */
  const budgetResumesAt = (state: HeartbeatState, timezone: string, now: Date): string => {
    const midnight = startOfNextLocalDay(now, timezone);
    const window = heartbeatWindowAt(state.config, timezone, midnight) ?? nextHeartbeatWindow(state.config, timezone, midnight);
    return (window.start.getTime() < midnight.getTime() ? midnight : window.start).toISOString();
  };

  /** The day's budget is spent: it rests until its next window after tonight's reset, said once. */
  const restForBudget = async (state: HeartbeatState, timezone: string, now: Date): Promise<void> => {
    const until = budgetResumesAt(state, timezone, now);
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(until));
    await pause(
      state,
      "budget",
      `The heartbeat used today's budget, or has too little of it left for another check, and rests until ${local}.`,
      until,
    );
  };

  /** Hand a check's signals back as new: it did not look at them (failed, declined, stopped). */
  const unsee = async (state: HeartbeatState, prepared: Prepared): Promise<void> => {
    if (prepared.signals.length === 0) return;
    try {
      await deps.repository.unseeSignals({
        workspaceId: state.workspaceId,
        principalId: state.principalId,
        keys: prepared.signals.map((signal) => signal.key),
      });
    } catch (error) {
      deps.log("warn", "a heartbeat could not hand its signals back to the next check", {
        workspaceId: state.workspaceId,
        error: errorMessage(error),
      });
    }
  };

  /** Paused now: a pause that has not run out. */
  const pausedNow = (state: HeartbeatState, now: Date): boolean =>
    state.config.paused !== undefined && !pauseExpired(state.config.paused, now);

  /**
   * G0 for any wake: off, paused (resuming an expired pause), disk, model, provider. `entry`: go on.
   * `quiet` turns a provider-off, provider-reloading or no-model refusal away without its row.
   */
  const gateZero = async (
    state: HeartbeatState,
    wakeReason: HeartbeatWakeReason,
    quiet = false,
  ): Promise<
    { readonly entry: HeartbeatProviderEntry; readonly left: BudgetLeft } | { readonly skipped: HeartbeatTickRecord | undefined }
  > => {
    const now = deps.now();
    const refuse = async (reason: HeartbeatSkipReason): Promise<{ readonly skipped: HeartbeatTickRecord | undefined }> => ({
      skipped: quiet ? undefined : await skip(state, reason, wakeReason, "skipped", null),
    });
    if (!state.config.enabled) return { skipped: undefined };
    if (state.config.paused !== undefined) {
      if (pausedNow(state, now)) return { skipped: undefined };
      // Only the pause that ran out is cleared, in one conditional write: one set meanwhile (the person's, a new budget pause) stays.
      if (
        !(await deps.repository.clearPause({
          workspaceId: state.workspaceId,
          principalId: state.principalId,
          paused: state.config.paused,
          now: now.toISOString(),
        }))
      )
        return { skipped: undefined };
    }
    const free = deps.freeBytes?.();
    if (free !== undefined && free < MIN_FREE_BYTES_FOR_A_FIRE) {
      const key = keyOf(state.workspaceId, state.principalId);
      const last = diskLoggedAt.get(key);
      if (last !== undefined && now.getTime() - last < HEARTBEAT_DISK_LOG_EVERY_MS) {
        // The log line is throttled, but a Check now still gets its row: the page that asked waits for one.
        return { skipped: wakeReason === "manual" ? await skip(state, "disk-full", wakeReason, "skipped", null) : undefined };
      }
      diskLoggedAt.set(key, now.getTime());
      deps.log("warn", "a heartbeat tick was skipped: the data directory is nearly full", {
        workspaceId: state.workspaceId,
        freeBytes: free,
      });
      return { skipped: await skip(state, "disk-full", wakeReason, "skipped", null) };
    }
    if (state.config.providerId === "off") return await refuse("provider-off");
    const entry = deps.providers.get(state.config.providerId);
    // A dev provider reloading after a save: this tick waits for it, and nothing pauses.
    if (entry === undefined && deps.providers.reloading(state.config.providerId)) return await refuse("provider-reloading");
    if (entry === undefined) {
      // Never a silent switch to another provider: its data flows differ.
      await pause(
        state,
        "provider",
        `The heartbeat paused: its provider ${state.config.providerId} is not available. Use the built-in one, or pick another.`,
      );
      return { skipped: await skip(state, "provider-unavailable", wakeReason, "skipped", "provider") };
    }
    if (!(await deps.modelAvailable(state))) return await refuse("no-model");
    // The day's budget: spent, the heartbeat rests until its next window after tonight's reset, said once.
    const timezone = await deps.timezoneOf(state.workspaceId);
    const left = await budgetLeft(state, timezone, now);
    if (left.modelTicks <= 0 || left.tokens <= 0 || (left.usd !== undefined && left.usd <= 0)) {
      await restForBudget(state, timezone, now);
      return { skipped: await skip(state, "budget", wakeReason, "skipped", "budget") };
    }
    return { entry, left };
  };

  /**
   * Collect and compare the signals, then G1 and G3: `skip` when
   * nothing is new and no deep look is due (or there are no instructions to
   * look at); otherwise the tick's kind, its new signals and its memory. A
   * manual check always looks deeper. Gone keys are passed on either way.
   */
  const prepare = async (
    state: HeartbeatState,
    timezone: string,
    now: Date,
    why: "scheduled" | "event" | "manual",
  ): Promise<{ readonly skip: HeartbeatSkipReason } | Prepared> => {
    const manual = why === "manual";
    const collection: HeartbeatCollection =
      deps.signalSources === undefined
        ? { signals: [], errors: [], incomplete: [], sources: [], expiring: [] }
        : await collectHeartbeatSignals(deps.signalSources, {
            workspaceId: state.workspaceId,
            principalId: state.principalId,
            now: now.toISOString(),
            timezone,
            skip: state.config.disabledSources,
          });
    const observed = await deps.repository.observeSignals({
      workspaceId: state.workspaceId,
      principalId: state.principalId,
      now: now.toISOString(),
      signals: collection.signals.map((signal) => ({ key: signal.key, hash: signal.hash, source: signal.source })),
      keep: collection.incomplete,
      ...(deps.signalSources === undefined ? {} : { sources: collection.sources }),
    });
    // The signals are recorded as seen from here: a failure past this point is noted, never the tick's end.
    const problems: { source: string; error: string }[] = [...collection.errors];
    let retracted = 0;
    if (observed.gone.length > 0) {
      try {
        // Retraction never waits for a tick: an item whose signals are all gone is resolved now.
        // A key that left by age (a failure past its day) is forgotten, but nothing it told is called resolved.
        const resolving = observed.gone.filter((key) => !collection.expiring.some((id) => key.startsWith(`${id}:`)));
        const resolved =
          resolving.length === 0
            ? []
            : await deps.repository.resolveItems({
                workspaceId: state.workspaceId,
                principalId: state.principalId,
                goneSignalKeys: resolving,
                now: now.toISOString(),
              });
        retracted = resolved.length;
        if (resolved.length > 0 && deps.delivery !== undefined)
          track(retractHeartbeatItems(deps.delivery, state, resolved, now, timezone, deps.log));
        await deps.onSignalsGone?.(state, observed.gone);
      } catch (error) {
        problems.push({ source: "retraction", error: errorMessage(error).slice(0, 200) });
      }
    }
    const freshKeys = new Set(observed.fresh);
    const fresh = collection.signals.filter((signal) => freshKeys.has(signal.key));
    const content = instructionsHaveContent(state.config.instructions);
    if (!manual && fresh.length === 0) {
      // G1: nothing to look at; G3: nothing new, and no deep look due — an event is itself the reason to look.
      if (!content) return { skip: "empty" };
      if (why === "scheduled" && !deepTickDue(state, now)) return { skip: "nothing-new" };
    }
    const kind: "signal" | "deep" = manual || (content && deepTickDue(state, now)) ? "deep" : "signal";
    let memory: readonly MemoryExcerpt[] = [];
    try {
      memory = boundHeartbeatMemory((await deps.memoryContext?.(state, { kind, signals: fresh })) ?? []);
    } catch (error) {
      problems.push({ source: "memory", error: errorMessage(error).slice(0, 200) });
    }
    const inputs = {
      instructionsRevision: state.config.revision,
      signalKeys: fresh.map((signal) => signal.key),
      memory: memory.map((record) => ({ recordId: record.recordId, revisionId: record.revisionId })),
      ...(problems.length === 0
        ? {}
        : { sourceErrors: problems.map((problem) => ({ source: problem.source, error: maskedText(problem.error, 200) })) }),
    };
    return { kind, signals: fresh, gone: observed.gone, retracted, memory, inputs };
  };

  /**
   * G4: asks a provider's precheck whether this tick is worth running,
   * within a signal source's deadline. Only a plain `wake: false` skips it: a
   * precheck that throws, is slow or answers oddly lets the tick run, since a
   * failure to save a tick must never cost one. An external provider is given
   * the new signals' keys only with its `signals` egress.
   */
  const precheckDeclines = async (
    state: HeartbeatState,
    entry: HeartbeatProviderEntry,
    prepared: Prepared,
    wake: HeartbeatTickBodyInput["wake"],
  ): Promise<boolean> => {
    const precheck = entry.provider.precheck;
    if (typeof precheck !== "function") return false;
    const shares = entry.kind === "builtin" || (entry.receives.includes("signals") && state.config.providerEgress.signals);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        precheck.call(
          entry.provider,
          Object.freeze({
            wake: Object.freeze({ ...wake }),
            kind: prepared.kind,
            signalKeys: Object.freeze(shares ? prepared.signals.map((signal) => signal.key) : []),
            signal: entry.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, entry.signal]),
          }),
        ),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            controller.abort(new Error("the heartbeat precheck ran past its time"));
            resolve(undefined);
          }, HEARTBEAT_LIMITS.sourceDeadlineMs);
        }),
      ]);
      return answer?.wake === false;
    } catch {
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /**
   * One tick, its key already reserved by the caller. The deadline aborts the
   * provider's signal and stops waiting for it: a provider that ignores the
   * signal is recorded as failed, and its heartbeat waits until it settles,
   * without holding up the sweep or any other heartbeat.
   */
  const tick = async (
    state: HeartbeatState,
    entry: HeartbeatProviderEntry,
    left: BudgetLeft,
    wakeReason: HeartbeatWakeReason,
    scheduledAt: string,
    timezone: string,
    prepared: Prepared,
  ): Promise<HeartbeatTickRecord> => {
    const key = keyOf(state.workspaceId, state.principalId);
    const started = deps.now();
    const tickId = deps.newId("hbt");
    // Read before the provider's time starts: what it told lately, and what became of it.
    // Never from before the provider was chosen: one provider is not shown what another told.
    const windowStart = new Date(started.getTime() - HEARTBEAT_RECENT_WINDOW_MS).toISOString();
    const since = state.providerSince !== undefined && state.providerSince > windowStart ? state.providerSince : windowStart;
    // A store that fails here hands the signals back too: the check never looked.
    const rows = await deps.repository
      .recentItems({ workspaceId: state.workspaceId, principalId: state.principalId, since, limit: HEARTBEAT_RECENT_ENTRIES })
      .catch(async (error: unknown) => {
        await unsee(state, prepared);
        throw error;
      });
    const recent = rows.map(
      (row): LedgerEntry => ({
        key: row.key,
        state: row.state,
        urgency: row.urgency,
        title: row.title,
        ...(row.feedback === undefined ? {} : { feedback: row.feedback }),
        lastToldAt: row.lastToldAt,
      }),
    );
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopWatching = (): void => undefined;
    const deadline = new Promise<"timeout" | "withdrawn">((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error("the heartbeat tick ran past its time"));
        resolve("timeout");
      }, entry.maxTickSeconds * 1000);
      // Its plugin stopped (disabled, withdrawn, reloaded): the tick stops with it, without waiting on the provider.
      const withdrawn = (): void => {
        controller.abort(new Error("the heartbeat provider stopped"));
        resolve("withdrawn");
      };
      if (entry.signal?.aborted === true) withdrawn();
      entry.signal?.addEventListener("abort", withdrawn, { once: true });
      stopWatching = () => entry.signal?.removeEventListener("abort", withdrawn);
    });
    /** Whether this check looked at its signals; until it says so, they are handed back. */
    let told_ = false;
    const body = runTick({
      state,
      entry,
      wake: { reason: wakeReason, scheduledAt, now: started.toISOString(), timezone },
      kind: prepared.kind,
      signals: prepared.signals,
      gone: prepared.gone,
      memory: prepared.memory,
      recent,
      budget: tickBudget(left),
      signal: controller.signal,
    });
    try {
      const raced = await Promise.race([body, deadline]);
      // The provider answered: a `host` it kept can start no turn while the check is recorded.
      controller.abort(new Error("the heartbeat tick ended"));
      const answered: HeartbeatTickBodyResult =
        raced === "timeout"
          ? {
              outcome: "failed",
              kind: prepared.kind,
              items: [],
              reason: "timeout",
              error: `the provider ran past its ${entry.maxTickSeconds} s`,
            }
          : raced === "withdrawn"
            ? // A dev provider reloading after a save: never a failure, so reloads cannot pause it.
              entry.dev === true
              ? { outcome: "skipped", kind: prepared.kind, items: [], reason: "provider-reloading" }
              : {
                  outcome: "failed",
                  kind: prepared.kind,
                  items: [],
                  reason: "provider-stopped",
                  error: "the heartbeat provider stopped during the check",
                }
            : raced;
      // The person chose another provider while this one answered: what it told and its memo are not the new one's to inherit.
      const switched = (await deps.repository.get(state.workspaceId, state.principalId))?.config.providerId !== state.config.providerId;
      const { memo: _staleMemo, ...withoutMemo } = answered;
      const kept: HeartbeatTickBodyResult = switched
        ? { ...withoutMemo, items: [], ...(answered.outcome === "reported" ? { outcome: "quiet" as const } : {}) }
        : answered;
      // A turn the day's budget could not fit: the budget is spent, not the provider failing.
      const overBudget = kept.outcome === "failed" && kept.reason === "budget";
      const result: HeartbeatTickBodyResult = overBudget ? { ...kept, outcome: "skipped" } : kept;
      if (raced === "timeout") {
        // Its heartbeat waits for the provider to settle, but not forever: once it is twice its time, it runs again.
        const mark = {};
        overdue.set(key, mark);
        const release = (): void => {
          if (overdue.get(key) !== mark) return;
          overdue.delete(key);
          drainManual(state.workspaceId, state.principalId);
        };
        const cap = setTimeout(() => {
          deps.log("warn", "a heartbeat provider never settled after its check ran out; its heartbeat runs again", {
            workspaceId: state.workspaceId,
            providerId: state.config.providerId,
          });
          release();
        }, entry.maxTickSeconds * 1000);
        cap.unref?.();
        // The tick's body reports its own failure; this only clears the running mark.
        void body
          .catch(() => undefined)
          .finally(() => {
            clearTimeout(cap);
            release();
          });
      }
      // What is told is decided, and written to the ledger, before the tick is recorded.
      const knownRefs = new Set([...prepared.signals.map((signal) => signal.key), ...prepared.memory.map((record) => record.recordId)]);
      // Each item past dedup and mute is put to mods' heartbeat.item hooks; what they decided goes on the record.
      // By the item's place in the answer: hooks run together, and the record lists them in a stable order.
      const decisions = new Map<string, HeartbeatHookDecision>();
      const hooks = deps.hooks;
      const itemHook =
        hooks === undefined || hooks.hasEvent?.("heartbeat.item") === false
          ? undefined
          : async (item: HeartbeatItem): Promise<HeartbeatItemVerdict> => {
              const envelope = heartbeatEnvelope(state, result.taskId ?? `heartbeat:${tickId}`);
              if (!hooks.has("heartbeat.item", envelope)) return {};
              try {
                const outcome = await hooks.dispatch(
                  "heartbeat.item",
                  {
                    envelope,
                    now: deps.now().toISOString(),
                    timezone,
                    key: item.key,
                    urgency: item.urgency,
                    title: item.title,
                    sources: item.sources.map((source) => ({
                      label: source.label,
                      ...(source.ref === undefined ? {} : { ref: source.ref }),
                    })),
                    signalKeys: item.signalKeys ?? [],
                  },
                  async () => ({}),
                );
                if (outcome.decidedBy !== undefined) {
                  // A hold-back's reason is the mod's own words: masked, and bounded, before it is kept.
                  const reason =
                    "drop" in outcome.result
                      ? (redactToolOutput({ reason: outcome.result.drop }).value as { reason: string }).reason.slice(0, 200)
                      : undefined;
                  decisions.set(item.key, {
                    key: item.key,
                    by: outcome.decidedBy,
                    action: reason === undefined ? "made it wait for the summary" : "held back",
                    ...(reason === undefined ? {} : { reason }),
                  });
                }
                return outcome.result;
              } catch (error) {
                // A hook's own failure is the registry's to stand in for; this is the dispatch failing, and the item is told as decided.
                deps.log("warn", "mods could not be asked about a heartbeat item; it is told as decided", {
                  workspaceId: state.workspaceId,
                  error: errorMessage(error),
                });
                return {};
              }
            };
      const told =
        result.items.length === 0
          ? []
          : await planHeartbeatDelivery(
              deps,
              state,
              cleanHeartbeatItems(
                result.items,
                knownRefs,
                knownUrlSet(heartbeatWatchedPages(state.config.instructions).map((page) => page.url)),
              ),
              deps.now(),
              itemHook,
            );
      const outcome = result.outcome === "reported" && told.length === 0 ? "quiet" : result.outcome;
      // The fifth failure in a row pauses it (skips, deferrals and other rows never count, a success ends the run).
      const failing = outcome === "failed" && (await failedInARow(state)) + 1 >= HEARTBEAT_FAILURES_TO_PAUSE;
      if (result.memo !== undefined) {
        await deps.repository.setMemo({
          workspaceId: state.workspaceId,
          principalId: state.principalId,
          memo: storedMemo(result.memo),
          now: deps.now().toISOString(),
        });
      }
      // A check that never looked (failed, timed out, over budget, its provider switched or stopped) told nothing of
      // what it was given: those signals are new again for the next check.
      const looked = !switched && heartbeatTickLooked(outcome);
      const recorded = await record(state, {
        ...blank,
        tickId,
        kind: result.kind,
        wakeReason,
        outcome,
        reason: result.reason ?? null,
        providerId: state.config.providerId,
        taskId: result.taskId ?? null,
        itemsNow: told.filter((row) => row.urgency === "now").length,
        itemsLater: told.filter((row) => row.urgency === "later").length,
        itemsRetracted: prepared.retracted,
        inputs: result.inputs ?? prepared.inputs,
        hookDecisions: decisions.size > 0 ? result.items.flatMap((item) => decisions.get(item.key) ?? []) : (result.hookDecisions ?? null),
        tokens: result.tokens ?? 0,
        cacheReadTokens: result.cacheReadTokens ?? 0,
        costUsd: result.costUsd ?? null,
        durationMs: Math.max(0, deps.now().getTime() - started.getTime()),
        // A provider's or a model's words: masked before they are kept or shown.
        error: result.error === undefined ? null : maskedText(result.error, 500),
        ...(failing ? { pauseReason: "failures" as const } : overBudget ? { pauseReason: "budget" as const } : {}),
        providerDev: entry.dev === true,
        advancesLastTick: true,
        // A check whose provider was switched away did not look, whatever it answered.
        ...(switched ? { advancesDeepTick: false } : {}),
      });
      // Only once it is on the record: a check that looked but could not be recorded hands its signals back (what it
      // told stays deduplicated by the ledger).
      if (looked) told_ = true;
      if (overBudget) {
        await restForBudget(state, timezone, deps.now());
      } else if (raced === "withdrawn" && entry.dev !== true && !switched) {
        // Never a silent switch to another provider, and no waiting for the next check to find it gone.
        await pause(
          state,
          "provider",
          `The heartbeat paused: its provider ${state.config.providerId} stopped. Use the built-in one, or pick another.`,
        );
      } else if (failing) {
        await pause(
          state,
          "failures",
          `The heartbeat failed ${HEARTBEAT_FAILURES_TO_PAUSE} times in a row (last: ${(result.reason ?? "unknown").replaceAll("-", " ")}) and paused; resume it once the cause is fixed (the log has the error).`,
          undefined,
          await failureAlertDue(state, recorded),
        );
      } else if (result.nextWakeHint !== undefined) {
        // A hint only brings the next look closer, within the clamp and inside the active hours.
        const hinted = clampHeartbeatHint(result.nextWakeHint, deps.now(), state.config.everyMs);
        const current = await deps.repository.get(state.workspaceId, state.principalId);
        if (
          hinted !== undefined &&
          current?.nextTickAt !== undefined &&
          hinted.getTime() < Date.parse(current.nextTickAt) &&
          heartbeatWindowAt(state.config, timezone, hinted) !== undefined
        ) {
          await deps.repository.setNextTick({
            workspaceId: state.workspaceId,
            principalId: state.principalId,
            nextTickAt: hinted.toISOString(),
            now: deps.now().toISOString(),
          });
        }
      }
      // Told after the record, and after the tick lets go of its heartbeat: a send may wait on the channel's pacer.
      if (told.length > 0 && deps.delivery !== undefined) track(deliverHeartbeatItems(deps.delivery, state, told, deps.log));
      return recorded;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      stopWatching();
      // The check is over, however it ended: a provider still holding `host` can no longer run a turn or publish.
      controller.abort(new Error("the heartbeat tick ended"));
      // A check that never looked — or failed on the way (a store error) — told nothing of what it was given: those
      // signals are new again for the next check.
      if (!told_ && prepared.signals.length > 0) await unsee(state, prepared);
    }
  };

  /**
   * The first look in a new window, whichever wakes it (a sweep, an event, Check
   * now): the closed hours since the last row are one row, and the digest's
   * moment. The row advances the last-row mark, so it is written once
   * per window whatever the gates decide.
   */
  const openWindow = async (
    state: HeartbeatState,
    wakeReason: HeartbeatWakeReason,
    window: { readonly start: Date; readonly end: Date } | undefined,
  ): Promise<void> => {
    if (window === undefined || state.lastTickAt === undefined || Date.parse(state.lastTickAt) >= window.start.getTime()) return;
    await record(state, { ...blank, kind: "window", outcome: "skipped", reason: "hours", wakeReason, advancesLastTick: true });
    await deps.onWindowOpened?.(state, { start: window.start.toISOString(), end: window.end.toISOString() });
    track(digest(state, window.start.toISOString()));
  };

  /** The digest when a window opens: its row is written whenever it listed anything, with Home off and no targets too. */
  const digest = async (state: HeartbeatState, start: string): Promise<void> => {
    const port: HeartbeatDeliveryPort = deps.delivery ?? {
      notify: async () => false,
      send: async () => "skipped",
      edit: async () => false,
    };
    // Since the window before this one opened: what it, the closed hours or a Check now between told waits for this summary.
    const previous = previousHeartbeatWindow(state.config, await deps.timezoneOf(state.workspaceId), new Date(start));
    const listed = await deliverHeartbeatDigest(
      deps,
      port,
      state,
      { start, ...(previous === undefined ? {} : { since: previous.start.toISOString() }) },
      deps.now(),
      deps.log,
    );
    if (listed > 0) await record(state, { ...blank, kind: "digest", outcome: "delivered", itemsLater: listed });
  };

  /**
   * Whether this failures pause is told: at most one alert every 6 h,
   * however often the heartbeat is resumed and fails again. Which earlier
   * pauses were told is read back from the log — each was, if none told
   * within 6 h before it — so it holds across a restart.
   */
  const failureAlertDue = async (state: HeartbeatState, current: HeartbeatTickRecord): Promise<boolean> => {
    const now = Date.parse(current.createdAt);
    const since = new Date(now - 7 * 24 * 60 * 60_000).toISOString();
    const pauses = (
      await deps.repository.listTicks({ workspaceId: state.workspaceId, principalId: state.principalId, since, ranOnly: true, limit: 500 })
    )
      .filter((row) => row.tickId !== current.tickId && row.pauseReason === "failures")
      .map((row) => Date.parse(row.createdAt))
      .sort((a, b) => a - b);
    let lastTold = Number.NEGATIVE_INFINITY;
    for (const at of pauses) if (at - lastTold >= HEARTBEAT_FAILURE_ALERT_EVERY_MS) lastTold = at;
    return now - lastTold >= HEARTBEAT_FAILURE_ALERT_EVERY_MS;
  };

  /** How many provider ticks failed in a row before this one, newest first. */
  const failedInARow = async (state: HeartbeatState): Promise<number> => {
    let count = 0;
    // Only ticks that asked the provider: however many skips lie between, the last five failures are read.
    for (const row of await deps.repository.listTicks({
      workspaceId: state.workspaceId,
      principalId: state.principalId,
      ranOnly: true,
      limit: HEARTBEAT_FAILURES_TO_PAUSE,
    })) {
      if (row.kind !== "signal" && row.kind !== "deep") continue;
      if (row.outcome === "skipped" || row.outcome === "deferred" || (row.outcome === "failed" && row.reason === "budget")) continue;
      if (row.outcome !== "failed" || row.pauseReason === "failures") break;
      count += 1;
    }
    return count;
  };

  const track = (work: Promise<void>): void => {
    const settled = work.catch((error: unknown) => deps.log("warn", "a heartbeat tick could not run", { error: errorMessage(error) }));
    running.add(settled);
    void settled.finally(() => running.delete(settled));
  };

  /**
   * A queued Check now runs as soon as nothing of its heartbeat runs here:
   * asked wherever a tick's key is released, so it is never left waiting for
   * the heartbeat to be due again.
   */
  const drainManual = (workspaceId: string, principalId: string): void => {
    const key = keyOf(workspaceId, principalId);
    if (stopped || !queuedManual.has(key) || busyHere(key)) return;
    queuedManual.delete(key);
    inFlight.add(key);
    track(
      (async () => {
        try {
          const state = await deps.repository.get(workspaceId, principalId);
          if (state === undefined) return;
          // A Check now that is the window's first look opens it: its closed-hours row and its summary are not lost.
          const timezone = await deps.timezoneOf(workspaceId);
          await openWindow(state, "manual", heartbeatWindowAt(state.config, timezone, deps.now()));
          const gate = await gateZero(state, "manual");
          if (!("entry" in gate)) return;
          const prepared = await prepare(state, timezone, deps.now(), "manual");
          if ("skip" in prepared) return;
          await tick(state, gate.entry, gate.left, "manual", deps.now().toISOString(), timezone, prepared);
        } finally {
          inFlight.delete(key);
          drainManual(workspaceId, principalId);
        }
      })(),
    );
  };

  const sweepOne = async (state: HeartbeatState): Promise<HeartbeatTickRecord | undefined> => {
    const key = keyOf(state.workspaceId, state.principalId);
    // G2's in-flight half, reserved before anything is awaited: a Check now or a slow deep look already running.
    if (busyHere(key)) return undefined;
    inFlight.add(key);
    try {
      return await sweepReserved(state, key);
    } finally {
      inFlight.delete(key);
      drainManual(state.workspaceId, state.principalId);
    }
  };

  /** G2's busy half: the person is in Home, or wrote there within the busy window. */
  const busyInHome = async (state: HeartbeatState, now: Date): Promise<boolean> => {
    const activity = await deps.homeActivity(state.workspaceId, state.principalId);
    return (
      activity !== undefined &&
      (activity.running ||
        (activity.lastUserEntryAt !== undefined && now.getTime() - Date.parse(activity.lastUserEntryAt) < HEARTBEAT_BUSY_WINDOW_MS))
    );
  };

  /**
   * An event tick, its key not yet reserved: it runs now when the
   * heartbeat is on, inside its hours, the person is not busy and the event
   * limit allows; otherwise the event waits for the next scheduled look. It
   * does not move the schedule.
   */
  const runEvent = async (workspaceId: string, principalId: string): Promise<void> => {
    const key = keyOf(workspaceId, principalId);
    if (stopped) return;
    if (busyHere(key)) {
      pendingEvents.add(key);
      return;
    }
    inFlight.add(key);
    try {
      const state = await deps.repository.get(workspaceId, principalId);
      const now = deps.now();
      if (state === undefined || !state.config.enabled || pausedNow(state, now)) {
        pendingEvents.delete(key);
        return;
      }
      const timezone = await deps.timezoneOf(workspaceId);
      const last = lastEventTick.get(key);
      if (
        heartbeatWindowAt(state.config, timezone, now) === undefined ||
        (last !== undefined && now.getTime() - last < HEARTBEAT_EVENT_TICK_EVERY_MS) ||
        (await busyInHome(state, now))
      ) {
        pendingEvents.add(key);
        return;
      }
      // An event that is the window's first look opens it, as a sweep would.
      await openWindow(state, "event", heartbeatWindowAt(state.config, timezone, now));
      const refused = lastEventGateSkip.get(key);
      const quiet = refused !== undefined && now.getTime() - refused < HEARTBEAT_EVENT_TICK_EVERY_MS;
      const gate = await gateZero(state, "event", quiet);
      // Turned away before it looked (a provider reloading, a full disk, no model): the event is not
      // spent — it waits for the next look, and the one-per-10-minutes allowance is left untouched.
      // The refusal's row is written at most once in 10 minutes; the look is still tried each time.
      if (!("entry" in gate)) {
        if (!quiet) lastEventGateSkip.set(key, now.getTime());
        pendingEvents.add(key);
        return;
      }
      pendingEvents.delete(key);
      lastEventTick.set(key, now.getTime());
      const prepared = await prepare(state, timezone, now, "event");
      if ("skip" in prepared) {
        await skip(state, prepared.skip, "event");
        return;
      }
      const wakeAt = { reason: "event" as const, scheduledAt: now.toISOString(), now: now.toISOString(), timezone };
      if (await precheckDeclines(state, gate.entry, prepared, wakeAt)) {
        // Declined, it looked at nothing: its signals wait for the next check.
        await unsee(state, prepared);
        await skip(state, "provider", "event");
        return;
      }
      await tick(state, gate.entry, gate.left, "event", now.toISOString(), timezone, prepared);
    } finally {
      inFlight.delete(key);
      drainManual(workspaceId, principalId);
    }
  };

  const wake = (workspaceId: string, principalId: string, event: HeartbeatWakeEvent): void => {
    if (stopped) return;
    const key = keyOf(workspaceId, principalId);
    const waiting = debouncing.get(key);
    if (waiting !== undefined) {
      waiting.now ||= event.mode === "now";
      return;
    }
    const timer = setTimeout(() => {
      const fired = debouncing.get(key);
      debouncing.delete(key);
      if (fired?.now === true)
        track(
          runEvent(workspaceId, principalId).catch((error: unknown) =>
            deps.log("warn", "a heartbeat event tick could not run", { workspaceId, error: errorMessage(error) }),
          ),
        );
      else {
        // An event for the next look waits only for a heartbeat that is on and not paused: a pause ignores events.
        track(
          (async () => {
            const state = await deps.repository.get(workspaceId, principalId);
            if (state !== undefined && state.config.enabled && !pausedNow(state, deps.now())) pendingEvents.add(key);
          })(),
        );
      }
    }, deps.eventDebounceMs ?? HEARTBEAT_EVENT_DEBOUNCE_MS);
    timer.unref?.();
    debouncing.set(key, { timer, now: event.mode === "now" });
  };

  const sweepReserved = async (listed: HeartbeatState, key: string): Promise<HeartbeatTickRecord | undefined> => {
    let state = listed;
    const now = deps.now();
    const scheduledAt = state.nextTickAt ?? now.toISOString();
    const timezone = await deps.timezoneOf(state.workspaceId);
    // One tick missed while the owner was away runs once, as a catch-up; the rest are never replayed.
    const caughtUp = now.getTime() - Date.parse(scheduledAt) >= state.config.everyMs;
    // An event waiting for this look makes it the event's: it looks even with nothing new.
    const evented = pendingEvents.has(key) && heartbeatWindowAt(state.config, timezone, now) !== undefined;
    const wakeReason: HeartbeatWakeReason = evented ? "event" : caughtUp ? "catch-up" : "interval";
    const next = nextHeartbeatAt(state.config, timezone, now, state.principalId).toISOString();
    const claim = async (nextTickAt: string): Promise<boolean> =>
      await deps.repository.claimTick({
        workspaceId: state.workspaceId,
        principalId: state.principalId,
        expectedNextTickAt: scheduledAt,
        nextTickAt,
        now: now.toISOString(),
      });
    // Outside active hours nothing runs: the next tick moves to the window's start, and no row is written.
    const window = heartbeatWindowAt(state.config, timezone, now);
    if (window === undefined) {
      // Its once-per-interval wait for a busy Home starts again with the next window.
      deferred.delete(key);
      await claim(next);
      return undefined;
    }
    // G2's busy half: once per interval it waits for the next sweep; a second time it skips this interval.
    const busy = await busyInHome(state, now);
    if (busy && state.config.enabled && !pausedNow(state, now) && !deferred.has(key)) {
      deferred.add(key);
      if (!(await claim(new Date(now.getTime() + deps.sweepMs).toISOString()))) return undefined;
      return await skip(state, "busy", wakeReason, "deferred");
    }
    deferred.delete(key);
    if (!(await claim(next))) return undefined;
    // What the person changed since the sweep listed it (a pause, a provider, the instructions) holds for this look.
    state = (await deps.repository.get(state.workspaceId, state.principalId)) ?? state;
    await openWindow(state, wakeReason, window);
    // Consumed by this look: a paused or off heartbeat ignores events.
    if (evented) pendingEvents.delete(key);
    const gate = await gateZero(state, wakeReason);
    if (!("entry" in gate)) {
      // Turned away before it looked (a provider reloading, a full disk, no model): the event waits for the next look.
      if (evented && state.config.enabled && !pausedNow(state, deps.now())) pendingEvents.add(key);
      return gate.skipped;
    }
    // Busy before the signals are collected, so a busy skip never marks them seen untold.
    if (busy) return await skip(state, "busy", wakeReason);
    const prepared = await prepare(state, timezone, now, evented ? "event" : "scheduled");
    if ("skip" in prepared) return await skip(state, prepared.skip, wakeReason);
    // G4: the provider's own model-free precheck; Check now is the person asking, and never asks it.
    if (await precheckDeclines(state, gate.entry, prepared, { reason: wakeReason, scheduledAt, now: now.toISOString(), timezone })) {
      // Declined, it looked at nothing: its signals wait for the next check.
      await unsee(state, prepared);
      return await skip(state, "provider", wakeReason);
    }
    return await tick(state, gate.entry, gate.left, wakeReason, scheduledAt, timezone, prepared);
  };

  const sweep = async (): Promise<HeartbeatSweepResult> => {
    const { due, unreadable } = await deps.repository.listDue(deps.now().toISOString(), 100);
    for (const name of unreadable)
      deps.log("warn", "a heartbeat's settings cannot be read; it is skipped until they are saved again", { heartbeat: name });
    const ran: HeartbeatTickRecord[] = [];
    for (const state of due) {
      if (stopped) break;
      try {
        const row = await sweepOne(state);
        if (row !== undefined) ran.push(row);
      } catch (error) {
        deps.log("warn", "a heartbeat tick could not run", {
          workspaceId: state.workspaceId,
          principalId: state.principalId,
          error: errorMessage(error),
        });
      }
    }
    return { ran, unreadable };
  };

  let sweeping: Promise<void> | undefined;
  const sweepDue = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (sweeping !== undefined) return sweeping;
    const work = sweep().then(() => undefined);
    track(work);
    sweeping = work
      .catch(() => undefined)
      .finally(() => {
        sweeping = undefined;
      });
    return sweeping;
  };
  const stopTicks = (deps.every ?? repeatEvery)(() => void sweepDue(), deps.sweepEveryMs ?? deps.sweepMs);

  return {
    sweep,
    sweepDue,
    async checkNow(workspaceId, principalId) {
      const state = await deps.repository.get(workspaceId, principalId);
      if (state === undefined || !state.config.enabled) return { status: "refused", reason: "The heartbeat is off." };
      if (state.config.paused !== undefined && pausedNow(state, deps.now()))
        return { status: "refused", reason: `The heartbeat is paused (${state.config.paused.reason}); resume it first.` };
      const key = keyOf(workspaceId, principalId);
      queuedManual.add(key);
      if (busyHere(key)) return { status: "queued" };
      drainManual(workspaceId, principalId);
      return { status: "started" };
    },
    wake,
    async idle() {
      while (running.size > 0) await Promise.all([...running]);
    },
    stop() {
      stopped = true;
      stopTicks();
      for (const { timer: waiting } of debouncing.values()) clearTimeout(waiting);
      debouncing.clear();
    },
  };
}
