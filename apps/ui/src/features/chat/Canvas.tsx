import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { turnEnded, type TranscriptEntry } from "@tavi/client/browser";
import type { ChatNotice } from "@tavi/contracts";
import { clip } from "@tavi/contracts/util";

import { useAutoscroll } from "../../hooks/scroll.js";
import { greeting } from "../../lib/time.js";
import { Empty } from "../../ui/Empty.js";
import { StatusNote } from "../../ui/Parts.js";
import { firstTurnOf } from "../chat-panel/turns.js";
import { headerStatusLabel, retryPromptOf, TASK_STATUS_LABELS, type Session } from "../shell/shell.js";
import { PrivateChatMark } from "./MemoryMode.js";
import { useTimeZone } from "../shell/Workspace.js";
import { WorkerNeedCards, workersWait, type WorkerRoundDecide } from "../workers/WorkerNeeds.js";
import type { UploadAttachment } from "./attachments.js";
import { Composer } from "./Composer.js";
import { EpochDivider, NoticeCards, epochDividersByRun, noticesByRun } from "./Notices.js";
import { latestPlan } from "./plan.js";
import { lastingChatOf, RunView } from "./RunView.js";
import { abortableRun, chatPluginStatus } from "./store/runs.js";
import type { CanvasRun, CanvasState, CanvasStore, WorkerNeeds } from "./store/types.js";
import { Button } from "../../ui/Button.js";

