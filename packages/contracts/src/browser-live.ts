import { z } from "zod";

import { BROWSER_ACTION_KINDS, BROWSER_ACTION_OUTCOME_STATUSES, type BrowserSensitiveReason } from "./browser.js";
import { BROWSER_TITLE_MAX, BROWSER_URL_MAX } from "./browser-history.js";
import { IdSchema, TimestampSchema } from "./ids.js";

/**
 * The live view of the agent's browser: what a session's page looks like
 * right now, pushed to whoever is
 * watching it, and never kept.
 *
 * - Frames come from the DevTools screencast only while someone watches, and
 *   are never written to the database, an artifact, the event ring or a
 *   checkpoint; they never reach the model.
 * - A page the sensitivity rules hold back (a blocked host, a password,
 *   payment or one-time-code field) sends `hidden`, never a frame.
 * - Sessions are named by their browser-history id (a UUID), never by the
 *   adapter's own `browser-session-N`.
 *
 * Messages travel on their own IPC frame (`{ type: "live" }`), apart from
 * `event`, so they never enter a task's event ring nor count against the
 * 8 KiB event cap.
 */

/** Screencasts one owner runs at once; a watcher past it is told `hidden { reason: "paused" }`. */
export const BROWSER_LIVE_MAX_SCREENCASTS = 4;
/**
 * Live subscriptions one IPC connection may hold (the bridge's, shared by
 * every tab): a tab may show a chat's live view in its panel and tab, two
 * Command Center tiles and a takeover. Each shares its session's one
 * screencast; credit and the connection's backlog pause bound what they send.
 */
export const BROWSER_LIVE_MAX_WATCHES = 32;
/** Frames a subscription may hold unacknowledged; a newer frame replaces a pending one. */
export const BROWSER_LIVE_MAX_UNACKED = 2;
/** The largest frame's base64 data; a larger one is dropped. A 960 px JPEG at quality 60 sits well under it. */
export const BROWSER_LIVE_MAX_FRAME_BYTES = 256 * 1024;
/** The widest frame a watcher may ask for. */
export const BROWSER_LIVE_MAX_WIDTH = 960;
/** The width a watch gets when it names none. */
export const BROWSER_LIVE_DEFAULT_WIDTH = 640;
/** The narrowest frame a watcher may ask for. */
export const BROWSER_LIVE_MIN_WIDTH = 160;
/** JPEG quality of a watched stream. */
export const BROWSER_LIVE_QUALITY = 60;
/** How often, at most, the sensitivity rules are checked while frames flow; a frame newer than the last passing check by more than this is held. */
export const BROWSER_LIVE_CHECK_INTERVAL_MS = 750;
/** A connection's measured backlog past which the hub stops sending frames (keeping the latest). Half the connection's 16 MiB ceiling. */
export const BROWSER_LIVE_CONNECTION_PAUSE_BYTES = 8 * 1024 * 1024;

// Operator takeover: the controller's own stream and input.
/** The widest frame the controller may ask for: the takeover surface's width times its pixel ratio. */
export const BROWSER_LIVE_CONTROL_MAX_WIDTH = 1600;
/**
 * A phone's takeover: the widest layout size (CSS pixels) a take may ask the page to be laid out at — the canvas's
 * phone width (`PHONE_MAX_WIDTH`), so a wider screen never resizes the agent's page.
 */
