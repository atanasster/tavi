// @vitest-environment jsdom
import {
  defaultHeartbeatConfig,
  HEARTBEAT_PRODUCTION_OPTIONS,
  type HeartbeatConfig,
  type HeartbeatGetAnswer,
  type ReminderView,
  type ScheduleRecord,
} from "@tavi/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HeartbeatPill } from "../../../src/features/center/HeartbeatPill.js";
import { HEARTBEAT_POLL_MS } from "../../../src/features/center/heartbeat-source.js";
import { Schedule } from "../../../src/features/center/Schedule.js";
import { UNDO_DELETE_MS, UNDO_PAUSE_MAX_MS } from "../../../src/features/center/UndoDelete.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { mount as mountNow, mountSettled as mount, rerender, settle, unmountAll } from "../../support/dom.js";
import { InWorkspace } from "../../support/workspace.js";

/**
 * Recurring as one list: every kind drawn as the same row (Run now where it
 * has one, the Pause/Resume switch, More), the heartbeat among them, sorted
 * by next run, with filter chips, a name filter and Pause all; deletes held
 * behind an Undo; Duplicate opening the filled form.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
  // The delete waiting outlives the list: leaving the page makes it, so the next test starts with none.
  window.dispatchEvent(new Event("pagehide"));
  unmountAll();
});

const AT = "2026-10-28T06:00:00.000Z";

const schedule = (overrides: Partial<ScheduleRecord> & Pick<ScheduleRecord, "scheduleId" | "name">): ScheduleRecord => ({
  workspaceId: "default",
  principalId: "operator",
  prompt: "Summarise my inbox",
  spec: { at: "07:00", timezone: "UTC" },
  missedRunPolicy: "skip",
  autoApproveTools: ["reports.*"],
  enabled: true,
  nextRunAt: "2026-10-30T07:00:00.000Z",
  lastRunAt: "2026-10-27T07:00:00.000Z",
  lastRunTaskId: null,
  lastOutcome: "completed",
  consecutiveFailures: 0,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

const brief = schedule({
  scheduleId: "s-brief",
  name: "Brief",
  notify: "when-sent",
  maxTokens: 50_000,
  deliverTo: "home",
  maxRunMinutes: 30,
});
const digest = schedule({
  scheduleId: "s-digest",
  name: "Digest",
  enabled: false,
  pausedReason: "failures",
  nextRunAt: null,
  lastOutcome: "failed: the model provider refused the request",
  consecutiveFailures: 3,
});

const routine = {
  routineId: "r-news",
  workspaceId: "default",
  principalId: "operator",
  name: "LLM news",
  status: "active",
  version: 3,
  activeRevision: 1,
  latestRevision: 1,
  lastRun: null,
  nextRunAt: "2026-10-29T19:00:00.000Z",
  triggers: [{ id: "morning", kind: "daily", at: "19:00", timezone: "UTC" }],
};

const stretch: ReminderView = {
  reminderId: "rem-stretch",
  workspaceId: "default",
  principalId: "operator",
  text: "Stretch",
  prompt: "Suggest a two-minute stretch",
  when: { kind: "repeat", times: ["06:00", "15:00"], daysOfWeek: [1, 2, 3, 4, 5] },
  timezone: "UTC",
  deliverTo: { kind: "app" },
  status: "active",
  nextFireAt: "2026-10-29T06:00:00.000Z",
  lastFiredAt: null,
  createdBy: "user",
  operationKey: "op-stretch",
  createdAt: AT,
  updatedAt: AT,
  upcoming: [],
};

/** An owner with a schedule, a paused failing schedule, a routine, a reminder and the heartbeat, recording what it was asked. */
function owner(
  options: {
    readonly hostRunning?: boolean;
    readonly refuseRoutinePause?: string;
    readonly refuseRemove?: string;
    readonly heartbeat?: boolean;
    /** More plain schedules the list answers, after Brief and Digest. */
    readonly schedules?: readonly ScheduleRecord[];
  } = {},
) {
  const asked: { readonly command: string; readonly payload: Record<string, unknown> }[] = [];
  /** Every request, reads included. */
  const all: { readonly command: string; readonly action: unknown }[] = [];
  let config: HeartbeatConfig = { ...defaultHeartbeatConfig(), enabled: true };
  let revision = config.revision;
  // Pauses stick, as the owner's do: the lists read after Pause all show them.
  let stretchStatus: ReminderView["status"] = "active";
  let briefEnabled = true;
  const heartbeat = (): HeartbeatGetAnswer => ({
    workspaceId: "default",
    principalId: "operator",
    config,
    revision,
    options: HEARTBEAT_PRODUCTION_OPTIONS,
    timezone: "UTC",
    hostRunning: options.hostRunning ?? true,
    providers: ["tavi.heartbeatagent"],
    providerDetails: [{ id: "tavi.heartbeatagent", kind: "builtin", receives: ["instructions", "signals", "ledger", "memory"] }],
    state: {
      workspaceId: "default",
      principalId: "operator",
      config,
      nextTickAt: "2026-10-29T09:30:00.000Z",
      lastTickAt: "2026-10-28T05:30:00.000Z",
      createdAt: AT,
      updatedAt: AT,
    },
    toolChoices: [],
    sources: [],
  });
  const client: SettingsClient = {
    request: async (command, raw) => {
      const payload = raw as Record<string, unknown>;
      const action = payload["action"];
      all.push({ command, action });
      const quiet = ["list", "agenda", "fires", "todos", "get", "preview", "show", "targets"].includes(String(action));
      if (!quiet || command === "heartbeat") asked.push({ command, payload });
      const ok = (result: unknown) => ({ ok: true, result }) as never;
      if (command === "schedules") {
        if (action === "agenda") return ok({ timezone: "UTC", items: [], truncated: false, skipped: [] });
        if (action === "list")
          return ok({ schedules: [{ ...brief, enabled: briefEnabled }, digest, ...(options.schedules ?? [])], truncated: false });
        if (action === "disable" || action === "enable") briefEnabled = action === "enable";
        if (action === "remove" && options.refuseRemove !== undefined)
          return { ok: false, error: { code: "CONFLICT", message: options.refuseRemove } } as never;
        if (action === "show") return ok({ ...brief, timezone: "UTC", recentFires: [] });
        if (action === "preview") return ok({ timezone: "UTC", text: "", runs: [] });
        return ok({ ...brief, enabled: action !== "disable" });
      }
      if (command === "agents") return ok({ agents: [], truncated: false });
      if (command === "routines") {
        if (action === "list") return ok({ routines: [routine] });
        if (action === "targets") return ok({ targets: [] });
        if (action === "pause" && options.refuseRoutinePause !== undefined)
          return { ok: false, error: { code: "CONFLICT", message: options.refuseRoutinePause } } as never;
        return ok({});
      }
      if (command === "reminders") {
        if (action === "list")
          return ok({
            timezone: "UTC",
            reminders: (payload["statuses"] as unknown[] | undefined) ? [] : [{ ...stretch, status: stretchStatus }],
          });
        if (action === "pause" || action === "resume") stretchStatus = action === "pause" ? "paused" : "active";
        if (action === "fires") return ok({ fires: [] });
        if (action === "todos") return ok({ todos: [] });
        if (action === "create") return ok({ reminder: { ...stretch, reminderId: "rem-copy" }, created: true, skippedNotices: [] });
        if (action === "update") return ok({ reminder: { ...stretch, text: String(payload["text"] ?? stretch.text) } });
        return ok({ reminder: { ...stretch, status: action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "active" } });
      }
      if (command === "heartbeat") {
        if (action === "set") {
          revision += 1;
          config = { ...config, ...(payload["changes"] as Partial<HeartbeatConfig>), revision };
        }
        if (action === "run-now") return ok({ status: "started" });
        return ok(heartbeat());
      }
      return ok({});
    },
  };
  return { client, asked, all };
}

