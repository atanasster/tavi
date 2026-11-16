import {
  IDEA_CATEGORIES,
  IDEA_FOR_YOU_MAX,
  IdeasBriefAnswerSchema,
  IdeasChipsAnswerSchema,
  IdeasIdeaAnswerSchema,
  IdeasListAnswerSchema,
  IdeasRecurAnswerSchema,
  IdeasRefreshAnswerSchema,
  IdeasRemindAnswerSchema,
  IdeasResetAnswerSchema,
  IdeasSettingsAnswerSchema,
  IdeasTryAnswerSchema,
  type Idea,
  type IdeaCategory,
  type IdeaRun,
  type IdeasBriefAnswer,
  type IdeasChipsAnswer,
  type IdeasIdeaAnswer,
  type IdeasListAnswer,
  type IdeasRecurAnswer,
  type IdeasRefreshAnswer,
  type IdeasRemindAnswer,
  type IdeasResetAnswer,
  type IdeasSettingsAnswer,
  type IdeasTryAnswer,
  type IdeaSources,
} from "@tavi/contracts";

import { whenLocal } from "../../lib/time.js";
import { read, type Outcome, type Readable, type SettingsClient } from "../../lib/ipc.js";

/**
 * The Ideas tab's side of the owner's `ideas` command. Every answer is read through the contract's schema, so an
 * owner of another build is a failure to read, never a page that guesses.
 */

function ideas<T>(client: SettingsClient, payload: Record<string, unknown>, schema: Readable<T>): Promise<Outcome<T>> {
  return read(client, "ideas", payload, schema);
}

/** The active ideas; with `includeInactive`, also the tried, snoozed and dismissed ones Settings → Ideas can restore. */
export function listIdeas(client: SettingsClient, workspaceId: string, includeInactive = false): Promise<Outcome<IdeasListAnswer>> {
  return ideas(client, { action: "list", workspaceId, ...(includeInactive ? { includeInactive } : {}) }, IdeasListAnswerSchema);
}

/** Undo *Not now* or *Not interested*: the idea is offered again. */
export function restoreIdea(client: SettingsClient, workspaceId: string, id: string): Promise<Outcome<IdeasIdeaAnswer>> {
  return ideas(client, { action: "restore", workspaceId, id }, IdeasIdeaAnswerSchema);
}

/** *Make it recurring*: the routine the idea would be, to confirm before anything is created. */
export function recurIdea(client: SettingsClient, workspaceId: string, id: string): Promise<Outcome<IdeasRecurAnswer>> {
  return ideas(client, { action: "recur", workspaceId, id }, IdeasRecurAnswerSchema);
}

/** The routine was created: the idea is done. */
export function madeRecurring(
  client: SettingsClient,
  workspaceId: string,
  id: string,
  routineId: string,
): Promise<Outcome<IdeasIdeaAnswer>> {
  return ideas(client, { action: "made-recurring", workspaceId, id, routineId }, IdeasIdeaAnswerSchema);
}

/** *Remind me*: a reminder that says the idea at `at`; it runs nothing. */
export function remindIdea(client: SettingsClient, workspaceId: string, id: string, at: string): Promise<Outcome<IdeasRemindAnswer>> {
  return ideas(client, { action: "remind", workspaceId, id, at }, IdeasRemindAnswerSchema);
}

/** Start over: `ledger` forgets every dismissal, snooze and source set aside; `categories` unmutes every section. */
export function resetIdeas(client: SettingsClient, workspaceId: string, what: "ledger" | "categories"): Promise<Outcome<IdeasResetAnswer>> {
  return ideas(client, { action: "reset", workspaceId, what }, IdeasResetAnswerSchema);
}

export function ideasSettings(client: SettingsClient, workspaceId: string): Promise<Outcome<IdeasSettingsAnswer>> {
  return ideas(client, { action: "settings", workspaceId }, IdeasSettingsAnswerSchema);
}

/** The switches a page may change; the provider and the digest are the terminal's. */
export function changeIdeasSettings(
  client: SettingsClient,
  workspaceId: string,
  changes: { readonly enabled?: boolean; readonly chips?: boolean; readonly sources?: Partial<IdeaSources> },
): Promise<Outcome<IdeasSettingsAnswer>> {
  return ideas(client, { action: "set-settings", workspaceId, changes }, IdeasSettingsAnswerSchema);
}

