// @vitest-environment jsdom
import type { CenterSummaryAnswer, ChannelDescriptor, TaskListRow } from "@tavi/contracts";
import { act } from "react";
import { beforeAll, describe, expect, it } from "vitest";

import { App } from "../../../src/App.js";
import { pageRoutesReady } from "../../../src/features/shell/PageRoute.js";
import { Bar } from "../../../src/features/shell/Bar.js";
import { Activity } from "../../../src/features/center/Activity.js";
import { ChannelNamesProvider } from "../../../src/features/shell/ChannelNames.js";
import { refreshFirstPage } from "../../../src/lib/paging.js";
import { CenterNav } from "../../../src/features/center/CenterNav.js";
import { dayEnd, dayHeading, instantLabel, localDate, localTime } from "../../../src/lib/time.js";
import type { PageNavigation } from "../../../src/features/shell/route.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import type { CanvasState, CanvasStore } from "../../../src/features/chat/store/types.js";
import { InWorkspace } from "../../support/workspace.js";
import { mount, rerender, unmountAll } from "../../support/dom.js";

/**
 * The Command Center in the shell: offered only
 * by an owner that advertises `center`, its nav's counts, and Activity's rows
 * grouped by the day they were asked in the workspace's zone.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The pages beside the chat are lazy chunks: fetched up front, every route renders in one pass.
beforeAll(() => pageRoutesReady());

/** Lets answered requests land and their repaints run. */
const settle = async (ms = 0): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const summary = (overrides: Partial<CenterSummaryAnswer> = {}): CenterSummaryAnswer => ({
  workspaceId: "default",
  timezone: "Europe/Berlin",
  today: "2026-09-29",
  counts: { approvals: 1, reviews: 1, questions: 0, runningTasks: 1, memoryProposals: 2, activeRoutines: 3, schedules: 1 },
  perDay: [
    { date: "2026-09-27", tasks: 1 },
    { date: "2026-09-28", tasks: 1 },
    { date: "2026-09-29", tasks: 4 },
  ],
  next: [{ kind: "routine", id: "r1", title: "Morning news", at: "2026-09-30T05:00:00.000Z" }],
  people: {},
  cursor: "c1",
  ...overrides,
});

/** A row of the list; its prompt preview, which names it, is its id unless a test says otherwise. */
const row = (taskId: string, createdAt: string, extra: Partial<TaskListRow> = {}): TaskListRow => ({
  taskId,
  promptPreview: taskId,
  workspaceId: "default",
  status: "completed",
  origin: "ipc",
  createdAt,
  updatedAt: createdAt,
  needs: [],
  counts: { admissions: 1, tools: null },
  ...extra,
});

/** Two installed channels, named only here: the page takes their names from the catalog. */
const shape = { label: "Id", placeholder: "", pattern: ".+", normalize: "none" } as const;
const CATALOG: readonly ChannelDescriptor[] = [
  {
    providerId: "telegram",
    label: "Telegram",
    kind: "chat",
    icon: { name: "send" },
    description: "d",
    settings: [],
    auth: { kind: "none" },
    sender: { ...shape, authentication: "provider" },
    target: shape,
  },
  {
    providerId: "mailgun",
    label: "Email",
    kind: "email",
    description: "d",
    settings: [],
    auth: { kind: "none" },
    sender: { ...shape, authentication: "per-message" },
    target: shape,
  },
];

/**
 * An owner that answers `tasks list` with `rows`, `center summary` with
 * `answer`, and never answers a watch (the page is left waiting, as it is
 * between changes). It records what it was asked.
 */
function owner(rows: readonly TaskListRow[], answer: CenterSummaryAnswer = summary()) {
  const asked: { readonly command: string; readonly payload: Record<string, unknown> }[] = [];
  const client: SettingsClient & { features: readonly string[] } = {
    features: ["center", "approvals", "routines", "schedules", "memory", "browser"],
    request: (command, payload) => {
      const body = payload as Record<string, unknown>;
      asked.push({ command, payload: body });
      if (command === "center" && body["action"] === "watch") return new Promise<never>(() => undefined);
      if (command === "center") return Promise.resolve({ ok: true, result: answer } as never);
      if (command === "tasks" && body["action"] === "list")
        return Promise.resolve({ ok: true, result: { action: "list", rows, truncated: false } } as never);
      if (command === "channels" && body["action"] === "catalog")
        return Promise.resolve({ ok: true, result: { channels: CATALOG } } as never);
      if (command === "channels" && body["action"] === "list")
        return Promise.resolve({ ok: true, result: { connections: [], ingress: { host: "127.0.0.1", port: 8025 } } } as never);
      return new Promise<never>(() => undefined);
    },
  };
  return { client, asked };
}

function fakeStore(state: CanvasState): CanvasStore {
  return {
    loadArtifacts: async () => undefined,
    reviewArtifacts: () => undefined,
    answerQuestion: () => undefined,
    loadWorkerNeeds: async () => undefined,
    answerWorker: () => undefined,
    decideWorkerRound: () => undefined,
    loadNotices: async () => undefined,
    replyToNotice: () => undefined,
    heartbeatTurn: () => undefined,
    loadSessions: async () => undefined,
    openTask: async () => undefined,
    getSnapshot: () => state,
    subscribe: () => () => undefined,
    submit: () => undefined,
    newTask: () => undefined,
    setHome: () => undefined,
    openHome: () => undefined,
    cancelQueued: () => undefined,
    rewind: async () => ({ ok: false as const, message: "" }),
    steerQueued: () => undefined,
    dropPluginStatus: () => undefined,
    loadEarlier: () => undefined,
    decide: () => undefined,
    abort: () => undefined,
    setExpanded: () => undefined,
    dispose: () => undefined,
  };
}

