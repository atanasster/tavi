import { describe, expect, it } from "vitest";

import { CHAT_PANEL_TABS } from "../../../src/features/chat-panel/tabs.js";
import {
  CENTER_SECTIONS,
  CHAT,
  DEFAULT_CENTER_SECTION,
  DEFAULT_SETTINGS_VIEW,
  parseRoute,
  routePath,
  ROUTES,
  schedulePath,
  settingsPath,
  SETTINGS_VIEWS,
  type CenterSection,
  type PageRoute,
} from "../../../src/features/shell/route.js";
import { mcpReviewPath } from "../../../src/features/settings/McpServers.js";

/**
 * The page's address. Pure, so the grammar is asserted without a DOM:
 * one path per page, the one spelling of each, and everything else the chat.
 */

const chat = (taskId: string | undefined): PageRoute => ({ ...CHAT, taskId });
const schedule = (inside: Pick<PageRoute, "routineId" | "runId" | "reminderId" | "scheduleId"> = {}): PageRoute => ({
  ...CHAT,
  route: "center",
  section: "schedule",
  ...inside,
});
const routine = (routineId: string, runId?: string): PageRoute => schedule({ routineId, runId });
const settings = (view: PageRoute["view"]): PageRoute => ({ route: "settings", view, taskId: undefined });
const center = (section: CenterSection): PageRoute => ({ ...CHAT, route: "center", section });

