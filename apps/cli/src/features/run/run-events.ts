import {
  ApprovalProvenanceSchema,
  EVENT_TEXT_BOUNDS,
  CONTENT_LABEL_LIMITS,
  clipArgValue,
  maskArgOrigins,
  TaviError,
  maskPluginText,
  redactToolOutput,
  redactToolText,
  TURN_SUGGESTION_MAX_CHARS,
  approvalRowId,
  boundTurnKnownUrls,
  type AgentDelegationAdmissionRecord,
  type AgentDelegationRepositoryPort,
  type AdmissionOutcome,
  type AdmissionResult,
  type AdmitInput,
  type ClientEvent,
  type ModelEvent,
  type ToolDispatchEvent,
  type TranscriptRepositoryPort,
  type UnsequencedClientEvent,
  type WorkflowInvokeOptions,
  type WorkflowPort,
  TURN_STOPPED_MESSAGE,
} from "@tavi/contracts";
import { definedOnly, errorMessage, nowTimestamp } from "@tavi/contracts/util";
import type { RunEventBus } from "@tavi/runtime";

import { createTurnRecorder } from "./turn-recorder.js";

/**
 * The one place admission activity becomes client events.
 *
 * The admission decorator (`withRunEvents`) is the single producer: every
 * admission — the daemon's, and the foreground CLI's — publishes its stream to
 * the bus through it, and every front end consumes that stream
 * (`createTaskStreamRenderer` for the CLI, an IPC subscription for an attached
 * client). A parity test asserts one fixture run yields the same NDJSON in the
 * foreground and attached, modulo `epoch`, `at` and minted ids.
 *
 * The decorator exists because `WorkflowInvokeOptions` cannot carry lifecycle:
 * that hook has model/tool callbacks, a signal and a lease, and nothing that
 * fires on admission or on the resolved outcome. Injecting a handler factory into
 * each admitting call site (rev 5's approach) also missed three of the ten sites
 * that admit, because the scheduler and the wait sweep receive a `WorkflowPort`
 * and nothing else. Wrapping the port once covers every one of them, since each
 * already receives it.
 */

/** What a producer hands to the sink or the bus before the envelope is assigned. */
type EventEmit = (event: UnsequencedClientEvent) => void;

/** Whether two bounded known-URL lists are the same, in order. */
function sameUrls(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((url, index) => url === b[index]);
}

/** How long a text delta waits for the next of its block before it is published alone. */
export const DELTA_COALESCE_MS = 16;
/** Deltas merge only while the merged text stays under this many characters. */
export const DELTA_COALESCE_CHARS = 1024;

type TextDelta = Extract<UnsequencedClientEvent, { kind: "text.delta" }>;

/**
 * One admission's publisher, with the model's per-token text deltas merged.
 *
 * A delta waits up to `DELTA_COALESCE_MS` for the next of the same block and
 * attempt, so a streamed answer costs the bus, the fan-out and every client's
 * reducer one event per few tokens rather than one per token. A merge never
 * splits a chunk and stops below `DELTA_COALESCE_CHARS`: a chunk that large
 * already passes through whole, as it always did. Any other event publishes
 * the waiting delta first, so the stream's order is the model's; a merged
 * delta is tainted when any of its parts was, with the newest `knownUrls`.
 */
export function createDeltaCoalescer(
  publish: (taskId: string, event: UnsequencedClientEvent) => void,
  windowMs = DELTA_COALESCE_MS,
): {
  /** Publish `event`, holding a text delta briefly to merge it with the next. */
  readonly send: (taskId: string, event: UnsequencedClientEvent) => void;
  /** Publish the delta held now. */
  readonly flush: () => void;
} {
  let held: { readonly taskId: string; event: TextDelta } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const waiting = held;
    held = undefined;
    if (waiting !== undefined) publish(waiting.taskId, waiting.event);
  };
  const send = (taskId: string, event: UnsequencedClientEvent): void => {
    if (event.kind !== "text.delta") {
      flush();
      publish(taskId, event);
      return;
    }
    const prior = held?.event;
    if (
      prior !== undefined &&
      held?.taskId === taskId &&
      prior.attemptId === event.attemptId &&
      prior.blockId === event.blockId &&
      prior.text.length + event.text.length < DELTA_COALESCE_CHARS
    ) {
      const tainted = prior.tainted === true || event.tainted === true;
      const knownUrls = event.knownUrls ?? prior.knownUrls;
      const { tainted: _tainted, knownUrls: _knownUrls, ...rest } = event;
      held.event = {
        ...rest,
        text: prior.text + event.text,
        ...(tainted ? { tainted: true } : {}),
        ...(knownUrls === undefined ? {} : { knownUrls }),
      };
      return;
    }
    flush();
    if (event.text.length >= DELTA_COALESCE_CHARS) {
      publish(taskId, event);
      return;
    }
    held = { taskId, event };
    timer = setTimeout(flush, windowMs);
    timer.unref?.();
  };
  return { send, flush };
}

