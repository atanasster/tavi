/** The socket the Discord connector's gateway drives (`@tavi/plugin-discord`'s `WebSocketLike`). */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { readonly code: number; readonly reason?: string }) => void): void;
  addEventListener(type: "open" | "error", listener: (event: unknown) => void): void;
}

/** The gateway's clock (`@tavi/plugin-discord`'s `GatewayClock`). */
export interface GatewayClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly random: () => number;
}

/**
 * An in-memory Discord Gateway: each socket the client opens is scripted from the test's side —
 * Hello, acks, dispatches, reconnect and invalid-session asks, closes — and
 * records every frame the client sends. Runs on a manual clock.
 */

export interface SentFrame {
  readonly op: number;
  readonly d?: unknown;
}

export class FakeSocket implements WebSocketLike {
  readonly url: string;
  readonly sent: SentFrame[] = [];
  closedWith: number | undefined;
  readonly #listeners = new Map<string, ((event: never) => void)[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentFrame);
  }

  close(code = 1000): void {
    if (this.closedWith !== undefined) return;
    this.closedWith = code;
    // As a real socket: the close event comes after the closing handshake, a turn or more later.
    setTimeout(() => this.#emit("close", { code }), 0);
  }

  // The server's side.
  frame(op: number, d?: unknown, s?: number, t?: string): void {
    this.#emit("message", { data: JSON.stringify({ op, d: d ?? null, s: s ?? null, t: t ?? null }) });
  }
  /** A message of exactly `text`, a malformed one too. */
  raw(text: string): void {
    this.#emit("message", { data: text });
  }
  hello(interval = 40_000): void {
    this.frame(10, { heartbeat_interval: interval });
  }
  ack(): void {
    this.frame(11);
  }
  dispatch(t: string, d: unknown, s: number): void {
    this.frame(0, d, s, t);
  }
  ready(s = 1, session = "session-1", resumeUrl = "wss://resume.discord.gg"): void {
    this.dispatch(
      "READY",
      {
        v: 10,
        session_id: session,
        resume_gateway_url: resumeUrl,
        user: { id: "900000000000000001", bot: true, username: "tavi" },
        application: { id: "900000000000000002" },
        guilds: [],
      },
      s,
    );
  }
  /** The server closes the connection with a code, as a drop (1006) or Discord's own close. */
  drop(code: number): void {
    if (this.closedWith !== undefined) return;
    this.closedWith = code;
    this.#emit("close", { code });
  }
  ops(op: number): SentFrame[] {
    return this.sent.filter((frame) => frame.op === op);
  }
}

export function fakeGateway(): { readonly sockets: FakeSocket[]; readonly webSocket: (url: string) => FakeSocket; latest(): FakeSocket } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    webSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    latest: () => {
      const socket = sockets.at(-1);
      if (socket === undefined) throw new Error("no socket was opened");
      return socket;
    },
  };
}

/** Timers run only when the test moves time on; `random` is fixed. */
export function manualClock(random = 0.5): GatewayClock & { advance(ms: number): Promise<void> } {
  let now = Date.parse("2026-10-18T00:00:00.000Z");
  let next = 0;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  return {
    now: () => now,
    random: () => random,
    setTimeout: (callback, ms) => {
      next += 1;
      timers.set(next, { at: now + Math.max(0, ms), callback });
      return next;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        // Let what the timer started (a connect, a close's event) run.
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      }
      now = until;
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    },
  };
}

/** Lets queued microtasks (a close event, a dispatch's handler) run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 500; turn += 1) await Promise.resolve();
}
