import { IPC_MAX_MESSAGE_CHARS, IpcFrameSchema, IPC_MAX_FRAME_BYTES, type IpcFrame } from "./ipc.js";

/**
 * Newline-delimited JSON frame codec.
 *
 * Deliberately platform-neutral — `Uint8Array`, `TextEncoder`/`TextDecoder`, no
 * `Buffer` and no `node:*` import — because both the runtime's server and
 * `@tavi/client` speak this format, and the client's root entry must
 * stay Node-free so a browser bundle can carry it. Two copies of a framing
 * implementation is how a client and a server drift into disagreeing about what
 * a frame is.
 *
 * The bound is enforced per **frame**, while bytes accumulate, not after a full
 * line has been buffered: every complete line and the unterminated tail are each
 * checked against the limit before they are copied, so an oversized frame is
 * refused rather than allocated. It bounds each frame, not the chunk — a legal
 * frame near the limit that arrives in the same chunk as the next frame is
 * accepted (bounding the chunk refused exactly that), and the reader still never
 * holds more than one limit's worth of unparsed bytes.
 */

const NEWLINE = 0x0a;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

export interface FrameReadResult {
  readonly frames: readonly IpcFrame[];
  /** Present when the peer's bytes are not a valid frame; the caller must close. */
  readonly error?: string;
}

export class FrameReader {
  readonly #limit: number;
  #buffer: Uint8Array = new Uint8Array(0);

  constructor(limit: number = IPC_MAX_FRAME_BYTES) {
    this.#limit = limit;
  }

  /** Feed bytes; returns every complete frame they completed. */
  push(chunk: Uint8Array): FrameReadResult {
    const frames: IpcFrame[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, start);
      if (newline === -1) break;
      // Bound before concatenating: an oversized frame must not be copied first.
      if (this.#buffer.byteLength + (newline - start) > this.#limit) {
        return { frames, error: `frame exceeded ${this.#limit} bytes` };
      }
      const body = chunk.subarray(start, newline);
      // Decoded in place when nothing was buffered: the line is not kept, so a
      // copy would only cost an allocation.
      const line = decoder.decode(this.#buffer.byteLength === 0 ? body : concat(this.#buffer, body));
      this.#buffer = new Uint8Array(0);
      start = newline + 1;
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return { frames, error: "frame was not valid JSON" };
      }
      const frame = IpcFrameSchema.safeParse(parsed);
      if (!frame.success) {
        return { frames, error: "frame did not match the IPC contract" };
      }
      frames.push(frame.data);
    }
    // The unterminated tail is the start of the next frame, bounded the same way.
    const tail = chunk.subarray(start);
    if (this.#buffer.byteLength + tail.byteLength > this.#limit) {
      return { frames, error: `frame exceeded ${this.#limit} bytes` };
    }
    this.#buffer = concat(this.#buffer, tail);
    return { frames };
  }
}

/**
 * A new array holding both — always a copy. `Uint8Array.prototype.slice` rather
 * than `right.slice()`: on a Node `Buffer` (what a socket delivers) `.slice` is a
 * *view*, so a kept tail pinned the whole socket chunk on Node while a browser
 * copied it — the per-platform difference this module exists to avoid.
 */
function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return Uint8Array.prototype.slice.call(right);
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}

/**
 * Encode a frame, validating it and bounding the serialized size.
 *
 * Validation matters as much as the size: the contract caps an error message at
 * 2000 characters, and a caller that exceeded it would otherwise make the peer
 * drop the connection and leave the request hanging.
 */
export function encodeFrame(frame: IpcFrame): Uint8Array {
  const parsed = IpcFrameSchema.safeParse(frame);
  if (!parsed.success) {
    throw new Error("refusing to send a frame that violates the IPC contract");
  }
  const encoded = encoder.encode(`${JSON.stringify(parsed.data)}\n`);
  if (encoded.byteLength > IPC_MAX_FRAME_BYTES) {
    throw new Error(`refusing to send a frame over ${IPC_MAX_FRAME_BYTES} bytes`);
  }
  return encoded;
}

/** Bound a peer-supplied message to what the contract allows. */
export function clampMessage(message: string, limit = IPC_MAX_MESSAGE_CHARS): string {
  return message.length <= limit ? message : `${message.slice(0, limit - 1)}…`;
}

/**
 * The UTF-8 size of already-serialized text — the one measurement the frame
 * codec and the event bus share, so ring and backlog accounting agree about
 * what an event costs.
 */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * The encoded size of one frame's payload, for ring and backlog accounting.
 *
 * Measured, never inferred from a schema's character bound: a 128 KiB `finalText`
 * of multi-byte characters is ~384 KiB of UTF-8 before JSON escaping, so a
 * budget computed from `.max()` lengths under-counts by an unbounded factor.
 */
export function encodedFrameBytes(frame: IpcFrame): number {
  return utf8ByteLength(JSON.stringify(frame));
}
