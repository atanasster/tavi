import { join } from "node:path";
import { temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT, main } from "../../src/main.js";
import { scheduledWorkThisMonth } from "../../src/features/schedules/actions.js";
import { scheduledBudgetNotices } from "../../src/features/schedules/budget-notice.js";
import { capture } from "../support/attached-owner.js";
import { SqliteStore } from "../support/database-fixture.js";

/**
 * A workspace's scheduled work this month: summed in its zone, shown by
 * `tavi doctor`, and told once a month in Home when it reaches 80% of the
 * workspace's `scheduled.monthlyTokenBudget`. Nothing is stopped.
 */

const directories = temporaryDirectories({ prefix: "tavi-scheduled-budget-" });
afterEach(() => directories.cleanup());

/** A schedule-fired task and one model call of it at `startedAt` that used `tokens`. */
function scheduledCall(store: SqliteStore, taskId: string, startedAt: string, tokens: number, origin = "schedule"): void {
  store.handle
    .prepare(
      "INSERT OR IGNORE INTO tavi_tasks (task_id, workspace_id, principal_id, thread_id, status, created_at, updated_at, origin) VALUES (?, 'default', 'operator', ?, 'completed', ?, ?, ?)",
    )
    .run(taskId, `thread-${taskId}`, startedAt, startedAt, origin);
  store.handle
    .prepare(
      "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, data, purpose) VALUES (?, ?, ?, 'owner', 'completed', ?, ?, 'generation')",
    )
    .run(`call-${taskId}-${startedAt}`, taskId, `attempt-${startedAt}`, startedAt, JSON.stringify({ usage: { totalTokens: tokens } }));
}

async function openStore(directory: string): Promise<SqliteStore> {
  return SqliteStore.open({ databasePath: join(directory, "tavi.sqlite"), artifactsDirectory: join(directory, "artifacts") });
}

async function config(directory: string, ...args: string[]): Promise<void> {
  const out = capture();
  expect(await main(["config", ...args, "--data-dir", directory], { io: out.io }), out.stderr()).toBe(EXIT.ok);
}