/** The empty chat's chips: an idea's, a capability's, or "Continue" with the chat it opens. */
export function ideaChips(client: SettingsClient, workspaceId: string): Promise<Outcome<IdeasChipsAnswer>> {
  return ideas(client, { action: "chips", workspaceId }, IdeasChipsAnswerSchema);
}

/** *Try it*: the prompt for a new chat's composer, the idea marked tried. Nothing is sent. */
export function tryIdea(client: SettingsClient, workspaceId: string, id: string): Promise<Outcome<IdeasTryAnswer>> {
  return ideas(client, { action: "try", workspaceId, id }, IdeasTryAnswerSchema);
}

export function refreshIdeas(client: SettingsClient, workspaceId: string): Promise<Outcome<IdeasRefreshAnswer>> {
  return ideas(client, { action: "refresh", workspaceId }, IdeasRefreshAnswerSchema);
}

export function getBrief(client: SettingsClient, workspaceId: string): Promise<Outcome<IdeasBriefAnswer>> {
  return ideas(client, { action: "brief", workspaceId }, IdeasBriefAnswerSchema);
}

export function setBrief(client: SettingsClient, workspaceId: string, text: string): Promise<Outcome<IdeasBriefAnswer>> {
  return ideas(client, { action: "set-brief", workspaceId, text }, IdeasBriefAnswerSchema);
}

/** A signal about one idea, or about its section or one of its sources. */
export function ideaFeedback(
  client: SettingsClient,
  workspaceId: string,
  fields: { readonly signal: string; readonly id?: string; readonly category?: IdeaCategory; readonly basisRef?: string },
): Promise<Outcome<IdeasIdeaAnswer>> {
  return ideas(client, { action: "feedback", workspaceId, ...fields }, IdeasIdeaAnswerSchema);
}

export function pinIdea(client: SettingsClient, workspaceId: string, id: string, pinned: boolean): Promise<Outcome<IdeasIdeaAnswer>> {
  return ideas(client, { action: pinned ? "pin" : "unpin", workspaceId, id }, IdeasIdeaAnswerSchema);
}

/** The page's sections: "For you" takes the best four; each section then shows the rest of its own. */
export interface IdeasLayout {
  readonly forYou: readonly Idea[];
  readonly sections: readonly { readonly category: IdeaCategory; readonly ideas: readonly Idea[] }[];
}

/** How many ideas a section shows before *More*. */
export const IDEAS_SECTION_SHOWN = 3;

/** The active ideas as the page lays them out; the list comes best first, pinned ones ahead. */
export function ideasLayout(listed: readonly Idea[]): IdeasLayout {
  const active = listed.filter((idea) => idea.status === "active");
  const forYou = active.slice(0, IDEA_FOR_YOU_MAX);
  const rest = active.slice(IDEA_FOR_YOU_MAX);
  return {
    forYou,
    sections: IDEA_CATEGORIES.map((category) => ({ category, ideas: rest.filter((idea) => idea.category === category) })).filter(
      (section) => section.ideas.length > 0,
    ),
  };
}

/**
 * When ideas were last looked for, and why that look came to nothing when it
 * was skipped or failed: otherwise a quiet tab reads as one that simply has
 * nothing new, and the person never learns the look did not happen.
 */
export function lastLooked(run: IdeaRun | undefined, timeZone: string | undefined): string {
  if (run === undefined) return "Not looked yet.";
  const when = `Last looked ${whenLocal(run.startedAt, timeZone)}`;
  const reason = run.outcome === "failed" || run.outcome === "skipped" ? run.reason?.trim() : undefined;
  if (reason === undefined || reason === "") return `${when}.`;
  return /[.!?]$/u.test(reason) ? `${when}: ${reason}` : `${when}: ${reason}.`;
}

/** What a finished look found, as the page says it once a refresh's run is over. */
export function runNote(run: IdeaRun): string {
  switch (run.outcome) {
    case "generated":
      return "New ideas are in.";
    case "unchanged":
      return "Nothing new to suggest yet.";
    default:
      return run.reason?.trim() || (run.outcome === "skipped" ? "The look was skipped." : "The look failed.");
  }
}
