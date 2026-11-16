import type { MemoryItem, MemoryListAnswer, MemoryPayload } from "@tavi/contracts";
import { MemoryService } from "@tavi/runtime";
import { describe, expect, it } from "vitest";

import { UsageError } from "../../src/cli/argv.js";
import { parseArgs } from "../../src/cli/parse.js";
import { memoryCommand } from "../../src/features/memory/owner.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * *Past* and *Keep longer* through the `memory` owner command: ended facts, kept, and expired preferences and lessons, each
 * with when it is erased; a new end date returns an expired one to approved.
 * `tavi memory list --past` and `tavi memory correct --until` send the same.
 */

const operator = { principalId: "operator", workspaceId: "default", caller: "test", authority: "operator" } as const;
const DAY = 86_400_000;

async function fixture() {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const memory = new MemoryService(store.asPort());
  const deps = {
    memory,
    repositories: store.asPort().repositories,
    principalOf: () => "operator",
    fromBridge: true,
    now: () => new Date(),
    timeZoneOf: async () => "UTC",
  };
  const run = async <T>(payload: MemoryPayload): Promise<T> => {
    const answer = await memoryCommand(deps, payload);
    if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`);
    return answer.result as T;
  };
  return { store, memory, deps, run };
}

describe("Past and Keep longer", () => {
  it("lists ended facts and expired preferences under Past, not the expired proposal, and Keep longer returns one to approved", async () => {
    const { memory, deps, run } = await fixture();
    const yesterday = new Date(Date.now() - DAY).toISOString();
    const trip = await memory.remember({
      actor: operator,
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "Travelling to Lisbon",
      validTo: yesterday,
    });
    const spanish = await memory.remember({
      actor: operator,
      scope: { kind: "personal", principalId: "operator" },
      kind: "preference",
      body: "Reply in Spanish",
      preferenceKey: "reply.language",
      preference: { valueType: "string", value: "es" },
      expiryAt: yesterday,
    });
    const lapsed = await memory.propose({
      actor: operator,
      scope: { kind: "personal", principalId: "operator" },
      kind: "fact",
      body: "Never decided",
      validTo: yesterday,
    });
    await memory.sweepExpired({ actor: operator });

    const past = await run<MemoryListAnswer>({ action: "list", past: true });
    expect(past.records.map((record) => [record.recordId, record.status]).sort()).toEqual(
      [
        [spanish.recordId, "expired"],
        [trip.recordId, "approved"],
      ].sort(),
    );
    expect(past.records.find((record) => record.recordId === lapsed.recordId)).toBeUndefined();
    // An expired one says when it is erased; an ended fact is kept, so it says nothing of the kind.
    const expired = past.records.find((record) => record.recordId === spanish.recordId);
    expect(expired?.erasesAt).toBeDefined();
    expect(past.records.find((record) => record.recordId === trip.recordId)?.erasesAt).toBeUndefined();
    // Past is listed on its own.
    expect(await memoryCommand(deps, { action: "list", past: true, statuses: ["approved"] })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });

    // Keep longer: through the day given, in the workspace's zone, and the expired preference is approved again.
    const later = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    const kept = await run<MemoryItem>({ action: "correct", recordId: spanish.recordId, until: later });
    expect(kept).toMatchObject({ status: "approved", expiryAt: new Date(Date.parse(`${later}T00:00:00.000Z`) + DAY).toISOString() });
    // `null` keeps the fact with no end: it is memory in force again.
    const open = await run<MemoryItem>({ action: "correct", recordId: trip.recordId, until: null });
    expect(open.validTo).toBeUndefined();
    expect((await run<MemoryListAnswer>({ action: "list", past: true })).records).toEqual([]);
    // A date already past is refused.
    expect(await memoryCommand(deps, { action: "correct", recordId: trip.recordId, until: "2020-01-01" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("refuses what it can't write, the same with or without an owner", () => {
    const refused =
      (...argv: string[]) =>
      () =>
        parseArgs(["memory", ...argv]);
    expect(refused("correct", "r1", "--value", "")).toThrow("--value can't be blank");
    expect(refused("correct", "r1", "--body", "   ")).toThrow("--body can't be blank");
    expect(refused("remember", "--key", "lang", "--kind", "preference", "--value", " ")).toThrow("--value can't be blank");
    expect(refused("remember", "--body", "")).toThrow("--body can't be blank");
    expect(refused("correct", "r1")).toThrow("A correction needs a new title, body, value or end date");
    expect(refused("remember", "--kind", "preference", "--key", "lang")).toThrow("--value is required alongside --key");
    expect(refused("remember", "--kind", "fact", "--key", "lang", "--body", "x")).toThrow("--key/--value only apply to --kind preference");
    expect(refused("remember", "--kind", "nonsense", "--body", "x")).toThrow("--kind must be one of preference, fact, lesson, summary");
    for (const refusal of [refused("remember", "--kind", "nonsense", "--body", "x"), refused("correct", "r1", "--value", "")]) {
      expect(refusal).toThrow(UsageError);
    }
  });

  it("parses `tavi memory list --past` and `tavi memory correct --until <date|none>`", () => {
    expect(parseArgs(["memory", "list", "--past"])).toMatchObject({ command: "memory", memory: { action: "list", past: true } });
    expect(parseArgs(["memory", "correct", "mem-1", "--until", "2026-10-17"])).toMatchObject({
      command: "memory",
      memory: { action: "correct", recordId: "mem-1", until: "2026-10-17" },
    });
    expect(parseArgs(["memory", "correct", "mem-1", "--until", "none"])).toMatchObject({
      command: "memory",
      memory: { action: "correct", until: null },
    });
    expect(() => parseArgs(["memory", "proposals", "--past"])).toThrow(/does not accept --past/);
  });
});
