// @vitest-environment jsdom
import type { AgendaAnswer, CenterSummaryAnswer, ReminderFire, ReminderFireView, ReminderView } from "@tavi/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CenterRail } from "../../../src/features/center/CenterRail.js";
import { SOURCE_LABELS, sourceOf, waitingCount } from "../../../src/features/center/model.js";
import {
  agendaReminderText,
  eventLine,
  localToInstant,
  noticeLabel,
  repeatText,
  whenText,
} from "../../../src/features/center/reminder-model.js";
import { NOTIFIED_STORAGE_KEY, UnseenReminderCards, useReminderNotifications } from "../../../src/features/center/ReminderNotifications.js";
import { doneEntries } from "../../../src/features/center/ReminderRows.js";
import { forgetChatTitles } from "../../../src/features/center/reminders-api.js";
import { Schedule } from "../../../src/features/center/Schedule.js";
import { UNDO_DELETE_MS } from "../../../src/features/center/UndoDelete.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { close, offeredWords, open, pick, selected } from "../../pick.js";
import { InWorkspace } from "../../support/workspace.js";
import { clickSettled as click, mountSettled as mount, rerender, settle, unmountAll } from "../../support/dom.js";

/**
 * Reminders in the Command Center: their
 * rows in Schedule, the New reminder form, a reminder's page, the rail's
 * unseen cards, the notification opt-in, and the Activity chip.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  forgetChatTitles();
  // A delete waiting outlives Schedule: leaving the page makes it, so the next test starts with none.
  window.dispatchEvent(new Event("pagehide"));
});
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
});

async function type(input: Element | null | undefined, value: string): Promise<void> {
  if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) throw new Error("no input");
  const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (page: ParentNode, label: string): HTMLButtonElement | undefined =>
  [...page.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );

const summary: CenterSummaryAnswer = {
  workspaceId: "default",
  timezone: "Europe/Berlin",
  today: "2026-09-29",
  counts: {
    approvals: 0,
    reviews: 0,
    questions: 0,
    runningTasks: 0,
    memoryProposals: 0,
    activeRoutines: 0,
    schedules: 0,
    reminders: 3,
    unseenReminders: 1,
  },
  perDay: [{ date: "2026-09-29", tasks: 0 }],
  next: [{ kind: "reminder", id: "rem-pills", title: "Take your pills", at: "2026-09-29T19:00:00.000Z" }],
  people: { operator: "Ana", bob: "Bob" },
  cursor: "c1",
};

const stamp = "2026-09-20T10:00:00.000Z";
function reminder(overrides: Partial<ReminderView> & Pick<ReminderView, "reminderId" | "text" | "when">): ReminderView {
  return {
    workspaceId: "default",
    principalId: "operator",
    timezone: "Europe/Berlin",
    deliverTo: { kind: "app" },
    status: "active",
    nextFireAt: null,
    lastFiredAt: null,
    createdBy: "user",
    operationKey: `op-${overrides.reminderId}`,
    createdAt: stamp,
    updatedAt: stamp,
    upcoming: [],
    ...overrides,
  };
}

const pills = reminder({
  reminderId: "rem-pills",
  text: "Take your pills",
  when: { kind: "repeat", times: ["21:00"] },
  nextFireAt: "2026-09-29T19:00:00.000Z",
  lastFiredAt: "2026-09-28T19:00:00.000Z",
  createdBy: "agent",
  originTaskId: "task-chat",
  upcoming: [{ at: "2026-09-29T19:00:00.000Z", occurrence: "repeat" }],
});
const stretch = reminder({
  reminderId: "rem-stretch",
  text: "Stretch",
  principalId: "bob",
  status: "paused",
  when: { kind: "repeat", times: ["19:00", "07:00"], daysOfWeek: [1, 2, 3, 4, 5], until: "2026-12-31" },
});
const dentist = reminder({
  reminderId: "rem-dentist",
  text: "Dentist appointment",
  when: { kind: "event", at: "2026-10-05T08:00:00.000Z", notify: ["-1d@20:00", "-1h"] },
  nextFireAt: "2026-10-04T18:00:00.000Z",
  upcoming: [
    { at: "2026-10-04T18:00:00.000Z", occurrence: "notice", noticeOffset: "-1d@20:00" },
    { at: "2026-10-05T07:00:00.000Z", occurrence: "notice", noticeOffset: "-1h" },
  ],
});

const agenda: AgendaAnswer = {
  timezone: "Europe/Berlin",
  items: [
    {
      kind: "reminder",
      id: "rem-call",
      title: "Call mum",
      at: "2026-09-29T16:00:00.000Z",
      cadence: { kind: "once" },
      enabled: true,
      principalId: "operator",
      reminder: { cadence: "once" },
    },
    {
      kind: "reminder",
      id: "rem-pills",
      title: "Take your pills",
      at: "2026-09-29T19:00:00.000Z",
      cadence: { kind: "daily", at: "21:00", timezone: "Europe/Berlin" },
      enabled: true,
      principalId: "operator",
      reminder: { cadence: "repeat", times: ["21:00"] },
    },
    {
      kind: "reminder",
      id: "rem-stretch",
      title: "Stretch",
      at: "2026-09-30T05:00:00.000Z",
      cadence: { kind: "daily", at: "07:00", timezone: "Europe/Berlin", daysOfWeek: [1, 2, 3, 4, 5] },
      enabled: true,
      principalId: "bob",
      reminder: { cadence: "repeat", times: ["07:00", "19:00"], until: "2026-12-31" },
    },
    {
      kind: "reminder",
      id: "rem-dentist",
      title: "Dentist appointment",
      at: "2026-10-04T18:00:00.000Z",
      cadence: { kind: "once" },
      enabled: true,
      principalId: "operator",
      reminder: { cadence: "event", eventAt: "2026-10-05T08:00:00.000Z", notice: "-1d@20:00" },
    },
  ],
  truncated: false,
  skipped: [],
};

const recent = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const paid = reminder({
  reminderId: "rem-invoice",
  text: "Pay the invoice",
  status: "done",
  when: { kind: "once", at: recent(4) },
  lastFiredAt: recent(4),
  updatedAt: recent(4),
});
const old = reminder({
  reminderId: "rem-old",
  text: "Long ago",
  status: "done",
  when: { kind: "once", at: recent(60) },
  lastFiredAt: recent(60),
  updatedAt: recent(60),
});
const missed: ReminderFireView = {
  reminderId: "rem-pills",
  workspaceId: "default",
  principalId: "operator",
  text: "Take your pills",
  fireAt: recent(2),
  firedAt: recent(2),
  outcome: "missed",
  occurrence: "repeat",
};

interface Asked {
  readonly command: string;
  readonly payload: Record<string, unknown>;
}

/** An owner answering Schedule's lists and the reminders command, recording what it was asked. */
function owner(
  options: {
    readonly agenda?: AgendaAnswer;
    readonly active?: readonly ReminderView[];
    readonly refuseCreate?: string;
    readonly fires?: readonly ReminderFireView[];
    readonly targets?: readonly Record<string, unknown>[];
  } = {},
) {
  const asked: Asked[] = [];
  const active = options.active ?? [pills, stretch, dentist];
  const client: SettingsClient = {
    request: async (command, raw) => {
      const payload = raw as Record<string, unknown>;
      asked.push({ command, payload });
      const action = payload["action"];
      if (command === "reminders" && action === "create" && options.refuseCreate !== undefined)
        return { ok: false, error: { code: "INVALID_INPUT", message: options.refuseCreate } } as never;
      if (command === "reminders" && action === "snooze") {
        const fireAt = (payload["fireAt"] as string | undefined) ?? "2026-09-29T19:00:00.000Z";
        const snoozed: ReminderFire = {
          reminderId: String(payload["reminderId"]),
          fireAt,
          firedAt: fireAt,
          outcome: "snoozed",
          occurrence: "repeat",
          acknowledgedAt: fireAt,
          snoozedUntil: "2026-09-29T19:10:00.000Z",
        };
        return {
          ok: true,
          result: {
            reminder: pills,
            snoozed,
            followUp: {
              reminderId: snoozed.reminderId,
              fireAt: "2026-09-29T19:10:00.000Z",
              firedAt: null,
              outcome: "pending",
              occurrence: "repeat",
            },
          },
        } as never;
      }
      const statuses = payload["statuses"] as readonly string[] | undefined;
      const result =
        command === "schedules" && action === "preview"
          ? { timezone: payload["timezone"], text: "", runs: ["2026-10-05T06:00:00.000Z"] }
          : command === "schedules" && action === "agenda"
            ? (options.agenda ?? agenda)
            : command === "schedules" && action === "list"
              ? { schedules: [], truncated: false }
              : command === "routines" && action === "list"
                ? { routines: [] }
                : command === "reminders" && action === "list"
                  ? { timezone: "Europe/Berlin", reminders: statuses?.includes("done") ? [paid, old] : active }
                  : command === "reminders" && action === "fires"
                    ? { fires: payload["status"] === "unseen" ? [] : (options.fires ?? [missed]) }
                    : command === "routines" && action === "targets"
                      ? { targets: options.targets ?? [] }
                      : command === "reminders" && action === "get"
                        ? {
                            reminder: pills,
                            fires: [
                              {
                                reminderId: "rem-pills",
                                fireAt: "2026-09-28T19:00:00.000Z",
                                firedAt: "2026-09-28T19:05:00.000Z",
                                outcome: "delivered-in-app",
                                occurrence: "repeat",
                                late: true,
                              },
                            ],
                          }
                        : command === "reminders" && action === "create"
                          ? { reminder: dentist, created: true, skippedNotices: [] }
                          : command === "reminders" && (action === "pause" || action === "resume" || action === "cancel")
                            ? {
                                reminder: {
                                  ...pills,
                                  status: action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "active",
                                },
                              }
                            : command === "reminders" && action === "acknowledge"
                              ? {
                                  fire: {
                                    reminderId: payload["reminderId"],
                                    fireAt: payload["fireAt"],
                                    firedAt: payload["fireAt"],
                                    outcome: "delivered-in-app",
                                    occurrence: "repeat",
                                    acknowledgedAt: "2026-09-29T19:01:00.000Z",
                                  },
                                }
                              : command === "tasks"
                                ? {
                                    task: { taskId: "task-chat" },
                                    admissions: [
                                      { state: "applied", intent: { prompt: "Remind me to take my pills every evening\nat nine" } },
                                    ],
                                  }
                                : {};
      return { ok: true, result } as never;
    },
  };
  return { client, asked };
}

