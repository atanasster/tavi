import { deserialize } from "node:v8";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { channel } from "node:diagnostics_channel";
import { TaviError } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import {
  copyMessageChunk,
  DATABASE_LIMITS,
  restoreError,
  transportError,
  validInline,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.js";
import { serializeBounded } from "./serialization.js";

export interface ChannelLimits {
  readonly requests: number;
  readonly controlRequests: number;
  readonly bytes: number;
  readonly controlBytes: number;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly control?: boolean;
}

export interface DatabaseOperationEvent {
  readonly operation: string;
  readonly phase: "started" | "settled";
  readonly queueDepth: number;
  readonly queueWaitMs: number;
  readonly executionMs: number;
}

export const databaseWorkerEvents = channel("tavi.database.operation");

interface PendingRequest {
  readonly id: number;
  readonly operation: string;
  readonly body: Buffer;
  readonly control: boolean;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
  offset: number;
  response?: Buffer;
  received: number;
  readonly acceptedAt: number;
  readonly sequence?: symbol;
  startedAt?: number;
  /** The worker said the operation changed rows. */
  wrote?: boolean;
}

/**
 * One native operation in flight. A request or response of at most one message travels
 * inline (`begin` → `started` → `result`, one round trip); larger ones cross in acknowledged chunks.
 */
export class WorkerChannel {
  readonly #worker: Worker;
  readonly #limits: ChannelLimits;
  readonly #queue: PendingRequest[] = [];
  #active: PendingRequest | undefined;
  #ordinaryCount = 0;
  #ordinaryBytes = 0;
  #controlCount = 0;
  #controlBytes = 0;
  #nextId = 0;
  #sequence: { token: symbol; after: number } | undefined;
  #state: "starting" | "open" | "closing" | "closed" | "failed" = "starting";
  #closeSent = false;
  #closeAcknowledged = false;
  readonly #readiness = Promise.withResolvers<void>();
  readonly #closure = Promise.withResolvers<void>();
  readonly #failure = Promise.withResolvers<Error>();
  #onWrote: ((operation: string) => void) | undefined;
  readonly ready = this.#readiness.promise;
  readonly closed = this.#closure.promise;
  readonly failed = this.#failure.promise;

  constructor(url: URL, options: WorkerOptions, limits: ChannelLimits = DATABASE_LIMITS) {
    for (const limit of Object.values(limits)) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TaviError("INVALID_INPUT", "Worker queue limits must be positive integers");
    }
    if (limits.bytes > DATABASE_LIMITS.bytes || limits.controlBytes > DATABASE_LIMITS.controlBytes) {
      throw new TaviError("INVALID_INPUT", "Worker request byte limits exceed the transport maximum");
    }
    this.#limits = { ...limits };
    // Callers can await these later; worker failure must not create an unhandled rejection first.
    void this.ready.catch(() => {});
    // Awaited or raced elsewhere: this only keeps an early rejection from going unhandled.
    void this.closed.catch(() => {});
    this.#worker = new Worker(url, options);
    this.#worker.on("message", (message: WorkerResponse) => this.#receive(message));
    this.#worker.on("messageerror", (error) => this.#fail(error instanceof Error ? error : new Error(String(error))));
    this.#worker.on("error", (error) => this.#fail(error instanceof Error ? error : new Error(String(error))));
    this.#worker.on("exit", (code) => {
      if (this.#closeAcknowledged && code === 0) {
        this.#state = "closed";
        this.#closure.resolve();
      } else this.#fail(new Error(`Database worker exited unexpectedly (${code})`));
    });
  }

  get available(): boolean {
    return this.#state === "open";
  }

  /** Told of each request that settles having changed rows, after its caller's own continuation is queued. */
  onWrote(listener: (operation: string) => void): void {
    this.#onWrote = listener;
  }

  async sequence<T>(
    run: (request: (operation: string, input: unknown, options?: RequestOptions) => Promise<unknown>) => Promise<T>,
  ): Promise<T> {
    if (this.#sequence !== undefined)
      throw new TaviError("BUDGET_EXCEEDED", "A database transfer is already active", { details: { mutationOutcome: "not-dispatched" } });
    const sequence = { token: Symbol("transfer"), after: this.#nextId };
    this.#sequence = sequence;
    try {
      return await run((operation, input, options) => this.#request(operation, input, { ...options, control: true }, sequence.token));
    } finally {
      this.#sequence = undefined;
      this.#dispatch();
    }
  }

  request(operation: string, input: unknown, options: RequestOptions = {}): Promise<unknown> {
    return this.#request(operation, input, options);
  }

  #request(operation: string, input: unknown, options: RequestOptions = {}, sequence?: symbol): Promise<unknown> {
    if (this.#state !== "open") return Promise.reject(transportError("Database worker is not accepting work", "not-dispatched"));
    if (options.signal?.aborted)
      return Promise.reject(
        new TaviError("ABORTED", "Database request cancelled before dispatch", { details: { mutationOutcome: "not-dispatched" } }),
      );
    const control = options.control === true;
    const count = control ? this.#controlCount : this.#ordinaryCount;
    const bytes = control ? this.#controlBytes : this.#ordinaryBytes;
    if (count >= (control ? this.#limits.controlRequests : this.#limits.requests)) {
      return Promise.reject(
        new TaviError("BUDGET_EXCEEDED", "Database request queue is full", { details: { mutationOutcome: "not-dispatched" } }),
      );
    }
    let body: Buffer;
    try {
      body = serializeBounded(input, (control ? this.#limits.controlBytes : this.#limits.bytes) - bytes);
    } catch (error) {
      return Promise.reject(
        new TaviError(
          error instanceof TaviError ? error.code : "INVALID_INPUT",
          errorMessage(error, "Database arguments are not serializable"),
          { cause: error, details: { mutationOutcome: "not-dispatched" } },
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      const cancel = () => {
        const at = this.#queue.findIndex((request) => request.id === id);
        if (at < 0) return; // A dispatched mutation may commit; cancellation cannot promise otherwise.
        const [request] = this.#queue.splice(at, 1);
        if (request !== undefined)
          this.#settle(
            request,
            undefined,
            new TaviError("ABORTED", "Database request cancelled before dispatch", { details: { mutationOutcome: "not-dispatched" } }),
          );
        this.#dispatch();
      };
      const request: PendingRequest = {
        id,
        operation,
        body,
        control,
        ...(sequence === undefined ? {} : { sequence }),
        resolve,
        reject,
        offset: 0,
        received: 0,
        acceptedAt: performance.now(),
        cleanup: () => options.signal?.removeEventListener("abort", cancel),
      };
      if (control) {
        this.#controlCount++;
        this.#controlBytes += body.byteLength;
      } else {
        this.#ordinaryCount++;
        this.#ordinaryBytes += body.byteLength;
      }
      this.#queue.push(request);
      options.signal?.addEventListener("abort", cancel, { once: true });
      this.#dispatch();
    });
  }

  async close(): Promise<void> {
    if (this.#state === "starting") await this.ready;
    if (this.#state === "open") this.#state = "closing";
    this.#dispatch();
    await this.closed;
  }

  /** Emergency stop leaves dispatched mutations unresolved and never replays them. */
  async abort(): Promise<void> {
    this.#fail(new Error("Database worker was terminated"));
    await this.#worker.terminate();
  }

  #post(message: WorkerRequest): void {
    try {
      this.#worker.postMessage(message);
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #dispatch(): void {
    if (this.#active !== undefined || !["open", "closing"].includes(this.#state)) return;
    const index =
      this.#sequence === undefined
        ? 0
        : this.#queue.findIndex((request) => request.id <= (this.#sequence?.after ?? 0) || request.sequence === this.#sequence?.token);
    const request = index < 0 ? undefined : this.#queue.splice(index, 1)[0];
    if (request !== undefined) {
      this.#active = request;
      const bytes = request.body.byteLength;
      if (bytes <= DATABASE_LIMITS.messageBytes) {
        request.offset = bytes;
        this.#post({ type: "begin", id: request.id, operation: request.operation, bytes, inline: copyMessageChunk(request.body, 0) });
      } else this.#post({ type: "begin", id: request.id, operation: request.operation, bytes });
    } else if (this.#sequence === undefined && this.#state === "closing" && !this.#closeSent) {
      this.#closeSent = true;
      this.#post({ type: "close" });
    }
  }

  #receive(message: WorkerResponse): void {
    if (message.type === "ready") {
      if (this.#state !== "starting") return this.#fail(new Error("Unexpected worker readiness message"));
      this.#state = "open";
      this.#readiness.resolve();
      return;
    }
    if (message.type === "startup-error") return this.#fail(restoreError(message.error));
    if (message.type === "closed") {
      if (!this.#closeSent || this.#active !== undefined) return this.#fail(new Error("Unexpected worker close acknowledgement"));
      this.#closeAcknowledged = true;
      return;
    }
    const request = this.#active;
    if (request === undefined || request.id !== message.id) return this.#fail(new Error("Unexpected database response identity"));
    if (message.type === "started") {
      request.startedAt = performance.now();
      this.#observe(request, "started");
    } else if (message.type === "next") {
      if (request.offset >= request.body.byteLength) return this.#fail(new Error("Unexpected database request acknowledgement"));
      const chunk = copyMessageChunk(request.body, request.offset);
      request.offset += chunk.byteLength;
      this.#post({ type: "chunk", id: request.id, bytes: chunk });
    } else if (message.type === "result") {
      if (message.wrote === true) request.wrote = true;
      if (
        request.response !== undefined ||
        !Number.isSafeInteger(message.bytes) ||
        message.bytes < 1 ||
        message.bytes > DATABASE_LIMITS.responseBytes
      )
        return this.#fail(new Error("Database response exceeds the memory limit"));
      if (message.inline !== undefined) {
        if (!validInline(message)) return this.#fail(new Error("Invalid database response chunk"));
        this.#complete(request, message.inline);
        return;
      }
      request.response = Buffer.allocUnsafe(message.bytes);
      this.#post({ type: "result-next", id: request.id });
    } else if (message.type === "chunk") {
      const response = request.response;
      if (
        response === undefined ||
        message.bytes.byteLength < 1 ||
        message.bytes.byteLength > DATABASE_LIMITS.messageBytes ||
        request.received + message.bytes.byteLength > response.byteLength
      )
        return this.#fail(new Error("Invalid database response chunk"));
      response.set(message.bytes, request.received);
      request.received += message.bytes.byteLength;
      if (request.received < response.byteLength) this.#post({ type: "result-next", id: request.id });
      else this.#complete(request, response);
    } else {
      if (message.wrote === true) request.wrote = true;
      this.#settle(request, undefined, restoreError(message.error));
      this.#active = undefined;
      this.#dispatch();
    }
  }

  #complete(request: PendingRequest, response: Uint8Array): void {
    try {
      this.#settle(request, deserialize(response));
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.#active = undefined;
    this.#dispatch();
  }

  #settle(request: PendingRequest, result: unknown, error?: Error): void {
    request.cleanup();
    if (request.control) {
      this.#controlCount--;
      this.#controlBytes -= request.body.byteLength;
    } else {
      this.#ordinaryCount--;
      this.#ordinaryBytes -= request.body.byteLength;
    }
    this.#observe(request, "settled");
    if (error === undefined) request.resolve(result);
    else request.reject(error);
    if (request.wrote === true) {
      try {
        this.#onWrote?.(request.operation);
      } catch {
        // A listener's failure is its own; the request it watched has settled.
      }
    }
  }

  #observe(request: PendingRequest, phase: DatabaseOperationEvent["phase"]): void {
    if (!databaseWorkerEvents.hasSubscribers) return;
    const now = performance.now();
    const event: DatabaseOperationEvent = {
      operation: request.operation,
      phase,
      queueDepth: this.#queue.length,
      queueWaitMs: (request.startedAt ?? now) - request.acceptedAt,
      executionMs: request.startedAt === undefined ? 0 : now - request.startedAt,
    };
    databaseWorkerEvents.publish(event);
  }

  #fail(error: Error): void {
    if (this.#state === "failed" || this.#state === "closed") return;
    this.#state = "failed";
    this.#readiness.reject(error);
    this.#closure.reject(error);
    if (this.#active !== undefined) {
      this.#settle(this.#active, undefined, transportError(error.message, "unknown"));
      this.#active = undefined;
    }
    for (const request of this.#queue.splice(0)) this.#settle(request, undefined, transportError(error.message, "not-dispatched"));
    this.#failure.resolve(error);
    void this.#worker.terminate();
  }
}
