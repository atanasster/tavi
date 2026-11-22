import { useCallback, useEffect, useRef, useState } from "react";

import { isChatPanelTab, isPluginPanelTab, type PanelTab } from "../chat-panel/tabs.js";
import { said, saidCoreEntry } from "./said.js";

/**
 * The page's address: which route the URL names, so a refresh, a
 * bookmark or Back lands where the reader was rather than always on the chat.
 *
 * The grammar is one path per page, the one spelling of each:
 *
 * - `/` — the chat, on the session the page holds (the remembered task);
 * - `/tasks/<taskId>` — the chat, reading that session;
 * - `/tasks/<taskId>/<tab>` — the same, with the chat panel open on that tab;
 * - `/center` and `/center/<section>` — the Command Center, at that section,
 *   Activity when none is named;
 * - `/center/schedule/routines/<routineId>` — one routine's page, in Schedule;
 * - `/center/schedule/routines/<routineId>/runs/<runId>` — one of its runs;
 * - `/center/schedule/reminders/<reminderId>` — one reminder;
 * - `/center/schedule/schedules/<scheduleId>` — one plain schedule;
 * - `/ideas` — the Ideas tab;
 * - `/welcome` and `/welcome/<stepId>` — setup's Welcome, at that step;
 *   `?all=1` walks every step, done ones too;
 * - `/settings` and `/settings/<view>` — the settings, at that view.
 *
 * Routines merged into Schedule, and the
 * addresses they had redirect, so bookmarks and links in delivered reports
 * keep working: `/routines` and `/settings/schedules` are Schedule, and
 * `/routines/<routineId>[/runs/<runId>]` the same page under it. They parse
 * as the new page, and the address bar is corrected by `replaceState`, as for
 * any spelling that is not the one.
 *
 * A path the grammar does not know is the chat, and the address bar is
 * corrected rather than left naming a page that does not exist. Anything
 * narrower than a page — which chat sub-view, whether the sidebar or the
 * inspector is open — stays the page's own state: this is what a reader would
 * send someone, not a transcript of every click.
 *
 * The host is `window`, or a test's fake. Parsing and formatting are pure, so
 * the grammar is asserted without a DOM (`route.test.ts`).
 */

/** The shell's primary routes. */
export type Route = "chat" | "ideas" | "center" | "settings" | "welcome";

/**
 * Every route, in the bar's order. `center` is offered only by an owner that
 * advertises the `center` command, and `ideas` only by one that advertises
 * `ideas`; the shell filters them out otherwise.
 */
export const ROUTES: readonly { readonly value: Route; readonly label: string }[] = [
  saidCoreEntry("chat", "nav.route.chat"),
  saidCoreEntry("ideas", "nav.route.ideas"),
  saidCoreEntry("center", "nav.route.center"),
  saidCoreEntry("settings", "nav.route.settings"),
];

/** The views inside Settings; one URL segment each. */
export type SettingsView =
  | "general"
  | "apps"
  | "messaging"
  | "people"
  | "models"
  | "search"
  | "credentials"
  | "system-prompt"
  | "plugins"
  | "permissions"
  | "ideas";

export const SETTINGS_VIEWS: readonly { readonly value: SettingsView; readonly label: string }[] = [
  saidCoreEntry("general", "nav.settings.general"),
  saidCoreEntry("apps", "nav.settings.apps"),
  saidCoreEntry("models", "nav.settings.models"),
  saidCoreEntry("search", "nav.settings.search"),
  saidCoreEntry("system-prompt", "nav.settings.systemPrompt"),
  saidCoreEntry("credentials", "nav.settings.credentials"),
  saidCoreEntry("messaging", "nav.settings.channels"),
  saidCoreEntry("people", "nav.settings.people"),
  saidCoreEntry("plugins", "nav.settings.plugins"),
  saidCoreEntry("permissions", "nav.settings.permissions"),
  // Offered only by an owner that advertises `ideas`.
  saidCoreEntry("ideas", "nav.settings.ideas"),
];

/** Settings' views in the nav's groups: what the workspace runs, what it reaches, and what it is allowed. */
export const SETTINGS_GROUPS: readonly { readonly label: string; readonly views: readonly SettingsView[] }[] = [
  said("shell.route.settingsGroup.workspace", { views: ["general", "models", "search", "system-prompt"] }),
  said("shell.route.settingsGroup.connections", { views: ["apps", "credentials", "messaging", "people"] }),
  said("shell.route.settingsGroup.control", { views: ["plugins", "permissions", "ideas"] }),
];

/** The Command Center's sections; one URL segment each. */
export type CenterSection = "activity" | "approvals" | "schedule" | "heartbeat" | "identity" | "browser";