/** A tainted turn's `task.completed` carries the taint whole, so a client that missed a delta still has it. */
function withEndTaint(event: UnsequencedClientEvent, knownUrls: string[] | undefined): UnsequencedClientEvent {
  if (knownUrls === undefined || event.kind !== "task.completed") return event;
  return { ...event, tainted: true, ...(knownUrls.length === 0 ? {} : { knownUrls }) };
}

/**
 * Translate graph activity into client events.
 *
 * Only text deltas come from the model stream: tool lifecycle events come from
 * the graph, which is the only place that knows whether a requested call was
 * actually dispatched or denied.
 */
function createGraphEventHandlers(
  emit: EventEmit,
  idFields: () => Pick<ClientEvent, "runId" | "attemptId">,
  onAttempt: (attemptId: string) => void,
  delegationOf?: (taskId: string) => Promise<AgentDelegationAdmissionRecord | undefined>,
): {
  readonly onModelEvent: (event: ModelEvent) => void;
  readonly onGraphToolEvent: (event: ToolDispatchEvent) => Promise<void>;
} {
  return {
    onModelEvent(event: ModelEvent): void {
      onAttempt(event.attemptId);
      if (event.type === "text.delta") {
        emit({ ...idFields(), kind: "text.delta", blockId: event.blockId, text: event.text });
      }
    },
    async onGraphToolEvent(event: ToolDispatchEvent): Promise<void> {
      const identity = { ...idFields(), ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }) };
      if (event.phase === "started") {
        emit({
          ...identity,
          kind: "tool.started",
          blockId: event.callId,
          callId: event.callId,
          toolName: event.toolName,
          input: event.input ?? null,
        });
        return;
      }
      if (event.phase === "completed") {
        const child = (event.output as { workerTaskId?: unknown } | null)?.workerTaskId;
        const edge = event.toolName === "agents.spawn" && typeof child === "string" ? await delegationOf?.(child) : undefined;
        if (edge?.parentTaskId === idFields().runId)
          emit({
            ...idFields(),
            kind: "task.spawned",
            childRunId: edge.workerTaskId,
            workerAgentId: edge.workerAgentId,
            depth: edge.depth,
            ...(edge.agentDefinitionId ? { agentDefinitionId: edge.agentDefinitionId } : {}),
          });
        emit({
          ...identity,
          kind: "tool.completed",
          callId: event.callId,
          toolName: event.toolName,
          output: event.output ?? null,
          durationMs: event.durationMs ?? 0,
          ...(event.redacted === undefined ? {} : { redacted: event.redacted }),
        });
        return;
      }
      emit({
        ...identity,
        kind: "tool.failed",
        callId: event.callId,
        toolName: event.toolName,
        errorCode: "TOOL_FAILED",
        message: event.message ?? "tool failed",
        durationMs: event.durationMs ?? 0,
      });
    },
  };
}

/**
 * The events a resolved admission stands for.
 *
 * The decorator maps every resolved admission through this; the front ends
 * render its output rather than calling it (the foreground reports only the
 * stderr guidance and exit code the stream cannot carry).
 *
 * Returns whether any event was emitted.
 */
/**
 * A round's call as clients are shown it with `tools.redactResults` on:
 * its input, and the summary, display and risk reasons built from it, masked.
 * The round's own record keeps the real input, which approvals bind to.
 */
/**
 * A round's provenance masked as its input is: every text in it that the
 * input or a page supplied — argument origins, principals, refs' hosts and
 * titles — masked whole and clipped to its bound again, so a placeholder
 * longer than what it replaced never breaks the schema. One that does not
 * parse is masked as output, and the emitter leaves it out.
 */
function maskedProvenance(provenance: unknown): unknown {
  const parsed = ApprovalProvenanceSchema.safeParse(provenance);
  if (!parsed.success) return redactToolOutput(provenance).value;
  const mask = (text: string): string => redactToolText(text).text;
  const limits = CONTENT_LABEL_LIMITS;
  return {
    ...parsed.data,
    principals: parsed.data.principals.map((principal) => clipArgValue(mask(principal), limits.maxPrincipalLength)),
    refs: parsed.data.refs.map((ref) => ({
      ...ref,
      ref: clipArgValue(mask(ref.ref), limits.maxRefLength),
      ...(ref.host === undefined ? {} : { host: clipArgValue(mask(ref.host), limits.maxHostLength) }),
      ...(ref.title === undefined ? {} : { title: clipArgValue(mask(ref.title), limits.maxTitleLength) }),
    })),
    argOrigins: maskArgOrigins(parsed.data.argOrigins, mask),
  };
}

export function maskedRoundRequest<
  T extends {
    readonly summary: string;
    readonly input: unknown;
    readonly display?: unknown;
    readonly risk?: unknown;
    readonly provenance?: unknown;
  },
>(request: T): T {
  return {
    ...request,
    summary: redactToolText(request.summary).text,
    input: redactToolOutput(request.input).value,
    ...(request.display === undefined ? {} : { display: redactToolOutput(request.display).value }),
    ...(request.risk === undefined ? {} : { risk: redactToolOutput(request.risk).value }),
    ...(request.provenance === undefined ? {} : { provenance: maskedProvenance(request.provenance) }),
  };
}

