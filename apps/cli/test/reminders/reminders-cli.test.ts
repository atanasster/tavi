import {
  RemindersPayloadSchema,
  instantForLocalTime,
  type ReminderCreateAnswer,
  type ReminderGetAnswer,
  type ReminderView,
  type RemindersListAnswer,
} from "@tavi/contracts";
import { capture, temporaryDirectories } from "@tavi/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { COMMAND_INDEX } from "../../src/cli/help.js";
import { REMINDERS_USAGE, type RemindersCommandOptions } from "../../src/features/reminders/parse.js";
import { UsageError, parseArgs } from "../../src/cli/parse.js";
import { EXIT, main } from "../../src/main.js";
import { reminderWhen, remindersPayload, remindersResultText } from "../../src/features/reminders/text.js";
import { findLiveOwner, serve, type ServeHandle } from "../../src/server/serve.js";
import { fixtureServeOptions } from "../support/serve-fixture.js";

/** `tavi reminders`: parsing, the payloads, and the owner and offline paths. */

const directories = temporaryDirectories({ prefix: "tavi-reminders-cli-" });
const handles: ServeHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) await handles.pop()?.shutdown("test cleanup");
  directories.cleanup();
});

async function owner(dataDirectory: string): Promise<ServeHandle> {
  const handle = await serve(
    fixtureServeOptions(dataDirectory, { reminderSweepEnabled: false }),
    { dataDirectory, drainDeadlineMs: 5_000 },
    { stdout: () => {}, stderr: () => {}, isTty: false },
  );
  handles.push(handle);
  if ((await findLiveOwner(dataDirectory)) === undefined) throw new Error("serve did not publish discovery");
  return handle;
}

const parsed = (...argv: string[]): RemindersCommandOptions => {
  const command = parseArgs(["reminders", ...argv]);
  if (command.reminders === undefined) throw new Error("not a reminders command");
  return command.reminders;
};
const refused = (...argv: string[]): string => {
  try {
    parseArgs(["reminders", ...argv]);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as UsageError).message;
  }
  throw new Error(`reminders ${argv.join(" ")} was accepted`);
};

/** A local date `days` from now, as `YYYY-MM-DD`: a time the owner accepts whatever the test's clock. */
function daysAhead(days: number): { readonly text: string; readonly year: number; readonly month: number; readonly day: number } {
  const date = new Date(Date.now() + days * 86_400_000);
  const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  return { text: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, year, month, day };
}