describe("the page's address", () => {
  it("reads each route from its path", () => {
    expect(parseRoute("/")).toEqual(chat(undefined));
    expect(parseRoute("/chat")).toEqual(chat(undefined));
    expect(parseRoute("/tasks/task-1")).toEqual(chat("task-1"));
    expect(parseRoute("/settings")).toEqual(settings(DEFAULT_SETTINGS_VIEW));
    for (const view of SETTINGS_VIEWS) expect(parseRoute(`/settings/${view.value}`)).toEqual(settings(view.value));
  });

  it("names the Ideas tab /ideas, and nothing under it", () => {
    expect(parseRoute("/ideas")).toEqual({ ...CHAT, route: "ideas" });
    expect(parseRoute("/ideas/")).toEqual({ ...CHAT, route: "ideas" });
    expect(routePath({ ...CHAT, route: "ideas" })).toBe("/ideas");
    expect(parseRoute("/ideas/idea-1")).toEqual(chat(undefined));
  });

  it("names a routine, and one of its runs, by id, inside Schedule", () => {
    expect(parseRoute("/center/schedule/routines/r1")).toEqual(routine("r1"));
    expect(parseRoute("/center/schedule/routines/r1/runs/run-1")).toEqual(routine("r1", "run-1"));
    expect(routePath(routine("r1"))).toBe("/center/schedule/routines/r1");
    expect(routePath(routine("r1", "run-1"))).toBe("/center/schedule/routines/r1/runs/run-1");
    expect(routePath(routine("a/b", "c d"))).toBe("/center/schedule/routines/a%2Fb/runs/c%20d");
    expect(parseRoute("/center/schedule/routines/a%2Fb/runs/c%20d")).toEqual(routine("a/b", "c d"));
  });

  it("reserves a reminder's address inside Schedule", () => {
    expect(parseRoute("/center/schedule/reminders/rem-1")).toEqual(schedule({ reminderId: "rem-1" }));
    expect(routePath(schedule({ reminderId: "a b" }))).toBe("/center/schedule/reminders/a%20b");
  });

  it("names a plain schedule's page inside Schedule", () => {
    expect(parseRoute("/center/schedule/schedules/s1")).toEqual(schedule({ scheduleId: "s1" }));
    expect(routePath(schedule({ scheduleId: "a/b" }))).toBe("/center/schedule/schedules/a%2Fb");
    expect(schedulePath("s 1")).toBe("/center/schedule/schedules/s%201");
    expect(parseRoute(schedulePath("a/b"))).toEqual(schedule({ scheduleId: "a/b" }));
  });

  it("redirects the Routines tab's and Settings → Schedules' old addresses to Schedule", () => {
    // Each parses as the new page; its path is the new address, which the
    // page writes back with `replaceState` (`usePageRoute`'s correction).
    const redirects: readonly (readonly [string, string, PageRoute])[] = [
      ["/routines", "/center/schedule", schedule()],
      ["/routines/", "/center/schedule", schedule()],
      ["/routines/r1", "/center/schedule/routines/r1", routine("r1")],
      ["/routines/r1/runs/run-1", "/center/schedule/routines/r1/runs/run-1", routine("r1", "run-1")],
      ["/routines/a%2Fb/runs/c%20d", "/center/schedule/routines/a%2Fb/runs/c%20d", routine("a/b", "c d")],
      ["/settings/schedules", "/center/schedule", schedule()],
    ];
    for (const [old, path, page] of redirects) {
      expect(parseRoute(old), old).toEqual(page);
      expect(routePath(parseRoute(old)), old).toBe(path);
    }
    expect(ROUTES.map((route) => route.value)).not.toContain("routines");
    expect(SETTINGS_VIEWS.map((view) => view.value)).not.toContain("schedules");
  });

  it("is slack about spelling and strict about routes: what it does not know is the chat", () => {
    expect(parseRoute("")).toEqual(chat(undefined));
    expect(parseRoute("/settings/")).toEqual(settings(DEFAULT_SETTINGS_VIEW));
    expect(parseRoute("//settings//models")).toEqual(settings("models"));
    // A view this build does not have: the settings, at their default view.
    expect(parseRoute("/settings/telepathy")).toEqual(settings(DEFAULT_SETTINGS_VIEW));
    // The Web search page by the name it shows.
    expect(parseRoute("/settings/web-search")).toEqual(settings("search"));
    // Nothing else is a page.
    expect(parseRoute("/old-link")).toEqual(chat(undefined));
    expect(parseRoute("/tasks")).toEqual(chat(undefined));
    expect(parseRoute("/tasks/task-1/trajectory")).toEqual(chat(undefined));
    expect(parseRoute("/routines/r1/logs")).toEqual(chat(undefined));
    expect(parseRoute("/routines/r1/runs")).toEqual(chat(undefined));
    expect(parseRoute("/routines/r1/runs/run-1/extra")).toEqual(chat(undefined));
    expect(parseRoute("/center/schedule/routines")).toEqual(chat(undefined));
    expect(parseRoute("/center/schedule/routines/r1/logs")).toEqual(chat(undefined));
    expect(parseRoute("/center/schedule/reminders")).toEqual(chat(undefined));
    expect(parseRoute("/center/schedule/telepathy/x")).toEqual(chat(undefined));
    expect(parseRoute("/center/approvals/routines/r1")).toEqual(chat(undefined));
  });

  it("keeps a task id whole, whatever it holds", () => {
    expect(parseRoute("/tasks/task-1")).toEqual(chat("task-1"));
    expect(parseRoute("/tasks/a%2Fb%20c")).toEqual(chat("a/b c"));
    expect(routePath(chat("a/b c"))).toBe("/tasks/a%2Fb%20c");
    // A malformed escape is not a reason to lose the page: it is read as it came.
    expect(parseRoute("/tasks/%zz")).toEqual(chat("%zz"));
  });

  it("writes each page back to the one path that names it", () => {
    expect(routePath(chat(undefined))).toBe("/");
    expect(routePath(chat("task-1"))).toBe("/tasks/task-1");
    expect(routePath(schedule())).toBe("/center/schedule");
    expect(routePath(settings(DEFAULT_SETTINGS_VIEW))).toBe("/settings");
    expect(routePath(settings("system-prompt"))).toBe("/settings/system-prompt");
    expect(routePath(settings("people"))).toBe("/settings/people");
    expect(routePath(settings("general"))).toBe("/settings/general");
  });

  it("names the General view, listed first, without making it the default", () => {
    expect(parseRoute("/settings/general")).toEqual(settings("general"));
    expect(SETTINGS_VIEWS[0]).toEqual({ value: "general", label: "General" });
    expect(DEFAULT_SETTINGS_VIEW).toBe("models");
  });

  it("names the Command Center and each of its sections, Activity by default", () => {
    expect(ROUTES.map((route) => route.label)).toEqual(["Chat", "Ideas", "Center", "Settings"]);
    expect(DEFAULT_CENTER_SECTION).toBe("activity");
    expect(parseRoute("/center")).toEqual(center("activity"));
    expect(parseRoute("/center/")).toEqual(center("activity"));
    for (const section of CENTER_SECTIONS) expect(parseRoute(`/center/${section.value}`)).toEqual(center(section.value));
    expect(routePath(center("activity"))).toBe("/center");
    expect(routePath({ ...CHAT, route: "center" })).toBe("/center");
    expect(routePath(center("approvals"))).toBe("/center/approvals");
    expect(routePath(center("identity"))).toBe("/center/identity");
  });

  it("reads a section it does not know as the Center's landing section, whose path corrects the address", () => {
    expect(parseRoute("/center/telepathy")).toEqual(center("activity"));
    expect(routePath(parseRoute("/center/telepathy"))).toBe("/center");
    // Deeper paths are pages only under Schedule.
    expect(parseRoute("/center/activity/x")).toEqual(chat(undefined));
  });

  it("round-trips every page the grammar can write", () => {
    const pages: readonly PageRoute[] = [
      chat(undefined),
      chat("task-1"),
      chat("a/b c"),
      schedule(),
      routine("r1"),
      routine("r1", "run-1"),
      schedule({ reminderId: "rem-1" }),
      ...SETTINGS_VIEWS.map((view) => settings(view.value)),
      ...CENTER_SECTIONS.map((section) => center(section.value)),
      ...CHAT_PANEL_TABS.map((panel) => ({ ...chat("task-1"), panel })),
    ];
    for (const page of pages) expect(parseRoute(routePath(page))).toEqual(page);
  });

  it("names the chat panel's tab beside its session, and only a tab it knows", () => {
    expect(parseRoute("/tasks/task-1/memory")).toEqual({ ...chat("task-1"), panel: "memory" });
    expect(routePath({ ...chat("task-1"), panel: "details" })).toBe("/tasks/task-1/details");
    // With no session there is no address to carry the tab.
    expect(routePath({ ...chat(undefined), panel: "details" })).toBe("/");
    expect(parseRoute("/tasks/task-1/telepathy")).toEqual(chat(undefined));
  });
});

