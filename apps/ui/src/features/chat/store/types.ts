import type { ClientState, PendingRound, RecordedTask, RunState, TaviClient } from "@tavi/client/browser";
import type {
  ApprovalScope,
  ArtifactListRow,
  ChatNotice,
  PendingApprovalRow,
  PendingHandoffRow,
  PendingQuestionRow,
  PluginCommandView,
  RunPayload,
  TaskListFilters,
  TaskListRow,
  TranscriptMemoryUsed,
} from "@tavi/contracts";

import type { CardOutcome, RoundDecision } from "../../center/InboxRoundCard.js";
import type { PendingRoundCard } from "../../center/inbox-model.js";
import type { CallDecision } from "../tasks-api.js";
import type { Said } from "./said.js";

/** An answer sent from this page to a worker's question, and the question it answered. */
export interface WorkerAnswer {
  readonly text: string;
  readonly status: "sending" | "recorded" | "uncertain" | "failed";
  readonly message?: string;
  readonly question: PendingQuestionRow;
}

/**
 * What a root chat's delegated workers wait on the reader for: their
 * open questions and browser handoffs, shown and answered in the root chat,
 * never in a chat of their own. An answer sent from this page outlives its
 * question as a receipt.
 */
export interface WorkerNeeds {
  readonly questions: readonly PendingQuestionRow[];
  readonly handoffs: readonly PendingHandoffRow[];
  /** Their approvals, decided by round at the worker's task. */
  readonly approvals?: readonly PendingApprovalRow[];
  /** By round: a decision made here, while its card is still listed. */
  readonly decided?: Readonly<Record<string, CardOutcome>>;
  /** By wait. */
  readonly answers: Readonly<Record<string, WorkerAnswer>>;
}

/** A turn of a chat that ended: its entry, and the owner's time of its end event. */
export interface EndedTurn {
  readonly id: string;
  readonly at: string;
}

/** One prompt sent from this page, and its run — or the turn it continued — as the reducer folds it. */
export interface CanvasRun {
  /** The operation key it was admitted under — or, a continuation, its reply's message id — which is also its id here. */
  readonly id: string;
  readonly prompt: string;
  /** The task this prompt continued, as a new turn of it; absent for a prompt that started a task. */
  readonly continues?: string;
  /** A turn replayed after the page was reloaded: its prompt is not on the task's stream, so it has none here. */
  readonly restored?: boolean;
  /** A chat with no turn yet (a Home a schedule started): there is nothing of it to draw. */
  readonly noTurn?: boolean;
  /** A saved turn's place in its task's history: where the chat's notices go among its turns. */
  readonly seq?: number;
  /**
   * What the answer used, from its saved turn: the turn it is read from (`memorySeq`,
   * which for a turn sent from this page is its last admission's, found once it settled) and its
   * `memoryUsed`, absent for a turn saved before answers recorded it.
   */
  readonly memorySeq?: number;
  readonly memoryUsed?: TranscriptMemoryUsed;
  /**
   * Typed while its chat's turn ran or waited on a decision: held
   * here, and sent as the chat's next turn once that turn ends. Cleared when
   * it is sent.
   */
  readonly queued?: boolean;
  /**
   * A queued prompt sent into the running turn (**Send now**): on its
   * way (`sending`), or recorded for the turn's next model call (`sent`). Still
   * queued: should the turn end before it reads it, it is sent as the next
   * turn, as any queued prompt — the same message, so it runs once. Gone from
   * the page once the stream shows it in the turn.
   */
  readonly steering?: "sending" | "sent";
  /** Sent into the person's Home (`target: "home"`): the Home's next turn, or the message that began it. */
  readonly toHome?: boolean;
  /** It carries uploaded files: a turn of its own, never sent into a running one. */
  readonly carriesFiles?: true;
  /** The uploaded files' names, shown on the message as it was sent: the prompt names none of them. */
  readonly fileNames?: readonly string[];
  readonly recordedPrompts?: readonly string[];
  /** Its prompt is several recorded turns' prompts, read back from the task's record: no one turn. */
  readonly merged?: true;
  readonly recordedHistory?: RecordedTask["history"];
  readonly approvalHistory?: Readonly<Record<number, PendingRound>>;
  readonly artifacts?: readonly ArtifactListRow[];
  readonly reviewBusy?: boolean;
  readonly reviewError?: Said;
  readonly questionId?: string;
  readonly needsRevision?: string;
  readonly answer?: {
    readonly key: string;
    readonly text: string;
    readonly status: "sending" | "recorded" | "uncertain" | "failed";
    readonly message?: string;
  };
  readonly run: RunState;
  /** The plugins whose status line this turn's stream set or cleared (`chatPluginStatus`). */
  readonly pluginStatusSeen?: readonly string[];
  /**
   * Each pending round's calls, as the owner listed them: the owner announces
   * a round one call at a time, so a round is offered for a decision only once
   * every listed call has arrived (`decidableRound`).
   */
  readonly roundCalls: Readonly<Record<number, readonly string[]>>;
  /** The round a decision was sent for, until the owner settles it. */
  readonly deciding: number | undefined;
  /** An abort is on its way, until the turn ends. */
  readonly aborting: boolean;
  /** What the stream no longer says, in words the page shows (after an owner restart, say). */
  readonly notice?: Said;
  /** Why this entry is not what was asked of it — a continuation that started a new task — kept as the stream goes on. */
  readonly remark?: readonly Said[];
  /** Why the run could not be started, followed or acted on. */
  readonly error?: Said;
  /** The reader asked for the whole transcript: `transcriptWindow` stops bounding it. */
  readonly expanded?: boolean;
  /**
   * When the owner stamped this entry's first event, and its latest: the
   * owner's own clock, never the browser's, so a page whose clock is wrong —
   * or that joined late — says nothing it cannot measure.
   */
  readonly startedAt?: string;
  readonly lastAt?: string;
  /**
   * Working time: the gaps between this entry's events while it was
   * running, so a round waiting on a person or a night between turns is not
   * counted — or, read back from the record, its executions' summed spans.
   */
  readonly activeMs?: number;
}