export const BROWSER_LIVE_PHONE_MAX_WIDTH = 720;
/** The tallest layout size a phone's take may ask for. */
export const BROWSER_LIVE_PHONE_MAX_HEIGHT = 2000;
/** The smallest layout size, either way, a phone's take may ask for. */
export const BROWSER_LIVE_PHONE_MIN_SIZE = 240;
/** A phone's takeover layout size, bounded. */
export const BrowserLivePhoneViewportSchema = z.strictObject({
  width: z.number().int().min(BROWSER_LIVE_PHONE_MIN_SIZE).max(BROWSER_LIVE_PHONE_MAX_WIDTH),
  height: z.number().int().min(BROWSER_LIVE_PHONE_MIN_SIZE).max(BROWSER_LIVE_PHONE_MAX_HEIGHT),
});
export type BrowserLivePhoneViewport = z.infer<typeof BrowserLivePhoneViewportSchema>;
/** JPEG quality of the controller's stream. */
export const BROWSER_LIVE_CONTROL_QUALITY = 75;
/** The largest frame's base64 data while an operator controls the session: its stream is larger and sharper. */
export const BROWSER_LIVE_CONTROL_MAX_FRAME_BYTES = 768 * 1024;
/** Input events one batch may carry. */
export const BROWSER_LIVE_INPUT_MAX_EVENTS = 64;
/** Input batches one controller may send a second. */
export const BROWSER_LIVE_INPUT_MAX_BATCHES_PER_SECOND = 30;
/** Text one `text` input event may insert (an IME commit, a paste). */
export const BROWSER_LIVE_INPUT_MAX_TEXT = 4096;
/** Files one upload may hand a page's file chooser during takeover. */
export const BROWSER_LIVE_UPLOAD_MAX_FILES = 10;
/** Their bytes in all: held in the owner's memory only until the page takes them. */
export const BROWSER_LIVE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** One upload chunk's base64: well inside an IPC frame. */
export const BROWSER_LIVE_UPLOAD_CHUNK_CHARS = 512 * 1024;
/**
 * The longest a `take` waits for the agent's call in flight to settle — each
 * call is bounded by its own timeouts well inside this. Past it the take is
 * refused, never taken alongside a call still running.
 */
export const BROWSER_LIVE_TAKE_WAIT_MS = 5 * 60_000;
/**
 * An operator's own grab (not one the agent asked for) left with no tab in
 * control goes back to the agent, as `timeout`, after this long: the idle
 * "Still working?" check's 10 + 2 minutes, kept by the owner when no surface
 * is open to keep it. An agent's request keeps its wait's own deadline.
 */
export const BROWSER_LIVE_UNATTENDED_MS = 12 * 60_000;

const UrlSchema = z.string().min(1).max(BROWSER_URL_MAX);
const TitleSchema = z.string().min(1).max(BROWSER_TITLE_MAX);
const CallIdSchema = z.string().min(1).max(256);
const Pixels = z.number().finite();

/**
 * A session's lifecycle as the live view sees it: `open` while its task runs,
 * `inactive` once the task has ended (the session stays, for the chat's next
 * turn), `closed` for good.
 */
export const BROWSER_LIVE_SESSION_STATES = ["open", "inactive", "closed"] as const;
export const BrowserLiveSessionStateSchema = z.enum(BROWSER_LIVE_SESSION_STATES);
export type BrowserLiveSessionState = z.infer<typeof BrowserLiveSessionStateSchema>;

/**
 * Who acts in a session's page: `agent` (the default) runs browser
 * tools; `requested` — the agent asked a person to act and waits, nothing
 * acts; `operator` — a person controls it and the agent's browser calls wait.
 */
export const BROWSER_LIVE_CONTROL_STATES = ["agent", "requested", "operator"] as const;
export const BrowserLiveControlStateSchema = z.enum(BROWSER_LIVE_CONTROL_STATES);
export type BrowserLiveControlState = z.infer<typeof BrowserLiveControlStateSchema>;

/** How a person hands control back; `timeout` and `cancelled` are the host's. */
export const BROWSER_LIVE_CONTROL_OUTCOMES = ["done", "failed", "timeout", "cancelled"] as const;
export type BrowserLiveControlOutcome = (typeof BROWSER_LIVE_CONTROL_OUTCOMES)[number];
/** What the controller itself may answer with `release`: `timeout` when its own "Still working?" went unanswered. */
export const BROWSER_LIVE_RELEASE_OUTCOMES = ["done", "failed", "timeout"] as const;
/** The operator's note on handing back, read by the model. */
export const BROWSER_LIVE_NOTE_MAX = 500;

