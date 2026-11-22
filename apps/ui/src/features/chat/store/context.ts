import type { ClientResponse, RunOptions, RunState, Subscription } from "@tavi/client/browser";
import type { ClientEvent, ChatNotice, RunPayload, TranscriptEntry as SavedTurn } from "@tavi/contracts";

import type { CanvasClient, CanvasOptions, CanvasRun, CanvasState, CanvasStore, EndedTurn, NextPrompt, RestoredTask } from "./types.js";
import type { Said } from "./said.js";

/** What a new entry on the page starts with beside its id and prompt. */
interface EntryExtra {
  readonly continues?: string;
  readonly run?: RunState;
  readonly restored?: boolean;
  readonly queued?: boolean;
  readonly toHome?: boolean;
  readonly carriesFiles?: true;
  readonly fileNames?: readonly string[];
}

/**
 * The store's working parts, each installed by the module that owns it
 * (`install*`) and called through the context by the others, so the parts
 * can call one another whatever order they are installed in.
 */
interface StoreOps {
  /** The finished task the next prompt continues: by its conversation, or by the task itself. */
  continuable(): string | undefined;
  /** Where a prompt typed now goes: the one decision `submit` acts on and the composer names. */
  nextPrompt(): NextPrompt;
  /** The chat the page shows: its last entry's, a queued one's by the chat it waits behind. */
  onScreen(): string | undefined;
  /** The run waiting on a question that a prompt typed now answers. */
  asked(): CanvasRun | undefined;
  /** The new state, and a repaint: at once, or batched for the ordinary flow of a stream. */
  publish(next: CanvasState, urgent?: boolean): void;
  /** Call off a deferred repaint. */
  cancelPaint(): void;
  /** The page's last task, kept for a reload. */
  remember(taskId: string): void;
  /** Task `taskId` finished as the page's last prompt: the next prompt continues it. */
  settles(id: string, taskId: string): void;
  find(id: string): CanvasRun | undefined;
  update(id: string, change: (run: CanvasRun) => CanvasRun, urgent?: boolean): void;
  failed(id: string, error: Said): void;
  /** The chat an entry belongs to: its task, or the one it continues. */
  chatOf(run: CanvasRun): string | undefined;
  /** Plugins' status lines taken off the entries `which` picks: `pluginId`'s, or every one. */
  dropStatus(which: (run: CanvasRun) => boolean, pluginId?: string): void;
  /** A new entry on the page. */
  entry(id: string, prompt: string, extra?: EntryExtra): CanvasRun;
  /** Send, and once more if the first send timed out. */
  sendOnceMore(send: () => Promise<ClientResponse>): Promise<{ readonly response: ClientResponse; readonly retried: boolean }>;
  unwatch(id: string): void;
  /** An earlier entry of a task the next prompt continues: its stream closed. */
  retire(id: string): void;
  /** The entry's stream closed, and whatever watched its turn stopped. */
  unfollow(id: string): void;
  /** Apply `event`, or hold it while the entry's record is being read back. */
  apply(id: string, event: ClientEvent): void;
  /** The frames an entry held while its record was read, applied in the order they arrived. */
  releaseHeld(id: string): void;
  /** Follow a run's stream; one that lost its place is resumed from the last event applied. */
  following(id: string, resumes?: number): RunOptions;
  start(id: string, payload: RunPayload, rejoined: boolean): void;
  /** Every pending approval row the owner holds for a task. */
  pendingRows(taskId: string): Promise<ClientResponse>;
  /** A saved turn as a page entry. */
  savedRun(saved: SavedTurn): CanvasRun;
  /** What turns of a chat used, once they settled, oldest first. */
  attachMemoryUsed(taskId: string, ended: readonly EndedTurn[], tries?: number): void;
  /** The task of entry `id` was cancelled, for `reason`: its last turn reads so, and what was queued behind it is not sent. */
  cancelled(id: string, taskId: string, reason: string): void;
  /** What a resync erased from the stream, read back from the task's record. */
  readRecord(id: string, taskId: string): void;
  /** The oldest prompt queued behind `taskId`'s turn, sent now as its next turn. False when none waits. */
  sendQueued(taskId: string): boolean;
  /** A queued prompt the turn of `taskId` took: out of the queue and off the page. */
  dropSteered(taskId: string, id: string): void;
  /** A task that will take no further turn: what was queued behind it is not sent. */
  dropQueued(taskId: string, error: Said): void;
  /** A prompt that continues task `taskId`, as a new turn of it. */
  continueTask(id: string, taskId: string, prompt: string, conversationId: string | undefined): void;
  /** A continuation whose turn has not spoken, watched. */
  watch(id: string): void;
  /** A task replayed from the owner's stream as its turns. */
  restore(remembered: RestoredTask, prompts?: readonly string[], resume?: CanvasRun, onLost?: (error: Said) => void): void;
  /** The chat shown here, taken up again from where its last followed turn stopped. */
  catchUp(taskId: string, place?: { readonly at?: string; readonly from?: CanvasRun }): void;
  /** Merge a read of chat `taskId`'s notices into what the page holds. */
  putNotices(taskId: string, incoming: readonly ChatNotice[], window?: { readonly limit: number }): void;
}

