import type { z } from "zod";
import {
  IDEA_CATEGORY_LABELS,
  IdeasBriefAnswerSchema,
  IdeasIdeaAnswerSchema,
  IdeasListAnswerSchema,
  IdeasRefreshAnswerSchema,
  IdeasResetAnswerSchema,
  IdeasSettingsAnswerSchema,
  IdeasTryAnswerSchema,
  type Idea,
  type IdeasBriefAnswer,
  type IdeasIdeaAnswer,
  type IdeasListAnswer,
  type IdeasPayload,
  type IdeasRefreshAnswer,
  type IdeasResetAnswer,
  type IdeaRun,
  type IdeasSettingsAnswer,
  type IdeasTryAnswer,
} from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

import type { IdeasCommandOptions } from "./parse.js";
import { indentedLines, pageWidth, terminalText } from "../../shared/terminal-text.js";
import { minuteUtc } from "../../shared/minute-utc.js";

/**
 * `tavi ideas`: the payload each action sends — the
 * same on the owner and offline — and what the terminal prints. A terminal has
 * no composer, so `try` prints the prompt to paste into a chat.
 */

/** The answer an action's payload gets, as the owner sends it: read through its schema, never cast. */
export function ideasAnswerSchema(options: IdeasCommandOptions): z.ZodType {
  switch (options.action) {
    case "list":
      return IdeasListAnswerSchema;
    case "provider":
      return options.provider === undefined ? IdeasListAnswerSchema : IdeasSettingsAnswerSchema;
    case "try":
      return IdeasTryAnswerSchema;
    case "dismiss":
    case "restore":
      return IdeasIdeaAnswerSchema;
    case "refresh":
      return IdeasRefreshAnswerSchema;
    case "brief":
      return IdeasBriefAnswerSchema;
    case "reset":
      return IdeasResetAnswerSchema;
    case "digest":
    case "hours":
    case "budget":
    case "prepare":
    case "on":
    case "off":
      return IdeasSettingsAnswerSchema;
  }
}

