import { CENTER_CHANGE_KINDS, CENTER_WATCH_DEFAULT_TIMEOUT_MS, type CenterChangeKind, type CenterSummaryAnswer } from "@tavi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FEED_RETRY_MAX_MS, FEED_RETRY_MS, followCenter } from "../../../src/features/center/feed.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";

/**
 * The Command Center's feed loop: the summary,
 * then long polls from its cursor, a refetch whenever something changed, a
 * growing wait after failures, and a stop the moment the page lets go.
 */

const summary = (cursor: string, overrides: Partial<CenterSummaryAnswer> = {}): CenterSummaryAnswer => ({
  workspaceId: "default",
  timezone: "Europe/Berlin",
  today: "2026-09-29",
  counts: { approvals: 0, reviews: 0, questions: 0, runningTasks: 0, memoryProposals: 0, activeRoutines: 0, schedules: 0 },
  perDay: [{ date: "2026-09-29", tasks: 0 }],
  next: [],
  people: {},
  cursor,
  ...overrides,
});

type Answer =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** An owner that answers from a script, in order; once it runs out, the page lets go. */
function scripted(answers: Answer[]) {
  const controller = new AbortController();
  const calls: { readonly payload: Record<string, unknown>; readonly timeoutMs: number | undefined }[] = [];
  const client: SettingsClient = {
    request: async (_command, payload, options) => {
      calls.push({ payload: payload as Record<string, unknown>, timeoutMs: options?.timeoutMs });
      const next = answers.shift();
      if (next === undefined) {
        controller.abort();
        return { ok: true, result: { cursor: "end", changed: [] } } as never;
      }
      return next as never;
    },
  };
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  return { client, calls, waits, sleep, signal: controller.signal, controller };
}

const ok = (result: unknown): Answer => ({ ok: true, result });
const refused = (code: string, message = "refused"): Answer => ({ ok: false, error: { code, message } });

