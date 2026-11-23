import type { z } from "zod";
import {
  ideaCategoryLabel,
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
import { coreEnglish, type CoreKey, type CoreT } from "@tavi/contracts/locales/core";

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
function lastRunLine(run: IdeaRun, t: CoreT): string {
  const when = t("cli.ideas.lastRun", { at: minuteUtc(run.startedAt), trigger: run.trigger });
  switch (run.outcome) {
    case "generated":
      // A provider's left-out ideas: the rules they broke, on the line below.
      return `${t("cli.ideas.run.generated", { when, n: String(run.generated) })}${run.dropped === 0 ? "" : t("cli.ideas.run.leftOut", { n: String(run.dropped) })}${run.reason === undefined ? "" : `\n  ${terminalText(run.reason)}`}`;
    case "unchanged":
      return t("cli.ideas.run.unchanged", { when });
    case "running":
      return t("cli.ideas.run.running", { when });
    default:
      return `${when}: ${run.outcome}${run.reason === undefined ? "" : ` — ${terminalText(run.reason)}`}`;
  }
}

/** An idea: its id and title, then its pitch on indented lines cut at spaces to `width`, not where the terminal breaks a word. */
function ideaLine(idea: Idea, width: number, t: CoreT): string {
  const marks = [
    idea.pinned ? t("cli.ideas.mark.pinned") : undefined,
    idea.prepared === undefined ? undefined : t("cli.ideas.mark.ready"),
    idea.status === "active" ? undefined : idea.status,
  ].filter((mark) => mark !== undefined);
  // What a provider wrote is printed without control characters: a plugin's text cannot drive the terminal.
  return `${idea.id}\t${idea.icon} ${terminalText(idea.title)}${marks.length === 0 ? "" : ` (${marks.join(", ")})`}\n${indentedLines(terminalText(idea.pitch), "    ", width).join("\n")}`;
}

/** What `tavi ideas <action>` prints, in `t`'s words: English as it always printed. */
export function ideasResultText(
  options: IdeasCommandOptions,
  result: unknown,
  columns: number | undefined = undefined,
  t: CoreT = coreEnglish,
): string {
  switch (options.action) {
    case "list": {
      const answer = result as IdeasListAnswer;
      const muted =
        answer.mutedCategories.length === 0
          ? ""
          : `\n${t("cli.ideas.muted", { categories: answer.mutedCategories.map((category) => ideaCategoryLabel(category, t)).join(", ") })}`;
      const next = answer.nextAt === undefined ? "" : `\n${t("cli.ideas.nextRun", { at: minuteUtc(answer.nextAt) })}`;
      const last = `${answer.lastRun === undefined ? "" : `\n${lastRunLine(answer.lastRun, t)}`}${next}`;
      // Off, nothing listed is offered anywhere: said first, so the list reads as what is kept, not what is shown.
      const off = answer.enabled === false ? `${t("cli.ideas.off")}\n` : "";
      if (answer.ideas.length === 0) return `${off}${t("cli.ideas.none")}${muted}${last}`;
      const sections = [...new Set(answer.ideas.map((idea) => idea.category))];
      const body = sections
        .map(
          (category) =>
            `${ideaCategoryLabel(category, t)}\n${answer.ideas
              .filter((idea) => idea.category === category)
              .map((idea) => ideaLine(idea, pageWidth(columns), t))
              .join("\n")}`,
        )
        .join("\n\n");
      return `${off}${body}${muted}${last}`;
    }
    case "try":
      return terminalText((result as IdeasTryAnswer).prompt);
    case "dismiss": {
      const idea = (result as IdeasIdeaAnswer).idea;
      return idea === undefined ? t("cli.ideas.dismissed") : t("cli.ideas.dismissedOne", { id: idea.id });
    }
    case "restore": {
      const idea = (result as IdeasIdeaAnswer).idea;
      return idea === undefined ? t("cli.ideas.restored") : t("cli.ideas.restoredOne", { id: idea.id, title: terminalText(idea.title) });
    }
    case "provider": {
      if (options.provider !== undefined)
        return t("cli.ideas.providerNow", { provider: (result as IdeasSettingsAnswer).settings.provider });
      const answer = result as IdeasListAnswer;
      if (answer.providers.length === 0) return t("cli.ideas.providerNone", { provider: answer.provider });
      return answer.providers
        .map(
          (provider) =>
            `${provider.id === answer.provider ? "*" : " "} ${provider.id}\t${provider.kind}\t${t(provider.ready ? "cli.ideas.providerReady" : "cli.ideas.providerNotReady")}\t${t("cli.ideas.providerReceives", { what: provider.receives.join(", ") || t("cli.ideas.providerNothing") })}`,
        )
        .join("\n");
    }
    case "refresh": {
      const status = (result as IdeasRefreshAnswer).status;
      if (status === "started") return t("cli.ideas.refresh.started");
      if (status === "queued") return t("cli.ideas.refresh.queued");
      return t("cli.ideas.refresh.elsewhere");
    }
    case "brief": {
      const text = (result as IdeasBriefAnswer).text;
      if (options.brief !== undefined) return t(text === "" ? "cli.ideas.brief.cleared" : "cli.ideas.brief.saved");
      return text === "" ? t("cli.ideas.brief.none") : terminalText(text);
    }
    case "reset": {
      const cleared = (result as IdeasResetAnswer).cleared;
      return t(options.reset === "sections" ? "cli.ideas.reset.sections" : "cli.ideas.reset.forgot", {
        count: cleared,
        n: String(cleared),
      });
    }
    case "hours": {
      const hours = (result as IdeasSettingsAnswer).settings.hours;
      return t("cli.ideas.hours", { start: hours.start, end: hours.end });
    }
    case "budget": {
      const tokens = (result as IdeasSettingsAnswer).settings.dailyTokens;
      return tokens === 0 ? t("cli.ideas.budget.off") : t("cli.ideas.budget.on", { count: tokens, n: String(tokens) });
    }
    case "prepare":
      return t(
        (result as IdeasSettingsAnswer).settings.prepareExternal === true ? "cli.ideas.prepare.external" : "cli.ideas.prepare.builtin",
      );
    case "digest": {
      const digest = (result as IdeasSettingsAnswer).settings.digest;
      return digest === undefined
        ? t("cli.ideas.digest.none")
        : t("cli.ideas.digest.weekly", {
            channel: terminalText(digest.channel),
            weekday:
              digest.weekday >= 0 && digest.weekday <= 6 ? t(`date.weekday.${digest.weekday}` as CoreKey) : t("cli.ideas.digest.week"),
          });
    }
    case "on":
    case "off":
      return t((result as IdeasSettingsAnswer).settings.enabled ? "cli.ideas.on" : "cli.ideas.offShort");
  }
}
