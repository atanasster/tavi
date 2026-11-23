import { emit, emitError } from "../../cli/output.js";
import { EXIT, isOwnershipContention, reportCommandFailure } from "../../cli/exit.js";
import { terminalText } from "../../shared/terminal-text.js";
import { ownerWords, storeWords } from "../../shared/terminal-words.js";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import {
  displaySafe,
  NEEDS_MAX_LIMIT,
  NeedAnsweredSchema,
  NeedsAnswerSchema,
  type NeedsAnswer,
  type ApprovalsShowResult,
  approvalCallsOf,
  toolResultRedactionOn,
  APPROVAL_PENDING_MAX_LIMIT,
  ApprovalsHistoryResultSchema,
  type ApprovalsHistoryResult,
  TaviError,
  type InvocationContext,
  type TaskRecord,
  decidableRound,
  expectedStepsOf,
  roundResumeKey,
  type PendingRound,
  type RoundDecidability,
} from "@tavi/contracts";
import type { TaviRuntime } from "../../runtime/types.js";
import { singleCallProblem, undecidableRoundMessage } from "../../shared/rounds.js";
import { shownInput } from "./prompt.js";
import { historyLine, listNeeds, needLine, offlineChannelNames, pendingProvenance, withChannels } from "./inbox.js";
import { definedOnly } from "@tavi/contracts/util";
import { approveOnOwner } from "../run/attached.js";
import { connectOwnerOrReport } from "../../cli/owner-connection.js";
import { type ApprovalsCommandOptions, APPROVALS_USAGE } from "./parse.js";
import type { RunCommandOptions } from "../run/parse.js";
import { maskedCall } from "../doctor/reports.js";
import { resolveDataDirectory } from "../../shared/data-directory.js";
import type { CliIo } from "../../cli/io.js";
import { clientOperationKey, refuseReservedOperationKey } from "../../cli/operation-key.js";
import { attachToOwner, expectTargetOf, ownerRefusesDecisionFlags } from "../../cli/owner.js";
import { resolveModelTargetOrReport } from "../../cli/run-target.js";
import { type RuntimeFactory, runtimeOptionsForTarget } from "../../cli/runtime-options.js";
import { type ResolvedDataDirectory, withStorePreservingOwnership } from "../../cli/store.js";
import { foregroundStream, reportAdmitFailure, reportOutcome } from "../run/foreground.js";
import { onInterrupt } from "../../shared/interrupt.js";

/**
 * `tavi approvals history`: decisions made
 * before — approvals, artifact reviews and answered questions — newest first.
 * The live owner answers over IPC, naming each approval's channel; without
 * one, the directory is read directly and a channel is named from its
 * connection's id. Either way the output is the same.
 */
async function approvalsHistory(options: ResolvedDataDirectory<ApprovalsCommandOptions>, io: CliIo): Promise<number> {
  const filters = {
    workspaceId: options.workspaceId,
    limit: options.limit,
    ...(options.kinds === undefined ? {} : { kinds: [...options.kinds] }),
    ...(options.states === undefined ? {} : { states: [...options.states] }),
    ...definedOnly({
      since: options.since,
      until: options.until,
      toolId: options.toolId,
      principalId: options.principalId,
      cursor: options.cursor,
    }),
  };
  const print = (history: ApprovalsHistoryResult): void =>
    emit(io, options.format, history, (value) =>
      value.items.length === 0
        ? "(no decisions yet)"
        : value.items.map(historyLine).join("\n") + (value.nextCursor === undefined ? "" : `\n(more: --cursor ${value.nextCursor})`),
    );
  try {
    // JSON is the owner's answer as it came; text reads it as this build's history.
    const attached = await attachToOwner(
      resolveDataDirectory(options.dataDirectory),
      "approvals",
      { action: "history", ...filters },
      io,
      undefined,
      undefined,
      options.format === "json" ? undefined : (result) => print(ApprovalsHistoryResultSchema.parse(result)),
    );
    if (attached !== undefined) return attached;
    return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      print(
        withChannels(
          await store.asPort().repositories.approvalInbox.history(filters),
          await offlineChannelNames(store.asPort().repositories),
        ),
      );
      return EXIT.ok;
    });
  } catch (error) {
    return reportApprovalsFailure(error, io);
  }
}

