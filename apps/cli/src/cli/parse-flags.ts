import { RESERVED_OPERATION_KEY_MESSAGE, isReservedOperationKey } from "@tavi/contracts";
import { UsageError } from "./argv.js";

/**
 * `--operation-key`, refused at parse time when it uses the reserved prefix.
 *
 * The `schedule:` namespace belongs to schedule-fired work. Refusing
 * it here, as a usage error, is what keeps the refusal harmless: raised any later
 * it surfaced inside a resume's failure path, which marks a merely-waiting task
 * `failed`, or escaped `main()` as an unhandled rejection.
 */
export function operationKeyFlag(flags: ReadonlyMap<string, string>, usage: string): string | undefined {
  const key = flags.get("--operation-key");
  if (key !== undefined && isReservedOperationKey(key)) {
    throw new UsageError(`--operation-key: ${RESERVED_OPERATION_KEY_MESSAGE}`, usage);
  }
  return key;
}

/**
 * Validate the `<reference>=<host>` shape of one `--http-credential-host`.
 *
 * Checked at parse time so a malformed binding is a usage error rather than
 * something discovered when a request is already in flight.
 */
export function requireBindingShape(value: string, usage: string): string {
  const at = value.indexOf("=");
  if (at <= 0 || at === value.length - 1) {
    throw new UsageError(`--http-credential-host expects <credential-reference>=<host>, received ${JSON.stringify(value)}`, usage);
  }
  return value;
}