/** One session a watch covers, as `watch` answers it and `session` messages update it. */
export const BrowserLiveSessionInfoSchema = z.strictObject({
  /** The browser-history id, never the adapter's own session id. */
  sessionId: IdSchema,
  taskId: IdSchema,
  state: BrowserLiveSessionStateSchema,
  /** Scrubbed (`scrubBrowserUrl`): scheme, host, port and path. */
  url: UrlSchema.optional(),
  title: TitleSchema.optional(),
  /** The `browser.create_session` call that opened it. */
  openedByCallId: CallIdSchema.optional(),
  /** Absent while the agent acts. */
  control: z.enum(["requested", "operator"]).optional(),
  /** While the agent's request for a person stands (asked, or taken from it): when its wait ends, for the time left wherever the page is taken. */
  handoffDeadlineAt: TimestampSchema.optional(),
  /** The sub-agent whose task opened it, for a session below the watched task; absent for the watched task's own. */
  agent: z.string().min(1).max(64).optional(),
});
export type BrowserLiveSessionInfo = z.infer<typeof BrowserLiveSessionInfoSchema>;

/** What an `action` message reports: every `browser.act` kind, and a navigation. */
export const BROWSER_LIVE_ACTIONS = [...BROWSER_ACTION_KINDS, "navigate"] as const;
export const BROWSER_LIVE_HIDDEN_REASONS = ["blocked-host", "password-field", "payment-field", "paused"] as const;
export type BrowserLiveHiddenReason = (typeof BROWSER_LIVE_HIDDEN_REASONS)[number];

/** An element's box in CSS pixels: of the layout viewport, or of the document for an `action` (see there). */
export const BrowserLiveBoxSchema = z.strictObject({ x: Pixels, y: Pixels, width: Pixels.nonnegative(), height: Pixels.nonnegative() });
export type BrowserLiveBox = z.infer<typeof BrowserLiveBoxSchema>;

/** The screencast's own metadata for a frame: what maps a box onto it. */
export const BrowserLiveFrameMetadataSchema = z.strictObject({
  deviceWidth: Pixels.nonnegative(),
  deviceHeight: Pixels.nonnegative(),
  pageScaleFactor: Pixels.positive(),
  offsetTop: Pixels,
  scrollOffsetX: Pixels,
  scrollOffsetY: Pixels,
});
export type BrowserLiveFrameMetadata = z.infer<typeof BrowserLiveFrameMetadataSchema>;

