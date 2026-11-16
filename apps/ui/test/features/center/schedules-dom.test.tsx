// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ScheduleRecord } from "@tavi/contracts";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { ScheduleForm } from "../../../src/features/center/ScheduleForm.js";
import { Schedule } from "../../../src/features/center/Schedule.js";
import { UNDO_DELETE_MS } from "../../../src/features/center/UndoDelete.js";
import { InWorkspace } from "../../support/workspace.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  // A delete waiting outlives Schedule: leaving the page makes it, so the next test starts with none.
  window.dispatchEvent(new Event("pagehide"));
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});
async function mount(element: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  return host;
}
async function fill(page: HTMLElement, label: string, value: string) {
  const input = page.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(page: HTMLElement, text: string) {
  await act(async () => [...page.querySelectorAll("button")].find((button) => button.textContent === text)!.click());
}
/** Opens the More menu of the row `name`d and chooses `item`. */
async function menu(page: HTMLElement, name: string, item: string) {
  await act(async () => page.querySelector<HTMLButtonElement>(`[aria-label="More actions for ${name}"]`)!.click());
  await act(async () =>
    [...page.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent === item)!.click(),
  );
}
/** Sets a control found some other way than by its `aria-label`. */
async function set(input: HTMLInputElement | null | undefined, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const timeInputs = (page: HTMLElement) => [...page.querySelectorAll<HTMLInputElement>('.cadence input[type="time"]')];
/** The cadence field's next runs, asked of the owner: answered here, and kept out of what a test reads as sent. */
const previewing = (payload: unknown) => (payload as Record<string, unknown>)["action"] === "preview";
const PREVIEW = { ok: true, result: { timezone: "UTC", text: "", runs: [] } } as const;
/** The chats the operator added as delivery targets: one enabled, one disabled (never offered). */
const TARGETS = [
  { targetId: "target-ana", label: "Telegram · Ana", connectionId: "telegram", chatId: "chat-ana", enabled: true, authorized: true },
  { targetId: "target-old", label: "Telegram · Old", connectionId: "telegram", chatId: "chat-old", enabled: false, authorized: true },
];
/** The tools a schedule may list, as the owner offers them. */
const TOOLS = { tools: ["reports.write", "web_search"], families: ["reports.*"] };
/** What the form reads on its own (the cadence preview, alert targets, tool suggestions): answered here, kept out of what a test reads as sent. */
function background(command: string, payload: unknown) {
  const action = (payload as Record<string, unknown>)["action"];
  if (previewing(payload)) return PREVIEW;
  if (command === "routines" && action === "targets") return { ok: true, result: { targets: TARGETS } } as const;
  if (command === "schedules" && action === "tools") return { ok: true, result: TOOLS } as const;
  return undefined;
}
/** Picks `label` in the custom select named `name`. */
/**
 * Radix Select closes its list on a timer after a pick: wait until the list is
 * gone, not a fixed beat a loaded machine can outrun.
 */
async function closed() {
  let tries = 0;
  do {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  } while (++tries < 100 && document.querySelector('[role="listbox"]') !== null);
  expect(document.querySelector('[role="listbox"]')).toBeNull();
}
async function pick(page: HTMLElement, name: string, label: string) {
  HTMLElement.prototype.scrollIntoView = () => {};
  const select = page.querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
  await act(async () => select.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...page.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes(label))!;
  await act(async () => {
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await closed();
}
const record: ScheduleRecord = {
  scheduleId: "sched",
  workspaceId: "default",
  principalId: "operator",
  name: "Brief",
  prompt: "Write a brief",
  spec: { at: "07:00", timezone: "UTC", daysOfWeek: [1] },
  missedRunPolicy: "skip",
  autoApproveTools: ["reports.*"],
  enabled: true,
  nextRunAt: "2026-01-01T07:00:00Z",
  lastRunAt: null,
  lastRunTaskId: null,
  lastOutcome: "failed",
  consecutiveFailures: 2,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** A client that answers the form's background reads and records every other payload, answering `record`. */
function recordingClient(): { readonly sent: Record<string, unknown>[]; readonly client: SettingsClient } {
  const sent: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      const aside = background(command, payload);
      if (aside) return aside;
      sent.push(payload as Record<string, unknown>);
      return { ok: true, result: command === "agents" ? { agents: [], truncated: false } : record };
    },
  };
  return { sent, client };
}

it("loads disabled agents as unavailable and validates alert pairs and tool chips", async () => {
  const sent: Record<string, unknown>[] = [];
  let saved = 0;
  const client: SettingsClient = {
    request: async (command, payload) => {
      const aside = background(command, payload);
      if (aside) return aside;
      sent.push(payload as Record<string, unknown>);
      return {
        ok: true,
        result: command === "agents" ? { agents: [{ agentId: "disabled", name: "Writer", enabled: false }], truncated: false } : record,
      };
    },
  };
  const page = await mount(
    <ScheduleForm client={client} workspaceId="default" initial={undefined} onClose={() => {}} onSaved={() => saved++} />,
  );
  expect(sent[0]).toMatchObject({ action: "list", workspaceId: "default" });
  HTMLElement.prototype.scrollIntoView = () => {};
  const agent = page.querySelector<HTMLElement>('[aria-label="Schedule agent"]')!;
  await act(async () => agent.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(
    [...page.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes("Writer"))?.getAttribute("aria-disabled"),
  ).toBe("true");
  expect(page.textContent).toContain("Writer — disabled");
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await fill(page, "Schedule name", "Brief");
  await fill(page, "Schedule prompt", "Write a brief");
  await fill(page, "Allowed tool", "*");
  await click(page, "Add tool");
  expect(page.textContent).toContain("blanket * is refused");
  await fill(page, "Allowed tool", "reports.*");
  await click(page, "Add tool");
  expect(page.querySelector('[aria-label="Remove tool reports.*"]')).not.toBeNull();
  await pick(page, "Alert target", "Telegram · Ana");
  await click(page, "Save schedule");
  expect(saved).toBe(1);
  expect(sent.at(-1)).toMatchObject({
    action: "add",
    name: "Brief",
    allow: ["reports.*"],
    alertConnection: "telegram",
    alertDestination: "chat-ana",
    days: null,
  });
  // A new schedule posts nowhere and keeps the default run limit unless asked.
  expect(sent.at(-1)).not.toHaveProperty("deliverTo");
  expect(sent.at(-1)).not.toHaveProperty("maxRunMinutes");
});
it("sends edited fields and explicit clears, retaining the owner refusal in the form", async () => {
  const sent: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      const aside = background(command, payload);
      if (aside) return aside;
      sent.push(payload as Record<string, unknown>);
      return command === "agents"
        ? { ok: true, result: { agents: [], truncated: false } }
        : { ok: false, error: { code: "CONFLICT", message: "fire in flight; edit it once the fire ends" } };
    },
  };
  const page = await mount(
    <ScheduleForm
      client={client}
      workspaceId="default"
      initial={record}
      onClose={() => {}}
      onSaved={() => {
        throw new Error("must not close");
      }}
    />,
  );
  expect(page.querySelector<HTMLInputElement>('[aria-label="Schedule name"]')?.readOnly).toBe(true);
  await fill(page, "Schedule prompt", "changed prompt");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toEqual({ action: "update", workspaceId: "default", scheduleId: "sched", prompt: "changed prompt" });
  // Monday alone cannot be unticked: a cadence runs on some day.
  const monday = page.querySelector<HTMLButtonElement>('button:has(abbr[title="Monday"])')!;
  expect(monday.getAttribute("aria-pressed")).toBe("true");
  expect(monday.getAttribute("aria-disabled")).toBe("true");
  await act(async () => monday.click());
  expect(monday.getAttribute("aria-pressed")).toBe("true");
  await set(timeInputs(page)[0], "08:00");
  await click(page, "Every day");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toEqual({
    action: "update",
    workspaceId: "default",
    scheduleId: "sched",
    prompt: "changed prompt",
    at: "08:00",
    timezone: "UTC",
    days: null,
  });
  expect(page.textContent).toContain("fire in flight");
});
it("edits a richer cadence in place, sending none of it when only the prompt changed", async () => {
  const { sent, client } = recordingClient();
  const remount = async (spec: ScheduleRecord["spec"]) => {
    act(() => root?.unmount());
    host?.remove();
    return mount(
      <ScheduleForm client={client} workspaceId="default" initial={{ ...record, spec }} onClose={() => {}} onSaved={() => {}} />,
    );
  };
  const checked = (page: HTMLElement) =>
    [...page.querySelectorAll<HTMLInputElement>('.cadence input[type="radio"]:checked')].map(
      (input) => input.closest("label")?.textContent,
    );
  const richer: readonly ScheduleRecord["spec"][] = [
    { times: ["07:00", "19:00"], timezone: "UTC", monthly: { dayOfMonth: 1 } },
    { everyHours: 2, between: { from: "08:00", to: "18:00" }, timezone: "UTC" },
    { everyHours: 3, timezone: "UTC" },
    { at: "09:00", timezone: "UTC", until: "2026-12-31" },
  ];
  for (const spec of richer) {
    const page = await remount(spec);
    expect(page.textContent).not.toContain("replaces it");
    await fill(page, "Schedule prompt", "changed prompt");
    await click(page, "Save schedule");
    expect(sent.at(-1)).toEqual({ action: "update", workspaceId: "default", scheduleId: "sched", prompt: "changed prompt" });
  }
  // Several times on a monthly day: shown as they are, and changed to weekdays whole.
  let page = await remount(richer[0]!);
  expect(checked(page)).toEqual(["Monthly", "At set times"]);
  expect(timeInputs(page).map((input) => input.value)).toEqual(["07:00", "19:00"]);
  await act(async () => page.querySelector<HTMLInputElement>('.cadence input[type="radio"][value="weekly"]')!.click());
  await click(page, "Weekdays");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toEqual({
    action: "update",
    workspaceId: "default",
    scheduleId: "sched",
    times: ["07:00", "19:00"],
    timezone: "UTC",
    days: [1, 2, 3, 4, 5],
  });
  // Every few hours in a window: its end moved, the window sent with its step.
  page = await remount(richer[1]!);
  expect(checked(page)).toEqual(["On days of the week", "Every few hours"]);
  await set(page.querySelector<HTMLInputElement>('[aria-label="Window end"]'), "20:00");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toEqual({
    action: "update",
    workspaceId: "default",
    scheduleId: "sched",
    everyHours: 2,
    between: { from: "08:00", to: "20:00" },
    timezone: "UTC",
    days: null,
  });
  // An end date cleared is sent as cleared.
  page = await remount(richer[3]!);
  await set(page.querySelector<HTMLInputElement>('[aria-label="Until"]'), "");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toEqual({
    action: "update",
    workspaceId: "default",
    scheduleId: "sched",
    at: "09:00",
    timezone: "UTC",
    days: null,
    untilDate: null,
  });
  // A window that ends before it starts is said in the field and refused by the form.
  page = await remount(richer[1]!);
  const before = sent.length;
  await set(page.querySelector<HTMLInputElement>('[aria-label="Window end"]'), "07:00");
  expect(page.querySelector(".cadence-problems")?.textContent).toBe("The window must end after it starts, within one day.");
  expect(page.querySelector('[aria-label="Window end"]')?.getAttribute("aria-invalid")).toBe("true");
  await click(page, "Save schedule");
  expect(page.querySelector('[role="alert"]')?.textContent).toContain("When it runs: The window must end after it starts");
  expect(sent.length).toBe(before);
});
it("creates a schedule several times a day on chosen days, once, or yearly, in the zone chosen from the list", async () => {
  const { sent, client } = recordingClient();
  const page = await mount(
    <ScheduleForm
      client={client}
      workspaceId="default"
      initial={undefined}
      timeZone="Europe/Sofia"
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
  const zone = page.querySelector<HTMLInputElement>('[aria-label="Time zone"]')!;
  expect(zone.value).toBe("Europe/Sofia");
  expect(page.textContent).toContain("(workspace zone)");
  await fill(page, "Schedule name", "Brief");
  await fill(page, "Schedule prompt", "Write a brief");
  await click(page, "Add a time");
  await set(timeInputs(page)[1], "19:30");
  await click(page, "Weekends");
  await set(zone, "Asia/Tokyo");
  expect(page.textContent).toContain("Use the workspace zone (Europe/Sofia)");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toMatchObject({
    action: "add",
    name: "Brief",
    times: ["07:00", "19:30"],
    timezone: "Asia/Tokyo",
    days: [0, 6],
  });
  expect(sent.at(-1)).not.toHaveProperty("at");
  await click(page, "Use the workspace zone (Europe/Sofia)");
  await act(async () => page.querySelector<HTMLInputElement>('.cadence input[type="radio"][value="once"]')!.click());
  await set(page.querySelector<HTMLInputElement>('.cadence input[type="date"][required]'), "2027-03-04");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ times: ["07:00", "19:30"], timezone: "Europe/Sofia", once: "2027-03-04" });
  expect(sent.at(-1)).not.toHaveProperty("days");
});
/** Schedule over an owner whose only recurring work is plain schedules: `rows` for `schedules list`, `answer` for any other action. */
function plainOwner(
  rows: readonly ScheduleRecord[],
  answer: (payload: Record<string, unknown>) => { ok: boolean; result?: unknown; error?: unknown },
) {
  const sent: Record<string, unknown>[] = [];
  const client: SettingsClient = {
    request: async (command, payload) => {
      const p = payload as Record<string, unknown>;
      if (command === "routines") return { ok: true, result: { routines: [] } } as never;
      if (p["action"] === "agenda") return { ok: true, result: { timezone: "UTC", items: [], truncated: false, skipped: [] } } as never;
      if (p["action"] === "list") return { ok: true, result: { schedules: rows, truncated: false } } as never;
      sent.push(p);
      return answer(p) as never;
    },
  };
  return { client, sent };
}
const inSchedule = (client: SettingsClient, onFollow: (taskId: string) => Promise<void>) => (
  <InWorkspace client={client} workspaceId="default">
    <Schedule summary={undefined} revision={0} onOpenRoutine={() => {}} onFollow={onFollow} />
  </InWorkspace>
);

it("lists plain schedules in Recurring with their fire history, follows run-now tasks, and surfaces a refused delete", async () => {
  const followed: string[] = [];
  const { client, sent } = plainOwner([record], (p) =>
    p["action"] === "remove"
      ? { ok: false, error: { code: "CONFLICT", message: "fire in flight" } }
      : { ok: true, result: { taskId: "fired-task" } },
  );
  const page = await mount(
    inSchedule(client, async (id) => {
      followed.push(id);
    }),
  );
  expect(page.textContent).toContain("Failed. 2 failures in a row.");
  expect(page.querySelector(".schedule-recurring .badge")?.textContent).toBe("failed");
  expect(page.textContent).toContain("Mon 07:00 · UTC");
  await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="Run now: Brief"]')!.click());
  expect(followed).toEqual(["fired-task"]);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await menu(page, "Brief", "Delete");
    expect(page.querySelector(".schedule-recurring")).toBeNull();
    expect(sent.some((item) => item["action"] === "remove")).toBe(false);
    // The wait runs out though Undo has the focus it was given.
    await act(async () => vi.advanceTimersByTime(UNDO_DELETE_MS));
  } finally {
    vi.useRealTimers();
  }
  await act(async () => undefined);
  expect(sent.filter((item) => item["action"] === "remove")).toHaveLength(1);
  // Refused: the row comes back, and says why.
  expect(page.textContent).toContain("Brief was not deleted: fire in flight");
  expect(page.querySelector(".schedule-recurring")?.textContent).toContain("Brief");
});

