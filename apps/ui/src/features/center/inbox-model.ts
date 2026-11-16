import {
  APPROVAL_EXPIRED_DECIDER,
  APPROVAL_HISTORY_STATES_BY_KIND,
  RISK_LEVELS,
  approvalProvenanceLine,
  type ApprovalHistoryItem,
  type ApprovalHistoryKind,
  type ApprovalHistoryState,
  type ApprovalScope,
  type ApprovalSettlement,
  type PendingApprovalRow,
  type PendingQuestionRow,
  type PendingReviewRow,
  type RiskLevel,
} from "@tavi/contracts";

import type { PendingListRow } from "./approvals-api.js";
import { localDate, localTime, shiftDate, shortDay, durationText } from "../../lib/time.js";

/**
 * The Approvals section's pure reads: which
 * pending rows make one card, what a countdown and a decision time say, and
 * what the history's filters ask the owner for. Kept free of React so each is
 * asserted on its own.
 */

// ---- Waiting ---------------------------------------------------------------

/** One call of a round, as its card lists it. */
interface RoundCall {
  readonly approvalId: string;
  /** The call's id, which a per-call decision names. */
  readonly callId: string;
  readonly toolId: string;
  readonly summary: string | undefined;
}

/**
 * One card: a round, since a decision covers every call of one model turn
 * (`approve` decides the round, not a row).
 */
export interface PendingRoundCard {
  readonly key: string;
  readonly taskId: string;
  /** Where it opens: its own chat, or a worker's root. A worker is no chat. */
  readonly chatTaskId: string;
  readonly steps: number;
  readonly calls: readonly RoundCall[];
  readonly taskTitle: string | undefined;
  readonly principalId: string | undefined;
  /** Absent when the round recorded none: the card then shows no stripe. */
  readonly risk: RiskLevel | undefined;
  readonly expiresAt: string | undefined;
  /** What every call of the round allows; `once` from an owner that sends none. */
  readonly allowedScopes: readonly ApprovalScope[];
  readonly announcedIn: PendingListRow["announcedIn"];
  readonly createdAt: string;
  /** Raised by a schedule's run, for the inbox's "From schedules". */
  readonly scheduled: boolean;
  /** Asked in a chat that never ends: its chat grant lasts a day, and says "Allow until tomorrow". */
  readonly lastingChat: boolean;
  /** Where the round's chat read untrusted content: "after reading news.example — once only" (the canvas draws no glyph). */
  readonly provenance: string | undefined;
}

const SCOPE_ORDER: readonly ApprovalScope[] = ["once", "session", "always"];

/** The key a round's card is kept under, across refetches. */
function roundKey(taskId: string, steps: number): string {
  return `${taskId}:${steps}`;
}

/** The higher of two risks; an unknown one does not lower a known one. */
function higher(a: RiskLevel | undefined, b: RiskLevel | undefined): RiskLevel | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return RISK_LEVELS.indexOf(a) >= RISK_LEVELS.indexOf(b) ? a : b;
}

/** A root chat's workers' pending rows as cards: the same card, read from the needs listing; a worker's grant lasts as its chat's does. */
export function workerRoundCards(rows: readonly PendingApprovalRow[], lastingChat?: true): readonly PendingRoundCard[] {
  return groupRounds(
    rows.map((row) => ({
      ...row,
      ...(lastingChat ? { lastingChat } : {}),
      record: {
        approvalId: row.approvalId,
        taskId: row.taskId,
        toolId: row.toolId,
        callId: row.callId,
        steps: row.steps,
        createdAt: row.createdAt,
      },
      provenance: row.label === undefined ? undefined : approvalProvenanceLine(row.label, row.allowedScopes.length === 1),
    })),
  );
}

