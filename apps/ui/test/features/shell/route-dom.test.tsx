// @vitest-environment jsdom
import { initialRunState, type RunState } from "@tavi/client/browser";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ANNOUNCER_ID } from "../../../src/features/shell/a11y.js";
import { App } from "../../../src/App.js";
import { pageRoutesReady } from "../../../src/features/shell/PageRoute.js";
import type { PageNavigation } from "../../../src/features/shell/route.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import type { CanvasRun, CanvasState, CanvasStore } from "../../../src/features/chat/store/types.js";
import { click, flush, mountSettled, unmountAll } from "../../support/dom.js";

/**
 * The page's address in the shell: a refresh, a bookmark or Back lands
 * where the reader was, and what they click is what the address bar says. The
 * grammar itself is asserted in `route.test.ts`; what is asserted here is the
 * seam — the URL the page opens from, the URL a click writes, and the URL a
 * `popstate` reads back.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mount, replacing whatever the last mount left: one page at a time. */
async function mount(element: React.ReactNode): Promise<HTMLElement> {
  unmountAll();
  if (document.getElementById(ANNOUNCER_ID) === null) {
    const region = document.createElement("p");
    region.id = ANNOUNCER_ID;
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.prepend(region);
  }
  // A deep link's task read settles in microtasks the render did not await.
  return mountSettled(element, () => flush(1, 0));
}

// The pages beside the chat are lazy chunks: fetched up front, every route renders in one pass.
beforeAll(() => pageRoutesReady());

afterEach(() => {
  unmountAll();
  document.getElementById(ANNOUNCER_ID)?.remove();
});

/** The chat list's rows, as the owner lists them: the sidebar shows those. */
const listed = (...chats: readonly (readonly [string, string])[]): NonNullable<CanvasState["directory"]> => ({
  rows: chats.map(([taskId, title]) => ({
    taskId,
    workspaceId: "default",
    status: "completed",
    origin: "web",
    title,
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    needs: [],
    counts: { admissions: 1, tools: null },
  })),
  needs: [],
  needsTruncated: false,
  loading: false,
});

const run = (id: string, prompt: string, state: Partial<RunState>, extra: Partial<CanvasRun> = {}): CanvasRun => ({
  id,
  prompt,
  run: { ...initialRunState(), ...state },
  roundCalls: {},
  deciding: undefined,
  aborting: false,
  ...extra,
});

const silent: SettingsClient = { request: () => new Promise<never>(() => undefined) };

/** What an owner on this build advertises that the Center's sections read from. */
const CENTER_FEATURES = ["center", "approvals", "routines", "schedules", "memory", "browser"] as const;

/**
 * An owner that offers the Command Center: its summary answered, its watch
 * left waiting (as between changes), everything else sent to `request`.
 */
function centered(request: SettingsClient["request"]): SettingsClient & { features: readonly string[] } {
  const summary = {
    workspaceId: "default",
    timezone: "UTC",
    today: "2026-09-29",
    counts: { approvals: 0, reviews: 0, questions: 0, runningTasks: 0, memoryProposals: 0, activeRoutines: 0, schedules: 0 },
    perDay: [],
    next: [],
    people: {},
    cursor: "c1",
  };
  return {
    features: CENTER_FEATURES,
    request: (command, payload, options) => {
      const action = (payload as Record<string, unknown>)["action"];
      if (command === "center")
        return action === "watch" ? new Promise<never>(() => undefined) : Promise.resolve({ ok: true, result: summary } as never);
      return request(command, payload, options);
    },
  };
}