it("leaves routine-owned schedules to their routine, and toggles a plain one with its switch", async () => {
  const { client, sent } = plainOwner([record, { ...record, scheduleId: "owned", name: "Owned by a routine", routineId: "r1" }], () => ({
    ok: true,
    result: {},
  }));
  const page = await mount(inSchedule(client, async () => {}));
  expect(page.textContent).not.toContain("Owned by a routine");
  const toggle = page.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Pause Brief"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle.click());
  expect(sent).toContainEqual({ action: "disable", scheduleId: "sched", workspaceId: "default" });
  expect(page.textContent).toContain("Brief paused.");
});

it("shows task-opening errors for both last-task and run-now navigation", async () => {
  const { client } = plainOwner([{ ...record, lastRunTaskId: "previous" }], () => ({ ok: true, result: { taskId: "new" } }));
  const page = await mount(
    inSchedule(client, async () => {
      throw new Error("owner unavailable");
    }),
  );
  // The error's message, never its "Error: " prefix.
  await menu(page, "Brief", "Open last task");
  expect(page.textContent).toContain("Could not open the task: owner unavailable. Retry opening it from Chats.");
  await act(async () => page.querySelector<HTMLButtonElement>('[aria-label="Run now: Brief"]')!.click());
  expect(page.textContent).toContain("Brief started, but its task could not be opened: owner unavailable. Retry opening it from Chats.");
  // Task ids are not words: neither note names one.
  expect(page.textContent).not.toContain("previous");
  expect(page.textContent).not.toMatch(/\bnew\b/);
});
it("reads an agents answer without a list as no agents, rather than failing to open", async () => {
  const client: SettingsClient = { request: async () => ({ ok: true, result: {} }) };
  const page = await mount(
    <ScheduleForm client={client} workspaceId="default" initial={undefined} onClose={() => {}} onSaved={() => {}} />,
  );
  await act(async () => undefined);
  expect(page.querySelector('[aria-label="Schedule name"]')).not.toBeNull();
  expect(page.querySelector('[aria-label="Schedule agent"]')?.textContent).toContain("Base instructions");
  expect(page.textContent).not.toContain("Agents unavailable");
});

