import { z } from "zod";

/**
 * IPC and client-event bounds, kept in a module that imports nothing.
 *
 * Both `ipc.ts` (which embeds `ClientEventSchema` in the frame union) and
 * `events.ts` (whose envelope and variants are bounded by them) need these
 * values. Declaring them in either file makes the two import each other, and a
 * circular import leaves a discriminated union with `undefined` members at
 * module-init time — the schema then throws `Cannot read properties of
 * undefined` on the first parse rather than failing loudly at build time. This
 * module is the leaf that breaks that cycle.
 */

/**
 * Connect errors of the "the owner is not there yet" kind — no endpoint, a
 * refused connection, a transient shortage — which another attempt could clear.
 * One list for the runtime's client and `@tavi/client/node`, so the two agree
 * about what a reconnect waits out.
 */
// `EBUSY`: every instance of a Windows named pipe is taken for the moment.
export const IPC_RETRYABLE_CONNECT_CODES: readonly string[] = ["ENOENT", "ECONNREFUSED", "EAGAIN", "EMFILE", "ENFILE", "EBUSY"];

/** Bound on a single frame, in UTF-8 bytes. */
export const IPC_MAX_FRAME_BYTES = 1 * 1024 * 1024;

/**
 * Bound on one subscription's unacknowledged outbound bytes.
 *
 * Larger than a single frame by design: it covers many frames in flight on one
 * subscription, and it must admit at least one maximum-sized frame.
 */
export const IPC_MAX_SUBSCRIPTION_BACKLOG_BYTES = 4 * 1024 * 1024;

/**
 * Bound on one connection's outbound bytes, across all its subscriptions
 * (a per-subscription budget "under a per-connection ceiling").
 *
 * The per-subscription budget alone lets one stalled connection hold its budget
 * once per subscription it opened, and a dropped subscription's bytes stay queued
 * on the socket. A connection over this ceiling is closed; its client
 * reconnects and resubscribes from its cursors.
 */
export const IPC_MAX_CONNECTION_BACKLOG_BYTES = 16 * 1024 * 1024;

/**
 * Subscriptions one connection may hold at once.
 *
 * The web bridge multiplexes every browser tab over one connection, so this is
 * sized for many tabs; it exists so that "per subscription" budgets still add up
 * to something bounded per connection.
 */
export const IPC_MAX_SUBSCRIPTIONS_PER_CONNECTION = 64;

/**
 * The bound every `message`/`summary` field shares with `clampMessage`.
 * One constant, because a schema that allowed more than the clamp
 * would let a handler build a frame the transport then truncates mid-word.
 */
export const IPC_MAX_MESSAGE_CHARS = 2000;

/**
 * Bound on a `run` prompt, in characters.
 *
 * Explicit because the web bridge's WebSocket `maxPayload` is sized from it: a bridge that
 * accepted a larger frame than the daemon does would fail after the bytes had
 * crossed the loopback socket.
 */
export const IPC_MAX_PROMPT_CHARS = 64 * 1024;

/**
 * Bound on an approval decision's note, in characters.
 *
 * The workflow's reply parser refuses a longer note, and a refused reply fails
 * the task — so the IPC schema must never admit a note the workflow would then
 * reject. One constant, shared by both.
 */
export const APPROVAL_NOTE_MAX_CHARS = 500;

/**
 * An artifact review decision's note. Longer than an approval's: a
 * reviewer explaining what is wrong with a large archived result may need to
 * quote from it. Stored on the artifact and shown to the model.
 */
export const ARTIFACT_REVIEW_NOTE_MAX_CHARS = 2000;

/**
 * At most one review entry per artifact id, and a generation can flag up to
 * `MAX_WORKFLOW_TOOL_CALLS` (24) tool calls whose messages can each name 16
 * artifacts — 384 in the worst case. Shared with `workflow.ts`'s
 * `MAX_REVIEW_REQUESTS` so a review round that is representable as an interrupt
 * is also representable as the event reporting it.
 */
export const MAX_REVIEW_EVENT_REQUESTS = 384;

/**
 * The schedule prefix a client may not mint an operation key under.
 *
 * Schedule-fired runs derive their keys from `schedule:${scheduleId}:${fireTime}`;
 * letting a client choose a key in that namespace would let it forge or collide
 * with a fire's admissions.
 */
export const IPC_RESERVED_OPERATION_KEY_PREFIX = "schedule:";

/**
 * Every prefix a client may not mint an operation key under: a schedule's
 * fires, and a reminder's (`reminder:${reminderId}:${fireAt}`,
 * `reminderTaskOperationKey`), whose tasks `tasks list` reads the reminder
 * back from.
 */
export const IPC_RESERVED_OPERATION_KEY_PREFIXES = [IPC_RESERVED_OPERATION_KEY_PREFIX, "reminder:", "home:"] as const;

/**
 * Whether a client-supplied operation key falls in a reserved namespace.
 *
 * One predicate and one message for every front end — the CLI parser, the IPC
 * `run` schema and the CLI's programmatic backstop — so the three cannot drift.
 */
export function isReservedOperationKey(key: string): boolean {
  return IPC_RESERVED_OPERATION_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** The refusal every front end reports for a reserved key. */
export const RESERVED_OPERATION_KEY_MESSAGE =
  `an operation key may not begin with the reserved prefix ${IPC_RESERVED_OPERATION_KEY_PREFIXES.join(" or ")}, ` +
  "which belong to schedule- and reminder-fired work";

/**
 * A durable approval row id.
 *
 * Its own bound, not `IdSchema`: the id composes a task id, a round and a call
 * id, each of which `IdSchema` already allows to be 128 characters, so a
 * well-formed id can exceed 128. Bounded generously above that composition so a
 * valid event cannot fail validation for being correct.
 */
export const ApprovalRowIdSchema = z.string().min(1).max(512);
export type ApprovalRowId = z.infer<typeof ApprovalRowIdSchema>;