export interface CanvasState {
  /** Plugins' slash commands, as the owner listed them when the page connected: what the composer offers after `/`. */
  readonly pluginCommands?: readonly PluginCommandView[];
  /** A message the owner never got: back in the composer (`text`), with why (`message`), until the next prompt. */
  readonly unsent?: { readonly key: string; readonly text: string; readonly message: Said };
  /** What a plugin's slash command answered, typed in this page: shown until the next prompt. */
  readonly commandAnswer?: { readonly name: string; readonly text: Said; readonly failed?: true };
  readonly directory?: {
    readonly observedNeeds?: Readonly<Record<string, string>>;
    readonly rows: readonly TaskListRow[];
    readonly needs: readonly TaskListRow[];
    readonly nextCursor?: string;
    readonly needsTruncated: boolean;
    readonly loading: boolean;
    readonly error?: string;
  };
  readonly connection: ClientState;
  /** Why the client closed on its own: shown with how to get a new link. */
  readonly failure?: string;
  readonly runs: readonly CanvasRun[];
  /** The task the next prompt continues; absent when it starts a new one. */
  readonly continuing?: string;
  /** The finished task New task set aside: the next prompt starts a new one, unless it is taken up again. */
  readonly declined?: string;
  /** Per task read back from its saved history: where an older page begins, while one remains. */
  readonly earlier?: Readonly<Record<string, number>>;
  /** The person's Home, once the page has seen its task. */
  readonly home?: string;
  /** Where the next prompt goes, as `submit` would send it now: what the composer says. */
  readonly next?: NextPrompt;
  /** By root chat: what its delegated workers wait on the reader for. */
  readonly workers?: Readonly<Record<string, WorkerNeeds>>;
  /** By chat: its newest notices, oldest first. */
  readonly notices?: Readonly<Record<string, readonly ChatNotice[]>>;
  /** The notice the next prompt replies to, in a side chat of the chat it was posted into. */
  readonly replyingTo?: ChatNotice;
  /** *New private chat* was asked for: the next prompt starts a private chat. */
  readonly privateDraft?: true;
}

/**
 * Where a prompt typed now goes: the answer to a chat's
 * question, queued behind a chat's running turn, the next turn of a finished
 * chat, into the person's Home, or a chat of its own.
 */
