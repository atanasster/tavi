import { useChannelNames } from "../shell/ChannelNames.js";
import { useEffect, useRef, useState } from "react";
import type { RecordedTask } from "@tavi/client/browser";
import { APPROVAL_HISTORY_MAX_LIMIT, toolCallTitle, type ApprovalHistoryItem } from "@tavi/contracts";
import { plural } from "@tavi/contracts/util";
type AdmissionRecord = NonNullable<RecordedTask["admissions"]>[number];

import { dayHeading, groupByDay, localTime, todayIn } from "../../lib/time.js";
import type { Outcome, SettingsClient } from "../../lib/ipc.js";
import { firstLine } from "../../lib/format.js";
import { CenterLink, CHAT_NOT_STARTED, Failure, LoadMore, NO_CHAT_SELECTED, Pending } from "../../ui/Parts.js";
import { appendPage, refreshFirstPage, useOlderPage, type Page, type Paged } from "../../lib/paging.js";
import type { Session } from "../shell/shell.js";
import { QuestionCard, sentAnswer, type AnswerState, type QuestionNeed } from "../needs/NeedCard.js";
import { questionBlocker, questionKey, RECONNECT_TO_ANSWER } from "../chat/store/runs.js";
import type { WorkerNeeds } from "../chat/store/types.js";
import { deciderName, decisionsOf } from "../chat/Approvals.js";
import { listHistory } from "../center/approvals-api.js";
import { admissionPrompt, readTaskRecord, type TaskRecord } from "../chat/tasks-api.js";
import { workerAsker, workerQuestionNeed } from "../workers/WorkerNeeds.js";
import { sessionPlan } from "../chat/plan.js";
import { PlanCard } from "../chat/PlanCard.js";
import { useLoaded } from "../../hooks/use-loaded.js";
import { chatVersion, turnVersion } from "./load.js";
import { matchTurns, transcriptPrompts } from "./turns.js";
import { Empty } from "../../ui/Empty.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";
import { prefersReducedMotion } from "../../lib/motion.js";
import { Button } from "../../ui/Button.js";
import { ChatPanelItem } from "./ChatPanelItem.js";

/** One line of the chat's timeline. */
export interface ActivityItem {
  readonly key: string;
  readonly at: string;
  readonly title: string;
  readonly detail: string;
  /** A turn: the `data-turn` its prompt is marked with in the transcript, when it is drawn there. */
  readonly turn?: number;
  /** A delegated task, opened in the chat. */
  readonly taskId?: string;
  /** A tool call's approval decided in the chat: how. */
  readonly verdict?: Verdict;
  /** The tool a decision was for: a run of decisions on one tool folds into one row. */
  readonly tool?: string;
}

/** A run of consecutive decisions on one tool with one verdict, as one expandable row. */
export interface DecisionFold {
  readonly kind: "fold";
  readonly key: string;
  readonly verdict: Verdict;
  readonly tool: string;
  readonly items: readonly ActivityItem[];
  /** Its newest decision (`items`' first) and its earliest (`items`' last). */
  readonly latest: ActivityItem;
  readonly earliest: ActivityItem;
}

/**
 * Fold each run of two or more consecutive decisions on the same tool with the
 * same verdict — eleven approved web searches — into one row; every other
 * item, and a lone decision, stays as it is.
 */
export function foldDecisions(items: readonly ActivityItem[]): readonly (ActivityItem | DecisionFold)[] {
  const out: (ActivityItem | DecisionFold)[] = [];
  let index = 0;
  for (let first = items[index]; first !== undefined; first = items[index]) {
    const { verdict, tool } = first;
    let end = index + 1;
    if (verdict !== undefined && tool !== undefined) {
      while (end < items.length && items[end]?.verdict === verdict && items[end]?.tool === tool) end += 1;
    }
    const run = items.slice(index, end);
    const earliest = run.at(-1);
    if (end - index >= 2 && verdict !== undefined && tool !== undefined && earliest !== undefined) {
      // Keyed by its earliest decision: a newer one joining the run (newest first) leaves an open fold open.
      out.push({ kind: "fold", key: `fold:${earliest.key}`, verdict, tool, items: run, latest: first, earliest });
    } else {
      out.push(first);
    }
    index = end;
  }
  return out;
}

/** How a tool call's approval ended, as Activity labels it. */
type Verdict = "approved" | "rejected" | "expired" | "cancelled";

const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  cancelled: "Cancelled",
};

