import { readAgentTree } from "../features/agents/tree.js";
import { randomFillSync } from "node:crypto";
import { channelDescriptorOf, channelLabelOf } from "../features/channels/catalog.js";
import { createBrowserHandoffs } from "../features/browser/handoff.js";
import { withPageLabel } from "../features/sandbox/browser-results.js";
import { createPendingBrowserActions } from "../features/browser/pending-actions.js";
import { errorMessage } from "@tavi/contracts/util";
import { createHeartbeatButtons } from "../features/heartbeat/buttons.js";
import { createReminderButtons } from "../features/reminders/delivery.js";
import { isLocalConnectionId } from "@tavi/contracts";
import { createChannelApprovals } from "../features/approvals/channel-approvals.js";
import { hostsWrittenIn } from "../features/approvals/channel-approval-text.js";
import { createConnectWaits } from "../features/apps/connect-waits.js";
import { createMemoryChannelCards } from "../features/memory/channel-cards.js";
import { workspaceZoneOf } from "../features/memory/owner.js";
import { memoryReachOf } from "./chat-scope.js";
import type { RunEventsContext } from "./run-events.js";

/** The credential a critical round's link page asks for: `tavi credentials set approvals.pin`. */
const APPROVAL_PIN_CREDENTIAL_REF = "approvals.pin";

