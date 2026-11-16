import type { CenterWatchAnswer } from "@tavi/contracts";
import { MemoryService } from "@tavi/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { centerCommand, type CenterDependencies } from "../../src/server/center.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * The Center's watch, woken by the store's write signal: it answers as soon
 * as a write moves the Center, and a quiet store costs it no reads.
 */

const stores: SqliteStore[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
});

async function owner() {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  stores.push(store);
  const repositories = store.asPort().repositories;
  let reads = 0;
  const deps: CenterDependencies = {
    repositories: {
      ...repositories,
      center: {
        ...repositories.center,
        summary: (input) => repositories.center.summary(input),
        changes: async (input) => {
          reads += 1;
          return await repositories.center.changes(input);
        },
      },
    },
    memory: new MemoryService(store.asPort()),
    principalOf: () => "operator",
    now: () => new Date("2026-10-16T09:00:00.000Z"),
    onWrite: (listener) => store.onWrite(listener),
    intervalMs: 20,
  };
  const watch = async (cursor?: string, timeoutMs?: number): Promise<CenterWatchAnswer> => {
    const answer = await centerCommand(deps, {
      action: "watch",
      ...(cursor === undefined ? {} : { cursor }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    if (!answer.ok) throw new Error(answer.error.message);
    return answer.result as CenterWatchAnswer;
  };
  return { store, repositories, watch, reads: () => reads };
}

describe("the Center watch", () => {
  it("answers a waiting watch as soon as a write moves the Center", async () => {
    const { repositories, watch } = await owner();
    const { cursor } = await watch();
    const started = performance.now();
    const waiting = watch(cursor, 20_000);
    await repositories.reminders.create({
      reminderId: "rem-1",
      workspaceId: "default",
      principalId: "operator",
      text: "Call the dentist",
      when: { kind: "once", at: "2026-10-17T09:00:00.000Z" },
      timezone: "UTC",
      deliverTo: { kind: "app" },
      createdBy: "user",
      operationKey: "op-1",
      now: "2026-10-16T09:00:00.000Z",
    });
    const answer = await waiting;
    expect(answer.changed.length).toBeGreaterThan(0);
    expect(answer.cursor).not.toBe(cursor);
    // Long before the quiet fallback read: the write woke it.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("reads nothing more while nothing is written, and answers unchanged when its time is up", async () => {
    const { watch, reads } = await owner();
    const { cursor } = await watch();
    const before = reads();
    const answer = await watch(cursor, 1_000);
    expect(answer).toEqual({ cursor, changed: [] });
    // Its first read only, where a timed watch read every `intervalMs` (20 ms here).
    expect(reads() - before).toBe(1);
  });
});
