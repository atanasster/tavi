import { createHash } from "node:crypto";

import {
  type AgentWaitIntentRecord,
  type AgentWaitOutcome,
  type AskUserChoices,
  type AskUserOption,
  formatChoiceOption,
  maxRisk,
  newRoundToken,
  type ApprovalCallScopes,
  type ApprovalScope,
  ApprovalFormSchema,
  type ApprovalForm,
  type OutboundButton,
  type RiskLevel,
  toolGroupLabel,
  toolGroupScopeNote,
  approvalProvenanceLine,
  isTaintReason,
  requestSources,
  requestTainted,
  disarmUrls,
  approvalTitleOf,
  flaggedReasons,
} from "@tavi/contracts";
import { clip } from "@tavi/contracts/util";
import type { ApprovalRoundAnnouncement, ApprovalRoundSettlement } from "@tavi/agent-host/workflow";

import { formLines, type FormView } from "./form.js";

/** What the channel approvals say: rounds, questions and their buttons, and the commands a person types. */

/** A decision a person typed: `approve k3f9 session`, `reject k3f9 too risky`. */
export interface ApprovalCommand {
  readonly approved: boolean;
  /** A round token or a task id; absent means the conversation's own task. */
  readonly target?: string;
  readonly scope?: ApprovalScope;
  readonly note?: string;
}

export const SCOPES: readonly ApprovalScope[] = ["once", "session", "always"];
/** What a typed round token looks like (`RoundTokenSchema`), case aside. */
export const ROUND_TOKEN_SHAPE = /^[a-km-np-z2-9]{8}$/i;
/** What a task id looks like. */
export const TASK_ID_SHAPE = /^task-/;

/**
 * Parse a whole message as an approval command, or `null` when it is not one.
 * The grammar is `(approve|allow|reject|deny) [token|task-id] [once|session|always] [reason…]`;
 * a scope only follows an approval and a reason only follows a rejection, so an
 * ordinary sentence that happens to start with "approve" is not a command.
 */
export function parseApprovalCommand(text: string): ApprovalCommand | null {
  const words = text.trim().split(/\s+/);
  const verb = (words[0] ?? "").toLowerCase();
  if (!["approve", "allow", "reject", "deny"].includes(verb)) return null;
  const approved = verb === "approve" || verb === "allow";
  let index = 1;
  let target: string | undefined;
  const next = words[index];
  if (next !== undefined && /^[A-Za-z0-9._-]{1,128}$/.test(next) && !SCOPES.includes(next.toLowerCase() as ApprovalScope)) {
    target = next;
    index += 1;
  }
  if (approved) {
    const scopeWord = words[index]?.toLowerCase();
    let scope: ApprovalScope | undefined;
    if (scopeWord !== undefined && SCOPES.includes(scopeWord as ApprovalScope)) {
      scope = scopeWord as ApprovalScope;
      index += 1;
    }
    if (index < words.length) return null;
    return { approved, ...(target === undefined ? {} : { target }), ...(scope === undefined ? {} : { scope }) };
  }
  const note = words.slice(index).join(" ").trim();
  return { approved, ...(target === undefined ? {} : { target }), ...(note === "" ? {} : { note: note.slice(0, 500) }) };
}

/**
 * Room the answer lines and links after the calls need: the calls' budget is
 * the channel's `maxTextLength` less this, so a round goes out as one message
 * with its buttons under it.
 */
const ROUND_TEXT_RESERVE = 700;
/** The calls' budget when the channel's limit is not known. */
const DEFAULT_ROUND_TEXT_BUDGET = 3_400;
const RISK_MARK: Readonly<Record<RiskLevel, string>> = { low: "low", medium: "medium", high: "HIGH", critical: "CRITICAL" };

/**
 * The group a round is asked as — "use the browser" — when every call shares
 * one and the task-wide scope is offered: approving it allows the group for the
 * task, so the round offers no one-call choice.
 */
export function roundGroup(requests: ApprovalRoundAnnouncement["requests"]): string | undefined {
  const group = requests[0]?.scopeGroup;
  if (group === undefined || !roundScopes(requests).includes("session")) return undefined;
  return requests.every((request) => request.scopeGroup === group) ? group : undefined;
}

/**
 * What a person calls a group of tools decided as one: for the browser, the
 * hosts the round's calls open (`display.host`), which is all a decision allows it.
 */
