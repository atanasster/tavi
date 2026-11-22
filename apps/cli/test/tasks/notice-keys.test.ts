import { localizedText, type AdmissionResult, type RoutineRun, type ScheduleRecord, type TextRef } from "@tavi/contracts";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { describe, expect, it } from "vitest";

import { noticeWordRefs, noticeWords } from "../../src/features/mcp/notices.js";
import { createRoutineNotices } from "../../src/features/routines/notices.js";
import { scheduledBudgetNotices } from "../../src/features/schedules/budget-notice.js";
import { createRefusalCounter } from "../../src/features/schedules/trigger-limits.js";
import { createChatNotices, type ChatNoticeDependencies } from "../../src/features/tasks/notices.js";
import { SqliteStore } from "../support/database-fixture.js";
import { fixturePromptPolicy } from "../support/prompt-policy.js";

/** Notices and fire outcomes keep their keys beside the English they always stored, so a reader sees them in their language. */

const AT = "2026-11-22T08:00:00.000Z";
const bg = coreIn("bg");

async function fixture() {
  const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
  const repositories = store.asPort().repositories;
  const task = async (taskId: string, extra: { readonly chatKind?: "home" | "side"; readonly parentChatId?: string } = {}) => {
    const written = await repositories.tasks.admit({
      prompt: fixturePromptPolicy,
      workspaceId: "w1",
      principalId: "alice",
      operationKey: `op-${taskId}`,
      kind: "start",
      intent: { prompt: "earlier" },
      checkpointNamespace: "",
      ...(extra.chatKind === undefined ? {} : { chatKind: extra.chatKind }),
      ...(extra.parentChatId === undefined ? {} : { parentChatId: extra.parentChatId }),
      newTaskId: taskId,
      newAdmissionId: `adm-${taskId}`,
      newThreadId: `thread-${taskId}`,
      now: AT,
    });
    return written;
  };
  let id = 0;
  const deps: ChatNoticeDependencies = {
    repositories: {
      ...repositories,
      reminders: { get: async () => undefined } as never,
      workspaceSettings: { get: async () => ({ settings: { homeChat: true } }) } as never,
    },
    homeOf: async () => "home-1",
    isLocalConnection: () => false,
    newId: () => `notice-${(id += 1)}`,
    now: () => AT,
    log: () => undefined,
  };
  return { store, repositories, task, notices: createChatNotices(deps) };
}

