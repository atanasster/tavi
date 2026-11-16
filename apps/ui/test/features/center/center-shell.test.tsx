// @vitest-environment jsdom
import { initialRunState, type RunState, type ToolCard } from "@tavi/client/browser";
import type { BrowserSessionView, CenterSummaryAnswer, ReminderFireView, ToolRule } from "@tavi/contracts";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ANNOUNCER_ID, useSaidOnce } from "../../../src/features/shell/a11y.js";
import { App, SCHEDULE_ONLY_REFRESH_MS } from "../../../src/App.js";
import { pageRoutesReady } from "../../../src/features/shell/PageRoute.js";
import { offeredSections } from "../../../src/features/center/CenterNav.js";
import { CenterRail } from "../../../src/features/center/CenterRail.js";
import { waitingCount } from "../../../src/features/center/model.js";
import type { PageNavigation } from "../../../src/features/shell/route.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { PermissionsSettings } from "../../../src/features/settings/PermissionsSettings.js";
import type { CanvasRun, CanvasState, CanvasStore } from "../../../src/features/chat/store/types.js";
import { InWorkspace } from "../../support/workspace.js";
import { flush, rerender, settledBy, unmountAll } from "../../support/dom.js";

/**
 * The Command Center's seams with the shell:
 * sections offered by what the owner advertises, the tab title and the
 * announcer counting what waits in the Center, Schedule alone refreshing on a
 * timer, a browser card opening its task at the call that opened the session,
 * and Settings → Permissions pointing out the rule an approval saved.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The pages beside the chat are lazy chunks: fetched up front, every route renders in one pass.
beforeAll(() => pageRoutesReady());

afterEach(() => {
  unmountAll();
  document.getElementById(ANNOUNCER_ID)?.remove();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

/** jsdom has no `scrollIntoView`: one that records what each call scrolled to, as `name` reads it. */
function watchScrolls(name: (element: HTMLElement) => string): string[] {
  const scrolled: string[] = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement) {
      scrolled.push(name(this));
    },
  });
  return scrolled;
}

/** What was asked answered: microtasks only, as tests here fake the clock. */
const { settle, mount, click } = settledBy(() => flush());

const summary = (overrides: Partial<CenterSummaryAnswer> = {}): CenterSummaryAnswer => ({
  workspaceId: "default",
  timezone: "UTC",
  today: "2026-09-29",
  counts: { approvals: 2, reviews: 0, questions: 0, runningTasks: 0, memoryProposals: 1, activeRoutines: 0, schedules: 0 },
  perDay: [{ date: "2026-09-29", tasks: 0 }],
  next: [{ kind: "routine", id: "r1", title: "Morning news", at: "2026-09-30T05:00:00.000Z" }],
  people: {},
  cursor: "c1",
  ...overrides,
});

type Handler = (command: string, payload: Record<string, unknown>) => Promise<unknown> | undefined;

/**
 * An owner advertising `features`: the summary answered, a watch left
 * waiting unless `watch` answers it, and whatever `handle` answers; anything
 * else waits forever.
 */
function owner(features: readonly string[], handle: Handler = () => undefined, answer: CenterSummaryAnswer = summary()) {
  const asked: { readonly command: string; readonly payload: Record<string, unknown> }[] = [];
  const client: SettingsClient & { features: readonly string[] } = {
    features,
    request: (command, raw) => {
      const payload = raw as Record<string, unknown>;
      asked.push({ command, payload });
      const handled = handle(command, payload);
      if (handled !== undefined) return handled.then((result) => ({ ok: true, result })) as never;
      if (command === "center" && payload["action"] === "summary") return Promise.resolve({ ok: true, result: answer } as never);
      return new Promise<never>(() => undefined);
    },
  };
  return { client, asked };
}

function fakeStore(initial: CanvasState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const expanded: string[] = [];
  const store: CanvasStore = {
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
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
    setExpanded: (id, value) => {
      expanded.push(id);
      state = { ...state, runs: state.runs.map((run) => (run.id === id ? { ...run, expanded: value } : run)) };
      for (const listener of [...listeners]) listener();
    },
    dispose: () => undefined,
  };
  const publish = (next: CanvasState): void => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return { store, expanded, publish };
}

