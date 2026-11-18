// @vitest-environment jsdom
import type { AgendaAnswer, CenterSummaryAnswer } from "@tavi/contracts";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { CenterRail } from "../../../src/features/center/CenterRail.js";
import { Schedule } from "../../../src/features/center/Schedule.js";
import {
  cadenceText,
  fireState,
  outcomeSentence,
  routineCadence,
  specText,
  weekdaysText,
} from "../../../src/features/center/schedule-model.js";
import { relativeTime } from "../../../src/lib/time.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { InWorkspace } from "../../support/workspace.js";
import { mount, rerender } from "../../support/dom.js";

/**
 * Schedule: Coming up from `schedules agenda`,
 * under the workspace zone's days; Recurring as routines and plain schedules
 * with a pause switch; and a routine's own page inside the section.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary: CenterSummaryAnswer = {
  workspaceId: "default",
  timezone: "Europe/Berlin",
  today: "2026-09-29",
  counts: { approvals: 0, reviews: 0, questions: 0, runningTasks: 0, memoryProposals: 0, activeRoutines: 2, schedules: 1 },
  perDay: [{ date: "2026-09-29", tasks: 0 }],
  next: [{ kind: "routine", id: "r1", title: "LLM news", at: "2026-09-30T19:00:00.000Z" }],
  people: {},
  cursor: "c1",
};

const berlin = { at: "21:00", timezone: "Europe/Berlin" };

const agenda: AgendaAnswer = {
  timezone: "Europe/Berlin",
  items: [
    {
      kind: "schedule",
      id: "s1",
      title: "Morning brief",
      at: "2026-09-29T05:00:00.000Z",
      cadence: { kind: "daily", at: "07:00", timezone: "Europe/Berlin" },
      enabled: true,
      overdue: true,
    },
    {
      kind: "routine",
      id: "r1",
      triggerId: "evening",
      title: "LLM news",
      at: "2026-09-30T19:00:00.000Z",
      cadence: { kind: "daily", ...berlin },
      enabled: true,
      status: "active",
    },
    // 22:30 UTC on the 30th is 00:30 on 1 October in Berlin.
    {
      kind: "routine",
      id: "r2",
      triggerId: "once",
      title: "Launch check",
      at: "2026-09-30T22:30:00.000Z",
      cadence: { kind: "once" },
      enabled: true,
      status: "active",
    },
    {
      kind: "schedule",
      id: "s2",
      title: "Standup notes",
      at: "2026-10-02T05:00:00.000Z",
      cadence: { kind: "daily", at: "07:00", timezone: "Europe/Berlin", daysOfWeek: [1, 2, 3, 4, 5] },
      enabled: true,
    },
  ],
  truncated: true,
  skipped: ["bad-schedule", "r3/t2"],
};

const lastRun = {
  runId: "run-1",
  routineId: "r1",
  revision: 1,
  mode: "production",
  status: "succeeded",
  claimedAt: "2026-09-29T19:00:00.000Z",
  startedAt: "2026-09-29T19:00:00.000Z",
  endedAt: "2026-09-29T19:05:00.000Z",
};
const routines = [
  {
    routineId: "r1",
    workspaceId: "default",
    principalId: "operator",
    name: "LLM news",
    version: 3,
    activeRevision: 1,
    latestRevision: 1,
    status: "active",
    conversationId: null,
    createdAt: "x",
    updatedAt: "x",
    lastRun,
    nextRunAt: "2026-09-30T19:00:00.000Z",
    triggers: [{ id: "evening", kind: "daily", ...berlin }],
  },
  {
    routineId: "r2",
    workspaceId: "default",
    principalId: "operator",
    name: "Weekly digest",
    version: 7,
    activeRevision: 2,
    latestRevision: 2,
    status: "paused",
    conversationId: null,
    createdAt: "x",
    updatedAt: "x",
    lastRun: null,
    nextRunAt: null,
    triggers: [{ id: "monday", kind: "daily", at: "08:00", timezone: "Europe/Berlin", daysOfWeek: [1] }],
  },
];
const plain = {
  scheduleId: "s1",
  workspaceId: "default",
  principalId: "operator",
  name: "Morning brief",
  spec: { at: "07:00", timezone: "Europe/Berlin" },
  missedRunPolicy: "skip",
  autoApproveTools: [],
  enabled: true,
  nextRunAt: "2026-09-30T05:00:00.000Z",
  lastRunAt: "2026-09-29T05:00:00.000Z",
  lastRunTaskId: null,
  lastOutcome: "completed",
  consecutiveFailures: 0,
  createdAt: "x",
  updatedAt: "x",
};

/** An owner answering Schedule's three lists (and routine actions), recording what it was asked. */
function owner(
  answer: AgendaAnswer = agenda,
  lists: { readonly routines: readonly unknown[]; readonly schedules: readonly unknown[] } = { routines, schedules: [plain] },
  refuse?: string,
) {
  const asked: { readonly command: string; readonly payload: Record<string, unknown> }[] = [];
  const client: SettingsClient = {
    request: async (command, raw) => {
      const payload = raw as Record<string, unknown>;
      asked.push({ command, payload });
      const action = payload["action"];
      if (refuse !== undefined && command === "routines" && (action === "pause" || action === "resume"))
        return { ok: false, error: { code: "CONFLICT", message: refuse } } as never;
      const result =
        command === "schedules" && action === "agenda"
          ? answer
          : command === "schedules" && action === "list"
            ? { schedules: lists.schedules, truncated: false }
            : command === "routines" && action === "list"
              ? { routines: lists.routines }
              : command === "routines" && action === "get"
                ? {
                    routine: routines[0],
                    revision: {
                      revision: 1,
                      snapshot: { objective: "Find news", agent: { name: "Researcher", revision: 1, instructions: "x" }, skills: [] },
                    },
                    evaluation: { status: "passed", detail: "" },
                    schedules: [],
                    state: {},
                    hostStatus: "running",
                  }
                : command === "routines" && action === "history"
                  ? { runs: [] }
                  : command === "routines" && action === "revisions"
                    ? { items: [], nextBeforeRevision: null }
                    : {};
      return { ok: true, result } as never;
    },
  };
  return { client, asked };
}