describe("settingsPath", () => {
  it("spells a settings view as routePath does, at an anchor when given", () => {
    expect([settingsPath("permissions", "rule-r%201"), settingsPath("models"), settingsPath("general")]).toEqual([
      "/settings/permissions#rule-r%201",
      "/settings",
      "/settings/general",
    ]);
  });
});

describe("Connected apps' routes", () => {
  it("reads and writes the list, the catalog, an app and its connect sheet", async () => {
    const { appsPath } = await import("../../../src/features/shell/route.js");
    const apps = (extra: Partial<PageRoute> = {}): PageRoute => ({ route: "settings", view: "apps", taskId: undefined, ...extra });
    expect(parseRoute("/settings/apps")).toEqual(apps());
    expect(parseRoute("/settings/apps/discover")).toEqual(apps({ appsTab: "discover" }));
    expect(parseRoute("/settings/apps/google-calendar")).toEqual(apps({ appId: "google-calendar" }));
    expect(parseRoute("/settings/apps/mcp.gcal/connect")).toEqual(apps({ appId: "mcp.gcal", appConnect: true }));
    // A fourth segment that is not the sheet is no route of the apps view.
    expect(parseRoute("/settings/apps/x/y").route).toBe("chat");
    for (const where of [{}, { tab: "discover" as const }, { appId: "mcp.gcal" }, { appId: "mcp.gcal", connect: true }]) {
      expect(appsPath(where)).toBe(routePath(parseRoute(appsPath(where))));
    }
    expect(appsPath({ appId: "a b" })).toBe("/settings/apps/a%20b");
  });

  it("sends an old MCP review link to Connected apps, naming the server in the query", () => {
    expect(mcpReviewPath("mcp.gcal")).toBe("/settings/apps?review=mcp.gcal");
  });
});