function fakeNavigation(initial: string) {
  let pathname = initial;
  const writes: { readonly kind: "push" | "replace"; readonly url: string }[] = [];
  const navigation: PageNavigation = {
    get location(): { readonly pathname: string } {
      return { pathname };
    },
    history: {
      pushState: (_data, _unused, url) => {
        if (url !== undefined) pathname = url;
        writes.push({ kind: "push", url: url ?? pathname });
      },
      replaceState: (_data, _unused, url) => {
        if (url !== undefined) pathname = url;
        writes.push({ kind: "replace", url: url ?? pathname });
      },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return { navigation, writes, path: () => pathname };
}

function announcer(): HTMLElement {
  const region = document.createElement("p");
  region.id = ANNOUNCER_ID;
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  document.body.prepend(region);
  return region;
}

const navItems = (page: HTMLElement): string[] =>
  [...page.querySelectorAll(".center-nav-item .center-nav-label")].map((item) => item.textContent ?? "");

describe("the sections an owner offers", () => {
  it("need the command each section reads from", () => {
    expect(offeredSections(["center"])).toEqual(["activity"]);
    expect(offeredSections(["center", "approvals", "memory"])).toEqual(["activity", "approvals", "identity"]);
    expect(offeredSections(["center", "schedules"])).toEqual(["activity", "schedule"]);
    expect(offeredSections(["center", "routines", "browser"])).toEqual(["activity", "schedule", "browser"]);
  });

  it("filter the nav, leave the rail's hidden sections unlinked, and send a hidden section's address to Activity", async () => {
    const address = fakeNavigation("/center/approvals");
    const { client } = owner(["center"]);
    const page = await mount(
      <App
        store={fakeStore({ connection: "ready", runs: [] }).store}
        client={client}
        workspaceId="default"
        navigation={address.navigation}
      />,
    );
    expect(navItems(page)).toEqual(["Activity"]);
    expect(address.path()).toBe("/center");
    expect(address.writes.at(-1)).toEqual({ kind: "replace", url: "/center" });
    expect(page.querySelector("h1")?.textContent).toBe("Activity");
    // Approvals and memory proposals are counted in sections this owner does not offer: no rail links to them.
    expect(page.querySelectorAll(".center-need")).toHaveLength(0);
    // Schedule is not offered either: Coming up lists, without a link.
    expect(page.querySelector(".center-next a")).toBeNull();
    expect(page.querySelector(".center-next")?.textContent).toContain("Morning news");
  });

  it("offer each section whose command the owner advertises", async () => {
    const address = fakeNavigation("/center/identity");
    const { client } = owner(["center", "approvals", "memory"]);
    const page = await mount(
      <App
        store={fakeStore({ connection: "ready", runs: [] }).store}
        client={client}
        workspaceId="default"
        navigation={address.navigation}
      />,
    );
    expect(navItems(page)).toEqual(["Activity", "Approvals", "Soul & memory"]);
    expect(address.path()).toBe("/center/identity");
    expect([...page.querySelectorAll(".center-need")].map((need) => need.getAttribute("href"))).toEqual([
      "/center/approvals",
      "/center/identity",
    ]);
  });
});

describe("the rail's browser handoffs", () => {
  it("names a task waiting for you in its browser apart from questions, opening Browser, and counts it as waiting", async () => {
    const asked = summary({
      counts: { approvals: 0, reviews: 0, questions: 0, handoffs: 1, runningTasks: 0, memoryProposals: 0, activeRoutines: 0, schedules: 0 },
    });
    const opened: string[] = [];
    const page = await mount(<CenterRail summary={asked} onSection={(section) => void opened.push(section)} />);
    expect(page.textContent).toContain("1 browser handoff");
    expect(page.textContent).not.toContain("question");
    expect([...page.querySelectorAll(".center-need")].map((need) => need.getAttribute("href"))).toEqual(["/center/browser"]);
    expect(waitingCount(asked)).toBe(1);
    // An owner from before handoffs sends none: nothing is counted.
    expect(
      waitingCount(
        summary({
          counts: { approvals: 0, reviews: 0, questions: 0, runningTasks: 0, memoryProposals: 0, activeRoutines: 0, schedules: 0 },
        }),
      ),
    ).toBe(0);
  });
});

describe("the rail's reminders", () => {
  it("never says nothing waits while reminder cards show", async () => {
    const quiet = summary({
      counts: { approvals: 0, reviews: 0, questions: 0, runningTasks: 0, memoryProposals: 0, activeRoutines: 0, schedules: 0 },
    });
    const page = await mount(
      <CenterRail summary={quiet} unseenReminders={1} reminders={<p className="card">⏰ Take your pills</p>} onSection={() => undefined} />,
    );
    expect(page.querySelector(".center-rail .empty")?.textContent).toBe("Nothing else is waiting on you.");
    expect(page.textContent).not.toContain("Nothing is waiting on you.");
    await rerender(<CenterRail summary={quiet} onSection={() => undefined} />);
    expect(page.querySelector(".center-rail .empty")?.textContent).toBe("Nothing is waiting on you.");
  });
});

describe("what waits in the Center, out loud and in the tab", () => {
  const fire = (fireAt: string, text: string): ReminderFireView => ({
    reminderId: `rem-${text}`,
    fireAt,
    firedAt: fireAt,
    outcome: "delivered-in-app",
    occurrence: "repeat",
    workspaceId: "default",
    principalId: "operator",
    text,
  });

  it("counts the Center's summary, not this page's sessions, and says a reminder as it fires", async () => {
    const region = announcer();
    let fires: ReminderFireView[] = [fire("2026-09-29T07:00:00.000Z", "Stretch")];
    let current = summary();
    const answers: ((kind: string) => void)[] = [];
    const { client } = owner(["center", "reminders"], (command, payload) => {
      if (command === "reminders" && payload["action"] === "fires") return Promise.resolve({ fires });
      if (command === "center" && payload["action"] === "summary") return Promise.resolve(current);
      // Each watch answers when the test says what changed.
      if (command === "center" && payload["action"] === "watch")
        return new Promise((resolve) => answers.push((kind) => resolve({ cursor: `c${answers.length + 1}`, changed: [kind] })));
      return undefined;
    });
    const changed = async (kind: string): Promise<void> => {
      await act(async () => answers.at(-1)?.(kind));
      await settle();
    };
    await mount(<App store={fakeStore({ connection: "ready", runs: [] }).store} client={client} workspaceId="default" />);
    // Two approvals and a memory proposal; no session of this page needs the reader.
    expect(document.title).toBe("(3) Chat – tavi");
    expect(region.textContent).toBe("3 things are waiting on you.");
    // The reminder already unseen when the page opened is not read out.
    expect(region.textContent).not.toContain("Stretch");

    fires = [fire("2026-09-29T08:00:00.000Z", "Take your pills"), ...fires];
    await changed("reminder");
    expect(region.textContent).toBe("Reminder: Take your pills. 3 things are waiting on you.");
    // Said once: an unrelated change says the new count without the reminder again.
    current = summary({ counts: { ...summary().counts, approvals: 3 } });
    await changed("approval");
    expect(region.textContent).toBe("4 things are waiting on you.");
  });
});

describe("a fired reminder, said once", () => {
  function Said({ items, rest }: { readonly items: readonly { readonly key: string; readonly text: string }[]; readonly rest: string }) {
    return <p>{useSaidOnce(items, rest).join("|")}</p>;
  }

  it("is said with the sentence it arrives in, and not again once that sentence moves on", async () => {
    const pills = { key: "rem-pills@08:00", text: "Take your pills" };
    const page = await mount(<Said items={[pills]} rest="3 waiting" />);
    expect(page.textContent).toBe("Take your pills");
    // The same sentence re-rendered still carries it: nothing new was said.
    await rerender(<Said items={[pills]} rest="3 waiting" />);
    expect(page.textContent).toBe("Take your pills");
    // An unrelated change (the count moved): the reminder is not read out again, then or later.
    await rerender(<Said items={[pills]} rest="4 waiting" />);
    expect(page.textContent).toBe("");
    await rerender(<Said items={[pills]} rest="3 waiting" />);
    expect(page.textContent).toBe("");
    // Another fire is its own, said once.
    const stretch = { key: "rem-stretch@09:00", text: "Stretch" };
    await rerender(<Said items={[pills, stretch]} rest="3 waiting" />);
    expect(page.textContent).toBe("Stretch");
  });
});

describe("Schedule alone", () => {
  it("reads its lists again every 30 seconds, having no feed to say what changed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { client, asked } = owner(["routines", "schedules"], (command, payload) => {
      if (command === "schedules")
        return Promise.resolve(
          payload["action"] === "agenda"
            ? { timezone: "UTC", items: [], truncated: false, skipped: [] }
            : { schedules: [], truncated: false },
        );
      if (command === "routines") return Promise.resolve({ routines: [] });
      return undefined;
    });
    await mount(
      <App
        store={fakeStore({ connection: "ready", runs: [] }).store}
        client={client}
        workspaceId="default"
        navigation={fakeNavigation("/center/schedule").navigation}
      />,
    );
    const agendas = () => asked.filter((call) => call.command === "schedules" && call.payload["action"] === "agenda").length;
    expect(agendas()).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(SCHEDULE_ONLY_REFRESH_MS - 1);
    });
    expect(agendas()).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await settle();
    expect(agendas()).toBe(2);
  });
});

