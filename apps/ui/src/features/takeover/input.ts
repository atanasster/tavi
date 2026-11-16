import {
  BROWSER_LIVE_INPUT_MAX_BATCHES_PER_SECOND,
  BROWSER_LIVE_INPUT_MAX_EVENTS,
  BROWSER_LIVE_INPUT_MAX_TEXT,
  BROWSER_LIVE_UPLOAD_CHUNK_CHARS,
  BROWSER_LIVE_UPLOAD_MAX_BYTES,
  BROWSER_LIVE_UPLOAD_MAX_FILES,
  refusedShortcut,
  type BrowserLiveFrameMetadata,
  type BrowserLiveInputEvent,
} from "@tavi/contracts";

import { delay } from "../../lib/delay.js";

/**
 * The takeover surface's input: what the
 * person does over the page's picture, as the events the owner applies to the
 * page. Pure, so it is tested without a browser; and it keeps nothing — a
 * batch is sent and forgotten.
 */

type Modifiable = { readonly altKey: boolean; readonly ctrlKey: boolean; readonly metaKey: boolean; readonly shiftKey: boolean };

/** The DevTools modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
function modifiersOf(event: Modifiable): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

/**
 * A key as the page should receive it, or `undefined` for one it must not:
 * a shortcut that opens, closes or switches tabs (the owner refuses them too).
 * A printable key carries its character; Enter carries `"\r"`. Escape goes to
 * the page — release is always an explicit button.
 */
export function keyEventOf(
  event: Modifiable & { readonly key: string; readonly code: string; readonly keyCode?: number },
  action: "down" | "up",
): BrowserLiveInputEvent | undefined {
  const modifiers = modifiersOf(event);
  const key = event.key.slice(0, 32);
  const printable = key.length === 1 && !event.ctrlKey && !event.metaKey;
  const text = action === "down" ? (key === "Enter" ? "\r" : printable ? key : undefined) : undefined;
  const mapped: BrowserLiveInputEvent = {
    type: "key",
    action,
    key: key === "" ? "Unidentified" : key,
    code: event.code.slice(0, 32),
    // 0 is "unknown": the page then reads the key and code alone.
    ...(event.keyCode === undefined || event.keyCode <= 0 || event.keyCode > 255 ? {} : { keyCode: event.keyCode }),
    ...(modifiers === 0 ? {} : { modifiers }),
    ...(text === undefined ? {} : { text }),
  };
  return refusedShortcut(mapped) ? undefined : mapped;
}

/**
 * Where a point over the picture is on the page, in its viewport's CSS
 * pixels: mapped through the frame's own metadata, never the image's size,
 * and kept inside the viewport.
 */
export function pagePoint(
  box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  clientX: number,
  clientY: number,
  metadata: BrowserLiveFrameMetadata,
): { readonly x: number; readonly y: number } {
  const width = metadata.deviceWidth / metadata.pageScaleFactor;
  const height = metadata.deviceHeight / metadata.pageScaleFactor;
  const relativeX = box.width <= 0 ? 0 : (clientX - box.left) / box.width;
  const relativeY = box.height <= 0 ? 0 : (clientY - box.top) / box.height;
  const clamp = (value: number, max: number): number => Math.round(Math.min(Math.max(0, max - 1), Math.max(0, value)) * 100) / 100;
  return { x: clamp(relativeX * width, width), y: clamp(relativeY * height, height) };
}

/** Text the person typed or pasted, in pieces the owner takes. */
export function textEvents(text: string): BrowserLiveInputEvent[] {
  const events: BrowserLiveInputEvent[] = [];
  for (let index = 0; index < text.length; index += BROWSER_LIVE_INPUT_MAX_TEXT)
    events.push({ type: "text", text: text.slice(index, index + BROWSER_LIVE_INPUT_MAX_TEXT) });
  return events;
}

/**
 * Gathers events into batches, in order: at most `BROWSER_LIVE_INPUT_MAX_EVENTS`
 * a batch and one batch every `1000 / BROWSER_LIVE_INPUT_MAX_BATCHES_PER_SECOND`
 * ms (a little slower, to stay inside the owner's limit). A run of mouse
 * moves with nothing between them keeps only the last. Each batch is sent
 * after the one before it answered.
 */
export class InputBatcher {
  #pending: BrowserLiveInputEvent[] = [];
  #seq = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sending: Promise<void> = Promise.resolve();
  #closed = false;
  /** When the last batch was taken from the queue: what a burst of late timers would otherwise take at once. */
  #lastSent = Number.NEGATIVE_INFINITY;
  /** When the last batch actually went: the owner counts sends, so they are spaced here, after any slow answer too. */
  #sentAt = Number.NEGATIVE_INFINITY;
  readonly #send: (events: readonly BrowserLiveInputEvent[], seq: number) => Promise<void>;
  readonly #intervalMs: number;

