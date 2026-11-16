import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  HEARTBEAT_PRODUCTION_OPTIONS,
  HeartbeatPayloadSchema,
  defaultHeartbeatConfig,
  type HeartbeatGetAnswer,
  type HeartbeatTickRecord,
} from "@tavi/contracts";
import { HeartbeatProviderStates } from "@tavi/agent-host/heartbeat-host";
import { temporaryDirectories } from "@tavi/test-support";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { heartbeatCommand, rescheduleHeartbeat, type HeartbeatCommandDependencies } from "../../src/features/heartbeat/owner.js";
import {
  editedInstructions,
  editorWords,
  heartbeatLogLine,
  heartbeatPayload,
  heartbeatStatusText,
  nearestHeartbeatInterval,
} from "../../src/features/heartbeat/text.js";
import { EXIT, main } from "../../src/main.js";
import { SqliteStore } from "../support/database-fixture.js";
import { ATTACHED, capture, turns, useAttachedOwners } from "../support/attached-owner.js";

/**
 * `heartbeat` over IPC and `tavi heartbeat`:
 * every action round-trips, a stale revision is refused, and so is any
 * principal but the operator.
 */

const directories = temporaryDirectories({ prefix: "tavi-heartbeat-cli-" });
const stores: SqliteStore[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
});
afterAll(() => directories.cleanup());

async function tavi(argv: readonly string[]) {
  const out = capture();
  const code = await main([...argv], { io: out.io });
  return { code, stdout: out.stdout(), stderr: out.stderr() };
}

const AT = "2026-10-11T09:00:00.000Z";

async function command(extra: Partial<HeartbeatCommandDependencies> = {}) {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  let checked = 0;
  const deps: HeartbeatCommandDependencies = {
    repositories: store.asPort().repositories,
    principalOf: (workspaceId) => (workspaceId === "default" ? "operator" : undefined),
    options: HEARTBEAT_PRODUCTION_OPTIONS,
    providers: () => [
      {
        id: "tavi.heartbeatagent",
        kind: "builtin",
        receives: ["instructions", "signals", "ledger", "memory"],
        usesTurns: true,
        maxTickSeconds: 60,
      },
      {
        id: "acme.heartbeat",
        kind: "plugin",
        receives: ["instructions", "signals", "ledger", "memory"],
        usesTurns: false,
        maxTickSeconds: 30,
      },
    ],
    host: () => ({
      checkNow: async () => {
        checked += 1;
        return { status: "started" as const };
      },
    }),
    author: "ipc",
    now: () => new Date(AT),
    ...extra,
  };
  return {
    run: (payload: Parameters<typeof heartbeatCommand>[1]) => heartbeatCommand(deps, payload),
    repositories: store.asPort().repositories,
    checked: () => checked,
  };
}