it("lets a fire ask the alert destination, with a default, only once there is one", async () => {
  const { sent, client } = recordingClient();
  const page = await mount(<ScheduleForm client={client} workspaceId="default" initial={record} onClose={() => {}} onSaved={() => {}} />);
  const select = page.querySelector<HTMLButtonElement>('[aria-label="Schedule questions"]')!;
  // No alert target: nowhere to ask.
  expect(select.disabled).toBe(true);
  expect(page.textContent).toContain("Set an alert target to let a fire ask you something.");
  await pick(page, "Alert target", "Telegram · Ana");
  expect(select.disabled).toBe(false);
  HTMLElement.prototype.scrollIntoView = () => {};
  await act(async () => select.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...page.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes("Ask the alert destination"),
  )!;
  await act(async () => {
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await closed();
  expect(page.textContent).toContain("always with the option it takes if you don't answer before the next fire");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toMatchObject({
    action: "update",
    scheduleId: "sched",
    alertConnection: "telegram",
    alertDestination: "chat-ana",
    humanCheckpoints: "ask-with-default",
  });
});

it("chooses when a schedule tells you, sending the choice only when it changed", async () => {
  const { sent, client } = recordingClient();
  const page = await mount(<ScheduleForm client={client} workspaceId="default" initial={record} onClose={() => {}} onSaved={() => {}} />);
  expect(page.textContent).toContain("Every run that goes well delivers its result. Failures are always told.");
  await fill(page, "Schedule prompt", "Message me only if there are new matches");
  await click(page, "Save schedule");
  expect(sent.at(-1)).not.toHaveProperty("notify");
  const select = page.querySelector<HTMLButtonElement>('[aria-label="Schedule notify"]')!;
  HTMLElement.prototype.scrollIntoView = () => {};
  await act(async () => select.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...page.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes("Only when there is something to tell"),
  )!;
  await act(async () => {
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await closed();
  expect(page.textContent).toContain("A run with nothing to send is a quiet success");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ action: "update", scheduleId: "sched", notify: "when-sent" });
});

it("sets, keeps and removes a token ceiling, sending it only when it changed", async () => {
  const { sent, client } = recordingClient();
  const page = await mount(<ScheduleForm client={client} workspaceId="default" initial={record} onClose={() => {}} onSaved={() => {}} />);
  expect(page.textContent).toContain("No ceiling: a run uses what it needs, within its time limit.");
  await click(page, "Save schedule");
  expect(sent.at(-1)).not.toHaveProperty("maxTokens");
  await fill(page, "Schedule token ceiling", "12");
  await click(page, "Save schedule");
  expect(page.textContent).toContain("Enter a token ceiling from 1,000 to 100,000,000");
  // A ceiling below one model call's worth is warned of: a run's first call alone passes it.
  await fill(page, "Schedule token ceiling", "2,000");
  expect(page.querySelector(".schedule-ceiling-low")?.textContent).toBe(
    "Below one model call: a run can go past it by one call (a run's first call alone takes about 25,000 tokens).",
  );
  await fill(page, "Schedule token ceiling", "250,000");
  expect(page.querySelector(".schedule-ceiling-low")).toBeNull();
  // The ceiling is checked between model calls: the note says a run can go past it by one.
  expect(page.textContent).toContain("a run can go past it by one call.");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ action: "update", scheduleId: "sched", maxTokens: 250_000 });
  act(() => root?.unmount());
  const capped = { ...record, maxTokens: 250_000 };
  const edited = await mount(<ScheduleForm client={client} workspaceId="default" initial={capped} onClose={() => {}} onSaved={() => {}} />);
  expect(edited.querySelector<HTMLInputElement>('[aria-label="Schedule token ceiling"]')?.value).toBe("250000");
  await click(edited, "Save schedule");
  expect(sent.at(-1)).not.toHaveProperty("maxTokens");
  await fill(edited, "Schedule token ceiling", "");
  await click(edited, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ action: "update", maxTokens: null });
});

