// @vitest-environment jsdom
import type { CenterSummaryAnswer, ScheduleFireRecord, ScheduleShowResult } from "@tavi/contracts";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CenterRail } from "../../../src/features/center/CenterRail.js";
import { Schedule } from "../../../src/features/center/Schedule.js";
import { fireState, outcomeReason, outcomeSentence, pausedText, scheduleState } from "../../../src/features/center/schedule-model.js";
import { Schedule as ChatSchedule } from "../../../src/features/chat-panel/Schedule.js";
import type { Session } from "../../../src/features/shell/shell.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { button, mountSettled as mount, settle } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

/**
 * A plain schedule's page (`/center/schedule/schedules/<id>`): its prompt,
 * its policy, its fire ledger in sentences and the workspace zone, its row's
 * actions; and the links that lead there.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const brief: ScheduleShowResult = {
  scheduleId: "s1",
  workspaceId: "default",
  principalId: "operator",
  name: "Morning brief",
  prompt: "Summarise my inbox\nand my calendar.",
  spec: { at: "07:00", timezone: "Europe/Berlin", daysOfWeek: [1, 2, 3, 4, 5] },
  missedRunPolicy: "run-once-if-missed-within-6h",
  autoApproveTools: ["web_search", "reports.*"],
  alert: { connectionId: "telegram", destination: "42" },
  deliverTo: "home",
  enabled: true,
  nextRunAt: "2026-09-30T05:00:00.000Z",
  lastRunAt: "2026-09-29T05:00:00.000Z",
  lastRunTaskId: "task-9",
  lastOutcome: "failed: the model provider refused the request",
  consecutiveFailures: 1,
  createdAt: "x",
  updatedAt: "x",
  timezone: "Europe/Berlin",
  recentFires: [],
};

const fire = (fireTime: string, reasonCode: ScheduleFireRecord["reasonCode"], outcome: string, taskId: string | null = null) => ({
  scheduleId: "s1",
  fireTime,
  reasonCode,
  outcome,
  outcomeKind: "failed" as const,
  taskId,
  at: fireTime,
});

const fires: readonly ScheduleFireRecord[] = [
  fire("2026-09-29T05:00:00.000Z", "failed", "failed: the model provider refused the request", "task-9"),
  fire("2026-09-28T05:00:00.000Z", "missed", "skipped: missed by 400m (beyond the 6h catch-up window)"),
  fire("2026-09-25T05:00:00.000Z", "ok", "completed", "task-7"),
];

/** An owner answering `schedules show`/`history` and the row's actions, recording each action asked. */
function owner(refuse?: string) {
  const asked: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (command, raw) => {
      const payload = raw as Record<string, unknown>;
      const action = payload["action"];
      if (command === "schedules" && action === "show") return { ok: true, result: brief } as never;
      if (command === "schedules" && action === "history")
        return { ok: true, result: { scheduleId: "s1", name: "Morning brief", timezone: "Europe/Berlin", fires } } as never;
      if (command === "schedules" && action === "agenda")
        return { ok: true, result: { timezone: "Europe/Berlin", items: [], truncated: false, skipped: [] } } as never;
      if (command === "schedules" && action === "list") return { ok: true, result: { schedules: [brief], truncated: false } } as never;
      if (command === "routines" && action === "targets")
        return {
          ok: true,
          result: {
            targets: [
              { targetId: "t-ana", label: "Telegram · Ana", connectionId: "telegram", chatId: "42", enabled: true, authorized: true },
            ],
          },
        } as never;
      if (command === "routines") return { ok: true, result: { routines: [] } } as never;
      asked.push(payload);
      if (refuse !== undefined) return { ok: false, error: { code: "CONFLICT", message: refuse } } as never;
      return { ok: true, result: { ...brief, enabled: false } } as never;
    },
  };
  return { client, asked };
}

/** The next animation frame, where focus is moved once what it moves to is drawn. */
const frame = () => act(async () => new Promise<void>((done) => requestAnimationFrame(() => done())));

const onPage = (client: SettingsClient, props: Partial<Parameters<typeof Schedule>[0]> = {}) => (
  <InWorkspace client={client} workspaceId="default">
    <Schedule
      summary={undefined}
      revision={0}
      scheduleId="s1"
      onOpenRoutine={() => undefined}
      onFollow={async () => undefined}
      {...props}
    />
  </InWorkspace>
);