export const BrowserLiveMessageSchema = z.discriminatedUnion("kind", [
  BrowserLiveSessionInfoSchema.safeExtend({ kind: z.literal("session") }),
  z.strictObject({
    kind: z.literal("navigated"),
    sessionId: IdSchema,
    /** Scrubbed, as history stores it. */
    url: UrlSchema,
    title: TitleSchema.optional(),
    epoch: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("action"),
    sessionId: IdSchema,
    /** `pending`: a submit, upload or download waits for the operator's approval, its target outlined until it runs or is denied. */
    phase: z.enum(["pending", "started", "ended"]),
    action: z.enum(BROWSER_LIVE_ACTIONS),
    /**
     * Absent on a hidden page, and for an action with no element. In the
     * page's document CSS pixels: subtract a frame's `scrollOffsetX/Y` to
     * place it on that frame.
     */
    box: BrowserLiveBoxSchema.optional(),
    status: z.enum(BROWSER_ACTION_OUTCOME_STATUSES).optional(),
    callId: CallIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("frame"),
    sessionId: IdSchema,
    mime: z.literal("image/jpeg"),
    /** Base64. Never typed values: those reach a frame only as the page renders them. */
    data: z.string().min(1).max(BROWSER_LIVE_CONTROL_MAX_FRAME_BYTES),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    metadata: BrowserLiveFrameMetadataSchema,
    at: TimestampSchema,
    /** `thumbnail`: the session's stored thumbnail, sent first so a closed or idle session still shows something. */
    source: z.enum(["live", "thumbnail"]),
  }),
  z.strictObject({ kind: z.literal("hidden"), sessionId: IdSchema, reason: z.enum(BROWSER_LIVE_HIDDEN_REASONS) }),
  z.strictObject({ kind: z.literal("ended"), sessionId: IdSchema, reason: z.string().min(1).max(256) }),
  // Takeover. Who acts now, as this watcher sees it: `you` for the
  // controller, `other` for every other watcher while a person controls it;
  // `pending` while a take waits for the agent's step in flight.
  z.strictObject({
    kind: z.literal("control"),
    sessionId: IdSchema,
    state: BrowserLiveControlStateSchema,
    controller: z.enum(["you", "other", "none"]).optional(),
    /** With `controller: "none"`: how long (ms) no tab has held it — a surface back within its grace takes it again by itself. */
    unattendedMs: z.number().int().nonnegative().optional(),
    pending: z.literal(true).optional(),
  }),
  // The controller only: a native popup the screencast cannot show, drawn by the host.
  z.strictObject({
    kind: z.literal("select"),
    sessionId: IdSchema,
    /** Names this picker in `select`; valid until the next one. */
    ref: z.string().min(1).max(64),
    box: BrowserLiveBoxSchema.optional(),
    options: z
      .array(
        z.strictObject({
          value: z.string().max(1024),
          label: z.string().max(256),
          selected: z.boolean(),
          disabled: z.boolean().optional(),
        }),
      )
      .max(500),
  }),
  z.strictObject({
    kind: z.literal("dialog"),
    sessionId: IdSchema,
    type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
    message: z.string().max(1000),
    defaultValue: z.string().max(1000).optional(),
  }),
  z.strictObject({ kind: z.literal("notice"), sessionId: IdSchema, notice: z.enum(["shortcut-refused"]) }),
  // The controller only: the page asks for files; the host offers its own picker.
  z.strictObject({ kind: z.literal("chooser"), sessionId: IdSchema, multiple: z.boolean(), accept: z.string().max(256).optional() }),
]);
export type BrowserLiveMessage = z.infer<typeof BrowserLiveMessageSchema>;
export type BrowserLiveFrame = Extract<BrowserLiveMessage, { kind: "frame" }>;

/**
 * `ended`'s reason when the session's task reached a terminal state. The session is kept (`inactive`), not over: its
 * watchers stay, a person may still take it, and it streams again once in use.
 */
export const BROWSER_LIVE_ENDED_TASK = "task-ended";

/**
 * Where a watched session's messages go. Answers whether the watcher can take
 * another frame now: `false` makes the source hold Chromium's acknowledgement
 * (so it renders nothing new for this session) until `demand()` is called.
 * Messages other than frames are delivered whatever it answers.
 */
export type BrowserLiveSink = (message: BrowserLiveMessage) => boolean;

/** Modifier bits, as the DevTools protocol numbers them: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const Modifiers = z.number().int().min(0).max(15);
const Coordinate = z.number().finite().min(-100_000).max(100_000);

/**
 * One input event the controller forwards, in the page's viewport
 * CSS pixels — mapped through a frame's `metadata`, never the image's size.
 * A touch is sent as the mouse events it stands for. Applied in order and
 * dropped: never logged, stored or sent on (invariant 8).
 */
export const BrowserLiveInputEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("mouse"),
    action: z.enum(["move", "down", "up"]),
    x: Coordinate,
    y: Coordinate,
    button: z.enum(["none", "left", "middle", "right"]).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    modifiers: Modifiers.optional(),
  }),
  z.strictObject({
    type: z.literal("wheel"),
    x: Coordinate,
    y: Coordinate,
    deltaX: Coordinate,
    deltaY: Coordinate,
    modifiers: Modifiers.optional(),
  }),
  z.strictObject({
    type: z.literal("key"),
    action: z.enum(["down", "up"]),
    key: z.string().min(1).max(32),
    code: z.string().max(32),
    keyCode: z.number().int().min(0).max(255).optional(),
    modifiers: Modifiers.optional(),
    /** A printable key's character, `"\r"` for Enter. */
    text: z.string().max(4).optional(),
  }),
  z.strictObject({ type: z.literal("text"), text: z.string().min(1).max(BROWSER_LIVE_INPUT_MAX_TEXT) }),
]);
export type BrowserLiveInputEvent = z.infer<typeof BrowserLiveInputEventSchema>;