export interface CanvasProps {
  readonly modelTarget?: string | undefined;
  /** Why the owner's target is not the one chosen — a restart pending, or no model at all. */
  readonly modelNotice?: string | undefined;
  /** The owner runs no configured model, so it refuses every run: the composer holds sends. */
  readonly unconfigured?: boolean;
  readonly onModels?: (() => void) | undefined;
  /** The composer's picker over the discovered models; without one, the target links to Settings. */
  readonly modelPicker?: ReactNode;
  /** The chat's working folder chip, in the chat's header; absent on an owner without `folder`. */
  readonly folderChip?: ReactNode;
  /** The chat's memory toggle, or its private-chat label, in the chat's header; absent on an owner without `chat-context`. */
  readonly memoryToggle?: ReactNode;
  /** The chat's taint chip: what it read that Tavi does not trust, and the remedy. */
  readonly taintChip?: ReactNode;
  readonly content?: ReactNode;
  readonly state: CanvasState;
  /** The session the main pane shows: every turn of one task this page holds. */
  readonly session: Session | undefined;
  /**
   * The session the next prompt acts on — the page's last, which the
   * sidebar lets diverge from the one being browsed. What the composer says
   * follows this one, not `session`.
   */
  readonly acting?: Session | undefined;
  /** The name of the chat the next prompt goes to (`state.next`), when it has one beyond its first prompt. */
  readonly chatTitle?: string | undefined;
  /** `false`: the prompt was not sent, and stays in the box. `asPrompt`: never run as a plugin's slash command (a suggestion pressed). */
  readonly onSubmit: (
    prompt: string,
    sent?: { readonly asPrompt?: boolean; readonly attachments?: readonly string[]; readonly attachmentNames?: readonly string[] },
  ) => boolean | void;
  /** Uploads a PDF, video or GIF the composer attaches. */
  readonly onUpload?: ((file: UploadAttachment) => Promise<string>) | undefined;
  readonly onLoadArtifacts?: CanvasStore["loadArtifacts"];
  readonly onReview?: CanvasStore["reviewArtifacts"];
  readonly onAnswer?: CanvasStore["answerQuestion"];
  /** What the chat's workers wait on the reader for, shown after its latest turn. */
  readonly workers?: WorkerNeeds | undefined;
  /** Answer a worker's question at its wait. */
  readonly onAnswerWorker?: (waitId: string, text: string) => void;
  readonly onDecideWorker?: WorkerRoundDecide;
  /** The chat's notices, shown among its turns, each after the turn it followed. */
  readonly notices?: readonly ChatNotice[] | undefined;
  readonly onOpenNotice?: (taskId: string) => void;
  readonly onReplyNotice?: (notice: ChatNotice) => void;
  /** A heartbeat notice's item card. */
  readonly heartbeatCard?: ((notice: ChatNotice & { readonly heartbeatItemId: string }) => ReactNode) | undefined;
  /** A memory notice's card. */
  readonly memoryCard?: ((notice: ChatNotice) => ReactNode) | undefined;
  /** What an answer used: the memory chip on its footer's line. */
  readonly memoryUsedChip?: ((run: CanvasRun) => ReactNode) | undefined;
  /** After a turn: the card for a skill the agent offered in it (`SkillOfferCard`), given the session's turns. */
  readonly skillOffer?: ((run: CanvasRun, index: number, runs: readonly CanvasRun[]) => ReactNode) | undefined;
  /** The heartbeat's first-run offer, shown at the top of Home. */
  readonly heartbeatOffer?: ReactNode;
  /** Show an epoch's archive. */
  readonly onOpenArchive?: (artifactId: string) => void;
  /** Fresh context for the chat shown; answers why it was not set, or nothing. */
  readonly onFreshContext?: (() => Promise<string | undefined>) | undefined;
  readonly onDecide: CanvasStore["decide"];
  readonly onAbort: (id: string) => void;
  /** Show the whole of a transcript the page has bounded, or bound it again. */
  readonly onExpand: (id: string, expanded: boolean) => void;
  /** Take back a prompt queued behind its chat's turn. */
  readonly onCancelQueued?: (id: string) => void;
  /** Rewind the chat to before a turn's message: the message returns to the composer. */
  readonly onRewind?: CanvasStore["rewind"];
  /** *Repeat this…* on a sent message: the schedule form filled from it and the chat's tools; `report` says what was created. */
  readonly onRepeat?: ((prompt: string, report: (note: string) => void) => void) | undefined;
  /** Send a queued prompt into its chat's running turn (Send now). */
  readonly onSteerQueued?: (id: string) => void;
  /** Read the chat's saved turns before the ones shown. */
  readonly onLoadEarlier?: (taskId: string) => void;
  /** Words to put in the composer from outside the chat (an idea's *Try it*), to edit and send; a new `key` puts them there again. */
  readonly composerSeed?: { readonly text: string; readonly key: number } | undefined;
  /** The seed is in the box: the shell lets go of it, so coming back to the chat later does not put it there again. */
  readonly onComposerSeeded?: (() => void) | undefined;
  /** The box went from words to empty (not its first, empty state): what an idea put there is gone. */
  readonly onComposerCleared?: (() => void) | undefined;
  /** The empty chat's suggestions, given how to fill the composer and whether something is typed, which hides them. */
  readonly ideaChips?: ((fill: (prompt: string) => void, hidden: boolean) => ReactNode) | undefined;
}
/** What each turn of a session is offered beside its own state, worked out in one pass over the turns rather than a scan per turn. */
interface TurnFacts {
  /** How many later turns carry a message: what a rewind of this one takes back with it. */
  readonly rewindLater: readonly number[];
  /**
   * Whether a queued prompt can be sent into its chat's turn now: a turn
   * of that chat is running — not waiting on a decision or a question — and no
   * prompt is already on its way into it ahead of this one.
   */
  readonly steerable: readonly boolean[];
  /**
   * Whether a queued prompt waits behind its chat's wait on the reader's
   * decision — an approval round or an artifact review — rather than a
   * running turn: it sends once that is decided.
   */
  readonly awaitsDecision: readonly boolean[];
  /** A running turn's: the transcript of the newest turn before it that kept a plan (`earlierPlanSource`). */
  readonly earlierPlan: readonly (readonly TranscriptEntry[] | undefined)[];
}
/** The statuses a turn waits on the reader's decision in. */
const DECISION_STATUSES: readonly string[] = ["awaiting_approval", "review_required"];
/** The chats (by task id, and by the task a turn continues) that have a turn in one of `statuses` — and, for a running one, not being stopped. */
function chatsWith(runs: readonly CanvasRun[], statuses: readonly string[]): ReadonlySet<string> {
  const chats = new Set<string>();
  for (const other of runs) {
    if (other.queued === true || !statuses.includes(other.run.status)) continue;
    if (other.run.status === "running" && other.aborting) continue;
    if (other.run.taskId !== undefined) chats.add(other.run.taskId);
    if (other.continues !== undefined) chats.add(other.continues);
  }
  return chats;
}
/** What a queued message for chat `taskId` waits on — the composer's queue placeholder says so: a decision, the browser, or the turn. */
function queuedBehind(taskId: string | undefined, runs: readonly CanvasRun[]): "approval" | "review" | "browser" | "turn" {
  if (taskId === undefined) return "turn";
  if (chatsWith(runs, ["awaiting_approval"]).has(taskId)) return "approval";
  if (chatsWith(runs, ["review_required"]).has(taskId)) return "review";
  // A browser handoff (or an account's sign-in) waits on the reader in the browser, not on a typed line.
  const browser = runs.some(
    (other) =>
      other.queued !== true &&
      other.run.status === "waiting" &&
      (other.run.waiting?.handoff !== undefined || other.run.waiting?.connect !== undefined) &&
      (other.run.taskId === taskId || other.continues === taskId),
  );
  return browser ? "browser" : "turn";
}
const QUEUE_PLACEHOLDERS = {
  approval: "Queue a message for after the approval…",
  review: "Queue a message for after the review…",
  browser: "Queue a message for after you finish in the browser…",
  turn: "Queue a message for after this turn…",
} as const;
/** The turn sent from this page and still going: a turn read back has its message from the record, and a settled one is old news. */
function sentTurn(runs: readonly CanvasRun[]): string | undefined {
  const last = runs.findLast((run) => run.prompt !== "" && run.restored !== true && run.seq === undefined);
  return last === undefined || turnEnded(last.run.status) ? undefined : last.id;
}
/**
 * What waits on the reader, by id: the chat's latest question, handoff or review, what its workers ask, and its
 * newest memory card, once a turn ran here (a card in a chat only read back is old news, found by scrolling).
 */