const schedule = (client: SettingsClient, extra: Partial<React.ComponentProps<typeof Schedule>> = {}) => (
  <InWorkspace client={client} workspaceId="default">
    <Schedule
      summary={summary}
      revision={0}
      reminders
      onOpenRoutine={() => undefined}
      onOpenReminder={() => undefined}
      onFollow={async () => undefined}
      {...extra}
    />
  </InWorkspace>
);

describe("reminders in Schedule's Coming up", () => {
  it("shows each reminder with an amber square node, its label and its cadence", async () => {
    const page = await mount(schedule(owner().client));
    await click(page.querySelector(".schedule-more"));
    const rows = [...page.querySelectorAll(".schedule-item-reminder")];
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.querySelector(".schedule-kind")?.textContent)).toEqual(["Reminder", "Reminder", "Reminder", "Reminder"]);
    expect(rows.map((row) => row.querySelector(".schedule-cadence")?.textContent)).toEqual([
      "Once",
      "Daily 21:00",
      "Mon–Fri 07:00, 19:00 · until 31 Dec",
      "Event Mon 5 Oct 10:00 · the evening before at 20:00",
    ]);
    // Each opens the reminder's page.
    expect(rows[0]?.querySelector("a.schedule-title")?.getAttribute("href")).toBe("/center/schedule/reminders/rem-call");
    // More than one person has reminders: each says whose it is.
    expect(rows[2]?.textContent).toContain("for Bob");
    expect(rows[1]?.textContent).toContain("for Ana");
  });

  it("says where the agent was asked for it", async () => {
    const followed: string[] = [];
    const page = await mount(schedule(owner().client, { onFollow: async (taskId) => void followed.push(taskId) }));
    const pillsRow = [...page.querySelectorAll(".schedule-item-reminder")][1];
    const origin = pillsRow?.querySelector(".reminder-origin");
    expect(origin?.textContent).toBe("Added from Remind me to take my pills every evening");
    await click(origin?.querySelector("a"));
    expect(followed).toEqual(["task-chat"]);
  });

  it("reads its lists again when the feed reports a reminder change", async () => {
    const { client, asked } = owner();
    await mount(schedule(client));
    const lists = () => asked.filter((item) => item.command === "reminders" && item.payload["action"] === "list").length;
    expect(lists()).toBe(2);
    await rerender(schedule(client, { revision: 1 }));
    await act(async () => undefined);
    expect(lists()).toBe(4);
  });
});

