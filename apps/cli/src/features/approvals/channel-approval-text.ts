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
  flaggedReasons,
} from "@tavi/contracts";
import { SUPPORTED_LOCALES } from "@tavi/contracts/i18n";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { clip } from "@tavi/contracts/util";
import { hostAndPathOf, trimTrailing } from "@tavi/contracts/url-text";
import type { ApprovalRoundAnnouncement, ApprovalRoundSettlement } from "@tavi/agent-host/workflow";

import { zonedClock, zonedShortDay } from "../channels/channel-words.js";
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
 * The words a typed decision is written with, lower case, in every language
 * Tavi speaks, whatever the workspace's: each language's own word as help names
 * it (`channel.approval.word.*`), and the forms a person naturally types: the
 * imperative and the first person, never a participle ("одобрено") or a noun
 * ("отказ"), as English takes "approve" but not "approved".
 */
export const TYPED_VERBS: { readonly approve: readonly string[]; readonly reject: readonly string[] } = {
  approve: [
    "approve",
    "allow",
    ...wordsIn("channel.approval.word.approve"),
    "одобри",
    "одобрете",
    "одобрявам",
    "разреши",
    "разрешете",
    "разрешавам",
  ],
  reject: [
    "reject",
    "deny",
    ...wordsIn("channel.approval.word.reject"),
    "откажи",
    "откажете",
    "отказвам",
    "отхвърли",
    "отхвърлете",
    "отхвърлям",
  ],
};
export const TYPED_SCOPES: { readonly [S in ApprovalScope]: readonly string[] } = {
  once: ["once", ...wordsIn("channel.approval.word.once"), "веднъж", "еднократно"],
  // The glossary's "чат" for a chat-long grant, and the "сесия" a person may still type.
  session: ["session", ...wordsIn("channel.approval.word.session"), "чат", "чата", "сесия", "сесията"],
  always: ["always", ...wordsIn("channel.approval.word.always"), "винаги"],
};

/** `key`'s word in every language, lower case. */
function wordsIn(
  key: "channel.approval.word.approve" | "channel.approval.word.reject" | `channel.approval.word.${ApprovalScope}`,
): string[] {
  return SUPPORTED_LOCALES.map((locale) => coreIn(locale)(key).toLowerCase());
}

/** The scope a typed word names, case aside, in any language; undefined for any other word. */
function typedScope(word: string | undefined): ApprovalScope | undefined {
  const lower = word?.toLowerCase();
  return lower === undefined ? undefined : SCOPES.find((scope) => TYPED_SCOPES[scope].includes(lower));
}

/**
 * Parse a whole message as an approval command, or `null` when it is not one.
 * The grammar is `(approve|allow|reject|deny) [token|task-id] [once|session|always] [reason…]`,
 * its words taken in every language Tavi speaks (`одобри k3f9 винаги`, `откажи твърде рисково`),
 * case aside; a scope only follows an approval and a reason only follows a rejection, so an
 * ordinary sentence that happens to start with "approve" is not a command.
 */