function waitingAsks(
  runs: readonly CanvasRun[],
  notices: readonly ChatNotice[] | undefined,
  workers: WorkerNeeds | undefined,
): readonly string[] {
  const latest = runs.at(-1);
  const waiting = latest?.run.waiting;
  const memory = runs.some((run) => run.restored !== true && run.seq === undefined)
    ? notices?.findLast((notice) => notice.kind === "memory")
    : undefined;
  return [
    ...(waiting !== undefined && (waiting.question ?? waiting.handoff ?? waiting.connect) !== undefined
      ? [`wait:${waiting.waitId ?? waiting.on}`]
      : []),
    ...(latest?.run.status === "review_required" ? [`review:${latest.id}`] : []),
    ...(memory === undefined ? [] : [`memory:${memory.noticeId}@${memory.createdAt}`]),
    ...[...(workers?.questions ?? []), ...(workers?.handoffs ?? [])].map((row) => `worker:${row.waitId}`),
    ...(workers?.approvals ?? []).map((row) => `worker:${row.approvalId}`),
  ];
}
export function turnFacts(runs: readonly CanvasRun[]): TurnFacts {
  const sending = runs.some((other) => other.queued === true && other.steering === "sending");
  const running = chatsWith(runs, ["running"]);
  const deciding = chatsWith(runs, DECISION_STATUSES);
  const rewindLater: number[] = new Array(runs.length);
  for (let index = runs.length - 1, later = 0; index >= 0; index -= 1) {
    rewindLater[index] = later;
    if (runs[index]?.prompt !== "") later += 1;
  }
  // A plan is looked for only up to the last running turn: no other turn is given one.
  const lastRunning = runs.findLastIndex((run) => run.run.status === "running");
  const earlierPlan: (readonly TranscriptEntry[] | undefined)[] = new Array(runs.length).fill(undefined);
  for (let index = 0, kept: readonly TranscriptEntry[] | undefined; index <= lastRunning; index += 1) {
    const transcript = runs[index]?.run.transcript;
    if (runs[index]?.run.status === "running") earlierPlan[index] = kept;
    if (transcript !== undefined && latestPlan(transcript) !== undefined) kept = transcript;
  }
  return {
    rewindLater,
    steerable: runs.map(
      (run) => run.queued === true && run.continues !== undefined && run.carriesFiles !== true && !sending && running.has(run.continues),
    ),
    awaitsDecision: runs.map((run) => run.queued === true && run.continues !== undefined && deciding.has(run.continues)),
    earlierPlan,
  };
}
/** The selected session's turns, its rounds, and the composer. */
export function Canvas({
  modelTarget,
  modelNotice,
  unconfigured = false,
  onModels,
  modelPicker,
  folderChip,
  memoryToggle,
  taintChip,
  content,
  state,
  session,
  acting,
  chatTitle,
  onSubmit,
  onUpload,
  onLoadArtifacts = async () => undefined,
  onReview = () => undefined,
  onAnswer = () => undefined,
  workers,
  onAnswerWorker = () => undefined,
  onDecideWorker,
  notices,
  onOpenNotice,
  onReplyNotice,
  heartbeatCard,
  memoryCard,
  memoryUsedChip,
  skillOffer,
  heartbeatOffer,
  onOpenArchive,
  onFreshContext,
  onDecide,
  onAbort,
  onExpand,
  onCancelQueued,
  onRewind,
  onRepeat,
  onSteerQueued,
  onLoadEarlier,
  composerSeed,
  onComposerSeeded,
  onComposerCleared,
  ideaChips,
}: CanvasProps) {
  /** The workspace's zone, the one a question's deadline and receipt are said in. */
  const timeZone = useTimeZone();
  /** The chat shown, when older turns of its saved history are still to be read. */
  const earlierTask = session?.taskId !== undefined && state.earlier?.[session.taskId] !== undefined ? session.taskId : undefined;
  const scroller = useRef<HTMLDivElement>(null);
  // How much there is to read, and how many entries there are. The first moves
  // on every delta — a streamed answer is one growing block, not new entries —
  // so the view follows it; the second is what "N new" can honestly count.
  // Worked out again only when the turns change, never on a repaint that left them as they were.
  const runs = session?.runs;
  const { size, entries } = useMemo(
    () => ({
      size:
        runs?.reduce(
          (total, run) => total + run.run.transcript.reduce((n, entry) => n + (entry.kind === "text" ? entry.text.length : 1), 0),
          0,
        ) ?? 0,
      entries: runs?.reduce((count, run) => count + run.run.transcript.length, 0) ?? 0,
    }),
    [runs],
  );
  // Where the chat rolled over, placed among its turns.
  const placesNotices = content === undefined && runs !== undefined;
  const dividers = useMemo(
    () => (placesNotices ? epochDividersByRun(runs, notices) : new Map<number, readonly ChatNotice[]>()),
    [placesNotices, runs, notices],
  );
  // Background output posted into the chat, after the turn it followed: data, never a turn of its own.
  const cards = useMemo(
    () => (placesNotices ? noticesByRun(runs, notices) : new Map<number, readonly ChatNotice[]>()),
    [placesNotices, runs, notices],
  );
  // A card posted into the chat (a `/remember`'s Saved, a side chat's result) is new to read, as an answer is.
  const placed = useMemo(
    () => [...cards.values(), ...dividers.values()].reduce((count, shown) => count + shown.length, 0),
    [cards, dividers],
  );
  const turn = useMemo(() => sentTurn(runs ?? []), [runs]);
  const asks = useMemo(() => waitingAsks(runs ?? [], notices, workers), [runs, notices, workers]);
  const { behind, jump } = useAutoscroll(scroller, size + placed, entries + placed, session?.key, { turn, asks });
  const placedAt = (index: number) => (
    <>
      {(dividers.get(index) ?? []).map((notice) => (
        <EpochDivider
          key={`${notice.noticeId}@${notice.createdAt}`}
          notice={notice}
          connected={state.connection === "ready"}
          onOpenArchive={onOpenArchive}
          onFreshContext={onFreshContext}
        />
      ))}
      <NoticeCards
        notices={cards.get(index)}
        connected={state.connection === "ready"}
        onOpen={onOpenNotice}
        onReply={onReplyNotice}
        heartbeatCard={heartbeatCard}
        memoryCard={memoryCard}
      />
    </>
  );
  const stoppable = useMemo(() => runs?.find(abortableRun), [runs]);
  /** A message rewound, back in the composer to edit; keyed so the same words twice still land. */
  const [seed, setSeed] = useState<{ readonly text: string; readonly key: number }>();
  // Words from outside the chat (an idea's *Try it*): in the box like a rewound message, never sent by this.
  useEffect(() => {
    if (composerSeed === undefined) return;
    setSeed((before) => ({ text: composerSeed.text, key: (before?.key ?? 0) + 1, placeholder: true }));
    onComposerSeeded?.();
  }, [composerSeed?.key]);
  // A message the owner never got: back in the box to send again.
  useEffect(() => {
    if (state.unsent !== undefined) setSeed((before) => ({ text: state.unsent?.text ?? "", key: (before?.key ?? 0) + 1 }));
  }, [state.unsent?.key]);
  const [composerEmpty, setComposerEmpty] = useState(true);
  const fillComposer = useCallback((text: string) => setSeed((before) => ({ text, key: (before?.key ?? 0) + 1, placeholder: true })), []);
  const rewindRun = useCallback(
    async (id: string): Promise<string | undefined> => {
      if (onRewind === undefined) return "Rewind is unavailable here.";
      const taken = await onRewind(id);
      if (!taken.ok) return taken.message;
      setSeed((before) => ({ text: taken.prompt, key: (before?.key ?? 0) + 1 }));
      return undefined;
    },
    [onRewind],
  );
  // Rewind is offered only while the chat is still: no turn running, waiting or queued behind.
  const still = useMemo(() => runs !== undefined && !runs.some((run) => run.queued === true || !turnEnded(run.run.status)), [runs]);
  // A cancel is final: nothing goes on in the chat, so nothing here offers to.
  const closed = session?.status === "canceled";
  const rewindable = onRewind !== undefined && state.connection === "ready" && still && !closed;
  const facts = useMemo(() => (runs === undefined ? undefined : turnFacts(runs)), [runs]);
  const pluginStatus = useMemo(() => (runs === undefined ? {} : chatPluginStatus(runs, session?.taskId)), [runs, session?.taskId]);
  // Who the composer writes to, as the store will send it — never guessed from the chat on screen.
  const next = state.next ?? { kind: "new" as const };
  const toHome = next.kind === "home";
  const target = next.kind === "home" || next.kind === "new" ? undefined : next.taskId;
  // A chat's name, when it has one beyond its first message: an untitled chat's
  // title is that message, and the box saying "Message <the question>" reads as the question again.
  const named = useMemo(() => {
    if (chatTitle === undefined || target === undefined) return chatTitle;
    const first = state.runs
      .filter((run) => run.run.taskId === target || run.continues === target)
      .map((run) => run.prompt.split("\n", 1)[0]?.trim() ?? "")
      .find((line) => line !== "");
    const title = trailingEllipsisOff(chatTitle).trim();
    return first !== undefined && (first.startsWith(title) || title.startsWith(first)) ? undefined : chatTitle;
  }, [chatTitle, target, state.runs]);
  const queued = next.kind === "queue" ? next.taskId : undefined;
  const queueBehind = useMemo(() => queuedBehind(queued, state.runs), [queued, state.runs]);
  // The one question open is answered by what is typed.
  const replying = next.kind === "new" ? state.replyingTo : undefined;
  const placeholder =
    next.kind === "answer"
      ? "Answer the question above…"
      : replying !== undefined
        ? `Reply to “${clip(replying.title, 40)}” in a side chat…`
        : next.kind === "queue"
          ? QUEUE_PLACEHOLDERS[queueBehind]
          : toHome || (target !== undefined && target === state.home)
            ? "Message Home…"
            : next.kind === "continue"
              ? named === undefined
                ? "Reply…"
                : `Message ${trailingEllipsisOff(clip(named, 40))}…`
              : state.privateDraft === true
                ? "Start a private chat: memory off, forgotten a day after its last message…"
                : next.kind === "new" && next.side === true
                  ? "Start a side chat…"
                  : "Start a new chat…";
  /** A private chat not started yet: no session, and the next message begins one with memory off for good. */
  const privateNew = session === undefined && !toHome && state.privateDraft === true;
  const pluginNotice = session?.runs.at(-1)?.run.pluginNotices.at(-1);
  const latest = session?.runs.at(-1);
  const suggestions = latest !== undefined && turnEnded(latest.run.status) && !closed ? latest.run.suggestions : [];
  return (
    <>
      {session !== undefined ? (
        <header className="task-header">
          <h1 className="truncate">{session.title}</h1>
          <span className={`badge badge-plain status-${session.status}`}>
            {workersWait(workers) ? TASK_STATUS_LABELS["input-required"] : headerStatusLabel(session.status, session.taskId === state.home)}
          </span>
          {folderChip}
          {memoryToggle}
          {taintChip}
          {/* Plugins' status lines, kept across the chat's turns until cleared, and the newest notice. */}
          {Object.entries(pluginStatus).map(([pluginId, text]) => (
            <span key={`plugin-status:${pluginId}`} className="meta-base truncate" title={pluginId}>
              {text}
            </span>
          ))}
          {pluginNotice === undefined ? null : (
            <span className="meta-base truncate" title={pluginNotice.pluginId}>
              {pluginNotice.pluginId}: {pluginNotice.text}
            </span>
          )}
        </header>
      ) : privateNew ? (
        // A new private chat says so before its first message, as its header will after.
        <header className="task-header">
          <h1 className="truncate">New private chat</h1>
          <PrivateChatMark />
          {folderChip}
        </header>
      ) : (
        <>
          {/* No chat yet: the page still has its one top heading, for a reader moving by headings. */}
          <h1 className="visually-hidden">{toHome ? "Home" : "New chat"}</h1>
          {/* The folders the first message starts the chat with. */}
          {folderChip === undefined ? null : <div className="task-header">{folderChip}</div>}
        </>
      )}
      <div className="runs" ref={scroller}>
        {/* The heartbeat's first-run offer, in Home only. */}
        {toHome ? heartbeatOffer : null}
        {session === undefined ? (
          <div className="chat-greeting">
            <p className="chat-greeting-title">{greeting(timeZone)}</p>
            <Empty>
              {toHome
                ? "Ask Tavi something: it goes to your Home."
                : privateNew
                  ? "A private chat: nothing in it is remembered, it is left out of past-chat search, and it is forgotten a day after its last message."
                  : "Ask Tavi something to start a chat."}
            </Empty>
          </div>
        ) : null}
        {session === undefined ? ideaChips?.(fillComposer, !composerEmpty) : null}
        {earlierTask !== undefined && onLoadEarlier !== undefined ? (
          <p className="earlier">
            <Button variant="ghost" size="sm" onClick={() => onLoadEarlier(earlierTask)}>
              Load earlier turns
            </Button>
          </p>
        ) : null}
        {content ??
          session?.runs.map((run, index, runs) => (
            <Fragment key={run.id}>
              {placedAt(index)}
              <RunView
                run={run}
                timeZone={timeZone}
                lastingChat={lastingChatOf(run, state)}
                firstTurn={firstTurnOf(runs, index)}
                earlierBegins={run.restored === true && runs[index - 1]?.restored !== true}
                connected={state.connection === "ready"}
                onLoadArtifacts={onLoadArtifacts}
                onReview={onReview}
                onAnswer={onAnswer}
                onDecide={onDecide}
                onExpand={onExpand}
                {...(onCancelQueued === undefined ? {} : { onCancelQueued })}
                {...(rewindable &&
                run.prompt !== "" &&
                run.merged !== true &&
                run.recordedPrompts === undefined &&
                (run.run.taskId ?? run.continues) !== undefined
                  ? { onRewind: rewindRun, rewindLater: facts?.rewindLater[index] ?? 0 }
                  : {})}
                {...(onRepeat === undefined || run.queued === true || run.merged === true ? {} : { onRepeat })}
                {...(onSteerQueued === undefined || facts?.steerable[index] !== true ? {} : { onSteerQueued })}
                awaitsDecision={facts?.awaitsDecision[index] === true}
                earlierPlan={facts?.earlierPlan[index]}
                memoryChip={memoryUsedChip?.(run)}
              />
              {skillOffer?.(run, index, runs)}
            </Fragment>
          ))}
        {content === undefined && session !== undefined ? placedAt(session.runs.length) : null}
        {/* What plugins suggest next, from the chat's latest turn: a press sends it as a prompt, even one that reads as a slash command. */}
        {content === undefined && suggestions.length > 0 ? (
          <p className="suggestions" role="group" aria-label="Suggested next">
            {suggestions.map((suggestion, index) => (
              <Button
                variant="ghost"
                size="sm"
                key={`${index}:${suggestion}`}
                disabled={state.connection !== "ready"}
                onClick={() => {
                  onSubmit(suggestion, { asPrompt: true });
                }}
              >
                {suggestion}
              </Button>
            ))}
          </p>
        ) : null}
        {/* A worker's question is asked here, after the chat's latest turn: workers are no chats. */}
        {content === undefined && session !== undefined ? (
          <WorkerNeedCards
            needs={workers}
            connected={state.connection === "ready"}
            onAnswer={onAnswerWorker}
            onDecide={onDecideWorker}
            lastingChat={latest !== undefined && lastingChatOf(latest, state)}
          />
        ) : null}
        {behind ? (
          <p className="jump-latest">
            <Button
              size="sm"
              onClick={(event) => {
                jump();
                // The button goes with the jump: from the keyboard (no pointer, `detail` 0), focus goes on to the box.
                if (event.detail === 0) scroller.current?.parentElement?.querySelector<HTMLElement>(".composer-box textarea")?.focus();
              }}
            >
              Jump to latest
            </Button>
          </p>
        ) : null}
      </div>
      <StatusNote note={modelNotice} className="notice model-notice" />
      <StatusNote note={state.unsent?.message} className="failure unsent-note" />
      {/* A plugin's slash command answered: its text, for the person, never the model. */}
      <StatusNote
        note={state.commandAnswer === undefined ? undefined : `/${state.commandAnswer.name}: ${state.commandAnswer.text}`}
        className={state.commandAnswer?.failed === true ? "failure command-answer" : "notice command-answer"}
      />
      {closed ? (
        <p className="notice">This chat was cancelled, so it takes no more messages.</p>
      ) : (
        <Composer
          modelTarget={modelTarget}
          onModels={onModels}
          modelPicker={modelPicker}
          unconfigured={unconfigured}
          disabled={state.connection !== "ready"}
          placeholder={placeholder}
          onSubmit={onSubmit}
          onUpload={onUpload}
          seed={seed}
          commands={state.pluginCommands}
          onEmptyChange={setComposerEmpty}
          onCleared={onComposerCleared}
          onStop={stoppable === undefined ? undefined : () => onAbort(stoppable.id)}
          retryPrompt={retryPromptOf((acting ?? session)?.runs.at(-1))}
          onRetry={(prompt) => {
            onSubmit(prompt);
          }}
        />
      )}
    </>
  );
}

/** A title before the placeholder's own "…": without the ellipsis or full stops it already ends in, so it is never doubled. */
export function trailingEllipsisOff(title: string): string {
  return title.replace(/[\s.…]+$/u, "");
}
