import { TaviError } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { GOOGLE_CALENDAR_LIST_MAX, GOOGLE_CALENDAR_SCOPES, GoogleCalendar } from "../src/calendar.js";
import { GMAIL_CHANNEL_DESCRIPTOR } from "../src/connector.js";

/** One Google account's calendar: what the owner's calendar tools call, over Calendar API v3. */

const TOKEN = "ya29.secret-token";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

/** A Calendar API that answers each call from `routes`, recording every one. */
function calendar(routes: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const call: Call = {
      method: init?.method ?? "GET",
      path: String(url).replace("https://calendar.test/v3", ""),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    };
    calls.push(call);
    return routes(call);
  }) as typeof globalThis.fetch;
  return { calls, cal: new GoogleCalendar({ accessToken: async () => TOKEN, fetch, apiBaseUrl: "https://calendar.test/v3" }) };
}

const range = { timeMin: "2026-11-09T00:00:00Z", timeMax: "2026-11-16T00:00:00Z" };
const standup = {
  id: "ev1",
  summary: "Standup",
  start: { dateTime: "2026-11-09T09:00:00+01:00" },
  end: { dateTime: "2026-11-09T09:15:00+01:00" },
  organizer: { email: "lead@example.com" },
  attendees: [
    { email: "lead@example.com", responseStatus: "accepted" },
    { email: "you@gmail.com", responseStatus: "needsAction", self: true },
  ],
  conferenceData: { entryPoints: [{ uri: "https://meet.example/secret" }] },
};

describe("the Google account's calendar", () => {
  it("asks for its scopes only once its calendar is on, and never the whole calendar scope", () => {
    const spec = GMAIL_CHANNEL_DESCRIPTOR.auth.kind === "oauth2" ? GMAIL_CHANNEL_DESCRIPTOR.auth.oauth : undefined;
    expect(spec?.scopes).toEqual(["openid", "https://www.googleapis.com/auth/userinfo.email"]);
    expect(spec?.optInScopes?.calendar).toEqual([...GOOGLE_CALENDAR_SCOPES]);
    expect(GOOGLE_CALENDAR_SCOPES).not.toContain("https://www.googleapis.com/auth/calendar");
    expect(GMAIL_CHANNEL_DESCRIPTOR.app?.calendar).toBe(true);
  });

  it("lists a range's single events in order, as the tools show them, without conference secrets", async () => {
    const { calls, cal } = calendar(() => Response.json({ items: [standup, { summary: "no id" }] }));
    const events = await cal.listEvents("primary", range, { query: "standup", max: 500 });
    const params = new URL(`https://calendar.test${calls[0]?.path ?? ""}`).searchParams;
    expect(calls[0]?.path.startsWith("/calendars/primary/events?")).toBe(true);
    expect(Object.fromEntries(params)).toEqual({
      ...range,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(GOOGLE_CALENDAR_LIST_MAX),
      q: "standup",
    });
    expect(events).toEqual([
      {
        id: "ev1",
        calendarId: "primary",
        summary: "Standup",
        organizer: "lead@example.com",
        myResponse: "needsAction",
        start: { dateTime: "2026-11-09T09:00:00+01:00" },
        end: { dateTime: "2026-11-09T09:15:00+01:00" },
        attendees: [
          { email: "lead@example.com", responseStatus: "accepted" },
          { email: "you@gmail.com", responseStatus: "needsAction", self: true },
        ],
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("meet.example");
  });

  it("makes and changes events emailing attendees only when told, and answers an invitation as its own attendee", async () => {
    const { calls, cal } = calendar((call) => (call.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(standup)));
    await cal.createEvent(
      "primary",
      { summary: "Tavi test", start: { dateTime: "2026-11-10T09:00:00Z" }, end: { dateTime: "2026-11-10T09:15:00Z" } },
      "none",
    );
    await cal.updateEvent("primary", "ev1", { attendees: ["ana@example.com"] }, "all");
    await cal.respond("primary", "ev1", "declined");
    await cal.deleteEvent("primary", "ev1", "none");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /calendars/primary/events?sendUpdates=none",
      "PATCH /calendars/primary/events/ev1?sendUpdates=all",
      "GET /calendars/primary/events/ev1",
      "PATCH /calendars/primary/events/ev1?sendUpdates=all",
      "DELETE /calendars/primary/events/ev1?sendUpdates=none",
    ]);
    expect(calls[0]?.body).toEqual({
      summary: "Tavi test",
      start: { dateTime: "2026-11-10T09:00:00Z" },
      end: { dateTime: "2026-11-10T09:15:00Z" },
    });
    expect(calls[1]?.body).toEqual({ attendees: [{ email: "ana@example.com" }] });
    expect(calls[3]?.body).toEqual({
      attendees: [
        { email: "lead@example.com", responseStatus: "accepted" },
        { email: "you@gmail.com", responseStatus: "declined", self: true },
      ],
    });
  });

  it("refuses to answer an event it is not invited to", async () => {
    const { calls, cal } = calendar(() => Response.json({ ...standup, attendees: [{ email: "lead@example.com" }] }));
    await expect(cal.respond("primary", "ev1", "accepted")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("reads busy periods per calendar, and the calendar list", async () => {
    const { cal } = calendar((call) =>
      call.path === "/freeBusy"
        ? Response.json({ calendars: { primary: { busy: [{ start: "2026-11-09T09:00:00Z", end: "2026-11-09T10:00:00Z" }, {}] } } })
        : Response.json({ items: [{ id: "primary", summary: "You", primary: true, accessRole: "owner" }, { summary: "no id" }] }),
    );
    expect(await cal.freeBusy(["primary", "other"], range)).toEqual({
      primary: [{ start: "2026-11-09T09:00:00Z", end: "2026-11-09T10:00:00Z" }],
      other: [],
    });
    expect(await cal.listCalendars()).toEqual([{ id: "primary", summary: "You", primary: true, accessRole: "owner" }]);
  });

  it("says a refused sign-in, a calendar access not allowed and an API turned off, each as its own fix", async () => {
    const answer = (status: number, body: unknown) => calendar(() => Response.json(body, { status })).cal.listCalendars();
    await expect(answer(401, {})).rejects.toMatchObject({ code: "NOT_AUTHORIZED", details: { signIn: true } });
    const narrow = answer(403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } });
    await expect(narrow).rejects.toMatchObject({ code: "NOT_AUTHORIZED", details: { signIn: true } });
    await expect(answer(403, { error: { details: [{ reason: "SERVICE_DISABLED" }] } })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(answer(404, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(answer(400, {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const failed = await answer(500, {}).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(TaviError);
    expect(String((failed as TaviError).message)).not.toContain(TOKEN);
  });
});
