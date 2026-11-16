import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  HeartbeatSignalSchema,
  TaviError,
  defaultHeartbeatConfig,
  heartbeatSignalsOf,
  type AppAccountView,
  type AppHealth,
  type AppRepair,
  type ConnectableApp,
  type HeartbeatSignal,
  type HeartbeatSignalBatch,
  type HeartbeatState,
  type MemoryActor,
} from "@tavi/contracts";
import { describeSignalSourceConformance } from "@tavi/plugin-kit/heartbeat/conformance";
import { MemoryService } from "@tavi/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryDirectories, delay } from "@tavi/test-support";

import { SqliteStore } from "../support/database-fixture.js";
import { HeartbeatSignalRegistry } from "@tavi/agent-host/heartbeat-host";

import {
  appsSignalsSource,
  builtinHeartbeatSources,
  heartbeatMemoryContext,
  heartbeatOfferInstructions,
  managedChatFolders,
  storageSignalsSource,
  watchedPagesSource,
} from "../../src/features/heartbeat/sources.js";

const directories = temporaryDirectories();
afterEach(() => directories.cleanup());

/**
 * The heartbeat's built-in signal sources and memory context
 * over a real store.
 */

const AT = "2026-10-11T09:00:00.000Z";
/** A collection's signals, list or batch; undefined for a source that is not there. */
const listed = async (answer: Promise<readonly HeartbeatSignal[] | HeartbeatSignalBatch> | undefined) =>
  answer === undefined ? undefined : heartbeatSignalsOf(await answer);
const stores: SqliteStore[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
});

async function open() {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  return { store, repositories: store.asPort().repositories, memory: new MemoryService(store.asPort()) };
}

const actorOf = (principalId: string, workspaceId = "default"): MemoryActor => ({
  workspaceId,
  principalId,
  caller: "test",
  authority: "operator",
});

function state(principalId = "alice", instructions = "Watch ACME invoices and payments"): HeartbeatState {
  return {
    workspaceId: "default",
    principalId,
    config: { ...defaultHeartbeatConfig(), enabled: true, instructions },
    createdAt: AT,
    updatedAt: AT,
  };
}

describe("the heartbeat's memory context", () => {
  it("holds the person's accepted preferences and relevant records, and nobody else's", async () => {
    const { memory } = await open();
    const alice = actorOf("alice");
    const preference = await memory.remember({
      actor: alice,
      scope: { kind: "personal", principalId: "alice" },
      kind: "preference",
      body: "Don't message me about stripe test invoices",
      preferenceKey: "quiet_topics",
      preference: { valueType: "string", value: "stripe test invoices" },
    });
    const fact = await memory.remember({
      actor: alice,
      scope: { kind: "personal_workspace", principalId: "alice", workspaceId: "default" },
      kind: "fact",
      body: "ACME is our biggest client and pays invoices late",
    });
    // Excluded: another person's, another workspace's, a run-local note, a pending proposal.
    await memory.remember({
      actor: actorOf("bob"),
      scope: { kind: "personal", principalId: "bob" },
      kind: "fact",
      body: "ACME invoices belong to Bob",
    });
    await memory.remember({
      actor: actorOf("alice", "other"),
      scope: { kind: "personal_workspace", principalId: "alice", workspaceId: "other" },
      kind: "fact",
      body: "ACME invoices in the other workspace",
    });
    await memory.remember({
      actor: { ...alice, runId: "task-1" },
      scope: { kind: "run_local", principalId: "alice", workspaceId: "default", runId: "task-1" },
      kind: "fact",
      body: "ACME invoices noted in one chat only",
    });
    await memory.propose({
      actor: { ...alice, authority: "model" },
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      body: "ACME invoices proposal nobody approved",
    });

    const context = await heartbeatMemoryContext(memory, state(), { kind: "deep", signals: [] });
    expect(context.map((record) => record.recordId).sort()).toEqual([preference.recordId, fact.recordId].sort());
    expect(context.find((record) => record.recordId === preference.recordId)).toMatchObject({
      kind: "preference",
      text: "quiet_topics: stripe test invoices",
    });
    for (const record of context) expect(record.revisionId).toBeTruthy();
  });

  it("reads an edited record at its new revision", async () => {
    const { memory } = await open();
    const alice = actorOf("alice");
    const fact = await memory.remember({
      actor: alice,
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      body: "ACME pays invoices on the first",
    });
    const before = (await heartbeatMemoryContext(memory, state(), { kind: "deep", signals: [] })).find(
      (record) => record.recordId === fact.recordId,
    );
    await memory.correct({ actor: alice, recordId: fact.recordId, body: "ACME pays invoices on the fifteenth" });
    const after = (await heartbeatMemoryContext(memory, state(), { kind: "deep", signals: [] })).find(
      (record) => record.recordId === fact.recordId,
    );
    expect(after?.revisionId).not.toBe(before?.revisionId);
    expect(after?.text).toContain("fifteenth");
  });

  it("gives a record as a turn sees it: its title, then its whole body when short, else a window around the match", async () => {
    const { memory } = await open();
    const alice = actorOf("alice");
    const short = await memory.remember({
      actor: alice,
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      title: "ACME terms",
      body: "ACME pays invoices net 60",
    });
    const long = await memory.remember({
      actor: alice,
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      body: `${"filler words ".repeat(40)}ACME invoices go to the finance inbox ${"more filler ".repeat(40)}`,
    });
    const context = await heartbeatMemoryContext(memory, state(), { kind: "deep", signals: [] });
    expect(context.find((record) => record.recordId === short.recordId)?.text).toBe("ACME terms — ACME pays invoices net 60");
    const window = context.find((record) => record.recordId === long.recordId)?.text ?? "";
    expect(window).toContain("[ACME]");
    expect(window.length).toBeLessThan(400);
  });

  it("leaves an ended fact out after its date: 'until Friday' is in Thursday's block and gone from Saturday's", async () => {
    const { store } = await open();
    const clock = { now: "2026-01-01T09:00:00.000Z" };
    const memory = new MemoryService(store.asPort(), { now: () => clock.now });
    const trip = await memory.remember({
      actor: actorOf("alice"),
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      body: "Away on ACME invoices duty until Friday",
      validTo: "2026-01-03T00:00:00.000Z",
    });
    expect((await heartbeatMemoryContext(memory, state(), { kind: "deep", signals: [] })).map((record) => record.recordId)).toContain(
      trip.recordId,
    );
    clock.now = "2026-01-03T09:00:00.000Z";
    expect((await heartbeatMemoryContext(memory, state(), { kind: "deep", signals: [] })).map((record) => record.recordId)).not.toContain(
      trip.recordId,
    );
  });

  it("searches the new signals' titles on a signal tick", async () => {
    const { memory } = await open();
    const alice = actorOf("alice");
    const fact = await memory.remember({
      actor: alice,
      scope: { kind: "personal", principalId: "alice" },
      kind: "fact",
      body: "Globex renewals are handled by Dana",
    });
    const context = await heartbeatMemoryContext(memory, state("alice", ""), {
      kind: "signal",
      signals: [{ key: "x", hash: "1", title: "Globex renewal is due", at: AT, source: "test" }],
    });
    expect(context.map((record) => record.recordId)).toContain(fact.recordId);
  });
});