it("sets, keeps and removes a pre-check, sending it only when it changed, and refuses one it cannot check", async () => {
  const { sent, client } = recordingClient();
  const page = await mount(<ScheduleForm client={client} workspaceId="default" initial={record} onClose={() => {}} onSaved={() => {}} />);
  expect(page.textContent).toContain("Every run goes ahead.");
  await click(page, "Save schedule");
  expect(sent.at(-1)).not.toHaveProperty("precheck");
  await pick(page, "Schedule pre-check", "A page changed");
  expect(page.textContent).toContain("when nothing is new, nothing runs and no model is called");
  await fill(page, "Schedule pre-check target", "http://example.com/");
  await click(page, "Save schedule");
  expect(page.textContent).toContain("Only run when: page-changed needs an https address");
  await fill(page, "Schedule pre-check target", "https://Example.com/news");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ action: "update", scheduleId: "sched", precheck: "page-changed:https://example.com/news" });
  act(() => root?.unmount());
  const watched: ScheduleRecord = { ...record, precheck: { kind: "page-changed", target: "https://example.com/news" } };
  const edited = await mount(
    <ScheduleForm client={client} workspaceId="default" initial={watched} onClose={() => {}} onSaved={() => {}} />,
  );
  expect(edited.querySelector<HTMLInputElement>('[aria-label="Schedule pre-check target"]')?.value).toBe("https://example.com/news");
  await click(edited, "Save schedule");
  expect(sent.at(-1)).not.toHaveProperty("precheck");
  await pick(edited, "Schedule pre-check", "Always: no pre-check");
  await click(edited, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ action: "update", precheck: null });
});