describe("notices keep their keys", () => {
  it("stores a schedule's result, a reminder and an epoch by key, with the English as before", async () => {
    const { repositories, task, notices, store } = await fixture();
    try {
      await task("home-1", { chatKind: "home" });
      await task("run-1");
      const schedule = { scheduleId: "s-1", name: "Morning brief", workspaceId: "w1", principalId: "alice" } as ScheduleRecord;
      const admission: AdmissionResult = {
        taskId: "run-1",
        threadId: "t",
        created: true,
        replay: false,
        outcome: { status: "completed", finalText: "Three meetings today." },
      };
      await notices.deliverSchedule(schedule, admission);
      await notices.postReminder({
        reminder: { reminderId: "r1", workspaceId: "w1", principalId: "alice" },
        fire: { fireAt: AT },
        text: "Take your pills",
        taskId: "run-1",
      });
      await notices.postEpoch("home-1", { epoch: 2, folded: 3 });
      const [result, reminder, epoch] = await repositories.transcripts.notices("home-1", { limit: 10 });
      expect(result).toMatchObject({
        title: "Scheduled run “Morning brief”",
        summary: "Completed\nThree meetings today.",
        titleRef: { key: "notice.schedule.result.title", params: { name: "Morning brief" } },
        summaryRef: {
          key: "notice.schedule.result.summary",
          params: { status: { key: "notice.status.completed" }, text: "Three meetings today." },
        },
      });
      expect(localizedText(result?.title ?? "", result?.titleRef, bg)).toBe("Пускане по график „Morning brief“");
      expect(localizedText(result?.summary ?? "", result?.summaryRef, bg)).toBe("Завършено\nThree meetings today.");
      expect(reminder).toMatchObject({
        title: "Reminder",
        summary: "Take your pills (its task started)",
        titleRef: { key: "notice.reminder.title" },
        summaryRef: { key: "notice.reminder.summary.taskStarted", params: { text: "Take your pills" } },
      });
      expect(epoch).toMatchObject({ title: "Epoch 2 began", titleRef: { key: "notice.epoch.title", params: { epoch: "2" } } });
      expect(localizedText(epoch?.summary ?? "", epoch?.summaryRef, bg)).toBe(
        "3 по-ранни съобщения са обобщени; не можаха да се запазят в архив.",
      );
    } finally {
      await store.close();
    }
  });

  it("stores a side chat's settle by key, its renamed title a parameter", async () => {
    const { repositories, task, notices, store } = await fixture();
    try {
      await task("home-1", { chatKind: "home" });
      await task("side-1", { chatKind: "side", parentChatId: "home-1" });
      await notices.onTaskEnded("side-1");
      const [settled] = await repositories.transcripts.notices("home-1", { limit: 10 });
      expect(settled?.titleRef).toEqual({ key: "notice.sideChat.title.id", params: { id: "side-1" } });
      expect(settled?.summaryRef?.key).toMatch(/^notice\.status\./);
      expect(localizedText(settled?.title ?? "", settled?.titleRef, bg)).toBe("Страничният чат side-1 приключи");
    } finally {
      await store.close();
    }
  });

  it("passes a routine's notice to Home by key, with the menu path a key of its own", async () => {
    const posted: { title: string; summary: string; titleRef?: TextRef; summaryRef?: TextRef }[] = [];
    const notices = createRoutineNotices({
      routines: {
        get: async () => ({ routine: { name: "News" } }),
        target: async () => {
          throw new Error("no targets");
        },
      },
      messaging: { send: async () => ({ status: "accepted", retryable: false, parts: [] }), buildDestination: () => undefined },
      postHome: async (input) => {
        posted.push(input);
        return true;
      },
      log: () => undefined,
    });
    const run = {
      runId: "run-1",
      routineId: "routine-1",
      workspaceId: "w1",
      principalId: "alice",
      claimedAt: AT,
      snapshot: { agent: { name: "News" }, execution: { credentialGraceHours: 48, failureThreshold: 3 }, delivery: { targetIds: [] } },
    } as unknown as RoutineRun;
    expect(await notices.runPaused(run, "failures" as never)).toBe(true);
    expect(posted[0]).toMatchObject({
      title: "Routine “News” paused",
      summary:
        "Routine “News” paused after 3 failed runs in a row; its run history says why. Resume it in Center → Schedule, or ask Tavi in chat to resume it.",
      titleRef: { key: "notice.routine.paused.title", params: { name: "News" } },
    });
    expect(posted[0]?.summaryRef?.params?.["resume"]).toEqual({
      key: "notice.routine.resumeHint",
      params: { path: { key: "nav.path.two", params: { first: { key: "nav.route.center" }, second: { key: "nav.center.schedule" } } } },
    });
  });

  it("says an MCP server's notice by key exactly as its English words", () => {
    const notice = {
      pluginId: "mcp.files",
      kind: "drift" as const,
      detail: { withheld: ["read", "write"], added: ["list"], instructions: true, rules: ["read"] },
    };
    const refs = noticeWordRefs(notice);
    const words = noticeWords(notice);
    expect(words.summary).toBe(
      "2 changed and withheld (read, write); 1 new, waiting for review; its instructions changed (nothing withheld; read them in the review). Allow rules still cover read. Review with `tavi mcp review mcp.files`.",
    );
    expect(localizedText(words.title, refs.title, bg)).toBe("mcp.files: инструментите му се промениха");
    expect(localizedText(words.summary, refs.summary, bg)).toMatch(/^2 променени и задържани \(read, write\); 1 нови, чакат преглед; /);
  });

  it("tells Home of the month's scheduled work by key", async () => {
    const store = await SqliteStore.open({ databasePath: ":memory:", inMemory: true });
    try {
      const posted: { summary: string; summaryRef?: TextRef; titleRef?: TextRef }[] = [];
      const repositories = store.asPort().repositories;
      await repositories.workspaceSettings.set({
        workspaceId: "default",
        settings: { timezone: "Europe/Sofia", scheduledMonthlyTokenBudget: 1_000_000 },
        expectedRevision: (await repositories.workspaceSettings.get("default")).revision,
        actor: "operator",
        now: AT,
      });
      const notices = scheduledBudgetNotices({
        repositories,
        workspaceIds: () => ["default"],
        principalOf: () => "operator",
        postAlert: async (input) => {
          posted.push(input);
          return true;
        },
        log: () => undefined,
        warn: () => undefined,
      });
      store.handle
        .prepare(
          "INSERT INTO tavi_tasks (task_id, workspace_id, principal_id, thread_id, status, created_at, updated_at, origin) VALUES ('fire-1', 'default', 'operator', 'thread-fire-1', 'completed', ?, ?, 'schedule')",
        )
        .run(AT, AT);
      store.handle
        .prepare(
          "INSERT INTO tavi_provider_attempts (call_id, run_id, attempt_id, owner_session, state, started_at, data, purpose) VALUES ('call-1', 'fire-1', 'attempt-1', 'owner', 'completed', ?, ?, 'generation')",
        )
        .run(AT, JSON.stringify({ usage: { totalTokens: 900_000 } }));
      await notices(AT);
      expect(posted).toHaveLength(1);
      expect(posted[0]?.titleRef).toEqual({ key: "notice.scheduledBudget.title" });
      expect(posted[0]?.summaryRef?.key).toBe("notice.scheduledBudget.summary");
      expect(posted[0]?.summary).toMatch(
        /^Your schedules and routines have used 900,000 tokens of a 1,000,000-token monthly budget \(90%\)/,
      );
      expect(localizedText(posted[0]?.summary ?? "", posted[0]?.summaryRef, bg)).toMatch(/^Графиците и рутините ти са използвали /);
    } finally {
      await store.close();
    }
  });

  it("records a refused webhook call's ledger row by key", async () => {
    const recorded: { outcome: string; outcomeRef?: TextRef }[] = [];
    const refuse = createRefusalCounter<"auth">({
      schedules: {
        recordFire: async (input: { outcome: string; outcomeRef?: TextRef }) => {
          recorded.push(input);
        },
      } as never,
      reasonCode: "webhook-refused",
      label: "webhook",
      noun: ["call", "calls"],
      logMessage: "refused",
      nowMs: () => Date.parse(AT),
      now: () => AT,
      log: () => undefined,
    });
    await refuse({ scheduleId: "s-1" }, "auth");
    expect(recorded[0]).toMatchObject({ outcome: "webhook refused 1 call this hour (1 auth)" });
    expect(localizedText(recorded[0]?.outcome ?? "", recorded[0]?.outcomeRef, bg)).toBe("уебхукът отказа 1 извикване този час (1 auth)");
  });
});
