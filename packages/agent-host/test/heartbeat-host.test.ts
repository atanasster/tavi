import { describe, expect, it } from "vitest";
import { partialFake } from "@tavi/test-support";

import {
  HeartbeatProviderError,
  defaultHeartbeatConfig,
  heartbeatTickLooked,
  heartbeatJitterMs,
  type HeartbeatConfig,
  type HeartbeatItem,
  type HeartbeatLedgerRow,
  type HeartbeatPause,
  type HeartbeatProvider,
  type HeartbeatSignal,
  type HeartbeatSignalBatch,
  type HeartbeatRepositoryPort,
  type HeartbeatState,
  type HeartbeatTickRecord,
  type HeartbeatPrecheckRequest,
  type ModHookInput,
  type ModHookResult,
  type TurnHooksPort,
  type HeartbeatTickRequest,
  type TellHeartbeatItem,
} from "@tavi/contracts";
import { cleanHeartbeatItems, type HeartbeatDeliveryPort } from "@tavi/agent-host/heartbeat-delivery";
import {
  HEARTBEAT_DEV_RELOAD_GRACE_MS,
  HeartbeatProviderRegistry,
  HeartbeatProviderStates,
  HeartbeatSignalRegistry,
  clampHeartbeatHint,
  heartbeatTurnTools,
  startHeartbeatHost,
  tickBudget,
  type HeartbeatHostDependencies,
  type HeartbeatTurnRequest,
  type HeartbeatTurnResult,
  type HomeActivity,
} from "@tavi/agent-host/heartbeat-host";
import { sleep } from "@tavi/node-kit";

/**
 * The heartbeat host against a fake clock and an
 * in-memory repository whose claim is compare-and-set, as the store's is.
 */

const WS = "default";
const OP = "operator";
const MINUTE = 60_000;

/** An in-memory `HeartbeatRepositoryPort`: one heartbeat per (workspace, principal), claims compare-and-set. */
function memoryRepository(initial: HeartbeatState) {
  const rows = new Map<string, HeartbeatState>([[`${initial.workspaceId}/${initial.principalId}`, initial]]);
  const ticks: HeartbeatTickRecord[] = [];
  const seenSignals = new Map<string, string>();
  let usage: { modelTicks: number; tokens: number; usd: number | null; pricedUsd?: number } = { modelTicks: 0, tokens: 0, usd: 0 };
  const usageAsked: string[] = [];
  let seededSignals = false;
  /** The item ledger, by item key (one heartbeat). */
  const ledger = new Map<string, HeartbeatLedgerRow>();
  const key = (workspaceId: string, principalId: string) => `${workspaceId}/${principalId}`;
  const update = (workspaceId: string, principalId: string, change: (state: HeartbeatState) => HeartbeatState) => {
    const current = rows.get(key(workspaceId, principalId));
    if (current !== undefined) rows.set(key(workspaceId, principalId), change(current));
  };
  const repository = partialFake<HeartbeatRepositoryPort>({
    get: async (workspaceId: string, principalId: string) => rows.get(key(workspaceId, principalId)),
    save: async () => {
      throw new Error("not used");
    },
    listDue: async (now: string) => ({
      due: [...rows.values()].filter((state) => state.config.enabled && state.nextTickAt !== undefined && state.nextTickAt <= now),
      unreadable: [],
    }),
    claimTick: async (input: { workspaceId: string; principalId: string; expectedNextTickAt: string; nextTickAt: string }) => {
      const current = rows.get(key(input.workspaceId, input.principalId));
      if (current?.nextTickAt !== input.expectedNextTickAt) return false;
      rows.set(key(input.workspaceId, input.principalId), { ...current, nextTickAt: input.nextTickAt });
      return true;
    },
    setNextTick: async (input: { workspaceId: string; principalId: string; nextTickAt: string | null }) =>
      update(input.workspaceId, input.principalId, (state) => {
        const { nextTickAt: _old, ...rest } = state;
        return input.nextTickAt === null ? rest : { ...rest, nextTickAt: input.nextTickAt };
      }),
    setPaused: async (input: { workspaceId: string; principalId: string; paused: HeartbeatPause | null }) =>
      update(input.workspaceId, input.principalId, (state) => {
        const { paused: _old, ...config } = state.config;
        return { ...state, config: input.paused === null ? config : { ...config, paused: input.paused } };
      }),
    clearPause: async (input: { workspaceId: string; principalId: string; paused: HeartbeatPause }) => {
      const current = rows.get(key(input.workspaceId, input.principalId))?.config.paused;
      if (current?.reason !== input.paused.reason || current.until !== input.paused.until) return false;
      update(input.workspaceId, input.principalId, (state) => {
        const { paused: _old, ...config } = state.config;
        return { ...state, config };
      });
      return true;
    },
    setMemo: async (input: { workspaceId: string; principalId: string; memo: string | null }) =>
      update(input.workspaceId, input.principalId, (state) => {
        const { memo: _old, ...rest } = state;
        return input.memo === null ? rest : { ...rest, memo: input.memo };
      }),
    dismissOffer: async () => undefined,
    recordTick: async (input: Parameters<HeartbeatRepositoryPort["recordTick"]>[0]) => {
      const { now, advancesLastTick, ...record } = input;
      const row: HeartbeatTickRecord = { ...record, createdAt: now };
      ticks.push(row);
      if (advancesLastTick)
        update(input.workspaceId, input.principalId, (state) => ({
          ...state,
          lastTickAt: now,
          ...(record.kind === "deep" && heartbeatTickLooked(record.outcome) && input.advancesDeepTick !== false
            ? { lastDeepTickAt: now }
            : {}),
        }));
      return row;
    },
    listTicks: async () => [...ticks].reverse(),
    instructionsHistory: async () => [],
    usageSince: async (input: { since: string }) => {
      usageAsked.push(input.since);
      return { pricedUsd: usage.usd ?? 0, ...usage };
    },
    observeSignals: async (input: {
      signals: readonly { key: string; hash: string }[];
      keep?: readonly string[];
      sources?: readonly string[];
    }) => {
      const firstTime = !seededSignals;
      seededSignals = true;
      const fresh = firstTime
        ? []
        : input.signals.filter((signal) => seenSignals.get(signal.key) !== signal.hash).map((signal) => signal.key);
      const present = new Set(input.signals.map((signal) => signal.key));
      const kept = (key: string) => (input.keep ?? []).some((prefix) => key.startsWith(prefix));
      const collected = (key: string) => input.sources === undefined || input.sources.some((id) => key.startsWith(`${id}:`));
      const gone = firstTime ? [] : [...seenSignals.keys()].filter((key) => !present.has(key) && !kept(key) && collected(key));
      for (const key of gone) seenSignals.delete(key);
      for (const signal of input.signals) seenSignals.set(signal.key, signal.hash);
      return { seeded: firstTime, fresh, gone };
    },
    unseeSignals: async (input: { keys: readonly string[] }) => {
      for (const key of input.keys) seenSignals.delete(key);
    },
    ledgerRows: async (input: { keys: readonly string[] }) =>
      input.keys.flatMap((itemKey) => (ledger.has(itemKey) ? [ledger.get(itemKey) as HeartbeatLedgerRow] : [])),
    ledgerRow: async (input: { itemId: string }) => [...ledger.values()].find((row) => row.itemId === input.itemId),
    itemByToken: async (token: string) => [...ledger.values()].find((row) => row.buttonToken === token),
    recentItems: async (input: { since?: string; limit: number }) =>
      [...ledger.values()]
        .filter((row) => input.since === undefined || row.lastToldAt >= input.since)
        .sort((a, b) => b.lastToldAt.localeCompare(a.lastToldAt))
        .slice(0, input.limit),
    tellItems: async (input: { workspaceId: string; principalId: string; items: readonly TellHeartbeatItem[]; now: string }) =>
      input.items.map(({ itemId, item, hash, heldBack, buttonToken, filtered }) => {
        const before = ledger.get(item.key);
        const row: HeartbeatLedgerRow = {
          itemId: before?.itemId ?? itemId,
          workspaceId: input.workspaceId,
          principalId: input.principalId,
          key: item.key,
          hash,
          signalKeys: item.signalKeys ?? [],
          urgency: item.urgency,
          heldBack,
          title: item.title,
          ...(item.body === undefined ? {} : { body: item.body }),
          sources: item.sources,
          ...(item.proposedAction === undefined ? {} : { proposedAction: item.proposedAction }),
          state: filtered === true ? "filtered" : "told",
          buttonToken,
          firstToldAt: before?.firstToldAt ?? input.now,
          lastToldAt: input.now,
          updatedAt: input.now,
        };
        ledger.set(item.key, row);
        return row;
      }),
    nowToldSince: async (input: { since: string }) =>
      [...ledger.values()].filter((row) => row.urgency === "now" && !row.heldBack && row.lastToldAt >= input.since).length,
    resolveItems: async (input: { goneSignalKeys: readonly string[]; now: string }) => {
      const resolved = [...ledger.values()].filter(
        (row) =>
          (row.state === "told" || row.state === "snoozed") &&
          row.signalKeys.some((signalKey) => input.goneSignalKeys.includes(signalKey)) &&
          !row.signalKeys.some((signalKey) => seenSignals.has(signalKey)),
      );
      for (const row of resolved) ledger.set(row.key, { ...row, state: "resolved", updatedAt: input.now });
      return resolved.map((row) => ledger.get(row.key) as HeartbeatLedgerRow);
    },
    digestItems: async (input: { since: string }) =>
      [...ledger.values()].filter(
        (row) => row.urgency === "later" && row.state === "told" && row.digestedAt === undefined && row.lastToldAt >= input.since,
      ),
    markDigested: async (input: { items: readonly { itemId: string; lastToldAt: string }[]; now: string }) => {
      for (const row of ledger.values())
        if (input.items.some((item) => item.itemId === row.itemId && item.lastToldAt === row.lastToldAt))
          ledger.set(row.key, { ...row, digestedAt: input.now });
    },
    setItemFeedback: async (input: { itemId: string; feedback: "up" | "down" | null; now: string }) => {
      const row = [...ledger.values()].find((candidate) => candidate.itemId === input.itemId);
      if (row === undefined) return undefined;
      const { feedback: _old, ...rest } = row;
      const next: HeartbeatLedgerRow = { ...rest, ...(input.feedback === null ? {} : { feedback: input.feedback }), updatedAt: input.now };
      ledger.set(row.key, next);
      return next;
    },
    setItemState: async (input: { itemId: string; state: "told" | "muted" | "snoozed"; snoozedUntil?: string; now: string }) => {
      const row = [...ledger.values()].find((candidate) => candidate.itemId === input.itemId);
      if (row === undefined) return undefined;
      const { snoozedUntil: _old, ...rest } = row;
      const next: HeartbeatLedgerRow = {
        ...rest,
        state: input.state,
        ...(input.snoozedUntil === undefined ? {} : { snoozedUntil: input.snoozedUntil }),
        updatedAt: input.now,
      };
      ledger.set(row.key, next);
      return next;
    },
  });
  return {
    repository,
    rows,
    ticks,
    usageAsked,
    ledger,
    state: () => rows.get(key(initial.workspaceId, initial.principalId)),
    setUsage: (next: typeof usage) => {
      usage = next;
    },
  };
}

function heartbeat(config: Partial<HeartbeatConfig> = {}, state: Partial<HeartbeatState> = {}): HeartbeatState {
  return {
    workspaceId: WS,
    principalId: OP,
    config: {
      ...defaultHeartbeatConfig(),
      enabled: true,
      instructions: "Tell me if a payment fails",
      activeHours: { start: "00:00", end: "23:59" },
      ...config,
    },
    nextTickAt: "2026-10-10T10:00:00.000Z",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    ...state,
  };
}

/** A provider recording each tick; `hold` keeps a tick open until released. */
function recordingProvider() {
  const calls: HeartbeatTickRequest[] = [];
  let release: (() => void) | undefined;
  let hold = false;
  const provider: HeartbeatProvider = {
    async tick(request) {
      calls.push(request);
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return {
        items: [{ key: "stripe:in_1", urgency: "now", title: "ACME payment failed", sources: [{ label: "stripe" }] }],
        memo: `seen ${calls.length}`,
      };
    },
  };
  return {
    provider,
    calls,
    holdNext: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      release?.();
    },
  };
}

function setup(state: HeartbeatState, extra: Partial<HeartbeatHostDependencies> & { readonly eventDebounceMs?: number } = {}) {
  let now = new Date("2026-10-10T10:00:00.000Z");
  const memory = memoryRepository(state);
  const providers = new HeartbeatProviderRegistry(() => now);
  const recording = recordingProvider();
  providers.install("tavi.heartbeatagent", {
    provider: recording.provider,
    kind: "builtin",
    receives: ["instructions", "signals", "ledger", "memory"],
    usesTurns: true,
    maxTickSeconds: 60,
  });
  const announced: string[] = [];
  let home: HomeActivity | undefined;
  let counter = 0;
  const deps: HeartbeatHostDependencies & { sweepMs: number; eventDebounceMs?: number } = {
    repository: memory.repository,
    providers,
    now: () => now,
    newId: (prefix) => `${prefix}-${(counter += 1)}`,
    sweepMs: 60 * 60_000,
    timezoneOf: async () => "UTC",
    homeActivity: async () => home,
    modelAvailable: async () => true,
    announcePause: async (_state, reason) => {
      announced.push(reason);
    },
    log: () => undefined,
    ...extra,
  };
  const host = startHeartbeatHost(deps);
  return {
    host,
    memory,
    recording,
    announced,
    providers,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    at: (iso: string) => {
      now = new Date(iso);
    },
    setHome: (activity: HomeActivity | undefined) => {
      home = activity;
    },
    stop: () => host.stop(),
  };
}

