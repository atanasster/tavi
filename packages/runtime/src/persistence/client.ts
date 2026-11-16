import { serialize, deserialize } from "node:v8";
import { serializeBounded } from "./serialization.js";
import { PAYLOAD_OPERATIONS, type PayloadOperation, type PayloadResult } from "./payloads.js";
import type { StoreOperations } from "./store-protocol.js";
import { TaviError, type ArtifactRecord, type ArtifactRepositoryPort } from "@tavi/contracts";
import { persistenceWorkerUrl } from "./worker-url.js";
import type { DatabaseOperations } from "./protocol.js";
import type { AsyncPersistencePort } from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { createAsyncRepositories } from "./repositories.js";
import { createAsyncServices } from "./services.js";
import { WorkerChannel, type ChannelLimits, type RequestOptions } from "./worker-channel.js";

export interface OpenDatabaseOptions {
  readonly databasePath: string;
  readonly artifactsDirectory?: string;
  readonly inMemory?: boolean;
  /** Administrative inspection preserves an incompatible checkpoint schema. */
  readonly checkpointMode?: "inspect";
  readonly limits?: ChannelLimits;
}

export { persistenceWorkerUrl };

/**
 * How many requests this client has sent its worker, in all and by operation
 * name — a debug probe for turn latency (each is a round trip a turn waits on).
 * A large payload's transfer requests count under their own `payload.*` names.
 */
export interface WorkerOperationCounts {
  readonly total: number;
  readonly byOperation: Readonly<Record<string, number>>;
}

export class DatabaseClient {
  readonly #channel: WorkerChannel;
  #operationTotal = 0;
  readonly #operationCounts = new Map<string, number>();
  readonly #settledListeners = new Set<(operation: string, input: unknown) => void>();
  readonly #writeListeners = new Set<(operation: string) => void>();
  #writes = 0;
  #largeUpload = false;
  #downloadActive = false;
  #closing = false;
  readonly #transfers = new Set<Promise<unknown>>();
  #artifactWriteCheck: ((input: Parameters<ArtifactRepositoryPort["putArtifact"]>[0]) => void) | undefined;
  readonly failed: Promise<Error>;
  readonly databasePath: string;
  readonly repositories: AsyncPersistencePort["repositories"];
  readonly checkpoints: AsyncPersistencePort["checkpoints"];
  readonly services: AsyncPersistencePort["services"];

