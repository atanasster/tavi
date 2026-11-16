import { errorMessage } from "@tavi/contracts/util";

/**
 * Discord's Gateway:
 * one WebSocket, JSON without compression, on `globalThis.WebSocket` or one
 * a test injects. It keeps the session alive (heartbeats, a zombie closed and
 * resumed), identifies within a daily budget, resumes where it can and
 * identifies again where it must, backs off between attempts, and never
 * retries a close that says the token or the application's settings are
 * wrong. Dispatches are handed over one at a time, in order; one whose
 * handler fails is replayed by resuming from the last one handled.
 */

/** What the Gateway needs of a WebSocket: the browser shape Node's global and the test's fake share. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { readonly code: number; readonly reason?: string }) => void): void;
  addEventListener(type: "open" | "error", listener: (event: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface GatewayClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly random: () => number;
}

/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES: no privileged intent. */
export const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12);
/**
 * MESSAGE_CONTENT, privileged: asked for only when the application has it on,
 * or Discord closes the session (4014). Without it Discord withholds a room
 * message's text unless it mentions the bot's user, so one that names the
 * bot by its role, or replies to it, comes with no words to ask.
 */
export const MESSAGE_CONTENT_INTENT = 1 << 15;
/** Opting in to channel-id obfuscation before it becomes mandatory. */
const IDENTIFY_CAPABILITIES = 1 << 15;
/** How many identifies a day the client allows itself, and below how many of Discord's it refuses. */
export const IDENTIFY_BUDGET_PER_DAY = 50;
const SESSION_STARTS_FLOOR = 5;
/** Gateway sends per 60 s, against Discord's 120. */
export const SENDS_PER_MINUTE = 110;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The close this client makes to resume (a zombie, a reconnect asked for, a replay): never 1000, which ends the session. */
const RESUME_CLOSE = 4900;

const FATAL: Readonly<Record<number, { readonly detail: string; readonly repair?: "credentials" | "provider-settings" }>> = {
  4004: { detail: "Discord refused the bot token", repair: "credentials" },
  4010: { detail: "Discord refused the shard it was sent" },
  4011: { detail: "the bot is in too many servers for one connection (sharding is required)" },
  4012: { detail: "Discord refused the Gateway version" },
  4013: { detail: "Discord refused the intents asked for", repair: "provider-settings" },
  4014: { detail: "the bot asks for an intent its application does not have turned on", repair: "provider-settings" },
};
/** Closes after which the session may be resumed. */
const RESUMABLE = new Set([4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009, RESUME_CLOSE, 1006]);

export interface GatewayDispatch {
  readonly t: string;
  readonly d: unknown;
  readonly s: number;
}

export type GatewayState =
  | { readonly state: "connecting" }
  /** `guildIds`: the servers READY listed (none on a resume), whose GUILD_CREATE that follows is the bot coming online, not joining. */
  | {
      readonly state: "ready";
      readonly botUserId: string;
      readonly applicationId: string;
      readonly resumed: boolean;
      readonly guildIds: readonly string[];
    }
  | { readonly state: "reconnecting"; readonly detail: string }
  | { readonly state: "failed"; readonly detail: string; readonly repair?: "credentials" | "provider-settings" };

export interface GatewayOptions {
  readonly token: string;
  readonly intents?: number;
  /** The application's identifies in the last day, shared across its connections' starts; a fresh log when absent. */
  readonly identifies?: number[];
  /** `GET /gateway/bot`: where to connect, and how many session starts Discord still allows. */
  readonly gatewayBot: () => Promise<{ readonly url: string; readonly sessionStartsRemaining: number }>;
  readonly webSocket: WebSocketFactory;
  readonly clock: GatewayClock;
  /** Each dispatch but READY and RESUMED, one at a time, in order; a throw replays it by resuming. */
  readonly onDispatch: (dispatch: GatewayDispatch) => Promise<void>;
  /**
   * Each such dispatch as it arrives, before any earlier one is done with: for
   * what cannot wait its turn (an interaction's 3 s acknowledgement).
   * Not awaited. A dispatch already handled is not seen again; one replayed
   * after a failure before it was handled is, so what it starts must be once.
   */
  readonly onArrival?: (dispatch: GatewayDispatch) => void;
  readonly onState: (state: GatewayState) => void;
}

interface Frame {
  readonly op: number;
  readonly d?: unknown;
  readonly s?: number | null;
  readonly t?: string | null;
}