describe("the built-in signal sources", () => {
  it("names a failed schedule of the person's, with a hash that changes with each failure", async () => {
    const { repositories } = await open();
    const sources = builtinHeartbeatSources(repositories);
    const schedules = sources.find((source) => source.id === "schedules");
    const created = await repositories.schedules.create({
      scheduleId: "schedule-brief",
      workspaceId: "default",
      principalId: "alice",
      name: "brief",
      prompt: "brief",
      spec: { at: "07:00", timezone: "UTC" },
      missedRunPolicy: "skip",
      autoApproveTools: [],
      enabled: true,
      now: AT,
      nextRunAt: AT,
    });
    await repositories.schedules.recordRun({
      scheduleId: created.scheduleId,
      taskId: null,
      outcome: "failed: boom",
      outcomeKind: "failed",
      now: AT,
    });
    const scope = { workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal };
    const signals = await listed(schedules?.collect(scope));
    expect(signals).toHaveLength(1);
    expect(signals?.[0]).toMatchObject({ key: created.scheduleId, source: "Schedules" });
    expect(await schedules?.collect({ ...scope, principalId: "bob" })).toEqual([]);
  });

  it("leaves a routine's trigger schedule to the routines source, and says a fire not run since apart from the failure", async () => {
    const { repositories } = await open();
    const schedule = (scheduleId: string, name: string) =>
      repositories.schedules.create({
        scheduleId,
        workspaceId: "default",
        principalId: "alice",
        name,
        prompt: "p",
        spec: { at: "07:00", timezone: "UTC" },
        missedRunPolicy: "skip",
        autoApproveTools: [],
        enabled: true,
        now: AT,
        nextRunAt: AT,
      });
    await schedule("schedule-plain", "brief");
    await schedule("schedule-routine", "routine-1/morning");
    for (const scheduleId of ["schedule-plain", "schedule-routine"]) {
      await repositories.schedules.markRunning({ scheduleId, taskId: "task-1", fireTime: AT, now: AT });
      await repositories.schedules.recordRun({ scheduleId, taskId: "task-1", outcome: "failed: boom", outcomeKind: "failed", now: AT });
    }
    const schedules = builtinHeartbeatSources(repositories, {
      routineOwners: (scheduleIds) =>
        scheduleIds.map((scheduleId) => (scheduleId === "schedule-routine" ? { routineId: "routine-1", triggerId: "morning" } : undefined)),
    }).find((source) => source.id === "schedules");
    const scope = { workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal };
    const failed = await listed(schedules?.collect(scope));
    expect(failed).toEqual([expect.objectContaining({ key: "schedule-plain", data: { failures: 1 } })]);
    // The next fire is missed: the failure stands as it was, and the miss is said apart from it.
    await repositories.schedules.recordRun({
      scheduleId: "schedule-plain",
      taskId: null,
      outcome: "skipped: missed by 400m (policy: skip)",
      outcomeKind: "skipped",
      now: AT,
    });
    const missed = await listed(schedules?.collect(scope));
    expect(missed).toEqual([
      expect.objectContaining({ key: "schedule-plain", hash: failed?.[0]?.hash, data: { failures: 1, latest: "not run" } }),
    ]);
  });

  it("says a schedule missed N times in a row, counted from missed fires alone: an overlap or a run ends the count, a refused call does not", async () => {
    const { repositories } = await open();
    await repositories.schedules.create({
      scheduleId: "schedule-brief",
      workspaceId: "default",
      principalId: "alice",
      name: "brief",
      prompt: "brief",
      spec: { at: "07:00", timezone: "UTC" },
      missedRunPolicy: "skip",
      autoApproveTools: [],
      enabled: true,
      now: AT,
      nextRunAt: AT,
    });
    const schedules = builtinHeartbeatSources(repositories).find((source) => source.id === "schedules");
    const scope = { workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal };
    const fire = (day: number, reasonCode: "missed" | "overlap" | "ok" | "manual" | "webhook-refused" | "email-refused") =>
      repositories.schedules.recordRun({
        scheduleId: "schedule-brief",
        taskId: null,
        outcome: reasonCode === "missed" ? "skipped: missed by 400m (policy: skip)" : reasonCode,
        outcomeKind: reasonCode === "ok" ? "succeeded" : "skipped",
        fire: { fireTime: `2026-10-0${day}T07:00:00.000Z`, reasonCode },
        now: `2026-10-0${day}T14:00:00.000Z`,
      });
    await fire(1, "ok");
    expect(await listed(schedules?.collect(scope))).toEqual([]);
    await fire(2, "missed");
    expect(await listed(schedules?.collect(scope))).toEqual([
      expect.objectContaining({ key: "schedule-brief:missed", title: "The schedule brief missed its run", data: { missed: 1 } }),
    ]);
    // An overlap is not a miss: something was running, and the count it ends starts again after it.
    await fire(3, "overlap");
    expect(await listed(schedules?.collect(scope))).toEqual([]);
    await fire(4, "missed");
    await fire(5, "manual");
    // Refused webhook calls and emails started nothing: they neither count nor end the count.
    await fire(5, "webhook-refused");
    await fire(6, "missed");
    await fire(6, "email-refused");
    await fire(7, "missed");
    const missed = await listed(schedules?.collect(scope));
    expect(missed).toEqual([
      expect.objectContaining({
        key: "schedule-brief:missed",
        title: "The schedule brief missed 3 times in a row",
        hash: "2026-10-07T07:00:00.000Z:3",
        at: "2026-10-07T14:00:00.000Z",
        data: { missed: 3 },
      }),
    ]);
    expect(missed?.map((signal) => HeartbeatSignalSchema.safeParse(signal).success)).toEqual([true]);
    // Never a failure: the failure count is untouched, and a run ends the streak.
    await fire(8, "ok");
    expect(await listed(schedules?.collect(scope))).toEqual([]);
  });

  it("lists only the person's own schedules on the agenda", async () => {
    const { repositories } = await open();
    const agenda = builtinHeartbeatSources(repositories).find((source) => source.id === "agenda");
    const soon = new Date(Date.parse(AT) + 30 * 60_000).toISOString();
    for (const [scheduleId, principalId] of [
      ["mine", "alice"],
      ["theirs", "bob"],
    ] as const) {
      await repositories.schedules.create({
        scheduleId,
        workspaceId: "default",
        principalId,
        name: scheduleId,
        prompt: "p",
        spec: { at: soon.slice(11, 16), timezone: "UTC" },
        missedRunPolicy: "skip",
        autoApproveTools: [],
        enabled: true,
        now: AT,
        nextRunAt: soon,
      });
    }
    const signals = await listed(
      agenda?.collect({ workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal }),
    );
    expect(signals?.map((signal) => signal.data)).toEqual([{ kind: "schedule", id: "mine" }]);
  });

  it("says when a list was cut at its page, so what it did not see is not taken for gone", async () => {
    const { repositories } = await open();
    const routines = builtinHeartbeatSources({
      ...repositories,
      heartbeats: {
        ...repositories.heartbeats,
        failedRoutineRuns: async () =>
          Array.from({ length: 50 }, (_, index) => ({ runId: `run-${index}`, routineId: "r1", name: "Brief", endedAt: AT })),
      },
    }).find((source) => source.id === "routines");
    const answer = await routines?.collect({
      workspaceId: "default",
      principalId: "alice",
      now: AT,
      timezone: "UTC",
      signal: new AbortController().signal,
    });
    expect(answer).toMatchObject({ incomplete: true });
    expect(answer === undefined ? 0 : heartbeatSignalsOf(answer).length).toBe(50);
  });

  it("marks the sources whose signals leave by age, so their leaving resolves nothing", async () => {
    const { repositories } = await open();
    expect(
      builtinHeartbeatSources(repositories)
        .filter((source) => source.retracts === false)
        .map((source) => source.id),
    ).toEqual(["agenda", "sends", "routines"]);
  });

  it("lists every built-in source, each answering an empty store with nothing", async () => {
    const { repositories } = await open();
    const sources = builtinHeartbeatSources(repositories);
    expect(sources.map((source) => source.id)).toEqual(["needs", "agenda", "schedules", "held", "messages", "sends", "routines"]);
    for (const source of sources) {
      expect(
        await source.collect({
          workspaceId: "default",
          principalId: "alice",
          now: AT,
          timezone: "UTC",
          signal: new AbortController().signal,
        }),
        source.id,
      ).toEqual([]);
    }
  });
});

