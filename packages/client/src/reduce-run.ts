import {
  AGENT_TREE_LIMIT,
  TaviError,
  type ApprovalDisplay,
  type ApprovalProvenance,
  type ApprovalScope,
  type AskUserChoices,
  type BrowserHandoff,
  type ClientEvent,
  type ConnectRequest,
  type ConnectSettlement,
  type ExecutionMetrics,
  type GateVerdict,
  type IpcCursor,
  type ToolOutputRedactionKind,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

/**
 * The state of one task's stream as a front end shows it, and the
 * pure reducer that folds the task's events into it. No React: a TUI and a
 * browser both render from this.
 *
 * Identity follows the round, never an id a provider chooses alone. A model
 * call mints a new `attemptId`, and a provider may reuse its text-part and
 * tool-call ids on every call (`call_0` each turn), so text blocks and tool
 * cards are keyed by the attempt they belong to as well as by `blockId` and
 * `callId`. Pending approvals are keyed by the round `(taskId, steps)`,
 * and cleared by that round's `approval.settled`, whichever client
 * decided it.
 */

export type RunStatus =
  /** No event has said what the task is doing yet. */
  | "idle"
  | "running"
  | "awaiting_approval"
  | "waiting"
  | "review_required"
  | "completed"
  | "failed"
  /** The person stopped the turn: no failure, and a reply goes on in the same chat. */
  | "stopped"
  /**
   * After a `resync.required`: the events that said are gone. A task that is
   * running says again with its next event, but one suspended on a decision
   * publishes nothing until it is decided, so a front end fetches the
   * suspension (`approvals list --task`, `tasks <id>`) and applies it with
   * `seedSuspension`.
   */
  | "unknown";

export interface TextBlock {
  readonly kind: "text";
  readonly key: string;
  readonly attemptId: string;
  readonly blockId: string;
  readonly text: string;
  /**
   * The attempt that wrote it failed over: streamed, but not part of
   * the task's conversation. A front end shows it as discarded, or not at all.
   */
  readonly discarded?: true;
}

export interface ToolCard {
  readonly kind: "tool";
  readonly key: string;
  readonly attemptId: string;
  readonly callId: string;
  readonly toolName: string;
  /** The model that requested this call, when durable accounting identifies it. */
  readonly model?: string;
  /** Absent for a card first seen at its end (a late join). */
  readonly input?: unknown;
  /**
   * `interrupted`: it never finished in the attempt that started it — the task
   * suspended on it (`operator.ask_user`, `agents.wait`, a Connect card) and
   * has not run it again yet, or the task ended first. The resume's re-run
   * reopens this card rather than adding a second one.
   */
  readonly status: "running" | "completed" | "failed" | "interrupted";
  readonly output?: unknown;
  readonly errorCode?: string;
  readonly message?: string;
  readonly durationMs?: number;
  /** The credential shapes masked in `output`, by kind. */
  readonly redacted?: Readonly<Partial<Record<ToolOutputRedactionKind, number>>>;
}

/** Where a resume took over the task, or a model call failed over: the attempt before it ends here. */
export interface AttemptBoundary {
  readonly kind: "boundary";
  readonly key: string;
  readonly attemptId: string;
  readonly supersededAttemptId: string;
  readonly reason: string;
  /** A failover: the superseded attempt's text is discarded. */
  readonly discarded?: true;
}

/** A message the person sent into the running turn, where the model read it. */
export interface SteerEntry {
  readonly kind: "steer";
  readonly key: string;
  /** The reply's `clientMessageId`: the front end that sent it knows its message. */
  readonly messageId: string;
  readonly text: string;
}

export type TranscriptEntry = TextBlock | ToolCard | AttemptBoundary | SteerEntry;

export interface ApprovalRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly input: unknown;
  /** The row `approve` can address directly. */
  readonly approvalId: string;
  readonly effect?: string;
  /** The call's risk, what it does, and the scopes a decision may carry; absent from an older owner. */
  readonly risk?: GateVerdict["risk"];
  readonly display?: ApprovalDisplay;
  readonly allowedScopes?: readonly ApprovalScope[];
  /** The exact subjects a `session` or `always` decision's rule matches; empty or absent covers any call of the tool. */
  readonly subjects?: readonly string[];
  /** The tools a `session` or `always` decision covers as one permission (`browser.*`). */
  readonly scopeGroup?: string;
  /** Why it is asked, and from where; absent from an older owner. */
  readonly provenance?: ApprovalProvenance;
}