export function groupName(
  group: string,
  requests: readonly { readonly display?: { readonly host?: string | undefined } | undefined }[] = [],
): string {
  return `the ${toolGroupLabel(
    group,
    requests.flatMap((request) => (request.display?.host === undefined ? [] : [request.display.host])),
  )}`;
}

/** The scopes every call of a round allows: a round-wide decision can carry only those. */
export function roundScopes(requests: ApprovalRoundAnnouncement["requests"]): readonly ApprovalScope[] {
  return SCOPES.filter((scope) => requests.every((request) => (request.allowedScopes ?? ["once"]).includes(scope)));
}

/** Each call's scopes as the gate offered them, recorded with the round for the approvals inbox. */
export function callScopesOf(requests: ApprovalRoundAnnouncement["requests"]): ApprovalCallScopes {
  return requests.map((request) => {
    const reasons = flaggedReasons(request.risk?.reasons);
    return {
      callId: request.callId,
      allowedScopes: request.allowedScopes === undefined || request.allowedScopes.length === 0 ? ["once"] : [...request.allowedScopes],
      ...(reasons.length === 0 ? {} : { reasons }),
    };
  });
}

/**
 * The context label the round's calls were emitted under, stored with its risk: every call of a round is emitted from one
 * context, so the first call's verdict that carries one speaks for the round.
 */
export function roundLabelOf(requests: ApprovalRoundAnnouncement["requests"]): {
  readonly riskLabel?: NonNullable<NonNullable<ApprovalRoundAnnouncement["requests"][number]["risk"]>["label"]>;
} {
  const label = requests.find((request) => request.risk?.label !== undefined)?.risk?.label;
  return label === undefined ? {} : { riskLabel: label };
}

/** A button press's data: `r:<token>:<o|s|a|d>` — the round, and once, session, always or deny. */
export const ROUND_BUTTON = /^r:([a-z2-9]{8}):([osad])$/;
export const BUTTON_SCOPES: Readonly<Record<string, ApprovalScope>> = { o: "once", s: "session", a: "always" };

/** Buttons for a round: one per offered scope, then deny. Data is opaque and at most 12 bytes. */
export function roundButtons(requests: ApprovalRoundAnnouncement["requests"], token: string): readonly (readonly OutboundButton[])[] {
  return scopeButtons(roundScopes(requests), token, roundGroup(requests));
}

/** The scopes a round's buttons and links offer: a grouped round has no one-call choice. */
export function offeredScopes(scopes: readonly ApprovalScope[], group: string | undefined): readonly ApprovalScope[] {
  return group === undefined ? scopes : scopes.filter((scope) => scope !== "once");
}

export function scopeButtons(scopes: readonly ApprovalScope[], token: string, group?: string): readonly (readonly OutboundButton[])[] {
  const labels: Readonly<Record<ApprovalScope, string>> =
    group === undefined
      ? { once: "✅ Once", session: "🔁 Session", always: "♾ Always" }
      : { once: "✅ Once", session: "✅ Allow for this chat", always: "♾ Always allow" };
  const approve = offeredScopes(scopes, group).map((scope) => ({ label: labels[scope], data: `r:${token}:${scope[0]}` }));
  // A round this chat may only reject (a form it did not show in full) is offered ❌ alone.
  return [...(approve.length === 0 ? [] : [approve]), [{ label: "❌ Deny", data: `r:${token}:d` }]];
}

export const LINK_LABELS: Readonly<Record<ApprovalScope | "deny", string>> = {
  once: "Approve once",
  session: "Approve for the rest of this chat",
  always: "Always allow (a workspace rule)",
  deny: "Reject",
};

/**
 * Said under every set of single-use links: a link is a bearer capability, so
 * whoever holds the message can use it (a critical round still asks for the PIN).
 */
export const LINK_BEARER_NOTE = "Anyone with this message can use these links: do not forward it.";

/** A link's label; a grouped round's names the group. */
export function linkLabel(choice: ApprovalScope | "deny", group: string | undefined, name: string | undefined): string {
  if (group === undefined || choice === "deny" || choice === "once") return LINK_LABELS[choice];
  const named = name ?? groupName(group);
  return choice === "session" ? `Allow ${named} for this chat` : `Always allow ${named}, in every chat`;
}

/** A round token in an email subject: `[tavi k3f9abcd]`. */
export function subjectRoundToken(subject: string | undefined): string | undefined {
  return subject === undefined ? undefined : /\[tavi ([a-z2-9]{8})\]/i.exec(subject)?.[1]?.toLowerCase();
}