const section = (page: HTMLElement, label: string): Element | undefined =>
  [...page.querySelectorAll(".schedule-day")].find((day) => day.getAttribute("aria-label") === label);

describe("Schedule's Coming up", () => {
  it("groups the agenda under the workspace zone's days, with times, kinds, cadences and how soon", async () => {
    const { client, asked } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Schedule summary={summary} revision={0} onOpenRoutine={() => undefined} onFollow={async () => undefined} />
      </InWorkspace>,
    );
    expect(asked).toContainEqual({ command: "schedules", payload: { action: "agenda", workspaceId: "default" } });
    const days = () => [...page.querySelectorAll(".schedule-day")].map((day) => day.getAttribute("aria-label"));
    // The first two days show; the rest of the week waits behind a button that counts it.
    expect(days()).toEqual(["Today, Tuesday 29 Sep", "Tomorrow, Wednesday 30 Sep"]);
    const more = page.querySelector<HTMLButtonElement>(".schedule-more");
    expect(more?.textContent).toBe("Show the rest of the week (2 more)");
    await act(async () => more?.click());
    expect(days()).toEqual(["Today, Tuesday 29 Sep", "Tomorrow, Wednesday 30 Sep", "Thursday 1 Oct", "Friday 2 Oct"]);
    expect(more?.textContent).toBe("Show less");
    const tomorrow = section(page, "Tomorrow, Wednesday 30 Sep");
    expect(tomorrow?.querySelector("time")?.textContent).toBe("21:00");
    expect(tomorrow?.querySelector(".schedule-kind")?.textContent).toBe("Routine");
    expect(tomorrow?.querySelector(".schedule-cadence")?.textContent).toBe("Daily 21:00 · Europe/Berlin");
    // In UTC this is still the 30th; the workspace zone puts it on the 1st.
    const thursday = section(page, "Thursday 1 Oct");
    expect(thursday?.querySelector("time")?.textContent).toBe("00:30");
    expect(thursday?.querySelector(".schedule-cadence")?.textContent).toBe("Once");
    const friday = section(page, "Friday 2 Oct");
    expect(friday?.querySelector(".schedule-kind")?.textContent).toBe("Schedule");
    expect(friday?.querySelector(".schedule-cadence")?.textContent).toBe("Mon–Fri 07:00 · Europe/Berlin");
    // How soon is the browser clock's: in some hours or days, or due once the date has passed.
    expect(friday?.querySelector(".schedule-rel")?.textContent).toMatch(/^(in |due now)/);
  });

  it("marks an overdue fire, says when the list is cut off, and names the rows it left out", async () => {
    const page = await mount(
      <InWorkspace client={owner().client} workspaceId="default">
        <Schedule summary={summary} revision={0} onOpenRoutine={() => undefined} onFollow={async () => undefined} />
      </InWorkspace>,
    );
    const today = section(page, "Today, Tuesday 29 Sep");
    expect(today?.querySelector(".schedule-overdue")?.textContent).toBe("Overdue — runs shortly");
    expect(today?.querySelector(".schedule-rel")).toBeNull();
    expect(page.textContent).toContain("Showing the first 4 occurrences");
    expect(page.querySelector(".schedule-skipped")?.textContent).toContain("bad-schedule, r3/t2");
  });

  it("names whose each routine is once more than one person has routines", async () => {
    const hers = { ...routines[1], routineId: "r3", principalId: "ana", name: "Ana's digest" };
    const page = await mount(
      <InWorkspace client={owner(agenda, { routines: [routines[0], hers], schedules: [plain] }).client} workspaceId="default">
        <Schedule
          summary={{ ...summary, people: { ana: "Ana" } }}
          revision={0}
          onOpenRoutine={() => undefined}
          onFollow={async () => undefined}
        />
      </InWorkspace>,
    );
    const row = (name: string) => [...page.querySelectorAll(".schedule-recurring")].find((item) => item.textContent?.includes(name));
    expect(row("Ana's digest")?.querySelector(".reminder-person")?.textContent).toBe(" · for Ana");
    expect(row("LLM news")?.querySelector(".reminder-person")?.textContent).toBe(" · for operator");
    // A revoked person's routine is named and marked, and cannot be paused or resumed from the list.
    const revoked = await mount(
      <InWorkspace
        client={
          owner(agenda, {
            routines: [{ ...routines[0], routineId: "r4", principalId: "bo", name: "Bo's brief", ownerRevoked: true }],
            schedules: [plain],
          }).client
        }
        workspaceId="default"
      >
        <Schedule summary={summary} revision={0} onOpenRoutine={() => undefined} onFollow={async () => undefined} />
      </InWorkspace>,
    );
    const bo = [...revoked.querySelectorAll(".schedule-recurring")].find((item) => item.textContent?.includes("Bo's brief"));
    expect(bo?.textContent).toContain("for bo · no longer allowed");
    expect(bo?.querySelector<HTMLButtonElement>("[role=switch]")?.disabled).toBe(true);
    // One person's routines alone name nobody.
    const own = await mount(
      <InWorkspace client={owner().client} workspaceId="default">
        <Schedule summary={summary} revision={0} onOpenRoutine={() => undefined} onFollow={async () => undefined} />
      </InWorkspace>,
    );
    expect(own.querySelector(".schedule-recurring .reminder-person")).toBeNull();
  });

  it("links a routine's occurrence to its page, and a plain schedule's to its own", async () => {
    const opened: (string | undefined)[] = [];
    const schedules: string[] = [];
    const page = await mount(
      <InWorkspace client={owner().client} workspaceId="default">
        <Schedule
          summary={summary}
          revision={0}
          onOpenRoutine={(id) => opened.push(id)}
          onOpenSchedule={(id) => schedules.push(id)}
          onFollow={async () => undefined}
        />
      </InWorkspace>,
    );
    const link = section(page, "Tomorrow, Wednesday 30 Sep")?.querySelector<HTMLAnchorElement>("a.schedule-title");
    expect(link?.getAttribute("href")).toBe("/center/schedule/routines/r1");
    await act(async () => link?.click());
    expect(opened).toEqual(["r1"]);
    await act(async () => page.querySelector<HTMLButtonElement>(".schedule-more")?.click());
    const standup = section(page, "Friday 2 Oct")?.querySelector<HTMLAnchorElement>("a.schedule-title");
    expect(standup?.getAttribute("href")).toBe("/center/schedule/schedules/s2");
    await act(async () => standup?.click());
    expect(schedules).toEqual(["s2"]);
  });

  it("reads its lists again when the feed reports a routine or schedule change", async () => {
    const { client, asked } = owner();
    const at = (revision: number) => (
      <InWorkspace client={client} workspaceId="default">
        <Schedule summary={summary} revision={revision} onOpenRoutine={() => undefined} onFollow={async () => undefined} />
      </InWorkspace>
    );
    await mount(at(0));
    const agendaReads = () => asked.filter((item) => item.payload["action"] === "agenda").length;
    expect(agendaReads()).toBe(1);
    await rerender(at(1));
    expect(agendaReads()).toBe(2);
    expect(asked.filter((item) => item.command === "routines" && item.payload["action"] === "list")).toHaveLength(2);
  });
});