export function emitOutcomeEvents(
  outcome: AdmissionOutcome,
  taskId: string,
  emit: EventEmit,
  attemptId: string,
  /** Mask a round's call inputs, as `tool.started`'s are: the round's own record keeps them. */
  maskInputs = false,
): void {
  const idFields = { runId: taskId, attemptId };
  if (outcome.status === "completed") {
    emit({ ...idFields, kind: "task.completed", finalText: outcome.finalText });
    return;
  }
  if (outcome.status === "waiting" && outcome.reviewInterrupt !== undefined) {
    const steps = outcome.reviewInterrupt.requests[0]?.steps;
    if (steps === undefined) return;
    emit({
      ...idFields,
      kind: "task.review_required",
      steps,
      requests: outcome.reviewInterrupt.requests.map((request) => ({
        artifactId: request.artifactId,
        toolName: request.toolName,
        callId: request.callId,
      })),
    });
    return;
  }
  if (outcome.status === "waiting" && outcome.waitInterrupt !== undefined) {
    const wait = outcome.waitInterrupt.wait;
    const on =
      wait.correlationId !== undefined
        ? `a reply correlated to ${wait.correlationId}`
        : wait.waitingOnWorkerTaskId !== undefined
          ? `worker task ${wait.waitingOnWorkerTaskId} completing`
          : "its deadline";
    emit({
      ...idFields,
      kind: "task.waiting",
      on,
      deadlineAt: wait.deadlineAt,
      ...definedOnly({
        question: outcome.waitInterrupt.question,
        choices: outcome.waitInterrupt.choices,
        workerTaskId: wait.waitingOnWorkerTaskId,
        context: outcome.waitInterrupt.context,
        handoff: outcome.waitInterrupt.handoff,
        connect: outcome.waitInterrupt.connect,
      }),
      waitId: wait.waitId,
    });
    return;
  }
  if (outcome.status === "waiting" && outcome.interrupt !== undefined) {
    for (const raw of outcome.interrupt.requests) {
      const request = maskInputs ? maskedRoundRequest(raw) : raw;
      emit({
        ...idFields,
        kind: "approval.required",
        callId: request.callId,
        toolName: request.toolName,
        summary: request.summary,
        input: request.input,
        steps: request.steps,
        approvalId: approvalRowId(taskId, request.callId, request.steps),
        effect: request.effect,
        ...(request.risk === undefined ? {} : { risk: request.risk }),
        ...(request.display === undefined ? {} : { display: request.display }),
        ...(request.allowedScopes === undefined ? {} : { allowedScopes: [...request.allowedScopes] }),
        // Read defensively: the outcome may be a durable one written before the
        // payload carried subjects, re-projected verbatim.
        ...("subjects" in request && Array.isArray(request.subjects)
          ? { subjects: request.subjects.filter((subject): subject is string => typeof subject === "string") }
          : {}),
        ...("scopeGroup" in request && typeof request.scopeGroup === "string" ? { scopeGroup: request.scopeGroup } : {}),
        // Why it is asked, and from where; an older durable outcome has none, and one that no longer parses is left out.
        ...(request.provenance !== undefined && ApprovalProvenanceSchema.safeParse(request.provenance).success
          ? { provenance: request.provenance }
          : {}),
      });
    }
    return;
  }
  if (outcome.status === "stopped") {
    emit({ ...idFields, kind: "task.stopped", message: outcome.finalText });
    return;
  }
  emit({
    ...idFields,
    kind: "task.failed",
    errorCode: outcome.error?.code ?? "INTERNAL",
    message: outcome.finalText,
  });
}

/**
 * Task-keyed abort registry.
 *
 * `abort` signals the *current* admission's controller, so it reaches every
 * resumed turn rather than only IPC-started ones. Entries are released when the
 * admission settles, so a finished task is not abortable and `abort` can answer
 * `NOT_RUNNING` with a clean conscience.
 */
export interface AbortRegistry {
  /** Publish a controller under a task id once the task exists. */
  register(taskId: string, controller: AbortController): void;
  release(taskId: string, controller: AbortController): void;
  signalFor(taskId: string): AbortSignal | undefined;
  has(taskId: string): boolean;
  /** Stop the task's running admission; false when none is running. */
  abort(taskId: string): boolean;
  /**
   * Stop every running admission — shutdown's last resort for the ones still
   * running when its drain deadline passes. Returns how many were signalled.
   */
  abortAll(reason: Error): number;
}

export function createAbortRegistry(): AbortRegistry {
  const controllers = new Map<string, AbortController>();
  return {
    register(taskId, controller) {
      // A task has one running admission at a time (the execution lease is
      // exclusive), so replacing is correct rather than a loss.
      controllers.set(taskId, controller);
    },
    release(taskId, controller) {
      // Only if it is still the current one: a settled older admission must not
      // deregister the admission that replaced it.
      if (controllers.get(taskId) === controller) controllers.delete(taskId);
    },
    signalFor: (taskId) => controllers.get(taskId)?.signal,
    has: (taskId) => controllers.has(taskId),
    abort(taskId) {
      const controller = controllers.get(taskId);
      if (controller === undefined) return false;
      controller.abort(new TaviError("STOPPED", TURN_STOPPED_MESSAGE));
      // Released here as well as in the admission's `finally`: an abort that
      // raced a settle would otherwise leave `abort` answering for a task that
      // is no longer running.
      controllers.delete(taskId);
      return true;
    },
    abortAll(reason) {
      const running = [...controllers.values()];
      controllers.clear();
      for (const controller of running) controller.abort(reason);
      return running.length;
    },
  };
}

