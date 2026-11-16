/**
 * Small helpers every package writes the same way: an error's message, a
 * record check, the JSON object in a model's answer, the current instant, a
 * comma list, a counted noun, a clipped string, an object without its
 * undefined fields, a provider's typed failure, and a `Retry-After` header as a
 * wait. Zod-free and free of Node
 * and DOM APIs, so a browser bundle or a plugin can import them without the
 * contracts barrel.
 */

/** `error`'s message when it is an `Error`; otherwise `fallback`, or `String(error)` when none is given. */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return error.message;
  return fallback ?? String(error);
}

/** Whether `value` is a non-null object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The current instant, ISO-8601 UTC with millisecond precision. */
export const nowTimestamp = (): string => new Date().toISOString();

/**
 * The JSON object a model's answer carries, from its first `{` to its last `}`,
 * so prose or a code fence around it is read past; `undefined` when there is
 * none or it does not parse.
 */
export function jsonObjectIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** The comma-separated items of `value`, each trimmed, empty ones dropped; none when `value` is not a string. */
export function csvList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** `count` and its noun: `one` for exactly 1, otherwise `many` (`one` with an `s` unless given). */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface ClipOptions {
  /** Count (and cut at) code points rather than UTF-16 code units. */
  readonly codePoints?: boolean;
  /** Fold every run of white space to one space and trim, before measuring. */
  readonly squeeze?: boolean;
}

/**
 * `text` when it is at most `max` long; otherwise its start and an ellipsis,
 * `max` long in all (the ellipsis alone when `max` is under 2). A cut in code
 * units never ends on half of a surrogate pair (the result is one shorter instead).
 */
export function clip(text: string, max: number, options: ClipOptions = {}): string {
  const source = options.squeeze === true ? text.replace(/\s+/g, " ").trim() : text;
  const keep = Math.max(0, max - 1);
  if (options.codePoints === true) {
    const points = Array.from(source);
    return points.length <= max ? source : `${points.slice(0, keep).join("")}…`;
  }
  if (source.length <= max) return source;
  const last = source.charCodeAt(keep - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep;
  return `${source.slice(0, end)}…`;
}

/** `T` without the `undefined` its fields may hold: a field that may be undefined becomes optional. */
export type DefinedOnly<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} extends infer Merged
  ? { [K in keyof Merged]: Merged[K] }
  : never;

/**
 * A copy of `value` without its undefined fields, in order: what a run of
 * `...(x === undefined ? {} : { x })` spreads builds, for an
 * `exactOptionalPropertyTypes` object. `null` is kept; string keys only.
 */
export function definedOnly<T extends object>(value: T): DefinedOnly<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as DefinedOnly<T>;
}

/** A provider's typed failure: the message is the reason alone, so it carries nothing of the provider's own. */
export interface ProviderError<Reason extends string> extends Error {
  readonly reason: Reason;
}

export interface ProviderErrorConstructor<Reason extends string> {
  new (reason: Reason): ProviderError<Reason>;
  readonly prototype: ProviderError<Reason>;
}

/**
 * A fresh `ProviderError` class for one provider kind, to extend under its
 * own name: each call is a distinct class, so one kind's failure is never
 * `instanceof` another's.
 */
export function defineProviderError<Reason extends string>(): ProviderErrorConstructor<Reason> {
  return class extends Error {
    readonly reason: Reason;
    constructor(reason: Reason) {
      super(reason);
      this.reason = reason;
    }
  };
}

/**
 * Where a page of `text` from `offset` ends: at most `maxChars` characters and
 * `maxBytes` bytes of UTF-8, and never between a surrogate pair's halves. A
 * page is at least one character while any is left, so paging always moves on.
 */
export function textPageEnd(text: string, offset: number, maxChars: number, maxBytes: number): number {
  let end = Math.min(text.length, offset + maxChars);
  // Brought under the byte budget by trimming the overshoot a tenth at a time.
  // Counted with a TextEncoder, not Node's Buffer: this module is the browser's too.
  const encoder = new TextEncoder();
  while (end > offset + 1 && encoder.encode(text.slice(offset, end)).length > maxBytes) end = offset + Math.floor((end - offset) * 0.9);
  if (end < text.length && end > offset + 1 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
  return end;
}

/** The longest a source or a provider may ask Tavi to wait, whatever its `Retry-After` says. */
export const RETRY_AFTER_MAX_MS = 24 * 3_600_000;
const RETRY_AFTER_DEFAULT_MS = 60_000;

/**
 * `Retry-After` as milliseconds: seconds, or an HTTP date; a minute when
 * absent or unreadable. Held between a second and a day unless `bounds` say otherwise.
 */
export function retryAfterMs(
  header: string | null | undefined,
  now: string,
  bounds: { readonly minMs: number; readonly maxMs: number } = { minMs: 1_000, maxMs: RETRY_AFTER_MAX_MS },
): number {
  if (header === undefined || header === null || header.trim() === "") return RETRY_AFTER_DEFAULT_MS;
  const seconds = Number(header.trim());
  const ms = Number.isFinite(seconds) ? Math.ceil(seconds * 1_000) : Date.parse(header) - Date.parse(now);
  return Number.isFinite(ms) ? Math.min(bounds.maxMs, Math.max(bounds.minMs, ms)) : RETRY_AFTER_DEFAULT_MS;
}