const page = (client: SettingsClient, heartbeat = true, workspaceId = "default", props: Partial<Parameters<typeof Schedule>[0]> = {}) => (
  <InWorkspace client={client} workspaceId={workspaceId}>
    <Schedule
      summary={undefined}
      revision={props.revision ?? 0}
      scheduleId={props.scheduleId}
      reminders
      heartbeat={heartbeat}
      onOpenHeartbeat={() => undefined}
      onOpenRoutine={() => undefined}
      onOpenReminder={() => undefined}
      onOpenSchedule={() => undefined}
      onFollow={async () => undefined}
    />
  </InWorkspace>
);

const rows = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>(".schedule-recurring-list > li")];
const names = (host: ParentNode) => rows(host).map((row) => row.querySelector(".item-title")?.textContent);
const byLabel = (host: ParentNode, label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const byText = (host: ParentNode, text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
async function press(element: HTMLElement | null | undefined) {
  await act(async () => element?.click());
}
/** Opens the row `name`d's More menu and chooses `item`, without waiting on timers (a test may hold them). */
async function choose(host: HTMLElement, name: string, item: string) {
  await press(byLabel(host, `More actions for ${name}`));
  await press([...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === item));
}
/** Focus leaves Undo, as when the person moves on. */
const blur = () => act(async () => (document.activeElement as HTMLElement | null)?.blur());
const sent = (asked: ReturnType<typeof owner>["asked"], command: string, action: string) =>
  asked.filter((item) => item.command === command && item.payload["action"] === action);

describe("one row for every kind", () => {
  it("draws reminders, routines, schedules and the heartbeat alike, soonest next run first", async () => {
    const host = await mount(page(owner().client));
    await settle();
    expect(names(host)).toEqual(["Stretch", "Heartbeat", "LLM news", "Brief", "Digest"]);
    expect(rows(host).map((row) => row.querySelector(".schedule-kind")?.textContent)).toEqual([
      "Reminder",
      "Heartbeat",
      "Routine",
      "Schedule",
      "Schedule",
    ]);
    // Short visible labels, the name in each control's accessible name, in one order: Run now, the switch, More.
    const controls = (name: string) =>
      [
        ...(rows(host)
          .find((row) => row.textContent?.includes(name))
          ?.querySelectorAll(".schedule-recurring-controls > *") ?? []),
      ].map((control) => [
        control.textContent?.trim() || undefined,
        control.getAttribute("aria-label") ?? control.firstElementChild?.getAttribute("aria-label"),
      ]);
    expect(controls("Brief")).toEqual([
      ["Run now", "Run now: Brief"],
      [undefined, "Pause Brief"],
      ["More", "More actions for Brief"],
    ]);
    expect(controls("Digest")[1]).toEqual([undefined, "Resume Digest"]);
    expect(controls("LLM news")[0]).toEqual(["Run now", "Run now: LLM news"]);
    // A reminder cannot be run by hand.
    expect(controls("Stretch")).toEqual([
      [undefined, "Pause Stretch"],
      ["More", "More actions for Stretch"],
    ]);
    // Each name links to its page; the last line says how it went, or that nothing ran yet.
    const links = rows(host).map((row) => row.querySelector("a.item-title")?.getAttribute("href"));
    expect(links).toEqual([
      "/center/schedule/reminders/rem-stretch",
      "/center/heartbeat",
      "/center/schedule/routines/r-news",
      "/center/schedule/schedules/s-brief",
      "/center/schedule/schedules/s-digest",
    ]);
    expect(rows(host)[0]?.textContent).toContain("Not run yet.");
    expect(rows(host)[2]?.textContent).toContain("Not run yet.");
    expect(rows(host)[3]?.textContent).toContain("Last run Tue 27 Oct 07:00 · Completed.");
    expect(rows(host)[4]?.querySelector(".badge")?.textContent).toBe("paused failures");
  });

  it("offers each kind's own More: Delete where removal is permanent, Archive where history is kept", async () => {
    const host = await mount(page(owner().client));
    await settle();
    const menu = async (name: string) => {
      await press(byLabel(host, `More actions for ${name}`));
      const items = [...host.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
      await act(async () =>
        host.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      return items;
    };
    expect(await menu("Brief")).toEqual(["Edit", "Duplicate", "Delete"]);
    expect(await menu("LLM news")).toEqual(["Edit", "Duplicate", "Archive"]);
    expect(await menu("Stretch")).toEqual(["Edit", "Duplicate", "Delete"]);
    expect(await menu("Heartbeat")).toEqual(["Edit"]);
  });

  it("opens More from the keyboard, moves with the arrows, and gives focus back on Escape", async () => {
    const host = await mount(page(owner().client));
    await settle();
    const more = byLabel(host, "More actions for Brief")!;
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      more.focus();
      more.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const menu = host.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.getAttribute("aria-label")).toBe("More actions for Brief");
    expect(more.getAttribute("aria-controls")).toBe(menu.id);
    expect(document.activeElement?.textContent).toBe("Edit");
    const key = (name: string) =>
      act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
    await key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Duplicate");
    await key("End");
    expect(document.activeElement?.textContent).toBe("Delete");
    await key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Edit");
    await key("Escape");
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);
  });
});

describe("the heartbeat's row", () => {
  it("says its active hours and next check, turns it off and on, and checks now", async () => {
    const { client, asked } = owner();
    const host = await mount(page(client));
    await settle();
    const row = rows(host).find((item) => item.dataset["rowKey"] === "heartbeat")!;
    expect(row.textContent).toContain("Daily every 30 min 08:00–22:00 · UTC");
    expect(row.textContent).toContain("Next check Thu 29 Oct 09:30");
    expect(row.textContent).toContain("Last check Wed 28 Oct 05:30");
    const toggle = byLabel(row, "Turn off Heartbeat")!;
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await press(toggle);
    await settle();
    expect(sent(asked, "heartbeat", "set").at(-1)?.payload).toMatchObject({ changes: { enabled: false } });
    expect(host.textContent).toContain("Heartbeat turned off.");
    const off = rows(host).find((item) => item.dataset["rowKey"] === "heartbeat")!;
    expect(off.querySelector(".badge")?.textContent).toBe("off");
    expect(byLabel(off, "Run now: Heartbeat")?.disabled).toBe(true);
    await press(byLabel(off, "Turn on Heartbeat"));
    await settle();
    await press(byLabel(host, "Run now: Heartbeat"));
    await settle();
    expect(sent(asked, "heartbeat", "run-now")).toHaveLength(1);
    expect(host.textContent).toContain("Heartbeat checking now.");
  });

  it("cannot check now where the host does not run, and is absent where the owner has no heartbeat", async () => {
    const host = await mount(page(owner({ hostRunning: false }).client));
    await settle();
    const run = byLabel(host, "Run now: Heartbeat")!;
    expect(run.disabled).toBe(true);
    expect(run.title).toBe("The heartbeat runs in tavi serve");
    unmountAll();
    const { client, asked } = owner();
    const without = await mount(page(client, false));
    await settle();
    expect(names(without)).not.toContain("Heartbeat");
    expect(asked.some((item) => item.command === "heartbeat")).toBe(false);
  });
});

describe("filters, order and Pause all", () => {
  it("filters by kind, failing and paused, and by name", async () => {
    const host = await mount(page(owner().client));
    await settle();
    const chips = [...host.querySelectorAll<HTMLButtonElement>(".schedule-recurring-tools .center-chip")];
    expect(chips.map((chip) => chip.textContent)).toEqual(["All", "Reminders", "Routines", "Schedules", "Watchers", "Failing", "Paused"]);
    const chip = (label: string) => press(chips.find((item) => item.textContent === label));
    await chip("Schedules");
    expect(names(host)).toEqual(["Brief", "Digest"]);
    expect(chips.find((item) => item.textContent === "Schedules")?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector(".schedule-recurring-tools + p, [role='status'].meta-sm")?.textContent).toBe("2 of 5 shown");
    // The heading counts the same rows the filter's total does, the heartbeat's among them.
    expect(host.querySelector(".schedule-recurring-head > span")?.textContent).toBe("5");
    await chip("Failing");
    expect(names(host)).toEqual(["Digest"]);
    await chip("Paused");
    expect(names(host)).toEqual(["Digest"]);
    await chip("Reminders");
    expect(names(host)).toEqual(["Stretch"]);
    await chip("Routines");
    expect(names(host)).toEqual(["LLM news"]);
    await chip("All");
    const search = host.querySelector<HTMLInputElement>('[aria-label="Filter recurring by name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "BRI");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(names(host)).toEqual(["Brief"]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "nothing like it");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows(host)).toHaveLength(0);
    expect(host.textContent).toContain("Nothing here matches.");
  });

  it("marks a watcher, says what it watches, and filters to watchers", async () => {
    const watcher = schedule({
      scheduleId: "s-status",
      name: "Status page",
      spec: { everyHours: 2, timezone: "UTC" },
      precheck: { kind: "page-changed", target: "https://example.com/status" },
      watch: true,
    });
    // A pre-check alone is not a watcher.
    const checked = schedule({
      scheduleId: "s-notes",
      name: "Notes",
      precheck: { kind: "file-changed", target: "/notes/today.md" },
    });
    const host = await mount(page(owner({ schedules: [watcher, checked] }).client));
    await settle();
    const row = rows(host).find((item) => item.dataset["rowKey"] === "schedule:s-status")!;
    expect(row.querySelector(".badge")?.textContent).toBe("Watcher");
    expect(row.textContent).toContain("Watches the page https://example.com/status every 2 hours; runs only when it changes");
    const notes = rows(host).find((item) => item.dataset["rowKey"] === "schedule:s-notes")!;
    expect(notes.textContent).not.toContain("Watcher");
    await press(
      [...host.querySelectorAll<HTMLButtonElement>(".schedule-recurring-tools .center-chip")].find(
        (chip) => chip.textContent === "Watchers",
      ),
    );
    expect(names(host)).toEqual(["Status page"]);
  });

  it("pauses what is shown after a confirm, says how each went, and resumes those it paused", async () => {
    const { client, asked } = owner({ refuseRoutinePause: "routine changed since it was read" });
    const host = await mount(page(client));
    await settle();
    await press(byText(host, "Pause all"));
    // The heartbeat keeps its own pause; what is already paused is not asked again.
    expect(host.querySelector(".confirmation")?.textContent).toContain("Pause 3 items: Stretch, LLM news, Brief? Each can be resumed.");
    expect(document.activeElement?.textContent).toBe("Keep running");
    await press(byText(host, "Keep running"));
    expect(sent(asked, "schedules", "disable")).toHaveLength(0);
    await press(byText(host, "Pause all"));
    await press(byText(host, "Pause them"));
    await settle();
    expect(sent(asked, "reminders", "pause")).toHaveLength(1);
    expect(sent(asked, "routines", "pause")[0]?.payload).toMatchObject({ routineId: "r-news", expectedVersion: 3 });
    expect(sent(asked, "schedules", "disable")[0]?.payload).toMatchObject({ scheduleId: "s-brief" });
    expect(sent(asked, "heartbeat", "pause")).toHaveLength(0);
    const failure = host.querySelector('.failure[role="alert"]');
    expect(failure?.textContent).toBe("Paused 2 of 3: Stretch, Brief. Not paused: LLM news (routine changed since it was read).");
    await press(byText(host, "Resume the 2 paused items"));
    await settle();
    expect(sent(asked, "reminders", "resume")).toHaveLength(1);
    expect(sent(asked, "schedules", "enable")[0]?.payload).toMatchObject({ scheduleId: "s-brief" });
    expect(sent(asked, "routines", "resume")).toHaveLength(0);
    expect(byText(host, "Resume the 2 paused items")).toBeUndefined();
  });

  it("pauses only the selection a chip leaves", async () => {
    const { client, asked } = owner();
    const host = await mount(page(client));
    await settle();
    await press([...host.querySelectorAll<HTMLButtonElement>(".center-chip")].find((chip) => chip.textContent === "Schedules"));
    await press(byText(host, "Pause all"));
    expect(host.querySelector(".confirmation")?.textContent).toContain("Pause 1 item shown: Brief?");
    await press(byText(host, "Pause them"));
    await settle();
    expect(sent(asked, "schedules", "disable")).toHaveLength(1);
    expect(sent(asked, "reminders", "pause")).toHaveLength(0);
    expect(sent(asked, "routines", "pause")).toHaveLength(0);
    expect(host.textContent).toContain("Paused 1 of 1: Brief.");
  });
});

describe("Delete waits behind its Undo", () => {
  it("hides the row at once, and Undo brings it back without asking the owner", async () => {
    const { client, asked } = owner();
    const host = await mount(page(client));
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await choose(host, "Brief", "Delete");
    expect(names(host)).not.toContain("Brief");
    const toast = host.querySelector(".undo-toast");
    expect(toast?.closest('[role="status"]')).not.toBeNull();
    expect(toast?.textContent).toContain("Brief deleted.");
    const undo = byLabel(host, "Undo deleting Brief")!;
    expect(document.activeElement).toBe(undo);
    await press(undo);
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS * 2));
    expect(sent(asked, "schedules", "remove")).toHaveLength(0);
    expect(names(host)).toContain("Brief");
    expect(host.querySelector(".undo-toast")).toBeNull();
    expect(host.textContent).toContain("Brief kept.");
  });

  it("asks the owner once the wait is over, and only once", async () => {
    const { client, asked } = owner();
    const host = await mount(page(client));
    await settle();
    // The clock as well: the wait goes on from where it stopped while Undo had focus.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await choose(host, "Brief", "Delete");
    await blur();
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS - 1));
    expect(sent(asked, "schedules", "remove")).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(1));
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS * 2));
    expect(sent(asked, "schedules", "remove").map((item) => item.payload)).toEqual([
      { action: "remove", workspaceId: "default", scheduleId: "s-brief" },
    ]);
    expect(host.textContent).toContain("Brief deleted.");
    expect(host.querySelector(".undo-toast")).toBeNull();
  });

  it("keeps a waiting delete while Schedule is left, and makes it when the wait is over, the page is left, or another starts", async () => {
    const { client, asked } = owner();
    let host = await mount(page(client));
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await choose(host, "Brief", "Delete");
    await blur();
    unmountAll();
    expect(sent(asked, "schedules", "remove")).toHaveLength(0);
    // Back on Schedule before the wait is over: the row is still hidden and Undo is there again.
    host = await mountNow(page(client));
    expect(names(host)).not.toContain("Brief");
    expect(byLabel(host, "Undo deleting Brief")).not.toBeNull();
    unmountAll();
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS));
    expect(sent(asked, "schedules", "remove")).toHaveLength(1);
    vi.useRealTimers();

    host = await mount(page(client));
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await choose(host, "Stretch", "Delete");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(sent(asked, "reminders", "cancel")).toHaveLength(1);
    await choose(host, "Digest", "Delete");
    await choose(host, "Brief", "Delete");
    expect(sent(asked, "schedules", "remove").map((item) => item.payload["scheduleId"])).toEqual(["s-brief", "s-digest"]);
    await blur();
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS));
    expect(sent(asked, "schedules", "remove").map((item) => item.payload["scheduleId"])).toEqual(["s-brief", "s-digest", "s-brief"]);
  });

  it("says a refusal that came while Schedule was left once it is back, and makes a waiting delete when another workspace opens", async () => {
    const refusing = owner({ refuseRemove: "fire in flight" });
    let host = await mount(page(refusing.client));
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await choose(host, "Brief", "Delete");
    await blur();
    unmountAll();
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS));
    expect(sent(refusing.asked, "schedules", "remove")).toHaveLength(1);
    vi.useRealTimers();
    host = await mount(page(refusing.client));
    await settle();
    expect(host.textContent).toContain("Brief was not deleted: fire in flight");
    expect(names(host)).toContain("Brief");
    // Said once: the next visit is quiet.
    unmountAll();
    host = await mount(page(refusing.client));
    await settle();
    expect(host.textContent).not.toContain("Brief was not deleted");

    const { client, asked } = owner();
    host = await mount(page(client));
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await choose(host, "Brief", "Delete");
    unmountAll();
    expect(sent(asked, "schedules", "remove")).toHaveLength(0);
    host = await mountNow(page(client, true, "other"));
    expect(sent(asked, "schedules", "remove")).toHaveLength(1);
    expect(host.querySelector(".undo-toast")).toBeNull();
  });

  it("runs the wait while Undo has the focus it was given, and makes the delete in the end", async () => {
    const { client, asked } = owner();
    const host = await mount(page(client));
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await choose(host, "Brief", "Delete");
    // Undo is where focus is, and the toast is said, yet the wait goes on: nobody has to move away for the delete to be made.
    const undo = byLabel(host, "Undo deleting Brief");
    expect(document.activeElement).toBe(undo);
    expect(undo?.closest('[role="status"]')).not.toBeNull();
    expect(host.querySelector(".undo-toast")?.classList.contains("undo-toast-paused")).toBe(false);
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS));
    expect(sent(asked, "schedules", "remove")).toHaveLength(1);
  });

  it("stops the wait, for a bounded time, while the person puts focus or the pointer on the toast, and gives focus to the Recurring heading if the toast closes with it", async () => {
    const { client, asked } = owner();
    const host = await mount(page(client));
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await choose(host, "Brief", "Delete");
    await blur();
    // Focus brought back to Undo stops the wait.
    await act(async () => byLabel(host, "Undo deleting Brief")?.focus());
    expect(host.querySelector(".undo-toast")?.classList.contains("undo-toast-paused")).toBe(true);
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS));
    expect(sent(asked, "schedules", "remove")).toHaveLength(0);
    await blur();
    // So does the pointer.
    const toast = host.querySelector(".undo-toast")!;
    await act(async () => toast.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS));
    expect(sent(asked, "schedules", "remove")).toHaveLength(0);
    await act(async () => toast.dispatchEvent(new PointerEvent("pointerout", { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS));
    expect(sent(asked, "schedules", "remove")).toHaveLength(1);

    // A pointer left on the toast holds the wait only so long, then the delete is made.
    await choose(host, "Stretch", "Delete");
    const held = host.querySelector(".undo-toast")!;
    await act(async () => held.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    await act(async () => vi.advanceTimersByTime(UNDO_PAUSE_MAX_MS - 1));
    expect(sent(asked, "reminders", "cancel")).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(1));
    expect(host.querySelector(".undo-toast")?.classList.contains("undo-toast-paused")).toBe(false);
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS));
    expect(sent(asked, "reminders", "cancel")).toHaveLength(1);

    // Closed while Undo had focus: focus goes to the heading, not the page.
    await choose(host, "Digest", "Delete");
    expect(document.activeElement).toBe(byLabel(host, "Undo deleting Digest"));
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(host.querySelector(".undo-toast")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.id).toBe("center-recurring-title");
  });

  it("holds a reminder's delete the same way", async () => {
    const { client, asked } = owner();
    const host = await mount(page(client));
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await choose(host, "Stretch", "Delete");
    expect(names(host)).not.toContain("Stretch");
    await press(byLabel(host, "Undo deleting Stretch"));
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS * 2));
    expect(sent(asked, "reminders", "cancel")).toHaveLength(0);
    expect(names(host)).toContain("Stretch");
  });
});