/**
 * Counts the admissions running through the decorator ("Shutdown").
 *
 * The plugin host's stop closes admission and disposes plugins, but nothing
 * waited for a turn already running: shutting down under one disposed the store
 * beneath it, and an attached client never saw the run's final event. `serve`
 * waits here, under its drain deadline, before it tears anything down.
 */
export interface AdmissionTracker {
  /** Admissions currently in flight. */
  readonly active: () => number;
  /**
   * Refuse every further admission (shutdown closes admission before
   * it drains). Irreversible: an owner that closed admission is stopping.
   */
  readonly close: () => void;
  /** Whether admission was closed: a producer with work queued stops starting it. */
  readonly closed: () => boolean;
  /** Resolves true once none are in flight, or false when the deadline passes first. */
  idle(deadlineMs: number): Promise<boolean>;
}

export function createAdmissionTracker(): AdmissionTracker & {
  readonly begin: () => void;
  readonly end: () => void;
} {
  let active = 0;
  let closed = false;
  let waiters: (() => void)[] = [];
  return {
    active: () => active,
    close: () => {
      closed = true;
    },
    closed: () => closed,
    begin: () => {
      // Refused before any work, so a producer that admits during a drain — a
      // schedule fire, a chat message, a sweep — cannot start on a store that is
      // about to be disposed, and the drain can only go down. Producers already
      // treat an `UNAVAILABLE` rejection as a failed fire or ingest.
      if (closed) throw new TaviError("UNAVAILABLE", "the owner is shutting down; admission is closed");
      active += 1;
    },
    end: () => {
      active = Math.max(0, active - 1);
      if (active > 0) return;
      const settled = waiters;
      waiters = [];
      for (const resolve of settled) resolve();
    },
    idle(deadlineMs) {
      if (active === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((waiter) => waiter !== done);
          resolve(false);
        }, deadlineMs);
        timer.unref?.();
        const done = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        waiters.push(done);
      });
    },
  };
}

export interface RunEventsOptions {
  readonly delegations?: AgentDelegationRepositoryPort;
  readonly bus: RunEventBus;
  readonly aborts?: AbortRegistry;
  readonly admissions?: ReturnType<typeof createAdmissionTracker>;
  readonly onDiagnostic?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * Where each claimed admission's turn is saved as it ends; absent,
   * nothing is saved. With `reconcile`, the turns of the chat an earlier save
   * lost are saved from their admissions first, so the history stays in order.
   */
  readonly transcripts?: Pick<TranscriptRepositoryPort, "append"> & Partial<Pick<TranscriptRepositoryPort, "reconcile">>;
  readonly now?: () => string;
  /**
   * What the memory tools returned to a task's turn, taken when its turn is saved, and
   * dropped when its next admission is claimed: the turn's `memoryUsed` holds it beside its evidence.
   */
  readonly memoryReads?: {
    take(taskId: string): {
      readonly records: readonly { readonly recordId: string; readonly revisionId: string }[];
      readonly listed: readonly { readonly recordId: string; readonly revisionId: string }[];
    };
  };
  /** Told as an admission is claimed, before it runs: its memory proposals are its own. */
  readonly onAdmissionClaimed?: (taskId: string, admissionId: string) => void;
  /**
   * Told once an admission left its task completed or failed: a worker's
   * result goes to its parent, the turn's memory card is posted.
   * `admissionId` is the admission's, when it was claimed, and
   * `outcome` how it ended (absent when the admission threw). Best effort.
   */
  readonly onTaskEnded?: (taskId: string, admissionId?: string, outcome?: AdmissionOutcome) => Promise<void>;
  /**
   * Told once a claimed admission ended, whatever its outcome: the steers its
   * turn did not take are handed on as the chat's next turn. Not
   * awaited; a failure is reported.
   */
  readonly onAdmissionEnded?: (taskId: string) => Promise<unknown>;
  /** Whether a workspace masks tool data shown to clients (`tools.redactResults`); absent, nothing is masked here. */
  readonly maskInputs?: (workspaceId: string) => Promise<boolean>;
}

/**
 * The attempt id an admission's own events carry until its first model call.
 *
 * Derived from the admission rather than minted, so every observer of one
 * admission — the foreground renderer, an attached client — names it the same.
 */
export function attemptIdFor(admissionId: string): string {
  return `attempt-${admissionId}`;
}

/** How many tasks' last attempt the decorator remembers (least recently used). */
const LAST_ATTEMPT_LIMIT = 4096;

/**
 * The `approval.settled` an approval resume stands for, when it names its round
 * and its per-call decisions — every front end's does (the foreground loop, the
 * offline command, chat, `approve`, a schedule's policy). A round recorded before
 * rounds existed has no `steps` for the event, and is not announced.
 */
