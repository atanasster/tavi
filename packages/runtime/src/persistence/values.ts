import { canonicalizeAdmission, MAX_ADMISSION_PAYLOAD_BYTES, TaviError } from "@tavi/contracts";
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
