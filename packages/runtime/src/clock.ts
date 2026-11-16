import type { ClockPort, LoggerPort } from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";

/**
 * Deterministic clock/id port.
 *
 * Ids are prefixed and monotonically suffixed so a fixture can assert on
 * ordering without pretending to control wall-clock time.
 */
export function createClock(): ClockPort {
  let counter = 0;
  return {
    now: nowTimestamp,
    newEpochId: () => {
      counter += 1;
      return `epoch-${Date.now().toString(36)}-${counter.toString(36)}`;
    },
    newId: (prefix: string) => {
      counter += 1;
      return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
    },
  };
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  readonly level?: LogLevel;
  /** Redacts known-sensitive values from structured fields. */
  readonly redactKeys?: readonly string[];
  readonly sink?: (line: string) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_REDACT = ["secret", "token", "apikey", "apiKey", "api_key", "authorization", "password", "credential"];

/**
 * Secrets carried inside a string value rather than under a sensitive key,
 * as a provider's error message or a logged request line carries them: an
 * HTTP credential header (`Authorization: …`, `X-Api-Key: …`), a JSON field
 * quoted in text (`"access_token":"…"`), a query-style parameter (`?key=…`,
 * or `token=…` at the start or after a space), and a `Bearer`/`Basic` token —
 * one with a digit or a token character in it, or 16+ characters, so a word
 * ("Basic authentication failed") is left alone.
 */
const SECRET_NAMES = "api_?key|token|access_token|refresh_token|id_token|client_secret|secret|password|sig|signature";
const VALUE_SECRETS: readonly (readonly [RegExp, string])[] = [
  [/\b((?:proxy-)?authorization|x-api-key|x-goog-api-key|api-key)(\s*:\s*)[^\r\n"]+/gi, "$1$2[redacted]"],
  [new RegExp(`("(?:${SECRET_NAMES}|key)"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*"`, "gi"), '$1[redacted]"'],
  [new RegExp(`(^|[?&#\\s])((?:${SECRET_NAMES}|key)=)[^&#\\s"']+`, "gi"), "$1$2[redacted]"],
  // `code` is an OAuth code only in a URL: "status code=500" in prose is not one.
  [/([?&#]code=)[^&#\s"']+/gi, "$1[redacted]"],
  [/\b(Bearer|Basic) +(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-]|[A-Za-z0-9._~+/=-]{16})[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]"],
];

/** `text` with every secret-shaped value masked (see `VALUE_SECRETS`). */
function redactSecretValues(text: string): string {
  let output = text;
  for (const [pattern, replacement] of VALUE_SECRETS) output = output.replace(pattern, replacement);
  return output;
}

/**
 * Bounded, content-minimal logger (credentials and private memory bodies never
 * reach generic diagnostics).
 */
export function createLogger(options: LoggerOptions = {}): LoggerPort {
  const level = options.level ?? "info";
  const redact = (options.redactKeys ?? DEFAULT_REDACT).map((key) => key.toLowerCase());
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));

  const isSensitiveKey = (key: string): boolean => {
    const lower = key.toLowerCase();
    return redact.some((needle) => lower.includes(needle));
  };

  /**
   * Redact by key at every level, not just the top, and by value in every
   * string (`redactSecretValues`).
   *
   * A credential nested under a neutral key (`config.apiKey`) or carried under an
   * innocuous name is exactly the case that reaches logs in practice, so the walk
   * recurses through plain objects and arrays under a depth bound.
   */
  const sanitizeValue = (value: unknown, depth: number): unknown => {
    if (depth > 4) return "[truncated-depth]";
    if (typeof value === "string") {
      const clipped = value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
      return redactSecretValues(clipped);
    }
    if (value instanceof Error) {
      // `message`, `stack` and `cause` are own but non-enumerable, so the plain
      // object walk below would write an `Error` as `{}` (or only its `code`).
      const fields: Record<string, unknown> = { name: value.name, message: value.message, ...Object.fromEntries(Object.entries(value)) };
      if (value.cause !== undefined) fields["cause"] = value.cause;
      if (level === "debug" && value.stack !== undefined) fields["stack"] = value.stack;
      return sanitizeValue(fields, depth);
    }
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((entry) => sanitizeValue(entry, depth + 1));
    }
    if (typeof value === "object" && value !== null) {
      const source = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(source)) {
        output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeValue(entry, depth + 1);
      }
      return output;
    }
    return value;
  };

  const sanitize = (fields: Record<string, unknown>): Record<string, unknown> => {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeValue(value, 0);
    }
    return output;
  };

  const emit = (at: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[at] < LEVEL_ORDER[level]) return;
    const payload = { at: nowTimestamp(), level: at, message: redactSecretValues(message), ...(fields ? sanitize(fields) : {}) };
    sink(JSON.stringify(payload));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

/** Silent logger for tests that assert on something other than log output. */
export function createNullLogger(): LoggerPort {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}