function approvalSettledBy(
  input: AdmitInput,
): { readonly steps: number; readonly decisions: { callId: string; approved: boolean }[]; readonly decidedBy: string } | undefined {
  const resume = input.resume;
  if (input.kind !== "approval" || resume?.expectedSteps === undefined || resume.decisions === undefined) return undefined;
  return {
    steps: resume.expectedSteps,
    decisions: resume.decisions.map((decision) => ({ callId: decision.callId, approved: decision.approved })),
    decidedBy: resume.decidedBy ?? resume.decisions[0]?.decidedBy ?? input.context.principalId,
  };
}

/**
 * The `wait.settled` a deadline resume stands for, when it names its wait:
 * every settle path does, so every attached client hears the answer —
 * and who gave it, through what — whichever front end it came from.
 */
function waitSettledBy(
  input: AdmitInput,
):
  | Omit<Extract<ClientEvent, { kind: "wait.settled" }>, "protocolVersion" | "epoch" | "sequence" | "runId" | "attemptId" | "at" | "kind">
  | undefined {
  const resume = input.resume;
  if (input.kind !== "deadline" || resume?.waitOutcome === undefined || resume.waitId === undefined) return undefined;
  const outcome = resume.waitOutcome;
  return {
    waitId: resume.waitId,
    outcome: outcome.kind,
    ...(outcome.answers === undefined || outcome.answers.length === 0 ? {} : { answers: [...outcome.answers] }),
    // Clamped by the bus (`boundEventPayloads`), as every event's text is.
    ...definedOnly({
      replyText: outcome.replyText,
      decidedBy: resume.decidedBy,
      via: resume.via,
      handoff: outcome.handoff,
      connect: outcome.connect,
    }),
  };
}

/** The attempt an event names when no admission of its task was claimed here. */
const UNCLAIMED_ATTEMPT = "attempt-unclaimed";

/**
 * Wrap a `WorkflowPort` so every admission publishes its stream to the bus.
 *
 * The wrapper is handed to everything that admits — the IPC handlers, the
 * scheduler, messaging (including `admitReply`'s resumes), agent communication,
 * the wait sweep and the foreground CLI — so none of them needs a new
 * dependency, and every one of them produces the same stream.
 *
 * Boundaries are published when an admission is **claimed** (`onClaimed`), not
 * when it is admitted: an admission queued behind another of the same task, a
 * retry that is about to replay, and a resume refused by its precondition are
 * all admitted and never claimed. Claiming is also when the abort controller is
 * registered, so `abort` reaches the admission that is actually running.
 */