export type NextPrompt =
  /**
   * The one question open in the chat: its own, or — with `waitId` and
   * `rootTaskId` — a worker's, answered at the worker's wait, never a turn of the root.
   */
  | { readonly kind: "answer"; readonly taskId: string | undefined; readonly waitId?: string; readonly rootTaskId?: string }
  | { readonly kind: "queue"; readonly taskId: string }
  | { readonly kind: "continue"; readonly taskId: string }
  | { readonly kind: "home" }
  /** A chat of its own: `side` when it opens as a side chat of the chat on screen when New side chat was pressed. */
  | { readonly kind: "new"; readonly side?: true };

/**
 * The part of the client the canvas uses. `features` is the owner's command
 * list (`ready.features`): the shell offers a route only when the owner it is
 * attached to implements the command behind it.
 */
/** A chat's model, as `run` carries it. */
export type ChatModelTarget = NonNullable<RunPayload["model"]>;

/**
 * What a new chat's first message carries beside its prompt: its drafted
 * instructions, and its own model. A chat already open keeps
 * both, and Home its own.
 */
export interface SubmitExtra {
  readonly chatInstructions?: string;
  readonly model?: ChatModelTarget;
  /**
   * The chat on screen, which a plugin's slash command runs against;
   * absent, the chat the page shows last. Set to `undefined`, no chat is in view.
   */
  readonly viewing?: string | undefined;
  /** Sent as a prompt even when it reads as a plugin's slash command: a suggestion pressed. */
  readonly asPrompt?: boolean;
  /** Files uploaded with `artifacts upload` the message carries , by artifact id. */
  readonly attachments?: readonly string[];
  /** Their names, in the same order: shown on the message, never sent. */
  readonly attachmentNames?: readonly string[];
  /** The idea whose *Try it* filled the box: a new chat it starts is linked to it. */
  readonly fromIdeaId?: string;
  /** Folders picked on the empty chat, by `browse` token: a chat (or Home) this message starts begins with them attached. */
  readonly folderAttachments?: RunPayload["folderAttachments"];
}

export type CanvasClient = Pick<TaviClient, "state" | "failure" | "onState" | "run" | "subscribe" | "request" | "features">;

export interface CanvasOptions {
  readonly workspaceId: string;
  readonly principal: string;
  /** A fresh operation key per prompt; a resend after a drop rejoins its run. */
  readonly mintKey: () => string;
  /** How long a continuation's recorded prompt may go without its turn speaking before the record is read (ms). */
  readonly settleMs?: number;
  /**
   * Where the page keeps its last task and that task's conversation (the tab's
   * storage): a reload replays the task and continues it.
   */
  readonly memory?: TaskMemory;
  /**
   * What paces the page's repaints; the browser's own frames and timers by
   * default. A test drives it by hand, so batching is asserted rather than
   * waited for.
   */
  readonly scheduler?: CanvasScheduler;
}

/** What `createCanvasStore` measures and defers with: a frame, a timer and a clock. */
export interface CanvasScheduler {
  /** Run `callback` before the next repaint; the returned function cancels it. */
  frame(callback: () => void): () => void;
  /** Run `callback` in `ms`; the returned function cancels it. */
  timer(ms: number, callback: () => void): () => void;
  /** A monotonic-enough millisecond clock, for the flush ceiling. */
  now(): number;
}

/** The page's last task, as kept across a reload. */
export interface RememberedTask {
  readonly taskId: string;
  readonly conversationId: string;
}

/** A task to read back: `cancelled` is its cancel's reason, when the caller has read its record. */
export interface RestoredTask extends RememberedTask {
  readonly cancelled?: string;
}

export interface TaskMemory {
  load(): RememberedTask | undefined;
  save(task: RememberedTask): void;
}