it("makes a schedule with a pre-check a watcher that checks every few hours, and stops it, sending it only when it changed", async () => {
  const sent: Record<string, unknown>[] = [];
  const client = writes(sent);
  const page = await mount(<ScheduleForm client={client} workspaceId="default" initial={record} onClose={() => {}} onSaved={() => {}} />);
  // No pre-check, nothing to watch.
  expect(page.querySelector('[aria-label="Schedule watch mode"]')).toBeNull();
  await pick(page, "Schedule pre-check", "A file changed");
  await fill(page, "Schedule pre-check target", "/notes/today.md");
  await pick(page, "Schedule watch mode", "Yes: check every 2 hours, run only on a change");
  expect(page.textContent).toContain(
    "the file is also checked about 30 seconds after it changes, at most once a minute and 12 times an hour",
  );
  await click(page, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ action: "update", precheck: "file-changed:/notes/today.md", watch: true, everyHours: 2 });
  expect(sent.at(-1)).not.toHaveProperty("at");
  act(() => root?.unmount());
  const watcher: ScheduleRecord = {
    ...record,
    spec: { everyHours: 2, timezone: record.spec.timezone },
    precheck: { kind: "file-changed", target: "/notes/today.md" },
    watch: true,
  };
  const edited = await mount(
    <ScheduleForm client={client} workspaceId="default" initial={watcher} onClose={() => {}} onSaved={() => {}} />,
  );
  expect(edited.querySelector('[aria-label="Schedule watch mode"]')?.textContent).toContain("Yes: check every 2 hours");
  await click(edited, "Save schedule");
  expect(sent.at(-1)).not.toHaveProperty("watch");
  await pick(edited, "Schedule watch mode", "No: it runs at its times, when something changed");
  await click(edited, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ action: "update", watch: false });
  expect(sent.at(-1)).not.toHaveProperty("precheck");
});