describe("Schedule alone, entered from the chat", () => {
  it("reads its lists once on entry, not again for the refresh beat", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { client, asked } = owner(["routines", "schedules"], (command, payload) => {
      if (command === "schedules")
        return Promise.resolve(
          payload["action"] === "agenda"
            ? { timezone: "UTC", items: [], truncated: false, skipped: [] }
            : { schedules: [], truncated: false },
        );
      if (command === "routines") return Promise.resolve({ routines: [] });
      return undefined;
    });
    const page = await mount(
      <App
        store={fakeStore({ connection: "ready", runs: [] }).store}
        client={client}
        workspaceId="default"
        navigation={fakeNavigation("/chat").navigation}
      />,
    );
    const macrotasks = async () => {
      for (let turn = 0; turn < 3; turn += 1) await act(async () => new Promise((done) => setTimeout(done, 0)));
    };
    await macrotasks();
    const agendas = () => asked.filter((call) => call.command === "schedules" && call.payload["action"] === "agenda").length;
    expect(agendas()).toBe(0);
    const tab = [...page.querySelectorAll<HTMLButtonElement>(".bar .view")].find((button) => button.textContent?.startsWith("Center"));
    expect(tab).toBeDefined();
    await act(async () => tab?.click());
    await macrotasks();
    expect(agendas()).toBe(1);
  });
});