describe("Duplicate", () => {
  it("opens a schedule's form filled from its settings, saved as a new schedule", async () => {
    const { client, asked } = owner();
    const host = await mount(page(client));
    await settle();
    await choose(host, "Brief", "Duplicate");
    await settle();
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Create schedule");
    const name = dialog.querySelector<HTMLInputElement>('[aria-label="Schedule name"]')!;
    expect(name.value).toBe("Brief (copy)");
    expect(name.readOnly).toBe(false);
    expect(dialog.querySelector<HTMLTextAreaElement>('[aria-label="Schedule prompt"]')?.value).toBe("Summarise my inbox");
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Schedule token ceiling"]')?.value).toBe("50000");
    expect(dialog.querySelector('[aria-label="Deliver result to"]')?.textContent).toContain("Home");
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Schedule run limit"]')?.value).toBe("30");
    await act(async () => dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    const added = sent(asked, "schedules", "add").at(-1)?.payload;
    expect(added).toMatchObject({
      name: "Brief (copy)",
      prompt: "Summarise my inbox",
      at: "07:00",
      timezone: "UTC",
      allow: ["reports.*"],
      notify: "when-sent",
      maxTokens: 50_000,
      deliverTo: "home",
      maxRunMinutes: 30,
    });
    expect(added).not.toHaveProperty("scheduleId");
    expect(host.textContent).toContain("Brief (copy) created.");
  });

  it("opens the reminder form filled from the reminder, saved as its copy so the owner keeps its label and person", async () => {
    const { client, asked } = owner();
    const host = await mount(page(client));
    await settle();
    await choose(host, "Stretch", "Duplicate");
    await settle();
    const form = host.querySelector<HTMLFormElement>('form[aria-label="New reminder"]')!;
    expect(form.querySelector<HTMLInputElement>('input[name="text"]')?.value).toBe("Stretch");
    expect(form.querySelector<HTMLInputElement>('input[value="repeat"]')?.checked).toBe(true);
    expect([...form.querySelectorAll<HTMLInputElement>('.cadence input[type="time"]')].map((input) => input.value)).toEqual([
      "06:00",
      "15:00",
    ]);
    expect(form.querySelector<HTMLTextAreaElement>('[aria-label="Task prompt"]')?.value).toBe("Suggest a two-minute stretch");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(sent(asked, "reminders", "create").at(-1)?.payload).toMatchObject({
      text: "Stretch",
      when: { kind: "repeat", times: ["06:00", "15:00"], daysOfWeek: [1, 2, 3, 4, 5] },
      timezone: "UTC",
      prompt: "Suggest a two-minute stretch",
      principalId: "operator",
      copyOf: "rem-stretch",
    });
  });
});

describe("a finished schedule", () => {
  const ended = schedule({
    scheduleId: "s-ended",
    name: "Launch week",
    enabled: false,
    nextRunAt: null,
    spec: { at: "07:00", timezone: "UTC", until: "2025-01-31" },
  });

  it("is badged finished, not paused: no Resume to press, and neither the Paused nor the Failing chip counts it", async () => {
    const host = await mount(page(owner({ schedules: [ended] }).client));
    await settle();
    const row = rows(host).find((item) => item.dataset["rowKey"] === "schedule:s-ended")!;
    expect(row.querySelector(".badge")?.textContent).toBe("finished");
    expect(row.textContent).toContain("Finished:");
    const toggle = row.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.disabled).toBe(true);
    const hint = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toContain("move its once or until date later");
    await press(byText(host, "Paused"));
    expect(names(host)).not.toContain("Launch week");
    await press(byText(host, "Failing"));
    expect(names(host)).not.toContain("Launch week");
  });
});