describe("Schedule's Recurring list", () => {
  it("lists routines and plain schedules soonest first, with cadence, status, last outcome and next run", async () => {
    const page = await mount(
      <InWorkspace client={owner().client} workspaceId="default">
        <Schedule summary={summary} revision={0} onOpenRoutine={() => undefined} onFollow={async () => undefined} />
      </InWorkspace>,
    );
    const rows = [...page.querySelectorAll(".schedule-recurring")];
    // Soonest next run first; a paused routine with nothing due goes last.
    expect(rows.map((row) => row.querySelector(".schedule-kind")?.textContent)).toEqual(["Schedule", "Routine", "Routine"]);
    const [brief, news, digest] = rows;
    expect(news?.textContent).toContain("LLM news");
    expect(news?.textContent).toContain("Daily 21:00 · Europe/Berlin");
    expect(news?.textContent).toContain("Next Wed 30 Sep 21:00");
    expect([...(news?.querySelectorAll(".badge") ?? [])].map((badge) => badge.textContent)).toEqual(["active", "succeeded"]);
    expect(digest?.textContent).toContain("Mon 08:00 · Europe/Berlin");
    expect(digest?.textContent).toContain("Not armed");
    expect(digest?.textContent).toContain("Not run yet.");
    expect(digest?.querySelector(".badge")?.textContent).toBe("paused");
    expect(brief?.textContent).toContain("Daily 07:00 · Europe/Berlin");
    expect(brief?.textContent).toContain("Completed.");
    expect(brief?.querySelector(".badge")?.textContent).toBe("ok");
    expect(brief?.querySelector('[role="switch"]')?.getAttribute("aria-label")).toBe("Pause Morning brief");
  });

  it("pauses an active routine and resumes a paused one through the switch, with the version it read", async () => {
    const { client, asked } = owner();
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Schedule summary={summary} revision={0} onOpenRoutine={() => undefined} onFollow={async () => undefined} />
      </InWorkspace>,
    );
    const pause = page.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Pause LLM news"]');
    expect(pause?.getAttribute("aria-checked")).toBe("true");
    await act(async () => pause?.click());
    expect(asked).toContainEqual({
      command: "routines",
      payload: { action: "pause", routineId: "r1", expectedVersion: 3, workspaceId: "default" },
    });
    expect(page.textContent).toContain("LLM news paused.");
    const resume = page.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Resume Weekly digest"]');
    expect(resume?.getAttribute("aria-checked")).toBe("false");
    await act(async () => resume?.click());
    expect(asked).toContainEqual({
      command: "routines",
      payload: { action: "resume", routineId: "r2", expectedVersion: 7, workspaceId: "default" },
    });
  });

  it("says in the workspace zone when a plain schedule last fired", async () => {
    const page = await mount(
      <InWorkspace client={owner().client} workspaceId="default">
        <Schedule summary={summary} revision={0} onOpenRoutine={() => undefined} onFollow={async () => undefined} />
      </InWorkspace>,
    );
    // 05:00 UTC is 07:00 in Berlin, whatever zone the browser is in.
    expect(page.querySelectorAll(".schedule-recurring")[0]?.textContent).toContain("Last run Tue 29 Sep 07:00");
  });

  it("shows a refused switch's reason and reads the routines again", async () => {
    const { client, asked } = owner(agenda, { routines, schedules: [plain] }, "routine changed since it was read; reload and retry");
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Schedule summary={summary} revision={0} onOpenRoutine={() => undefined} onFollow={async () => undefined} />
      </InWorkspace>,
    );
    const lists = () => asked.filter((item) => item.command === "routines" && item.payload["action"] === "list").length;
    expect(lists()).toBe(1);
    await act(async () => page.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Pause LLM news"]')?.click());
    expect(page.textContent).toContain("routine changed since it was read; reload and retry");
    expect(page.textContent).not.toContain("LLM news paused.");
    expect(lists()).toBe(2);
  });

  it("opens a routine's page inside the section at its address", async () => {
    const page = await mount(
      <InWorkspace client={owner().client} workspaceId="default">
        <Schedule summary={summary} revision={0} routineId="r1" onOpenRoutine={() => undefined} onFollow={async () => undefined} />
      </InWorkspace>,
    );
    expect(page.querySelector(".routine-page .page-title")?.textContent).toContain("LLM news");
    expect(page.querySelector(".schedule-day")).toBeNull();
  });
});