/**
 * `tavi needs` (`tavi approvals needs`): everything
 * waiting on the operator as one queue — questions, approvals, reviews — the
 * soonest deadline first. The live owner answers over IPC; without one the
 * directory is read directly, the same queue either way.
 */
async function approvalsNeeds(options: ResolvedDataDirectory<ApprovalsCommandOptions>, io: CliIo): Promise<number> {
  // Text is said in the workspace's language; JSON stays as programs read it.
  const print = (answer: NeedsAnswer, t: CoreT): void =>
    emit(io, options.format, answer, (value) =>
      value.needs.length === 0
        ? t("cli.needs.none")
        : value.needs.map((need) => needLine(need, t)).join("\n") + (value.truncated ? `\n${t("cli.needs.more")}` : ""),
    );
  const input = { workspaceId: options.workspaceId, limit: Math.min(options.limit, NEEDS_MAX_LIMIT) };
  try {
    const attached = await attachToOwner(
      resolveDataDirectory(options.dataDirectory),
      "approvals",
      { action: "needs", ...input },
      io,
      undefined,
      undefined,
      options.format === "json"
        ? undefined
        : async (result, client) => print(NeedsAnswerSchema.parse(result), await ownerWords(client, options.workspaceId)),
    );
    if (attached !== undefined) return attached;
    return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      print(
        await listNeeds(store.asPort().repositories, input, await offlineChannelNames(store.asPort().repositories)),
        options.format === "json" ? coreEnglish : await storeWords(store, options.workspaceId),
      );
      return EXIT.ok;
    });
  } catch (error) {
    return reportApprovalsFailure(error, io);
  }
}

/**
 * `tavi answer <task-id> <answer>` (`tavi approvals answer`): answers the
 * task's open question from the terminal, whatever channel it started from. The
 * owner resumes the task, so one must be running.
 */
async function approvalsAnswer(options: ResolvedDataDirectory<ApprovalsCommandOptions>, io: CliIo): Promise<number> {
  if (options.taskId === undefined || options.answer === undefined) {
    io.stderr("approvals answer needs a task id and --answer\n");
    return EXIT.usage;
  }
  try {
    const attached = await attachToOwner(
      resolveDataDirectory(options.dataDirectory),
      "approvals",
      {
        action: "answer",
        workspaceId: options.workspaceId,
        taskId: options.taskId,
        answer: options.answer,
        ...(options.waitId === undefined ? {} : { waitId: options.waitId }),
      },
      io,
      undefined,
      undefined,
      options.format === "json"
        ? undefined
        : (result) => {
            const answered = NeedAnsweredSchema.parse(result);
            const said = [...answered.answers, ...(answered.other === undefined ? [] : [answered.other])].join(", ");
            io.stdout(`Answered: ${said}\n`);
          },
    );
    if (attached !== undefined) return attached;
    io.stderr("`tavi answer` needs a running owner, which resumes the task: start `tavi serve` and run it again.\n");
    return EXIT.unavailable;
  } catch (error) {
    return reportApprovalsFailure(error, io);
  }
}

/**
 * `tavi approvals list|approve|reject`.
 *
 * The resolver for a task suspended on an approval: `tavi serve` sets
 * `approval: "deny"` and nothing reads it, and the chat reply path can settle a
 * wait but never an approval — so without this command the first mutating tool
 * call in a conversation would wedge the task permanently.
 *
 * Two contract facts shape this implementation:
 *
 * - **The resume runs as the task's own owner**, not as `--decided-by`. A
 *   follow-up admission is refused unless its principal equals the task's, and
 *   the refusal path would mark a genuinely suspended task failed. `--decided-by`
 *   is attribution recorded on the decision, nothing more.
 * - **The decision set must cover every request in the interrupt.** The
 *   workflow's reply parser requires one decision per request, so a *subset* is
 *   fatal while a superset is harmless — which is why `--call` can only assert
 *   "this is the only pending call", never narrow a multi-call decision.
 *
 * While `serve` owns the data directory, every action is the owner's over IPC:
 * `approve`/`reject` decide the round on it and follow the
 * resumed turn; the direct path below runs only with no owner.
 */