describe("reminders in Recurring, Later and Done / missed", () => {
  it("lists repeating reminders with a pause switch, and Delete behind its Undo", async () => {
    const { client, asked } = owner();
    const page = await mount(schedule(client));
    const rows = [...page.querySelectorAll(".schedule-recurring-list .schedule-recurring-reminder")];
    expect(rows.map((row) => row.querySelector(".reminder-title")?.textContent)).toEqual(["Take your pills", "Stretch"]);
    expect(rows[0]?.textContent).toContain("Daily 21:00 · Europe/Berlin");
    expect(rows[1]?.textContent).toContain("Mon–Fri 07:00, 19:00 · until 31 Dec · Europe/Berlin");

    await click(page.querySelector('[role="switch"][aria-label="Pause Take your pills"]'));
    expect(asked).toContainEqual({ command: "reminders", payload: { action: "pause", workspaceId: "default", reminderId: "rem-pills" } });
    await click(page.querySelector('[role="switch"][aria-label="Resume Stretch"]'));
    expect(asked).toContainEqual({
      command: "reminders",
      payload: { action: "resume", workspaceId: "default", reminderId: "rem-stretch" },
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => button(page, "More actions for Take your pills")?.click());
      await act(async () =>
        [...page.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Delete")?.click(),
      );
      expect(asked.some((item) => item.payload["action"] === "cancel")).toBe(false);
      expect(page.querySelector(".undo-toast")?.textContent).toContain("Take your pills deleted.");
      await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS));
    } finally {
      vi.useRealTimers();
    }
    await act(async () => undefined);
    expect(asked).toContainEqual({ command: "reminders", payload: { action: "cancel", workspaceId: "default", reminderId: "rem-pills" } });
    expect(page.textContent).toContain("Take your pills deleted.");
  });

  it("shows an event after this week with its notices, and the done and missed ones of the last 30 days", async () => {
    const later = reminder({ ...dentist, reminderId: "rem-later", nextFireAt: new Date(Date.now() + 20 * 86_400_000).toISOString() });
    const page = await mount(schedule(owner({ active: [pills, later] }).client));
    const laterRow = [...page.querySelectorAll(".schedule-recurring-reminder")].find((row) =>
      row.textContent?.includes("Dentist appointment"),
    );
    expect(laterRow?.querySelector(".schedule-cadence")?.textContent).toBe(
      eventLine(
        dentist.when.kind === "event" ? dentist.when.at : "",
        dentist.upcoming.map((fire) => fire.at),
        "Europe/Berlin",
      ),
    );
    expect(laterRow?.querySelector(".schedule-cadence")?.textContent).toBe("Mon 5 Oct 10:00 · reminds Sun 4 Oct 20:00, Mon 5 Oct 09:00");

    const done = page.querySelector("details.reminder-done");
    expect(done?.hasAttribute("open")).toBe(false);
    expect(done?.querySelector("summary")?.textContent).toContain("Done / missed");
    const entries = [...(done?.querySelectorAll(".reminder-done-item") ?? [])].map(
      (item) => item.querySelector(".reminder-title")?.textContent,
    );
    expect(entries).toEqual(["Take your pills", "Pay the invoice"]);
    expect(done?.textContent).toContain("Missed");
  });
});

describe("a repeating reminder's row", () => {
  it("names the reminder in its More button's label, not its text", async () => {
    const page = await mount(schedule(owner().client));
    const row = [...page.querySelectorAll(".schedule-recurring-reminder")].find((item) => item.textContent?.includes("Take your pills"));
    const more = [...(row?.querySelectorAll("button") ?? [])].find(
      (item) => item.getAttribute("aria-label") === "More actions for Take your pills",
    );
    expect(more?.textContent?.trim()).toBe("More");
    // A reminder cannot be run by hand.
    expect(row?.querySelector('[aria-label^="Run now"]')).toBeNull();
  });

  it("says how its last fire went: missed, failed, or shown in the app", async () => {
    const fire = (
      reminderId: string,
      text: string,
      fireAt: string,
      outcome: ReminderFireView["outcome"],
      extra: Partial<ReminderFireView> = {},
    ): ReminderFireView => ({
      reminderId,
      workspaceId: "default",
      principalId: "operator",
      text,
      fireAt,
      firedAt: fireAt,
      outcome,
      occurrence: "repeat",
      ...extra,
    });
    const fires = [
      // Newest first, as the owner lists them: a snoozed follow-up still to come is not a fire that happened.
      fire("rem-stretch", "Stretch", "2026-09-29T06:10:00.000Z", "pending", { firedAt: null }),
      fire("rem-stretch", "Stretch", "2026-09-29T05:00:00.000Z", "failed"),
      fire("rem-pills", "Take your pills", "2026-09-28T19:00:00.000Z", "delivered-in-app", {
        firedAt: "2026-09-28T19:02:00.000Z",
        late: true,
      }),
      fire("rem-pills", "Take your pills", "2026-09-27T19:00:00.000Z", "missed"),
    ];
    const page = await mount(schedule(owner({ fires }).client));
    const meta = (text: string) =>
      [...page.querySelectorAll(".schedule-recurring-reminder")]
        .find((item) => item.textContent?.includes(text))
        ?.querySelector(".reminder-meta")?.textContent;
    expect(meta("Take your pills")).toContain("Last: Shown in the app Mon 28 Sep 21:02 · late");
    expect(meta("Stretch")).toContain("Last: Failed Tue 29 Sep 07:00");

    unmountAll();
    const missedOnly = await mount(
      schedule(owner({ fires: [fire("rem-pills", "Take your pills", "2026-09-27T19:00:00.000Z", "missed")] }).client),
    );
    const pillsMeta = [...missedOnly.querySelectorAll(".schedule-recurring-reminder")]
      .find((item) => item.textContent?.includes("Take your pills"))
      ?.querySelector(".reminder-meta")?.textContent;
    expect(pillsMeta).toContain("Last: Missed Sun 27 Sep 21:00");
    // No fire listed for it: when it last fired, as the reminder records it.
    const stretchMeta = [...missedOnly.querySelectorAll(".schedule-recurring-reminder")]
      .find((item) => item.textContent?.includes("Stretch"))
      ?.querySelector(".reminder-meta")?.textContent;
    expect(stretchMeta).toContain("Not run yet.");
  });
});