/** An approval the owner recorded for the chat (`approvals history`). */
export type RecordedDecision = Extract<ApprovalHistoryItem, { readonly kind: "approval" }>;

/** A recorded decision as a line of the timeline. */
function recordedItem(decision: RecordedDecision): ActivityItem {
  const verdict: Verdict = decision.state === "granted" ? "approved" : decision.state === "denied" ? "rejected" : decision.state;
  const detail =
    decision.state === "expired"
      ? "No decision before it expired"
      : decision.state === "cancelled"
        ? "Closed with its chat"
        : `Decided by ${decision.decidedBy === null ? "someone" : deciderName(decision.decidedBy, decision.state === "granted" ? true : decision.state === "denied" ? false : undefined)}${decision.channel === undefined ? "" : ` in ${decision.channel}`}`;
  return {
    key: `decision:${decision.approvalId}`,
    at: decision.decidedAt,
    title: toolCallTitle(decision.toolId, decision.summary),
    detail,
    verdict,
    tool: decision.toolId,
  };
}

/** What is waiting on the reader in this chat, from its live stream. */
export interface WaitingItem {
  readonly key: string;
  readonly title: string;
  /** For a question: the run it is asked in, and the card that answers it here. */
  readonly question?: {
    readonly runId: string;
    readonly key: string;
    readonly need: QuestionNeed;
    readonly answer?: AnswerState | undefined;
    /** Set when something else must be decided first. */
    readonly blocked?: string | undefined;
  };
  /** A worker's question, answered here at the worker's wait. */
  readonly worker?: {
    readonly waitId: string;
    readonly need: QuestionNeed;
    readonly answer?: AnswerState | undefined;
  };
}

/** How an admitted turn stands, in words. */
function stateOf(admission: AdmissionRecord): string {
  if (admission.state === "pending") return "queued";
  if (admission.state === "claimed") return "working";
  if (admission.state === "refused") return "refused";
  if (admission.state === "failed") return "failed";
  return admission.result?.status === "waiting" ? "waiting" : (admission.result?.status ?? "done");
}

/**
 * The chat's timeline, newest first: each prompt it was given, with the turn
 * the transcript shows it at (`matchTurns`), and each task it delegated.
 */