function fakeNavigation(initial: string) {
  let pathname = initial;
  const navigation: PageNavigation = {
    get location(): { readonly pathname: string } {
      return { pathname };
    },
    history: {
      pushState: (_data, _unused, url) => void (url !== undefined && (pathname = url)),
      replaceState: (_data, _unused, url) => void (url !== undefined && (pathname = url)),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return { navigation, path: () => pathname };
}

const tabs = (page: HTMLElement): string[] => [...page.querySelectorAll(".bar .views .view")].map((tab) => tab.textContent ?? "");

describe("the Center tab", () => {
  it("is absent, and the needs pill stays, when the owner does not offer the Command Center", async () => {
    const page = await mount(
      <InWorkspace>
        <Bar state={{ connection: "ready", runs: [] }} route="chat" onRoute={() => undefined} needs={2} />
      </InWorkspace>,
    );
    expect(tabs(page)).toEqual(["Chat", "Settings"]);
    expect(page.querySelector(".needs-count")?.textContent).toContain("2 chats need you");
  });

  it("carries what is waiting as its badge, in place of the needs pill", async () => {
    const page = await mount(
      <InWorkspace>
        <Bar state={{ connection: "ready", runs: [] }} route="chat" onRoute={() => undefined} needs={2} center={{ waiting: 4 }} />
      </InWorkspace>,
    );
    expect(tabs(page).map((tab) => tab.split(",")[0])).toEqual(["Chat", "Center4", "Settings"]);
    expect(page.querySelector(".view-count .visually-hidden")?.textContent).toBe(", 4 waiting");
    expect(page.querySelector(".needs-count")).toBeNull();
  });

  it("is offered by the shell only when the client's owner advertises center", async () => {
    const store = fakeStore({ connection: "ready", runs: [] });
    const without: SettingsClient & { features: readonly string[] } = { features: [], request: () => new Promise<never>(() => undefined) };
    let page = await mount(<App store={store} client={without} workspaceId="default" />);
    expect(tabs(page)).not.toContain("Center");
    unmountAll();

    const { client } = owner([]);
    page = await mount(<App store={store} client={client} workspaceId="default" />);
    await settle();
    // approvals 1 + reviews 1 + questions 0 + memory proposals 2.
    expect(page.querySelector(".bar .view-count")?.textContent).toContain("4 waiting");
  });

  it("opens the section nav and Activity on /center, and writes a picked section to the address", async () => {
    const address = fakeNavigation("/center");
    const { client } = owner([]);
    const page = await mount(
      <App store={fakeStore({ connection: "ready", runs: [] })} client={client} workspaceId="default" navigation={address.navigation} />,
    );
    await settle();
    expect(page.querySelector('nav[aria-label="Command Center sections"]')).not.toBeNull();
    expect(page.querySelector("h1")?.textContent).toBe("Activity");
    expect(page.textContent).toContain(
      "Tasks you start anywhere — here, in the terminal, or in a chat on one of your channels — appear here.",
    );
    const approvals = [...page.querySelectorAll(".center-nav-item")].find((item) => item.textContent?.startsWith("Approvals"));
    await act(async () => (approvals as HTMLElement).click());
    expect(address.path()).toBe("/center/approvals");
    expect(page.querySelector("h1")?.textContent).toBe("Approvals");
    // The rail's waiting counts lead to their section.
    const memory = [...page.querySelectorAll(".center-need")].find((item) => item.textContent?.includes("memory proposals"));
    await act(async () => (memory as HTMLElement).click());
    expect(address.path()).toBe("/center/identity");
  });
});

describe("the section nav", () => {
  it("counts each section from the summary, speaks the counts, and marks the current one", async () => {
    const page = await mount(
      <InWorkspace workspaceId="default">
        <CenterNav section="approvals" summary={summary()} onSection={() => undefined} />
      </InWorkspace>,
    );
    const nav = page.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Command Center sections");
    const item = (label: string) =>
      [...page.querySelectorAll(".center-nav-item")].find((button) => button.querySelector(".center-nav-label")?.textContent === label);
    expect(item("Activity")?.querySelector(".visually-hidden")?.textContent).toBe("4 today");
    expect(item("Approvals")?.querySelector(".visually-hidden")?.textContent).toBe("2 waiting");
    expect(item("Schedule")?.querySelector(".visually-hidden")?.textContent).toBe("4 scheduled");
    expect(item("Soul & memory")?.querySelector(".visually-hidden")?.textContent).toBe("2 to review");
    expect(item("Browser")?.querySelector(".center-count")).toBeNull();
    expect(item("Approvals")?.getAttribute("aria-current")).toBe("page");
    expect(item("Activity")?.getAttribute("aria-current")).toBeNull();
    expect(page.textContent).toContain("Europe/Berlin");
  });
});

describe("Activity", () => {
  it("groups tasks by the day they were asked in the workspace zone, not the browser's", () => {
    // 23:30 UTC on the 28th is 01:30 on the 29th in Berlin.
    expect(localDate("2026-09-28T23:30:00.000Z", "Europe/Berlin")).toBe("2026-09-29");
    expect(localTime("2026-09-28T23:30:00.000Z", "Europe/Berlin")).toBe("01:30");
    expect(localDate("2026-09-28T23:30:00.000Z", "UTC")).toBe("2026-09-28");
    expect(dayHeading("2026-09-29", "2026-09-29")).toEqual({ title: "Today", detail: "Tue 29 Sep" });
    expect(dayHeading("2026-09-28", "2026-09-29")).toEqual({ title: "Yesterday", detail: "Mon 28 Sep" });
    expect(dayHeading("2026-09-27", "2026-09-29")).toEqual({ title: "Sunday", detail: "27 Sep" });
  });

  it("labels an instant by the workspace zone's day: the time alone today, else the day and time", () => {
    // 23:30 UTC on the 28th is 01:30 on the 29th in Berlin.
    expect(instantLabel("2026-09-28T23:30:00.000Z", "Europe/Berlin", "2026-09-29")).toBe("01:30");
    expect(instantLabel("2026-09-28T23:30:00.000Z", "UTC", "2026-09-29")).toBe("Mon 28 Sep 23:30");
    expect(instantLabel("2025-12-31T09:00:00.000Z", "UTC", "2026-09-29")).toBe("Wed 31 Dec 2025 09:00");
  });

  it("expands a row's +N delegated into its workers, each opening its view-only transcript", async () => {
    const base = owner([row("task-late", "2026-09-28T23:30:00.000Z", { title: "Plan the week", delegated: 2 })]);
    const tree = {
      taskId: "task-late",
      workspaceId: "default",
      ancestors: [],
      truncated: false,
      ancestryUnknown: false,
      nodes: [
        { taskId: "task-late", status: "running", depth: 0, createdAt: "2026-09-28T23:30:00.000Z", updatedAt: "2026-09-28T23:30:00.000Z" },
        {
          taskId: "w1",
          parentTaskId: "task-late",
          agentDefinitionId: "researcher",
          status: "completed",
          depth: 1,
          createdAt: "2026-09-28T23:30:00.000Z",
          updatedAt: "2026-09-28T23:31:00.000Z",
        },
        {
          taskId: "w2",
          parentTaskId: "task-late",
          workerAgentId: "agent-2",
          status: "running",
          depth: 1,
          createdAt: "2026-09-28T23:30:00.000Z",
          updatedAt: "2026-09-28T23:31:00.000Z",
        },
      ],
    };
    const asked: string[] = [];
    const client: SettingsClient = {
      request: (command, payload) => {
        if (command === "agents") {
          asked.push(JSON.stringify(payload));
          return Promise.resolve({ ok: true, result: tree } as never);
        }
        return base.client.request(command, payload);
      },
    };
    const workers: { root: string; taskId: string; label: string }[] = [];
    const opened: string[] = [];
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Activity
          summary={summary()}
          revision={0}
          onOpen={async (taskId) => void opened.push(taskId)}
          onOpenWorker={async (root, worker) => void workers.push({ root, ...worker })}
        />
      </InWorkspace>,
    );
    await settle();
    const toggle = page.querySelector(".center-delegated button") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(asked).toEqual([]);
    await act(async () => toggle.click());
    await settle();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(asked).toEqual([JSON.stringify({ action: "tree", workspaceId: "default", taskId: "task-late", limit: 200, detail: false })]);
    const items = [...page.querySelectorAll(".center-delegated li")];
    expect(items.map((item) => item.textContent)).toEqual(["completedresearcher", "runningagent-2"]);
    await act(async () => (items[0]?.querySelector("button") as HTMLElement).click());
    expect(workers).toEqual([{ root: "task-late", taskId: "w1", label: "researcher" }]);
    expect(opened).toEqual([]);
    await act(async () => toggle.click());
    expect(page.querySelector(".center-delegated li")).toBeNull();
  });

  it("lists tasks under their local day, with origin, person, delegation, tool calls and status", async () => {
    const rows = [
      row("task-late", "2026-09-28T23:30:00.000Z", {
        title: "Plan the week",
        lastText: "Wrote the plan",
        origin: "messaging",
        delegated: 2,
        counts: { admissions: 1, tools: 5 },
        principalId: "khan",
      }),
      row("task-noon", "2026-09-28T10:00:00.000Z", {
        promptPreview: "Morning news digest",
        origin: "schedule",
        status: "working",
        principalId: "operator",
      }),
      row("task-sun", "2026-09-27T08:00:00.000Z", { origin: null, status: "failed", needs: [] }),
      row("task-wait", "2026-09-27T07:00:00.000Z", { title: "Book tickets", origin: "agent", status: "working", needs: ["approval"] }),
    ];
    const { client, asked } = owner(rows);
    const opened: string[] = [];
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Activity
          summary={summary({ people: { khan: "Khan", operator: "Operator" } })}
          revision={0}
          onOpen={async (taskId) => void opened.push(taskId)}
        />
      </InWorkspace>,
    );
    await settle();
    expect(asked.find((call) => call.command === "tasks")?.payload).toEqual({
      action: "list",
      workspaceId: "default",
      order: "created",
      limit: 50,
    });

    const days = [...page.querySelectorAll(".center-day")];
    expect(days.map((day) => day.querySelector(".center-day-head")?.textContent)).toEqual([
      "TodayTue 29 Sep · 1 task",
      "YesterdayMon 28 Sep · 1 task",
      "Sunday27 Sep · 2 tasks",
    ]);
    const late = days[0]?.querySelector(".center-row");
    expect(late?.querySelector("time")?.textContent).toBe("01:30");
    expect(late?.querySelector(".center-row-title")?.textContent).toBe("Plan the week");
    expect(late?.querySelector(".center-row-text")?.textContent).toBe("Wrote the plan");
    const meta = late?.querySelector(".center-row-meta")?.textContent ?? "";
    expect(meta).toContain("Messaging");
    expect(meta).toContain("Khan");
    expect(meta).not.toContain("delegated");
    expect(days[0]?.querySelector(".center-delegated button")?.textContent).toBe("+2 delegated ");
    expect(meta).toContain("5 tool calls");
    expect(late?.querySelector(".center-mark")?.textContent).toBe("Done");

    const noon = days[1]?.querySelector(".center-row");
    expect(noon?.querySelector(".center-row-title")?.textContent).toBe("Morning news digest");
    expect(noon?.querySelector(".center-origin")?.textContent).toBe("Schedule");
    expect(noon?.querySelector(".center-mark-working .center-pulse")).not.toBeNull();

    const sunday = [...(days[2]?.querySelectorAll(".center-row") ?? [])];
    expect(sunday.map((item) => item.querySelector(".center-row-title")?.textContent)).toEqual(["task-sun", "Book tickets"]);
    expect(sunday.map((item) => item.querySelector(".center-origin")?.textContent)).toEqual(["Other", "Agent"]);
    expect(sunday.map((item) => item.querySelector(".center-mark")?.textContent)).toEqual(["Failed", "Needs you"]);

    // More than one person: a Person filter, and it filters.
    const personChips = page.querySelector('[aria-label="Filter by person"]');
    expect(personChips?.textContent).toBe("EveryoneKhanOperator");
    await act(async () =>
      ([...(personChips?.querySelectorAll("button") ?? [])].find((chip) => chip.textContent === "Khan") as HTMLElement).click(),
    );
    expect([...page.querySelectorAll(".center-row-title")].map((title) => title.textContent)).toEqual(["Plan the week"]);

    // A source chip per origin present.
    const sources = page.querySelector('[aria-label="Filter by source"]');
    expect([...(sources?.querySelectorAll("button") ?? [])].map((chip) => chip.textContent)).toEqual([
      "All sources",
      "Messaging",
      "Schedule",
      "Agent",
      "Other",
    ]);

    await act(async () => (page.querySelector(".center-row") as HTMLElement).click());
    expect(opened).toEqual(["task-late"]);
  });

  it("names each row's source from its channel, and filters by the channel's kind", async () => {
    const rows = [
      row("web", "2026-09-29T09:00:00.000Z", { origin: "web", channel: { kind: "web" } }),
      row("term", "2026-09-29T08:50:00.000Z", { origin: "ipc", channel: { kind: "terminal" } }),
      row("tg", "2026-09-29T08:40:00.000Z", { origin: "messaging", channel: { kind: "telegram", label: "telegram-default" } }),
      row("mail", "2026-09-29T08:30:00.000Z", { origin: "messaging", channel: { kind: "mailgun", label: "mailgun-default" } }),
      row("news", "2026-09-29T08:20:00.000Z", { origin: null, channel: { kind: "routine", label: "Morning news" } }),
      row("news-2", "2026-09-29T08:15:00.000Z", { origin: null, channel: { kind: "routine", label: "Evening digest" } }),
      row("pills", "2026-09-29T08:10:00.000Z", { origin: "reminder", channel: { kind: "reminder", label: "Take the pills" } }),
      row("backup", "2026-09-29T08:00:00.000Z", { origin: "schedule", channel: { kind: "schedule", label: "Nightly backup" } }),
      row("worker", "2026-09-29T07:50:00.000Z", { origin: "agent", channel: { kind: "agent" } }),
      // An older owner's row: no channel, so its origin names it.
      row("legacy", "2026-09-29T07:40:00.000Z", { origin: "ipc" }),
    ];
    const { client } = owner(rows);
    const page = await mount(
      <ChannelNamesProvider client={client} workspaceId="default">
        <InWorkspace client={client} workspaceId="default">
          <Activity summary={summary()} revision={0} onOpen={async () => undefined} />
        </InWorkspace>
      </ChannelNamesProvider>,
    );
    await settle();
    // Each channel's chip carries its icon: the builtin glyph its descriptor names, else its kind's.
    expect(page.querySelectorAll(".center-row .center-origin svg.channel-icon")).toHaveLength(2);
    const chipsOf = () => [...page.querySelectorAll(".center-row .center-origin")].map((chip) => chip.textContent);
    expect(chipsOf()).toEqual([
      "Web",
      "Terminal",
      "Telegram",
      "Email",
      "Routine: Morning news",
      "Routine: Evening digest",
      "Reminder",
      "Schedule: Nightly backup",
      "Agent",
      "Terminal",
    ]);
    const origin = (taskId: string) =>
      [...page.querySelectorAll(".center-row")]
        .find((item) => item.querySelector(".center-row-title")?.textContent === taskId)
        ?.querySelector(".center-origin");
    expect(origin("pills")?.getAttribute("title")).toBe("Take the pills");
    expect(origin("tg")?.className).toContain("center-origin-channel");
    const sources = () => [...page.querySelectorAll('[aria-label="Filter by source"] button')];
    // The channels by their names, from their descriptors, after the front ends.
    expect(sources().map((chip) => chip.textContent)).toEqual([
      "All sources",
      "Web",
      "Terminal",
      "Email",
      "Telegram",
      "Routine",
      "Reminder",
      "Schedule",
      "Agent",
    ]);
    await act(async () => (sources().find((chip) => chip.textContent === "Routine") as HTMLElement).click());
    expect([...page.querySelectorAll(".center-row-title")].map((title) => title.textContent)).toEqual(["news", "news-2"]);
    await act(async () => (sources().find((chip) => chip.textContent === "Terminal") as HTMLElement).click());
    expect([...page.querySelectorAll(".center-row-title")].map((title) => title.textContent)).toEqual(["term", "legacy"]);
  });

  it("opens a row's task with its chat panel from the row's own control, and offers none without it", async () => {
    const { client } = owner([row("audit", "2026-09-29T09:00:00.000Z")]);
    const opened: string[] = [];
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Activity
          summary={summary()}
          revision={0}
          onOpen={async () => undefined}
          onOpenWithPanel={async (taskId) => void opened.push(taskId)}
        />
      </InWorkspace>,
    );
    await settle();
    await act(async () => (page.querySelector('[aria-label="Open audit with its panel"]') as HTMLElement).click());
    expect(opened).toEqual(["audit"]);
    unmountAll();
    const plain = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Activity summary={summary()} revision={0} onOpen={async () => undefined} />
      </InWorkspace>,
    );
    await settle();
    expect(plain.querySelector('[aria-label$="with its panel"]')).toBeNull();
  });

  it("names a row with no title and no prompt Untitled chat, never by its task id", async () => {
    const { client } = owner([row("task-9f3a", "2026-09-29T09:00:00.000Z", { promptPreview: undefined })]);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Activity summary={summary()} revision={0} onOpen={async () => undefined} onOpenWithPanel={async () => undefined} />
      </InWorkspace>,
    );
    await settle();
    expect(page.querySelector(".center-row-title")?.textContent).toBe("Untitled chat");
    expect(page.querySelector('[aria-label="Open Untitled chat with its panel"]')).not.toBeNull();
    expect(page.textContent).not.toContain("task-9f3a");
  });

  it("asks the owner for the source and person picked, keeping every source's chip", async () => {
    const rows = [
      row("tg", "2026-09-29T09:00:00.000Z", {
        origin: "messaging",
        channel: { kind: "telegram", label: "telegram-default" },
        principalId: "khan",
      }),
      row("news", "2026-09-29T08:00:00.000Z", {
        origin: null,
        channel: { kind: "routine", label: "Morning news" },
        principalId: "operator",
      }),
      row("legacy", "2026-09-29T07:00:00.000Z", { origin: null, principalId: "operator" }),
    ];
    const { client, asked } = owner(rows);
    const page = await mount(
      <ChannelNamesProvider client={client} workspaceId="default">
        <InWorkspace client={client} workspaceId="default">
          <Activity summary={summary({ people: { khan: "Khan", operator: "Operator" } })} revision={0} onOpen={async () => undefined} />
        </InWorkspace>
      </ChannelNamesProvider>,
    );
    await settle();
    const lists = () => asked.filter((call) => call.command === "tasks").map((call) => call.payload);
    const chip = (group: string, label: string) =>
      [...page.querySelectorAll(`[aria-label="${group}"] button`)].find((item) => item.textContent === label) as HTMLElement;
    await act(async () => chip("Filter by source", "Routine").click());
    await settle();
    expect(lists().at(-1)).toEqual({ action: "list", workspaceId: "default", order: "created", limit: 50, channelKinds: ["routine"] });
    // The other sources keep their chips while one filters.
    expect([...page.querySelectorAll('[aria-label="Filter by source"] button')].map((item) => item.textContent)).toEqual([
      "All sources",
      "Telegram",
      "Routine",
      "Other",
    ]);
    await act(async () => chip("Filter by person", "Operator").click());
    await settle();
    expect(lists().at(-1)).toEqual({
      action: "list",
      workspaceId: "default",
      order: "created",
      limit: 50,
      channelKinds: ["routine"],
      principalId: "operator",
    });
    // A row with no channel cannot be asked for: "Other" filters the page's rows.
    await act(async () => chip("Filter by source", "Other").click());
    await settle();
    expect(lists().at(-1)).toEqual({ action: "list", workspaceId: "default", order: "created", limit: 50, principalId: "operator" });
    expect([...page.querySelectorAll(".center-row-title")].map((title) => title.textContent)).toEqual(["legacy"]);
  });

  it("loads a day the strip names that the list does not hold, listing back from the end of that day in the workspace zone", async () => {
    const newest = [row("today", "2026-09-29T08:00:00.000Z")];
    const older = [row("sunday", "2026-09-27T10:00:00.000Z"), row("saturday", "2026-09-26T10:00:00.000Z")];
    const asked: Record<string, unknown>[] = [];
    const client: SettingsClient = {
      request: (command, payload) => {
        const body = payload as Record<string, unknown>;
        if (command !== "tasks") return new Promise<never>(() => undefined);
        asked.push(body);
        return Promise.resolve({
          ok: true,
          result: { action: "list", rows: body["until"] === undefined ? newest : older, truncated: false },
        } as never);
      },
    };
    const scrolled: string[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        scrolled.push(this.id);
      },
    });
    try {
      const page = await mount(
        <InWorkspace client={client} workspaceId="default">
          <Activity summary={summary()} revision={0} onOpen={async () => undefined} />
        </InWorkspace>,
      );
      await settle();
      const bar = (label: string) =>
        [...page.querySelectorAll<HTMLButtonElement>(".center-strip button")].find((item) =>
          item.getAttribute("title")?.endsWith(label),
        ) as HTMLButtonElement;
      // Every bar can be followed; one for a day not listed says it loads that day.
      expect(bar("Sun 27 Sep").disabled).toBe(false);
      expect(bar("Sun 27 Sep").getAttribute("aria-label")).toBe("1 turn on Sun 27 Sep (loads that day)");
      await act(async () => bar("Sun 27 Sep").click());
      await settle();
      // The end of Sunday in Berlin is 21:59:59.999 UTC.
      expect(asked.at(-1)).toMatchObject({ until: "2026-09-27T21:59:59.999Z" });
      expect([...page.querySelectorAll(".center-row-title")].map((title) => title.textContent)).toEqual(["sunday", "saturday"]);
      expect(scrolled).toContain("center-day-2026-09-27");
      expect(page.querySelector(".center-from")?.textContent).toContain("Showing tasks from Sun 27 Sep and before.");
      // A listed day is only scrolled to.
      const reads = asked.length;
      await act(async () => bar("Sun 27 Sep").click());
      expect(asked).toHaveLength(reads);
      await act(async () => (page.querySelector(".center-from button") as HTMLElement).click());
      await settle();
      expect(asked.at(-1)?.["until"]).toBeUndefined();
      expect([...page.querySelectorAll(".center-row-title")].map((title) => title.textContent)).toEqual(["today"]);
      expect(page.querySelector(".center-from")).toBeNull();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("stops waiting for a picked day once its read answers without it, or once the filters change", async () => {
    const newest = [
      row("today", "2026-09-29T08:00:00.000Z", { origin: null, channel: { kind: "routine", label: "News" } }),
      row("asked", "2026-09-29T07:00:00.000Z", { origin: "web", channel: { kind: "web" } }),
    ];
    const saturday = [row("saturday", "2026-09-26T10:00:00.000Z")];
    const sunday = [row("sunday", "2026-09-27T10:00:00.000Z", { origin: null, channel: { kind: "routine", label: "News" } })];
    let slow = false;
    const client: SettingsClient = {
      request: (command, payload) => {
        const body = payload as Record<string, unknown>;
        if (command !== "tasks") return new Promise<never>(() => undefined);
        const answer = (rows: readonly TaskListRow[], nextCursor?: string) =>
          Promise.resolve({
            ok: true,
            result: { action: "list", rows, truncated: false, ...(nextCursor === undefined ? {} : { nextCursor }) },
          } as never);
        if (body["cursor"] === "older") return answer(sunday);
        if (body["until"] === undefined) return answer(newest, "older");
        // A read for Sunday finds none there — or, once `slow`, answers only after the filter has changed.
        if (body["channelKinds"] === undefined) return slow ? new Promise<never>(() => undefined) : answer(saturday);
        return answer(sunday);
      },
    };
    const scrolled: string[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        scrolled.push(this.id);
      },
    });
    try {
      const page = await mount(
        <InWorkspace client={client} workspaceId="default">
          <Activity summary={summary()} revision={0} onOpen={async () => undefined} />
        </InWorkspace>,
      );
      await settle();
      const bar = (label: string) =>
        [...page.querySelectorAll<HTMLButtonElement>(".center-strip button")].find((item) =>
          item.getAttribute("title")?.endsWith(label),
        ) as HTMLButtonElement;
      await act(async () => bar("Sun 27 Sep").click());
      await settle();
      expect([...page.querySelectorAll(".center-row-title")].map((title) => title.textContent)).toEqual(["saturday"]);
      // Back to the newest, then older days: Sunday is listed now, but nobody asked to go there.
      await act(async () => (page.querySelector(".center-from button") as HTMLElement).click());
      await settle();
      await act(async () =>
        ([...page.querySelectorAll("button")].find((button) => button.textContent === "Load older") as HTMLElement).click(),
      );
      await settle();
      expect(page.querySelector("#center-day-2026-09-27")).not.toBeNull();
      expect(scrolled).not.toContain("center-day-2026-09-27");

      // Picked, then the source changed before the day was shown: the new list is not scrolled either.
      unmountAll();
      slow = true;
      const page2 = await mount(
        <InWorkspace client={client} workspaceId="default">
          <Activity summary={summary()} revision={0} onOpen={async () => undefined} />
        </InWorkspace>,
      );
      await settle();
      await act(async () =>
        (
          [...page2.querySelectorAll<HTMLButtonElement>(".center-strip button")].find((item) =>
            item.getAttribute("title")?.endsWith("Sun 27 Sep"),
          ) as HTMLButtonElement
        ).click(),
      );
      await act(async () =>
        (
          [...page2.querySelectorAll('[aria-label="Filter by source"] button')].find(
            (chip) => chip.textContent === "Routine",
          ) as HTMLElement
        ).click(),
      );
      await settle();
      expect(page2.querySelector("#center-day-2026-09-27")).not.toBeNull();
      expect(scrolled).not.toContain("center-day-2026-09-27");
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("names the end of a local day as an instant", () => {
    expect(dayEnd("2026-09-27", "Europe/Berlin")).toBe("2026-09-27T21:59:59.999Z");
    expect(dayEnd("2026-09-27", "UTC")).toBe("2026-09-27T23:59:59.999Z");
    // The day the clocks go back is 25 hours long.
    expect(dayEnd("2026-10-25", "Europe/Berlin")).toBe("2026-10-25T22:59:59.999Z");
  });

  it("expands a row's follow-ups, read from the owner only when first opened", async () => {
    const rows = [
      row("asked", "2026-09-29T08:00:00.000Z", { followUps: 2 }),
      row("once", "2026-09-29T07:00:00.000Z", { followUps: 0 }),
      row("older-owner", "2026-09-29T06:00:00.000Z"),
    ];
    const asked: Record<string, unknown>[] = [];
    let answer: (value: unknown) => void = () => undefined;
    const client: SettingsClient = {
      request: (command, payload) => {
        const body = payload as Record<string, unknown>;
        if (command === "tasks" && body["action"] === "list")
          return Promise.resolve({ ok: true, result: { action: "list", rows, truncated: false } } as never);
        if (command === "tasks" && body["action"] === "prompts") {
          asked.push(body);
          return new Promise((resolve) => (answer = resolve)) as never;
        }
        return new Promise<never>(() => undefined);
      },
    };
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Activity summary={summary()} revision={0} onOpen={async () => undefined} />
      </InWorkspace>,
    );
    await settle();
    const toggles = [...page.querySelectorAll<HTMLButtonElement>(".center-followups-toggle")];
    // Only a row with follow-ups offers them; nothing is read before a toggle is opened.
    expect(toggles.map((toggle) => toggle.textContent?.trim())).toEqual(["2 follow-ups"]);
    expect(toggles[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(asked).toEqual([]);
    await act(async () => toggles[0]?.click());
    expect(toggles[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(asked).toEqual([{ action: "prompts", workspaceId: "default", taskId: "asked" }]);
    expect(page.querySelector(".center-followups")?.textContent).toContain("Loading follow-ups…");
    await act(async () =>
      answer({
        ok: true,
        result: {
          action: "prompts",
          truncated: false,
          items: [
            { at: "2026-09-29T08:05:00.000Z", text: "Make it shorter" },
            { at: "2026-09-30T07:00:00.000Z", text: "And in German" },
          ],
        },
      }),
    );
    await settle();
    const items = [...page.querySelectorAll(".center-followups-list li")].map((item) => [
      item.querySelector("time")?.textContent,
      item.querySelector("span")?.textContent,
    ]);
    // Berlin time; the second was sent on another day, so it carries the day.
    expect(items).toEqual([
      ["10:05", "Make it shorter"],
      ["Wed 30 Sep 09:00", "And in German"],
    ]);
    // Closing and opening again does not ask the owner a second time.
    await act(async () => toggles[0]?.click());
    expect(page.querySelector(".center-followups-list")).toBeNull();
    await act(async () => toggles[0]?.click());
    expect(asked).toHaveLength(1);
    expect(page.querySelectorAll(".center-followups-list li")).toHaveLength(2);
  });

  it("keeps an open follow-ups list open when a live refresh raises the count, and reads it again", async () => {
    let rows: readonly TaskListRow[] = [row("asked", "2026-09-29T08:00:00.000Z", { followUps: 1 })];
    const reads: number[] = [];
    const client: SettingsClient = {
      request: (command, payload) => {
        const body = payload as Record<string, unknown>;
        if (command === "tasks" && body["action"] === "list")
          return Promise.resolve({ ok: true, result: { action: "list", rows, truncated: false } } as never);
        if (command === "tasks" && body["action"] === "prompts") {
          reads.push(reads.length);
          const items = ["Make it shorter", "And in German"]
            .slice(0, reads.length)
            .map((text, index) => ({ at: `2026-09-29T08:0${index + 1}:00.000Z`, text }));
          return Promise.resolve({ ok: true, result: { action: "prompts", truncated: false, items } } as never);
        }
        return new Promise<never>(() => undefined);
      },
    };
    const element = (revision: number) => (
      <InWorkspace client={client} workspaceId="default">
        <Activity summary={summary()} revision={revision} onOpen={async () => undefined} />
      </InWorkspace>
    );
    const page = await mount(element(0));
    await settle();
    await act(async () => page.querySelector<HTMLButtonElement>(".center-followups-toggle")?.click());
    await settle();
    expect([...page.querySelectorAll(".center-followups-list li span")].map((item) => item.textContent)).toEqual(["Make it shorter"]);
    rows = [row("asked", "2026-09-29T08:00:00.000Z", { followUps: 2 })];
    await rerender(element(1));
    await settle();
    const toggle = page.querySelector(".center-followups-toggle");
    expect(toggle?.textContent?.trim()).toBe("2 follow-ups");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(reads).toHaveLength(2);
    expect([...page.querySelectorAll(".center-followups-list li span")].map((item) => item.textContent)).toEqual([
      "Make it shorter",
      "And in German",
    ]);
  });

  it("shows a task's generated title and summary, and its last text when it has no summary yet", async () => {
    const rows = [
      row("summarized", "2026-09-29T09:00:00.000Z", {
        title: "Finish SEO and content action plan",
        titleSource: "generated",
        summary: "Delivered the 90-day SEO roadmap PDF",
        summaryState: "done",
        lastText: "Here is the full roadmap…",
        promptPreview: "please look at the seo stuff",
      }),
      row("waiting", "2026-09-29T08:00:00.000Z", {
        title: "Book the train",
        titleSource: "prompt",
        summary: null,
        summaryState: "pending",
        lastText: "Booked the 9:10",
      }),
    ];
    const { client } = owner(rows);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Activity summary={summary()} revision={0} onOpen={async () => undefined} />
      </InWorkspace>,
    );
    await settle();
    const [first, second] = [...page.querySelectorAll(".center-row")];
    expect(first?.querySelector(".center-row-title")?.textContent).toBe("Finish SEO and content action plan");
    expect(first?.querySelector(".center-row-text")?.textContent).toBe("Delivered the 90-day SEO roadmap PDF");
    expect(second?.querySelector(".center-row-title")?.textContent).toBe("Book the train");
    expect(second?.querySelector(".center-row-text")?.textContent).toBe("Booked the 9:10");
  });

  it("warns of the owner's sustained growth above the day strip, and says nothing while it is healthy", async () => {
    const { client } = owner([]);
    const warning = "the owner's memory (RSS) grew 2.3x in 6 hours (200 MB to 450 MB) and stayed there";
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Activity summary={summary({ health: [warning] })} revision={0} onOpen={async () => undefined} />
      </InWorkspace>,
    );
    await settle();
    expect(page.querySelector(".center-health")?.textContent).toBe(warning);
    unmountAll();
    const healthy = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Activity summary={summary()} revision={0} onOpen={async () => undefined} />
      </InWorkspace>,
    );
    await settle();
    expect(healthy.querySelector(".center-health")).toBeNull();
  });

  it("shows no Person filter or names for a workspace with one person", async () => {
    const { client } = owner([row("t1", "2026-09-29T08:00:00.000Z", { principalId: "operator" })]);
    const page = await mount(
      <InWorkspace client={client} workspaceId="default">
        <Activity summary={summary({ people: { operator: "Operator" } })} revision={0} onOpen={async () => undefined} />
      </InWorkspace>,
    );
    await settle();
    expect(page.querySelector('[aria-label="Filter by person"]')).toBeNull();
    expect(page.querySelector(".center-row-meta")?.textContent).not.toContain("Operator");
  });

  it("asks the owner for the search once typing rests, and again when the feed says a task changed", async () => {
    const { client, asked } = owner([]);
    const element = (revision: number) => (
      <InWorkspace client={client} workspaceId="default">
        <Activity summary={summary()} revision={revision} onOpen={async () => undefined} />
      </InWorkspace>
    );
    const page = await mount(element(0));
    await settle();
    const input = page.querySelector<HTMLInputElement>('input[aria-label="Search activity"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "seo");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const lists = () => asked.filter((call) => call.command === "tasks");
    expect(lists()).toHaveLength(1);
    await settle(300);
    expect(lists().at(-1)?.payload["query"]).toBe("seo");
    const before = lists().length;
    await rerender(element(1));
    await settle();
    expect(lists()).toHaveLength(before + 1);
    expect(lists().at(-1)?.payload["query"]).toBe("seo");
  });

  it("keeps the picked source's chip while it filters, even when no loaded row carries it", async () => {
    const all = [row("t1", "2026-09-29T08:00:00.000Z", { origin: "ipc" }), row("t2", "2026-09-29T07:00:00.000Z", { origin: "schedule" })];
    let rows: readonly TaskListRow[] = all;
    const client: SettingsClient = {
      request: (command, payload) =>
        command === "tasks" && (payload as Record<string, unknown>)["action"] === "list"
          ? Promise.resolve({ ok: true, result: { action: "list", rows, truncated: false } } as never)
          : new Promise<never>(() => undefined),
    };
    const element = (revision: number) => (
      <InWorkspace client={client} workspaceId="default">
        <Activity summary={summary()} revision={revision} onOpen={async () => undefined} />
      </InWorkspace>
    );
    const page = await mount(element(0));
    await settle();
    const chips = () => [...page.querySelectorAll('[aria-label="Filter by source"] button')];
    await act(async () => (chips().find((chip) => chip.textContent === "Schedule") as HTMLElement).click());
    rows = [all[0]].filter((item): item is TaskListRow => item !== undefined);
    await rerender(element(1));
    await settle();
    expect(chips().map((chip) => chip.textContent)).toEqual(["All sources", "Terminal", "Schedule"]);
    expect(
      chips()
        .find((chip) => chip.textContent === "Schedule")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => (chips().find((chip) => chip.textContent === "All sources") as HTMLElement).click());
    expect([...page.querySelectorAll(".center-row-title")].map((title) => title.textContent)).toEqual(["t1"]);
  });

  it("loads older pages, and keeps them when a live refresh reads the first page again", async () => {
    const first = [row("new", "2026-09-29T08:00:00.000Z"), row("mid", "2026-09-28T08:00:00.000Z")];
    const second = [row("mid", "2026-09-28T08:00:00.000Z"), row("old", "2026-09-27T08:00:00.000Z")];
    let refreshed = false;
    const client: SettingsClient = {
      request: (command, payload) => {
        const body = payload as Record<string, unknown>;
        if (command !== "tasks") return new Promise<never>(() => undefined);
        const result =
          body["cursor"] === "p2"
            ? { action: "list", rows: second, truncated: false }
            : {
                action: "list",
                rows: refreshed ? [row("newest", "2026-09-29T09:00:00.000Z"), ...first.slice(0, 1)] : first,
                nextCursor: "p2",
                truncated: false,
              };
        return Promise.resolve({ ok: true, result } as never);
      },
    };
    const element = (revision: number) => (
      <InWorkspace client={client} workspaceId="default">
        <Activity summary={summary()} revision={revision} onOpen={async () => undefined} />
      </InWorkspace>
    );
    const page = await mount(element(0));
    await settle();
    const titles = () => [...page.querySelectorAll(".center-row-title")].map((title) => title.textContent);
    const older = [...page.querySelectorAll("button")].find((button) => button.textContent === "Load older");
    await act(async () => (older as HTMLElement).click());
    await settle();
    // `mid` is on both pages and listed once.
    expect(titles()).toEqual(["new", "mid", "old"]);
    refreshed = true;
    await rerender(element(1));
    await settle();
    expect(titles()).toEqual(["newest", "new", "mid", "old"]);
  });
});

describe("a live refresh of the first page", () => {
  const page = (...items: TaskListRow[]) => ({ items, nextCursor: "next" });
  const refresh = (held: Parameters<typeof refreshFirstPage<TaskListRow>>[0], fresh: ReturnType<typeof page>) =>
    refreshFirstPage(
      held,
      fresh,
      (item) => item.taskId,
      (item) => item.createdAt,
    );

  it("replaces the list when only the first page is held", () => {
    const held = { items: [row("a", "2026-09-29T08:00:00.000Z")], nextCursor: "old", pages: 1 };
    expect(refresh(held, page(row("b", "2026-09-29T09:00:00.000Z")))).toEqual({
      items: [row("b", "2026-09-29T09:00:00.000Z")],
      nextCursor: "next",
      pages: 1,
    });
  });

  it("lays the fresh page over older pages: its rows win, older rows stay, and rows it no longer carries go", () => {
    const held = {
      items: [
        row("gone", "2026-09-29T10:00:00.000Z"),
        row("kept", "2026-09-29T09:00:00.000Z", { status: "working" }),
        row("older", "2026-09-27T08:00:00.000Z"),
      ],
      nextCursor: "p3",
      pages: 2,
    };
    const fresh = page(row("newest", "2026-09-29T11:00:00.000Z"), row("kept", "2026-09-29T09:00:00.000Z"));
    const merged = refresh(held, fresh);
    expect(merged.items.map((item) => `${item.taskId}:${item.status}`)).toEqual(["newest:completed", "kept:completed", "older:completed"]);
    // The held pages' cursor, not the fresh page's: the next "Load older" continues below them.
    expect(merged.nextCursor).toBe("p3");
    expect(merged.pages).toBe(2);
  });
});

describe("the Center across a reconnect", () => {
  it("keeps the tab and Activity's search while the client is not ready", async () => {
    let state: CanvasState = { connection: "ready", runs: [] };
    const listeners = new Set<() => void>();
    const store: CanvasStore = {
      ...fakeStore(state),
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const publish = async (next: CanvasState) =>
      act(async () => {
        state = next;
        for (const listener of [...listeners]) listener();
      });
    const { client } = owner([]);
    const live = {
      get features(): readonly string[] {
        return state.connection === "ready" ? client.features : [];
      },
      request: client.request,
    };
    const page = await mount(<App store={store} client={live} workspaceId="default" navigation={fakeNavigation("/center").navigation} />);
    await settle();
    const input = page.querySelector<HTMLInputElement>('input[aria-label="Search activity"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "seo");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await publish({ connection: "reconnecting", runs: [] });
    expect(tabs(page).some((tab) => tab.startsWith("Center"))).toBe(true);
    expect(page.querySelector<HTMLInputElement>('input[aria-label="Search activity"]')?.value).toBe("seo");
    await publish({ connection: "ready", runs: [] });
    expect(page.querySelector<HTMLInputElement>('input[aria-label="Search activity"]')).toBe(input);
  });
});
