import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";

import {
  toolCallTitle,
  type CenterSummaryAnswer,
  type PendingConnectRow,
  type PendingQuestionRow,
  type PendingReviewRow,
} from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";

import { useOpenError } from "../../hooks/use-action.js";
import { MINUTE_TICK_MS, useNow } from "../../hooks/use-poll.js";
import { todayIn } from "../../lib/time.js";
import { Empty } from "../../ui/Empty.js";
import { Failure, FilterChip, LoadState, Notice, PageHead } from "../../ui/Parts.js";
import { ConnectCard } from "../apps/ConnectCard.js";
import type { AnswerState } from "../needs/NeedCard.js";
import { NeedNotifyToggle } from "../needs/NeedNotify.js";
import { AppLink } from "../shell/AppLink.js";
import { isBareKeyOutsideText } from "../shell/keys.js";
import { taskPath } from "../shell/route.js";
import { answerNeed, decideRound, listHistory, listNeeds, listPendingApprovals, loadRoundCalls } from "./approvals-api.js";
import {
  groupRounds,
  inboxGroups,
  INBOX_FILTER_LABELS,
  INBOX_FILTERS,
  keepOrder,
  resolvedText,
  LASTING_SESSION_BUTTON,
  SCOPE_BUTTONS,
  settledText,
  type InboxFilter,
  type InboxItem,
  type PendingRoundCard,
  type ResolvedNeed,
} from "./inbox-model.js";
import { HistoryTable } from "./InboxHistory.js";
import { QuestionNeedCard, ReviewNeedCard } from "./InboxNeedCards.js";
import { type CardOutcome, type RoundDecision, RoundCard } from "./InboxRoundCard.js";
import { personName } from "./model.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * Approvals: what
 * waits on the reader across every task — tool calls, questions and reviews —
 * as one queue, the soonest deadline first and each task's needs together; and
 * what was decided before. A tool call is decided here with the same `approve`
 * command the task's own card sends, and a question answered here with its own
 * card. A review needs the archived results, so its card opens the task.
 */

/** The id `Waiting` carries, so the rail's "Waiting on you" lands on it. */
export const WAITING_ANCHOR = "center-waiting";

interface Waiting {
  /** Cards in the order shown; a card decided here keeps its place after it leaves the list. */
  readonly order: readonly string[];
  readonly cards: Readonly<Record<string, PendingRoundCard>>;
  readonly outcomes: Readonly<Record<string, CardOutcome>>;
}

