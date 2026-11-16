import { useEffect, useRef } from "react";

import { useChannelNames } from "../shell/ChannelNames.js";
import { approvalChannelLabel, type PendingHandoffRow, type PendingQuestionRow } from "@tavi/contracts";

import { Icon } from "../../ui/Icon.js";
import { QuestionCard, answerLabels, questionNeed, sentAnswer, type QuestionNeed } from "../needs/NeedCard.js";
import { RECONNECT_TO_ANSWER } from "../chat/store/runs.js";
import type { WorkerNeeds } from "../chat/store/types.js";
import { openWorkerQuestions } from "../chat/store/workers.js";
import { HandoffCard } from "../takeover/HandoffCard.js";
import { Notice } from "../../ui/Parts.js";
import { loadRoundCalls } from "../center/approvals-api.js";
import { RoundCard, type RoundDecision } from "../center/InboxRoundCard.js";
import { workerRoundCards, type PendingRoundCard } from "../center/inbox-model.js";
import { useTimeZone, useWorkspace } from "../shell/Workspace.js";

/**
 * A root chat's workers' questions and browser handoffs, as cards in the
 * root's own transcript and its chat panel: a worker is no chat, so
 * what it asks is asked — and answered — where the person already is.
 */

/** Who asks: the worker's agent, else its task's title. */
export const workerAsker = (row: Pick<PendingQuestionRow, "workerLabel" | "taskTitle" | "taskId">): string =>
  row.workerLabel ?? row.taskTitle ?? `worker ${row.taskId}`;

/** A worker's question as the card shows it. */
export const workerQuestionNeed = (row: PendingQuestionRow, connectionName?: (connectionId: string) => string | undefined): QuestionNeed =>
  questionNeed(row, (delivery) => delivery.channel ?? approvalChannelLabel(delivery.connectionId, connectionName), workerAsker(row));

/** Decide a worker's round from the chat on screen. */
export type WorkerRoundDecide = (round: PendingRoundCard, decision: RoundDecision) => void;

/** Whether a root chat's workers wait on the reader: then the chat does too, whatever its own turn says. */
export const workersWait = (needs: WorkerNeeds | undefined): boolean =>
  needs !== undefined && needs.questions.length + needs.handoffs.length + (needs.approvals?.length ?? 0) > 0;

/** A worker's round in its chat: the card Center shows, its details included, and its "In" line opens the worker. */
function WorkerRound({
  round,
  outcome,
  onDecide,
}: {
  readonly round: PendingRoundCard;
  readonly outcome: NonNullable<WorkerNeeds["decided"]>[string] | undefined;
  readonly onDecide: (decision: RoundDecision) => void;
}) {
  const { client, workspaceId } = useWorkspace();
  return (
    <RoundCard
      card={round}
      outcome={outcome}
      now={Date.now()}
      person={undefined}
      linkTo={round.taskId}
      loadCalls={() => loadRoundCalls(client, workspaceId, round.taskId)}
      onDecide={onDecide}
    />
  );
}

/** The cards, newest last, and a receipt for each answer sent from here whose question has closed. */
export function WorkerNeedCards({
  needs,
  connected,
  onAnswer,
  onDecide,
  lastingChat = false,
  density = "full",
}: {
  readonly needs: WorkerNeeds | undefined;
  readonly connected: boolean;
  readonly onAnswer: (waitId: string, text: string) => void;
  readonly onDecide?: WorkerRoundDecide | undefined;
  /** The chat never ends, so a grant made here lasts a day, and its button says so. */
  readonly lastingChat?: boolean;
  readonly density?: "full" | "compact";
}) {
  const timeZone = useTimeZone();
  const channels = useChannelNames();
  const rounds = onDecide === undefined ? [] : workerRoundCards(needs?.approvals ?? [], lastingChat ? true : undefined);
  // A card goes once its round is decided, and focus with it: on to the box, not the page.
  const shown = useRef(rounds.length);
  useEffect(() => {
    const gone = rounds.length < shown.current;
    shown.current = rounds.length;
    if (gone && document.activeElement === document.body) document.querySelector<HTMLElement>(".composer-box textarea")?.focus();
  }, [rounds.length]);
  if (needs === undefined) return null;
  const open = new Set(needs.questions.map((row) => row.waitId));
  const receipts = Object.entries(needs.answers).filter(([waitId, answer]) => !open.has(waitId) && answer.status === "recorded");
  const several = openWorkerQuestions(needs).length > 1;
  if (needs.questions.length === 0 && needs.handoffs.length === 0 && receipts.length === 0 && rounds.length === 0) return null;
  return (
    <section className="worker-needs" aria-label="your workers ask">
      {receipts.map(([waitId, answer]) => (
        <p key={waitId} className={`need-receipt need-receipt-answered${density === "compact" ? " need-compact" : ""}`}>
          <Icon name="check" size="sm" /> You answered <strong>{answerLabels(answer.text, answer.question.choices)}</strong>
          <span className="need-receipt-meta"> · {workerAsker(answer.question)}'s question</span>
          <span className="visually-hidden"> — {answer.question.question}</span>
        </p>
      ))}
      {several ? (
        <Notice role="note">
          More than one question is open: answer each in its card. A message typed below is sent to the chat, not as an answer.
        </Notice>
      ) : null}
      {needs.questions.map((row) => {
        const sent = needs.answers[row.waitId];
        return (
          <div key={row.waitId} data-waiting="">
            <QuestionCard
              key={`${row.waitId}\0${JSON.stringify(row.choices?.options ?? [])}`}
              density={density}
              timeZone={timeZone}
              need={workerQuestionNeed(row, channels.connection)}
              answer={sentAnswer(sent)}
              blocked={connected ? undefined : { reason: RECONNECT_TO_ANSWER }}
              onAnswer={(text) => onAnswer(row.waitId, text)}
            />
          </div>
        );
      })}
      {rounds.map((round) => (
        <div key={round.key} data-waiting="" className="worker-round">
          <p className="need-asker">{round.taskTitle ?? `worker ${round.taskId}`} asks:</p>
          <ul className="center-cards list-reset">
            <WorkerRound round={round} outcome={needs.decided?.[round.key]} onDecide={(decision) => onDecide?.(round, decision)} />
          </ul>
        </div>
      ))}
      {needs.handoffs.map((row: PendingHandoffRow) => (
        <div key={row.waitId} data-waiting="" className="worker-handoff">
          <p className="need-asker">{workerAsker(row)} asks:</p>
          <HandoffCard taskId={row.taskId} handoff={row.handoff} deadlineAt={row.deadlineAt} />
        </div>
      ))}
    </section>
  );
}