describe("Edit on a reminder", () => {
  it("opens the reminder's own form filled in, and saves over it, sending only what changed", async () => {
    const { client, asked } = owner();
    const host = await mount(page(client));
    await settle();
    await choose(host, "Stretch", "Edit");
    await settle();
    const form = host.querySelector<HTMLFormElement>('form[aria-label="Edit reminder"]')!;
    expect(form.querySelector("h2")?.textContent).toBe("Edit reminder");
    const text = form.querySelector<HTMLInputElement>('input[name="text"]')!;
    expect(text.value).toBe("Stretch");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(text, "Stretch and walk");
      text.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(sent(asked, "reminders", "update").map((item) => item.payload)).toEqual([
      { action: "update", workspaceId: "default", reminderId: "rem-stretch", expectedUpdatedAt: AT, text: "Stretch and walk" },
    ]);
    expect(sent(asked, "reminders", "create")).toHaveLength(0);
    expect(host.textContent).toContain("Stretch and walk saved.");
  });
});

describe("what Schedule reads", () => {
  /** Schedule's own lists: the form's agents are not among them. */
  const listReads = (all: ReturnType<typeof owner>["all"]) =>
    all.filter((item) => item.command !== "agents" && (item.action === "list" || item.action === "agenda")).length;

  it("reads nothing again after Edit, which only reads, and once, not twice, for a write and the feed's word of it", async () => {
    const { client, all } = owner();
    const host = await mount(page(client, false));
    await settle();
    const before = listReads(all);
    await choose(host, "Brief", "Edit");
    await settle();
    expect(listReads(all)).toBe(before);
    await press(byText(document.body, "Cancel"));

    const write = listReads(all);
    await press(byLabel(host, "Pause Brief"));
    await settle();
    const afterWrite = listReads(all);
    expect(afterWrite).toBeGreaterThan(write);
    // The feed then says the schedules moved: that is the write already read.
    await rerender(page(client, false, "default", { revision: 1 }));
    await settle();
    expect(listReads(all)).toBe(afterWrite);
    // A later move is someone else's, and is read.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10_000);
    await rerender(page(client, false, "default", { revision: 2 }));
    vi.useRealTimers();
    await settle();
    expect(listReads(all)).toBeGreaterThan(afterWrite);
  });

  it("does not read the lists while a schedule's own page is shown", async () => {
    const { client, all } = owner();
    const host = await mount(page(client, false, "default", { scheduleId: "s-brief" }));
    await settle();
    expect(host.querySelector(".page-title")?.textContent).toContain("Brief");
    expect(all.filter((item) => item.action === "list" || item.action === "agenda" || item.action === "fires")).toEqual([]);
  });

  it("shows a schedule's page whose delete waits for its Undo as being deleted, with Undo", async () => {
    const { client, asked } = owner();
    const host = await mount(page(client, false));
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await choose(host, "Brief", "Delete");
    await rerender(page(client, false, "default", { scheduleId: "s-brief" }));
    expect(host.textContent).toContain("Brief is being deleted.");
    expect(host.querySelector(".page-title")).toBeNull();
    expect(byText(host, "Run now")).toBeUndefined();
    await press(byLabel(host, "Undo deleting Brief"));
    vi.useRealTimers();
    await settle();
    expect(sent(asked, "schedules", "remove")).toHaveLength(0);
    expect(host.querySelector(".page-title")?.textContent).toContain("Brief");
  });
});