export function ApprovalsInbox({
  summary,
  revision,
  principal,
  onOpenTask,
  onPermissions,
}: {
  /** The feed's summary: the zone, today and people's names. */
  readonly summary: CenterSummaryAnswer | undefined;
  /** Moves when the feed reports `approval`, `review` or `question`: both lists are read again. */
  readonly revision: number;
  /** Who a decision here is recorded as, as the task's own card records it. */
  readonly principal?: string | undefined;
  readonly onOpenTask: (taskId: string) => Promise<void>;
  /** Settings → Permissions, where an "Always allow" rule is revoked; with a rule, that rule. */
  readonly onPermissions: (ruleId?: string) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const timeZone = summary?.timezone;
  const today = summary?.today ?? todayIn(timeZone);
  const people = summary?.people ?? {};

  // ---- Waiting ----
  const [waiting, setWaiting] = useState<Waiting>({ order: [], cards: {}, outcomes: {} });
  const [waits, setWaits] = useState<{
    readonly questions: readonly PendingQuestionRow[];
    readonly reviews: readonly PendingReviewRow[];
  }>();
  /** Chats waiting for an app to be signed in again: connected or declined from here. */
  const [connects, setConnects] = useState<readonly PendingConnectRow[]>([]);
  /** Questions answered here, kept (as their receipt) until the page is left. */
  const [answered, setAnswered] = useState<
    Readonly<Record<string, { readonly row: PendingQuestionRow; readonly state: AnswerState | "elsewhere" }>>
  >({});
  const [filter, setFilter] = useState<InboxFilter>("all");
  /** Needs that left the queue while the page was open, newest first: resolved somewhere else. */
  const [resolved, setResolved] = useState<readonly ResolvedNeed[]>([]);
  /** What the last read listed, to tell what has since left the queue. */
  const listedBefore = useRef<
    | {
        readonly rounds: ReadonlyMap<string, PendingRoundCard>;
        readonly questions: ReadonlyMap<string, PendingQuestionRow>;
        readonly questionsWhole: boolean;
      }
    | undefined
  >(undefined);
  /** What was acted on here, which leaves the queue as its own receipt. */
  const actedHere = useRef(new Set<string>());
  const [truncated, setTruncated] = useState(false);
  const [needsTruncated, setNeedsTruncated] = useState(false);
  const [waitingError, setWaitingError] = useState<string>();
  const [waitingAttempt, setWaitingAttempt] = useState(0);
  const { openError, open: openTask } = useOpenError();
  // A countdown says minutes, so it moves once a minute.
  const now = useNow(MINUTE_TICK_MS);
  /** Unset on unmount: a decision answered after it is dropped. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    void Promise.all([listPendingApprovals(client, workspaceId), listNeeds(client, workspaceId)]).then(([approvals, needs]) => {
      if (!current) return;
      const roundsRead = approvals.ok ? groupRounds(approvals.value.rows) : undefined;
      const failure = !approvals.ok ? approvals.message : !needs.ok ? needs.message : undefined;
      setWaitingError(failure);
      if (approvals.ok) {
        const rounds = roundsRead ?? groupRounds(approvals.value.rows);
        setTruncated(approvals.value.truncated);
        setWaiting((held) => {
          // A card acted on stays, collapsed, until the page is left; one that
          // failed goes with its round.
          const kept = new Set(
            Object.entries(held.outcomes)
              .filter(([, outcome]) => outcome.kind !== "error")
              .map(([key]) => key),
          );
          const order = keepOrder(
            held.order,
            rounds.map((round) => round.key),
            kept,
          );
          const listed = new Map(rounds.map((round) => [round.key, round]));
          const cards: Record<string, PendingRoundCard> = {};
          for (const key of order) {
            const card = listed.get(key) ?? held.cards[key];
            if (card !== undefined) cards[key] = card;
          }
          return { order, cards, outcomes: held.outcomes };
        });
      }
      if (needs.ok) {
        setWaits({
          questions: needs.value.needs.flatMap((need) => (need.kind === "question" ? [need.question] : [])),
          reviews: needs.value.needs.flatMap((need) => (need.kind === "review" ? [need.review] : [])),
        });
        setConnects(needs.value.needs.flatMap((need) => (need.kind === "connect" ? [need.connect] : [])));
        setNeedsTruncated(needs.value.truncated);
      }
      if (approvals.ok && needs.ok) {
        // What left the queue since the last read, not acted on here, was
        // resolved somewhere else: the history says by whom and how.
        const rounds = new Map((roundsRead ?? []).map((card) => [card.key, card]));
        const questionRows = new Map(
          needs.value.needs.flatMap((need) => (need.kind === "question" ? [[need.question.waitId, need.question] as const] : [])),
        );
        const before = listedBefore.current;
        listedBefore.current = { rounds, questions: questionRows, questionsWhole: !needs.value.truncated };
        const goneRounds =
          before === undefined
            ? []
            : [...before.rounds.values()].filter((card) => !rounds.has(card.key) && !actedHere.current.has(card.key));
        // A page of questions is cut by deadline: one pushed off a full page by a
        // sooner one has not left the queue, so only whole reads are compared.
        const comparable = before?.questionsWhole === true && !needs.value.truncated;
        const goneQuestions =
          before === undefined || !comparable
            ? []
            : [...before.questions.values()].filter((row) => !questionRows.has(row.waitId) && !actedHere.current.has(row.waitId));
        if (goneRounds.length + goneQuestions.length > 0) {
          void listHistory(client, workspaceId, {}).then((history) => {
            if (!mounted.current) return;
            const items = history.ok ? history.value.items : [];
            const lines: ResolvedNeed[] = [
              ...goneQuestions.map((row) => ({
                key: `question:${row.waitId}`,
                text: resolvedText(
                  `“${row.question}”`,
                  items.find((item) => item.kind === "question" && item.waitId === row.waitId),
                  timeZone,
                  today,
                  people,
                ),
              })),
              ...goneRounds.map((card) => ({
                key: `approval:${card.key}`,
                text: resolvedText(
                  card.calls.length === 1
                    ? card.calls[0] === undefined
                      ? "A tool call"
                      : toolCallTitle(card.calls[0].toolId, card.calls[0].summary)
                    : `${card.calls.length} tool calls`,
                  items.find((item) => item.kind === "approval" && card.calls.some((call) => call.approvalId === item.approvalId)),
                  timeZone,
                  today,
                  people,
                ),
              })),
            ];
            setResolved((held) => [...lines, ...held.filter((line) => !lines.some((added) => added.key === line.key))].slice(0, 20));
          });
        }
      }
    });
    return () => {
      current = false;
    };
  }, [client, workspaceId, revision, waitingAttempt]);

  const setOutcome = (key: string, outcome: CardOutcome): void =>
    setWaiting((held) => ({ ...held, outcomes: { ...held.outcomes, [key]: outcome } }));

  const decide = (card: PendingRoundCard, decision: RoundDecision): void => {
    const { approved, scope, decisions, note } = decision;
    actedHere.current.add(card.key);
    setOutcome(card.key, { kind: "busy" });
    void decideRound(client, {
      workspaceId,
      taskId: card.taskId,
      steps: card.steps,
      approved,
      scope,
      decidedBy: principal,
      decisions,
      note,
    }).then((outcome) => {
      if (!mounted.current) return;
      const partial =
        decisions === undefined ? undefined : { approved: decisions.filter((call) => call.approved).length, of: decisions.length };
      if (outcome.ok) setOutcome(card.key, { kind: "done", approved, scope, ...(partial === undefined ? {} : { partial }) });
      else if (outcome.settled !== undefined)
        setOutcome(card.key, { kind: "settled", text: settledText(outcome.settled, timeZone, today, people) });
      else setOutcome(card.key, { kind: "error", message: outcome.message });
    });
  };

  const answer = (row: PendingQuestionRow, text: string): void => {
    actedHere.current.add(row.waitId);
    setAnswered((held) => ({ ...held, [row.waitId]: { row, state: { status: "sending", text } } }));
    void answerNeed(client, { workspaceId, taskId: row.taskId, waitId: row.waitId, answer: text }).then((outcome) => {
      if (!mounted.current) return;
      const state: AnswerState | "elsewhere" = outcome.ok
        ? { status: "recorded", text }
        : outcome.code === "CONFLICT"
          ? "elsewhere"
          : { status: "failed", text, message: outcome.message };
      setAnswered((held) => ({ ...held, [row.waitId]: { row, state } }));
    });
  };

  const open = (taskId: string): void => openTask(`Task ${taskId}`, () => onOpenTask(taskId));

  const rounds = waiting.order.map((key) => waiting.cards[key]).filter((card): card is PendingRoundCard => card !== undefined);
  const pendingRounds = rounds.filter(
    (card) =>
      waiting.outcomes[card.key] === undefined ||
      waiting.outcomes[card.key]?.kind === "busy" ||
      waiting.outcomes[card.key]?.kind === "error",
  ).length;
  // A question answered here stays, as its receipt, after the owner stops
  // listing it; one whose answer failed or is unsettled goes when the owner
  // drops it — it expired, or was answered elsewhere.
  const listedQuestions = waits?.questions ?? [];
  const isReceipt = (state: AnswerState | "elsewhere" | undefined): boolean => state === "elsewhere" || state?.status === "recorded";
  const questions = [
    ...listedQuestions,
    ...Object.values(answered)
      .filter((entry) => isReceipt(entry.state) && !listedQuestions.some((listed) => listed.waitId === entry.row.waitId))
      .map((entry) => entry.row),
  ];
  const reviews = waits?.reviews ?? [];
  const stillOpen = (row: PendingQuestionRow): boolean => {
    const state = answered[row.waitId]?.state;
    return state === undefined || (state !== "elsewhere" && state.status === "failed");
  };
  const openQuestions = questions.filter(stillOpen).length;
  const loaded = waits !== undefined || rounds.length > 0;
  const nothing =
    loaded && waitingError === undefined && rounds.length === 0 && reviews.length === 0 && questions.length === 0 && connects.length === 0;
  const waitingCounts = [
    openQuestions === 0 ? undefined : plural(openQuestions, "question"),
    pendingRounds === 0 ? undefined : plural(pendingRounds, "approval"),
    reviews.length === 0 ? undefined : plural(reviews.length, "review"),
    connects.length === 0 ? undefined : plural(connects.length, "app to connect", "apps to connect"),
  ].filter((part) => part !== undefined);
  const items: InboxItem[] = [
    ...rounds.map(
      (card): InboxItem => ({
        kind: "approval",
        key: `approval:${card.key}`,
        taskId: card.taskId,
        title: card.taskTitle,
        scheduled: card.scheduled,
        deadlineAt: card.expiresAt,
        askedAt: card.createdAt,
        card,
      }),
    ),
    ...questions.map(
      (row): InboxItem => ({
        kind: "question",
        key: `question:${row.waitId}`,
        taskId: row.taskId,
        title: row.taskTitle,
        scheduled: row.origin === "schedule",
        deadlineAt: row.deadlineAt,
        askedAt: row.askedAt,
        row,
      }),
    ),
    ...reviews.map(
      (row): InboxItem => ({
        kind: "review",
        key: `review:${row.taskId}`,
        taskId: row.taskId,
        title: row.taskTitle,
        scheduled: row.origin === "schedule",
        deadlineAt: undefined,
        askedAt: row.askedAt,
        row,
      }),
    ),
  ];
  // Every card stays mounted under any filter, hidden when filtered out: an
  // option in its undo window, or words half-typed, survive a chip.
  const groups = inboxGroups(items, "all");
  /**
   * Triage by keyboard: `j`/`k` move between the
   * cards shown; on a card `a` approves, `s` approves for the task, `r` starts
   * a rejection and `o` opens its task; a question's own keys (1–4, Enter, `o`
   * for own words) work once its card has focus. Never while typing.
   */
  const triage = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (!isBareKeyOutsideText(event)) return;
    const target = event.target as HTMLElement;
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>(":scope > li.center-card:not([hidden])")];
    const at = cards.findIndex((card) => card.contains(target));
    const focusCard = (card: HTMLElement | undefined) => {
      if (card === undefined) return;
      // A question's card takes focus on its question, where its own keys work; any other on itself.
      const question = card.querySelector<HTMLElement>(".need-question-text");
      (question ?? card).focus();
    };
    if (event.key === "j" || event.key === "k") {
      event.preventDefault();
      focusCard(cards[at < 0 ? 0 : Math.min(cards.length - 1, Math.max(0, at + (event.key === "j" ? 1 : -1)))]);
      return;
    }
    const card = cards[at];
    if (card === undefined || card.classList.contains("center-card-question")) return;
    const press = (label: (text: string) => boolean) =>
      [...card.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => !button.disabled && label(button.textContent ?? ""))
        ?.click();
    const keys: Readonly<Record<string, (text: string) => boolean>> = {
      a: (text) => text === SCOPE_BUTTONS.once || text === "Allow ticked, deny the rest",
      s: (text) => text === SCOPE_BUTTONS.session || text === LASTING_SESSION_BUTTON,
      r: (text) => text === "Deny…",
      o: (text) => text === "Open",
    };
    const label = keys[event.key];
    if (label === undefined) return;
    event.preventDefault();
    // A card without an Open button opens through its task's link.
    if (event.key === "o" && ![...card.querySelectorAll("button")].some((button) => button.textContent === "Open")) {
      card.querySelector<HTMLAnchorElement>(".center-card-ctx a")?.click();
      return;
    }
    press(label);
  };
  const shown = new Set(inboxGroups(items, filter).flatMap((group) => group.items.map((item) => item.key)));
  /** Whether an item still waits — not a receipt of an answer, nor a decided round. */
  const stillWaits = (item: InboxItem): boolean =>
    item.kind === "question"
      ? stillOpen(item.row)
      : item.kind === "approval"
        ? waiting.outcomes[item.card.key] === undefined ||
          waiting.outcomes[item.card.key]?.kind === "busy" ||
          waiting.outcomes[item.card.key]?.kind === "error"
        : true;
  const personOf = (principalId: string | undefined) => personName(people, principalId);

  return (
    <section className="center-section" aria-labelledby="center-approvals-title">
      <PageHead
        className="center-head"
        id="center-approvals-title"
        title="Approvals"
        description="Questions, tool calls and reviews waiting on you across every chat and schedule — the soonest first — and what you decided before."
      >
        <NeedNotifyToggle />
      </PageHead>

      <h2 className="center-subhead" id={WAITING_ANCHOR} tabIndex={-1}>
        Waiting
        {waitingCounts.length === 0 ? null : <span>{waitingCounts.join(" · ")}</span>}
      </h2>
      <LoadState
        error={waitingError}
        reload={() => setWaitingAttempt((value) => value + 1)}
        loading={!loaded && waitingError === undefined}
        status
      >
        <Failure message={openError} alert={false} />
      </LoadState>
      {nothing ? (
        <Empty className="center-empty">
          Nothing needs you. When a chat or a schedule asks something, it waits here — and in the chat it asked in.
        </Empty>
      ) : null}
      {connects.length === 0 ? null : (
        <ul className="center-cards list-reset" aria-label="Apps to connect">
          {connects.map((row) => (
            <li key={row.waitId}>
              <AppLink href={taskPath(row.taskId)} onFollow={() => open(row.taskId)}>
                {row.taskTitle ?? row.taskId}
              </AppLink>
              <ConnectCard ask={{ kind: "wait", waitId: row.waitId, request: row, deadlineAt: row.deadlineAt }} />
            </li>
          ))}
        </ul>
      )}
      {items.length === 0 ? null : (
        <p className="center-card-hint meta center-keys">
          Keys: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>1</kbd>–<kbd>4</kbd> pick an option · <kbd>a</kbd> allow once · <kbd>s</kbd> for this
          chat · <kbd>r</kbd> deny · <kbd>o</kbd> open
        </p>
      )}
      {items.length === 0 ? null : (
        <div className="center-chips" role="group" aria-label="Show">
          {INBOX_FILTERS.map((option) => (
            <FilterChip key={option} pressed={filter === option} onPick={() => setFilter(option)}>
              {INBOX_FILTER_LABELS[option]}
            </FilterChip>
          ))}
        </div>
      )}
      {items.length > 0 && shown.size === 0 ? <Empty className="center-empty">Nothing of this kind is waiting.</Empty> : null}
      {groups.length === 0 ? null : (
        <ul className="center-cards list-reset" onKeyDown={triage}>
          {groups.map((group) => (
            <Fragment key={group.taskId}>
              {group.items.filter((item) => shown.has(item.key)).length > 1 ? (
                <li className="center-group-head">
                  <AppLink href={taskPath(group.taskId)} onFollow={() => open(group.taskId)}>
                    {group.title ?? group.taskId}
                  </AppLink>
                  {group.items.filter(stillWaits).length === 0 ? null : <> · {group.items.filter(stillWaits).length} waiting</>}
                </li>
              ) : null}
              {group.items.map((item) =>
                item.kind === "approval" ? (
                  <RoundCard
                    hidden={!shown.has(item.key)}
                    key={item.key}
                    card={item.card}
                    outcome={waiting.outcomes[item.card.key]}
                    now={now}
                    person={personOf(item.card.principalId)}
                    loadCalls={() => loadRoundCalls(client, workspaceId, item.card.taskId)}
                    onDecide={(decision) => decide(item.card, decision)}
                    onOpen={() => open(item.card.chatTaskId)}
                  />
                ) : item.kind === "question" ? (
                  <QuestionNeedCard
                    hidden={!shown.has(item.key)}
                    key={item.key}
                    row={item.row}
                    state={answered[item.row.waitId]?.state}
                    person={personOf(item.row.principalId)}
                    timeZone={timeZone}
                    onAnswer={(text) => answer(item.row, text)}
                    onOpen={() => open(item.row.taskId)}
                  />
                ) : (
                  <ReviewNeedCard
                    hidden={!shown.has(item.key)}
                    key={item.key}
                    row={item.row}
                    person={personOf(item.row.principalId)}
                    onOpen={() => open(item.row.taskId)}
                  />
                ),
              )}
            </Fragment>
          ))}
        </ul>
      )}
      {resolved.length === 0 ? null : (
        <details className="center-resolved">
          <summary className="disclosure">Resolved just now ({resolved.length})</summary>
          <ul>
            {resolved.map((line) => (
              <li key={line.key}>{line.text}</li>
            ))}
          </ul>
        </details>
      )}
      {truncated ? (
        <Notice>More approvals are waiting than one page holds; the oldest are shown. Decide these to see the rest.</Notice>
      ) : null}
      {needsTruncated ? (
        <Notice>
          More questions and reviews are waiting than one page holds; the questions due soonest and the oldest reviews are shown.
        </Notice>
      ) : null}

      <HistoryTable revision={revision} timeZone={timeZone} today={today} people={people} onOpen={open} onPermissions={onPermissions} />
    </section>
  );
}