/** `approvals show` as text: each round, its audit trail, then each call with its full input. */
function showText(taskId: string, value: ApprovalsShowResult): string {
  if (value.rounds.length === 0 && value.events.length === 0 && (value.calls ?? []).length === 0)
    return `(task ${taskId} has put no call to a person)`;
  const rounds = value.rounds.map(
    (round) =>
      `round ${round.steps}\ttoken ${round.token}\t${round.connectionId ?? "-"}:${round.conversationId ?? "-"}\t` +
      `expires ${round.expiresAt ?? "never"}\t${round.settledAt === undefined ? "pending" : `settled ${round.settledAt}`}`,
  );
  const events = value.events.map(
    (event) =>
      `  ${event.at}\tround ${event.steps}\t${event.kind}\t${event.via ?? "-"}\t${event.actor ?? "-"}${event.detail === undefined ? "" : `\t${JSON.stringify(event.detail)}`}`,
  );
  // What flagged each call besides taint, as its round recorded it (a guard mod's reasons, the shell checks').
  const flaggedOf = (steps: number, callId: string): string => {
    const reasons = value.rounds.find((round) => round.steps === steps)?.callScopes?.find((call) => call.callId === callId)?.reasons;
    return reasons === undefined || reasons.length === 0 ? "" : `\n    Flagged: ${terminalText(reasons.join(" · "))}`;
  };
  // The full input of each call: a chat's announcement is clipped to fit it.
  const calls = (value.calls ?? []).map(
    (call) =>
      `call ${call.callId}\tround ${call.steps}\t${call.toolId}\t${call.state}${call.decidedBy === null ? "" : `\t${call.decidedBy}`}${call.note === null ? "" : `\t${JSON.stringify(call.note)}`}${flaggedOf(call.steps, call.callId)}\n    ${shownInput(call.inputs, 2).split("\n").join("\n    ")}`,
  );
  return [...rounds, ...events, ...calls].join("\n");
}

/**
 * `tavi approvals show <task-id>`: the rounds a task announced to a
 * chat and the audit trail of each. The live owner answers over IPC; without
 * one, the directory is read directly.
 */
async function approvalsShow(options: ResolvedDataDirectory<ApprovalsCommandOptions>, io: CliIo): Promise<number> {
  const taskId = options.taskId ?? "";
  try {
    const attached = await attachToOwner(
      resolveDataDirectory(options.dataDirectory),
      "approvals",
      { action: "show", taskId, workspaceId: options.workspaceId },
      io,
      undefined,
      undefined,
      // Text unless JSON was asked for, as offline.
      options.format === "json"
        ? undefined
        : (result) => emit(io, options.format, result as ApprovalsShowResult, (value) => showText(taskId, value)),
    );
    if (attached !== undefined) return attached;
    return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
      const repositories = store.asPort().repositories;
      const task = await repositories.tasks.get(taskId);
      if (task === undefined || task.workspaceId !== options.workspaceId) {
        io.stderr(`approvals show: no task ${taskId} in workspace ${options.workspaceId}\n`);
        return EXIT.unavailable;
      }
      const shown: ApprovalsShowResult = {
        taskId,
        rounds: await repositories.approvalRounds.listForTask(taskId),
        events: await repositories.approvalRounds.listEvents(taskId),
        calls: approvalCallsOf(
          await repositories.approvals.listForTask(taskId),
          toolResultRedactionOn((await repositories.workspaceSettings.get(task.workspaceId)).settings),
        ),
      };
      emit(io, options.format, shown, (value) => showText(taskId, value));
      return EXIT.ok;
    });
  } catch (error) {
    return reportApprovalsFailure(error, io);
  }
}

/** What `approvals list` prints, from the owner's answer or the directory's: the fields both carry. */
interface PendingList {
  readonly rows: readonly {
    readonly record?: { readonly taskId: string; readonly toolId: string; readonly callId: string; readonly createdAt: string } | undefined;
    readonly task?: { readonly workspaceId?: string; readonly principalId?: string } | undefined;
    readonly provenance?: string;
  }[];
  readonly truncated: boolean;
}

