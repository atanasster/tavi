import { Fragment, memo, useMemo } from "react";

import type { AttemptBoundary, SettledWait, ToolCard, TranscriptEntry } from "@tavi/client/browser";
import { Markdown } from "../../ui/Markdown.js";
import { useT } from "../../lib/i18n.js";
import { QuestionReceipt } from "../needs/NeedCard.js";
import { HandoffReceipt } from "./Receipts.js";
import { EntryBoundary, Tool, ToolGroup, countRender, failoverText } from "./ToolCards.js";

/**
 * How a transcript is drawn.
 *
 * Three rules live here, and each is a named cure for something the single
 * column of cards did badly:
 *
 * - **Consecutive tool calls are one collapsed block**, not a column of
 *   sibling cards. "The transcript is all tool output" is the complaint; a
 *   group that says how many calls it holds hides nothing. A resume after an
 *   approval or an answer is not a break in the work: it draws nothing, and a
 *   failover is a note inside the block rather than a row between blocks.
 * - **Tool cards are a registry, not a `switch`**: a renderer per tool family
 *   with a generic fallback, so a new tool is a new renderer rather than an
 *   edit to the entry component.
 * - **Every entry is its own error boundary.** One malformed tool payload must
 *   not blank the transcript: the row says what it could not render and the
 *   session goes on.
 */

/** A run of consecutive tool cards with the failovers among them, or a single entry of any other kind. */
export type TranscriptGroup =
  | { readonly kind: "entry"; readonly key: string; readonly entry: TranscriptEntry }
  | { readonly kind: "tools"; readonly key: string; readonly cards: readonly ToolCard[]; readonly failovers: readonly AttemptBoundary[] };

/**
 * Fold consecutive tool cards together. A lone tool call is still a group of
 * one, so it renders the same way whether or not a neighbour joins it later —
 * a card that changed shape when the next call arrived would move under the
 * reader's cursor.
 *
 * Boundaries do not end a run. A resume (a boundary that discards nothing) is
 * dropped: the decision that caused it already shows on its card and in the
 * Activity tab. A failover joins the run open when it arrives, else the next
 * run to start; it stands alone only when no run is open and text comes
 * before the next call.
 */
export function groupEntries(entries: readonly TranscriptEntry[]): readonly TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  /** The run being built, appended to in place: copying it per card is quadratic in a tool-heavy turn. */
  let run: { cards: ToolCard[]; failovers: AttemptBoundary[] } | undefined;
  /** Failovers seen since the last run ended, waiting for the next to start. */
  let held: AttemptBoundary[] = [];
  const release = () => {
    for (const boundary of held) groups.push({ kind: "entry", key: boundary.key, entry: boundary });
    held = [];
  };
  for (const entry of entries) {
    if (entry.kind === "boundary") {
      if (entry.discarded !== true) continue;
      (run?.failovers ?? held).push(entry);
      continue;
    }
    if (entry.kind !== "tool") {
      release();
      run = undefined;
      groups.push({ kind: "entry", key: entry.key, entry });
      continue;
    }
    if (run !== undefined) {
      run.cards.push(entry);
      continue;
    }
    run = { cards: [entry], failovers: held };
    held = [];
    groups.push({ kind: "tools", key: entry.key, ...run });
  }
  release();
  return groups;
}

/**
 * The turn read untrusted content, and the URLs its conversation holds: a novel
 * link in its answer names its host and asks before it opens (`MarkdownBody`).
 */
type LinkTaint = { readonly tainted?: boolean | undefined; readonly knownUrls?: readonly string[] | undefined };

/** Text, a steered message, a tool card, or a failover outside any group; a resume draws nothing. */
const Entry = memo(function Entry({ entry, tainted, knownUrls }: { readonly entry: TranscriptEntry } & LinkTaint) {
  countRender?.(entry.key);
  const t = useT();
  switch (entry.kind) {
    case "text":
      return (
        <div className={entry.discarded === true ? "text discarded" : "text"}>
          {/* Struck through on screen; said in words for a screen reader. */}
          <span className="visually-hidden">
            {t(entry.discarded === true ? "transcript.entry.discarded" : "transcript.entry.assistant")}
          </span>
          <Markdown text={entry.text} tainted={tainted} knownUrls={knownUrls} />
        </div>
      );
    case "tool":
      // `Transcript` routes tool cards through `ToolGroup`; this arm keeps the
      // switch exhaustive over `TranscriptEntry` and `Entry` usable on its own.
      return <Tool card={entry} />;
    case "boundary":
      // `Transcript` reaches this only for a failover outside any group; a resume draws nothing.
      return entry.discarded === true ? <p className="boundary">{failoverText(entry)}</p> : null;
    case "steer":
      // A message the person sent into the running turn, where the model read it.
      return (
        <div className="user-message steered">
          <div className="message-heading" aria-hidden="true">
            {t("transcript.entry.steerHeading")}
          </div>
          <p className="prompt">
            <span className="visually-hidden">{t("transcript.entry.steerSaid")}</span>
            {entry.text}
          </p>
        </div>
      );
  }
});

