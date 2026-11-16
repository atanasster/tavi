import { deserialize } from "node:v8";
import { serializeBounded } from "./serialization.js";
import type { MessagePort } from "node:worker_threads";
import {
  copyMessageChunk,
  DATABASE_LIMITS,
  validInline,
  wireError,
  type WorkerRequest,
  type WorkerResponse,
  type MutationOutcome,
} from "./protocol.js";

interface Incoming {
  readonly id: number;
  readonly operation: string;
  readonly body: Buffer;
  received: number;
}

/**
 * Called only by a worker entry; each handler finishes before another operation starts.
 * `changes` counts the rows the connection has changed since it opened (SQLite's
 * `total_changes()`): an operation that moved it is answered `wrote`, the write
 * signal the main thread wakes change-driven work on.
 */
export function serveWorker(
  port: MessagePort,
  dispatch: (operation: string, input: unknown) => unknown,
  close: () => void,
  failureOutcome: (operation: string) => MutationOutcome = () => "unknown",
  changes?: () => number,
): void {
  let incoming: Incoming | undefined;
  let outgoing: { id: number; body: Buffer; offset: number } | undefined;
  const send = (message: WorkerResponse) => port.postMessage(message);
  const execute = (id: number, operation: string, input: Uint8Array): void => {
    send({ type: "started", id });
    const before = changes?.();
    const wrote = (): { wrote?: true } => (before !== undefined && changes?.() !== before ? { wrote: true } : {});
    let result: unknown;
    try {
      result = dispatch(operation, deserialize(input));
    } catch (error) {
      send({ type: "error", id, error: wireError(error, failureOutcome(operation)), ...wrote() });
      return;
    }
    const written = wrote();
    try {
      const body = serializeBounded(result, DATABASE_LIMITS.responseBytes);
      if (body.byteLength > DATABASE_LIMITS.responseBytes) throw new Error("Database result requires a bounded cursor or byte stream");
      if (body.byteLength <= DATABASE_LIMITS.messageBytes) {
        send({ type: "result", id, bytes: body.byteLength, inline: copyMessageChunk(body, 0), ...written });
        return;
      }
      outgoing = { id, body, offset: 0 };
      send({ type: "result", id, bytes: body.byteLength, ...written });
    } catch (error) {
      outgoing = undefined;
      send({ type: "error", id, error: wireError(error, "unknown"), ...written });
    }
  };
  port.on("message", (message: WorkerRequest) => {
    if (message.type === "close") {
      if (incoming !== undefined || outgoing !== undefined) throw new Error("Cannot close an active database operation");
      close();
      send({ type: "closed" });
      port.close();
      return;
    }
    if (message.type === "begin") {
      if (
        incoming !== undefined ||
        outgoing !== undefined ||
        !Number.isSafeInteger(message.bytes) ||
        message.bytes < 1 ||
        message.bytes > DATABASE_LIMITS.bytes + DATABASE_LIMITS.controlBytes ||
        !validInline(message)
      )
        throw new Error("Invalid database request envelope");
      if (message.inline !== undefined) {
        execute(message.id, message.operation, message.inline);
        return;
      }
      incoming = { id: message.id, operation: message.operation, body: Buffer.allocUnsafe(message.bytes), received: 0 };
      send({ type: "next", id: message.id });
      return;
    }
    if (message.type === "result-next") {
      if (outgoing === undefined || outgoing.id !== message.id) throw new Error("Unexpected database result acknowledgement");
      const chunk = copyMessageChunk(outgoing.body, outgoing.offset);
      outgoing.offset += chunk.byteLength;
      send({ type: "chunk", id: outgoing.id, bytes: chunk });
      if (outgoing.offset === outgoing.body.byteLength) outgoing = undefined;
      return;
    }
    const request = incoming;
    if (
      request === undefined ||
      request.id !== message.id ||
      message.bytes.byteLength < 1 ||
      message.bytes.byteLength > DATABASE_LIMITS.messageBytes ||
      request.received + message.bytes.byteLength > request.body.byteLength
    )
      throw new Error("Invalid database request chunk");
    request.body.set(message.bytes, request.received);
    request.received += message.bytes.byteLength;
    if (request.received < request.body.byteLength) {
      send({ type: "next", id: request.id });
      return;
    }
    incoming = undefined;
    execute(request.id, request.operation, request.body);
  });
  send({ type: "ready" });
}