describe("new routines and schedules", () => {
  it("start in the workspace zone, not the browser's", async () => {
    const page = await mount(schedule(owner({ agenda: { ...agenda, timezone: "Asia/Kathmandu" } }).client));
    await click(button(page, "New routine"));
    const routineZone = document.querySelector<HTMLInputElement>('dialog input[aria-label="Time zone"]');
    expect(routineZone?.value).toBe("Asia/Kathmandu");
    expect(routineZone?.closest(".cadence")?.textContent).toContain("(workspace zone)");
    await click(button(document.body, "Cancel"));
    await click(button(page, "New schedule"));
    expect(document.querySelector<HTMLInputElement>('dialog input[aria-label="Time zone"]')?.value).toBe("Asia/Kathmandu");
  });
});

describe("the New reminder form's Deliver to", () => {
  const target = (targetId: string, label: string, extra: Record<string, unknown> = {}) => ({
    targetId,
    workspaceId: "default",
    principalId: "operator",
    connectionId: "telegram-default",
    chatId: `chat-${targetId}`,
    label,
    authorizationRef: "auth-1",
    enabled: true,
    createdAt: stamp,
    authorized: true,
    ...extra,
  });

  it("offers the app and the operator's enabled, authorized delivery targets, and sends the chat picked", async () => {
    const { client, asked } = owner({
      targets: [
        target("t-ana", "Telegram · Ana"),
        target("t-off", "Old chat", { enabled: false }),
        target("t-lost", "Lost chat", { authorized: false }),
      ],
    });
    const page = await mount(schedule(client));
    await click(button(page, "New reminder"));
    const form = page.querySelector("form.reminder-form") ?? page;
    const select = form.querySelector('[aria-label="Deliver to"]');
    await open(select);
    expect(offeredWords()).toEqual(["This app", "Home", "Telegram · Ana"]);
    await close();
    expect(asked).toContainEqual({ command: "routines", payload: { action: "targets", workspaceId: "default" } });
    await pick(select, "t-ana");
    expect(form.querySelector(".reminder-deliver")?.textContent).toContain("Said in Telegram · Ana");
    await type(form.querySelector('input[name="text"]'), "Call the bank");
    await type(form.querySelector('input[name="date"]'), "2026-10-05");
    await type(form.querySelector('input[name="time"]'), "10:00");
    await click(button(form, "Save reminder"));
    const create = asked.find((item) => item.command === "reminders" && item.payload["action"] === "create");
    expect(create?.payload["deliverTo"]).toEqual({ kind: "conversation", connectionId: "telegram-default", conversationId: "chat-t-ana" });
  });

  it("sends no deliverTo for the app, the default", async () => {
    const { client, asked } = owner({ targets: [target("t-ana", "Telegram · Ana")] });
    const page = await mount(schedule(client));
    await click(button(page, "New reminder"));
    const form = page.querySelector("form.reminder-form") ?? page;
    expect(selected(form.querySelector('[aria-label="Deliver to"]'))).toBe("app");
    expect(form.querySelector(".reminder-deliver")?.textContent).toContain("Or pick a chat you added as a delivery target.");
    await type(form.querySelector('input[name="text"]'), "Stretch");
    await type(form.querySelector('input[name="date"]'), "2026-10-05");
    await click(button(form, "Save reminder"));
    const create = asked.find((item) => item.command === "reminders" && item.payload["action"] === "create");
    expect(create?.payload["deliverTo"]).toBeUndefined();
  });

  it("delivers to Home when picked, so a task it starts settles there too", async () => {
    const { client, asked } = owner({ targets: [target("t-ana", "Telegram · Ana")] });
    const page = await mount(schedule(client));
    await click(button(page, "New reminder"));
    const form = page.querySelector("form.reminder-form") ?? page;
    await pick(form.querySelector('[aria-label="Deliver to"]'), "home");
    expect(form.querySelector(".reminder-deliver")?.textContent).toContain("A notice in your Home, and its task's result another");
    await type(form.querySelector('input[name="text"]'), "Check the build");
    await type(form.querySelector('input[name="date"]'), "2026-10-05");
    await click(button(form, "Save reminder"));
    const create = asked.find((item) => item.command === "reminders" && item.payload["action"] === "create");
    expect(create?.payload["deliverTo"]).toEqual({ kind: "home" });
  });
});