/** Each built-in source passes the conformance kit, over a store holding something for it to report. */
async function seeded() {
  const { repositories, store } = await open();
  // A message from bob two hours unanswered, a send that bounced, and a routine run of alice's that failed.
  const hour = (n: number) => new Date(Date.parse(AT) - n * 3_600_000).toISOString();
  store.handle
    .prepare(
      "INSERT INTO tavi_messaging_connections (connection_id, provider_id, workspace_id, label, account_identity, settings_json, credential_refs_json, enabled, config_revision, auth_state, created_at, updated_at) VALUES ('tg', 'telegram', 'default', 'Telegram', 'bot', '{}', '{}', 1, 1, 'connected', ?, ?)",
    )
    .run(hour(5), hour(5));
  await repositories.heartbeats.noteInbound({
    connectionId: "tg",
    conversationKey: "chat-1",
    workspaceId: "default",
    senderPrincipalId: "bob",
    providerEventId: "evt-1",
    at: hour(2),
  });
  store.handle
    .prepare(
      "INSERT INTO tavi_messaging_deliveries (connection_id, provider_message_id, effect_id, status, status_at) VALUES ('tg', 'm1', 'e1', 'bounced', ?)",
    )
    .run(hour(1));
  store.handle
    .prepare(
      "INSERT INTO tavi_routines (routine_id, workspace_id, principal_id, name, version, active_revision, latest_revision, status, created_at, updated_at) VALUES ('r1', 'default', 'alice', 'Morning brief', 1, 1, 1, 'active', ?, ?)",
    )
    .run(hour(5), hour(5));
  store.handle
    .prepare(
      "INSERT INTO tavi_routine_runs (run_id, routine_id, workspace_id, principal_id, occurrence_key, revision, snapshot_json, mode, status, claimed_at, ended_at, data_json) VALUES ('run-1', 'r1', 'default', 'alice', 'o1', 1, '{}', 'scheduled', 'failed', ?, ?, '{}')",
    )
    .run(hour(2), hour(1));
  // The other sources: a channel that needs signing in again, and a message held for review from an unbound sender.
  store.handle
    .prepare(
      "INSERT INTO tavi_messaging_connections (connection_id, provider_id, workspace_id, label, account_identity, settings_json, credential_refs_json, enabled, config_revision, auth_state, created_at, updated_at) VALUES ('mail', 'gmail', 'default', 'Mail', 'me@example.com', '{}', '{}', 1, 2, 'expired', ?, ?)",
    )
    .run(hour(3), hour(3));
  const heldRow = store.handle.prepare(
    "INSERT INTO tavi_messaging_inbox (connection_id, provider_event_id, kind, payload_json, state, received_at) VALUES ('tg', ?, 'message', ?, 'received', ?)",
  );
  heldRow.run(
    "held-1",
    JSON.stringify({
      connectionId: "tg",
      providerEventId: "held-1",
      externalSenderId: "+15550001111",
      externalConversationId: "c-9",
      content: "hello",
    }),
    hour(1),
  );
  // One held from a sender bound to bob: his to review, never alice's.
  store.handle
    .prepare(
      "INSERT INTO tavi_messaging_identity_bindings (connection_id, external_sender_id, workspace_id, principal_id, approved_by, created_at) VALUES ('tg', '+15550002222', 'default', 'bob', 'operator', ?)",
    )
    .run(hour(4));
  heldRow.run(
    "held-2",
    JSON.stringify({
      connectionId: "tg",
      providerEventId: "held-2",
      externalSenderId: "+15550002222",
      externalConversationId: "c-10",
      content: "hi",
    }),
    hour(1),
  );
  const soon = new Date(Date.parse(AT) + 30 * 60_000).toISOString();
  await repositories.schedules.create({
    scheduleId: "schedule-brief",
    workspaceId: "default",
    principalId: "alice",
    name: "brief",
    prompt: "brief",
    spec: { at: soon.slice(11, 16), timezone: "UTC" },
    missedRunPolicy: "skip",
    autoApproveTools: [],
    enabled: true,
    now: AT,
    nextRunAt: soon,
  });
  await repositories.schedules.recordRun({
    scheduleId: "schedule-brief",
    taskId: null,
    outcome: "failed: boom",
    outcomeKind: "failed",
    now: AT,
  });
  // A pending approval of alice's for two hours: the inbox's own read joins several tables, so the test stands in for it.
  const approvalInbox = {
    pending: async () => ({
      rows: [
        {
          approvalId: "ap-1",
          taskId: "task-1",
          toolId: "fs.write",
          callId: "call-1",
          steps: null,
          createdAt: hour(2),
          workspaceId: "default",
          principalId: "alice",
          taskStatus: "waiting",
          allowedScopes: ["once" as const],
        },
      ],
      truncated: false,
    }),
    pendingWaits: async () => ({ questions: [], reviews: [], truncated: false }),
  } as unknown as typeof repositories.approvalInbox;
  return builtinHeartbeatSources({ ...repositories, approvalInbox });
}