  constructor(
    send: (events: readonly BrowserLiveInputEvent[], seq: number) => Promise<void>,
    intervalMs = Math.ceil(1000 / BROWSER_LIVE_INPUT_MAX_BATCHES_PER_SECOND) + 5,
  ) {
    this.#send = send;
    this.#intervalMs = intervalMs;
  }

  push(event: BrowserLiveInputEvent): void {
    if (this.#closed) return;
    const last = this.#pending.at(-1);
    if (event.type === "mouse" && event.action === "move" && last?.type === "mouse" && last.action === "move")
      this.#pending[this.#pending.length - 1] = event;
    else this.#pending.push(event);
    this.#timer ??= setTimeout(() => this.flush(), this.#intervalMs);
  }

  /** Sends what is waiting now, one batch at a time, never sooner than the interval after the last; the rest waits. */
  flush(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#pending.length === 0) return this.#sending;
    const wait = this.#lastSent + this.#intervalMs - Date.now();
    if (wait > 0) {
      this.#timer = setTimeout(() => this.flush(), wait);
      return this.#sending;
    }
    this.#lastSent = Date.now();
    const batch = this.#pending.splice(0, BROWSER_LIVE_INPUT_MAX_EVENTS);
    this.#seq += 1;
    const seq = this.#seq;
    this.#sending = this.#sending
      .then(async () => {
        const gap = this.#sentAt + this.#intervalMs - Date.now();
        if (gap > 0) await delay(gap);
        this.#sentAt = Date.now();
        await this.#send(batch, seq);
      })
      // Best effort: input sent to a page that is gone has nowhere to go.
      .catch(() => undefined);
    if (this.#pending.length > 0) this.#timer = setTimeout(() => this.flush(), this.#intervalMs);
    return this.#sending;
  }

  /** Sends everything waiting, at the pace above, and answers once the last batch was answered. */
  async drain(): Promise<void> {
    while (this.#pending.length > 0 && !this.#closed) {
      const wait = this.#lastSent + this.#intervalMs - Date.now();
      if (wait > 0) await delay(wait);
      await this.flush();
    }
    await this.#sending;
  }

  /** Drops what was not sent: nothing typed outlives the takeover. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = [];
  }
}

/** The mouse button a pointer event names. */
export function buttonOf(button: number): "left" | "middle" | "right" {
  return button === 1 ? "middle" : button === 2 ? "right" : "left";
}

/** "1 m 12 s", "45 s": how long a person had the page. */
export function formatControlled(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds} s` : `${minutes} m ${seconds % 60} s`;
}

/** "14:32": time left to a deadline. */
export function formatLeft(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Raw bytes in one upload chunk: their base64 fits `BROWSER_LIVE_UPLOAD_CHUNK_CHARS`. */
const UPLOAD_CHUNK_BYTES = (BROWSER_LIVE_UPLOAD_CHUNK_CHARS / 4) * 3;

/** A file's bytes as the upload's base64 chunks, each with its offset. An empty file is one empty chunk. */
export function uploadChunks(bytes: Uint8Array, chunkBytes = UPLOAD_CHUNK_BYTES): { readonly offset: number; readonly data: string }[] {
  const chunks: { offset: number; data: string }[] = [];
  for (let offset = 0; offset < bytes.length || offset === 0; offset += chunkBytes) {
    const piece = bytes.subarray(offset, offset + chunkBytes);
    let binary = "";
    // In slices: a spread of a whole chunk would overflow the call stack.
    for (let index = 0; index < piece.length; index += 8192) binary += String.fromCharCode(...piece.subarray(index, index + 8192));
    chunks.push({ offset, data: btoa(binary) });
    if (bytes.length === 0) break;
  }
  return chunks;
}

/** Why these files cannot be handed over, or `undefined` when they can. */
export function uploadRefusal(files: readonly { readonly size: number }[], multiple: boolean): string | undefined {
  if (files.length === 0) return "No file was chosen.";
  if (!multiple && files.length > 1) return "The page takes one file.";
  if (files.length > BROWSER_LIVE_UPLOAD_MAX_FILES) return `At most ${BROWSER_LIVE_UPLOAD_MAX_FILES} files at once.`;
  if (files.reduce((total, file) => total + file.size, 0) > BROWSER_LIVE_UPLOAD_MAX_BYTES)
    return `At most ${BROWSER_LIVE_UPLOAD_MAX_BYTES / (1024 * 1024)} MiB of files.`;
  return undefined;
}