/** Ctrl (2) or Meta (4): a browser shortcut's modifier. */
const COMMAND_MODIFIERS = 2 | 4;
/** Keys that, with Ctrl or Meta, open, close or switch tabs or reach the browser's own UI. */
const REFUSED_SHORTCUT_KEYS = new Set(["t", "w", "n", "l", "tab", "pageup", "pagedown", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);

/**
 * Whether an input event is a refused browser shortcut: one that would
 * open, close or switch tabs or reach the browser's own UI. F5 and every other
 * key go to the page. The canvas and the owner both filter them.
 */
export function refusedShortcut(event: BrowserLiveInputEvent): boolean {
  return event.type === "key" && ((event.modifiers ?? 0) & COMMAND_MODIFIERS) !== 0 && REFUSED_SHORTCUT_KEYS.has(event.key.toLowerCase());
}

/** A change of who acts in a session, as `onControl` reports it: the start of a person's control, or its end with how. */
export type BrowserLiveControlChange =
  | { readonly sessionId: string; readonly taskId: string; readonly state: "requested" | "operator" }
  | {
      readonly sessionId: string;
      readonly taskId: string;
      readonly state: "agent";
      readonly outcome: BrowserLiveControlOutcome;
      readonly note?: string;
      readonly controlledMs: number;
      /** Who handed back, for a release or decline: the operator's actor (`operator:ui`, `operator:cli`). Absent when the host ended it. */
      readonly by?: string;
    };

/** A watch's takeover controls: accepted only from the watch that holds control. */
export interface BrowserLiveControl {
  /**
   * Becomes the controller once the agent's step in flight settles; the stream rises to `maxWidth` (≤ 1600) at quality 75.
   * With `viewport` (a phone's take), the page is laid out at that size while this watch holds it; a take without it
   * restores the session's own.
   */
  take(options: { readonly maxWidth: number; readonly viewport?: BrowserLivePhoneViewport | undefined }): Promise<void>;
  /** Applies a batch in order, after any batch before it. */
  input(events: readonly BrowserLiveInputEvent[]): Promise<void>;
  /** Answers the host-drawn `<select>` picker `ref`. */
  select(ref: string, value: string): Promise<void>;
  /** Answers the JavaScript dialog the page opened. */
  dialog(accept: boolean, text?: string): Promise<void>;
  /** Hands control back to the agent. */
  release(outcome: (typeof BROWSER_LIVE_RELEASE_OUTCOMES)[number], note?: string, by?: string): void;
  /** Answers the agent's request without taking the page ("I can't do this"): any watch may, while it is requested. */
  decline(note?: string, by?: string): void;
  /** One chunk of the files for the page's open file chooser; the last one hands them to the page. */
  upload(chunk: {
    readonly count: number;
    readonly index: number;
    readonly name: string;
    readonly type: string;
    readonly size: number;
    readonly offset: number;
    readonly data: string;
  }): Promise<void>;
  /** Dismisses the page's file chooser with no file. */
  cancelUpload(): Promise<void>;
}

export interface BrowserLiveWatch {
  /** The watcher has credit again: a held frame acknowledgement goes to Chromium. */
  demand(): void;
  /** Stops delivering; the last watcher of a session stops its screencast. A controller's leaving keeps the operator in control, unattended. */
  close(): void;
  /** Takeover, where the source supports it. */
  readonly control?: BrowserLiveControl;
}

/** The live side of a browser adapter, as the owner's hub uses it. */
export interface BrowserLivePort {
  /** The sessions opened by any of `taskIds`, open or inactive, as they stand now. */
  sessions(scope: { readonly workspaceId: string; readonly taskIds: readonly string[] }): readonly BrowserLiveSessionInfo[];
  /**
   * Starts (or joins) the session's screencast. The sink first gets the
   * session's state, then its stored thumbnail as a `thumbnail` frame when it
   * has one, then live messages. An unknown session gets `ended`.
   */
  watch(sessionId: string, options: { readonly maxWidth: number; readonly quality: number }, sink: BrowserLiveSink): BrowserLiveWatch;
  /** Called with a session's info whenever one opens, changes state or closes, in any task. */
  onSession(listener: (workspaceId: string, info: BrowserLiveSessionInfo) => void): () => void;
  /** Called whenever who acts in a session changes; a handoff wait settles on its `agent` change. */
  onControl?(listener: (change: BrowserLiveControlChange) => void): () => void;
}

// ---------------------------------------------------------------------------
// IPC: the `browser-live` command.
// ---------------------------------------------------------------------------

export const BrowserLivePayloadSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("watch"),
    workspaceId: IdSchema,
    /** The chat's task: the watch covers it and every task under it. */
    taskId: IdSchema,
    /** One session only; every session of the task tree when absent. */
    sessionId: IdSchema.optional(),
    /** Clamped to `BROWSER_LIVE_MIN_WIDTH`..`BROWSER_LIVE_MAX_WIDTH`. */
    maxWidth: z.number().int().positive().max(4096).optional(),
  }),
  z.strictObject({ action: z.literal("ack"), subscriptionId: IdSchema, seq: z.number().int().nonnegative() }),
  z.strictObject({ action: z.literal("unwatch"), subscriptionId: IdSchema }),
  // Takeover: from the watch that holds control only — `take` makes it so.
  z.strictObject({
    action: z.literal("take"),
    subscriptionId: IdSchema,
    sessionId: IdSchema,
    /** The takeover surface's width times its pixel ratio; clamped to `BROWSER_LIVE_CONTROL_MAX_WIDTH`. */
    maxWidth: z.number().int().positive().max(8192).optional(),
    /** A phone's take: the surface's size in CSS pixels, which the page is laid out at while this watch holds it. */
    viewport: BrowserLivePhoneViewportSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("input"),
    subscriptionId: IdSchema,
    sessionId: IdSchema,
    /** Increasing per watch: a batch older than one applied is refused. */
    seq: z.number().int().nonnegative(),
    events: z.array(BrowserLiveInputEventSchema).min(1).max(BROWSER_LIVE_INPUT_MAX_EVENTS),
  }),
  z.strictObject({
    action: z.literal("select"),
    subscriptionId: IdSchema,
    sessionId: IdSchema,
    ref: z.string().min(1).max(64),
    value: z.string().max(1024),
  }),
  z.strictObject({
    action: z.literal("dialog"),
    subscriptionId: IdSchema,
    sessionId: IdSchema,
    accept: z.boolean(),
    text: z.string().max(1000).optional(),
  }),
  z.strictObject({
    action: z.literal("decline"),
    subscriptionId: IdSchema,
    sessionId: IdSchema,
    note: z.string().max(BROWSER_LIVE_NOTE_MAX).optional(),
  }),
  // Files for the page's file chooser, in order: each file's chunks from offset 0, file after file.
  z.strictObject({
    action: z.literal("upload"),
    subscriptionId: IdSchema,
    sessionId: IdSchema,
    count: z.number().int().min(1).max(BROWSER_LIVE_UPLOAD_MAX_FILES),
    index: z
      .number()
      .int()
      .min(0)
      .max(BROWSER_LIVE_UPLOAD_MAX_FILES - 1),
    name: z.string().min(1).max(255),
    type: z.string().max(127),
    size: z.number().int().nonnegative().max(BROWSER_LIVE_UPLOAD_MAX_BYTES),
    offset: z.number().int().nonnegative().max(BROWSER_LIVE_UPLOAD_MAX_BYTES),
    data: z
      .string()
      .max(BROWSER_LIVE_UPLOAD_CHUNK_CHARS)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
  /** No file after all: the page's chooser is dismissed. */
  z.strictObject({ action: z.literal("upload-cancel"), subscriptionId: IdSchema, sessionId: IdSchema }),
  z.strictObject({
    action: z.literal("release"),
    subscriptionId: IdSchema,
    sessionId: IdSchema,
    outcome: z.enum(BROWSER_LIVE_RELEASE_OUTCOMES),
    note: z.string().max(BROWSER_LIVE_NOTE_MAX).optional(),
  }),
]);
/** The takeover actions of `browser-live`; all but `take` and `decline` are accepted only from the watch in control. */
export const BROWSER_LIVE_CONTROL_ACTIONS = ["take", "input", "select", "dialog", "release", "decline", "upload", "upload-cancel"] as const;
export type BrowserLiveControlPayload = Extract<BrowserLivePayload, { readonly action: (typeof BROWSER_LIVE_CONTROL_ACTIONS)[number] }>;
/** A takeover action as a watch sends it: its subscription is the watch's own. */
export type BrowserLiveControlRequest = BrowserLiveControlPayload extends infer Payload
  ? Payload extends unknown
    ? Omit<Payload, "subscriptionId">
    : never
  : never;