describe("the New reminder form", () => {
  it("reads an event's date and time in the workspace zone and sends the default notices", async () => {
    const { client, asked } = owner();
    const page = await mount(schedule(client));
    await click(button(page, "New reminder"));
    const form = page.querySelector("form.reminder-form");
    // The form takes focus on its text, which its visible label names.
    expect(document.activeElement).toBe(form?.querySelector('input[name="text"]'));
    expect(form?.querySelector('input[name="text"]')?.closest("label")?.textContent).toContain("Remind me to");
    expect(form?.querySelector('input[name="text"]')?.hasAttribute("aria-label")).toBe(false);
    expect(form?.textContent).toContain("Deliver to");
    expect(form?.textContent).toContain("ask for the reminder in that chat");
    await type(form?.querySelector('input[name="text"]'), "Dentist appointment");
    await click(form?.querySelector('input[type="radio"][value="event"]'));
    expect([...(form?.querySelectorAll('[aria-label="Notices"] li') ?? [])].map((item) => item.textContent)).toEqual([
      "the evening before at 20:00",
      "1 hour before",
    ]);
    await type(form?.querySelector('input[name="date"]'), "2026-10-05");
    await type(form?.querySelector('input[name="time"]'), "10:00");
    await click(button(form ?? page, "Save reminder"));
    const create = asked.find((item) => item.command === "reminders" && item.payload["action"] === "create");
    expect(create?.payload).toMatchObject({
      workspaceId: "default",
      text: "Dentist appointment",
      // 10:00 in Berlin on 5 October (summer time, UTC+2).
      when: { kind: "event", at: "2026-10-05T08:00:00.000Z", notify: ["-1d@20:00", "-1h"] },
      timezone: "Europe/Berlin",
    });
    expect(String(create?.payload["operationKey"])).toMatch(/^ui:/);
    expect(create?.payload["prompt"]).toBeUndefined();
    expect(page.querySelector("form.reminder-form")).toBeNull();
    expect(page.textContent).toContain("Reminder set.");
    // Focus goes back to the button that opened the form.
    await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    expect(document.activeElement).toBe(button(page, "New reminder"));
  });

  it("builds a repeat with its days, end and task prompt, and edits notices", async () => {
    const { client, asked } = owner();
    const page = await mount(schedule(client));
    await click(button(page, "New reminder"));
    const form = page.querySelector("form.reminder-form") ?? page;
    await type(form.querySelector('input[name="text"]'), "Take your pills");
    await click(form.querySelector('input[type="radio"][value="repeat"]'));
    // A reminder's repeat is days of the week, monthly or yearly at set times: never once, never every few hours.
    expect([...form.querySelectorAll('.cadence [aria-label="Repeats"] label')].map((label) => label.textContent)).toEqual([
      "On days of the week",
      "Monthly",
      "Yearly",
    ]);
    expect(form.querySelector('.cadence [aria-label="Times of day"]')).toBeNull();
    const times = () => [...form.querySelectorAll('.cadence input[type="time"]')];
    await type(times()[0], "20:00");
    await click(button(form, "Add a time"));
    await click(button(form, "Remove time 20:00"));
    await type(times()[0], "08:00");
    await click(button(form, "Add a time"));
    await type(times()[1], "20:00");
    await click(button(form, "Weekdays"));
    for (const day of ["Tuesday", "Thursday"]) await click(form.querySelector(`button:has(abbr[title="${day}"])`));
    await type(form.querySelector('input[aria-label="Until"]'), "2026-12-31");
    await click(
      [...form.querySelectorAll("label")]
        .find((label) => label.textContent === "Also start a task with this prompt")
        ?.querySelector("input"),
    );
    await type(form.querySelector('[aria-label="Task prompt"]'), "Check the pharmacy is open");
    await click(button(form, "Save reminder"));
    expect(asked.find((item) => item.payload["action"] === "create")?.payload).toMatchObject({
      text: "Take your pills",
      when: { kind: "repeat", times: ["08:00", "20:00"], daysOfWeek: [1, 3, 5], until: "2026-12-31" },
      timezone: "Europe/Berlin",
      prompt: "Check the pharmacy is open",
    });
  });

  it("repeats monthly or yearly, in a zone picked for it", async () => {
    const { client, asked } = owner();
    const page = await mount(schedule(client));
    await click(button(page, "New reminder"));
    const form = page.querySelector("form.reminder-form") ?? page;
    await type(form.querySelector('input[name="text"]'), "Pay the rent");
    await click(form.querySelector('input[type="radio"][value="repeat"]'));
    await click(form.querySelector('.cadence input[type="radio"][value="monthly"]'));
    await pick(form.querySelector('[aria-label="Monthly on"]'), "last");
    await type(form.querySelector('input[aria-label="Time zone"]'), "Asia/Tokyo");
    await click(button(form, "Save reminder"));
    expect(asked.find((item) => item.payload["action"] === "create")?.payload).toMatchObject({
      text: "Pay the rent",
      when: { kind: "repeat", times: ["09:00"], monthly: { dayOfMonth: 31 } },
      timezone: "Asia/Tokyo",
    });
    const yearly = await mount(schedule(owner().client));
    await click(button(yearly, "New reminder"));
    const again = yearly.querySelector("form.reminder-form") ?? yearly;
    await type(again.querySelector('input[name="text"]'), "Renew the passport");
    await click(again.querySelector('input[type="radio"][value="repeat"]'));
    await click(again.querySelector('.cadence input[type="radio"][value="yearly"]'));
    await pick(again.querySelector('[aria-label="Month"]'), "2");
    await pick(again.querySelector('[aria-label="Day"]'), "29");
    expect(again.textContent).not.toContain("That month has no such day.");
    await pick(again.querySelector('[aria-label="Day"]'), "30");
    expect(again.querySelector(".cadence-problems")?.textContent).toBe("That month has no such day.");
  });

  it("adds and removes an event's notices, and shows the owner's refusal inline", async () => {
    const { client, asked } = owner({ refuseCreate: "That time is in the past" });
    const page = await mount(schedule(client));
    await click(button(page, "New reminder"));
    const form = page.querySelector("form.reminder-form") ?? page;
    await type(form.querySelector('input[name="text"]'), "Dentist");
    await click(form.querySelector('input[type="radio"][value="event"]'));
    await click(button(form, "Remove notice 1 hour before"));
    await type(form.querySelector('[aria-label="Notice amount"]'), "2");
    await pick(form.querySelector('[aria-label="Notice unit"]'), "d");
    await type(form.querySelector('[aria-label="Notice time"]'), "09:00");
    await click(button(form, "Add notice"));
    expect([...form.querySelectorAll('[aria-label="Notices"] li')].map((item) => item.textContent)).toEqual([
      "the evening before at 20:00",
      "2 days before at 09:00",
    ]);
    await click(button(form, "Save reminder"));
    expect(asked.find((item) => item.payload["action"] === "create")?.payload["when"]).toMatchObject({
      notify: ["-1d@20:00", "-2d@09:00"],
    });
    expect(form.querySelector('[role="alert"]')?.textContent).toBe("That time is in the past");
    expect(page.querySelector("form.reminder-form")).not.toBeNull();
  });
});