/** A subject fragment: one line, and nothing that reads as a round token. */
export function subjectSafe(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\[\s*tavi/gi, "(tavi");
}

/** A name on one line: what a header or a subject may carry. */
const printableLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

/**
 * A question email's subject: its token, so a reply that loses the
 * thread still names the question, and the header or the question's start.
 */
export function questionSubject(waitId: string, question: string, choices: AskUserChoices | undefined): string {
  return `[tavi ${questionToken(waitId)}] Question: ${subjectSafe(clip(choices?.header ?? question, 60))}`;
}

/**
 * When a question stops waiting, as its message says it: the time alone on the
 * day it is sent, the day too otherwise — a question that waits a day would
 * else read as due at a time already past.
 */
function deadlineText(deadlineAt: string, now: string | undefined, timeZone?: string): string {
  const at = new Date(deadlineAt);
  if (Number.isNaN(at.getTime())) return "";
  const zone = usableZone(timeZone);
  const time = wallTime(at, zone);
  const dayOf = (date: Date): string => date.toLocaleDateString("en-CA", { timeZone: zone });
  const sameDay = now !== undefined && !Number.isNaN(new Date(now).getTime()) && dayOf(new Date(now)) === dayOf(at);
  if (sameDay) return time;
  const day = at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: zone });
  return `${day}, ${time}`;
}