describe("the heartbeat command", () => {
  it("answers the defaults before the heartbeat is saved, and turns it on at revision 1 with its next check placed", async () => {
    const { run } = await command();
    expect(await run({ action: "get" })).toMatchObject({
      ok: true,
      result: { revision: 0, config: { enabled: false }, hostRunning: true, providers: ["tavi.heartbeatagent", "acme.heartbeat"] },
    });
    const on = await run({ action: "set", changes: { enabled: true } });
    expect(on).toMatchObject({ ok: true, result: { revision: 1, config: { enabled: true }, state: { nextTickAt: expect.any(String) } } });
  });

  it("answers what the selected provider published for its panel, and Forget clears it", async () => {
    const states = new HeartbeatProviderStates();
    const { run } = await command({ providerStates: states });
    await run({ action: "set", changes: { enabled: true } });
    states.publish({ workspaceId: "default", principalId: "operator" }, "tavi.heartbeatagent", "rules", { matched: 2 });
    states.publish({ workspaceId: "default", principalId: "operator" }, "acme.heartbeat", "other", 1);
    expect(await run({ action: "get" })).toMatchObject({ ok: true, result: { providerState: { rules: { matched: 2 } } } });
    await run({ action: "forget" });
    expect((await run({ action: "get" })) as { result: Record<string, unknown> }).not.toHaveProperty("result.providerState");
  });

  it("lists the installed signal sources, and saves the ones turned off", async () => {
    const { run } = await command({ sources: () => [{ id: "needs", kind: "builtin" }] });
    expect(await run({ action: "get" })).toMatchObject({
      ok: true,
      result: { sources: [{ id: "needs", kind: "builtin" }], config: { disabledSources: [] } },
    });
    expect(await run({ action: "set", changes: { disabledSources: ["needs"] } })).toMatchObject({
      ok: true,
      result: { config: { disabledSources: ["needs"] } },
    });
    expect(await run({ action: "set", changes: { disabledSources: ["Not An Id!"] } })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("offers the read-only plugin tools the owner names as choices", async () => {
    const { run } = await command({ toolChoices: () => [{ id: "acme.units.convert", description: "Convert units" }] });
    expect(await run({ action: "get" })).toMatchObject({
      ok: true,
      result: { toolChoices: [{ id: "acme.units.convert", description: "Convert units" }] },
    });
  });

  it("clears the model and persona when a change names them null, and keeps what it does not name", async () => {
    const { run } = await command();
    await run({ action: "set", changes: { enabled: true, model: { connectionId: "main", model: "small" }, agentId: "writer" } });
    expect(await run({ action: "set", changes: { model: null } })).toMatchObject({ ok: true, result: { config: { agentId: "writer" } } });
    const cleared = (await run({ action: "set", changes: { agentId: null } })) as { result: { config: Record<string, unknown> } };
    expect(cleared.result.config).not.toHaveProperty("model");
    expect(cleared.result.config).not.toHaveProperty("agentId");
  });

  it("refuses a stale revision, an interval outside this owner's choices, and any principal but the operator", async () => {
    const { run } = await command();
    await run({ action: "set", changes: { enabled: true } });
    expect(await run({ action: "set", revision: 1, changes: { tellMe: "digest-only" } })).toMatchObject({
      ok: true,
      result: { revision: 2 },
    });
    expect(await run({ action: "set", revision: 1, changes: { tellMe: "everything-now" } })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(await run({ action: "set", changes: { everyMs: 5 * 60_000 } })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("check interval must be one of") },
    });
    expect(await run({ action: "set", changes: { everyMs: 8 * 60 * 60_000 } })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await run({ action: "get", principalId: "bob" })).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    expect(await run({ action: "get", workspaceId: "elsewhere" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("round-trips instructions with their history, pause and resume, mutes, provider, egress, Check now and the offer", async () => {
    const { run, checked } = await command();
    expect(await run({ action: "run-now" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    await run({ action: "set", changes: { enabled: true } });
    await run({ action: "set-instructions", text: "Tell me if a payment fails" });
    expect(await run({ action: "instructions" })).toEqual({ ok: true, result: { text: "Tell me if a payment fails", revision: 2 } });
    expect(await run({ action: "history" })).toMatchObject({
      ok: true,
      result: { history: [{ revision: 2, text: "Tell me if a payment fails", author: "ipc" }] },
    });
    expect(await run({ action: "pause", forMs: 2 * 60 * 60_000 })).toMatchObject({
      ok: true,
      result: { config: { paused: { reason: "user", until: "2026-10-11T11:00:00.000Z" } } },
    });
    expect(await run({ action: "resume" })).toMatchObject({ ok: true, result: { config: { enabled: true } } });
    expect(((await run({ action: "get" })) as { result: HeartbeatGetAnswer }).result.config.paused).toBeUndefined();
    expect(await run({ action: "mute", prefix: "stripe:test:*" })).toMatchObject({
      ok: true,
      result: { config: { mutes: ["stripe:test:*"] } },
    });
    expect(await run({ action: "unmute", prefix: "stripe:test:*" })).toMatchObject({ ok: true, result: { config: { mutes: [] } } });
    expect(await run({ action: "mute", prefix: "not a key" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await run({ action: "set-provider", providerId: "builtin" })).toMatchObject({
      ok: true,
      result: { config: { providerId: "tavi.heartbeatagent" } },
    });
    expect(await run({ action: "egress", field: "memory", on: true })).toMatchObject({
      ok: true,
      result: { config: { providerEgress: { memory: true, signals: false } } },
    });
    expect(await run({ action: "run-now" })).toEqual({ ok: true, result: { status: "started" } });
    expect(checked()).toBe(1);
    expect(await run({ action: "offer" })).toEqual({ ok: true, result: { dismissed: true } });
    expect(await run({ action: "log" })).toEqual({ ok: true, result: { ticks: [] } });
  });

  it("places the next check again when the workspace's timezone changes", async () => {
    const { run, repositories } = await command();
    await run({ action: "set", changes: { enabled: true, activeHours: { start: "09:00", end: "17:00" } } });
    const before = (await repositories.heartbeats.get("default", "operator"))?.nextTickAt;
    await rescheduleHeartbeat(repositories.heartbeats, {
      workspaceId: "default",
      principalId: "operator",
      timezone: "Asia/Tokyo",
      now: new Date(AT),
    });
    const after = (await repositories.heartbeats.get("default", "operator"))?.nextTickAt;
    expect(after).not.toBe(before);
    // 09:00–17:00 in Tokyo is 00:00–08:00 UTC: its next check falls in that window.
    expect(Number(after?.slice(11, 13))).toBeLessThan(8);
  });

  it("starts a new provider with every egress switch off", async () => {
    const plugin = (id: string) => ({ id, kind: "plugin" as const, receives: ["memory" as const], usesTurns: false, maxTickSeconds: 30 });
    const { run, repositories } = await command({ providers: () => [plugin("acme.heartbeat"), plugin("other.heartbeat")] });
    await run({ action: "set", changes: { enabled: true } });
    await run({ action: "set-provider", providerId: "acme.heartbeat" });
    await run({ action: "egress", field: "memory", on: true });
    // Choosing the same one again keeps what it was allowed.
    await run({ action: "set-provider", providerId: "acme.heartbeat" });
    expect((await repositories.heartbeats.get("default", "operator"))?.config.providerEgress.memory).toBe(true);
    await run({ action: "set-provider", providerId: "other.heartbeat" });
    expect(Object.values((await repositories.heartbeats.get("default", "operator"))?.config.providerEgress ?? {}).every((on) => !on)).toBe(
      true,
    );
  });

  it("takes as extra tools only a loaded plugin's read-only tools", async () => {
    const { run } = await command({ toolChoices: () => [{ id: "acme.read", description: "Reads ACME" }] });
    expect(await run({ action: "set", changes: { extraTools: ["acme.read"] } })).toMatchObject({
      ok: true,
      result: { config: { extraTools: ["acme.read"] } },
    });
    expect(await run({ action: "set", changes: { extraTools: ["heartbeat.status"] } })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("heartbeat.status") },
    });
  });

  it("keeps a saved extra tool whose plugin is not loaded when another is added", async () => {
    let choices = [
      { id: "acme.read", description: "Reads ACME" },
      { id: "globex.read", description: "Reads Globex" },
    ];
    const { run } = await command({ toolChoices: () => choices });
    await run({ action: "set", changes: { extraTools: ["acme.read"] } });
    choices = [{ id: "globex.read", description: "Reads Globex" }];
    expect(await run({ action: "set", changes: { extraTools: ["acme.read", "globex.read"] } })).toMatchObject({
      ok: true,
      result: { config: { extraTools: ["acme.read", "globex.read"] } },
    });
  });

  it("prints every setting in status, a plugin provider's disclosure and egress, and a mod's decision in the log", async () => {
    const { run, repositories } = await command({
      providers: () => [{ id: "acme.heartbeat", kind: "plugin", receives: ["signals", "memory"], usesTurns: false, maxTickSeconds: 30 }],
    });
    await run({ action: "set", changes: { enabled: true, fetchHosts: ["example.com"], disabledSources: ["held"] } });
    await run({ action: "set-provider", providerId: "acme.heartbeat" });
    await run({ action: "egress", field: "signals", on: true });
    await repositories.heartbeats.setMemo({ workspaceId: "default", principalId: "operator", memo: "notes", now: AT });
    const text = heartbeatStatusText(((await run({ action: "get" })) as { result: HeartbeatGetAnswer }).result);
    for (const line of [
      "Model: the workspace's fast model; persona: none",
      "Limits: ",
      "Extra tools: none",
      "Sites it may read: example.com",
      "Sources turned off: held",
      "Provider notes: 5 bytes",
      "  Heartbeat provider: decides what the heartbeat tells you.",
      "  Receives: signals (off: memory)",
    ])
      expect(text).toContain(line);
    const tick: HeartbeatTickRecord = {
      tickId: "t1",
      workspaceId: "default",
      principalId: "operator",
      kind: "signal",
      wakeReason: "interval",
      outcome: "quiet",
      reason: null,
      pauseReason: null,
      providerId: "acme.heartbeat",
      taskId: null,
      itemsNow: 0,
      itemsLater: 0,
      itemsRetracted: 0,
      inputs: null,
      hookDecisions: [{ key: "billing:1", by: "acme.guard", action: "held back", reason: "Not today" }],
      tokens: 0,
      cacheReadTokens: 0,
      costUsd: null,
      durationMs: 5,
      error: null,
      providerDev: false,
      createdAt: AT,
    };
    expect(heartbeatLogLine(tick)).toContain("· acme.guard held back billing:1 (Not today)");
    expect(heartbeatLogLine({ ...tick, wakeReason: "event", inputs: { memory: [{ recordId: "m1", revisionId: "r1" }] } })).toContain(
      "· woken by an event · used 1 memory",
    );
  });

  it("refuses an egress switch for what the selected provider does not ask to receive", async () => {
    const { run, repositories } = await command({
      providers: () => [{ id: "acme.heartbeat", kind: "plugin", receives: ["signals"], usesTurns: false, maxTickSeconds: 30 }],
    });
    await run({ action: "set", changes: { enabled: true } });
    await run({ action: "set-provider", providerId: "acme.heartbeat" });
    expect(await run({ action: "egress", field: "memory", on: true })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("memory") },
    });
    expect(
      await run({ action: "set", changes: { providerEgress: { instructions: false, signals: true, ledger: true, memory: false } } }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", message: expect.stringContaining("ledger") } });
    expect(await run({ action: "egress", field: "signals", on: true })).toMatchObject({ ok: true });
    // Turning one off is always allowed.
    expect(await run({ action: "egress", field: "memory", on: false })).toMatchObject({ ok: true });
    // A provider not loaded here (saved where it ran, or offline): nothing is turned on for it, since what it asks for cannot be read.
    const saved = await repositories.heartbeats.get("default", "operator");
    await repositories.heartbeats.save({
      workspaceId: "default",
      principalId: "operator",
      config: { ...(saved?.config ?? defaultHeartbeatConfig()), providerId: "gone.heartbeat" },
      expectedRevision: saved?.config.revision ?? 0,
      author: "test",
      now: AT,
    });
    expect(await run({ action: "egress", field: "signals", on: true })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("not loaded") },
    });
  });

  it("never snoozes or mutes a settled item back to life, and refuses a provider that is not installed", async () => {
    const { run, repositories } = await command();
    await run({ action: "set", changes: { enabled: true } });
    await repositories.heartbeats.tellItems({
      workspaceId: "default",
      principalId: "operator",
      now: AT,
      items: [
        {
          itemId: "hbi-1",
          hash: "h",
          heldBack: false,
          buttonToken: "abcdefghijklmnop",
          item: { key: "billing:1", urgency: "now", title: "A payment failed", sources: [{ label: "Billing" }] },
        },
      ],
    });
    await run({ action: "items", itemId: "hbi-1", op: "mute" });
    // A stale card's Snooze on a muted item: answered as it is.
    expect(await run({ action: "items", itemId: "hbi-1", op: "snooze", minutes: 60 })).toMatchObject({
      ok: true,
      result: { item: { state: "muted" } },
    });
    // A snooze that ran out (still "snoozed" until told again) may be snoozed afresh.
    await repositories.heartbeats.tellItems({
      workspaceId: "default",
      principalId: "operator",
      now: AT,
      items: [
        {
          itemId: "hbi-2",
          hash: "h",
          heldBack: false,
          buttonToken: "bcdefghijklmnopq",
          item: { key: "billing:2", urgency: "now", title: "Another", sources: [{ label: "Billing" }] },
        },
      ],
    });
    await repositories.heartbeats.setItemState({
      workspaceId: "default",
      principalId: "operator",
      itemId: "hbi-2",
      state: "snoozed",
      snoozedUntil: "2026-10-11T08:00:00.000Z",
      now: AT,
    });
    expect(await run({ action: "items", itemId: "hbi-2", op: "snooze", minutes: 60 })).toMatchObject({
      ok: true,
      result: { item: { state: "snoozed", snoozedUntil: "2026-10-11T10:00:00.000Z" } },
    });
    // One still running is not cut short by a stale card's Snooze.
    await repositories.heartbeats.setItemState({
      workspaceId: "default",
      principalId: "operator",
      itemId: "hbi-2",
      state: "snoozed",
      snoozedUntil: "2026-10-12T09:00:00.000Z",
      now: AT,
    });
    expect(await run({ action: "items", itemId: "hbi-2", op: "snooze", minutes: 60 })).toMatchObject({
      ok: true,
      result: { item: { snoozedUntil: "2026-10-12T09:00:00.000Z" } },
    });
    expect(await run({ action: "set-provider", providerId: "acme.heartbaet" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("acme.heartbaet") },
    });
    expect(await run({ action: "set-provider", providerId: "off" })).toMatchObject({ ok: true });
  });

  it("refuses a daily token limit no check could run under, and a timed pause over the heartbeat's own", async () => {
    const { run, repositories } = await command();
    await run({ action: "set", changes: { enabled: true } });
    expect(await run({ action: "set", changes: { budget: { modelTicksPerDay: 24, tokensPerDay: 50_000 } } })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT", message: expect.stringContaining("80,000") },
    });
    await repositories.heartbeats.setPaused({ workspaceId: "default", principalId: "operator", paused: { reason: "failures" }, now: AT });
    expect(await run({ action: "pause", forMs: 60 * 60_000 })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", message: expect.stringContaining("failures") },
    });
    // Untimed, it is the person's own pause from then on.
    expect(await run({ action: "pause" })).toMatchObject({ ok: true, result: { config: { paused: { reason: "user" } } } });
  });

  it("ends a provider pause when the same provider is chosen again", async () => {
    const { run, repositories } = await command();
    await run({ action: "set", changes: { enabled: true } });
    await run({ action: "set-provider", providerId: "acme.heartbeat" });
    await repositories.heartbeats.setPaused({ workspaceId: "default", principalId: "operator", paused: { reason: "provider" }, now: AT });
    await run({ action: "set-provider", providerId: "acme.heartbeat" });
    expect((await repositories.heartbeats.get("default", "operator"))?.config.paused).toBeUndefined();
  });

  it("leaves what a mod held back out of what it told lately, and un-mutes an item", async () => {
    const { run, repositories } = await command();
    await run({ action: "set", changes: { enabled: true } });
    const told = (key: string, filtered = false) => ({
      itemId: `hbi-${key}`,
      hash: "h",
      heldBack: false,
      buttonToken: "abcdefghijklmnop",
      ...(filtered ? { filtered: true } : {}),
      item: { key, urgency: "now" as const, title: key, sources: [{ label: "Billing" }] },
    });
    await repositories.heartbeats.tellItems({ workspaceId: "default", principalId: "operator", now: AT, items: [told("shown")] });
    await repositories.heartbeats.tellItems({
      workspaceId: "default",
      principalId: "operator",
      now: "2026-10-11T09:05:00.000Z",
      items: [told("held", true)],
    });
    // The newer held-back item takes no place in the list: the one it told still fills it.
    expect(await run({ action: "recent", limit: 1 })).toMatchObject({ ok: true, result: { items: [{ itemId: "hbi-shown" }] } });
    // Undo only undoes: a held-back item is not made told.
    expect(await run({ action: "items", itemId: "hbi-held", op: "unmute" })).toMatchObject({
      ok: true,
      result: { item: { state: "filtered" } },
    });
    await run({ action: "items", itemId: "hbi-shown", op: "mute" });
    expect(await run({ action: "items", itemId: "hbi-shown", op: "unmute" })).toMatchObject({
      ok: true,
      result: { item: { state: "told" } },
    });
  });

  it("clears the memo and a provider pause when the provider changes", async () => {
    const { run, repositories } = await command();
    await run({ action: "set", changes: { enabled: true } });
    await repositories.heartbeats.setMemo({ workspaceId: "default", principalId: "operator", memo: "notes", now: AT });
    await repositories.heartbeats.setPaused({ workspaceId: "default", principalId: "operator", paused: { reason: "provider" }, now: AT });
    await run({ action: "set-provider", providerId: "acme.heartbeat" });
    const state = await repositories.heartbeats.get("default", "operator");
    expect(state?.memo).toBeUndefined();
    expect(state?.config.paused).toBeUndefined();
  });

  it("gives 👍/👎, snoozes, unsnoozes and mutes one item, and forgets the history", async () => {
    const { run, repositories } = await command();
    await run({ action: "set", changes: { enabled: true } });
    await repositories.heartbeats.tellItems({
      workspaceId: "default",
      principalId: "operator",
      now: AT,
      items: [
        {
          itemId: "hbi-1",
          hash: "h",
          heldBack: false,
          buttonToken: "abcdefghijklmnop",
          item: { key: "billing:1", urgency: "now", title: "A payment failed", sources: [{ label: "Billing" }] },
        },
      ],
    });
    expect(await run({ action: "items", itemId: "hbi-1", op: "feedback", feedback: "down" })).toMatchObject({
      ok: true,
      result: { item: { feedback: "down" } },
    });
    expect(await run({ action: "items", itemId: "hbi-1", op: "snooze", minutes: 60 })).toMatchObject({
      ok: true,
      result: { item: { state: "snoozed", snoozedUntil: "2026-10-11T10:00:00.000Z" } },
    });
    expect(await run({ action: "items", itemId: "hbi-1", op: "unsnooze" })).toMatchObject({
      ok: true,
      result: { item: { state: "told" } },
    });
    expect(await run({ action: "items", itemId: "hbi-1", op: "mute" })).toMatchObject({ ok: true, result: { item: { state: "muted" } } });
    expect(await run({ action: "items", itemId: "nope", op: "mute" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await run({ action: "item", itemId: "hbi-1" })).toMatchObject({
      ok: true,
      result: { item: { itemId: "hbi-1", title: "A payment failed", state: "muted", feedback: "down" } },
    });
    expect(await run({ action: "item", itemId: "nope" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await run({ action: "recent" })).toMatchObject({ ok: true, result: { items: [{ itemId: "hbi-1" }] } });
    expect(await run({ action: "recent", principalId: "bob" })).toMatchObject({ ok: false, error: { code: "NOT_AUTHORIZED" } });
    // The item is muted: Forget keeps a "Don't tell me".
    expect(await run({ action: "forget" })).toMatchObject({ ok: true, result: { removed: { items: 0 } } });
    expect(await run({ action: "item", itemId: "hbi-1" })).toMatchObject({ ok: true, result: { item: { state: "muted" } } });
  });

  it("leaves the provider to set-provider: a settings change cannot name one", () => {
    expect(HeartbeatPayloadSchema.safeParse({ action: "set", changes: { providerId: "acme.heartbeat" } }).success).toBe(false);
    expect(HeartbeatPayloadSchema.safeParse({ action: "set", changes: { tellMe: "digest-only" } }).success).toBe(true);
  });

  it("writes edited instructions over the revision they were read at, so a change made meanwhile is refused", () => {
    const base = { action: "edit" as const, workspaceId: "default", format: "text" as const };
    expect(heartbeatPayload(base, { choices: HEARTBEAT_PRODUCTION_OPTIONS, instructions: "x", readRevision: 4 })).toEqual({
      action: "set-instructions",
      workspaceId: "default",
      revision: 4,
      text: "x",
    });
    expect(
      heartbeatPayload({ ...base, revision: 2 }, { choices: HEARTBEAT_PRODUCTION_OPTIONS, instructions: "x", readRevision: 4 }),
    ).toMatchObject({ revision: 2 });
    // Read before any save: held to revision 0, so a first save made while editing is refused.
    expect(heartbeatPayload(base, { choices: HEARTBEAT_PRODUCTION_OPTIONS, instructions: "x", readRevision: 0 })).toMatchObject({
      revision: 0,
    });
  });

  it("offers the first run only before anything is saved, and something is watched; Turn on saves revision 1", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    stores.push(store);
    let watched = "Scheduled runs that fail\n";
    const deps: HeartbeatCommandDependencies = {
      repositories: store.asPort().repositories,
      principalOf: () => "operator",
      options: HEARTBEAT_PRODUCTION_OPTIONS,
      providers: () => [],
      host: () => undefined,
      offerInstructions: async () => (watched === "" ? undefined : watched),
      author: "ipc",
      now: () => new Date(AT),
    };
    const run = (payload: Parameters<typeof heartbeatCommand>[1]) => heartbeatCommand(deps, payload);
    const offer = async (): Promise<HeartbeatGetAnswer["offer"]> =>
      ((await run({ action: "get", offer: true })) as { result: HeartbeatGetAnswer }).result.offer;
    expect(await offer()).toEqual({ instructions: "Scheduled runs that fail\n" });
    // Only asked for: a plain read runs no source.
    expect(((await run({ action: "get" })) as { result: HeartbeatGetAnswer }).result.offer).toBeUndefined();
    watched = "";
    expect(await offer()).toBeUndefined();
    watched = "Scheduled runs that fail\n";
    expect(await run({ action: "start", revision: 0, instructions: "Scheduled runs that fail\n" })).toMatchObject({
      ok: true,
      result: { revision: 1, config: { enabled: true, instructions: "Scheduled runs that fail\n" } },
    });
    // A second press (or a stale card) is refused, never a second save.
    expect(await run({ action: "start", revision: 0, instructions: "Something else\n" })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
    expect(await offer()).toBeUndefined();
    // Turned off again, it is not offered again: it was asked once.
    await run({ action: "set", changes: { enabled: false } });
    expect(await offer()).toBeUndefined();
  });

  it("keeps Not now across a restart of the owner", async () => {
    const directory = directories.create("tavi-heartbeat-offer-");
    const databasePath = join(directory, "tavi.db");
    const deps = (store: SqliteStore): HeartbeatCommandDependencies => ({
      repositories: store.asPort().repositories,
      principalOf: () => "operator",
      options: HEARTBEAT_PRODUCTION_OPTIONS,
      providers: () => [],
      host: () => undefined,
      offerInstructions: async () => "Scheduled runs that fail\n",
      author: "ipc",
      now: () => new Date(AT),
    });
    const first = await SqliteStore.open({ databasePath });
    expect(await heartbeatCommand(deps(first), { action: "get", offer: true })).toMatchObject({
      ok: true,
      result: { offer: { instructions: "Scheduled runs that fail\n" } },
    });
    await heartbeatCommand(deps(first), { action: "offer" });
    await first.close();
    const second = await SqliteStore.open({ databasePath });
    try {
      expect(
        ((await heartbeatCommand(deps(second), { action: "get", offer: true })) as { result: HeartbeatGetAnswer }).result.offer,
      ).toBeUndefined();
    } finally {
      await second.close();
    }
  });

  it("snaps a duration to the nearest choice, refusing one outside them", () => {
    expect(nearestHeartbeatInterval(50 * 60_000, HEARTBEAT_PRODUCTION_OPTIONS.every)).toBe(60 * 60_000);
    expect(nearestHeartbeatInterval(20 * 60_000, HEARTBEAT_PRODUCTION_OPTIONS.every)).toBe(15 * 60_000);
    expect(nearestHeartbeatInterval(5 * 60_000, HEARTBEAT_PRODUCTION_OPTIONS.every)).toBeUndefined();
    expect(nearestHeartbeatInterval(5 * 60 * 60_000, HEARTBEAT_PRODUCTION_OPTIONS.every)).toBeUndefined();
  });
});

describe("tavi heartbeat on the data directory", () => {
  it("turns it on, tunes it, edits its instructions from a file, pauses, reads its log and forgets, with a stale revision refused", async () => {
    const at = ["--data-dir", directories.create()];
    const status = await tavi(["heartbeat", "status", ...at]);
    expect(status.code, status.stderr).toBe(EXIT.ok);
    expect(status.stdout).toContain("Heartbeat: off (never saved; these are the defaults)");
    expect((await tavi(["heartbeat", "on", ...at])).stdout).toContain("Heartbeat: on");
    expect((await tavi(["heartbeat", "every", "50m", ...at])).stdout).toContain("Checks every 1h");
    expect((await tavi(["heartbeat", "every", "3m", ...at])).code).toBe(EXIT.usage);
    expect((await tavi(["heartbeat", "hours", "09:00-17:00", "--days", "mon-fri", ...at])).stdout).toContain("09:00–17:00");
    expect((await tavi(["heartbeat", "tell", "digest-only", ...at])).stdout).toContain("only in the summary");
    const file = join(directories.create(), "instructions.md");
    writeFileSync(file, "Tell me if a payment fails\nWatch the Globex renewal\n");
    expect((await tavi(["heartbeat", "edit", "--file", file, ...at])).stdout).toContain("Instructions: 2 line(s)");
    const json = JSON.parse((await tavi(["heartbeat", "status", "--format", "json", ...at])).stdout) as HeartbeatGetAnswer;
    expect(json.config).toMatchObject({
      enabled: true,
      everyMs: 60 * 60_000,
      activeHours: { start: "09:00", end: "17:00" },
      daysOfWeek: [1, 2, 3, 4, 5],
      tellMe: "digest-only",
    });
    const stale = await tavi(["heartbeat", "off", "--revision", "1", ...at]);
    expect(stale.code).toBe(EXIT.usage);
    expect(stale.stderr).toContain("changed since revision 1");
    expect((await tavi(["heartbeat", "off", "--revision", String(json.revision), ...at])).stdout).toContain("Heartbeat: off");
    expect((await tavi(["heartbeat", "pause", "--for", "2h", ...at])).stdout).toContain("paused: user");
    expect((await tavi(["heartbeat", "resume", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["heartbeat", "mute", "stripe:test:*", ...at])).stdout).toContain("Mutes: stripe:test:*");
    expect((await tavi(["heartbeat", "egress", "memory", "on", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["heartbeat", "log", ...at])).stdout).toContain("No checks yet.");
    expect((await tavi(["heartbeat", "run-now", ...at])).code).toBe(EXIT.unavailable);
    expect((await tavi(["heartbeat", "forget", ...at])).code).toBe(EXIT.usage);
    expect((await tavi(["heartbeat", "forget", "--yes", ...at])).stdout).toContain("Its settings stay.");
  });

  it("exits 2 for the owner's refusals: pause before the first save, and a write held to a revision a first save overtook", async () => {
    const at = ["--data-dir", directories.create()];
    expect((await tavi(["heartbeat", "pause", ...at])).code).toBe(EXIT.usage);
    // A first save made meanwhile: a write held to revision 0 is refused, never written over it.
    expect((await tavi(["heartbeat", "on", ...at])).code).toBe(EXIT.ok);
    const stale = await tavi(["heartbeat", "tell", "digest-only", "--revision", "0", ...at]);
    expect(stale.code).toBe(EXIT.usage);
    expect(stale.stderr).toContain("changed since revision 0");
  });

  it("refuses an unknown action, a missing argument and a bad duration with usage", async () => {
    for (const argv of [
      ["heartbeat", "sometimes"],
      ["heartbeat", "every"],
      ["heartbeat", "pause", "--for", "soon"],
      ["heartbeat", "pause", "--for", "30d"],
      ["heartbeat", "egress", "memory", "maybe"],
    ]) {
      expect((await tavi(argv)).code, argv.join(" ")).toBe(EXIT.usage);
    }
  });
});

const owners = useAttachedOwners("tavi-heartbeat-ipc-");

describe("tavi heartbeat under a live owner", ATTACHED, () => {
  it("round-trips over IPC, saying when the owner runs no host to check now on", async () => {
    // This owner sweeps nothing (scheduleSweepEnabled: false), so it runs no heartbeat host; Check now on one is the command's test above.
    const { handle, directory: dataDirectory } = await owners.startOwner(turns([]));
    const at = ["--data-dir", dataDirectory];
    const on = await tavi(["heartbeat", "on", ...at]);
    expect(on.code, on.stderr).toBe(EXIT.ok);
    expect(on.stdout).toContain("Host: not running here");
    expect((await handle.runtime.store.asPort().repositories.heartbeats.get("default", "operator"))?.config.enabled).toBe(true);
    expect((await tavi(["heartbeat", "edit", "--file", "/dev/null", ...at])).code).toBe(EXIT.ok);
    expect((await tavi(["heartbeat", "every", "3m", ...at])).code).toBe(EXIT.usage);
    const checked = await tavi(["heartbeat", "run-now", ...at]);
    expect(checked.code).toBe(EXIT.unavailable);
    expect(checked.stderr).toContain("tavi serve");
    expect((await tavi(["heartbeat", "on", "--revision", "99", ...at])).code).toBe(EXIT.usage);
    expect((await tavi(["heartbeat", "log", "--format", "json", ...at])).code).toBe(EXIT.ok);
  });
});

describe("the editor heartbeat edit opens", () => {
  it("is split into its words, quoted ones kept whole, and run with no shell", () => {
    expect(editorWords("vi")).toEqual(["vi"]);
    expect(editorWords("code --wait")).toEqual(["code", "--wait"]);
    expect(editorWords('"C:\\Program Files\\Editor\\edit.exe" -w')).toEqual(["C:\\Program Files\\Editor\\edit.exe", "-w"]);
    expect(editorWords("'/opt/my editor/bin/ed' --new-window")).toEqual(["/opt/my editor/bin/ed", "--new-window"]);
    // A shell's own syntax is a word like any other: nothing runs it.
    expect(editorWords("vi; rm -rf ~")).toEqual(["vi;", "rm", "-rf", "~"]);
  });

  const stdin = { readStdin: () => "" };

  it("is run with the file's path as its last argument, and what it wrote is sent", () => {
    // The Node already running stands in for an editor: it appends to the file it is given.
    const editor = `"${process.execPath}" -e "require('node:fs').appendFileSync(process.argv.at(-1), ' and more')"`;
    expect(editedInstructions({}, "Check the inbox", { ...stdin, editor })).toBe("Check the inbox and more");
  });

  it("is reported as not started when it cannot be found, and nothing is saved", () => {
    expect(() => editedInstructions({}, "Check the inbox", { ...stdin, editor: "tavi-no-such-editor" })).toThrow(/could not be started/);
  });
});