/** The public operations a part installs, called by the others through the context as well. */
type InstalledApi = Pick<
  CanvasStore,
  | "loadSessions"
  | "openTask"
  | "answerQuestion"
  | "loadWorkerNeeds"
  | "decideWorkerRound"
  | "answerWorker"
  | "loadArtifacts"
  | "reviewArtifacts"
  | "loadNotices"
  | "loadEarlier"
  | "submit"
  | "newTask"
  | "replyToNotice"
  | "heartbeatTurn"
  | "setHome"
  | "openHome"
  | "steerQueued"
  | "rewind"
  | "cancelQueued"
>;

/** What every part of the store shares: the client, the page's state and the bookkeeping beside it. */
export interface StoreContext extends StoreOps, InstalledApi {
  readonly client: CanvasClient;
  readonly options: CanvasOptions;
  state: CanvasState;
  disposed: boolean;
  /** The last prompt's task, once it has finished: the task the next prompt continues. */
  settled: string | undefined;
  /** "New chat" was pressed: the next prompt starts a task of its own. */
  fresh: boolean;
  /** Home was opened before it has a task: the next prompt starts it, whatever chat the page last showed. */
  homeDraft: boolean;
  /** The chat on screen when it was: the side chat's parent, read only while `fresh`. */
  sideParent: string | undefined;
  /** The workspace has `chat.home` on. */
  homeOn: boolean;
  /** The notice New side chat replies to, read only while `fresh`. */
  sideNotice: ChatNotice | undefined;
  /** *New private chat*: the chat the next prompt starts is private, set when it is created or never. */
  freshPrivate: boolean;
  readonly recordReleased: Map<string, () => void>;
  readonly artifactLoads: Map<string, number>;
  readonly listeners: Set<() => void>;
  /** Each run's open stream, closed once the task ends. */
  readonly streams: Map<string, Subscription>;
  readonly restoredStreams: Set<Subscription>;
  /** Each task's conversation on the local connection, as its run's answer named it. */
  readonly conversations: Map<string, string>;
  /** Tasks read to be workers: never a side chat's parent. */
  readonly workers: Set<string>;
  /** Each task's prompts queued behind its turn, oldest first: entry ids. */
  readonly queuedPrompts: Map<string, string[]>;
  /** The uploaded files a message carries, by its entry's id: sent with it, whenever it goes. */
  readonly attachmentsOf: Map<string, readonly string[]>;
  /** Continuations whose reply is sent and whose turn has not spoken yet. */
  readonly turnPending: Set<string>;
  /** Entries whose last cursor was from before a reconnect: no continuation follows from it. */
  readonly placeLost: Set<string>;
  /**
   * Continuations following from the turn before's place, their prompt not
   * yet sent: a resync then says only that the owner no longer holds
   * what came between — the chat's lines go, and nothing else is wrong.
   */
  readonly resumingPlace: Set<string>;
  /** Continuations whose place's replay held another turn of the task: followed from now instead. */
  readonly foreignTurn: Set<string>;
  /**
   * Each pending continuation's watch (`watch`): its task, how many admissions
   * the task's record held before the reply — so a turn admitted since is
   * told from none — and the timer that reads the record next.
   */
  readonly watches: Map<string, { readonly taskId: string; readonly before: number; timer?: ReturnType<typeof setTimeout> }>;
  /** Continuations the watch gave up on: should their turn speak after all, the error is taken back. */
  readonly gaveUp: Set<string>;
  /**
   * Frames held while an entry's record is read back: a resync left the page
   * not knowing where the task stands, and what the read answers replaces the
   * entry's state wholesale. Applying a delta into a state about to be
   * replaced would fold it twice or lose it, so it waits.
   */
  readonly held: Map<string, ClientEvent[]>;
  /** How many record reads are in flight per entry: the frames are released when the last is through. */
  readonly reading: Map<string, number>;
  /** Tasks being replayed now (`restore`): one is not opened twice at once. */
  readonly reopening: Set<string>;
}

/** A store's context before its parts are installed: the state and bookkeeping, no operations yet. */
export function createStoreContext(client: CanvasClient, options: CanvasOptions): StoreContext {
  const fields: Omit<StoreContext, keyof StoreOps | keyof InstalledApi> = {
    client,
    options,
    state: { connection: client.state, runs: [], next: { kind: "new" } },
    disposed: false,
    settled: undefined,
    fresh: false,
    homeDraft: false,
    sideParent: undefined,
    homeOn: false,
    sideNotice: undefined,
    freshPrivate: false,
    recordReleased: new Map(),
    artifactLoads: new Map(),
    listeners: new Set(),
    streams: new Map(),
    restoredStreams: new Set(),
    conversations: new Map(),
    workers: new Set(),
    queuedPrompts: new Map(),
    attachmentsOf: new Map(),
    turnPending: new Set(),
    placeLost: new Set(),
    resumingPlace: new Set(),
    foreignTurn: new Set(),
    watches: new Map(),
    gaveUp: new Set(),
    held: new Map(),
    reading: new Map(),
    reopening: new Set(),
  };
  // Every operation is installed by its part (`createCanvasStore`) before the store is handed out.
  return fields as StoreContext;
}