/** `approvals list` as text: a row a call, its provenance under it. */
function pendingText(value: PendingList): string {
  return value.rows.length === 0
    ? "(no pending approvals)"
    : value.rows
        .map(
          (entry) =>
            `${entry.record?.taskId}\t${entry.record?.toolId}\t${entry.record?.callId}\t` +
            `${entry.task?.workspaceId ?? "?"}\t${entry.task?.principalId ?? "?"}\t${entry.record?.createdAt}` +
            (entry.provenance === undefined ? "" : `\n  ${displaySafe(terminalText(entry.provenance))}`),
        )
        .join("\n") + (value.truncated ? `\n(truncated at ${value.rows.length}; raise --limit to see more)` : "");
}

export async function approvalsCommand(
  options: ResolvedDataDirectory<ApprovalsCommandOptions>,
  io: CliIo,
  runtimeFactory: RuntimeFactory,
): Promise<number> {
  if (options.action === "needs") return approvalsNeeds(options, io);
  if (options.action === "answer") return approvalsAnswer(options, io);
  if (options.action === "list") {
    // A live owner answers over IPC, so the queue is inspectable while the daemon
    // runs — which is the whole point: an approval wedged in a chat task is
    // resolved by a process the operator is otherwise told to stop. With no owner, the same command reads the directory
    // directly.
    let attached: number | undefined;
    try {
      attached = await attachToOwner(
        resolveDataDirectory(options.dataDirectory),
        "approvals",
        { action: "list", workspaceId: options.workspaceId, limit: options.limit },
        io,
        undefined,
        undefined,
        // Text unless JSON was asked for, as offline: the owner's rows carry the same record, task and provenance.
        options.format === "json" ? undefined : (result) => emit(io, options.format, result as PendingList, pendingText),
      );
    } catch (error) {
      // An owner that holds the directory but cannot answer is a *reported*
      // refusal, not an unhandled rejection out of `main()`: letting it escape
      // changed this command's exit code depending on how the owner failed.
      return reportApprovalsFailure(error, io);
    }
    if (attached !== undefined) return attached;
    try {
      return await withStorePreservingOwnership(options.dataDirectory, async (store) => {
        const repositories = store.asPort().repositories;
        // Scoped to the workspace in SQL, so another workspace's older rows
        // cannot crowd this one's out; the full records are read for the page
        // only, as this command has always printed them.
        const page = await repositories.approvalInbox.pending({
          workspaceId: options.workspaceId,
          limit: Math.min(options.limit, APPROVAL_PENDING_MAX_LIMIT),
        });
        // A call's input is masked as `tools.redactResults` says, as the attached answer and `approvals show` hold it.
        const mask = toolResultRedactionOn((await repositories.workspaceSettings.get(options.workspaceId)).settings);
        const rows = (
          await Promise.all(
            page.rows.map(async (row) => {
              const record = await repositories.approvals.get(row.approvalId);
              // Where its chat read untrusted content, as the owner's answer says it.
              const provenance = pendingProvenance(row);
              return {
                record: record === undefined || !mask ? record : maskedCall(record),
                task: await repositories.tasks.get(row.taskId),
                ...(provenance === undefined ? {} : { provenance }),
              };
            }),
          )
        )
          // Fail closed: an approval whose records cannot be read is not shown.
          .filter((entry) => entry.record !== undefined && entry.task?.workspaceId === options.workspaceId);
        const truncated = page.truncated;
        emit(io, options.format, { rows, truncated }, pendingText);
        return EXIT.ok;
      });
    } catch (error) {
      return reportApprovalsFailure(error, io);
    }
  }

  if (options.action === "history") return approvalsHistory(options, io);
  if (options.action === "show") return approvalsShow(options, io);

  const taskId = options.taskId;
  if (taskId === undefined) {
    io.stderr(`approvals ${options.action} needs a task id\n`);
    return EXIT.usage;
  }
  const reserved = refuseReservedOperationKey(options.operationKey, io);
  if (reserved !== undefined) return reserved;

  // Under a live owner the decision is the owner's to admit,
  // as `list` is its to answer; with none, the directory is opened directly.
  const onOwner = await approvalOnOwner(options, taskId, io);
  if (onOwner !== undefined) return onOwner;

  /**
   * The task this approval belongs to.
   *
   * Read before anything else, because the resume must run as *its* owner and in
   * *its* workspace: a follow-up admission is refused for any other principal,
   * and the refusal path (`reportAdmitFailure`) writes `failed` onto a task that
   * is merely suspended.
   */
  let task: TaskRecord | undefined;
  try {
    task = await withStorePreservingOwnership(options.dataDirectory, async (store) => await store.asPort().repositories.tasks.get(taskId));
  } catch (error) {
    return reportApprovalsFailure(error, io);
  }
  if (task === undefined) {
    io.stderr(`no task ${JSON.stringify(taskId)} exists; nothing to decide\n`);
    return EXIT.resumeNotApplicable;
  }
  if (task.workspaceId !== options.workspaceId) {
    io.stderr(`Task ${taskId} belongs to workspace ${task.workspaceId}, not ${options.workspaceId}\n`);
    return EXIT.usage;
  }

  const approved = options.action === "approve";
  const baseRunOptions: RunCommandOptions = {
    prompt: "",
    format: options.format,
    // The task's own identity, never the decider's: see the note above.
    workspaceId: task.workspaceId,
    principalId: task.principalId,
    dataDirectory: options.dataDirectory,
    // Required by the options type, never read here: this path performs a single
    // `workflow.admit` and has no interactive approval loop to configure.
    approval: "deny",
    quiet: false,
    inMemory: false,
    ...definedOnly({
      connectionId: options.connectionId,
      model: options.model,
      apiKeyFile: options.apiKeyFile,
    }),
  };
  const resolved = await resolveModelTargetOrReport(baseRunOptions, io, { usage: APPROVALS_USAGE });
  if (typeof resolved === "number") return resolved;

  let runtime: TaviRuntime;
  try {
    runtime = await runtimeFactory(runtimeOptionsForTarget(resolved), {
      requireModelTransport: true,
    });
  } catch (error) {
    return reportApprovalsFailure(error, io);
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  const stopListening = onInterrupt(onSignal);
  try {
    const workflow = runtime.workflow;
    if (workflow === undefined || !runtime.host.admissionOpen) {
      io.stderr("Runtime admission is closed: the workflow service is unavailable\n");
      return EXIT.unavailable;
    }

    // The round the task is suspended on, read from its durable admission
    // record inside the composed runtime (the authoritative set): the decision
    // covers exactly that round's calls, and carries it as the precondition, so
    // a round decided meanwhile by another front end is refused rather than
    // having this decision applied to whatever is pending next. Only a waiting,
    // uncancelled task is decided.
    //
    // Keyed on the round unless the operator supplied `--operation-key`,
    // which stays this command's idempotency key: a scripted retry under it
    // replays (or conflicts with) the first decision instead of deciding
    // whatever round the first one surfaced — a round nobody reviewed.
    const repositories = runtime.store.asPort().repositories;
    const operationKeyFor = (round: PendingRound): string =>
      options.operationKey === undefined ? roundResumeKey(taskId, round) : clientOperationKey(options.operationKey);
    const current = await repositories.tasks.get(taskId);
    const decidability: RoundDecidability =
      current === undefined ? { decidable: false, reason: "no-round" } : await decidableRound(repositories, current, operationKeyFor);
    if (!decidability.decidable) {
      io.stderr(`${undecidableRoundMessage(taskId, decidability, "approval")}\n`);
      return EXIT.resumeNotApplicable;
    }
    const round = decidability.round;
    if (round.kind !== "approval") {
      io.stderr(`task ${taskId} has no pending approval; nothing to decide\n`);
      return EXIT.resumeNotApplicable;
    }
    if (options.callId !== undefined) {
      // A subset of the round's requests is fatal to the resume, so `--call`
      // can only assert that this *is* the whole set. Narrowing a multi-call
      // decision needs a workflow-side "leave undecided" reply shape.
      const problem = singleCallProblem(taskId, round.callIds, options.callId);
      if (problem !== undefined) {
        emitError(io, problem.message);
        return problem.kind === "multi-call" ? EXIT.usage : EXIT.resumeNotApplicable;
      }
    }
    const decisions = round.callIds.map((callId) => ({
      callId,
      approved,
      decidedBy: options.decidedBy,
      ...(approved && options.scope !== undefined ? { scope: options.scope } : {}),
      ...(!approved && options.note !== undefined ? { note: options.note } : {}),
    }));

    const context: InvocationContext = {
      workspaceId: task.workspaceId,
      principalId: task.principalId,
      caller: "cli",
      runId: taskId,
    };

    // Rendered from the bus, as `tavi run` is: one producer for every front end.
    const view = foregroundStream(runtime, options.format, io);
    const { renderer, stream } = view;
    stream.attach(taskId);

    try {
      const resumed = await workflow.admit(
        {
          context,
          taskId,
          operationKey: operationKeyFor(round),
          kind: "approval",
          resume: { decisions, via: "cli", ...expectedStepsOf(round) },
        },
        { signal: controller.signal },
      );
      renderer.finish();

      // A resume can surface the *next* approval — a model that calls more than
      // one gated tool across turns does exactly this. Reporting it through
      // `reportOutcome`'s `task.failed` fall-through would both lie and hide the
      // decision the operator still owes.
      if (resumed.outcome.status === "waiting" && resumed.outcome.interrupt !== undefined) {
        for (const request of resumed.outcome.interrupt.requests) {
          io.stderr(`Pending approval: ${request.toolName} (call ${request.callId})\n`);
        }
        io.stderr(`Task ${taskId} is still waiting on an approval; decide it with \`tavi approvals approve|reject ${taskId}\`.\n`);
        return EXIT.approvalRequired;
      }
      return reportOutcome(resumed.outcome, resumed.taskId, io, options.format);
    } catch (error) {
      renderer.finish();
      // A refused resume is not a failed task: `reportAdmitFailure` leaves a
      // refused admission's task as it was, which is what made a mistyped
      // `--decided-by` stop looking like data loss.
      return await reportAdmitFailure(error, taskId, repositories.tasks, io, "resume failed", view);
    } finally {
      stream.detach();
    }
  } finally {
    stopListening();
    await runtime.close();
  }
}

/**
 * `tavi approvals approve|reject` against a live owner — or `undefined` when
 * none is running, so the caller decides against the directory.
 */
async function approvalOnOwner(
  options: ResolvedDataDirectory<ApprovalsCommandOptions>,
  taskId: string,
  io: CliIo,
): Promise<number | undefined> {
  const client = await connectOwnerOrReport(options.dataDirectory, ["approvals", "subscribe", "tasks"], io, EXIT);
  if (client === undefined || typeof client === "number") return client;
  try {
    const refused = ownerRefusesDecisionFlags(options, io);
    if (refused !== undefined) return refused;
    return await approveOnOwner(
      client,
      {
        taskId,
        verdict: options.action === "reject" ? "reject" : "approve",
        decidedBy: options.decidedBy,
        ...definedOnly({
          callId: options.callId,
          scope: options.scope,
          note: options.note,
        }),
        ...expectTargetOf(options),
      },
      { format: options.format, approval: "ask", workspaceId: options.workspaceId, principalId: options.decidedBy, exit: EXIT, io },
    );
  } finally {
    client.close();
  }
}

/**
 * Report an approvals failure without re-labelling an ownership refusal.
 *
 * `withStore`'s own conflict text says what to do about an owner; wrapping it in
 * "approvals command failed: CONFLICT:" buries the one sentence the operator
 * needs.
 */
function reportApprovalsFailure(error: unknown, io: CliIo): number {
  if (error instanceof TaviError && error.code === "CONFLICT" && isOwnershipContention(error)) {
    io.stderr(
      `${error.message}\n` +
        "Another process holds the data directory without serving it over IPC — a foreground command, or a " +
        "`tavi serve` still starting. Retry once it finishes, or once the owner is up.\n",
    );
    return EXIT.alreadyOwned;
  }
  return reportCommandFailure(error, io, "approvals command failed");
}