describe("a browser card", () => {
  /** A tool card as the transcript holds it: its key is not its call id, which is what a session records. */
  const tool = (callId: string, toolName: string): ToolCard => ({
    kind: "tool",
    key: `a1:${callId}`,
    attemptId: "a1",
    callId,
    toolName,
    status: "completed",
    input: {},
    output: {},
  });
  const text = (key: string) => ({ kind: "text" as const, key, attemptId: "a1", blockId: key, text: `Step ${key}` });
  const run = (transcript: RunState["transcript"], status: RunState["status"] = "completed"): CanvasRun => ({
    id: "ui-1",
    prompt: "Compare prices",
    run: { ...initialRunState(), taskId: "task-1", status, transcript },
    roundCalls: {},
    deciding: undefined,
    aborting: false,
  });
  const view = (sessionId: string, openedAt: string, live: boolean, openedByCallId?: string): BrowserSessionView => ({
    sessionId,
    taskId: "task-1",
    taskTitle: "Compare prices",
    principalId: "operator",
    openedAt,
    closedAt: live ? null : openedAt,
    closeReason: live ? null : "closed",
    live,
    lastUrl: "https://example.com/",
    host: "example.com",
    lastTitle: null,
    pages: 1,
    durationMs: 60_000,
    ...(openedByCallId === undefined ? {} : { openedByCallId }),
  });
  /** The live card was opened by `live`'s call, the earlier one by `earlier`'s (none when absent). */
  const browserOwner = (live: string | undefined, earlier?: string) =>
    owner(["center", "browser"], (command, payload) => {
      if (command !== "browser" || payload["action"] !== "list") return undefined;
      return Promise.resolve(
        payload["open"] === true
          ? { items: [view("s2", "2026-09-29T11:00:00.000Z", true, live)] }
          : { items: [view("s1", "2026-09-29T10:00:00.000Z", false, earlier)] },
      );
    });
  const frame = async (): Promise<void> => act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
  const opens = [
    text("t1"),
    tool("call-1", "browser.create_session"),
    tool("call-2", "browser.navigate"),
    text("t2"),
    tool("call-3", "browser.create_session"),
    tool("call-4", "browser.observe"),
  ];

  it("opens its task in the chat, at the call that opened that session", async () => {
    const scrolled = watchScrolls((element) => element.dataset["toolKey"] ?? "");
    const address = fakeNavigation("/center/browser");
    const { store } = fakeStore({ connection: "ready", runs: [run(opens)] });
    const page = await mount(
      <App store={store} client={browserOwner("call-3").client} workspaceId="default" navigation={address.navigation} />,
    );
    await click(page.querySelector(".browser-card.live a.browser-card-open"));
    await frame();
    expect(address.path()).toBe("/tasks/task-1");
    expect(scrolled).toEqual(["a1:call-3"]);
    const card = page.querySelector<HTMLDetailsElement>('[data-tool-key="a1:call-3"]');
    expect(card?.open).toBe(true);
    // The block folding it is open too.
    expect(card?.parentElement?.closest("details")?.open).toBe(true);
  });

  it("waits for its call while the transcript replays, never settling for another session's call", async () => {
    const scrolled = watchScrolls((element) => element.dataset["toolKey"] ?? "");
    const { store, publish } = fakeStore({ connection: "ready", runs: [run(opens.slice(0, 2), "running")] });
    const page = await mount(
      <App
        store={store}
        client={browserOwner("call-3").client}
        workspaceId="default"
        navigation={fakeNavigation("/center/browser").navigation}
      />,
    );
    await click(page.querySelector(".browser-card.live a.browser-card-open"));
    await frame();
    // Only the first session's call has replayed: nothing is scrolled to yet.
    expect(scrolled).toEqual([]);
    await act(async () => publish({ connection: "ready", runs: [run(opens, "running")] }));
    await frame();
    expect(scrolled).toEqual(["a1:call-3"]);
  });

  it("settles for the task's top once every turn has settled without the call", async () => {
    const scrolled = watchScrolls((element) => element.dataset["toolKey"] ?? "");
    const { store, publish } = fakeStore({ connection: "ready", runs: [run(opens.slice(0, 2), "running")] });
    const page = await mount(
      <App
        store={store}
        client={browserOwner("call-9").client}
        workspaceId="default"
        navigation={fakeNavigation("/center/browser").navigation}
      />,
    );
    await click(page.querySelector(".browser-card.live a.browser-card-open"));
    await frame();
    const runs = page.querySelector<HTMLElement>(".runs");
    if (runs !== null) runs.scrollTop = 50;
    await act(async () => publish({ connection: "ready", runs: [run(opens, "completed")] }));
    await frame();
    expect(scrolled).toEqual([]);
    expect(page.querySelector<HTMLElement>(".runs")?.scrollTop).toBe(0);
  });

  it("opens the task alone for a session with no recorded call", async () => {
    const scrolled = watchScrolls((element) => element.dataset["toolKey"] ?? "");
    const address = fakeNavigation("/center/browser");
    const { store } = fakeStore({ connection: "ready", runs: [run(opens)] });
    const page = await mount(
      <App store={store} client={browserOwner(undefined).client} workspaceId="default" navigation={address.navigation} />,
    );
    await click(page.querySelector(".browser-card.live a.browser-card-open"));
    await frame();
    expect(address.path()).toBe("/tasks/task-1");
    expect(scrolled).toEqual([]);
  });

  it("expands a turn folded in the middle so the call is on the page", async () => {
    watchScrolls(() => "");
    const filler = Array.from({ length: 240 }, (_, index) => text(`f${index}`));
    const { store, expanded } = fakeStore({
      connection: "ready",
      runs: [run([...filler.slice(0, 30), tool("call-1", "browser.create_session"), ...filler.slice(30)])],
    });
    const page = await mount(
      <App
        store={store}
        client={browserOwner(undefined, "call-1").client}
        workspaceId="default"
        navigation={fakeNavigation("/center/browser").navigation}
      />,
    );
    await click(page.querySelector(".browser-card:not(.live) a.browser-card-open"));
    await frame();
    expect(expanded).toEqual(["ui-1"]);
    expect(page.querySelector('[data-tool-key="a1:call-1"]')).not.toBeNull();
  });
});

