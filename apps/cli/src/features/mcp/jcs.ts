import { sha256Hex } from "@tavi/node-kit";

/**
 * RFC 8785 (JSON Canonicalization Scheme) for the values a tool definition
 * holds, so a definition's hash never changes with key order or spacing:
 * object keys sorted by UTF-16 code
 * units, no whitespace, strings as `JSON.stringify` writes them (which is
 * RFC 8785's escaping), and numbers in ECMAScript's shortest form, which is
 * RFC 8785's. A value JSON cannot hold (a non-finite number, a function) is
 * refused rather than dropped.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("JSON cannot hold a non-finite number");
      // -0 is written 0, as RFC 8785 requires.
      return Object.is(value, -0) ? "0" : String(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`JSON cannot hold a ${typeof value}`);
  }
}

/** The SHA-256 of a value's canonical JSON, in hex. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