describe("scheduled work's monthly budget", () => {
  it("tells Home once a month at 80%, never below it, never with no budget, and again in the next month", async () => {
    const directory = directories.create();
    await config(directory, "set", "workspace.timezone", "Europe/Sofia");
    const store = await openStore(directory);
    try {
      const posted: { sourceKey: string; summary: string }[] = [];
      const told: string[] = [];
      const notices = scheduledBudgetNotices({
        repositories: store.asPort().repositories,
        workspaceIds: () => ["default"],
        principalOf: () => "operator",
        postAlert: async (input) => {
          posted.push({ sourceKey: input.sourceKey, summary: input.summary });
          return true;
        },
        log: (message) => told.push(message),
        warn: (message) => told.push(message),
      });
      // With no budget, nothing is summed or told, however much was spent.
      scheduledCall(store, "fire-1", "2026-10-10T05:00:00.000Z", 700_000);
      await notices("2026-10-20T12:00:00.000Z");
      expect(posted).toEqual([]);

      await store.asPort().repositories.workspaceSettings.set({
        workspaceId: "default",
        settings: { timezone: "Europe/Sofia", scheduledMonthlyTokenBudget: 1_000_000 },
        expectedRevision: (await store.asPort().repositories.workspaceSettings.get("default")).revision,
        actor: "operator",
        now: "2026-10-20T12:00:00.000Z",
      });
      // 70% is below the notice; a chat's spending would take it past, but a chat is not scheduled work.
      scheduledCall(store, "chat", "2026-10-11T05:00:00.000Z", 500_000, "web");
      await notices("2026-10-20T12:00:00.000Z");
      expect(posted).toEqual([]);
      scheduledCall(store, "fire-2", "2026-10-12T05:00:00.000Z", 100_000);
      await notices("2026-10-20T12:00:00.000Z");
      await notices("2026-10-20T12:10:00.000Z");
      expect(posted).toEqual([
        {
          sourceKey: "scheduled-budget:default:2026-10",
          summary: expect.stringMatching(
            /^Your schedules and routines have used 800,000 tokens of a 1,000,000-token monthly budget \(80%\) for 2026-10\. Nothing is stopped\./,
          ),
        },
      ]);
      // November in Sofia starts at 22:00 UTC on 31 October: a new month starts from nothing.
      scheduledCall(store, "fire-3", "2026-10-31T22:30:00.000Z", 850_000);
      await notices("2026-10-31T22:40:00.000Z");
      expect(posted.map((notice) => notice.sourceKey)).toEqual(["scheduled-budget:default:2026-10", "scheduled-budget:default:2026-11"]);
      expect(posted[1]?.summary).toContain("850,000 tokens of a 1,000,000-token monthly budget (85%)");
      expect(told).toEqual([]);

      const month = await scheduledWorkThisMonth(store.asPort().repositories, "default", new Date("2026-10-20T12:00:00.000Z"));
      expect(month).toEqual({
        month: "2026-10",
        timezone: "Europe/Sofia",
        since: "2026-09-30T21:00:00.000Z",
        until: "2026-10-31T22:00:00.000Z",
        tokens: 800_000,
        usd: null,
        budget: 1_000_000,
        percent: 80,
      });
    } finally {
      await store.close();
    }
  });

  it("marks a month told only once its notice is posted, and one workspace's failure leaves the others checked", async () => {
    const directory = directories.create();
    await config(directory, "set", "workspace.timezone", "UTC");
    await config(directory, "set", "scheduled.monthlyTokenBudget", "1000");
    const store = await openStore(directory);
    try {
      scheduledCall(store, "fire-1", "2026-10-10T05:00:00.000Z", 900);
      const settings = store.asPort().repositories.workspaceSettings;
      await settings.set({
        workspaceId: "broken",
        settings: { scheduledMonthlyTokenBudget: 1000 },
        expectedRevision: (await settings.get("broken")).revision,
        actor: "operator",
        now: "2026-10-20T12:00:00.000Z",
      });
      const posted: string[] = [];
      const warned: unknown[] = [];
      let principal: string | undefined;
      let failPost = true;
      const notices = scheduledBudgetNotices({
        repositories: store.asPort().repositories,
        workspaceIds: () => ["broken", "default"],
        principalOf: (workspaceId) => {
          if (workspaceId === "broken") throw new Error("no such workspace");
          return principal;
        },
        postAlert: async (input) => {
          if (failPost) throw new Error("Home write failed");
          posted.push(input.sourceKey);
          return true;
        },
        log: () => undefined,
        warn: (_message, fields) => warned.push(fields["workspaceId"]),
      });
      // No principal yet: skipped, not marked.
      await notices("2026-10-20T12:00:00.000Z");
      principal = "operator";
      // The post fails: logged, not marked; the broken workspace never stops the default one being tried.
      await notices("2026-10-20T12:10:00.000Z");
      expect(posted).toEqual([]);
      failPost = false;
      await notices("2026-10-20T12:20:00.000Z");
      await notices("2026-10-20T12:30:00.000Z");
      expect(posted).toEqual(["scheduled-budget:default:2026-10"]);
      expect(warned).toEqual(["broken", "broken", "default", "broken", "broken"]);
    } finally {
      await store.close();
    }
  });

  it("is a workspace setting, off unless set", async () => {
    const directory = directories.create();
    const shown = capture();
    expect(await main(["config", "get", "scheduled.monthlyTokenBudget", "--data-dir", directory], { io: shown.io })).toBe(EXIT.ok);
    expect(shown.stdout()).toBe("scheduled.monthlyTokenBudget = none (default)\n");
    const set = capture();
    expect(await main(["config", "set", "scheduled.monthlyTokenBudget", "2_000_000", "--data-dir", directory], { io: set.io })).toBe(
      EXIT.ok,
    );
    expect(set.stdout()).toBe("scheduled.monthlyTokenBudget = 2000000 tokens a month (set)\n");
    for (const bad of ["999", "lots", "-5"]) {
      const refused = capture();
      expect(await main(["config", "set", "scheduled.monthlyTokenBudget", bad, "--data-dir", directory], { io: refused.io }), bad).toBe(
        EXIT.usage,
      );
    }
    await config(directory, "unset", "scheduled.monthlyTokenBudget");
    const cleared = capture();
    expect(await main(["config", "get", "scheduled.monthlyTokenBudget", "--data-dir", directory], { io: cleared.io })).toBe(EXIT.ok);
    expect(cleared.stdout()).toBe("scheduled.monthlyTokenBudget = none (default)\n");
  });

  it("is shown by tavi doctor: this month's tokens and dollars, and the budget's share once set", async () => {
    const directory = directories.create();
    await config(directory, "set", "workspace.timezone", "UTC");
    const doctor = async () => {
      const out = capture();
      expect(await main(["doctor", "--data-dir", directory], { io: out.io }), out.stderr()).toBe(EXIT.ok);
      return (JSON.parse(out.stdout()) as { scheduledWork: Record<string, unknown> }).scheduledWork;
    };
    const month = new Date().toISOString().slice(0, 7);
    expect(await doctor()).toEqual({ month, timezone: "UTC", tokens: 0, usd: 0 });
    const store = await openStore(directory);
    try {
      scheduledCall(store, "fire-1", new Date().toISOString(), 900);
    } finally {
      await store.close();
    }
    await config(directory, "set", "scheduled.monthlyTokenBudget", "1000");
    expect(await doctor()).toEqual({
      month,
      timezone: "UTC",
      tokens: 900,
      usd: "unknown",
      budget: 1000,
      percent: 90,
      warning: "scheduled work used 90% of this month's 1000-token budget",
    });
  });
});
