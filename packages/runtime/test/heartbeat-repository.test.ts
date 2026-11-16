import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  TaviError,
  defaultHeartbeatConfig,
  type HeartbeatConfig,
  type RecordHeartbeatTickInput,
  type TellHeartbeatItem,
} from "@tavi/contracts";
import { temporaryDirectories } from "@tavi/test-support";
import { SqliteStore } from "../src/persistence/store.js";

/**
 * Heartbeat storage: the repository — its compare-and-set save, the claim that is
 * the per-heartbeat lock, the record and the instructions history.
 */

const AT = "2026-10-10T08:00:00.000Z";
const LATER = "2026-10-10T08:30:00.000Z";
const scope = { workspaceId: "default", principalId: "operator" };

const cleanup: (() => void)[] = [];
const directories = temporaryDirectories();
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  directories.cleanup();
});

function opened() {
  const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
  cleanup.push(() => store.close());
  return store;
}

function repositories() {
  return opened().asPort().repositories.heartbeats;
}

const enabled = (overrides: Partial<HeartbeatConfig> = {}): HeartbeatConfig => ({
  ...defaultHeartbeatConfig(),
  enabled: true,
  ...overrides,
});

const tick = (overrides: Partial<RecordHeartbeatTickInput> = {}): RecordHeartbeatTickInput => ({
  tickId: "tick-1",
  ...scope,
  kind: "deep",
  wakeReason: "interval",
  outcome: "quiet",
  reason: null,
  pauseReason: null,
  providerId: "tavi.heartbeatagent",
  taskId: "task-1",
  itemsNow: 0,
  itemsLater: 0,
  itemsRetracted: 0,
  inputs: { instructionsRevision: 1, signalKeys: [], memory: [{ recordId: "m1", revision: 2 }] },
  hookDecisions: null,
  tokens: 1200,
  cacheReadTokens: 800,
  costUsd: null,
  durationMs: 950,
  error: null,
  providerDev: false,
  now: LATER,
  advancesLastTick: true,
  ...overrides,
});

