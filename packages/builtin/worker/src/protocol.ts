/**
 * The worker protocol: length-prefixed JSON
 * frames on the worker's stdin and stdout, a 4-byte big-endian length, then
 * that many bytes of UTF-8 JSON. Shared by the owner's shim and the worker;
 * imports nothing, so the worker bundle stays one file.
 */

export const PROTOCOL_VERSION = 1;
/** The largest frame either side accepts: a tool's input or result, a hook's snapshot. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** The largest value one `state.put` stores. */
export const MAX_STATE_BYTES = 256 * 1024;

export type WireError = { readonly code: string; readonly message: string; readonly details?: Record<string, unknown> };

/** Who a tool call is for and whether anyone attends it: its handler's third argument. */
export type CallContext = { readonly principalId: string; readonly workspaceId: string; readonly unattended: boolean };

/** The owner to the worker. */
export type OwnerMessage =
  | {
      readonly t: "hello";
      readonly protocol: number;
      readonly pluginId: string;
      readonly version: string;
      readonly contentHash: string;
      readonly entryUrl: string;
      readonly config: Record<string, unknown>;
      readonly rawSecrets: readonly string[];
      /** Credential settings whose placeholder the worker's environment holds, by setting key. */
      readonly maskedEnv: Record<string, string>;
      /** Every credential setting the manifest declares: one with no value set reads as null, not as undeclared. */
      readonly credentials?: readonly string[];
      /** The workspace's language (`ctx.locale`) at the worker's start; a `locale` message follows each change. */
      readonly locale?: string;
      /** The plugin's own messages by language, from its approved language packs (`ctx.t`). */
      readonly messages?: Record<string, Record<string, unknown>>;
    }
  /** The workspace's language changed: `ctx.locale` reads it from now on. */
  | { readonly t: "locale"; readonly locale: string }
  /** `noNetwork`: the tool's manifest declares sink `none`, so the worker refuses any request the call makes. */
  | {
      readonly t: "call";
      readonly id: number;
      readonly op: "tool" | "before";
      readonly name: string;
      readonly input: unknown;
      readonly noNetwork?: true;
      readonly context?: CallContext;
    }
  | { readonly t: "call"; readonly id: number; readonly op: "hook"; readonly index: number; readonly input: unknown }
  /** One collection of a heartbeat signal source the worker provided. */
  | {
      readonly t: "call";
      readonly id: number;
      readonly op: "collect";
      readonly name: string;
      readonly input: { readonly workspaceId: string; readonly principalId: string; readonly now: string; readonly timezone: string };
    }
  | {
      readonly t: "call";
      readonly id: number;
      readonly op: "command";
      readonly name: string;
      readonly input: { readonly envelope: unknown; readonly args: string };
    }
  | { readonly t: "cancel"; readonly id: number }
  | { readonly t: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly t: "reply"; readonly id: number; readonly ok: false; readonly error: WireError }
  | { readonly t: "stop" };

/** The worker to the owner. */
export type WorkerMessage =
  | {
      readonly t: "ready";
      readonly protocol: number;
      readonly pluginId: string;
      readonly contentHash: string;
      readonly registrations: {
        readonly tools: readonly {
          readonly name: string;
          readonly inputJsonSchema: Record<string, unknown>;
          readonly beforeCall: boolean;
        }[];
        readonly hooks: readonly { readonly event: string; readonly match?: unknown }[];
        readonly commands: readonly string[];
        readonly signalSources: readonly { readonly id: string; readonly retracts?: false }[];
      };
    }
  | { readonly t: "failed"; readonly error: WireError }
  | { readonly t: "reply"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly t: "reply"; readonly id: number; readonly ok: false; readonly error: WireError }
  | { readonly t: "request"; readonly id: number; readonly op: "state.load" }
  | { readonly t: "request"; readonly id: number; readonly op: "state.put"; readonly namespace: string; readonly value: unknown }
  | { readonly t: "request"; readonly id: number; readonly op: "secret"; readonly key: string }
  | { readonly t: "request"; readonly id: number; readonly op: "next"; readonly call: number; readonly input?: unknown }
  | {
      readonly t: "log";
      readonly level: "debug" | "info" | "warn" | "error";
      readonly message: string;
      readonly meta?: Record<string, unknown>;
    }
  | {
      readonly t: "ui";
      readonly kind: "status" | "notice" | "publish";
      readonly envelope: unknown;
      readonly text?: string;
      readonly key?: string;
      readonly value?: unknown;
    };

/** One frame for `message`; throws when it is past `MAX_MESSAGE_BYTES`. */
export function encodeFrame(message: OwnerMessage | WorkerMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.byteLength > MAX_MESSAGE_BYTES)
    throw new Error(`a message of ${String(body.byteLength)} bytes is past the ${String(MAX_MESSAGE_BYTES)}-byte limit`);
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

/**
 * Frames out of a byte stream, whatever its chunking. A frame announced past
 * `MAX_MESSAGE_BYTES`, or one that is not JSON, ends the stream: `onError`
 * is called once and nothing more is read.
 */
export class FrameReader {
  #pending: Buffer = Buffer.alloc(0);
  #broken = false;
  readonly #onMessage: (message: unknown) => void;
  readonly #onError: (error: Error) => void;

  constructor(onMessage: (message: unknown) => void, onError: (error: Error) => void) {
    this.#onMessage = onMessage;
    this.#onError = onError;
  }

  push(chunk: Buffer): void {
    if (this.#broken) return;
    this.#pending = this.#pending.byteLength === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    while (this.#pending.byteLength >= 4) {
      const length = this.#pending.readUInt32BE(0);
      if (length > MAX_MESSAGE_BYTES)
        return this.#fail(new Error(`a frame of ${String(length)} bytes is past the ${String(MAX_MESSAGE_BYTES)}-byte limit`));
      if (this.#pending.byteLength < 4 + length) return;
      const body = this.#pending.subarray(4, 4 + length);
      this.#pending = this.#pending.subarray(4 + length);
      let message: unknown;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        return this.#fail(new Error("a frame is not JSON"));
      }
      this.#onMessage(message);
    }
  }

  #fail(error: Error): void {
    this.#broken = true;
    this.#pending = Buffer.alloc(0);
    this.#onError(error);
  }
}

/** `value` as JSON carries it: functions, `undefined` and cycles dropped (a hook's snapshot, a tool's result). */
export function snapshot(value: unknown): unknown {
  if (value === undefined) return undefined;
  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return undefined;
        seen.add(item);
      }
      return item;
    }) ?? "null",
  );
}