export const CENTER_SECTIONS: readonly { readonly value: CenterSection; readonly label: string }[] = [
  saidCoreEntry("activity", "nav.center.activity"),
  saidCoreEntry("approvals", "nav.center.approvals"),
  saidCoreEntry("schedule", "nav.center.schedule"),
  saidCoreEntry("heartbeat", "nav.center.heartbeat"),
  saidCoreEntry("identity", "nav.center.identity"),
  saidCoreEntry("browser", "nav.center.browser"),
];

/** The section a bare `/center` names: what happened, the landing view. */
export const DEFAULT_CENTER_SECTION: CenterSection = "activity";

const CENTER_SECTION_NAMES: ReadonlySet<string> = new Set(CENTER_SECTIONS.map((section) => section.value));

/** The view a bare `/settings` names, and the one a reader who has not opened Settings sees. */
export const DEFAULT_SETTINGS_VIEW: SettingsView = "models";

const SETTINGS_VIEW_NAMES: ReadonlySet<string> = new Set(SETTINGS_VIEWS.map((view) => view.value));

/** What the URL says the page shows. */
export interface PageRoute {
  readonly route: Route;
  /**
   * The settings view named, or the last one the reader opened. It is carried
   * while they are on another route — the chat's URL does not spell it — so
   * leaving Settings and returning keeps the view rather than resetting it.
   */
  readonly view: SettingsView;
  /** The session the URL names, when it names one. */
  readonly taskId: string | undefined;
  /** The routine the URL names, in the Center's Schedule section. */
  readonly routineId?: string | undefined;
  /** The run of that routine the URL names. */
  readonly runId?: string | undefined;
  /** The reminder the URL names, in the Center's Schedule section. */
  readonly reminderId?: string | undefined;
  /** The plain schedule the URL names, in the Center's Schedule section. */
  readonly scheduleId?: string | undefined;
  /** The Command Center section the URL names, on the center route. */
  readonly section?: CenterSection | undefined;
  /** The chat panel's tab the URL names, beside the session it names. */
  readonly panel?: PanelTab | undefined;
  /** In Connected apps: the list or the catalog. */
  readonly appsTab?: "connected" | "discover" | undefined;
  /** The app whose page the URL names. */
  readonly appId?: string | undefined;
  /** Its connect sheet is open over that page. */
  readonly appConnect?: boolean | undefined;
  /** Discover opened at an entry, by its words: the page's alone, never in the address. */
  readonly appsQuery?: string | undefined;
  /** The Welcome step the URL names. */
  readonly stepId?: string | undefined;
  /** Welcome's `?all=1`: every step, done ones included; kept across its steps. */
  readonly welcomeAll?: boolean | undefined;
}

/** The chat, on whatever session the page holds. */
export const CHAT: PageRoute = { route: "chat", view: DEFAULT_SETTINGS_VIEW, taskId: undefined };