/** `zone` when the runtime knows it, else UTC: a chat's times follow the workspace's zone. */
function usableZone(zone: string | undefined): string {
  if (zone === undefined || zone === "") return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/** The time of day in `zone` with the zone's short name: `05:24 EET`, `03:24 UTC`. */
function wallTime(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone,
    timeZoneName: "short",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("hour")}:${part("minute")} ${zone === "UTC" ? "UTC" : part("timeZoneName")}`;
}

/** A question's button data: `q:<token>:<n>` picks option n, `t<n>` toggles it, `ok` submits a multi-select. */
export const QUESTION_BUTTON = /^q:([a-z2-9]{8}):(t?[1-4]|ok)$/;

/** A question's token, derived from its wait so a press can be matched without storing anything. */
export function questionToken(waitId: string): string {
  const digest = createHash("sha256").update(waitId).digest();
  return newRoundToken((bytes) => bytes.set(digest.subarray(0, bytes.length)));
}

/** A question as a chat shows it: the options numbered, and how to answer without buttons. */
export function renderQuestionText(
  question: string,
  choices: AskUserChoices | undefined,
  extra: {
    readonly context?: string;
    readonly deadlineAt?: string;
    readonly now?: string;
    readonly origin?: string;
    /** The workspace's time zone, which the deadline is shown in; UTC when absent. */
    readonly timeZone?: string;
  } = {},
): string {
  // Who asks, when it is not the chat's own task — a schedule's run.
  const asks = extra.origin === undefined ? [] : [`⏸ ${printableLine(extra.origin)} asks:`];
  // Why it is asked, and when it stops waiting — with what it then goes with.
  const why = extra.context === undefined ? [] : [`Why: ${extra.context}`];
  const fallback = choices?.defaultOption === undefined ? undefined : choices.options[choices.defaultOption - 1]?.label;
  const by = extra.deadlineAt === undefined ? "" : deadlineText(extra.deadlineAt, extra.now, extra.timeZone);
  const until =
    by === "" && fallback === undefined
      ? []
      : [`⌛ ${by === "" ? "If nobody answers" : `Answer by ${by}`}${fallback === undefined ? "" : ` (otherwise: ${fallback})`}`];
  if (choices === undefined) return [...asks, question, ...why, ...until].join("\n");
  const lines = [...asks, choices.header === undefined ? `❓ ${question}` : `❓ ${choices.header} — ${question}`, ...why];
  choices.options.forEach((option, index) =>
    lines.push(`${formatChoiceOption(option, index)}${choices.recommended === index + 1 ? " ★ recommended" : ""}`),
  );
  const how = choices.multiSelect ? "Reply with the numbers of your choices (e.g. 1 3)" : "Reply with a number";
  lines.push(choices.allowOther ? `${how}, or with your own answer.` : `${how}.`, ...until);
  return lines.join("\n");
}

/** Buttons for a question: one per option, or toggles and Done for a multi-select. */
export function questionButtons(
  token: string,
  choices: AskUserChoices,
  selected: ReadonlySet<number> = new Set(),
): readonly (readonly OutboundButton[])[] {
  if (!choices.multiSelect)
    return choices.options.map((option, index) => [{ label: clip(option.label, 60), data: `q:${token}:${index + 1}` }]);
  return [
    ...choices.options.map((option, index) => [
      { label: `${selected.has(index + 1) ? "☑" : "☐"} ${clip(option.label, 56)}`, data: `q:${token}:t${index + 1}` },
    ]),
    [{ label: "Done", data: `q:${token}:ok` }],
  ];
}

/** How a round's announcement may be answered where it is sent. */
export interface RoundTextOptions {
  /**
   * Email: a reply approves once only, and only a low- or medium-risk
   * round; `links` says whether the email also carries single-use links.
   */
  readonly email?: { readonly links: boolean };
  /** The channel's `maxTextLength`, which bounds how many calls are listed. */
  readonly maxTextLength?: number;
  /** The round is the operator's to decide, not the person it is shown to: it says so, and offers no answers. */
  readonly operatorDecides?: boolean;
  /** How a form fill's values are shown here; labels only when unset. */
  readonly formView?: Exclude<FormView, "full">;
  /** A form fill this surface may not approve: `none` here at all, `link` only through an email's link. */
  readonly formApproval?: "none" | "link";
  /** Told how many of the round's calls the text lists, the rest past its budget. */
  readonly onListed?: (listed: number) => void;
  /**
   * The round's buttons are shown under it: the text says to press one, or to
   * reply in words, with no `<reason>` placeholder. `ownChat`: the round is the
   * task of the chat it is shown in, so a bare `approve` typed there decides it
   * and no token is shown; else (a worker's round, a room's shown privately)
   * the typed answer names the round's token.
   */
  readonly buttons?: { readonly ownChat: boolean };
}

/** A tainted call's provenance line for a channel, disarmed and bounded; undefined for a clean one. */
function provenanceLineOf(request: ApprovalRoundAnnouncement["requests"][number]): string | undefined {
  const from = requestSources(request);
  if (from === undefined && !requestTainted(request)) return undefined;
  const onceOnly = (request.allowedScopes ?? ["once"]).every((scope) => scope === "once");
  return clip(disarmUrls(approvalProvenanceLine(from ?? { sources: [], refs: [] }, onceOnly), new Set()), 400);
}

/** The tools whose approvals carry a form (`ApprovalDisplay.form`): a round of one is approved on a channel only where its values were shown. */
export const FORM_TOOLS: ReadonlySet<string> = new Set(["pdf.fill", "pdf.overlay"]);

/** What a round's announcement keeps of its form (`RoundMessage`), for a resend, `decide` and a link's page. */
export function formDetail(message: {
  readonly formApproval?: "none" | "link";
  readonly linkForms?: readonly ApprovalForm[];
}): Record<string, unknown> {
  return {
    ...(message.formApproval === undefined ? {} : { formApproval: message.formApproval }),
    ...(message.linkForms === undefined ? {} : { linkForms: message.linkForms }),
  };
}

/** `formDetail` read back from an event's detail: anything malformed is dropped, and a form not kept reads as none. */
export function formOfDetail(detail: Readonly<Record<string, unknown>> | undefined): {
  readonly formApproval?: "none" | "link";
  readonly linkForms?: readonly ApprovalForm[];
} {
  const approval = detail?.["formApproval"];
  const forms = ApprovalFormSchema.array().max(64).safeParse(detail?.["linkForms"]);
  return {
    ...(approval === "none" || approval === "link" ? { formApproval: approval } : {}),
    ...(forms.success ? { linkForms: forms.data } : {}),
  };
}

/** What a channel's chat is told when its turn waits on a review it cannot give there. */
export function reviewNoticeText(requests: readonly { readonly toolName: string }[]): string {
  const screenshots = requests.every((request) => request.toolName === "browser.capture");
  const what =
    requests.length === 1
      ? screenshots
        ? "The screenshot I took is"
        : "A file I made is"
      : `${requests.length} ${screenshots ? "screenshots" : "files"} I made are`;
  return (
    `📎 ${what} waiting for your review before I can use ${requests.length === 1 ? "it" : "them"}. ` +
    "Review it in the Tavi app (the chat's Held files), or send a new message and I'll go on without it."
  );
}

/** How a card with buttons is answered: press one, or type the answer — the bare verb where it decides this round. */
function pressLine(token: string, ownChat: boolean): string {
  return ownChat
    ? 'Press a button below, or reply "approve", or "reject" with your reason.'
    : `Press a button below, or reply "approve ${token}", or "reject ${token}" with your reason.`;
}

/** The line that says when an announced round is rejected unless decided. */
export const roundExpiryLine = (expiresAt: string, timeZone?: string): string => {
  const by = deadlineText(expiresAt, undefined, timeZone);
  return by === "" ? "If nobody decides it in time, it is rejected." : `⌛ Not decided by ${by}, it is rejected.`;
};

/** Text under a call's line, every line of it indented, so a multi-line detail (a form's fields) stays under its call. */
const indented = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => `   ${line}`)
    .join("\n");

/** The plain-text announcement: what each call does, its risk, and how to answer. */
export function renderRoundText(
  round: ApprovalRoundAnnouncement,
  token: string,
  expiresAt: string | undefined,
  options: RoundTextOptions = {},
): string {
  const level = maxRisk(...round.requests.map((request) => request.risk?.level ?? "medium"));
  const group = roundGroup(round.requests);
  const headline =
    group === undefined
      ? `🔐 Approval needed — ${round.requests.length === 1 ? "1 action" : `${round.requests.length} actions`}, ${RISK_MARK[level]} risk`
      : `🔐 This task wants to use ${groupName(group, round.requests)} — ${RISK_MARK[level]} risk`;
  const lines = [headline];
  // A message is bounded by its channel (`maxTextLength`); a round of up to
  // 64 calls lists what fits and says where the rest can be read.
  // Never more than the channel takes: on a short channel the calls get half of it.
  const budget =
    options.maxTextLength === undefined
      ? DEFAULT_ROUND_TEXT_BUDGET
      : Math.max(Math.floor(options.maxTextLength / 2), options.maxTextLength - ROUND_TEXT_RESERVE);
  let used = headline.length;
  let shownCount = 0;
  for (const [index, request] of round.requests.entries()) {
    const entry = [`${index + 1}. ${clip(approvalTitleOf(request), 220)}`];
    const form = request.display?.form;
    // A form's own table stands for its plain-text `command`, and is not clipped: every row or none.
    const shown =
      form === undefined ? (request.display?.command ?? request.display?.destination ?? request.display?.detail) : request.display?.detail;
    if (shown !== undefined && shown !== request.display?.title) entry.push(indented(clip(shown, 300)));
    // What approving for the chat covers, where that is offered.
    if (request.display?.forThisChat !== undefined && request.allowedScopes?.includes("session") === true)
      entry.push(`   for this chat, approving covers: ${clip(request.display.forThisChat, 200)}`);
    // What runs from standard input is part of the command, so the card shows it beside it.
    const stdin = request.display?.stdin;
    if (stdin !== undefined)
      entry.push(
        `   stdin: ${clip(stdin.replace(/\r?\n/g, " ⏎ "), 300)}${stdin.length > 300 ? ` (${stdin.length} characters: \`tavi approvals list\` shows more)` : ""}`,
      );
    // Why it is asked, and from where, in one line: "⚠ after reading example[.]com, mail
    // from x[.]example — once only". Its hosts and any title are content's, so they are disarmed as every
    // tainted turn's outbound text is: a channel would link a bare domain.
    const line = provenanceLineOf(request);
    if (line !== undefined) entry.push(`   ${line}`);
    for (const reason of request.risk?.reasons ?? [])
      if (line === undefined || !isTaintReason(reason)) entry.push(`   ⚠ ${clip(reason, 160)}`);
    const size = entry.join("\n").length + 1;
    if (used + size > budget) {
      lines.push(`…and ${round.requests.length - index} more — \`tavi approvals list\` shows every call.`);
      break;
    }
    lines.push(...entry);
    // The table is split across messages where it is sent, so it is not held to the calls' budget.
    if (form !== undefined)
      lines.push(...formLines(form, options.formView ?? "labels", (text) => disarmUrls(text, new Set())).map((line) => `   ${line}`));
    used += size;
    shownCount += 1;
  }
  options.onListed?.(shownCount);
  const email = options.email;
  // An email's buttons are its links, which it says how to use on its own.
  const buttons = email === undefined ? options.buttons : undefined;
  if (options.operatorDecides === true) {
    lines.push("Waiting for the operator to approve or reject it; you will hear here once they have.");
  } else if (options.formApproval === "none") {
    // A value not shown here, or masked without a verified source, is decided where every value is shown.
    lines.push(
      `Reply: reject ${token} <reason> — this form fill can be approved only in Tavi: \`tavi approvals show ${round.taskId}\` or the approvals view in \`tavi ui\`.`,
    );
  } else if (options.formApproval === "link") {
    lines.push(
      `A reply cannot approve a form fill: use a link below (its page shows the values), \`tavi approvals show ${round.taskId}\`, or the approvals view in \`tavi ui\`. Reply \`reject ${token} <reason>\` to reject it.`,
    );
  } else if (email !== undefined && level !== "low" && level !== "medium") {
    // A reply cannot decide a high-risk round; without links nothing in the email can.
    lines.push(
      email.links
        ? `A reply cannot decide a ${RISK_MARK[level]}-risk round: use a link below, \`tavi approvals approve ${round.taskId}\`, or the approvals view in \`tavi ui\`.`
        : `Decide it with \`tavi approvals approve ${round.taskId}\` (or \`reject\`), or in the approvals view of \`tavi ui\`: a reply cannot decide a ${RISK_MARK[level]}-risk round.`,
    );
  } else if (group !== undefined) {
    // One question for the group: approving allows it for the chat.
    const name = groupName(group, round.requests);
    const note = toolGroupScopeNote(group);
    if (note !== undefined) lines.push(note);
    const answers =
      email === undefined
        ? [
            `approve ${token} (${name}, for this chat)`,
            ...(roundScopes(round.requests).includes("always") ? [`approve ${token} always (${name}, in every chat)`] : []),
            `reject ${token} <reason>`,
          ]
        : [
            `approve ${token} (this call only: the next one asks again${email.links ? "; a link below allows it for the chat" : ""})`,
            `reject ${token} <reason>`,
          ];
    lines.push(buttons === undefined ? `Reply: ${answers.join(" · ")}` : pressLine(token, buttons.ownChat));
  } else {
    // An email reply approves once only; a wider scope needs a link.
    const scopes = email === undefined ? roundScopes(round.requests) : (["once"] as const);
    // A session grant for a call with nothing narrower to match covers any call
    // of that tool for the rest of the task: say so where it is offered. Only
    // the tools listed above, and a few of them, so the line stays bounded.
    const wholeTools = [
      ...new Set(
        round.requests
          .slice(0, shownCount)
          .filter((request) => request.scopeGroup !== undefined || request.subjects === undefined || request.subjects.length === 0)
          .map((request) => request.scopeGroup ?? request.toolName),
      ),
    ];
    const named = wholeTools.length > 3 ? `${wholeTools.slice(0, 3).join(", ")} or another listed tool` : wholeTools.join(" or ");
    // `always` for such a call — a grouped one, or a search — is a rule for any call of it, in every chat.
    const scopeHint = (scope: ApprovalScope) =>
      scope === "session" && wholeTools.length > 0
        ? ` (any ${clip(named, 200)} call in this chat)`
        : scope === "always" && wholeTools.length > 0
          ? ` (any ${clip(named, 200)} call, in every chat)`
          : "";
    const answers = [
      `approve ${token}`,
      ...scopes.filter((scope) => scope !== "once").map((scope) => `approve ${token} ${scope}${scopeHint(scope)}`),
      `reject ${token} <reason>`,
    ];
    if (buttons === undefined) lines.push(`Reply: ${answers.join(" · ")}`);
    else {
      // The buttons are one word each: what Session and Always cover is said here.
      if (wholeTools.length > 0) {
        const any = `any ${clip(named, 200)} call`;
        const wide = [
          ...(scopes.includes("session") ? [`Session allows ${any} in this chat.`] : []),
          ...(scopes.includes("always") ? [`Always allows ${any}, in every chat.`] : []),
        ];
        if (wide.length > 0) lines.push(wide.join(" "));
      }
      lines.push(pressLine(token, buttons.ownChat));
    }
  }
  if (expiresAt !== undefined) lines.push(roundExpiryLine(expiresAt));
  return lines.join("\n");
}

