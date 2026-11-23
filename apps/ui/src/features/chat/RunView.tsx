import { memo, type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { turnEnded, type TranscriptEntry } from "@tavi/client/browser";
import { TURN_STOPPED_MESSAGE, turnStoppedMessage, type PlanItem } from "@tavi/contracts";

import { useResetOnChange } from "../../hooks/use-reset-on-change.js";
import { useScrollIntoView } from "../../hooks/scroll.js";
import { useAnnounce } from "../../hooks/use-announce.js";
import { translateCore, useT } from "../../lib/i18n.js";
import { Icon } from "../../ui/Icon.js";
import { Markdown } from "../../ui/Markdown.js";
import { Modal } from "../../ui/Modal.js";
import { TaviMark } from "../../ui/TaviMark.js";
import { ConnectCard } from "../apps/ConnectCard.js";
import { QuestionCard } from "../needs/NeedCard.js";
import { HandoffCard } from "../takeover/HandoffCard.js";
import { Transcript } from "../transcript/Transcript.js";
import { BrowserControlRow } from "../transcript/Receipts.js";
import { Approvals } from "./Approvals.js";
import { FILES_ONLY_PROMPT, inlinedFilesOf } from "./attachments.js";
import { MessageActions, type RewindOffer } from "./MessageActions.js";
import { latestPlan, planStep } from "./plan.js";
import { replyFacts } from "./reply-facts.js";
import { Reviews } from "./Reviews.js";
import {
  cancelledWords,
  isCancelled,
  questionBlocker,
  questionKey,
  transcriptWindow,
  TRANSCRIPT_HEAD,
  TRANSCRIPT_TAIL,
} from "./store/runs.js";
import type { CanvasRun, CanvasState, CanvasStore } from "./store/types.js";
import { spoken } from "./store/said.js";
import { Failure, Notice } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { Command } from "../../ui/Command.js";
import { withParts } from "../../ui/with-parts.js";

/**
 * Whether a run is a turn of a chat that never ends — the person's Home, or a
 * messaging conversation's chat — where a `session` grant lasts a day or until
 * the chat rolls over, so its button says "until tomorrow".
 */
export function lastingChatOf(run: CanvasRun, state: Pick<CanvasState, "home" | "directory">): boolean {
  const taskId = run.run.taskId ?? run.continues;
  if (run.toHome === true || (taskId !== undefined && taskId === state.home)) return true;
  return taskId !== undefined && state.directory?.rows.find((row) => row.taskId === taskId)?.origin === "messaging";
}
/**
 * A person's message, its files as badges under it: a text file inlined in
 * the prompt opens its lines in a dialog (never in the bubble, however long),
 * an uploaded one is named. A long message
 * scrolls in its box, which a keyboard can do only from inside it: only then
 * is it a tab stop.
 */
export function Prompt({
  id,
  text,
  fileNames = [],
}: {
  readonly id: string;
  readonly text: string;
  readonly fileNames?: readonly string[];
}) {
  const t = useT();
  const inlined = useMemo(() => inlinedFilesOf(text), [text]);
  const hasFiles = inlined.files.length > 0 || fileNames.length > 0;
  // A message of files alone says so to the owner; here its badges say it.
  const said = hasFiles && inlined.text.trim() === FILES_ONLY_PROMPT ? "" : inlined.text;
  const box = useRef<HTMLParagraphElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const [viewing, setViewing] = useState<number | undefined>(undefined);
  const viewed = viewing === undefined ? undefined : inlined.files[viewing];
  useLayoutEffect(() => {
    const { scrollHeight = 0, clientHeight = 0 } = box.current ?? {};
    setScrolls(scrollHeight > clientHeight);
  }, [said]);
  return (
    <>
      {said === "" ? null : (
        <p className="prompt" id={id} ref={box} {...(scrolls ? { tabIndex: 0 } : {})}>
          <span className="visually-hidden">{t("chat.run.you")}</span>
          {said}
        </p>
      )}
      {hasFiles ? (
        <ul className="prompt-files list-reset" aria-label={t("chat.composer.attached")} {...(said === "" ? { id } : {})}>
          {fileNames.map((name, index) => (
            <li key={`upload-${index}`} className="prompt-file">
              <span className="prompt-file-name" title={name}>
                <Icon name="paperclip" size="sm" />
                <span className="truncate">{name}</span>
              </span>
            </li>
          ))}
          {inlined.files.map((file, index) => (
            <li key={`inline-${index}`} className="prompt-file">
              <Button
                variant="bare"
                className="prompt-file-name"
                title={t("chat.run.showFile", { name: file.name })}
                onClick={() => setViewing(index)}
              >
                <Icon name="paperclip" size="sm" />
                <span className="truncate">{file.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {viewed === undefined ? null : (
        <Modal title={viewed.name} wide onClose={() => setViewing(undefined)}>
          <pre className="prompt-file-text">{viewed.text}</pre>
        </Modal>
      )}
    </>
  );
}

/**
 * One turn's card. Memoized: a batched repaint hands `Canvas` a new array
 * every flush, and a turn the event did not touch must not cost a walk over
 * its whole window. The handlers come from the store and never change.
 */
export const RunView = memo(function RunView({
  run,
  timeZone,
  lastingChat = false,
  firstTurn,
  earlierBegins = false,
  connected,
  onLoadArtifacts,
  onReview,
  onAnswer,
  onDecide,
  onExpand,
  onCancelQueued,
  onRewind,
  rewindLater = 0,
  onRepeat,
  onSteerQueued,
  awaitsDecision: waitsOnDecision = false,
  earlierPlan,
  memoryChip,
}: {
  readonly run: CanvasRun;
  readonly timeZone: string | undefined;
  /** A turn of a Home or a messaging conversation's chat, where "Allow for this chat" lasts a day. */
  readonly lastingChat?: boolean;
  /** Its first prompt's turn number, written as `data-turn` for the chat panel to find. */
  readonly firstTurn: number;
  /** The first of the turns read back: "Earlier in this chat" marks that one boundary, not each turn. */
  readonly earlierBegins?: boolean;
  readonly connected: boolean;
  readonly onLoadArtifacts: CanvasStore["loadArtifacts"];
  readonly onReview: CanvasStore["reviewArtifacts"];
  readonly onAnswer: CanvasStore["answerQuestion"];
  readonly onDecide: CanvasStore["decide"];
  readonly onExpand: (id: string, expanded: boolean) => void;
  readonly onCancelQueued?: (id: string) => void;
  /** Offered on a settled turn's message while its chat is still: answers why it was not rewound. */
  readonly onRewind?: (id: string) => Promise<string | undefined>;
  /** How many later turns of the chat a rewind here takes back with it. */
  readonly rewindLater?: number;
  /** *Repeat this…* on its message: the schedule form filled from `prompt`; `report` says what was created. */
  readonly onRepeat?: ((prompt: string, report: (note: string) => void) => void) | undefined;
  /** Offered while the turn it waits behind runs (not on a decision): sends it into that turn. */
  readonly onSteerQueued?: (id: string) => void;
  /** A queued prompt whose turn waits on the reader's approval or review: it sends once that is decided. */
  readonly awaitsDecision?: boolean;
  /** While it runs: the transcript of an earlier turn whose plan this one carries on, when it has kept none of its own. */
  readonly earlierPlan?: readonly TranscriptEntry[] | undefined;
  /** What the answer used from memory: a chip on the footer's line that opens to the records below it. */
  readonly memoryChip?: ReactNode;
}) {
  const t = useT();
  /** Where focus lands once the divider that held it is gone. */
  const shownHere = useRef<HTMLParagraphElement>(null);
  /** The pending round's card, brought into view whenever the ask changes. */
  const ask = useRef<HTMLDivElement>(null);
  /** A pick still in its undo window when the question was settled elsewhere: never sent. */
  const [dropped, setDropped] = useState<{ readonly waitId: string; readonly label: string }>();
  const { status, transcript, pending, waiting, review, outcome, truncated } = run.run;
  const droppedFor = dropped === undefined ? undefined : run.run.settledWaits.find((settled) => settled.waitId === dropped.waitId);
  // A newer question makes the note about an older one read as about it: it goes.
  useResetOnChange([waiting?.waitId], () => {
    if (waiting?.waitId !== undefined && waiting.waitId !== dropped?.waitId) setDropped(undefined);
  });
  const response =
    transcript
      .filter((entry) => entry.kind === "text" && !entry.discarded)
      .map((entry) => (entry.kind === "text" ? entry.text : ""))
      .join("\n\n") || (outcome?.kind === "completed" ? outcome.finalText : "");
  const round = pending[0];
  // A long transcript is bounded: its first entries, its last, and a divider for the rest.
  const shown = transcriptWindow(run);
  // Offered only once every call the owner listed for the round has arrived.
  useScrollIntoView(ask, round === undefined ? undefined : `${run.id}:${round.steps}`);
  const rewindOffer = useMemo(
    (): RewindOffer | undefined => (onRewind === undefined ? undefined : { later: rewindLater, onRewind: () => onRewind(run.id) }),
    [onRewind, rewindLater, run.id],
  );
  const repeat = useMemo(
    () => (onRepeat === undefined ? undefined : (report: (note: string) => void) => onRepeat(run.prompt, report)),
    [onRepeat, run.prompt],
  );
  const droppedShown =
    dropped !== undefined &&
    droppedFor !== undefined &&
    droppedFor.answers?.join(", ") !== dropped.label &&
    droppedFor.replyText !== dropped.label;
  const droppedKey =
    droppedFor?.outcome === "answered" || droppedFor?.outcome === "replied" ? "chat.run.dropped.answered" : "chat.run.dropped.closed";
  useAnnounce(droppedShown ? t(droppedKey, { label: dropped.label }) : undefined);
  // Queued is said by the page's announcer; sending into the running turn is said here.
  useAnnounce(
    run.queued === true && run.steering !== undefined
      ? run.steering === "sending"
        ? t("chat.run.steering.sending")
        : t("chat.run.steering.sent")
      : undefined,
  );
  const promptId = useId();
  if (run.noTurn === true) return null;
  return (
    <article className={`run run-${status}`} aria-labelledby={run.prompt === "" ? undefined : promptId}>
      {/* A later turn of the chat on screen gets no line of its own (the reader is in that chat); where replayed turns
          begin is said without naming a task id. No prompt shown says only that: a worker's report wakes a turn nobody
          asked for, and a replay can't tell that from one whose prompt it lost. */}
      {earlierBegins ? (
        <p className="continues meta-sm">{t(run.prompt === "" ? "chat.run.earlierNoPrompt" : "chat.run.earlier")}</p>
      ) : run.restored === true && run.prompt === "" ? (
        <p className="continues meta-sm">{t("chat.run.noPrompt")}</p>
      ) : null}
      {run.recordedPrompts?.length ? (
        <details>
          <summary className="disclosure">{t("chat.run.recordedPrompts")}</summary>
          {run.recordedPrompts.map((prompt, index) => (
            <p key={index} data-turn={firstTurn + index}>
              {prompt}
            </p>
          ))}
        </details>
      ) : null}
      {run.prompt === "" ? null : (
        <div className="user-message" data-run={run.id} data-turn={firstTurn + (run.recordedPrompts?.length ?? 0)}>
          <Prompt id={promptId} text={run.prompt} {...(run.fileNames === undefined ? {} : { fileNames: run.fileNames })} />
          <MessageActions text={run.prompt} kind="prompt" rewind={rewindOffer} onRepeat={repeat} />
        </div>
      )}
      {/* A replayed turn that kept only its prompt (its answer drawn as the next, promptless turn) names no one under it. */}
      {transcript.length > 0 ||
      status !== "completed" ||
      outcome !== undefined ||
      truncated ||
      round !== undefined ||
      waiting !== undefined ||
      review !== undefined ||
      run.queued === true ||
      run.error !== undefined ||
      run.notice !== undefined ||
      run.remark !== undefined ? (
        <div className="message-heading assistant-heading">
          <TaviMark />
          Tavi
        </div>
      ) : null}
      {truncated ? <Notice>{t("chat.run.joinedLate")}</Notice> : null}
      <Transcript
        entries={shown.head}
        receipts={run.run.settledWaits}
        timeZone={timeZone}
        tainted={run.run.tainted}
        knownUrls={run.run.knownUrls}
      />
      {shown.hidden > 0 ? (
        <p className="older">
          <Button
            onClick={() => {
              onExpand(run.id, true);
              // The button is gone; focus and the announcement go where it was.
              requestAnimationFrame(() => shownHere.current?.focus());
            }}
          >
            {t("chat.run.expand", { count: shown.hidden })}
          </Button>
        </p>
      ) : run.expanded === true && transcript.length > TRANSCRIPT_HEAD + TRANSCRIPT_TAIL ? (
        // Focus moves here when the divider it replaces is activated, which
        // reads it: no live region of its own is needed.
        <p className="older" tabIndex={-1} ref={shownHere}>
          {t("chat.run.allShown")} <Button onClick={() => onExpand(run.id, false)}>{t("chat.run.collapse")}</Button>
        </p>
      ) : null}
      <Transcript
        entries={shown.tail}
        receipts={run.run.settledWaits}
        timeZone={timeZone}
        tainted={run.run.tainted}
        knownUrls={run.run.knownUrls}
      />
      {/* A person's holds of the browser the task did not wait for: between turns, so after this one. */}
      {run.run.browserControls.map((receipt) => (
        <BrowserControlRow key={`${receipt.sessionId}@${receipt.at}`} receipt={receipt} />
      ))}
      {/* Said only when the answer recorded is not what was picked here. */}
      {droppedShown ? <Notice>{withParts(t(droppedKey), { label: <strong>{dropped.label}</strong> })}</Notice> : null}
      {status === "running" && round === undefined && waiting === undefined && review === undefined ? (
        <Working plan={latestPlan(transcript) ?? (earlierPlan === undefined ? undefined : latestPlan(earlierPlan))} />
      ) : null}
      <div ref={ask} data-waiting={round === undefined ? undefined : ""}>
        <Approvals run={run} onDecide={onDecide} lastingChat={lastingChat} />
      </div>
      {waiting === undefined ? null : waiting.handoff !== undefined && run.run.taskId !== undefined ? (
        <div data-waiting="">
          <HandoffCard taskId={run.run.taskId} handoff={waiting.handoff} deadlineAt={waiting.deadlineAt} />
        </div>
      ) : waiting.connect !== undefined && waiting.waitId !== undefined ? (
        <div data-waiting="">
          <ConnectCard ask={{ kind: "wait", waitId: waiting.waitId, request: waiting.connect, deadlineAt: waiting.deadlineAt }} />
        </div>
      ) : waiting.question === undefined ? (
        <Notice>{t("chat.run.waitingOn", { on: waiting.on })}</Notice>
      ) : (
        <div data-waiting="">
          <QuestionCard
            // A new question — or the same one with other options — starts afresh, its boxes unticked.
            key={`${questionKey(waiting, run.questionId)}\0${JSON.stringify(waiting.choices?.options ?? [])}`}
            need={{ question: waiting.question, choices: waiting.choices, context: waiting.context, deadlineAt: waiting.deadlineAt }}
            timeZone={timeZone}
            answer={run.answer?.key === questionKey(waiting, run.questionId) ? run.answer : undefined}
            blocked={(() => {
              const reason = questionBlocker(run, connected, {
                round: t("chat.run.blocked.round"),
                review: t("chat.run.blocked.review"),
              });
              return reason === undefined
                ? undefined
                : {
                    reason: reason.text,
                    ...(reason.kind === "round" ? { jump: () => ask.current?.scrollIntoView({ block: "center" }) } : {}),
                  };
            })()}
            onAnswer={(text) => onAnswer(run.id, text)}
            onDropped={(label) => {
              if (waiting.waitId !== undefined) setDropped({ waitId: waiting.waitId, label });
            }}
          />
        </div>
      )}
      {review !== undefined ? (
        <div data-waiting="">
          <Reviews run={run} connected={connected} onLoad={onLoadArtifacts} onReview={onReview} />
        </div>
      ) : null}
      {outcome?.kind === "failed" && isCancelled(run.run) ? (
        <Notice>{cancelledWords(outcome.message)}</Notice>
      ) : outcome?.kind === "failed" ? (
        <Failure alert={false}>{t("chat.run.failed", { code: outcome.errorCode, message: outcome.message })}</Failure>
      ) : outcome?.kind === "stopped" ? (
        // The owner records the English sentence; said in the reader's language here.
        <Notice>{outcome.message === TURN_STOPPED_MESSAGE ? turnStoppedMessage(translateCore) : outcome.message}</Notice>
      ) : null}
      {run.queued === true ? (
        run.steering !== undefined ? (
          <Notice className="queued">{run.steering === "sending" ? t("chat.run.steering.sending") : t("chat.run.steering.sent")}</Notice>
        ) : (
          <Notice className="queued">
            {waitsOnDecision ? t("chat.run.queued.decision") : t("chat.run.queued.turn")}
            {onSteerQueued === undefined ? null : (
              <>
                {" "}
                <Button variant="ghost" size="sm" title={t("chat.run.sendNowTip")} onClick={() => onSteerQueued(run.id)}>
                  {t("chat.run.sendNow")}
                </Button>
              </>
            )}
            {onCancelQueued === undefined ? null : (
              <>
                {" "}
                <Button variant="ghost" size="sm" onClick={() => onCancelQueued(run.id)}>
                  {t("chat.run.cancel")}
                </Button>
              </>
            )}
          </Notice>
        )
      ) : null}
      {run.remark !== undefined ? <Notice>{run.remark.map((line) => spoken(line, t)).join(" ")}</Notice> : null}
      {run.notice !== undefined ? <Notice>{spoken(run.notice, t)}</Notice> : null}
      {status === "unknown" && run.notice === undefined && run.error === undefined ? (
        <Notice>{withParts(t("chat.run.unknown"), { command: <Command>tavi tasks</Command> })}</Notice>
      ) : null}
      {outcome?.kind === "completed" && transcript.length === 0 ? (
        outcome.finalText ? (
          <div className="text">
            <Markdown text={outcome.finalText} tainted={run.run.tainted} knownUrls={run.run.knownUrls} />
          </div>
        ) : (
          <p className="text">{t("chat.run.noOutput")}</p>
        )
      ) : null}
      {run.error !== undefined ? <Failure alert={false}>{spoken(run.error, t)}</Failure> : null}
      {/* Stop lives on the composer; the card only says when one is already on its way. */}
      {run.aborting ? <Notice>{t("chat.run.stopping")}</Notice> : null}
      {response || memoryChip ? <ReplyFooter run={run} response={response} memoryChip={memoryChip} /> : null}
    </article>
  );
});
/**
 * A running turn's sign of life, under its latest output: three dots that
 * bounce (still for reduced motion), and with a plan, which of its steps is
 * under way (the plan itself is in the Activity tab). Not a live region: the
 * page's own announcer already says "Responding.".
 */
function Working({ plan }: { readonly plan: readonly PlanItem[] | undefined }) {
  const t = useT();
  const at = plan === undefined ? undefined : planStep(plan);
  return (
    <p className="run-working meta-sm">
      <span className="working-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {t("chat.run.working")}
      {at === undefined ? null : <span className="truncate"> {t("chat.run.step", { step: at.step, of: at.of, content: at.content })}</span>}
    </p>
  );
}

/**
 * Under a reply: its actions and what it used from memory on the left, and on
 * the right, quietly, how long it worked, the model that answered and its tool
 * calls when it made any. The chat-wide figures are the Details tab's.
 */
function ReplyFooter({
  run,
  response,
  memoryChip,
}: {
  readonly run: CanvasRun;
  readonly response: string;
  readonly memoryChip: ReactNode;
}) {
  const t = useT();
  const facts = replyFacts(run);
  const said = [facts.time, facts.model, facts.tools === undefined ? undefined : t("chat.run.toolCalls", { count: facts.tools })].filter(
    (fact): fact is string => fact !== undefined,
  );
  return (
    <footer className="response-footer">
      {response ? <MessageActions text={response} kind="response" readAloud={turnEnded(run.run.status)} /> : null}
      {memoryChip}
      {said.length === 0 ? null : (
        <p className="reply-facts meta-sm" title={facts.modelIds}>
          {said.join(" · ")}
          {/* The title is for a pointer; a screen reader hears the full model id too. */}
          {facts.modelIds === undefined || facts.modelIds === facts.model ? null : (
            <span className="visually-hidden"> ({facts.modelIds})</span>
          )}
        </p>
      )}
    </footer>
  );
}