/** A round waiting on a decision: what `approve` names with `expectedSteps`. */
export interface PendingRound {
  readonly taskId: string;
  readonly steps: number;
  readonly requests: readonly ApprovalRequest[];
}

export interface SettledRound {
  readonly steps: number;
  readonly decisions: readonly { readonly callId: string; readonly approved: boolean }[];
  readonly decidedBy: string;
  /** When it was decided, as the event says. */
  readonly at: string;
}

/**
 * A question settled while this stream was watched: what was asked, and
 * how it ended — answered (with what, by whom, through what) or not. A front end
 * shows it as the question's receipt instead of letting the card vanish.
 */
export interface SettledWait {
  readonly waitId: string;
  readonly question?: string;
  readonly choices?: AskUserChoices;
  readonly outcome: Extract<ClientEvent, { kind: "wait.settled" }>["outcome"];
  readonly answers?: readonly string[];
  readonly replyText?: string;
  readonly decidedBy?: string;
  readonly via?: string;
  /** A browser handoff the person ended. */
  readonly handoff?: { readonly outcome: "done" | "failed"; readonly controlledMs: number };
  /** The handoff's ask, when this wait was one. */
  readonly handedOver?: true;
  /** A connect wait the account's sign-in or *Not now* ended. */
  readonly connect?: ConnectSettlement;
  readonly at: string;
}

/** A person's hold of the task's browser the task did not wait for: the transcript's receipt of it. */
export interface BrowserControlReceipt {
  readonly sessionId: string;
  readonly outcome: Extract<ClientEvent, { kind: "browser.controlled" }>["outcome"];
  readonly controlledMs: number;
  readonly note?: string;
  readonly at: string;
}

/** How many settled questions a stream keeps (and as many browser-control receipts). */
const SETTLED_WAIT_LIMIT = 20;

export interface RunState {
  readonly metrics?: ExecutionMetrics | undefined;
  /** The task the stream belongs to, from its first event. */
  readonly taskId: string | undefined;
  readonly threadId: string | undefined;
  readonly workspaceId: string | undefined;
  /** The last event applied: every later one must follow it directly. */
  readonly cursor: IpcCursor | undefined;
  /** The attempt the stream is carrying. */
  readonly attemptId: string | undefined;
  readonly status: RunStatus;
  /** Text, tool cards and resume boundaries, in the order they began. */
  readonly transcript: readonly TranscriptEntry[];
  /** Bounded discovery hints; the durable tree API remains authoritative. */
  readonly spawned: readonly Extract<ClientEvent, { kind: "task.spawned" }>[];
  /** Rounds waiting on a decision, by `steps`. */
  readonly pending: readonly PendingRound[];
  /** Rounds decided while this stream was watched, oldest first. */
  readonly settled: readonly SettledRound[];
  /** Set while the task waits on a reply, a worker or a deadline. */
  readonly waiting:
    | {
        readonly on: string;
        readonly deadlineAt: string;
        readonly question?: string;
        readonly choices?: AskUserChoices;
        /** Why it is asked. */
        readonly context?: string;
        /** A person is asked to act in the browser, from the live view. */
        readonly handoff?: BrowserHandoff;
        /** An app's account is to be signed in again, from Connected apps. */
        readonly connect?: ConnectRequest;
        /** From the `task.waiting` event; absent when a front end seeded the wait from the task's durable row. */
        readonly waitId?: string;
      }
    | undefined;
  /** Questions settled while this stream was watched, oldest first (bounded). */
  readonly settledWaits: readonly SettledWait[];
  /** A person's holds of the task's browser it did not wait for, oldest first (bounded). */
  readonly browserControls: readonly BrowserControlReceipt[];
  /** Set while the task waits on the review of archived output. */
  readonly review:
    | {
        readonly steps: number;
        readonly requests: readonly { readonly artifactId: string; readonly toolName: string; readonly callId: string }[];
      }
    | undefined;
  readonly outcome:
    | { readonly kind: "completed"; readonly finalText: string }
    | { readonly kind: "failed"; readonly errorCode: string; readonly message: string }
    /** The person stopped the turn: no failure, and a reply goes on. */
    | { readonly kind: "stopped"; readonly message: string }
    | undefined;
  /**
   * The transcript is missing its beginning: a `resync.required` said the
   * events before it cannot be replayed, or the caller joined late.
   * A front end says so on screen rather than presenting it as whole.
   */
  readonly truncated: boolean;
  /** Each plugin's status line for the task, by plugin id; a cleared one is absent. */
  readonly pluginStatus: Readonly<Record<string, string>>;
  /** Each plugin's published values for its canvas contribution, by plugin id and key. */
  readonly pluginState: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** What plugins suggest the person does next, from the newest turn's end; cleared when a turn starts. */
  readonly suggestions: readonly string[];
  /** Plugins' notices while this stream was watched, oldest first (bounded). */
  readonly pluginNotices: readonly { readonly pluginId: string; readonly text: string; readonly at: string }[];
  /** A turn of the stream read untrusted data: the canvas disarms a novel link in its answer. Sticky. */
  readonly tainted?: true;
  /** The URLs the tainted conversation holds, as last told: a link to exactly one of them is not novel. */
  readonly knownUrls?: readonly string[];
}

