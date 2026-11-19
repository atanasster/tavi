import {
  TaviError,
  type InvocationContext,
  type SendOutcome,
  toolResultRedactionOn,
  taintModeOf,
  injectionDetectorModeOf,
  type InjectionDetectorMode,
  type TaintMode,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import type { createWorkflowAdapter, WorkflowAdapterOptions } from "@tavi/agent-host/workflow";
import {
  LINK_BEARER_NOTE,
  questionButtons,
  questionSubject,
  questionToken,
  renderQuestionText,
} from "../features/approvals/channel-approval-text.js";
import { createInjectionDetector } from "@tavi/runtime";
import { injectionClassifierFor } from "./injection-classifier.js";
import { destinationAllowed, destinationRefusal } from "../features/channels/destination.js";
import type { RoutineCheckpointHost } from "../features/routines/workflow.js";
import { createOwnerChatGrants } from "./chat-scope.js";
import type { ApprovalsContext } from "./approvals.js";

/**
 * Refuse a question the provider did not accept.
 *
 * `messaging.send` throws only for a grant refusal, a closed connection or a
 * workspace mismatch. A *provider* refusal comes back as
 * `{status: "rejected"}` — the Telegram and Mailgun connectors both return it —
 * and discarding that outcome meant an undelivered question still suspended the
 * task for its full deadline, though a task must suspend only on a question
 * someone received.
 *
 * `"uncertain"` is refused too: the question either reached a person or it did
 * not, and a task that suspends on a message nobody saw is the failure this
 * guards against. The model can retry, or the operator can be told.
 */
function requireDelivered(outcome: SendOutcome, question: string): void {
  if (outcome.status === "accepted") return;
  throw new TaviError(
    "UNAVAILABLE",
    `the question could not be delivered (${outcome.status}); not suspending on a message the operator never received: ${question.slice(0, 80)}`,
    { details: { status: outcome.status } },
  );
}

/** Routine checkpoints, chat grants, asking the person, redaction, taint and the injection scan. */
export function composeAsking(composed: ApprovalsContext) {
  const {
    channelApprovals,
    channelTarget,
    clock,
    currentConnectionIds,
    destinationChannels,
    heartbeatReports,
    isEmailConnection,
    logger,
    messaging,
    messagingAllowedDestinations,
    modelAccounting,
    modelAdapter,
    modelConnectionLocality,
    options,
    overrides,
    persistencePort,
  } = composed;
  /** Routine roots a run is holding on a checkpoint question. */
  const routineCheckpoints: RoutineCheckpointHost = {
    held: new Map(),
    ...(overrides.routineCheckpointPollMs === undefined ? {} : { pollMs: overrides.routineCheckpointPollMs }),
  };

  // How an `ask_user` question reaches the operator.
  // The workflow knows nothing about connectors; this closes over the
  // messaging service and the same operator allowlist `messaging.send_to`
  // uses, so the tool cannot address a conversation the operator did not
  // authorize.
  /** How long before a schedule's next fire its question is decided, so the carried-on task does not overlap that fire. */
  const SCHEDULE_QUESTION_RESERVE_MS = 15 * 60_000;
  /**
   * Fresh context: a chat whose next message starts a fresh epoch, as
   * `chat-context {action: "compact"}` asked, is a `fresh` row in
   * `tavi_memory_marks`, so a restart keeps a request not yet
   * taken. Asking again before it is taken is the same request; the next
   * message takes it by deleting the row, so it is taken once.
   */
  const FRESH_CONTEXT_MARK = { kind: "fresh", mark: "next" } as const;
  // Grants in a chat that never ends lapse, judged from where a task started, as its tool policy is.
  const chatGrants = createOwnerChatGrants(persistencePort.repositories, () => clock.now());
  /** A task's schedule, whether it runs under a schedule's checkpoint policy, and the fire's admission key that created it. */
  const askingTask = async (
    taskId: string,
  ): Promise<
    | {
        readonly schedule: import("@tavi/contracts").ScheduleRecord | undefined;
        readonly checkpoints: boolean;
        readonly runKey: string | null;
      }
    | undefined
  > => {
    const task = await persistencePort.repositories.tasks.get(taskId);
    if (task?.originScheduleId === null || task?.originScheduleId === undefined) return undefined;
    return {
      schedule: await persistencePort.repositories.schedules.get(task.originScheduleId),
      checkpoints: task.executionPolicy.requiresDefault === true,
      runKey: task.creationOperationKey,
    };
  };
  const askUserDelivery: NonNullable<WorkflowAdapterOptions["askUser"]> = async ({
    question,
    choices,
    context,
    invocation,
    taskId,
    waitId,
    connectionId,
    chatId,
    origin: askedBy,
    destination: chosen,
    bestEffort,
  }) => {
    let destination = chosen;
    // Options are numbered in the text, and buttons where the connector
    // has them; the text alone always says how to answer. The
    // wait's row is active by now, so its bounded deadline is known.
    const deadlineAt = (await persistencePort.repositories.agentWaits.get(waitId))?.deadlineAt;
    // A schedule's or a routine's run says whose question it is: its chat is not a conversation with it.
    const asking = askedBy !== undefined ? undefined : await askingTask(taskId);
    const origin = askedBy ?? asking?.schedule?.name;
    // A schedule that may ask asks in its alert destination, which its operator chose — never a chat the model names.
    const alert = asking?.checkpoints === true ? asking.schedule?.alert : undefined;
    if (asking?.checkpoints === true && destination === undefined && alert === undefined) {
      throw new TaviError("UNAVAILABLE", "This schedule has no alert destination to ask in");
    }
    destination = destination ?? (alert === undefined ? undefined : { connectionId: alert.connectionId, chatId: alert.destination });
    const text = renderQuestionText(question, choices, {
      ...(context === undefined ? {} : { context }),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      ...(origin === undefined || origin.trim() === "" ? {} : { origin }),
      now: clock.now(),
    });
    // An email names the question in its subject, with its token.
    const subjectFor = (connection: string) =>
      isEmailConnection(connection) ? { subject: questionSubject(waitId, question, choices) } : {};
    const buttonsFor = (connection: string) =>
      choices !== undefined && messaging.capabilitiesOf(connection)?.interactions === true
        ? { buttons: questionButtons(questionToken(waitId), choices) }
        : {};
    // Recorded after a send, so a press, a link page or an edit after a
    // restart still finds where the question went.
    const recordSent = async (
      connection: string,
      destination: unknown,
      chat: string,
      outcome: SendOutcome,
      thread?: string,
    ): Promise<void> => {
      requireDelivered(outcome, question);
      const providerMessageId = outcome.parts.find((part) => part.providerMessageId !== undefined)?.providerMessageId;
      // The question is in the chat now: a failure to record it must not
      // report the delivery as failed, or the wait would be cancelled
      // under a question the person can still see and answer by typing.
      try {
        await channelApprovals.recordQuestion({
          waitId,
          taskId,
          connectionId: connection,
          destination,
          chatId: chat,
          ...(thread === undefined ? {} : { threadId: thread }),
          text,
          ...(providerMessageId === undefined ? {} : { providerMessageId }),
        });
      } catch (error) {
        logger.error("a delivered question could not be recorded", { waitId, connectionId: connection, error: errorMessage(error) });
      }
    };
    // An email also carries single-use links, one per option.
    const textFor = async (connection: string): Promise<string> => {
      const lines =
        choices === undefined ? [] : await channelApprovals.questionLinkLines({ taskId, waitId, choices, connectionId: connection });
      return lines.length === 0
        ? text
        : `${text}\n\nOr open a link — each asks you to confirm, and works once. ${LINK_BEARER_NOTE}\n${lines.join("\n")}`;
    };
    // Called with the wait's row already active,
    // and never on a resumed turn: `waitFor` returns the settled outcome
    // before delivering. A replay of a turn that crashed after sending is
    // caught by the outbox's `effectId` below.
    // A worker asks in its delegation root's conversation, as its approval
    // rounds are announced there.
    // A destination the operator chose (a routine's) is asked in as named.
    const replyTo = destination !== undefined ? undefined : (invocation.messagingReplyTo ?? (await channelApprovals.replyTargetOf(taskId)));
    const target =
      replyTo === undefined
        ? undefined
        : messaging.buildReplyDestination(replyTo.connectionId, {
            externalConversationId: replyTo.externalConversationId,
            externalSenderId: replyTo.externalSenderId,
            ...(replyTo.externalMessageId === undefined ? {} : { externalMessageId: replyTo.externalMessageId }),
            ...(replyTo.externalThreadId === undefined ? {} : { externalThreadId: replyTo.externalThreadId }),
          });
    // Deterministic per wait, so the messaging outbox recognises a repeat:
    // the graph's tool-node dispatch bypasses the effect ledger, so the
    // outbox is the only thing standing between a post-send failure and a
    // second copy of the question in the operator's chat.
    const effectId = `ask:${waitId}`;
    if (target !== undefined && replyTo !== undefined) {
      await recordSent(
        replyTo.connectionId,
        target,
        replyTo.externalConversationId,
        await messaging.send({
          effectId,
          connectionId: replyTo.connectionId,
          workspaceId: invocation.workspaceId,
          destination: target,
          parts: [{ content: await textFor(replyTo.connectionId) }],
          ...buttonsFor(replyTo.connectionId),
          ...subjectFor(replyTo.connectionId),
          // Threading headers, so a Mailgun answer arrives in the same
          // conversation — `messaging.send` forwards these and
          // `features/channels/tools.ts` already does the same for a reply.
          ...(replyTo.externalMessageId === undefined ? {} : { replyToId: replyTo.externalMessageId }),
        }),
        // The topic it was asked in: only a message there answers it by typing.
        replyTo.externalThreadId,
      );
      return;
    }
    // No inbound conversation to reply into (a scheduled or CLI-driven
    // task), so the destination has to be named explicitly — and it must
    // be one the operator allowlisted, exactly as `messaging.send_to`
    // requires, because the model chose it — unless the operator chose it.
    // A tool's question names no channel: it goes to the conversation the task is in, as a message there when
    // the channel cannot reply into it; with no conversation, it waits in Needs you, answered from Center or the terminal.
    if (bestEffort === true && destination === undefined)
      destination = replyTo === undefined ? undefined : { connectionId: replyTo.connectionId, chatId: replyTo.externalConversationId };
    const named = destination ?? (connectionId === undefined || chatId === undefined ? undefined : { connectionId, chatId });
    if (named === undefined && bestEffort === true) return;
    if (named === undefined) {
      throw new TaviError(
        "INVALID_INPUT",
        "ask_user needs a connectionId and chatId when the task has no inbound conversation to reply to",
      );
    }
    // The channel's own form of the target, as `messaging.send_to` takes it.
    const to = channelTarget(named.connectionId, String(named.chatId));
    if (to === undefined)
      throw new TaviError(
        "INVALID_INPUT",
        `ask_user: ${String(named.chatId)} is not a target on connection ${named.connectionId}'s channel`,
      );
    if (
      destination === undefined &&
      !destinationAllowed(named.connectionId, to, messagingAllowedDestinations, currentConnectionIds(), destinationChannels)
    ) {
      throw new TaviError("NOT_AUTHORIZED", `ask_user refused: ${destinationRefusal(named.connectionId, to, currentConnectionIds())}`);
    }
    const built = messaging.buildDestination(named.connectionId, { to });
    if (built === undefined)
      throw new TaviError(
        "UNSUPPORTED",
        `Connection ${named.connectionId} is not open, or its channel cannot be sent to except as a reply`,
      );
    await recordSent(
      named.connectionId,
      built,
      to,
      await messaging.send({
        effectId,
        connectionId: named.connectionId,
        workspaceId: invocation.workspaceId,
        destination: built,
        parts: [{ content: await textFor(named.connectionId) }],
        ...buttonsFor(named.connectionId),
        ...subjectFor(named.connectionId),
      }),
    );
  };

  // `tools.redactResults`, read per tools round: owner turns and routine runs alike, and what clients are shown.
  const redactionOn = async (workspaceId: string): Promise<boolean> =>
    toolResultRedactionOn((await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings);
  // A heartbeat turn's results are always masked: what it reads may reach a channel unattended (invariant 19).
  const redactToolResults = async (context: InvocationContext): Promise<boolean> =>
    heartbeatReports.alwaysRedacted(context) || redactionOn(context.workspaceId);
  // `security.taint`, read per call as `tools.redactResults` is: `serve --taint-policy`
  // over the workspace's setting over the default (`enforce`). Unreadable settings enforce.
  let taintFallbackLogged = false;
  const taintMode = async (workspaceId: string): Promise<TaintMode> => {
    try {
      return taintModeOf((await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings, options.taintPolicy);
    } catch (error) {
      if (!taintFallbackLogged) {
        taintFallbackLogged = true;
        logger.warn("security.taint could not be read; enforcing", { workspaceId, error: errorMessage(error) });
      }
      return options.taintPolicy ?? "enforce";
    }
  };
  // `security.injectionDetector`, read per gated call of a tainted chat. `model` puts
  // what the patterns leave alone to the `fast` role, or a local chat's own model (as the idle review chooses).
  // A hit only adds a reason and raises the risk; an unreadable setting, a missing model or a failed call is no hit.
  const injectionDetector = createInjectionDetector();
  const injectionScan: NonNullable<Parameters<typeof createWorkflowAdapter>[0]["injectionScan"]> = async ({
    workspaceId,
    taskId,
    invocation,
    items,
    signal,
  }) => {
    let mode: InjectionDetectorMode;
    try {
      mode = injectionDetectorModeOf((await persistencePort.repositories.workspaceSettings.get(workspaceId)).settings);
    } catch {
      return [];
    }
    if (mode === "off") return [];
    const classify =
      mode !== "model"
        ? undefined
        : injectionClassifierFor(
            {
              attempts: (task) => modelAccounting.summaries(task),
              fastBinding: async (workspace) =>
                (await persistencePort.repositories.modelConfig.listRoleBindings(workspace)).find((binding) => binding.role === "fast")
                  ?.target,
              locality: modelConnectionLocality,
              models: modelAdapter,
              newId: () => clock.newId("attempt"),
              now: () => clock.now(),
            },
            { workspaceId, taskId, invocation },
          );
    return await injectionDetector.scan({ mode, items, classify, signal });
  };
  // What the taint step asked, or would have asked (`tavi_gate_observations`): ids and reasons, never arguments.
  const recordGateObservation = async (
    observation: Parameters<typeof persistencePort.repositories.toolPolicy.recordGateObservation>[0],
  ): Promise<void> => {
    await persistencePort.repositories.toolPolicy.recordGateObservation(observation);
  };
  return {
    FRESH_CONTEXT_MARK,
    SCHEDULE_QUESTION_RESERVE_MS,
    askUserDelivery,
    askingTask,
    chatGrants,
    injectionScan,
    recordGateObservation,
    redactToolResults,
    redactionOn,
    routineCheckpoints,
    taintMode,
  };
}

export type AskingContext = ApprovalsContext & ReturnType<typeof composeAsking>;
