import { emitJson } from "../../cli/output.js";
import { prefixedId } from "@tavi/node-kit";
import {
  IPC_NOT_PENDING,
  type AdmissionOutcome,
  type ApprovalsListResult,
  type ApproveResult,
  type ClientEvent,
  type ApprovalScope,
  type ChatFolderChoice,
  type ExpectTarget,
  type RunTarget,
  type IpcCursor,
  type PolicyStopped,
  type ReviewResult,
  type RunResult,
  type SubscribeResult,
  approvalTitleOf,
} from "@tavi/contracts";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import type { IpcClient, IpcClientResponse } from "@tavi/runtime";
import { promptForApprovalScope } from "../approvals/prompt.js";
import type { OutputFormat } from "../../cli/parse.js";
import type { RunCommandOptions } from "./parse.js";
import { createEventRenderer } from "./client-events.js";
import type { CliIo } from "../../cli/io.js";
import { endingOfOutcome, recordedStateOf, type Ending, type RecordedTask } from "../../shared/recorded-task.js";
import { roundCallIds } from "../../shared/rounds.js";
import { waitingText } from "./waiting-text.js";
import { terminalText } from "../../shared/terminal-text.js";
import type { ExitCodes } from "../../cli/owner-connection.js";

type DetachSignal = "SIGINT" | "SIGTERM";

/** Where a detaching signal is heard; the process by default. */
interface SignalSource {
  on(signal: DetachSignal, listener: () => void): void;
  off(signal: DetachSignal, listener: () => void): void;
}

export interface FollowOptions {
  readonly format: OutputFormat;
  readonly approval: RunCommandOptions["approval"];
  /** The workspace to decide rounds in until the stream's `run.started` names the task's own. */
  readonly workspaceId: string;
  readonly principalId: string;
  readonly exit: ExitCodes;
  readonly io: CliIo;
  readonly signals?: SignalSource;
  /**
   * How one call of a round is asked on a terminal; `promptForApprovalScope` by
   * default. `signal` aborts the question when the round is decided elsewhere
   * or the session ends.
   */
  readonly prompt?: (summary: string, input: unknown, signal: AbortSignal) => Promise<boolean>;
  /**
   * `false` reports a whole round with exit 3 even on a terminal, as the offline
   * `tavi approvals`/`tavi artifacts --resume` report the next round a resume
   * suspends on. Asked by default.
   */
  readonly ask?: boolean;
  /** `--quiet`: no diagnostic on stderr (the working-folder note among them). */
  readonly quiet?: boolean;
  /** A schedule's fire: its `[nothing to report]` answer is printed in words (`EventRendererOptions.quietMarker`). */
  readonly quietMarker?: boolean;
}

/** Longer than the transport's 5 s: an admission can queue behind a busy task. */
const DISPATCH_TIMEOUT_MS = 30_000;

/** The exit an owner's refusal of `run`/`subscribe` maps to — the foreground's for the same refusal. */
function exitForRefusal(code: string | undefined, exit: ExitCodes): number {
  switch (code) {
    // A usage mistake: another target than the owner runs, a reserved key, an
    // unconfigured owner (the foreground's "no model is configured").
    case "INVALID_INPUT":
    case "NOT_CONFIGURED":
      return exit.usage;
    default:
      // A refused admission (CONFLICT, NOT_AUTHORIZED, a busy slot), an unknown
      // task, a full connection: nothing ran here.
      return exit.unavailable;
  }
}

/**
 * Dispatch `run` to the owner and follow the task's stream to its end.
 */
