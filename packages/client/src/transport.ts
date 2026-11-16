import { FrameReader, encodeFrame, type IpcFrame } from "@tavi/contracts";

/**
 * A byte stream to an owner, as a host supplies it: the Unix socket
 * of `@tavi/client/node`. Chunks arrive as the host reads them, with no regard
 * for frame boundaries; `frameTransport` does the framing.
 */
export interface ByteChannel {
  write(bytes: Uint8Array): void;
  /** Called with each chunk read, in order. */
  onData(listener: (chunk: Uint8Array) => void): void;
  /** Called once, when the stream ends for any reason. */
  onClose(listener: () => void): void;
  close(): void;
}

/**
 * Frames to and from an owner.
 *
 * Every host's transport presents this one shape, so the handshake, the
 * connection and reconnect above it are written once, in the root.
 */
export interface FrameTransport {
  /** Throws when `frame` breaks the contract; a no-op once closed. */
  send(frame: IpcFrame): void;
  /** Called for each frame read, synchronously and in order. Returns the unsubscribe. */
  onFrame(listener: (frame: IpcFrame) => void): () => void;
  /**
   * Called once when the transport ends, whoever ended it, with why when this
   * side knows (a frame that broke the contract); immediately if it already has.
   */
  onClose(listener: (reason: string | undefined) => void): () => void;
  close(reason?: string): void;
  readonly closed: boolean;
}

/**
 * Newline-delimited frames over a byte channel, through the contracts' own
 * codec, so this client and the owner cannot disagree about what a frame is.
 *
 * Bytes that are not a valid frame end the transport: the frames the same chunk
 * completed before them are still delivered, then it closes with the codec's
 * reason. A listener that throws is contained, so one broken consumer cannot
 * stop the read loop for the rest.
 */
export function frameTransport(channel: ByteChannel): FrameTransport {
  const reader = new FrameReader();
  const frameListeners = new Set<(frame: IpcFrame) => void>();
  const closeListeners = new Set<(reason: string | undefined) => void>();
  let closed = false;
  let closeReason: string | undefined;

  const finish = (reason: string | undefined): void => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    frameListeners.clear();
    for (const listener of [...closeListeners]) contain(() => listener(reason));
    closeListeners.clear();
  };

  channel.onData((chunk) => {
    if (closed) return;
    const { frames, error } = reader.push(chunk);
    for (const frame of frames) {
      for (const listener of [...frameListeners]) contain(() => listener(frame));
      // A listener may close the transport mid-chunk; nothing after that is read.
      if (closed) return;
    }
    if (error !== undefined) {
      finish(error);
      channel.close();
    }
  });
  channel.onClose(() => finish(undefined));

  return {
    send(frame) {
      // Encoded before the check, so a contract violation throws even on a
      // closed transport rather than disappearing.
      const bytes = encodeFrame(frame);
      if (!closed) channel.write(bytes);
    },
    onFrame(listener) {
      if (closed) return () => undefined;
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    onClose(listener) {
      if (closed) {
        contain(() => listener(closeReason));
        return () => undefined;
      }
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    close(reason) {
      if (closed) return;
      finish(reason);
      channel.close();
    },
    get closed() {
      return closed;
    },
  };
}

/** Run a consumer's callback; its failure is its own and must not stop ours. */
export function contain(callback: () => void): void {
  try {
    callback();
  } catch {
    // Deliberately swallowed: see the callers.
  }
}