describe("a schedule's page", () => {
  it("shows its prompt, its policy and its fires in sentences, in the workspace zone, with each fire's task", async () => {
    const followed: string[] = [];
    const page = await mount(onPage(owner().client, { onFollow: async (taskId) => void followed.push(taskId) }));
    await settle();
    const title = page.querySelector<HTMLElement>(".page-title");
    expect(title?.textContent).toContain("Morning brief");
    expect(title?.querySelector(".badge")?.textContent).toBe("failed");
    // Arriving puts focus on its name.
    expect(document.activeElement).toBe(title);
    expect(page.textContent).toContain("Mon–Fri 07:00 · Europe/Berlin");
    expect(page.textContent).toContain("Next Wed 30 Sep 07:00");
    expect(page.querySelector(".schedule-prompt")?.textContent).toBe("Summarise my inbox\nand my calendar.");
    const policy = page.querySelector(".summary-grid")?.textContent ?? "";
    expect(policy).toContain("web_search");
    expect(policy).toContain("reports.*");
    expect(policy).toContain("Runs once if it is missed by up to 6 hours");
    expect(policy).toContain("Stopped after 30 minutes of work (the default).");
    expect(policy).toContain("Token ceilingNone.");
    expect(policy).toContain("Its result into Home.");
    expect(policy).toContain("After every run. Failures are always told.");
    expect(policy).toContain("Pre-checkNone: every run goes ahead.");
    // Its alert chat is named as the delivery targets name it, never by its ids.
    expect(policy).toContain("AlertsTelegram · Ana");
    expect(policy).not.toContain("telegram");
    expect(policy).toContain("The base instructions");
    expect(policy).toContain("Never asks");
    expect(policy).toContain("1 failure in a row");
    const rows = [...page.querySelectorAll(".schedule-fires li")];
    expect(rows.map((row) => row.querySelector("time")?.textContent)).toEqual(["Tue 29 Sep 07:00", "Mon 28 Sep 07:00", "Fri 25 Sep 07:00"]);
    expect(rows.map((row) => row.querySelector(".badge")?.textContent)).toEqual(["failed", "skipped", "ok"]);
    // Every row is the same four cells of one grid, whatever its length: time, badge, what happened, its task.
    expect(
      rows.map((row) =>
        [...row.children].map((cell) => cell.tagName.toLowerCase() + (cell.classList.contains("schedule-fire-text") ? ".text" : "")),
      ),
    ).toEqual([
      ["time", "span", "span.text", "a"],
      ["time", "span", "span.text"],
      ["time", "span", "span.text", "a"],
    ]);
    expect(rows[0]?.textContent).toContain("Failed: the model provider refused the request.");
    expect(rows[1]?.textContent).toContain("Missed by 6 h 40 min, too late to catch up (6 hours at most).");
    expect(rows[2]?.textContent).toContain("Completed.");
    expect(rows[1]?.querySelector("a")).toBeNull();
    const task = rows[0]?.querySelector<HTMLAnchorElement>("a");
    expect(task?.getAttribute("href")).toBe("/tasks/task-9");
    await act(async () => task?.click());
    expect(followed).toEqual(["task-9"]);
  });

  it("says what its pre-check reads before each run, when it last read it, and that with no alert target Home is told", async () => {
    const { alert: _alert, ...unalerted } = brief;
    const watched: ScheduleShowResult = {
      ...unalerted,
      precheck: { kind: "feed-has-new", target: "https://example.com/feed.xml" },
      precheckState: { fingerprint: "f", checkedAt: "2026-09-29T05:00:00.000Z" },
    };
    const { client } = owner();
    const answering: SettingsClient = {
      request: async (command, raw) =>
        command === "schedules" && (raw as Record<string, unknown>)["action"] === "show"
          ? ({ ok: true, result: watched } as never)
          : client.request(command, raw),
    };
    const page = await mount(onPage(answering));
    await settle();
    expect(page.querySelector(".summary-grid")?.textContent).toContain(
      "Runs only when the feed https://example.com/feed.xml has new items since the last check; otherwise nothing runs and no model is called. Last read Tue 29 Sep 07:00.",
    );
    // As `schedules add` says it: a failed or missed run with no alert target goes to Home.
    expect(page.querySelector(".summary-grid")?.textContent).toContain(
      "AlertsYour Home: a failed or missed run is posted there as a notice (only logged while Home is off).",
    );
  });

  it("turns its webhook on from its page, shows the new secret once, and says how calls reach it", async () => {
    const asked: Record<string, unknown>[] = [];
    let webhook: ScheduleShowResult["webhook"];
    const { client } = owner();
    const answering: SettingsClient = {
      request: async (command, raw) => {
        const payload = raw as Record<string, unknown>;
        if (command === "schedules" && payload["action"] === "show")
          return { ok: true, result: { ...brief, ...(webhook === undefined ? {} : { webhook }) } } as never;
        if (command === "schedules" && payload["action"] === "webhook") {
          asked.push(payload);
          webhook = { since: "2026-09-29T06:00:00.000Z" };
          return {
            ok: true,
            result: {
              scheduleId: "s1",
              name: "Morning brief",
              webhook: "on",
              path: "/hooks/schedules/s1",
              url: "https://hooks.example.com/hooks/schedules/s1",
              secret: "twh_shown-once",
              signingKey: "twhk_shown-once",
            },
          } as never;
        }
        return client.request(command, raw);
      },
    };
    const page = await mount(onPage(answering));
    await settle();
    expect(page.textContent).toContain("Off: nothing outside can start it.");
    // Two Turn on buttons can share the page: each says which it turns on.
    expect(button(page, "Turn on")?.getAttribute("aria-label")).toBe("Turn on webhook");
    await act(async () => button(page, "Turn on")?.click());
    await settle();
    expect(asked).toEqual([{ action: "webhook", workspaceId: "default", scheduleId: "s1", webhook: "on" }]);
    const section = page.querySelector(".schedule-webhook")?.textContent ?? "";
    expect(section).toContain("On since Tue 29 Sep 08:00");
    expect(section).toContain("https://hooks.example.com/hooks/schedules/s1");
    // Shown in read-only fields to copy from, never in a live region that would read it out.
    const secret = page.querySelector<HTMLInputElement>('[aria-label="Webhook secret"]');
    expect(secret?.value).toBe("twh_shown-once");
    expect(secret?.readOnly).toBe(true);
    expect(page.querySelector<HTMLInputElement>('[aria-label="Webhook signing key"]')?.value).toBe("twhk_shown-once");
    expect(page.querySelector('[aria-label="Copy webhook secret"]')).not.toBeNull();
    expect(secret?.closest('[role="status"], [aria-live]')).toBeNull();
    expect(section).not.toContain("twh_shown-once");
    expect(section).toContain("The secret is stored only as its hash, the signing key only encrypted.");
    // Focus goes to the words above it, not to the secret.
    await frame();
    expect(document.activeElement?.textContent).toContain("Copy it now: it is shown once.");
    await act(async () => button(page, "Done")?.click());
    await frame();
    expect(page.querySelector('[aria-label="Webhook secret"]')).toBeNull();
    // Done leaves focus on New secret, not the page.
    expect(document.activeElement).toBe(button(page, "New secret"));
    expect(button(page, "Turn off")).toBeDefined();
  });

  it("says the address a webhook that is on is reached at, the listener's own while no public address is set", async () => {
    const { client } = owner();
    const local = "http://127.0.0.1:48779/hooks/schedules/s1";
    const answering: SettingsClient = {
      request: async (command, raw) => {
        const payload = raw as Record<string, unknown>;
        if (command === "schedules" && payload["action"] === "show")
          return { ok: true, result: { ...brief, webhook: { since: "2026-09-29T06:00:00.000Z" }, webhookUrl: local } } as never;
        return client.request(command, raw);
      },
    };
    const page = await mount(onPage(answering));
    await settle();
    const section = page.querySelector(".schedule-webhook")?.textContent ?? "";
    expect(section).toContain(local);
    expect(section).not.toContain("<public address>");
  });

  it("sets up an email trigger on an email connection with its senders, warns it is read-only, and turns it off", async () => {
    const asked: Record<string, unknown>[] = [];
    let emailTrigger: ScheduleShowResult["emailTrigger"];
    const { client } = owner();
    const channel = (providerId: string, authentication: "provider" | "per-message") => ({
      providerId,
      label: providerId === "mailgun" ? "Mailgun" : "Telegram",
      sender: { authentication },
    });
    const connection = (connectionId: string, providerId: string) => ({
      connectionId,
      providerId,
      label: providerId === "mailgun" ? "Mailgun" : "Telegram",
      accountIdentity: `${connectionId}.example.com`,
    });
    const answering: SettingsClient = {
      request: async (command, raw) => {
        const payload = raw as Record<string, unknown>;
        if (command === "schedules" && payload["action"] === "show")
          return { ok: true, result: { ...brief, ...(emailTrigger === undefined ? {} : { emailTrigger }) } } as never;
        if (command === "channels" && payload["action"] === "catalog")
          return { ok: true, result: { channels: [channel("mailgun", "per-message"), channel("telegram", "provider")] } } as never;
        if (command === "channels" && payload["action"] === "list")
          return { ok: true, result: { connections: [connection("mail-1", "mailgun"), connection("tg-1", "telegram")] } } as never;
        if (command === "schedules" && payload["action"] === "email-trigger") {
          asked.push(payload);
          const setting = payload["emailTrigger"];
          emailTrigger =
            setting === "off"
              ? undefined
              : { ...(setting as { connectionId: string; senders: string[] }), since: "2026-09-29T06:00:00.000Z" };
          return {
            ok: true,
            result: {
              scheduleId: "s1",
              name: "Morning brief",
              emailTrigger: emailTrigger === undefined ? "off" : "on",
              ...(emailTrigger === undefined ? {} : { trigger: emailTrigger }),
            },
          } as never;
        }
        return client.request(command, raw);
      },
    };
    const page = await mount(onPage(answering));
    await settle();
    const section = () => page.querySelector(".schedule-email-trigger");
    expect(section()?.textContent).toContain("Off: no email starts it.");
    // Nothing is asked of the channels until a person sets one up.
    expect(section()?.querySelector("input")).toBeNull();
    await act(async () => button(section()!, "Set up")?.click());
    await settle();
    expect(section()?.textContent).toContain("may only read");
    // The one email connection is chosen; Telegram, which cannot authenticate each sender, is not offered.
    expect(section()?.textContent).toContain("Mailgun (mail-1.example.com)");
    expect(section()?.textContent).not.toContain("tg-1");
    expect(button(section()!, "Turn on")?.disabled).toBe(true);
    expect(button(section()!, "Turn on")?.getAttribute("aria-label")).toBe("Turn on email trigger");
    expect(section()?.querySelector("input[aria-label='Subject holds (optional)']")).not.toBeNull();
    const senders = section()?.querySelector<HTMLInputElement>("input[aria-label='From']");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(senders, "ann@example.com, @example.org");
      senders?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(section()!, "Turn on")?.click());
    await settle();
    expect(asked).toEqual([
      {
        action: "email-trigger",
        workspaceId: "default",
        scheduleId: "s1",
        emailTrigger: { connectionId: "mail-1", senders: ["ann@example.com", "@example.org"] },
      },
    ]);
    const on = section()?.textContent ?? "";
    expect(on).toContain("On since Tue 29 Sep 08:00");
    expect(on).toContain("ann@example.com");
    expect(on).toContain("@example.org");
    expect(on).toContain("never also a chat message");
    expect(on).toContain("no tool that changes or sends anything runs");
    await act(async () => button(section()!, "Turn off")?.click());
    await act(async () => button(document.querySelector(".modal")!, "Turn off")?.click());
    await settle();
    expect(asked.at(-1)).toMatchObject({ action: "email-trigger", emailTrigger: "off" });
    expect(section()?.textContent).toContain("Off: no email starts it.");
  });

  it("pauses it and says so, and shows a refusal as a failure", async () => {
    const { client, asked } = owner();
    const page = await mount(onPage(client));
    await settle();
    await act(async () => button(page, "Pause")?.click());
    expect(asked).toContainEqual({ action: "disable", scheduleId: "s1", workspaceId: "default" });
    expect(page.textContent).toContain("Morning brief paused.");
    expect(page.querySelector(".failure")).toBeNull();

    const refused = owner("schedule Morning brief has a fire in flight; pause it once the fire ends");
    const other = await mount(onPage(refused.client));
    await settle();
    await act(async () => button(other, "Pause")?.click());
    const failure = other.querySelector(".failure");
    expect(failure?.getAttribute("role")).toBe("alert");
    expect(failure?.textContent).toContain("has a fire in flight");
  });

  it("goes back to the lists on Delete, where Undo keeps it whole without asking the owner", async () => {
    const { client, asked } = owner();
    const shows = vi.fn();
    const counting: SettingsClient = {
      request: async (command, raw) => {
        if (command === "schedules" && (raw as Record<string, unknown>)["action"] === "show") shows();
        return client.request(command, raw);
      },
    };
    const onOpenRoutine = vi.fn();
    function Leaving() {
      const [scheduleId, setScheduleId] = useState<string | undefined>("s1");
      return onPage(counting, {
        scheduleId,
        onOpenRoutine: (routineId) => {
          onOpenRoutine(routineId);
          setScheduleId(undefined);
        },
      });
    }
    const page = await mount(<Leaving />);
    await settle();
    const before = shows.mock.calls.length;
    await act(async () => button(page, "Delete")?.click());
    await settle();
    expect(onOpenRoutine).toHaveBeenCalledWith(undefined);
    expect(page.querySelector(".schedule-page")).toBeNull();
    expect(shows.mock.calls.length).toBe(before);
    // Back on the lists its row is hidden, and the toast's Undo has focus.
    expect(page.querySelector('[data-row-key="schedule:s1"]')).toBeNull();
    const undo = page.querySelector<HTMLButtonElement>('.undo-toast [aria-label="Undo deleting Morning brief"]');
    expect(page.querySelector(".undo-toast-region")?.getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(undo);
    await act(async () => undo?.click());
    await settle();
    expect(asked.some((item) => item["action"] === "remove")).toBe(false);
    expect(page.querySelector('[data-row-key="schedule:s1"]')).not.toBeNull();
    expect(page.textContent).toContain("Morning brief kept.");
  });

  it("names the agent it runs as and an alert chat set elsewhere in words, and offers no Resume once it is finished", async () => {
    const { client } = owner();
    const ended: ScheduleShowResult = {
      ...brief,
      agentId: "agent-7f3a",
      alert: { connectionId: "slack", destination: "C123" },
      enabled: false,
      nextRunAt: null,
      spec: { at: "07:00", timezone: "Europe/Berlin", until: "2025-01-31" },
    };
    const answering: SettingsClient = {
      request: async (command, raw) => {
        const payload = raw as Record<string, unknown>;
        if (command === "schedules" && payload["action"] === "show") return { ok: true, result: ended } as never;
        if (command === "agents")
          return { ok: true, result: { agents: [{ agentId: "agent-7f3a", name: "Writer", enabled: true }] } } as never;
        return client.request(command, raw);
      },
    };
    const page = await mount(onPage(answering));
    await settle();
    const policy = page.querySelector(".summary-grid")?.textContent ?? "";
    expect(policy).toContain("Runs asWriter");
    expect(policy).toContain("AlertsA chat not among your delivery targets");
    expect(policy).not.toContain("agent-7f3a");
    expect(policy).not.toContain("C123");
    expect(page.querySelector(".page-title .badge")?.textContent).toBe("finished");
    expect(button(page, "Resume")).toBeUndefined();
    expect(button(page, "Edit")).toBeDefined();
  });

  it("says a run asked for now as the last run, and a watcher's page says what it watches under its name", async () => {
    const watcher: ScheduleShowResult = {
      ...brief,
      spec: { at: "00:00", timezone: "Europe/Berlin", everyHours: 1, between: { from: "00:00", to: "23:59" } },
      precheck: { kind: "file-changed", target: "/notes/prices.txt" },
      watch: true,
      // Any run that started moves it: here a Run now.
      lastRunAt: "2026-09-29T05:00:00.000Z",
      lastOutcome: "manual run: completed",
      consecutiveFailures: 0,
    };
    const { client } = owner();
    const answering: SettingsClient = {
      request: async (command, raw) =>
        command === "schedules" && (raw as Record<string, unknown>)["action"] === "show"
          ? ({ ok: true, result: watcher } as never)
          : client.request(command, raw),
    };
    const page = await mount(onPage(answering));
    await settle();
    const policy = page.querySelector(".summary-grid")?.textContent ?? "";
    expect(policy).toMatch(/Last run(Yesterday|Tue 29 Sep) 07:00/);
    expect(policy).not.toContain("None on its schedule yet");
    expect(page.querySelector(".schedule-cadence")?.textContent).toMatch(/^Watches the file \/notes\/prices\.txt every hour/);
  });

  it("badges a schedule its Resume started again as resumed, not failed", async () => {
    const resumed: ScheduleShowResult = { ...brief, consecutiveFailures: 0 };
    const { client } = owner();
    const answering: SettingsClient = {
      request: async (command, raw) =>
        command === "schedules" && (raw as Record<string, unknown>)["action"] === "show"
          ? ({ ok: true, result: resumed } as never)
          : client.request(command, raw),
    };
    const page = await mount(onPage(answering));
    await settle();
    expect(page.querySelector(".page-title .badge")?.textContent).toBe("resumed");
  });

  it("says a retried try's Retry N in its fire's words, so the row keeps the grid's four cells", async () => {
    const { client } = owner();
    const retried = {
      ...fire("2026-09-29T05:00:00.000Z", "retry", "retrying at 2026-09-29T05:02:00.000Z (retry 1 of 3) after a provider error: 429"),
      retryCount: 1,
    };
    const answering: SettingsClient = {
      request: async (command, raw) =>
        command === "schedules" && (raw as Record<string, unknown>)["action"] === "history"
          ? ({ ok: true, result: { scheduleId: "s1", name: "Morning brief", timezone: "Europe/Berlin", fires: [retried] } } as never)
          : client.request(command, raw),
    };
    const page = await mount(onPage(answering));
    await settle();
    const row = page.querySelector(".schedule-fires li");
    expect(row?.children).toHaveLength(3);
    expect(row?.querySelector(".schedule-fire-text")?.textContent).toMatch(/^Retry 1 · Failed on a provider error/);
  });

  it("says when the schedule does not exist", async () => {
    const client: SettingsClient = {
      request: async (_command, raw) =>
        (raw as Record<string, unknown>)["action"] === "show" || (raw as Record<string, unknown>)["action"] === "history"
          ? ({ ok: false, error: { code: "NOT_FOUND", message: 'no schedule "s1" exists in workspace default' } } as never)
          : ({ ok: true, result: { schedules: [], routines: [], items: [], truncated: false, skipped: [], timezone: "UTC" } } as never),
    };
    const page = await mount(onPage(client));
    await settle();
    expect(page.textContent).toContain("This schedule was not found.");
    expect(page.textContent).not.toContain("s1");
  });
});

