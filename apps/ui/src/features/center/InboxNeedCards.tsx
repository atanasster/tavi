import type { PendingQuestionRow, PendingReviewRow } from "@tavi/contracts";

import { ANSWERED_ELSEWHERE_KEY, QuestionCard, deliveryName, questionNeed, type AnswerState } from "../needs/NeedCard.js";
import { AppLink } from "../shell/AppLink.js";
import { taskPath } from "../shell/route.js";
import { Button } from "../../ui/Button.js";
import { useT } from "../../lib/i18n.js";
import { withParts } from "../welcome/WelcomeStepParts.js";

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
  const t = useT();
  const title = row.taskTitle ?? row.taskId;
  // The task is named under the card; the schedule and the person are not.
  const askedBy = [row.originLabel, person].filter((part) => part !== undefined).join(" · ");
  return (
    <li
      className="center-card center-card-question"
      aria-label={t("center.needCards.questionLabel", { question: row.question })}
      hidden={hidden}
      tabIndex={-1}
    >
      {state === "elsewhere" ? (
        <p className="need-receipt">{t(ANSWERED_ELSEWHERE_KEY)}</p>
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
        {withParts(t("center.roundCard.in"), {
          chat: (
            <AppLink href={taskPath(row.taskId)} onFollow={onOpen}>
              {title}
            </AppLink>
          ),
        })}
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
  const t = useT();
  const title = row.taskTitle ?? row.taskId;
  return (
    <li className="center-card" aria-label={t("center.needCards.reviewLabel", { title })} hidden={hidden} tabIndex={-1}>
      <div className="center-card-top">
        <span className="center-risk-tag eyebrow">{t("center.needCards.review")}</span>
      </div>
      <h3>{t("center.needCards.resultsWait", { count: row.artifactCount })}</h3>
      <p className="center-card-ctx meta">
        {withParts(t("center.roundCard.in"), {
          chat: (
            <AppLink href={taskPath(row.taskId)} onFollow={onOpen}>
              {title}
            </AppLink>
          ),
        })}
        {person === undefined ? null : <> · {person}</>}
      </p>
      <div className="center-card-actions">
        <Button variant="primary" size="sm" onClick={onOpen}>
          {t("center.needCards.open")}
        </Button>
        <span className="center-card-note meta">{t("center.needCards.keepOrReject")}</span>
      </div>
    </li>
  );
}