describe("Settings → Permissions", () => {
  const rule = (ruleId: string, toolPattern: string): ToolRule => ({
    ruleId,
    workspaceId: "default",
    toolPattern,
    decision: "allow",
    source: "operator",
    createdBy: "operator",
    createdVia: "bridge",
    createdAt: "2026-09-29T08:00:00.000Z",
  });
  const permissionsOwner = (rules: readonly ToolRule[]): SettingsClient => ({
    request: (command, raw) => {
      const action = (raw as Record<string, unknown>)["action"];
      if (command === "permissions" && action === "rules") return Promise.resolve({ ok: true, result: { rules } } as never);
      if (command === "permissions" && action === "grants") return Promise.resolve({ ok: true, result: { grants: [] } } as never);
      return new Promise<never>(() => undefined);
    },
  });

  it("points out the rule an approval's Always row linked to, and brings it into view", async () => {
    const scrolled = watchScrolls((element) => element.id);
    const page = await mount(
      <InWorkspace client={permissionsOwner([rule("rule-1", "shell.*"), rule("rule-2", "browser.*")])} workspaceId="default">
        <PermissionsSettings highlight="rule-2" />
      </InWorkspace>,
    );
    const pointed = [...page.querySelectorAll(".rule-pointed")];
    expect(pointed.map((row) => row.id)).toEqual(["rule-rule-2"]);
    expect(pointed[0]?.getAttribute("aria-current")).toBe("true");
    expect(scrolled).toEqual(["rule-rule-2"]);
  });

  it("points out a followed rule once: a later visit from the settings nav points out nothing", async () => {
    watchScrolls((element) => element.id);
    const history = {
      items: [
        {
          kind: "approval",
          approvalId: "h1",
          taskId: "t1",
          taskTitle: "Book",
          principalId: "operator",
          toolId: "browser.navigate",
          state: "granted",
          decidedBy: "operator",
          decidedAt: "2026-09-29T12:02:00.000Z",
          via: "bridge",
          channel: "web",
          scope: "always",
          note: null,
          ruleId: "rule-2",
        },
      ],
    };
    const address = fakeNavigation("/center/approvals");
    const { client } = owner(["center", "approvals"], (command, payload) => {
      if (command === "approvals" && payload["action"] === "history") return Promise.resolve(history);
      if (command === "approvals" && payload["action"] === "list") return Promise.resolve({ rows: [], truncated: false });
      if (command === "tasks") return Promise.resolve({ action: "list", rows: [], truncated: false });
      if (command === "permissions" && payload["action"] === "rules")
        return Promise.resolve({ rules: [rule("rule-1", "shell.*"), rule("rule-2", "browser.*")] });
      if (command === "permissions" && payload["action"] === "grants") return Promise.resolve({ grants: [] });
      return undefined;
    });
    const page = await mount(
      <App
        store={fakeStore({ connection: "ready", runs: [] }).store}
        client={client}
        workspaceId="default"
        navigation={address.navigation}
      />,
    );
    await click([...page.querySelectorAll("a")].find((link) => link.textContent === "Revoke in Permissions"));
    expect(address.path()).toBe("/settings/permissions");
    expect([...page.querySelectorAll(".rule-pointed")].map((row) => row.id)).toEqual(["rule-rule-2"]);
    const subview = (label: string) => [...page.querySelectorAll(".settings-nav button")].find((button) => button.textContent === label);
    await click(subview("General"));
    await click(subview("Permissions"));
    expect(page.querySelector('[id="rule-rule-2"]')).not.toBeNull();
    expect(page.querySelector(".rule-pointed")).toBeNull();
  });

  it("reads the rule from a #rule- address, and says when that rule is gone", async () => {
    window.location.hash = "#rule-rule-9";
    try {
      const page = await mount(
        <InWorkspace client={permissionsOwner([rule("rule-1", "shell.*")])} workspaceId="default">
          <PermissionsSettings />
        </InWorkspace>,
      );
      expect(page.querySelector(".rule-pointed")).toBeNull();
      expect(page.textContent).toContain("The rule that approval saved is no longer listed: it was removed.");
    } finally {
      window.location.hash = "";
    }
  });
});
