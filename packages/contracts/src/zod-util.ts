/**
 * Zod helpers every service writes the same way: a schema's issues as
 * `path: message` lines, and a parse that throws `INVALID_INPUT` naming them.
 * Kept apart from `./util.js`, which stays zod-free for browser bundles and
 * plugins that do not carry zod.
 */
import type { z } from "zod";
import { TaviError } from "./errors.js";

/** The shape of a zod failure these helpers read: any `ZodError`. */
interface ZodIssueList {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[];
}

/** One `path: message` line per issue; an issue at the root is labelled `root` when given, else just its message. */
export function zodIssues(error: ZodIssueList, root?: string): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".") || root;
    return path === undefined || path === "" ? issue.message : `${path}: ${issue.message}`;
  });
}

export interface ParseOrThrowOptions {
  /** The label for an issue at the root of the value (`"input"`, `"<root>"`). */
  readonly root?: string;
  /** Extra fields for the error's `details` beside `issues`. */
  readonly details?: Record<string, unknown>;
}

/**
 * `input` checked against `schema`, or a `TaviError("INVALID_INPUT")` whose
 * message is `message` (or what `message` derives from the issue lines) and
 * whose `details.issues` lists every issue as `path: message`.
 */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
  message: string | ((issues: readonly string[], error: ZodIssueList) => string),
  options: ParseOrThrowOptions = {},
): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = zodIssues(result.error, options.root);
  throw new TaviError("INVALID_INPUT", typeof message === "string" ? message : message(issues, result.error), {
    details: { ...options.details, issues },
  });
}