/** Pending rows as cards, one per (task, round), in the order their first rows came (oldest first). */
export function groupRounds(rows: readonly PendingListRow[]): readonly PendingRoundCard[] {
  const cards = new Map<string, PendingRoundCard>();
  for (const row of rows) {
    const key = roundKey(row.record.taskId, row.record.steps);
    const call: RoundCall = {
      approvalId: row.record.approvalId,
      callId: row.record.callId,
      toolId: row.record.toolId,
      summary: row.summary,
    };
    const scopes = row.allowedScopes ?? ["once"];
    const held = cards.get(key);
    if (held === undefined) {
      cards.set(key, {
        key,
        taskId: row.record.taskId,
        chatTaskId: row.rootTaskId ?? row.record.taskId,
        steps: row.record.steps,
        calls: [call],
        taskTitle: row.taskTitle,
        principalId: row.principalId ?? row.task?.principalId,
        risk: row.risk,
        expiresAt: row.expiresAt,
        allowedScopes: SCOPE_ORDER.filter((scope) => scopes.includes(scope)),
        announcedIn: row.announcedIn,
        createdAt: row.record.createdAt,
        scheduled: row.task?.origin === "schedule",
        lastingChat: row.lastingChat === true,
        provenance: canvasProvenance(row.provenance),
      });
      continue;
    }
    cards.set(key, {
      ...held,
      calls: [...held.calls, call],
      taskTitle: held.taskTitle ?? row.taskTitle,
      risk: higher(held.risk, row.risk),
      // The round's scopes are what every call allows.
      allowedScopes: held.allowedScopes.filter((scope) => scopes.includes(scope)),
      expiresAt:
        held.expiresAt === undefined || (row.expiresAt !== undefined && row.expiresAt < held.expiresAt)
          ? (row.expiresAt ?? held.expiresAt)
          : held.expiresAt,
      announcedIn: held.announcedIn ?? row.announcedIn,
      provenance: held.provenance ?? canvasProvenance(row.provenance),
    });
  }
  return [...cards.values()].map((card) => (card.allowedScopes.length === 0 ? { ...card, allowedScopes: ["once"] } : card));
}

/**
 * The order cards are shown in: the ones already shown keep their place while
 * they are still listed or were decided here (a decided card stays, collapsed,
 * rather than vanishing under the reader), and new ones follow.
 */
export function keepOrder(shown: readonly string[], listed: readonly string[], kept: ReadonlySet<string>): readonly string[] {
  const now = new Set(listed);
  const order = shown.filter((key) => now.has(key) || kept.has(key));
  const placed = new Set(order);
  return [...order, ...listed.filter((key) => !placed.has(key))];
}

/** What a button that grants `scope` says: the chat's approval card's words. */
export const SCOPE_BUTTONS: Readonly<Record<ApprovalScope, string>> = {
  once: "Allow once",
  session: "Allow for this chat",
  always: "Always allow",
};

/** The `session` button in a chat that never ends: the grant lasts a day. */
export const LASTING_SESSION_BUTTON = "Allow until tomorrow";

/** What a card's button for `scope` says: a Home's or a messaging chat's chat grant says how long it lasts. */
export function scopeButton(scope: ApprovalScope, lastingChat: boolean): string {
  return scope === "session" && lastingChat ? LASTING_SESSION_BUTTON : SCOPE_BUTTONS[scope];
}

/**
 * A round's countdown at minute resolution: "expires in 2 h 14 min",
 * "expires in 5 min", and past its time "expired".
 */
export function expiryLabel(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left)) return "";
  if (left <= 0) return "expired";
  return `expires in ${durationText(left)}`;
}

// ---- Times and people ------------------------------------------------------

/**
 * When something was decided, in the workspace zone: the time alone today,
 * "Mon 16:09" within the last week, the date before that.
 */
export function whenLabel(iso: string, timeZone: string | undefined, today: string): string {
  const date = localDate(iso, timeZone);
  if (date === today) return localTime(iso, timeZone);
  const day = shortDay(date, today);
  if (date >= shiftDate(today, -6) && date < today) return `${day.slice(0, 3)} ${localTime(iso, timeZone)}`;
  return day.slice(4);
}

/** Who decided, as the page names them: a person's name when the summary has it, the policy for an expiry. */
export function deciderLabel(decidedBy: string | null | undefined, people: Readonly<Record<string, string>>): string | undefined {
  if (decidedBy === null || decidedBy === undefined || decidedBy === "") return undefined;
  if (decidedBy === APPROVAL_EXPIRED_DECIDER || decidedBy.startsWith("policy:")) return "policy";
  return people[decidedBy] ?? decidedBy;
}

/**
 * A round decided somewhere else, as its card says it: "Already decided in
 * Telegram by Ana, 14:02". An expiry and a cancellation say so instead.
 */
export function settledText(
  settled: ApprovalSettlement,
  timeZone: string | undefined,
  today: string,
  people: Readonly<Record<string, string>>,
): string {
  const when = whenLabel(settled.decidedAt, timeZone, today);
  if (settled.state === "expired") return `Already expired without a decision, ${when}`;
  if (settled.state === "cancelled") return `Already closed with its task, ${when}`;
  return `Already decided${throughWhom(settled.channel ?? settled.via, settled.decidedBy, people)}, ${when}`;
}

