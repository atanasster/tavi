import { TaviError } from "@tavi/contracts";

export interface CapturedCheckpoint<T> {
  value: T;
  /** Estimated retained bytes of the input, counted during the copy. */
  bytes: number;
}

/**
 * Copy nested message fields and binary values before an asynchronous codec can observe them, counting retained bytes
 * in the same walk. The walk throws BUDGET_EXCEEDED as soon as the count passes `limit`, before copying the rest.
 * Message prototypes remain available to the pinned codec.
 */
export function captureCheckpointWithFootprint<T>(input: T, limit = Number.POSITIVE_INFINITY): CapturedCheckpoint<T> {
  const seen = new Map<object, unknown>();
  let bytes = 0;
  const count = (amount: number): void => {
    bytes += amount;
    if (bytes > limit) throw new TaviError("BUDGET_EXCEEDED", "Checkpoint serialization byte budget is full");
  };
  const walk = <V>(value: V): V => {
    if (typeof value === "string") {
      count(32 + value.length * 2);
      return value;
    }
    if (value === null || typeof value !== "object") {
      count(32);
      return value;
    }
    if (seen.has(value)) {
      count(16);
      return seen.get(value) as V;
    }
    const remember = (copy: unknown, amount: number): V => {
      seen.set(value, copy);
      count(amount);
      return copy as V;
    };
    if (value instanceof Date) return remember(new Date(value), 64);
    if (value instanceof URL) return remember(new URL(value.href), 64 + value.href.length * 2);
    if (value instanceof URLSearchParams) return remember(new URLSearchParams(value), 64 + value.toString().length * 2);
    if (value instanceof String) return remember(Object(value.valueOf()), 64 + value.valueOf().length * 2);
    if (value instanceof Number || value instanceof Boolean) return remember(Object(value.valueOf()), 64);
    if (value instanceof RegExp) {
      const copy = new RegExp(value.source, value.flags);
      copy.lastIndex = value.lastIndex;
      return remember(copy, 64 + value.source.length * 2);
    }
    if (value instanceof ArrayBuffer) {
      // Count before slicing so an oversized buffer is refused without being copied.
      count(64 + value.byteLength);
      const copy = value.slice(0);
      seen.set(value, copy);
      return copy as V;
    }
    if (ArrayBuffer.isView(value)) {
      count(64 + value.byteLength);
      const bytes = Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      let copy: unknown;
      if (value instanceof DataView) copy = new DataView(bytes.buffer);
      // Typed-array slice preserves its element type; Buffer.from owns its backing bytes.
      else if (Buffer.isBuffer(value)) copy = Buffer.from(value);
      else copy = Reflect.construct(value.constructor, [bytes.buffer]);
      seen.set(value, copy);
      return copy as V;
    }
    if (value instanceof Map) {
      const out = new Map();
      seen.set(value, out);
      count(64);
      for (const [key, item] of value) out.set(walk(key), walk(item));
      return out as V;
    }
    if (value instanceof Set) {
      const out = new Set();
      seen.set(value, out);
      count(64);
      for (const item of value) out.add(walk(item));
      return out as V;
    }
    const out: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    seen.set(value, out);
    count(64);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) continue;
      if (!("value" in descriptor)) throw new TaviError("INVALID_INPUT", "Checkpoint input cannot contain own accessors");
      walk(key);
      Object.defineProperty(out, key, { ...descriptor, value: walk(descriptor.value) });
    }
    return out as V;
  };
  const value = walk(input);
  return { value, bytes };
}

/** Copy nested message fields and binary values before an asynchronous codec can observe them. */
export function captureCheckpoint<T>(value: T): T {
  return captureCheckpointWithFootprint(value).value;
}