describe("the heartbeat host", () => {
  it("claims a due tick, asks the provider, records it, and schedules the next by the window's anchor", async () => {
    const { host, memory, recording, stop } = setup(heartbeat());
    try {
      const { ran } = await host.sweep();
      expect(ran).toHaveLength(1);
      expect(ran[0]).toMatchObject({
        outcome: "reported",
        kind: "deep",
        wakeReason: "interval",
        itemsNow: 1,
        providerId: "tavi.heartbeatagent",
      });
      expect(recording.calls).toHaveLength(1);
      expect(recording.calls[0]?.instructions).toBe("Tell me if a payment fails");
      expect(memory.state()?.nextTickAt).toBe(
        new Date(Date.parse("2026-10-10T10:00:00.000Z") + heartbeatJitterMs(30 * MINUTE, OP)).toISOString(),
      );
      expect(memory.state()?.memo).toBe("seen 1");
      // Not due again until then.
      expect((await host.sweep()).ran).toEqual([]);
    } finally {
      stop();
    }
  });

  it("runs nothing outside active hours, and writes one closed-window row when the next window opens", async () => {
    const { host, memory, recording, at, stop } = setup(
      heartbeat(
        { activeHours: { start: "08:00", end: "22:00" } },
        { nextTickAt: "2026-10-10T22:30:00.000Z", lastTickAt: "2026-10-10T21:30:00.000Z" },
      ),
    );
    try {
      at("2026-10-10T22:30:00.000Z");
      expect((await host.sweep()).ran).toEqual([]);
      expect(recording.calls).toEqual([]);
      expect(memory.state()?.nextTickAt?.startsWith("2026-10-11T08:0")).toBe(true);
      at(memory.state()?.nextTickAt ?? "");
      const { ran } = await host.sweep();
      expect(memory.ticks.map((tick) => [tick.kind, tick.outcome, tick.reason])).toEqual([
        ["window", "skipped", "hours"],
        ["deep", "reported", null],
      ]);
      expect(ran).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("stays paused for a person's, failures' and provider's pause, and resumes a budget pause past its end", async () => {
    for (const reason of ["user", "failures", "provider"] as const) {
      const { host, recording, stop } = setup(heartbeat({ paused: { reason } }));
      try {
        await host.sweep();
        expect(recording.calls, reason).toEqual([]);
      } finally {
        stop();
      }
    }
    const { host, memory, recording, stop } = setup(heartbeat({ paused: { reason: "budget", until: "2026-10-10T09:00:00.000Z" } }));
    try {
      await host.sweep();
      expect(recording.calls).toHaveLength(1);
      expect(memory.state()?.config.paused).toBeUndefined();
    } finally {
      stop();
    }
  });

  it("defers once while the person is using Home, then skips that interval rather than waiting forever", async () => {
    const { host, memory, recording, setHome, advance, stop } = setup(heartbeat());
    try {
      setHome({ running: true });
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "deferred", reason: "busy" });
      advance(60 * MINUTE);
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "skipped", reason: "busy" });
      expect(recording.calls).toEqual([]);
      setHome({ running: false, lastUserEntryAt: "2026-10-10T08:00:00.000Z" });
      advance(60 * MINUTE);
      await host.sweep();
      expect(recording.calls).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("runs one catch-up after the owner was away, and schedules from now, never replaying the misses", async () => {
    const { host, memory, recording, at, stop } = setup(heartbeat({}, { nextTickAt: "2026-10-10T06:00:00.000Z" }));
    try {
      at("2026-10-10T10:05:00.000Z");
      const { ran } = await host.sweep();
      expect(ran.map((row) => row.wakeReason)).toEqual(["catch-up"]);
      expect(recording.calls).toHaveLength(1);
      expect(Date.parse(memory.state()?.nextTickAt ?? "")).toBeGreaterThan(Date.parse("2026-10-10T10:05:00.000Z"));
      expect((await host.sweep()).ran).toEqual([]);
    } finally {
      stop();
    }
  });

  it("lets only one of two owners' sweeps run a tick", async () => {
    const first = setup(heartbeat());
    const recording = first.recording;
    const second = startHeartbeatHost({
      repository: first.memory.repository,
      providers: first.providers,
      now: () => new Date("2026-10-10T10:00:00.000Z"),
      newId: (prefix) => `${prefix}-b`,
      sweepMs: 60 * 60_000,
      timezoneOf: async () => "UTC",
      homeActivity: async () => undefined,
      modelAvailable: async () => true,
      log: () => undefined,
    });
    try {
      const [a, b] = await Promise.all([first.host.sweep(), second.sweep()]);
      expect(a.ran.length + b.ran.length).toBe(1);
      expect(recording.calls).toHaveLength(1);
    } finally {
      first.stop();
      second.stop();
    }
  });

  it("queues Check now behind a tick in flight, then runs it as a manual deep look, never alongside", async () => {
    const { host, memory, recording, stop } = setup(heartbeat());
    try {
      recording.holdNext();
      const sweeping = host.sweep();
      await sleep(0);
      expect(await host.checkNow(WS, OP)).toEqual({ status: "queued" });
      expect(recording.calls).toHaveLength(1);
      recording.release();
      await sweeping;
      await host.idle();
      expect(recording.calls).toHaveLength(2);
      expect(memory.ticks.map((tick) => tick.wakeReason)).toEqual(["interval", "manual"]);
    } finally {
      stop();
    }
  });

  it("never runs two ticks of one heartbeat at once: two quick Check nows run one after the other (invariant 17)", async () => {
    const { host, memory, recording, stop } = setup(heartbeat({}, { nextTickAt: "2026-10-10T12:00:00.000Z" }));
    try {
      recording.holdNext();
      const answers = await Promise.all([host.checkNow(WS, OP), host.checkNow(WS, OP)]);
      expect(answers.map((answer) => answer.status).sort()).toEqual(["queued", "started"]);
      await sleep(0);
      expect(recording.calls).toHaveLength(1);
      recording.release();
      await host.idle();
      // The queued one ran after the first finished, without waiting for the heartbeat to be due.
      expect(recording.calls).toHaveLength(2);
      expect(memory.ticks.map((tick) => tick.wakeReason)).toEqual(["manual", "manual"]);
    } finally {
      stop();
    }
  });

  it("writes the closed-window row once per window, even while every tick then skips", async () => {
    const { host, memory, advance, stop } = setup(
      heartbeat(
        { activeHours: { start: "08:00", end: "22:00" }, instructions: "" },
        { nextTickAt: "2026-10-10T08:00:00.000Z", lastTickAt: "2026-10-09T21:30:00.000Z" },
      ),
    );
    try {
      for (let index = 0; index < 4; index += 1) {
        await host.sweep();
        advance(30 * MINUTE);
      }
      expect(memory.ticks.filter((tick) => tick.kind === "window")).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("stops waiting for a provider that ignores its deadline, records a failure, and holds only its own heartbeat", async () => {
    const { host, memory, providers, stop } = setup(heartbeat());
    let settle: (() => void) | undefined;
    providers.install("tavi.heartbeatagent", {
      provider: {
        tick: () =>
          new Promise((resolve) => {
            settle = () => resolve({ items: [] });
          }),
      },
      kind: "builtin",
      receives: [],
      usesTurns: false,
      maxTickSeconds: 1,
    });
    try {
      const { ran } = await host.sweep();
      expect(ran[0]).toMatchObject({ outcome: "failed", reason: "timeout" });
      expect(await host.checkNow(WS, OP)).toEqual({ status: "queued" });
      settle?.();
      await sleep(10);
      await host.idle();
      expect(memory.ticks.filter((tick) => tick.wakeReason === "manual")).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("runs its heartbeat again once a provider that never settles is twice past its time", async () => {
    const { host, memory, providers, stop } = setup(heartbeat());
    providers.install("tavi.heartbeatagent", {
      provider: { tick: () => new Promise<never>(() => undefined) },
      kind: "builtin",
      receives: [],
      usesTurns: false,
      maxTickSeconds: 1,
    });
    try {
      await host.sweep();
      expect(await host.checkNow(WS, OP)).toEqual({ status: "queued" });
      // Released about 2 s after the hung check began; the queued Check now then runs (and itself runs out after 1 s).
      for (let waited = 0; waited < 6_000 && !memory.ticks.some((tick) => tick.wakeReason === "manual"); waited += 50) await sleep(50);
      expect(memory.ticks.filter((tick) => tick.wakeReason === "manual")).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("does not pause for a provider whose plugin stops after the person switched away from it", async () => {
    const { host, memory, providers, stop } = setup(heartbeat({ providerId: "acme.heartbeat" }));
    try {
      const lifetime = new AbortController();
      const started = Promise.withResolvers<void>();
      providers.install("acme.heartbeat", {
        provider: {
          tick: async () => {
            started.resolve();
            return await new Promise<never>(() => undefined);
          },
        },
        kind: "plugin",
        receives: [],
        usesTurns: false,
        maxTickSeconds: 60,
        signal: lifetime.signal,
      });
      const sweeping = host.sweep();
      await started.promise;
      const state = memory.state() as HeartbeatState;
      memory.rows.set(`${WS}/${OP}`, { ...state, config: { ...state.config, providerId: "tavi.heartbeatagent" } });
      lifetime.abort(new Error("disabled"));
      await sweeping;
      expect(memory.state()?.config.paused).toBeUndefined();
    } finally {
      stop();
    }
  });

  it("writes nothing for a catch-up due outside active hours, busy or not", async () => {
    const { host, memory, setHome, at, stop } = setup(
      heartbeat({ activeHours: { start: "08:00", end: "22:00" } }, { nextTickAt: "2026-10-10T20:00:00.000Z" }),
    );
    try {
      setHome({ running: true });
      at("2026-10-10T23:30:00.000Z");
      expect((await host.sweep()).ran).toEqual([]);
      expect(memory.ticks).toEqual([]);
    } finally {
      stop();
    }
  });

  it("refuses Check now while paused or off", async () => {
    const paused = setup(heartbeat({ paused: { reason: "user" } }));
    try {
      expect(await paused.host.checkNow(WS, OP)).toMatchObject({ status: "refused" });
    } finally {
      paused.stop();
    }
    const off = setup(heartbeat({ enabled: false }));
    try {
      expect(await off.host.checkNow(WS, OP)).toMatchObject({ status: "refused" });
    } finally {
      off.stop();
    }
  });

  it("skips a full disk with no model call, and logs it at most hourly", async () => {
    const { host, memory, recording, advance, stop } = setup(heartbeat({ everyMs: 15 * MINUTE }), { freeBytes: () => 1024 });
    try {
      await host.sweep();
      advance(15 * MINUTE);
      await host.sweep();
      expect(recording.calls).toEqual([]);
      expect(memory.ticks.map((tick) => tick.reason)).toEqual(["disk-full"]);
    } finally {
      stop();
    }
  });

  it("answers a Check now on a full disk with its own skipped row, even while the disk log is throttled", async () => {
    const { host, memory, recording, advance, stop } = setup(heartbeat({ everyMs: 15 * MINUTE }), { freeBytes: () => 1024 });
    try {
      await host.sweep();
      advance(MINUTE);
      await host.checkNow(WS, OP);
      await host.idle();
      expect(recording.calls).toEqual([]);
      expect(memory.ticks.map((tick) => [tick.reason, tick.wakeReason])).toEqual([
        ["disk-full", "interval"],
        ["disk-full", "manual"],
      ]);
    } finally {
      stop();
    }
  });

  it("pauses with one notice when its provider is not installed, never switching to another", async () => {
    const { host, memory, announced, stop } = setup(heartbeat({ providerId: "acme.heartbeat" }));
    try {
      await host.sweep();
      expect(memory.state()?.config.paused).toEqual({ reason: "provider" });
      expect(announced).toEqual(["provider"]);
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "skipped", reason: "provider-unavailable" });
    } finally {
      stop();
    }
  });

  it("waits for a dev provider reloading after a save, and pauses only once its grace has passed", async () => {
    const { host, memory, providers, announced, advance, stop } = setup(heartbeat({ providerId: "acme.dev" }));
    try {
      const withdraw = providers.install("acme.dev", {
        provider: recordingProvider().provider,
        kind: "plugin",
        receives: [],
        usesTurns: false,
        maxTickSeconds: 5,
        dev: true,
      });
      withdraw();
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "skipped", reason: "provider-reloading" });
      expect(memory.state()?.config.paused).toBeUndefined();
      // Never reloaded: once the grace is over, it pauses as for any missing provider.
      advance(HEARTBEAT_DEV_RELOAD_GRACE_MS + 30 * MINUTE);
      await host.sweep();
      expect(memory.state()?.config.paused).toEqual({ reason: "provider" });
      expect(announced).toEqual(["provider"]);
    } finally {
      stop();
    }
  });

  it("stops a check whose plugin stops in the middle of it: a failure that pauses for an installed provider, a skip that never counts for a dev one reloading", async () => {
    for (const dev of [false, true]) {
      const { host, memory, providers, stop } = setup(heartbeat({ providerId: "acme.heartbeat" }));
      try {
        const lifetime = new AbortController();
        const started = Promise.withResolvers<void>();
        // A provider that never answers on its own: only the plugin's stop ends its tick.
        const provider: HeartbeatProvider = {
          tick: async () => {
            started.resolve();
            return await new Promise<never>(() => undefined);
          },
        };
        providers.install("acme.heartbeat", {
          provider,
          kind: "plugin",
          receives: [],
          usesTurns: false,
          maxTickSeconds: 60,
          signal: lifetime.signal,
          ...(dev ? { dev: true } : {}),
        });
        const sweeping = host.sweep();
        await started.promise;
        lifetime.abort(new Error("disabled"));
        await sweeping;
        expect(memory.ticks.at(-1), String(dev)).toMatchObject(
          dev
            ? { outcome: "skipped", reason: "provider-reloading", error: null }
            : { outcome: "failed", reason: "provider-stopped", error: "the heartbeat provider stopped during the check" },
        );
        expect(memory.state()?.config.paused, String(dev)).toEqual(dev ? undefined : { reason: "provider" });
      } finally {
        stop();
      }
    }
  });

  it("skips a tick its provider's precheck declines, runs it when the precheck fails, and never asks it on Check now", async () => {
    const { host, memory, providers, stop } = setup(heartbeat({ providerId: "acme.heartbeat" }));
    try {
      const asked: HeartbeatPrecheckRequest[] = [];
      let answer: () => Promise<{ wake: boolean }> = async () => ({ wake: false });
      const ticked: HeartbeatTickRequest[] = [];
      const provider: HeartbeatProvider = {
        precheck: async (request) => {
          asked.push(request);
          return await answer();
        },
        tick: async (request) => {
          ticked.push(request);
          return { items: [] };
        },
      };
      providers.install("acme.heartbeat", { provider, kind: "plugin", receives: ["instructions"], usesTurns: false, maxTickSeconds: 30 });
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "skipped", reason: "provider" });
      expect(ticked).toEqual([]);
      // Without signals egress it is told no signal keys.
      expect(asked[0]).toMatchObject({ kind: "deep", signalKeys: [] });
      memory.rows.set(`${WS}/${OP}`, { ...(memory.state() as HeartbeatState), nextTickAt: "2026-10-10T10:00:00.000Z" });
      answer = async () => {
        throw new Error("precheck down");
      };
      await host.sweep();
      expect(ticked).toHaveLength(1);
      await host.checkNow(WS, OP);
      await host.idle();
      expect(ticked).toHaveLength(2);
      expect(asked).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it("keeps neither the items nor the memo of a check whose provider was switched away while it answered", async () => {
    const { host, memory, providers, stop } = setup(heartbeat());
    try {
      const provider: HeartbeatProvider = {
        tick: async () => {
          // The person picks another provider while this one is still answering.
          const state = memory.state() as HeartbeatState;
          memory.rows.set(`${WS}/${OP}`, { ...state, config: { ...state.config, providerId: "acme.heartbeat" } });
          return {
            items: [{ key: "old:1", urgency: "now", title: "From the old provider", sources: [{ label: "Old" }] }],
            memo: "old provider's notes",
          };
        },
      };
      providers.install("tavi.heartbeatagent", {
        provider,
        kind: "builtin",
        receives: ["instructions", "signals", "ledger", "memory"],
        usesTurns: false,
        maxTickSeconds: 60,
      });
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "quiet", itemsNow: 0 });
      expect(memory.ledger.size).toBe(0);
      expect(memory.state()?.memo).toBeUndefined();
    } finally {
      stop();
    }
  });

  it("skips with no model call when no model is bound, when the instructions are empty, and when no deep look is due", async () => {
    const noModel = setup(heartbeat(), { modelAvailable: async () => false });
    const empty = setup(heartbeat({ instructions: "# Things to watch\n\n" }));
    const recent = setup(heartbeat({}, { lastDeepTickAt: "2026-10-10T09:00:00.000Z" }));
    try {
      for (const [harness, reason] of [
        [noModel, "no-model"],
        [empty, "empty"],
        [recent, "nothing-new"],
      ] as const) {
        await harness.host.sweep();
        expect(harness.recording.calls, reason).toEqual([]);
        expect(harness.memory.ticks.at(-1)?.reason).toBe(reason);
      }
    } finally {
      noModel.stop();
      empty.stop();
      recent.stop();
    }
  });

  it("keeps a provider's error masked, and its pause alert names only the reason, never the provider's words", async () => {
    const said: string[] = [];
    const delivery: HeartbeatDeliveryPort = {
      notify: async (_state, notice) => {
        said.push(notice.summary);
        return true;
      },
      send: async (_state, _target, message) => {
        said.push(message.text);
        return "accepted";
      },
      edit: async () => false,
    };
    const { host, memory, providers, stop } = setup(heartbeat({ targets: [{ connectionId: "chat-a", to: "100" }] }), { delivery });
    try {
      providers.install("tavi.heartbeatagent", {
        provider: {
          tick: async () => {
            throw new Error(
              "401 from https://api.example/v1?key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 — buy now at evil.example",
            );
          },
        },
        kind: "builtin",
        receives: [],
        usesTurns: false,
        maxTickSeconds: 60,
      });
      for (let n = 0; n < 5; n += 1) {
        expect(await host.checkNow(WS, OP)).toMatchObject({ status: expect.stringMatching(/started|queued/) });
        await host.idle();
      }
      expect(memory.state()?.config.paused).toEqual({ reason: "failures" });
      expect(memory.ticks.at(-1)?.error).toContain("401");
      expect(JSON.stringify(memory.ticks)).not.toContain("sk-ant-api03");
      expect(said.length).toBeGreaterThan(0);
      expect(said.length).toBeGreaterThan(0);
      for (const text of said) expect(text).not.toContain("evil.example");
    } finally {
      stop();
    }
  });

  it("records a provider's throw as a failed tick, and nothing it returned", async () => {
    const { host, memory, providers, stop } = setup(heartbeat());
    try {
      providers.install("tavi.heartbeatagent", {
        provider: {
          tick: async () => {
            throw Object.assign(new Error("down"), { reason: "transport" });
          },
        },
        kind: "builtin",
        receives: [],
        usesTurns: false,
        maxTickSeconds: 60,
      });
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "failed", reason: "transport", itemsNow: 0 });
    } finally {
      stop();
    }
  });

  it("gives an external provider only what its egress switches allow", async () => {
    const { host, providers, stop } = setup(
      heartbeat({ providerId: "acme.heartbeat", providerEgress: { instructions: false, signals: true, ledger: true, memory: true } }),
    );
    const seen: HeartbeatTickRequest[] = [];
    providers.install("acme.heartbeat", {
      provider: {
        tick: async (request) => {
          seen.push(request);
          return { items: [] };
        },
      },
      kind: "plugin",
      receives: ["instructions"],
      usesTurns: false,
      maxTickSeconds: 30,
    });
    try {
      await host.sweep();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.instructions).toBeUndefined();
    } finally {
      stop();
    }
  });

  describe("signals and memory", () => {
    const signal = (key: string, hash = "1"): HeartbeatSignal => ({
      key,
      hash,
      title: `Signal ${key}`,
      at: "2026-10-10T09:00:00.000Z",
      source: "Test",
    });

    function withSignals(
      initial: HeartbeatSignal[],
      extra: Partial<HeartbeatHostDependencies> = {},
      config: Partial<HeartbeatConfig> = {},
      state: Partial<HeartbeatState> = { lastDeepTickAt: "2026-10-10T09:59:00.000Z" },
    ) {
      let current = initial;
      const sources = new HeartbeatSignalRegistry();
      sources.install("test", { id: "test", collect: async () => current }, "builtin");
      const gone: string[][] = [];
      const harness = setup(heartbeat(config, state), {
        signalSources: sources,
        onSignalsGone: async (_state, keys) => {
          gone.push([...keys]);
        },
        ...extra,
      });
      return {
        ...harness,
        sources,
        gone,
        set: (next: HeartbeatSignal[]) => {
          current = next;
        },
      };
    }

    it("seeds the first collection without telling, then reacts only to what is new, seeing only that", async () => {
      const { host, memory, recording, advance, set, stop } = withSignals([signal("a"), signal("b")]);
      try {
        await host.sweep();
        expect(recording.calls).toEqual([]);
        expect(memory.ticks.at(-1)?.reason).toBe("nothing-new");
        set([signal("a"), signal("b"), signal("c")]);
        advance(31 * MINUTE);
        await host.sweep();
        expect(recording.calls).toHaveLength(1);
        expect(recording.calls[0]?.kind).toBe("signal");
        expect(recording.calls[0]?.signals.map((entry) => entry.key)).toEqual(["test:c"]);
        expect(memory.ticks.at(-1)?.inputs).toMatchObject({ signalKeys: ["test:c"] });
      } finally {
        stop();
      }
    });

    it("never runs a source the heartbeat turned off, and keeps what it saw before rather than taking it for gone", async () => {
      const { host, memory, sources, gone, advance, set, stop } = withSignals([signal("a")]);
      let calls = 0;
      sources.install(
        "other",
        {
          id: "other",
          collect: async () => {
            calls += 1;
            return [signal("x")];
          },
        },
        "builtin",
      );
      try {
        await host.sweep();
        expect(calls).toBe(1);
        const state = memory.state() as HeartbeatState;
        memory.rows.set(`${WS}/${OP}`, { ...state, config: { ...state.config, disabledSources: ["other"] } });
        set([signal("a"), signal("b")]);
        advance(31 * MINUTE);
        await host.sweep();
        expect(calls).toBe(1);
        expect(gone.flat()).not.toContain("other:x");
        expect(memory.ticks.at(-1)?.inputs).toMatchObject({ signalKeys: ["test:b"] });
      } finally {
        stop();
      }
    });

    it("keeps what a source did not see when it says its list was cut short", async () => {
      const { host, sources, gone, advance, stop } = withSignals([signal("a")]);
      let answer: readonly HeartbeatSignal[] | HeartbeatSignalBatch = [signal("x"), signal("y")];
      sources.install("other", { id: "other", collect: async () => answer }, "builtin");
      try {
        await host.sweep();
        answer = { signals: [signal("x")], incomplete: true };
        advance(31 * MINUTE);
        await host.sweep();
        expect(gone.flat()).not.toContain("other:y");
        answer = [signal("x")];
        advance(31 * MINUTE);
        await host.sweep();
        expect(gone.flat()).toContain("other:y");
      } finally {
        stop();
      }
    });

    it("skips unchanged signals with no model call, and counts a changed hash as new", async () => {
      const { host, recording, advance, set, stop } = withSignals([signal("a")]);
      try {
        await host.sweep();
        advance(31 * MINUTE);
        await host.sweep();
        expect(recording.calls).toEqual([]);
        set([signal("a", "2")]);
        advance(31 * MINUTE);
        await host.sweep();
        expect(recording.calls).toHaveLength(1);
      } finally {
        stop();
      }
    });

    it("hands a check that failed's new signals to the next check, and does not count it as the deep look", async () => {
      const { host, memory, providers, recording, advance, set, stop } = withSignals([signal("a")]);
      let fail = true;
      const failing = recording.provider;
      providers.install("tavi.heartbeatagent", {
        provider: {
          tick: async (request) => {
            if (fail) throw new Error("the model is down");
            return await failing.tick(request);
          },
        },
        kind: "builtin",
        receives: ["instructions", "signals", "ledger", "memory"],
        usesTurns: true,
        maxTickSeconds: 60,
      });
      try {
        await host.sweep();
        set([signal("a"), signal("b")]);
        advance(31 * MINUTE);
        await host.sweep();
        expect(memory.ticks.at(-1)).toMatchObject({ outcome: "failed" });
        // Not the deep look either: it stays where it was.
        expect(memory.state()?.lastDeepTickAt).toBe("2026-10-10T09:59:00.000Z");
        fail = false;
        advance(31 * MINUTE);
        await host.sweep();
        expect(recording.calls.at(-1)?.signals.map((entry) => entry.key)).toEqual(["test:b"]);
      } finally {
        stop();
      }
    });

    it("keeps what a plugin source saw while it is not installed, and calls nothing resolved that left by age", async () => {
      const { host, memory, sources, gone, advance, set, stop } = withSignals([signal("a")]);
      let aged: HeartbeatSignal[] = [signal("fail")];
      const withdraw = sources.install("acme.q", { id: "acme.q", collect: async () => [signal("job")] }, "plugin");
      sources.install("aging", { id: "aging", retracts: false, collect: async () => aged }, "builtin");
      const resolving: string[][] = [];
      const resolve = memory.repository.resolveItems.bind(memory.repository);
      memory.repository.resolveItems = async (input) => {
        resolving.push([...input.goneSignalKeys]);
        return await resolve(input);
      };
      try {
        await host.sweep();
        withdraw();
        aged = [];
        set([signal("a"), signal("b")]);
        advance(31 * MINUTE);
        await host.sweep();
        expect(gone.flat()).not.toContain("acme.q:job");
        // Left by age: forgotten, but no item is resolved by it.
        expect(gone.flat()).toContain("aging:fail");
        expect(resolving.flat()).not.toContain("aging:fail");
      } finally {
        stop();
      }
    });

    it("hands its signals to the next check when the precheck declines, and when the store fails mid-check", async () => {
      const { host, memory, providers, recording, advance, set, stop } = withSignals([signal("a")]);
      let declining = true;
      providers.install("tavi.heartbeatagent", {
        provider: { precheck: async () => ({ wake: !declining }), tick: async (request) => await recording.provider.tick(request) },
        kind: "builtin",
        receives: ["instructions", "signals", "ledger", "memory"],
        usesTurns: false,
        maxTickSeconds: 60,
      });
      try {
        await host.sweep();
        set([signal("a"), signal("b")]);
        advance(31 * MINUTE);
        await host.sweep();
        expect(memory.ticks.at(-1)).toMatchObject({ outcome: "skipped", reason: "provider" });
        declining = false;
        // The store fails while the check is recorded: its signals are still handed back.
        const record = memory.repository.recordTick.bind(memory.repository);
        let failOnce = true;
        memory.repository.recordTick = async (input) => {
          if (failOnce && input.kind !== null && input.kind !== "window") {
            failOnce = false;
            throw new Error("the store is busy");
          }
          return await record(input);
        };
        advance(31 * MINUTE);
        await host.sweep();
        advance(31 * MINUTE);
        await host.sweep();
        expect(recording.calls.at(-1)?.signals.map((entry) => entry.key)).toEqual(["test:b"]);
        expect(recording.calls).toHaveLength(2);
      } finally {
        stop();
      }
    });

    it("keeps a signal left out for a moment (outside the contract) seen, not gone", async () => {
      const { host, sources, gone, advance, stop } = withSignals([signal("a")]);
      let data: unknown = { id: 1 };
      sources.install("plug", { id: "plug", collect: async () => [{ ...signal("x"), data }] }, "plugin");
      try {
        await host.sweep();
        data = "x".repeat(5_000);
        advance(31 * MINUTE);
        await host.sweep();
        expect(gone.flat()).not.toContain("plug:x");
      } finally {
        stop();
      }
    });

    it("tells retraction every gone key, even on a tick that then skips", async () => {
      const { host, gone, advance, set, stop } = withSignals([signal("a"), signal("b")]);
      try {
        await host.sweep();
        set([signal("a")]);
        advance(31 * MINUTE);
        await host.sweep();
        expect(gone).toEqual([["test:b"]]);
      } finally {
        stop();
      }
    });

    it("records a throwing or slow source and goes on with the rest", async () => {
      const { host, memory, sources, recording, advance, set, stop } = withSignals([signal("a")]);
      sources.install(
        "broken",
        {
          id: "broken",
          collect: async () => {
            throw new Error("down");
          },
        },
        "plugin",
      );
      try {
        await host.sweep();
        set([signal("a"), signal("b")]);
        advance(31 * MINUTE);
        await host.sweep();
        expect(recording.calls).toHaveLength(1);
        expect(memory.ticks.at(-1)?.inputs).toMatchObject({ sourceErrors: [{ source: "broken", error: "down" }] });
      } finally {
        stop();
      }
    });

    it("keeps a failing source's signals seen, so its recovery tells nothing again", async () => {
      let failing = false;
      const sources = new HeartbeatSignalRegistry();
      sources.install(
        "flaky",
        {
          id: "flaky",
          collect: async () => {
            if (failing) throw new Error("down");
            return [signal("a")];
          },
        },
        "plugin",
      );
      const gone: string[][] = [];
      const harness = setup(heartbeat({}, { lastDeepTickAt: "2026-10-10T09:59:00.000Z" }), {
        signalSources: sources,
        onSignalsGone: async (_state, keys) => {
          gone.push([...keys]);
        },
      });
      try {
        await harness.host.sweep();
        failing = true;
        harness.advance(31 * MINUTE);
        await harness.host.sweep();
        failing = false;
        harness.advance(31 * MINUTE);
        await harness.host.sweep();
        expect(gone).toEqual([]);
        expect(harness.recording.calls).toEqual([]);
      } finally {
        harness.stop();
      }
    });

    it("notes a memory failure and still runs the tick, and reports signals outside the contract", async () => {
      const { host, memory, recording, advance, set, stop } = withSignals([], {
        memoryContext: async () => {
          throw new Error("memory unavailable");
        },
      });
      try {
        await host.sweep();
        set([signal("a"), { ...signal("bad"), at: "not a time" }]);
        advance(31 * MINUTE);
        await host.sweep();
        expect(recording.calls).toHaveLength(1);
        const errors = (memory.ticks.at(-1)?.inputs as { sourceErrors: { source: string; error: string }[] }).sourceErrors;
        expect(errors.map((entry) => entry.source).sort()).toEqual(["memory", "test"]);
      } finally {
        stop();
      }
    });

    it("does not mark signals seen on a busy skip", async () => {
      const { host, memory, recording, setHome, advance, set, stop } = withSignals([signal("a")]);
      try {
        await host.sweep();
        set([signal("a"), signal("b")]);
        setHome({ running: true });
        advance(31 * MINUTE);
        await host.sweep();
        expect(memory.ticks.at(-1)).toMatchObject({ outcome: "deferred", reason: "busy" });
        setHome(undefined);
        // The retry is one sweep later (an hour in this harness).
        advance(61 * MINUTE);
        await host.sweep();
        expect(recording.calls).toHaveLength(1);
        expect(recording.calls[0]?.signals.map((entry) => entry.key)).toEqual(["test:b"]);
      } finally {
        stop();
      }
    });

    it("keeps a source's error and the provider's memo masked", async () => {
      const { host, memory, sources, providers, stop } = withSignals([signal("a")]);
      sources.install(
        "bad",
        {
          id: "bad",
          collect: async () => {
            throw new Error("401 with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
          },
        },
        "builtin",
      );
      providers.install("tavi.heartbeatagent", {
        provider: { tick: async () => ({ items: [], memo: "remember sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }) },
        kind: "builtin",
        receives: [],
        usesTurns: false,
        maxTickSeconds: 60,
      });
      try {
        await host.checkNow(WS, OP);
        await host.idle();
        expect(JSON.stringify(memory.ticks.at(-1)?.inputs)).toContain("401 with key");
        expect(JSON.stringify(memory.ticks)).not.toContain("sk-ant-api03");
        expect(memory.state()?.memo).toContain("remember");
        expect(memory.state()?.memo).not.toContain("sk-ant-api03");
      } finally {
        stop();
      }
    });

    it("masks secrets in signals and memory, and bounds memory to 10 records", async () => {
      const records = Array.from({ length: 12 }, (_, index) => ({
        recordId: `m${index}`,
        revisionId: `m${index}-r1`,
        kind: "fact" as const,
        text: index === 0 ? "the key is AKIAIOSFODNN7EXAMPLE" : `fact ${index}`,
      }));
      const { host, memory, recording, advance, set, stop } = withSignals([], { memoryContext: async () => records });
      try {
        await host.sweep();
        set([
          { ...signal("a"), title: "token AKIAIOSFODNN7EXAMPLE leaked", source: "AKIAIOSFODNN7EXAMPLE" },
          { ...signal("b"), key: "AKIAIOSFODNN7EXAMPLE" },
        ]);
        advance(31 * MINUTE);
        await host.sweep();
        const request = recording.calls[0];
        expect(request?.signals[0]?.title).not.toContain("AKIAIOSFODNN7EXAMPLE");
        // Its source is masked, and a signal whose key looks like a secret is left out.
        expect(JSON.stringify(request?.signals)).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(request?.signals).toHaveLength(1);
        expect(request?.memory).toHaveLength(10);
        expect(request?.memory[0]?.text).toContain("[redacted:");
        expect((memory.ticks.at(-1)?.inputs as { memory: unknown[] }).memory).toHaveLength(10);
      } finally {
        stop();
      }
    });
  });

  describe("the day's budget", () => {
    it("rests when today's model ticks are used, until the next window after tonight's reset, saying so once", async () => {
      const { host, memory, recording, announced, stop } = setup(
        heartbeat({ activeHours: { start: "08:00", end: "22:00" }, budget: { modelTicksPerDay: 3, tokensPerDay: 300_000 } }),
      );
      memory.setUsage({ modelTicks: 3, tokens: 1_000, usd: 0.01 });
      try {
        await host.sweep();
        expect(recording.calls).toEqual([]);
        expect(memory.state()?.config.paused).toEqual({ reason: "budget", until: "2026-10-11T08:00:00.000Z" });
        expect(announced).toEqual(["budget"]);
        expect(memory.ticks.at(-1)).toMatchObject({ outcome: "skipped", reason: "budget", pauseReason: "budget" });
      } finally {
        stop();
      }
    });

    it("starts the day at midnight in the heartbeat's timezone, and rests until its local window", async () => {
      const { host, memory, announced, stop } = setup(
        heartbeat(
          { activeHours: { start: "08:00", end: "22:00" }, budget: { modelTicksPerDay: 1, tokensPerDay: 300_000 } },
          { nextTickAt: "2026-10-10T07:00:00.000Z" },
        ),
        { timezoneOf: async () => "Europe/Sofia" },
      );
      memory.setUsage({ modelTicks: 1, tokens: 0, usd: 0 });
      try {
        await host.sweep();
        // 10:00 UTC is 13:00 in Sofia (UTC+3): its day began at 21:00 UTC the day before.
        expect(memory.usageAsked).toEqual(["2026-10-09T21:00:00.000Z"]);
        expect(memory.state()?.config.paused).toEqual({ reason: "budget", until: "2026-10-11T05:00:00.000Z" });
        expect(announced).toEqual(["budget"]);
      } finally {
        stop();
      }
    });

    it("caps an unpriced model by tokens, its cost unknown", async () => {
      const { host, memory, recording, stop } = setup(heartbeat({ budget: { modelTicksPerDay: 24, tokensPerDay: 10_000, usdPerDay: 1 } }));
      memory.setUsage({ modelTicks: 1, tokens: 10_000, usd: null });
      try {
        await host.sweep();
        expect(recording.calls).toEqual([]);
        expect(memory.state()?.config.paused?.reason).toBe("budget");
      } finally {
        stop();
      }
    });

    it("keeps the dollar limit when some calls had no price, against what the priced ones cost", async () => {
      const { host, memory, recording, stop } = setup(heartbeat({ budget: { modelTicksPerDay: 24, tokensPerDay: 300_000, usdPerDay: 1 } }));
      memory.setUsage({ modelTicks: 2, tokens: 1_000, usd: null, pricedUsd: 1.2 });
      try {
        await host.sweep();
        expect(recording.calls).toEqual([]);
        expect(memory.state()?.config.paused?.reason).toBe("budget");
      } finally {
        stop();
      }
    });

    it("stays resting before the pause ends, and hands a running tick what is left", async () => {
      const { host, memory, recording, at, stop } = setup(heartbeat({}, { nextTickAt: "2026-10-10T10:00:00.000Z" }));
      try {
        await memory.repository.setPaused({
          workspaceId: WS,
          principalId: OP,
          paused: { reason: "budget", until: "2026-10-11T08:00:00.000Z" },
          now: "2026-10-10T10:00:00.000Z",
        });
        await host.sweep();
        expect(recording.calls).toEqual([]);
        memory.setUsage({ modelTicks: 2, tokens: 50_000, usd: 0.2 });
        at("2026-10-11T08:00:00.000Z");
        await memory.repository.setNextTick({
          workspaceId: WS,
          principalId: OP,
          nextTickAt: "2026-10-11T08:00:00.000Z",
          now: "2026-10-11T08:00:00.000Z",
        });
        await host.sweep();
        expect(recording.calls).toHaveLength(1);
        expect(recording.calls[0]?.limits.budgetLeft).toEqual({ modelTicks: 22, tokens: 250_000 });
      } finally {
        stop();
      }
    });

    it("reserves each call's worst case, so the cap is never passed", () => {
      const budget = tickBudget({ modelTicks: 5, tokens: 1_000 });
      expect(budget.reserve({ tokens: 600 })).toBe(true);
      expect(budget.reserve({ tokens: 500 })).toBe(false);
      budget.spend({ tokens: 600 }, { tokens: 100 });
      expect(budget.reserve({ tokens: 900 })).toBe(true);
      expect(budget.reserve({ tokens: 1 })).toBe(false);
      // Dollars are reserved too when the model is priced.
      const priced = tickBudget({ modelTicks: 5, tokens: 1_000_000, usd: 0.1 });
      expect(priced.reserve({ tokens: 10, usd: 0.06 })).toBe(true);
      expect(priced.reserve({ tokens: 10, usd: 0.06 })).toBe(false);
      priced.spend({ tokens: 10, usd: 0.06 }, { tokens: 10, usd: 0.01 });
      expect(priced.reserve({ tokens: 10, usd: 0.08 })).toBe(true);
    });
  });
});

describe("the heartbeat's model turns", () => {
  const turnItem = {
    key: "billing:payment:pay_1",
    urgency: "now" as const,
    title: "A payment failed",
    body: "ACME invoice 1042 bounced",
    sources: [{ label: "Billing" }],
  };

  /** A `runTurn` reporting `items` with `usage`, recording each request. */
  function turnRunner(answer: Partial<HeartbeatTurnResult> = {}) {
    const requests: HeartbeatTurnRequest[] = [];
    let n = 0;
    const runTurn = async (request: HeartbeatTurnRequest): Promise<HeartbeatTurnResult> => {
      requests.push(request);
      n += 1;
      return {
        items: [turnItem],
        taskId: `task-${n}`,
        usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 },
        tokens: 100,
        cacheReadTokens: 40,
        costUsd: 0.01,
        withheld: false,
        completed: true,
        ...answer,
      };
    };
    return { runTurn, requests };
  }

  /** A provider that runs one turn per entry of `turns`, then returns `items`. */
  function turningProvider(turns: readonly { readonly tools?: readonly string[] }[], items: readonly HeartbeatItem[] = []) {
    const answers: unknown[] = [];
    const provider: HeartbeatProvider = {
      async tick(request) {
        for (const turn of turns)
          answers.push(await request.host.runTurn({ prompt: "check", ...(turn.tools === undefined ? {} : { tools: turn.tools }) }));
        return { items };
      },
    };
    return { provider, answers };
  }

  it("delivers what a turn reported, gives the provider back only its keys and urgencies, and records the turn's task and usage", async () => {
    const runner = turnRunner();
    const { host, memory, providers, stop } = setup(heartbeat(), { runTurn: runner.runTurn });
    const turning = turningProvider([{}]);
    providers.install("tavi.heartbeatagent", {
      provider: turning.provider,
      kind: "builtin",
      receives: ["instructions", "signals", "ledger", "memory"],
      usesTurns: true,
      maxTickSeconds: 60,
    });
    try {
      await host.sweep();
      expect(turning.answers).toEqual([
        { reported: [{ key: turnItem.key, urgency: "now" }], usage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 } },
      ]);
      expect(memory.ticks.at(-1)).toMatchObject({
        outcome: "reported",
        itemsNow: 1,
        taskId: "task-1",
        tokens: 100,
        cacheReadTokens: 40,
        costUsd: 0.01,
      });
      expect(runner.requests[0]?.operationKey).toBe(`heartbeat:${WS}:${OP}:2026-10-10T10:00:00.000Z:interval:1`);
      expect(runner.requests[0]?.model).toBe("fast");
    } finally {
      stop();
    }
  });

  it("tells a turn its provider was handed memory only when the tick found some", async () => {
    for (const [records, shown] of [
      [[{ recordId: "m1", revisionId: "m1-r1", kind: "fact" as const, text: "ACME pays late" }], true],
      [[], false],
    ] as const) {
      const runner = turnRunner({ items: [] });
      const { host, providers, stop } = setup(heartbeat(), { runTurn: runner.runTurn, memoryContext: async () => records });
      providers.install("tavi.heartbeatagent", {
        provider: turningProvider([{}]).provider,
        kind: "builtin",
        receives: ["instructions", "signals", "ledger", "memory"],
        usesTurns: true,
        maxTickSeconds: 60,
      });
      try {
        await host.sweep();
        expect(runner.requests[0]?.memoryShown).toBe(shown);
      } finally {
        stop();
      }
    }
  });

  it("merges a turn's items with the provider's own by key, the provider's standing", async () => {
    const runner = turnRunner();
    const { host, memory, providers, stop } = setup(heartbeat(), { runTurn: runner.runTurn });
    const turning = turningProvider(
      [{}],
      [
        { ...turnItem, urgency: "later", title: "A payment failed, retrying" },
        { key: "renewal:globex", urgency: "later", title: "Globex renews Friday", sources: [{ label: "Calendar" }] },
      ],
    );
    providers.install("tavi.heartbeatagent", {
      provider: turning.provider,
      kind: "builtin",
      receives: [],
      usesTurns: true,
      maxTickSeconds: 60,
    });
    try {
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "reported", itemsNow: 0, itemsLater: 2 });
    } finally {
      stop();
    }
  });

  it("records a quiet tick as quiet:withheld when a hook withheld a tool result", async () => {
    const runner = turnRunner({ items: [], withheld: true });
    const { host, memory, providers, stop } = setup(heartbeat(), { runTurn: runner.runTurn });
    providers.install("tavi.heartbeatagent", {
      provider: turningProvider([{}]).provider,
      kind: "builtin",
      receives: [],
      usesTurns: true,
      maxTickSeconds: 60,
    });
    try {
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "quiet:withheld", itemsNow: 0, itemsLater: 0 });
    } finally {
      stop();
    }
  });

  it("offers a turn the allowlist and heartbeat.report only, narrowed to what it asked and, for an external provider, by egress", async () => {
    const runner = turnRunner({ items: [] });
    const { host, providers, stop } = setup(
      heartbeat({ providerId: "acme.heartbeat", providerEgress: { instructions: true, signals: true, ledger: true, memory: false } }),
      { runTurn: runner.runTurn },
    );
    providers.install("acme.heartbeat", {
      provider: turningProvider([{}, { tools: ["memory.search", "reminders.list", "fs.write"] }]).provider,
      kind: "plugin",
      receives: ["instructions", "memory"],
      usesTurns: true,
      maxTickSeconds: 30,
    });
    try {
      await host.sweep();
      // Without memory egress, nothing that reads the person: past chats, reminders, projects and reports included.
      expect(runner.requests[0]?.tools).toEqual(["heartbeat.report"]);
      expect(runner.requests[1]?.tools).toEqual(["heartbeat.report"]);
      expect(runner.requests[0]?.personal).toBe(false);
      // Withheld memory is no block in its prompt, so the turn is not told memory can be out of date.
      expect(runner.requests[0]?.memoryShown).toBe(false);
      // Its turns share one tick key, each its own operation key.
      expect(runner.requests[1]?.tickKey).toBe(runner.requests[0]?.tickKey);
      expect(runner.requests[1]?.operationKey).not.toBe(runner.requests[0]?.operationKey);
    } finally {
      stop();
    }
    const remembering = heartbeat({
      extraTools: ["acme.read"],
      providerEgress: { instructions: false, signals: false, ledger: false, memory: true },
    });
    expect([...heartbeatTurnTools({ kind: "plugin", receives: ["memory"] }, remembering)].sort()).toEqual([
      "acme.read",
      "heartbeat.report",
      "memory.get",
      "memory.search",
      "projects.get",
      "reminders.list",
      "reports.history",
      "sessions.search",
    ]);
    expect(heartbeatTurnTools({ kind: "plugin", receives: [] }, remembering)).toEqual(["heartbeat.report"]);
    const builtin = heartbeatTurnTools(
      { kind: "builtin", receives: [] },
      heartbeat({ providerEgress: { instructions: false, signals: false, ledger: false, memory: false } }),
    );
    expect([...builtin].sort()).toEqual([
      "heartbeat.report",
      "memory.get",
      "memory.search",
      "projects.get",
      "reminders.list",
      "reports.history",
      "sessions.search",
    ]);
  });

  it("offers heartbeat.fetch only when the heartbeat may read a site, and an external provider's turn only with signals, never web_fetch", () => {
    const reading = (signals: boolean) =>
      heartbeat({
        fetchHosts: ["example.com"],
        extraTools: ["web_fetch"],
        providerEgress: { instructions: false, signals, ledger: false, memory: false },
      });
    expect(heartbeatTurnTools({ kind: "builtin", receives: [] }, heartbeat())).not.toContain("heartbeat.fetch");
    expect(heartbeatTurnTools({ kind: "builtin", receives: [] }, reading(false))).toContain("heartbeat.fetch");
    expect(heartbeatTurnTools({ kind: "plugin", receives: ["signals"] }, reading(false))).not.toContain("heartbeat.fetch");
    expect(heartbeatTurnTools({ kind: "plugin", receives: [] }, reading(true))).not.toContain("heartbeat.fetch");
    expect(heartbeatTurnTools({ kind: "plugin", receives: ["signals"] }, reading(true))).toContain("heartbeat.fetch");
    expect(heartbeatTurnTools({ kind: "builtin", receives: [] }, reading(true))).not.toContain("web_fetch");
  });

  it("keeps the limit and gives each its own key when a provider starts its turns together", async () => {
    const runner = turnRunner({ items: [] });
    const { host, providers, stop } = setup(heartbeat(), { runTurn: runner.runTurn });
    const provider: HeartbeatProvider = {
      async tick(request) {
        await Promise.allSettled([1, 2, 3, 4].map(async () => await request.host.runTurn({ prompt: "check" })));
        return { items: [] };
      },
    };
    providers.install("tavi.heartbeatagent", { provider, kind: "builtin", receives: [], usesTurns: true, maxTickSeconds: 60 });
    try {
      await host.sweep();
      expect(runner.requests.map((request) => request.operationKey.split(":").at(-1))).toEqual(["1", "2", "3"]);
    } finally {
      stop();
    }
  });

  it("fails a tick whose turn did not complete, still recording what it spent", async () => {
    const runner = turnRunner({ items: [turnItem], completed: false });
    const { host, memory, providers, stop } = setup(heartbeat(), { runTurn: runner.runTurn });
    providers.install("tavi.heartbeatagent", {
      provider: turningProvider([{}]).provider,
      kind: "builtin",
      receives: [],
      usesTurns: true,
      maxTickSeconds: 60,
    });
    try {
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "failed", reason: "transport", itemsNow: 0, taskId: "task-1", tokens: 100 });
    } finally {
      stop();
    }
  });

  it("rests on a turn the day's budget cannot fit, never counting it as a failure", async () => {
    const runTurn = async (): Promise<HeartbeatTurnResult> => {
      throw new HeartbeatProviderError("budget");
    };
    const { host, memory, providers, stop } = setup(heartbeat(), { runTurn });
    providers.install("tavi.heartbeatagent", {
      provider: turningProvider([{}]).provider,
      kind: "builtin",
      receives: [],
      usesTurns: true,
      maxTickSeconds: 60,
    });
    try {
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "skipped", reason: "budget", pauseReason: "budget" });
      expect(memory.state()?.config.paused).toMatchObject({ reason: "budget", until: expect.any(String) });
    } finally {
      stop();
    }
  });

  it("runs at most three turns a tick, and none for a provider that declared none", async () => {
    const runner = turnRunner({ items: [] });
    const { host, memory, providers, stop } = setup(heartbeat(), { runTurn: runner.runTurn });
    providers.install("tavi.heartbeatagent", {
      provider: turningProvider([{}, {}, {}, {}]).provider,
      kind: "builtin",
      receives: [],
      usesTurns: true,
      maxTickSeconds: 60,
    });
    try {
      await host.sweep();
      expect(runner.requests).toHaveLength(3);
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "failed", tokens: 300 });
      providers.install("tavi.heartbeatagent", {
        provider: turningProvider([{}]).provider,
        kind: "builtin",
        receives: [],
        usesTurns: false,
        maxTickSeconds: 60,
      });
      expect(await host.checkNow(WS, OP)).toEqual({ status: "started" });
      await host.idle();
      expect(runner.requests).toHaveLength(3);
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "failed", error: "this provider did not declare model turns" });
    } finally {
      stop();
    }
  });
});