describe("needs, channels and held messages over a store holding them", () => {
  it("each make one signal", async () => {
    const sources = await seeded();
    const scope = { workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal };
    const collected = async (id: string) => await sources.find((source) => source.id === id)?.collect(scope);
    expect(await collected("needs")).toEqual([
      expect.objectContaining({ key: "approval:ap-1", hash: "waiting", source: "Waiting on you" }),
    ]);
    expect(await collected("held")).toEqual([
      expect.objectContaining({ key: "tg:held-1", hash: "held", title: "A message is held for review from +15550001111" }),
    ]);
    // Bob: the unbound sender's and his own sender's held messages, and none of alice's needs.
    const bob = { ...scope, principalId: "bob" };
    expect((await listed(sources.find((source) => source.id === "held")?.collect(bob)))?.map((signal) => signal.key)).toEqual([
      "tg:held-1",
      "tg:held-2",
    ]);
    expect(await sources.find((source) => source.id === "needs")?.collect(bob)).toEqual([]);
  });
});

describe("held messages", () => {
  it("are read for this workspace's connections only, so another workspace's backlog never crowds them out", async () => {
    const { repositories, store } = await open();
    const at = (n: number) => new Date(Date.parse(AT) - n * 60_000).toISOString();
    const connection = store.handle.prepare(
      "INSERT INTO tavi_messaging_connections (connection_id, provider_id, workspace_id, label, account_identity, settings_json, credential_refs_json, enabled, config_revision, auth_state, created_at, updated_at) VALUES (?, 'telegram', ?, 'T', 'bot', '{}', '{}', 1, 1, 'connected', ?, ?)",
    );
    connection.run("mine", "default", at(500), at(500));
    connection.run("theirs", "other", at(500), at(500));
    const held = store.handle.prepare(
      "INSERT INTO tavi_messaging_inbox (connection_id, provider_event_id, kind, payload_json, state, received_at) VALUES (?, ?, 'message', ?, 'received', ?)",
    );
    for (let index = 0; index < 205; index += 1)
      held.run("theirs", `old-${index}`, JSON.stringify({ externalSenderId: "+1", content: "spam" }), at(400 - index));
    held.run("mine", "new-1", JSON.stringify({ externalSenderId: "+15550001111", content: "hello" }), at(1));
    const source = builtinHeartbeatSources(repositories).find((candidate) => candidate.id === "held");
    const signals = await listed(
      source?.collect({ workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal }),
    );
    expect(signals?.map((signal) => signal.key)).toEqual(["mine:new-1"]);
  });
});