/** A link's confirmation page, as the listener renders it. */
export interface LinkView {
  readonly kind: "round" | "question";
  readonly title: string;
  /** The announcement or question as it was sent. */
  readonly body: string;
  /** What confirming does: "Approve once", "Reject", an option's label. */
  readonly choiceLabel: string;
  /** A critical round asks for the operator's PIN too. */
  readonly needsPin: boolean;
  /** A rejection may carry a reason. */
  readonly allowsNote: boolean;
  /** A multi-select question's options: the page offers them as checkboxes, and confirming sends those ticked. */
  readonly options?: readonly AskUserOption[];
  /** Each form fill's values, masked as on a private chat: the page shows them as tables. */
  readonly forms?: readonly ApprovalForm[];
}

/**
 * What a settled question's message says under it. `via` names where it
 * was answered when that is not the message's own connection.
 */
export function questionReceipt(outcome: AgentWaitOutcome, via: string | undefined, at: string, timeZone?: string): string {
  const when = clockTime(at, timeZone);
  if (outcome.kind === "answered") {
    const answer =
      outcome.answers === undefined || outcome.answers.length === 0
        ? (outcome.other ?? outcome.replyText ?? "")
        : [...outcome.answers, ...(outcome.other === undefined ? [] : [outcome.other])].join(", ");
    return `✅ ${clip(answer, 200)}${via === undefined ? "" : ` — answered via ${FRONT_END_NAMES[via] ?? via}${when}`}`;
  }
  if (outcome.kind === "wait-timeout") {
    // A question with a default went on with it.
    const fallback = outcome.answers?.[0];
    return fallback === undefined
      ? `⌛ No answer came in time${when}; the task went on without one.`
      : `⌛ No answer came in time${when}; the task went with the default: ${clip(fallback, 200)}.`;
  }
  return `✖ This question was withdrawn${when}.`;
}