function recorder() {
  const seen: string[] = [];
  const changed: CenterChangeKind[][] = [];
  const failures: (string | undefined)[] = [];
  return {
    seen,
    changed,
    failures,
    handlers: {
      summary: (value: CenterSummaryAnswer) => void seen.push(value.cursor),
      changed: (kinds: readonly CenterChangeKind[]) => void changed.push([...kinds]),
      failed: (message: string | undefined) => void failures.push(message),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the Command Center feed", () => {
  it("reads the summary, watches from its cursor, and refetches when something changed", async () => {
    const owner = scripted([
      ok(summary("c1")),
      ok({ cursor: "c1", changed: [] }),
      ok({ cursor: "c2", changed: ["task", "approval"] }),
      ok(summary("c2b")),
    ]);
    const seen = recorder();
    await followCenter(owner.client, "default", seen.handlers, owner.signal, owner.sleep);
    expect(owner.calls.map((call) => call.payload)).toEqual([
      { action: "summary", workspaceId: "default" },
      { action: "watch", workspaceId: "default", cursor: "c1", timeoutMs: CENTER_WATCH_DEFAULT_TIMEOUT_MS },
      { action: "watch", workspaceId: "default", cursor: "c1", timeoutMs: CENTER_WATCH_DEFAULT_TIMEOUT_MS },
      { action: "summary", workspaceId: "default" },
      // The watch's cursor, not the refetched summary's.
      { action: "watch", workspaceId: "default", cursor: "c2", timeoutMs: CENTER_WATCH_DEFAULT_TIMEOUT_MS },
    ]);
    // A quiet poll is an answer, not a timeout: the request waits longer than the owner does.
    expect(owner.calls[1]?.timeoutMs).toBeGreaterThan(CENTER_WATCH_DEFAULT_TIMEOUT_MS);
    expect(seen.seen).toEqual(["c1", "c2b"]);
    expect(seen.changed).toEqual([["task", "approval"]]);
    expect(owner.waits).toEqual([]);
  });

  it("waits longer after each failure, up to its ceiling, and starts over after a success", async () => {
    const owner = scripted([
      refused("UNAVAILABLE"),
      refused("UNAVAILABLE"),
      refused("UNAVAILABLE"),
      refused("UNAVAILABLE"),
      refused("UNAVAILABLE", "still down"),
      ok(summary("c1")),
      refused("TIMEOUT"),
    ]);
    const seen = recorder();
    await followCenter(owner.client, "default", seen.handlers, owner.signal, owner.sleep);
    expect(owner.waits).toEqual([FEED_RETRY_MS, 10_000, 20_000, FEED_RETRY_MAX_MS, FEED_RETRY_MAX_MS, FEED_RETRY_MS]);
    expect(seen.failures).toContain("still down");
    // Current again once the summary reads.
    expect(seen.failures[seen.failures.indexOf("still down") + 1]).toBeUndefined();
    // A failed watch keeps its cursor: the next watch asks from the same place.
    expect(owner.calls.at(-1)?.payload).toMatchObject({ action: "watch", cursor: "c1" });
  });

  it("drops a cursor the owner refuses, reads a new summary, and reports everything as changed", async () => {
    const owner = scripted([ok(summary("c1")), refused("INVALID_INPUT"), ok(summary("c9"))]);
    const seen = recorder();
    await followCenter(owner.client, "default", seen.handlers, owner.signal, owner.sleep);
    expect(owner.calls.map((call) => call.payload["action"])).toEqual(["summary", "watch", "summary", "watch"]);
    expect(owner.calls.at(-1)?.payload["cursor"]).toBe("c9");
    expect(seen.changed).toEqual([[...CENTER_CHANGE_KINDS]]);
  });

  it("asks nothing more once the page lets go, and reports nothing that arrives after", async () => {
    const owner = scripted([ok(summary("c1"))]);
    const seen = recorder();
    const client: SettingsClient = {
      request: async (command, payload, options) => {
        const answer = await owner.client.request(command, payload, options);
        // The page unmounts while the first answer is on its way.
        owner.controller.abort();
        return answer;
      },
    };
    await followCenter(client, "default", seen.handlers, owner.signal, owner.sleep);
    expect(owner.calls).toHaveLength(1);
    expect(seen.seen).toEqual([]);
  });

  it("resyncs, reporting every kind as changed, when the summary after a change cannot be read", async () => {
    const owner = scripted([ok(summary("c1")), ok({ cursor: "c2", changed: ["task"] }), refused("UNAVAILABLE", "down"), ok(summary("c3"))]);
    const seen = recorder();
    await followCenter(owner.client, "default", seen.handlers, owner.signal, owner.sleep);
    expect(owner.calls.map((call) => call.payload["action"])).toEqual(["summary", "watch", "summary", "summary", "watch"]);
    expect(owner.waits).toEqual([FEED_RETRY_MS]);
    expect(seen.seen).toEqual(["c1", "c3"]);
    expect(seen.changed).toEqual([["task"], [...CENTER_CHANGE_KINDS]]);
    expect(owner.calls.at(-1)?.payload["cursor"]).toBe("c3");
  });

  it("reads the summary again after a quiet watch once the workspace zone's date has moved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 23:59:50 in Berlin on the 29th.
    vi.setSystemTime(new Date("2026-09-29T21:59:50.000Z"));
    const owner = scripted([
      ok(summary("c1")),
      ok({ cursor: "c1", changed: [] }),
      ok({ cursor: "c1", changed: [] }),
      ok(summary("c1b", { today: "2026-09-30" })),
      ok({ cursor: "c1", changed: [] }),
    ]);
    const seen = recorder();
    let watches = 0;
    const client: SettingsClient = {
      request: async (command, payload, options) => {
        // The second watch returns after Berlin's midnight.
        if ((payload as Record<string, unknown>)["action"] === "watch" && ++watches === 2)
          vi.setSystemTime(new Date("2026-09-29T22:00:10.000Z"));
        return owner.client.request(command, payload, options);
      },
    };
    await followCenter(client, "default", seen.handlers, owner.signal, owner.sleep);
    expect(owner.calls.map((call) => call.payload["action"])).toEqual(["summary", "watch", "watch", "summary", "watch", "watch"]);
    expect(seen.seen).toEqual(["c1", "c1b"]);
    // A new day is not a change the sections refetch for.
    expect(seen.changed).toEqual([]);
  });
});
