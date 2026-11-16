/**
 * A channel account's calendar, for the agent's calendar tools: what a channel whose app is `calendar`
 * ships (Google's account carries Gmail and Calendar under one sign-in), so the owner's tools are the
 * same for every such channel and name none. It asks only `accessToken()`; it never sees the refresh
 * token or the OAuth client.
 */

/** One calendar the account sees. */
export interface CalendarListed {
  readonly id: string;
  readonly summary: string;
  readonly primary?: boolean;
  /** `owner`, `writer`, `reader` or `freeBusyReader`, as the provider names its access. */
  readonly accessRole?: string;
  readonly timeZone?: string;
}

/** When an event happens: a date-time with its offset, or an all-day date. */
export interface CalendarWhen {
  readonly dateTime?: string;
  readonly date?: string;
  readonly timeZone?: string;
}

/** An event as the tools show it: never its attachments or conference secrets. */
export interface CalendarEvent {
  readonly id: string;
  readonly calendarId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start?: CalendarWhen;
  readonly end?: CalendarWhen;
  readonly status?: string;
  readonly organizer?: string;
  readonly attendees?: readonly { readonly email: string; readonly responseStatus?: string; readonly self?: boolean }[];
  readonly htmlLink?: string;
  /** The account's own answer to an invitation, when it is an attendee. */
  readonly myResponse?: string;
}

/** A window of time to list, search or find free time in. */
export interface CalendarRange {
  readonly timeMin: string;
  readonly timeMax: string;
}

/** What an event is made or changed to: only what is given changes. */
export interface CalendarEventInput {
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start?: CalendarWhen;
  readonly end?: CalendarWhen;
  readonly attendees?: readonly string[];
}

/** Whether attendees are emailed about a change: the approval card says which. */
export type CalendarNotify = "all" | "none";

export interface ChannelCalendar {
  listCalendars(signal?: AbortSignal): Promise<readonly CalendarListed[]>;
  listEvents(
    calendarId: string,
    range: CalendarRange,
    options: { readonly query?: string; readonly max: number },
    signal?: AbortSignal,
  ): Promise<readonly CalendarEvent[]>;
  getEvent(calendarId: string, eventId: string, signal?: AbortSignal): Promise<CalendarEvent>;
  /** Each calendar's busy periods in the range. */
  freeBusy(
    calendarIds: readonly string[],
    range: CalendarRange,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, readonly { readonly start: string; readonly end: string }[]>>>;
  createEvent(calendarId: string, event: CalendarEventInput, notify: CalendarNotify, signal?: AbortSignal): Promise<CalendarEvent>;
  updateEvent(
    calendarId: string,
    eventId: string,
    change: CalendarEventInput,
    notify: CalendarNotify,
    signal?: AbortSignal,
  ): Promise<CalendarEvent>;
  /** The account's own answer to an invitation: tells the organizer. */
  respond(
    calendarId: string,
    eventId: string,
    response: "accepted" | "declined" | "tentative",
    signal?: AbortSignal,
  ): Promise<CalendarEvent>;
  deleteEvent(calendarId: string, eventId: string, notify: CalendarNotify, signal?: AbortSignal): Promise<void>;
}

/** What a channel ships for its accounts' calendars; `Fetch` is the runtime's `fetch`, which this package does not type. */
export interface ChannelCalendarKit<Fetch = unknown> {
  /** The most events one list or search returns. */
  readonly listMax: number;
  open(options: { readonly accessToken: () => Promise<string>; readonly fetch?: Fetch; readonly apiBaseUrl?: string }): ChannelCalendar;
}