describe("the heartbeat repository", () => {
  it("creates at revision 1, reads back the config as saved, and keeps column fields out of the JSON", async () => {
    const heartbeats = repositories();
    expect(await heartbeats.get(scope.workspaceId, scope.principalId)).toBeUndefined();
    const saved = await heartbeats.save({
      ...scope,
      config: enabled({ instructions: "Failed payments" }),
      expectedRevision: 0,
      nextTickAt: LATER,
      author: "operator",
      now: AT,
    });
    expect(saved.config.revision).toBe(1);
    expect(saved.config.enabled).toBe(true);
    expect(saved.nextTickAt).toBe(LATER);
    expect(await heartbeats.get(scope.workspaceId, scope.principalId)).toEqual(saved);
  });

  it("reads a heartbeat saved before signal sources could be turned off as having none off", async () => {
    const store = opened();
    const heartbeats = store.asPort().repositories.heartbeats;
    await heartbeats.save({ ...scope, config: enabled(), expectedRevision: 0, author: "test", now: AT });
    store.handle.prepare("UPDATE tavi_heartbeats SET config_json = json_remove(config_json, '$.disabledSources')").run();
    expect((await heartbeats.get(scope.workspaceId, scope.principalId))?.config.disabledSources).toEqual([]);
  });

  it("keeps enabled, the pause and the revision out of the stored JSON", async () => {
    const store = opened();
    const heartbeats = store.asPort().repositories.heartbeats;
    await heartbeats.save({ ...scope, config: enabled({ paused: { reason: "user" } }), expectedRevision: 0, author: "operator", now: AT });
    const row = store.handle.prepare("SELECT config_json, enabled, paused_reason, revision FROM tavi_heartbeats").get() as {
      config_json: string;
      enabled: number;
      paused_reason: string;
      revision: number;
    };
    const stored = JSON.parse(row.config_json) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("enabled");
    expect(stored).not.toHaveProperty("paused");
    expect(stored).not.toHaveProperty("revision");
    expect([row.enabled, row.paused_reason, row.revision]).toEqual([1, "user", 1]);
  });

  it("names a row that no longer parses, with the revision a save needs to replace it", async () => {
    const store = opened();
    const heartbeats = store.asPort().repositories.heartbeats;
    await heartbeats.save({ ...scope, config: enabled(), expectedRevision: 0, nextTickAt: AT, author: "operator", now: AT });
    store.handle.prepare("UPDATE tavi_heartbeats SET config_json = '{\"everyMs\":-1}'").run();
    expect(await heartbeats.listDue(LATER, 10)).toEqual({ due: [], unreadable: ["default/operator"] });
    await expect(async () => heartbeats.get(scope.workspaceId, scope.principalId)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { revision: 1 },
    });
    const replaced = await heartbeats.save({ ...scope, config: enabled(), expectedRevision: 1, author: "operator", now: LATER });
    expect(replaced.config.revision).toBe(2);
  });

  it("refuses a stale revision, and records the instructions only when they change", async () => {
    const heartbeats = repositories();
    await heartbeats.save({ ...scope, config: enabled({ instructions: "one" }), expectedRevision: 0, author: "operator", now: AT });
    await heartbeats.save({
      ...scope,
      config: enabled({ instructions: "one", tellMe: "digest-only" }),
      expectedRevision: 1,
      author: "operator",
      now: AT,
    });
    await heartbeats.save({ ...scope, config: enabled({ instructions: "two" }), expectedRevision: 2, author: "chat", now: LATER });
    await expect(async () =>
      heartbeats.save({ ...scope, config: enabled(), expectedRevision: 2, author: "operator", now: LATER }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const history = await heartbeats.instructionsHistory({ ...scope, limit: 10 });
    expect(history.map((entry) => [entry.revision, entry.text, entry.author])).toEqual([
      [3, "two", "chat"],
      [1, "one", "operator"],
    ]);
  });

  it("refuses a config outside its bounds", async () => {
    const heartbeats = repositories();
    await expect(async () =>
      heartbeats.save({
        ...scope,
        config: enabled({ activeHours: { start: "09:00", end: "09:00" } }),
        expectedRevision: 0,
        author: "operator",
        now: AT,
      }),
    ).rejects.toBeInstanceOf(TaviError);
  });

  it("lists only enabled heartbeats that are due, and names a row that no longer parses", async () => {
    const heartbeats = repositories();
    await heartbeats.save({ ...scope, config: enabled(), expectedRevision: 0, nextTickAt: AT, author: "operator", now: AT });
    await heartbeats.save({
      workspaceId: "default",
      principalId: "off",
      config: defaultHeartbeatConfig(),
      expectedRevision: 0,
      nextTickAt: AT,
      author: "operator",
      now: AT,
    });
    await heartbeats.save({
      workspaceId: "default",
      principalId: "later",
      config: enabled(),
      expectedRevision: 0,
      nextTickAt: "2026-10-10T09:00:00.000Z",
      author: "operator",
      now: AT,
    });
    const { due, unreadable } = await heartbeats.listDue(LATER, 10);
    expect(due.map((state) => state.principalId)).toEqual(["operator"]);
    expect(unreadable).toEqual([]);
  });

  it("lets exactly one of two owners' claims on one database win", async () => {
    const directory = directories.create("tavi-heartbeat-claim-");
    const databasePath = join(directory, "tavi.sqlite");
    const first = new SqliteStore({ databasePath });
    cleanup.push(() => first.close());
    const second = new SqliteStore({ databasePath });
    cleanup.push(() => second.close());
    const a = first.asPort().repositories.heartbeats;
    const b = second.asPort().repositories.heartbeats;
    await a.save({ ...scope, config: enabled(), expectedRevision: 0, nextTickAt: AT, author: "operator", now: AT });
    const claims = [
      await a.claimTick({ ...scope, expectedNextTickAt: AT, nextTickAt: LATER, now: AT }),
      await b.claimTick({ ...scope, expectedNextTickAt: AT, nextTickAt: LATER, now: AT }),
    ];
    expect(claims).toEqual([true, false]);
    expect((await b.get(scope.workspaceId, scope.principalId))?.nextTickAt).toBe(LATER);
  });

  it("pauses without bumping the revision, so a pending edit still saves", async () => {
    const heartbeats = repositories();
    await heartbeats.save({ ...scope, config: enabled(), expectedRevision: 0, author: "operator", now: AT });
    await heartbeats.setPaused({ ...scope, paused: { reason: "budget", until: LATER }, now: AT });
    const paused = await heartbeats.get(scope.workspaceId, scope.principalId);
    expect(paused?.config.paused).toEqual({ reason: "budget", until: LATER });
    expect(paused?.config.revision).toBe(1);
    const edited = await heartbeats.save({
      ...scope,
      config: enabled({ maxNowPerHour: 2 }),
      expectedRevision: 1,
      author: "operator",
      now: LATER,
    });
    expect(edited.config.paused).toEqual({ reason: "budget", until: LATER });
    await heartbeats.setPaused({ ...scope, paused: null, now: LATER });
    expect((await heartbeats.get(scope.workspaceId, scope.principalId))?.config.paused).toBeUndefined();
    // An expired pause is cleared only while it is still the stored one.
    await heartbeats.setPaused({ ...scope, paused: { reason: "user" }, now: LATER });
    expect(await heartbeats.clearPause({ ...scope, paused: { reason: "budget", until: LATER }, now: LATER })).toBe(false);
    expect((await heartbeats.get(scope.workspaceId, scope.principalId))?.config.paused).toEqual({ reason: "user" });
    expect(await heartbeats.clearPause({ ...scope, paused: { reason: "user" }, now: LATER })).toBe(true);
    expect((await heartbeats.get(scope.workspaceId, scope.principalId))?.config.paused).toBeUndefined();
  });

  it("records ticks, advancing the last and last deep tick, and lists them newest first", async () => {
    const heartbeats = repositories();
    await heartbeats.save({ ...scope, config: enabled(), expectedRevision: 0, author: "operator", now: AT });
    await heartbeats.recordTick(tick());
    await heartbeats.recordTick(
      tick({
        tickId: "tick-2",
        kind: null,
        wakeReason: "interval",
        outcome: "skipped",
        reason: "nothing-new",
        taskId: null,
        tokens: 0,
        cacheReadTokens: 0,
        inputs: null,
        now: "2026-10-10T09:00:00.000Z",
        advancesLastTick: false,
      }),
    );
    const state = await heartbeats.get(scope.workspaceId, scope.principalId);
    expect(state?.lastTickAt).toBe(LATER);
    expect(state?.lastDeepTickAt).toBe(LATER);
    const ticks = await heartbeats.listTicks({ ...scope, limit: 10 });
    expect(ticks.map((row) => row.tickId)).toEqual(["tick-2", "tick-1"]);
    expect(ticks[1]?.inputs).toEqual({ instructionsRevision: 1, signalKeys: [], memory: [{ recordId: "m1", revision: 2 }] });
    expect(await heartbeats.listTicks({ ...scope, since: "2026-10-10T08:45:00.000Z", limit: 10 })).toHaveLength(1);
    // Oldest first: the check that told an item at or after an instant.
    expect((await heartbeats.listTicks({ ...scope, oldestFirst: true, limit: 1 })).map((row) => row.tickId)).toEqual(["tick-1"]);
    expect((await heartbeats.listTicks({ ...scope, oldestFirst: true, limit: 10 })).map((row) => row.tickId)).toEqual(["tick-1", "tick-2"]);
    // A deep look that failed is not the deep look: it stays due.
    await heartbeats.recordTick(tick({ tickId: "tick-3", outcome: "failed", reason: "timeout", now: "2026-10-10T10:00:00.000Z" }));
    expect((await heartbeats.get(scope.workspaceId, scope.principalId))?.lastDeepTickAt).toBe(LATER);
  });

  it("leaves a record row that no longer parses out of the log, and shows the rest", async () => {
    const store = opened();
    const heartbeats = store.asPort().repositories.heartbeats;
    await heartbeats.save({ ...scope, config: enabled(), expectedRevision: 0, author: "operator", now: AT });
    await heartbeats.recordTick(tick());
    await heartbeats.recordTick(tick({ tickId: "tick-2", now: "2026-10-10T09:00:00.000Z" }));
    store.handle.prepare("UPDATE tavi_heartbeat_ticks SET tokens = -5 WHERE tick_id = 'tick-2'").run();
    expect((await heartbeats.listTicks({ ...scope, limit: 10 })).map((row) => row.tickId)).toEqual(["tick-1"]);
  });

  it("keeps the memo bounded, and dismisses the first-run offer for good, creating the row off", async () => {
    const heartbeats = repositories();
    await heartbeats.dismissOffer({ ...scope, now: AT });
    await heartbeats.dismissOffer({ ...scope, now: LATER });
    const state = await heartbeats.get(scope.workspaceId, scope.principalId);
    expect(state?.offerDismissedAt).toBe(AT);
    expect(state?.config.enabled).toBe(false);
    await heartbeats.setMemo({ ...scope, memo: "checked 3", now: AT });
    expect((await heartbeats.get(scope.workspaceId, scope.principalId))?.memo).toBe("checked 3");
    await expect(async () => heartbeats.setMemo({ ...scope, memo: "x".repeat(5000), now: AT })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(async () =>
      heartbeats.setMemo({ workspaceId: "default", principalId: "nobody", memo: "m", now: AT }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(async () =>
      heartbeats.setNextTick({ workspaceId: "default", principalId: "nobody", nextTickAt: AT, now: AT }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("clears the memo and marks when the provider changed, and only then", async () => {
    const heartbeats = repositories();
    const saved = await heartbeats.save({ ...scope, config: defaultHeartbeatConfig(), expectedRevision: 0, author: "test", now: AT });
    await heartbeats.setMemo({ ...scope, memo: "checked 3", now: AT });
    const tuned = await heartbeats.save({
      ...scope,
      config: { ...saved.config, everyMs: 3_600_000 },
      expectedRevision: 1,
      author: "test",
      now: LATER,
    });
    expect(tuned).toMatchObject({ memo: "checked 3" });
    expect(tuned.providerSince).toBeUndefined();
    const switched = await heartbeats.save({
      ...scope,
      config: { ...tuned.config, providerId: "acme.heartbeat" },
      expectedRevision: 2,
      author: "test",
      now: LATER,
    });
    expect(switched.memo).toBeUndefined();
    expect(switched.providerSince).toBe(LATER);
  });
});

describe("what a heartbeat spent", () => {
  it("counts model ticks since an instant and sums every heartbeat turn's tokens and dollars; unknown when any was unpriced", async () => {
    const store = opened();
    const heartbeats = store.asPort().repositories.heartbeats;
    await heartbeats.save({ ...scope, config: enabled(), expectedRevision: 0, author: "operator", now: AT });
    await heartbeats.recordTick(tick({ tickId: "t1", taskId: "run-1" }));
    await heartbeats.recordTick(
      tick({ tickId: "t2", taskId: null, kind: null, outcome: "skipped", reason: "nothing-new", advancesLastTick: false }),
    );
    // A tick that ran past its time counts as a model tick, though it names no task.
    await heartbeats.recordTick(tick({ tickId: "t3", taskId: null, outcome: "failed", reason: "timeout" }));
    // Each turn is a heartbeat task: a tick's second turn (run-2) counts as well as its first; a chat's run does not.
    const task = store.handle.prepare(
      "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at,origin) VALUES(?,?,?,?,'','completed',?,?,?)",
    );
    task.run("run-1", scope.workspaceId, scope.principalId, "th-1", LATER, LATER, "heartbeat");
    task.run("run-2", scope.workspaceId, scope.principalId, "th-2", LATER, LATER, "heartbeat");
    task.run("other-run", scope.workspaceId, scope.principalId, "th-3", LATER, LATER, null);
    const attempt = store.handle.prepare(
      "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, data) VALUES (?, ?, ?, 's', 'completed', ?, ?)",
    );
    attempt.run("c1", "run-1", "a1", LATER, JSON.stringify({ usage: { inputTokens: 900, outputTokens: 100 }, estimatedUsd: 0.01 }));
    attempt.run("c2", "run-2", "a2", LATER, JSON.stringify({ usage: { totalTokens: 500 }, estimatedUsd: 0.02 }));
    attempt.run("c3", "other-run", "a3", LATER, JSON.stringify({ usage: { totalTokens: 99_999 }, estimatedUsd: 9 }));
    const usage = await heartbeats.usageSince({ ...scope, since: AT });
    expect(usage.modelTicks).toBe(2);
    // A check whose provider stopped in it may have run a turn: it counts as a model check.
    await heartbeats.recordTick(tick({ tickId: "tick-stopped", taskId: null, outcome: "failed", reason: "provider-stopped", now: LATER }));
    expect((await heartbeats.usageSince({ ...scope, since: AT })).modelTicks).toBe(3);
    expect(usage.tokens).toBe(1_500);
    expect(usage.usd).toBeCloseTo(0.03);
    attempt.run("c4", "run-1", "a4", LATER, JSON.stringify({ usage: { totalTokens: 10 } }));
    expect((await heartbeats.usageSince({ ...scope, since: AT })).usd).toBeNull();
    // What the priced calls cost is still known, for the dollar limit.
    expect((await heartbeats.usageSince({ ...scope, since: AT })).pricedUsd).toBeCloseTo(0.03);
    expect(await heartbeats.usageSince({ ...scope, since: "2026-10-11T00:00:00.000Z" })).toEqual({
      modelTicks: 0,
      tokens: 0,
      usd: 0,
      pricedUsd: 0,
    });
  });
});

describe("the signals seen", () => {
  it("seeds the first collection silently, then names what is new, changed and gone, and counts a return as new", async () => {
    const heartbeats = repositories();
    const at = (signals: { key: string; hash: string }[], now: string) =>
      heartbeats.observeSignals({ ...scope, now, signals: signals.map((signal) => ({ ...signal, source: "test" })) });
    expect(
      await at(
        [
          { key: "a", hash: "1" },
          { key: "b", hash: "1" },
        ],
        AT,
      ),
    ).toEqual({ seeded: true, fresh: [], gone: [] });
    expect(
      await at(
        [
          { key: "a", hash: "1" },
          { key: "b", hash: "2" },
          { key: "c", hash: "1" },
        ],
        LATER,
      ),
    ).toEqual({ seeded: false, fresh: ["b", "c"], gone: [] });
    expect(await at([{ key: "a", hash: "1" }], LATER)).toEqual({ seeded: false, fresh: [], gone: ["b", "c"] });
    expect(
      await at(
        [
          { key: "a", hash: "1" },
          { key: "b", hash: "2" },
        ],
        LATER,
      ),
    ).toEqual({ seeded: false, fresh: ["b"], gone: [] });
  });

  it("seeds a source on its own first collection, and lets only a source collected now say a key is gone", async () => {
    const heartbeats = repositories();
    const observe = (signals: { key: string; hash: string }[], sources: string[], now = LATER) =>
      heartbeats.observeSignals({ ...scope, now, signals: signals.map((signal) => ({ ...signal, source: "test" })), sources });
    await observe([{ key: "needs:a", hash: "1" }], ["needs"]);
    // A plugin source installed later: what it already holds is seeded, not new.
    expect(
      await observe(
        [
          { key: "needs:a", hash: "1" },
          { key: "acme.q:job-1", hash: "1" },
        ],
        ["needs", "acme.q"],
      ),
    ).toEqual({ seeded: false, fresh: [], gone: [] });
    expect(
      await observe(
        [
          { key: "needs:a", hash: "1" },
          { key: "acme.q:job-1", hash: "1" },
          { key: "acme.q:job-2", hash: "1" },
        ],
        ["needs", "acme.q"],
      ),
    ).toMatchObject({ fresh: ["acme.q:job-2"] });
    // The plugin restarting (not installed for a moment): its keys stay seen.
    expect(await observe([{ key: "needs:a", hash: "1" }], ["needs"])).toMatchObject({ gone: [] });
    expect(
      await observe(
        [
          { key: "needs:a", hash: "1" },
          { key: "acme.q:job-1", hash: "1" },
          { key: "acme.q:job-2", hash: "1" },
        ],
        ["needs", "acme.q"],
      ),
    ).toMatchObject({ fresh: [], gone: [] });
  });

  it("seeds a source again after a month unseen, so a heartbeat back from a long rest does not flood", async () => {
    const heartbeats = repositories();
    const observe = (signals: { key: string; hash: string }[], now: string) =>
      heartbeats.observeSignals({ ...scope, now, signals: signals.map((signal) => ({ ...signal, source: "test" })), sources: ["needs"] });
    await observe([{ key: "needs:a", hash: "1" }], "2026-08-01T00:00:00.000Z");
    await heartbeats.sweep({ olderThan: "2026-09-10T00:00:00.000Z" });
    expect(
      await observe(
        [
          { key: "needs:a", hash: "1" },
          { key: "needs:b", hash: "1" },
        ],
        LATER,
      ),
    ).toMatchObject({ fresh: [], gone: [] });
  });

  it("does not seed a source that saw only part and found nothing, so its first real answer is seeded", async () => {
    const heartbeats = repositories();
    const observe = (signals: { key: string; hash: string }[], keep: string[]) =>
      heartbeats.observeSignals({
        ...scope,
        now: LATER,
        signals: signals.map((signal) => ({ ...signal, source: "test" })),
        sources: ["needs", "pages"],
        keep,
      });
    await observe([], ["pages:"]);
    // The page's first reading arrives: seeded, not told as new.
    expect(await observe([{ key: "pages:page-1", hash: "h1" }], [])).toMatchObject({ fresh: [] });
    expect(await observe([{ key: "pages:page-1", hash: "h2" }], [])).toMatchObject({ fresh: ["pages:page-1"] });
  });

  it("forgets keys a failed check was given, so the next one finds them new", async () => {
    const heartbeats = repositories();
    const observe = (signals: { key: string; hash: string }[]) =>
      heartbeats.observeSignals({
        ...scope,
        now: LATER,
        signals: signals.map((signal) => ({ ...signal, source: "test" })),
        sources: ["needs"],
      });
    await observe([]);
    expect(await observe([{ key: "needs:a", hash: "1" }])).toMatchObject({ fresh: ["needs:a"] });
    await heartbeats.unseeSignals({ ...scope, keys: ["needs:a"] });
    expect(await observe([{ key: "needs:a", hash: "1" }])).toMatchObject({ fresh: ["needs:a"], gone: [] });
    // Unseen and then gone before a check looked: still reported gone, so what rests on it resolves.
    await heartbeats.unseeSignals({ ...scope, keys: ["needs:a"] });
    expect(await observe([])).toMatchObject({ gone: ["needs:a"] });
  });

  it("keeps what a failing source saw before: its keys are never gone, and its return is not new", async () => {
    const heartbeats = repositories();
    const observe = (signals: { key: string; hash: string }[], keep?: string[]) =>
      heartbeats.observeSignals({
        ...scope,
        now: LATER,
        signals: signals.map((signal) => ({ ...signal, source: "test" })),
        ...(keep === undefined ? {} : { keep }),
      });
    await observe([
      { key: "needs:a", hash: "1" },
      { key: "held:b", hash: "1" },
    ]);
    expect(await observe([{ key: "needs:a", hash: "1" }], ["held:"])).toEqual({ seeded: false, fresh: [], gone: [] });
    expect(
      await observe([
        { key: "needs:a", hash: "1" },
        { key: "held:b", hash: "1" },
      ]),
    ).toEqual({ seeded: false, fresh: [], gone: [] });
  });

  it("seeds once even for a heartbeat that has seen no signal yet", async () => {
    const heartbeats = repositories();
    expect((await heartbeats.observeSignals({ ...scope, now: AT, signals: [] })).seeded).toBe(true);
    expect(await heartbeats.observeSignals({ ...scope, now: LATER, signals: [{ key: "a", hash: "1", source: "test" }] })).toEqual({
      seeded: false,
      fresh: ["a"],
      gone: [],
    });
  });
});

describe("a heartbeat notice", () => {
  it("carries the item it shows", async () => {
    const store = new SqliteStore({ databasePath: ":memory:", inMemory: true });
    cleanup.push(() => store.close());
    const { tasks, transcripts } = store.asPort().repositories;
    await tasks.admit({
      workspaceId: "default",
      principalId: "operator",
      operationKey: "op-home",
      kind: "start",
      intent: { prompt: "hi" },
      checkpointNamespace: "",
      newTaskId: () => "home",
      newAdmissionId: () => "adm",
      newThreadId: () => "thread",
      now: () => AT,
    });
    const { notice } = await transcripts.postNotice({
      noticeId: "n1",
      taskId: "home",
      kind: "heartbeat",
      sourceKey: "heartbeat:item-1",
      heartbeatItemId: "item-1",
      title: "ACME payment failed",
      summary: "stripe",
      createdAt: AT,
    });
    expect(notice.heartbeatItemId).toBe("item-1");
    expect((await transcripts.getNotice("n1"))?.kind).toBe("heartbeat");
  });
});

describe("the item ledger", () => {
  const told = (key: string, extra: Partial<TellHeartbeatItem["item"]> = {}, heldBack = false): TellHeartbeatItem => ({
    itemId: `hbi-${key}`,
    hash: `h-${key}`,
    heldBack,
    buttonToken: "abcdefghijklmnop",
    item: {
      key,
      urgency: "now",
      title: `Item ${key}`,
      body: "the body",
      sources: [{ label: "Billing", ref: "test:a" }],
      signalKeys: ["test:a"],
      ...extra,
    },
  });

  it("records an item a mod held back as filtered, outside the hour's count, and tells it again later as told", async () => {
    const heartbeats = repositories();
    await heartbeats.save({ ...scope, config: enabled(), expectedRevision: 0, author: "test", now: AT });
    const [held] = await heartbeats.tellItems({ ...scope, items: [{ ...told("a"), filtered: true }], now: AT });
    expect(held).toMatchObject({ key: "a", state: "filtered" });
    expect(await heartbeats.nowToldSince({ ...scope, since: AT })).toBe(0);
    const [again] = await heartbeats.tellItems({ ...scope, items: [told("a")], now: LATER });
    expect(again).toMatchObject({ key: "a", state: "told", itemId: held?.itemId });
  });

  it("leaves a key muted, or snoozed and not yet out of it, as it is: nothing of it is told", async () => {
    const heartbeats = repositories();
    await heartbeats.tellItems({ ...scope, items: [told("a"), told("b")], now: AT });
    await heartbeats.setItemState({ ...scope, itemId: "hbi-a", state: "muted", now: AT });
    await heartbeats.setItemState({ ...scope, itemId: "hbi-b", state: "snoozed", snoozedUntil: "2026-10-12T00:00:00.000Z", now: AT });
    expect(
      await heartbeats.tellItems({
        ...scope,
        items: [
          { ...told("a"), hash: "h-a2" },
          { ...told("b"), hash: "h-b2" },
        ],
        now: LATER,
      }),
    ).toEqual([]);
    expect(
      (await heartbeats.ledgerRows({ ...scope, keys: ["a", "b"] })).map((row) => `${row.key}:${row.state}:${row.hash}`).sort(),
    ).toEqual(["a:muted:h-a", "b:snoozed:h-b"]);
  });

  it("records a telling, keeps a key's id and first telling when told again, and counts the hour's now items", async () => {
    const heartbeats = repositories();
    const [first] = await heartbeats.tellItems({
      ...scope,
      items: [told("a"), told("b", { urgency: "later" }), told("c", {}, true)],
      now: AT,
    });
    expect(first).toMatchObject({
      itemId: "hbi-a",
      key: "a",
      state: "told",
      urgency: "now",
      body: "the body",
      sources: [{ label: "Billing", ref: "test:a" }],
      signalKeys: ["test:a"],
      firstToldAt: AT,
    });
    const [again] = await heartbeats.tellItems({ ...scope, items: [{ ...told("a"), itemId: "hbi-other", hash: "h-a2" }], now: LATER });
    expect(again).toMatchObject({ itemId: "hbi-a", hash: "h-a2", firstToldAt: AT, lastToldAt: LATER });
    // The held-back one and the later one are not now tellings.
    expect(await heartbeats.nowToldSince({ ...scope, since: AT })).toBe(1);
    expect((await heartbeats.ledgerRows({ ...scope, keys: ["a", "b", "zz"] })).map((row) => row.key).sort()).toEqual(["a", "b"]);
    expect(await heartbeats.ledgerRows({ workspaceId: "default", principalId: "someone-else", keys: ["a"] })).toEqual([]);
  });

  it("resolves an item only when its signals are all gone, and leaves it out of the digest", async () => {
    const heartbeats = repositories();
    await heartbeats.observeSignals({
      ...scope,
      signals: [
        { key: "test:a", hash: "1", source: "t" },
        { key: "test:b", hash: "1", source: "t" },
      ],
      now: AT,
    });
    await heartbeats.tellItems({
      ...scope,
      items: [
        told("one", { urgency: "later", signalKeys: ["test:a", "test:b"] }),
        told("two", { urgency: "later", signalKeys: ["test:a"] }),
      ],
      now: AT,
    });
    const { gone } = await heartbeats.observeSignals({ ...scope, signals: [{ key: "test:b", hash: "1", source: "t" }], now: LATER });
    expect(gone).toEqual(["test:a"]);
    const resolved = await heartbeats.resolveItems({ ...scope, goneSignalKeys: gone, now: LATER });
    expect(resolved.map((row) => [row.key, row.state])).toEqual([["two", "resolved"]]);
    expect((await heartbeats.digestItems({ ...scope, since: AT, limit: 10 })).map((row) => row.key)).toEqual(["one"]);
  });

  it("lists a later item in one digest, and none past its window", async () => {
    const heartbeats = repositories();
    await heartbeats.tellItems({ ...scope, items: [told("x", { urgency: "later" }), told("y")], now: AT });
    const listed = await heartbeats.digestItems({ ...scope, since: AT, limit: 10 });
    expect(listed.map((row) => row.key)).toEqual(["x"]);
    // A telling newer than the one listed is not marked: it waits for the next digest.
    await heartbeats.markDigested({ ...scope, items: [{ itemId: "hbi-x", lastToldAt: "2026-10-10T07:00:00.000Z" }], now: LATER });
    expect((await heartbeats.digestItems({ ...scope, since: AT, limit: 10 })).map((row) => row.key)).toEqual(["x"]);
    await heartbeats.markDigested({
      ...scope,
      items: listed.map((row) => ({ itemId: row.itemId, lastToldAt: row.lastToldAt })),
      now: LATER,
    });
    expect(await heartbeats.digestItems({ ...scope, since: AT, limit: 10 })).toEqual([]);
    expect(await heartbeats.digestItems({ ...scope, since: LATER, limit: 10 })).toEqual([]);
  });

  it("finds an item by its button token, and lists what was told lately, newest first", async () => {
    const heartbeats = repositories();
    await heartbeats.tellItems({ ...scope, items: [told("a")], now: AT });
    await heartbeats.tellItems({ ...scope, items: [{ ...told("b"), buttonToken: "qrstuvwxyzabcdef" }], now: LATER });
    expect((await heartbeats.itemByToken("qrstuvwxyzabcdef"))?.key).toBe("b");
    expect(await heartbeats.itemByToken("nope")).toBeUndefined();
    expect((await heartbeats.recentItems({ ...scope, limit: 10 })).map((row) => row.key)).toEqual(["b", "a"]);
    expect((await heartbeats.recentItems({ ...scope, since: LATER, limit: 10 })).map((row) => row.key)).toEqual(["b"]);
    expect(await heartbeats.recentItems({ workspaceId: "default", principalId: "someone-else", limit: 10 })).toEqual([]);
    expect(await heartbeats.setItemFeedback({ ...scope, itemId: "hbi-a", feedback: "down", now: LATER })).toMatchObject({
      feedback: "down",
    });
    expect((await heartbeats.setItemFeedback({ ...scope, itemId: "hbi-a", feedback: null, now: LATER }))?.feedback).toBeUndefined();
  });

  it("mutes and snoozes one item of this heartbeat only, a snooze naming when it ends", async () => {
    const heartbeats = repositories();
    await heartbeats.tellItems({ ...scope, items: [told("a")], now: AT });
    expect(await heartbeats.setItemState({ ...scope, itemId: "hbi-a", state: "snoozed", snoozedUntil: LATER, now: AT })).toMatchObject({
      state: "snoozed",
      snoozedUntil: LATER,
    });
    expect(await heartbeats.setItemState({ ...scope, itemId: "hbi-a", state: "muted", now: AT })).toMatchObject({ state: "muted" });
    expect((await heartbeats.ledgerRow({ ...scope, itemId: "hbi-a" }))?.snoozedUntil).toBeUndefined();
    expect(
      await heartbeats.setItemState({ workspaceId: "default", principalId: "someone-else", itemId: "hbi-a", state: "muted", now: AT }),
    ).toBeUndefined();
    await expect(async () => heartbeats.setItemState({ ...scope, itemId: "hbi-a", state: "snoozed", now: AT })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("retention and Forget heartbeat history", () => {
  const OLD = "2026-08-01T08:00:00.000Z";

  /** A store with one heartbeat's history from long ago and from now, its tasks' attempts and hook rows, and a chat task beside them. */
  async function history() {
    const store = opened();
    const heartbeats = store.asPort().repositories.heartbeats;
    await heartbeats.save({ ...scope, config: enabled(), expectedRevision: 0, author: "operator", now: OLD });
    await heartbeats.setMemo({ ...scope, memo: "watching 1042", now: OLD });
    const task = store.handle.prepare(
      "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at,origin) VALUES(?,?,?,?,'',?,?,?,?)",
    );
    task.run("hb-old", scope.workspaceId, scope.principalId, "th-hb-old", "completed", OLD, OLD, "heartbeat");
    task.run("hb-new", scope.workspaceId, scope.principalId, "th-hb-new", "completed", LATER, LATER, "heartbeat");
    task.run("hb-running", scope.workspaceId, scope.principalId, "th-hb-running", "running", OLD, OLD, "heartbeat");
    task.run("chat-old", scope.workspaceId, scope.principalId, "th-chat-old", "completed", OLD, OLD, null);
    const attempt = store.handle.prepare(
      "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, data) VALUES (?, ?, ?, 's', 'completed', ?, '{}')",
    );
    for (const runId of ["hb-old", "hb-new", "chat-old"]) attempt.run(`c-${runId}`, runId, `a-${runId}`, OLD);
    // What hangs off a task without a cascade: its operations, its attempts' requests, and its checkpoints by thread.
    for (const runId of ["hb-old", "hb-new", "chat-old"]) {
      store.handle
        .prepare(
          "INSERT INTO tavi_provider_operations (run_id, attempt_id, owner_session, state, data) VALUES (?, ?, 's', 'completed', '{}')",
        )
        .run(runId, `a-${runId}`);
      store.handle
        .prepare("INSERT INTO tavi_provider_attempt_requests (call_id, run_id, started_at, request) VALUES (?, ?, ?, '{}')")
        .run(`c-${runId}`, runId, OLD);
    }
    store.handle.exec(
      "CREATE TABLE IF NOT EXISTS checkpoints (thread_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS writes (thread_id TEXT NOT NULL, idx INTEGER NOT NULL);",
    );
    for (const thread of ["th-hb-old", "th-hb-new", "th-chat-old"]) {
      store.handle.prepare("INSERT INTO checkpoints (thread_id, checkpoint_id) VALUES (?, 'cp')").run(thread);
      store.handle.prepare("INSERT INTO writes (thread_id, idx) VALUES (?, 0)").run(thread);
      store.handle
        .prepare("INSERT INTO tavi_checkpoint_blobs (thread_id, channel, version, type, blob) VALUES (?, 'messages', '1', 'json', '[]')")
        .run(thread);
    }
    const hook = store.handle.prepare(
      "INSERT INTO tavi_plugin_hook_events (plugin_id, kind, event, task_id, workspace_id, detail, created_at) VALUES ('acme.guard', 'decision', 'tool.check', ?, 'default', 'allow → deny', ?)",
    );
    for (const taskId of ["hb-old", "chat-old"]) hook.run(taskId, OLD);
    // A check that ran no turn files its hook rows under its own id.
    hook.run("heartbeat:t-old", OLD);
    hook.run("heartbeat:t-new", LATER);
    // The messages source's notes: one past the history kept, one recent.
    for (const [conversation, at] of [
      ["old", OLD],
      ["new", LATER],
    ] as const)
      await heartbeats.noteInbound({
        connectionId: "tg",
        conversationKey: conversation,
        workspaceId: scope.workspaceId,
        senderPrincipalId: "bob",
        providerEventId: `evt-${conversation}`,
        at,
      });
    await heartbeats.recordTick(tick({ tickId: "t-old", taskId: "hb-old", now: OLD }));
    await heartbeats.recordTick(tick({ tickId: "t-new", taskId: "hb-new", now: LATER }));
    const told = (key: string, urgency: "now" | "later", now: string) =>
      heartbeats.tellItems({
        ...scope,
        items: [
          {
            itemId: `hbi-${key}`,
            hash: "h",
            heldBack: false,
            buttonToken: "abcdefghijklmnop",
            item: { key, urgency, title: key, sources: [{ label: "x" }] },
          },
        ],
        now,
      });
    await told("old-later", "later", OLD);
    await told("old-now", "now", OLD);
    await told("old-muted", "later", OLD);
    await heartbeats.setItemState({ ...scope, itemId: "hbi-old-muted", state: "muted", now: OLD });
    await told("new-later", "later", LATER);
    await heartbeats.observeSignals({ ...scope, signals: [{ key: "test:old", hash: "1", source: "t" }], now: OLD });
    await heartbeats.observeSignals({
      ...scope,
      signals: [
        { key: "test:old", hash: "1", source: "t" },
        { key: "test:new", hash: "1", source: "t" },
      ],
      now: LATER,
    });
    store.handle.prepare("UPDATE tavi_heartbeat_signals SET last_seen_at = ? WHERE signal_key = 'test:old'").run(OLD);
    const ids = (sql: string) => (store.handle.prepare(sql).all() as { id: string }[]).map((row) => row.id).sort();
    return { store, heartbeats, ids };
  }

  it("sweeps what is past 30 days across heartbeats, keeping muted rows, unsettled tasks and everything else's", async () => {
    const { heartbeats, ids } = await history();
    // Every old item but the muted one: an item whose signals are swept could never resolve.
    expect(await heartbeats.sweep({ olderThan: "2026-09-10T00:00:00.000Z" })).toEqual({ ticks: 1, items: 2, signals: 1, tasks: 1 });
    expect(ids("SELECT task_id AS id FROM tavi_tasks")).toEqual(["chat-old", "hb-new", "hb-running"]);
    expect(ids("SELECT run_id AS id FROM tavi_provider_attempts")).toEqual(["chat-old", "hb-new"]);
    expect(ids("SELECT run_id AS id FROM tavi_provider_operations")).toEqual(["chat-old", "hb-new"]);
    expect(ids("SELECT run_id AS id FROM tavi_provider_attempt_requests")).toEqual(["chat-old", "hb-new"]);
    expect(ids("SELECT thread_id AS id FROM checkpoints")).toEqual(["th-chat-old", "th-hb-new"]);
    expect(ids("SELECT thread_id AS id FROM writes")).toEqual(["th-chat-old", "th-hb-new"]);
    expect(ids("SELECT thread_id AS id FROM tavi_checkpoint_blobs")).toEqual(["th-chat-old", "th-hb-new"]);
    expect(ids("SELECT task_id AS id FROM tavi_plugin_hook_events")).toEqual(["chat-old", "heartbeat:t-new"]);
    expect(ids("SELECT plugin_id AS id FROM tavi_plugin_hook_prunes")).toEqual(["acme.guard"]);
    expect(ids("SELECT conversation_key AS id FROM tavi_messaging_inbound_activity")).toEqual(["new"]);
    expect(ids("SELECT tick_id AS id FROM tavi_heartbeat_ticks")).toEqual(["t-new"]);
    expect(ids("SELECT item_key AS id FROM tavi_heartbeat_items")).toEqual(["new-later", "old-muted"]);
    expect(ids("SELECT signal_key AS id FROM tavi_heartbeat_signals")).toEqual(["test:new", "~seeded"]);
  });

  it("forgets one heartbeat's ledger, log, seen signals, memo, settled tasks and their hook rows, and keeps its settings", async () => {
    const { heartbeats, ids } = await history();
    // Its muted item stays: a "Don't tell me" outlives the history.
    expect(await heartbeats.forget({ ...scope, now: LATER })).toEqual({ ticks: 2, items: 3, signals: 3, tasks: 2 });
    expect(ids("SELECT item_key AS id FROM tavi_heartbeat_items")).toEqual(["old-muted"]);
    expect(ids("SELECT task_id AS id FROM tavi_tasks")).toEqual(["chat-old", "hb-running"]);
    expect(ids("SELECT run_id AS id FROM tavi_provider_attempts")).toEqual(["chat-old"]);
    expect(ids("SELECT task_id AS id FROM tavi_plugin_hook_events")).toEqual(["chat-old"]);
    const state = await heartbeats.get(scope.workspaceId, scope.principalId);
    expect(state?.memo).toBeUndefined();
    expect(state?.config.enabled).toBe(true);
    expect(ids("SELECT signal_key AS id FROM tavi_heartbeat_signals")).toEqual([]);
    expect(ids("SELECT conversation_key AS id FROM tavi_messaging_inbound_activity")).toEqual([]);
  });

  it("keeps what the forgotten checks spent today, so the day's budget stands", async () => {
    const { store, heartbeats } = await history();
    store.handle
      .prepare("UPDATE tavi_provider_attempts SET data = ? WHERE run_id = 'hb-new'")
      .run(JSON.stringify({ usage: { totalTokens: 700 }, estimatedUsd: 0.05 }));
    const before = await heartbeats.usageSince({ ...scope, since: LATER });
    expect(before).toMatchObject({ modelTicks: 1, tokens: 700 });
    await heartbeats.forget({ ...scope, now: LATER, keepUsageSince: LATER });
    expect(await heartbeats.usageSince({ ...scope, since: LATER })).toEqual(before);
    // A second Forget the same day keeps both, and one without a day to keep clears the total.
    await heartbeats.forget({ ...scope, now: LATER, keepUsageSince: LATER });
    expect(await heartbeats.usageSince({ ...scope, since: LATER })).toEqual(before);
    // The next day starts from nothing.
    expect(await heartbeats.usageSince({ ...scope, since: "2026-10-11T00:00:00.000Z" })).toEqual({
      modelTicks: 0,
      tokens: 0,
      usd: 0,
      pricedUsd: 0,
    });
    await heartbeats.forget({ ...scope, now: LATER });
    expect(await heartbeats.usageSince({ ...scope, since: LATER })).toMatchObject({ modelTicks: 0, tokens: 0 });
  });

  it("does not count twice what a turn still running spent, nor take others' notes of who messaged when", async () => {
    const { store, heartbeats, ids } = await history();
    store.handle
      .prepare(
        "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, data) VALUES ('c-run', 'hb-running', 'a-run', 's', 'completed', ?, ?)",
      )
      .run(LATER, JSON.stringify({ usage: { totalTokens: 300 } }));
    store.handle.prepare("UPDATE tavi_tasks SET created_at = ? WHERE task_id = 'hb-running'").run(LATER);
    await heartbeats.save({
      workspaceId: scope.workspaceId,
      principalId: "bob",
      config: enabled(),
      expectedRevision: 0,
      author: "bob",
      now: LATER,
    });
    const before = await heartbeats.usageSince({ ...scope, since: LATER });
    await heartbeats.forget({ ...scope, now: LATER, keepUsageSince: LATER });
    expect((await heartbeats.usageSince({ ...scope, since: LATER })).tokens).toBe(before.tokens);
    // Bob's heartbeat still reads the workspace's notes.
    expect(ids("SELECT conversation_key AS id FROM tavi_messaging_inbound_activity")).toEqual(["new", "old"]);
  });
});

describe("reads for the unanswered-messages signals", () => {
  const T = "2026-10-10T08:00:00.000Z";
  const after = (minutes: number) => new Date(Date.parse(T) + minutes * 60_000).toISOString();

  it("finds a conversation's message from someone else that nobody answered, and not one answered by a turn, a reply or a mod's drop", async () => {
    const store = opened();
    const heartbeats = store.asPort().repositories.heartbeats;
    const task = store.handle.prepare(
      "INSERT INTO tavi_tasks(task_id,workspace_id,principal_id,thread_id,checkpoint_namespace,status,created_at,updated_at,origin) VALUES(?,?,?,?,'','completed',?,?,?)",
    );
    for (const id of ["chat-a", "chat-b", "chat-c", "chat-d", "chat-e", "chat-old"])
      task.run(id, scope.workspaceId, "bob", `th-${id}`, T, T, "messaging");
    const channel = store.handle.prepare(
      "INSERT INTO tavi_messaging_connections (connection_id, provider_id, workspace_id, label, account_identity, settings_json, credential_refs_json, enabled, config_revision, auth_state, created_at, updated_at, deleted_at) VALUES (?, 'telegram', ?, NULL, 'bot', '{}', '{}', 1, 1, 'connected', ?, ?, ?)",
    );
    channel.run("tg", scope.workspaceId, T, T, null);
    channel.run("gone", scope.workspaceId, T, T, T);
    const note = (conversation: string, taskId: string, sender = "bob") =>
      heartbeats.noteInbound({
        connectionId: "tg",
        conversationKey: conversation,
        workspaceId: scope.workspaceId,
        senderPrincipalId: sender,
        providerEventId: `evt-${conversation}`,
        taskId,
        at: T,
      });
    await note("a", "chat-a");
    await note("b", "chat-b");
    await note("c", "chat-c");
    await note("d", "chat-d");
    await note("e", "chat-e", "operator");
    // b: its chat saved a turn since; c: the inbound path replied to it; d: a mod dropped it.
    store.handle
      .prepare("INSERT INTO tavi_transcript_entries (task_id, seq, turn_json, created_at) VALUES (?, 1, '{}', ?)")
      .run("chat-b", after(1));
    store.handle
      .prepare(
        "INSERT INTO tavi_messaging_outbox (effect_id, connection_id, message_json, state, created_at) VALUES (?, 'tg', '{}', 'resolved', ?)",
      )
      .run("repeat-answer:tg:evt-c", after(1));
    store.handle
      .prepare(
        "INSERT INTO tavi_plugin_hook_events (plugin_id, kind, event, task_id, workspace_id, detail, created_at) VALUES ('acme.mod', 'decision', 'prompt.submit', 'chat-d', ?, 'dropped: spam', ?)",
      )
      .run(scope.workspaceId, after(1));
    // f: noted with no chat, a conversation reset once: only its active epoch's chat counts, once.
    const epoch = store.handle.prepare(
      "INSERT INTO tavi_messaging_conversation_tasks (connection_id, external_conversation_id, epoch, active, task_id, created_at) VALUES ('tg', 'f', ?, ?, ?, ?)",
    );
    epoch.run(0, 0, "chat-old", T);
    epoch.run(1, 1, "chat-a", T);
    await heartbeats.noteInbound({
      connectionId: "tg",
      conversationKey: "f",
      workspaceId: scope.workspaceId,
      senderPrincipalId: "bob",
      providerEventId: "evt-f",
      at: T,
    });
    // A deleted channel's conversation says nothing.
    await heartbeats.noteInbound({
      connectionId: "gone",
      conversationKey: "g",
      workspaceId: scope.workspaceId,
      senderPrincipalId: "bob",
      providerEventId: "evt-g",
      at: T,
    });
    const unanswered = await heartbeats.unansweredMessages({
      workspaceId: scope.workspaceId,
      principalId: "operator",
      since: after(-60),
      before: after(61),
      limit: 10,
    });
    expect(unanswered.map((row) => `${row.conversationKey}:${row.taskId ?? ""}`).sort()).toEqual(["a:chat-a", "f:chat-a"]);
    // Not yet waited long enough: none.
    expect(
      await heartbeats.unansweredMessages({
        workspaceId: scope.workspaceId,
        principalId: "operator",
        since: after(-60),
        before: after(-1),
        limit: 10,
      }),
    ).toEqual([]);
    // A newer message in the conversation takes its place.
    await heartbeats.noteInbound({
      connectionId: "tg",
      conversationKey: "a",
      workspaceId: scope.workspaceId,
      senderPrincipalId: "bob",
      providerEventId: "evt-a2",
      at: after(5),
    });
    // ...noted with no chat of its own: the conversation's own, never the earlier message's (a has none).
    expect(
      await heartbeats.unansweredMessages({
        workspaceId: scope.workspaceId,
        principalId: "operator",
        since: after(4),
        before: after(70),
        limit: 10,
      }),
    ).toEqual([{ connectionId: "tg", conversationKey: "a", providerEventId: "evt-a2", receivedAt: after(5) }]);
  });

  it("finds sends a channel reported bounced or failed, in this workspace only", async () => {
    const store = opened();
    const heartbeats = store.asPort().repositories.heartbeats;
    const connection = store.handle.prepare(
      "INSERT INTO tavi_messaging_connections (connection_id, provider_id, workspace_id, label, account_identity, settings_json, credential_refs_json, enabled, config_revision, auth_state, created_at, updated_at) VALUES (?, 'telegram', ?, NULL, 'bot', '{}', '{}', 1, 1, 'connected', ?, ?)",
    );
    connection.run("tg", scope.workspaceId, T, T);
    connection.run("other", "elsewhere", T, T);
    const delivery = store.handle.prepare(
      "INSERT INTO tavi_messaging_deliveries (connection_id, provider_message_id, effect_id, status, status_at) VALUES (?, ?, ?, ?, ?)",
    );
    delivery.run("tg", "m1", "e1", "bounced", after(1));
    delivery.run("tg", "m2", "e2", "delivered", after(2));
    delivery.run("other", "m3", "e3", "failed", after(3));
    expect(await heartbeats.failedSends({ workspaceId: scope.workspaceId, since: T, limit: 10 })).toEqual([
      { connectionId: "tg", providerMessageId: "m1", status: "bounced", statusAt: after(1) },
    ]);
  });

  it("finds a person's routine runs that failed", async () => {
    const store = opened();
    const heartbeats = store.asPort().repositories.heartbeats;
    store.handle
      .prepare(
        "INSERT INTO tavi_routines (routine_id, workspace_id, principal_id, name, version, active_revision, latest_revision, status, created_at, updated_at) VALUES ('r1', ?, 'operator', 'Morning brief', 1, 1, 1, 'active', ?, ?)",
      )
      .run(scope.workspaceId, T, T);
    const run = store.handle.prepare(
      "INSERT INTO tavi_routine_runs (run_id, routine_id, workspace_id, principal_id, occurrence_key, revision, snapshot_json, mode, status, claimed_at, ended_at, data_json) VALUES (?, 'r1', ?, ?, ?, 1, '{}', 'scheduled', ?, ?, ?, '{}')",
    );
    run.run("run-1", scope.workspaceId, "operator", "o1", "failed", T, after(1));
    run.run("run-2", scope.workspaceId, "operator", "o2", "succeeded", T, after(2));
    run.run("run-3", scope.workspaceId, "bob", "o3", "failed", T, after(3));
    expect(await heartbeats.failedRoutineRuns({ workspaceId: scope.workspaceId, principalId: "operator", since: T, limit: 10 })).toEqual([
      { runId: "run-1", routineId: "r1", name: "Morning brief", endedAt: after(1) },
    ]);
  });
});
