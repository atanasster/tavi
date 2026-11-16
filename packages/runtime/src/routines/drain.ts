import {
  TaviError,
  routineReportFileName,
  type RoutineDeliveryJob,
  type RoutineFence,
  type RoutinePauseCause,
  type RoutineRun,
  type RoutineRunStatus,
  type RoutineScope,
  type SendOutcome,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { AsyncWork } from "../async-work.js";
import { routineFailureSettlement } from "./failures.js";
import type { RoutineDeliveryOptions } from "./delivery.js";

/**
 * The owner's run and delivery drain loops.
 *
 * There is one copy of each. The owner drives them through the database
 * facades (`persistence/routine-facades.ts`); a test drives the same loop
 * against the worker-side services directly, which answer the same calls
 * synchronously. Either way the loop that runs is the one that ships.
 */
type Awaitable<T> = T | Promise<T>;

/** What the run loop asks of the execution service. */
export interface RoutineRunQueue {
  pending(): Awaitable<readonly RoutineRun[]>;
  start(scope: RoutineScope, runId: string): Awaitable<RoutineFence | undefined>;
  get(scope: RoutineScope, runId: string): Awaitable<RoutineRun>;
  cancel(scope: RoutineScope, runId: string): Awaitable<unknown>;
  /** `detail`: the error that cut the attempt short, said with the failure if retries have run out. */
  interrupt(fence: RoutineFence, transient?: boolean, detail?: string): Awaitable<unknown>;
  finish(
    fence: RoutineFence,
    status: Extract<RoutineRunStatus, "failed">,
    reason: "credentials" | "unsupported" | "failed",
    detail?: string,
  ): Awaitable<unknown>;
}
export interface RoutineRunDrainOptions {
  readonly dispatch?: (run: RoutineRun, fence: RoutineFence) => Promise<void>;
  /** A run the drain could not start, dispatch or settle: reported, and left for recovery. */
  readonly onDrainError?: (input: { readonly runId: string; readonly error: unknown }) => void;
}

/** One background owner shared by a drain's single-flight pass. */
abstract class SingleFlight {
  protected readonly work = new AsyncWork();
  private draining: Promise<void> | undefined;
  get active(): boolean {
    return this.work.active;
  }
  stop(): void {
    this.work.stop();
  }
  idle(): Promise<void> {
    return this.work.idle();
  }
  protected once(pass: () => Promise<void>): Promise<void> {
    if (this.draining !== undefined) return this.draining;
    const pending = this.work.run(pass);
    this.draining = pending;
    void pending.then(
      () => {
        this.draining = undefined;
      },
      () => {
        this.draining = undefined;
      },
    );
    return pending;
  }
}

/**
 * The owner's run loop. It dispatches up to `ROUTINE_CONCURRENT_RUNS` runs at
 * once — `start` decides whether a slot is free — and looks at the queue again
 * whenever one of them ends or a drain is asked for while it runs, so a run
 * claimed meanwhile starts beside the one running rather than after it.
 */
export class RoutineRunDrain extends SingleFlight {
  readonly queue: RoutineRunQueue;
  readonly options: RoutineRunDrainOptions;
  /** Wakes a pass that is waiting on its running runs, to look at the queue again. */
  #poke: PromiseWithResolvers<void> | undefined;
  constructor(queue: RoutineRunQueue, options: RoutineRunDrainOptions) {
    super();
    this.queue = queue;
    this.options = options;
  }
  drain(): Promise<void> {
    const dispatch = this.options.dispatch;
    if (dispatch === undefined) return Promise.resolve();
    this.#poke?.resolve();
    return this.once(async () => {
      const running = new Map<string, Promise<void>>();
      // A run is dispatched once a pass: one interrupted here is resumed by a later drain —
      // but for a transient failure's retry, which `start` holds back until its backoff ends.
      const dispatched = new Set<string>();
      try {
        for (;;) {
          this.#poke = Promise.withResolvers<void>();
          for (const pending of await this.queue.pending()) {
            if (this.work.closed) break;
            if (dispatched.has(pending.runId)) continue;
            const fence = await this.begin(pending);
            if (fence === undefined) continue;
            dispatched.add(pending.runId);
            running.set(
              pending.runId,
              this.dispatch(dispatch, pending, fence)
                .then((retry) => {
                  if (retry) dispatched.delete(pending.runId);
                })
                .finally(() => running.delete(pending.runId)),
            );
          }
          if (running.size === 0 || this.work.closed) break;
          await Promise.race([...running.values(), this.#poke.promise]);
        }
      } finally {
        this.#poke = undefined;
        await Promise.all(running.values());
      }
    });
  }
  /** Start one run; one that cannot be started is reported and left for recovery. */
  private async begin(pending: RoutineRun): Promise<RoutineFence | undefined> {
    try {
      return await this.queue.start({ workspaceId: pending.workspaceId, principalId: pending.principalId }, pending.runId);
    } catch (error) {
      this.options.onDrainError?.({ runId: pending.runId, error });
      return undefined;
    }
  }
  /**
   * Dispatch one started run and settle it if it throws. Each run is isolated:
   * one that cannot be dispatched or settled is reported and left for recovery,
   * never allowed to abandon the runs beside or after it.
   *
   * Resolves `true` when the attempt ended in a transient failure's retry: the
   * run may be started again in this pass once its backoff ends, rather than
   * wait behind the pass and run out its deadline. Each retry is counted, and
   * they are bounded, so this cannot spin.
   */
  private async dispatch(
    dispatch: NonNullable<RoutineRunDrainOptions["dispatch"]>,
    pending: RoutineRun,
    fence: RoutineFence,
  ): Promise<boolean> {
    const scope = { workspaceId: pending.workspaceId, principalId: pending.principalId };
    try {
      try {
        await dispatch(await this.queue.get(scope, pending.runId), fence);
      } catch (error) {
        // Read once the dispatch has thrown: `stop()` is how a shutdown reaches
        // this loop, and a run it cut short is resumed, not failed.
        const stopping = this.work.closed;
        const run = await this.queue.get(scope, pending.runId);
        const settlement = routineFailureSettlement(error, fence, stopping, run);
        if (settlement === "cancel") await this.queue.cancel(scope, pending.runId);
        else if (run.status !== "running") return false;
        else if (settlement === "interrupt" || settlement === "transient")
          await this.queue.interrupt(fence, settlement === "transient", errorMessage(error));
        else await this.queue.finish(fence, "failed", settlement, errorMessage(error));
      }
      if (this.work.closed) return false;
      const after = await this.queue.get(scope, pending.runId);
      return after.status === "interrupted" && (after.data.transientRetries ?? 0) > (pending.data.transientRetries ?? 0);
    } catch (error) {
      this.options.onDrainError?.({ runId: pending.runId, error });
      return false;
    }
  }
}

/** What the delivery loop asks of the delivery service. */
export interface RoutineDeliveryQueue {
  reconcileReceipts(): Awaitable<unknown>;
  pendingJobs(): Awaitable<readonly RoutineDeliveryJob[]>;
  claimDelivery(
    scope: RoutineScope,
    jobId: string,
    ready: boolean,
  ): Awaitable<{ job: RoutineDeliveryJob; run: RoutineRun; reportName: string; notifyPause?: RoutinePauseCause } | undefined>;
  acknowledgeDeliveryPause(scope: RoutineScope, jobId: string): Awaitable<unknown>;
  settleDelivery(scope: RoutineScope, jobId: string, outcome: SendOutcome | undefined, timedOut?: boolean): Awaitable<unknown>;
}

export class RoutineDeliveryDrain extends SingleFlight {
  readonly queue: RoutineDeliveryQueue;
  readonly options: RoutineDeliveryOptions;
  constructor(queue: RoutineDeliveryQueue, options: RoutineDeliveryOptions) {
    super();
    this.queue = queue;
    this.options = options;
  }
  /**
   * A routine target's destination, built by its connection's channel:
   * the target's `chatId` is the channel's own target —
   * a chat id, an email address. A connection that is not open, or cannot be
   * sent to but as a reply, is a failed delivery.
   */
  destinationFor(target: { readonly connectionId: string; readonly chatId: string }): unknown {
    const destination = this.options.messaging.buildDestination(target.connectionId, { to: target.chatId });
    if (destination === undefined)
      throw new TaviError("UNAVAILABLE", `Connection ${target.connectionId} is not open, or its channel cannot be sent to this way`);
    return destination;
  }
  drain(): Promise<void> {
    return this.once(async () => {
      await this.queue.reconcileReceipts();
      for (const pending of await this.queue.pendingJobs()) {
        if (this.work.closed) break;
        const scope = { workspaceId: pending.data.target.workspaceId, principalId: pending.data.target.principalId };
        const ready = this.options.ready === undefined || (await this.options.ready(pending));
        const claim = await this.queue.claimDelivery(scope, pending.jobId, ready);
        if (claim === undefined) continue;
        const { job, run } = claim;
        if (claim.notifyPause !== undefined) {
          // Untold (`false`), the pause is told again when the job next comes back.
          if (this.options.onPaused === undefined || (await this.options.onPaused(run, job.data.targetId, claim.notifyPause)) !== false)
            await this.queue.acknowledgeDeliveryPause(scope, job.jobId);
          continue;
        }
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const outcome = await Promise.race([
            this.work.track(
              this.options.messaging.send({
                effectId: job.effectId,
                workspaceId: scope.workspaceId,
                connectionId: job.data.target.connectionId,
                destination: this.destinationFor(job.data.target),
                parts:
                  job.data.text === undefined
                    ? [
                        {
                          kind: "file",
                          artifactId: job.data.artifactId,
                          // Named as the report is titled: by the routine's name when the report was selected.
                          filename: `${routineReportFileName(run.snapshot, claim.reportName)}.${run.snapshot.delivery.format}`,
                        },
                      ]
                    : [{ kind: "text", content: job.data.text }],
              }),
            ),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new TaviError("UNAVAILABLE", "Delivery receipt deadline exceeded"));
              }, run.snapshot.execution.deliveryMinutes * 60_000);
            }),
          ]);
          await this.queue.settleDelivery(scope, job.jobId, outcome);
        } catch {
          await this.queue.settleDelivery(scope, job.jobId, undefined, timedOut);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    });
  }
}