export function withRunEvents(workflow: WorkflowPort, options: RunEventsOptions): WorkflowPort {
  const aborts = options.aborts ?? createAbortRegistry();
  /**
   * The attempt id each task's stream last carried, most recent last.
   *
   * A resume has to name the attempt it supersedes, and that id belongs to the
   * *previous* admission — including after the task completed, because a chat
   * reply resumes a completed conversation's task. Bounded as least recently
   * used, so a long-lived daemon does not keep an entry per task it ever ran; a
   * task that falls out simply resumes without a boundary, as one this process
   * never observed does.
   */
  const lastAttempt = new Map<string, string>();
  const rememberAttempt = (taskId: string, attempt: string): void => {
    lastAttempt.delete(taskId);
    lastAttempt.set(taskId, attempt);
    if (lastAttempt.size > LAST_ATTEMPT_LIMIT) {
      const oldest = lastAttempt.keys().next().value;
      if (oldest !== undefined) lastAttempt.delete(oldest);
    }
  };

  const report = (message: string, fields?: Record<string, unknown>): void => {
    try {
      options.onDiagnostic?.(message, fields);
    } catch {
      // A diagnostic sink that throws must not break an admission.
    }
  };

  /**
   * Publish, never throwing into the caller.
   *
   * This runs inside the graph's own event handlers: an event the bus refused
   * used to escape the tools node and fail the task it was only reporting on.
   * The event contract clamps every free-text field (`boundEventPayloads`), so a
   * refusal here is a defect, reported rather than propagated.
   */
  const publish = (taskId: string, event: UnsequencedClientEvent): void => {
    try {
      options.bus.publish(taskId, event);
    } catch (error) {
      report("an event could not be published; the admission continues without it", {
        taskId,
        kind: event.kind,
        reason: errorMessage(error),
      });
    }
  };

  /** A claimed admission ended: its hook runs on, after the caller has the outcome. */
  const admissionEnded = (taskId: string): void => {
    if (options.onAdmissionEnded === undefined) return;
    void options.onAdmissionEnded(taskId).catch((error: unknown) => {
      report("an ended turn's follow-up failed", { taskId, reason: errorMessage(error) });
    });
  };

  /** A terminal stream: its events are evicted before a live task's. */
  const finish = (taskId: string): void => {
    try {
      options.bus.markCompleted(taskId);
    } catch (error) {
      report("could not mark a finished task's events evictable", {
        taskId,
        reason: errorMessage(error),
      });
    }
  };

  return {
    checkpoints: workflow.checkpoints,
    ...(workflow.openHome === undefined ? {} : { openHome: workflow.openHome }),

    async admit(input: AdmitInput, invokeOptions?: WorkflowInvokeOptions): Promise<AdmissionResult> {
      /** Known up front for a resume; for a start, once the task row exists. */
      let taskId = input.taskId;
      /** This admission's attempt; set when it is claimed, then by model calls. */
      let attemptId: string | undefined;
      let claimed = false;
      /** The first turn of a task that had none: it begins the task's stream, as a start does. */
      let firstTurn = false;
      let admissionId: string | undefined;
      const recorder = createTurnRecorder(input.kind, input.prompt);
      /** Every event this admission publishes goes through here, so a held text delta never falls behind another. */
      const stream = createDeltaCoalescer(publish);
      /**
       * The turn read untrusted data: the known URLs last told (bounded), and whether the next text delta
       * carries them — `knownUrls` only when they changed since the last sent (`ClientEvent`'s `turnTaint`).
       */
      let taint: { knownUrls: string[]; pending: boolean; sent: readonly string[] | undefined } | undefined;
      /** A text delta of a tainted turn, stamped with the taint the stream has not been told yet. */
      const withTaint = (event: UnsequencedClientEvent): UnsequencedClientEvent => {
        if (taint === undefined || !taint.pending || event.kind !== "text.delta") return event;
        const { knownUrls, sent } = taint;
        taint = { knownUrls, pending: false, sent: knownUrls };
        // None held and none sent yet: nothing to say beyond the taint.
        return sameUrls(knownUrls, sent ?? []) ? { ...event, tainted: true } : { ...event, tainted: true, knownUrls };
      };
      /** The turn as a person saw it, saved once the admission ends — best effort: a failure costs the saved history only. */
      const saveTurn = async (savedTaskId: string, outcome: AdmissionOutcome): Promise<void> => {
        stream.flush();
        if (options.transcripts === undefined || !claimed) return;
        // A turn an earlier append lost (a full disk, a stop after the turn ended) is saved from its admission row first.
        if (options.transcripts.reconcile !== undefined && admissionId !== undefined) {
          try {
            await options.transcripts.reconcile(savedTaskId, { beforeAdmissionId: admissionId });
          } catch (error) {
            report("the chat's lost turns could not be saved from their admissions", { taskId: savedTaskId, reason: errorMessage(error) });
          }
        }
        // What the turn's memory tools returned joins what its calls were given.
        recorder.noteMemory(options.memoryReads?.take(savedTaskId) ?? { records: [] });
        try {
          await options.transcripts.append({
            taskId: savedTaskId,
            ...(admissionId === undefined ? {} : { admissionId }),
            turn: recorder.turn(outcome),
            createdAt: (options.now ?? nowTimestamp)(),
          });
        } catch (error) {
          report("a turn could not be saved to the chat's history", { taskId: savedTaskId, reason: errorMessage(error) });
        }
      };
      const models = new Set<string>();
      let totalTokens = 0;
      let cacheReadTokens = 0;
      let partial = false;
      // Created before `admit` runs, because the signal has to be part of the
      // invoke options; registered only once the admission is claimed.
      const controller = new AbortController();

      const handlers = createGraphEventHandlers(
        (event) => {
          if (taskId === undefined) return;
          recorder.observe(event);
          stream.send(taskId, withTaint(event));
        },
        // Graph events only arrive after the claim, which sets both.
        () => ({ runId: taskId ?? "pending-admission", attemptId: attemptId ?? UNCLAIMED_ATTEMPT }),
        // Runs for every model event — every token delta — but the attempt only
        // changes once per model call.
        (next) => {
          if (next === attemptId) return;
          attemptId = next;
          if (taskId !== undefined) rememberAttempt(taskId, next);
        },
        async (childId) => {
          try {
            const edge = await options.delegations?.getByWorkerTaskId(childId);
            return edge?.workspaceId === input.context.workspaceId ? edge : undefined;
          } catch (error) {
            options.onDiagnostic?.("Could not read spawned task ancestry", { taskId: childId, error: String(error) });
            return undefined;
          }
        },
      );

      // `AbortSignal.any` so a caller's own signal (the foreground loop's
      // SIGINT) and the registry's (an IPC `abort`) both stop the run.
      const signals = [invokeOptions?.signal, controller.signal].filter((signal): signal is AbortSignal => signal !== undefined);
      // Composed, not replaced: a caller may observe model and tool events of its
      // own, and the decorator's job is to add the bus, not to take that away.
      const composed: WorkflowInvokeOptions = {
        ...(invokeOptions ?? {}),
        // The bus handler runs first: a caller's handler that throws must not
        // suppress the daemon's copy of the event, and the caller's exception
        // still propagates to it afterwards.
        onModelEvent: (event) => {
          if (event.type === "model.result") {
            models.add(`${event.connectionId}/${event.model}`);
            totalTokens += event.usage.totalTokens ?? (event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0);
            partial ||=
              event.usage.totalTokens === undefined && (event.usage.inputTokens === undefined || event.usage.outputTokens === undefined);
            cacheReadTokens += event.usage.inputCacheReadTokens ?? 0;
          }
          handlers.onModelEvent(event);
          invokeOptions?.onModelEvent?.(event);
        },
        onToolEvent: async (event) => {
          await handlers.onGraphToolEvent(event);
          await invokeOptions?.onToolEvent?.(event);
        },
        // A model call failed over: an attempt boundary mid-turn, whose
        // superseded attempt's partial output every client discards. Announced
        // before the new attempt's first event, which then finds the attempt
        // already current.
        onFailover: (event) => {
          if (taskId !== undefined) {
            const replaced: UnsequencedClientEvent = {
              kind: "attempt.replaced",
              runId: taskId,
              attemptId: event.attemptId,
              supersededAttemptId: event.supersededAttemptId,
              reason: event.reason.slice(0, EVENT_TEXT_BOUNDS.reason),
              discarded: true,
            };
            recorder.observe(replaced);
            stream.send(taskId, replaced);
            attemptId = event.attemptId;
            rememberAttempt(taskId, event.attemptId);
          }
          invokeOptions?.onFailover?.(event);
        },
        // A message the person sent into this turn was merged: shown
        // where the model read it, and kept with the turn's saved history.
        onSteer: (event) => {
          if (taskId !== undefined) {
            const steered: UnsequencedClientEvent = {
              kind: "turn.steered",
              runId: taskId,
              attemptId: attemptId ?? UNCLAIMED_ATTEMPT,
              messageId: event.messageId,
              text: event.text,
            };
            recorder.observe(steered);
            stream.send(taskId, steered);
          }
          invokeOptions?.onSteer?.(event);
        },
        // Plugins' suggestions for the next prompt: shown with the turn, kept nowhere.
        // The memory a model call of this turn was given: kept with the saved turn, published nowhere.
        onMemoryUsed: (event) => {
          recorder.noteMemory(event);
          invokeOptions?.onMemoryUsed?.(event);
        },
        // Untrusted data reached a model call of this turn: kept with the saved turn, and the known URLs told
        // to the canvas with the next text delta and the turn's end, so it disarms a novel link in the answer.
        onUntrustedInput: (knownUrls) => {
          recorder.noteUntrusted(knownUrls);
          taint = { knownUrls: boundTurnKnownUrls(knownUrls), pending: true, sent: taint?.sent };
          invokeOptions?.onUntrustedInput?.(knownUrls);
        },
        // The turn is held to a messaging conversation: kept with the saved turn, so automatic capture leaves it out.
        onHeldChannel: (channel) => {
          recorder.noteChannel(channel);
          invokeOptions?.onHeldChannel?.(channel);
        },
        onSuggestions: (suggestions) => {
          if (taskId !== undefined)
            stream.send(taskId, {
              kind: "turn.suggested",
              runId: taskId,
              attemptId: attemptId ?? UNCLAIMED_ATTEMPT,
              suggestions: suggestions.map((text) => maskPluginText(text, TURN_SUGGESTION_MAX_CHARS)).filter((text) => text.trim() !== ""),
            });
          invokeOptions?.onSuggestions?.(suggestions);
        },
        signal: AbortSignal.any(signals),
      };

      // Counted from here, right before the `try` whose `finally` uncounts it:
      // nothing that can throw lies between the two, so the count cannot leak.
      options.admissions?.begin();
      try {
        const result = await workflow.admit(
          {
            ...input,
            onAdmitted: async (value) => {
              taskId = value.taskId;
              firstTurn = value.firstTurn === true;
              await input.onAdmitted?.(value);
            },
            onClaimed: (value) => {
              claimed = true;
              taskId = value.taskId;
              admissionId = value.admissionId;
              // Reads left over from a turn that was never saved are not this one's.
              options.memoryReads?.take(value.taskId);
              options.onAdmissionClaimed?.(value.taskId, value.admissionId);
              attemptId = attemptIdFor(value.admissionId);
              aborts.register(value.taskId, controller);
              if ((input.taskId === undefined || firstTurn) && value.created) {
                // An admission that creates its task starts the stream. Both
                // conditions: `created` alone is also true of a resume's new row
                // (keying on it started a second stream per resume), and a start
                // retried under its key after a claimed attempt threw has no task
                // id but continues the existing task — a new attempt on it.
                stream.send(value.taskId, {
                  kind: "run.started",
                  runId: value.taskId,
                  attemptId,
                  threadId: value.threadId,
                  workspaceId: input.context.workspaceId,
                });
              } else {
                const superseded = lastAttempt.get(value.taskId);
                // The round this resume decided, before the turn it starts:
                // every attached client clears that round's cards, whichever front
                // end decided it. Published at the claim — the round precondition
                // has passed — so a refused decision never announces a round as
                // settled. It names the attempt whose `approval.required` it answers.
                const settled = approvalSettledBy(input);
                if (settled !== undefined) {
                  stream.send(value.taskId, {
                    kind: "approval.settled",
                    runId: value.taskId,
                    attemptId: superseded ?? attemptId,
                    ...settled,
                  });
                }
                // The same for a question's answer (or its deadline): every
                // attached client turns the question into a receipt.
                const answered = waitSettledBy(input);
                if (answered !== undefined) {
                  stream.send(value.taskId, {
                    kind: "wait.settled",
                    runId: value.taskId,
                    attemptId: superseded ?? attemptId,
                    ...answered,
                  });
                }
                // A resume continues the same task: an attempt boundary, naming
                // the attempt the stream was carrying. When this process never
                // observed the task's earlier admission there is nothing to
                // supersede, and since the schema requires the field, no boundary
                // is claimed rather than one invented.
                if (superseded !== undefined) {
                  stream.send(value.taskId, {
                    kind: "attempt.replaced",
                    runId: value.taskId,
                    attemptId,
                    supersededAttemptId: superseded,
                    reason: `resuming after ${input.kind}`,
                  });
                }
              }
              rememberAttempt(value.taskId, attemptId);
              input.onClaimed?.(value);
            },
          },
          composed,
        );
        // A replayed admission still needs an end event on an empty stream — a
        // new process, or an evicted ring — or a subscriber to a retried run
        // would wait forever for a stream that finished. A stream that holds
        // events already carries its own end, or the progress past it: a second
        // `task.completed`, or a stale `approval.required` for a round decided
        // since, would mislead every subscriber. An admission answered without a
        // claim (a replay, a cancellation) names the attempt the stream last
        // carried.
        if (result.replay && !claimed && options.bus.retains(result.taskId)) return result;
        const endAttempt = attemptId ?? lastAttempt.get(result.taskId) ?? UNCLAIMED_ATTEMPT;
        const maskInputs = (await options.maskInputs?.(input.context.workspaceId).catch(() => true)) ?? false;
        emitOutcomeEvents(
          result.outcome,
          result.taskId,
          (event) =>
            stream.send(
              result.taskId,
              withEndTaint(
                (event.kind === "task.completed" || event.kind === "task.failed" || event.kind === "task.stopped") && models.size > 0
                  ? {
                      ...event,
                      metrics: {
                        models: [...models].slice(0, 64),
                        totalTokens,
                        partial,
                        ...(cacheReadTokens === 0 ? {} : { cacheReadTokens }),
                      },
                    }
                  : event,
                taint?.knownUrls,
              ),
            ),
          endAttempt,
          maskInputs,
        );
        const ended = result.outcome.status !== "waiting";
        if (ended) finish(result.taskId);
        await saveTurn(result.taskId, result.outcome);
        if (claimed) admissionEnded(result.taskId);
        if (claimed && ended) {
          try {
            await options.onTaskEnded?.(result.taskId, admissionId, result.outcome);
          } catch (error) {
            report("a finished task's follow-up failed", { taskId: result.taskId, reason: errorMessage(error) });
          }
        }
        return result;
      } catch (error) {
        // Only a claimed admission has a stream to end. One refused before it —
        // an unknown agent, a foreign principal, a stale round, a busy lease —
        // ran nothing, and a `task.failed` would report a task that is still
        // waiting (or another principal's) as failed.
        if (claimed && taskId !== undefined) {
          const failure = TaviError.from(error);
          report("an admission failed after it was claimed", { taskId, reason: failure.message });
          stream.send(taskId, {
            kind: "task.failed",
            runId: taskId,
            // Set by the claim that makes this branch reachable.
            attemptId: attemptId ?? UNCLAIMED_ATTEMPT,
            errorCode: failure.code,
            message: failure.message,
          });
          finish(taskId);
          await saveTurn(taskId, { status: "failed", finalText: "", error: { code: failure.code, message: failure.message } });
          admissionEnded(taskId);
          try {
            await options.onTaskEnded?.(taskId, admissionId);
          } catch (hookError) {
            report("a finished task's follow-up failed", { taskId, reason: errorMessage(hookError) });
          }
        }
        throw error;
      } finally {
        stream.flush();
        if (taskId !== undefined) aborts.release(taskId, controller);
        options.admissions?.end();
      }
    },
  };
}

