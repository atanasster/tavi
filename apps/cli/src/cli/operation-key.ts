import { EXIT } from "./exit.js";
import { RESERVED_OPERATION_KEY_MESSAGE, isReservedOperationKey } from "@tavi/contracts";
import { prefixedId } from "@tavi/node-kit";
import type { CliIo } from "./io.js";

/**
 * The operation key a CLI admission runs under.
 *
 * Minted with `randomUUID` rather than the runtime clock's `newId`: that
 * counter is process-local, so two invocations starting in the same millisecond
 * produced the same key and the second resolved the first's task as a replay
 * instead of starting its own. A supplied key has already passed
 * `refuseReservedOperationKey`.
 */
export function clientOperationKey(supplied: string | undefined): string {
  return supplied ?? prefixedId("op");
}

/**
 * Refuse a supplied operation key in the reserved `schedule:` namespace.
 *
 * The CLI parser already refuses it (`operationKeyFlag`) and `RunPayloadSchema`
 * refuses it over IPC; this is the backstop for a caller that builds command
 * options directly. It runs first in each command — before a runtime is composed
 * and before any durable write — and answers with the usage exit rather than a
 * throw, which would escape `main()`.
 */
export function refuseReservedOperationKey(key: string | undefined, io: CliIo): number | undefined {
  if (key === undefined || !isReservedOperationKey(key)) return undefined;
  io.stderr(`--operation-key: ${RESERVED_OPERATION_KEY_MESSAGE}\n`);
  return EXIT.usage;
}