export type BrowserLivePayload = z.infer<typeof BrowserLivePayloadSchema>;

/** What `browser-live watch` answers: the subscription its `live` frames carry, and the sessions it covers now. */
export const BrowserLiveWatchAnswerSchema = z.strictObject({
  subscriptionId: IdSchema,
  sessions: z.array(BrowserLiveSessionInfoSchema).max(256),
});
export type BrowserLiveWatchAnswer = z.infer<typeof BrowserLiveWatchAnswerSchema>;

/** `maxWidth` as a watch asks for it, bounded. */
export function clampLiveWidth(maxWidth: number | undefined): number {
  if (maxWidth === undefined) return BROWSER_LIVE_DEFAULT_WIDTH;
  return Math.min(BROWSER_LIVE_MAX_WIDTH, Math.max(BROWSER_LIVE_MIN_WIDTH, Math.round(maxWidth)));
}

// ------------------------------------------------------------------ the producer

/*
 * What a browser engine hands the live view, and the live view's producer
 * itself: the built-in browser implements them, and so may any engine that
 * replaces it.
 */

/** A screencast frame as the target hands it over. */
export interface LiveTargetFrame {
  readonly data: string;
  readonly metadata: BrowserLiveFrameMetadata;
  /** Tells Chromium the frame was taken, so it renders the next one. */
  ack(): void;
}