describe("an empty workspace", () => {
  it("says once that nothing is scheduled", async () => {
    const nothing: AgendaAnswer = { timezone: "Europe/Berlin", items: [], truncated: false, skipped: [] };
    const page = await mount(
      <InWorkspace client={owner(nothing, { routines: [], schedules: [] }).client} workspaceId="default">
        <Schedule summary={summary} revision={0} onOpenRoutine={() => undefined} onFollow={async () => undefined} />
      </InWorkspace>,
    );
    expect(page.querySelectorAll(".empty-state")).toHaveLength(1);
    expect(page.querySelector(".empty-state h2")?.textContent).toBe("Nothing scheduled yet");
    expect(page.textContent).not.toContain("Nothing runs in the next 7 days.");
    expect(page.textContent).not.toContain("No routines or schedules yet.");
    expect(page.querySelector(".schedule-recurring-list")).toBeNull();
    // Without reminders, no reminder template either.
    expect([...page.querySelectorAll('.empty-state [aria-label="Start from a template"] button')].map((item) => item.textContent)).toEqual([
      "Morning inbox brief",
      "Weekly research digest",
      "End-of-day wrap-up",
    ]);
  });
});

describe("the rail's Coming up", () => {
  it("links each entry to Schedule", async () => {
    const picked: string[] = [];
    const page = await mount(<CenterRail summary={summary} onSection={(next) => picked.push(next)} />);
    const entry = page.querySelector<HTMLAnchorElement>(".center-next a");
    expect(entry?.getAttribute("href")).toBe("/center/schedule");
    await act(async () => entry?.click());
    expect(picked).toEqual(["schedule"]);
  });

  it("is left out where the page beside it lists the same, and the rest of the rail stays", async () => {
    const page = await mount(<CenterRail summary={summary} onSection={() => undefined} hideComingUp />);
    expect(page.querySelector(".center-next")).toBeNull();
    expect(page.textContent).not.toContain("Coming up");
    expect(page.querySelector(".center-stats")).not.toBeNull();
  });
});