export function activityOf(
  record: RecordedTask | undefined,
  session: Session,
  recorded: readonly RecordedDecision[] = [],
): readonly ActivityItem[] {
  const items: ActivityItem[] = [];
  const turns = (record?.admissions ?? []).flatMap((admission) => {
    const prompt = admissionPrompt(admission);
    return prompt === undefined || (admission.kind !== "start" && admission.kind !== "reply") ? [] : [{ admission, prompt }];
  });
  const matched = matchTurns(
    turns.map((item) => item.prompt),
    transcriptPrompts(session.runs),
  );
  /** The revision the last turn that ran was pinned to; none before one has. */
  let instructions: { readonly revision: number | undefined } | undefined;
  turns.forEach(({ admission, prompt }, index) => {
    const turn = matched[index];
    // A turn that runs under other instructions than the turn before it: said where it starts.
    const revision = admission.instructionsRevision;
    if (instructions !== undefined && revision !== instructions.revision && revision !== undefined && admission.state !== "refused") {
      items.push({
        key: `${admission.admissionId}:instructions`,
        at: admission.createdAt,
        title: `Instructions changed (revision ${revision})`,
        detail: "From this turn",
        ...(turn === undefined ? {} : { turn }),
      });
    }
    if (admission.state !== "refused") instructions = { revision };
    items.push({
      key: admission.admissionId,
      at: admission.createdAt,
      title: firstLine(prompt) || "(empty prompt)",
      detail: `${admission.kind === "start" ? "Started" : "Follow-up"} · ${stateOf(admission)}`,
      ...(turn === undefined ? {} : { turn }),
    });
  });
  const spawned = new Map<string, ActivityItem>();
  for (const run of session.runs) {
    for (const event of run.run.spawned) {
      spawned.set(event.childRunId, {
        key: `spawn:${event.childRunId}`,
        at: event.at,
        title: `Delegated to ${event.agentDefinitionId ?? event.workerAgentId}`,
        detail: `Agent task ${event.childRunId}`,
        taskId: event.childRunId,
      });
    }
  }
  items.push(...spawned.values());
  // The approvals decided in the chat: a record, kept here and not in the
  // transcript. The owner's record survives a reload; a decision the stream
  // announced since it was read is added from the stream, once.
  const known = new Set(recorded.map((decision) => `${decision.steps ?? ""}:${decision.callId}`));
  items.push(...recorded.map(recordedItem));
  for (const run of session.runs) {
    for (const decided of decisionsOf(run)) {
      if (known.has(`${decided.steps}:${decided.callId}`)) continue;
      items.push({
        key: decided.key,
        at: decided.at,
        title: decided.description === undefined ? decided.toolName : `${decided.toolName} ${decided.description}`,
        detail: `Decided by ${decided.decider}`,
        verdict: decided.approved ? "approved" : "rejected",
        tool: decided.toolName,
      });
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * What the chat is waiting on the reader for, as its stream says now, and what
 * its workers ask (`workers`); `connected` unset reads as reachable.
 */
export function waitingOf(
  session: Session,
  connected = true,
  workers?: WorkerNeeds,
  connectionName?: (connectionId: string) => string | undefined,
): readonly WaitingItem[] {
  const items: WaitingItem[] = [];
  for (const run of session.runs) {
    for (const round of run.run.pending) {
      const tools = [...new Set(round.requests.map((request) => request.toolName))];
      items.push({ key: `${run.id}:round:${round.steps}`, title: `Approve ${tools.join(", ")}` });
    }
    if (run.run.review !== undefined)
      items.push({
        key: `${run.id}:review:${run.run.review.steps}`,
        title: `Review ${plural(run.run.review.requests.length, "archived output")}`,
      });
    const waiting = run.run.waiting;
    if (waiting?.question !== undefined) {
      const key = questionKey(waiting, run.questionId);
      items.push({
        key: `${run.id}:question`,
        title: `Answer: ${firstLine(waiting.question)}`,
        question: {
          runId: run.id,
          key,
          need: { question: waiting.question, choices: waiting.choices, context: waiting.context, deadlineAt: waiting.deadlineAt },
          answer: run.answer?.key === key ? run.answer : undefined,
          blocked: questionBlocker(run, connected, {
            round: "Decide the approval in the chat first.",
            review: "Decide the review in the chat first.",
          })?.text,
        },
      });
    }
  }
  for (const row of workers?.questions ?? []) {
    const sent = workers?.answers[row.waitId];
    // Answered from here and on its way: no longer waiting on the reader.
    if (sent !== undefined && sent.status !== "failed") continue;
    items.push({
      key: `worker:${row.waitId}`,
      title: `Answer ${workerAsker(row)}: ${firstLine(row.question)}`,
      worker: { waitId: row.waitId, need: workerQuestionNeed(row, connectionName), answer: sentAnswer(sent) },
    });
  }
  for (const row of workers?.handoffs ?? [])
    items.push({ key: `worker:${row.waitId}`, title: `Act in the browser for ${workerAsker(row)}` });
  return items;
}

/** Bring `element` into view, opening the `<details>` that hides it; false when there is none. */
function reveal(element: Element | null): boolean {
  if (element === null) return false;
  const closed = element.closest("details");
  if (closed !== null) closed.open = true;
  element.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  return true;
}

/** Scroll the transcript to a turn's prompt; false when it is not on the page. */
export function revealTurn(root: ParentNode, turn: number): boolean {
  return reveal(root.querySelector(`.runs [data-turn="${turn}"]`));
}

/** Scroll the transcript to the first thing waiting on the reader. */
export function revealWaiting(root: ParentNode): boolean {
  return reveal(root.querySelector(".runs [data-waiting]"));
}

const loadTask = (client: SettingsClient, taskId: string): Promise<Outcome<TaskRecord>> =>
  readTaskRecord(client, undefined, taskId, { notFound: "The owner has no record of this chat." });

/**
 * A page of the approvals the owner recorded for a chat, newest first. An
 * owner that predates the history's `taskId` filter answers for the whole
 * workspace and without call ids: only this chat's rows that can be matched
 * to the stream's are kept, and no further page is offered — its pages would
 * walk the whole workspace.
 */
export async function loadDecisions(
  client: SettingsClient,
  workspaceId: string,
  taskId: string,
  cursor?: string,
): Promise<Outcome<Page<RecordedDecision>>> {
  const answer = await listHistory(client, workspaceId, { kinds: ["approval"], taskId, limit: APPROVAL_HISTORY_MAX_LIMIT }, cursor);
  if (!answer.ok) return answer;
  const ours = (item: ApprovalHistoryItem): item is RecordedDecision =>
    item.kind === "approval" && item.taskId === taskId && item.callId !== undefined;
  const items = answer.value.items.filter(ours);
  const filtered = items.length === answer.value.items.length;
  return { ok: true, value: { items, nextCursor: filtered ? answer.value.nextCursor : undefined } };
}

/**
 * The chat panel's Activity tab: what is waiting on the reader, the plan the
 * model keeps — here, not in the transcript — then the chat's
 * timeline by day. A turn scrolls the transcript to its prompt; a
 * delegated task opens in the chat.
 */
export function Activity({
  session,
  onTurn,
  onWaiting,
  onOpenTask,
  onCenter,
  onAnswer,
  workers,
  onAnswerWorker,
  connected = true,
  workspaceId,
}: {
  readonly session: Session | undefined;
  /** The chat's workspace: its recorded decisions are read from it; absent, only the stream's are shown. */
  readonly workspaceId?: string | undefined;
  /** Whether the owner is reachable: an answer sent without it would be dropped. */
  readonly connected?: boolean;
  /** Answer a run's question from the panel; absent, the panel only points to it. */
  readonly onAnswer?: ((runId: string, text: string) => void) | undefined;
  /** What the chat's workers ask, and how a worker's question is answered from the panel. */
  readonly workers?: WorkerNeeds | undefined;
  readonly onAnswerWorker?: ((waitId: string, text: string) => void) | undefined;
  readonly onTurn: (turn: number) => void;
  /** Bring what is waiting into view in the transcript. */
  readonly onWaiting: () => void;
  readonly onOpenTask: (taskId: string) => void;
  /** The Command Center's Activity; absent when the owner does not offer it. */
  readonly onCenter?: (() => void) | undefined;
}) {
  const timeZone = useTimeZone();
  const channels = useChannelNames();
  if (session === undefined) return <Empty>{NO_CHAT_SELECTED}</Empty>;
  const waiting = waitingOf(session, connected, workers, channels.connection);
  const plan = sessionPlan(session);
  return (
    <>
      {waiting.length === 0 ? null : (
        <section className="chat-panel-waiting" aria-label="waiting on you">
          <h4>Waiting on you ({waiting.length})</h4>
          <ul>
            {waiting.map((item) => (
              <li key={item.key}>
                {item.question !== undefined && onAnswer !== undefined ? (
                  // Answered here, from the same card the chat shows; on a phone the panel is where you are.
                  <QuestionCard
                    key={item.question.key}
                    density="compact"
                    timeZone={timeZone}
                    need={item.question.need}
                    answer={item.question.answer}
                    blocked={item.question.blocked === undefined ? undefined : { reason: item.question.blocked, jump: onWaiting }}
                    onAnswer={(text) => item.question !== undefined && onAnswer(item.question.runId, text)}
                  />
                ) : item.worker !== undefined && onAnswerWorker !== undefined ? (
                  <QuestionCard
                    key={item.key}
                    density="compact"
                    timeZone={timeZone}
                    need={item.worker.need}
                    answer={item.worker.answer}
                    blocked={connected ? undefined : { reason: RECONNECT_TO_ANSWER }}
                    onAnswer={(text) => item.worker !== undefined && onAnswerWorker(item.worker.waitId, text)}
                  />
                ) : (
                  <Button variant="ghost" size="sm" className="chat-panel-waiting-item" onClick={onWaiting}>
                    {item.title}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan === undefined ? null : <PlanCard plan={plan} />}
      {session.taskId === undefined ? (
        <Empty>{CHAT_NOT_STARTED}</Empty>
      ) : (
        <Timeline
          key={session.taskId}
          session={session}
          taskId={session.taskId}
          workspaceId={workspaceId}
          onTurn={onTurn}
          onOpenTask={onOpenTask}
        />
      )}
      <CenterLink what="Activity" onCenter={onCenter} />
    </>
  );
}

function Timeline({
  session,
  taskId,
  workspaceId,
  onTurn,
  onOpenTask,
}: {
  readonly session: Session;
  readonly taskId: string;
  readonly workspaceId: string | undefined;
  readonly onTurn: (turn: number) => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const { client } = useWorkspace();
  const timeZone = useTimeZone();
  const { data, error } = useLoaded(() => loadTask(client, taskId), [chatVersion(session)]);
  const [decisions, setDecisions] = useState<Paged<RecordedDecision>>();
  const [olderError, setOlderError] = useState<string>();
  /** The first-page read whose answer counts; an older page read before it is dropped. */
  const generation = useRef(0);
  const older = useOlderPage(generation);
  const turns = turnVersion(session);
  // Read again as each turn starts or ends; between, the stream adds what is
  // decided. Older pages the reader loaded stay below the fresh first one.
  useEffect(() => {
    if (workspaceId === undefined) return;
    const current = ++generation.current;
    void loadDecisions(client, workspaceId, taskId).then((page) => {
      // A history that could not be read leaves the stream's decisions, not an error.
      if (current === generation.current && page.ok) setDecisions((held) => refreshFirstPage(held, page.value, decisionKey, decisionDate));
    });
  }, [client, workspaceId, taskId, turns]);
  const loadOlder = (): void => {
    if (workspaceId === undefined) return;
    setOlderError(undefined);
    older.load(
      decisions?.nextCursor,
      (cursor) => loadDecisions(client, workspaceId, taskId, cursor),
      (page) => setDecisions((held) => appendPage(held, page, decisionKey)),
      setOlderError,
    );
  };
  if (data === undefined) return <Pending error={error} />;
  const items = activityOf(data, session, decisions?.items ?? []);
  if (items.length === 0) return <Empty>Nothing recorded yet.</Empty>;
  const today = todayIn(timeZone);
  return (
    <>
      {groupByDay(items, (item) => item.at, timeZone).map((group) => {
        const heading = dayHeading(group.date, today);
        return (
          <section key={group.date} className="chat-panel-day" aria-label={heading.title}>
            <h4>
              {heading.title} <span className="muted">{heading.detail}</span>
            </h4>
            <ol className="chat-panel-timeline list-reset">
              {foldDecisions(group.items).map((entry) => {
                if ("kind" in entry) {
                  const latest = entry.latest;
                  return (
                    <li key={entry.key}>
                      <details className="chat-panel-fold">
                        <summary className="chat-panel-item">
                          <span className="chat-panel-item-title chat-panel-fold-title disclosure">
                            <span className="truncate">
                              <span className={`decision-${entry.verdict}`}>{VERDICT_LABELS[entry.verdict]}: </span>
                              {entry.tool} ×{entry.items.length}
                            </span>
                          </span>
                          <span className="chat-panel-item-detail meta-sm">
                            Latest {localTime(latest.at, timeZone)} · earliest {localTime(entry.earliest.at, timeZone)}
                          </span>
                        </summary>
                        <ol className="chat-panel-timeline list-reset">
                          {entry.items.map((item) => (
                            <li key={item.key}>
                              <ItemRow item={item} onTurn={onTurn} onOpenTask={onOpenTask} />
                            </li>
                          ))}
                        </ol>
                      </details>
                    </li>
                  );
                }
                return (
                  <li key={entry.key}>
                    <ItemRow item={entry} onTurn={onTurn} onOpenTask={onOpenTask} />
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
      {decisions?.nextCursor === undefined ? null : (
        <LoadMore busy={older.busy} onLoad={loadOlder} label="Load older decisions">
          {olderError === undefined ? null : (
            <Failure as="span" className="meta-sm">
              {olderError}
            </Failure>
          )}
        </LoadMore>
      )}
    </>
  );
}

/** One line of the timeline: a turn scrolls the transcript to it, a delegated task opens. */
function ItemRow({
  item,
  onTurn,
  onOpenTask,
}: {
  readonly item: ActivityItem;
  readonly onTurn: (turn: number) => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const timeZone = useTimeZone();
  const { turn, taskId } = item;
  const open = turn !== undefined ? () => onTurn(turn) : taskId !== undefined ? () => onOpenTask(taskId) : undefined;
  const body = (
    <>
      <span className="chat-panel-item-title truncate">
        {item.verdict === undefined ? null : <span className={`decision-${item.verdict}`}>{VERDICT_LABELS[item.verdict]}: </span>}
        {item.title}
      </span>
      <span className="chat-panel-item-detail meta-sm">
        {item.detail} · {localTime(item.at, timeZone)}
      </span>
    </>
  );
  return <ChatPanelItem onOpen={open}>{body}</ChatPanelItem>;
}

const decisionKey = (decision: RecordedDecision): string => decision.approvalId;
const decisionDate = (decision: RecordedDecision): string => decision.decidedAt;
