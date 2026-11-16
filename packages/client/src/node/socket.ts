import { createConnection, type Socket } from "node:net";

import { IPC_RETRYABLE_CONNECT_CODES } from "@tavi/contracts";

import { frameTransport, type ByteChannel, type FrameTransport } from "../transport.js";

/** A connected socket as the root's byte channel. */
export function socketChannel(socket: Socket): ByteChannel {
  return {
    write: (bytes) => {
      socket.write(bytes);
    },
    // A `Buffer` is a `Uint8Array`; the codec copies whatever it keeps.
    onData: (listener) => {
      socket.on("data", (chunk: Buffer) => listener(chunk));
    },
    onClose: (listener) => {
      socket.once("close", () => listener());
    },
    close: () => {
      socket.destroy();
    },
  };
}

/** How `openSocket` connects. */
export interface OpenSocketOptions {
  /**
   * Called with the endpoint before connecting; a throw refuses it, and the
   * cookie is never sent. On Windows the caller checks here that the named
   * pipe is owned by its own account, which this package cannot ask Windows;
   * without it, a named pipe is refused there (`refuseUncheckedPipe`).
   */
  readonly verify?: (endpoint: string) => void;
}

/**
 * The default `verify`: on Windows a named pipe whose owner nobody checked is
 * refused, so a caller that forgets the check sends its cookie nowhere, as
 * `readOwner` refuses every publication there without `privacyProblem`.
 */
export function refuseUncheckedPipe(endpoint: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32" && /^\\\\[.?]\\pipe\\/i.test(endpoint))
    throw new Error(`refusing the pipe ${endpoint}: its owner was not checked (pass openSocket's verify)`);
}

/**
 * Connect to an owner's endpoint — a Unix socket, or a named pipe on Windows —
 * and frame it. Rejects with the socket's own error, whose `code` says whether
 * another attempt could help (`isRetryableSocketError`), or with `verify`'s.
 */
export function openSocket(endpoint: string, options: OpenSocketOptions = {}): Promise<FrameTransport> {
  return new Promise((resolve, reject) => {
    (options.verify ?? refuseUncheckedPipe)(endpoint);
    const socket = createConnection(endpoint);
    const refused = (error: Error): void => reject(error);
    socket.once("error", refused);
    socket.once("connect", () => {
      socket.off("error", refused);
      // Once connected, an error is followed by `close`, which ends the
      // transport; unheard, it would be thrown from the socket instead.
      socket.on("error", () => undefined);
      resolve(frameTransport(socketChannel(socket)));
    });
  });
}

/**
 * Errors of the "the owner is not there yet" kind (`IPC_RETRYABLE_CONNECT_CODES`):
 * the endpoint of an owner that is restarting answers with one of these until
 * the new owner binds.
 */
export function isRetryableSocketError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && IPC_RETRYABLE_CONNECT_CODES.includes(code);
}
