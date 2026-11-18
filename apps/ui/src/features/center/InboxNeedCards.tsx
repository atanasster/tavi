import type { PendingQuestionRow, PendingReviewRow } from "@tavi/contracts";

import { ANSWERED_ELSEWHERE, QuestionCard, deliveryName, questionNeed, type AnswerState } from "../needs/NeedCard.js";
import { AppLink } from "../shell/AppLink.js";
import { taskPath } from "../shell/route.js";
import { Button } from "../../ui/Button.js";

/**
 * A question waiting on the reader, answered right here: the same card
 * the task's chat shows, compact, and a link to the task for the whole story.
 */
export function QuestionNeedCard({
  hidden,
  row,
  state,
  person,
  timeZone,
  onAnswer,
  onOpen,
}: {
  readonly hidden: boolean;
  readonly row: PendingQuestionRow;
  readonly state: AnswerState | "elsewhere" | undefined;
  readonly person: string | undefined;
  readonly timeZone: string | undefined;
  readonly onAnswer: (text: string) => void;
  readonly onOpen: () => void;
}) {
  const title = row.taskTitle ?? row.taskId;
  // The task is named under the card; the schedule and the person are not.
  const askedBy = [row.originLabel, person].filter((part) => part !== undefined).join(" · ");
  return (
    <li className="center-card center-card-question" aria-label={`Question: ${row.question}`} hidden={hidden} tabIndex={-1}>
      {state === "elsewhere" ? (
        <p className="need-receipt">{ANSWERED_ELSEWHERE}</p>
      ) : (
        <QuestionCard
          density="compact"
          announce
          timeZone={timeZone}
          need={questionNeed(row, deliveryName, askedBy === "" ? undefined : askedBy)}
          answer={state}
          onAnswer={onAnswer}
        />
      )}
      <p className="center-card-ctx meta">
        In{" "}
        <AppLink href={taskPath(row.taskId)} onFollow={onOpen}>
          {title}
        </AppLink>
      </p>
    </li>
  );
}
/** Results waiting for review: deciding needs the archived results, so the card opens the task. */
export function ReviewNeedCard({
  hidden,
  row,
  person,
  onOpen,
}: {
  readonly hidden: boolean;
  readonly row: PendingReviewRow;
  readonly person: string | undefined;
  readonly onOpen: () => void;
}) {
  const title = row.taskTitle ?? row.taskId;
  return (
    <li className="center-card" aria-label={`Review: ${title}`} hidden={hidden} tabIndex={-1}>
      <div className="center-card-top">
        <span className="center-risk-tag eyebrow">Review</span>
      </div>
      <h3>{row.artifactCount === 1 ? "A result waits for your review" : `${row.artifactCount} results wait for your review`}</h3>
      <p className="center-card-ctx meta">
        In{" "}
        <AppLink href={taskPath(row.taskId)} onFollow={onOpen}>
          {title}
        </AppLink>
        {person === undefined ? null : <> · {person}</>}
      </p>
      <div className="center-card-actions">
        <Button variant="primary" size="sm" onClick={onOpen}>
          Open
        </Button>
        <span className="center-card-note meta">Keep or reject the results where they were made.</span>
      </div>
    </li>
  );
}