  private constructor(channel: WorkerChannel, databasePath: string) {
    this.#channel = channel;
    channel.onWrote((operation) => this.#wrote(operation));
    this.failed = channel.failed;
    this.databasePath = databasePath;
    this.repositories = createAsyncRepositories(this);
    this.services = createAsyncServices(this);
    this.checkpoints = {
      get: (input) => this.call("checkpoint.get", input),
      put: (input) => this.call("checkpoint.put", input),
      putWrites: (input) => this.call("checkpoint.putWrites", input),
      deleteThread: (input) => this.call("checkpoint.deleteThread", input),
      pruneThread: (input) => this.call("checkpoint.pruneThread", input),
      latest: (input) => this.call("checkpoint.latest", input),
      openCursor: (input) => this.call("checkpoint.openCursor", input),
      nextCursor: (input) => this.call("checkpoint.nextCursor", input),
      closeCursor: (input) => this.call("checkpoint.closeCursor", input, { control: true }),
    };
  }

  static async open(options: OpenDatabaseOptions): Promise<DatabaseClient> {
    const { limits, ...workerData } = options;
    const channel = new WorkerChannel(persistenceWorkerUrl("database-worker"), { workerData, execArgv: [] }, limits);
    await channel.ready;
    return new DatabaseClient(channel, options.inMemory === true ? ":memory:" : options.databasePath);
  }

  getArtifact(...args: StoreOperations["store.getArtifact"]["input"]): Promise<StoreOperations["store.getArtifact"]["output"]> {
    return this.call("store.getArtifact", args);
  }
  readArtifactBody(
    ...args: StoreOperations["store.readArtifactBody"]["input"]
  ): Promise<StoreOperations["store.readArtifactBody"]["output"]> {
    return this.call("store.readArtifactBody", args);
  }
  pruneArtifacts(...args: StoreOperations["store.pruneArtifacts"]["input"]): Promise<StoreOperations["store.pruneArtifacts"]["output"]> {
    return this.call("store.pruneArtifacts", args);
  }
  eraseArtifacts(...args: StoreOperations["store.eraseArtifacts"]["input"]): Promise<StoreOperations["store.eraseArtifacts"]["output"]> {
    return this.call("store.eraseArtifacts", args);
  }
  pruneVideo(...args: StoreOperations["store.pruneVideo"]["input"]): Promise<StoreOperations["store.pruneVideo"]["output"]> {
    return this.call("store.pruneVideo", args);
  }
  listPendingReview(
    ...args: StoreOperations["store.listPendingReview"]["input"]
  ): Promise<StoreOperations["store.listPendingReview"]["output"]> {
    return this.call("store.listPendingReview", args);
  }
  setReviewState(...args: StoreOperations["store.setReviewState"]["input"]): Promise<StoreOperations["store.setReviewState"]["output"]> {
    return this.call("store.setReviewState", args);
  }
  resolveArtifactPath(
    ...args: StoreOperations["store.resolveArtifactPath"]["input"]
  ): Promise<StoreOperations["store.resolveArtifactPath"]["output"]> {
    return this.call("store.resolveArtifactPath", args);
  }
  listTables(...args: StoreOperations["store.listTables"]["input"]): Promise<StoreOperations["store.listTables"]["output"]> {
    return this.call("store.listTables", args);
  }
  listApplicationTables(
    ...args: StoreOperations["store.listApplicationTables"]["input"]
  ): Promise<StoreOperations["store.listApplicationTables"]["output"]> {
    return this.call("store.listApplicationTables", args);
  }
  getMeta(...args: StoreOperations["store.getMeta"]["input"]): Promise<StoreOperations["store.getMeta"]["output"]> {
    return this.call("store.getMeta", args);
  }
  setMeta(...args: StoreOperations["store.setMeta"]["input"]): Promise<StoreOperations["store.setMeta"]["output"]> {
    return this.call("store.setMeta", args);
  }
  integrityCheck(...args: StoreOperations["store.integrityCheck"]["input"]): Promise<StoreOperations["store.integrityCheck"]["output"]> {
    return this.call("store.integrityCheck", args);
  }
  reclaimSpace(...args: StoreOperations["store.reclaimSpace"]["input"]): Promise<StoreOperations["store.reclaimSpace"]["output"]> {
    return this.call("store.reclaimSpace", args);
  }
  optimize(...args: StoreOperations["store.optimize"]["input"]): Promise<StoreOperations["store.optimize"]["output"]> {
    return this.call("store.optimize", args);
  }
  migrationStatus(...args: StoreOperations["store.migrationStatus"]["input"]): Promise<StoreOperations["store.migrationStatus"]["output"]> {
    return this.call("store.migrationStatus", args);
  }
  transportRowCounts(
    ...args: StoreOperations["store.transportRowCounts"]["input"]
  ): Promise<StoreOperations["store.transportRowCounts"]["output"]> {
    return this.call("store.transportRowCounts", args);
  }
  chatMeasurement(...args: StoreOperations["store.chatMeasurement"]["input"]): Promise<StoreOperations["store.chatMeasurement"]["output"]> {
    return this.call("store.chatMeasurement", args);
  }
  memoryCallSpend(...args: StoreOperations["store.memoryCallSpend"]["input"]): Promise<StoreOperations["store.memoryCallSpend"]["output"]> {
    return this.call("store.memoryCallSpend", args);
  }
  memoryEmbeddingSpend(
    ...args: StoreOperations["store.memoryEmbeddingSpend"]["input"]
  ): Promise<StoreOperations["store.memoryEmbeddingSpend"]["output"]> {
    return this.call("store.memoryEmbeddingSpend", args);
  }
  pruneTransport(...args: StoreOperations["store.pruneTransport"]["input"]): Promise<StoreOperations["store.pruneTransport"]["output"]> {
    return this.call("store.pruneTransport", args);
  }
  tableColumns(...args: StoreOperations["store.tableColumns"]["input"]): Promise<StoreOperations["store.tableColumns"]["output"]> {
    return this.call("store.tableColumns", args);
  }
  listMeta(...args: StoreOperations["store.listMeta"]["input"]): Promise<StoreOperations["store.listMeta"]["output"]> {
    return this.call("store.listMeta", args);
  }
  listSaverTables(...args: StoreOperations["store.listSaverTables"]["input"]): Promise<StoreOperations["store.listSaverTables"]["output"]> {
    return this.call("store.listSaverTables", args);
  }
  listArtifacts(...args: StoreOperations["store.listArtifacts"]["input"]): Promise<StoreOperations["store.listArtifacts"]["output"]> {
    return this.call("store.listArtifacts", args);
  }
  listTaskSessions(
    ...args: StoreOperations["store.listTaskSessions"]["input"]
  ): Promise<StoreOperations["store.listTaskSessions"]["output"]> {
    return this.call("store.listTaskSessions", args);
  }
  taskPrompts(...args: StoreOperations["store.taskPrompts"]["input"]): Promise<StoreOperations["store.taskPrompts"]["output"]> {
    return this.call("store.taskPrompts", args);
  }
  taskNeeds(...args: StoreOperations["store.taskNeeds"]["input"]): Promise<StoreOperations["store.taskNeeds"]["output"]> {
    return this.call("store.taskNeeds", args);
  }
  listTasks(...args: StoreOperations["store.listTasks"]["input"]): Promise<StoreOperations["store.listTasks"]["output"]> {
    return this.call("store.listTasks", args);
  }
  getTask(...args: StoreOperations["store.getTask"]["input"]): Promise<StoreOperations["store.getTask"]["output"]> {
    return this.call("store.getTask", args);
  }
  updateTaskStatus(
    ...args: StoreOperations["store.updateTaskStatus"]["input"]
  ): Promise<StoreOperations["store.updateTaskStatus"]["output"]> {
    return this.call("store.updateTaskStatus", args);
  }
  commitAdmission(...args: StoreOperations["store.commitAdmission"]["input"]): Promise<StoreOperations["store.commitAdmission"]["output"]> {
    return this.call("store.commitAdmission", args);
  }
  listAdmissions(...args: StoreOperations["store.listAdmissions"]["input"]): Promise<StoreOperations["store.listAdmissions"]["output"]> {
    return this.call("store.listAdmissions", args);
  }
  listClaimedAdmissions(
    ...args: StoreOperations["store.listClaimedAdmissions"]["input"]
  ): Promise<StoreOperations["store.listClaimedAdmissions"]["output"]> {
    return this.call("store.listClaimedAdmissions", args);
  }
  latestSettledAdmission(
    ...args: StoreOperations["store.latestSettledAdmission"]["input"]
  ): Promise<StoreOperations["store.latestSettledAdmission"]["output"]> {
    return this.call("store.latestSettledAdmission", args);
  }
  searchTaskHistory(
    ...args: StoreOperations["store.searchTaskHistory"]["input"]
  ): Promise<StoreOperations["store.searchTaskHistory"]["output"]> {
    return this.call("store.searchTaskHistory", args);
  }
  getAdmission(...args: StoreOperations["store.getAdmission"]["input"]): Promise<StoreOperations["store.getAdmission"]["output"]> {
    return this.call("store.getAdmission", args);
  }

  countCheckpoints(
    ...args: StoreOperations["store.countCheckpoints"]["input"]
  ): Promise<StoreOperations["store.countCheckpoints"]["output"]> {
    return this.call("store.countCheckpoints", args);
  }

  nextWakeups(...args: StoreOperations["store.nextWakeups"]["input"]): Promise<StoreOperations["store.nextWakeups"]["output"]> {
    return this.call("store.nextWakeups", args);
  }

  routineSchedule(...args: StoreOperations["store.routineSchedule"]["input"]): Promise<StoreOperations["store.routineSchedule"]["output"]> {
    return this.call("store.routineSchedule", args);
  }

  importProjects(...args: StoreOperations["store.importProjects"]["input"]): Promise<StoreOperations["store.importProjects"]["output"]> {
    return this.call("store.importProjects", args);
  }

  servicesWith(
    options: (args: readonly unknown[], operation: string) => import("@tavi/contracts").PersistenceServiceOptions,
  ): AsyncPersistencePort["services"] {
    return createAsyncServices(this, options);
  }

  /** The worker requests sent since open (or the last `resetOperationCounts`); always on, it is one map increment per request. */
  operationCounts(): WorkerOperationCounts {
    return { total: this.#operationTotal, byOperation: Object.fromEntries(this.#operationCounts) };
  }

  resetOperationCounts(): void {
    this.#operationTotal = 0;
    this.#operationCounts.clear();
  }

  /**
   * Tells `listener` of each request this client settles, resolved or
   * rejected, by operation name and input (a service call's input is its
   * arguments): the hook an in-process cache of what the database holds is
   * invalidated by. A listener's throw is its own. Answers the unsubscribe.
   */
  onSettled(listener: (operation: string, input: unknown) => void): () => void {
    this.#settledListeners.add(listener);
    return () => this.#settledListeners.delete(listener);
  }

  /**
   * How many requests this client has seen change rows since open — a trigger's
   * rows (the Center's version bumps among them) included. Work that only has
   * something to do after a change compares it with the count it last saw.
   */
  get writeCount(): number {
    return this.#writes;
  }

  /**
   * Tells `listener` of each request that changed rows, by operation name, once
   * it has settled: the write signal change-driven work (the Center's watch, the
   * due-work planner) wakes on instead of polling. A read never signals, so a
   * listener's own reads cannot wake it again. A listener's throw is its own.
   * Answers the unsubscribe.
   */
  onWrite(listener: (operation: string) => void): () => void {
    this.#writeListeners.add(listener);
    return () => this.#writeListeners.delete(listener);
  }

  #wrote(operation: string): void {
    this.#writes += 1;
    for (const listener of this.#writeListeners) {
      try {
        listener(operation);
      } catch {
        // A change listener never fails the request it watched.
      }
    }
  }

  #settled(operation: string, input: unknown): void {
    for (const listener of this.#settledListeners) {
      try {
        listener(operation, input);
      } catch {
        // A cache's listener never fails the request it watched.
      }
    }
  }

