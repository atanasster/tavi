import { fetchWithTimeout, readJson, redactedError } from "@tavi/channel-kit";
import {
  TaviError,
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarListed,
  type CalendarNotify,
  type CalendarRange,
  type CalendarWhen,
  type ChannelCalendar,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

/**
 * A Google account's calendar, over Google's Calendar API (v3), not its Developer Preview MCP server:
 * the same scopes, without the preview program, a second API or an "agentic" client. Like the
 * mailbox, it asks only `accessToken()`, and never sees the refresh token or the OAuth client.
 */

const API = "https://www.googleapis.com/calendar/v3";
const REQUEST_TIMEOUT_MS = 30_000;
/** The most events one list or search returns. */
export const GOOGLE_CALENDAR_LIST_MAX = 50;
/** The scopes the calendar asks for: its list, free or busy, and events. Never the whole `calendar` (sharing, settings). */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export interface GoogleCalendarOptions {
  readonly accessToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly apiBaseUrl?: string;
  readonly requestTimeoutMs?: number;
}

interface GoogleWhen {
  readonly dateTime?: unknown;
  readonly date?: unknown;
  readonly timeZone?: unknown;
}

interface GoogleEvent {
  readonly id?: unknown;
  readonly summary?: unknown;
  readonly description?: unknown;
  readonly location?: unknown;
  readonly start?: GoogleWhen;
  readonly end?: GoogleWhen;
  readonly status?: unknown;
  readonly organizer?: { readonly email?: unknown };
  readonly attendees?: readonly { readonly email?: unknown; readonly responseStatus?: unknown; readonly self?: unknown }[];
  readonly htmlLink?: unknown;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

function whenOf(value: GoogleWhen | undefined): CalendarWhen | undefined {
  if (value === undefined) return undefined;
  const dateTime = text(value.dateTime);
  const date = text(value.date);
  const timeZone = text(value.timeZone);
  if (dateTime === undefined && date === undefined) return undefined;
  return definedOnly({ dateTime, date, timeZone });
}

/** An event as the tools show it: what it is, when, where and with whom; never its attachments or conference secrets. */
function eventOf(calendarId: string, event: GoogleEvent): CalendarEvent {
  const id = text(event.id);
  if (id === undefined) throw new TaviError("UNAVAILABLE", "Google Calendar answered with an event that has no id");
  const attendees = (event.attendees ?? []).flatMap((attendee) => {
    const email = text(attendee.email);
    if (email === undefined) return [];
    const responseStatus = text(attendee.responseStatus);
    return [{ email, ...(responseStatus === undefined ? {} : { responseStatus }), ...(attendee.self === true ? { self: true } : {}) }];
  });
  const mine = attendees.find((attendee) => attendee.self === true)?.responseStatus;
  const start = whenOf(event.start);
  const end = whenOf(event.end);
  const fields: Record<string, unknown> = {
    summary: text(event.summary),
    description: text(event.description),
    location: text(event.location),
    status: text(event.status),
    organizer: text(event.organizer?.email),
    htmlLink: text(event.htmlLink),
    myResponse: mine,
  };
  return {
    id,
    calendarId,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    ...(attendees.length === 0 ? {} : { attendees }),
  };
}

/** What Google is sent for an event made or changed: only the fields given. */
function bodyOf(event: CalendarEventInput): Record<string, unknown> {
  return definedOnly({
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: event.start,
    end: event.end,
    attendees: event.attendees?.map((email) => ({ email })),
  });
}

export class GoogleCalendar implements ChannelCalendar {
  readonly #options: GoogleCalendarOptions;

  constructor(options: GoogleCalendarOptions) {
    this.#options = options;
  }

  /** One Calendar API call; its errors never carry the token, and a refusal is said with its status. */
  async #call(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const token = await this.#options.accessToken();
    let response: Response;
    let body: unknown;
    try {
      response = await fetchWithTimeout(
        this.#options.fetch ?? globalThis.fetch,
        `${this.#options.apiBaseUrl ?? API}${path}`,
        {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            authorization: `Bearer ${token}`,
            accept: "application/json",
          },
        },
        this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        signal,
      );
      body = response.status === 204 ? undefined : await readJson(response);
    } catch (error) {
      throw new TaviError("UNAVAILABLE", redactedError(error, [token]));
    }
    if (response.status === 404 || response.status === 410)
      throw new TaviError("NOT_FOUND", "Google Calendar has no such calendar or event");
    // Its token refused (revoked at Google before it expired): a sign-in to make, as a lapsed one is.
    if (response.status === 401)
      throw new TaviError("NOT_AUTHORIZED", "Google Calendar refused its sign-in (HTTP 401)", { details: { signIn: true } });
    if (response.status === 403) {
      const reason = JSON.stringify(body ?? "");
      // The account signed in without the calendar's access (Google's consent lets each box be unticked), or the API is off.
      if (/insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(reason))
        throw new TaviError("NOT_AUTHORIZED", "This Google account did not allow the calendar's access: sign in again and tick every box", {
          details: { signIn: true },
        });
      if (/SERVICE_DISABLED|accessNotConfigured/i.test(reason))
        throw new TaviError(
          "NOT_CONFIGURED",
          "The Google Calendar API is off in your Google client's project: enable it in the Cloud console",
        );
    }
    // A request Google calls malformed (a time it cannot read, an unknown calendar id): the call's to fix, not an outage.
    if (response.status === 400) throw new TaviError("INVALID_INPUT", "Google Calendar could not read that request (HTTP 400)");
    if (!response.ok) throw new TaviError("UNAVAILABLE", `Google Calendar refused the request (HTTP ${String(response.status)})`);
    return body;
  }

  async listCalendars(signal?: AbortSignal): Promise<readonly CalendarListed[]> {
    const listed = (await this.#call("/users/me/calendarList?maxResults=250", {}, signal)) as
      | { items?: readonly { id?: unknown; summary?: unknown; primary?: unknown; accessRole?: unknown; timeZone?: unknown }[] }
      | undefined;
    return (listed?.items ?? []).flatMap((item) => {
      const id = text(item.id);
      if (id === undefined) return [];
      const accessRole = text(item.accessRole);
      const timeZone = text(item.timeZone);
      return [
        {
          id,
          summary: text(item.summary) ?? id,
          ...(item.primary === true ? { primary: true } : {}),
          ...(accessRole === undefined ? {} : { accessRole }),
          ...(timeZone === undefined ? {} : { timeZone }),
        },
      ];
    });
  }

  async listEvents(
    calendarId: string,
    range: CalendarRange,
    options: { readonly query?: string; readonly max: number },
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(options.max, GOOGLE_CALENDAR_LIST_MAX)),
      ...(options.query === undefined ? {} : { q: options.query }),
    });
    const listed = (await this.#call(`/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`, {}, signal)) as
      | { items?: readonly GoogleEvent[] }
      | undefined;
    return (listed?.items ?? []).filter((event) => text(event.id) !== undefined).map((event) => eventOf(calendarId, event));
  }

  async getEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<CalendarEvent> {
    const event = (await this.#call(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {},
      signal,
    )) as GoogleEvent;
    return eventOf(calendarId, event);
  }

  async freeBusy(
    calendarIds: readonly string[],
    range: CalendarRange,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, readonly { readonly start: string; readonly end: string }[]>>> {
    const answer = (await this.#call(
      "/freeBusy",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeMin: range.timeMin, timeMax: range.timeMax, items: calendarIds.map((id) => ({ id })) }),
      },
      signal,
    )) as { calendars?: Readonly<Record<string, { busy?: readonly { start?: unknown; end?: unknown }[] }>> } | undefined;
    return Object.fromEntries(
      calendarIds.map((id) => [
        id,
        (answer?.calendars?.[id]?.busy ?? []).flatMap((period) => {
          const start = text(period.start);
          const end = text(period.end);
          return start === undefined || end === undefined ? [] : [{ start, end }];
        }),
      ]),
    );
  }

  async createEvent(calendarId: string, event: CalendarEventInput, notify: CalendarNotify, signal?: AbortSignal): Promise<CalendarEvent> {
    const made = (await this.#call(
      `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${notify}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyOf(event)) },
      signal,
    )) as GoogleEvent;
    return eventOf(calendarId, made);
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    change: CalendarEventInput,
    notify: CalendarNotify,
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    const changed = (await this.#call(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${notify}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(bodyOf(change)) },
      signal,
    )) as GoogleEvent;
    return eventOf(calendarId, changed);
  }

  async respond(
    calendarId: string,
    eventId: string,
    response: "accepted" | "declined" | "tentative",
    signal?: AbortSignal,
  ): Promise<CalendarEvent> {
    const event = await this.#call(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {}, signal);
    const attendees = ((event as GoogleEvent).attendees ?? []) as readonly Record<string, unknown>[];
    if (!attendees.some((attendee) => attendee["self"] === true))
      throw new TaviError("INVALID_INPUT", "this account is not invited to that event, so it has nothing to answer");
    const answered = attendees.map((attendee) => (attendee["self"] === true ? { ...attendee, responseStatus: response } : attendee));
    // Answering tells the organizer: Google sends the reply.
    const changed = (await this.#call(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ attendees: answered }) },
      signal,
    )) as GoogleEvent;
    return eventOf(calendarId, changed);
  }

  async deleteEvent(calendarId: string, eventId: string, notify: CalendarNotify, signal?: AbortSignal): Promise<void> {
    await this.#call(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${notify}`,
      { method: "DELETE" },
      signal,
    );
  }
}
