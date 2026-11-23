import { initialRunState, reduceRun, seedSuspension, turnEnded, type RunState, type TranscriptEntry } from "@tavi/client";
import {
  PLAN_TOOL_ID,
  SESSIONS_SEARCH_TOOL_ID,
  SKILLS_PROPOSE_TOOL_ID,
  skillProposalNoticeLine,
  skillProposedOf,
  argOriginWords,
  displaySafe,
  printable,
  formatChoiceOption,
  maskedSecretsNote,
  flaggedReasons,
  neutralizedText,
  pastChatSearchCitations,
  provenanceChips,
  requestSources,
  requestTainted,
  taintChipText,
  taintDetailLines,
  whyAskedText,
  type LabelSummary,
  pastChatSearchSummary,
  planLines,
  toolGroupLabel,
  type ApprovalScope,
  type ClientEvent,
  type RoundAnswerer,
  type ScheduleFire,
  approvalTitleOf,
  isUnifiedDiff,
} from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { definedOnly } from "@tavi/contracts/util";
import stringWidth from "string-width";

import { formLines } from "../features/approvals/form.js";
import { fittedRow } from "../shared/terminal-text.js";
import { FORMS, fieldLabel, fieldOf, formTitle, type FormState } from "./forms.js";
import { GLYPHS, RULES, divider } from "./theme.js";

/**
 * The chat TUI's state, held above the React tree: every event is
 * reduced here as it arrives, and the tree hears of it at most once a frame.
 * Ten thousand text deltas are ten thousand reductions and a handful of
 * renders, not ten thousand reconciliations.
 *
 * Output is split the way Ink draws it. Finished lines — whole lines of text,
 * a tool's result, a resume boundary, a notice — are **committed**: appended
 * once to `<Static>`, which prints them above the live region and never
 * touches them again, so they become the terminal's own scrollback. Only the
 * line being written, a running tool, the status and the prompt stay live.
 *
 * Ink 7.1.1 clears the whole terminal, scrollback included (`ESC[3J`, issue
 * #990), when `shouldClearTerminalForFrame` holds: the previous frame was
 * taller than the viewport, or the next one is and a frame came before, or a
 * frame at the viewport's height shrinks. So the live region is capped twice:
 * at a few rows (`MAX_LIVE_ROWS`), and below the viewport less the status and
 * the prompt. A frame never grows to the viewport; only a terminal resized
 * below the frame already drawn (a few rows, by the cap) still clears.
 */

export type LineTone = "text" | "prompt" | "tool" | "failure" | "notice" | "divider";

export interface ChatLine {
  /** Stable and unique: `<Static>` keys its items by it. */
  readonly id: number;
  readonly text: string;
  readonly tone: LineTone;
}

/**
 * The committed lines, as `<Static>` reads them: a length, and the lines from
 * an index. A new view whenever lines are added — `<Static>` memoises on the
 * items' identity — backed by one array, so a frame costs the lines it adds,
 * not the whole transcript.
 */
export interface CommittedLines {
  readonly length: number;
  slice(start?: number, end?: number): ChatLine[];
}

export interface ChatView {
  readonly committed: CommittedLines;
  /** The live rows: the unfinished line's tail and running tools, within the budget. */
  readonly live: readonly string[];
  /** One short row: what the task is doing. Anything longer is committed as a notice. */
  readonly status: string;
  /** A run is in flight: Ctrl-C then detaches from it rather than simply quitting. */
  readonly running: boolean;
  /**
   * The round this chat may decide now, with one key for the whole round
   * (`y`, `s`, `a`, `n`, `N`): absent while none is pending, while the owner
   * answers the task's rounds itself, while a decision is on its way, and in
   * a replay.
   */
  readonly decision?: {
    readonly taskId: string;
    readonly steps: number;
    /** The scopes every call of the round offers: `s` and `a` answer only these. */
    readonly scopes: readonly ApprovalScope[];
    /** The tools every call of the round is decided as (`browser.*`), when they share one. */
    readonly scopeGroup?: string;
    /** The hosts the round's calls open (`display.host`): what a grouped browser decision allows. */
    readonly scopeHosts?: readonly string[];
  };
  /** The task has a turn running this chat may abort (Esc). */
  readonly abortable?: { readonly taskId: string };
  /**
   * The review this chat may decide now, for every flagged artifact at once:
   * `y` releases them and resumes the task, `n` rejects them.
   */
  readonly review?: { readonly taskId: string; readonly steps: number; readonly artifactIds: readonly string[] };
  /**
   * The question the task waits on, which this chat may answer by typing:
   * the task's conversation is known, and what is typed goes to
   * it as a `reply` rather than starting a run.
   */
  readonly answer?: { readonly taskId: string; readonly conversationId: string };
  /**
   * The form being filled: the prompt row takes its field —
   * masked when `secret` — and every key is the form's until it is sent or
   * Esc cancels it.
   */
  readonly form?: { readonly label: string; readonly secret: boolean };
}

export interface ChatStoreOptions {
  /** The terminal's width, read at each flush (a resize takes effect on the next). */
  readonly columns: () => number;
  /** The terminal's height, likewise. */
  readonly rows: () => number;
  /** Rows the tree draws below the live rows: the status and the prompt. */
  readonly reservedRows: number;
  /** How often the tree may hear of a change: `FRAME_MS` by default, Ink's own frame. */
  readonly frameMs?: number;
  /** Must call back asynchronously: the store relies on the returned canceller existing first. */
  readonly schedule?: (callback: () => void, ms: number) => () => void;
  /** Whether the operator can type a prompt; the status says what to do next. Default true. */
  readonly prompting?: boolean;
  /** The words of the workspace's language; English until `words` says otherwise. */
  readonly words?: CoreT;
}

/** Ink draws at most this many frames a second (its default, set explicitly), and the tree hears of a change at most once a frame. */
export const MAX_FPS = 30;
export const FRAME_MS = Math.ceil(1000 / MAX_FPS);

/** The live region's own cap: a terminal shrunk by less than this never clears (see the header). */
export const MAX_LIVE_ROWS = 6;
/** The fewest columns a cut status row keeps for the chat's state before its private and taint marks. */
const MIN_STATE_COLUMNS = 12;
/** How many lines of a file change's diff an approval round prints. */
const TERMINAL_DIFF_LINES = 20;

/** Rows the live region may take: within its cap, and so that the whole frame stays under the viewport. */
export function liveRowBudget(rows: number, reservedRows: number): number {
  // One row of slack: Ink clears once a frame's height *reaches* the viewport.
  return Math.max(0, Math.min(MAX_LIVE_ROWS, rows - reservedRows - 1));
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `text` cut into rows of at most `width` terminal columns: by grapheme, and
 * by display width, so a wide character or an emoji counts as two columns and
 * a combined sequence is never split.
 */
export function wrapRows(text: string, width: number, measure: (segment: string) => number = stringWidth): string[] {
  const limit = Math.max(1, width);
  const rows: string[] = [];
  let row = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const columns = Math.max(0, measure(segment));
    if (used + columns > limit && row !== "") {
      rows.push(row);
      row = "";
      used = 0;
    }
    row += segment;
    used += columns;
  }
  rows.push(row);
  return rows;
}

/**
 * The width to lay a committed line out at when Ink's word wrap would break a
 * word inside it — a path, a URL, a command longer than the terminal: its
 * longest row, so the terminal soft-wraps it and it copies whole. Undefined
 * for a line whose every word fits, which Ink wraps by words as usual.
 */
export function unbrokenWidth(text: string, columns: number, measure: (segment: string) => number = stringWidth): number | undefined {
  const rows = text.split("\n");
  if (!rows.some((row) => row.split(/\s+/).some((word) => measure(word) > columns))) return undefined;
  return Math.max(...rows.map((row) => measure(row)));
}

/**
 * A copy of `text` that keeps nothing else alive. In V8 a substring of 13
 * characters or more is a view of the string it was cut from — here the whole
 * transcript as it stood at the cut — and a committed line lives as long as
 * the session, so each would pin a copy of the transcript (187 MiB after
 * 100,000 deltas). Cutting a fresh concatenation flattens it first,
 * into a string of the line's own length. One copy a committed line.
 */
function own(text: string): string {
  return ` ${text}`.slice(1);
}

const defaultSchedule = (callback: () => void, ms: number): (() => void) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