describe("Schedule's words", () => {
  it("says a cadence as people read it", () => {
    expect(cadenceText({ kind: "daily", at: "21:00", timezone: "Europe/Berlin" })).toBe("Daily 21:00 · Europe/Berlin");
    expect(cadenceText({ kind: "once" })).toBe("Once");
    expect(weekdaysText([1, 2, 3, 4, 5])).toBe("Mon–Fri");
    expect(weekdaysText([0, 6])).toBe("Sat, Sun");
    expect(weekdaysText([1, 3])).toBe("Mon, Wed");
    expect(weekdaysText([5, 6, 0, 1])).toBe("Mon, Fri–Sun");
    expect(weekdaysText([0, 1, 2, 3, 4, 5, 6])).toBeUndefined();
    expect(routineCadence([{ id: "a", kind: "once", runAt: "2026-10-01T00:00:00.000Z", consumed: true }])).toBe("Once · fired");
    expect(
      routineCadence([
        { id: "a", kind: "daily", at: "07:00", timezone: "UTC" },
        { id: "b", kind: "once", runAt: "2026-10-01T00:00:00.000Z" },
      ]),
    ).toBe("Daily 07:00 · UTC; Once");
  });

  it("says every cadence a schedule or a routine's trigger may have, and one that finished", () => {
    expect(specText({ at: "07:00", timezone: "Europe/Berlin", daysOfWeek: [1, 2, 3, 4, 5] })).toBe("Mon–Fri 07:00 · Europe/Berlin");
    expect(specText({ times: ["19:00", "07:00"], timezone: "UTC" })).toBe("Daily 07:00, 19:00 · UTC");
    expect(specText({ everyHours: 2, between: { from: "08:00", to: "18:00" }, timezone: "UTC", daysOfWeek: [1, 2, 3, 4, 5] })).toBe(
      "Mon–Fri every 2 h 08:00–18:00 · UTC",
    );
    expect(specText({ at: "09:00", timezone: "UTC", monthly: { nth: -1, weekday: 5 }, until: "2027-06-30" })).toBe(
      "Monthly on the last Fri, 09:00 until 2027-06-30 · UTC",
    );
    expect(specText({ at: "09:00", timezone: "UTC", once: "2026-11-05" })).toBe("Once on 2026-11-05, 09:00 · UTC");
    expect(
      routineCadence([
        { id: "a", kind: "daily", times: ["07:00", "19:00"], timezone: "UTC", yearly: { month: 12, day: 25 } },
        { id: "b", kind: "once", runAt: "2026-10-01T00:00:00.000Z", consumed: true },
      ]),
    ).toBe("Yearly on 25 Dec, 07:00, 19:00 · UTC");
    const finished = "finished: every day at 07:00 (UTC) until 2026-11-02 has no more runs";
    expect(fireState({ reasonCode: "disabled", outcome: finished })).toBe("ok");
    expect(outcomeSentence(finished, "UTC")).toBe("Finished: its last run is past, so it runs no more.");
  });

  it("says how soon", () => {
    const now = Date.parse("2026-09-29T12:00:00.000Z");
    expect(relativeTime("2026-09-29T12:05:00.000Z", now)).toBe("in 5 min");
    expect(relativeTime("2026-09-30T02:00:00.000Z", now)).toBe("in 14 h");
    expect(relativeTime("2026-09-30T13:00:00.000Z", now)).toBe("in 1 day");
    expect(relativeTime("2026-10-05T12:00:00.000Z", now)).toBe("in 6 days");
    expect(relativeTime("2026-09-29T11:00:00.000Z", now)).toBe("due now");
    // Days on the calendar: from a Sunday morning, Monday's 07:00 and 19:30 are both a day away.
    const sunday = Date.parse("2026-11-01T05:30:00.000Z");
    expect(relativeTime("2026-11-02T07:00:00.000Z", sunday, "Europe/London")).toBe("in 1 day");
    expect(relativeTime("2026-11-02T19:30:00.000Z", sunday, "Europe/London")).toBe("in 1 day");
    expect(relativeTime("2026-11-03T05:00:00.000Z", sunday, "Europe/London")).toBe("in 2 days");
  });
});
