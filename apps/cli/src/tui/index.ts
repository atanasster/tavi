import { createReadStream, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

import {
  CLIENT_TIMEOUT,
  connectToOwner,
  initialRunState,
  isEventOrderError,
  isProtocolMismatch,
  turnEnded,
  reduceRun,
  type RunOptions,
  type Subscription,
  type TaviClient,
} from "@tavi/client/node";
import {
  ClientEventSchema,
  IPC_NOT_PENDING,
  redactCredentialShapes,
  TaviError,
  type AgentsListResult,
  type ApprovalScope,
  type ApprovalsListResult,
  type NeedsAnswer,
  NeedsAnswerSchema,
  type PendingQuestionRow,
  type ClientEvent,
  type RunResult,
  type SchedulesListResult,
  type SubscribeResult,
  TaskListResultSchema,
  TranscriptPageSchema,
  TaskLabelAnswerSchema,
  NoticeListResultSchema,
  MemoryCardAnswerSchema,
  memoryCardLine,
  memorySeenCount,
  memoryUsedCount,
  memoryUsedLine,
  MEMORY_USED_READS,
  MEMORY_USED_RETRY_MS,
  savedTurnAfter,
  type ChatNotice,
  type PluginCommandView,
  parsePluginCommandLine,
  FolderViewSchema,
} from "@tavi/contracts";
import { errorMessage, nowTimestamp } from "@tavi/contracts/util";
import { assertPipeOwnedHere, prefixedId, privacyProblem, sleep } from "@tavi/node-kit";
import { render, type Instance } from "ink";
import { createElement } from "react";

import type { ChatCommandOptions } from "./parse.js";
import {
  conversationOfRecorded,
  recordedStateOf,
  taintOfRecorded,
  type Ending,
  type RecordedState,
  type RecordedTask,
} from "../shared/recorded-task.js";
import { ChatApp, RESERVED_ROWS } from "./app.js";
import { roundCallIds } from "../shared/rounds.js";
import { chatCommand, commandHelp, type FolderChange, helpRows } from "./commands.js";
import { folderLines, hostPathOf } from "../features/folders/owner.js";
import { clientCwdFor, remoteFoldersOf } from "../features/remote/folders.js";
import { enterField, FORMS, formOutcome, formRequest, looksLikeCredential, openForm, type FormStep } from "./forms.js";
import {
  agentsPane,
  approvalsPane,
  chatsPane,
  needsPane,
  credentialsPane,
  pluginsPane,
  modelsPane,
  schedulesPane,
  type ConnectionSummary,
  type Pane,
} from "./panes.js";
import { ChatStore, FRAME_MS, MAX_FPS, pendingRoundsOf, plainEmphasis } from "./store.js";
import { GLYPHS, divider } from "./theme.js";

/**
 * `connectToOwner`, with the checks only Node's own kit can make on Windows:
 * the publication's access lists, and the pipe's owner before the cookie is sent.
 */
const connectOwnersPipe = (dataDirectory: string): Promise<TaviClient> =>
  connectToOwner(dataDirectory, { socket: { verify: assertPipeOwnedHere }, discovery: { privacyProblem } });

/**
 * `tavi chat`. Loaded by a dynamic `import()` from
 * `main.ts` for this command alone, so no other command pays for React, Ink
 * and Yoga's WebAssembly; `main.ts` sets `NODE_ENV=production` first, because
 * React picks its build when it is first imported and the development
 * reconciler retains memory for its profiling marks.
 */

export interface ChatStreams {
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
  readonly stderr: (text: string) => void;
}

export interface ChatExitCodes {
  readonly ok: number;
  readonly usage: number;
  readonly unavailable: number;
  readonly detached: number;
}

type ResolvedChat = ChatCommandOptions & { readonly dataDirectory: string };

/** What `--stats` records: enough to see whether rendering kept up without redrawing per event. */
export interface ChatStats {
  readonly events: number;
  readonly deltas: number;
  /** Times the store handed the tree a new view: React updates, at most one a frame. */
  readonly treeUpdates: number;
  /** Frames Ink drew. */
  readonly renders: number;
  readonly committedLines: number;
  readonly peakRssBytes: number;
  /**
   * The heap in use: what the session retained, when `collected`. A replay
   * measures it with the tree still mounted, after its last frame; a live
   * chat, on exit.
   */
  readonly heapUsedBytes: number;
  /** The heap was measured after a full collection (the process runs with `--expose-gc`). */
  readonly collected: boolean;
  /** The React reconciler that ran, read from the modules that loaded; `unknown` where they are not Node's. */
  readonly reactBuild: ReactBuild;
  readonly elapsedMs: number;
  readonly rows: number;
  readonly columns: number;
}

type ReactBuild = "production" | "development" | "unknown";

/**
 * Which React reconciler this process ran. `NODE_ENV` only says which was
 * asked for, when React was first imported; the reconciler's own module says
 * which executed (Node also lists the other, unexecuted, when it reads the
 * package's exports).
 */
function reactBuild(): ReactBuild {
  const ran = (build: string): boolean =>
    Object.entries(createRequire(import.meta.url).cache).some(
      ([path, module]) => module?.loaded === true && path.endsWith(`react-reconciler.${build}.js`),
    );
  if (ran("development")) return "development";
  return ran("production") ? "production" : "unknown";
}

/** The heap in use, after a full collection when the collector is exposed (`--expose-gc`). */
function heapInUse(): { readonly bytes: number; readonly collected: boolean } {
  // Garbage is not retention: with the collector exposed, measure what survives it.
  const collect = (globalThis as { gc?: () => void }).gc;
  collect?.();
  return { bytes: process.memoryUsage().heapUsed, collected: collect !== undefined };
}

/** Whether both streams are a terminal: `tavi chat` draws, it does not print a transcript. */
function isTerminal(streams: { readonly stdout: { readonly isTTY?: boolean }; readonly stdin: { readonly isTTY?: boolean } }): boolean {
  return streams.stdout.isTTY === true && streams.stdin.isTTY === true;
}

const NEEDS_TERMINAL = "tavi chat needs a terminal; use `tavi run` in scripts and pipelines\n";

/** A terminal dimension, or `fallback` while it is unknown (some report 0 as they start). */
const dimension = (value: number | undefined, fallback: number): number => (value !== undefined && value >= 1 ? value : fallback);

/** The deadline of each read chat makes of a task's record. */
const READ_TIMEOUT_MS = 10_000;

/** How long a recorded answer may take to resume its task before the question is offered again. */
const ANSWER_SETTLE_MS = 5_000;

/** The codes a task fails with that no further prompt can change: cancelled. A long chat rolls over instead of ending. */
const NOT_CONTINUED_CODES: ReadonlySet<string> = new Set(["CANCELLED", "TASK_CANCELLED"]);

/** The pending approval rows the approvals pane reads: 200 rows, however many rounds. */
const APPROVALS_PANE_LIMIT = 200;

/** The chats `/chats` lists, most recently touched first. */
const CHATS_PANE_LIMIT = 20;

/** A request that threw, as the refusal the handlers read. */
const failedOf = (error: unknown) => ({ ok: false as const, error: { code: "FAILED", message: errorMessage(error) } });

/**
 * A replay's pace: this many events a frame (about 7,500 a second), so Ink
 * draws the stream as it plays, as it would a live one, not once at the end.
 * It pauses `FRAME_MS` after each slice — the store's own flush interval, whose
 * timer was set first — so each slice is one tree update.
 */
const REPLAY_SLICE = 250;

/** What `runChat` reaches outside itself, so a test can put a scripted owner there. */
export interface ChatDeps {
  /** A connected client of the owner serving the directory; `connectToOwner`, its pipe checked, by default. */
  readonly connect?: (dataDirectory: string) => Promise<TaviClient>;
  /** How often a round a schedule's fire answers is checked for the fire's end; 3 s by default. */
  readonly probeMs?: number;
  /** How long a recorded answer may take to resume its task before the question is offered again; 5 s by default. */
  readonly answerSettleMs?: number;
  /** How often the chat shown's workers' open questions are read; 5 s by default. */
  readonly workerPollMs?: number;
}

/** How often the chat shown's workers' open questions are read. */
const WORKER_POLL_MS = 5_000;

/**
 * A notice as one line: its title, its summary on one line, and the
 * task it links to. A notice is never sent anywhere from here; a side chat
 * replies to one from the web app.
 */
export function noticeLine(notice: Pick<ChatNotice, "title" | "summary" | "sourceTaskId">): string {
  const summary = notice.summary
    .replace(/\s*\n\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();
  return `${GLYPHS.notice} ${notice.title}${summary === "" ? "" : ` — ${summary}`}${notice.sourceTaskId === undefined ? "" : ` (task ${notice.sourceTaskId})`}`;
}

/** A notice's identity as printed: a later settle of the same source is printed again. */
export const noticeSeenKey = (notice: Pick<ChatNotice, "noticeId" | "createdAt">): string => `${notice.noticeId}@${notice.createdAt}`;

/**
 * Which of a chat's listed notices to print now, learning every one
 * it is shown into `seen`. A notice already seen is skipped; one placed before
 * the saved page this chat printed (`afterSeq < pageFrom`) is older than what
 * is on screen and only learnt; on a chat's first read, one posted before the
 * chat was shown here (`since`) is only learnt — its saved page, if any,
 * printed it — and one posted since is printed (a new Home's "Earlier chats").
 */
export function freshNotices(
  notices: readonly ChatNotice[],
  watch: {
    readonly seen: Set<string>;
    readonly first: boolean;
    readonly since?: string | undefined;
    readonly pageFrom?: number | undefined;
  },
): readonly ChatNotice[] {
  const fresh: ChatNotice[] = [];
  for (const notice of notices) {
    const key = noticeSeenKey(notice);
    if (watch.seen.has(key)) continue;
    watch.seen.add(key);
    if (watch.pageFrom !== undefined && notice.afterSeq < watch.pageFrom) continue;
    if (watch.first && (watch.since === undefined || notice.createdAt < watch.since)) continue;
    fresh.push(notice);
  }
  return fresh;
}

/**
 * The options every `tavi chat` renders Ink with — exported so a test renders
 * the tree exactly as the command does.
 */
export function chatInkOptions(streams: Pick<ChatStreams, "stdout" | "stdin">, onRender: () => void) {
  return {
    stdout: streams.stdout,
    stdin: streams.stdin,
    // Both streams are terminals (checked first): drawn live even where `CI`
    // is set, which Ink otherwise takes to mean "print only the last frame".
    interactive: true,
    exitOnCtrlC: false,
    // Nothing in this process writes to the console; left unpatched, the
    // console stays the host's (a test runner replaces it with its own).
    patchConsole: false,
    incrementalRendering: true,
    maxFps: MAX_FPS,
    onRender,
  } as const;
}

export async function runChat(options: ResolvedChat, streams: ChatStreams, exit: ChatExitCodes, deps: ChatDeps = {}): Promise<number> {
  if (!isTerminal(streams)) {
    streams.stderr(NEEDS_TERMINAL);
    return exit.usage;
  }
  const columns = (): number => dimension(streams.stdout.columns, 80);
  const rows = (): number => dimension(streams.stdout.rows, 24);
  const store = new ChatStore({ columns, rows, reservedRows: RESERVED_ROWS, prompting: options.replay === undefined });
  const started = Date.now();
  let renders = 0;
  let deltas = 0;
  // Sampled only when asked for: `--stats` is a diagnostic, not a cost every chat pays.
  let peakRss = options.stats === undefined ? 0 : process.memoryUsage.rss();
  const sampler =
    options.stats === undefined
      ? undefined
      : setInterval(() => {
          peakRss = Math.max(peakRss, process.memoryUsage.rss());
        }, 25);
  /**
   * Each followed task's own workspace: its rounds, reviews and conversation
   * live there — `--attach` follows a task of any workspace, not only this
   * chat's. Learned from the task's `run.started`, or read from its record on
   * a late attach.
   */
  const taskWorkspaces = new Map<string, string>();
  const push = (event: ClientEvent): void => {
    if (event.kind === "text.delta") deltas += 1;
    if (event.kind === "run.started") taskWorkspaces.set(event.runId, event.workspaceId);
    store.push(event);
  };
  const inkOptions = chatInkOptions(streams, () => {
    renders += 1;
  });
  const finish = (code: number, heap = options.stats === undefined ? undefined : heapInUse()): number => {
    if (options.stats !== undefined && heap !== undefined) {
      const stats: ChatStats = {
        events: store.eventsReduced,
        deltas,
        treeUpdates: store.treeUpdates,
        renders,
        committedLines: store.linesCommitted,
        peakRssBytes: Math.max(peakRss, process.memoryUsage.rss()),
        heapUsedBytes: heap.bytes,
        collected: heap.collected,
        reactBuild: reactBuild(),
        elapsedMs: Date.now() - started,
        rows: rows(),
        columns: columns(),
      };
      writeFileSync(options.stats, `${JSON.stringify(stats)}\n`);
    }
    return code;
  };

  // The live rows are cut to the terminal's size as of the last flush: recut them now.
  const onResize = (): void => store.flush();
  let instance: Instance | undefined;
  let client: TaviClient | undefined;
  let stopWatching: (() => void) | undefined;
  let stopProbe: (() => void) | undefined;
  // The terminal closing (on Windows, its console window): the app is unmounted, so the way out below
  // restores the terminal, instead of the default action ending the process mid-frame. Before the app
  // is drawn there is nothing to restore: the process ends as it would have.
  const onHangup = (): void => {
    if (instance === undefined) process.exit(128 + 1);
    instance.unmount();
  };
  process.once("SIGHUP", onHangup);
  try {
    if (options.replay !== undefined) {
      let recording: Recording;
      try {
        recording = await readRecording(options.replay);
      } catch (error) {
        streams.stderr(`${errorMessage(error)}\n`);
        return finish(exit.usage);
      }
      instance = render(createElement(ChatApp, { store }), inkOptions);
      streams.stdout.on("resize", onResize);
      store.begin();
      let failure: unknown;
      try {
        let applied = 0;
        for await (const event of recording.events()) {
          push(event);
          applied += 1;
          if (applied % REPLAY_SLICE === 0) await sleep(FRAME_MS);
        }
      } catch (error) {
        // Checked whole before it played: only a file changed since can fail here.
        failure = error;
        store.finishWith(`${GLYPHS.failed} the recording changed while it played: ${errorMessage(error)}`, "failure");
      }
      store.end();
      store.flush();
      await sleep(100);
      // What the session holds while it is still drawn: the tree, Ink's output, the store.
      const heap = options.stats === undefined ? undefined : heapInUse();
      const exited = instance.waitUntilExit();
      instance.unmount();
      await exited;
      instance = undefined;
      if (failure !== undefined) {
        streams.stderr(`${options.replay} changed while it played: ${errorMessage(failure)}\n`);
        return finish(exit.usage, heap);
      }
      return finish(exit.ok, heap);
    }

    try {
      client = await (deps.connect ?? connectOwnersPipe)(options.dataDirectory);
    } catch (error) {
      streams.stderr(
        isProtocolMismatch(error)
          ? `${error.message}\n`
          : `No tavi owner is serving ${options.dataDirectory}: start \`tavi serve\` (${errorMessage(error)})\n`,
      );
      return finish(exit.unavailable);
    }
    const owner = client;
    /** Whether the owner has gone, said as what could not be done: an action checks it before it starts. */
    const ownerGone = (what: string): boolean => {
      if (owner.state !== "closed") return false;
      store.fail(`the owner is gone: ${what}`);
      return true;
    };

    /** The task this chat follows now: learnt from its stream, or named by `--attach`. */
    let current: string | undefined;
    /** The operation key of a run sent and not yet answered. */
    let dispatching: string | undefined;
    /**
     * `/side` (or `/new`) was typed: the next prompt starts a chat of its own
     * rather than continuing `settled` or going to Home.
     */
    // A draft is a new chat's first prompt: it never continues Home or another chat.
    let startFresh = options.memory !== undefined || options.draft !== undefined;
    /**
     * `--no-memory` or `--private`: the first chat this
     * session starts is made with its memory off, or private — never Home,
     * which `startFresh` keeps the first prompt from. Its side chats take it
     * from it; a chat started later is ordinary.
     */
    let newChatMemory = options.memory;
    /** Whether the working-folder note (why this terminal's directory is not a new chat's) was said already. */
    let folderNoted = false;
    /**
     * The chat `/side` left: the side chat's parent, which it
     * begins from and whose notes it reads. Absent — nothing shown, or `/new`
     * with Home off — the next prompt starts an ordinary chat.
     */
    let sideParent: string | undefined;
    /** The workspace has `chat.home` on: a prompt that continues nothing goes to the person's Home. */
    let homeOn = false;
    let pluginCommands: readonly PluginCommandView[] = [];
    /** Plugins' slash commands, as the owner lists them now; an owner without them lists none. */
    const readCommands = async (): Promise<void> => {
      const listed = await owner.request("plugin-commands", { action: "list" }, { timeoutMs: READ_TIMEOUT_MS }).catch(failedOf);
      pluginCommands = listed.ok
        ? ((listed.result as { readonly commands?: readonly PluginCommandView[] } | undefined)?.commands ?? [])
        : [];
    };
    /** The person's Home, once known: listed as the chat starts, or learnt from a message sent to Home. */
    let home: string | undefined;
    /** The task last seen to settle — on its stream or by its record — which the next prompt continues. */
    let settled: string | undefined;
    /** Prompts typed while a turn ran: sent in order, each once the turn before it ends — `side` when typed after `/side`. */
    const queuedPrompts: { readonly prompt: string; readonly side: boolean; readonly parent?: string }[] = [];
    /**
     * A continuation under way: its prompt's client-minted message id,
     * and whether the `reply` has gone to the owner — what a quit says of it.
     */
    let replying: { readonly taskId: string; readonly clientMessageId: string; sent: boolean } | undefined;
    /**
     * A continuation's reply is sent and its turn has not spoken yet: a resync
     * then reads a record from before the turn, which settles nothing.
     */
    let turnPending: string | undefined;
    /**
     * The generation of a continuation following from the turn before's
     * place, its prompt not yet sent: a resync then says only that the
     * owner no longer holds what came between — the lines it may have cleared
     * go, and nothing else is wrong. Held by generation, so a chat left
     * meanwhile (`/open`, `/home`) is not mistaken for it.
     */
    let resumingPlace: number | undefined;
    /** Whether that place's replay held another turn of the task: the continuation follows from now instead. */
    let foreignTurn = false;
    /** Tasks read to have no conversation here (not started by an IPC run): never continued, nor their questions answered. */
    const noConversation = new Set<string>();
    /** A continuation's watch on its turn (`continueTask`): read the record again soon — after a resync, say. */
    let watchTurn: (() => void) | undefined;
    /**
     * An attach's replay from the beginning (`--attach`): how many events it
     * holds, once the owner says, and how many have arrived. A task continued
     * before holds several turns: the stream is let go at a turn's end only
     * once the replay is through.
     */
    let replay: { expected: number | undefined; delivered: number } | undefined;
    /** Answers whose `reply` went unanswered, by task: the next answer to it is sent as the same message. */
    const unansweredAnswers = new Map<string, string>();
    /** The status line says where the next prompt goes: the chat shown, Home, or a chat of its own. */
    const offerContinuation = (): void => {
      const continues = settled !== undefined && !startFresh && !noConversation.has(settled);
      store.next(continues ? "continue" : startFresh ? (homeOn ? "side" : "new") : homeOn ? "home" : "new", homeOn);
    };
    let following: Subscription | undefined;
    /**
     * Bumped whenever the chat moves on to another stream: a callback of an
     * earlier one — its late events, its end, a read it started — is not heard.
     */
    let generation = 0;

    let reconnecting = false;
    stopWatching = owner.onState((state) => {
      if (state === "reconnecting") {
        reconnecting = true;
        store.notice("the owner went away; reconnecting");
      } else if (state === "ready" && reconnecting) {
        reconnecting = false;
        store.notice("reconnected");
        // A followed stream resumes (or resyncs), but no stream follows a chat
        // between turns: its plugins' lines may have been cleared meanwhile.
        // Nor is the place it stopped one a restarted owner knows.
        if (following === undefined) {
          store.clearPluginStatus();
          store.forgetPlace();
        }
        // The owner may have restarted with other plugins: their commands are read again.
        void readCommands();
      } else if (state === "closed") {
        // A form half filled can be sent nowhere now: closed, so the ending shows.
        if (store.formNow() !== undefined) store.form(undefined);
        // Refused, not gone: an owner of another version (found on a
        // reconnect, or by a frame this client cannot read), or one that broke
        // the protocol, says so rather than "did not come back".
        const failure = owner.failure;
        const violated = failure instanceof TaviError && failure.details?.["reason"] === "protocol-violation";
        if ((isProtocolMismatch(failure) || violated) && failure instanceof Error) {
          store.finishWith(`${GLYPHS.failed} ${failure.message}`, "failure");
          return;
        }
        const again =
          store.running && current !== undefined
            ? `, then \`tavi chat --attach ${current}\` to follow task ${current} again`
            : ", then `tavi chat` again";
        store.finishWith(`${GLYPHS.failed} the owner did not come back; start \`tavi serve\`${again}`, "failure");
      }
    });

    /** Remember a task's workspace from any record of it this chat reads. */
    const learnWorkspace = (taskId: string, recorded: unknown): string | undefined => {
      const workspaceId = (recorded as { readonly task?: { readonly workspaceId?: unknown } | null } | undefined)?.task?.workspaceId;
      if (typeof workspaceId !== "string") return undefined;
      taskWorkspaces.set(taskId, workspaceId);
      return workspaceId;
    };

    /**
     * How chat `taskId` is opened: a Home — this person's, or any task
     * whose record says `chatKind: "home"` — from its newest saved turns, since
     * the owner does not hold a chat that never ends from its start; any other
     * from its stream's beginning. The record decides when `home` was not found
     * (`findHome` reads nothing on a slow or failed read, or Home is off), so a
     * Home is never replayed as "joined late" with none of its turns shown.
     */
    /** Each chat's first prompt, read with its record when it is attached: the question shown above its replay. */
    const firstPrompts = new Map<string, string>();
    const attachMode = async (taskId: string): Promise<"saved" | "beginning"> => {
      if (taskId === home) return "saved";
      // A task that cannot be read now opens from its stream's beginning.
      const answer = await owner.request("tasks", { taskId }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => undefined);
      if (answer?.ok !== true) return "beginning";
      learnWorkspace(taskId, answer.result);
      const recorded = answer.result as
        | {
            readonly task?: { readonly chatKind?: unknown } | null;
            readonly admissions?: readonly { readonly intent?: { readonly prompt?: unknown } }[];
          }
        | undefined;
      // Its first prompt, shown above what its stream replays: the stream carries no prompt of its own.
      const first = recorded?.admissions?.[0]?.intent?.prompt;
      if (typeof first === "string" && first.trim() !== "") firstPrompts.set(taskId, first);
      return recorded?.task?.chatKind === "home" ? "saved" : "beginning";
    };

    /** A followed task's own workspace (see `taskWorkspaces`), this chat's when it cannot be read. */
    const workspaceOf = async (taskId: string): Promise<string> => {
      const known = taskWorkspaces.get(taskId);
      if (known !== undefined) return known;
      // A task that cannot be read now: this chat's own workspace stands in, and it is read again next time.
      const answer = await owner.request("tasks", { taskId }, { timeoutMs: READ_TIMEOUT_MS }).catch(() => undefined);
      const read = answer?.ok === true ? learnWorkspace(taskId, answer.result) : undefined;
      // A failed read is not remembered: the next decision reads the record again.
      return read ?? options.workspaceId;
    };

    /** What the stream cannot say — erased by a resync, or never held — the task's record does. */
    const settleFromRecord = (taskId: string, recorded: RecordedState, mine: number): void => {
      // The stream moved on while the record was read: it speaks for itself.
      const unsettled = store.status === "idle" || store.status === "unknown";
      if (mine !== generation || !unsettled) return;
      if (recorded.kind === "live") return;
      if (recorded.kind === "cancelled") {
        store.finishWith(`${GLYPHS.failed} task ${taskId} was cancelled.`, "failure");
        dropQueued();
        return;
      }
      const ending = recorded.ending;
      if (ending.kind === "approval") {
        void workspaceOf(taskId)
          .then((workspaceId) =>
            owner.request("approvals", { action: "list", taskId, workspaceId, limit: 1000 }, { timeoutMs: READ_TIMEOUT_MS }),
          )
          .then((listed) => {
            if (mine !== generation || !listed.ok) return;
            // The recorded calls fill in what the listing leaves out: each call's title, diff and reasons.
            const { rounds } = pendingRoundsOf(taskId, (listed.result as ApprovalsListResult).rows, ending.requests);
            if (rounds.length === 0) return;
            // Listed whole: the rows are the round's call set.
            for (const round of rounds) store.roundCalls(round.steps, new Set(round.requests.map((request) => request.callId)));
            store.seed({ pending: rounds });
          });
        return;
      }
      if (ending.kind === "waiting") {
        store.seed({ waiting: waitingOf(ending) });
        return;
      }
      if (ending.kind === "review") {
        store.seed({ review: { steps: ending.steps, requests: ending.requests } });
        return;
      }
      store.settleWith(recordedLine(ending, taskId === home));
      settled = taskId;
      shownSince(taskId);
      offerContinuation();
      sendQueued();
      if (!startFresh && !noConversation.has(taskId))
        store.notice(taskId === home ? "type to continue Home" : "type to continue this chat");
    };

    /** The oldest queued prompt, sent once the turn that just ended has let go of the screen. */
    let flushScheduled = false;
    const sendQueued = (): void => {
      // One ending is told twice — by the stream and by the record — and sends one prompt.
      if (flushScheduled) return;
      flushScheduled = true;
      setTimeout(() => {
        flushScheduled = false;
        if (store.running) return;
        const next = queuedPrompts.shift();
        if (next !== undefined) dispatchPrompt(next.prompt, next.side, next.parent);
      }, 0);
    };
    /** A task that takes no further turn: what was queued behind it is not sent. */
    const dropQueued = (): void => {
      if (queuedPrompts.length === 0) return;
      store.fail(`the chat was cancelled: ${queuedPrompts.length} queued prompt${queuedPrompts.length === 1 ? " was" : "s were"} not sent`);
      queuedPrompts.length = 0;
    };

    /** The chat whose notices were read last, and those already printed or known. */
    let noticeRoot: string | undefined;
    const noticeSeen = new Set<string>();
    let noticesUnsupported = false;
    let readingNotices = false;
    /** When each chat was first shown here, and the first saved turn its printed page held. */
    const noticeSince = new Map<string, string>();
    const noticePageFrom = new Map<string, number>();
    /** A chat is shown from `at` (a run's, from when its prompt was sent): notices posted since are new to the reader. */
    const shownSince = (taskId: string, at: string = nowTimestamp()): void => {
      if (!noticeSince.has(taskId)) noticeSince.set(taskId, at);
    };
    /**
     * A memory card's one line, read from the memory rows now:
     * the notice itself says only how many things it holds. An owner that
     * cannot render it gets the notice's own line.
     */
    const memoryNoticeLine = async (notice: ChatNotice, workspaceId: string | undefined): Promise<string> => {
      const answer = await owner
        .request(
          "memory",
          { action: "card", noticeId: notice.noticeId, ...(workspaceId === undefined ? {} : { workspaceId }) },
          { timeoutMs: READ_TIMEOUT_MS },
        )
        .catch(failedOf);
      const card = answer.ok ? MemoryCardAnswerSchema.safeParse(answer.result) : undefined;
      return card?.success === true ? memoryCardLine(card.data) : noticeLine(notice);
    };
    /**
     * What a turn that just ended here used, as one dim line: read from its saved turn, the
     * chat's first saved at or after its end (saved just after the end event), a few times while the owner
     * saves it. Nothing when it used none, or when the read fails.
     */
    const printMemoryUsed = async (taskId: string, endedAt: string, tries = 0): Promise<void> => {
      const after = Date.parse(endedAt);
      if (Number.isNaN(after) || owner.state !== "ready") return;
      const answer = await owner
        .request("tasks", { action: "transcript", taskId, workspaceId: await workspaceOf(taskId) }, { timeoutMs: READ_TIMEOUT_MS })
        .catch(failedOf);
      const page = answer.ok ? TranscriptPageSchema.safeParse(answer.result) : undefined;
      if (page === undefined || !page.success) return;
      const saved = savedTurnAfter(page.data.entries, endedAt);
      if (saved === undefined) {
        if (tries < MEMORY_USED_READS) setTimeout(() => void printMemoryUsed(taskId, endedAt, tries + 1), MEMORY_USED_RETRY_MS);
        return;
      }
      const used = saved.turn.memoryUsed;
      if (memorySeenCount(used) === 0) return;
      // Under the answer: its streamed text is committed first, or the line would print above it.
      store.flush();
      store.note(memoryUsedLine(memoryUsedCount(used), memoryUsedCount(used?.listed)), "tool");
    };
    /** The newest page of a chat's saved history, printed as its turns were; a failed read prints nothing. */
    const showSaved = async (taskId: string, mine: number): Promise<void> => {
      try {
        const answer = await owner.request(
          "tasks",
          { action: "transcript", taskId, workspaceId: await workspaceOf(taskId) },
          { timeoutMs: READ_TIMEOUT_MS },
        );
        const page = answer.ok ? TranscriptPageSchema.safeParse(answer.result) : undefined;
        // The chat moved on, or the task spoke, while it was read: old turns would print below newer ones.
        if (mine !== generation || (store.status !== "idle" && store.status !== "unknown")) return;
        if (page === undefined || !page.success || page.data.entries.length === 0) return;
        if (page.data.nextBefore !== undefined) store.notice("earlier turns are saved too: `tavi ui` pages back through them");
        // Notices among the turns, each after the turn it followed.
        const notices = [...(page.data.notices ?? [])];
        noticeRoot = taskId;
        if (page.data.entries[0] !== undefined)
          noticePageFrom.set(taskId, page.data.nextBefore === undefined ? 0 : page.data.entries[0].seq);
        // A memory card's line is read now: its text is the memory rows', never the notice's.
        const workspace = await workspaceOf(taskId);
        const cards = new Map(
          await Promise.all(
            notices
              .filter((notice) => notice.kind === "memory")
              .map(async (notice) => [notice.noticeId, await memoryNoticeLine(notice, workspace)] as const),
          ),
        );
        if (mine !== generation || (store.status !== "idle" && store.status !== "unknown")) return;
        const printNotices = (before: number): void => {
          while (notices[0] !== undefined && notices[0].afterSeq < before) {
            const notice = notices.shift() as ChatNotice;
            noticeSeen.add(noticeSeenKey(notice));
            store.note(cards.get(notice.noticeId) ?? noticeLine(notice), "notice");
          }
        };
        for (const saved of page.data.entries) {
          printNotices(saved.seq);
          if (saved.turn.prompt !== undefined) store.echo(`${saved.turn.prompt}`);
          for (const item of saved.turn.items) {
            // Saved text shows its emphasis as words, as the live stream does.
            if (item.kind === "text") store.note(plainEmphasis(item.text), "text");
            else if (item.kind === "question") store.note(`? ${item.text}`, "notice");
            else if (item.kind === "steer") store.echo(`${item.text} (sent into the turn)`);
            else store.note(`  ${item.toolName} ${item.status}${item.errorCode === undefined ? "" : ` (${item.errorCode})`}`, "notice");
          }
          // What the answer used, dim: `/why` names them.
          const used = saved.turn.memoryUsed;
          if (memorySeenCount(used) > 0) store.note(memoryUsedLine(memoryUsedCount(used), memoryUsedCount(used?.listed)), "tool");
        }
        printNotices(Number.POSITIVE_INFINITY);
        store.flush();
      } catch {
        // The record still says how the task ended.
      }
    };

    const readRecord = async (taskId: string, mine: number): Promise<RecordedState | undefined> => {
      const answer = await owner.request("tasks", { taskId }, { timeoutMs: READ_TIMEOUT_MS });
      if (answer.ok) learnWorkspace(taskId, answer.result);
      if (mine !== generation) return undefined;
      if (!answer.ok) {
        store.fail(`could not read task ${taskId}'s record: ${answer.error?.code}: ${answer.error?.message}`);
        return undefined;
      }
      store.setTaint(taskId, taintOfRecorded(answer.result as RecordedTask));
      // A private chat opened or attached here says so too.
      if ((answer.result as RecordedTask).task?.memoryMode === "private") store.markPrivate(taskId);
      return recordedStateOf(answer.result as RecordedTask);
    };
    /** The chip after a turn: the chat's label alone (`tasks { action: "label" }`). A failed read leaves the chip as it was. */
    const refreshTaint = async (taskId: string, mine: number): Promise<void> => {
      const answer = await owner
        .request("tasks", { action: "label", taskId, workspaceId: await workspaceOf(taskId) }, { timeoutMs: READ_TIMEOUT_MS })
        .catch(failedOf);
      const parsed = answer.ok ? TaskLabelAnswerSchema.safeParse(answer.result) : undefined;
      if (mine !== generation || parsed?.success !== true) return;
      store.setTaint(taskId, parsed.data.contextLabel ?? undefined);
      store.flush();
    };

    /** `/taint`: the chat shown's label, read again from the owner first, so it says what the chat read by now. */
    const showTaint = async (): Promise<void> => {
      const taskId = current ?? settled;
      if (taskId !== undefined) await refreshTaint(taskId, generation);
      store.note(store.taintDetails(taskId).join("\n"), "notice");
      store.flush();
    };

    /** Rounds already listed (`task:steps`), so each is listed once. */
    const listed = new Set<string>();
    /**
     * Task `taskId`'s conversation, when it has one here: the run this chat
     * started says it; an attached task's is its IPC start's operation key,
     * read off its record (a task another connection started has none here).
     * A record that could not be read says nothing either way.
     */
    const conversationOf = async (
      taskId: string,
    ): Promise<
      { readonly kind: "known"; readonly id: string } | { readonly kind: "none" } | { readonly kind: "unreadable"; readonly why: string }
    > => {
      const known = store.conversationOf(taskId);
      if (known !== undefined) return { kind: "known", id: known };
      if (noConversation.has(taskId)) return { kind: "none" };
      const answer = await owner.request("tasks", { taskId }, { timeoutMs: READ_TIMEOUT_MS }).catch(failedOf);
      if (!answer.ok)
        return { kind: "unreadable", why: `${answer.error?.code ?? "REFUSED"}: ${answer.error?.message ?? "the owner refused the read"}` };
      learnWorkspace(taskId, answer.result);
      const recorded = answer.result as RecordedTask;
      // A Home's conversation is the person's, not its first message's key.
      const conversationId = conversationOfRecorded(recorded);
      if (conversationId === undefined) {
        noConversation.add(taskId);
        offerContinuation();
        return { kind: "none" };
      }
      store.conversation(taskId, conversationId);
      return { kind: "known", id: conversationId };
    };
    /** The owner's pending rows for the round: its whole call set, which the keys wait for. */
    const listRound = (taskId: string, steps: number, mine: number): void => {
      void workspaceOf(taskId)
        .then((workspaceId) =>
          owner.request("approvals", { action: "list", taskId, workspaceId, limit: 1000 }, { timeoutMs: READ_TIMEOUT_MS }),
        )
        .then((answer) => {
          if (mine !== generation) return;
          if (!answer.ok) {
            store.fail(
              `could not list round ${steps}'s calls (${answer.error?.code}); decide it with \`tavi approvals approve|reject ${taskId}\``,
            );
            return;
          }
          store.roundCalls(steps, roundCallIds((answer.result as ApprovalsListResult).rows, steps));
        })
        .catch((error: unknown) => {
          if (mine === generation)
            store.fail(
              `could not list round ${steps}'s calls (${errorMessage(error)}); decide it with \`tavi approvals approve|reject ${taskId}\``,
            );
        });
    };

    /** Callbacks for one followed stream, of a generation of its own. */
    /**
     * A settled task says nothing more: followed on, an owner restart would
     * replay its resync into whatever this chat does next.
     */
    const letGo = (): void => {
      generation += 1;
      void following?.close();
      following = undefined;
    };

    const follow = (): RunOptions => {
      const mine = ++generation;
      return {
        onEvent: (event) => {
          if (mine !== generation) return;
          if (resumingPlace === mine) {
            if (event.kind === "resync.required") {
              resumingPlace = undefined;
              store.clearPluginStatus();
              return;
            }
            // Another turn of the task ran since the last one this chat saw — a
            // message from a channel into Home, a reminder, another front end:
            // it is not this prompt's, and is not drawn as if it were.
            if (!event.kind.startsWith("plugin.")) {
              foreignTurn = true;
              return;
            }
          }
          current = event.runId;
          const ends = event.kind === "task.completed" || event.kind === "task.failed" || event.kind === "task.stopped";
          // The continued turn has spoken: what the stream says now is of it. A plugin's line or notice from between the turns is not it.
          if (event.kind !== "resync.required" && !event.kind.startsWith("plugin.")) turnPending = undefined;
          if (replay !== undefined) replay.delivered += 1;
          // A turn after one that ended, in an attach's replay: a new
          // turn of the task, shown as one, and the task not offered while it goes.
          if (!ends && event.kind !== "resync.required" && !event.kind.startsWith("plugin.") && turnEnded(store.status)) {
            store.begin({ taskId: event.runId, continuing: true, roundsAnsweredBy: store.roundsAnsweredBy });
            if (settled === event.runId) settled = undefined;
            offerContinuation();
          }
          push(event);
          // A question on an attached task: its conversation is its IPC start's
          // operation key, read off its record — only for a task an IPC run
          // started (another chat's is answered there).
          if (event.kind === "task.waiting" && event.question !== undefined) void conversationOf(event.runId).catch(() => undefined);
          // A round this chat decides is offered once it is whole: list its calls, once.
          if (event.kind === "approval.required" && store.decidesRounds && !listed.has(`${event.runId}:${event.steps}`)) {
            listed.add(`${event.runId}:${event.steps}`);
            listRound(event.runId, event.steps, mine);
          }
          // Not while a continuation's turn has yet to speak: the record may
          // still show the turn before it; its watch reads it again, soon.
          if (event.kind === "resync.required") {
            if (turnPending === undefined) {
              void readRecord(event.runId, mine).then((recorded) => {
                if (recorded !== undefined) settleFromRecord(event.runId, recorded, mine);
              });
            } else watchTurn?.();
          }
          if (ends) {
            // What the answer used: not for a replayed turn, whose saved page already said it.
            if (replay === undefined) void printMemoryUsed(event.runId, event.at);
            // What the chat read now, for the status line's taint chip.
            void refreshTaint(event.runId, mine);
            // A cancelled task is not continued; a long one rolls over.
            const lasting = event.kind === "task.failed" && NOT_CONTINUED_CODES.has(event.errorCode);
            settled = lasting ? undefined : event.runId;
            offerContinuation();
            if (lasting) dropQueued();
            else sendQueued();
            // An attach's replay may hold later turns: let go only past its end.
            const more = replay !== undefined && (replay.expected === undefined || replay.delivered < replay.expected);
            if (!more) letGo();
          }
          if (replay !== undefined && replay.expected !== undefined && replay.delivered >= replay.expected) replay = undefined;
        },
        onEnd: (error) => {
          if (mine !== generation) return;
          if (error !== undefined) store.fail(errorMessage(error));
          store.end();
        },
      };
    };

    /**
     * Follow chat `taskId` and continue it. `beginning` (`--attach`, `/open`):
     * its stream replayed from the start, or its saved turns and record when
     * the owner holds none. `saved` (Home): a chat that never ends is
     * not replayed whole — its newest saved turns are printed and it is
     * followed live from now. The refusal's text when the owner will not follow it.
     */
    /** Counts what the chat goes to — a chat followed, a prompt sent — so an `/open` whose record is still being read when another comes is not followed. */
    let opening = 0;
    /** A chat opened whose record could not be read: it is not left "starting…" with every prompt queued behind nothing. */
    const endUnread = (mine: number): void => {
      if (mine === generation && store.status === "idle") store.end();
    };
    const attach = async (taskId: string, from: "beginning" | "saved"): Promise<string | undefined> => {
      opening += 1;
      current = taskId;
      shownSince(taskId);
      store.begin({ taskId });
      // A chat followed from its stream's beginning shows the question that began it, as Home's saved turns do.
      const first = from === "beginning" ? firstPrompts.get(taskId) : undefined;
      if (first !== undefined) store.echo(first);
      const callbacks = follow();
      const mine = generation;
      if (from === "saved") {
        const opened = await owner.subscribe(taskId, callbacks).catch(failedOf);
        if ("ok" in opened) return opened.error.message;
        if (!opened.response.ok) return opened.response.error?.message ?? "the owner refused to follow that chat";
        if (mine === generation) following = opened.subscription;
        else void opened.subscription?.close();
        const result = opened.response.result as SubscribeResult;
        store.answeredBy(result.roundsAnsweredBy, result.schedule);
        void showSaved(taskId, mine)
          .then(() => readRecord(taskId, mine))
          .then(async (recorded) => {
            // Unread: nothing to settle from, so the chat is not left "starting…" — a prompt still goes to Home.
            if (recorded === undefined) return endUnread(mine);
            if (recorded.kind === "live") {
              if (mine === generation && store.status === "idle")
                store.notice(`${taskId === home ? "Home" : `chat ${taskId}`} is taking a turn; following it live`);
              return;
            }
            // Its conversation first: a question it waits on is answered by typing.
            await conversationOf(taskId).catch(() => undefined);
            settleFromRecord(taskId, recorded, mine);
          })
          .catch(() => endUnread(mine));
        return undefined;
      }
      replay = { expected: undefined, delivered: 0 };
      const opened = await owner.subscribe(taskId, { from: "beginning", ...callbacks });
      if (!opened.response.ok) return opened.response.error?.message ?? "the owner refused to follow that chat";
      const result = opened.response.result as SubscribeResult;
      // A stream that settled at the end of its replay was let go already (`follow`).
      if (mine === generation) following = opened.subscription;
      else void opened.subscription?.close();
      if (replay !== undefined) {
        replay.expected = result.replayed;
        if (replay.delivered >= result.replayed) {
          replay = undefined;
          // Its last event, delivered before the owner said how many there were, ended the task.
          if (mine === generation && turnEnded(store.status)) letGo();
        }
      }
      store.answeredBy(result.roundsAnsweredBy, result.schedule);
      if (result.truncated) store.joinedLate();
      if (result.replayed === 0 && !result.resync) {
        // Nothing held: the task has published nothing yet, or its stream is gone.
        void readRecord(taskId, mine).then((recorded) => {
          if (recorded === undefined) return;
          if (recorded.kind === "live") {
            store.note(`The owner has published nothing of task ${taskId} yet; following it live.`, "notice");
            return;
          }
          store.note(
            `The owner holds no stream of task ${taskId}: it ended before this owner started, or its stream was evicted.`,
            "notice",
          );
          // Its saved history says what the stream no longer does.
          void showSaved(taskId, mine).finally(() => settleFromRecord(taskId, recorded, mine));
        });
      }
      return undefined;
    };

    /** The person's Home in this workspace, when they have one; undefined when it cannot be read. */
    const findHome = async (): Promise<string | undefined> => {
      const answer = await owner
        .request(
          "tasks",
          { action: "list", workspaceId: options.workspaceId, chatKinds: ["home"], principalId: options.principalId, limit: 1 },
          { timeoutMs: READ_TIMEOUT_MS },
        )
        .catch(failedOf);
      const listed = answer.ok ? TaskListResultSchema.safeParse(answer.result) : undefined;
      return listed?.success === true ? listed.data.rows.find((row) => row.workspaceId === options.workspaceId)?.taskId : undefined;
    };

    // `chat.home`: read once; a failed read is off, and the chat is what it was before Home.
    const settings = await owner
      .request("workspace-settings", { action: "get", workspaceId: options.workspaceId }, { timeoutMs: READ_TIMEOUT_MS })
      .catch(failedOf);
    homeOn =
      settings.ok &&
      (settings.result as { readonly effective?: { readonly homeChat?: unknown } } | undefined)?.effective?.homeChat === true;
    // Plugins' slash commands: read as the chat starts, and again on each reconnect.
    await readCommands();
    if (homeOn) home = await findHome();
    store.setHome(home);
    offerContinuation();

    if (options.attach !== undefined) {
      const refused = await attach(options.attach, await attachMode(options.attach));
      if (refused !== undefined) {
        streams.stderr(`${refused}\n`);
        return finish(exit.unavailable);
      }
    } else if (home !== undefined) {
      // `tavi chat` opens on Home: its newest turns, then type to continue it.
      const refused = await attach(home, "saved");
      if (refused !== undefined)
        store.finishWith(`${GLYPHS.failed} Home could not be followed: ${refused}; a message still goes to it`, "failure");
    }

    /**
     * An answer to the question the task waits on: `reply` into the
     * task's conversation on the local connection, with a client-minted
     * message id, so a resend is one message. The resumed turn arrives on the
     * stream this chat already follows.
     */
    const answerQuestion = (answer: { readonly taskId: string; readonly conversationId: string }, text: string): void => {
      const mine = generation;
      store.answering(true);
      store.echo(`${text}`);
      // A client-minted id, once: a resend of this message is the same message
      // — and so is the next answer after one the owner did not answer.
      const clientMessageId = unansweredAnswers.get(answer.taskId) ?? prefixedId("chat-reply");
      void workspaceOf(answer.taskId)
        .then(async (workspaceId) => {
          const payload = { workspaceId, conversationId: answer.conversationId, text, clientMessageId };
          const first = await owner.request("reply", payload).catch(failedOf);
          if (first.ok || first.error?.code !== CLIENT_TIMEOUT || mine !== generation) return first;
          store.notice("the owner has not answered yet; sending the answer again as the same message");
          return owner.request("reply", payload);
        })
        .catch(failedOf)
        .then((reply) => {
          if (mine !== generation) return;
          if (!reply.ok && reply.error?.code === CLIENT_TIMEOUT) {
            // Unknown, not refused: it may have been recorded. Answered again, it is this message still.
            unansweredAnswers.set(answer.taskId, clientMessageId);
            store.answering(false);
            store.fail(
              `The owner did not answer: the answer may have been recorded (message ${clientMessageId}); answering again sends it as the same message`,
            );
            return;
          }
          unansweredAnswers.delete(answer.taskId);
          if (reply.ok) {
            // Recorded: the resumed turn is on its way. Should the task still
            // wait on its question a while from now, the answer is offered
            // again rather than the prompt left locked.
            setTimeout(() => {
              if (mine !== generation || store.answerNow() !== undefined || store.status !== "waiting") return;
              store.answering(false);
              store.notice("the answer was recorded, but the chat has not resumed yet; you may answer again");
            }, deps.answerSettleMs ?? ANSWER_SETTLE_MS);
            return;
          }
          store.answering(false);
          // No such conversation: this task's questions are not answered here — nor is it continued.
          if (reply.error?.code === "NOT_FOUND") {
            store.forgetConversation(answer.taskId);
            noConversation.add(answer.taskId);
            offerContinuation();
          }
          store.fail(`The answer was not sent: ${reply.error?.code ?? "REFUSED"}: ${reply.error?.message ?? "the owner refused it"}`);
        });
    };

    /**
     * The chat shown's workers' open questions, as last read: asked
     * here, in the root chat — a worker is no chat — and answered at the
     * worker's wait, by its task, never as a turn of the root.
     */
    let workerQuestions: readonly PendingQuestionRow[] = [];
    /** The root they were read for, and the waits and handoffs already printed for it. */
    let workerRoot: string | undefined;
    const workerSeen = new Set<string>();
    /** The owner does not list a root's workers — it refused the root, or dropped it and listed the workspace — and none are read again. */
    let workersUnsupported = false;
    let readingWorkers = false;
    /** A read was asked for while one was in flight: read again once it ends, for what the first could not see. */
    let rereadWanted = false;
    /** Waits answered from here: left out of every read until one no longer lists them, so a read from before the answer cannot offer it again. */
    const answeredWaits = new Set<string>();
    /** The chat shown changed: its predecessor's workers are not this chat's. */
    const resetWorkers = (): void => {
      workerQuestions = [];
      workerRoot = undefined;
      workerSeen.clear();
      answeredWaits.clear();
    };
    /** The workers' questions of the chat shown now, and no other chat's. */
    const shownWorkers = (): readonly PendingQuestionRow[] =>
      workerRoot !== undefined && workerRoot === (current ?? settled) ? workerQuestions : [];
    const asker = (row: {
      readonly workerLabel?: string | undefined;
      readonly taskTitle?: string | undefined;
      readonly taskId: string;
    }): string => row.workerLabel ?? row.taskTitle ?? `worker ${row.taskId}`;
    /** How many questions are open in the chat shown: its own and its workers'. */
    const openQuestions = (): number => (store.answerNow() === undefined ? 0 : 1) + shownWorkers().length;
    const workerHint = (): string => {
      const count = openQuestions();
      return count === 1
        ? `${GLYPHS.more} type your answer`
        : `${GLYPHS.more} ${count} questions are open: /answer lists them, /answer <n> <text> answers one`;
    };
    /**
     * The chat shown's notices, read on the workers' cadence: they
     * arrive on no stream. The first read of a chat only learns what is there
     * (its saved page printed those it holds); later ones print what is new.
     */
    const readNotices = async (): Promise<void> => {
      const root = current ?? settled;
      if (root === undefined || noticesUnsupported || readingNotices || owner.state !== "ready") return;
      readingNotices = true;
      try {
        const answer = await owner
          .request(
            "tasks",
            { action: "notices", taskId: root, workspaceId: taskWorkspaces.get(root) ?? options.workspaceId },
            { timeoutMs: READ_TIMEOUT_MS },
          )
          .catch(failedOf);
        if ((current ?? settled) !== root) return;
        if (!answer.ok) {
          if (answer.error?.code === "INVALID_INPUT") noticesUnsupported = true;
          return;
        }
        const listed = NoticeListResultSchema.safeParse(answer.result);
        if (!listed.success) return;
        const first = noticeRoot !== root;
        if (first) noticeRoot = root;
        for (const notice of freshNotices(listed.data.notices, {
          seen: noticeSeen,
          first,
          since: noticeSince.get(root),
          pageFrom: noticePageFrom.get(root),
        })) {
          store.note(
            notice.kind === "memory" ? await memoryNoticeLine(notice, taskWorkspaces.get(root) ?? options.workspaceId) : noticeLine(notice),
            "notice",
          );
        }
      } finally {
        readingNotices = false;
      }
    };
    const readWorkers = async (): Promise<void> => {
      void readNotices();
      const root = current ?? settled;
      if (root === undefined || workersUnsupported || owner.state !== "ready") return;
      if (readingWorkers) {
        rereadWanted = true;
        return;
      }
      readingWorkers = true;
      rereadWanted = false;
      try {
        const answer = await owner
          .request(
            "approvals",
            { action: "needs", workspaceId: taskWorkspaces.get(root) ?? options.workspaceId, rootTaskId: root },
            { timeoutMs: READ_TIMEOUT_MS },
          )
          .catch(failedOf);
        if ((current ?? settled) !== root) return;
        if (!answer.ok) {
          if (answer.error?.code === "INVALID_INPUT") workersUnsupported = true;
          return;
        }
        const listed = NeedsAnswerSchema.safeParse(answer.result);
        if (!listed.success) return;
        // A root's listing always carries `handoffs`: without them the owner dropped the root and listed the whole workspace.
        if (listed.data.handoffs === undefined) {
          workersUnsupported = true;
          return;
        }
        if (workerRoot !== root) {
          resetWorkers();
          workerRoot = root;
        }
        // The root's own question is its stream's, never a worker's.
        const listedQuestions = listed.data.needs.flatMap((need) =>
          need.kind === "question" && need.question.taskId !== root ? [need.question] : [],
        );
        for (const waitId of [...answeredWaits]) if (!listedQuestions.some((row) => row.waitId === waitId)) answeredWaits.delete(waitId);
        workerQuestions = listedQuestions.filter((row) => !answeredWaits.has(row.waitId));
        const asked = workerQuestions.filter((row) => !workerSeen.has(row.waitId));
        for (const row of asked) {
          workerSeen.add(row.waitId);
          const choices = row.choices?.options.map((option, index) => `${index + 1}. ${option.label}`).join("  ");
          store.note(`? ${asker(row)} asks: ${row.question}${choices === undefined ? "" : `\n  ${choices}`}`, "notice");
        }
        for (const row of listed.data.handoffs.filter((handoff) => handoff.taskId !== root)) {
          if (workerSeen.has(row.waitId)) continue;
          workerSeen.add(row.waitId);
          store.note(
            `! ${asker(row)} needs you in its browser${row.handoff.instructions === undefined ? "" : `: ${row.handoff.instructions}`} — take control in the web app's chat`,
            "notice",
          );
        }
        if (asked.length > 0) store.note(workerHint(), "notice");
      } finally {
        readingWorkers = false;
        if (rereadWanted) void readWorkers();
      }
    };
    /** A worker's question answered here: at its wait. */
    const answerWorker = (row: PendingQuestionRow, text: string): void => {
      if (ownerGone("the answer was not sent")) return;
      workerQuestions = workerQuestions.filter((open) => open.waitId !== row.waitId);
      answeredWaits.add(row.waitId);
      store.echo(`${text} (to ${asker(row)})`, "text");
      void owner
        .request(
          "approvals",
          { action: "answer", workspaceId: row.workspaceId, taskId: row.taskId, answer: text, waitId: row.waitId },
          { timeoutMs: READ_TIMEOUT_MS },
        )
        .catch(failedOf)
        .then((answer) => {
          if (answer.ok) store.note(`${GLYPHS.done} answered ${asker(row)}'s question`, "notice");
          else {
            // Not recorded: offered again at the next read.
            answeredWaits.delete(row.waitId);
            store.fail(`The answer was not sent: ${answer.error?.code ?? "REFUSED"}: ${answer.error?.message ?? "the owner refused it"}`);
          }
          void readWorkers();
        });
    };
    /** `/answer [<n> <text>]`: the open questions, numbered — the chat's own first — or an answer to one of them. */
    const answerNumbered = (index: number | undefined, text: string | undefined): void => {
      const own = store.answerNow();
      const numbered: (
        | { readonly own: true; readonly question: NonNullable<typeof own> }
        | { readonly own: false; readonly row: PendingQuestionRow }
      )[] = [
        ...(own === undefined ? [] : [{ own: true as const, question: own }]),
        ...shownWorkers().map((row) => ({ own: false as const, row })),
      ];
      if (index === undefined) {
        store.note(
          numbered.length === 0
            ? `${GLYPHS.more} no question is open in this chat`
            : [
                divider("open questions"),
                ...numbered.map(
                  (entry, at) =>
                    `  ${at + 1}. ${entry.own ? "this chat's own question, shown above" : `${asker(entry.row)}: ${entry.row.question}`}`,
                ),
                "  /answer <n> <text> answers one",
              ].join("\n"),
          "text",
        );
        return;
      }
      const entry = numbered[index - 1];
      if (entry === undefined) {
        store.fail(`no open question ${index}: /answer lists them`);
        return;
      }
      if (text === undefined) {
        store.fail(`type the answer after its number: /answer ${index} <text>`);
        return;
      }
      if (entry.own) answerQuestion(entry.question, text);
      else answerWorker(entry.row, text);
    };

    /**
     * A status pane: read from the owner now and printed into
     * the transcript as a snapshot. Not bound to the stream the chat follows —
     * a pane asked for while a run goes is printed when its read answers.
     */
    const showPane = (pane: Pane): void => {
      if (ownerGone("no pane can be read")) return;
      const workspaceId = options.workspaceId;
      const followed = current;
      const read = (command: "agents" | "schedules" | "approvals" | "credentials" | "models", payload: Record<string, unknown>) =>
        owner.request(command, { action: "list", workspaceId, ...payload }, { timeoutMs: READ_TIMEOUT_MS }).catch(failedOf);
      /** Each pane's read, and how its answer is drawn. */
      const panes: Record<
        Pane,
        () => Promise<string[] | { readonly error?: { readonly code: string; readonly message: string } | undefined }>
      > = {
        agents: async () => {
          const answer = await read("agents", followed === undefined ? {} : { taskId: followed });
          // A task followed in another workspace (`--attach` names any): the
          // agents are still this workspace's, without its mailbox.
          if (!answer.ok && followed !== undefined && answer.error?.code === "NOT_FOUND") {
            const bare = await read("agents", {});
            return bare.ok ? agentsPane(bare.result as AgentsListResult, workspaceId, Date.now(), followed) : bare;
          }
          return answer.ok ? agentsPane(answer.result as AgentsListResult, workspaceId, Date.now()) : answer;
        },
        schedules: async () => {
          const answer = await read("schedules", {});
          return answer.ok ? schedulesPane(answer.result as SchedulesListResult, workspaceId, Date.now()) : answer;
        },
        plugins: async () => {
          // `plugins` is owner-wide: its list takes no workspace.
          const answer = await owner.request("plugins", { action: "list" }, { timeoutMs: READ_TIMEOUT_MS }).catch(failedOf);
          return answer.ok ? pluginsPane(answer.result as Parameters<typeof pluginsPane>[0]) : answer;
        },
        credentials: async () => {
          const answer = await read("credentials", {});
          return answer.ok ? credentialsPane(answer.result as Parameters<typeof credentialsPane>[0]) : answer;
        },
        models: async () => {
          const [connections, roles] = await Promise.all([read("models", {}), read("models", { action: "roles" })]);
          if (!connections.ok) return connections;
          if (!roles.ok) return roles;
          return modelsPane(connections.result as ConnectionSummary[], roles.result as Parameters<typeof modelsPane>[1], workspaceId);
        },
        needs: async () => {
          const answer = await owner.request("approvals", { action: "needs", workspaceId }, { timeoutMs: READ_TIMEOUT_MS }).catch(failedOf);
          return answer.ok ? needsPane(answer.result as NeedsAnswer, workspaceId, followed, Date.now()) : answer;
        },
        approvals: async () => {
          // Wide enough that a round is rarely cut; one that is, is left out.
          const answer = await read("approvals", { limit: APPROVALS_PANE_LIMIT });
          const where = followed === undefined ? undefined : { taskId: followed, decidedWhere: store.roundsDecidedWhere() };
          return answer.ok ? approvalsPane(answer.result as ApprovalsListResult, workspaceId, where, Date.now()) : answer;
        },
      };
      void panes[pane]().then((drawn) => {
        if (Array.isArray(drawn)) {
          store.note(drawn.join("\n"), "text");
          return;
        }
        store.fail(`/${pane}: ${drawn.error?.code ?? "REFUSED"}: ${drawn.error?.message ?? "the owner refused the read"}`);
      });
    };

    /**
     * A form's next step: its next field asked, or the form sent
     * — never echoing a secret — and what the owner did said.
     */
    const stepForm = (step: FormStep): void => {
      if (step.kind === "refused") {
        store.form(undefined);
        store.fail(step.reason);
        return;
      }
      if (step.kind === "ask") {
        store.form(step.state);
        return;
      }
      store.form(undefined);
      if (ownerGone("the form was not sent")) return;
      const request = formRequest(step.id, step.values, options.workspaceId);
      store.note(`${GLYPHS.form} ${FORMS[step.id].title}…`, "notice");
      void owner
        .request(request.command, request.payload, { timeoutMs: request.timeoutMs })
        .catch(failedOf)
        .then((answer) => {
          if (!answer.ok) {
            // The owner's refusal may quote what was sent: never a key's shape.
            const why = redactCredentialShapes(answer.error?.message ?? "the owner refused it");
            store.fail(`${FORMS[step.id].title}: ${answer.error?.code ?? "REFUSED"}: ${why}`);
            return;
          }
          store.note(formOutcome(step.id, step.values, answer.result).join("\n"), "text");
        });
    };
    const onForm = {
      enter: (typed: string): void => {
        const state = store.formNow();
        if (state === undefined) return;
        const step = enterField(state, typed);
        if (step.kind === "again") {
          // Said without what was typed: it may be a secret.
          store.fail(step.reason);
          return;
        }
        stepForm(step);
      },
      cancel: (): void => {
        const state = store.formNow();
        store.form(undefined);
        if (state !== undefined) store.notice(`${FORMS[state.id].title}: cancelled, nothing was sent`);
      },
    };

    /** `/name args` when `name` is a plugin's command; it is answered by the plugin, and nothing goes to the model. */
    const pluginCommandOf = (prompt: string): { readonly name: string; readonly args: string } | undefined => {
      const typed = parsePluginCommandLine(prompt);
      return typed !== undefined && pluginCommands.some((command) => command.name === typed.name) ? typed : undefined;
    };
    const runPluginCommand = (command: { readonly name: string; readonly args: string }): void => {
      void owner
        .request(
          "plugin-commands",
          {
            action: "run",
            workspaceId: options.workspaceId,
            name: command.name,
            args: command.args,
            ...(current === undefined ? {} : { taskId: current }),
          },
          { timeoutMs: READ_TIMEOUT_MS },
        )
        .catch(failedOf)
        .then((answer) => {
          const text = answer.ok ? (answer.result as { readonly text?: string } | undefined)?.text : undefined;
          if (text !== undefined) store.note(text === "" ? `/${command.name} answered nothing` : text, "notice");
          else store.fail(`/${command.name}: ${answer.ok ? "no answer" : (answer.error?.message ?? "the owner refused it")}`);
        });
    };

    const onSubmit = (prompt: string): void => {
      // A credential typed or pasted here goes nowhere — not to the model, not
      // into the transcript, not as an answer, not echoed by a command's
      // refusal: it has a form of its own. First, before anything shows it.
      if (looksLikeCredential(prompt)) {
        store.fail(
          "That looks like a credential, so it was not sent or shown. Store it with /credentials set <reference>, where its value is typed hidden.",
        );
        return;
      }
      // A plugin's command, before the chat's own refuse it as unknown.
      const pluginCommand = pluginCommandOf(prompt);
      if (pluginCommand !== undefined) {
        runPluginCommand(pluginCommand);
        return;
      }
      // A command is never a prompt, nor an answer.
      const command = chatCommand(prompt);
      if (command !== undefined) {
        if (command.kind === "help")
          store.note(
            [
              ...commandHelp(homeOn, columns()),
              ...(pluginCommands.length === 0
                ? []
                : [
                    divider("plugins' commands"),
                    ...pluginCommands.flatMap((entry) => helpRows(`/${entry.name}`, `${entry.description} (${entry.pluginId})`, columns())),
                  ]),
            ].join("\n"),
            "text",
          );
        else if (command.kind === "unknown") store.fail(`no command ${command.typed}: /help lists them`);
        else if (command.kind === "pane") showPane(command.pane);
        else if (command.kind === "side") side(command.topic);
        else if (command.kind === "new") {
          // With Home on, the same as `/side`; with Home off it starts a new chat.
          if (homeOn) store.notice("/new does what /side does");
          side(undefined, homeOn);
        } else if (command.kind === "home") goHome();
        else if (command.kind === "chats") showChats();
        else if (command.kind === "open") {
          if (command.taskId === undefined) store.fail("/open takes a chat's task id: /chats lists them");
          else open(command.taskId);
        } else if (command.kind === "answer") answerNumbered(command.index, command.text);
        else if (command.kind === "compact") freshContext();
        else if (command.kind === "taint") void showTaint();
        else if (command.kind === "model") chatModel(command.target);
        else if (command.kind === "folder") chatFolder(command.change);
        else if (command.kind === "steer") {
          if (command.text === undefined) store.fail("/steer takes the message to send into the running turn: /steer <text>");
          else steerTurn(command.text);
        } else if (!ownerGone("no form can be sent")) stepForm(openForm(command.form, command.words));
        return;
      }
      // A typed line answers a question only when exactly one is open: the chat's own, or a worker's.
      const answer = store.answerNow();
      const asking = openQuestions();
      const worker = shownWorkers()[0];
      if (asking === 1 && (answer !== undefined || worker !== undefined)) {
        if (answer !== undefined) answerQuestion(answer, prompt);
        else if (worker !== undefined) answerWorker(worker, prompt);
        return;
      }
      if (asking > 1) {
        store.notice(`${asking} questions are open, so this is a message, not an answer: /answer <n> <text> answers one`);
        // The chat waits on its own question: the message goes once its turn ends, never as that answer.
        if (answer !== undefined) {
          queuedPrompts.push({ prompt, side: false });
          store.notice("queued: sends after this turn");
          return;
        }
      }
      sendOrQueue(prompt);
    };

    /**
     * `/steer <text>`: sent into the turn that runs now, which reads it
     * before its next model call — the stream shows it there. With no turn
     * running it is a message as any other; a turn that ended before the owner
     * had it gets it as the chat's next turn, which the owner sends itself.
     */
    const steerTurn = (text: string): void => {
      const taskId = current;
      if (!store.running || taskId === undefined || owner.state === "closed") {
        sendOrQueue(text);
        return;
      }
      const mine = generation;
      const clientMessageId = prefixedId("chat-steer");
      void (async () => {
        const workspaceId = await workspaceOf(taskId);
        const payload = { workspaceId, taskId, text, clientMessageId, intent: "steer" as const };
        let reply = await owner.request("reply", payload).catch(failedOf);
        // The same message id is the same message: once more after a timeout.
        if (!reply.ok && reply.error?.code === CLIENT_TIMEOUT) reply = await owner.request("reply", payload).catch(failedOf);
        if (mine !== generation) return;
        if (!reply.ok) {
          store.fail(`not sent into the turn: ${reply.error?.code ?? "REFUSED"}: ${reply.error?.message ?? "the owner refused it"}`);
          return;
        }
        const steered = (reply.result as { readonly steered?: unknown } | undefined)?.steered === true;
        store.note(
          steered
            ? `${GLYPHS.more} sent into the running turn: it shows there once the model reads it`
            : `${GLYPHS.more} the turn had ended: sent as the chat's next message`,
          "notice",
        );
      })().catch((error: unknown) => store.fail(`not sent into the turn: ${errorMessage(error)}`));
    };

    /** A prompt sent now, or — while a turn runs — queued behind it, keeping whether `/side` came before it. */
    const sendOrQueue = (prompt: string): void => {
      if (store.running) {
        // Queued, not dropped: it goes once this turn ends.
        queuedPrompts.push({ prompt, side: startFresh, ...(startFresh && sideParent !== undefined ? { parent: sideParent } : {}) });
        startFresh = false;
        sideParent = undefined;
        offerContinuation();
        store.notice(`queued: sends after this turn${queuedPrompts.length > 1 ? ` (${queuedPrompts.length} waiting)` : ""}`);
        return;
      }
      dispatchPrompt(prompt);
    };

    /**
     * `/side [topic]`: the next prompt starts a side chat of the chat shown
     * — its parent, which it begins from — or, with none
     * shown, a chat of its own. With a topic, that topic is the prompt, sent
     * now. `/new` with Home off (`withParent` false) starts an ordinary chat.
     */
    const side = (topic?: string, withParent = true): void => {
      startFresh = true;
      sideParent = withParent ? (current ?? settled) : undefined;
      offerContinuation();
      if (topic !== undefined) {
        // A marker between the chat left and the side chat: what follows is not Home's.
        store.notice(homeOn ? "a side chat begins" : "a new chat begins");
        sendOrQueue(topic);
        return;
      }
      store.notice(homeOn ? "the next prompt starts a side chat" : "the next prompt starts a new chat");
    };

    /**
     * Leave the chat shown for another (`/home`, `/open`): its stream let go,
     * what was queued behind it dropped. A turn still going goes on at the owner.
     */
    const leave = (): void => {
      const going = store.running && current !== undefined && store.status === "running" ? current : undefined;
      const sending = dispatching !== undefined && current === undefined;
      letGo();
      resetWorkers();
      replying = undefined;
      turnPending = undefined;
      resumingPlace = undefined;
      watchTurn = undefined;
      dispatching = undefined;
      replay = undefined;
      settled = undefined;
      startFresh = false;
      sideParent = undefined;
      if (queuedPrompts.length > 0) {
        store.note(
          `${GLYPHS.more} ${queuedPrompts.length} queued prompt${queuedPrompts.length === 1 ? " was" : "s were"} not sent: they were for the chat left`,
          "notice",
        );
        queuedPrompts.length = 0;
      }
      if (going !== undefined) {
        store.note(
          going === home
            ? `${GLYPHS.more} Home goes on at the owner; /home follows it again`
            : `${GLYPHS.more} chat ${going} goes on at the owner; /open ${going} follows it again`,
          "notice",
        );
      } else if (sending) store.notice("the prompt just sent goes on at the owner; /chats lists it once it is admitted");
    };

    /** Follow chat `taskId` in place of the one shown, and continue it. */
    const open = (taskId: string): void => {
      if (ownerGone("no chat can be opened")) return;
      leave();
      offerContinuation();
      const mine = ++opening;
      void attachMode(taskId)
        // Another chat was opened, Home gone back to, or a prompt sent while the record was read: that one is followed.
        .then((mode) => (mine === opening ? attach(taskId, mode) : undefined))
        .catch((error: unknown) => errorMessage(error))
        .then((refused) => {
          if (refused !== undefined && current === taskId) store.finishWith(`${GLYPHS.failed} ${refused}`, "failure");
        });
    };

    /** `/home`: back to the person's Home, or — with none yet — the next message begins it. */
    const goHome = (): void => {
      if (!homeOn) {
        store.fail("Home is off in this workspace: `tavi config set chat.home on` turns it on");
        return;
      }
      if (ownerGone("Home cannot be opened")) return;
      if (home !== undefined && current === home) {
        startFresh = false;
        offerContinuation();
        store.notice("this is Home: type to continue it");
        return;
      }
      void (async () => {
        const found = home ?? (await findHome());
        if (found !== undefined) {
          home = found;
          store.setHome(home);
          open(found);
          return;
        }
        leave();
        current = undefined;
        // Nothing shown now: an empty chat, whose first message begins Home.
        store.begin();
        store.end();
        offerContinuation();
        store.notice("you have no Home yet: your next message begins it");
      })();
    };

    /**
     * `/compact`: Fresh context — the chat shown's next message starts
     * a new epoch, its earlier turns summarized and archived, whatever its
     * length. With no chat shown there is nothing to compact.
     */
    const freshContext = (): void => {
      const chat = current ?? settled;
      if (chat === undefined) {
        store.notice("no chat is shown: a new chat starts fresh anyway");
        return;
      }
      if (ownerGone("fresh context cannot be asked for")) return;
      void owner
        .request(
          "chat-context",
          { action: "compact", taskId: chat, workspaceId: taskWorkspaces.get(chat) ?? options.workspaceId },
          { timeoutMs: READ_TIMEOUT_MS },
        )
        .catch(failedOf)
        .then((answer) => {
          if (answer.ok)
            store.note(
              `${GLYPHS.more} fresh context: your next message starts a new epoch; earlier turns are summarized and archived${store.tainted ? ". It does not clear taint: /taint says what this chat read, and a fresh chat starts clean" : ""}`,
              "notice",
            );
          else store.fail(`fresh context was not set: ${answer.error?.message ?? "the owner refused"}`);
        });
    };

    /**
     * `/model`: the chat shown's own model, named — or, with one
     * given, run from the chat's next turn and made the default for new chats.
     * With no chat shown, the default is what the next new chat runs.
     */
    const chatModel = (target: { readonly connectionId: string; readonly model: string } | undefined): void => {
      if (ownerGone("no model can be read or set")) return;
      const chat = current ?? settled;
      const workspaceId = chat === undefined ? options.workspaceId : (taskWorkspaces.get(chat) ?? options.workspaceId);
      const label = (named: { readonly connectionId: string; readonly model: string }): string => `${named.connectionId}/${named.model}`;
      const ask = (payload: Record<string, unknown>) =>
        owner.request("models", { workspaceId, ...payload }, { timeoutMs: READ_TIMEOUT_MS }).catch(failedOf);
      void (async () => {
        if (target === undefined) {
          if (chat === undefined) {
            const roles = await ask({ action: "roles" });
            const active = (
              roles.ok
                ? (roles.result as { readonly activeTarget?: { readonly connectionId: string; readonly model: string } | null } | undefined)
                : undefined
            )?.activeTarget;
            store.note(
              roles.ok
                ? `${GLYPHS.more} ${homeOn && home === undefined ? "Home begins with your first message, and runs" : "no chat is shown: a new chat runs"} ${active === undefined || active === null ? "no configured model" : label(active)}`
                : `${GLYPHS.failed} the model could not be read: ${roles.error?.message ?? "the owner refused"}`,
              roles.ok ? "notice" : "failure",
            );
            return;
          }
          const read = await ask({ action: "chat", taskId: chat });
          const answer = read.ok
            ? (read.result as
                | {
                    readonly target: { readonly connectionId: string; readonly model: string } | null;
                    readonly source: "chosen" | "default";
                  }
                | undefined)
            : undefined;
          if (!read.ok || answer === undefined)
            store.fail(`this chat's model could not be read: ${read.error?.message ?? "the owner refused"}`);
          else if (answer.target === null)
            store.note(
              answer.source === "chosen"
                ? `${GLYPHS.failed} this chat's model is offered by no connection now: /model <connection> <model> picks another`
                : `${GLYPHS.more} this chat runs no configured model: /model <connection> <model> picks one`,
              answer.source === "chosen" ? "failure" : "notice",
            );
          else store.notice(`this chat runs ${label(answer.target)}${answer.source === "chosen" ? "" : ", the default"}`);
          return;
        }
        if (chat !== undefined) {
          const chosen = await ask({ action: "set-chat", taskId: chat, connectionId: target.connectionId, model: target.model });
          if (!chosen.ok) {
            store.fail(`this chat's model was not set: ${chosen.error?.message ?? "the owner refused"}`);
            return;
          }
        }
        const made = await ask({ action: "set-default", connectionId: target.connectionId, model: target.model });
        if (made.ok) {
          // Role main, or the flags the owner was started with, outrank the default just saved.
          const roles = await ask({ action: "roles" });
          const active = (
            roles.ok
              ? (roles.result as { readonly activeTarget?: { readonly connectionId: string; readonly model: string } | null } | undefined)
              : undefined
          )?.activeTarget;
          const outranked =
            active === undefined || active === null || label(active) === label(target)
              ? undefined
              : `${label(active)}, which role main or the owner's own flags choose`;
          if (chat === undefined)
            store.note(
              outranked === undefined
                ? `${GLYPHS.more} new chats run ${label(target)}`
                : `${GLYPHS.more} ${label(target)} is the default, but new chats run ${outranked}`,
              "notice",
            );
          else
            store.note(
              outranked === undefined
                ? `${GLYPHS.more} this chat and new chats run ${label(target)}`
                : `${GLYPHS.more} this chat runs ${label(target)}; new chats run ${outranked}`,
              "notice",
            );
        } else
          store.note(
            chat === undefined
              ? `${GLYPHS.failed} the default was not set: ${made.error?.message ?? "the owner refused"}`
              : `${GLYPHS.more} this chat runs ${label(target)}; it could not be made the default for new chats: ${made.error?.message ?? "the owner refused"}`,
            chat === undefined ? "failure" : "notice",
          );
      })();
    };

    /**
     * `/folder`: the chat shown's working folder — shown, or
     * changed from its next message. A path is this terminal's: `~`
     * and a relative path are resolved here (for an owner on another computer,
     * `~` is its home and a relative path is refused), and the owner checks it against
     * its `--fs-root` folders. `/folder reset` also recovers a folder that is
     * gone. Home's folder moves only by this.
     */
    const chatFolder = (change: FolderChange | undefined): void => {
      if (ownerGone("no folder can be read or set")) return;
      const chat = current ?? settled;
      if (chat === undefined) {
        store.notice(
          homeOn && home === undefined
            ? "Home begins with your first message: /folder then shows and changes its folder"
            : "no chat is shown: /folder shows and changes the folder of the chat shown",
        );
        return;
      }
      // A path for an owner on another computer is its own (`~` its home), and a relative one is refused here.
      let path: string | undefined;
      if (change?.kind === "set" || change?.kind === "add") {
        try {
          path = hostPathOf(change.path, undefined, undefined, remoteFoldersOf(options.dataDirectory));
        } catch (error) {
          store.notice(errorMessage(error));
          return;
        }
      }
      const action =
        change === undefined
          ? { action: "show" }
          : change.kind === "set"
            ? { action: "set", folder: { path } }
            : change.kind === "add"
              ? { action: "attach", folder: { path }, ...(change.rw ? { mode: "rw" } : {}) }
              : change.kind === "drop"
                ? { action: "detach", label: change.label }
                : { action: "reset" };
      void owner
        .request(
          "folder",
          { ...action, workspaceId: taskWorkspaces.get(chat) ?? options.workspaceId, taskId: chat },
          { timeoutMs: READ_TIMEOUT_MS },
        )
        .catch(failedOf)
        .then((answer) => {
          if (!answer.ok) {
            store.fail(
              `${change === undefined ? "this chat's folder could not be read" : "this chat's folder was not changed"}: ${answer.error?.message ?? "the owner refused"}`,
            );
            return;
          }
          const view = FolderViewSchema.safeParse(answer.result);
          if (!view.success) {
            store.fail("the owner's answer for this chat's folder could not be read");
            return;
          }
          store.note(folderLines(view.data, change !== undefined).join("\n"), view.data.unavailable === undefined ? "notice" : "failure");
        });
    };

    /** `/chats`: the recent chats, the person's Home first; workers are no chats. */
    const showChats = (): void => {
      if (ownerGone("no chat can be listed")) return;
      void owner
        .request(
          "tasks",
          { action: "list", workspaceId: options.workspaceId, chatKinds: ["home", "side", "run", "chat"], limit: CHATS_PANE_LIMIT },
          { timeoutMs: READ_TIMEOUT_MS },
        )
        .catch(failedOf)
        .then((answer) => {
          const listed = answer.ok ? TaskListResultSchema.safeParse(answer.result) : undefined;
          if (listed === undefined || !listed.success) {
            const why = answer.ok
              ? "the owner's answer could not be read"
              : `${answer.error?.code ?? "REFUSED"}: ${answer.error?.message ?? "the owner refused the read"}`;
            store.fail(`/chats: ${why}`);
            return;
          }
          store.note(
            chatsPane(listed.data, options.workspaceId, {
              principalId: options.principalId,
              homeOn,
              ...(current === undefined ? {} : { followed: current }),
            }).join("\n"),
            "text",
          );
        });
    };

    /**
     * A prompt sent now: it continues the settled chat, goes to Home, or
     * starts a chat of its own — a side chat of `/side`'s parent, when it had one.
     * `queuedSide` and `queuedParent` for a queued prompt: whether `/side` came before it, and from which chat.
     */
    const dispatchPrompt = (prompt: string, queuedSide?: boolean, queuedParent?: string): void => {
      if (ownerGone("start `tavi serve`, then `tavi chat` again")) return;
      // A settled chat goes on: the prompt continues it, as a reply into
      // its conversation, and the model sees what came before — unless `/side`
      // asked for a chat of its own, or the chat has no conversation to reply into.
      // A queued prompt carries its own: a `/side` typed after it is kept for the next prompt.
      const sideChat = queuedSide ?? startFresh;
      const parent = !sideChat ? undefined : queuedSide === undefined ? sideParent : queuedParent;
      if (queuedSide === undefined) {
        startFresh = false;
        sideParent = undefined;
      }
      offerContinuation();
      const previous = sideChat ? undefined : settled;
      if (previous !== undefined && !noConversation.has(previous)) {
        continueTask(previous, prompt);
        return;
      }
      // Nothing to continue: with Home on, the prompt is Home's — its next turn, or the message that begins it.
      startTask(prompt, false, homeOn && !sideChat ? "home" : undefined, parent);
    };

    /**
     * A prompt as a run: an IPC `run`, followed on its stream — a chat of its
     * own, or (`target: "home"`) the person's Home's next turn, or a side chat
     * of `parentChatId`. `echoed` when the transcript shows it already.
     */
    const startTask = (prompt: string, echoed = false, target?: "home", parentChatId?: string): void => {
      opening += 1;
      // Whatever stream came before is done with.
      void following?.close();
      following = undefined;
      current = undefined;
      settled = undefined;
      resetWorkers();
      offerContinuation();
      const operationKey = prefixedId("chat");
      dispatching = operationKey;
      // `--no-memory` / `--private` make the first chat this session starts (never Home); later ones are ordinary.
      const memory = target === undefined ? newChatMemory : undefined;
      if (target === undefined) newChatMemory = undefined;
      // A message to an existing Home is a turn of a task already begun: its stream starts mid-task.
      store.begin(target === "home" ? { continuing: true, ...(home === undefined ? {} : { taskId: home }) } : {});
      if (!echoed) store.echo(`${prompt}`);
      store.flush();
      const callbacks = follow();
      const mine = generation;
      // Notices posted from here on into the chat this prompt goes to are new to the reader (a new Home's "Earlier chats").
      const sentAt = nowTimestamp();
      const payload = {
        prompt,
        workspaceId: options.workspaceId,
        principal: options.principalId,
        operationKey,
        approval: "client" as const,
        ...(target === undefined ? {} : { target }),
        ...(target !== undefined || parentChatId === undefined ? {} : { parentChatId }),
        ...(memory === undefined ? {} : { memory }),
        // A chat this prompt starts may work in this terminal's directory, when the owner allows it;
        // Home never moves to it.
        ...(target === "home" ? {} : clientCwdFor(options.dataDirectory)),
      };
      // A refused or failed run made no chat: the next prompt starts the one `--no-memory` / `--private` asked for.
      const keepMemory = (): void => {
        if (memory === undefined) return;
        newChatMemory = memory;
        startFresh = true;
        offerContinuation();
      };
      // A run that timed out may have started: sent once more
      // under the same key, it rejoins that run rather than starting another.
      const dispatch = (attempt: number): void => {
        owner
          .run(payload, callbacks)
          .then(({ response, subscription }) => {
            if (mine !== generation) {
              if (dispatching === operationKey) dispatching = undefined;
              void subscription?.close();
              return;
            }
            if (!response.ok && response.error?.code === CLIENT_TIMEOUT && attempt === 1) {
              store.notice("the owner has not answered yet; asking again under the same key");
              dispatch(2);
              return;
            }
            if (dispatching === operationKey) dispatching = undefined;
            if (!response.ok) {
              store.finishWith(
                `${GLYPHS.failed} ${response.error?.code ?? "REFUSED"}: ${response.error?.message ?? "the owner refused the run"}`,
                "failure",
              );
              keepMemory();
              return;
            }
            following = subscription;
            if (subscription !== undefined) {
              current = subscription.taskId;
              shownSince(subscription.taskId, sentAt);
            }
            // The run's conversation: where its questions are answered.
            const run = response.result as RunResult | undefined;
            if (run?.conversationId !== undefined) store.conversation(run.taskId, run.conversationId);
            // One line when this terminal's directory was not used, and why.
            // Said once a session: every new chat's would be the same sentence.
            if (run?.folder?.note !== undefined && !folderNoted) {
              store.notice(`${run.folder.note}`);
              folderNoted = true;
            }
            if (target === "home" && run !== undefined) {
              home = run.taskId;
              store.setHome(home);
            }
            // The chat a `--private` prompt began, once the owner took it: its status line says private.
            if (memory === "private" && run !== undefined) store.markPrivate(run.taskId);
          })
          .catch((error: unknown) => {
            if (dispatching === operationKey) dispatching = undefined;
            if (mine !== generation) return;
            store.finishWith(`${GLYPHS.failed} ${errorMessage(error)}`, "failure");
            keepMemory();
          });
      };
      dispatch(1);
    };

    /**
     * A prompt that continues task `taskId`: its stream followed again
     * from now, then the prompt sent as a `reply` into the task's conversation
     * — which the owner admits as a new turn of the same task, its earlier
     * turns in the model's context, as the task's own principal. Sent under a
     * client-minted message id, so a resend is the same message.
     */
    const continueTask = (taskId: string, prompt: string): void => {
      void following?.close();
      following = undefined;
      const clientMessageId = prefixedId("chat");
      const sending = { taskId, clientMessageId, sent: false };
      replying = sending;
      // From where the turn before was last applied: a plugin's line cleared between the turns is seen.
      const resumeAt = store.resumeAt(taskId);
      store.begin({ taskId, continuing: true });
      store.echo(`${prompt}`);
      store.flush();
      const callbacks = follow();
      const mine = generation;
      const release = (): void => {
        if (replying === sending) replying = undefined;
      };
      /** Not continued: said, and the task stays the one the next prompt continues. */
      const stop = (text: string): void => {
        release();
        if (resumingPlace === mine) resumingPlace = undefined;
        if (mine !== generation) return;
        generation += 1;
        void following?.close();
        following = undefined;
        if (turnPending === clientMessageId) turnPending = undefined;
        store.finishWith(text, "failure");
        offerContinuation();
      };
      /** Nothing to reply into: said, and the prompt goes to Home, or starts a chat of its own. */
      const fallBack = (why: string): void => {
        release();
        if (mine !== generation) return;
        const toHome = homeOn && taskId !== home;
        store.notice(`chat ${taskId} ${why}: this prompt ${toHome ? "goes to Home" : "starts a new chat"}`);
        startTask(prompt, true, toHome ? "home" : undefined);
      };
      /** How many admissions the task's record held before the reply: a turn admitted since is this prompt's. */
      let before = 0;
      /** Whether the owner answered the reply; after a timeout, it may not have recorded it. */
      let recorded = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      /**
       * The reply is recorded (or may be): until its turn speaks, the task's
       * record is read every while — and again soon after a resync, or a read
       * that failed. A turn in flight is watched on; one admitted since the
       * reply that ended (an owner restart kept its events away) is read back;
       * none releases the prompt rather than leave it locked (the owner
       * answers `reply` once the message is recorded, before its turn is
       * admitted).
       */
      const settleLater = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (mine !== generation || turnPending !== clientMessageId) return;
          void owner
            .request("tasks", { taskId }, { timeoutMs: READ_TIMEOUT_MS })
            .catch(failedOf)
            .then((answer) => {
              if (mine !== generation || turnPending !== clientMessageId) return;
              if (!answer.ok) return settleLater();
              const record = answer.result as RecordedTask;
              const state = recordedStateOf(record);
              if (state.kind === "live") return settleLater();
              turnPending = undefined;
              if (watchTurn === settleLater) watchTurn = undefined;
              // Admitted, and ended while the stream could not say so: its ending, read back.
              if ((record.admissions ?? []).length > before) return settleFromRecord(taskId, state, mine);
              stop(
                `${GLYPHS.failed} the prompt ${recorded ? "was recorded" : "may have been recorded"} (message ${clientMessageId}), but task ${taskId} has not started its turn: ` +
                  `it may yet — \`tavi chat --attach ${taskId}\` follows it; \`tavi tasks ${taskId}\` shows it`,
              );
            });
        }, deps.answerSettleMs ?? ANSWER_SETTLE_MS);
      };
      void (async () => {
        const conversation = await conversationOf(taskId);
        if (mine !== generation) return release();
        if (conversation.kind === "unreadable")
          return stop(
            `${GLYPHS.failed} could not read task ${taskId}'s record (${conversation.why}): nothing was sent; type the prompt again`,
          );
        if (conversation.kind === "none") return fallBack("has no conversation here to continue");
        // From the turn before's last event, and before the reply is sent: a
        // settled task's stream holds only what plugins showed since, so every
        // event of the new turn arrives here and nothing of the earlier ones
        // is drawn again.
        resumingPlace = resumeAt === undefined ? undefined : mine;
        foreignTurn = false;
        // The place's subscription ends quietly once one from now replaces it: its end is not the turn's.
        let replaced = false;
        const placeCallbacks: RunOptions = {
          ...callbacks,
          onEnd: (error) => {
            if (!replaced) callbacks.onEnd?.(error);
          },
        };
        const opened = await owner.subscribe(taskId, { ...(resumeAt === undefined ? {} : { from: resumeAt }), ...placeCallbacks });
        if (mine !== generation) {
          void opened.subscription?.close();
          return release();
        }
        if (!opened.response.ok) {
          return stop(
            `${GLYPHS.failed} ${opened.response.error?.code ?? "REFUSED"}: ${opened.response.error?.message ?? "the owner refused to follow the chat"}; nothing was sent`,
          );
        }
        following = opened.subscription;
        /**
         * The place's replay held another turn: followed from now, as
         * before resuming places — what plugins showed stays applied. Answers
         * whether the continuation goes on.
         */
        const fromNowIfForeign = async (): Promise<boolean> => {
          if (!foreignTurn) return true;
          foreignTurn = false;
          resumingPlace = undefined;
          replaced = true;
          void following?.close();
          following = undefined;
          const again = await owner.subscribe(taskId, callbacks);
          if (mine !== generation) {
            void again.subscription?.close();
            release();
            return false;
          }
          if (!again.response.ok) {
            stop(
              `${GLYPHS.failed} ${again.response.error?.code ?? "REFUSED"}: ${again.response.error?.message ?? "the owner refused to follow the chat"}; nothing was sent`,
            );
            return false;
          }
          following = again.subscription;
          return true;
        };
        if (!(await fromNowIfForeign())) return;
        current = taskId;
        shownSince(taskId);
        const result = opened.response.result as SubscribeResult;
        store.answeredBy(result.roundsAnsweredBy, result.schedule);
        const workspaceId = await workspaceOf(taskId);
        if (mine !== generation) return release();
        // What the record holds before the reply: a turn admitted since is this one.
        const read = await owner.request("tasks", { taskId }, { timeoutMs: READ_TIMEOUT_MS }).catch(failedOf);
        if (mine !== generation) return release();
        if (!read.ok)
          return stop(
            `${GLYPHS.failed} could not read task ${taskId}'s record (${read.error?.code ?? "REFUSED"}: ${read.error?.message ?? "refused"}): nothing was sent; type the prompt again`,
          );
        before = ((read.result as RecordedTask).admissions ?? []).length;
        const payload = { workspaceId, conversationId: conversation.id, text: prompt, clientMessageId };
        if (!(await fromNowIfForeign())) return;
        sending.sent = true;
        resumingPlace = undefined;
        turnPending = clientMessageId;
        watchTurn = settleLater;
        let reply = await owner.request("reply", payload).catch(failedOf);
        // An answer that timed out may still have been recorded: sent once
        // more, the same message id is the same message, not a second one.
        if (!reply.ok && reply.error?.code === CLIENT_TIMEOUT && mine === generation) {
          store.notice("the owner has not answered yet; sending the prompt again as the same message");
          reply = await owner.request("reply", payload).catch(failedOf);
        }
        if (mine !== generation) return release();
        if (reply.ok) {
          release();
          settleLater();
          return;
        }
        if (reply.error?.code === CLIENT_TIMEOUT) {
          // Unknown, not refused: the stream stays followed, so a turn that does start shows.
          release();
          recorded = false;
          store.fail(
            `the owner did not answer: the prompt may have been recorded (message ${clientMessageId}); still following task ${taskId}`,
          );
          settleLater();
          return;
        }
        if (turnPending === clientMessageId) turnPending = undefined;
        if (watchTurn === settleLater) watchTurn = undefined;
        if (reply.error?.code === "NOT_FOUND") {
          // No such conversation on the local connection: as if it had none.
          store.forgetConversation(taskId);
          noConversation.add(taskId);
          return fallBack("has no conversation on this owner's local connection");
        }
        stop(
          `${GLYPHS.failed} the prompt was not sent: ${reply.error?.code ?? "REFUSED"}: ${reply.error?.message ?? "the owner refused it"}; type it again to send it to this chat`,
        );
      })().catch((error: unknown) => stop(`${GLYPHS.failed} ${errorMessage(error)}`));
    };

    /**
     * The round, decided whole: `approve` names the
     * round the chat showed (`expectedSteps`), so a round that moved on — or
     * was decided elsewhere first — is refused, never decided in its place.
     * The settlement arrives on the stream (`approval.settled`).
     */
    const onDecide = ({
      taskId,
      steps,
      approved,
      scope,
      note,
    }: {
      readonly taskId: string;
      readonly steps: number;
      readonly approved: boolean;
      readonly scope?: ApprovalScope;
      readonly note?: string;
    }): void => {
      const mine = generation;
      store.deciding(steps);
      void workspaceOf(taskId)
        .then((workspaceId) =>
          owner.request("approve", {
            taskId,
            workspaceId,
            expectedSteps: steps,
            verdict: approved ? "approve" : "reject",
            decidedBy: options.principalId,
            ...(approved && scope !== undefined && scope !== "once" ? { scope } : {}),
            ...(!approved && note !== undefined ? { note } : {}),
          }),
        )
        .catch(failedOf)
        .then((answer) => {
          if (mine !== generation || answer.ok) return;
          store.decisionAnswered(steps);
          const code = answer.error?.code ?? "REFUSED";
          const why = answer.error?.message ?? "the owner refused the decision";
          store.note(
            code === "CONFLICT" || code === IPC_NOT_PENDING
              ? `${GLYPHS.failed} Round ${steps} was not decided here: ${why}`
              : `${GLYPHS.failed} Round ${steps}: ${code}: ${why}`,
            "failure",
          );
        });
    };

    /** Esc: the turn the task is running stops (`stopped`); nothing is recorded. */
    const onAbort = (taskId: string): void => {
      const mine = generation;
      store.aborting(taskId);
      // Said now: the turn may end — and the stream move on — before the answer arrives.
      store.notice(`aborting task ${taskId}'s turn`);
      void owner
        .request("abort", { taskId })
        .catch(failedOf)
        .then((answer) => {
          if (mine !== generation || answer.ok) return;
          store.aborting(undefined);
          store.fail(`abort: ${answer.error?.message ?? answer.error?.code ?? "refused"}`);
        });
    };

    /**
     * The review, decided for every flagged artifact at once:
     * `review` with the round the chat showed (`expectedSteps`) and `resume`,
     * so the task goes on with what was released. Its resumed turn arrives on
     * the stream.
     */
    const onReview = (review: {
      readonly taskId: string;
      readonly steps: number;
      readonly artifactIds: readonly string[];
      readonly approved: boolean;
    }): void => {
      const mine = generation;
      store.reviewing(review.steps);
      // Said now: the resumed turn may run to its end before the answer arrives.
      store.notice(`${review.approved ? "releasing" : "rejecting"} the output, as ${options.principalId}, and resuming the chat`);
      void workspaceOf(review.taskId)
        .then((workspaceId) =>
          owner.request("review", {
            taskId: review.taskId,
            workspaceId,
            expectedSteps: review.steps,
            decisions: review.artifactIds.map((artifactId) => ({ artifactId, approved: review.approved })),
            reviewedBy: options.principalId,
            resume: true,
          }),
        )
        .catch(failedOf)
        .then((answer) => {
          if (mine !== generation || answer.ok) return;
          store.reviewRefused(review.steps);
          const code = answer.error?.code ?? "REFUSED";
          const why = answer.error?.message ?? "the owner refused it";
          store.note(
            code === CLIENT_TIMEOUT
              ? `${GLYPHS.failed} The owner did not answer the review in time: ${why}`
              : code === "CONFLICT" || code === IPC_NOT_PENDING
                ? `${GLYPHS.failed} The review was refused — part of it was decided elsewhere, or it is no longer pending: ${why}`
                : `${GLYPHS.failed} The owner refused the review: ${code}: ${why}`,
            "failure",
          );
          store.note(
            `  Decide what is left artifact by artifact: tavi artifacts approve|reject <artifact-id>, with --resume --connection <id> --model <id> on the last.`,
            "failure",
          );
        });
    };

    /**
     * A round or review a schedule's fire answers is shown read-only while the
     * fire runs — `approve` would refuse it — and becomes this chat's once the
     * fire ends. Nothing announces that, so while one is pending the chat asks
     * again who answers the task's rounds: a brief subscription from now, whose
     * answer is read and which is closed at once.
     */
    const probeEvery = deps.probeMs ?? 3_000;
    let probing = false;
    const probe = setInterval(() => {
      const taskId = current;
      // One at a time: a slow owner does not stack them up.
      if (probing || !store.awaitingOwner || store.schedule === undefined || taskId === undefined || owner.state !== "ready") return;
      probing = true;
      const mine = generation;
      void owner
        .subscribe(taskId, { onEvent: () => undefined })
        .then(({ response, subscription }) => {
          void subscription?.close();
          const answered = response.ok ? (response.result as SubscribeResult) : undefined;
          // Read again now: the fire may have decided it, or the chat moved on, while this was asked.
          const ended = store.schedule;
          if (mine !== generation || answered?.roundsAnsweredBy !== "client" || !store.awaitingOwner || ended === undefined) return;
          store.answeredBy("client");
          store.notice(`schedule ${ended.name}'s fire has ended: this chat may decide what it left pending`);
          const round = store.pendingRound;
          if (round !== undefined) listRound(taskId, round, mine);
        })
        .catch(() => undefined)
        .finally(() => {
          probing = false;
        });
    }, probeEvery);
    // The chat shown's workers' questions, read on a cadence: they arrive on no stream this chat follows.
    const workerPoll = setInterval(() => void readWorkers(), deps.workerPollMs ?? WORKER_POLL_MS);
    stopProbe = () => {
      clearInterval(probe);
      clearInterval(workerPoll);
    };

    instance = render(
      createElement(ChatApp, {
        store,
        onSubmit,
        onDecide,
        onAbort,
        onReview,
        onForm,
        pluginCommands: () => pluginCommands.map((command) => command.name),
        ...(options.draft === undefined ? {} : { draft: options.draft }),
      }),
      inkOptions,
    );
    streams.stdout.on("resize", onResize);
    await instance.waitUntilExit();
    instance = undefined;
    // Prompts typed behind a turn are this window's alone: leaving drops them, so the way out names them.
    if (store.running && queuedPrompts.length > 0) {
      const said = queuedPrompts
        .map((queued) => `“${queued.prompt.length > 60 ? `${queued.prompt.slice(0, 59)}…` : queued.prompt}”`)
        .join(", ");
      streams.stderr(`${queuedPrompts.length} queued prompt${queuedPrompts.length === 1 ? " was" : "s were"} not sent: ${said}\n`);
    }
    if (store.running && replying !== undefined) {
      const { taskId, clientMessageId, sent } = replying;
      if (!sent) {
        streams.stderr(`Quit before the prompt was sent: task ${taskId} was not continued.\n`);
        return finish(exit.ok);
      }
      streams.stderr(
        `Detached before the owner answered: the prompt may have been recorded (message ${clientMessageId}) and task ${taskId} continued; follow it with \`tavi chat --attach ${taskId}\`.\n`,
      );
      return finish(exit.detached);
    }
    if (store.running && current !== undefined) {
      streams.stderr(`Detached: the owner continues task ${current}; follow it again with \`tavi chat --attach ${current}\`\n`);
      return finish(exit.detached);
    }
    if (store.running && dispatching !== undefined) {
      streams.stderr(
        `Detached before the owner answered: it may still start this run (operation key ${dispatching}); \`tavi tasks\` lists it once admitted.\n`,
      );
      return finish(exit.detached);
    }
    return finish(exit.ok);
  } finally {
    process.off("SIGHUP", onHangup);
    streams.stdout.off("resize", onResize);
    if (sampler !== undefined) clearInterval(sampler);
    stopProbe?.();
    // Unsubscribed first: the client's own "closed" is not the owner going away.
    stopWatching?.();
    client?.close();
    instance?.unmount();
  }
}