/** What a press on a question that is no longer open is told. */
export function closedQuestionText(wait: AgentWaitIntentRecord | undefined): string {
  if (wait?.settledOutcome?.kind === "wait-timeout") {
    const fallback = wait.settledOutcome.answers?.[0];
    return fallback === undefined
      ? "This question expired without an answer."
      : `This question expired; the task went with the default: ${clip(fallback, 150)}.`;
  }
  if (wait?.settledOutcome?.error?.code === "CONVERSATION_RESET") return "This conversation was reset, so this question was withdrawn.";
  if (wait?.settledOutcome !== undefined && wait.settledOutcome.kind !== "answered") return "This question was withdrawn.";
  return "This question was already answered.";
}

/** How a front end is named in a settlement notice, when the connection itself has no better name. */
const FRONT_END_NAMES: Readonly<Record<string, string>> = {
  cli: "the CLI",
  ipc: "a terminal",
  bridge: "the web app",
  link: "an email link",
  policy: "policy",
};

/** The time of day a decision was made, as a chat shows it: ` at 05:24 EET`, ` at 14:02 UTC` without a zone. */
const clockTime = (at: string, timeZone?: string): string => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : ` at ${wallTime(date, usableZone(timeZone))}`;
};

/** How a settlement names its decision's place and person; each optional. */
export interface SettlementView {
  /** The workspace's time zone; UTC when absent. */
  readonly timeZone?: string;
  /** Who decided, as the chat knows them: a bound person's name, "Tavi's owner"; the principal id when absent. */
  readonly decider?: string;
}