/** How many plugin notices a run keeps. */
export const PLUGIN_NOTICES_KEPT = 20;

/**
 * Before the first event. `truncated` when the caller already knows it joined
 * late (`SubscribeResult.truncated`); a first event other than `run.started`
 * says so on its own.
 */
export function initialRunState(options: { readonly taskId?: string; readonly truncated?: boolean } = {}): RunState {
  return {
    taskId: options.taskId,
    threadId: undefined,
    workspaceId: undefined,
    cursor: undefined,
    attemptId: undefined,
    status: "idle",
    transcript: [],
    spawned: [],
    pending: [],
    settled: [],
    settledWaits: [],
    browserControls: [],
    waiting: undefined,
    review: undefined,
    outcome: undefined,
    truncated: options.truncated ?? false,
    pluginStatus: {},
    pluginNotices: [],
    suggestions: [],
    pluginState: {},
  };
}

const EVENT_ORDER = "event-order";

/**
 * Whether `error` is the reducer's refusal of an event that does not follow
 * the state's cursor: the caller has lost events, or been handed another
 * task's. It resubscribes `from: resumeFrom(state)` — the last event
 * *applied* — into the same state, rather than rendering a gap. Not from the
 * client's cursor, which has already moved past the refused event, and never
 * `"beginning"` into the same state, which starts with a duplicate; a fresh
 * replay starts from `initialRunState()`.
 */
export function isEventOrderError(error: unknown): error is TaviError {
  return error instanceof TaviError && error.details?.["reason"] === EVENT_ORDER;
}

function orderError(message: string, event: ClientEvent, cursor: IpcCursor | undefined): TaviError {
  return new TaviError("CONFLICT", message, {
    details: {
      reason: EVENT_ORDER,
      received: { epoch: event.epoch, sequence: event.sequence, kind: event.kind },
      ...(cursor === undefined ? {} : { cursor }),
    },
  });
}

/**
 * Refuse an event that does not directly follow the last one applied.
 *
 * The first event may start anywhere: a subscription can open mid-stream.
 * After that, each event is the next sequence of the same epoch — a sequence
 * is monotonic per task across its admissions — except a `resync.required`,
 * which starts over (a new epoch, or a later position the owner could still
 * answer from) and is the only way a stream may jump.
 */
function assertFollows(state: RunState, event: ClientEvent): void {
  if (state.taskId !== undefined && event.runId !== state.taskId) {
    throw orderError(`an event of task ${event.runId} reached the stream of task ${state.taskId}`, event, state.cursor);
  }
  const cursor = state.cursor;
  if (cursor === undefined) return;
  if (event.kind === "resync.required") {
    if (event.epoch === cursor.epoch && event.sequence < cursor.sequence) {
      throw orderError(`a resync at sequence ${event.sequence} went back past ${cursor.sequence}`, event, cursor);
    }
    return;
  }
  if (event.epoch !== cursor.epoch) {
    throw orderError(`an event of epoch ${event.epoch} arrived without a resync after epoch ${cursor.epoch}`, event, cursor);
  }
  if (event.sequence !== cursor.sequence + 1) {
    throw orderError(`expected sequence ${cursor.sequence + 1}, received ${event.sequence}`, event, cursor);
  }
}

/** Where to (re)subscribe to continue `state`: after the last event it applied. */
export function resumeFrom(state: RunState): IpcCursor | "beginning" {
  return state.cursor ?? "beginning";
}