  #count(operation: string): void {
    this.#operationTotal += 1;
    this.#operationCounts.set(operation, (this.#operationCounts.get(operation) ?? 0) + 1);
  }

  get isOpen(): boolean {
    return !this.#closing && this.#channel.available;
  }

  asPort(): AsyncPersistencePort {
    return this;
  }

  /**
   * A check every artifact this client stores passes first, given what is
   * stored — the owner's free-space floor — so a
   * download, a report or a screenshot is refused, as its caller handles a
   * refused store, rather than filling the volume `tavi.sqlite` shares.
   */
  guardArtifactWrites(check: (input: Parameters<ArtifactRepositoryPort["putArtifact"]>[0]) => void): void {
    this.#artifactWriteCheck = check;
  }

  async putArtifact(input: Parameters<ArtifactRepositoryPort["putArtifact"]>[0]): ReturnType<ArtifactRepositoryPort["putArtifact"]> {
    this.#artifactWriteCheck?.(input);
    const artifactId = input.artifactId ?? prefixedId("art");
    try {
      return await this.call("repository.artifacts.putArtifact", [{ ...input, artifactId }]);
    } catch (error) {
      if (error instanceof TaviError)
        throw new TaviError(error.code, error.message, { cause: error, details: { ...error.details, artifactId } });
      throw error;
    }
  }

  /** `putStagedArtifact`, past the same write check as `putArtifact` (the check reads only what is stored, never its bytes). */
  async putStagedArtifact(input: Parameters<NonNullable<ArtifactRepositoryPort["putStagedArtifact"]>>[0]): Promise<ArtifactRecord> {
    const { stagedPath: _staged, ...fields } = input;
    this.#artifactWriteCheck?.({ ...fields, body: new Uint8Array(0) });
    const artifactId = input.artifactId ?? prefixedId("art");
    try {
      return await this.call("repository.artifacts.putStagedArtifact", [{ ...input, artifactId }]);
    } catch (error) {
      if (error instanceof TaviError)
        throw new TaviError(error.code, error.message, { cause: error, details: { ...error.details, artifactId } });
      throw error;
    }
  }

  cancelTask(input: Parameters<AsyncPersistencePort["cancelTask"]>[0]): ReturnType<AsyncPersistencePort["cancelTask"]> {
    return this.call("tasks.cancel", input, { control: true });
  }

  async call<K extends keyof DatabaseOperations>(
    operation: K,
    input: DatabaseOperations[K]["input"],
    options?: RequestOptions,
    serviceOptions?: import("@tavi/contracts").PersistenceServiceOptions,
  ): Promise<DatabaseOperations[K]["output"]> {
    if (this.#closing) throw new TaviError("UNAVAILABLE", "Database is closing", { details: { mutationOutcome: "not-dispatched" } });
    try {
      return await this.#dispatch(operation, input, options, serviceOptions);
    } finally {
      this.#settled(operation, input);
    }
  }

  async #dispatch<K extends keyof DatabaseOperations>(
    operation: K,
    input: DatabaseOperations[K]["input"],
    options?: RequestOptions,
    serviceOptions?: import("@tavi/contracts").PersistenceServiceOptions,
  ): Promise<DatabaseOperations[K]["output"]> {
    // The checked worker dispatcher and this operation map describe both ends of the private channel.
    if (PAYLOAD_OPERATIONS.includes(operation as PayloadOperation)) {
      if (this.#closing) throw new TaviError("UNAVAILABLE", "Database is closing");
      const result = this.#payload(operation as PayloadOperation, input, options);
      this.#transfers.add(result);
      void result.then(
        () => this.#transfers.delete(result),
        () => this.#transfers.delete(result),
      );
      return (await result) as DatabaseOperations[K]["output"];
    }
    const control =
      options?.control === true ||
      /^(repository\.(executions\.(heartbeat|release|terminate)|receipts\.record|messagingOutbox\.resolve|messagingInbox\.(markProcessed|releaseReplayClaim)|effects\.(finish|complete|fail|resolve)|approvals\.(decide|cancelPendingForTask)|cancellations\.request)|service\.(accounting\.finish|router\.finish)|routine\.runs\.(heartbeat|serviceHeartbeat|finish|settleModel|cancel)|routine\.delivery\.settleDelivery|checkpoint\.closeCursor|tasks\.cancel)$/.test(
        operation,
      );
    this.#count(operation);
    return (await this.#channel.request(operation, serviceOptions === undefined ? input : { args: input, options: serviceOptions }, {
      ...options,
      control,
    })) as DatabaseOperations[K]["output"];
  }

  async #payload(operation: PayloadOperation, input: unknown, options?: RequestOptions): Promise<unknown> {
    let large: Buffer | undefined;
    try {
      serializeBounded(input, 512 * 1024);
    } catch (error) {
      if (!(error instanceof TaviError) || error.code !== "BUDGET_EXCEEDED") throw error;
      if (this.#largeUpload)
        throw new TaviError("BUDGET_EXCEEDED", "A large database upload is already active", {
          details: { mutationOutcome: "not-dispatched" },
        });
      this.#largeUpload = true;
      try {
        large = serialize(input);
      } catch (error) {
        this.#largeUpload = false;
        throw error;
      }
    }
    let result: PayloadResult;
    if (large === undefined) {
      this.#count(operation);
      result = (await this.#channel.request("payload.inline", { operation, input }, options)) as PayloadResult;
    } else {
      const body = large;
      try {
        result = await this.#channel.sequence(async (request) => {
          let id: string | undefined;
          try {
            this.#count("payload.begin");
            id = (await request("payload.begin", { size: body.byteLength }, options)) as string;
            for (let offset = 0; offset < body.byteLength; offset += 512 * 1024) {
              this.#count("payload.append");
              await request("payload.append", { id, offset, bytes: Uint8Array.from(body.subarray(offset, offset + 512 * 1024)) }, options);
            }
            this.#count(operation);
            return (await request("payload.execute", { operation, id }, options)) as PayloadResult;
            // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
          } finally {
            if (id !== undefined) {
              this.#count("payload.close");
              await request("payload.close", id).catch(() => {});
            }
          }
        });
      } finally {
        this.#largeUpload = false;
      }
    }
    if (result.kind === "inline") return result.value;
    if (this.#downloadActive) {
      // Best effort: the refusal below is the answer whether or not the close lands.
      this.#count("payload.close");
      await this.#channel.request("payload.close", result.id, { control: true }).catch(() => undefined);
      throw new TaviError("BUDGET_EXCEEDED", "A large database response is already active", { details: { mutationOutcome: "unknown" } });
    }
    this.#downloadActive = true;
    try {
      const body = Buffer.allocUnsafe(result.size);
      for (let offset = 0; offset < body.byteLength; ) {
        this.#count("payload.read");
        const bytes = (await this.#channel.request("payload.read", { id: result.id, offset }, options)) as Uint8Array;
        if (bytes.byteLength === 0 || bytes.byteLength > body.byteLength - offset)
          throw new TaviError("UNAVAILABLE", "Invalid payload response");
        body.set(bytes, offset);
        offset += bytes.byteLength;
      }
      return deserialize(body);
    } catch (error) {
      throw new TaviError(
        error instanceof TaviError ? error.code : "UNAVAILABLE",
        errorMessage(error, "Database response transfer failed"),
        { cause: error, details: { ...(error instanceof TaviError ? error.details : {}), mutationOutcome: "unknown" } },
      );
      // Best effort: cleanup of something that may already be closed or gone; nothing waits on it.
    } finally {
      this.#downloadActive = false;
      this.#count("payload.close");
      await this.#channel.request("payload.close", result.id, { control: true }).catch(() => {});
    }
  }
  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled([...this.#transfers]);
    return this.#channel.close();
  }
  abort(): Promise<void> {
    this.#closing = true;
    return this.#channel.abort();
  }
}