/**
 * Render one task's stream from the bus — exactly what an attached client
 * receives.
 *
 * The foreground CLI renders through this rather than emitting events of its
 * own: its output and an attached client's then come from one producer, the
 * admission decorator, and cannot drift (they had: attempt ids, the approval
 * row id and the resume boundary each differed). `attach` is idempotent for a
 * task, so an approval loop that resumes the same task keeps one subscription.
 */
export function createTaskStreamRenderer(
  bus: RunEventBus,
  render: (event: ClientEvent) => void,
): {
  attach(taskId: string): void;
  detach(): void;
  /** Whether the stream has reached `task.completed`, `task.failed` or `task.stopped`. */
  readonly ended: () => boolean;
} {
  let attached: { readonly taskId: string; readonly unsubscribe: () => void } | undefined;
  let ended = false;
  const show = (event: ClientEvent): void => {
    if (event.kind === "task.completed" || event.kind === "task.failed" || event.kind === "task.stopped") ended = true;
    render(event);
  };
  return {
    attach(taskId) {
      if (attached?.taskId === taskId) return;
      attached?.unsubscribe();
      const { subscription, replayed, resync } = bus.subscribe({ taskId, from: "beginning", deliver: show });
      for (const event of replayed) show(event);
      if (resync !== null) show(resync);
      attached = { taskId, unsubscribe: () => subscription.unsubscribe() };
    },
    detach() {
      attached?.unsubscribe();
      attached = undefined;
    },
    ended: () => ended,
  };
}
