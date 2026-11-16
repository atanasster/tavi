import { useState } from "react";

import { approvalChannelLabel, type NeedRow, type RoutineCheckpoint } from "@tavi/contracts";

import { useLoaded } from "../../hooks/use-loaded.js";
import { when } from "../../lib/time.js";
import { Failure, LoadError, Notice, Section } from "../../ui/Parts.js";
import { answerNeed, listNeeds } from "../center/approvals-api.js";
import { QuestionCard, answerOutcome, deliveryName, questionNeed, type AnswerState } from "../needs/NeedCard.js";
import { useChannelNames } from "../shell/ChannelNames.js";
import { requestList, routineRequest } from "./api.js";
import { Button } from "../../ui/Button.js";
import { useWorkspace } from "../shell/Workspace.js";

/**
 * What the run waits on the reader for: a question
 * answered right here, with the card the chat shows; anything else — a round,
 * a review — named, with the way to the task that decides it.
 */
export function RunWaiting({
  taskId,
  revision = 0,
  timeZone,
  onOpen,
}: {
  readonly taskId: string;
  /** Moves while the run is live: what it waits on is read again, answers given here kept. */
  readonly revision?: number;
  readonly timeZone: string | undefined;
  readonly onOpen: () => void;
}) {
  const { client, workspaceId } = useWorkspace();
  const needs = useLoaded(() => listNeeds(client, workspaceId, taskId), [revision], { serial: true });
  const [answers, setAnswers] = useState<Readonly<Record<string, AnswerState>>>({});
  const listed: readonly NeedRow[] = needs.data?.needs ?? [];
  if (listed.length === 0) return null;
  const others = listed.filter((need) => need.kind !== "question").length;
  const answer = (waitId: string, text: string): void => {
    setAnswers((held) => ({ ...held, [waitId]: { status: "sending", text } }));
    void answerNeed(client, { workspaceId, taskId, waitId, answer: text }).then((outcome) => {
      // The answer shows as its receipt until the next read, when the settled question moves to Questions.
      setAnswers((held) => ({ ...held, [waitId]: answerOutcome(text, outcome) }));
    });
  };
  return (
    <section className="routine-waiting" aria-label="waiting on you">
      <h3>Waiting on you</h3>
      {listed.map((need) =>
        need.kind === "question" ? (
          <QuestionCard
            key={need.needId}
            need={questionNeed(need.question, deliveryName)}
            timeZone={timeZone}
            answer={answers[need.question.waitId]}
            onAnswer={(text) => answer(need.question.waitId, text)}
          />
        ) : null,
      )}
      {others === 0 ? null : (
        <Notice>
          {others === 1 ? "A decision" : `${others} decisions`}{" "}
          {others === listed.length ? (others === 1 ? "waits" : "wait") : others === 1 ? "also waits" : "also wait"} in the run's task.{" "}
          <Button variant="ghost" size="sm" onClick={onOpen}>
            Open it
          </Button>
        </Notice>
      )}
    </section>
  );
}
/** How a run's question was settled, in one line. */
function checkpointReceipt(
  checkpoint: RoutineCheckpoint,
  timeZone: string | undefined,
  connectionName?: (connectionId: string) => string | undefined,
): string {
  const answer = checkpoint.answers?.join(", ") ?? checkpoint.replyText ?? "";
  const at = checkpoint.at === undefined ? "" : ` · ${when(checkpoint.at, timeZone)}`;
  switch (checkpoint.state) {
    case "open":
      return `waiting for an answer until ${when(checkpoint.deadlineAt, timeZone)}`;
    case "answered":
      return checkpoint.via === "standing-answer"
        ? `${answer}, by your standing answer${at}`
        : `${answer}, answered${checkpoint.via === undefined ? "" : ` via ${approvalChannelLabel(checkpoint.via, connectionName)}`}${at}`;
    case "defaulted":
      return answer === "" ? `nobody answered; the run went on without one${at}` : `nobody answered; the default ${answer} was taken${at}`;
    case "undelivered":
      return `could not be sent; the run went on without asking${at}`;
    case "withdrawn":
      return `withdrawn when the run ended${at}`;
  }
}
/**
 * The questions a run asked and how each was settled. An
 * answer given in the chat or here can be kept as a standing answer, so the
 * routine is not asked the same again; it is forgotten from Edit routine.
 */
export function RunQuestions({
  routineId,
  runId,
  revision = 0,
  timeZone,
}: {
  readonly routineId: string;
  /** Moves while the run is live: its questions are read again. */
  readonly revision?: number;
  readonly runId: string;
  readonly timeZone: string | undefined;
}) {
  const { client, workspaceId } = useWorkspace();
  const channels = useChannelNames();
  const loaded = useLoaded(
    () =>
      requestList<{ readonly checkpoints: readonly RoutineCheckpoint[] }>(
        client,
        workspaceId,
        { action: "checkpoints", routineId, runId },
        "checkpoints",
        "run's questions",
      ),
    [revision],
    { serial: true },
  );
  const [kept, setKept] = useState<Readonly<Record<string, "saving" | "saved" | string>>>({});
  const checkpoints = loaded.data?.checkpoints ?? [];
  if (loaded.error) return <LoadError error={loaded.error} reload={loaded.reload} />;
  if (checkpoints.length === 0) return null;
  const keep = (checkpoint: RoutineCheckpoint, answers: readonly string[]) => {
    setKept((held) => ({ ...held, [checkpoint.waitId]: "saving" }));
    void routineRequest(client, workspaceId, { action: "always_answer", routineId, waitId: checkpoint.waitId, answers: [...answers] }).then(
      (outcome) => setKept((held) => ({ ...held, [checkpoint.waitId]: outcome.ok ? "saved" : outcome.message })),
    );
  };
  return (
    <Section title="Questions">
      <ul className="routine-checkpoints">
        {checkpoints.map((checkpoint) => {
          const answers = checkpoint.answers ?? [];
          // Only an answer in the question's own options, given by a person, can stand for the next time.
          const offer =
            checkpoint.state === "answered" &&
            checkpoint.via !== "standing-answer" &&
            answers.length > 0 &&
            answers.every((answer) => checkpoint.options.includes(answer));
          const state = kept[checkpoint.waitId];
          return (
            <li key={checkpoint.waitId}>
              <p>
                <strong>{checkpoint.header ?? checkpoint.question ?? "A question"}</strong>
                {checkpoint.header !== undefined && checkpoint.question !== undefined ? (
                  <span className="muted"> — {checkpoint.question}</span>
                ) : null}
              </p>
              <p className="muted">{checkpointReceipt(checkpoint, timeZone, channels.connection)}</p>
              {!offer ? null : state === "saved" ? (
                <p className="muted" role="status">
                  Kept: questions like this are answered {answers.join(", ")} from now on. Forget it in Edit routine.
                </p>
              ) : (
                <>
                  <Button variant="ghost" size="sm" disabled={state === "saving"} onClick={() => keep(checkpoint, answers)}>
                    Always answer {answers.join(", ")} for this routine
                  </Button>
                  <Failure message={state !== undefined && state !== "saving" ? state : undefined} />
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