/** A path's non-empty segments, each decoded; a malformed escape is kept as it came. */
function segments(pathname: string): readonly string[] {
  return pathname
    .split("/")
    .filter((part) => part !== "")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/** Settings views by the name their page shows, where it is not the view's id. */
const SETTINGS_VIEW_ALIASES: Readonly<Record<string, string>> = { "web-search": "search" };

/**
 * The page a pathname names. Only the shapes above are routes: `/settings/`
 * and `/chat` are the same pages they spell without the slack, and everything
 * else — an old link, a typo, a path this build does not know — is the chat.
 */
export function parseRoute(pathname: string, search = ""): PageRoute {
  const parts = segments(pathname);
  const [first, second] = parts;
  // The old Routines tab's addresses: the same pages, under Schedule.
  if (first === "routines") {
    const [, , third, runId] = parts;
    if (parts.length === 1) return schedule();
    if (parts.length === 2) return schedule({ routineId: second });
    if (parts.length === 4 && third === "runs") return schedule({ routineId: second, runId });
  }
  if (first === "center" && second === "schedule" && parts.length > 2) {
    const [, , kind, id, runs, runId] = parts;
    if (kind === "routines" && parts.length === 4) return schedule({ routineId: id });
    if (kind === "routines" && parts.length === 6 && runs === "runs") return schedule({ routineId: id, runId });
    if (kind === "reminders" && parts.length === 4) return schedule({ reminderId: id });
    if (kind === "schedules" && parts.length === 4) return schedule({ scheduleId: id });
  }
  // A section this build does not have is the Center's landing section, and
  // the address is corrected to `/center` rather than kept naming it.
  if (first === "center" && parts.length <= 2) {
    return {
      ...CHAT,
      route: "center",
      section: second !== undefined && CENTER_SECTION_NAMES.has(second) ? (second as CenterSection) : DEFAULT_CENTER_SECTION,
    };
  }
  if (first === "ideas" && parts.length === 1) return { ...CHAT, route: "ideas" };
  if (first === "welcome" && parts.length <= 2)
    return {
      ...CHAT,
      route: "welcome",
      ...(second === undefined ? {} : { stepId: second }),
      ...(new URLSearchParams(search).get("all") === "1" ? { welcomeAll: true } : {}),
    };
  // Settings → Schedules folded into Schedule.
  if (first === "settings" && second === "schedules" && parts.length === 2) return schedule();
  // Connected apps' own pages: the catalog, an app, and its connect sheet over it.
  if (first === "settings" && second === "apps" && parts.length >= 3 && parts.length <= 4) {
    const third = parts[2] as string;
    if (third === "discover" && parts.length === 3) return { route: "settings", view: "apps", taskId: undefined, appsTab: "discover" };
    if (parts.length === 3) return { route: "settings", view: "apps", taskId: undefined, appId: third };
    if (parts[3] === "connect") return { route: "settings", view: "apps", taskId: undefined, appId: third, appConnect: true };
  }
  if (first === "settings" && parts.length <= 2) {
    // A view by the name its page shows (`web-search`, the Web search page) is its view.
    const named = second === undefined ? undefined : (SETTINGS_VIEW_ALIASES[second] ?? second);
    return {
      route: "settings",
      view: named !== undefined && SETTINGS_VIEW_NAMES.has(named) ? (named as SettingsView) : DEFAULT_SETTINGS_VIEW,
      taskId: undefined,
    };
  }
  if (first === "tasks" && parts.length === 2 && second !== undefined) return { ...CHAT, taskId: second };
  if (first === "tasks" && parts.length === 3 && second !== undefined && isChatPanelTab(parts[2]))
    return { ...CHAT, taskId: second, panel: parts[2] };
  // A plugin's tab: `/tasks/<id>/plugin:<plugin-id>/<contribution-id>`.
  const pluginTab = parts.length === 4 ? `${parts[2]}/${parts[3]}` : undefined;
  if (first === "tasks" && second !== undefined && isPluginPanelTab(pluginTab)) return { ...CHAT, taskId: second, panel: pluginTab };
  return CHAT;
}

/** The Center's Schedule section, or a page inside it. */
function schedule(inside: Pick<PageRoute, "routineId" | "runId" | "reminderId" | "scheduleId"> = {}): PageRoute {
  return { ...CHAT, route: "center", section: "schedule", ...inside };
}

/** Where a page lives: the one spelling of each route, and the read of `parseRoute`. */
export function routePath(page: PageRoute): string {
  if (page.route === "center") {
    if (page.section === "schedule") {
      if (page.routineId !== undefined) {
        const routine = `/center/schedule/routines/${encodeURIComponent(page.routineId)}`;
        return page.runId === undefined ? routine : `${routine}/runs/${encodeURIComponent(page.runId)}`;
      }
      if (page.reminderId !== undefined) return `/center/schedule/reminders/${encodeURIComponent(page.reminderId)}`;
      if (page.scheduleId !== undefined) return `/center/schedule/schedules/${encodeURIComponent(page.scheduleId)}`;
    }
    return page.section === undefined || page.section === DEFAULT_CENTER_SECTION ? "/center" : `/center/${page.section}`;
  }
  if (page.route === "ideas") return "/ideas";
  if (page.route === "welcome")
    return `${page.stepId === undefined ? "/welcome" : `/welcome/${encodeURIComponent(page.stepId)}`}${page.welcomeAll === true ? "?all=1" : ""}`;
  if (page.route === "settings" && page.view === "apps") {
    if (page.appId !== undefined) return `/settings/apps/${encodeURIComponent(page.appId)}${page.appConnect === true ? "/connect" : ""}`;
    return page.appsTab === "discover" ? "/settings/apps/discover" : "/settings/apps";
  }
  if (page.route === "settings") return page.view === DEFAULT_SETTINGS_VIEW ? "/settings" : `/settings/${page.view}`;
  if (page.taskId === undefined) return "/";
  const task = `/tasks/${encodeURIComponent(page.taskId)}`;
  return page.panel === undefined ? task : `${task}/${page.panel}`;
}

/** A session's address. */
export const taskPath = (taskId: string): string => routePath({ ...CHAT, taskId });

/** A Command Center section's address. */
export const centerPath = (section: CenterSection): string => routePath({ ...CHAT, route: "center", section });

/** A routine's page inside Schedule. */
export const routinePath = (routineId: string): string => routePath(schedule({ routineId }));

/** A reminder's page inside Schedule. */
export const reminderPath = (reminderId: string): string => routePath(schedule({ reminderId }));

/** A plain schedule's page inside Schedule. */
export const schedulePath = (scheduleId: string): string => routePath(schedule({ scheduleId }));

/** Every page inside Schedule closed: what a move to a section or another route clears. */
export const NO_SCHEDULE_PAGE = {
  routineId: undefined,
  runId: undefined,
  reminderId: undefined,
  scheduleId: undefined,
} as const satisfies Partial<PageRoute>;

/** Connected apps' addresses: the list, the catalog, an app's page, its connect sheet. */
export const appsPath = (
  where: { readonly tab?: "connected" | "discover"; readonly appId?: string; readonly connect?: boolean } = {},
): string =>
  routePath({
    route: "settings",
    view: "apps",
    taskId: undefined,
    ...(where.tab === undefined ? {} : { appsTab: where.tab }),
    ...(where.appId === undefined ? {} : { appId: where.appId }),
    ...(where.connect === true ? { appConnect: true } : {}),
  });

/** A settings view's address, at `hash` (an anchor inside it, unescaped by the caller) when given. */
export const settingsPath = (view: SettingsView, hash?: string): string =>
  `${routePath({ route: "settings", view, taskId: undefined })}${hash === undefined ? "" : `#${hash}`}`;

/** A plain primary click, which the page follows in place; a modified one opens the address as the browser would. */
export const isPlainClick = (event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly button: number;
}): boolean => !(event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0);

