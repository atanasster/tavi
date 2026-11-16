import { describe, expect, it } from "vitest";

import { AGENDA_DEFAULT_LIMIT, AgendaAnswerSchema, SchedulesPayloadSchema, resolveAgendaWindow } from "../src/index.js";

const NOW = new Date("2026-09-29T10:00:00.000Z");

describe("schedules agenda window", () => {
  it("defaults to the next seven days from now", () => {
    expect(resolveAgendaWindow({}, NOW)).toEqual({
      from: "2026-09-29T10:00:00.000Z",
      until: "2026-10-06T10:00:00.000Z",
      limit: AGENDA_DEFAULT_LIMIT,
    });
  });

  it("reads a past from as now, and accepts an offset", () => {
    expect(resolveAgendaWindow({ from: "2026-09-28T00:00:00.000Z", until: "2026-10-01T00:00:00+02:00", limit: 5 }, NOW)).toEqual({
      from: "2026-09-29T10:00:00.000Z",
      until: "2026-09-30T22:00:00.000Z",
      limit: 5,
    });
  });

  it("refuses a window over 31 days or ending before it starts", () => {
    expect(resolveAgendaWindow({ until: "2026-11-01T10:00:00.000Z" }, NOW)).toEqual({ error: expect.stringMatching(/31 days/) });
    expect(resolveAgendaWindow({ from: "2026-10-02T00:00:00.000Z", until: "2026-10-01T00:00:00.000Z" }, NOW)).toEqual({
      error: expect.stringMatching(/after from/),
    });
  });

  it("is a schedules action, and the answer schema holds both cadences", () => {
    expect(SchedulesPayloadSchema.parse({ action: "agenda", from: "2026-09-29T10:00:00Z", limit: 200 }).action).toBe("agenda");
    expect(SchedulesPayloadSchema.safeParse({ action: "agenda", limit: 201 }).success).toBe(false);
    expect(
      AgendaAnswerSchema.parse({
        timezone: "Europe/Berlin",
        items: [
          {
            kind: "schedule",
            id: "s",
            title: "S",
            at: "2026-09-29T19:00:00.000Z",
            cadence: { kind: "daily", at: "21:00", timezone: "Europe/Berlin", daysOfWeek: [1] },
            enabled: true,
          },
          {
            kind: "routine",
            id: "r",
            triggerId: "t",
            title: "R",
            at: "2026-09-29T08:00:00.000Z",
            cadence: { kind: "once" },
            enabled: true,
            status: "active",
            overdue: true,
          },
        ],
        truncated: false,
        skipped: ["broken"],
      }).items,
    ).toHaveLength(2);
    expect(AgendaAnswerSchema.safeParse({ timezone: "UTC", items: [] }).success).toBe(false);
  });
});