/** " in Telegram by Ana": where a decision came through, and who made it, each when known. */
function throughWhom(channel: string | undefined, decidedBy: string | null | undefined, people: Readonly<Record<string, string>>): string {
  const by = deciderLabel(decidedBy, people);
  return `${channel === undefined ? "" : ` in ${channel}`}${by === undefined ? "" : ` by ${by}`}`;
}

// ---- History ---------------------------------------------------------------

/** A history item's own key, across pages. */
export function historyKey(item: ApprovalHistoryItem): string {
  switch (item.kind) {
    case "approval":
      return `approval:${item.approvalId}`;
    case "review":
      return `review:${item.artifactId}`;
    case "question":
      return `question:${item.waitId}`;
    case "connect":
      return `connect:${item.waitId}`;
  }
}

/** The verdicts a reader filters by; each is one or more owner states. */
export type VerdictFilter = "approved" | "rejected" | "answered" | "connected" | "declined" | "expired" | "cancelled";

const VERDICT_STATES: Readonly<Record<VerdictFilter, readonly ApprovalHistoryState[]>> = {
  approved: ["granted", "approved"],
  rejected: ["denied", "rejected"],
  answered: ["answered"],
  // A connect need: signed in, or *Not now*.
  connected: ["connected"],
  declined: ["declined"],
  expired: ["expired"],
  cancelled: ["cancelled"],
};

export const VERDICT_LABELS: Readonly<Record<VerdictFilter, string>> = {
  approved: "Approved",
  rejected: "Rejected",
  answered: "Answered",
  connected: "Connected",
  declined: "Not now",
  expired: "Expired",
  cancelled: "Cancelled",
};

export const KIND_FILTERS: readonly { readonly value: ApprovalHistoryKind | "all"; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "approval", label: "Approvals" },
  { value: "review", label: "Reviews" },
  { value: "question", label: "Questions" },
  { value: "connect", label: "Connect" },
];

/** The owner states a verdict filter asks for, narrowed to what the kind can have. */
function statesOf(verdict: VerdictFilter, kind: ApprovalHistoryKind | "all"): readonly ApprovalHistoryState[] {
  const states = VERDICT_STATES[verdict];
  return kind === "all" ? states : states.filter((state) => APPROVAL_HISTORY_STATES_BY_KIND[kind].includes(state));
}

/** The verdict chips a kind offers: only outcomes items of that kind can have. */
export function verdictFilters(kind: ApprovalHistoryKind | "all"): readonly VerdictFilter[] {
  return (Object.keys(VERDICT_STATES) as VerdictFilter[]).filter((verdict) => statesOf(verdict, kind).length > 0);
}

/** The filters as the owner's `approvals history` takes them. */
export function historyFilters(
  kind: ApprovalHistoryKind | "all",
  verdict: VerdictFilter | "all",
  principalId: string | "all",
  toolId: string | "all" = "all",
) {
  return {
    ...(kind === "all" ? {} : { kinds: [kind] }),
    ...(verdict === "all" ? {} : { states: statesOf(verdict, kind) }),
    ...(principalId === "all" ? {} : { principalId }),
    // A tool names approvals only: the owner leaves reviews and questions out.
    ...(toolId === "all" || (kind !== "all" && kind !== "approval") ? {} : { toolId }),
  };
}

/** A decided item's verdict, as its row says it and colours it. */
export function verdictOf(state: ApprovalHistoryState): VerdictFilter {
  switch (state) {
    case "granted":
    case "approved":
      return "approved";
    case "denied":
    case "rejected":
      return "rejected";
    default:
      return state;
  }
}

export const SCOPE_LABELS: Readonly<Record<ApprovalScope, string>> = {
  once: "Once",
  session: "This chat",
  always: "Always",
};

/**
 * Everything waiting on the reader, as one queue:
 * a round of tool calls, a question, or results to review.
 */