/** An address bar the test drives: where the page is, and what it wrote there. */
function fakeNavigation(initial: string) {
  let pathname = initial;
  const listeners = new Set<() => void>();
  const writes: { readonly kind: "push" | "replace"; readonly url: string }[] = [];
  const navigation: PageNavigation = {
    // A getter, as `window.location` is: the page reads where it is, and what
    // it wrote changes that.
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
    addEventListener: (type, listener) => {
      if (type === "popstate") listeners.add(listener);
    },
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  return {
    navigation,
    writes,
    path: () => pathname,
    /** The browser's Back or Forward: the address changes outside the page. */
    go: async (url: string) => {
      pathname = url;
      await act(async () => {
        for (const listener of [...listeners]) listener();
      });
    },
  };
}

/** A store the test publishes into, with what the shell asked it to open. */
function fakeStore(initial: CanvasState, open?: (taskId: string) => Promise<void>) {
  let state = initial;
  const listeners = new Set<() => void>();
  const opened: string[] = [];
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
    openTask: async (taskId) => {
      opened.push(taskId);
      await open?.(taskId);
    },
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
    setExpanded: () => undefined,
    dispose: () => undefined,
  };
  return {
    store,
    opened,
    publish: (next: CanvasState) => {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const tab = (page: HTMLElement, scope: string, label: string): Element | undefined =>
  [...page.querySelectorAll(`${scope} button`)].find((button) => button.textContent === label);
const currentTab = (page: HTMLElement, scope: string): string | undefined =>
  [...page.querySelectorAll(`${scope} button`)].find((button) => button.getAttribute("aria-current") === "page")?.textContent ?? undefined;
const sessionButton = (page: HTMLElement, text: string): Element | undefined =>
  [...page.querySelectorAll(".session")].find((button) => button.textContent?.includes(text));

describe("the page's address in the shell", () => {
  it("opens the route the address names, so a refresh is not always the chat", async () => {
    const settings = fakeNavigation("/settings/system-prompt");
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" navigation={settings.navigation} />);
    expect(page.querySelector(".composer")).toBeNull();
    expect(currentTab(page, ".bar .views")).toBe("Settings");
    expect(currentTab(page, ".settings-nav")).toBe("System prompt");
  });

  it("moves between Settings views from its own nav, leaving an app's page behind, and folds it to a rail", async () => {
    const address = fakeNavigation("/settings/apps/google-calendar");
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" navigation={address.navigation} />);
    expect(currentTab(page, ".settings-nav")).toBe("Connected apps");
    await click(tab(page, ".settings-nav", "Web search"));
    expect(address.path()).toBe("/settings/search");
    expect(currentTab(page, ".settings-nav")).toBe("Web search");
    await click(page.querySelector('.settings-nav [aria-label="Hide settings"]'));
    expect(page.querySelector(".settings-nav")).toBeNull();
    expect(page.querySelector(".sidebar-rail")).not.toBeNull();
  });

  it("redirects the old Routines and Settings → Schedules addresses to Schedule, replacing the entry", async () => {
    for (const old of ["/routines", "/settings/schedules"]) {
      const address = fakeNavigation(old);
      const { store } = fakeStore({ connection: "ready", runs: [] });
      const page = await mount(
        <App store={store} client={centered(silent.request)} workspaceId="default" navigation={address.navigation} />,
      );
      expect(address.path()).toBe("/center/schedule");
      expect(address.writes).toEqual([{ kind: "replace", url: "/center/schedule" }]);
      expect(currentTab(page, ".bar .views")).toBe("Center");
      expect(page.querySelector("h1")?.textContent).toBe("Schedule");
      expect([...page.querySelectorAll("button")].some((button) => button.textContent === "New routine")).toBe(true);
    }
  });

  it("gives a routine and its run addresses of their own under Schedule, and Back walks them", async () => {
    const run = {
      runId: "run-1",
      routineId: "r1",
      revision: 1,
      mode: "production",
      status: "succeeded",
      claimedAt: "now",
      startedAt: "now",
      endedAt: "now",
      snapshot: {},
      data: { modelCalls: 1, tokensKnown: 1, usageComplete: true },
    };
    const owner = centered(async (command, raw) => {
      const action = (raw as Record<string, unknown>)["action"];
      if (command === "schedules")
        return {
          ok: true,
          result: action === "agenda" ? { timezone: "UTC", items: [], truncated: false, skipped: [] } : { schedules: [], truncated: false },
        } as never;
      if (command === "channels") return { ok: true, result: { channels: [], connections: [] } } as never;
      const result =
        action === "list"
          ? {
              routines: [
                { routineId: "r1", name: "LLM news", status: "active", version: 1, activeRevision: 1, latestRevision: 1, lastRun: null },
              ],
            }
          : action === "get"
            ? {
                routine: { routineId: "r1", name: "LLM news", status: "active", version: 1, activeRevision: 1, latestRevision: 1 },
                revision: {
                  revision: 1,
                  snapshot: { objective: "Find news", agent: { name: "Researcher", revision: 1, instructions: "x" }, skills: [] },
                },
                evaluation: { status: "passed", detail: "" },
                schedules: [],
                state: {},
                hostStatus: "running",
              }
            : action === "history"
              ? { runs: [run] }
              : action === "revisions"
                ? { items: [], nextBeforeRevision: null }
                : action === "inspect"
                  ? { run, publication: null, deliveries: [], attempts: [] }
                  : action === "ledger"
                    ? { events: [] }
                    : action === "sources"
                      ? { sources: [], nextAfterSourceId: null }
                      : {};
      return { ok: true, result } as never;
    });
    const button = (page: HTMLElement, text: string) => [...page.querySelectorAll("button")].find((item) => item.textContent === text);
    // An old deep link lands on the routine itself, at its new address.
    const address = fakeNavigation("/routines/r1");
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={owner} workspaceId="default" navigation={address.navigation} />);
    expect(address.path()).toBe("/center/schedule/routines/r1");
    expect(address.writes).toEqual([{ kind: "replace", url: "/center/schedule/routines/r1" }]);
    expect(page.querySelector(".page-title")?.textContent).toContain("LLM news");

    // Opening a run is a step of its own.
    await act(async () => button(page, "Inspect")?.click());
    expect(address.path()).toBe("/center/schedule/routines/r1/runs/run-1");
    expect(page.querySelector(".page-title")?.textContent).toContain("Run");

    // Back returns to the routine, and again to Schedule.
    await address.go("/center/schedule/routines/r1");
    expect(page.querySelector(".page-title")?.textContent).toContain("LLM news");
    await act(async () => button(page, "← Schedule")?.click());
    expect(address.path()).toBe("/center/schedule");
    expect(page.querySelector("h1")?.textContent).toBe("Schedule");

    // The Center tab, and Schedule in the nav, are the section, never the routine last open.
    await act(async () =>
      [...page.querySelectorAll<HTMLAnchorElement>(".schedule-recurring a")].find((item) => item.textContent === "LLM news")?.click(),
    );
    expect(address.path()).toBe("/center/schedule/routines/r1");
    await click(tab(page, ".bar .views", "Chat"));
    await click(tab(page, ".bar .views", "Center"));
    expect(address.path()).toBe("/center/schedule");
    await act(async () => button(page, "LLM news")?.click());
    const nav = [...page.querySelectorAll(".center-nav-item")].find((item) => item.textContent?.startsWith("Schedule"));
    await click(nav);
    expect(address.path()).toBe("/center/schedule");
  });

  it("keeps Schedule reachable, alone, from an owner that offers routines and schedules but not the Command Center", async () => {
    const asked: string[] = [];
    const owner: SettingsClient & { features: readonly string[] } = {
      features: ["routines", "schedules"],
      request: async (command, raw) => {
        const action = String((raw as Record<string, unknown>)["action"]);
        asked.push(`${command} ${action}`);
        const result =
          command === "channels"
            ? { channels: [], connections: [] }
            : command === "schedules"
              ? action === "agenda"
                ? { timezone: "UTC", items: [], truncated: false, skipped: [] }
                : { schedules: [], truncated: false }
              : action === "list"
                ? {
                    routines: [
                      {
                        routineId: "r1",
                        name: "LLM news",
                        status: "active",
                        version: 1,
                        activeRevision: 1,
                        latestRevision: 1,
                        lastRun: null,
                      },
                    ],
                  }
                : action === "get"
                  ? {
                      routine: { routineId: "r1", name: "LLM news", status: "active", version: 1, activeRevision: 1, latestRevision: 1 },
                      revision: {
                        revision: 1,
                        snapshot: { objective: "Find news", agent: { name: "Researcher", revision: 1, instructions: "x" }, skills: [] },
                      },
                      evaluation: { status: "passed", detail: "" },
                      schedules: [],
                      state: {},
                      hostStatus: "running",
                    }
                  : action === "history"
                    ? { runs: [] }
                    : action === "revisions"
                      ? { items: [], nextBeforeRevision: null }
                      : {};
        return { ok: true, result } as never;
      },
    };
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const settings = fakeNavigation("/settings/schedules");
    let page = await mount(<App store={store} client={owner} workspaceId="default" navigation={settings.navigation} />);
    expect(settings.path()).toBe("/center/schedule");
    expect([...page.querySelectorAll(".bar .views .view")].map((view) => view.textContent)).toEqual(["Chat", "Center", "Settings"]);
    expect(page.querySelector("h1")?.textContent).toBe("Schedule");
    expect([...page.querySelectorAll(".center-nav-item")].map((item) => item.textContent)).toEqual(["Schedule"]);
    expect(page.querySelector(".center-rail")).toBeNull();
    expect(page.textContent).not.toContain("does not offer the Command Center");
    expect(asked.some((request) => request.startsWith("center"))).toBe(false);

    // An old routine link opens the routine at its new address.
    const deep = fakeNavigation("/routines/r1");
    page = await mount(<App store={store} client={owner} workspaceId="default" navigation={deep.navigation} />);
    expect(deep.path()).toBe("/center/schedule/routines/r1");
    expect(page.querySelector(".page-title")?.textContent).toContain("LLM news");

    // Another section's address is corrected to Schedule.
    const landing = fakeNavigation("/center");
    page = await mount(<App store={store} client={owner} workspaceId="default" navigation={landing.navigation} />);
    expect(landing.path()).toBe("/center/schedule");
    expect(landing.writes.at(-1)).toEqual({ kind: "replace", url: "/center/schedule" });
    expect(page.querySelector("h1")?.textContent).toBe("Schedule");
  });

  it("opens a reminder's page at its address when the owner offers reminders", async () => {
    const address = fakeNavigation("/center/schedule/reminders/rem-1");
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const asked: string[] = [];
    const base = centered(async (command, payload) => {
      asked.push(`${command}:${String((payload as Record<string, unknown>)["action"])}`);
      return { ok: false, error: { code: "NOT_FOUND", message: "Reminder rem-1 does not exist" } } as never;
    });
    const page = await mount(
      <App
        store={store}
        client={{ ...base, features: [...CENTER_FEATURES, "reminders"] }}
        workspaceId="default"
        navigation={address.navigation}
      />,
    );
    expect(address.writes).toEqual([]);
    expect(asked).toContain("reminders:get");
    // The rail's unseen reminders are read too.
    expect(asked).toContain("reminders:fires");
    expect(page.textContent).toContain("This reminder was not found.");
  });

  it("opens a plain schedule's page at its address", async () => {
    const address = fakeNavigation("/center/schedule/schedules/s1");
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const asked: string[] = [];
    const base = centered(async (command, payload) => {
      asked.push(`${command}:${String((payload as Record<string, unknown>)["action"])}`);
      return { ok: false, error: { code: "NOT_FOUND", message: 'no schedule "s1" exists in workspace default' } } as never;
    });
    const page = await mount(<App store={store} client={base} workspaceId="default" navigation={address.navigation} />);
    expect(address.writes).toEqual([]);
    expect(asked).toContain("schedules:show");
    expect(asked).toContain("schedules:history");
    expect(page.textContent).toContain("This schedule was not found.");
  });

  it("reserves a reminder's address in Schedule, saying it is not found when the owner has no reminders", async () => {
    const address = fakeNavigation("/center/schedule/reminders/rem-1");
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={centered(silent.request)} workspaceId="default" navigation={address.navigation} />);
    expect(address.writes).toEqual([]);
    expect(page.textContent).toContain("This reminder was not found.");
  });

  it("writes what the reader picks, and Back reads it back", async () => {
    const address = fakeNavigation("/");
    const { store } = fakeStore({
      connection: "ready",
      runs: [
        run("ui-1", "the old one", { taskId: "task-1", status: "completed" }),
        run("ui-2", "the newest", { taskId: "task-2", status: "completed" }),
      ],
      directory: listed(["task-1", "the old one"], ["task-2", "the newest"]),
    });
    const page = await mount(<App store={store} client={silent} workspaceId="default" navigation={address.navigation} />);
    // The page opened at `/`: nothing was written, and there is nothing to undo.
    expect(address.path()).toBe("/");
    expect(address.writes).toEqual([]);

    await click(tab(page, ".bar .views", "Settings"));
    expect(address.path()).toBe("/settings");
    expect(address.writes.at(-1)).toEqual({ kind: "push", url: "/settings" });
    // Clicking the route the reader is already on is not a step: no second entry.
    await click(tab(page, ".bar .views", "Settings"));
    expect(address.writes).toHaveLength(1);
    await click(tab(page, ".settings-nav", "System prompt"));
    expect(address.path()).toBe("/settings/system-prompt");

    // A session chosen in the sidebar is a page of its own.
    await click(tab(page, ".bar .views", "Chat"));
    expect(address.path()).toBe("/");
    await click(sessionButton(page, "the old one"));
    expect(address.path()).toBe("/tasks/task-1");
    expect(page.querySelector(".task-header")?.textContent).toContain("the old one");
    expect(page.querySelector(".composer")).not.toBeNull();

    // Back: the address moves outside the page, and the page follows it.
    await address.go("/settings/system-prompt");
    expect(page.querySelector(".composer")).toBeNull();
    expect(currentTab(page, ".settings-nav")).toBe("System prompt");
    await address.go("/");
    expect(page.querySelector(".composer")).not.toBeNull();
    expect(page.querySelector(".task-header")?.textContent).toContain("the newest");
  });

  it("opens the session the address names, on mount and on Back or Forward", async () => {
    const deep = fakeNavigation("/tasks/task-7");
    const fake = fakeStore({ connection: "ready", runs: [] }, async (taskId) => {
      fake.publish({ connection: "ready", runs: [run(`ui-${taskId}`, `the ${taskId} session`, { taskId, status: "completed" })] });
    });
    const page = await mount(<App store={fake.store} client={silent} workspaceId="default" navigation={deep.navigation} />);
    expect(fake.opened).toEqual(["task-7"]);
    expect(page.querySelector(".task-header")?.textContent).toContain("the task-7 session");

    // The address moving to a session this page has never held opens it too.
    await deep.go("/");
    expect(page.querySelector(".task-header")?.textContent).toContain("the task-7 session");
    await deep.go("/tasks/task-8");
    expect(fake.opened).toEqual(["task-7", "task-8"]);
    expect(page.querySelector(".task-header")?.textContent).toContain("the task-8 session");
  });

  it("reads nothing for a session the page already holds", async () => {
    const here = fakeNavigation("/");
    const held = fakeStore({
      connection: "ready",
      runs: [
        run("ui-1", "the old one", { taskId: "task-1", status: "completed" }),
        run("ui-2", "the newest", { taskId: "task-2", status: "completed" }),
      ],
      directory: listed(["task-1", "the old one"], ["task-2", "the newest"]),
    });
    const page = await mount(<App store={held.store} client={silent} workspaceId="default" navigation={here.navigation} />);
    await click(sessionButton(page, "the old one"));
    expect(here.path()).toBe("/tasks/task-1");
    expect(page.querySelector(".task-header")?.textContent).toContain("the old one");
    // The sidebar's click opens it (the store reads nothing for a chat it holds); the address asks for nothing more.
    expect(held.opened).toEqual(["task-1"]);
  });

  it("keeps one folder chip in the chat header however often the chats switch", async () => {
    const here = fakeNavigation("/");
    const directory = listed(["task-1", "Home talk"], ["task-2", "side talk"]);
    const held = fakeStore({
      connection: "ready",
      runs: [
        run("ui-1", "Home talk", { taskId: "task-1", status: "completed" }),
        run("ui-2", "side talk", { taskId: "task-2", status: "completed" }),
      ],
      directory: { ...directory, rows: directory.rows.map((row) => ({ ...row, memoryMode: "off" as const })) },
    });
    const folders: SettingsClient = {
      features: ["folder", "chat-context"],
      request: async (command, payload) => {
        const taskId = String((payload as Record<string, unknown>)["taskId"] ?? "");
        if (command !== "folder") return new Promise<never>(() => undefined);
        const path = `/data/chats/default/${taskId}`;
        return {
          ok: true,
          result: { taskId, revision: 1, managed: path, primary: { kind: "managed", path, label: "Chat files" }, attachments: [] },
        };
      },
    } as SettingsClient;
    const page = await mount(<App store={held.store} client={folders} workspaceId="default" navigation={here.navigation} />);
    for (const title of ["side talk", "Home talk", "side talk", "Home talk"]) {
      await click(sessionButton(page, title));
      await flush();
      expect(page.querySelectorAll(".task-header .folder-chip"), title).toHaveLength(1);
    }
  });

  it("corrects an address it does not know", async () => {
    const unknown = fakeNavigation("/old-link");
    const { store } = fakeStore({ connection: "ready", runs: [] });
    const page = await mount(<App store={store} client={silent} workspaceId="default" navigation={unknown.navigation} />);
    expect(page.querySelector(".composer")).not.toBeNull();
    expect(unknown.path()).toBe("/");
    expect(unknown.writes).toEqual([{ kind: "replace", url: "/" }]);
  });

  it("says so when a session the address names cannot be opened, and corrects the address", async () => {
    const gone = fakeNavigation("/tasks/gone");
    const absent = fakeStore({ connection: "ready", runs: [] }, () => Promise.reject(new Error("Chat not found in this workspace")));
    const page = await mount(<App store={absent.store} client={silent} workspaceId="default" navigation={gone.navigation} />);
    expect(gone.path()).toBe("/");
    expect(gone.writes.at(-1)).toEqual({ kind: "replace", url: "/" });
    expect(page.textContent).toContain("Chat gone could not be opened: Chat not found in this workspace.");
    // Said too, not only shown: the page has one region and this goes through it.
    expect(document.getElementById(ANNOUNCER_ID)?.textContent).toContain("Chat gone could not be opened");
    // Its own sessions are still there, and the sentence stays until the reader
    // goes somewhere themselves.
    expect(page.querySelector(".composer")).not.toBeNull();
    await click(tab(page, ".bar .views", "Settings"));
    expect(page.textContent).not.toContain("could not be opened");
  });

  it("takes a failed deep link's sentence back when the reader moves on, Back included", async () => {
    const gone = fakeNavigation("/tasks/gone");
    const absent = fakeStore({ connection: "ready", runs: [] }, () => Promise.reject(new Error("Chat not found in this workspace")));
    const page = await mount(<App store={absent.store} client={silent} workspaceId="default" navigation={gone.navigation} />);
    expect(page.textContent).toContain("could not be opened");
    await gone.go("/settings");
    expect(currentTab(page, ".bar .views")).toBe("Settings");
    expect(page.textContent).not.toContain("could not be opened");
  });
});

describe("the chat panel in the address", () => {
  afterEach(() => window.localStorage.clear());

  it("toggles the panel and picks its tab from the keyboard, and writes the tab into the address", async () => {
    const { store } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "completed" })] });
    const nav = fakeNavigation("/tasks/task-1");
    const page = await mount(<App store={store} client={silent} workspaceId="default" navigation={nav.navigation} />);
    const press = (init: KeyboardEventInit) =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
      });
    await press({ key: ">", code: "Period", metaKey: true, shiftKey: true });
    expect(page.querySelector(".chat-panel")).not.toBeNull();
    expect(nav.path()).toBe("/tasks/task-1/activity");
    await press({ key: "5", code: "Digit5", metaKey: true, altKey: true });
    expect(page.querySelector('.chat-panel [role="tab"][aria-selected="true"]')?.getAttribute("aria-label")).toBe("Details");
    expect(nav.path()).toBe("/tasks/task-1/details");
    await press({ key: ">", code: "Period", metaKey: true, shiftKey: true });
    expect(page.querySelector(".chat-panel")).toBeNull();
    expect(nav.path()).toBe("/tasks/task-1");
  });

  it("opens the panel on the tab the address names", async () => {
    const { store } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "completed" })] });
    const nav = fakeNavigation("/tasks/task-1/memory");
    const page = await mount(<App store={store} client={silent} workspaceId="default" navigation={nav.navigation} />);
    expect(page.querySelector('.chat-panel [role="tab"][aria-selected="true"]')?.getAttribute("aria-label")).toBe("Memory");
    expect(nav.path()).toBe("/tasks/task-1/memory");
  });

  it("opens the panel on the tab Back names, without writing over it", async () => {
    const { store } = fakeStore({ connection: "ready", runs: [run("ui-1", "p", { taskId: "task-1", status: "completed" })] });
    const nav = fakeNavigation("/tasks/task-1");
    const page = await mount(<App store={store} client={silent} workspaceId="default" navigation={nav.navigation} />);
    await nav.go("/tasks/task-1/schedule");
    expect(page.querySelector('.chat-panel [role="tab"][aria-selected="true"]')?.getAttribute("aria-label")).toBe("Schedule");
    expect(nav.path()).toBe("/tasks/task-1/schedule");
  });

  it("offers Ideas only where the owner does, and Try it puts the prompt in a new chat's composer without sending it", async () => {
    const at = "2026-10-19T10:00:00.000Z";
    const idea = {
      id: "id-1",
      workspaceId: "default",
      runId: "run-1",
      providerId: "tavi.ideasagent",
      key: "travel.fare-watch",
      category: "travel",
      icon: "💡",
      title: "I can watch fares",
      pitch: "Fares.",
      label: "Fares",
      prompt: "Watch Sofia–Lisbon fares for May.",
      basis: [{ kind: "general", ref: "general" }],
      uses: [{ capability: "web", approval: false }],
      score: 0.5,
      status: "active",
      pinned: false,
      shownRuns: 0,
      createdAt: at,
      updatedAt: at,
      expiresAt: at,
    };
    const asked: string[] = [];
    const owner: SettingsClient & { features: readonly string[] } = {
      features: ["ideas"],
      request: async (command, payload) => {
        const action = String((payload as Record<string, unknown>)["action"]);
        asked.push(`${command} ${action}`);
        if (command !== "ideas") return { ok: false, error: { code: "UNSUPPORTED", message: "no" } } as never;
        return {
          ok: true,
          result:
            action === "try"
              ? { prompt: idea.prompt, idea }
              : { ideas: [idea], mutedCategories: [], excludedBasis: [], provider: "tavi.ideasagent", providers: [] },
        } as never;
      },
    };
    const sent: string[] = [];
    const { store } = fakeStore({ connection: "ready", runs: [] });
    store.submit = (prompt) => void sent.push(prompt);
    const address = fakeNavigation("/ideas");
    const page = await mount(<App store={store} client={owner} workspaceId="default" navigation={address.navigation} />);
    expect([...page.querySelectorAll(".bar .views .view")].map((view) => view.textContent)).toEqual(["Chat", "Ideas", "Settings"]);
    expect(currentTab(page, ".bar .views")).toBe("Ideas");
    await act(async () => undefined);
    await click([...page.querySelectorAll(".idea-card button")].find((button) => button.textContent === "Try it"));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(address.path()).toBe("/");
    expect(page.querySelector<HTMLTextAreaElement>(".composer textarea")?.value).toBe("Watch Sofia–Lisbon fares for May.");
    expect(sent).toEqual([]);
    // The new chat asks for its suggestions too; nothing else is sent.
    expect(asked.filter((request) => request.startsWith("ideas") && request !== "ideas chips")).toEqual(["ideas list", "ideas try"]);
    // Sent as it is, the message carries the idea it came from; the next one does not.
    const extras: unknown[] = [];
    store.submit = (prompt, extra) => void extras.push({ prompt, fromIdeaId: extra?.fromIdeaId });
    await act(async () => page.querySelector<HTMLFormElement>("form.composer")?.requestSubmit());
    await act(async () => page.querySelector<HTMLFormElement>("form.composer")?.requestSubmit());
    expect(extras[0]).toEqual({ prompt: "Watch Sofia–Lisbon fares for May.", fromIdeaId: "id-1" });
    store.submit = (prompt) => void sent.push(prompt);
    // Back on the chat later, the box is not filled again.
    await click(tab(page, ".bar .views", "Ideas"));
    await click(tab(page, ".bar .views", "Chat"));
    expect(page.querySelector<HTMLTextAreaElement>(".composer textarea")?.value).toBe("");

    // An owner without `ideas` has no tab, and its address says so.
    const without = await mount(
      <App store={store} client={silent} workspaceId="default" navigation={fakeNavigation("/ideas").navigation} />,
    );
    expect([...without.querySelectorAll(".bar .views .view")].map((view) => view.textContent)).not.toContain("Ideas");
  });

  it("on a phone, Try it closes the chat's sheet so the prompt it put in the composer is in view", async () => {
    const at = "2026-10-19T10:00:00.000Z";
    const idea = {
      id: "id-1",
      workspaceId: "default",
      runId: "run-1",
      providerId: "tavi.ideasagent",
      key: "travel.fare-watch",
      category: "travel",
      icon: "💡",
      title: "I can watch fares",
      pitch: "Fares.",
      label: "Fares",
      prompt: "Watch Sofia–Lisbon fares for May.",
      basis: [{ kind: "general", ref: "general" }],
      uses: [{ capability: "web", approval: false }],
      score: 0.5,
      status: "active",
      pinned: false,
      shownRuns: 0,
      createdAt: at,
      updatedAt: at,
      expiresAt: at,
    };
    const owner: SettingsClient & { features: readonly string[] } = {
      features: ["ideas"],
      request: async (command, payload) => {
        const action = String((payload as Record<string, unknown>)["action"]);
        if (command !== "ideas") return { ok: false, error: { code: "UNSUPPORTED", message: "no" } } as never;
        return {
          ok: true,
          result:
            action === "try"
              ? { prompt: idea.prompt, idea }
              : { ideas: [idea], mutedCategories: [], excludedBasis: [], provider: "tavi.ideasagent", providers: [] },
        } as never;
      },
    };
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("720px"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    // The panel was left open (a sheet on a phone).
    localStorage.setItem("tavi.chatpanel.open", "true");
    try {
      const { store } = fakeStore({ connection: "ready", runs: [] });
      const address = fakeNavigation("/ideas");
      const page = await mount(<App store={store} client={owner} workspaceId="default" navigation={address.navigation} />);
      await act(async () => undefined);
      await click([...page.querySelectorAll(".idea-card button")].find((button) => button.textContent === "Try it"));
      await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      expect(page.querySelector<HTMLTextAreaElement>(".composer textarea")?.value).toBe("Watch Sofia–Lisbon fares for May.");
      expect(localStorage.getItem("tavi.chatpanel.open")).toBe("false");
    } finally {
      window.matchMedia = original;
      localStorage.removeItem("tavi.chatpanel.open");
    }
  });

  it("suggests prompts in an empty chat that fill the box, select the part to type, send nothing, and hide once typing starts", async () => {
    const asked: string[] = [];
    const owner: SettingsClient & { features: readonly string[] } = {
      features: ["ideas"],
      request: async (command, payload) => {
        const action = String((payload as Record<string, unknown>)["action"]);
        asked.push(`${command} ${action}`);
        if (command === "ideas" && action === "chips")
          return {
            ok: true,
            result: {
              chips: [
                { taskId: "task-7", label: "Continue: Trip budget", prompt: 'Let\'s continue "Trip budget".' },
                { label: "Search the web", prompt: "Search the web for [topic] and summarise what you find." },
              ],
            },
          } as never;
        return { ok: false, error: { code: "UNSUPPORTED", message: "no" } } as never;
      },
    };
    const sent: string[] = [];
    const { store, opened } = fakeStore({ connection: "ready", runs: [] });
    store.submit = (prompt) => void sent.push(prompt);
    const page = await mount(<App store={store} client={owner} workspaceId="default" navigation={fakeNavigation("/").navigation} />);
    await act(async () => undefined);
    const chip = (label: string) => [...page.querySelectorAll(".idea-chips button")].find((button) => button.textContent === label);
    expect([...page.querySelectorAll(".idea-chips .idea-chip")].map((button) => button.textContent)).toEqual([
      "Continue: Trip budget",
      "Search the web",
    ]);
    await click(chip("Search the web"));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const box = page.querySelector<HTMLTextAreaElement>(".composer textarea");
    expect(box?.value).toBe("Search the web for [topic] and summarise what you find.");
    expect(box?.value.slice(box.selectionStart, box.selectionEnd)).toBe("[topic]");
    expect(sent).toEqual([]);
    // Something in the box: the chips step aside, kept so clearing it does not ask for them again.
    expect(page.querySelector(".idea-chips")?.hasAttribute("hidden")).toBe(true);
    // Cleared again, they return; Continue opens its chat.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(box, "");
      box?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(page.querySelector(".idea-chips")?.hasAttribute("hidden")).toBe(false);
    expect(asked.filter((request) => request === "ideas chips")).toHaveLength(1);
    await click(chip("Continue: Trip budget"));
    expect(opened).toContain("task-7");
    expect(sent).toEqual([]);
  });

  it("links a chat to an idea only while the idea's words are in the box, and never a private chat or Home", async () => {
    const at = "2026-10-19T10:00:00.000Z";
    const idea = {
      id: "id-1",
      workspaceId: "default",
      runId: "run-1",
      providerId: "tavi.ideasagent",
      key: "travel.fare-watch",
      category: "travel",
      icon: "💡",
      title: "I can watch fares",
      pitch: "Fares.",
      label: "Fares",
      prompt: "Watch Sofia–Lisbon fares for May.",
      basis: [{ kind: "general", ref: "general" }],
      uses: [{ capability: "web", approval: false }],
      score: 0.5,
      status: "active",
      pinned: false,
      shownRuns: 0,
      createdAt: at,
      updatedAt: at,
      expiresAt: at,
    };
    const asked: string[] = [];
    /** A chip's *Try it* waits here until the test lets it answer. */
    const tries: (() => void)[] = [];
    const owner: SettingsClient & { features: readonly string[] } = {
      features: ["ideas"],
      request: async (command, payload) => {
        const action = String((payload as Record<string, unknown>)["action"]);
        asked.push(`${command} ${action}`);
        if (command !== "ideas") return { ok: false, error: { code: "UNSUPPORTED", message: "no" } } as never;
        if (action === "chips")
          return {
            ok: true,
            result: {
              chips: [
                { ideaId: "id-1", label: "Fares", prompt: idea.prompt },
                { label: "Search the web", prompt: "Search the web for [topic]." },
              ],
            },
          } as never;
        if (action === "try")
          return new Promise((resolve) => tries.push(() => resolve({ ok: true, result: { prompt: idea.prompt, idea } }))) as never;
        return {
          ok: true,
          result: { ideas: [idea], mutedCategories: [], excludedBasis: [], provider: "tavi.ideasagent", providers: [] },
        } as never;
      },
    };
    const extras: { prompt: string; fromIdeaId: string | undefined }[] = [];
    const { store } = fakeStore({ connection: "ready", runs: [] });
    store.submit = (prompt, extra) => void extras.push({ prompt, fromIdeaId: extra?.fromIdeaId });
    const page = await mount(<App store={store} client={owner} workspaceId="default" navigation={fakeNavigation("/").navigation} />);
    await act(async () => undefined);
    const box = () => page.querySelector<HTMLTextAreaElement>(".composer textarea");
    const type = async (text: string): Promise<void> => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box(), text);
        box()?.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const send = async (): Promise<void> => {
      await act(async () => page.querySelector<HTMLFormElement>("form.composer")?.requestSubmit());
    };
    const frame = () => act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const chip = (label: string) => [...page.querySelectorAll(".idea-chips button")].find((button) => button.textContent === label);
    const answerTries = async (): Promise<void> => {
      await act(async () => {
        tries.splice(0).forEach((resolve) => resolve());
      });
      await frame();
    };

    // One pick at a time: while it is on its way the chips wait, and a second click asks nothing.
    await click(chip("Fares"));
    expect(chip("Fares")?.hasAttribute("disabled")).toBe(true);
    await click(chip("Fares"));
    expect(asked.filter((request) => request === "ideas try")).toHaveLength(1);
    await answerTries();
    expect(box()?.value).toBe(idea.prompt);
    await send();
    expect(extras.at(-1)).toEqual({ prompt: idea.prompt, fromIdeaId: "id-1" });

    // An idea's chip, then another's in its place: the box holds the other's words, and no idea goes with them.
    await click(chip("Fares"));
    await answerTries();
    await click(chip("Search the web"));
    await frame();
    await send();
    expect(extras.at(-1)).toEqual({ prompt: "Search the web for [topic].", fromIdeaId: undefined });

    // The idea's words cleared and others typed: the message is the person's own.
    await click(chip("Fares"));
    await answerTries();
    await type("");
    await type("Something else");
    await send();
    expect(extras.at(-1)).toEqual({ prompt: "Something else", fromIdeaId: undefined });

    // A private chat started after Try it carries no idea either.
    await click(tab(page, ".bar .views", "Ideas"));
    await click([...page.querySelectorAll(".idea-card button")].find((button) => button.textContent === "Try it"));
    await answerTries();
    expect(box()?.value).toBe(idea.prompt);
    await click(page.querySelector(".new-private-session"));
    await type("A private question");
    await send();
    expect(extras.at(-1)).toEqual({ prompt: "A private question", fromIdeaId: undefined });

    // Writing to Home, an idea's chip is not offered: Home is no new chat to link; capability chips are.
    const home = fakeStore({ connection: "ready", runs: [], next: { kind: "home" } });
    const homePage = await mount(
      <App store={home.store} client={owner} workspaceId="default" navigation={fakeNavigation("/").navigation} />,
    );
    await act(async () => undefined);
    expect([...homePage.querySelectorAll(".idea-chips .idea-chip")].map((button) => button.textContent)).toEqual(["Search the web"]);
  });
  it("drops an idea with its words when the chat is left, links none the owner refused, and Try it opens a chat of its own", async () => {
    const at = "2026-10-19T10:00:00.000Z";
    const idea = {
      id: "id-1",
      workspaceId: "default",
      runId: "run-1",
      providerId: "tavi.ideasagent",
      key: "travel.fare-watch",
      category: "travel",
      icon: "💡",
      title: "I can watch fares",
      pitch: "Fares.",
      label: "Fares",
      prompt: "Watch Sofia–Lisbon fares for May.",
      basis: [{ kind: "general", ref: "general" }],
      uses: [{ capability: "web", approval: false }],
      score: 0.5,
      status: "active",
      pinned: false,
      shownRuns: 0,
      createdAt: at,
      updatedAt: at,
      expiresAt: at,
    };
    /** Each *Try it* waits here until the test answers it, as taken or refused. */
    const tries: ((ok: boolean) => void)[] = [];
    const owner: SettingsClient & { features: readonly string[] } = {
      features: ["ideas"],
      request: async (command, payload) => {
        const action = String((payload as Record<string, unknown>)["action"]);
        if (command !== "ideas") return { ok: false, error: { code: "UNSUPPORTED", message: "no" } } as never;
        if (action === "chips") return { ok: true, result: { chips: [{ ideaId: "id-1", label: "Fares", prompt: idea.prompt }] } } as never;
        if (action === "try")
          return new Promise((resolve) =>
            tries.push((ok) =>
              resolve(
                ok
                  ? { ok: true, result: { prompt: idea.prompt, idea } }
                  : { ok: false, error: { code: "NOT_FOUND", message: "Idea id-1 does not exist" } },
              ),
            ),
          ) as never;
        return {
          ok: true,
          result: { ideas: [idea], mutedCategories: [], excludedBasis: [], provider: "tavi.ideasagent", providers: [] },
        } as never;
      },
    };
    const extras: { prompt: string; fromIdeaId: string | undefined }[] = [];
    const newTasks: unknown[][] = [];
    const { store } = fakeStore({ connection: "ready", runs: [] });
    store.submit = (prompt, extra) => void extras.push({ prompt, fromIdeaId: extra?.fromIdeaId });
    store.newTask = (...args) => void newTasks.push(args);
    const page = await mount(<App store={store} client={owner} workspaceId="default" navigation={fakeNavigation("/").navigation} />);
    await act(async () => undefined);
    const box = () => page.querySelector<HTMLTextAreaElement>(".composer textarea");
    const type = async (text: string): Promise<void> => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(box(), text);
        box()?.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const send = async (): Promise<void> => {
      await act(async () => page.querySelector<HTMLFormElement>("form.composer")?.requestSubmit());
    };
    const frame = () => act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const chip = () => [...page.querySelectorAll(".idea-chips button")].find((button) => button.textContent === "Fares");
    const answer = async (ok: boolean): Promise<void> => {
      await act(async () => {
        tries.splice(0).forEach((resolve) => resolve(ok));
      });
      await frame();
    };
    const away = async (): Promise<void> => {
      await click(tab(page, ".bar .views", "Ideas"));
      await click(tab(page, ".bar .views", "Chat"));
    };

    // The idea's words filled the box, then the chat was left: back, what is typed is the person's own.
    await click(chip());
    await answer(true);
    expect(box()?.value).toBe(idea.prompt);
    await away();
    expect(box()?.value).toBe("");
    await type("Something else");
    await send();
    expect(extras.at(-1)).toEqual({ prompt: "Something else", fromIdeaId: undefined });

    // A pick that answers after the chat was left fills nothing and links nothing.
    await click(chip());
    await click(tab(page, ".bar .views", "Ideas"));
    await answer(true);
    await click(tab(page, ".bar .views", "Chat"));
    expect(box()?.value).toBe("");
    await type("Mine");
    await send();
    expect(extras.at(-1)).toEqual({ prompt: "Mine", fromIdeaId: undefined });

    // An idea the owner refused fills the box with its prompt alone.
    await click(chip());
    await answer(false);
    expect(box()?.value).toBe(idea.prompt);
    await send();
    expect(extras.at(-1)).toEqual({ prompt: idea.prompt, fromIdeaId: undefined });

    // Try it, which itself moves to the chat, keeps its idea, and opens a chat of its own.
    newTasks.length = 0;
    await click(tab(page, ".bar .views", "Ideas"));
    await click([...page.querySelectorAll(".idea-card button")].find((button) => button.textContent === "Try it"));
    await answer(true);
    expect(newTasks).toEqual([[undefined, { own: true }]]);
    expect(box()?.value).toBe(idea.prompt);
    await send();
    expect(extras.at(-1)).toEqual({ prompt: idea.prompt, fromIdeaId: "id-1" });
  });
});

