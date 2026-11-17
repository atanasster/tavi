import { z } from "zod";

/** Opaque bounded id. Validated at every boundary so an id can never be an unbounded blob. */
export const IdSchema = z.string().min(1).max(128);
export type Id = z.infer<typeof IdSchema>;

/**
 * A name a person gives a schedule or an agent, as it comes in: one line of
 * text with no control character. A tab breaks `tavi schedules list`'s
 * columns, and an escape sequence would drive the terminal it is printed in.
 * Stored records are read as they are; only a new name is held to this.
 */
export const DisplayNameSchema = z
  .string()
  .min(1, "a name cannot be empty")
  .max(200, "a name is at most 200 characters")
  .regex(/^[^\p{Cc}\u2028\u2029]+$/u, "a name is one line of text, with no tab, line break or other control character");

/**
 * Reserved id aliases.
 *
 * These are deliberately plain string aliases rather than branded types: a
 * branded id cannot survive a Zod parse without a cast at every boundary, and
 * Zod (not a cast) is the source of truth for state. The
 * aliases keep call sites readable while validation stays in the schemas below.
 */
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type ThreadId = z.infer<typeof ThreadIdSchema>;
export type AttemptId = z.infer<typeof AttemptIdSchema>;

export const WorkspaceIdSchema = IdSchema;

/**
 * The workspace the initial installation provisions.
 *
 * The installation has one trusted operator and one default personal principal; commands
 * that are not yet workspace-aware target this id rather than repeating the
 * literal.
 */
export const DEFAULT_WORKSPACE_ID = "default";
export const RunIdSchema = IdSchema;
export const ThreadIdSchema = IdSchema;
export const AttemptIdSchema = IdSchema;

/**
 * Credential references are opaque registered bindings.
 *
 * The shape is a path-safe slug, never an arbitrary filename or
 * environment-variable name supplied by a model. It is deliberately not
 * lowercase-only: the established convention is a connection id plus a purpose,
 * such as `openai.apiKey`, and the rule that matters here is that a reference
 * cannot escape the directory the operator configured.
 */
export const SECRET_KEY_REF_PATTERN = /^[a-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;

export function assertSecretKeyRef(keyRef: unknown): string {
  if (typeof keyRef !== "string" || keyRef.length > 128 || !SECRET_KEY_REF_PATTERN.test(keyRef)) {
    throw new Error(`Invalid credential reference ${JSON.stringify(keyRef)}: expected a path-safe slug such as "openai.apiKey"`);
  }
  return keyRef;
}

/** Local wall-clock instant, ISO-8601 UTC with millisecond precision. */
export const TimestampSchema = z.iso.datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

export { nowTimestamp } from "./util.js";
