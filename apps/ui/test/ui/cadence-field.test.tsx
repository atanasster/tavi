// @vitest-environment jsdom
import { act, useState } from "react";
import { describe, expect, it } from "vitest";
import type { ScheduleSpec } from "@tavi/contracts";

import type { SettingsClient } from "../../src/lib/ipc.js";
import { cadencePayload, cadenceProblems, sameCadence, toggleDay } from "../../src/ui/cadence.js";
import { PREVIEW_DELAY_MS } from "../../src/ui/cadence-preview.js";
import { CadenceField, type CadenceAllows } from "../../src/ui/CadenceField.js";
import { DayChips } from "../../src/ui/DayChips.js";
import { button, click, mount } from "../support/dom.js";
import { pick } from "../pick.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function type(input: Element | null | undefined, value: string): Promise<void> {
  if (!(input instanceof HTMLInputElement)) throw new Error("no input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const waitPreview = () => act(async () => new Promise<void>((done) => setTimeout(done, PREVIEW_DELAY_MS + 50)));

/** The field over its own state, as a form holds it; `seen` is each value it was given. */
function harness(
  initial: ScheduleSpec,
  props: {
    readonly allows?: CadenceAllows;
    readonly client?: SettingsClient;
    readonly workspaceZone?: string;
    readonly maxTimes?: number;
  } = {},
) {
  const seen: ScheduleSpec[] = [];
  function Form() {
    const [spec, setSpec] = useState(initial);
    return (
      <CadenceField
        value={spec}
        onChange={(next) => {
          seen.push(next);
          setSpec(next);
        }}
        workspaceId="default"
        {...props}
      />
    );
  }
  return { seen, last: () => seen.at(-1), element: <Form /> };
}
const pressed = (page: HTMLElement, group: string) =>
  [...page.querySelectorAll(`[aria-label="${group}"] button`)]
    .filter((item) => item.getAttribute("aria-pressed") === "true")
    .map((item) => item.textContent);
const radio = (page: HTMLElement, value: string) => page.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`);
const times = (page: HTMLElement) => [...page.querySelectorAll<HTMLInputElement>('input[type="time"]')];

describe("the cadence's pure parts", () => {
  it("keeps the last day ticked, and sorts what it ticks", () => {
    expect(toggleDay([1, 3], 2)).toEqual([1, 2, 3]);
    expect(toggleDay([1, 3], 3)).toEqual([1]);
    expect(toggleDay([3], 3)).toEqual([3]);
  });

  it("says a cadence as add takes it, sorted, so two forms of one cadence compare equal", () => {
    expect(cadencePayload({ times: ["19:00", "07:00"], timezone: "UTC", daysOfWeek: [5, 1] })).toEqual({
      times: ["07:00", "19:00"],
      timezone: "UTC",
      days: [1, 5],
    });
    expect(cadencePayload({ at: "09:00", timezone: "UTC" })).toEqual({ at: "09:00", timezone: "UTC", days: null });
    expect(cadencePayload({ everyHours: 2, between: { from: "08:00", to: "18:00" }, timezone: "UTC", until: "2026-12-31" })).toEqual({
      everyHours: 2,
      between: { from: "08:00", to: "18:00" },
      timezone: "UTC",
      days: null,
      untilDate: "2026-12-31",
    });
    expect(cadencePayload({ at: "09:00", timezone: "UTC", once: "2026-12-01" })).toEqual({
      at: "09:00",
      timezone: "UTC",
      once: "2026-12-01",
    });
    expect(cadencePayload({ at: "09:00", timezone: "UTC", yearly: { month: 2, day: 29 } })).toMatchObject({
      yearly: { month: 2, day: 29 },
    });
    expect(cadencePayload({ at: "09:00", timezone: "UTC", monthly: { nth: -1, weekday: 5 } })).toMatchObject({
      monthly: { nth: -1, weekday: 5 },
    });
    expect(sameCadence({ times: ["19:00", "07:00"], timezone: "UTC" }, { times: ["07:00", "19:00"], timezone: "UTC" })).toBe(true);
    expect(sameCadence({ at: "07:00", timezone: "UTC" }, { at: "07:00", timezone: "Europe/Sofia" })).toBe(false);
  });

  it("finds what the contracts refuse, and what a form leaves half-typed, in the form's words", () => {
    expect(cadenceProblems({ at: "09:00", timezone: "Europe/Sofia" })).toEqual([]);
    expect(cadenceProblems({ times: ["09:00", "09:00"], timezone: "UTC" })).toEqual([
      { path: "times", message: "Each time may be given only once." },
    ]);
    expect(cadenceProblems({ everyHours: 2, between: { from: "18:00", to: "08:00" }, timezone: "UTC" })).toEqual([
      { path: "between", message: "The window must end after it starts, within one day." },
    ]);
    expect(cadenceProblems({ at: "09:00", timezone: "UTC", yearly: { month: 4, day: 31 } })).toEqual([
      { path: "yearly", message: "That month has no such day." },
    ]);
    expect(cadenceProblems({ at: "", timezone: "Mars/Olympus" }).map((problem) => problem.path)).toEqual(["times", "timezone"]);
    expect(cadenceProblems({ times: [], timezone: "UTC" })).toEqual([{ path: "at", message: "Add at least one time." }]);
  });
});

describe("DayChips", () => {
  it("lists the week Monday first, each chip named by what it shows, with the presets pressed when they match", async () => {
    let days: readonly number[] = [1, 2, 3, 4, 5];
    const toggled: number[] = [];
    const presets: (readonly number[])[] = [];
    const page = await mount(
      <DayChips
        days={days}
        onToggle={(day) => {
          toggled.push(day);
          days = toggleDay(days, day);
        }}
        onPreset={(preset) => presets.push(preset)}
      />,
    );
    expect(page.querySelector("fieldset > legend")?.textContent).toBe("Days");
    const chips = [...page.querySelectorAll('[aria-label="Days of the week"] button')];
    expect(chips.map((chip) => chip.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    // Named by what each shows (WCAG 2.5.3): no aria-label over it, the full day in the abbreviation's title.
    expect(chips.every((chip) => !chip.hasAttribute("aria-label"))).toBe(true);
    expect(chips.map((chip) => chip.querySelector("abbr")?.getAttribute("title"))).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
    expect(pressed(page, "Presets")).toEqual(["Weekdays"]);
    expect(pressed(page, "Days of the week")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
    await click(button(page, "Sun"));
    await click(button(page, "Weekends"));
    expect(toggled).toEqual([0]);
    expect(presets).toEqual([[0, 6]]);
  });

  it("will not let the last day go, and says why", async () => {
    const toggled: number[] = [];
    const page = await mount(<DayChips days={[3]} onToggle={(day) => toggled.push(day)} onPreset={() => {}} />);
    const wednesday = page.querySelector<HTMLButtonElement>(`button:has(abbr[title="Wednesday"])`)!;
    expect(wednesday.getAttribute("aria-disabled")).toBe("true");
    expect(document.getElementById(wednesday.getAttribute("aria-describedby") ?? "")?.textContent).toBe("At least one day stays chosen.");
    // Still in the tab order, and still a button a keyboard reaches: it only does nothing.
    expect(wednesday.disabled).toBe(false);
    await click(wednesday);
    expect(toggled).toEqual([]);
  });
});

describe("CadenceField", () => {
  it("is a fieldset with a legend, every day by default, at the time it was given, in the workspace zone, marked", async () => {
    const run = harness({ at: "07:00", timezone: "Europe/Sofia" }, { workspaceZone: "Europe/Sofia" });
    const page = await mount(run.element);
    expect(page.querySelector("fieldset.cadence > legend")?.textContent).toBe("When");
    expect(radio(page, "weekly")?.checked).toBe(true);
    expect(pressed(page, "Presets")).toEqual(["Every day"]);
    expect(times(page).map((input) => input.value)).toEqual(["07:00"]);
    expect(times(page)[0]?.closest("label")?.textContent).toBe("Time");
    const zone = page.querySelector<HTMLInputElement>('input[aria-label="Time zone"]')!;
    expect(zone.value).toBe("Europe/Sofia");
    expect(zone.closest("label")?.textContent).toContain("Time zone");
    expect(page.textContent).toContain("(workspace zone)");
    const list = document.getElementById(zone.getAttribute("list") ?? "");
    expect(list?.querySelector("option")?.getAttribute("label")).toBe("Europe/Sofia (workspace zone)");
    expect(list?.querySelectorAll("option").length).toBeGreaterThan(100);
    expect([...(list?.querySelectorAll("option") ?? [])].filter((option) => option.getAttribute("value") === "Europe/Sofia")).toHaveLength(
      1,
    );
  });

  it("takes several times a day, up to its most, and back to one", async () => {
    const run = harness({ at: "07:00", timezone: "UTC" }, { maxTimes: 3 });
    const page = await mount(run.element);
    await click(button(page, "Add a time"));
    expect(run.last()).toEqual({ times: ["07:00", "08:00"], timezone: "UTC" });
    expect(times(page).map((input) => input.closest("label")?.textContent)).toEqual(["Time 1", "Time 2"]);
    await type(times(page)[1], "19:00");
    await click(button(page, "Add a time"));
    expect(run.last()).toEqual({ times: ["07:00", "19:00", "20:00"], timezone: "UTC" });
    expect(button(page, "Add a time")).toBeUndefined();
    await click(page.querySelector('[aria-label="Remove time 19:00"]'));
    await click(page.querySelector('[aria-label="Remove time 20:00"]'));
    expect(run.last()).toEqual({ at: "07:00", timezone: "UTC" });
    expect(page.querySelector('[aria-label^="Remove time"]')).toBeNull();
  });

  it("chooses days through the chips and presets, every day being no mask at all", async () => {
    const run = harness({ at: "07:00", timezone: "UTC" });
    const page = await mount(run.element);
    await click(button(page, "Weekdays"));
    expect(run.last()).toEqual({ at: "07:00", timezone: "UTC", daysOfWeek: [1, 2, 3, 4, 5] });
    await click(page.querySelector(`button:has(abbr[title="Saturday"])`));
    await click(page.querySelector(`button:has(abbr[title="Sunday"])`));
    expect(run.last()).toEqual({ at: "07:00", timezone: "UTC" });
    expect(pressed(page, "Presets")).toEqual(["Every day"]);
  });

  it("runs every few hours within a window, and back to set times", async () => {
    const run = harness({ at: "07:00", timezone: "UTC" });
    const page = await mount(run.element);
    await act(async () => page.querySelectorAll<HTMLInputElement>('[aria-label="Times of day"] input')[1]!.click());
    expect(run.last()).toEqual({ timezone: "UTC", everyHours: 2, between: { from: "08:00", to: "20:00" } });
    await pick(page.querySelector('[aria-label="Every how many hours"]'), "3");
    await type(page.querySelector('[aria-label="Window start"]'), "09:00");
    expect(run.last()).toEqual({ timezone: "UTC", everyHours: 3, between: { from: "09:00", to: "20:00" } });
    await act(async () => page.querySelectorAll<HTMLInputElement>('[aria-label="Times of day"] input')[0]!.click());
    expect(run.last()).toEqual({ timezone: "UTC", at: "09:00" });
  });

  it("repeats monthly on a day, a weekday or the last day, and yearly on a date", async () => {
    const run = harness({ at: "07:00", timezone: "UTC", daysOfWeek: [1] });
    const page = await mount(run.element);
    await click(radio(page, "monthly"));
    expect(run.last()?.daysOfWeek).toBeUndefined();
    expect(run.last()?.monthly).toMatchObject({ dayOfMonth: expect.any(Number) });
    await pick(page.querySelector('[aria-label="Day of the month"]'), "15");
    expect(run.last()).toEqual({ at: "07:00", timezone: "UTC", monthly: { dayOfMonth: 15 } });
    await pick(page.querySelector('[aria-label="Monthly on"]'), "weekday");
    await pick(page.querySelector('[aria-label="Which week"]'), "2");
    await pick(page.querySelector('[aria-label="Weekday"]'), "3");
    expect(run.last()).toEqual({ at: "07:00", timezone: "UTC", monthly: { nth: 2, weekday: 3 } });
    await pick(page.querySelector('[aria-label="Monthly on"]'), "last");
    expect(run.last()).toEqual({ at: "07:00", timezone: "UTC", monthly: { dayOfMonth: 31 } });
    expect(page.querySelector('[aria-label="Day of the month"]')).toBeNull();
    await click(radio(page, "yearly"));
    await pick(page.querySelector('[aria-label="Month"]'), "4");
    await pick(page.querySelector('[aria-label="Day"]'), "31");
    expect(run.last()).toEqual({ at: "07:00", timezone: "UTC", yearly: { month: 4, day: 31 } });
    const problems = page.querySelector(".cadence-problems")!;
    expect(problems.textContent).toBe("That month has no such day.");
    expect(page.querySelector("fieldset.cadence")?.getAttribute("aria-describedby")).toBe(problems.id);
    await pick(page.querySelector('[aria-label="Day"]'), "30");
    // The live region stays, empty, so the next problem is announced as it appears.
    expect(page.querySelector(".cadence-problems")?.textContent).toBe("");
    expect(page.querySelector(".cadence-problems")?.getAttribute("aria-live")).toBe("polite");
    expect(page.querySelector("fieldset.cadence")?.getAttribute("aria-describedby")).toBeNull();
  });

  it("runs once on a date, without an end date; a one-time-only field keeps one time", async () => {
    const run = harness({ times: ["07:00", "19:00"], timezone: "UTC", until: "2027-01-01" });
    const page = await mount(run.element);
    expect(page.querySelector<HTMLInputElement>('input[aria-label="Until"]')?.value).toBe("2027-01-01");
    await click(radio(page, "once"));
    expect(run.last()).toMatchObject({ times: ["07:00", "19:00"], once: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(run.last()).not.toHaveProperty("until");
    expect(page.querySelector('input[aria-label="Until"]')).toBeNull();
    await type(page.querySelector('input[type="date"]'), "2027-03-04");
    expect(run.last()?.once).toBe("2027-03-04");

    const single = harness({ everyHours: 2, between: { from: "08:00", to: "20:00" }, timezone: "UTC" }, { allows: { once: "single" } });
    const other = await mount(single.element);
    await click(radio(other, "once"));
    expect(single.last()).toMatchObject({ at: "08:00", timezone: "UTC" });
    expect(single.last()).not.toHaveProperty("everyHours");
    expect(other.querySelector('[aria-label="Times of day"]')).toBeNull();
    expect(button(other, "Add a time")).toBeUndefined();
  });

  it("offers only what the form allows", async () => {
    const run = harness({ at: "07:00", timezone: "UTC" }, { allows: { once: false, everyHours: false, until: false } });
    const page = await mount(run.element);
    expect(radio(page, "once")).toBeNull();
    expect(page.querySelector('[aria-label="Times of day"]')).toBeNull();
    expect(page.querySelector('input[aria-label="Until"]')).toBeNull();
  });

  it("says a zone it does not know, and offers the workspace's back", async () => {
    const run = harness({ at: "07:00", timezone: "Europe/Sofia" }, { workspaceZone: "Europe/Sofia" });
    const page = await mount(run.element);
    const zone = page.querySelector<HTMLInputElement>('input[aria-label="Time zone"]')!;
    await type(zone, "Mars/Olympus");
    expect(zone.getAttribute("aria-invalid")).toBe("true");
    expect(page.querySelector(".cadence-problems")?.textContent).toBe("Choose a time zone from the list.");
    await click(button(page, "Use the workspace zone (Europe/Sofia)"));
    expect(run.last()?.timezone).toBe("Europe/Sofia");
    expect(zone.getAttribute("aria-invalid")).toBeNull();
  });

  it("shows the owner's next three runs once typing settles, in the cadence's zone, asking nothing while it has problems", async () => {
    const asked: Record<string, unknown>[] = [];
    let refuse = false;
    const client: SettingsClient = {
      request: async (command, payload) => {
        asked.push({ command, ...(payload as Record<string, unknown>) });
        if (refuse) return { ok: false, error: { code: "INVALID_INPUT", message: "no such cadence" } };
        return {
          ok: true,
          result: {
            timezone: "Europe/Sofia",
            text: "every day at 07:00 (Europe/Sofia)",
            runs: ["2030-11-04T05:00:00.000Z", "2030-11-05T05:00:00.000Z", "2030-11-06T05:00:00.000Z"],
          },
        };
      },
    };
    const run = harness({ at: "07:00", timezone: "Europe/Sofia" }, { client });
    const page = await mount(run.element);
    expect(page.querySelector(".cadence-preview")?.textContent).toContain("Working them out…");
    expect(page.querySelector('.cadence-preview [aria-live="polite"]')?.textContent).toBe("");
    await waitPreview();
    expect(asked).toEqual([
      { command: "schedules", action: "preview", workspaceId: "default", at: "07:00", timezone: "Europe/Sofia", days: null, limit: 3 },
    ]);
    const preview = page.querySelector(".cadence-preview")!;
    // Only the next run is said aloud; the list is there to read, and "Working them out…" is never said.
    expect(preview.getAttribute("aria-live")).toBeNull();
    const said = preview.querySelector('[aria-live="polite"]');
    expect(said?.textContent).toBe("Next run Mon 4 Nov 2030 07:00.");
    expect(preview.querySelector(".cadence-label")?.textContent).toBe("Next 3 runs");
    expect([...preview.querySelectorAll("time")].map((time) => time.textContent)).toEqual([
      "Mon 4 Nov 2030 07:00",
      "Tue 5 Nov 2030 07:00",
      "Wed 6 Nov 2030 07:00",
    ]);
    expect(preview.querySelector("time")?.getAttribute("dateTime")).toBe("2030-11-04T05:00:00.000Z");
    // Typing in quick succession asks once, for what it settled on.
    await type(times(page)[0], "08:00");
    await type(times(page)[0], "08:30");
    await waitPreview();
    expect(asked.slice(1).map((payload) => payload["at"])).toEqual(["08:30"]);
    // A half-typed time asks nothing, and says why.
    await type(times(page)[0], "");
    await waitPreview();
    expect(asked).toHaveLength(2);
    expect(page.querySelector(".cadence-preview")?.textContent).toContain("Shown once the schedule above is complete.");
    refuse = true;
    await type(times(page)[0], "09:00");
    await waitPreview();
    expect(page.querySelector(".cadence-preview")?.textContent).toContain("Not available: no such cadence");
  });

  it("shows only the latest cadence's runs when the owner's answers come back out of order", async () => {
    const pending: { readonly at: unknown; readonly answer: () => void }[] = [];
    const client: SettingsClient = {
      request: (_command, payload) => {
        const at = (payload as Record<string, unknown>)["at"];
        return new Promise((resolve) =>
          pending.push({
            at,
            answer: () => resolve({ ok: true, result: { timezone: "UTC", text: "", runs: [`2030-11-04T${String(at)}:00.000Z`] } }),
          }),
        );
      },
    };
    const run = harness({ at: "07:00", timezone: "UTC" }, { client });
    const page = await mount(run.element);
    await waitPreview();
    await type(times(page)[0], "08:00");
    await waitPreview();
    expect(pending.map((each) => each.at)).toEqual(["07:00", "08:00"]);
    await act(async () => pending[1]!.answer());
    await act(async () => pending[0]!.answer());
    const shown = () => [...page.querySelectorAll(".cadence-preview time")].map((time) => time.getAttribute("dateTime"));
    expect(shown()).toEqual(["2030-11-04T08:00:00.000Z"]);
  });

  it("keeps a stored date that has passed without a floor, and holds a newly picked one to today or later", async () => {
    const once = await mount(harness({ at: "07:00", timezone: "UTC", once: "2020-01-01" }).element);
    const on = once.querySelector<HTMLInputElement>('input[type="date"]')!;
    expect(on.value).toBe("2020-01-01");
    expect(on.hasAttribute("min")).toBe(false);
    await type(on, "2020-02-01");
    expect(on.getAttribute("min")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const until = await mount(harness({ at: "07:00", timezone: "UTC", until: "2020-01-01" }).element);
    const last = until.querySelector<HTMLInputElement>('input[aria-label="Until"]')!;
    expect(last.hasAttribute("min")).toBe(false);
    await type(last, "2020-02-01");
    expect(last.getAttribute("min")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const future = await mount(harness({ at: "07:00", timezone: "UTC", once: "2999-01-01" }).element);
    expect(future.querySelector('input[type="date"]')?.getAttribute("min")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("says when a cadence does not run again, and shows no preview without an owner to ask", async () => {
    const client: SettingsClient = { request: async () => ({ ok: true, result: { timezone: "UTC", text: "", runs: [] } }) };
    const page = await mount(harness({ at: "07:00", timezone: "UTC", once: "2020-01-01" }, { client }).element);
    await waitPreview();
    expect(page.querySelector(".cadence-preview")?.textContent).toContain("It does not run again.");
    const quiet = await mount(harness({ at: "07:00", timezone: "UTC" }).element);
    expect(quiet.querySelector(".cadence-preview")).toBeNull();
  });
});