export function ideasPayload(options: IdeasCommandOptions): IdeasPayload {
  const workspaceId = options.workspaceId;
  const id = options.ideaId ?? "";
  switch (options.action) {
    case "list":
      return { action: "list", workspaceId, ...(options.all === true ? { includeInactive: true } : {}) };
    case "try":
      return { action: "try", workspaceId, id };
    case "dismiss":
      return { action: "feedback", workspaceId, signal: "not-interested", id };
    case "restore":
      return { action: "restore", workspaceId, id };
    case "provider":
      return options.provider === undefined
        ? { action: "list", workspaceId }
        : { action: "set-settings", workspaceId, changes: { provider: options.provider } };
    case "refresh":
      return { action: "refresh", workspaceId };
    case "brief":
      return options.brief === undefined ? { action: "brief", workspaceId } : { action: "set-brief", workspaceId, text: options.brief };
    case "reset":
      return { action: "reset", workspaceId, what: options.reset === "sections" ? "categories" : "ledger" };
    case "digest":
      return options.digest === undefined
        ? { action: "settings", workspaceId }
        : { action: "set-settings", workspaceId, changes: { digest: options.digest } };
    case "hours":
      return options.hours === undefined
        ? { action: "settings", workspaceId }
        : { action: "set-settings", workspaceId, changes: { hours: options.hours } };
    case "budget":
      return options.budget === undefined
        ? { action: "settings", workspaceId }
        : { action: "set-settings", workspaceId, changes: { dailyTokens: options.budget } };
    case "prepare":
      return options.prepareExternal === undefined
        ? { action: "settings", workspaceId }
        : { action: "set-settings", workspaceId, changes: { prepareExternal: options.prepareExternal } };
    case "on":
    case "off":
      return { action: "set-settings", workspaceId, changes: { enabled: options.action === "on" } };
  }
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Whether an action writes: a lost answer to a write may still have been applied. */
export function ideasMutates(options: IdeasCommandOptions): boolean {
  return !(
    options.action === "list" ||
    (options.action === "brief" && options.brief === undefined) ||
    (options.action === "provider" && options.provider === undefined) ||
    (options.action === "digest" && options.digest === undefined) ||
    (options.action === "hours" && options.hours === undefined) ||
    (options.action === "budget" && options.budget === undefined) ||
    (options.action === "prepare" && options.prepareExternal === undefined)
  );
}

/** The last run, in one line: when nothing came of it, the reason a person reads (a provider's words, cleaned). */
function lastRunLine(run: IdeaRun): string {
  const when = `Last run ${minuteUtc(run.startedAt)} (${run.trigger})`;
  switch (run.outcome) {
    case "generated":
      // A provider's left-out ideas: the rules they broke, on the line below.
      return `${when}: ${run.generated} offered${run.dropped === 0 ? "" : `, ${run.dropped} left out`}${run.reason === undefined ? "" : `\n  ${terminalText(run.reason)}`}`;
    case "unchanged":
      return `${when}: nothing new to look at`;
    case "running":
      return `${when}: still looking`;
    default:
      return `${when}: ${run.outcome}${run.reason === undefined ? "" : ` — ${terminalText(run.reason)}`}`;
  }
}

/** An idea: its id and title, then its pitch on indented lines cut at spaces to `width`, not where the terminal breaks a word. */
function ideaLine(idea: Idea, width: number): string {
  const marks = [
    idea.pinned ? "pinned" : undefined,
    idea.prepared === undefined ? undefined : "ready",
    idea.status === "active" ? undefined : idea.status,
  ].filter((mark) => mark !== undefined);
  // What a provider wrote is printed without control characters: a plugin's text cannot drive the terminal.
  return `${idea.id}\t${idea.icon} ${terminalText(idea.title)}${marks.length === 0 ? "" : ` (${marks.join(", ")})`}\n${indentedLines(terminalText(idea.pitch), "    ", width).join("\n")}`;
}

export function ideasResultText(options: IdeasCommandOptions, result: unknown, columns: number | undefined = undefined): string {
  switch (options.action) {
    case "list": {
      const answer = result as IdeasListAnswer;
      const muted =
        answer.mutedCategories.length === 0
          ? ""
          : `\nMuted: ${answer.mutedCategories.map((category) => IDEA_CATEGORY_LABELS[category]).join(", ")}`;
      const next = answer.nextAt === undefined ? "" : `\nNext run ${minuteUtc(answer.nextAt)}`;
      const last = `${answer.lastRun === undefined ? "" : `\n${lastRunLine(answer.lastRun)}`}${next}`;
      // Off, nothing listed is offered anywhere: said first, so the list reads as what is kept, not what is shown.
      const off = answer.enabled === false ? "Ideas are off: none are offered (tavi ideas on)\n" : "";
      if (answer.ideas.length === 0) return `${off}No ideas yet${muted}${last}`;
      const sections = [...new Set(answer.ideas.map((idea) => idea.category))];
      const body = sections
        .map(
          (category) =>
            `${IDEA_CATEGORY_LABELS[category]}\n${answer.ideas
              .filter((idea) => idea.category === category)
              .map((idea) => ideaLine(idea, pageWidth(columns)))
              .join("\n")}`,
        )
        .join("\n\n");
      return `${off}${body}${muted}${last}`;
    }
    case "try":
      return terminalText((result as IdeasTryAnswer).prompt);
    case "dismiss": {
      const idea = (result as IdeasIdeaAnswer).idea;
      return idea === undefined ? "Dismissed" : `Dismissed ${idea.id}: it will not be offered again`;
    }
    case "restore": {
      const idea = (result as IdeasIdeaAnswer).idea;
      return idea === undefined ? "Restored" : `Restored ${idea.id}: ${terminalText(idea.title)}`;
    }
    case "provider": {
      if (options.provider !== undefined) return `Ideas now come from ${(result as IdeasSettingsAnswer).settings.provider}`;
      const answer = result as IdeasListAnswer;
      if (answer.providers.length === 0)
        return `In use: ${answer.provider}. None is listed: no owner is running, or it has no ideas provider installed`;
      return answer.providers
        .map(
          (provider) =>
            `${provider.id === answer.provider ? "*" : " "} ${provider.id}\t${provider.kind}\t${provider.ready ? "ready" : "not ready"}\treceives: ${provider.receives.join(", ") || "nothing"}`,
        )
        .join("\n");
    }
    case "refresh": {
      const status = (result as IdeasRefreshAnswer).status;
      if (status === "started") return "Looking for new ideas; tavi ideas list shows them, and how the run went";
      if (status === "queued") return "New ideas are already being looked for; this refresh follows";
      return "New ideas are being looked for elsewhere; refresh again once that run ends";
    }
    case "brief": {
      const text = (result as IdeasBriefAnswer).text;
      if (options.brief !== undefined) return text === "" ? "Cleared the ideas brief" : "Saved the ideas brief";
      return text === "" ? "No ideas brief" : terminalText(text);
    }
    case "reset": {
      const cleared = (result as IdeasResetAnswer).cleared;
      return options.reset === "sections"
        ? `Unmuted ${plural(cleared, "section")}`
        : `Forgot ${plural(cleared, "dismissal")}, ${cleared === 1 ? "snooze" : "snoozes"} and ${cleared === 1 ? "exclusion" : "exclusions"}`;
    }
    case "hours": {
      const hours = (result as IdeasSettingsAnswer).settings.hours;
      return `Ideas look once a day between ${hours.start} and ${hours.end}, in the workspace's timezone`;
    }
    case "budget": {
      const tokens = (result as IdeasSettingsAnswer).settings.dailyTokens;
      return tokens === 0
        ? "Ideas' model turns are off: ideas keep their plain wording"
        : `Ideas' model turns may spend ${tokens} tokens a day`;
    }
    case "prepare":
      return (result as IdeasSettingsAnswer).settings.prepareExternal === true
        ? "A provider that reads your memory, tasks or brief may prepare its ideas' first steps"
        : "Only a provider that reads nothing of yours (the built-in included) prepares ideas' first steps";
    case "digest": {
      const digest = (result as IdeasSettingsAnswer).settings.digest;
      return digest === undefined
        ? "No weekly ideas digest"
        : `The ideas digest goes to your chat on ${terminalText(digest.channel)} each ${WEEKDAY_NAMES[digest.weekday] ?? "week"}, inside your ideas hours`;
    }
    case "on":
    case "off":
      return (result as IdeasSettingsAnswer).settings.enabled ? "Ideas are on" : "Ideas are off";
  }
}