/** What the producer needs of a page: its screencast, its sensitivity, its navigations. */
export interface LiveTarget {
  screencast(
    options: { readonly maxWidth: number; readonly quality: number },
    onFrame: (frame: LiveTargetFrame) => void,
  ): Promise<{ stop(): Promise<void> }>;
  sensitivity(blockedHosts: readonly string[]): Promise<BrowserSensitiveReason | undefined>;
  /**
   * Calls `listener` on any frame's navigation, at once; for the top frame's,
   * once more with its address and title — what a person's own navigation
   * (taking over the browser) leaves showing. Answers how to stop.
   */
  onNavigated(listener: (page?: { readonly url: string; readonly title?: string }) => void): () => void;
  /**
   * Calls `listener` as soon as the page grows a field the sensitivity rules
   * look for: the check then runs at once instead of at its next
   * interval. Optional, and only a hint — the interval's check stays the
   * guarantee. Answers how to stop.
   */
  watchSensitive?(listener: () => void): Promise<() => Promise<void>>;
}

/** A `<select>` a press would open, as the host draws it. */
export interface LiveSelectInfo {
  readonly ref: string;
  readonly box?: BrowserLiveBox;
  readonly options: readonly { readonly value: string; readonly label: string; readonly selected: boolean; readonly disabled?: boolean }[];
}

/** A JavaScript dialog the page opened while a person controls it. */
export interface LiveDialogInfo {
  readonly type: "alert" | "confirm" | "prompt" | "beforeunload";
  readonly message: string;
  readonly defaultValue?: string;
}

