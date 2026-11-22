import { canonicalizeAdmission, MAX_ADMISSION_PAYLOAD_BYTES, TaviError, TextRefSchema, type TextRef } from "@tavi/contracts";
export function assertBoundedPayload(value: unknown, label: string): void {
  const json = canonicalizeAdmission(value ?? null);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > MAX_ADMISSION_PAYLOAD_BYTES) {
    throw new TaviError("BUDGET_EXCEEDED", `${label} exceeded ${MAX_ADMISSION_PAYLOAD_BYTES} bytes`, {
      details: { bytes },
    });
  }
}

export function assertPositiveLimit(limit: number, caller: string): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TaviError("INVALID_INPUT", `${caller} requires a positive integer limit`, {
      details: { limit },
    });
  }
}

export function hashEffectInputs(inputs: unknown): string {
  return canonicalizeAdmission(inputs ?? null);
}

/**
 * Words stored by key (`TextRef`) as their two columns: the key and its parameters as JSON; both NULL for none, and
 * for a reference past `TextRefSchema`'s bounds, which would be dropped on every read: its English is stored all the same.
 */
export function textRefColumns(ref: TextRef | undefined): readonly [string | null, string | null] {
  if (ref === undefined || !TextRefSchema.safeParse(ref).success) return [null, null];
  return [ref.key, ref.params === undefined ? null : JSON.stringify(ref.params)];
}

/** A stored key and its parameters as a reference; undefined for none, or for one this build cannot read (its English is shown). */
export function storedTextRef(key: string | null | undefined, paramsJson: string | null | undefined): TextRef | undefined {
  if (key === null || key === undefined) return undefined;
  let params: unknown;
  try {
    params = paramsJson === null || paramsJson === undefined ? undefined : JSON.parse(paramsJson);
  } catch {
    return undefined;
  }
  const parsed = TextRefSchema.safeParse(params === undefined ? { key } : { key, params });
  return parsed.success ? parsed.data : undefined;
}