export interface CanvasStore {
  loadSessions(filters?: TaskListFilters, more?: boolean, refresh?: boolean): Promise<void>;
  openTask(taskId: string): Promise<void>;
  answerQuestion(id: string, text: string): void;
  /** Read what root chat `rootTaskId`'s workers wait on the reader for. */
  loadWorkerNeeds(rootTaskId: string): Promise<void>;
  /** Decide a worker's round from its root chat. */
  decideWorkerRound(rootTaskId: string, round: Pick<PendingRoundCard, "key" | "taskId" | "steps">, decision: RoundDecision): void;
  /** Answer a worker's question from its root chat: at the worker's wait, never as a turn of the root. */
  answerWorker(rootTaskId: string, waitId: string, text: string): void;
  /** Read chat `taskId`'s newest notices. */
  loadNotices(taskId: string): Promise<void>;
  /** The next prompt replies to `notice`: a side chat of the chat it was posted into, seeded with its run's output. */
  replyToNotice(notice: ChatNotice): void;
  /**
   * A turn about a heartbeat item: into
   * Home, or a new chat with Home off — never a side chat. The owner seeds it
   * from the item — its proposal for *Do it*, the item quoted for *Chat about
   * this* — and it starts tainted; `prompt` is what the transcript shows until then.
   */
  heartbeatTurn(input: {
    readonly prompt: string;
    readonly toHome: boolean;
    readonly itemId: string;
    readonly action: "do" | "chat";
  }): void;
  loadArtifacts(id: string): Promise<void>;
  reviewArtifacts(id: string, decisions: readonly { readonly artifactId: string; readonly approved: boolean }[]): void;
  getSnapshot(): CanvasState;
  subscribe(listener: () => void): () => void;
  /**
   * Send a prompt: once the last task has finished, as a new turn of it — a
   * `reply` into its conversation — otherwise as a run whose approval
   * rounds this page answers.
   */
  /** `extra.chatInstructions`: a new chat's drafted instructions, sent only when the prompt starts a task. */
  submit(prompt: string, extra?: SubmitExtra): void;
  /**
   * Take plugin `pluginId`'s status lines off every chat: Settings
   * disabled or rejected it, and the clear it publishes reaches no stream
   * between turns.
   */
  dropPluginStatus(pluginId: string): void;
  /** Take back a prompt still queued behind its chat's turn: it is never sent. */
  cancelQueued(id: string): void;
  /**
   * Rewind: take back the turn entry `id` shows and every later turn
   * of its chat, on the owner and on the page, so the chat's next message
   * goes on from before it. Answers the taken-back prompt, for the composer to
   * hold, or why nothing was taken back.
   */
  rewind(id: string): Promise<{ readonly ok: true; readonly prompt: string } | { readonly ok: false; readonly message: string }>;
  /**
   * **Send now**: a prompt queued behind its chat's running turn is
   * sent into that turn, which reads it before its next model call. It stays
   * first in the queue until the stream shows it in the turn, so a turn that
   * ends first gets it as its next turn instead.
   */
  steerQueued(id: string): void;
  /** Read the page of `taskId`'s saved history before the one shown. */
  loadEarlier(taskId: string): void;
  /**
   * The next prompt starts a chat of its own rather than continuing the last:
   * a side chat of `parentChatId` — the chat on screen — when there is one,
   * else an ordinary chat. A worker is never a parent.
   * Called again with none while the new chat is still a draft, it keeps the parent.
   * `own` makes it a chat of its own whatever the draft before it was — no
   * parent kept, no notice answered — as an idea's *Try it* opens;
   * `private` does the same, with its memory off.
   */
  newTask(parentChatId?: string, options?: { readonly private?: boolean; readonly own?: boolean }): void;
  /**
   * The workspace's `chat.home`: on, a prompt that would start a chat
   * of its own — not after `newTask` — goes into the person's Home instead.
   */
  setHome(on: boolean): void;
  /**
   * Home opened from the chat list before its first message: the next
   * prompt starts it (`target: "home"`), not the chat the page last showed.
   */
  openHome(): void;
  /** Decide the run's oldest pending round, all of it one way — once it is whole. */
  /**
   * Decide the pending round. `scope` widens an approval to the rest of the
   * task or to a workspace rule where every call offered it; `note` is
   * a rejection's reason, which the model reads.
   */
  decide(id: string, approved: boolean | readonly CallDecision[], extra?: { readonly scope?: ApprovalScope; readonly note?: string }): void;
  /** Stop the turn the run's task is running. */
  abort(id: string): void;
  /** Show the whole of a bounded transcript (`transcriptWindow`), or bound it again. */
  setExpanded(id: string, expanded: boolean): void;
  /**
   * Let the store go: its streams closed, its timers cleared and its listeners
   * dropped, so a page that replaces it leaves nothing running.
   */
  dispose(): void;
}