describe("the heartbeat's delivery", () => {
  const item = (key: string, extra: Partial<HeartbeatItem> = {}): HeartbeatItem => ({
    key,
    urgency: "now",
    title: `Item ${key}`,
    sources: [{ label: "Billing" }],
    ...extra,
  });

  /** A delivery port recording what it was asked; Home on unless told otherwise, every channel able to edit unless told otherwise. */
  function recordingDelivery(options: { home?: boolean; edits?: boolean; outcome?: "accepted" | "rejected" | "uncertain" } = {}) {
    const notices: { sourceKey: string; title: string; summary: string; heartbeatItemId?: string }[] = [];
    const sends: { connectionId: string; effectId: string; text: string }[] = [];
    const edits: { connectionId: string; effectId: string; text: string }[] = [];
    const port: HeartbeatDeliveryPort = {
      notify: async (_state, notice) => {
        notices.push(notice);
        return options.home ?? true;
      },
      send: async (_state, target, message) => {
        sends.push({ connectionId: target.connectionId, effectId: message.effectId, text: message.text });
        return options.outcome ?? "accepted";
      },
      edit: async (_state, target, message) => {
        if (options.edits === false) return false;
        edits.push({ connectionId: target.connectionId, effectId: message.effectId, text: message.text });
        return true;
      },
    };
    return { port, notices, sends, edits };
  }

  /** A host whose provider reports `current`, with a recording delivery port. */
  function delivering(
    config: Partial<HeartbeatConfig> = {},
    options: Parameters<typeof recordingDelivery>[0] = {},
    extra: Partial<HeartbeatHostDependencies> & { readonly eventDebounceMs?: number } = {},
  ) {
    let current: HeartbeatItem[] = [];
    const delivery = recordingDelivery(options);
    const harness = setup(
      heartbeat({
        targets: [
          { connectionId: "chat-a", to: "100" },
          { connectionId: "chat-b", to: "200" },
        ],
        ...config,
      }),
      { delivery: delivery.port, ...extra },
    );
    harness.providers.install("tavi.heartbeatagent", {
      provider: { tick: async () => ({ items: current }) },
      kind: "builtin",
      receives: [],
      usesTurns: false,
      maxTickSeconds: 60,
    });
    const check = async () => {
      expect(await harness.host.checkNow(WS, OP)).toEqual({ status: "started" });
      await harness.host.idle();
      return harness.memory.ticks.at(-1);
    };
    return {
      ...harness,
      ...delivery,
      check,
      report: (items: HeartbeatItem[]) => {
        current = items;
      },
    };
  }

  it("tells an item once, again only when it changed past the cooldown, and never under a muted prefix", async () => {
    const run = delivering({ mutes: ["stripe:test:*"] });
    try {
      run.report([item("billing:1"), item("stripe:test:9")]);
      expect(await run.check()).toMatchObject({ outcome: "reported", itemsNow: 1 });
      expect(run.notices.map((notice) => notice.title)).toEqual(["Item billing:1"]);
      expect(run.sends).toHaveLength(2);
      expect(await run.check()).toMatchObject({ outcome: "quiet", itemsNow: 0 });
      run.report([item("billing:1", { title: "Item billing:1, retried" })]);
      run.advance(60 * MINUTE);
      expect(await run.check()).toMatchObject({ itemsNow: 0 });
      run.advance(6 * 60 * MINUTE);
      expect(await run.check()).toMatchObject({ itemsNow: 1 });
      expect(run.sends).toHaveLength(4);
      expect(run.notices.every((notice) => !notice.title.includes("stripe"))).toBe(true);
    } finally {
      run.stop();
    }
  });

  it("still messages the targets when the app notice cannot be written", async () => {
    const failing = recordingDelivery();
    const run = delivering(
      {},
      {},
      {
        delivery: {
          ...failing.port,
          notify: async () => {
            throw new Error("the store is busy");
          },
        },
      },
    );
    try {
      run.report([item("a")]);
      await run.check();
      await run.host.idle();
      expect(failing.sends.map((send) => send.connectionId)).toEqual(["chat-a", "chat-b"]);
    } finally {
      run.stop();
    }
  });

  it("tells three now items in an hour, and the fourth later, held back", async () => {
    const run = delivering();
    try {
      run.report([item("a"), item("b"), item("c"), item("d")]);
      expect(await run.check()).toMatchObject({ itemsNow: 3, itemsLater: 1 });
      expect(run.memory.ledger.get("d")).toMatchObject({ urgency: "later", heldBack: true });
      expect(run.notices.find((notice) => notice.title === "Item d")?.summary).toContain("Held back");
      expect(run.sends).toHaveLength(6);
    } finally {
      run.stop();
    }
  });

  it.each(["rejected", "uncertain"] as const)(
    "sends a now item to each target once, each under its own effect, and never again after a %s send",
    async (outcome) => {
      const run = delivering({}, { outcome });
      try {
        run.report([item("billing:1")]);
        await run.check();
        expect(run.sends.map((send) => send.connectionId)).toEqual(["chat-a", "chat-b"]);
        expect(new Set(run.sends.map((send) => send.effectId)).size).toBe(2);
        await run.check();
        expect(run.sends).toHaveLength(2);
      } finally {
        run.stop();
      }
    },
  );

  it("puts a later item in Home only, and in the next window's digest once, to Home and the targets", async () => {
    const run = delivering({ activeHours: { start: "08:00", end: "22:00" } });
    try {
      run.report([item("renewal:1", { urgency: "later" })]);
      expect(await run.check()).toMatchObject({ itemsNow: 0, itemsLater: 1 });
      expect(run.sends).toEqual([]);
      // The next morning's window opens: one digest, then none.
      run.at("2026-10-11T08:00:30.000Z");
      run.memory.rows.set(`${WS}/${OP}`, { ...(run.memory.state() as HeartbeatState), nextTickAt: "2026-10-11T08:00:00.000Z" });
      await run.host.sweep();
      await run.host.idle();
      expect(run.notices.at(-1)).toMatchObject({ title: "1 thing from your heartbeat" });
      expect(run.sends.map((send) => send.text)).toEqual([
        "1 thing from your heartbeat\n\n• Item renewal:1",
        "1 thing from your heartbeat\n\n• Item renewal:1",
      ]);
      expect(run.memory.ticks.some((tick) => tick.kind === "digest" && tick.outcome === "delivered" && tick.itemsLater === 1)).toBe(true);
      expect(run.memory.ledger.get("renewal:1")?.digestedAt).toBeDefined();
    } finally {
      run.stop();
    }
  });

  it("sends an urgent item a mod made wait nowhere until the next window's summary, which lists it", async () => {
    const waiting: TurnHooksPort = {
      has: (event) => event === "heartbeat.item",
      dispatch: async (event, input, core) =>
        event === "heartbeat.item" ? ({ result: { urgency: "later" }, decidedBy: "acme.mod" } as never) : { result: await core(input) },
    };
    const run = delivering({ activeHours: { start: "08:00", end: "22:00" } }, {}, { hooks: waiting });
    try {
      run.report([item("renewal:1")]);
      expect(await run.check()).toMatchObject({ itemsNow: 0, itemsLater: 1 });
      expect(run.sends).toEqual([]);
      run.at("2026-10-11T08:00:30.000Z");
      run.memory.rows.set(`${WS}/${OP}`, { ...(run.memory.state() as HeartbeatState), nextTickAt: "2026-10-11T08:00:00.000Z" });
      await run.host.sweep();
      await run.host.idle();
      expect(run.sends.map((send) => send.text)).toEqual([
        "1 thing from your heartbeat\n\n• Item renewal:1",
        "1 thing from your heartbeat\n\n• Item renewal:1",
      ]);
    } finally {
      run.stop();
    }
  });

  it("opens the window when an event is its first look, so the summary still goes out", async () => {
    const run = delivering({ activeHours: { start: "08:00", end: "22:00" } }, {}, { eventDebounceMs: 10 });
    try {
      run.report([item("renewal:1", { urgency: "later" })]);
      await run.check();
      run.report([]);
      run.at("2026-10-11T08:00:30.000Z");
      run.host.wake(WS, OP, { reason: "message", mode: "now" });
      await sleep(40);
      await run.host.idle();
      expect(run.memory.ticks.some((tick) => tick.kind === "window")).toBe(true);
      expect(run.sends.map((send) => send.text)).toContain("1 thing from your heartbeat\n\n• Item renewal:1");
      // The window's first scheduled sweep opens nothing again.
      run.at("2026-10-11T08:03:00.000Z");
      run.memory.rows.set(`${WS}/${OP}`, { ...(run.memory.state() as HeartbeatState), nextTickAt: "2026-10-11T08:03:00.000Z" });
      await run.host.sweep();
      await run.host.idle();
      expect(run.memory.ticks.filter((tick) => tick.kind === "window")).toHaveLength(1);
      expect(run.sends.filter((send) => send.text.startsWith("1 thing from your heartbeat"))).toHaveLength(2);
    } finally {
      run.stop();
    }
  });

  it("opens the window when Check now is its first look", async () => {
    const run = delivering({ activeHours: { start: "08:00", end: "22:00" } });
    try {
      run.report([item("renewal:1", { urgency: "later" })]);
      await run.check();
      run.report([]);
      run.at("2026-10-11T08:00:30.000Z");
      await run.check();
      expect(run.memory.ticks.filter((tick) => tick.kind === "window")).toHaveLength(1);
      expect(run.sends.map((send) => send.text)).toContain("1 thing from your heartbeat\n\n• Item renewal:1");
    } finally {
      run.stop();
    }
  });

  it("lists in Monday's summary what waited since Saturday, when no window opened between", async () => {
    const run = delivering({ activeHours: { start: "08:00", end: "22:00" }, daysOfWeek: [1, 2, 3, 4, 5] });
    try {
      run.report([item("renewal:1", { urgency: "later" })]);
      await run.check();
      // A Check now on Sunday evening, outside every window, does not move what Monday's summary looks back to.
      run.report([]);
      run.at("2026-10-11T20:00:00.000Z");
      await run.check();
      run.at("2026-10-12T08:00:30.000Z");
      run.memory.rows.set(`${WS}/${OP}`, { ...(run.memory.state() as HeartbeatState), nextTickAt: "2026-10-12T08:00:00.000Z" });
      await run.host.sweep();
      await run.host.idle();
      expect(run.sends.map((send) => send.text)).toContain("1 thing from your heartbeat\n\n• Item renewal:1");
    } finally {
      run.stop();
    }
  });

  it("writes the digest row with Home off and no targets", async () => {
    const run = delivering({ targets: [], activeHours: { start: "08:00", end: "22:00" } }, { home: false });
    try {
      run.report([item("renewal:1", { urgency: "later" })]);
      await run.check();
      run.at("2026-10-11T08:00:30.000Z");
      run.memory.rows.set(`${WS}/${OP}`, { ...(run.memory.state() as HeartbeatState), nextTickAt: "2026-10-11T08:00:00.000Z" });
      await run.host.sweep();
      await run.host.idle();
      expect(run.sends).toEqual([]);
      expect(run.memory.ticks.some((tick) => tick.kind === "digest" && tick.itemsLater === 1)).toBe(true);
    } finally {
      run.stop();
    }
  });

  it("leaves a later item out of the digest after 24 h, and tells a snoozed item again when its snooze ends", async () => {
    const run = delivering();
    try {
      run.report([item("renewal:1", { urgency: "later" }), item("billing:1")]);
      await run.check();
      run.advance(25 * 60 * MINUTE);
      expect(
        await run.memory.repository.digestItems({
          workspaceId: WS,
          principalId: OP,
          since: new Date(Date.parse("2026-10-11T11:00:00.000Z") - 24 * 60 * MINUTE).toISOString(),
          limit: 50,
        }),
      ).toEqual([]);
      const told = run.memory.ledger.get("billing:1") as HeartbeatLedgerRow;
      await run.memory.repository.setItemState({
        workspaceId: WS,
        principalId: OP,
        itemId: told.itemId,
        state: "snoozed",
        snoozedUntil: "2026-10-11T12:00:00.000Z",
        now: "2026-10-11T11:00:00.000Z",
      });
      run.report([item("billing:1")]);
      run.at("2026-10-11T11:30:00.000Z");
      expect(await run.check()).toMatchObject({ itemsNow: 0 });
      run.at("2026-10-11T12:00:00.000Z");
      const before = run.sends.length;
      expect(await run.check()).toMatchObject({ itemsNow: 1 });
      // Told again unchanged, it is a message of its own: a channel would not take it for a replay.
      const again = run.sends.slice(before).map((send) => send.effectId);
      expect(again).toHaveLength(2);
      for (const effectId of again) expect(run.sends.slice(0, before).map((send) => send.effectId)).not.toContain(effectId);
    } finally {
      run.stop();
    }
  });

  it("resolves an item whose signals are gone: Resolved in Home, an edit only where the channel can edit, out of the digest", async () => {
    let signals: HeartbeatSignal[] = [
      { key: "a", hash: "1", title: "A payment failed", at: "2026-10-10T09:00:00.000Z", source: "Billing" },
    ];
    const sources = new HeartbeatSignalRegistry();
    sources.install("test", { id: "test", collect: async () => signals }, "builtin");
    for (const edits of [true, false]) {
      const run = delivering({}, { edits }, { signalSources: sources });
      try {
        await run.check();
        run.report([item("billing:1", { signalKeys: ["test:a"] })]);
        signals = [...signals];
        await run.check();
        const sendsBefore = run.sends.length;
        signals = [];
        await run.check();
        expect(run.memory.ledger.get("billing:1")?.state).toBe("resolved");
        expect(run.notices.at(-1)?.title).toMatch(/^Resolved · \d\d:\d\d — Item billing:1$/);
        expect(run.memory.ticks.at(-1)?.itemsRetracted).toBe(1);
        expect(run.edits).toHaveLength(edits ? 2 : 0);
        expect(run.sends).toHaveLength(sendsBefore);
      } finally {
        run.stop();
        signals = [{ key: "a", hash: "1", title: "A payment failed", at: "2026-10-10T09:00:00.000Z", source: "Billing" }];
      }
    }
  });

  it("masks anything secret-shaped the model copied into an item, and drops a proposal whose input held one", () => {
    const [cleaned] = cleanHeartbeatItems(
      [
        {
          key: "k",
          urgency: "now",
          title: "Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 leaked",
          body: "token AKIAIOSFODNN7EXAMPLE",
          sources: [{ label: "Billing" }],
          proposedAction: {
            toolId: "reminders.create",
            input: { text: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
            summary: "Remind",
          },
        },
      ],
      new Set(),
    );
    expect(JSON.stringify(cleaned)).not.toMatch(/sk-ant-api03|AKIAIOSFODNN7EXAMPLE/);
    expect(cleaned?.proposedAction).toBeUndefined();
  });

  it("disarms every address in what it tells but a watched page's, so no channel fetches a preview of it", async () => {
    const run = delivering({ instructions: "watch: https://example.com/pricing — tell me if the Pro price changes" });
    try {
      run.report([
        item("page:1", {
          title: "Pricing changed: https://example.com/pricing",
          body: "Details at https://evil.example/?q=home-address or evil.example/x",
          sources: [{ label: "see www.evil.example" }],
        }),
      ]);
      await run.check();
      const text = run.sends[0]?.text ?? "";
      expect(text).toContain("https://example.com/pricing");
      expect(text).toContain("hxxps[:]//evil[.]example/?q=home-address");
      expect(text).toContain("evil[.]example/x");
      expect(text).not.toMatch(/(?<![[\w])evil\.example/);
      expect(run.memory.ledger.get("page:1")?.sources[0]?.label).toBe("see www[.]evil[.]example");
    } finally {
      run.stop();
    }
  });

  it("renders a link only for a ref the host produced, and drops a proposal holding a masked secret or a path", async () => {
    const run = delivering();
    try {
      run.report([
        item("a", {
          sources: [{ label: "Evil", ref: "https://evil.example/steal" }],
          proposedAction: { toolId: "fs.write", input: { path: "/etc/passwd", text: "x" }, summary: "Write" },
        }),
        item("b", {
          proposedAction: { toolId: "http.request", input: { headers: { authorization: "[redacted:bearer]" } }, summary: "Call" },
        }),
        item("c", { proposedAction: { toolId: "reminders.create", input: { text: "Pay ACME" }, summary: "Remind me" } }),
      ]);
      await run.check();
      expect(run.memory.ledger.get("a")?.sources).toEqual([{ label: "Evil" }]);
      expect(run.memory.ledger.get("a")?.proposedAction).toBeUndefined();
      expect(run.memory.ledger.get("b")?.proposedAction).toBeUndefined();
      expect(run.memory.ledger.get("c")?.proposedAction).toMatchObject({ toolId: "reminders.create" });
      // The notice summary holds the sources, never the body.
      expect(run.notices.every((notice) => notice.summary === "Evil" || notice.summary === "Billing")).toBe(true);
    } finally {
      run.stop();
    }
  });

  it("drops a proposal naming a Windows path: drive-relative or a share", async () => {
    const run = delivering();
    try {
      run.report([
        item("d", { proposedAction: { toolId: "fs.read", input: { from: "C:secret" }, summary: "Read" } }),
        item("e", { proposedAction: { toolId: "fs.read", input: { from: "\\\\server\\share\\x" }, summary: "Read" } }),
      ]);
      await run.check();
      expect(run.memory.ledger.get("d")?.proposedAction).toBeUndefined();
      expect(run.memory.ledger.get("e")?.proposedAction).toBeUndefined();
    } finally {
      run.stop();
    }
  });

  it("promotes everything to now under everything-now, still within the hourly limit, and demotes to later under digest-only", async () => {
    const everything = delivering({ tellMe: "everything-now" });
    try {
      everything.report([
        item("a", { urgency: "later" }),
        item("b", { urgency: "later" }),
        item("c", { urgency: "later" }),
        item("d", { urgency: "later" }),
      ]);
      expect(await everything.check()).toMatchObject({ itemsNow: 3, itemsLater: 1 });
    } finally {
      everything.stop();
    }
    const digestOnly = delivering({ tellMe: "digest-only" });
    try {
      digestOnly.report([item("a")]);
      expect(await digestOnly.check()).toMatchObject({ itemsNow: 0, itemsLater: 1 });
      expect(digestOnly.sends).toEqual([]);
    } finally {
      digestOnly.stop();
    }
  });

  it("alerts Home and the targets when it pauses itself", async () => {
    const run = delivering({ providerId: "acme.missing" });
    try {
      await run.host.sweep();
      await run.host.idle();
      expect(run.notices.at(-1)).toMatchObject({ title: "Your heartbeat paused" });
      expect(run.sends).toHaveLength(2);
    } finally {
      run.stop();
    }
  });
});

describe("the heartbeat's reliability", () => {
  function failing(extra: Partial<HeartbeatHostDependencies> = {}) {
    const notices: string[] = [];
    const delivery: HeartbeatDeliveryPort = {
      notify: async (_state, notice) => {
        notices.push(notice.title);
        return true;
      },
      send: async () => "skipped",
      edit: async () => false,
    };
    const harness = setup(heartbeat(), { delivery, ...extra });
    let fail = true;
    harness.providers.install("tavi.heartbeatagent", {
      provider: {
        tick: async () => {
          if (fail) throw new Error("the model is down");
          return { items: [] };
        },
      },
      kind: "builtin",
      receives: [],
      usesTurns: false,
      maxTickSeconds: 60,
    });
    const check = async () => {
      const answer = await harness.host.checkNow(WS, OP);
      await harness.host.idle();
      return answer;
    };
    return {
      ...harness,
      notices,
      check,
      recover: (next: boolean) => {
        fail = !next;
      },
    };
  }

  const resume = async (memory: ReturnType<typeof memoryRepository>) => {
    await memory.repository.setPaused({ workspaceId: WS, principalId: OP, paused: null, now: "2026-10-10T10:00:00.000Z" });
  };

  it("pauses after five failed ticks in a row with one alert, repeated at most every 6 h", async () => {
    const run = failing();
    try {
      for (let n = 0; n < 4; n += 1) await run.check();
      expect(run.memory.state()?.config.paused).toBeUndefined();
      await run.check();
      expect(run.memory.state()?.config.paused).toEqual({ reason: "failures" });
      expect(run.memory.ticks.at(-1)).toMatchObject({ outcome: "failed", pauseReason: "failures" });
      expect(run.notices).toEqual(["Your heartbeat paused"]);
      expect(await run.check()).toMatchObject({ status: "refused" });
      // Resumed, and failing again within 6 h: paused, but not told again.
      await resume(run.memory);
      run.advance(60 * MINUTE);
      for (let n = 0; n < 5; n += 1) await run.check();
      expect(run.memory.state()?.config.paused).toEqual({ reason: "failures" });
      expect(run.notices).toHaveLength(1);
      // Past 6 h, told again.
      await resume(run.memory);
      run.advance(6 * 60 * MINUTE);
      for (let n = 0; n < 5; n += 1) await run.check();
      expect(run.notices).toHaveLength(2);
    } finally {
      run.stop();
    }
  });

  it("never counts skips or deferrals, and starts again after a success", async () => {
    const run = failing();
    try {
      for (let n = 0; n < 4; n += 1) await run.check();
      run.recover(true);
      await run.check();
      run.recover(false);
      for (let n = 0; n < 4; n += 1) await run.check();
      // A skip between failures neither counts nor ends the run.
      await run.memory.repository.recordTick({
        tickId: "skip-1",
        workspaceId: WS,
        principalId: OP,
        kind: null,
        wakeReason: "interval",
        outcome: "skipped",
        reason: "busy",
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
        now: "2026-10-10T10:00:00.000Z",
        advancesLastTick: false,
      });
      expect(run.memory.state()?.config.paused).toBeUndefined();
      await run.check();
      expect(run.memory.state()?.config.paused).toEqual({ reason: "failures" });
    } finally {
      run.stop();
    }
  });

  it("keeps a failures pause across a restart, and never resumes it by itself", async () => {
    const run = failing();
    for (let n = 0; n < 5; n += 1) await run.check();
    run.stop();
    const providers = new HeartbeatProviderRegistry();
    providers.install("tavi.heartbeatagent", {
      provider: { tick: async () => ({ items: [] }) },
      kind: "builtin",
      receives: [],
      usesTurns: false,
      maxTickSeconds: 60,
    });
    const ticksBefore = run.memory.ticks.length;
    const restarted = startHeartbeatHost({
      repository: run.memory.repository,
      providers,
      now: () => new Date("2026-10-12T10:00:00.000Z"),
      newId: (prefix) => `${prefix}-r`,
      sweepMs: 60 * 60_000,
      timezoneOf: async () => "UTC",
      homeActivity: async () => undefined,
      modelAvailable: async () => true,
      log: () => undefined,
    });
    try {
      run.memory.rows.set(`${WS}/${OP}`, { ...(run.memory.state() as HeartbeatState), nextTickAt: "2026-10-12T09:00:00.000Z" });
      await restarted.sweep();
      await restarted.idle();
      expect(run.memory.state()?.config.paused).toEqual({ reason: "failures" });
      expect(run.memory.ticks.slice(ticksBefore).every((tick) => tick.outcome !== "quiet" && tick.outcome !== "failed")).toBe(true);
    } finally {
      restarted.stop();
    }
  });

  it("clamps a provider's next-wake hint to [min(15 min, interval), interval] from now", () => {
    const now = new Date("2026-10-10T10:00:00.000Z");
    expect(clampHeartbeatHint("2026-10-10T10:01:00.000Z", now, 30 * MINUTE)?.toISOString()).toBe("2026-10-10T10:15:00.000Z");
    expect(clampHeartbeatHint("2026-10-10T10:20:00.000Z", now, 30 * MINUTE)?.toISOString()).toBe("2026-10-10T10:20:00.000Z");
    expect(clampHeartbeatHint("2026-10-10T13:00:00.000Z", now, 30 * MINUTE)?.toISOString()).toBe("2026-10-10T10:30:00.000Z");
    // Under a test floor the interval is the floor too.
    expect(clampHeartbeatHint("2026-10-10T09:00:00.000Z", now, 2_000)?.toISOString()).toBe("2026-10-10T10:00:02.000Z");
    expect(clampHeartbeatHint("soon", now, 30 * MINUTE)).toBeUndefined();
  });

  it("brings the next look closer on a hint, never further", async () => {
    const { host, memory, providers, stop } = setup(heartbeat());
    try {
      providers.install("tavi.heartbeatagent", {
        provider: { tick: async () => ({ items: [], nextWakeHint: "2026-10-10T10:16:00.000Z" }) },
        kind: "builtin",
        receives: [],
        usesTurns: false,
        maxTickSeconds: 60,
      });
      memory.rows.set(`${WS}/${OP}`, { ...(memory.state() as HeartbeatState), nextTickAt: "2026-10-10T10:30:00.000Z" });
      await host.checkNow(WS, OP);
      await host.idle();
      expect(memory.state()?.nextTickAt).toBe("2026-10-10T10:16:00.000Z");
    } finally {
      stop();
    }
  });
});

describe("mods' heartbeat hooks", () => {
  /** A hooks port: `item` answers each heartbeat.item, and every heartbeat.tick input is kept. */
  function hooksPort(item?: (input: ModHookInput<"heartbeat.item">) => ModHookResult<"heartbeat.item">) {
    const ticks: ModHookInput<"heartbeat.tick">[] = [];
    const items: ModHookInput<"heartbeat.item">[] = [];
    const port: TurnHooksPort = {
      has: (event) => event === "heartbeat.tick" || (event === "heartbeat.item" && item !== undefined),
      dispatch: async (event, input, core) => {
        if (event === "heartbeat.item" && item !== undefined) {
          items.push(input as ModHookInput<"heartbeat.item">);
          const result = item(input as ModHookInput<"heartbeat.item">);
          return Object.keys(result).length === 0 ? { result } : ({ result, decidedBy: "acme.mod" } as never);
        }
        if (event === "heartbeat.tick") ticks.push(input as ModHookInput<"heartbeat.tick">);
        return { result: await core(input) };
      },
    };
    return { port, ticks, items };
  }

  it("records an item a mod holds back as filtered, tells it nowhere, and puts the decision on the check's record", async () => {
    const hooks = hooksPort(() => ({ drop: "Not today: key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }));
    const { host, memory, stop } = setup(heartbeat(), { hooks: hooks.port });
    try {
      await host.sweep();
      await host.idle();
      expect(memory.ledger.get("stripe:in_1")).toMatchObject({ state: "filtered" });
      // The mod's reason is kept on the record, masked.
      expect(memory.ticks.at(-1)).toMatchObject({
        outcome: "quiet",
        itemsNow: 0,
        hookDecisions: [{ key: "stripe:in_1", by: "acme.mod", action: "held back", reason: expect.stringContaining("Not today") }],
      });
      expect(JSON.stringify(memory.ticks.at(-1)?.hookDecisions)).not.toContain("sk-ant-api03");
      expect(hooks.items[0]).toMatchObject({
        key: "stripe:in_1",
        urgency: "now",
        title: "ACME payment failed",
        envelope: { source: "heartbeat", attended: false, heartbeatProvider: "tavi.heartbeatagent" },
      });
    } finally {
      stop();
    }
  });

  it("leaves the hour's limit to the items told: a held-back urgent item uses none of it", async () => {
    const hooks = hooksPort((input) => (input.key === "billing:1" ? { drop: "Not this one" } : {}));
    const { host, memory, providers, stop } = setup(heartbeat({ maxNowPerHour: 1 }), { hooks: hooks.port });
    try {
      providers.install("tavi.heartbeatagent", {
        provider: {
          tick: async () => ({
            items: [
              { key: "billing:1", urgency: "now", title: "Held back", sources: [{ label: "Billing" }] },
              { key: "billing:2", urgency: "now", title: "Told now", sources: [{ label: "Billing" }] },
            ],
          }),
        },
        kind: "builtin",
        receives: ["instructions", "signals", "ledger", "memory"],
        usesTurns: false,
        maxTickSeconds: 60,
      });
      await host.sweep();
      expect(memory.ledger.get("billing:2")).toMatchObject({ urgency: "now", heldBack: false });
      expect(memory.ticks.at(-1)).toMatchObject({ itemsNow: 1, hookDecisions: [{ key: "billing:1", action: "held back" }] });
    } finally {
      stop();
    }
  });

  it("tells an item a mod makes wait in the summary instead", async () => {
    const hooks = hooksPort(() => ({ urgency: "later" }));
    const { host, memory, stop } = setup(heartbeat(), { hooks: hooks.port });
    try {
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "reported", itemsNow: 0, itemsLater: 1 });
      expect(memory.ledger.get("stripe:in_1")).toMatchObject({ state: "told", urgency: "later" });
    } finally {
      stop();
    }
  });

  it("tells an item as decided when asking the mods fails, and records no decision", async () => {
    let asked = 0;
    const port: TurnHooksPort = {
      has: (event) => event === "heartbeat.item",
      dispatch: async (event, input, core) => {
        if (event === "heartbeat.item") {
          asked += 1;
          throw new Error("the hook registry is closed");
        }
        return { result: await core(input) };
      },
    };
    const { host, memory, stop } = setup(heartbeat(), { hooks: port });
    try {
      await host.sweep();
      expect(memory.ledger.get("stripe:in_1")).toMatchObject({ state: "told", urgency: "now" });
      expect(asked).toBe(1);
      expect(memory.ticks.at(-1)).toMatchObject({ outcome: "reported", itemsNow: 1, hookDecisions: null });
    } finally {
      stop();
    }
  });

  it("tells heartbeat.tick of each check once recorded, never what it looked at", async () => {
    const hooks = hooksPort();
    const { host, stop } = setup(heartbeat(), { hooks: hooks.port });
    try {
      await host.sweep();
      await host.idle();
      expect(hooks.ticks).toHaveLength(1);
      expect(hooks.ticks[0]).toMatchObject({ wake: "interval", kind: "deep", outcome: "reported", itemsNow: 1, timezone: "UTC" });
      for (const key of Object.keys(hooks.ticks[0] ?? {}))
        expect(["envelope", "now", "timezone", "wake", "kind", "gate", "outcome", "itemsNow", "itemsLater", "usage"]).toContain(key);
      expect(hooks.ticks[0]?.envelope.taskId).toMatch(/^heartbeat:hbt-/);
    } finally {
      stop();
    }
  });
});

describe("a provider's own panel", () => {
  it("keeps what a provider publishes for this person, masked and bounded, and refuses a bad key or an oversized value", async () => {
    const states = new HeartbeatProviderStates();
    const { host, providers, stop } = setup(heartbeat({ providerId: "acme.heartbeat" }), { providerStates: states });
    const refused: string[] = [];
    let kept: { publish(key: string, value: unknown): void } | undefined;
    try {
      providers.install("acme.heartbeat", {
        provider: {
          tick: async ({ host: own }) => {
            kept = own;
            own.publish("rules", { matched: 2, token: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" });
            for (const [key, value] of [
              ["no spaces allowed", 1],
              ["huge", "x".repeat(20_000)],
            ] as const) {
              try {
                own.publish(key, value);
              } catch (error) {
                refused.push((error as Error).message);
              }
            }
            return { items: [] };
          },
        },
        kind: "plugin",
        receives: [],
        usesTurns: false,
        maxTickSeconds: 30,
      });
      await host.sweep();
      // Kept past its check, `host` refuses: the tick is over.
      expect(() => kept?.publish("late", 1)).toThrow("the heartbeat tick was stopped");
      const published = states.get(WS, OP, "acme.heartbeat");
      expect(published?.["rules"]).toMatchObject({ matched: 2 });
      expect(JSON.stringify(published)).not.toContain("sk-ant-api03");
      expect(refused).toHaveLength(2);
      expect(states.get(WS, "someone-else", "acme.heartbeat")).toBeUndefined();
      // At most 16 keys, the oldest dropped; Forget clears them.
      for (let index = 0; index < 20; index += 1)
        states.publish({ workspaceId: WS, principalId: OP }, "acme.heartbeat", `k${index}`, index);
      expect(Object.keys(states.get(WS, OP, "acme.heartbeat") ?? {})).toHaveLength(16);
      states.forget(WS, OP);
      expect(states.get(WS, OP, "acme.heartbeat")).toBeUndefined();
    } finally {
      stop();
    }
  });
});

describe("event wakes", () => {
  /** Not due for half an hour, and its last deep look just now: a scheduled sweep would find nothing to do. */
  const quiet = (config: Partial<HeartbeatConfig> = {}) =>
    heartbeat(config, { nextTickAt: "2026-10-10T10:30:00.000Z", lastDeepTickAt: "2026-10-10T09:59:00.000Z" });
  const settle = async (host: { idle(): Promise<void> }) => {
    await sleep(40);
    await host.idle();
  };

  it("turns a burst of events into one event tick, which looks even with nothing new", async () => {
    const { host, memory, recording, stop } = setup(quiet(), { eventDebounceMs: 10 });
    try {
      for (const reason of ["message", "message", "need", "failed-run", "message"] as const) host.wake(WS, OP, { reason, mode: "now" });
      await settle(host);
      expect(recording.calls).toHaveLength(1);
      expect(memory.ticks).toHaveLength(1);
      expect(memory.ticks[0]).toMatchObject({ wakeReason: "event", kind: "signal", outcome: "reported" });
      // The schedule is left as it was.
      expect(memory.state()?.nextTickAt).toBe("2026-10-10T10:30:00.000Z");
    } finally {
      stop();
    }
  });

  it("runs at most one event tick in 10 minutes; a later event makes the next scheduled tick look", async () => {
    const { host, memory, recording, at, stop } = setup(quiet(), { eventDebounceMs: 10 });
    try {
      host.wake(WS, OP, { reason: "message", mode: "now" });
      await settle(host);
      at("2026-10-10T10:05:00.000Z");
      host.wake(WS, OP, { reason: "message", mode: "now" });
      await settle(host);
      expect(recording.calls).toHaveLength(1);
      at("2026-10-10T10:30:00.000Z");
      await host.sweep();
      // It looked (the same item, told 30 minutes ago, is not told again).
      expect(memory.ticks.at(-1)).toMatchObject({ wakeReason: "event", outcome: "quiet" });
      expect(recording.calls).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it("keeps an event a gate turned away, and does not spend its 10-minute allowance on it", async () => {
    const { host, memory, recording, providers, advance, stop } = setup(quiet({ providerId: "acme.dev" }), { eventDebounceMs: 10 });
    try {
      const dev = recordingProvider();
      const entry = { provider: dev.provider, kind: "plugin" as const, receives: [], usesTurns: false, maxTickSeconds: 5, dev: true };
      // Reloading after a save: the event's look is turned away before it looks at anything.
      providers.install("acme.dev", entry)();
      host.wake(WS, OP, { reason: "failed-run", mode: "now" });
      await settle(host);
      expect(memory.ticks.at(-1)).toMatchObject({ wakeReason: "event", reason: "provider-reloading" });
      // Back a minute later, the next event runs at once rather than ten minutes on.
      providers.install("acme.dev", entry);
      advance(MINUTE);
      host.wake(WS, OP, { reason: "failed-run", mode: "now" });
      await settle(host);
      expect(dev.calls).toHaveLength(1);
      expect(memory.ticks.at(-1)).toMatchObject({ wakeReason: "event", outcome: "reported" });
      expect(recording.calls).toEqual([]);
    } finally {
      stop();
    }
  });

  it("leaves an event turned away by a gate for the next scheduled look", async () => {
    const { host, memory, providers, at, stop } = setup(quiet({ providerId: "acme.dev" }), { eventDebounceMs: 10 });
    try {
      const dev = recordingProvider();
      const entry = { provider: dev.provider, kind: "plugin" as const, receives: [], usesTurns: false, maxTickSeconds: 5, dev: true };
      providers.install("acme.dev", entry)();
      host.wake(WS, OP, { reason: "failed-run", mode: "now" });
      await settle(host);
      providers.install("acme.dev", entry);
      at("2026-10-10T10:30:00.000Z");
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ wakeReason: "event" });
      expect(dev.calls).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("keeps an event a scheduled look's gate turned away, for the look after", async () => {
    let free = 1024;
    const { host, memory, recording, at, stop } = setup(quiet(), { eventDebounceMs: 10, freeBytes: () => free });
    try {
      host.wake(WS, OP, { reason: "failed-run", mode: "now" });
      await settle(host);
      // The disk is still full when the sweep picks the event up: the look is turned away, and the event is not spent.
      at("2026-10-10T10:30:00.000Z");
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ reason: "disk-full" });
      expect(recording.calls).toEqual([]);
      free = Number.MAX_SAFE_INTEGER;
      at("2026-10-10T11:30:00.000Z");
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ wakeReason: "event" });
      expect(recording.calls).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("waits outside the active hours, and runs as the window's first tick", async () => {
    const { host, memory, recording, at, stop } = setup(quiet({ activeHours: { start: "12:00", end: "18:00" } }), { eventDebounceMs: 10 });
    try {
      host.wake(WS, OP, { reason: "need", mode: "now" });
      await settle(host);
      expect(recording.calls).toEqual([]);
      at("2026-10-10T12:00:30.000Z");
      memory.rows.set(`${WS}/${OP}`, {
        ...(memory.state() as HeartbeatState),
        nextTickAt: "2026-10-10T12:00:00.000Z",
        lastTickAt: "2026-10-10T12:00:10.000Z",
      });
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ wakeReason: "event", outcome: "reported" });
    } finally {
      stop();
    }
  });

  it("is ignored by a paused heartbeat, and leaves nothing waiting for after it resumes", async () => {
    const { host, memory, recording, at, stop } = setup(quiet({ paused: { reason: "user" } }), { eventDebounceMs: 10 });
    try {
      host.wake(WS, OP, { reason: "message", mode: "now" });
      host.wake(WS, OP, { reason: "failed-run", mode: "next" });
      await settle(host);
      expect(recording.calls).toEqual([]);
      const state = memory.state() as HeartbeatState;
      const { paused: _paused, ...running } = state.config;
      memory.rows.set(`${WS}/${OP}`, { ...state, config: running });
      at("2026-10-10T10:30:00.000Z");
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ wakeReason: "interval", outcome: "skipped", reason: "nothing-new" });
    } finally {
      stop();
    }
  });

  it("drops an event that waited into a pause: the first tick after it resumes is an ordinary one", async () => {
    const { host, memory, recording, at, stop } = setup(quiet(), { eventDebounceMs: 10 });
    try {
      host.wake(WS, OP, { reason: "message", mode: "next" });
      await settle(host);
      const state = memory.state() as HeartbeatState;
      memory.rows.set(`${WS}/${OP}`, { ...state, config: { ...state.config, paused: { reason: "user" } } });
      at("2026-10-10T10:30:00.000Z");
      await host.sweep();
      const paused = memory.state() as HeartbeatState;
      const { paused: _paused, ...resumed } = paused.config;
      memory.rows.set(`${WS}/${OP}`, { ...paused, config: resumed, nextTickAt: "2026-10-10T10:30:00.000Z" });
      await host.sweep();
      expect(recording.calls).toEqual([]);
      expect(memory.ticks.at(-1)).toMatchObject({ wakeReason: "interval", outcome: "skipped", reason: "nothing-new" });
    } finally {
      stop();
    }
  });

  it("does not count an event a gate turned away toward the one-per-10-minutes limit", async () => {
    let model = false;
    const { host, recording, stop } = setup(quiet(), { eventDebounceMs: 10, modelAvailable: async () => model });
    try {
      host.wake(WS, OP, { reason: "message", mode: "now" });
      await settle(host);
      model = true;
      host.wake(WS, OP, { reason: "message", mode: "now" });
      await settle(host);
      expect(recording.calls).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("writes at most one row in 10 minutes for events a gate keeps turning away", async () => {
    const { host, memory, recording, advance, stop } = setup(quiet(), { eventDebounceMs: 10, modelAvailable: async () => false });
    try {
      host.wake(WS, OP, { reason: "failed-run", mode: "now" });
      await settle(host);
      advance(MINUTE);
      host.wake(WS, OP, { reason: "failed-run", mode: "now" });
      await settle(host);
      expect(recording.calls).toEqual([]);
      expect(memory.ticks.filter((tick) => tick.wakeReason === "event" && tick.outcome === "skipped")).toEqual([
        expect.objectContaining({ reason: "no-model" }),
      ]);
    } finally {
      stop();
    }
  });

  it("queues nothing for the next look of a heartbeat that is off", async () => {
    const { host, memory, recording, at, stop } = setup(quiet({ enabled: false }), { eventDebounceMs: 10 });
    try {
      host.wake(WS, OP, { reason: "message", mode: "next" });
      await settle(host);
      const state = memory.state() as HeartbeatState;
      memory.rows.set(`${WS}/${OP}`, { ...state, config: { ...state.config, enabled: true }, nextTickAt: "2026-10-10T10:30:00.000Z" });
      at("2026-10-10T10:30:00.000Z");
      await host.sweep();
      expect(recording.calls).toEqual([]);
      expect(memory.ticks.at(-1)).toMatchObject({ wakeReason: "interval", outcome: "skipped", reason: "nothing-new" });
    } finally {
      stop();
    }
  });

  it("clears an expired pause only while it is still the one stored", async () => {
    const { host, memory, recording, stop } = setup(heartbeat({ paused: { reason: "user", until: "2026-10-10T09:00:00.000Z" } }));
    const get = memory.repository.get.bind(memory.repository);
    // The person paused again after the sweep read the expired pause.
    memory.repository.get = async (workspaceId: string, principalId: string) => {
      const state = await get(workspaceId, principalId);
      return state === undefined ? undefined : { ...state, config: { ...state.config, paused: { reason: "user" } } };
    };
    try {
      await host.sweep();
      expect(recording.calls).toEqual([]);
      expect(memory.state()?.config.paused).toEqual({ reason: "user", until: "2026-10-10T09:00:00.000Z" });
    } finally {
      stop();
    }
  });

  it("with next, makes the next scheduled tick look rather than running one now", async () => {
    const { host, memory, recording, at, stop } = setup(quiet(), { eventDebounceMs: 10 });
    try {
      host.wake(WS, OP, { reason: "message", mode: "next" });
      await settle(host);
      expect(recording.calls).toEqual([]);
      at("2026-10-10T10:30:00.000Z");
      await host.sweep();
      expect(memory.ticks.at(-1)).toMatchObject({ wakeReason: "event", outcome: "reported" });
    } finally {
      stop();
    }
  });
});

describe("what a provider is told it said lately", () => {
  it("hands the next check the person's 👎 and mutes, and an external provider nothing without ledger egress", async () => {
    const { host, memory, providers, stop } = setup(heartbeat());
    const seen: HeartbeatTickRequest[] = [];
    let items: HeartbeatItem[] = [
      { key: "billing:1", urgency: "now", title: "A payment failed", sources: [{ label: "Billing" }] },
      { key: "stripe:test:9", urgency: "later", title: "A test invoice failed", sources: [{ label: "Billing" }] },
    ];
    providers.install("tavi.heartbeatagent", {
      provider: {
        tick: async (request) => {
          seen.push(request);
          const answer = { items };
          items = [];
          return answer;
        },
      },
      kind: "builtin",
      receives: ["instructions", "signals", "ledger", "memory"],
      usesTurns: false,
      maxTickSeconds: 60,
    });
    try {
      await host.checkNow(WS, OP);
      await host.idle();
      expect(seen[0]?.recent).toEqual([]);
      const billing = memory.ledger.get("billing:1") as HeartbeatLedgerRow;
      const test = memory.ledger.get("stripe:test:9") as HeartbeatLedgerRow;
      await memory.repository.setItemFeedback({
        workspaceId: WS,
        principalId: OP,
        itemId: billing.itemId,
        feedback: "down",
        now: "2026-10-10T10:01:00.000Z",
      });
      await memory.repository.setItemState({
        workspaceId: WS,
        principalId: OP,
        itemId: test.itemId,
        state: "muted",
        now: "2026-10-10T10:01:00.000Z",
      });
      await host.checkNow(WS, OP);
      await host.idle();
      expect(seen[1]?.recent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "billing:1", feedback: "down", state: "told" }),
          expect.objectContaining({ key: "stripe:test:9", state: "muted" }),
        ]),
      );
      providers.install("acme.heartbeat", {
        provider: {
          tick: async (request) => {
            seen.push(request);
            return { items: [] };
          },
        },
        kind: "plugin",
        receives: ["instructions"],
        usesTurns: false,
        maxTickSeconds: 30,
      });
      memory.rows.set(`${WS}/${OP}`, {
        ...(memory.state() as HeartbeatState),
        config: { ...(memory.state() as HeartbeatState).config, providerId: "acme.heartbeat" },
      });
      await host.checkNow(WS, OP);
      await host.idle();
      expect(seen[2]?.recent).toEqual([]);
    } finally {
      stop();
    }
  });

  it("shows a provider only what was told since it was chosen, never another provider's items", async () => {
    const { host, memory, providers, advance, stop } = setup(heartbeat());
    const seen: HeartbeatTickRequest[] = [];
    let items: HeartbeatItem[] = [{ key: "billing:1", urgency: "now", title: "A payment failed", sources: [{ label: "Billing" }] }];
    providers.install("acme.heartbeat", {
      provider: {
        tick: async (request) => {
          seen.push(request);
          const answer = { items };
          items = [];
          return answer;
        },
      },
      kind: "plugin",
      receives: ["ledger"],
      usesTurns: false,
      maxTickSeconds: 30,
    });
    try {
      await host.checkNow(WS, OP);
      await host.idle();
      // The built-in one told it; then the person picks acme.heartbeat, whose ledger egress is on.
      advance(60_000);
      const state = memory.state() as HeartbeatState;
      memory.rows.set(`${WS}/${OP}`, {
        ...state,
        providerSince: "2026-10-10T10:01:00.000Z",
        config: { ...state.config, providerId: "acme.heartbeat", providerEgress: { ...state.config.providerEgress, ledger: true } },
      });
      items = [{ key: "acme:1", urgency: "now", title: "A job failed", sources: [{ label: "Jobs" }] }];
      await host.checkNow(WS, OP);
      await host.idle();
      expect(seen[0]?.recent).toEqual([]);
      advance(60_000);
      await host.checkNow(WS, OP);
      await host.idle();
      expect(seen[1]?.recent.map((entry) => entry.key)).toEqual(["acme:1"]);
    } finally {
      stop();
    }
  });
});
