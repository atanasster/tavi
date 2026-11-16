import type { PayloadOperations } from "./payloads.js";
import type { RoutineOperations } from "./routine-protocol.js";
import type { StoreOperations } from "./store-protocol.js";
import { TaviError, TaviErrorCodeSchema, type AsyncPersistencePort, type CheckpointStoragePort, type TaskRecord } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { RepositoryOperations } from "./repository-protocol.js";
import type { ServiceOperations } from "./service-protocol.js";
import type { PluginRegistryOperations } from "./plugin-registry-protocol.js";

export const DATABASE_LIMITS = {
  requests: 128,
  controlRequests: 16,
  bytes: 32 * 1024 * 1024,
  controlBytes: 4 * 1024 * 1024,
  responseBytes: 36 * 1024 * 1024,
  messageBytes: 1024 * 1024,
  cursors: 4,
  cursorLifetimeMs: 30_000,
} as const;

/**
 * Own exactly the bytes sent; a Buffer view would clone its whole backing allocation.
 * A body that already owns its whole allocation goes as is. Otherwise the typed-array
 * `slice` of a plain view makes an exact-sized native copy (`Buffer#slice` would only make another view).
 */
export function copyMessageChunk(body: Uint8Array, offset: number): Uint8Array {
  if (
    offset === 0 &&
    body.byteLength <= DATABASE_LIMITS.messageBytes &&
    body.byteOffset === 0 &&
    body.byteLength === body.buffer.byteLength
  )
    return body;
  const length = Math.max(0, Math.min(DATABASE_LIMITS.messageBytes, body.byteLength - offset));
  return new Uint8Array(body.buffer, body.byteOffset + offset, length).slice();
}

/** An inline payload is at most one message and exactly the announced length. */
export function validInline(message: { readonly bytes: number; readonly inline?: Uint8Array }): boolean {
  return message.inline === undefined || (message.bytes <= DATABASE_LIMITS.messageBytes && message.inline.byteLength === message.bytes);
}

export type MutationOutcome = "not-dispatched" | "rolled-back" | "committed" | "unknown";

type CheckpointOperations = {
  [K in keyof CheckpointStoragePort as `checkpoint.${K}`]: {
    input: Parameters<CheckpointStoragePort[K]>[0];
    output: Awaited<ReturnType<CheckpointStoragePort[K]>>;
  };
};
export type DatabaseOperations = PayloadOperations &
  RoutineOperations &
  StoreOperations &
  RepositoryOperations &
  CheckpointOperations &
  ServiceOperations &
  PluginRegistryOperations & {
    "tasks.cancel": {
      input: Parameters<AsyncPersistencePort["cancelTask"]>[0];
      output: Awaited<ReturnType<AsyncPersistencePort["cancelTask"]>>;
    };
    info: { input: undefined; output: { databasePath: string; tables: readonly string[] } };
    "meta.get": { input: { key: string }; output: string | undefined };
    "meta.set": { input: { key: string; value: string; now: string }; output: undefined };
    "tasks.get": { input: { taskId: string }; output: TaskRecord | undefined };
  };

export interface WireError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly outcome: MutationOutcome;
}

export type WorkerRequest =
  /** A body of at most one message travels inline, so the operation takes one round trip. */
  | { readonly type: "begin"; readonly id: number; readonly operation: string; readonly bytes: number; readonly inline?: Uint8Array }
  | { readonly type: "chunk"; readonly id: number; readonly bytes: Uint8Array }
  | { readonly type: "result-next"; readonly id: number }
  | { readonly type: "close" };

export type WorkerResponse =
  | { readonly type: "ready" }
  | { readonly type: "next"; readonly id: number }
  | { readonly type: "started"; readonly id: number }
  /** `wrote`: the operation changed rows (a trigger's rows included), so what the database holds may differ now. */
  | { readonly type: "result"; readonly id: number; readonly bytes: number; readonly inline?: Uint8Array; readonly wrote?: true }
  | { readonly type: "chunk"; readonly id: number; readonly bytes: Uint8Array }
  | { readonly type: "error"; readonly id: number; readonly error: WireError; readonly wrote?: true }
  | { readonly type: "startup-error"; readonly error: WireError }
  | { readonly type: "closed" };

export function wireError(error: unknown, outcome: MutationOutcome): WireError {
  if (error instanceof TaviError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
      outcome,
    };
  }
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: errorMessage(error),
    ...(code === undefined ? {} : { code }),
    outcome,
  };
}

export function restoreError(error: WireError): Error {
  const code = TaviErrorCodeSchema.safeParse(error.code);
  if (code.success) return new TaviError(code.data, error.message, { details: { ...error.details, mutationOutcome: error.outcome } });
  return Object.assign(new Error(error.message), { name: error.name, code: error.code, mutationOutcome: error.outcome });
}

export function transportError(message: string, outcome: MutationOutcome): TaviError {
  return new TaviError("UNAVAILABLE", message, { details: { mutationOutcome: outcome } });
}