export class ChatStore {
  readonly #options: ChatStoreOptions;
  readonly #frameMs: number;
  readonly #schedule: (callback: () => void, ms: number) => () => void;
  readonly #listeners = new Set<() => void>();
  #state: RunState = initialRunState();
  readonly #lines: ChatLine[] = [];
  #nextId = 0;
  /** Characters of each text entry committed so far. */
  #progress = new Map<string, number>();
  /** Tool cards and boundaries committed. */
  #done = new Set<string>();
  /** The plan last printed, so an unchanged plan is not printed again. */
  #plan: string | undefined;
  #truncationNoted = false;
  /** The suspension already explained, so it is explained once. */
  #suspensionNoted: string | undefined;
  #roundsAnsweredBy: RoundAnswerer = "client";
  #view: ChatView;
  #flushToken: object | undefined;
  #cancelFlush: (() => void) | undefined;
  #running = false;
  /** The next event is a continued turn's first (`begin({ continuing })`). */
  #continuing = false;
  /** Where the next prompt goes: what the status line offers. */
  #next: NextPrompt = "new";
  /** The workspace has `chat.home` on: the status line names `/side`, not `/new`. */
  #home = false;
  /** The status a run this side ended says, until the next begins. */
  #endedWith: string | undefined;
  /**
   * Lines to commit where they happened in the stream, by the transcript
   * position they come before — a round's settlement — so the scrollback
   * keeps the stream's order however many events one frame carries.
   */
  #markers = new Map<number, { readonly text: string; readonly tone: LineTone }[]>();
  /** Rounds settled so far (`RunState.settled`) that have their line. */
  #settledNoted = 0;
  /** The round whose decision this chat has sent, until the owner answers it. */
  #deciding: number | undefined;
  /** Each round's full call set, as the owner listed it (`roundCalls`): keys are offered only once all are shown. */
  #roundCalls = new Map<number, ReadonlySet<string>>();
  /** The approval card on screen: its round, the calls it lists so far, and whether it asked. */
  #card: { readonly steps: number; readonly calls: Set<string>; asked: boolean } | undefined;
  #homeTask: string | undefined;
  /** The private chats this terminal knows of (`--private`, or their record): the status line says so. */
  readonly #private = new Set<string>();
  /** What each chat read that Tavi does not trust, by task id: the chip and `/taint` read the chat shown's. */
  readonly #taints = new Map<string, LabelSummary>();
  /** The task whose abort this chat has sent, so a second Esc does not send another. */
  #aborting: string | undefined;
  /** Each tool card's call line, computed once: a card's input does not change. */
  #callLines = new Map<string, string>();
  /** The schedule whose fire answers the task's rounds, when that is why the owner answers them. */
  #firing: ScheduleFire | undefined;
  /** Reviews the owner refused: offered no more, since the same keys would be refused again. */
  #reviewsRefused = new Set<number>();
  /** The review this chat has sent, until the owner answers it or the task resumes. */
  #reviewing: number | undefined;
  /** The review card on screen, and whether it has said what decides it. */
  #reviewCard: { readonly steps: number; asked: boolean } | undefined;
  /** Each task's conversation on the local connection, as this chat learnt it. */
  #conversations = new Map<string, string>();
  /** A reply this chat has sent, until the task resumes or the owner refuses it. */
  #answering = false;
  /** The form being filled, if one is. */
  #form: FormState | undefined;
  /** The question card on screen said the answer could not be typed here: said again once it can. */
  #questionUntyped: string | undefined;
  /** The words the chat speaks: the workspace's language, once the owner says it. */
  #t: CoreT;
  /** Events reduced so far. */
  eventsReduced = 0;
  /** Times the tree was told of a new view: against the events, a measure of coalescing. */
  treeUpdates = 0;

  constructor(options: ChatStoreOptions) {
    this.#options = options;
    this.#frameMs = options.frameMs ?? FRAME_MS;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#t = options.words ?? coreEnglish;
    this.#view = {
      committed: this.#committedView(),
      live: [],
      status: statusLine(this.#state, false, options.prompting ?? true, "new", false, this.#t),
      running: false,
    };
  }

  /** The words the chat speaks now: what every line it adds is said in. */
  get t(): CoreT {
    return this.#t;
  }

  /** The chat speaks `t` from now on (the workspace's language, read from the owner); lines already printed stay as they are. */
  words(t: CoreT): void {
    if (t === this.#t) return;
    this.#t = t;
    this.#dirty();
  }

  /** The last view the tree was given: a stable snapshot between flushes. */
  view = (): ChatView => this.#view;

  /** Observe the view; called at most once a frame. Returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Whether a run is in flight now, not as of the last frame: what input must check. */
  get running(): boolean {
    return this.#running;
  }

  /** Lines committed so far. */
  get linesCommitted(): number {
    return this.#lines.length;
  }

  /** The current run's status as reduced so far. */
  get status(): RunState["status"] {
    return this.#state.status;
  }

  /**
   * The place the chat's stream was last applied is no longer the owner's (it
   * restarted, or may have): its next turn is followed from now.
   */
  forgetPlace(): void {
    if (this.#state.cursor !== undefined) this.#state = { ...this.#state, cursor: undefined };
  }

  /** Where the chat's stream was last applied, for `taskId`: what its next turn is followed from. */
  resumeAt(taskId: string): RunState["cursor"] {
    return this.#state.taskId === taskId ? this.#state.cursor : undefined;
  }

  /**
   * A new run's stream begins: whatever the last one left live is committed
   * first. `taskId` when it is known before any event — an attach — so what
   * is said of the task before its stream speaks (a round read from its
   * record) names it.
   */
  begin(
    options: {
      readonly taskId?: string;
      readonly truncated?: boolean;
      readonly roundsAnsweredBy?: RoundAnswerer;
      /** A new turn of a task this chat already showed: its stream starts mid-task, and is not joined late. */
      readonly continuing?: boolean;
    } = {},
  ): void {
    this.#commitEntries(this.#state.transcript, "final");
    // A new turn of the chat shown keeps its plugins' lines, as the
    // canvas does: a line set on one turn stays until a later one changes it.
    const carried =
      options.continuing === true && options.taskId !== undefined && options.taskId === this.#state.taskId
        ? this.#state.pluginStatus
        : undefined;
    this.#state = initialRunState({
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
      ...(options.truncated === undefined ? {} : { truncated: options.truncated }),
    });
    if (carried !== undefined) this.#state = { ...this.#state, pluginStatus: carried };
    this.#progress = new Map();
    this.#done = new Set();
    this.#plan = undefined;
    this.#truncationNoted = false;
    this.#suspensionNoted = undefined;
    this.#roundsAnsweredBy = options.roundsAnsweredBy ?? "client";
    this.#endedWith = undefined;
    this.#markers = new Map();
    this.#settledNoted = 0;
    this.#deciding = undefined;
    this.#roundCalls = new Map();
    this.#card = undefined;
    this.#aborting = undefined;
    this.#callLines = new Map();
    this.#firing = undefined;
    this.#reviewing = undefined;
    this.#reviewCard = undefined;
    this.#reviewsRefused = new Set();
    this.#answering = false;
    this.#questionUntyped = undefined;
    this.#continuing = options.continuing === true;
    this.#running = true;
    this.#dirty();
  }

