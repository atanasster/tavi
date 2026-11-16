import type { RoutineScope, RoutineServicePort, RoutineSnapshot } from "@tavi/contracts";
import { RoutineDeliveryDrain, RoutineRunDrain, type RoutineRunDrainOptions } from "../routines/drain.js";
import type { DatabaseClient } from "./client.js";
import { ROUTINE_METHODS, type RoutineEnvelope, type RoutineOperations, type RoutinePort } from "./routine-protocol.js";
import { rpcGroupClass } from "./rpc.js";
import type { RoutineExecutionOptions as WorkerExecutionOptions } from "../routines/runs.js";
import type { RoutineDeliveryOptions } from "../routines/delivery.js";
import type { RoutineNewsOptions } from "../routines/news.js";
import type { RoutinePublicationService as WorkerPublicationService } from "../routines/publication.js";

/**
 * The owner's routine services: each method of `ROUTINE_METHODS` is a worker
 * request (`rpcGroupClass`), sent with what its group carries beside its
 * arguments — the clock's `now`, the owner's epoch for runs, the news options.
 */
export interface RoutineServiceOptions {
  readonly now?: () => string;
  readonly toolPermissions?: () => Readonly<Record<string, readonly string[]>>;
}
export type RoutineExecutionOptions = Omit<WorkerExecutionOptions, "authorized" | "researchReady" | "cancelTask"> & RoutineRunDrainOptions;

type Operation = keyof RoutineOperations;

/** `now` when the clock gives one, else nothing: the worker then reads its own. */
const at = (now: string | undefined): { now?: string } => (now === undefined ? {} : { now });

export class RoutineService
  extends rpcGroupClass<RoutinePort, "routines">("routine", "routines", ROUTINE_METHODS.routines)
  implements RoutineServicePort
{
  readonly store: DatabaseClient;
  readonly options: RoutineServiceOptions;
  constructor(store: DatabaseClient, options: RoutineServiceOptions = {}) {
    super();
    this.store = store;
    this.options = options;
  }
  call<K extends Operation>(operation: K, input: RoutineOperations[K]["input"]): Promise<RoutineOperations[K]["output"]> {
    const toolPermissions = this.options.toolPermissions?.();
    return this.store.call(operation, toolPermissions === undefined ? input : { ...input, toolPermissions });
  }
  /** One table operation with `envelope` beside its arguments. */
  sendWith(operation: string, args: unknown[], envelope: RoutineEnvelope): Promise<unknown> {
    return this.call(operation as Operation, { ...envelope, args } as RoutineOperations[Operation]["input"]);
  }
  override send(operation: string, args: unknown[]): Promise<unknown> {
    return this.sendWith(operation, args, at(this.options.now?.()));
  }
}

export class RoutineExecutionService extends rpcGroupClass<RoutinePort, "runs">("routine", "runs", ROUTINE_METHODS.runs) {
  readonly routines: RoutineService;
  readonly options: RoutineExecutionOptions;
  private readonly loop: RoutineRunDrain;
  constructor(routines: RoutineService, options: RoutineExecutionOptions) {
    super();
    this.routines = routines;
    this.options = options;
    this.loop = new RoutineRunDrain(this, options);
  }
  override send(operation: string, args: unknown[]): Promise<unknown> {
    return this.routines.sendWith(operation, args, { ownerEpoch: this.options.ownerEpoch, ...at(this.options.now?.()) });
  }
  skillContext(scope: RoutineScope, pins: RoutineSnapshot["skills"]): Promise<string> {
    return this.routines.call("routine.skillContext", { scope, pins });
  }
  async notifyPauses(): Promise<void> {
    if (this.options.onPaused === undefined) return;
    // A notice not yet told (`false`) stays pending for the next sweep.
    for (const { run, cause } of await this.pendingPauses())
      if ((await this.options.onPaused(run, cause)) !== false) await this.acknowledgePause(run.runId);
  }
  get active(): boolean {
    return this.loop.active;
  }
  stop(): void {
    this.loop.stop();
  }
  idle(): Promise<void> {
    return this.loop.idle();
  }
  drain(): Promise<void> {
    return this.loop.drain();
  }
}

export class RoutineNewsService extends rpcGroupClass<RoutinePort, "news">("routine", "news", ROUTINE_METHODS.news) {
  readonly runs: RoutineExecutionService;
  readonly options: RoutineNewsOptions;
  constructor(runs: RoutineExecutionService, options: RoutineNewsOptions = {}) {
    super();
    this.runs = runs;
    this.options = options;
  }
  override send(operation: string, args: unknown[]): Promise<unknown> {
    return this.runs.routines.sendWith(operation, args, { ...at(this.runs.options.now?.()), news: this.options });
  }
}

export class RoutinePublicationService extends rpcGroupClass<RoutinePort, "publication">(
  "routine",
  "publication",
  ROUTINE_METHODS.publication,
) {
  readonly runs: RoutineExecutionService;
  readonly options: RoutineServiceOptions;
  constructor(runs: RoutineExecutionService, options: RoutineServiceOptions = {}) {
    super();
    this.runs = runs;
    this.options = options;
  }
  #now(): string | undefined {
    return this.options.now?.() ?? this.runs.options.now?.();
  }
  override send(operation: string, args: unknown[]): Promise<unknown> {
    return this.runs.routines.sendWith(operation, args, at(this.#now()));
  }
  /** The worker publishes through its own delivery service, so `_delivery` stays here. */
  publish(
    fence: Parameters<WorkerPublicationService["publish"]>[0],
    report: Parameters<WorkerPublicationService["publish"]>[1],
    version: number,
    _delivery: RoutineDeliveryService,
    pdfError: string | null = null,
  ): Promise<RoutineOperations["routine.publication.publish"]["output"]> {
    return this.runs.routines.call("routine.publication.publish", { args: [fence, report, version, pdfError], ...at(this.#now()) });
  }
}

export class RoutineDeliveryService extends rpcGroupClass<RoutinePort, "delivery">("routine", "delivery", ROUTINE_METHODS.delivery) {
  readonly runs: RoutineExecutionService;
  readonly options: RoutineDeliveryOptions;
  private readonly loop: RoutineDeliveryDrain;
  constructor(runs: RoutineExecutionService, options: RoutineDeliveryOptions) {
    super();
    this.runs = runs;
    this.options = options;
    this.loop = new RoutineDeliveryDrain(this, options);
  }
  override send(operation: string, args: unknown[]): Promise<unknown> {
    return this.runs.routines.sendWith(operation, args, at(this.options.now?.() ?? this.runs.options.now?.()));
  }
  get active(): boolean {
    return this.loop.active;
  }
  stop(): void {
    this.loop.stop();
  }
  idle(): Promise<void> {
    return this.loop.idle();
  }
  drain(): Promise<void> {
    return this.loop.drain();
  }
}