/** A client whose every write is kept in `sent`; the form's own reads are answered aside. */
function writes(sent: Record<string, unknown>[]): SettingsClient {
  return {
    request: async (command, payload) => {
      const aside = background(command, payload);
      if (aside) return aside;
      sent.push(payload as Record<string, unknown>);
      return { ok: true, result: command === "agents" ? { agents: [], truncated: false } : record };
    },
  };
}

it("delivers a result into Home and limits a run's minutes, sending each only when it changed", async () => {
  const sent: Record<string, unknown>[] = [];
  let page = await mount(
    <ScheduleForm client={writes(sent)} workspaceId="default" initial={undefined} onClose={() => {}} onSaved={() => {}} />,
  );
  expect(page.textContent).toContain("Only what the run sends itself goes out");
  await fill(page, "Schedule name", "Brief");
  await fill(page, "Schedule prompt", "Write a brief");
  await pick(page, "Deliver result to", "Home");
  expect(page.textContent).toContain("Each run's result is posted into Home as a notice, starting your Home if you have none yet.");
  await fill(page, "Schedule run limit", "0");
  await click(page, "Save schedule");
  expect(page.textContent).toContain("Enter a run limit from 1 to 1,440 minutes, or leave it empty for 30.");
  expect(sent.some((payload) => payload["action"] === "add")).toBe(false);
  await fill(page, "Schedule run limit", "45");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ action: "add", deliverTo: "home", maxRunMinutes: 45 });

  // Edited, they show as stored and are sent only once changed; an emptied limit is the default again.
  act(() => root?.unmount());
  host?.remove();
  page = await mount(
    <ScheduleForm
      client={writes(sent)}
      workspaceId="default"
      initial={{ ...record, deliverTo: "home", maxRunMinutes: 45 }}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
  expect(page.querySelector('[aria-label="Deliver result to"]')?.textContent).toContain("Home");
  expect(page.querySelector<HTMLInputElement>('[aria-label="Schedule run limit"]')?.value).toBe("45");
  await fill(page, "Schedule prompt", "changed prompt");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toEqual({ action: "update", workspaceId: "default", scheduleId: "sched", prompt: "changed prompt" });
  await pick(page, "Deliver result to", "Nowhere");
  await fill(page, "Schedule run limit", "");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ action: "update", deliverTo: "none", maxRunMinutes: 30 });
});