describe("the links to a schedule's page", () => {
  it("opens it from its name in Recurring", async () => {
    const opened: string[] = [];
    const page = await mount(onPage(owner().client, { scheduleId: undefined, onOpenSchedule: (id) => opened.push(id) }));
    const name = page.querySelector<HTMLAnchorElement>(".schedule-recurring a.item-title");
    expect(name?.textContent).toBe("Morning brief");
    expect(name?.getAttribute("href")).toBe("/center/schedule/schedules/s1");
    await act(async () => name?.click());
    expect(opened).toEqual(["s1"]);
  });

  it("opens it from the rail's Coming up, other entries still opening Schedule", async () => {
    const summary: CenterSummaryAnswer = {
      workspaceId: "default",
      timezone: "Europe/Berlin",
      today: "2026-09-29",
      counts: { approvals: 0, reviews: 0, questions: 0, runningTasks: 0, memoryProposals: 0, activeRoutines: 1, schedules: 1 },
      perDay: [{ date: "2026-09-29", tasks: 0 }],
      next: [
        { kind: "schedule", id: "s1", title: "Morning brief", at: "2026-09-30T05:00:00.000Z" },
        { kind: "routine", id: "r1", title: "LLM news", at: "2026-09-30T19:00:00.000Z" },
      ],
      people: {},
      cursor: "c1",
    };
    const sections: string[] = [];
    const opened: string[] = [];
    const page = await mount(
      <CenterRail summary={summary} onSection={(next) => sections.push(next)} onOpenSchedule={(id) => opened.push(id)} />,
    );
    const [schedule, routine] = [...page.querySelectorAll<HTMLAnchorElement>(".center-next a")];
    expect(schedule?.getAttribute("href")).toBe("/center/schedule/schedules/s1");
    expect(routine?.getAttribute("href")).toBe("/center/schedule");
    await act(async () => schedule?.click());
    await act(async () => routine?.click());
    expect(opened).toEqual(["s1"]);
    expect(sections).toEqual(["schedule"]);
  });

  it("opens it from the chat panel for a chat a plain schedule started", async () => {
    const session = { key: "task-1", taskId: "task-1", title: "t", status: "completed", runs: [] } as unknown as Session;
    const client: SettingsClient = {
      request: async (command) =>
        command === "tasks"
          ? ({ ok: true, result: { task: { origin: "schedule", originScheduleId: "s1" }, admissions: [] } } as never)
          : ({ ok: true, result: { schedules: [{ scheduleId: "s1", name: "Morning brief" }], truncated: false } } as never),
    };
    const onOpenSchedule = vi.fn();
    const onCenter = vi.fn();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <ChatSchedule
          session={session}
          reminders={false}
          onOpenReminder={() => undefined}
          onOpenRoutine={() => undefined}
          onOpenSchedule={onOpenSchedule}
          onCenter={onCenter}
        />
      </InWorkspace>,
    );
    const started = page.querySelector('[aria-label="what started this chat"]');
    expect(started?.textContent).toContain("The schedule Morning brief");
    await act(async () => (started?.querySelector("button") as HTMLButtonElement).click());
    expect(onOpenSchedule).toHaveBeenCalledWith("s1");
    expect(onCenter).not.toHaveBeenCalled();
  });
});