export async function runOnOwner(
  client: IpcClient,
  request: {
    readonly prompt: string;
    readonly operationKey: string;
    readonly expectTarget?: ExpectTarget;
    /** The chat's own model, saved before its first turn. */
    readonly model?: { readonly connectionId: string; readonly model: string };
    readonly target?: RunTarget;
    /** The new chat's folder, or this terminal's directory for the owner to use when it may. */
    readonly folder?: ChatFolderChoice;
    readonly clientCwd?: string;
  },
  options: FollowOptions,
): Promise<number> {
  const requestId = `run-${request.operationKey}`;
  const session = followSession(client, options, { mode: "run", requestId, operationKey: request.operationKey });
  // The run may have been admitted: only the key can find it again.
  const outcomeUnknown = (reason: string): number => {
    session.dispose();
    options.io.stderr(
      `The run's outcome is unknown: ${reason}. Retrying with --operation-key ${request.operationKey} ` +
        "resolves the same task rather than starting another.\n",
    );
    return options.exit.unavailable;
  };
  let response: IpcClientResponse;
  try {
    response = await client.request(
      "run",
      {
        prompt: request.prompt,
        workspaceId: options.workspaceId,
        principal: options.principalId,
        operationKey: request.operationKey,
        // `ask` is the client's to answer, round by round; the owner answers the others.
        approval: options.approval === "ask" ? "client" : options.approval,
        ...definedOnly({
          expectTarget: request.expectTarget,
          model: request.model,
          target: request.target,
          folder: request.folder,
          clientCwd: request.clientCwd,
        }),
      },
      requestId,
      { timeoutMs: DISPATCH_TIMEOUT_MS, onResponse: (answer) => session.bind(answer) },
    );
  } catch (error) {
    return outcomeUnknown(errorMessage(error));
  }
  if (!response.ok) {
    if (response.error?.code === "DISCONNECTED") return outcomeUnknown("the owner closed the connection before answering");
    session.dispose();
    options.io.stderr(`run failed: ${response.error?.code}: ${response.error?.message}\n`);
    return exitForRefusal(response.error?.code, options.exit);
  }
  // One line when the terminal's directory was not used, and why.
  const note = (response.result as RunResult | undefined)?.folder?.note;
  if (note !== undefined && options.quiet !== true) options.io.stderr(`${terminalText(note)}\n`);
  return session.done();
}

/** Follow an existing task's stream, from its beginning, to its end. */
export async function attachToRunningTask(client: IpcClient, taskId: string, options: FollowOptions): Promise<number> {
  return followTask(client, taskId, "beginning", "attach", options);
}

/**
 * Subscribe to a task and follow it to its end.
 *
 * `attach` reads a task the owner holds nothing of from its recorded outcome,
 * since no event may ever arrive for it. `resume` follows a resume the owner
 * just admitted: whatever it has not published yet is still to come.
 */
async function followTask(
  client: IpcClient,
  taskId: string,
  from: IpcCursor | "beginning",
  mode: "attach" | "resume",
  options: FollowOptions,
): Promise<number> {
  const requestId = prefixedId(`${mode}-${taskId}`);
  const session = followSession(client, options, { mode, requestId, taskId });
  let response: IpcClientResponse;
  try {
    response = await client.request("subscribe", { taskId, from }, requestId, {
      timeoutMs: DISPATCH_TIMEOUT_MS,
      onResponse: (answer) => session.bind(answer),
    });
  } catch (error) {
    session.dispose();
    options.io.stderr(`attach failed: ${errorMessage(error)}\n`);
    return options.exit.unavailable;
  }
  if (!response.ok) {
    session.dispose();
    options.io.stderr(`attach failed: ${response.error?.code}: ${response.error?.message}\n`);
    return exitForRefusal(response.error?.code, options.exit);
  }
  return session.done();
}

/** What a decision's answer says of the resume it admitted. */
interface AdmittedResume {
  readonly operationKey: string;
  readonly replayed: boolean;
  readonly status?: AdmissionOutcome["status"];
  readonly cursor?: IpcCursor;
}

/**
 * Follow the resume a decision admitted to its end, reporting it as the offline
 * command reports its own resume: a round it suspends on is reported (exit 3),
 * never asked. A decision already committed ran nothing now, so it is answered
 * from its recorded outcome; any other is followed from the stream position the
 * owner read before admitting it — exactly the resumed turn — or from the
 * beginning when the owner held nothing of the task.
 */
async function followResume(client: IpcClient, taskId: string, resume: AdmittedResume, options: FollowOptions): Promise<number> {
  const follow = { ...options, ask: false };
  if (resume.replayed && resume.status !== undefined) return reportRecordedResume(client, taskId, resume.operationKey, follow);
  return followTask(client, taskId, resume.cursor ?? "beginning", "resume", follow);
}