/** `value` as a Gateway payload, when it has the shape of one (`d` is each opcode's own to read). */
function frameOf(value: unknown): Frame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { op, s, t } = value as { readonly op?: unknown; readonly s?: unknown; readonly t?: unknown };
  if (typeof op !== "number" || !Number.isInteger(op)) return undefined;
  if (s !== undefined && s !== null && typeof s !== "number") return undefined;
  if (t !== undefined && t !== null && typeof t !== "string") return undefined;
  return value as Frame;
}

export class Gateway {
  readonly #options: GatewayOptions;
  #socket: WebSocketLike | undefined;
  #stopped = false;
  #sessionId: string | undefined;
  #resumeUrl: string | undefined;
  /** The last sequence number received, which heartbeats carry. */
  #seq: number | null = null;
  /** The last sequence number whose dispatch was handled: where a replay resumes from. */
  #handled: number | null = null;
  /** How long the next resume waits after a dispatch could not be handled: 1 s doubling to 60 s, reset once one is. */
  #replayBackoffMs = 1000;
  #heartbeat: unknown;
  #interval = 0;
  #awaitingAck = false;
  #reconnect: unknown;
  #backoffMs = 1000;
  /** Whether the last connection reached READY or RESUMED: only then is the next attempt made at once. */
  #healthy = false;
  #botUserId = "";
  #applicationId = "";
  /** When this application identified in the last day: shared by every Gateway of it this run (Discord allows 50 a day). */
  readonly #identifies: number[];
  #sends: number[] = [];
  #outbox: string[] = [];
  #flush: unknown;
  /** The dispatches waiting to be handed over, in order. */
  #queue: Promise<void> = Promise.resolve();
  /** Settles once READY (or RESUMED) arrives, or the connection fails for good. */
  #ready: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | undefined;

  constructor(options: GatewayOptions) {
    this.#options = options;
    this.#identifies = options.identifies ?? [];
  }

  /**
   * Connects and waits for READY; rejects on a fatal close, a refused identify
   * budget, a failure to reach Discord before the first READY, or `stop()`.
   */
  async start(): Promise<void> {
    this.#stopped = false;
    let resolve = (): void => {};
    let reject = (_error: Error): void => {};
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.#ready = { promise, resolve, reject };
    await this.#connect(false);
    await promise;
  }

