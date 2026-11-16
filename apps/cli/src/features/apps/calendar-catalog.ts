/**
 * A channel account's calendar tools, named: what `calendar-tools.ts` registers for each account whose
 * calendar is on, and what Connected apps lists on its page, from one place. They share the account's
 * part of their ids with its mailbox tools (`mailboxToolSlug`), so an account's tools read as one set.
 */

export const CALENDAR_TOOLS = [
  { name: "list_calendars", title: "List calendars", effect: "read-only", sink: "none" },
  { name: "list_events", title: "List events", effect: "read-only", sink: "none" },
  { name: "search_events", title: "Search events", effect: "read-only", sink: "none" },
  { name: "get_event", title: "Read an event", effect: "read-only", sink: "none" },
  { name: "free_busy", title: "Find free time", effect: "read-only", sink: "none" },
  { name: "create_event", title: "Create an event", effect: "external", sink: "message" },
  { name: "update_event", title: "Change an event", effect: "external", sink: "message" },
  { name: "respond_to_event", title: "Answer an invitation", effect: "external", sink: "message" },
  { name: "delete_event", title: "Delete an event", effect: "external", sink: "message" },
] as const;