/** Connect waits, browser handoffs, approval rounds on channels, and the channels' buttons and memory cards. */
export function composeApprovals(composed: RunEventsContext) {
  const {
    access,
    browser,
    browserTools,
    clock,
    connectWaitsRef,
    ingress,
    late,
    liveSource,
    logger,
    memory,
    memoryChannelCardsRef,
    memorySettings,
    messaging,
    options,
    overrides,
    persistencePort,
    recordedProviders,
    runEventBus,
    scheduleFires,
    secrets,
  } = composed;
  const pendingBrowserActions = createPendingBrowserActions(browser, (error) =>
    logger.warn("a pending browser action could not be outlined", { error: errorMessage(error) }),
  );
  const connectWaits = createConnectWaits({
    repositories: persistencePort.repositories,
    workflow: () => late.workflowForChannels,
    log: (level, message, fields) => logger[level](message, fields),
  });
  connectWaitsRef.current = connectWaits;
  /** Tells the chat a task came from, in one text part: false when it has none, or the send was refused. */
  const tellTaskChat = async (taskId: string, text: string, effectId: string): Promise<boolean> => {
    const target = await channelApprovals.replyTargetOf(taskId);
    const task = await persistencePort.repositories.tasks.get(taskId);
    if (target === undefined || task === undefined) return false;
    const destination = messaging.buildReplyDestination(target.connectionId, {
      externalConversationId: target.externalConversationId,
      externalSenderId: target.externalSenderId,
      ...(target.externalMessageId === undefined ? {} : { externalMessageId: target.externalMessageId }),
      ...(target.externalThreadId === undefined ? {} : { externalThreadId: target.externalThreadId }),
    });
    if (destination === undefined) return false;
    const sent = await messaging.send({
      effectId,
      connectionId: target.connectionId,
      workspaceId: task.workspaceId,
      destination,
      parts: [{ content: text }],
      ...(target.externalMessageId === undefined ? {} : { replyToId: target.externalMessageId }),
    });
    return sent.status !== "rejected";
  };
  /**
   * A connect need, told to the chat a task came from: Tavi's words only, no link and no token. Best effort,
   * as a handoff's notice is: the person can still connect from Tavi, so a failed send never ends the wait.
   */
  const tellConnect = async (input: { readonly taskId: string; readonly waitId: string; readonly text: string }): Promise<void> => {
    await tellTaskChat(input.taskId, input.text, `connect:${input.waitId}`).catch((error: unknown) =>
      logger.warn("a connect need could not be told to its chat", { taskId: input.taskId, error: errorMessage(error) }),
    );
  };
  // Handing the browser to a person in the live view: only where one is served.
  const browserHandoffs =
    overrides.liveViewServed !== true
      ? undefined
      : createBrowserHandoffs({
          browser,
          live: liveSource,
          repositories: persistencePort.repositories,
          workflow: () => late.workflowForChannels,
          taskTree: async (workspaceId, taskId) =>
            (await readAgentTree(persistencePort.repositories, workspaceId, taskId)).nodes.map((node) => node.taskId),
          // On the task's own stream, after the attempt it last ran: the transcript's row for a hold it did not wait for.
          recordControl: (change) => {
            const attemptId = runEventBus.lastAttempt(change.taskId);
            if (attemptId === undefined) return;
            runEventBus.publish(change.taskId, {
              kind: "browser.controlled",
              runId: change.taskId,
              attemptId,
              sessionId: change.sessionId,
              outcome: change.outcome,
              controlledMs: Math.round(change.controlledMs),
              ...(change.note === undefined ? {} : { replyText: change.note }),
            });
          },
          tellChat: tellTaskChat,
          // The page handed back is recorded as any observation is: its elements and title name the next action's card.
          noteObservation: async (observation, sessionId) => {
            const workspaceId = browserTools.sessionWorkspace(sessionId);
            const noted = workspaceId === undefined ? observation : await browserTools.noteObservation(observation, workspaceId);
            return withPageLabel(noted);
          },
          log: (level, message, fields) => logger[level](message, fields),
        });
  /** A connection's channel as a person names it: its provider's descriptor label. */
  const channelName = (connectionId: string): string | undefined =>
    channelLabelOf(messaging.providerOf(connectionId) ?? recordedProviders.get(connectionId));
  /** A connection whose channel is email: its messages carry a subject, and a reply's command is its first line. */
  const isEmailConnection =
    overrides.approvalEmailConnection ??
    ((connectionId: string) => channelDescriptorOf(messaging.providerOf(connectionId))?.kind === "email");
  const channelApprovals = createChannelApprovals({
    repositories: persistencePort.repositories,
    messaging,
    workflow: () => late.workflowForChannels,
    scheduleOf: (taskId) => scheduleFires.scheduleOf(taskId),
    isLocalConnection: isLocalConnectionId,
    now: () => clock.now(),
    fillRandom: (bytes) => randomFillSync(bytes),
    ...(options.approvalReasonWindowMs === undefined ? {} : { reasonWindowMs: options.approvalReasonWindowMs }),
    ...(options.approvalExpiryMs === undefined ? {} : { roundTtlMs: options.approvalExpiryMs }),
    isEmailConnection,
    channelName,
    // Links need somewhere public to open: the ingress's public address, for email.
    linkBase: overrides.approvalLinkBase ?? ((connectionId) => (isEmailConnection(connectionId) ? ingress.publicUrl() : undefined)),
    // A host the chat's people wrote stays linked on its cards: what they sent, never what a page linked.
    // Only a channel conversation's own task, whose starts and replies are its people's messages: a
    // worker's, a schedule's or a heartbeat's prompt is text a model wrote, so its cards keep every host disarmed.
    personHostsOf: async (taskId) => {
      if ((await persistencePort.repositories.messagingConversations.getByTask(taskId)) === undefined) return new Set();
      return hostsWrittenIn(
        (await persistencePort.repositories.tasks.listAdmissions(taskId)).flatMap((admission) => {
          if (admission.kind !== "start" && admission.kind !== "reply") return [];
          const prompt = (admission.intent as { readonly prompt?: unknown } | null)?.prompt;
          return typeof prompt === "string" ? [prompt] : [];
        }),
      );
    },
    // A round's deadline and decision are shown in the workspace's zone, as its reminders are.
    timeZoneOf: workspaceZoneOf(persistencePort.repositories.workspaceSettings),
    readPin: async () => (await secrets.getSecret(APPROVAL_PIN_CREDENTIAL_REF)) ?? undefined,
    // A person's rounds are the workspace operator's to decide (Allowed people).
    operatorOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
    onDiagnostic: (message, fields) => logger.warn(message, fields),
  });
  late.channelApprovals = channelApprovals;

  const reminderButtons = createReminderButtons({
    repositories: persistencePort.repositories,
    messaging,
    now: () => clock.now(),
    onDiagnostic: (message, fields) => logger.warn(message, fields),
  });
  late.reminderButtons = reminderButtons;
  // Open, Snooze and Don't tell me under a heartbeat item.
  const heartbeatButtons = createHeartbeatButtons({
    repositories: persistencePort.repositories,
    messaging,
    now: () => clock.now(),
    onDiagnostic: (message, fields) => logger.warn(message, fields),
  });
  late.heartbeatButtons = heartbeatButtons;
  // Memory cards on direct channels, and their buttons.
  const memoryChannelCards = createMemoryChannelCards({
    memory,
    repositories: persistencePort.repositories,
    messaging,
    isEmailConnection,
    isLocalConnection: isLocalConnectionId,
    channelName,
    reachOf: (taskId) => memoryReachOf(persistencePort.repositories, taskId),
    memorySettings,
    // What the chat knows, for the disarm of a card's proposals made under taint.
    knownUrlsOf: async (taskId) => {
      const task = await persistencePort.repositories.tasks.get(taskId);
      if (task === undefined || late.workflow?.checkpoints.knownUrls === undefined) return new Set();
      return (await late.workflow.checkpoints.knownUrls(task.threadId)) ?? new Set();
    },
    newId: (prefix) => clock.newId(prefix),
    now: () => clock.now(),
    log: (message, fields) => logger.warn(message, fields),
  });
  late.memoryChannelCards = memoryChannelCards;
  memoryChannelCardsRef.current = memoryChannelCards;
  return {
    browserHandoffs,
    channelApprovals,
    channelName,
    connectWaits,
    isEmailConnection,
    memoryChannelCards,
    pendingBrowserActions,
    tellConnect,
  };
}

export type ApprovalsContext = RunEventsContext & ReturnType<typeof composeApprovals>;