/** A decision answered from the record: the outcome its resume recorded, reported as the offline replay reports it. */
async function reportRecordedResume(client: IpcClient, taskId: string, operationKey: string, options: FollowOptions): Promise<number> {
  let answer: IpcClientResponse;
  try {
    answer = await client.request("tasks", { taskId }, prefixedId(`resumed-${taskId}`), { timeoutMs: DISPATCH_TIMEOUT_MS });
  } catch (error) {
    options.io.stderr(`Could not read task ${taskId}'s recorded state: ${errorMessage(error)}\n`);
    return options.exit.unavailable;
  }
  if (!answer.ok) {
    options.io.stderr(`Could not read task ${taskId}'s recorded state: ${answer.error?.code}: ${answer.error?.message}\n`);
    return options.exit.unavailable;
  }
  const admissions = (answer.result as RecordedTask).admissions ?? [];
  const recorded = admissions.filter((admission) => admission.operationKey === operationKey && admission.result !== null).at(-1)?.result;
  if (recorded === undefined || recorded === null) {
    options.io.stderr(
      `Task ${taskId}'s decision was already recorded, but its outcome is not; \`tavi tasks ${taskId}\` shows where it stands.\n`,
    );
    return options.exit.unavailable;
  }
  options.io.stderr(`Replayed the decision already recorded for this round (${operationKey}); no work was re-run.\n`);
  return reportEnding(taskId, endingOfOutcome(recorded), "attach", options);
}

/**
 * `tavi approvals approve|reject <task-id>` under a live owner: the round is
 * decided over IPC — one verdict for every call, `callId` only asserting it is
 * the one — and the resumed turn followed to its end, with the exit the offline
 * command gives it.
 */
