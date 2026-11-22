import type { ClientResponse, TaviClient } from "@tavi/client/browser";
import type { IpcCommand } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";

import { translateNow } from "./i18n.js";

/**
 * Asking the owner from the page: one request's `Outcome` — its result, or the
 * refusal in words — and the few ways an answer is read, checked or reworded.
 * Every `*-api.ts` module builds on these.
 */

/** The part of the client the page asks the owner through. */
export type SettingsClient = Pick<TaviClient, "request">;

/**
 * A request's outcome: its result, or the owner's refusal in words.
 *
 * `code` is the owner's typed refusal code where it has one. A caller branches
 * on it (`CONFLICT` means someone else saved first) rather than on the message,
 * and a transport failure that never reached the owner simply has none.
 * `details` is the refusal's structured facts, where the owner sent some (a
 * decision on a round settled elsewhere says how).
 */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string; readonly code?: string; readonly details?: Readonly<Record<string, unknown>> };

/**
 * How one request is sent: its deadline (`null`: the client's own, by kind of
 * command), the words for a refusal that came without any, and those for a
 * request that never reached the owner (absent: the error's own).
 */
export interface AskOptions {
  readonly timeoutMs?: number | null;
  readonly refused?: string;
  readonly unreachable?: string;
}

/**
 * One owner request. It never rejects: a refusal, a timeout or a dropped
 * connection is an `Outcome` in words. Its default 30 s deadline is above the
 * owner's own for a model test (10 s), a discovery (5 s) and a search (15 s),
 * so the owner's answer — not this deadline — says what happened.
 */
export async function ask<T>(
  client: SettingsClient,
  command: IpcCommand,
  payload: Record<string, unknown>,
  options: AskOptions = {},
): Promise<Outcome<T>> {
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs;
  let response: ClientResponse;
  try {
    response = await (timeoutMs === null ? client.request(command, payload) : client.request(command, payload, { timeoutMs }));
  } catch (error) {
    return { ok: false, message: options.unreachable ?? errorMessage(error) };
  }
  if (response.ok) return { ok: true, value: response.result as T };
  const code = response.error?.code;
  const details = response.error?.details;
  return {
    ok: false,
    message: response.error?.message ?? options.refused ?? translateNow("common.ipc.refused", { command }),
    // Conditionally spread: `exactOptionalPropertyTypes` distinguishes an absent
    // field from one explicitly set to `undefined`.
    ...(code === undefined ? {} : { code }),
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * `work`, a throw turned into an `Outcome`: its value, or its error's message
 * in `failed`'s words (as it is, without one). It never rejects.
 */
export async function attempt<T>(work: () => Promise<T>, failed: (message: string) => string = (message) => message): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, message: failed(errorMessage(error)) };
  }
}

/** What `read` needs of a schema: its safe parse. */
export interface Readable<T> {
  safeParse(value: unknown): { readonly success: true; readonly data: T } | { readonly success: false };
}

/**
 * What `read` says of an answer that came back but did not parse; it already
 * says to restart. No code: a write's answer may be unreadable after the write.
 */
export const unreadable = (command: IpcCommand): string => translateNow("common.ipc.unreadable", { command });

/** `ask`, its answer parsed by `schema`: one the page cannot read is a failed outcome, never a value a view trips over. */
export async function read<T>(
  client: SettingsClient,
  command: IpcCommand,
  payload: Record<string, unknown>,
  schema: Readable<T>,
  options: AskOptions = {},
): Promise<Outcome<T>> {
  const outcome = await ask<unknown>(client, command, payload, options);
  if (!outcome.ok) return outcome;
  const parsed = schema.safeParse(outcome.value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: unreadable(command) };
}

/**
 * An answer that carries a list under `field`: one without it (an older owner,
 * or `{}` from an unawaited handler) is a failure to read, named for the page,
 * rather than `undefined` for a view to call `.map` on.
 */
export function withList<T>(answer: Outcome<T>, field: string, what: string): Outcome<T> {
  return !answer.ok || Array.isArray((answer.value as Record<string, unknown> | null | undefined)?.[field])
    ? answer
    : { ok: false, message: translateNow("common.ipc.listUnreadable", { what }) };
}

/** An outcome's value as `change` makes it, its refusal as it is: a write's own words for what it did. */
export function mapOutcome<T, U>(outcome: Outcome<T>, change: (value: T) => U): Outcome<U> {
  return outcome.ok ? { ok: true, value: change(outcome.value) } : outcome;
}

/** A raw response's refusal in words: the owner's message, else `fallback`. */
export function refusal(response: { readonly error?: { readonly message: string } | undefined }, fallback: string): string {
  return response.error?.message ?? fallback;
}