  /** Where the next prompt goes: the status line says so. `home` while the workspace has `chat.home` on. */
  next(next: NextPrompt, home = this.#home): void {
    if (this.#next === next && this.#home === home) return;
    this.#next = next;
    this.#home = home;
    this.#dirty();
  }

  /** Task `taskId`'s conversation is `conversationId`: a question it asks may be answered here. */
  conversation(taskId: string, conversationId: string): void {
    this.#conversations.set(taskId, conversationId);
    // The card already said it could not be typed here: it can now.
    if (this.#questionUntyped === taskId && this.#answerable() !== undefined) {
      this.#questionUntyped = undefined;
      this.#line(this.#t("tui.store.typeAnswer"), "notice");
    }
    this.#dirty();
  }

  /** Task `taskId` has no conversation here after all (the owner found none): its questions are not offered. */
  forgetConversation(taskId: string): void {
    this.#conversations.delete(taskId);
    this.#dirty();
  }

  /** Task `taskId`'s conversation here, when this chat knows it. */
  conversationOf(taskId: string): string | undefined {
    return this.#conversations.get(taskId);
  }

  /** Whether this chat knows task `taskId`'s conversation. */
  knowsConversation(taskId: string): boolean {
    return this.#conversations.has(taskId);
  }

  /** A reply is on its way (`true`), or the owner refused it (`false`) and the question is offered again. */
  answering(sent: boolean): void {
    this.#answering = sent;
    this.#dirty();
  }

  /** The question typing may answer now; see `decisionNow`. */
  answerNow(): ChatView["answer"] {
    return this.#answerable();
  }

  /** A form is being filled (`state`), or none is (`undefined`): sent, or cancelled. */
  form(state: FormState | undefined): void {
    this.#form = state;
    this.#dirty();
  }

  /** The form being filled now; see `decisionNow`. */
  formNow(): FormState | undefined {
    return this.#form;
  }

  /** A review for round `steps` is on its way: not offered again until it is answered. */
  reviewing(steps: number): void {
    this.#reviewing = steps;
    this.#dirty();
  }

  /**
   * The owner refused the review for round `steps`. It is not offered again:
   * whatever refused it — an artifact decided elsewhere meanwhile, decisions
   * written but the resume refused — the same keys would be refused again, so
   * what is left is deciding artifact by artifact, as the card says.
   */
  reviewRefused(steps: number): void {
    if (this.#reviewing === steps) this.#reviewing = undefined;
    this.#reviewsRefused.add(steps);
    this.#dirty();
  }

  /** The review a key may decide now; see `decisionNow`. */
  reviewNow(): ChatView["review"] {
    return this.#reviewable();
  }

  /** The schedule whose fire answers the task's rounds, if one does; see `answeredBy`. */
  get schedule(): ScheduleFire | undefined {
    return this.#firing;
  }

  /** The round pending now, if one is: what a chat that may decide it lists. */
  get pendingRound(): number | undefined {
    return this.#state.status === "awaiting_approval" ? this.#state.pending[0]?.steps : undefined;
  }

  /** Whether a round or review is pending that the owner — not this chat — answers. */
  get awaitingOwner(): boolean {
    return this.#roundsAnsweredBy === "owner" && (this.#state.status === "awaiting_approval" || this.#state.status === "review_required");
  }

  /**
   * Round `steps` has these calls, as the owner listed them. The owner
   * announces a round a call at a time, so until every one listed has arrived
   * the card is incomplete and no key is offered: a round decided whole must
   * be seen whole.
   */
  roundCalls(steps: number, callIds: ReadonlySet<string>): void {
    this.#roundCalls.set(steps, callIds);
    this.#dirty();
  }

  /** An abort of `taskId`'s turn is on its way: Esc does not send another. */
  aborting(taskId: string | undefined): void {
    this.#aborting = taskId;
    this.#dirty();
  }

  /** Whether the owner leaves the task's rounds to a client (this one) to decide. */
  /** Where the followed task's rounds are decided, as a status pane names it. */
  roundsDecidedWhere(): string {
    const t = this.#t;
    if (this.decidesRounds) return t("tui.store.decidedWhere.card");
    if (this.#roundsAnsweredBy === "owner") {
      return this.#firing !== undefined
        ? t("tui.store.decidedWhere.fire", { name: printable(this.#firing.name) })
        : t("tui.store.decidedWhere.owner");
    }
    return t("tui.store.decidedWhere.elsewhere");
  }

  /** Who answers the current task's rounds, as last told (`answeredBy`). */
  get roundsAnsweredBy(): RoundAnswerer {
    return this.#roundsAnsweredBy;
  }

  get decidesRounds(): boolean {
    return this.#roundsAnsweredBy === "client" && (this.#options.prompting ?? true);
  }

  /** The round a key may decide now — now, not as of the last frame: two keys in one chunk see the first. */
  decisionNow(): ChatView["decision"] {
    return this.#decidable();
  }

  /** The turn Esc may abort now; see `decisionNow`. */
  abortableNow(): ChatView["abortable"] {
    return this.#abortable();
  }

  /** A decision for round `steps` is on its way: the round is not offered again until it is answered. */
  deciding(steps: number): void {
    this.#deciding = steps;
    this.#dirty();
  }

  /** The owner answered the decision for round `steps` without settling it: it is offered again. */
  decisionAnswered(steps: number): void {
    if (this.#deciding === steps) this.#deciding = undefined;
    this.#dirty();
  }

  /** The run ended from this side (detached, refused, or its stream closed). */
  end(): void {
    this.#running = false;
    this.#dirty();
  }

  /**
   * The run ended for a reason its stream does not show — its record says how
   * it settled, or the owner is gone: `text` is committed, and its first line
   * is the status until the next run begins.
   */
  finishWith(text: string, tone: LineTone): void {
    this.#line(text, tone);
    this.#endedWith = own(printable(text).split("\n")[0] ?? "");
    this.end();
  }

  /**
   * The run ended as its record says (the stream did not tell it): shown as
   * the status, as a stream's own ending is, and not committed as well — the
   * row and a line saying the same once each, with a note between them, read
   * as the chat ending twice.
   */
  settleWith(text: string): void {
    this.#endedWith = own(printable(text).split("\n")[0] ?? "");
    this.end();
  }

  /** The owner no longer holds the start of the stream this run follows (`SubscribeResult.truncated`). */
  joinedLate(): void {
    if (this.#state.truncated) return;
    this.#state = { ...this.#state, truncated: true };
    this.#dirty();
  }

  /**
   * Who answers the current task's rounds: a client (this one), or the owner
   * itself — and, when that is a schedule's fire, which schedule. It may
   * change: a fire that ends leaves its rounds to a client.
   */
  answeredBy(answerer: RoundAnswerer, schedule?: ScheduleFire): void {
    this.#roundsAnsweredBy = answerer;
    this.#firing = answerer === "owner" ? schedule : undefined;
    this.#dirty();
  }

  /** Apply one event of the current run's stream. */
  push(event: ClientEvent): void {
    const previous = this.#state;
    this.#state = reduceRun(this.#state, event);
    // What a plugin showed between the turns is applied, but is not the new turn starting — nor a late join.
    if (this.#continuing && event.kind.startsWith("plugin.")) this.#state = { ...this.#state, truncated: false };
    else if (this.#continuing) {
      // The earlier turns are on screen already: the new turn's first event is where it starts, not a late join.
      this.#continuing = false;
      if (event.kind !== "resync.required") this.#state = { ...this.#state, truncated: false };
      // A follow-up turn resumes the task, so its stream opens with a resume boundary: the prompt above it says so already.
      if (event.kind === "attempt.replaced" && event.discarded !== true) {
        this.#state = {
          ...this.#state,
          transcript: this.#state.transcript.filter((entry) => !(entry.kind === "boundary" && entry.attemptId === event.attemptId)),
        };
      }
    }
    this.eventsReduced += 1;
    if (event.kind === "turn.suggested")
      this.#mark(
        previous.transcript.length,
        this.#t("tui.store.suggested", {
          suggestions: event.suggestions.map((text) => `“${printable(text.replace(/\s+/g, " "))}”`).join(" · "),
        }),
        "notice",
      );
    if (event.kind === "plugin.notice") this.#mark(previous.transcript.length, `${event.pluginId}: ${printable(event.notice)}`, "notice");
    if (event.kind === "task.spawned" && this.#state !== previous)
      this.#mark(
        previous.transcript.length,
        this.#t("tui.store.spawned", { worker: event.workerAgentId, run: event.childRunId, depth: String(event.depth) }),
        "notice",
      );
    if (event.kind === "approval.settled") {
      // Where the stream settled it: before whatever the resumed turn adds.
      for (const round of this.#state.settled.slice(this.#settledNoted)) {
        this.#mark(previous.transcript.length, settledLine(round, this.#t), "notice");
        if (round.steps === this.#deciding) this.#deciding = undefined;
      }
      this.#settledNoted = this.#state.settled.length;
    }
    if (event.kind === "resync.required") {
      // What the stream said before the marker is gone: the transcript starts over.
      this.#commitEntries(previous.transcript, "final");
      this.#progress = new Map();
      this.#done = new Set();
      this.#plan = undefined;
      this.#markers = new Map();
      this.#settledNoted = 0;
      this.#deciding = undefined;
      this.#card = undefined;
      this.#reviewCard = undefined;
      this.#suspensionNoted = undefined;
      this.#line(this.#t("tui.store.resync", { mark: GLYPHS.warning, reason: event.reason }), "notice");
      this.#truncationNoted = true;
    }
    // A decision for a round no longer pending was answered some other way
    // (a resume the stream announced without its settlement): let it go.
    if (this.#deciding !== undefined && !this.#state.pending.some((round) => round.steps === this.#deciding)) this.#deciding = undefined;
    if (this.#state.status !== "running") this.#aborting = undefined;
    if (this.#state.status !== "review_required") this.#reviewing = undefined;
    if (this.#state.status !== "waiting") this.#answering = false;
    if (turnEnded(this.#state.status)) {
      // The stream's own ending says it better than any read of the record.
      this.#endedWith = undefined;
      this.#running = false;
    }
    this.#dirty();
  }

  /**
   * Apply a suspension learned out of band — after a resync, which erases what
   * the stream said, a suspended task publishes nothing until it is decided.
   */
  seed(suspension: Parameters<typeof seedSuspension>[1]): void {
    this.#state = seedSuspension(this.#state, suspension);
    this.#dirty();
  }

  /**
   * Plugins' status lines off the row: the stream that would clear
   * them is no longer followed — the chat's turn ended before a reconnect —
   * so they may be stale. Its next turn sets them again.
   */
  clearPluginStatus(): void {
    if (Object.keys(this.#state.pluginStatus).length === 0) return;
    this.#state = { ...this.#state, pluginStatus: {} };
    this.#dirty();
  }

  /**
   * What chat `taskId` read that Tavi does not trust, as its record or a
   * round says: the status line shows a chip while it is the chat shown.
   * A label that is not untrusted clears it: taint never lowers within a
   * chat, so only a chat that never read such content answers one.
   */
  setTaint(taskId: string, label: LabelSummary | undefined): void {
    const untrusted = label !== undefined && label.integrity === "untrusted" ? label : undefined;
    const was = this.#taints.get(taskId);
    if (JSON.stringify(was) === JSON.stringify(untrusted)) return;
    if (untrusted === undefined) this.#taints.delete(taskId);
    else this.#taints.set(taskId, untrusted);
    if (taskId === this.#state.taskId) this.#dirty();
  }

  /** The person's Home, once this terminal knows its task: a chat grant there lasts until tomorrow. */
  setHome(taskId: string | undefined): void {
    this.#homeTask = taskId;
  }

  /** Whether the chat shown never ends (Home): its round's `s` lasts until tomorrow, not the rest of the chat. */
  #lasting(): boolean {
    return this.#homeTask !== undefined && this.#homeTask === this.#state.taskId;
  }

  /** Chat `taskId` is private: its status line says so while it is the one shown. */
  markPrivate(taskId: string): void {
    if (this.#private.has(taskId)) return;
    this.#private.add(taskId);
    if (taskId === this.#state.taskId) this.#dirty();
  }

  /** `/taint`'s lines: what chat `taskId` (the one shown) read, the remedy, and that `/compact` does not clear it. */
  taintDetails(taskId: string | undefined = this.#state.taskId): readonly string[] {
    const label = taskId === undefined ? undefined : this.#taints.get(taskId);
    if (label === undefined) return [this.#t("tui.store.noTaint")];
    return taintDetailLines(label, this.#t).map((line) => printable(line));
  }

  /** Whether the chat shown is tainted: `/compact` says it does not clear it. */
  get tainted(): boolean {
    return this.#shownTaint() !== undefined;
  }

  /** The chat shown's label, when it read something Tavi does not trust. */
  #shownTaint(): LabelSummary | undefined {
    return this.#state.taskId === undefined ? undefined : this.#taints.get(this.#state.taskId);
  }

  /** A line of the conversation's own: the prompt, an error, a notice. */
  note(text: string, tone: LineTone): void {
    this.#line(text, tone);
    this.#dirty();
  }

  /** A line saying what failed, marked as a failure. */
  fail(text: string): void {
    this.note(`${GLYPHS.failed} ${text}`, "failure");
  }

  /** A line about the chat rather than in it (reconnecting, queued, what a command did), marked as a notice. */
  notice(text: string): void {
    this.note(`${GLYPHS.more} ${text}`, "notice");
  }

  /** What the person typed, echoed as they sent it. */
  echo(text: string, tone: LineTone = "prompt"): void {
    this.note(`${GLYPHS.prompt} ${text}`, tone);
  }

  /** Recompute the view and tell the tree, now. */
  flush(): void {
    this.#cancelFlush?.();
    this.#cancelFlush = undefined;
    this.#flushToken = undefined;
    const before = this.#view.committed.length;
    if (this.#state.truncated && !this.#truncationNoted) {
      this.#line(this.#t("tui.store.joinedLate", { mark: GLYPHS.warning }), "notice");
      this.#truncationNoted = true;
    }
    const live = this.#commitEntries(this.#state.transcript, this.#running ? "live" : "final");
    this.#noteSuspension();
    const width = this.#options.columns();
    const budget = liveRowBudget(this.#options.rows(), this.#options.reservedRows);
    const rows = live.flatMap((line) => wrapRows(line, width));
    const decision = this.#decidable();
    const abortable = this.#abortable();
    const review = this.#reviewable();
    const answer = this.#answerable();
    const form = this.#form;
    const field = form === undefined ? undefined : fieldOf(form);
    const t = this.#t;
    // A translated status row is cut where a clause or a word ends, never inside a word; English's is as it always was.
    const fit = t === coreEnglish ? undefined : fittedRow;
    const row = (status: string): string => (fit === undefined ? status : fit(status, width));
    this.#view = {
      committed: this.#lines.length === before ? this.#view.committed : this.#committedView(),
      live: budget === 0 ? [] : rows.slice(Math.max(0, rows.length - budget)),
      status: row(
        (form !== undefined && field !== undefined ? formStatus(form, field, t) : undefined) ??
          (this.#endedWith === undefined ? undefined : this.#withTaint(this.#endedWith, fit)) ??
          (this.#deciding !== undefined && this.#deciding === this.#state.pending[0]?.steps
            ? t("tui.status.deciding", { mark: GLYPHS.more, steps: String(this.#deciding) })
            : decision !== undefined
              ? roundRow(decision, this.#lasting(), t, fit === undefined ? undefined : width)
              : this.#reviewing !== undefined && this.#state.status === "review_required"
                ? t("tui.status.sendingReview", { mark: GLYPHS.more })
                : review !== undefined
                  ? t("tui.status.review", { mark: GLYPHS.waiting, keys: t("tui.review.keys") })
                  : this.#answering && this.#state.status === "waiting"
                    ? t("tui.status.sendingAnswer", { mark: GLYPHS.more })
                    : answer !== undefined
                      ? t("tui.status.asks", {
                          mark: GLYPHS.waiting,
                          question: clipStatus(this.#state.waiting?.choices?.header ?? this.#state.waiting?.question ?? "", t),
                        })
                      : this.#withTaint(
                          statusLine(this.#state, this.#running, this.#options.prompting ?? true, this.#next, this.#home, t),
                          fit,
                        )),
      ),
      running: this.#running,
      ...definedOnly({
        decision,
        abortable,
        review,
        answer,
      }),
      ...(field === undefined ? {} : { form: { label: fieldLabel(field, t).replace(/ \(.*\)$/, ""), secret: field.secret === true } }),
    };
    this.treeUpdates += 1;
    for (const listener of [...this.#listeners]) listener();
  }

  #committedView(): CommittedLines {
    const lines = this.#lines;
    const length = lines.length;
    return { length, slice: (start = 0, end = length) => lines.slice(start, Math.min(end, length)) };
  }

  /** The round this chat may decide now; see `ChatView.decision`. */
  #decidable(): ChatView["decision"] {
    const round = this.#state.pending[0];
    const taskId = this.#state.taskId;
    if (!this.#running || this.#state.status !== "awaiting_approval" || round === undefined || taskId === undefined) return undefined;
    if (!this.decidesRounds || this.#deciding === round.steps || !this.#whole(round)) return undefined;
    const scopes = (["once", "session", "always"] as const).filter((scope) =>
      round.requests.every((request) => (request.allowedScopes ?? ["once"]).includes(scope)),
    );
    const group = round.requests[0]?.scopeGroup;
    const scopeGroup = group !== undefined && round.requests.every((request) => request.scopeGroup === group) ? group : undefined;
    const scopeHosts = round.requests.flatMap((request) => (request.display?.host === undefined ? [] : [request.display.host]));
    return {
      taskId,
      steps: round.steps,
      scopes,
      ...(scopeGroup === undefined ? {} : { scopeGroup, ...(scopeHosts.length === 0 ? {} : { scopeHosts }) }),
    };
  }

  /** Whether every call the owner listed for `round` has arrived; unknown until it is listed. */
  #whole(round: RunState["pending"][number]): boolean {
    const listed = this.#roundCalls.get(round.steps);
    if (listed === undefined || listed.size === 0) return false;
    return [...listed].every((callId) => round.requests.some((request) => request.callId === callId));
  }

  /** The question this chat may answer; see `ChatView.answer`. */
  #answerable(): ChatView["answer"] {
    const taskId = this.#state.taskId;
    if (!this.#running || this.#state.status !== "waiting" || this.#state.waiting?.question === undefined || taskId === undefined)
      return undefined;
    if (!(this.#options.prompting ?? true) || this.#answering) return undefined;
    const conversationId = this.#conversations.get(taskId);
    return conversationId === undefined ? undefined : { taskId, conversationId };
  }

  /** The review this chat may decide; see `ChatView.review`. */
  #reviewable(): ChatView["review"] {
    const review = this.#state.review;
    const taskId = this.#state.taskId;
    if (!this.#running || this.#state.status !== "review_required" || review === undefined || taskId === undefined) return undefined;
    if (!this.decidesRounds || this.#reviewing === review.steps || this.#reviewsRefused.has(review.steps) || review.requests.length === 0) {
      return undefined;
    }
    return { taskId, steps: review.steps, artifactIds: review.requests.map((request) => request.artifactId) };
  }

  /** The turn Esc may abort; see `ChatView.abortable`. */
  #abortable(): ChatView["abortable"] {
    const taskId = this.#state.taskId;
    if (!this.#running || this.#state.status !== "running" || taskId === undefined || !(this.#options.prompting ?? true)) return undefined;
    return this.#aborting === taskId ? undefined : { taskId };
  }

  #mark(position: number, text: string, tone: LineTone): void {
    const lines = this.#markers.get(position) ?? [];
    lines.push({ text, tone });
    this.#markers.set(position, lines);
  }

  /** Commit the lines marked to come before transcript position `position`, once. */
  #commitMarkers(position: number): void {
    const lines = this.#markers.get(position);
    if (lines === undefined) return;
    this.#markers.delete(position);
    for (const { text, tone } of lines) this.#line(text, tone);
  }

  #line(text: string, tone: LineTone): void {
    for (const line of printable(text).split("\n")) {
      this.#nextId += 1;
      this.#lines.push({ id: this.#nextId, text: own(line), tone });
    }
  }

  #dirty(): void {
    if (this.#flushToken !== undefined) return;
    const token = {};
    this.#flushToken = token;
    this.#cancelFlush = this.#schedule(() => {
      // A flush since this was scheduled owns the next one; this one is stale.
      if (this.#flushToken !== token) return;
      this.flush();
    }, this.#frameMs);
  }

  /** A suspension, explained once in full: the status row only has room to point at it. */
  #noteSuspension(): void {
    const state = this.#state;
    const t = this.#t;
    const task = state.taskId ?? "<task-id>";
    let key: string | undefined;
    let lines: string[] = [];
    if (state.status === "awaiting_approval") {
      const round = state.pending[0];
      if (round !== undefined) this.#noteRound(round, task);
      return;
    } else if (state.status === "waiting" && state.waiting !== undefined) {
      key = `waiting:${state.waiting.deadlineAt}`;
      lines =
        state.waiting.question !== undefined
          ? [
              // The header is the question's short topic, as the canvas shows it.
              state.waiting.choices?.header === undefined
                ? t("tui.card.asks", { mark: GLYPHS.waiting, question: state.waiting.question })
                : t("tui.card.asksAbout", { mark: GLYPHS.waiting, header: state.waiting.choices.header, question: state.waiting.question }),
              // Options are numbered: typing a number (or several, for a
              // multi-select) picks them, as it does in a chat.
              ...(state.waiting.choices?.options.map((option, index) => `  ${formatChoiceOption(option, index)}`) ?? []),
              this.#answerable() !== undefined
                ? state.waiting.choices === undefined
                  ? t("tui.store.typeAnswer")
                  : t(
                      state.waiting.choices.multiSelect
                        ? state.waiting.choices.allowOther
                          ? "tui.card.typeNumbersOrOwn"
                          : "tui.card.typeNumbers"
                        : state.waiting.choices.allowOther
                          ? "tui.card.typeNumberOrOwn"
                          : "tui.card.typeNumber",
                    )
                : t("tui.card.waitsElsewhere"),
            ]
          : [t("tui.card.waitsOn", { mark: GLYPHS.waiting, on: state.waiting.on, deadline: state.waiting.deadlineAt })];
      // Shown as not typed here: said again once it can be (`conversation`).
      if (key !== this.#suspensionNoted && state.waiting.question !== undefined && this.#answerable() === undefined) {
        this.#questionUntyped = state.taskId;
      }
    } else if (state.status === "review_required" && state.review !== undefined) {
      this.#noteReview(state.review);
      return;
    }
    if (key === undefined || key === this.#suspensionNoted) return;
    this.#suspensionNoted = key;
    for (const line of lines) this.#line(line, "notice");
  }

  /** The status line with the taint chip: up to three sources, and where the details are. */
  #withTaint(line: string, fit?: (line: string, columns: number) => string): string {
    // A private chat says so on its status line, before its taint chip.
    const t = this.#t;
    const marks: string[] = [];
    if (this.#state.taskId !== undefined && this.#private.has(this.#state.taskId)) marks.push(t("tui.status.private"));
    const label = this.#shownTaint();
    if (label !== undefined)
      marks.push(t("tui.status.taintChip", { mark: GLYPHS.warning, chip: clipStatus(printable(taintChipText(label, t)), t) }));
    if (marks.length === 0) return line;
    const tail = marks.join(" · ");
    // A row cut to fit (`fit`) gives up its own words before the marks, which say what the chat is: the state is cut to
    // the room the marks leave (a few columns at least), and only what still does not fit is cut from the marks' end.
    const room = Math.max(MIN_STATE_COLUMNS, this.#options.columns() - stringWidth(tail) - 3);
    const shown = fit === undefined || line === "" ? line : fit(line, room);
    return shown === "" ? tail : `${shown} · ${tail}`;
  }

  /**
   * The approval card: a header, then each gated call of the round as it
   * arrives — the owner announces them one at a time — and, once every call it
   * listed has arrived, what decides it. One decision for the whole round.
   */
  #noteRound(round: RunState["pending"][number], task: string): void {
    const t = this.#t;
    if (this.#card?.steps !== round.steps) {
      this.#card = { steps: round.steps, calls: new Set(), asked: false };
      const steps = String(round.steps);
      this.#line(
        this.#roundsAnsweredBy === "owner"
          ? t("tui.card.roundOwner", { mark: GLYPHS.waiting, steps, by: this.#answeredByClause() })
          : this.decidesRounds
            ? t("tui.card.round", { mark: GLYPHS.waiting, steps })
            : t("tui.card.roundElsewhere", { mark: GLYPHS.waiting, steps, task }),
        "notice",
      );
    }
    const card = this.#card;
    for (const request of round.requests) {
      if (card.calls.has(request.callId)) continue;
      card.calls.add(request.callId);
      this.#line(
        `  ${GLYPHS.bullet} ${callLine(request.toolName, approvalTitleOf(request), request.input)}${request.risk === undefined ? "" : t("tui.card.risk", { level: riskLevel(request.risk.level, t) })}`,
        "notice",
      );
      const form = request.display?.form;
      // A form fill's every value, with its source and check, grouped by page: its table stands for `command`.
      const shown = form === undefined ? (request.display?.command ?? request.display?.destination) : undefined;
      if (shown !== undefined && shown !== request.display?.title) this.#line(`      ${printable(shown).slice(0, 200)}`, "notice");
      if (request.display?.forThisChat !== undefined && request.allowedScopes?.includes("session") === true)
        this.#line(t("tui.card.forThisChat", { what: printable(request.display.forThisChat).slice(0, 200) }), "notice");
      // On one line, its line breaks marked, so no line of it can pass for one of the card's own; a cut says so.
      const stdin = request.display?.stdin;
      if (stdin !== undefined)
        this.#line(
          t(stdin.length > 200 ? "tui.card.stdinLong" : "tui.card.stdin", {
            text: printable(stdin.replace(/\r?\n/g, " ⏎ ")).slice(0, 200),
            n: String(stdin.length),
          }),
          "notice",
        );
      if (form !== undefined) for (const line of formLines(form, "full", printable)) this.#line(`      ${line}`, "notice");
      // A file change's diff, as the canvas's Details show it: the first lines here, the rest there.
      const diff = request.display?.detail;
      if (isUnifiedDiff(diff)) {
        const lines = diff.split("\n");
        for (const line of lines.slice(0, TERMINAL_DIFF_LINES)) this.#line(`      ${printable(line).slice(0, 200)}`, "notice");
        // Only the diff's own lines are counted: a cut diff's closing note is none.
        const more = lines.slice(TERMINAL_DIFF_LINES).filter((line) => /^[ +\-@]/.test(line)).length;
        if (lines.length > TERMINAL_DIFF_LINES)
          this.#line(more === 0 ? t("tui.card.diffRest") : t("tui.card.diffMore", { n: String(more) }), "notice");
      }
      // Why it is asked, and from where, as the canvas shows it: Tavi's words first, a page's claim after.
      for (const line of provenanceLines(request, t)) this.#line(`      ${line}`, "notice");
      // The round's label is the chat's as the call was made: the header's chip says it before the record does.
      if (request.risk?.label?.integrity === "untrusted" && this.#state.taskId !== undefined)
        this.setTaint(this.#state.taskId, request.risk.label);
      // What else flags it (taint has its own lines above).
      const reasons = flaggedReasons(request.risk?.reasons);
      if (reasons.length > 0) this.#line(t("tui.card.flagged", { reasons: printable(reasons.join(" · ")).slice(0, 300) }), "notice");
    }
    if (!card.asked && this.decidesRounds && this.#whole(round)) {
      card.asked = true;
      const decision = this.#decidable();
      this.#line(
        t("tui.card.decide", {
          keys: roundKeys(decision?.scopes ?? ["once"], decision?.scopeGroup, decision?.scopeHosts, this.#lasting(), t),
          task,
        }),
        "notice",
      );
    }
  }

  /**
   * The review card: each flagged artifact, and what decides them — the keys,
   * once this chat may (they are offered for all the artifacts at once), or
   * the command that does it elsewhere.
   */
  #noteReview(review: NonNullable<RunState["review"]>): void {
    const t = this.#t;
    if (this.#reviewCard?.steps !== review.steps) {
      this.#reviewCard = { steps: review.steps, asked: false };
      const artifacts = review.requests.map((request) =>
        t("tui.card.reviewItem", { mark: GLYPHS.bullet, artifact: printable(request.artifactId), tool: printable(request.toolName) }),
      );
      const header = t("tui.card.review", { mark: GLYPHS.waiting, by: this.#answeredByClause() });
      for (const line of [header, ...artifacts]) this.#line(line, "notice");
      if (!this.decidesRounds && this.#roundsAnsweredBy === "client") {
        this.#reviewCard.asked = true;
        this.#line(t("tui.card.reviewElsewhere1"), "notice");
        this.#line(t("tui.card.reviewElsewhere2"), "notice");
      }
    }
    if (!this.#reviewCard.asked && this.decidesRounds) {
      this.#reviewCard.asked = true;
      this.#line(t("tui.card.reviewKeys"), "notice");
    }
  }

  /** Who answers a suspension the owner answers, as a card's header says it; empty when a client does. */
  #answeredByClause(): string {
    if (this.#roundsAnsweredBy !== "owner") return "";
    return this.#firing !== undefined ? this.#t("tui.card.byFire", { name: printable(this.#firing.name) }) : this.#t("tui.card.byOwner");
  }

  /** A tool card's call line, computed once per card. */
  #callLineOf(entry: Extract<TranscriptEntry, { readonly kind: "tool" }>): string {
    const known = this.#callLines.get(entry.key);
    if (known !== undefined) return known;
    const line = callLine(entry.toolName, "", entry.input);
    this.#callLines.set(entry.key, line);
    return line;
  }

  /**
   * Commit what is finished of `transcript`, strictly in order, and return
   * what is still live.
   *
   * In `live` mode the first unfinished entry — the text being written, a tool
   * still running (the tool a suspended task waits on included) — holds back
   * everything after it, so the scrollback never runs ahead of the stream; its
   * whole lines of text are committed as they complete. In `final` mode
   * everything is committed: the run ended, or the stream behind it was lost.
   * Text is tracked by how much of it was committed, so text a provider adds to
   * an entry after it was committed still reaches the scrollback.
   */
  #commitEntries(transcript: readonly TranscriptEntry[], mode: "live" | "final"): string[] {
    const live: string[] = [];
    let held = false;
    for (const [index, entry] of transcript.entries()) {
      if (!held) this.#commitMarkers(index);
      if (entry.kind === "text") {
        const from = this.#progress.get(entry.key) ?? 0;
        const pending = entry.text.slice(from);
        if (pending === "") continue;
        const shown = entry.text.slice(0, from);
        // A failed-over attempt's text: what was not yet committed is
        // dropped — the boundary after it says the rest is discarded.
        if (entry.discarded === true) {
          this.#progress.set(entry.key, entry.text.length);
          continue;
        }
        if (held) {
          live.push(...plainEmphasis(printable(pending), shown).split("\n"));
          continue;
        }
        const writing = mode === "live" && isActive(this.#state) && index === transcript.length - 1;
        if (!writing) {
          this.#line(plainEmphasis(pending.replace(/\n$/, ""), shown), "text");
          this.#progress.set(entry.key, entry.text.length);
          continue;
        }
        const newline = pending.lastIndexOf("\n");
        if (newline !== -1) {
          this.#line(plainEmphasis(pending.slice(0, newline), shown), "text");
          this.#progress.set(entry.key, from + newline + 1);
        }
        const tail = pending.slice(newline + 1);
        if (tail !== "") live.push(plainEmphasis(printable(tail), entry.text.slice(0, from + newline + 1)));
        held = true;
        continue;
      }
      if (this.#done.has(entry.key)) continue;
      if (entry.kind === "boundary") {
        if (held) {
          live.push(divider(entry.reason, RULES.boundary));
          continue;
        }
        this.#line(divider(entry.reason, RULES.boundary), "divider");
        this.#done.add(entry.key);
        continue;
      }
      // A message sent into the running turn, where the model read it.
      if (entry.kind === "steer") {
        const line = this.#t("tui.transcript.steered", { mark: GLYPHS.prompt, text: printable(entry.text) });
        if (held) {
          live.push(line);
          continue;
        }
        this.#line(line, "prompt");
        this.#done.add(entry.key);
        continue;
      }
      if (entry.status === "running" && mode === "live") {
        live.push(`${GLYPHS.call} ${this.#callLineOf(entry)} ${GLYPHS.more}`);
        held = true;
        continue;
      }
      if (held) {
        live.push(toolLine(entry, this.#callLineOf(entry), this.#t));
        continue;
      }
      // A plan is shown as the checklist it is, not as a tool call.
      // The scrollback is append-only (`<Static>`), so a plan cannot be
      // redrawn in place; instead only the latest one is printed: a plan a
      // later one in the transcript replaces is skipped, as is one unchanged
      // from the plan last printed, and a plan input that does not parse (an
      // event's capped preview) is not printed raw.
      if (entry.toolName === PLAN_TOOL_ID && entry.status === "completed") {
        const plan = planLines(entry.input);
        const superseded = transcript
          .slice(index + 1)
          .some(
            (later) =>
              later.kind === "tool" &&
              later.toolName === PLAN_TOOL_ID &&
              later.status === "completed" &&
              planLines(later.input) !== undefined,
          );
        const shown = plan?.join("\n");
        if (plan !== undefined && !superseded && shown !== this.#plan) {
          this.#line(`${GLYPHS.call} ${this.#t(this.#plan === undefined ? "tui.transcript.plan" : "tui.transcript.planUpdated")}`, "tool");
          for (const item of plan) this.#line(`  ${printable(item)}`, "tool");
          this.#plan = shown;
        }
        this.#done.add(entry.key);
        continue;
      }
      this.#line(toolLine(entry, this.#callLineOf(entry), this.#t), entry.status === "completed" ? "tool" : "failure");
      // Past-chat search names the chats it found, by title, not a line of JSON.
      const cited =
        entry.status === "completed" && entry.toolName === SESSIONS_SEARCH_TOOL_ID ? pastChatSearchCitations(entry.output) : undefined;
      if (cited !== undefined) {
        this.#line(`  ${GLYPHS.result} ${pastChatSearchSummary(cited.found, this.#t)}`, "tool");
        for (const chat of cited.chats) this.#line(`    ${GLYPHS.bullet} ${clamp(printable(chat.title), SUMMARY_CHARS)}`, "tool");
        if (cited.found > cited.chats.length)
          this.#line(this.#t("tui.transcript.moreChats", { mark: GLYPHS.more, n: String(cited.found - cited.chats.length) }), "tool");
      }
      // A skill proposed: where it waits, and the command that shows it, in place of its output's JSON.
      const proposed =
        entry.status === "completed" && entry.toolName === SKILLS_PROPOSE_TOOL_ID ? skillProposedOf(entry.output) : undefined;
      if (proposed !== undefined)
        this.#line(`  ${GLYPHS.result} ${printable(skillProposalNoticeLine(proposed.skillId, proposed.version, this.#t))}`, "notice");
      const result = entry.status === "completed" && cited === undefined && proposed === undefined ? outputLine(entry.output) : undefined;
      if (result !== undefined) this.#line(`  ${GLYPHS.result} ${result}`, "tool");
      const masked = entry.status === "completed" ? maskedSecretsNote(entry.redacted) : undefined;
      if (masked !== undefined) this.#line(`  ${GLYPHS.result} ${masked}`, "notice");
      this.#done.add(entry.key);
    }
    if (!held) this.#commitMarkers(transcript.length);
    return live;
  }
}

/** Whether the stream may still add to its last entry. */
function isActive(state: RunState): boolean {
  return state.status === "running" || state.status === "idle" || state.status === "unknown";
}

/** A tool card's header: the tool, what it was called with, and how it ended. */
function toolLine(card: Extract<TranscriptEntry, { readonly kind: "tool" }>, call: string, t: CoreT = coreEnglish): string {
  const took = card.durationMs === undefined ? "" : ` ${durationOf(card.durationMs)}`;
  if (card.status === "completed") return `${GLYPHS.call} ${call} ${GLYPHS.done}${took}`;
  if (card.status === "running") return t("tui.tool.didNotFinish", { mark: GLYPHS.call, call });
  if (card.status === "interrupted") return t("tui.tool.interrupted", { mark: GLYPHS.call, call });
  return `${GLYPHS.call} ${call} ${GLYPHS.failed} ${card.errorCode ?? t("tui.tool.failed")}${card.message === undefined ? "" : `: ${printable(card.message)}`}`;
}

/** The line that opens or closes a Markdown fence: its run of marks. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A code span: a run of backticks up to the same run. */
const CODE_SPAN = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;

/** Where a fence stands after a line: its marks while open. */
function fenceAfter(open: string | undefined, line: string): string | undefined {
  const [, marks, rest = ""] = FENCE_LINE.exec(line) ?? [];
  if (marks === undefined) return open;
  if (open === undefined) return marks;
  return marks.startsWith(open) && rest.trim() === "" ? undefined : open;
}

/** One line outside a fence as its words: a code span in it stays exact, and bold may hold one. */
function plainLine(line: string): string {
  const spans: string[] = [];
  const masked = line.replace(CODE_SPAN, (span) => `${spans.push(span) - 1}`);
  return masked
    .replace(/^#{2,6}[ \t]+/, "")
    .replace(/^([ \t]*)\*(?=[ \t])/, "$1-")
    .replace(/(?<![\w*/])\*\*(?=[^\s/])(.*?)(?<=\S)\*\*(?![\w/])/g, "$1")
    .replace(/(^|[^\w*\\])\*([^\s*](?:[^*]*?[^\s*\\])?)\*(?=[^\w*]|$)/g, "$1$2")
    .replace(/(\d+)/g, (_, index: string) => spans[Number(index)] ?? "");
}

/**
 * An answer's Markdown emphasis and headings as the words alone (`**bold**`,
 * `*italic*`, `## Title`) and a `* ` bullet as `- `: the canvas draws them, and a
 * terminal line shows the words rather than the marks. Code stays exact, in a
 * fence or a span, and `before` (what of the answer is already shown) says
 * whether `text` starts in a fence. A lone `*` (`a * b`) or `**` (`x ** 2`,
 * `**kwargs`, `src/**`) is left as it is, and so is one `#`, which a code line
 * may start with.
 */
export function plainEmphasis(text: string, before = ""): string {
  let fence = before
    .split("\n")
    .slice(0, -1)
    .reduce(fenceAfter, undefined as string | undefined);
  return text
    .split("\n")
    .map((line) => {
      const inside = fence !== undefined || FENCE_LINE.test(line);
      fence = fenceAfter(fence, line);
      return inside ? line : plainLine(line);
    })
    .join("\n");
}

/** How long a card will show inputs and outputs, before cutting them. */
const SUMMARY_CHARS = 72;

/** The keys a round's card offers: `s` and `a` only where every call offers that scope. */
function roundKeys(
  scopes: readonly ApprovalScope[],
  scopeGroup?: string,
  scopeHosts: readonly string[] = [],
  home = false,
  t: CoreT = coreEnglish,
): string {
  const label = scopeGroup === undefined ? undefined : groupLabel(scopeGroup, scopeHosts, t);
  return roundKeyList(scopes, label, home, t, "card").join(", ");
}

/** A tool group's name as a round's keys say it: the browser with the hosts its round opens. */
const groupLabel = (scopeGroup: string, scopeHosts: readonly string[], t: CoreT): string =>
  printable(displaySafe(toolGroupLabel(scopeGroup, scopeHosts, t)));

/**
 * A round's keys, one entry each. `label` is the group the round's calls share (absent: none); the card says each key
 * in full, and the status row, one line under it, may say them shorter (`tui.rowKeys.*`).
 */
function roundKeyList(
  scopes: readonly ApprovalScope[],
  label: string | undefined,
  home: boolean,
  t: CoreT,
  place: "card" | "row",
): string[] {
  const words = ROUND_KEYS[place];
  if (label !== undefined && scopes.includes("session")) {
    // One question for the group: `y` allows it for the task (the owner's
    // default for a grouped round), `a` saves a rule for every tool of it.
    // The browser is allowed on the hosts the round opens, so the keys name them.
    const name = t("tui.keys.groupName", { label });
    return [
      t(words.groupAllow, { name }),
      ...(scopes.includes("always") ? [t(words.groupAlways, { name })] : []),
      t(words.groupRefuse),
      t(words.groupRefuseWhy),
    ];
  }
  return [
    t(words.approve),
    // In Home, which never ends, a chat grant lasts until tomorrow, as the canvas's Allow until tomorrow says.
    ...(scopes.includes("session") ? [t(home ? words.untilTomorrow : words.restOfChat)] : []),
    ...(scopes.includes("always") ? [t(words.always)] : []),
    t(words.reject),
    t(words.rejectWhy),
  ];
}

/**
 * The status row that offers a round's keys. With no `columns` (English), the row as it always was. With them, a row
 * that fits and never cuts a key's words: first the round numbered, each key naming its group; then the group named
 * once, ahead of keys that leave it out, with fewer of its hosts (`…` where some are left out); then the first keys
 * alone, each whole, and `…` for the rest. The card above names every call, host and key in full.
 */
function roundRow(decision: NonNullable<ChatView["decision"]>, home: boolean, t: CoreT, columns?: number): string {
  const group = decision.scopeGroup;
  const hosts = decision.scopeHosts ?? [];
  const label = group === undefined ? undefined : groupLabel(group, hosts, t);
  const numbered = t("tui.status.round", {
    mark: GLYPHS.waiting,
    steps: String(decision.steps),
    keys: roundKeyList(decision.scopes, label, home, t, "row").join(", "),
  });
  if (columns === undefined) return numbered;
  const fits = (row: string): boolean => stringWidth(row) <= columns;
  if (fits(numbered)) return numbered;
  // The group's keys without its name, which the row then says once.
  const grouped = label !== undefined && decision.scopes.includes("session");
  const keys = grouped
    ? [
        t("tui.rowKeys.group.allowIt"),
        ...(decision.scopes.includes("always") ? [t("tui.rowKeys.group.alwaysIt")] : []),
        t("tui.rowKeys.group.refuse"),
        t("tui.rowKeys.group.refuseWhy"),
      ]
    : roundKeyList(decision.scopes, undefined, home, t, "row");
  const labels =
    group === undefined
      ? [""]
      : [
          groupLabel(group, hosts, t),
          ...hosts.slice(1).map((_, index) => `${groupLabel(group, hosts.slice(0, hosts.length - 1 - index), t)}…`),
          ...(hosts.length === 0 ? [] : [`${groupLabel(group, [], t)}…`]),
        ];
  const row = (name: string, list: readonly string[]): string =>
    grouped
      ? t("tui.status.roundGroup", { mark: GLYPHS.waiting, name, keys: list.join(", ") })
      : t("tui.status.roundKeys", { mark: GLYPHS.waiting, keys: list.join(", ") });
  for (const name of labels) if (fits(row(name, keys))) return row(name, keys);
  // Too narrow for every key: the first ones, each whole, and a mark that more are on the card.
  const shortest = labels.at(-1) ?? "";
  for (let count = keys.length - 1; count > 0; count -= 1) {
    const cut = `${row(shortest, keys.slice(0, count))}…`;
    if (fits(cut)) return cut;
  }
  return fittedRow(row(shortest, keys.slice(0, 1)), columns);
}

/** A round's keys as its card says them, and as the status row does (English says both alike). */
const ROUND_KEYS = {
  card: {
    groupAllow: "tui.keys.group.allow",
    groupAlways: "tui.keys.group.always",
    groupRefuse: "tui.keys.group.refuse",
    groupRefuseWhy: "tui.keys.group.refuseWhy",
    approve: "tui.keys.approve",
    untilTomorrow: "tui.keys.untilTomorrow",
    restOfChat: "tui.keys.restOfChat",
    always: "tui.keys.always",
    reject: "tui.keys.reject",
    rejectWhy: "tui.keys.rejectWhy",
  },
  row: {
    groupAllow: "tui.rowKeys.group.allow",
    groupAlways: "tui.rowKeys.group.always",
    groupRefuse: "tui.rowKeys.group.refuse",
    groupRefuseWhy: "tui.rowKeys.group.refuseWhy",
    approve: "tui.rowKeys.approve",
    untilTomorrow: "tui.rowKeys.untilTomorrow",
    restOfChat: "tui.rowKeys.restOfChat",
    always: "tui.rowKeys.always",
    reject: "tui.rowKeys.reject",
    rejectWhy: "tui.rowKeys.rejectWhy",
  },
} as const;

/** A risk level as a card says it: the channel's words, lowercased (`[high risk]`); a level it does not know, as given. */
function riskLevel(level: string, t: CoreT): string {
  switch (level) {
    case "low":
      return t("channel.approval.risk.low");
    case "medium":
      return t("channel.approval.risk.medium");
    case "high":
      return t("channel.approval.risk.high").toLowerCase();
    case "critical":
      return t("channel.approval.risk.critical").toLowerCase();
    default:
      return level;
  }
}

/**
 * A call as a card names it: `tool — summary` when the summary says more than
 * the tool's name (the workflow's default, "Approve <tool>?", does not), else
 * `tool(input)`; an empty input is left out.
 */
function callLine(toolName: string, summary: string, input: unknown): string {
  const name = printable(toolName);
  const given = printable(displaySafe(summary)).trim();
  if (given !== "" && !given.includes(name)) return `${name} — ${clamp(given, SUMMARY_CHARS)}`;
  // The call's own input, which no verdict cleaned: what it would hide (a bidi override, an invisible character) is marked.
  const shown = summarize(input);
  return shown === undefined ? name : `${name}(${displaySafe(shown)})`;
}

/** A tool's result, in one line; nothing for an empty one. */
function outputLine(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") {
    const first = printable(output).trim().split("\n")[0] ?? "";
    return first === "" ? undefined : clamp(first, SUMMARY_CHARS);
  }
  return summarize(output);
}

/** A value in one short line of JSON; nothing for an empty object or array. */
function summarize(value: unknown): string | undefined {
  // A round read back from the owner's list carries no input: nothing to show, never "null".
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    return undefined;
  }
  if (text === "{}" || text === "[]" || text === "") return undefined;
  return clamp(printable(text), SUMMARY_CHARS);
}

/** `text` cut to `columns` terminal columns, by display width, with an ellipsis where it was cut. */
function clamp(text: string, columns: number): string {
  // A value may be megabytes of JSON: only its head is ever shown, so only that is measured.
  const head = text.length > columns * 4 ? text.slice(0, columns * 4) : text;
  let used = 0;
  let kept = "";
  for (const { segment } of graphemes.segment(head)) {
    const width = stringWidth(segment);
    if (used + width > columns - 1) return `${kept}${GLYPHS.more}`;
    kept += segment;
    used += width;
  }
  return head.length < text.length ? `${kept}${GLYPHS.more}` : kept;
}

function durationOf(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

/** A settled round, as the scrollback records it: who decided, and what. */
function settledLine(round: RunState["settled"][number], t: CoreT = coreEnglish): string {
  const approved = round.decisions.filter((decision) => decision.approved).length;
  // A blanket `--approval approve|deny` saw no call: say so rather than name the principal. Its decider id is the same
  // for both; the round's decisions say which it was.
  const by = !round.decidedBy.startsWith("auto:")
    ? printable(round.decidedBy)
    : approved === 0
      ? t("tui.settled.autoDeny")
      : t("tui.settled.autoApprove");
  const steps = String(round.steps);
  if (approved === round.decisions.length) return t("tui.settled.approved", { mark: GLYPHS.done, steps, by });
  if (approved === 0) return t("tui.settled.rejected", { mark: GLYPHS.failed, steps, by });
  const each = round.decisions
    .map((decision) => `${printable(decision.callId)} ${decision.approved ? GLYPHS.done : GLYPHS.failed}`)
    .join(", ");
  return t("tui.settled.mixed", { steps, by, each });
}

/** `text` ended as a sentence: with a full stop unless it already ends with one, a question or an exclamation. */
const sentence = (text: string): string => (/[.!?…]$/u.test(text) ? text : `${text}.`);

/** A question in the status row: its first line, cut to stay one row. */
function clipStatus(text: string, t: CoreT = coreEnglish): string {
  const line = printable(text.split("\n")[0] ?? "");
  // A translated row is cut where a word ends (`fittedRow`); English's as it always was.
  if (t !== coreEnglish) return fittedRow(line, 60);
  return line.length > 60 ? `${line.slice(0, 59)}${GLYPHS.more}` : line;
}

/**
 * Where the next prompt goes: it continues the chat shown, goes to the
 * person's Home, starts a side chat (`/side`), or starts a chat of its
 * own (Home off).
 */
export type NextPrompt = "continue" | "home" | "side" | "new";

/** How much of an argument a terminal card shows. */
const ORIGIN_VALUE_CHARS = 60;

/**
 * A round card's provenance lines, as the canvas shows
 * them: "Why am I asked?" in plain words, the sources Tavi established (a
 * page's own title only after, neutralized), and where the call's values
 * appear. Nothing for a call made in a clean chat that nothing flags.
 */
function provenanceLines(request: RunState["pending"][number]["requests"][number], t: CoreT = coreEnglish): readonly string[] {
  const provenance = request.provenance;
  const tainted = requestTainted(request);
  const lines: string[] = [];
  const why = whyAskedText(provenance?.gateReason, tainted, provenance?.skillCeiling, request.toolName, t);
  if (why !== undefined) lines.push(t("tui.card.why", { mark: GLYPHS.warning, why }));
  const sources = requestSources(request);
  const chips = sources === undefined ? [] : provenanceChips(sources, t);
  if (chips.length > 0)
    lines.push(
      t("tui.card.read", {
        chips: chips.map((chip) => `${chip.established}${chip.claim === undefined ? "" : ` (${chip.claim})`}`).join("; "),
      }),
    );
  for (const origin of provenance?.argOrigins ?? []) {
    if (!tainted && origin.from === "unmatched") continue;
    lines.push(`  “${neutralizedText(origin.value, ORIGIN_VALUE_CHARS)}” ${argOriginWords(origin, t)}`);
  }
  return lines.map((line) => printable(line));
}

/** One short row: what the task is doing, the verb first. Details are committed as notices. */
export function statusLine(
  state: RunState,
  running: boolean,
  prompting = true,
  next: NextPrompt = "new",
  home = false,
  t: CoreT = coreEnglish,
): string {
  const line = runStatusLine(state, running, prompting, next, home, t);
  // Plugins' lines ride the row while nothing asks the person for anything.
  const plugins = Object.values(state.pluginStatus)
    .map((text) => printable(text.replace(/\s+/g, " ")))
    .join(" · ");
  return plugins === "" || !["idle", "running", "completed"].includes(state.status)
    ? line
    : `${line}${line === "" ? "" : " · "}${clipStatus(plugins, t)}`;
}

function runStatusLine(state: RunState, running: boolean, prompting: boolean, next: NextPrompt, home: boolean, t: CoreT): string {
  const task = state.taskId === undefined ? "" : ` ${state.taskId}`;
  // A settled chat's next prompt continues it, unless `/side` was typed or it has no conversation here.
  const offer = !prompting
    ? ""
    : next === "continue"
      ? t(home ? "tui.status.offer.continueHome" : "tui.status.offer.continue")
      : next === "home"
        ? t("tui.status.offer.home")
        : next === "side"
          ? t("tui.status.offer.side")
          : t("tui.status.offer.new");
  switch (state.status) {
    case "idle":
      return running
        ? t("tui.status.starting", { mark: GLYPHS.running })
        : !prompting
          ? ""
          : next === "home"
            ? t("tui.status.idleHome")
            : t("tui.status.idle");
    case "running":
      return t(prompting ? "tui.status.runningKeys" : "tui.status.running", { mark: GLYPHS.running, task });
    case "awaiting_approval":
      return t("tui.status.approval", { mark: GLYPHS.waiting, task });
    case "waiting":
      // What it waits for, in the row: a question scrolled away is still named.
      // Not answerable from this prompt (the chat that answers it does that), so the way to it is /needs.
      return state.waiting?.question === undefined
        ? t("tui.status.waiting", { mark: GLYPHS.waiting, task })
        : t(prompting ? "tui.status.waitingAnswerWhere" : "tui.status.waitingAnswer", {
            mark: GLYPHS.waiting,
            task,
            question: clipStatus(state.waiting.choices?.header ?? state.waiting.question, t),
          });
    case "review_required":
      return t("tui.status.reviewNeeded", { mark: GLYPHS.waiting, task });
    // A finished turn is said without its id: /chats lists ids, where they are acted on.
    case "completed":
      return t("tui.status.done", { mark: GLYPHS.done, offer });
    case "stopped": {
      const said = state.outcome?.kind === "stopped" ? printable(state.outcome.message) : undefined;
      if (t === coreEnglish) return t("tui.status.stoppedWith", { why: said ?? t("tui.status.stopped"), offer });
      // A translated row says why it stopped as a sentence of its own, and the offer after it only when there is one.
      const why = said === undefined || said.trim() === "" ? t("tui.status.stopped") : sentence(said.trimEnd());
      return offer === "" ? why : t("tui.status.stoppedWith", { why, offer });
    }
    case "failed":
      return t("tui.status.failed", {
        mark: GLYPHS.failed,
        why: state.outcome?.kind === "failed" ? printable(state.outcome.message) : t("tui.status.failedSeeTasks"),
        more: prompting && next === "continue" ? t("tui.status.typeToContinue") : "",
      });
    case "unknown":
      return t("tui.status.resumed", { mark: GLYPHS.more, task });
  }
}

/** A form's status row: which form, which field of how many, and how to leave it. */
function formStatus(form: FormState, field: ReturnType<typeof fieldOf>, t: CoreT): string {
  const spec = FORMS[form.id];
  return t("tui.form.status", {
    mark: GLYPHS.form,
    title: formTitle(form.id, t),
    at: String(form.index + 1),
    of: String(spec.fields.length),
    label: fieldLabel(field, t),
    choices: field.choices === undefined ? "" : ` (${field.choices.join(", ")})`,
    skip: field.optional === true ? t("tui.form.skip") : "",
  });
}

// Shared with the web canvas: `@tavi/client` reads an `approvals list` answer into rounds.
export { pendingRoundsOf } from "@tavi/client";