describe("a reminder's page", () => {
  it("shows its cadence, next and recent fires, where it was asked, and acts on it", async () => {
    const { client, asked } = owner();
    const followed: string[] = [];
    const page = await mount(schedule(client, { reminderId: "rem-pills", onFollow: async (taskId) => void followed.push(taskId) }));
    expect(asked).toContainEqual({ command: "reminders", payload: { action: "get", workspaceId: "default", reminderId: "rem-pills" } });
    expect(page.querySelector("h1")?.textContent).toBe("Take your pills");
    expect(page.textContent).toContain("Daily 21:00");
    expect(page.textContent).toContain("Tue 29 Sep 21:00");
    expect(page.querySelector(".reminder-fire")?.textContent).toContain("Mon 28 Sep 21:00 · Delivered in the app · late");
    expect(page.querySelector(".reminder-origin")?.textContent).toBe("Added from Remind me to take my pills every evening");
    await click(page.querySelector(".reminder-origin a"));
    expect(followed).toEqual(["task-chat"]);

    await click(button(page, "Snooze 10 min"));
    expect(asked).toContainEqual({
      command: "reminders",
      payload: { action: "snooze", workspaceId: "default", reminderId: "rem-pills", minutes: 10, fireAt: "2026-09-28T19:00:00.000Z" },
    });
    await click(button(page, "Pause"));
    expect(asked).toContainEqual({ command: "reminders", payload: { action: "pause", workspaceId: "default", reminderId: "rem-pills" } });
    // Delete goes back to the lists, where it waits behind its Undo, through leaving Schedule; leaving the page makes it.
    await click(button(page, "Delete"));
    expect(asked.some((item) => item.payload["action"] === "cancel")).toBe(false);
    unmountAll();
    expect(asked.some((item) => item.payload["action"] === "cancel")).toBe(false);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(asked).toContainEqual({ command: "reminders", payload: { action: "cancel", workspaceId: "default", reminderId: "rem-pills" } });
  });

  it("hides a one-off reminder after this week from Later once deleted from its page", async () => {
    const later = reminder({ ...dentist, reminderId: "rem-later", nextFireAt: new Date(Date.now() + 20 * 86_400_000).toISOString() });
    const { client: base } = owner({ active: [pills, later] });
    const client: SettingsClient = {
      request: async (command, raw) =>
        command === "reminders" && (raw as Record<string, unknown>)["action"] === "get"
          ? ({ ok: true, result: { reminder: later, fires: [] } } as never)
          : base.request(command, raw),
    };
    const page = await mount(schedule(client, { reminderId: "rem-later" }));
    await click(button(page, "Delete"));
    await rerender(schedule(client));
    const laterTitles = () => [...page.querySelectorAll(".schedule-recurring-reminder .reminder-title")].map((title) => title.textContent);
    expect(laterTitles()).not.toContain("Dentist appointment");
    await click(button(page, "Undo deleting Dentist appointment"));
    expect(laterTitles()).toContain("Dentist appointment");
  });

  it("says its times in the reminder's own zone, as it names it", async () => {
    const sofia = reminder({
      reminderId: "rem-sofia",
      text: "Call the bank",
      timezone: "Europe/Sofia",
      when: { kind: "once", at: "2026-10-05T08:00:00.000Z" },
      nextFireAt: "2026-10-05T08:00:00.000Z",
      upcoming: [{ at: "2026-10-05T08:00:00.000Z", occurrence: "once" }],
    });
    const client: SettingsClient = {
      request: async (command, raw) => {
        const action = (raw as Record<string, unknown>)["action"];
        if (command === "reminders" && action === "get") return { ok: true, result: { reminder: sofia, fires: [] } } as never;
        return owner().client.request(command, raw);
      },
    };
    const page = await mount(schedule(client, { reminderId: "rem-sofia" }));
    // 08:00 UTC is 11:00 in Sofia (the workspace's Berlin would say 10:00).
    expect(page.querySelector(".settings-description")?.textContent).toContain("Once Mon 5 Oct 11:00 · Europe/Sofia");
    expect(page.querySelector(".reminder-fires time")?.textContent).toBe("Mon 5 Oct 11:00");
  });

  it("says a reminder is not found", async () => {
    const client: SettingsClient = {
      request: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Reminder rem-x does not exist" } }) as never,
    };
    const page = await mount(schedule(client, { reminderId: "rem-x" }));
    expect(page.textContent).toContain("This reminder was not found.");
    expect(page.textContent).not.toContain("rem-x");
  });
});