it("picks alert targets from the delivery targets, keeping one set elsewhere through an edit", async () => {
  const sent: Record<string, unknown>[] = [];
  const page = await mount(
    <ScheduleForm
      client={writes(sent)}
      workspaceId="default"
      initial={{ ...record, alert: { connectionId: "slack", destination: "C123" } }}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
  const target = page.querySelector<HTMLElement>('[aria-label="Alert target"]')!;
  expect(target.textContent).toContain("C123 on slack (not among your delivery targets)");
  expect(page.querySelector('[aria-label="Alert connection"]')).toBeNull();
  // A prompt edit leaves the alert as it is: nothing about it is sent.
  await fill(page, "Schedule prompt", "changed prompt");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toEqual({ action: "update", workspaceId: "default", scheduleId: "sched", prompt: "changed prompt" });
  HTMLElement.prototype.scrollIntoView = () => {};
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const offered = [...page.querySelectorAll('[role="option"]')].map((option) => option.textContent);
  expect(offered).toEqual(["No alerts", "Telegram · Ana", "C123 on slack (not among your delivery targets)"]);
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await pick(page, "Alert target", "Telegram · Ana");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ alertConnection: "telegram", alertDestination: "chat-ana" });
  await pick(page, "Alert target", "No alerts");
  await click(page, "Save schedule");
  expect(sent.at(-1)).toMatchObject({ alertConnection: null, alertDestination: null });
  // With no alert target the owner posts failures into Home, so the form says so rather than that nobody is told.
  expect(page.textContent).toContain("No alert target: failed and missed runs are told in your Home instead (nowhere, with Home off).");
  expect(page.textContent).not.toContain("cannot notify you");
});