describe("unanswered messages, failed sends and failed routine runs", () => {
  it("each make one signal", async () => {
    const sources = await seeded();
    const scope = { workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal };
    const collected = async (id: string) => await sources.find((source) => source.id === id)?.collect(scope);
    expect(await collected("messages")).toEqual([
      expect.objectContaining({
        key: "message:tg:chat-1",
        title: "A message on Telegram has waited over an hour for an answer",
        source: "Channels",
      }),
    ]);
    expect(await collected("sends")).toEqual([
      expect.objectContaining({ key: "send:tg:m1", hash: "bounced", title: "A message on Telegram bounced" }),
    ]);
    expect(await collected("routines")).toEqual([
      expect.objectContaining({ key: "routine-run:run-1", hash: "failed", title: "Routine Morning brief failed", source: "Routines" }),
    ]);
  });
});

for (const id of ["needs", "agenda", "schedules", "held", "messages", "sends", "routines"]) {
  describeSignalSourceConformance(`built-in ${id}`, async () => {
    const source = (await seeded()).find((candidate) => candidate.id === id);
    if (source === undefined) throw new Error(`no built-in source ${id}`);
    return source;
  });
}

/** A lapsed channel and an MCP account a day before its weekly sign-in, as the owner's apps projection gives them. */
async function appsSeeded() {
  const { repositories, store } = await open();
  const hour = (n: number) => new Date(Date.parse(AT) - n * 3_600_000).toISOString();
  store.handle
    .prepare(
      "INSERT INTO tavi_messaging_connections (connection_id, provider_id, workspace_id, label, account_identity, settings_json, credential_refs_json, enabled, config_revision, auth_state, created_at, updated_at) VALUES ('mail', 'gmail', 'default', 'Mail', 'me@example.com', '{}', '{}', 1, 2, 'expired', ?, ?)",
    )
    .run(hour(3), hour(3));
  const account = (accountId: string, health: AppHealth, extra: Partial<AppAccountView> = {}): AppAccountView => ({
    accountId,
    label: "me@example.com",
    owner: { kind: "owner" },
    health,
    grantedScopes: [],
    missingScopes: [],
    expiresWeekly: false,
    workspaces: ["default"],
    people: false,
    sharing: "personal",
    readOnly: false,
    ...extra,
  });
  const app = (
    appId: string,
    name: string,
    health: AppHealth,
    accounts: readonly AppAccountView[],
    repairs: readonly AppRepair[],
  ): ConnectableApp => ({
    appId,
    name,
    summary: "",
    category: "other",
    source: { kind: "mcp", pluginIds: accounts.map((each) => each.accountId), verified: "reviewed", isolation: "remote" },
    auth: { kind: "none" },
    tools: [],
    egress: { hosts: [], lan: false, anyNetwork: false },
    credentials: [],
    settings: [],
    trust: { output: "untrusted", source: "mcp", confidentiality: "personal" },
    accounts: [...accounts],
    health,
    repairs: [...repairs],
    warnings: [],
  });
  const apps = [
    app(
      "gmail",
      "Gmail",
      "needs-sign-in",
      [account("mail", "needs-sign-in", { readOnly: true })],
      [
        {
          kind: "sign-in",
          accountId: "mail",
          title: "Reconnect Gmail",
          detail: "Its sign-in expired or was revoked.",
          cli: "tavi channels connect mail",
        },
      ],
    ),
    app(
      "google-calendar",
      "Google Calendar",
      "ready",
      [account("mcp.gcal", "ready", { signedInAt: hour(150), expiresWeekly: true, nextSignInBy: hour(-18) })],
      [
        {
          kind: "sign-in",
          accountId: "mcp.gcal",
          title: "Sign in to Google Calendar again by 2026-10-12",
          detail: "Its provider signs an app in Testing out every 7 days.",
          cli: "tavi mcp login mcp.gcal",
        },
      ],
    ),
    app(
      "notes",
      "Notes",
      "not-set-up",
      [account("mcp.notes", "not-set-up")],
      [
        {
          kind: "sign-in",
          accountId: "mcp.notes",
          title: "Sign in to Notes",
          detail: "It has not been signed in yet.",
          cli: "tavi mcp login mcp.notes",
        },
      ],
    ),
  ];
  return appsSignalsSource({
    apps: async () => apps,
    connections: repositories.messagingConnections,
    operatorOf: () => "alice",
    usedIn: async (accountId) => (accountId === "mcp.gcal" ? ["work", "default"] : []),
  });
}