export type InboxItem =
  | {
      readonly kind: "approval";
      readonly key: string;
      readonly taskId: string;
      readonly title: string | undefined;
      readonly scheduled: boolean;
      readonly deadlineAt: string | undefined;
      readonly askedAt: string;
      readonly card: PendingRoundCard;
    }
  | {
      readonly kind: "question";
      readonly key: string;
      readonly taskId: string;
      readonly title: string | undefined;
      readonly scheduled: boolean;
      readonly deadlineAt: string;
      readonly askedAt: string;
      readonly row: PendingQuestionRow;
    }
  | {
      readonly kind: "review";
      readonly key: string;
      readonly taskId: string;
      readonly title: string | undefined;
      readonly scheduled: boolean;
      readonly deadlineAt: undefined;
      readonly askedAt: string;
      readonly row: PendingReviewRow;
    };

export const INBOX_FILTERS = ["all", "question", "approval", "review", "scheduled"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
export const INBOX_FILTER_LABELS: Readonly<Record<InboxFilter, string>> = {
  all: "All",
  question: "Questions",
  approval: "Approvals",
  review: "Reviews",
  scheduled: "From schedules",
};

/** The items of one task, kept together: a task's round and its question are decided side by side. */
export interface InboxGroup {
  readonly taskId: string;
  readonly title: string | undefined;
  readonly items: readonly InboxItem[];
}

const soonest = (
  a: { readonly deadlineAt: string | undefined; readonly askedAt: string },
  b: { readonly deadlineAt: string | undefined; readonly askedAt: string },
): number => {
  if (a.deadlineAt !== b.deadlineAt) {
    if (a.deadlineAt === undefined) return 1;
    if (b.deadlineAt === undefined) return -1;
    return Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt);
  }
  return Date.parse(a.askedAt) - Date.parse(b.askedAt);
};

/**
 * The queue a person takes in order: grouped by task, each group placed by its
 * soonest deadline (an undated one after every dated one), then its oldest ask.
 */
export function inboxGroups(items: readonly InboxItem[], filter: InboxFilter): InboxGroup[] {
  const shown = items.filter((item) => filter === "all" || (filter === "scheduled" ? item.scheduled : item.kind === filter));
  // Sorted first, so each group's first item is its soonest, and groups keep that order.
  const groups = new Map<string, { readonly first: InboxItem; readonly items: InboxItem[] }>();
  for (const item of [...shown].sort(soonest)) {
    const group = groups.get(item.taskId);
    if (group === undefined) groups.set(item.taskId, { first: item, items: [item] });
    else group.items.push(item);
  }
  return [...groups.values()].map(({ first, items }) => ({
    taskId: first.taskId,
    title: items.find((item) => item.title !== undefined)?.title,
    items,
  }));
}

/** Something that left the queue without being acted on here, and how the history says it ended. */
export interface ResolvedNeed {
  readonly key: string;
  readonly text: string;
}

/**
 * A need that left the queue while the page was open — answered in a chat, by
 * an email link, by its deadline — said as one line: "Ana answered “Monday”
 * in Telegram, 14:02". The history names who and how; without its record, only that it was resolved elsewhere.
 */
export function resolvedText(
  what: string,
  item: ApprovalHistoryItem | undefined,
  timeZone: string | undefined,
  today: string,
  people: Readonly<Record<string, string>>,
): string {
  if (item === undefined) return `${what} — resolved elsewhere`;
  const when = whenLabel(item.decidedAt, timeZone, today);
  const through = throughWhom(
    item.kind === "review" || item.kind === "connect" ? undefined : (item.channel ?? item.via),
    item.decidedBy,
    people,
  );
  if (item.kind === "connect")
    return item.state === "connected"
      ? `${what} — ${item.appName} signed in, ${when}`
      : item.state === "declined"
        ? `${what} — not now${through}, ${when}`
        : item.state === "expired"
          ? `${what} — nobody signed in in time, ${when}`
          : `${what} — closed with its task, ${when}`;
  if (item.state === "expired")
    return item.kind === "question" ? `${what} — no answer came in time, ${when}` : `${what} — expired without a decision, ${when}`;
  if (item.state === "cancelled") return `${what} — closed with its task, ${when}`;
  if (item.kind === "question") return `${what} — answered${item.answer === null ? "" : ` “${item.answer}”`}${through}, ${when}`;
  return `${what} — ${VERDICT_LABELS[verdictOf(item.state)].toLowerCase()}${through}, ${when}`;
}

/** The round's provenance line as the canvas shows it: the channels' leading warning glyph dropped (the card styles the line). */
function canvasProvenance(line: string | undefined): string | undefined {
  return line?.replace(/^\u26a0\ufe0f?\s*/u, "");
}
