import type { z } from "zod";
import { TaviError, ContentLabelSchema, UNTRUSTED_UNKNOWN_SOURCE, normalizeLabel, type ContentLabel } from "@tavi/contracts";

/**
 * Parse a stored row into the contract type.
 *
 * A row is validated on the way out rather than cast: the database is a
 * boundary, a restored backup or an older release can put a value there that the
 * current schema does not accept, and a cast would carry it into the runtime as
 * if it were typed: every boundary validates.
 */
export function parseStoredRow<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  value: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data === undefined) {
    throw new TaviError("INTERNAL", `Stored ${what} row does not match the current schema; run a migration or repair it`);
  }
  return parsed.data;
}

/**
 * Split stored rows into the ones that map cleanly and the ids that do not.
 *
 * Every registry read uses this: a per-row `try` is what stops one hand-edited,
 * restored or older-release row from failing a whole query, and returning the
 * ids is what stops it from vanishing silently. Extracted so the three callers
 * cannot drift into three different policies.
 */
export function partitionReadable<Row, Value>(
  rows: readonly Row[],
  idOf: (row: Row) => string,
  map: (row: Row) => Value,
): { readonly readable: Value[]; readonly unreadable: string[] } {
  const readable: Value[] = [];
  const unreadable: string[] = [];
  for (const row of rows) {
    try {
      readable.push(map(row));
    } catch {
      unreadable.push(idOf(row));
    }
  }
  return { readable, unreadable };
}

/**
 * Validate a value the caller is about to write.
 *
 * `parseStoredRow` is for a row that is already there and reports `INTERNAL`;
 * this is for a caller's own value and reports `INVALID_INPUT`. The distinction
 * matters because validating only on the way *out* commits the row and then
 * hides it in `unreadable`, so the write looks like a success while the record
 * disappears.
 */
export function assertWritable<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  value: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data === undefined) {
    throw new TaviError("INVALID_INPUT", `${what} is not valid and was not written`, { details: { value } });
  }
  return parsed.data;
}

/**
 * Restore a stored enum value, or `null` when the column is empty.
 *
 * Mirrors `parseJsonColumn`'s posture: a value the contract does not recognize
 * is an error an operator repairs, not a value to accept because it happens to
 * satisfy TypeScript's structural check. Returning `null` for an absent value
 * (rather than throwing) is deliberate: "not recorded" is a legitimate state.
 */
export function parseOptionalEnum<T>(schema: z.ZodType<T>, value: unknown, what: string): T | null {
  if (value === null || value === undefined) return null;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TaviError("INTERNAL", `Stored ${what} column is not a recognized value; repair the row or restore a backup`);
  }
  return parsed.data;
}

/** Restore a required stored enum, refusing an unrecognized value. */
export function parseRequiredEnum<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new TaviError("INTERNAL", `Stored ${what} column is not a recognized value; repair the row or restore a backup`);
  }
  return parsed.data;
}

export function parseJsonColumn<T>(value: string, what: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new TaviError("INTERNAL", `Stored ${what} column is not valid JSON; repair the row or restore a backup`);
  }
}

export function storedLabelOf(json: string): ContentLabel {
  try {
    const parsed = ContentLabelSchema.safeParse(JSON.parse(json));
    return parsed.success ? normalizeLabel(parsed.data) : UNTRUSTED_UNKNOWN_SOURCE;
  } catch {
    return UNTRUSTED_UNKNOWN_SOURCE;
  }
}