describe("a schedule's outcome in words", () => {
  const zone = "Europe/Berlin";

  it("says each of the scheduler's outcomes as a sentence, never its dispatch mark", () => {
    const said = (outcome: string | null) => outcomeSentence(outcome, zone);
    expect(said(null)).toBe("Not run yet.");
    expect(said("completed")).toBe("Completed.");
    expect(said("completed quietly: nothing to report, so nothing was sent")).toBe(
      "Completed with nothing to report, so nothing was sent.",
    );
    expect(said("manual run: completed quietly: the result was unchanged, so it was not sent again")).toBe(
      "Run now: completed with the same result as last time, so it was not sent again.",
    );
    expect(said("completed but nothing was delivered: no brief was sent")).toBe("Completed, but sent nothing it was to send.");
    expect(said("timed out: stopped after 30 minutes of work")).toBe("Stopped after 30 minutes of work, its run limit.");
    expect(said("over budget: stopped after 52,000 tokens, past its ceiling of 50,000 tokens")).toBe(
      "Stopped after 52,000 tokens, past its ceiling of 50,000 tokens.",
    );
    expect(said("waiting on a worker; goes on once it finishes")).toBe("Waiting on a worker it started; goes on once that finishes.");
    expect(said("asked a question; goes on with its default if nobody answers in time")).toContain("Asked a question");
    expect(said("waiting: suspended on an approval, which nothing in an unattended run resolves")).toBe(
      "Stopped waiting on an approval, which nobody answers in an unattended run.",
    );
    expect(said("admission failed: no model configured")).toBe("Could not start: no model configured.");
    expect(said("fire threw: disk I/O error")).toBe("Could not start: disk I/O error.");
    expect(said("failed after its wait: the worker failed")).toBe("Failed after its wait: the worker failed.");
    expect(said(`failed: ${"x".repeat(400)}`).length).toBeLessThan(220);
    expect(said("skipped: the previous run is still in flight")).toBe("Skipped: the previous run was still going.");
    expect(said("skipped: missed while the owner was not running")).toBe("Missed: Tavi was not running at the time.");
    expect(said("skipped: missed by 12m (policy: skip)")).toBe("Missed by 12 min; this schedule skips missed runs.");
    expect(said("refused: only 40 MiB free on the data directory's filesystem")).toBe(
      "Did not start: only 40 MiB free on the data disk. It runs once space is freed.",
    );
    expect(said("disabled: invalid time zone")).toBe("Turned off: its time has no next run (invalid time zone).");
    expect(said("orphaned: the 2026-09-29T05:00:00.000Z fire never reported a result")).toBe(
      "The run for Tue 29 Sep 07:00 never reported a result.",
    );
    expect(said("manual run: completed")).toBe("Run now: completed.");
    expect(said("email run (from ann@example.com, 312 bytes, sha256 0123456789abcdef): completed")).toBe(
      "Email (from ann@example.com, 312 bytes): completed.",
    );
    expect(
      fireState({ reasonCode: "email", outcome: "email run (from ann@example.com, 1 bytes, sha256 0123456789abcdef): failed: boom" }),
    ).toBe("failed");
    expect(fireState({ reasonCode: "email-refused", outcome: "email trigger refused 2 emails this hour (2 unauthenticated)" })).toBe(
      "skipped",
    );
    expect(said("webhook run (payload 312 bytes, sha256 0123456789abcdef): completed")).toBe(
      "Webhook call (payload 312 bytes): completed.",
    );
    expect(said("webhook run: failed after its wait: boom")).toBe("Webhook call: failed after its wait: boom.");
    expect(said("webhook refused 4 calls this hour (3 bad credentials, 1 over the rate limit)")).toBe(
      "Webhook refused 4 calls this hour (3 bad credentials, 1 over the rate limit).",
    );
    expect(said("unchanged: page-changed:https://example.com/ found nothing new since 2026-09-28T05:00:00.000Z, so nothing ran")).toBe(
      "Nothing new at its pre-check, so nothing ran and no model was called.",
    );
    expect(said("pre-check failed: example.com resolves to a non-public address")).toBe(
      "Did not run: its pre-check could not be made: example.com resolves to a non-public address.",
    );
    const marked = said("dispatching the 2026-09-29T05:00:00.000Z fire");
    expect(marked).toBe("Starting its run; no result yet.");
    expect(marked).not.toContain("dispatching");
    expect(said("something new")).toBe("Something new.");
  });

  it("reads the reason an outcome stands for", () => {
    expect(outcomeReason("over budget: stopped after 52,000 tokens, past its ceiling of 50,000 tokens")).toBe("budget");
    expect(outcomeReason("completed")).toBe("ok");
    expect(outcomeReason("completed quietly: nothing to report, so nothing was sent")).toBe("quiet");
    expect(outcomeReason("manual run: timed out: stopped after 5 minutes of work")).toBe("timeout");
    expect(outcomeReason("skipped: missed by 3m (policy: skip)")).toBe("missed");
    expect(outcomeReason("dispatching the 2026-09-29T05:00:00.000Z fire")).toBeUndefined();
  });

  it("badges a schedule ok, failed, skipped or paused", () => {
    const row = { enabled: true, consecutiveFailures: 0, lastOutcome: "completed" };
    expect(scheduleState(row)).toBe("ok");
    expect(scheduleState({ ...row, enabled: false })).toBe("paused");
    expect(scheduleState({ ...row, consecutiveFailures: 2 })).toBe("failed");
    expect(scheduleState({ ...row, lastOutcome: "manual run: completed but nothing was delivered: no brief was sent" })).toBe("failed");
    expect(scheduleState({ ...row, lastOutcome: "skipped: the previous run is still in flight" })).toBe("skipped");
    expect(scheduleState({ ...row, lastOutcome: "waiting on a worker; goes on once it finishes" })).toBe("ok");
    expect(scheduleState({ ...row, lastOutcome: null })).toBeUndefined();
    expect(scheduleState({ ...row, lastOutcome: "dispatching the 2026-09-29T05:00:00.000Z fire" })).toBeUndefined();
    // A run asked for by hand is judged by how it ended.
    expect(fireState({ reasonCode: "manual", outcome: "manual run: failed: no" })).toBe("failed");
    expect(fireState({ reasonCode: "asked", outcome: "asked a question" })).toBe("waiting");
    // A quiet run went well: it had nothing to tell.
    expect(fireState({ reasonCode: "quiet", outcome: "completed quietly: nothing to report, so nothing was sent" })).toBe("ok");
    // A webhook's run is judged by how it ended; its refused calls started nothing.
    expect(fireState({ reasonCode: "webhook", outcome: "webhook run (no payload): completed" })).toBe("ok");
    expect(fireState({ reasonCode: "webhook", outcome: "webhook run (no payload): failed: boom" })).toBe("failed");
    expect(fireState({ reasonCode: "webhook-refused", outcome: "webhook refused 1 call this hour (1 bad credentials)" })).toBe("skipped");
    expect(scheduleState({ ...row, lastOutcome: "completed quietly: nothing to report, so nothing was sent" })).toBe("ok");
    // A fire its pre-check found nothing new for went well too; one whose check could not be made failed.
    expect(
      fireState({ reasonCode: "unchanged", outcome: "unchanged: page-changed:https://example.com/ found nothing new, so nothing ran" }),
    ).toBe("ok");
    expect(scheduleState({ ...row, consecutiveFailures: 1, lastOutcome: "pre-check failed: refused" })).toBe("failed");
    expect(scheduleState({ ...row, lastOutcome: "webhook run (no payload): pre-check failed: refused" })).toBe("failed");
    // A file watcher's check is judged by how it ended: nothing new ran nothing, and went well.
    const unchanged = "file-watch run: unchanged: file-changed:/notes/today.md found nothing new, so nothing ran";
    expect(fireState({ reasonCode: "watch", outcome: unchanged })).toBe("ok");
    expect(fireState({ reasonCode: "watch", outcome: "file-watch run: completed" })).toBe("ok");
    expect(fireState({ reasonCode: "watch", outcome: "file-watch run: pre-check failed: gone" })).toBe("failed");
    expect(outcomeSentence("file-watch run: completed", "UTC")).toBe("Its file changed: completed.");
    expect(scheduleState({ ...row, lastOutcome: unchanged })).toBe("ok");
  });

  it("badges a schedule resumed after failing as resumed, not failed: Resume started its count again", () => {
    // Resume clears the count; the last outcome is still the failure that paused it.
    const resumed = { enabled: true, consecutiveFailures: 0, lastOutcome: "failed: boom" };
    expect(scheduleState(resumed)).toBe("resumed");
    expect(scheduleState({ ...resumed, lastOutcome: "file-watch run: failed: gone" })).toBe("resumed");
    expect(scheduleState({ ...resumed, lastOutcome: "completed but nothing was delivered: none" })).toBe("resumed");
    // A run asked for now never counts toward a pause: its failure is the schedule's last word.
    expect(scheduleState({ ...resumed, lastOutcome: "manual run: failed: boom" })).toBe("failed");
    expect(scheduleState({ ...resumed, consecutiveFailures: 1 })).toBe("failed");
  });

  it("says a fire tried again and a schedule its failures paused, and badges each", () => {
    const row = { enabled: false, consecutiveFailures: 3, lastOutcome: "failed: boom" };
    expect(scheduleState({ ...row, pausedReason: "failures" as const })).toBe("paused-failures");
    expect(scheduleState(row)).toBe("paused");
    expect(pausedText({ enabled: false, pausedReason: "failures" })).toBe("Paused after 3 failed runs in a row; resume it to run again");
    expect(pausedText({ enabled: false })).toBe("Paused");
    const retrying = "retrying at 2026-09-29T05:02:00.000Z (retry 1 of 3) after a provider error: 429";
    expect(outcomeReason(retrying)).toBe("retry");
    expect(outcomeSentence(retrying, zone)).toBe("Failed on a provider error; trying again at Tue 29 Sep 07:02 (retry 1 of 3).");
    expect(fireState({ reasonCode: "retry", outcome: retrying })).toBe("waiting");
    expect(outcomeSentence("paused: 3 failed runs in a row", zone)).toBe("Paused after 3 failed runs in a row; resume it to run again.");
    expect(fireState({ reasonCode: "paused", outcome: "paused: 3 failed runs in a row" })).toBe("skipped");
    expect(outcomeSentence("skipped: its retry did not run before a later fire came due", zone)).toBe(
      "Its retry did not run before the next run came due.",
    );
  });
});