describe("apps that need signing in again", () => {
  it("make one signal per lapsed or soon-due account, named by its revision, for the operator only", async () => {
    const source = await appsSeeded();
    const scope = { workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal };
    const signals = await listed(source.collect(scope));
    expect(signals).toEqual([
      expect.objectContaining({ key: "app:mail", hash: "needs-sign-in:mail:2", title: "Reconnect Gmail", source: "Connected apps" }),
      expect.objectContaining({
        key: "app:mcp.gcal",
        hash: `ready:mcp.gcal:${new Date(Date.parse(AT) - 150 * 3_600_000).toISOString()}`,
        title: "Sign in to Google Calendar again by 2026-10-12",
      }),
    ]);
    expect(await source.collect({ ...scope, principalId: "bob" })).toEqual([]);
  });

  it("tells an owner-wide account once, in the first workspace that offers it, not in every workspace's look", async () => {
    const source = await appsSeeded();
    const scope = { workspaceId: "work", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal };
    // `mcp.gcal` is offered in `default` and `work`: told in `default` (above), not here; Gmail's connection is `default`'s.
    expect(await listed(source.collect(scope))).toEqual([]);
  });
});

describeSignalSourceConformance("built-in apps", appsSeeded);

describe("the first-run offer's instructions", () => {
  it("prefills a line per installed built-in source, only when one has something to watch", async () => {
    const { repositories } = await open();
    const registry = new HeartbeatSignalRegistry();
    for (const source of builtinHeartbeatSources(repositories)) registry.install(source.id, source, "builtin");
    registry.install(
      "apps",
      appsSignalsSource({
        apps: async () => [],
        connections: repositories.messagingConnections,
        operatorOf: () => "alice",
        usedIn: async () => [],
      }),
      "builtin",
    );
    const scope = { workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC" };
    expect(await heartbeatOfferInstructions(registry, scope)).toBeUndefined();
    await repositories.schedules.create({
      scheduleId: "schedule-brief",
      workspaceId: "default",
      principalId: "alice",
      name: "brief",
      prompt: "brief",
      spec: { at: "07:00", timezone: "UTC" },
      missedRunPolicy: "skip",
      autoApproveTools: [],
      enabled: true,
      now: AT,
      nextRunAt: AT,
    });
    await repositories.schedules.recordRun({
      scheduleId: "schedule-brief",
      taskId: null,
      outcome: "failed: boom",
      outcomeKind: "failed",
      now: AT,
    });
    expect(await heartbeatOfferInstructions(registry, scope)).toBe(
      "Approvals or questions waiting more than an hour\nReminders and events in the next 2 hours\nScheduled runs that fail\nMessages held for my review\nMessages that wait over an hour for an answer\nMessages that bounce or fail to send\nRoutines that fail\nApps that need signing in again\n",
    );
    // A plugin's source with something to watch is not a reason to offer the built-in heartbeat.
    const plugins = new HeartbeatSignalRegistry();
    plugins.install(
      "acme",
      { id: "acme", collect: async () => [{ key: "x", hash: "1", title: "Something", at: AT, source: "Acme" }] },
      "plugin",
    );
    expect(await heartbeatOfferInstructions(plugins, scope)).toBeUndefined();
    // A plugin source's offer line joins the built-ins', after them; its code never runs for the offer.
    let ran = false;
    registry.install(
      "acme.queue",
      {
        id: "queue",
        offer: "Jobs stuck in the queue",
        collect: async () => ((ran = true), []),
      },
      "plugin",
    );
    expect(await heartbeatOfferInstructions(registry, scope)).toMatch(/Apps that need signing in again\nJobs stuck in the queue\n$/);
    expect(ran).toBe(false);
  });
});

describe("watched pages", () => {
  const flush = async () => await delay(5);

  /** A heartbeat watching two pages, one on a host it may read, and a page whose answer the test sets. */
  function pages(fetchHosts: string[] = ["example.com"]) {
    const instructions = "watch: https://example.com/pricing — tell me if the Pro price changes\nwatch: https://elsewhere.test/news";
    const heartbeat = { ...state(), config: { ...state().config, instructions, fetchHosts } };
    const fetched: { url: string; allowedHosts: readonly string[] }[] = [];
    let answer: () => Promise<{ status: number; text: string }> = async () => ({
      status: 200,
      text: "<h1>Pricing</h1><p>Pro: $20 a month</p>",
    });
    const source = watchedPagesSource({
      heartbeats: { get: async () => heartbeat },
      fetchPage: async (url, allowedHosts) => {
        fetched.push({ url, allowedHosts });
        return await answer();
      },
    });
    /** One collection, then the reads it started settle; answers what the next collection would see. */
    const collect = async (now: string) => {
      const scope = { workspaceId: "default", principalId: "alice", now, timezone: "UTC", signal: new AbortController().signal };
      await source.collect(scope);
      await flush();
      return heartbeatSignalsOf(await source.collect(scope));
    };
    return {
      source,
      fetched,
      collect,
      answer: (next: () => Promise<{ status: number; text: string }>) => {
        answer = next;
      },
    };
  }

  it("says it saw only part while a watched page has no reading yet, so its signal is not taken for gone", async () => {
    const { source } = pages();
    const scope = { workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal };
    expect(await source.collect(scope)).toEqual({ signals: [], incomplete: true });
    await flush();
    expect(heartbeatSignalsOf(await source.collect(scope))).toHaveLength(1);
  });

  it("reads only a host the heartbeat may read, at most hourly, and its hash changes only when the page does", async () => {
    const { fetched, collect, answer } = pages();
    const [first] = await collect(AT);
    expect(fetched).toEqual([{ url: "https://example.com/pricing", allowedHosts: ["example.com"] }]);
    expect(first).toMatchObject({
      title: "A page you watch: example.com/pricing",
      source: "Watched page",
      data: { url: "https://example.com/pricing", instructionLine: 1 },
    });
    // Within the hour: not read again, the same reading.
    answer(async () => ({ status: 200, text: "<h1>Pricing</h1><p>Pro: $25 a month</p>" }));
    expect((await collect("2026-10-11T09:30:00.000Z"))[0]?.hash).toBe(first?.hash);
    expect(fetched).toHaveLength(1);
    // An hour on: read again, and changed.
    const [changed] = await collect("2026-10-11T10:00:00.000Z");
    expect(changed?.key).toBe(first?.key);
    expect(changed?.hash).not.toBe(first?.hash);
    // Unchanged after another hour: the same hash.
    expect((await collect("2026-10-11T11:00:00.000Z"))[0]?.hash).toBe(changed?.hash);
  });

  it("never fetches a page whose host was never approved", async () => {
    const { fetched, collect } = pages([]);
    expect(await collect(AT)).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it("keeps a page's last reading through a failed read or an error answer, and tries again only an hour on", async () => {
    const { fetched, collect, answer } = pages();
    const [first] = await collect(AT);
    answer(async () => {
      throw new Error("down");
    });
    expect((await collect("2026-10-11T10:00:00.000Z"))[0]?.hash).toBe(first?.hash);
    // The failed read was this hour's try.
    await collect("2026-10-11T10:10:00.000Z");
    expect(fetched).toHaveLength(2);
    answer(async () => ({ status: 503, text: "Service unavailable" }));
    expect((await collect("2026-10-11T11:00:00.000Z"))[0]?.hash).toBe(first?.hash);
  });

  it("answers at once while a slow page is read, within the collection's deadline", async () => {
    const heartbeat = {
      ...state(),
      config: { ...state().config, instructions: "watch: https://example.com/pricing", fetchHosts: ["example.com"] },
    };
    const source = watchedPagesSource({
      heartbeats: { get: async () => heartbeat },
      fetchPage: async () => await new Promise(() => undefined),
    });
    const started = Date.now();
    expect(
      await source.collect({
        workspaceId: "default",
        principalId: "alice",
        now: AT,
        timezone: "UTC",
        signal: new AbortController().signal,
      }),
    ).toEqual({ signals: [], incomplete: true });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("keeps its data within the signal's limit for a multi-byte page and a long address", async () => {
    const long = `https://example.com/${"a".repeat(2_100)}`;
    const heartbeat = {
      ...state(),
      config: { ...state().config, instructions: `watch: https://example.com/новости\nwatch: ${long}`, fetchHosts: ["example.com"] },
    };
    const source = watchedPagesSource({
      heartbeats: { get: async () => heartbeat },
      fetchPage: async () => ({ status: 200, text: "Новости дня ".repeat(400) }),
    });
    const scope = { workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal };
    await source.collect(scope);
    await flush();
    const signals = heartbeatSignalsOf(await source.collect(scope));
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(HeartbeatSignalSchema.safeParse(signal).success, signal.title).toBe(true);
    expect(signals[1]?.data).not.toHaveProperty("url");
  });
});

// Read once first: a page shows from the collection after its read, and the kit holds what a source answers.
describeSignalSourceConformance("built-in watched pages", async () => {
  const source = watchedPagesSource({
    heartbeats: {
      get: async () => ({
        ...state(),
        config: { ...state().config, instructions: "watch: https://example.com/pricing", fetchHosts: ["example.com"] },
      }),
    },
    fetchPage: async () => ({ status: 200, text: "Pro: $20 a month" }),
  });
  await source.collect({ workspaceId: "default", principalId: "alice", now: AT, timezone: "UTC", signal: new AbortController().signal });
  await delay(5);
  return source;
});

describe("storage signals", () => {
  const MB = 1024 * 1024;
  function storage(sizes: Record<string, number>, options: { owners?: Record<string, string>; belowFloor?: boolean } = {}) {
    const measured: string[] = [];
    const source = storageSignalsSource({
      space: {
        usage: async (managed) => {
          measured.push(managed);
          const total = Object.values(sizes).reduce((sum, bytes) => sum + bytes, 0);
          return { bytes: sizes[managed] ?? 0, capBytes: 100 * MB, chatsBytes: total, chatsCapBytes: 1_000 * MB };
        },
        checkFloor: () => {
          if (options.belowFloor === true) throw new TaviError("QUOTA_EXCEEDED", "below the floor");
        },
      },
      chatFolders: async () => Object.keys(sizes).map((managed) => ({ taskId: managed.split("/").pop() ?? managed, managed })),
      ownerOf: async (taskId) => options.owners?.[taskId] ?? "alice",
    });
    const collect = async () =>
      heartbeatSignalsOf(
        await source.collect({
          workspaceId: "default",
          principalId: "alice",
          now: AT,
          timezone: "UTC",
          signal: new AbortController().signal,
        }),
      );
    return { source, collect, measured };
  }

  it("is one signal per folder past 80% of its budget, the same while it stays there, and none below", async () => {
    expect(await storage({ "/chats/default/home-1": 70 * MB }).collect()).toEqual([]);
    const past = storage({ "/chats/default/home-1": 85 * MB, "/chats/default/side-2": 10 * MB });
    const [first] = await past.collect();
    expect(first).toMatchObject({
      key: "folder:home-1",
      hash: "past-80",
      source: "Storage",
      data: { taskId: "home-1", bytes: 85 * MB, capBytes: 100 * MB },
    });
    expect((await past.collect()).map((signal) => `${signal.key}#${signal.hash}`)).toEqual(["folder:home-1#past-80"]);
  });

  it("measures only the person's own chats, and says when every chat together or the disk is nearly full", async () => {
    const { collect, measured } = storage(
      { "/chats/default/home-1": 10 * MB, "/chats/default/bob-chat": 900 * MB },
      { owners: { "bob-chat": "bob" }, belowFloor: true },
    );
    expect((await collect()).map((signal) => signal.key)).toEqual(["folders", "free-space"]);
    expect(measured).toEqual(["/chats/default/home-1"]);
  });

  it("says every chat together is nearly full to a person who owns no folder, and measures at most 50 of a person's folders", async () => {
    const others = storage({ "/chats/default/bob-chat": 900 * MB }, { owners: { "bob-chat": "bob" } });
    expect((await others.collect()).map((signal) => signal.key)).toEqual(["folders"]);
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`/chats/default/chat-${String(index).padStart(2, "0")}`, MB]),
    );
    const capped = storage(many);
    await capped.collect();
    expect(capped.measured).toHaveLength(50);
  });

  it("lists a workspace's chat folders by name, and none for a workspace without any", async () => {
    const root = realpathSync(directories.create("tavi-storage-"));
    mkdirSync(join(root, "home-1"));
    mkdirSync(join(root, ".trash"));
    writeFileSync(join(root, "stray.txt"), "not a folder");
    expect(await managedChatFolders(root)).toEqual([{ taskId: "home-1", managed: join(root, "home-1") }]);
    expect(await managedChatFolders(join(root, "missing"))).toEqual([]);
  });
});

describeSignalSourceConformance("built-in storage", () =>
  storageSignalsSource({
    space: { usage: async () => ({ bytes: 90, capBytes: 100, chatsBytes: 90, chatsCapBytes: 1_000 }), checkFloor: () => undefined },
    chatFolders: async () => [{ taskId: "home-1", managed: "/chats/default/home-1" }],
    ownerOf: async () => "alice",
  }),
);