export function parseApprovalCommand(text: string): ApprovalCommand | null {
  const words = text.trim().split(/\s+/);
  const verb = (words[0] ?? "").toLowerCase();
  const approved = TYPED_VERBS.approve.includes(verb);
  if (!approved && !TYPED_VERBS.reject.includes(verb)) return null;
  // "Откажи се", "отказвам се": to give up, an ordinary sentence and never a rejection.
  if (!approved && /^се[,.;:!?…]*$/u.test(words[1]?.toLowerCase() ?? "")) return null;
  let index = 1;
  let target: string | undefined;
  const next = words[index];
  if (next !== undefined && /^[A-Za-z0-9._-]{1,128}$/.test(next) && typedScope(next) === undefined) {
    target = next;
    index += 1;
  }
  if (approved) {
    const scope = typedScope(words[index]);
    if (scope !== undefined) index += 1;
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
const riskMark = (level: RiskLevel, t: CoreT): string => t(`channel.approval.risk.${level}`);

/**
 * The words a typed answer is written with, as help and cards name them: the
 * verbs and scopes `parseApprovalCommand` takes.
 */
export function approvalWords(t: CoreT = coreEnglish): {
  readonly approve: string;
  readonly reject: string;
  readonly once: string;
  readonly session: string;
  readonly always: string;
  readonly reason: string;
} {
  return {
    approve: t("channel.approval.word.approve"),
    reject: t("channel.approval.word.reject"),
    once: t("channel.approval.word.once"),
    session: t("channel.approval.word.session"),
    always: t("channel.approval.word.always"),
    reason: t("channel.approval.reason"),
  };
}

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
  t: CoreT = coreEnglish,
): string {
  return t("channel.approval.groupName", {
    label: toolGroupLabel(
      group,
      requests.flatMap((request) => (request.display?.host === undefined ? [] : [request.display.host])),
      t,
    ),
  });
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
export function roundButtons(
  requests: ApprovalRoundAnnouncement["requests"],
  token: string,
  t: CoreT = coreEnglish,
): readonly (readonly OutboundButton[])[] {
  return scopeButtons(roundScopes(requests), token, roundGroup(requests), t);
}

/** The scopes a round's buttons and links offer: a grouped round has no one-call choice. */
export function offeredScopes(scopes: readonly ApprovalScope[], group: string | undefined): readonly ApprovalScope[] {
  return group === undefined ? scopes : scopes.filter((scope) => scope !== "once");
}

export function scopeButtons(
  scopes: readonly ApprovalScope[],
  token: string,
  group?: string,
  t: CoreT = coreEnglish,
): readonly (readonly OutboundButton[])[] {
  const labels: Readonly<Record<ApprovalScope, string>> =
    group === undefined
      ? {
          once: `✅ ${t("channel.approval.button.once")}`,
          session: `🔁 ${t("channel.approval.button.session")}`,
          always: `♾ ${t("channel.approval.button.always")}`,
        }
      : {
          once: `✅ ${t("channel.approval.button.once")}`,
          session: `✅ ${t("channel.approval.button.groupSession")}`,
          always: `♾ ${t("channel.approval.button.groupAlways")}`,
        };
  // Only the labels follow the language: the data stays `r:<token>:<o|s|a|d>`.
  const approve = offeredScopes(scopes, group).map((scope) => ({ label: labels[scope], data: `r:${token}:${scope[0]}` }));
  // A round this chat may only reject (a form it did not show in full) is offered ❌ alone.
  return [...(approve.length === 0 ? [] : [approve]), [{ label: `❌ ${t("channel.approval.button.deny")}`, data: `r:${token}:d` }]];
}

/** A link's label for each choice, in `t`'s words. */
export function linkLabels(t: CoreT = coreEnglish): Readonly<Record<ApprovalScope | "deny", string>> {
  return {
    once: t("channel.approval.link.once"),
    session: t("channel.approval.link.session"),
    always: t("channel.approval.link.always"),
    deny: t("channel.approval.link.deny"),
  };
}

/**
 * Said under every set of single-use links: a link is a bearer capability, so
 * whoever holds the message can use it (a critical round still asks for the PIN).
 */
export const LINK_BEARER_NOTE = coreEnglish("channel.approval.link.bearer");

/** A link's label; a grouped round's names the group. */
export function linkLabel(
  choice: ApprovalScope | "deny",
  group: string | undefined,
  name: string | undefined,
  t: CoreT = coreEnglish,
): string {
  if (group === undefined || choice === "deny" || choice === "once") return linkLabels(t)[choice];
  const named = name ?? groupName(group, [], t);
  return t(choice === "session" ? "channel.approval.link.groupSession" : "channel.approval.link.groupAlways", { name: named });
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
export function questionSubject(waitId: string, question: string, choices: AskUserChoices | undefined, t: CoreT = coreEnglish): string {
  return `[tavi ${questionToken(waitId)}] ${t("channel.question.subject", { what: subjectSafe(clip(choices?.header ?? question, 60)) })}`;
}

/**
 * When a question stops waiting, as its message says it: the time alone on the
 * day it is sent, the day too otherwise — a question that waits a day would
 * else read as due at a time already past.
 */
function deadlineText(deadlineAt: string, now: string | undefined, timeZone?: string, t: CoreT = coreEnglish): string {
  const at = new Date(deadlineAt);
  if (Number.isNaN(at.getTime())) return "";
  const zone = usableZone(timeZone);
  const time = wallTime(at, zone);
  // A machine date key, compared only: "2026-11-23".
  const dayOf = (date: Date): string => date.toLocaleDateString("en-CA", { timeZone: zone });
  const sameDay = now !== undefined && !Number.isNaN(new Date(now).getTime()) && dayOf(new Date(now)) === dayOf(at);
  if (sameDay) return time;
  return t("channel.time.dayTime", { day: zonedShortDay(at, zone, t), time });
}

/** `zone` when the runtime knows it, else UTC: a chat's times follow the workspace's zone. */
function usableZone(zone: string | undefined): string {
  if (zone === undefined || zone === "") return "UTC";
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/**
 * The time of day in `zone` with the zone's short name: `05:24 EET`, `03:24 UTC`.
 * The zone's name is an identifier, the same in every language: its `en-GB` abbreviation.
 */
function wallTime(at: Date, zone: string): string {
  const name =
    zone === "UTC"
      ? "UTC"
      : (new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" })
          .formatToParts(at)
          .find((entry) => entry.type === "timeZoneName")?.value ?? "");
  return `${zonedClock(at, zone)} ${name}`;
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
  t: CoreT = coreEnglish,
): string {
  // Who asks, when it is not the chat's own task — a schedule's run.
  const asks = extra.origin === undefined ? [] : [t("channel.question.asks", { origin: printableLine(extra.origin) })];
  // Why it is asked, and when it stops waiting — with what it then goes with.
  const why = extra.context === undefined ? [] : [t("channel.question.why", { context: extra.context })];
  const fallback = choices?.defaultOption === undefined ? undefined : choices.options[choices.defaultOption - 1]?.label;
  const by = extra.deadlineAt === undefined ? "" : deadlineText(extra.deadlineAt, extra.now, extra.timeZone, t);
  const until =
    by === "" && fallback === undefined
      ? []
      : [
          `⌛ ${
            by === ""
              ? t("channel.question.untilOtherwise", { fallback: fallback ?? "" })
              : fallback === undefined
                ? t("channel.question.untilBy", { by })
                : t("channel.question.untilByOtherwise", { by, fallback })
          }`,
        ];
  if (choices === undefined) return [...asks, question, ...why, ...until].join("\n");
  const lines = [...asks, choices.header === undefined ? `❓ ${question}` : `❓ ${choices.header} — ${question}`, ...why];
  choices.options.forEach((option, index) =>
    lines.push(
      choices.recommended === index + 1
        ? t("channel.question.recommended", { option: formatChoiceOption(option, index) })
        : formatChoiceOption(option, index),
    ),
  );
  lines.push(
    t(
      choices.multiSelect
        ? choices.allowOther
          ? "channel.question.howManyOwn"
          : "channel.question.howMany"
        : choices.allowOther
          ? "channel.question.howOneOwn"
          : "channel.question.howOne",
    ),
    ...until,
  );
  return lines.join("\n");
}

/** Buttons for a question: one per option, or toggles and Done for a multi-select. */
export function questionButtons(
  token: string,
  choices: AskUserChoices,
  selected: ReadonlySet<number> = new Set(),
  t: CoreT = coreEnglish,
): readonly (readonly OutboundButton[])[] {
  if (!choices.multiSelect)
    return choices.options.map((option, index) => [{ label: clip(option.label, 60), data: `q:${token}:${index + 1}` }]);
  return [
    ...choices.options.map((option, index) => [
      { label: `${selected.has(index + 1) ? "☑" : "☐"} ${clip(option.label, 56)}`, data: `q:${token}:t${index + 1}` },
    ]),
    [{ label: t("channel.question.done"), data: `q:${token}:ok` }],
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
   * The hosts the chat's own people wrote in their messages (lower-case, ASCII):
   * the provenance line leaves such a host linked where it names it exactly.
   * Every other host is disarmed (`example[.]com`), as before — never one only a
   * page linked, which a hostile page could make its own. None when absent.
   */
  readonly personHosts?: ReadonlySet<string>;
  /**
   * The round's buttons are shown under it: the text says to press one, or to
   * reply in words, with no `<reason>` placeholder. `ownChat`: the round is the
   * task of the chat it is shown in, so a bare `approve` typed there decides it
   * and no token is shown; else (a worker's round, a room's shown privately)
   * the typed answer names the round's token.
   */
  readonly buttons?: { readonly ownChat: boolean };
  /** The workspace's words: the round is said in its language. English when absent. */
  readonly t?: CoreT;
}

/** A tainted call's provenance line for a channel, disarmed and bounded; undefined for a clean one. */
function provenanceLineOf(
  request: ApprovalRoundAnnouncement["requests"][number],
  personHosts: ReadonlySet<string>,
  t: CoreT,
): string | undefined {
  const from = requestSources(request);
  if (from === undefined && !requestTainted(request)) return undefined;
  const onceOnly = (request.allowedScopes ?? ["once"]).every((scope) => scope === "once");
  // Only a host that is exactly one of this call's sources: text cleaned for the card (a format mark
  // shown as a space) can leave a person's host standing alone inside another source's name.
  const sourceHosts = new Set((from?.refs ?? []).flatMap((ref) => (ref.host === undefined ? [] : [ref.host.toLowerCase()])));
  const rearmable = new Set([...personHosts].filter((host) => sourceHosts.has(host)));
  // Clipped first, so a cut never falls inside a host put back.
  return rearmPersonHosts(
    clip(disarmUrls(approvalProvenanceLine(from ?? { sources: [], refs: [] }, onceOnly, t), new Set()), 400),
    rearmable,
  );
}

/**
 * A disarmed bare ASCII host as `disarmUrls` writes it (`sub[.]example[.]com`),
 * standing alone: after the start, a space or an opening bracket or quote, and
 * before the end, a space, closing punctuation or a sentence's full stop —
 * never next to another character a client could read as part of the address
 * (a combining or format mark, an ideographic full stop, a path, port, query
 * or fragment). ASCII spelled out, with no `i` flag: under `iu`, `[a-z]` also
 * matches look-alikes that fold to a letter (U+212A, the Kelvin sign, is k).
 */
const DISARMED_HOST = /(?<=^|[\s([“"'‘])((?:[A-Za-z0-9-]+\[\.\])+[A-Za-z0-9-]+)(?=$|[\s)\]”"'’,;!]|\.(?:$|\s))/gu;

/**
 * `disarmed` with each bare host put back that is exactly one the chat's
 * people wrote themselves (`personHosts`), written as stored. A provenance
 * line names hosts Tavi parsed (`example.com`); one a person sent the chat
 * carries nothing new.
 */
function rearmPersonHosts(disarmed: string, personHosts: ReadonlySet<string>): string {
  if (personHosts.size === 0) return disarmed;
  return disarmed.replace(DISARMED_HOST, (written: string) => {
    const host = written.replaceAll("[.]", ".").toLowerCase();
    return personHosts.has(host) ? host : written;
  });
}

/** Bound on the hosts `hostsWrittenIn` collects: a card needs only the few a person sent. */
const PERSON_HOSTS_MAX = 200;

/**
 * The hosts of the http(s) addresses written in `texts` (a chat's own
 * messages), lower-case and ASCII as a URL parses them; a bare domain is not
 * taken, only an address with its scheme.
 */
export function hostsWrittenIn(texts: Iterable<string>): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const text of texts)
    for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/giu)) {
      const host = hostAndPathOf(trimTrailing(match[0]))?.hostname;
      if (host !== undefined && host !== "") hosts.add(host);
      if (hosts.size >= PERSON_HOSTS_MAX) return hosts;
    }
  return hosts;
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
export function reviewNoticeText(requests: readonly { readonly toolName: string }[], t: CoreT = coreEnglish): string {
  const screenshots = requests.every((request) => request.toolName === "browser.capture");
  if (requests.length === 1) return `📎 ${t(screenshots ? "channel.review.screenshot" : "channel.review.file")}`;
  return `📎 ${t(screenshots ? "channel.review.screenshots" : "channel.review.files", { n: String(requests.length) })}`;
}

/** How a card with buttons is answered: press one, or type the answer — the bare verb where it decides this round. */
function pressLine(token: string, ownChat: boolean, t: CoreT): string {
  const words = approvalWords(t);
  return ownChat
    ? t("channel.approval.press.own", { approve: words.approve, reject: words.reject })
    : t("channel.approval.press.token", { approve: words.approve, reject: words.reject, token });
}

/** The line that says when an announced round is rejected unless decided. */
export const roundExpiryLine = (expiresAt: string, timeZone?: string, t: CoreT = coreEnglish): string => {
  const by = deadlineText(expiresAt, undefined, timeZone, t);
  return by === "" ? t("channel.approval.expiryUnknown") : `⌛ ${t("channel.approval.expiry", { by })}`;
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
  const t = options.t ?? coreEnglish;
  const words = approvalWords(t);
  const level = maxRisk(...round.requests.map((request) => request.risk?.level ?? "medium"));
  const group = roundGroup(round.requests);
  // A call asked after the chat read outside content is rated at least high (SECURITY-MODEL.md, taint):
  // a reminder or a site the person named reads HIGH, so the headline says why — only where taint
  // alone made each high call so (`risk.raisedByTaint`), never one high for its own sake.
  const byTaint =
    level === "high" && round.requests.every((request) => request.risk?.level !== "high" || request.risk.raisedByTaint === true);
  const risk = t(byTaint ? "channel.approval.riskByTaint" : "channel.approval.risk", { level: riskMark(level, t) });
  const headline =
    group === undefined
      ? `🔐 ${t("channel.approval.headline", { count: round.requests.length, n: String(round.requests.length), risk })}`
      : `🔐 ${t("channel.approval.headlineGroup", { group: groupName(group, round.requests, t), risk })}`;
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
  const personHosts = options.personHosts ?? new Set<string>();
  for (const [index, request] of round.requests.entries()) {
    const entry = [`${index + 1}. ${clip(titleOf(request, t), 220)}`];
    const form = request.display?.form;
    // A form's own table stands for its plain-text `command`, and is not clipped: every row or none.
    const shown =
      form === undefined ? (request.display?.command ?? request.display?.destination ?? request.display?.detail) : request.display?.detail;
    if (shown !== undefined && shown !== request.display?.title) entry.push(indented(clip(shown, 300)));
    // What approving for the chat covers, where that is offered.
    if (request.display?.forThisChat !== undefined && request.allowedScopes?.includes("session") === true)
      entry.push(`   ${t("channel.approval.forThisChat", { what: clip(request.display.forThisChat, 200) })}`);
    // What runs from standard input is part of the command, so the card shows it beside it.
    const stdin = request.display?.stdin;
    if (stdin !== undefined) {
      const text = clip(stdin.replace(/\r?\n/g, " ⏎ "), 300);
      entry.push(
        `   ${stdin.length > 300 ? t("channel.approval.stdinLong", { text, n: String(stdin.length) }) : t("channel.approval.stdin", { text })}`,
      );
    }
    // Why it is asked, and from where, in one line: "⚠ after reading example[.]com, mail
    // from x[.]example — once only". Its hosts and any title are content's, so they are disarmed as every
    // tainted turn's outbound text is (a channel would link a bare domain), but a host the chat's people wrote.
    const line = provenanceLineOf(request, personHosts, t);
    if (line !== undefined) entry.push(`   ${line}`);
    for (const reason of request.risk?.reasons ?? [])
      if (line === undefined || !isTaintReason(reason)) entry.push(`   ⚠ ${clip(reason, 160)}`);
    const size = entry.join("\n").length + 1;
    if (used + size > budget) {
      lines.push(t("channel.approval.more", { n: String(round.requests.length - index) }));
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
  const reject = t("channel.approval.answer.reject", { reject: words.reject, token, reason: words.reason });
  if (options.operatorDecides === true) {
    lines.push(t("channel.approval.operatorDecides"));
  } else if (options.formApproval === "none") {
    // A value not shown here, or masked without a verified source, is decided where every value is shown.
    lines.push(t("channel.approval.formNone", { reject: words.reject, token, reason: words.reason, taskId: round.taskId }));
  } else if (options.formApproval === "link") {
    lines.push(t("channel.approval.formLink", { reject: words.reject, token, reason: words.reason, taskId: round.taskId }));
  } else if (email !== undefined && level !== "low" && level !== "medium") {
    // A reply cannot decide a high-risk round; without links nothing in the email can.
    lines.push(
      t(email.links ? "channel.approval.emailHighLinks" : "channel.approval.emailHighNoLinks", {
        level: riskMark(level, t),
        taskId: round.taskId,
      }),
    );
  } else if (group !== undefined) {
    // One question for the group: approving allows it for the chat.
    const name = groupName(group, round.requests, t);
    const note = toolGroupScopeNote(group, t);
    if (note !== undefined) lines.push(note);
    const answers =
      email === undefined
        ? [
            t("channel.approval.answer.groupChat", { approve: words.approve, token, name }),
            ...(roundScopes(round.requests).includes("always")
              ? [t("channel.approval.answer.groupAlways", { approve: words.approve, always: words.always, token, name })]
              : []),
            reject,
          ]
        : [
            t(email.links ? "channel.approval.answer.emailOnceLinks" : "channel.approval.answer.emailOnce", {
              approve: words.approve,
              token,
            }),
            reject,
          ];
    lines.push(
      buttons === undefined ? t("channel.approval.reply", { answers: answers.join(" · ") }) : pressLine(token, buttons.ownChat, t),
    );
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
    const named =
      wholeTools.length > 3
        ? t("channel.approval.tools.more", { tools: wholeTools.slice(0, 3).join(", ") })
        : wholeTools.join(t("channel.approval.tools.or"));
    const tools = clip(named, 200);
    // `always` for such a call — a grouped one, or a search — is a rule for any call of it, in every chat.
    const scoped = (scope: ApprovalScope): string => {
      const said = { approve: words.approve, token, scope: scope === "always" ? words.always : words.session, tools };
      return scope === "session" && wholeTools.length > 0
        ? t("channel.approval.answer.scopedSession", said)
        : scope === "always" && wholeTools.length > 0
          ? t("channel.approval.answer.scopedAlways", said)
          : t("channel.approval.answer.scoped", said);
    };
    const answers = [
      t("channel.approval.answer.approve", { approve: words.approve, token }),
      ...scopes.filter((scope) => scope !== "once").map(scoped),
      reject,
    ];
    if (buttons === undefined) lines.push(t("channel.approval.reply", { answers: answers.join(" · ") }));
    else {
      // The buttons are one word each: what Session and Always cover is said here.
      if (wholeTools.length > 0) {
        const wide = [
          ...(scopes.includes("session") ? [t("channel.approval.wide.session", { tools })] : []),
          ...(scopes.includes("always") ? [t("channel.approval.wide.always", { tools })] : []),
        ];
        if (wide.length > 0) lines.push(wide.join(" "));
      }
      lines.push(pressLine(token, buttons.ownChat, t));
    }
  }
  if (expiresAt !== undefined) lines.push(roundExpiryLine(expiresAt, undefined, t));
  return lines.join("\n");
}

/** A call's title as a line says it: `approvalTitleOf` in `t`'s words. */
function titleOf(request: ApprovalRoundAnnouncement["requests"][number], t: CoreT): string {
  const title = request.display?.title ?? request.summary;
  return request.display?.destructive === true ? t("channel.approval.cannotUndo", { title }) : title;
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
export function questionReceipt(
  outcome: AgentWaitOutcome,
  via: string | undefined,
  at: string,
  timeZone?: string,
  t: CoreT = coreEnglish,
): string {
  const when = clockTime(at, timeZone, t);
  if (outcome.kind === "answered") {
    const answer =
      outcome.answers === undefined || outcome.answers.length === 0
        ? (outcome.other ?? outcome.replyText ?? "")
        : [...outcome.answers, ...(outcome.other === undefined ? [] : [outcome.other])].join(", ");
    return via === undefined
      ? t("channel.question.answered", { answer: clip(answer, 200) })
      : t("channel.question.answeredVia", { answer: clip(answer, 200), via: frontEndName(via, t), when });
  }
  if (outcome.kind === "wait-timeout") {
    // A question with a default went on with it.
    const fallback = outcome.answers?.[0];
    return `⌛ ${
      fallback === undefined
        ? t("channel.question.timeout", { when })
        : t("channel.question.timeoutDefault", { when, fallback: clip(fallback, 200) })
    }`;
  }
  return `✖ ${t("channel.question.withdrawnAt", { when })}`;
}

/** What a press on a question that is no longer open is told. */
export function closedQuestionText(wait: AgentWaitIntentRecord | undefined, t: CoreT = coreEnglish): string {
  if (wait?.settledOutcome?.kind === "wait-timeout") {
    const fallback = wait.settledOutcome.answers?.[0];
    return fallback === undefined
      ? t("channel.question.closed.expired")
      : t("channel.question.closed.expiredDefault", { fallback: clip(fallback, 150) });
  }
  if (wait?.settledOutcome?.error?.code === "CONVERSATION_RESET") return t("channel.question.closed.reset");
  if (wait?.settledOutcome !== undefined && wait.settledOutcome.kind !== "answered") return t("channel.question.closed.withdrawn");
  return t("channel.question.closed.answered");
}

/** How a front end is named in a settlement notice, when the connection itself has no better name. */
const FRONT_END_KEYS = {
  cli: "channel.via.cli",
  ipc: "channel.via.ipc",
  bridge: "channel.via.bridge",
  link: "channel.via.link",
  policy: "channel.via.policy",
} as const;

/** A front end's or a connection's name, as a receipt says where it was decided. */
const frontEndName = (via: string, t: CoreT): string =>
  Object.hasOwn(FRONT_END_KEYS, via) ? t(FRONT_END_KEYS[via as keyof typeof FRONT_END_KEYS]) : via;

/** The time of day a decision was made, as a chat shows it: ` at 05:24 EET`, ` at 14:02 UTC` without a zone. */
const clockTime = (at: string, timeZone: string | undefined, t: CoreT): string => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : t("channel.time.at", { time: wallTime(date, usableZone(timeZone)) });
};

/** How a settlement names its decision's place and person; each optional. */
export interface SettlementView {
  /** The workspace's time zone; UTC when absent. */
  readonly timeZone?: string;
  /** Who decided, as the chat knows them: a bound person's name, "Tavi's owner"; the principal id when absent. */
  readonly decider?: string;
  /** The workspace's words; English when absent. */
  readonly t?: CoreT;
}

export function settlementText(
  settlement: ApprovalRoundSettlement,
  expired: boolean,
  channel: string,
  at: string,
  view: SettlementView = {},
): string {
  const t = view.t ?? coreEnglish;
  // No round token: a chat's reader has the card above it, and the token is only for typing.
  const when = clockTime(at, view.timeZone, t);
  if (expired) return `⌛ ${t("channel.settle.expired", { when })}`;
  const approved = settlement.decisions.filter((decision) => decision.approved);
  const who = view.decider ?? settlement.decisions[0]?.decidedBy ?? t("channel.settle.owner");
  const via = frontEndName(channel, t);
  if (approved.length === settlement.decisions.length) {
    const scopes = [...new Set(approved.map((decision) => decision.scope))];
    const scope = scopes.length === 1 ? (scopes[0] ?? "once") : "once";
    return `✅ ${t(
      scope === "session"
        ? "channel.settle.approvedSession"
        : scope === "always"
          ? "channel.settle.approvedAlways"
          : "channel.settle.approved",
      { who, via, when },
    )}`;
  }
  if (approved.length === 0) return `❌ ${t("channel.settle.rejected", { who, via, when })}`;
  return `☑️ ${t("channel.settle.mixed", { who, via, when, approved: String(approved.length), total: String(settlement.decisions.length) })}`;
}
