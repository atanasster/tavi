/**
 * `@tavi/client/browser` — the client, for a page `tavi ui` serves.
 *
 * A superset of the root, as `@tavi/client/node` is: it re-exports everything
 * `@tavi/client` does and adds the host a page supplies — a WebSocket to the
 * bridge, the bridge's answer to "which owner", and the page's timers. Like
 * the root it imports no `node:*`, and it compiles with no host library: the
 * few platform names it uses (`WebSocket`, `fetch`, timers) are declared
 * structurally and taken from `globalThis` when first used, or passed in.
 */
import { TaviError, UI_IPC_PATH, UI_OWNER_PATH, UI_SECRET_HEADER, UiOwnerAnswerSchema } from "@tavi/contracts";

import { createClient, type ClientOptions, type Dialer, type OwnerAddress, type TaviClient } from "./client.js";
import { WebSocketOpenError, openWebSocket, type WebSocketConstructor } from "./browser/websocket.js";
import type { Scheduler } from "./scheduler.js";

export * from "./index.js";
export {
  WebSocketOpenError,
  openWebSocket,
  webSocketChannel,
  type BrowserWebSocket,
  type WebSocketConstructor,
} from "./browser/websocket.js";

/** The response surface of `fetch` this entry reads. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** The `fetch` surface this entry calls: a same-origin POST. */
export type FetchFunction = (
  url: string,
  init: { readonly method: "POST"; readonly headers: Record<string, string>; readonly credentials: "same-origin"; readonly body: string },
) => Promise<FetchResponse>;

interface HostGlobals {
  readonly WebSocket?: WebSocketConstructor;
  readonly fetch?: FetchFunction;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// This entry compiles with no host library, so `globalThis` declares none of these: the one cast, to their structural shapes.
const host = globalThis as unknown as HostGlobals;

/** The page's timers, as the root's `Scheduler`. */
export const browserScheduler: Scheduler = {
  delay(ms, callback) {
    const handle = host.setTimeout(callback, ms);
    return () => host.clearTimeout(handle);
  },
};

/** An origin: a lowercase `http`/`https` scheme and an authority, nothing after it but a trailing slash. */
const BRIDGE_ORIGIN = /^(https?):\/\/([^/?#\s]+)\/?$/;

/** Where the bridge is, and what the page holds to reach it. */
export interface BridgeOptions {
  /** The bridge's origin, as the page was served from it: `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The session secret the token exchange answered, held only in page memory. */
  readonly secret: string;
  /** `globalThis.fetch` otherwise. */
  readonly fetch?: FetchFunction;
  /** `globalThis.WebSocket` otherwise. */
  readonly WebSocket?: WebSocketConstructor;
}

/**
 * Find the owner through the bridge, and reach it over the bridge's
 * WebSocket. Discovery asks the bridge afresh before every
 * attempt: a restarted owner has a new session, which the WebSocket's `hello`
 * must name. The session secret is the handshake's token.
 *
 * `discover` answers `undefined` — no owner, try again — when the bridge
 * reaches no owner (503) or cannot be reached; it rejects, finally, when the
 * bridge refuses the session (401/403): no later attempt holds another — or
 * answers in a form this page cannot read. Throws `INVALID_INPUT` at once for
 * an `origin` that is not one.
 */
export function bridgeDialer(options: BridgeOptions): Dialer {
  // Checked here, once: a wrong origin would otherwise fail every attempt as
  // an unreachable bridge, and be reported as an outage after the back-off.
  const parsed = BRIDGE_ORIGIN.exec(options.origin);
  if (parsed === null) throw new TaviError("INVALID_INPUT", `not a bridge origin (scheme://host:port): ${options.origin}`);
  const [, scheme, authority] = parsed;
  const origin = `${scheme}://${authority}`;
  const socketUrl = `${scheme === "https" ? "wss" : "ws"}://${authority}${UI_IPC_PATH}`;
  return {
    async discover(): Promise<OwnerAddress | undefined> {
      // Bound: a page's `fetch` called off `window` throws "Illegal invocation".
      const fetch = options.fetch ?? host.fetch?.bind(globalThis);
      if (fetch === undefined) throw new TaviError("CAPABILITY_MISSING", "this host has no fetch");
      let response: FetchResponse;
      try {
        response = await fetch(`${origin}${UI_OWNER_PATH}`, {
          method: "POST",
          headers: { [UI_SECRET_HEADER]: options.secret, "content-type": "application/json" },
          credentials: "same-origin",
          body: "{}",
        });
      } catch {
        return undefined;
      }
      if (response.status === 401 || response.status === 403) {
        throw new TaviError("NOT_AUTHORIZED", "the bridge refused this page's session: open a new link from `tavi ui`");
      }
      if (!response.ok) return undefined;
      // A body that is not JSON fails the schema below, said as such.
      const answer = UiOwnerAnswerSchema.safeParse(await response.json().catch(() => undefined));
      // A bridge that answers, but not in this page's contract, is another
      // build: no later attempt reads it differently.
      if (!answer.success) {
        throw new TaviError("UNAVAILABLE", "the bridge answered in a form this page cannot read: reload it from a new `tavi ui` link");
      }
      return {
        endpoint: socketUrl,
        sessionId: answer.data.sessionId,
        protocolVersion: answer.data.protocolVersion,
        token: options.secret,
      };
    },
    open(endpoint) {
      const WebSocket = options.WebSocket ?? host.WebSocket;
      if (WebSocket === undefined) return Promise.reject(new TaviError("CAPABILITY_MISSING", "this host has no WebSocket"));
      return openWebSocket(endpoint, WebSocket);
    },
    retryable: (error) => error instanceof WebSocketOpenError,
  };
}

/**
 * A connected client of the owner `tavi ui` bridges to. Rejects as
 * `connect()` does: after every attempt failed, at once for a session the
 * bridge refused, or for an owner that speaks another protocol.
 */
export async function connectThroughBridge(
  bridge: BridgeOptions,
  options: Omit<ClientOptions, "dialer" | "scheduler"> = {},
): Promise<TaviClient> {
  const client = createClient({ ...options, dialer: bridgeDialer(bridge), scheduler: browserScheduler });
  await client.connect();
  return client;
}