describe("setup's first-run redirect", () => {
  const status = (firstRun: boolean) => ({
    workspaceId: "default",
    providerId: "tavi.onboarding",
    steps: [{ kind: "model", state: firstRun ? "todo" : "done", detail: "" }],
    complete: !firstRun,
    firstRun,
    open: firstRun ? ["model"] : [],
  });
  /** An owner offering `onboarding`: its status answered when `release` says so, its flow left waiting. */
  function onboardingOwner(firstRun: boolean, features: readonly string[] = ["onboarding"]) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const asked: string[] = [];
    const client: SettingsClient & { features: readonly string[] } = {
      features,
      request: (command, payload) => {
        const action = String((payload as Record<string, unknown>)["action"]);
        asked.push(`${command}:${action}`);
        if (command === "onboarding" && action === "status") return gate.then(() => ({ ok: true, result: status(firstRun) }) as never);
        return new Promise<never>(() => undefined);
      },
    };
    return {
      client,
      asked,
      release: async () => {
        release();
        await act(async () => {
          await gate;
          await Promise.resolve();
        });
      },
    };
  }
  const welcomeWrites = (writes: readonly { readonly url: string }[]) => writes.filter((write) => write.url.startsWith("/welcome"));
  afterEach(() => window.sessionStorage.clear());

  it("opens Welcome in place of the bare chat on a first run, once a browser session", async () => {
    window.sessionStorage.clear();
    const first = fakeNavigation("/");
    const owner = onboardingOwner(true);
    await mount(
      <App
        store={fakeStore({ connection: "ready", runs: [] }).store}
        client={owner.client}
        workspaceId="default"
        navigation={first.navigation}
      />,
    );
    await owner.release();
    expect(welcomeWrites(first.writes)).toEqual([{ kind: "replace", url: "/welcome" }]);
    // A second load in the same session stays on the chat.
    const again = fakeNavigation("/");
    const second = onboardingOwner(true);
    await mount(
      <App
        store={fakeStore({ connection: "ready", runs: [] }).store}
        client={second.client}
        workspaceId="default"
        navigation={again.navigation}
      />,
    );
    await second.release();
    expect(welcomeWrites(again.writes)).toEqual([]);
  });

  it("never opens it for a seeded install, an owner without onboarding, or a page the reader named", async () => {
    for (const [path, owner] of [
      ["/", onboardingOwner(false)],
      ["/", onboardingOwner(true, [])],
      ["/settings/system-prompt", onboardingOwner(true)],
    ] as const) {
      window.sessionStorage.clear();
      const address = fakeNavigation(path);
      await mount(
        <App
          store={fakeStore({ connection: "ready", runs: [] }).store}
          client={owner.client}
          workspaceId="default"
          navigation={address.navigation}
        />,
      );
      await owner.release();
      expect(welcomeWrites(address.writes)).toEqual([]);
      expect(address.path()).toBe(path);
    }
  });

  it("stays on a page the reader opened while the status was loading", async () => {
    window.sessionStorage.clear();
    const address = fakeNavigation("/");
    const owner = onboardingOwner(true);
    const page = await mount(
      <App
        store={fakeStore({ connection: "ready", runs: [] }).store}
        client={owner.client}
        workspaceId="default"
        navigation={address.navigation}
      />,
    );
    await click(tab(page, ".bar .views", "Settings"));
    await owner.release();
    expect(welcomeWrites(address.writes)).toEqual([]);
    expect(address.path()).toMatch(/^\/settings/u);
  });

  it("gives setup the page to itself: no chats beside it, no routes over it, no model strip under it", async () => {
    window.sessionStorage.clear();
    const address = fakeNavigation("/welcome");
    const owner = onboardingOwner(true);
    const page = await mount(
      <App
        store={fakeStore({ connection: "ready", runs: [] }).store}
        client={owner.client}
        workspaceId="default"
        navigation={address.navigation}
      />,
    );
    await owner.release();
    expect(page.querySelector(".canvas-setup")).not.toBeNull();
    expect(page.querySelector(".sidebar, .sidebar-rail")).toBeNull();
    expect(page.querySelector(".bar .views")).toBeNull();
    expect(page.querySelector(".bar .bar-context")?.textContent).toBe("Setup");
    expect(page.querySelector(".strip")).toBeNull();
  });
});