describe("the empty state", () => {
  it("suggests asking for a reminder in chat", async () => {
    const nothing: AgendaAnswer = { timezone: "Europe/Berlin", items: [], truncated: false, skipped: [] };
    const page = await mount(schedule(owner({ agenda: nothing, active: [] }).client));
    expect(page.querySelector(".empty-state")?.textContent).toContain("Try asking: “remind me to stretch every day at 15:00”");
  });

  it("offers templates, each opening its form filled in, created only when saved", async () => {
    const nothing: AgendaAnswer = { timezone: "Europe/Berlin", items: [], truncated: false, skipped: [] };
    const { client, asked } = owner({ agenda: nothing, active: [] });
    const page = await mount(schedule(client));
    const templates = page.querySelector('.empty-state [role="group"][aria-label="Start from a template"]')!;
    expect([...templates.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "Morning inbox brief",
      "Weekly research digest",
      "Daily stretch reminder",
      "End-of-day wrap-up",
    ]);
    const writes = () => asked.filter((item) => ["create", "add"].includes(String(item.payload["action"])));
    const pressedDays = (scope: ParentNode) =>
      [...scope.querySelectorAll('.cadence button[aria-pressed="true"] abbr[title]')].map((day) => day.getAttribute("title"));

    // A reminder: its text, repeating daily at its time.
    await click(button(templates, "Daily stretch reminder"));
    const form = page.querySelector("form.reminder-form")!;
    expect(form.querySelector<HTMLInputElement>('input[name="text"]')?.value).toBe("Stand up and stretch");
    expect(form.querySelector<HTMLInputElement>('input[value="repeat"]')?.checked).toBe(true);
    expect(form.querySelector<HTMLInputElement>('.cadence input[type="time"]')?.value).toBe("15:00");
    expect(writes()).toEqual([]);
    await click(button(form, "Save reminder"));
    expect(writes().at(-1)?.payload).toMatchObject({ text: "Stand up and stretch", when: { kind: "repeat", times: ["15:00"] } });

    // A routine: its name, objective and day, in the workspace zone.
    await click(button(templates, "Weekly research digest"));
    let dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Create routine");
    expect(dialog.querySelector<HTMLInputElement>("input")?.value).toBe("Weekly research digest");
    expect(dialog.querySelector("textarea")?.value).toContain("large language models");
    expect(pressedDays(dialog)).toEqual(["Monday"]);
    await click(button(dialog, "Cancel"));
    expect(document.querySelector("dialog")).toBeNull();

    // A schedule: its prompt, delivered into Home, on weekdays.
    await click(button(templates, "Morning inbox brief"));
    dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Create schedule");
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Schedule name"]')?.value).toBe("Morning inbox brief");
    expect(dialog.querySelector<HTMLTextAreaElement>('[aria-label="Schedule prompt"]')?.value).toContain("unread email");
    expect(dialog.querySelector('[aria-label="Deliver result to"]')?.textContent).toContain("Home");
    expect(pressedDays(dialog)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
    expect(writes()).toHaveLength(1);
    await act(async () => dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(writes().at(-1)).toMatchObject({
      command: "schedules",
      payload: {
        action: "add",
        name: "Morning inbox brief",
        at: "07:30",
        days: [1, 2, 3, 4, 5],
        timezone: "Europe/Berlin",
        deliverTo: "home",
      },
    });
    expect(page.textContent).toContain("Morning inbox brief created.");
  });
});

describe("the rail's unseen reminders", () => {
  const fire: ReminderFireView = {
    reminderId: "rem-pills",
    workspaceId: "default",
    principalId: "operator",
    text: "Take your pills",
    fireAt: "2026-09-29T19:00:00.000Z",
    firedAt: "2026-09-29T19:00:05.000Z",
    outcome: "delivered-in-app",
    occurrence: "repeat",
  };

  it("shows each above what waits, with Done and Snooze sending acknowledge and snooze", async () => {
    const { client, asked } = owner();
    let changed = 0;
    const page = await mount(
      <CenterRail
        summary={summary}
        reminders={
          <InWorkspace client={client} workspaceId="default">
            <UnseenReminderCards fires={[fire]} timeZone="Europe/Berlin" changed={() => void (changed += 1)} />
          </InWorkspace>
        }
        onSection={() => undefined}
      />,
    );
    const card = page.querySelector(".reminder-card");
    expect(page.querySelector(".center-rail > *")?.classList.contains("reminder-cards")).toBe(true);
    expect(card?.querySelector(".reminder-card-text")?.textContent).toBe("Take your pills");
    // Each card's buttons name the reminder they act on.
    expect([...(card?.querySelectorAll("button") ?? [])].map((item) => item.getAttribute("aria-label"))).toEqual([
      "Done: Take your pills",
      "Snooze 10 min: Take your pills",
      "Snooze 1 h: Take your pills",
    ]);
    await click(button(card ?? page, "Done"));
    expect(asked).toContainEqual({
      command: "reminders",
      payload: { action: "acknowledge", workspaceId: "default", reminderId: "rem-pills", fireAt: fire.fireAt },
    });
    await click(button(card ?? page, "Snooze 10 min"));
    expect(asked).toContainEqual({
      command: "reminders",
      payload: { action: "snooze", workspaceId: "default", reminderId: "rem-pills", minutes: 10, fireAt: fire.fireAt },
    });
    await click(button(card ?? page, "Snooze 1 h"));
    expect(asked).toContainEqual({
      command: "reminders",
      payload: { action: "snooze", workspaceId: "default", reminderId: "rem-pills", minutes: 60, fireAt: fire.fireAt },
    });
    expect(changed).toBe(3);
    // The rail's Coming up names a reminder as one.
    expect(page.querySelector(".center-next-detail")?.textContent).toMatch(/^Reminder · /);
  });

  it("keeps the snooze note once the last card is gone", async () => {
    const { client } = owner();
    let fires: readonly ReminderFireView[] = [fire];
    const view = () => (
      <InWorkspace client={client} workspaceId="default">
        <UnseenReminderCards fires={fires} timeZone="Europe/Berlin" changed={() => undefined} />
      </InWorkspace>
    );
    const page = await mount(view());
    await click(button(page, "Snooze 1 h: Take your pills"));
    fires = [];
    await rerender(view());
    expect(page.querySelector(".reminder-card")).toBeNull();
    expect(page.textContent).toContain("Snoozed “Take your pills” until");
  });

  it("counts unseen reminders in the Center badge", () => {
    expect(waitingCount(summary)).toBe(1);
    expect(waitingCount({ ...summary, counts: { ...summary.counts, unseenReminders: undefined } })).toBe(0);
  });
});

describe("browser notifications", () => {
  class FakeNotification {
    static permission: NotificationPermission = "default";
    static requested = 0;
    static shown: string[] = [];
    static tags: (string | undefined)[] = [];
    static requestPermission(): Promise<NotificationPermission> {
      FakeNotification.requested += 1;
      FakeNotification.permission = "granted";
      return Promise.resolve("granted");
    }
    constructor(title: string, options?: NotificationOptions) {
      FakeNotification.shown.push(title);
      FakeNotification.tags.push(options?.tag);
    }
  }
  beforeEach(() => {
    FakeNotification.permission = "default";
    FakeNotification.requested = 0;
    FakeNotification.shown = [];
    FakeNotification.tags = [];
    (globalThis as { Notification?: unknown }).Notification = FakeNotification;
  });
  afterEach(() => {
    delete (globalThis as { Notification?: unknown }).Notification;
  });

  it("asks for permission only when Turn on notifications is clicked", async () => {
    const page = await mount(schedule(owner().client));
    expect(FakeNotification.requested).toBe(0);
    await click(button(page, "Turn on notifications"));
    expect(FakeNotification.requested).toBe(1);
    expect(page.textContent).toContain("Notifications on while this page is open");
  });

  const fireOf = (reminderId: string, text: string, fireAt: string, firedAt = new Date().toISOString()): ReminderFireView => ({
    reminderId,
    workspaceId: "default",
    principalId: "operator",
    text,
    fireAt,
    firedAt,
    outcome: "delivered-in-app",
    occurrence: "once",
  });
  function Notifier({
    fires,
    workspaceId = "default",
  }: {
    readonly fires: readonly ReminderFireView[] | undefined;
    readonly workspaceId?: string;
  }) {
    useReminderNotifications(workspaceId, fires);
    return null;
  }

  it("shows one notification for each fire seen after the first read, never for the ones already there", async () => {
    FakeNotification.permission = "granted";
    const first = [fireOf("rem-a", "Old one", "2026-09-29T06:00:00.000Z")];
    await mount(<Notifier fires={undefined} />);
    await rerender(<Notifier fires={first} />);
    expect(FakeNotification.shown).toEqual([]);
    const next = [fireOf("rem-b", "Take your pills", "2026-09-29T19:00:00.000Z"), ...first];
    await rerender(<Notifier fires={next} />);
    expect(FakeNotification.shown).toEqual(["⏰ Take your pills"]);
    // Tagged with the fire, so a second tab showing it replaces this one.
    expect(FakeNotification.tags).toEqual(["rem-b@2026-09-29T19:00:00.000Z"]);
    // The same list again, or a fire already shown: nothing more.
    await rerender(<Notifier fires={[...next]} />);
    expect(FakeNotification.shown).toEqual(["⏰ Take your pills"]);
    expect(JSON.parse(localStorage.getItem(`${NOTIFIED_STORAGE_KEY}.default`) ?? "[]")).toEqual(
      expect.arrayContaining(["rem-a@2026-09-29T06:00:00.000Z", "rem-b@2026-09-29T19:00:00.000Z"]),
    );
  });

  it("shows nothing for an old fire that only comes into view later", async () => {
    FakeNotification.permission = "granted";
    await mount(<Notifier fires={[]} />);
    const dayOld = new Date(Date.now() - 86_400_000).toISOString();
    await rerender(<Notifier fires={[fireOf("rem-e", "Yesterday's", dayOld, dayOld)]} />);
    expect(FakeNotification.shown).toEqual([]);
  });

  it("shows nothing for another workspace's waiting fires when the workspace changes", async () => {
    FakeNotification.permission = "granted";
    await mount(<Notifier fires={[]} workspaceId="default" />);
    // The first read for the new workspace is its baseline, however recent its fires.
    await rerender(<Notifier fires={undefined} workspaceId="other" />);
    await rerender(<Notifier fires={[fireOf("rem-f", "Other workspace", "2026-09-29T22:00:00.000Z")]} workspaceId="other" />);
    expect(FakeNotification.shown).toEqual([]);
    await rerender(
      <Notifier
        fires={[
          fireOf("rem-g", "New in other", "2026-09-29T23:00:00.000Z"),
          fireOf("rem-f", "Other workspace", "2026-09-29T22:00:00.000Z"),
        ]}
        workspaceId="other"
      />,
    );
    expect(FakeNotification.shown).toEqual(["⏰ New in other"]);
  });

  it("shows nothing without permission, and nothing for a fire another page already showed", async () => {
    localStorage.setItem(`${NOTIFIED_STORAGE_KEY}.default`, JSON.stringify(["rem-c@2026-09-29T20:00:00.000Z"]));
    FakeNotification.permission = "granted";
    await mount(<Notifier fires={[]} />);
    await rerender(<Notifier fires={[fireOf("rem-c", "Seen elsewhere", "2026-09-29T20:00:00.000Z")]} />);
    expect(FakeNotification.shown).toEqual([]);
    FakeNotification.permission = "default";
    await rerender(<Notifier fires={[fireOf("rem-d", "No permission", "2026-09-29T21:00:00.000Z")]} />);
    expect(FakeNotification.shown).toEqual([]);
  });
});

describe("reminders' words", () => {
  it("says notices, cadences and events as people read them", () => {
    expect(noticeLabel("-1d@20:00")).toBe("the evening before at 20:00");
    expect(noticeLabel("-1d@08:00")).toBe("the morning before at 08:00");
    expect(noticeLabel("-1h")).toBe("1 hour before");
    expect(noticeLabel("-15m")).toBe("15 minutes before");
    expect(noticeLabel("-2d@09:00")).toBe("2 days before at 09:00");
    expect(repeatText({ times: ["21:00"] })).toBe("Daily 21:00");
    expect(repeatText({ times: ["19:00", "07:00"], daysOfWeek: [1, 2, 3, 4, 5], until: "2026-12-31" })).toBe(
      "Mon–Fri 07:00, 19:00 · until 31 Dec",
    );
    expect(whenText({ kind: "repeat", times: ["09:00"], monthly: { dayOfMonth: 1 } }, "Europe/Berlin")).toBe("Monthly on the 1st, 09:00");
    expect(repeatText({ times: ["09:00"], monthly: { nth: -1, weekday: 5 } })).toBe("Monthly on the last Fri, 09:00");
    expect(repeatText({ times: ["08:00"], yearly: { month: 2, day: 29 } })).toBe("Yearly on 29 Feb, 08:00");
    // Coming up says a monthly reminder the same way, from its agenda item.
    expect(
      agendaReminderText(
        {
          kind: "reminder",
          id: "rem-monthly",
          title: "Pay rent",
          at: "2026-11-01T08:00:00.000Z",
          cadence: { kind: "repeat", at: "09:00", timezone: "Europe/Berlin", monthly: { dayOfMonth: 1 } },
          enabled: true,
          reminder: { cadence: "repeat", times: ["09:00"], monthly: { dayOfMonth: 1 } },
        },
        "Europe/Berlin",
      ),
    ).toBe("Monthly on the 1st, 09:00");
    expect(agendaReminderText(agenda.items[3]!, "Europe/Berlin")).toBe("Event Mon 5 Oct 10:00 · the evening before at 20:00");
    expect(eventLine("2026-10-05T08:00:00.000Z", ["2026-10-04T18:00:00.000Z"], "Europe/Berlin", "2026-09-29")).toBe(
      "Mon 5 Oct 10:00 · reminds Sun 4 Oct 20:00",
    );
  });

  it("reads a local date and time in the zone, across DST", () => {
    expect(localToInstant("2026-10-05", "10:00", "Europe/Berlin")).toBe("2026-10-05T08:00:00.000Z");
    expect(localToInstant("2026-11-05", "10:00", "Europe/Berlin")).toBe("2026-11-05T09:00:00.000Z");
    expect(localToInstant("2026-10-05", "", "Europe/Berlin")).toBeUndefined();
    // 02:30 does not exist on 29 March in Berlin: read as the first minute that does, 03:00 CEST.
    expect(localToInstant("2026-03-29", "02:30", "Europe/Berlin")).toBe("2026-03-29T01:00:00.000Z");
    // 02:30 happens twice on 25 October: the first one, in CEST, is chosen, as the scheduler fires it.
    expect(localToInstant("2026-10-25", "02:30", "Europe/Berlin")).toBe("2026-10-25T00:30:00.000Z");
  });

  it("keeps Done / missed to the last 30 days, newest first", () => {
    expect(
      doneEntries([paid, old], [missed], Date.now()).map((entry) =>
        entry.kind === "reminder" ? entry.reminder.reminderId : `missed:${entry.fire.reminderId}`,
      ),
    ).toEqual(["missed:rem-pills", "rem-invoice"]);
  });
});

describe("Activity's reminder chip", () => {
  it("gives a task a reminder started its own source", () => {
    expect(sourceOf({ origin: "reminder" })).toBe("reminder");
    expect(SOURCE_LABELS[sourceOf({ origin: "reminder" })]).toBe("Reminder");
    // An older owner's row, with no channel: a schedule's task reads as a schedule.
    expect(sourceOf({ origin: "schedule" })).toBe("schedule");
  });
});