/**
 * Apply a suspension learned out of band — after a resync, or on a join after
 * the round was announced — as the events would have: its pending rounds, or
 * the wait or review it is suspended on.
 */
export function seedSuspension(
  state: RunState,
  suspension: {
    readonly pending?: readonly PendingRound[];
    readonly waiting?: NonNullable<RunState["waiting"]>;
    readonly review?: NonNullable<RunState["review"]>;
  },
): RunState {
  const pending = [...(suspension.pending ?? [])].sort((left, right) => left.steps - right.steps);
  const status: RunStatus =
    pending.length > 0
      ? "awaiting_approval"
      : suspension.review !== undefined
        ? "review_required"
        : suspension.waiting !== undefined
          ? "waiting"
          : state.status;
  return { ...state, pending, waiting: suspension.waiting, review: suspension.review, status };
}

/** Whether a turn in this status has ended, however it ended: nothing more comes of it, and the chat takes a reply. */
export function turnEnded(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

/** The entry `key` names, updated, or appended when there is none. */
function upsert(
  transcript: readonly TranscriptEntry[],
  key: string,
  update: (current: TranscriptEntry | undefined) => TranscriptEntry,
): readonly TranscriptEntry[] {
  // From the end: the entry an event continues is almost always the newest.
  const index = transcript.findLastIndex((entry) => entry.key === key);
  if (index === -1) return [...transcript, update(undefined)];
  const next = transcript.slice();
  next[index] = update(transcript[index]);
  return next;
}

/**
 * Cards still running whose attempt has ended, marked as never finishing: all
 * of them, or those of attempts other than `current` — one admission runs its
 * tools under one attempt, so activity under another means theirs is over.
 */
function interrupt(transcript: readonly TranscriptEntry[], current?: string): readonly TranscriptEntry[] {
  const ended = (entry: TranscriptEntry): boolean => entry.kind === "tool" && entry.status === "running" && entry.attemptId !== current;
  if (!transcript.some(ended)) return transcript;
  return transcript.map((entry) => (ended(entry) ? { ...entry, status: "interrupted" as const } : entry));
}

const textKey = (attemptId: string, blockId: string): string => `text:${attemptId}:${blockId}`;

/**
 * A tool card's key: its attempt and call, and — when that pair already has a
 * card — the event's position, so a call id reused within one attempt (a model
 * that emits no events of its own leaves its tools under the admission's
 * attempt) is a new card rather than an overwrite.
 */
function toolKey(transcript: readonly TranscriptEntry[], event: ClientEvent & { readonly callId: string }): string {
  const base = `tool:${event.attemptId}:${event.callId}`;
  return transcript.some((entry) => entry.key === base) ? `${base}@${event.epoch}:${event.sequence}` : base;
}

/** The newest card of `callId` in `attemptId` that is still running. */
function runningCard(transcript: readonly TranscriptEntry[], attemptId: string, callId: string): number {
  return transcript.findLastIndex(
    (entry) => entry.kind === "tool" && entry.attemptId === attemptId && entry.callId === callId && entry.status === "running",
  );
}

/**
 * The card a call that ran again after a wait continues: the newest card of
 * `callId` and the same tool, left interrupted, in `attemptId` or in the
 * attempt that `attemptId` resumed (a boundary since says so). A resume runs the suspended call again
 * from the top; it is the same call, so its row is reopened rather than drawn
 * twice (QA 2101). -1 when there is none.
 */
function rerunCard(transcript: readonly TranscriptEntry[], attemptId: string, callId: string, toolName: string): number {
  const index = transcript.findLastIndex((entry) => entry.kind === "tool" && entry.callId === callId);
  const card = transcript[index];
  if (card?.kind !== "tool" || card.status !== "interrupted" || card.toolName !== toolName) return -1;
  if (card.attemptId === attemptId) return index;
  const superseded = transcript
    .slice(index + 1)
    .some(
      (entry) =>
        entry.kind === "boundary" &&
        entry.discarded !== true &&
        entry.attemptId === attemptId &&
        entry.supersededAttemptId === card.attemptId,
    );
  return superseded ? index : -1;
}

/** The card a tool event continues: one still running, else an interrupted one it runs again; -1 for a new call. */
function continuedCard(
  transcript: readonly TranscriptEntry[],
  event: ClientEvent & { readonly callId: string; readonly toolName: string },
): number {
  const running = runningCard(transcript, event.attemptId, event.callId);
  return running === -1 ? rerunCard(transcript, event.attemptId, event.callId, event.toolName) : running;
}

/** `entries` with `index` replaced, or `entry` appended when `index` is -1. */
function place(entries: readonly TranscriptEntry[], index: number, entry: TranscriptEntry): readonly TranscriptEntry[] {
  if (index === -1) return [...entries, entry];
  const next = entries.slice();
  next[index] = entry;
  return next;
}

/** Activity means the task is running, whatever it was last said to be doing. */
const RUNNING: Pick<RunState, "status" | "waiting" | "review" | "outcome" | "metrics"> = {
  status: "running",
  metrics: undefined,
  waiting: undefined,
  review: undefined,
  outcome: undefined,
};

/** A tainted turn's event's taint, as `RunState` keeps it: an event without `knownUrls` keeps the ones before. */
function taintOf(event: Extract<ClientEvent, { kind: "text.delta" | "task.completed" }>): Pick<RunState, "tainted" | "knownUrls"> {
  if (event.tainted !== true) return {};
  return event.knownUrls === undefined ? { tainted: true } : { tainted: true, knownUrls: event.knownUrls };
}

/**
 * Apply one event. Pure: `state` is never modified, and a new state is
 * returned. Throws `isEventOrderError` for an event that does not follow the
 * last one applied.
 */
export function reduceRun(state: RunState, event: ClientEvent): RunState {
  assertFollows(state, event);
  const taskId = state.taskId ?? event.runId;
  const base: RunState = {
    ...state,
    taskId,
    cursor: { epoch: event.epoch, sequence: event.sequence },
    attemptId: event.attemptId,
    // Every task's stream begins with `run.started` in the epoch that created
    // it; a first event of any other kind means the beginning is missing.
    truncated: state.truncated || (state.cursor === undefined && event.kind !== "run.started"),
  };
  switch (event.kind) {
    case "run.started":
      // A turn that starts is past what the last one suggested.
      return { ...base, ...RUNNING, threadId: event.threadId, workspaceId: event.workspaceId, suggestions: [] };

    case "text.delta": {
      // The common case, once per streamed chunk: the block this continues is
      // the newest entry, of the attempt the stream already follows. Replaced
      // without the transcript scans below: that block's last delta already
      // interrupted every other attempt's cards, and since then nothing was
      // appended after it (it is still last), so no card can have started.
      const key = textKey(event.attemptId, event.blockId);
      const last = base.transcript.at(-1);
      if (state.attemptId === event.attemptId && last?.kind === "text" && last.key === key) {
        const transcript = base.transcript.slice();
        transcript[transcript.length - 1] = {
          kind: "text",
          key,
          attemptId: event.attemptId,
          blockId: event.blockId,
          text: last.text + event.text,
        };
        return { ...base, ...RUNNING, ...taintOf(event), transcript };
      }
      return {
        ...base,
        ...RUNNING,
        ...taintOf(event),
        transcript: upsert(interrupt(base.transcript, event.attemptId), textKey(event.attemptId, event.blockId), (current) => ({
          kind: "text",
          key: textKey(event.attemptId, event.blockId),
          attemptId: event.attemptId,
          blockId: event.blockId,
          text: (current?.kind === "text" ? current.text : "") + event.text,
        })),
      };
    }

    case "tool.started": {
      const transcript = interrupt(base.transcript, event.attemptId);
      const index = continuedCard(transcript, event);
      const current = transcript[index];
      return {
        ...base,
        ...RUNNING,
        transcript: place(transcript, index, {
          kind: "tool",
          key: current?.key ?? toolKey(transcript, event),
          attemptId: event.attemptId,
          callId: event.callId,
          toolName: event.toolName,
          input: event.input,
          status: "running",
        }),
      };
    }

    case "tool.completed":
    case "tool.failed": {
      const index = continuedCard(base.transcript, event);
      const current = base.transcript[index];
      return {
        ...base,
        ...RUNNING,
        // A card first seen at its end (a late join) is added without its input.
        transcript: place(base.transcript, index, {
          kind: "tool",
          key: current?.key ?? toolKey(base.transcript, event),
          attemptId: event.attemptId,
          callId: event.callId,
          toolName: event.toolName,
          ...(current?.kind === "tool" && current.input !== undefined ? { input: current.input } : {}),
          durationMs: event.durationMs,
          ...(event.kind === "tool.completed"
            ? { status: "completed" as const, output: event.output, ...(event.redacted === undefined ? {} : { redacted: event.redacted }) }
            : { status: "failed" as const, errorCode: event.errorCode, message: event.message }),
        }),
      };
    }

    case "approval.required": {
      const request: ApprovalRequest = {
        callId: event.callId,
        toolName: event.toolName,
        summary: event.summary,
        input: event.input,
        approvalId: event.approvalId,
        ...definedOnly({
          effect: event.effect,
          risk: event.risk,
          display: event.display,
          allowedScopes: event.allowedScopes,
          subjects: event.subjects,
          scopeGroup: event.scopeGroup,
          provenance: event.provenance,
        }),
      };
      const existing = base.pending.find((round) => round.steps === event.steps);
      const round: PendingRound = {
        taskId,
        steps: event.steps,
        // A call is named once per round; a repeat replaces it.
        requests: [...(existing?.requests ?? []).filter((known) => known.callId !== event.callId), request],
      };
      return {
        ...base,
        status: "awaiting_approval",
        waiting: undefined,
        review: undefined,
        outcome: undefined,
        // A task suspends on one round at a time and `steps` only grows: a
        // lower round still listed was decided without being announced.
        pending: [...base.pending.filter((known) => known.steps > event.steps), round].sort((left, right) => left.steps - right.steps),
      };
    }

    case "approval.settled": {
      const pending = base.pending.filter((round) => round.steps !== event.steps);
      return {
        ...base,
        // The turn goes on: what it suggested before is past.
        suggestions: [],
        pending,
        settled: [...base.settled, { steps: event.steps, decisions: event.decisions, decidedBy: event.decidedBy, at: event.at }],
        // Published when the resume that decided it is claimed: the task is
        // running again, whatever this stream last knew of it.
        status:
          pending.length === 0 && (base.status === "awaiting_approval" || base.status === "idle" || base.status === "unknown")
            ? "running"
            : base.status,
      };
    }

    case "attempt.replaced": {
      // A resume took the task over: whatever it was suspended on was
      // decided, answered or reached, including a round decided where no
      // `approval.settled` was announced. A failover is a boundary
      // mid-turn instead, whose superseded attempt's text is discarded.
      const kept = interrupt(base.transcript);
      const transcript =
        event.discarded === true
          ? kept.map((entry) =>
              entry.kind === "text" && entry.attemptId === event.supersededAttemptId ? { ...entry, discarded: true as const } : entry,
            )
          : kept;
      return {
        ...base,
        ...RUNNING,
        pending: [],
        transcript: [
          ...transcript,
          {
            kind: "boundary",
            key: `boundary:${event.epoch}:${event.sequence}`,
            attemptId: event.attemptId,
            supersededAttemptId: event.supersededAttemptId,
            reason: event.reason,
            ...(event.discarded === true ? { discarded: true as const } : {}),
          },
        ],
      };
    }

    case "task.spawned":
      return {
        ...base,
        spawned: [...base.spawned.filter((child) => child.childRunId !== event.childRunId), event].slice(-AGENT_TREE_LIMIT),
      };

    case "task.waiting":
      return {
        ...base,
        status: "waiting",
        waiting: {
          on: event.on,
          deadlineAt: event.deadlineAt,
          ...definedOnly({
            question: event.question,
            choices: event.choices,
            context: event.context,
            handoff: event.handoff,
            connect: event.connect,
          }),
          waitId: event.waitId,
        },
        review: undefined,
        outcome: undefined,
      };

    case "wait.settled": {
      // The wait this names. A wait a front end seeded from the task's durable
      // row has no id to compare, and is the one the task was suspended on.
      const asked =
        base.waiting !== undefined && (base.waiting.waitId === undefined || base.waiting.waitId === event.waitId)
          ? base.waiting
          : undefined;
      const receipt: SettledWait = {
        waitId: event.waitId,
        ...(asked?.question === undefined ? {} : { question: asked.question }),
        ...(asked?.choices === undefined ? {} : { choices: asked.choices }),
        outcome: event.outcome,
        ...definedOnly({
          answers: event.answers,
          replyText: event.replyText,
          decidedBy: event.decidedBy,
          via: event.via,
          handoff: event.handoff,
        }),
        ...(asked?.handoff === undefined ? {} : { handedOver: true as const }),
        ...(event.connect === undefined ? {} : { connect: event.connect }),
        at: event.at,
      };
      return {
        ...base,
        settledWaits: [...base.settledWaits.filter((wait) => wait.waitId !== event.waitId), receipt].slice(-SETTLED_WAIT_LIMIT),
        suggestions: [],
        ...(asked === undefined ? {} : { waiting: undefined, status: base.status === "waiting" ? ("running" as const) : base.status }),
      };
    }

    case "browser.controlled":
      // A note between turns: it changes neither the status nor the attempt the stream follows.
      return {
        ...base,
        attemptId: state.attemptId ?? event.attemptId,
        browserControls: [
          ...state.browserControls,
          {
            sessionId: event.sessionId,
            outcome: event.outcome,
            controlledMs: event.controlledMs,
            ...(event.replyText === undefined ? {} : { note: event.replyText }),
            at: event.at,
          },
        ].slice(-SETTLED_WAIT_LIMIT),
      };

    case "turn.steered":
      // Once per message: a model call retried after a crash may report it again.
      return {
        ...base,
        ...RUNNING,
        transcript: upsert(base.transcript, `steer:${event.messageId}`, () => ({
          kind: "steer",
          key: `steer:${event.messageId}`,
          messageId: event.messageId,
          text: event.text,
        })),
      };

    case "plugin.status": {
      // Neither entry nor progress: a plugin's own line beside the task's status.
      const { [event.pluginId]: _previous, ...others } = base.pluginStatus;
      return {
        ...base,
        pluginStatus: event.line === undefined || event.line === "" ? others : { ...others, [event.pluginId]: event.line },
      };
    }

    case "plugin.state":
      return {
        ...base,
        pluginState: { ...base.pluginState, [event.pluginId]: { ...base.pluginState[event.pluginId], [event.stateKey]: event.value } },
      };

    case "turn.suggested":
      return { ...base, suggestions: event.suggestions };

    case "plugin.notice":
      return {
        ...base,
        pluginNotices: [...base.pluginNotices, { pluginId: event.pluginId, text: event.notice, at: event.at }].slice(-PLUGIN_NOTICES_KEPT),
      };

    case "task.review_required":
      return {
        ...base,
        status: "review_required",
        review: { steps: event.steps, requests: event.requests },
        waiting: undefined,
        outcome: undefined,
      };

    case "task.completed":
      return {
        ...base,
        status: "completed",
        metrics: event.metrics,
        outcome: { kind: "completed", finalText: event.finalText },
        ...taintOf(event),
        transcript: interrupt(base.transcript),
        pending: [],
        waiting: undefined,
        review: undefined,
      };

    case "task.failed":
      return {
        ...base,
        status: "failed",
        metrics: event.metrics,
        outcome: { kind: "failed", errorCode: event.errorCode, message: event.message },
        transcript: interrupt(base.transcript),
        pending: [],
        waiting: undefined,
        review: undefined,
      };

    case "task.stopped":
      return {
        ...base,
        status: "stopped",
        metrics: event.metrics,
        outcome: { kind: "stopped", message: event.message },
        transcript: interrupt(base.transcript),
        pending: [],
        waiting: undefined,
        review: undefined,
      };

    case "resync.required":
      // A reset, never an entry: what the stream said before it
      // cannot be trusted to be current — a round may have been decided since —
      // and the events in between are gone.
      return {
        ...initialRunState({ truncated: true }),
        taskId: base.taskId,
        threadId: base.threadId,
        workspaceId: base.workspaceId,
        cursor: base.cursor,
        // The marker's attempt may be the bus's placeholder, not a real one.
        attemptId: undefined,
        status: "unknown",
      };

    default: {
      // A kind this client does not know (a newer protocol reaching an older
      // bundle) is refused here, not returned as `undefined` to fail later.
      const unknown: never = event;
      throw new TaviError("INVALID_INPUT", `unknown event kind ${(unknown as { kind: string }).kind}`);
    }
  }
}

/** Fold `events` into `state` (the initial state by default). */
export function replayRun(events: Iterable<ClientEvent>, state: RunState = initialRunState()): RunState {
  let current = state;
  for (const event of events) current = reduceRun(current, event);
  return current;
}