function waitingOf(ending: Extract<Ending, { readonly kind: "waiting" }>): Omit<Extract<Ending, { readonly kind: "waiting" }>, "kind"> {
  const { kind: _kind, ...waiting } = ending;
  return waiting;
}

/** How a chat's recorded ending is said on reopening it: without its id (`/chats` lists ids); Home is never done, only ready. */
export function recordedLine(ending: Ending, home = false): string {
  // Home's last turn, done or failed, leaves it ready for the next message, as the chats list and the canvas say.
  if (home && (ending.kind === "completed" || ending.kind === "failed" || ending.kind === "stopped")) return `${GLYPHS.done} ready`;
  if (ending.kind === "completed") return `${GLYPHS.done} completed (recorded)`;
  if (ending.kind === "stopped") return `${ending.message} (recorded)`;
  if (ending.kind === "failed") return `${GLYPHS.failed} failed${ending.reason === undefined ? "" : `: ${ending.reason}`} (recorded)`;
  return `${ending.kind} (recorded)`;
}

/** A recorded stream, checked whole before it plays; read again as it plays, so no event is held. */
interface Recording {
  /** The events checked, and no more: lines written to the file since are not played. */
  events(): AsyncGenerator<ClientEvent>;
}

/** A recording's events, with the line each is on, up to `lastLine`. */
async function* recordedEvents(path: string, lastLine = Number.POSITIVE_INFINITY): AsyncGenerator<{ event: ClientEvent; line: number }> {
  const lines = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Number.POSITIVE_INFINITY });
  let number = 0;
  for await (const text of lines) {
    number += 1;
    if (number > lastLine) return;
    if (text.trim() === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${path}:${number} is not JSON`);
    }
    const parsed = ClientEventSchema.safeParse(json);
    if (!parsed.success) throw new Error(`${path}:${number} is not a client event: ${parsed.error.issues[0]?.message ?? ""}`);
    yield { event: parsed.data, line: number };
  }
}

/** A recorded `tavi run --format json` stream: one event per line, one task's, in its order. */
async function readRecording(path: string): Promise<Recording> {
  // Checked before anything is drawn: a stream the reducer refuses part-way is refused whole.
  let state = initialRunState();
  let lastLine = 0;
  for await (const { event, line } of recordedEvents(path)) {
    try {
      state = reduceRun(state, event);
    } catch (error) {
      if (isEventOrderError(error)) throw new Error(`${path}:${line} is not one task's stream in order: ${error.message}`);
      throw error;
    }
    lastLine = line;
  }
  return {
    events: async function* () {
      for await (const { event } of recordedEvents(path, lastLine)) yield event;
    },
  };
}

// The setup prompter renders with Ink too: one chunk holds the terminal UI, loaded only on demand.
export { createInkPrompter } from "../features/onboard/ink-prompter.js";