describe("the heartbeat, read once for the rail and its row", () => {
  it("is read once for both, on one beat, and not while the page is hidden", async () => {
    const { client, asked } = owner();
    const gets = () => sent(asked, "heartbeat", "get").length;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const host = await mount(
      <InWorkspace client={client} workspaceId="default">
        <HeartbeatPill onOpen={() => undefined} />
        <Schedule
          summary={undefined}
          revision={0}
          heartbeat
          onOpenHeartbeat={() => undefined}
          onOpenRoutine={() => undefined}
          onFollow={async () => undefined}
        />
      </InWorkspace>,
    );
    await settle();
    expect(host.querySelector(".heartbeat-pill")?.textContent).toMatch(/^Heartbeat on/);
    expect(names(host)).toContain("Heartbeat");
    expect(gets()).toBe(1);
    await act(async () => vi.advanceTimersByTime(HEARTBEAT_POLL_MS));
    await settle();
    expect(gets()).toBe(2);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try {
      await act(async () => vi.advanceTimersByTime(HEARTBEAT_POLL_MS * 3));
      await settle();
      expect(gets()).toBe(2);
      hidden.mockReturnValue(false);
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      await settle();
      expect(gets()).toBe(3);
    } finally {
      hidden.mockRestore();
    }
  });
});
