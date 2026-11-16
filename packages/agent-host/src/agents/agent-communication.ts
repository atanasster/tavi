import type {
  AccessPolicyPort,
  ArtifactRepositoryPort,
  AgentCommunicationServicePort,
  AgentDelegationRepositoryPort,
  AgentMailboxRepositoryPort,
  AgentWaitOutcome,
  AgentWaitRepositoryPort,
  MemoryServicePort,
  TaskRepositoryPort,
  WorkflowPort,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { type AgentCommunicationContext, TERMINAL_TASK_STATUSES } from "./agent-communication/context.js";
import { spawn } from "./agent-communication/spawn.js";
import { send, receive, ack, status, cancel, getArtifact } from "./agent-communication/mail.js";
import { wake, announceWorkerResult, workersOutstanding, wakeIfOwed, announceUnreported } from "./agent-communication/results.js";
import { request, reply, waitFor } from "./agent-communication/waits.js";

export { TERMINAL_TASK_STATUSES };

/**
 * Orchestrator-to-worker delegation and worker-to-worker peer messaging.
 *
 * Implements `spawn`/`send`/`wake`/`receive`/`ack`/`status`/`cancel`/
 * `waitFor`/`request`/`reply`.
 *
 * **`request`/`reply`** are thin wrappers
 * around the same envelope-delivery machinery `send` already uses —
 * `request` self-correlates its envelope (`correlationId = messageId`) so
 * the existing `agents.wait { correlationId }` path (unchanged from the
 * interrupt work) is what a caller uses to block for the answer; `reply`
 * looks up the original request's envelope to resolve who to send back to
 * and which agent it needs the peer-messaging grant against. Both go
 * through `assertPeerGrant`, the "explicit recipient grant, not merely
 * knowing an ID" requirement `send` (orchestrator→worker, authorized by
 * task ownership) never needed. `expectedReplySchema` is validated
 * in-process only — held in a local `Map` keyed by `messageId`, never
 * persisted, since it arrives as a live value (a `z.ZodType` in practice,
 * typed `unknown` at this port boundary the same way `ToolDefinition`'s
 * canonical schema is) with no serializable wire form this contract
 * defines. A process restart between `request` and its `reply` loses the
 * ability to validate that specific reply against its declared schema —
 * disclosed here rather than solved, since solving it would mean either
 * persisting a serialized schema (a real design question, e.g. JSON
 * Schema conversion, not attempted here) or blocking cross-restart
 * requests entirely, which the rest of this plugin's restart-survival
 * design does not otherwise require.
 *
 * **`waitFor`'s suspend/resume path**: a wait checkpoints the workflow
 * and releases the execution slot, which needs a real LangGraph
 * `interrupt()` — the same mechanism approvals already suspend on. This
 * plugin must not import runtime implementations or LangGraph classes into
 * its public API, so it cannot call `interrupt()` itself. Instead: `waitFor`
 * rechecks durable mail/worker status immediately and returns a real
 * settled outcome when one is already available (so an early reply is
 * never missed); when nothing settles, it registers a durable `prepared`/
 * `active` wait row and throws `WorkflowWaitSuspend` — a plain marker
 * class (`packages/contracts`), not a `TaviError` — which
 * `workflow/nodes/tools/waits.ts`'s `runWaitCall` specifically catches
 * and turns into a real `interrupt()` call. `waitId` is either caller-supplied (the graph's direct dispatch
 * passes a deterministic id derived from checkpointed state, so a
 * replayed node calls this with the exact same id every time — see
 * `AgentWaitForInput.waitId`'s own doc comment) or freshly generated (a
 * caller outside the graph, where determinism doesn't matter). A durable
 * row already `settled` under the given `waitId` short-circuits
 * immediately, ahead of every other check — this is what lets a resumed
 * graph pass find its answer from `send()`'s wait-aware settle-and-admit
 * branch (or the expiry sweep) without re-registering or re-throwing.
 *
 * Two more gaps, disclosed with the same rigor rather than left implicit:
 *
 *  - `spawn` awaits the worker's first turn unless asked to run it in the
 *    background (`background`, honoured for a spawner that hears back from it): it
 *    then answers once the worker's task exists, and the worker's result
 *    comes back through `announceWorkerResult` when it ends.
 *  - Every operation that takes a `taskId`/`recipientTaskId` asserts the
 *    target task belongs to the caller's own workspace via
 *    `assertOwnsTask` in `agent-communication/context.ts`: delivery is
 *    scoped to the workspace, and cross-workspace delivery is refused.
 *    `send` (orchestrator→worker)
 *    relies on this same-workspace-only check alone, since ownership
 *    already implies authority there; `request`/`reply` additionally
 *    require the scoped `agentMessageGrant` permission (`assertPeerGrant`,
 *    also in `agent-communication/context.ts`), since sender and
 *    recipient are siblings, not parent/child.
 *    Three operations are scoped tighter than the workspace: a correlation
 *    wait settles only on an envelope addressed to the waiting task
 *    (`waitFor`); a `result` settles a correlation wait only as a delegated
 *    child's own `worker-result:<id>` (`settlesCorrelationWait`), so a
 *    peer's answer still goes through `reply`'s grant and schema checks;
 *    and `cancel` reaches only the caller's own task and its delegated
 *    descendants, except for the system actor (no `runId`).
 *  - Active wait-graph deadlock detection (peer A waits on B, B waits on
 *    A, or longer cycles) is **not implemented**: arbitrary peer cycles
 *    resolve only via their bounded per-wait deadlines, never a
 *    cycle-detection short-circuit.
 *  - **`request`/`waitFor` deadlines are capped by the remaining root-task
 *    deadline** — `capDeadlineToRootBudget` in
 *    `agent-communication/context.ts`. `spawn` persists an
 *    `AgentDelegatedBudget`, which narrows/inherits `expiresAt` down a
 *    delegation chain via `mergeBudget`, so the cap needs no cascading
 *    system of its own, only that already-inherited `budget.expiresAt`.
 *    A task with no delegation
 *    row (an orchestrator's own root task, never itself spawned) has no
 *    cap — only a worker whose spawning chain set `budget.expiresAt` is
 *    ever bounded, matching "root-task" literally.
 */

const DEFAULT_LEASE_MS = 5 * 60 * 1000;

export interface AgentCommunicationServiceOptions {
  readonly mailbox: AgentMailboxRepositoryPort;
  readonly waits: AgentWaitRepositoryPort;
  readonly delegations: AgentDelegationRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly workflow: WorkflowPort;
  /**
   * Only consulted by `request`/`reply` (`assertPeerGrant`) via
   * `agentMessageGrant` — `send`/`spawn`/etc. rely on task ownership alone,
   * per this module's own header comment.
   */
  readonly access: AccessPolicyPort;
  /**
   * Where a non-fatal anomaly is reported.
   *
   * Used for the one thing a caller cannot otherwise observe: a worker that
   * inherited the conservative execution policy because its parent's identity or
   * row was missing. The child still runs (fail closed), but an operator can see
   * that the inheritance rule did not apply.
   */
  readonly onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * Payload offload: `send`/`request`/`reply`
   * content over `MAX_AGENT_ENVELOPE_INLINE_BYTES` publishes through this
   * store instead of being rejected outright — the same
   * `ArtifactRepositoryPort` memory/compaction already use.
   * Optional: when omitted, an over-cap payload is rejected (fail closed).
   */
  readonly artifacts?: ArtifactRepositoryPort;
  /**
   * `spawn`'s validation of `AgentSpawnInput.sharedMemoryRecordIds`:
   * each requested id is read under the spawning
   * actor's own `MemoryActor` before admission proceeds, so a record the
   * spawner cannot itself read is rejected rather than silently granted to
   * its worker. Optional, matching `artifacts`' pattern: when omitted, a
   * non-empty `sharedMemoryRecordIds` fails closed with `INVALID_INPUT`
   * rather than being granted unchecked.
   */
  readonly memory?: MemoryServicePort;
  /**
   * Cancellation is not routed through `WorkflowPort.admit`'s `"cancel"`
   * `AdmissionKind` today — that kind is declared but nothing implements
   * it. The real cancellation path (`apps/cli/src/features/tasks/mutations.ts`'s
   * `recordCancellation`) is a direct store transaction the CLI/IPC layer
   * calls outside `WorkflowPort` entirely. Injected here so this plugin
   * stays decoupled from `@tavi/runtime` rather than
   * reimplementing that transaction.
   */
  readonly cancelTask: (input: { readonly taskId: string; readonly reason: string; readonly operator: string }) => void | Promise<void>;
  readonly now?: () => string;
  readonly newId?: (prefix: string) => string;
  /** Default `receive` lease duration in milliseconds. */
  readonly leaseMs?: number;
  /** Told of a wait `cancel` settles, so whatever announced it can say it was withdrawn. */
  readonly onWaitSettled?: (waitId: string, outcome: AgentWaitOutcome) => Promise<void>;
}

export function createAgentCommunicationService(options: AgentCommunicationServiceOptions): AgentCommunicationServicePort {
  const ctx: AgentCommunicationContext = {
    options,
    now: options.now ?? nowTimestamp,
    newId: options.newId ?? ((prefix: string): string => `${prefix}-${crypto.randomUUID()}`),
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    expectedReplySchemas: new Map(),
    owed: new Map(),
  };
  return {
    spawn: (input) => spawn(ctx, input),
    send: (input) => send(ctx, input),
    wake: (input) => wake(ctx, input),
    request: (input) => request(ctx, input),
    reply: (input) => reply(ctx, input),
    receive: (input) => receive(ctx, input),
    ack: (input) => ack(ctx, input),
    waitFor: (input) => waitFor(ctx, input),
    status: (input) => status(ctx, input),
    cancel: (input) => cancel(ctx, input),
    announceWorkerResult: (taskId) => announceWorkerResult(ctx, taskId),
    workersOutstanding: (taskId) => workersOutstanding(ctx, taskId),
    wakeIfOwed: (taskId) => wakeIfOwed(ctx, taskId),
    announceUnreported: (input) => announceUnreported(ctx, input),
    getArtifact: (input) => getArtifact(ctx, input),
  };
}
