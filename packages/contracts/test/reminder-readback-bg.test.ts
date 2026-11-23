import { describe, expect, it } from "vitest";
import { coreIn } from "../src/locales/core-server.js";
import { reminderReadBack } from "../src/reminders.js";

const BERLIN = "Europe/Berlin";
const now = new Date("2026-10-01T10:00:00.000Z");
const bg = coreIn("bg");

describe("reminderReadBack in Bulgarian", () => {
  it("reads a one-off reminder back in Bulgarian, the English default unchanged", () => {
    const reminder = { when: { kind: "once" as const, at: "2026-10-02T07:00:00.000Z" }, timezone: BERLIN };
    expect(reminderReadBack(reminder, now, bg)).toBe("пт, 2 окт в 09:00 Europe/Berlin; ще ти напомня тогава");
    expect(reminderReadBack(reminder, now)).toBe("Fri 2 Oct 09:00 Europe/Berlin; I'll remind you then");
  });

  it("names a coming notice by weekday and joins the list with „и“", () => {
    const reminder = {
      when: { kind: "event" as const, at: "2026-10-05T08:00:00.000Z", notify: ["-1d@20:00", "-1h"] },
      timezone: BERLIN,
    };
    expect(reminderReadBack(reminder, now, bg)).toBe("пн, 5 окт в 10:00 Europe/Berlin; ще ти напомня нд в 20:00 и пн в 09:00");
  });

  it("reads a weekly repeat with its end and next time", () => {
    const reminder = {
      when: { kind: "repeat" as const, times: ["21:00", "08:00"], daysOfWeek: [1, 3], until: "2027-01-31" },
      timezone: BERLIN,
    };
    expect(reminderReadBack(reminder, now, bg)).toBe("пн, ср в 08:00 и 21:00 Europe/Berlin до 31 яну 2027 г.; следващо: пн, 5 окт в 08:00");
  });

  it("writes a date in another year with its year", () => {
    const reminder = { when: { kind: "once" as const, at: "2028-08-27T08:00:00.000Z" }, timezone: "Europe/London" };
    expect(reminderReadBack(reminder, now, bg)).toBe("нд, 27 авг 2028 г. в 09:00 Europe/London; ще ти напомня тогава");
  });
});