/**
 * What takeover needs of a session, built by the adapter over the
 * session's current page: a page a person opens becomes the session's page.
 */
export interface LiveControlTarget {
  /**
   * A person takes the page: focus emulation on, its dialogs and file
   * choosers routed to `events` instead of their defaults. Answers how to
   * undo it all.
   */
  begin(events: {
    dialog(info: LiveDialogInfo): void;
    fileChooser(info: { readonly multiple: boolean; readonly accept?: string }): void;
  }): Promise<() => Promise<void>>;
  input(event: BrowserLiveInputEvent): Promise<void>;
  /**
   * Lays the page out at `viewport` (a phone's take), or back at the session's own size when `undefined`. The undo
   * `begin` answered restores it too. Optional: without it, the page keeps its size.
   */
  layout?(viewport: BrowserLivePhoneViewport | undefined): Promise<void>;
  /** The `<select>` a press at this point would open, if any. */
  selectAt(x: number, y: number): Promise<LiveSelectInfo | undefined>;
  selectOption(ref: string, value: string): Promise<void>;
  answerDialog(accept: boolean, text?: string): Promise<void>;
  /** Hands the open file chooser these files, from memory: nothing is written to disk. */
  setFiles(files: readonly { readonly name: string; readonly mimeType: string; readonly buffer: Uint8Array }[]): Promise<void>;
  /** Dismisses the open file chooser with no file. */
  dismissChooser(): Promise<void>;
}

/** A session as the adapter opens it to the live view. */
export interface LiveSessionOpening {
  /** The browser-history id: the only id a watcher sees. */
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly openedByCallId?: string;
  readonly target: LiveTarget;
  /** The workspace's no-thumbnail hosts, read at each check. */
  readonly blockedHosts: () => Promise<readonly string[]>;
  /** Takeover; without it, `take` is refused. */
  readonly control?: LiveControlTarget;
}

export type LiveActionEvent = Omit<Extract<BrowserLiveMessage, { kind: "action" }>, "kind" | "sessionId">;

/** The producer: the port the hub watches through, and the hooks the adapter reports to. */
export interface BrowserLiveSource extends BrowserLivePort {
  opened(session: LiveSessionOpening): void;
  /** The session now shows another page (a new tab it followed). */
  retarget(sessionId: string, target: LiveTarget): void;
  /** The page the session recorded: `url` raw (it is scrubbed here). */
  navigated(sessionId: string, page: { readonly url: string; readonly title?: string | undefined; readonly epoch: number }): void;
  action(sessionId: string, event: LiveActionEvent): void;
  /** The session's stored thumbnail changed: its JPEG bytes, or `undefined` when it was cleared. */
  thumbnail(sessionId: string, jpeg: Uint8Array | undefined): void;
  /** Its task ended: kept open, inactive — nothing streams but a person's takeover; watchers are told the task ended, and stay. */
  inactive(sessionId: string): void;
  /** Its task's next browser call: in use again. */
  activated(sessionId: string): void;
  closed(sessionId: string, reason: string): void;
  /**
   * The agent is about to act on the session: answers the function to call
   * when it is done. Throws `CONFLICT` while anyone but the agent acts, or a
   * take is waiting (the call becomes a handoff wait upstream).
   */
  agentCall(sessionId: string): () => void;
  /** Who acts in the session now; `undefined` for one it does not know. */
  controlState(sessionId: string): BrowserLiveControlState | undefined;
  /** How many times a person has taken the session (asked or not); 0 for one it does not know. */
  personTakes?(sessionId: string): number;
  /** The agent asked a person to act: nothing acts until someone takes it. `deadlineAt` is its wait's, shown wherever the page is taken. */
  requestHandoff(sessionId: string, deadlineAt?: string): void;
  /** The host ends a person's control or a request (a timeout, a cancelled task) with `outcome`. */
  endControl(sessionId: string, outcome: BrowserLiveControlOutcome): void;
}