describe("the reminders list as text", () => {
  const ID = "rem-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const view = (fields: Partial<ReminderView>): ReminderView =>
    ({ reminderId: ID, status: "active", timezone: "UTC", text: "Stretch", nextFireAt: null, ...fields }) as ReminderView;
  const at = (columns: number | undefined, ...reminders: ReminderView[]): string =>
    remindersResultText(
      { action: "list" } as RemindersCommandOptions,
      { reminders, timezone: "UTC" },
      new Date("2026-11-04T00:00:00.000Z"),
      columns,
    );
  const listed = (...reminders: ReminderView[]): string => at(undefined, ...reminders);
  const AT = "2026-11-10T18:30:00.000Z";

  it("lists reminders in the order they run, with a date in another year saying so", () => {
    const out = listed(
      view({ text: "Later", when: { kind: "once", at: "2028-05-01T09:00:00.000Z" }, nextFireAt: "2028-05-01T09:00:00.000Z" }),
      view({ text: "Sooner", when: { kind: "once", at: AT }, nextFireAt: AT }),
    );
    expect(out.indexOf("Sooner")).toBeLessThan(out.indexOf("Later"));
    expect(out).toContain("Mon 1 May 2028 09:00");
  });

  it("fits 80 columns with no tabs, the text wrapped on lines of its own, however long", () => {
    const text =
      "Driving Theory Study Session 3: Road Signs & Markings (Motorway Signals, Stopping Distances and Hazard Perception practice)";
    const out = listed(
      view({ text, when: { kind: "repeat", times: ["07:00", "19:00"], daysOfWeek: [1, 2, 3, 4, 5], until: "2026-12-31" }, nextFireAt: AT }),
    );
    expect(out).not.toContain("\t");
    for (const line of out.split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
    expect(out.split("\n").map((line) => line.trimEnd())).toEqual([
      "Reminders (UTC)",
      "REMINDER                                  STATUS  NEXT",
      `${ID}  active  Tue 10 Nov 18:30`,
      "    Driving Theory Study Session 3: Road Signs & Markings (Motorway Signals,",
      "    Stopping Distances and Hazard Perception practice)",
      "    Mon,Tue,Wed,Thu,Fri 07:00,19:00 until 2026-12-31",
    ]);
  });

  it("fits the terminal's width when there is one, and 80 when piped, breaking a word too long for a line", () => {
    const sentence = "Driving Theory Study Session 3: Road Signs and Markings, Stopping Distances and Hazard Perception practice";
    const word = "x".repeat(120);
    const when = { kind: "once", at: AT } as const;
    const many = [view({ text: sentence, when, nextFireAt: AT }), view({ text: word, when, nextFireAt: AT })];
    for (const columns of [40, 80, 120]) {
      for (const line of at(columns, ...many).split("\n")) expect(line.length, `${columns}: ${line}`).toBeLessThanOrEqual(columns);
      expect(at(columns, ...many).replaceAll(/\s/g, "")).toContain(word);
    }
    // No terminal, a pipe: 80, as ever.
    expect(listed(...many)).toBe(at(80, ...many));
    for (const line of listed(...many).split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
    // Wider than 80, the sentence takes the room.
    expect(at(120, ...many)).toContain(`    ${sentence}`);
  });

  it("says a one-off's date once while it is to come, and keeps it once it has fired", () => {
    const once = { kind: "once", at: AT } as const;
    const coming = listed(view({ when: once, nextFireAt: AT }));
    expect(coming.match(/Tue 10 Nov 18:30/g)).toHaveLength(1);
    expect(coming).not.toContain("once");
    expect(listed(view({ when: once, status: "done" }))).toContain("once Tue 10 Nov 18:30");
    // Snoozed: the next fire is not the date it was set for.
    const snoozed = listed(view({ when: once, nextFireAt: "2026-11-11T09:00:00.000Z" }));
    expect(snoozed).toContain("Wed 11 Nov 09:00");
    expect(snoozed).toContain("once Tue 10 Nov 18:30");
  });
});

describe("parsing tavi reminders", () => {
  it("is in the command index and has its own usage page", () => {
    expect(COMMAND_INDEX).toContain("tavi reminders <action>");
    expect(parseArgs(["reminders", "--help"])).toEqual({ command: "help", usage: REMINDERS_USAGE });
    expect(refused()).toContain("reminders needs an action");
    expect(refused("nudge")).toContain("Unknown reminders action");
  });

  it("reads once, event and repeat reminders", () => {
    expect(parsed("add", "Call mum", "--at", "2026-10-05T10:00+02:00")).toMatchObject({
      action: "add",
      text: "Call mum",
      when: { kind: "once", at: { instant: "2026-10-05T10:00+02:00" } },
      workspaceId: "default",
      format: "text",
    });
    expect(parsed("add", "Dentist appointment", "--event", "2026-10-05 10:00", "--zone", "Europe/Berlin").when).toEqual({
      kind: "event",
      at: { local: { year: 2026, month: 10, day: 5, hour: 10, minute: 0 } },
      notify: ["-1d@20:00", "-1h"],
    });
    expect(parsed("add", "Dentist", "--event", "2026-10-05T10:00", "--notify", "-2d@09:00,-15m").when).toMatchObject({
      notify: ["-2d@09:00", "-15m"],
    });
    expect(
      parsed(
        "add",
        "Take your pills",
        "--repeat",
        "08:00,20:00",
        "--days",
        "mon-fri",
        "--until",
        "2026-12-31",
        "--prompt",
        "check the train",
      ).when,
    ).toEqual({
      kind: "repeat",
      times: ["08:00", "20:00"],
      daysOfWeek: [1, 2, 3, 4, 5],
      until: "2026-12-31",
    });
    expect(parsed("add", "Stretch", "--repeat", "15:00", "--days", "sat,sun").when).toMatchObject({ daysOfWeek: [0, 6] });
    expect(parsed("add", "Stretch", "--repeat", "15:00", "--days", "0,3").when).toMatchObject({ daysOfWeek: [0, 3] });
    expect(parsed("add", "Stretch", "--repeat", "15:00", "--days", "fri-mon").when).toMatchObject({ daysOfWeek: [0, 1, 5, 6] });
    expect(parsed("add", "Stretch", "--repeat", "15:00", "--prompt", "look at the news").prompt).toBe("look at the news");
  });

  it("reads monthly and yearly repeats as the contract's repeat.monthly and repeat.yearly", () => {
    expect(parsed("add", "Pay the rent", "--repeat", "09:00", "--monthly", "1").when).toEqual({
      kind: "repeat",
      times: ["09:00"],
      monthly: { dayOfMonth: 1 },
    });
    expect(parsed("add", "Team review", "--repeat", "16:00", "--monthly", "last:fri").when).toMatchObject({
      monthly: { nth: -1, weekday: 5 },
    });
    expect(parsed("add", "Book club", "--repeat", "19:00", "--monthly", "2:Tue").when).toMatchObject({ monthly: { nth: 2, weekday: 2 } });
    expect(parsed("add", "Book club", "--repeat", "19:00", "--monthly", "3:0").when).toMatchObject({ monthly: { nth: 3, weekday: 0 } });
    expect(parsed("add", "Birthday", "--repeat", "08:00", "--yearly", "02-29", "--until", "2040-12-31").when).toEqual({
      kind: "repeat",
      times: ["08:00"],
      yearly: { month: 2, day: 29 },
      until: "2040-12-31",
    });
    const payload = remindersPayload(parsed("add", "Pay the rent", "--repeat", "09:00", "--monthly", "31"), "UTC", "k");
    expect(payload).toMatchObject({ action: "create", when: { kind: "repeat", times: ["09:00"], monthly: { dayOfMonth: 31 } } });
    expect(RemindersPayloadSchema.safeParse(payload).success).toBe(true);
    const yearly = remindersPayload(parsed("add", "Renew the car", "--repeat", "09:00", "--yearly", "12-25"), "UTC", "k");
    expect(RemindersPayloadSchema.safeParse(yearly).success).toBe(true);
  });

  it("reads the other actions", () => {
    expect(parsed("list")).toMatchObject({ action: "list" });
    expect(parsed("list", "--status", "done,cancelled", "--format", "json")).toMatchObject({
      statuses: ["done", "cancelled"],
      format: "json",
    });
    expect(parsed("show", "rem-1")).toMatchObject({ action: "show", reminderId: "rem-1" });
    expect(parsed("cancel", "rem-1")).toMatchObject({ action: "cancel", reminderId: "rem-1" });
    expect(parsed("pause", "rem-1")).toMatchObject({ action: "pause", reminderId: "rem-1" });
    expect(parsed("resume", "rem-1")).toMatchObject({ action: "resume", reminderId: "rem-1" });
    expect(parsed("snooze", "rem-1", "--minutes", "60")).toMatchObject({ action: "snooze", reminderId: "rem-1", minutes: 60 });
    expect(parsed("snooze", "rem-1", "--minutes", "1")).toMatchObject({ minutes: 1 });
    expect(parsed("snooze", "rem-1", "--minutes", "10080")).toMatchObject({ minutes: 10_080 });
    expect(RemindersPayloadSchema.safeParse(remindersPayload(parsed("snooze", "rem-1", "--minutes", "45"), undefined, "k")).success).toBe(
      true,
    );
    // --task: the chat a reminder belongs to.
    expect(remindersPayload(parsed("list", "--task", "t1"), undefined, "k")).toMatchObject({ action: "list", originTaskId: "t1" });
    expect(remindersPayload(parsed("add", "Check the audit", "--at", "2026-10-05T10:00Z", "--task", "t1"), undefined, "k")).toMatchObject({
      action: "create",
      originTaskId: "t1",
    });
    // --deliver-to home: said as a notice in the person's Home.
    expect(remindersPayload(parsed("add", "Stretch", "--repeat", "15:00", "--deliver-to", "home"), undefined, "k")).toMatchObject({
      action: "create",
      deliverTo: { kind: "home" },
    });
    expect(refused("add", "Stretch", "--repeat", "15:00", "--deliver-to", "telegram")).toContain("--deliver-to expects app or home");
    expect(refused("show", "rem-1", "--task", "t1")).toContain("does not accept --task");
  });

  it("refuses what it cannot read", () => {
    expect(refused("add", "Pills")).toContain("exactly one of --at, --event or --repeat");
    expect(refused("add", "Pills", "--at", "2026-10-05 10:00", "--repeat", "21:00")).toContain("exactly one of");
    expect(refused("add", "--repeat", "21:00")).toContain("needs the reminder's text");
    expect(refused("add", "take", "pills", "--repeat", "21:00")).toContain("quote it");
    expect(refused("add", "Pills", "--at", "tomorrow")).toContain("--at expects an ISO time");
    expect(refused("add", "Pills", "--at", "2026-02-30 10:00")).toContain("--at expects");
    expect(refused("add", "Pills", "--repeat", "9pm")).toContain("--repeat expects 24-hour HH:MM");
    expect(refused("add", "Pills", "--repeat", "21:00", "--days", "funday")).toContain("--days expects");
    expect(refused("add", "Pills", "--repeat", "21:00", "--until", "soon")).toContain("--until expects");
    expect(refused("add", "Pills", "--at", "2026-10-05 10:00", "--notify", "-1h")).toContain("--notify goes with --event");
    expect(refused("add", "Pills", "--at", "2026-10-05 10:00", "--days", "mon")).toContain("go with --repeat");
    expect(refused("add", "Rent", "--at", "2026-10-05 10:00", "--monthly", "1")).toContain("go with --repeat");
    expect(refused("add", "Rent", "--repeat", "09:00", "--monthly", "1", "--days", "mon")).toContain("one of them");
    expect(refused("add", "Rent", "--repeat", "09:00", "--monthly", "1", "--yearly", "01-01")).toContain("one of them");
    expect(refused("add", "Rent", "--repeat", "09:00", "--monthly", "32")).toContain("--monthly expects");
    expect(refused("add", "Rent", "--repeat", "09:00", "--monthly", "6:fri")).toContain("--monthly expects");
    expect(refused("add", "Rent", "--repeat", "09:00", "--monthly", "last:funday")).toContain("--monthly expects");
    expect(refused("add", "Birthday", "--repeat", "08:00", "--yearly", "02-30")).toContain("--yearly expects");
    expect(refused("add", "Birthday", "--repeat", "08:00", "--yearly", "2026-12-25")).toContain("--yearly expects");
    expect(refused("add", "Dentist", "--event", "2026-10-05 10:00", "--notify", "+1h")).toContain("--notify expects");
    expect(refused("add", "Pills", "--repeat", "21:00", "--zone", "Mars/Olympus")).toContain("not a known IANA timezone");
    expect(refused("snooze", "rem-1")).toContain("--minutes from 1 to 10080");
    expect(refused("snooze", "rem-1", "--minutes", "0")).toContain("--minutes from 1 to 10080");
    expect(refused("snooze", "rem-1", "--minutes", "10081")).toContain("--minutes from 1 to 10080");
    expect(refused("snooze", "rem-1", "--minutes", "1.5")).toContain("--minutes from 1 to 10080");
    expect(refused("snooze", "rem-1", "--minutes", "soon")).toContain("--minutes from 1 to 10080");
    expect(refused("show")).toContain("needs a reminder id");
    expect(refused("list", "rem-1")).toContain("takes no reminder id");
    expect(refused("list", "--status", "fired")).toContain("--status expects");
    expect(refused("cancel", "rem-1", "--minutes", "10")).toContain("does not accept --minutes");
  });
});

describe("the reminders payloads", () => {
  it("reads a local time in the zone it is given, across DST", () => {
    const local = { year: 2026, month: 10, day: 5, hour: 10, minute: 0 };
    // Berlin is on summer time (UTC+2) on 5 October, and winter time (UTC+1) in November.
    expect(reminderWhen({ kind: "event", at: { local }, notify: ["-1d@20:00", "-1h"] }, "Europe/Berlin")).toEqual({
      kind: "event",
      at: "2026-10-05T08:00:00.000Z",
      notify: ["-1d@20:00", "-1h"],
    });
    expect(reminderWhen({ kind: "once", at: { local: { ...local, month: 11 } } }, "Europe/Berlin")).toEqual({
      kind: "once",
      at: "2026-11-05T09:00:00.000Z",
    });
    expect(reminderWhen({ kind: "once", at: { instant: "2026-10-05T10:00+02:00" } }, "Europe/Berlin")).toEqual({
      kind: "once",
      at: "2026-10-05T10:00+02:00",
    });
    // A time the clocks skip is read as the first minute that exists (03:00 CEST); one they repeat as its first, CEST, reading.
    expect(reminderWhen({ kind: "once", at: { local: { year: 2026, month: 3, day: 29, hour: 2, minute: 30 } } }, "Europe/Berlin")).toEqual({
      kind: "once",
      at: "2026-03-29T01:00:00.000Z",
    });
    expect(reminderWhen({ kind: "once", at: { local: { year: 2026, month: 10, day: 25, hour: 2, minute: 30 } } }, "Europe/Berlin")).toEqual(
      { kind: "once", at: "2026-10-25T00:30:00.000Z" },
    );
  });

  it("sends the zone it read local times in only when --zone named it", () => {
    const zoned = remindersPayload(parsed("add", "Pills", "--repeat", "21:00", "--zone", "Europe/Sofia"), undefined, "key-1");
    expect(zoned).toEqual({
      action: "create",
      workspaceId: "default",
      text: "Pills",
      when: { kind: "repeat", times: ["21:00"] },
      timezone: "Europe/Sofia",
      operationKey: "key-1",
    });
    const workspace = remindersPayload(parsed("add", "Dentist", "--at", "2026-10-05 10:00"), "Europe/Berlin", "key-2");
    expect(workspace).toEqual({
      action: "create",
      workspaceId: "default",
      text: "Dentist",
      when: { kind: "once", at: "2026-10-05T08:00:00.000Z" },
      operationKey: "key-2",
    });
    expect(remindersPayload(parsed("snooze", "rem-1", "--minutes", "10"), undefined, "k")).toEqual({
      action: "snooze",
      workspaceId: "default",
      reminderId: "rem-1",
      minutes: 10,
    });
    expect(remindersPayload(parsed("show", "rem-1"), undefined, "k")).toEqual({
      action: "get",
      workspaceId: "default",
      reminderId: "rem-1",
    });
  });
});

describe("tavi reminders", () => {
  const run = async (dataDirectory: string, ...argv: string[]) => {
    const captured = capture();
    const code = await main(["reminders", ...argv, "--data-dir", dataDirectory], { io: captured.io });
    return { code, out: captured.out(), err: captured.err() };
  };

  it("works through a live owner: add with the read-back, list, show, pause, resume, cancel", async () => {
    const dataDirectory = directories.create();
    await owner(dataDirectory);

    const added = await run(dataDirectory, "add", "Take your pills", "--repeat", "21:00", "--zone", "Europe/Berlin");
    expect(added.code, added.err).toBe(EXIT.ok);
    const [head, readBack] = added.out.trim().split("\n");
    expect(head).toMatch(/^Added rem-[\w-]+: Take your pills$/);
    expect(readBack).toMatch(/^every day at 21:00 Europe\/Berlin; next \w{3} \d{1,2} \w{3,4} 21:00$/);
    const reminderId = /^Added (rem-[\w-]+):/.exec(head ?? "")?.[1] ?? "";

    const future = daysAhead(20);
    const event = await run(
      dataDirectory,
      "add",
      "Dentist appointment",
      "--event",
      `${future.text} 10:00`,
      "--zone",
      "Europe/Berlin",
      "--format",
      "json",
    );
    expect(event.code, event.err).toBe(EXIT.ok);
    const created = JSON.parse(event.out) as ReminderCreateAnswer;
    const expected = instantForLocalTime(
      { year: future.year, month: future.month, day: future.day, hour: 10, minute: 0 },
      "Europe/Berlin",
    ).toISOString();
    expect(created.reminder).toMatchObject({
      text: "Dentist appointment",
      createdBy: "user",
      deliverTo: { kind: "app" },
      when: { kind: "event", at: expected, notify: ["-1d@20:00", "-1h"] },
    });

    const listed = await run(dataDirectory, "list", "--format", "json");
    expect((JSON.parse(listed.out) as RemindersListAnswer).reminders.map((reminder) => reminder.text).sort()).toEqual([
      "Dentist appointment",
      "Take your pills",
    ]);
    const text = await run(dataDirectory, "list");
    expect(text.out).toMatch(new RegExp(`${reminderId} +active +`));
    expect(text.out).toContain("    Take your pills\n    daily 21:00");

    const shown = await run(dataDirectory, "show", reminderId, "--format", "json");
    expect((JSON.parse(shown.out) as ReminderGetAnswer).reminder.reminderId).toBe(reminderId);
    expect((await run(dataDirectory, "show", reminderId)).out).toContain("When: every day at 21:00 Europe/Berlin");

    expect((await run(dataDirectory, "pause", reminderId)).out).toBe(`${reminderId}\tpaused\tTake your pills\n`);
    expect((await run(dataDirectory, "resume", reminderId)).out).toBe(`${reminderId}\tactive\tTake your pills\n`);
    expect((await run(dataDirectory, "cancel", reminderId)).out).toBe(`${reminderId}\tcancelled\tTake your pills\n`);

    // Nothing delivered yet: the owner's refusal, in its own words.
    const snoozed = await run(dataDirectory, "snooze", created.reminder.reminderId, "--minutes", "10");
    expect(snoozed.code).toBe(EXIT.usage);
    expect(snoozed.err.length).toBeGreaterThan(0);

    const missing = await run(dataDirectory, "show", "rem-nope");
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.err).toContain("does not exist");

    const past = await run(dataDirectory, "add", "Too late", "--at", "2020-01-01 10:00", "--zone", "Europe/Berlin");
    expect(past.code).toBe(EXIT.usage);
    expect(past.err).toContain("That time is in the past");
  });

  it("reads a local time in the workspace's zone when --zone is not given", async () => {
    const dataDirectory = directories.create();
    await owner(dataDirectory);
    const zone = await run(dataDirectory, "list");
    const workspaceZone = /^(?:No reminders|Reminders) \((.+)\)$/m.exec(zone.out)?.[1] ?? "";
    const future = daysAhead(10);
    const added = await run(dataDirectory, "add", "Call the plumber", "--at", `${future.text} 09:30`, "--format", "json");
    expect(added.code, added.err).toBe(EXIT.ok);
    const created = JSON.parse(added.out) as ReminderCreateAnswer;
    expect(created.reminder.timezone).toBe(workspaceZone);
    // A workspace the owner does not serve: its refusal, not a request for --zone.
    const unserved = await run(dataDirectory, "add", "Call the plumber", "--at", `${future.text} 09:30`, "--workspace", "elsewhere");
    expect(unserved.code).toBe(EXIT.usage);
    expect(unserved.err).toContain("workspace elsewhere is not configured on this owner");
    expect(unserved.err).not.toContain("--zone");
    expect(created.reminder.when).toEqual({
      kind: "once",
      at: instantForLocalTime(
        { year: future.year, month: future.month, day: future.day, hour: 9, minute: 30 },
        workspaceZone,
      ).toISOString(),
    });
  });

  it("works offline when no owner serves the directory", async () => {
    const dataDirectory = directories.create();
    const added = await run(dataDirectory, "add", "Stretch", "--repeat", "15:00", "--days", "mon-fri", "--zone", "Europe/Berlin");
    expect(added.code, added.err).toBe(EXIT.ok);
    expect(added.out).toMatch(/every Mon, Tue, Wed, Thu, Fri at 15:00 Europe\/Berlin; next /);
    const listed = await run(dataDirectory, "list");
    expect(listed.out).toContain("    Stretch\n    Mon,Tue,Wed,Thu,Fri 15:00");
    const reminderId = /^Added (rem-[\w-]+):/.exec(added.out)?.[1] ?? "";
    expect((await run(dataDirectory, "cancel", reminderId)).out).toBe(`${reminderId}\tcancelled\tStretch\n`);
    expect((await run(dataDirectory, "list", "--status", "cancelled")).out).toMatch(new RegExp(`${reminderId} +cancelled +-`));
    expect((await run(dataDirectory, "show", "rem-nope")).code).toBe(EXIT.usage);
  });
});