it("adds a tool on Enter without saving, suggesting the tools a schedule may list", async () => {
  const sent: Record<string, unknown>[] = [];
  const page = await mount(
    <ScheduleForm client={writes(sent)} workspaceId="default" initial={undefined} onClose={() => {}} onSaved={() => {}} />,
  );
  const input = page.querySelector<HTMLInputElement>('[aria-label="Allowed tool"]')!;
  const suggested = () =>
    [...document.getElementById(input.getAttribute("list")!)!.querySelectorAll("option")].map((option) => option.value);
  expect(suggested()).toEqual(["reports.write", "web_search", "reports.*"]);
  const enter = async () => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(event));
    return event;
  };
  await fill(page, "Allowed tool", "web_search");
  expect((await enter()).defaultPrevented).toBe(true);
  expect(page.querySelector('[aria-label="Remove tool web_search"]')).not.toBeNull();
  expect(input.value).toBe("");
  expect(suggested()).toEqual(["reports.write", "reports.*"]);
  // Enter on an empty field neither adds nor saves.
  expect((await enter()).defaultPrevented).toBe(true);
  expect(page.querySelector('[role="alert"]')).toBeNull();
  await fill(page, "Allowed tool", "*");
  await enter();
  expect(page.textContent).toContain("blanket * is refused");
  expect(sent.some((payload) => payload["action"] === "add")).toBe(false);
});

it("says what scheduled work spent this month under Recurring, and when it nears its budget", async () => {
  const usage = (tokens: number, budget?: number) => ({
    month: "2026-10",
    timezone: "UTC",
    since: "2026-10-01T00:00:00.000Z",
    until: "2026-11-01T00:00:00.000Z",
    tokens,
    usd: budget === undefined ? 0.42 : null,
    ...(budget === undefined ? {} : { budget, percent: Math.floor((tokens * 100) / budget) }),
  });
  const owner = (scheduledWork: ReturnType<typeof usage> | undefined): SettingsClient => ({
    request: async (command, payload) => {
      const p = payload as Record<string, unknown>;
      if (command === "routines") return { ok: true, result: { routines: [] } } as never;
      if (p["action"] === "agenda") return { ok: true, result: { timezone: "UTC", items: [], truncated: false, skipped: [] } } as never;
      return {
        ok: true,
        result: {
          schedules: [record],
          truncated: false,
          ...(scheduledWork === undefined || p["withUsage"] !== true ? {} : { scheduledWork }),
        },
      } as never;
    },
  });
  const page = await mount(inSchedule(owner(usage(12_345)), async () => {}));
  expect(page.querySelector(".schedule-month")?.textContent).toBe("Scheduled work in October 2026: 12,345 tokens (about $0.42).");
  act(() => root?.unmount());
  const near = await mount(inSchedule(owner(usage(850_000, 1_000_000)), async () => {}));
  expect(near.querySelector(".schedule-month")?.textContent).toBe(
    "Near budget Scheduled work in October 2026: 850,000 tokens of a 1,000,000-token monthly budget (85%).",
  );
  act(() => root?.unmount());
  // An owner from before the monthly total says nothing of it.
  const older = await mount(inSchedule(owner(undefined), async () => {}));
  expect(older.querySelector(".schedule-month")).toBeNull();
});