  /** Closes for good: no reconnect, and the session ends. */
  stop(): void {
    this.#stopped = true;
    this.#ready?.reject(new Error("the Gateway was stopped before it was ready"));
    this.#clear(this.#heartbeat);
    this.#clear(this.#reconnect);
    this.#clear(this.#flush);
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000, "stopping");
  }

  #clear(handle: unknown): void {
    if (handle !== undefined) this.#options.clock.clearTimeout(handle);
  }

  async #connect(resume: boolean): Promise<void> {
    if (this.#stopped) return;
    this.#options.onState({ state: "connecting" });
    let url: string;
    if (resume && this.#resumeUrl !== undefined && this.#sessionId !== undefined) url = this.#resumeUrl;
    else {
      let gateway: { readonly url: string; readonly sessionStartsRemaining: number };
      try {
        gateway = await this.#options.gatewayBot();
      } catch (error) {
        const detail = `Discord's Gateway address could not be read: ${errorMessage(error)}`;
        // A refused token is not tried again: its operator repairs it.
        const repair = (error as { readonly repair?: unknown } | null)?.repair;
        if (repair === "credentials" || repair === "provider-settings") this.#fail(detail, repair);
        else this.#retry(detail);
        return;
      }
      if (gateway.sessionStartsRemaining <= SESSION_STARTS_FLOOR) {
        this.#fail(
          `Discord allows only ${String(gateway.sessionStartsRemaining)} more session starts today; the connection waits for tomorrow's`,
        );
        return;
      }
      url = gateway.url;
    }
    const socket = this.#options.webSocket(`${url.replace(/\/+$/, "")}/?v=10&encoding=json`);
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      this.#receive(typeof event.data === "string" ? event.data : String(event.data));
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#closed(event.code);
    });
  }

  #receive(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    // A frame that is not a Gateway payload is dropped, as one that does not parse is.
    const frame = frameOf(parsed);
    if (frame === undefined) return;
    switch (frame.op) {
      case 10:
        this.#hello(frame.d);
        return;
      case 11:
        this.#awaitingAck = false;
        return;
      case 1:
        this.#beat();
        return;
      case 7:
        this.#abandon(this.#socket, RESUME_CLOSE);
        return;
      case 9:
        this.#invalidSession(frame.d === true);
        return;
      case 0:
        this.#dispatch(frame);
        return;
      default:
        return;
    }
  }

  #hello(data: unknown): void {
    const interval = (data as { readonly heartbeat_interval?: unknown } | undefined)?.heartbeat_interval;
    this.#interval = typeof interval === "number" && interval > 0 ? interval : 41_250;
    this.#awaitingAck = false;
    this.#clear(this.#heartbeat);
    // The first beat at a random point in the interval, so many clients reconnecting together spread out.
    this.#heartbeat = this.#options.clock.setTimeout(() => this.#tick(), this.#interval * this.#options.clock.random());
    if (this.#sessionId !== undefined && this.#seq !== null) {
      this.#send({ op: 6, d: { token: this.#options.token, session_id: this.#sessionId, seq: this.#handled ?? this.#seq } });
      return;
    }
    this.#identify();
  }

  #identify(): void {
    const now = this.#options.clock.now();
    // Pruned in place: the log is the application's, not this connection's.
    this.#identifies.splice(0, this.#identifies.length, ...this.#identifies.filter((at) => now - at < DAY_MS));
    if (this.#identifies.length >= IDENTIFY_BUDGET_PER_DAY) {
      this.#fail(
        `the connection identified ${String(IDENTIFY_BUDGET_PER_DAY)} times in a day; it stops rather than risk Discord resetting the token`,
      );
      return;
    }
    this.#identifies.push(now);
    this.#send({
      op: 2,
      d: {
        token: this.#options.token,
        intents: this.#options.intents ?? DISCORD_INTENTS,
        properties: { os: process.platform, browser: "tavi", device: "tavi" },
        capabilities: IDENTIFY_CAPABILITIES,
      },
    });
  }

  #tick(): void {
    if (this.#awaitingAck) {
      // No ack since the last beat: a zombie connection, closed so the session resumes on a fresh one.
      this.#abandon(this.#socket, RESUME_CLOSE);
      return;
    }
    this.#beat();
    this.#heartbeat = this.#options.clock.setTimeout(() => this.#tick(), this.#interval);
  }

  #beat(): void {
    this.#awaitingAck = true;
    this.#send({ op: 1, d: this.#seq });
  }

  #invalidSession(resumable: boolean): void {
    if (!resumable) this.#forgetSession();
    // Discord asks for 1–5 s before identifying again.
    this.#abandon(this.#socket, RESUME_CLOSE, resumable ? undefined : 1000 + Math.floor(this.#options.clock.random() * 4000));
  }

  #forgetSession(): void {
    this.#sessionId = undefined;
    this.#resumeUrl = undefined;
    this.#seq = null;
    this.#handled = null;
  }

  /**
   * Closes a socket this client is done with and goes on at once, never
   * waiting for its close event: nothing more of it is read, so no dispatch
   * after a failed one is handed over before the replay. Only the current
   * socket: one already left is nothing to do.
   */
  #abandon(socket: WebSocketLike | undefined, code: number, delayMs?: number): void {
    if (socket === undefined || this.#socket !== socket) return;
    this.#socket = undefined;
    socket.close(code, "resuming");
    this.#closed(code, delayMs);
  }

  #dispatch(frame: Frame): void {
    if (typeof frame.s === "number") this.#seq = frame.s;
    const type = frame.t ?? "";
    if (type === "READY") {
      const data = frame.d as
        | {
            readonly session_id?: unknown;
            readonly resume_gateway_url?: unknown;
            readonly user?: { readonly id?: unknown };
            readonly application?: { readonly id?: unknown };
            readonly guilds?: unknown;
          }
        | undefined;
      const guildIds = Array.isArray(data?.guilds)
        ? data.guilds.flatMap((guild: unknown) =>
            typeof (guild as { readonly id?: unknown } | null)?.id === "string" ? [String((guild as { readonly id: string }).id)] : [],
          )
        : [];
      this.#sessionId = typeof data?.session_id === "string" ? data.session_id : undefined;
      this.#resumeUrl = typeof data?.resume_gateway_url === "string" ? data.resume_gateway_url : undefined;
      this.#handled = this.#seq;
      this.#backoffMs = 1000;
      this.#healthy = true;
      this.#botUserId = String(data?.user?.id ?? "");
      this.#applicationId = String(data?.application?.id ?? "");
      this.#options.onState({ state: "ready", botUserId: this.#botUserId, applicationId: this.#applicationId, resumed: false, guildIds });
      this.#ready?.resolve();
      return;
    }
    if (type === "RESUMED") {
      this.#backoffMs = 1000;
      this.#healthy = true;
      this.#options.onState({
        state: "ready",
        botUserId: this.#botUserId,
        applicationId: this.#applicationId,
        resumed: true,
        guildIds: [],
      });
      this.#ready?.resolve();
      return;
    }
    if (typeof frame.s !== "number") return;
    const dispatch: GatewayDispatch = { t: type, d: frame.d, s: frame.s };
    const socket = this.#socket;
    if (this.#handled === null || dispatch.s > this.#handled) {
      try {
        this.#options.onArrival?.(dispatch);
      } catch {
        /* What cannot wait is best effort: the dispatch is still handed over in its turn. */
      }
    }
    this.#queue = this.#queue.then(async () => {
      // A replay is on its way: what arrived on the old socket after a failure is handed over again from there.
      if (this.#socket !== socket || (this.#handled !== null && dispatch.s <= this.#handled)) return;
      try {
        await this.#options.onDispatch(dispatch);
        this.#handled = dispatch.s;
        this.#replayBackoffMs = 1000;
      } catch {
        // Not handled: resume from the last one that was, and Discord replays this one and what followed it —
        // after a wait that doubles while it keeps failing, so a fault that lasts never makes a loop of resumes.
        const wait = Math.round(this.#replayBackoffMs * (0.5 + this.#options.clock.random() / 2));
        this.#replayBackoffMs = Math.min(this.#replayBackoffMs * 2, 60_000);
        this.#abandon(socket, RESUME_CLOSE, wait);
      }
    });
  }

  #closed(code: number, delayMs?: number): void {
    this.#clear(this.#heartbeat);
    this.#clear(this.#flush);
    this.#flush = undefined;
    this.#outbox = [];
    if (this.#stopped) return;
    const fatal = FATAL[code];
    if (fatal !== undefined) {
      this.#fail(fatal.detail, fatal.repair);
      return;
    }
    const resumable = RESUMABLE.has(code) && this.#sessionId !== undefined;
    if (!resumable) this.#forgetSession();
    this.#retry(`the Gateway closed (${String(code)})`, resumable, delayMs);
  }

  #retry(detail: string, resume = false, delayMs?: number): void {
    if (this.#stopped) return;
    // Never ready yet: start() says so, and its caller decides when to try again.
    if (this.#ready !== undefined && !this.#everReady) {
      this.#fail(detail);
      return;
    }
    this.#options.onState({ state: "reconnecting", detail });
    // After a healthy connection the next attempt goes at once; after a failed one, 1 s doubling to 60 s, with jitter.
    const backoff = Math.round(this.#backoffMs * (0.5 + this.#options.clock.random() / 2));
    const delay = delayMs ?? (this.#healthy ? 0 : backoff);
    if (!this.#healthy) this.#backoffMs = Math.min(this.#backoffMs * 2, 60_000);
    this.#healthy = false;
    this.#reconnect = this.#options.clock.setTimeout(() => void this.#connect(resume), delay);
  }

  /** Whether a READY ever arrived on this run: before it, a failure fails start(). */
  get #everReady(): boolean {
    return this.#botUserId !== "";
  }

  #fail(detail: string, repair?: "credentials" | "provider-settings"): void {
    this.#stopped = true;
    this.#clear(this.#heartbeat);
    this.#clear(this.#reconnect);
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000, "failed");
    this.#options.onState({ state: "failed", detail, ...(repair === undefined ? {} : { repair }) });
    this.#ready?.reject(Object.assign(new Error(detail), repair === undefined ? {} : { repair }));
  }

  /** Sends a frame within the 110-a-minute limit; past it, frames wait their turn. */
  #send(frame: Frame): void {
    this.#outbox.push(JSON.stringify(frame));
    this.#drain();
  }

  #drain(): void {
    const now = this.#options.clock.now();
    this.#sends = this.#sends.filter((at) => now - at < MINUTE_MS);
    while (this.#outbox.length > 0 && this.#sends.length < SENDS_PER_MINUTE) {
      const next = this.#outbox.shift();
      if (next === undefined) break;
      this.#sends.push(now);
      this.#socket?.send(next);
    }
    if (this.#outbox.length > 0 && this.#flush === undefined) {
      this.#flush = this.#options.clock.setTimeout(
        () => {
          this.#flush = undefined;
          this.#drain();
        },
        MINUTE_MS - (now - (this.#sends[0] ?? now)),
      );
    }
  }
}
