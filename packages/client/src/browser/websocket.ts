import { TaviError } from "@tavi/contracts";

import { frameTransport, type ByteChannel, type FrameTransport } from "../transport.js";

/**
 * The WHATWG `WebSocket` surface this entry uses, declared structurally: the
 * browser entry compiles with no host library, so `lib.dom`'s
 * declaration is not in scope — and a test, or a Node host, passes any
 * implementation of this shape.
 */
export interface BrowserWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
}

/** A `WebSocket` constructor, the global one by default. */
export type WebSocketConstructor = new (url: string) => BrowserWebSocket;

/** Why a WebSocket did not open: another attempt may succeed once the bridge is up. */
export class WebSocketOpenError extends Error {
  constructor(url: string) {
    super(`the WebSocket to ${url} did not open`);
    this.name = "WebSocketOpenError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/**
 * An open WebSocket as the root's byte channel. The bridge sends each frame as
 * one text message, newline-terminated as the codec writes it, so the root's
 * `frameTransport` reads the messages as the stream it reads from a socket. A
 * binary message is no frame the bridge sends: it ends the transport.
 */
export function webSocketChannel(socket: BrowserWebSocket): ByteChannel {
  const dataListeners: ((chunk: Uint8Array) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let closed = false;
  const end = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) listener();
  };
  socket.addEventListener("message", (event) => {
    if (closed) return;
    if (typeof event.data !== "string") {
      socket.close(1003, "text frames only");
      end();
      return;
    }
    const chunk = encoder.encode(event.data);
    for (const listener of dataListeners) listener(chunk);
  });
  socket.addEventListener("close", end);
  socket.addEventListener("error", end);
  return {
    write: (bytes) => {
      if (!closed) socket.send(decoder.decode(bytes));
    },
    onData: (listener) => {
      dataListeners.push(listener);
    },
    onClose: (listener) => {
      closeListeners.push(listener);
    },
    close: () => {
      socket.close(1000);
      end();
    },
  };
}

/**
 * Open a WebSocket to `url` and frame it. Rejects with `WebSocketOpenError`
 * when it closes, or errs, before it opens — a bridge that is not listening,
 * or one that refused the upgrade (a page cannot tell the two apart) — and
 * with `INVALID_INPUT`, not to be retried, when `url` is no WebSocket URL.
 */
export function openWebSocket(url: string, WebSocket: WebSocketConstructor): Promise<FrameTransport> {
  return new Promise((resolve, reject) => {
    let socket: BrowserWebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      reject(new TaviError("INVALID_INPUT", `not a WebSocket URL: ${url}`));
      return;
    }
    let settled = false;
    const refused = (): void => {
      if (settled) return;
      settled = true;
      reject(new WebSocketOpenError(url));
    };
    socket.addEventListener("error", refused);
    socket.addEventListener("close", refused);
    socket.addEventListener("open", () => {
      if (settled) return;
      settled = true;
      resolve(frameTransport(webSocketChannel(socket)));
    });
  });
}