/** What each scope allowed, as a settlement says it. */
const SCOPE_WORDS: Readonly<Record<ApprovalScope, string>> = { once: "", session: " for this chat", always: " in every chat" };

export function settlementText(
  settlement: ApprovalRoundSettlement,
  expired: boolean,
  channel: string,
  at: string,
  view: SettlementView = {},
): string {
  // No round token: a chat's reader has the card above it, and the token is only for typing.
  const when = clockTime(at, view.timeZone);
  if (expired) return `⌛ Not decided in time, so it was rejected${when}; the task goes on without it.`;
  const approved = settlement.decisions.filter((decision) => decision.approved);
  const who = view.decider ?? settlement.decisions[0]?.decidedBy ?? "Tavi's owner";
  const via = FRONT_END_NAMES[channel] ?? channel;
  if (approved.length === settlement.decisions.length) {
    const scopes = [...new Set(approved.map((decision) => decision.scope))];
    return `✅ Approved${scopes.length === 1 ? SCOPE_WORDS[scopes[0] ?? "once"] : ""} by ${who} via ${via}${when}.`;
  }
  if (approved.length === 0) return `❌ Rejected by ${who} via ${via}${when}.`;
  return `☑️ Decided by ${who} via ${via}${when}: ${approved.length} of ${settlement.decisions.length} approved.`;
}