export async function approveOnOwner(
  client: IpcClient,
  request: {
    readonly taskId: string;
    readonly verdict: "approve" | "reject";
    readonly callId?: string;
    readonly decidedBy: string;
    readonly scope?: ApprovalScope;
    readonly note?: string;
    readonly expectTarget?: ExpectTarget;
  },
  options: FollowOptions,
): Promise<number> {
  let response: IpcClientResponse;
  try {
    response = await client.request(
      "approvals",
      {
        action: request.verdict,
        taskId: request.taskId,
        workspaceId: options.workspaceId,
        decidedBy: request.decidedBy,
        ...definedOnly({
          scope: request.scope,
          note: request.note,
          callId: request.callId,
          expectTarget: request.expectTarget,
        }),
      },
      prefixedId(`decide-${request.taskId}`),
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  } catch (error) {
    return decisionUnknown(error, request.taskId, options);
  }
  if (!response.ok) return decisionRefused("approvals", response, request.taskId, options);
  return followResume(client, request.taskId, response.result as ApproveResult, options);
}

/**
 * `tavi artifacts approve|reject <artifact-id> [--resume]` under a live owner:
 * the artifact is decided over IPC under its own task, printed as the offline
 * command prints it, and with `resume` the task's review suspension
 * acknowledged and the resumed turn followed to its end. As offline, a
 * decision with nothing to resume is still recorded (exit 8).
 */
export async function reviewOnOwner(
  client: IpcClient,
  request: {
    readonly artifactId: string;
    readonly verdict: "approve" | "reject";
    readonly reviewedBy: string;
    readonly resume: boolean;
    readonly expectTarget?: ExpectTarget;
  },
  options: FollowOptions,
): Promise<number> {
  const { io, exit } = options;
  const send = (resume: boolean): Promise<IpcClientResponse> =>
    client.request(
      "review",
      {
        workspaceId: options.workspaceId,
        decisions: [{ artifactId: request.artifactId, approved: request.verdict === "approve" }],
        reviewedBy: request.reviewedBy,
        ...(resume ? { resume: true, ...(request.expectTarget === undefined ? {} : { expectTarget: request.expectTarget }) } : {}),
      },
      prefixedId(`review-${request.artifactId}`),
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
  // The decided artifact's record, as the offline command prints it.
  const print = (result: ReviewResult): void => {
    for (const record of result.records) emitJson(io, record);
  };
  let response: IpcClientResponse;
  try {
    response = await send(request.resume);
    if (!response.ok && request.resume && response.error?.code === IPC_NOT_PENDING) {
      // Nothing to resume. The owner refuses before writing; offline, the
      // decision is recorded all the same, so it is recorded here too.
      const why = response.error.message;
      const decided = await send(false);
      if (!decided.ok) return decisionRefused("review", decided, undefined, options);
      print(decided.result as ReviewResult);
      io.stderr(`${why}. The artifact decision is recorded; there is nothing to resume.\n`);
      return exit.resumeNotApplicable;
    }
  } catch (error) {
    return decisionUnknown(error, undefined, options);
  }
  if (!response.ok) return decisionRefused("review", response, undefined, options);
  const reviewed = response.result as ReviewResult;
  print(reviewed);
  if (!request.resume) return exit.ok;
  if (reviewed.taskId === null || reviewed.resumed === undefined) {
    io.stderr(`Artifact ${request.artifactId} has no associated task; nothing to resume.\n`);
    return exit.resumeNotApplicable;
  }
  return followResume(client, reviewed.taskId, reviewed.resumed, options);
}

/**
 * A decision whose answer never came: it may have been admitted. Deciding again
 * is not blind-safe — a decision carries no round, so it applies to whatever
 * round is pending by then — so the operator is sent to look first.
 */
function decisionUnknown(error: unknown, taskId: string | undefined, options: FollowOptions): number {
  const id = taskId ?? "<task-id>";
  options.io.stderr(
    `The decision's outcome is unknown: ${errorMessage(error)}. ` +
      `Check \`tavi approvals list\` or \`tavi run --attach ${id}\` before deciding again: a new decision applies to ` +
      "whatever round is pending then.\n",
  );
  return options.exit.unavailable;
}

/** The exit an owner's refusal of a decision maps to — the offline command's for the same refusal. */
function decisionRefused(command: string, response: IpcClientResponse, taskId: string | undefined, options: FollowOptions): number {
  const { io, exit } = options;
  const code = response.error?.code;
  if (code === "DISCONNECTED") return decisionUnknown(new Error("the owner closed the connection before answering"), taskId, options);
  if (code === IPC_NOT_PENDING) {
    // Nothing to decide: the offline command's own wording, and its exit 8.
    io.stderr(`${response.error?.message}\n`);
    return exit.resumeNotApplicable;
  }
  io.stderr(`${command} failed: ${code}: ${response.error?.message}\n`);
  // Another workspace, a partial round, another target, an unconfigured owner:
  // usage mistakes. Anything else — another front end deciding first, a busy
  // slot, a cancelled task, a schedule's fire — is a refused decision (4).
  return exitForRefusal(code, exit);
}

/** One call of a round, as its `approval.required` event announced it. */
type RoundCall = Extract<ClientEvent, { kind: "approval.required" }>;

const SUSPENDED_KINDS: ReadonlySet<ClientEvent["kind"]> = new Set(["approval.required", "task.waiting", "task.review_required"]);

/** The ending a stream's final event describes, if it is one. */
function endingOf(event: ClientEvent): Ending | undefined {
  switch (event.kind) {
    case "task.completed":
      return { kind: "completed" };
    case "task.failed":
      // Rendered by the stream itself.
      return { kind: "failed" };
    case "task.stopped":
      return { kind: "stopped", message: event.message };
    case "task.review_required":
      return { kind: "review", steps: event.steps, requests: event.requests };
    case "task.waiting":
      return {
        kind: "waiting",
        on: event.on,
        deadlineAt: event.deadlineAt,
        ...definedOnly({ question: event.question, choices: event.choices }),
      };
    default:
      return undefined;
  }
}

/**
 * Report how a followed task ended — the stderr guidance the foreground gives
 * for the same outcome — and return its exit code. A `run` names the policies
 * it could have re-run with; an attached client or a decision starts nothing.
 */
function reportEnding(forTask: string, ending: Ending, mode: "run" | "attach" | "resume", options: FollowOptions): number {
  const { io, exit } = options;
  switch (ending.kind) {
    case "completed":
      if (options.format === "text") io.stdout("\n");
      return exit.ok;
    case "failed":
      if (ending.reason !== undefined) io.stderr(`Task ${forTask} failed: ${ending.reason}\n`);
      return exit.taskFailed;
    case "stopped":
      // It did not finish, as a script reads a run; nothing broke, and a reply goes on.
      io.stderr(`Task ${forTask} stopped: ${ending.message}\n`);
      return exit.taskFailed;
    case "approval":
      for (const request of ending.requests) io.stderr(`Pending approval: ${request.toolName} (call ${request.callId})\n`);
      io.stderr(
        `Task ${forTask} is waiting on an approval; decide it with \`tavi approvals approve ${forTask}\`` +
          (mode === "run" ? ", or re-run with --approval approve or --approval deny.\n" : ".\n"),
      );
      return exit.approvalRequired;
    case "review":
      for (const request of ending.requests) {
        io.stderr(`Pending artifact review: ${request.artifactId} (from ${request.toolName}, call ${request.callId})\n`);
      }
      io.stderr(
        `Task ${forTask} is waiting on artifact review. Decide with \`tavi artifacts approve <artifact-id>\` or ` +
          "`tavi artifacts reject <artifact-id>`, adding `--resume` to re-admit this task once every flagged artifact has a decision.\n",
      );
      return exit.reviewRequired;
    case "waiting":
      io.stderr(waitingText(forTask, ending));
      return exit.taskWaiting;
  }
}

/**
 * One followed stream: renders the subscription's events, settles an exit code
 * on the event the stream ends at, answers approval rounds under `ask`, and
 * detaches on Ctrl-C.
 */
function followSession(
  client: IpcClient,
  options: FollowOptions,
  target:
    | { readonly mode: "run"; readonly requestId: string; readonly operationKey: string }
    | { readonly mode: "attach" | "resume"; readonly requestId: string; readonly taskId: string },
) {
  const { io, exit } = options;
  const renderer = createEventRenderer({
    format: options.format,
    write: io.stdout,
    ...(options.quietMarker === true ? { quietMarker: true } : {}),
  });
  let subscriptionId: string | undefined;
  let taskId: string | undefined = target.mode === "run" ? undefined : target.taskId;
  /** The task's own workspace once `run.started` names it: rounds are listed and decided there. */
  let workspaceId = options.workspaceId;
  /** The last event rendered: whether a detached task is running or suspended, and how a replay ended. */
  let lastEvent: ClientEvent | undefined;
  /** Events of the subscription's replay not yet received; an outcome is only read once it is 0. */
  let replayRemaining = 0;
  /** Rounds the owner answers itself are only rendered here. */
  let ownerAnswers = options.approval !== "ask";
  /** Under `approve` the owner releases a run's review rounds too, so one is not where this stream ends. */
  const ownerReviews = target.mode === "run" && options.approval === "approve";
  /**
   * Why the owner stopped answering the run's rounds, once a round it published
   * again says so (`policyStopped`): that round, and every later one, is a person's.
   */
  let policyStopped: PolicyStopped | undefined;
  const endingFor = (event: ClientEvent): Ending | undefined => {
    const ending = endingOf(event);
    if (ending?.kind !== "review" || !ownerReviews) return ending;
    return policyStopped !== undefined ? ending : undefined;
  };
  /** A round the owner left: noted, and from here the rounds are this client's to report. */
  function ownerStopped(stopped: PolicyStopped | undefined): void {
    if (stopped === undefined) return;
    policyStopped ??= stopped;
    ownerAnswers = false;
  }
  /** A detach asked for before the owner answered: settled once it names the task. */
  let pendingDetach: DetachSignal | undefined;
  let settle: (code: number) => void = () => {};
  const result = new Promise<number>((resolve) => (settle = resolve));
  let finished = false;
  /** Approval requests per round, by `steps`, awaiting their whole round. */
  const rounds = new Map<number, { readonly forTask: string; readonly calls: Map<string, RoundCall> }>();
  const settledRounds = new Set<number>();
  const asked = new Set<number>();
  /** The round's full call set, once the owner has listed it. */
  const roundCalls = new Map<number, ReadonlySet<string>>();
  /** The open prompt of a round, aborted when the round is decided elsewhere or the session ends. */
  const prompts = new Map<number, AbortController>();

  function finish(code: number): void {
    if (finished) return;
    finished = true;
    renderer.finish();
    cleanup();
    settle(code);
  }

  const signals: SignalSource = options.signals ?? {
    on: (signal, listener) => process.on(signal, listener),
    off: (signal, listener) => process.off(signal, listener),
  };
  const onInterrupt = (): void => detach("SIGINT");
  const onTerminate = (): void => detach("SIGTERM");
  let listening = true;
  signals.on("SIGINT", onInterrupt);
  signals.on("SIGTERM", onTerminate);
  function stopListening(): void {
    if (!listening) return;
    listening = false;
    signals.off("SIGINT", onInterrupt);
    signals.off("SIGTERM", onTerminate);
  }

  function detach(signal: DetachSignal): void {
    if (finished || pendingDetach !== undefined) return;
    if (subscriptionId === undefined) {
      // The owner has not answered yet, so there is no task to name. The
      // detach is settled when it does; a second interrupt ends the process.
      pendingDetach = signal;
      stopListening();
      io.stderr(
        target.mode === "run"
          ? `\nDetaching once the owner answers (operation key ${target.operationKey}); the run is the owner's either way. ` +
              "Interrupt again to quit now.\n"
          : "\nDetaching once the owner answers. Interrupt again to quit now.\n",
      );
      return;
    }
    detachNow(signal);
  }

  function detachNow(signal: DetachSignal): void {
    const id = taskId ?? "<task-id>";
    const suspended = lastEvent !== undefined && SUSPENDED_KINDS.has(lastEvent.kind);
    io.stderr(
      `\nDetached from task ${id}; ${suspended ? "it waits under the owner" : "it keeps running under the owner"}.\n` +
        `  follow it again:  tavi run --attach ${id}\n` +
        (suspended
          ? `  cancel it:        tavi cancel ${id} --reason <text>   (it is suspended; there is no running turn to abort)\n`
          : `  stop this turn:   tavi abort ${id}\n  cancel the task:  tavi cancel ${id} --reason <text>\n`),
    );
    finish(signal === "SIGTERM" ? exit.terminated : exit.detached);
  }

  /**
   * Every asynchronous branch — reading the task's record, listing a round,
   * asking it, sending its answer — ends here: Ctrl-C at a prompt detaches,
   * anything else is reported rather than left unhandled.
   */
  function fail(error: unknown): void {
    if (finished) return;
    if (error instanceof Error && error.name === "AbortError") {
      // Readline turns Ctrl-C at an open prompt into an AbortError; the process
      // never sees the SIGINT, so this is the same detach.
      detach("SIGINT");
      return;
    }
    const id = taskId ?? "<task-id>";
    io.stderr(
      `\nFollowing task ${id} failed: ${errorMessage(error)}. ` +
        `The task is the owner's either way; follow it again with \`tavi run --attach ${id}\`.\n`,
    );
    finish(exit.unavailable);
  }

  const stopEvents = client.onEvent((frame) => {
    if (subscriptionId === undefined || frame.subscriptionId !== subscriptionId) return;
    onEvent(frame.event);
  });
  // A subscription the owner drops (its backlog budget) is reported against the
  // request that created it, long since answered.
  const stopOrphans = client.onOrphanResponse((answer) => {
    if (finished || answer.requestId !== target.requestId) return;
    const id = taskId ?? "<task-id>";
    io.stderr(`\nThe owner dropped this stream (${answer.code}: ${answer.message}); follow it again with \`tavi run --attach ${id}\`.\n`);
    finish(exit.unavailable);
  });
  const stopClose = client.onClose(() => {
    // Before the answer, the pending request reports the disconnect itself.
    if (finished || subscriptionId === undefined) return;
    const id = taskId ?? "<task-id>";
    io.stderr(
      `\nThe owner closed the connection before task ${id} ended; \`tavi tasks ${id}\` shows how it stands, and ` +
        `\`tavi run --attach ${id}\` follows it once an owner is back.\n`,
    );
    finish(exit.unavailable);
  });
  function cleanup(): void {
    stopListening();
    stopEvents();
    stopOrphans();
    stopClose();
    for (const prompt of prompts.values()) prompt.abort();
  }

  function onEvent(event: ClientEvent): void {
    if (finished) return;
    const replaying = replayRemaining > 0;
    if (replaying) replayRemaining -= 1;
    renderer.render(event);
    lastEvent = event;
    switch (event.kind) {
      case "run.started":
        workspaceId = event.workspaceId;
        break;
      case "approval.settled":
        settledRounds.add(event.steps);
        rounds.delete(event.steps);
        if (prompts.has(event.steps)) {
          prompts.get(event.steps)?.abort();
          io.stderr(`\nThis round was decided elsewhere (by ${event.decidedBy}).\n`);
        }
        break;
      case "approval.required":
        ownerStopped(event.policyStopped);
        if (!ownerAnswers) collect(event, !replaying);
        break;
      case "task.review_required":
        ownerStopped(event.policyStopped);
        break;
      default:
        break;
    }
    if (replaying) {
      if (replayRemaining === 0) replayEnded();
      return;
    }
    const ending = endingFor(event);
    if (ending !== undefined) end(event.runId, ending);
  }

  /** Add one call to its round; a live round is listed and asked as soon as it is whole. */
  function collect(event: RoundCall, live: boolean): void {
    let round = rounds.get(event.steps);
    if (round === undefined) {
      round = { forTask: event.runId, calls: new Map() };
      rounds.set(event.steps, round);
      if (live) requestRound(event.runId, event.steps);
    }
    round.calls.set(event.callId, event);
    if (live) maybeAsk(event.runId, event.steps).catch(fail);
  }

  /**
   * The replay is over: a stream that ends on an outcome ends here with it; a
   * round still open is asked; a task the owner retains nothing of is read
   * from its durable record, since no event may ever arrive for it.
   */
  function replayEnded(): void {
    if (finished) return;
    const ending = lastEvent === undefined ? undefined : endingFor(lastEvent);
    if (ending !== undefined && lastEvent !== undefined) {
      end(lastEvent.runId, ending);
      return;
    }
    for (const [steps, round] of rounds) requestRound(round.forTask, steps);
    if (lastEvent === undefined && target.mode === "attach") readRecorded(target.taskId).catch(fail);
  }

  function end(forTask: string, ending: Ending): void {
    const stopped = ending.kind === "review" || ending.kind === "approval" ? policyStopped : undefined;
    if (stopped !== undefined) {
      const policy = target.mode === "run" && options.approval !== "ask" ? `--approval ${options.approval}` : "its --approval policy";
      io.stderr(`The owner stopped answering task ${forTask}'s rounds under ${policy}: ${terminalText(stopped.message)}.\n`);
    }
    // A run whose policy gave up is not re-run with another: the round is decided by the commands named.
    finish(reportEnding(forTask, ending, stopped === undefined ? target.mode : "attach", options));
  }

  /**
   * A task with nothing retained — it ended before this owner started, or its
   * ring was evicted — is reported from its recorded outcome. One still
   * admitted, or with no outcome yet, is followed live.
   */
  async function readRecorded(forTask: string): Promise<void> {
    const answer = await client.request("tasks", { taskId: forTask }, prefixedId(`attach-state-${forTask}`), {
      timeoutMs: DISPATCH_TIMEOUT_MS,
    });
    if (finished) return;
    if (!answer.ok) {
      // A disconnect is reported by the close listener.
      if (answer.error?.code === "DISCONNECTED") return;
      io.stderr(`Could not read task ${forTask}'s recorded state: ${answer.error?.code}: ${answer.error?.message}\n`);
      finish(exit.unavailable);
      return;
    }
    const recorded = recordedStateOf(answer.result as RecordedTask);
    if (recorded.kind === "cancelled") {
      io.stderr(`Task ${forTask} was cancelled.\n`);
      finish(exit.taskFailed);
      return;
    }
    if (recorded.kind === "live") {
      io.stderr(`note: the owner has published nothing for task ${forTask} yet; following it live (Ctrl-C to detach).\n`);
      return;
    }
    io.stderr(
      `note: the owner holds no stream for task ${forTask} (it ended before this owner started, or its stream was evicted); ` +
        "reporting its recorded outcome.\n",
    );
    end(forTask, recorded.ending);
  }

  function requestRound(forTask: string, steps: number): void {
    listRound(forTask, steps).catch(fail);
  }

  /** The round's full call set, from the owner's pending approval rows for this task. */
  async function listRound(forTask: string, steps: number): Promise<void> {
    const listed = await client.request(
      "approvals",
      { action: "list", taskId: forTask, workspaceId, limit: 1000 },
      `round-${forTask}-${steps}`,
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
    if (finished) return;
    if (!listed.ok) {
      if (listed.error?.code === "DISCONNECTED") return;
      io.stderr(
        `Could not list task ${forTask}'s approval round: ${listed.error?.code}: ${listed.error?.message}. ` +
          `Decide it with \`tavi approvals approve ${forTask}\`, or follow it again with \`tavi run --attach ${forTask}\`.\n`,
      );
      finish(exit.unavailable);
      return;
    }
    const { rows } = listed.result as ApprovalsListResult;
    roundCalls.set(steps, roundCallIds(rows, steps));
    await maybeAsk(forTask, steps);
  }

  /** Ask for the round once every call of it has arrived, unless it was decided meanwhile. */
  async function maybeAsk(forTask: string, steps: number): Promise<void> {
    const calls = roundCalls.get(steps);
    const round = rounds.get(steps);
    if (finished || calls === undefined || round === undefined || asked.has(steps) || settledRounds.has(steps)) return;
    // Decided elsewhere before this client listed it: the rows are gone, and
    // the stream carries the settlement.
    if (calls.size === 0) return;
    if ([...calls].some((callId) => !round.calls.has(callId))) return;
    asked.add(steps);
    const requests = [...calls].map((callId) => round.calls.get(callId)).filter((request) => request !== undefined);
    // A round the run's own policy gave up on is reported, never asked: this run chose not to be asked.
    const policyRun = target.mode === "run" && options.approval !== "ask";
    if (!io.isTty || options.ask === false || (policyStopped !== undefined && policyRun)) {
      end(forTask, { kind: "approval", requests });
      return;
    }
    // An injected prompt answers yes or no; the terminal's own offers the
    // call's scopes.
    const injected = options.prompt;
    const askCall = async (
      request: RoundCall,
      signal: AbortSignal,
    ): Promise<{ readonly approved: boolean; readonly scope?: ApprovalScope }> =>
      injected !== undefined
        ? { approved: await injected(request.summary, request.input, signal) }
        : promptForApprovalScope(approvalTitleOf(request), request.input, request.allowedScopes ?? ["once"], {
            isTty: true,
            write: io.stderr,
            signal,
            // The stream printed the call (its diff or input) as it arrived; text only, as JSON lines print no `[approval]`.
            shown: options.format === "text",
          });
    const controller = new AbortController();
    prompts.set(steps, controller);
    const decisions: { callId: string; approved: boolean; scope?: ApprovalScope }[] = [];
    try {
      for (const request of requests) {
        const verdict = await askCall(request, controller.signal);
        decisions.push({
          callId: request.callId,
          approved: verdict.approved,
          ...(verdict.scope === undefined ? {} : { scope: verdict.scope }),
        });
      }
    } catch (error) {
      // Decided elsewhere, or the session ended: there is nothing to answer.
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      prompts.delete(steps);
    }
    if (finished || settledRounds.has(steps)) return;
    const answer = await client.request(
      "approve",
      { taskId: forTask, workspaceId, expectedSteps: steps, decisions, decidedBy: options.principalId },
      `approve-${forTask}-${steps}`,
      { timeoutMs: DISPATCH_TIMEOUT_MS },
    );
    if (finished) return;
    // Decided elsewhere, differently or first: the stream shows what happened.
    if (answer.ok || answer.error?.code === "CONFLICT" || answer.error?.code === IPC_NOT_PENDING) return;
    if (answer.error?.code === "DISCONNECTED") return;
    io.stderr(`approve failed: ${answer.error?.code}: ${answer.error?.message}\n`);
    // As `tavi approvals approve` exits for the same refusal: an unconfigured
    // owner is a usage mistake (2), anything else a refused decision (4).
    finish(exitForRefusal(answer.error?.code, exit));
  }

  return {
    /** Bind the subscription the response names, before its held events are dispatched. */
    bind(answer: IpcClientResponse): void {
      if (!answer.ok || finished) return;
      const named = answer.result as (RunResult | SubscribeResult) & { readonly taskId?: string };
      subscriptionId = named.subscriptionId;
      if (named.taskId !== undefined) taskId = named.taskId;
      replayRemaining = named.replayed;
      if ("roundsAnsweredBy" in named && named.roundsAnsweredBy === "owner") ownerAnswers = true;
      if (pendingDetach !== undefined) {
        detachNow(pendingDetach);
        return;
      }
      if (target.mode === "run" && "replay" in named && named.replay) {
        io.stderr(`Replayed committed admission for operation key ${target.operationKey}; no work was re-run.\n`);
      }
      if (named.truncated === true) {
        io.stderr(`note: the owner no longer holds the start of task ${taskId ?? "<task-id>"}'s stream; showing what it holds.\n`);
      }
      if (replayRemaining === 0) replayEnded();
    },
    dispose(): void {
      finished = true;
      cleanup();
    },
    done(): Promise<number> {
      return result;
    },
  };
}