/**
 * Which receipt follows which card. A settled question's wait is named
 * for its call (`waitRowId(task, steps, callId)`), and a provider may reuse a
 * call id across turns, so receipts for one id are handed out in order: each
 * `operator.ask_user` card that completed (its answer read) takes the next. One
 * not yet completed — the resume still on its way — follows the last card that
 * asked it.
 */
export function placeReceipts(
  entries: readonly TranscriptEntry[],
  receipts: readonly SettledWait[],
): ReadonlyMap<string, readonly SettledWait[]> {
  const waiting = [...receipts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // A browser call takes only a handoff's receipt, a question only a question's: a reused call id cannot cross them.
  const take = (callId: string, handoff: boolean): SettledWait | undefined => {
    const index = waiting.findIndex((receipt) => receipt.waitId.endsWith(`:${callId}`) && (receipt.handedOver === true) === handoff);
    return index < 0 ? undefined : waiting.splice(index, 1)[0];
  };
  const placed = new Map<string, SettledWait[]>();
  const put = (key: string, receipt: SettledWait) => placed.set(key, [...(placed.get(key) ?? []), receipt]);
  const asks: { readonly key: string; readonly callId: string; readonly handoff: boolean }[] = [];
  for (const entry of entries) {
    // A question's card, or a browser call that waited for a person.
    if (entry.kind !== "tool" || (entry.toolName !== "operator.ask_user" && !entry.toolName.startsWith("browser."))) continue;
    const handoff = entry.toolName !== "operator.ask_user";
    asks.push({ key: entry.key, callId: entry.callId, handoff });
    if (entry.status !== "completed") continue;
    const next = take(entry.callId, handoff);
    if (next !== undefined) put(entry.key, next);
  }
  for (const ask of [...asks].reverse()) {
    for (let next = take(ask.callId, ask.handoff); next !== undefined; next = take(ask.callId, ask.handoff)) put(ask.key, next);
  }
  return placed;
}

/** The transcript's entries, grouped and each guarded; each settled question's receipt after the card that asked it. */
export function Transcript({
  entries,
  receipts = [],
  timeZone,
  tainted,
  knownUrls,
}: {
  readonly entries: readonly TranscriptEntry[];
  readonly receipts?: readonly SettledWait[] /** The workspace's zone, the one a receipt's time is said in. */;
  readonly timeZone?: string | undefined;
} & LinkTaint) {
  // Re-folded whenever the entries change, which a delta does; the fold is
  // cheap. What must not be repeated is rendering the groups, which
  // `ToolGroup`'s own comparison prevents.
  const groups = useMemo(() => groupEntries(entries), [entries]);
  const placed = useMemo(() => placeReceipts(entries, receipts), [entries, receipts]);
  return (
    <>
      {groups.map((group) =>
        group.kind === "tools" ? (
          <Fragment key={group.key}>
            <ToolGroup cards={group.cards} failovers={group.failovers} />
            {group.cards
              .flatMap((card) => placed.get(card.key) ?? [])
              .map((receipt) =>
                receipt.handedOver === true ? (
                  <HandoffReceipt key={receipt.waitId} receipt={receipt} />
                ) : (
                  <QuestionReceipt key={receipt.waitId} receipt={receipt} timeZone={timeZone} />
                ),
              )}
          </Fragment>
        ) : (
          <EntryBoundary key={group.key} what={group.entry.kind === "text" ? "answer" : group.entry.kind === "steer" ? "message" : "note"}>
            <Entry entry={group.entry} tainted={tainted} knownUrls={knownUrls} />
          </EntryBoundary>
        ),
      )}
    </>
  );
}