/** The page's address, as this module reads and writes it: `window`, or a test's fake. */
export interface PageNavigation {
  readonly location: { readonly pathname: string; readonly search?: string };
  readonly history: {
    pushState(data: unknown, unused: string, url?: string): void;
    replaceState(data: unknown, unused: string, url?: string): void;
  };
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

/** Where the reader is going: the page itself, or the change from the current one. */
export type RouteChange = PageRoute | ((page: PageRoute) => PageRoute);

/** One navigation's options: `replace` swaps the current entry rather than adding one. */
export interface RouteOptions {
  readonly replace?: boolean;
}

/** How a page goes elsewhere: `usePageRoute`'s `navigate`. */
export type Navigate = (next: RouteChange, options?: RouteOptions) => void;

/**
 * The page the address bar names, and how to go elsewhere. With no host
 * (a component test, a page without `window`) the route still changes in
 * memory: the shell works, it just has no address to keep.
 *
 * A host that names a path this module does not know is corrected once, by
 * `replaceState`, so the address bar and the page agree and Back is not
 * offered a page that does not exist. `popstate` — Back, Forward, a bookmark
 * — is read back into the page.
 */
export function usePageRoute(navigation: PageNavigation | undefined): {
  readonly page: PageRoute;
  readonly navigate: (next: RouteChange, options?: RouteOptions) => void;
} {
  const [page, setPage] = useState<PageRoute>(() =>
    navigation === undefined ? CHAT : parseRoute(navigation.location.pathname, navigation.location.search),
  );
  const latest = useRef(page);
  useEffect(() => {
    latest.current = page;
  }, [page]);
  const navigate = useCallback(
    (next: RouteChange, options?: RouteOptions) => {
      const target = typeof next === "function" ? next(latest.current) : next;
      if (navigation !== undefined) {
        const url = routePath(target);
        // Clicking the route the reader is already on is not a step: a
        // duplicate entry would make Back appear to do nothing.
        if (`${navigation.location.pathname}${navigation.location.search ?? ""}` !== url) {
          const write = options?.replace === true ? navigation.history.replaceState : navigation.history.pushState;
          write.call(navigation.history, null, "", url);
        }
      }
      latest.current = target;
      setPage(target);
    },
    [navigation],
  );
  useEffect(() => {
    if (navigation === undefined) return;
    const read = (): void => setPage(parseRoute(navigation.location.pathname, navigation.location.search));
    navigation.addEventListener("popstate", read);
    return () => navigation.removeEventListener("popstate", read);
  }, [navigation]);
  useEffect(() => {
    if (navigation === undefined) return;
    // A query only Welcome reads (`?all=1`) stays; the path is what is corrected.
    const canonical = routePath(parseRoute(navigation.location.pathname, navigation.location.search));
    if (navigation.location.pathname !== canonical.split("?")[0]) navigation.history.replaceState(null, "", canonical);
  }, [navigation]);
  return { page, navigate };
}
