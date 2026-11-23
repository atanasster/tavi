import { withBuiltinAgents } from "../features/agents/builtin.js";
import {
  type MessagingConversationTask,
  type AgentWaitIntentRecord,
  ATTENDED_TASK_POLICY,
  agentMessageGrant,
  homeChatOn,
  homeDmLinked,
  topicConversationKey,
  matchChoiceAnswer,
  waitResumeOperationKey,
  TaviError,
  clampWaitAnswer,
  type AgentWaitOutcome,
  type InboundBlock,
  type InboundEvent,
  type MessagingServicePort,
  type InvocationContext,
  type MemoryActor,
  maskPluginText,
  parsePluginCommandLine,
  MOD_COMMAND_TEXT_MAX_CHARS,
  type ModEnvelope,
  isLocalConnectionId,
  inboundParts,
  noticeWordsOf,
  textRef,
  navPath,
  renderTextRef,
} from "@tavi/contracts";
import { channelDescriptorOf } from "../features/channels/catalog.js";
import { channelWords, workspaceLocaleOf } from "../features/channels/channel-words.js";
import { TERMINAL_TASK_STATUSES, createAgentCommunicationService } from "@tavi/agent-host/agent-communication";
import { definedOnly, errorMessage } from "@tavi/contracts/util";
import type { MemoryCommandPlace } from "../features/memory/slash.js";
import { pendingRoundRefusal } from "../shared/ipc-decisions.js";
import { registerAgentTools } from "../features/agents/tools.js";
import { parseApprovalCommand, subjectRoundToken } from "../features/approvals/channel-approval-text.js";
import { parsePromptCommand, withPromptBlock } from "../features/mcp/prompts.js";
import { recordCancellation } from "../features/tasks/mutations.js";
import { sha256Hex } from "@tavi/node-kit";
import { inboundTurnOf, replyAudienceOf, roomContextBlock, type InboundTurn } from "../features/channels/inbound-turn.js";
import type { SchedulesContext } from "./schedules.js";

/** How many of a chat's open questions a typed message reads for one its own tree asked. */
const OPEN_QUESTIONS_SCANNED = 20;
/** How long after a question is answered a message that picks its options again is read as a repeat. */
const REPEAT_ANSWER_WINDOW_MS = 10 * 60 * 1000;
/** A chat message that ends the conversation's current task: `/new` or `/reset`, Telegram's `@bot` suffix allowed. */
const MESSAGING_RESET_COMMAND = /^\/(?:new|reset)(?:@\w+)?$/i;

/** Agent communication and the admission of inbound messages into conversation tasks. */
export function composeConversations(composed: SchedulesContext) {
  const {
    access,
    browserHandoffs,
    channelApprovals,
    channelTarget,
    clock,
    isEmailConnection,
    late,
    liveModelReady,
    logger,
    mcpHost,
    memory,
    memoryCommandPlaces,
    messaging,
    persistencePort,
    providerAndKind,
    store,
    tools,
    turnHooks,
    workflow,
  } = composed;
  // Only meaningful once a real workflow exists to admit worker tasks
  // through (only the workflow plugin executes or resumes an
  // agent turn); mirrors `workflow` itself being conditional on
  // `hasModelTransport`.
  if (workflow !== undefined) {
    const agents = createAgentCommunicationService({
      // A worker that inherited the conservative policy because its parent's
      // identity or row was missing is reported, so a silently unattended child
      // is observable rather than invisible.
      onDiagnostic: (message, fields) => logger.warn(message, fields),
      // A cancelled task's open question is marked withdrawn where it was asked.
      onWaitSettled: (waitId, outcome) => channelApprovals.onQuestionSettled({ waitId, outcome, via: "policy" }),
      mailbox: persistencePort.repositories.agentMailbox,
      waits: persistencePort.repositories.agentWaits,
      delegations: persistencePort.repositories.agentDelegations,
      tasks: persistencePort.repositories.tasks,
      workflow,
      access,
      artifacts: persistencePort.repositories.artifacts,
      // `spawn`'s `sharedMemoryRecordIds` validation
      // reads each requested record under the spawning actor's own access
      // before granting it to a worker.
      memory,
      // Cancellation is not routed through WorkflowPort today (see
      // `createAgentCommunicationService`'s own doc comment) — reuses the
      // exact transaction the CLI/IPC cancel path already uses, so the two
      // entry points can never drift (matches `features/tasks/mutations.ts`'s own
      // "implemented once" rationale).
      cancelTask: async (input) => {
        await recordCancellation(store, { taskId: input.taskId, reason: input.reason, operator: input.operator }, () => clock.now());
      },
      newId: (prefix) => clock.newId(prefix),
      now: () => clock.now(),
    });
    late.agentsService = agents;
    // The built-in browser worker counts as a definition, as admission reads it.
    registerAgentTools(tools, agents, {
      definitions: withBuiltinAgents(persistencePort.repositories.agents),
      delegations: persistencePort.repositories.agentDelegations,
      // Asking or answering a peer needs a grant naming it: offered only where the workspace's grant holds one.
      peerMessaging: (context) =>
        access.permissionsFor(context.workspaceId).some((permission) => permission.startsWith(agentMessageGrant(""))),
    });

    // The real inbound-message-to-task-admission implementation
    // — one task per (connectionId,
    // externalConversationId), indefinitely: the first message for a
    // conversation admits a new `kind: "start"` task and durably records
    // the mapping AFTER `admit` resolves (the same "write the durable
    // mapping after admit resolves" ordering `spawn()` already
    // establishes for delegation); every later message for the same
    // conversation admits a `kind: "reply"` on the existing task instead.
    //
    // Deliberately no top-level try/catch here beyond the one CONFLICT
    // recovery path below: `MessagingService.ingest()`'s own doc comment
    // (`packages/runtime/src/messaging/service.ts`) states plainly that it
    // never catches a thrown `admit` error, on the reasoning that the
    // event's durable recording is already complete by the time `admit`
    // runs, so a thrown error here is a genuine failure the CALLER of
    // `ingest()` must handle (the Mailgun webhook handler does, with a
    // 502 — see that file). An uncaught error from this function is a
    // deliberate contract, not an oversight — matching ends of that
    // contract, this file and `service.ts`, cross-reference each other.
    // Narrowed once: a function declared inside the handler below does not keep the `if`'s narrowing.
    const narrowedWorkflow = workflow;
    /**
     * A conversation's admissions: a prompt a plugin's hook dropped runs no
     * turn, so no model replies on the channel — the person is told why here,
     * once: the send is keyed by the admission's operation key, and a
     * replay of the admission is no new drop.
     */
    const conversationWorkflow = {
      admit: async (input: Parameters<typeof narrowedWorkflow.admit>[0]) => {
        const admission = await narrowedWorkflow.admit(input);
        const replyTo = input.context.messagingReplyTo;
        // The owner's own front ends show the reason as the turn's answer; a channel is told by a message.
        if (
          admission.outcome.dropped !== true ||
          replyTo === undefined ||
          isLocalConnectionId(replyTo.connectionId) ||
          admission.outcome.finalText.trim() === ""
        )
          return admission;
        // Addressed as the model's own reply would be, so an email answer stays in its thread.
        const destination = messaging.buildReplyDestination(replyTo.connectionId, {
          externalConversationId: replyTo.externalConversationId,
          externalSenderId: replyTo.externalSenderId,
          ...definedOnly({
            externalMessageId: replyTo.externalMessageId,
            externalReferences: replyTo.externalReferences,
            externalThreadId: replyTo.externalThreadId,
            subject: replyTo.subject,
          }),
        });
        if (destination === undefined) return admission;
        try {
          // The reason is the plugin's words: masked, as everything a plugin writes is.
          await messaging.send({
            effectId: `prompt-dropped:${input.operationKey}`,
            connectionId: replyTo.connectionId,
            workspaceId: input.context.workspaceId,
            destination,
            parts: [{ content: maskPluginText(admission.outcome.finalText) }],
          });
        } catch (error) {
          // The admission already stands: a notice that could not go out is logged, never a failed message.
          logger.warn("the reason a plugin dropped a channel message could not be sent", {
            taskId: admission.taskId,
            connectionId: replyTo.connectionId,
            error: errorMessage(error),
          });
        }
        return admission;
      },
    };
    /**
     * What a conversation's task still waits on, withdrawn as `/new` ends it
     * every open wait of the task and its workers is settled as
     * cancelled (an old question's buttons then say it was withdrawn), and a
     * task of the tree that has not ended is cancelled, which refuses its
     * pending approval rounds. A finished task is left as it is. Children are
     * read up to 200 per task, the agent tree's own bound.
     */
    const withdrawConversationTask = async (
      rootTaskId: string,
      actor: Pick<MemoryActor, "workspaceId" | "principalId">,
      connectionId: string,
    ): Promise<boolean> => {
      // Whether anything was still going: a question, or a task (or worker) not yet finished.
      let withdrew = false;
      const seen = new Set<string>();
      let level = [rootTaskId];
      for (let depth = 0; depth < 32 && level.length > 0; depth += 1) {
        const next: string[] = [];
        for (const taskId of level) {
          if (seen.has(taskId)) continue;
          seen.add(taskId);
          const wait = await persistencePort.repositories.agentWaits.getActiveByTask(taskId);
          if (wait !== undefined) {
            const outcome = { kind: "cancelled", error: { code: "CONVERSATION_RESET", message: "the conversation was reset" } } as const;
            // Settled here, then the question's messages lose their buttons, as any settled question's do.
            if (
              await persistencePort.repositories.agentWaits.settle({
                waitId: wait.waitId,
                outcome,
                by: actor.principalId,
                via: connectionId,
              })
            ) {
              withdrew = true;
              await channelApprovals.onQuestionSettled({ waitId: wait.waitId, outcome, via: connectionId });
            }
          }
          // What was granted for the rest of the chat ends with it.
          await persistencePort.repositories.toolPolicy.clearSessionGrants(taskId);
          const task = await persistencePort.repositories.tasks.get(taskId);
          if (task !== undefined && !TERMINAL_TASK_STATUSES.has(task.status)) {
            withdrew = true;
            await recordCancellation(store, { taskId, reason: "the conversation was reset", operator: actor.principalId }, () =>
              clock.now(),
            );
          }
          // Its rounds still open are withdrawn, their buttons edited away.
          await channelApprovals.onConversationReset({ taskId, via: connectionId, actor: actor.principalId });
          for (const child of await persistencePort.repositories.agentDelegations.listChildren(actor.workspaceId, taskId, 200))
            next.push(child.workerTaskId);
        }
        level = next;
      }
      return withdrew;
    };
    /** `/new`'s withdrawal ran: recorded, so a start does not run it again. A failure here is retried at the next start. */
    const markWithdrawn = async (ended: MessagingConversationTask): Promise<void> => {
      try {
        await persistencePort.repositories.messagingConversations.markWithdrawn(
          ended.connectionId,
          ended.externalConversationId,
          ended.epoch ?? 0,
          clock.now(),
        );
      } catch (error) {
        logger.warn("a reset conversation's withdrawal could not be recorded; the next start runs it again", {
          connectionId: ended.connectionId,
          taskId: ended.taskId,
          error,
        });
      }
    };
    late.withdrawUnfinishedResets = async () => {
      const conversations = persistencePort.repositories.messagingConversations;
      let unfinished: readonly MessagingConversationTask[];
      try {
        unfinished = await conversations.listUnwithdrawn();
      } catch (error) {
        logger.warn("the withdrawals of reset conversations could not be read", { error });
        return;
      }
      for (const ended of unfinished) {
        try {
          // Under the task's own person: only they could `/new` it, and a topic's side chat is withdrawn under its own.
          const task = await persistencePort.repositories.tasks.get(ended.taskId);
          if (task !== undefined)
            await withdrawConversationTask(
              ended.taskId,
              { workspaceId: task.workspaceId, principalId: task.principalId },
              ended.connectionId,
            );
          await conversations.markWithdrawn(ended.connectionId, ended.externalConversationId, ended.epoch ?? 0, clock.now());
          logger.info("withdrew what a reset conversation's task still waited on", {
            connectionId: ended.connectionId,
            taskId: ended.taskId,
          });
        } catch (error) {
          logger.warn("a reset conversation's withdrawal failed; the next start tries again", {
            connectionId: ended.connectionId,
            taskId: ended.taskId,
            error,
          });
        }
      }
    };

    /**
     * The Home a message is a turn of when its DM is linked, else undefined. An allow-list, so a connector
     * that cannot say what a direct message is never links: only a chat
     * channel's one-to-one conversation (`conversationKind: "direct"`, its id
     * the sender's own, no forum topic), from an identity the workspace's
     * `chat.home-dm` names, whose binding still resolves to the workspace's
     * operator, while `chat.home` is on and the operator has a Home. Email is
     * not linked: it is never a chat channel. Anything else keeps its own
     * conversation Home.
     */
    const linkedHomeOf = async (event: InboundEvent, actor: MemoryActor, topicKey: string | undefined): Promise<string | undefined> => {
      // Only a chat channel's one-to-one conversation is a DM; email never is.
      if (
        isLocalConnectionId(event.connectionId) ||
        event.conversationKind !== "direct" ||
        channelDescriptorOf(messaging.providerOf(event.connectionId))?.kind !== "chat"
      )
        return undefined;
      if (topicKey !== undefined || event.threadIsTopic === true) return undefined;
      // The sender's own one-to-one chat: by its id being the sender's (Telegram's private chats), or, on a channel with
      // the group seam, by the connector's `direct`, which the group conformance suite holds to that meaning — a Discord DM channel
      // has an id of its own. Anywhere else a `direct` that is
      // not the sender's chat id is taken for a mislabelled group, which must not reach Home.
      if (
        event.externalConversationId !== event.externalSenderId &&
        messaging.capabilitiesOf(event.connectionId)?.groups?.directToSender !== true
      )
        return undefined;
      if (access.resolveWorkspace(actor.workspaceId)?.principalId !== actor.principalId) return undefined;
      if (
        !homeDmLinked(
          (await persistencePort.repositories.workspaceSettings.get(actor.workspaceId)).settings,
          event.connectionId,
          event.externalSenderId,
        )
      )
        return undefined;
      const homeTaskId = await persistencePort.repositories.tasks.homeOf(actor.workspaceId, actor.principalId);
      if (homeTaskId === undefined) return undefined;
      const home = await persistencePort.repositories.tasks.get(homeTaskId);
      return home !== undefined && home.workspaceId === actor.workspaceId && home.principalId === actor.principalId
        ? homeTaskId
        : undefined;
    };

    /**
     * An inbound message on an owner with no model yet: refused, not
     * admitted against the unconfigured placeholder. Its sender hears why at
     * most once a day per conversation — the effect id is the day, as
     * `onUnverified`'s — and the message after a model is added is a turn.
     * The owner's local connection is not refused here: a reply from the app
     * or the terminal is admitted as before, its turn ending with the model's
     * own refusal where the person sees it, rather than dropped unseen.
     */
    /** The words a reply to a chat app speaks: the workspace's language, English when it cannot be read. */
    const wordsFor = async (workspaceId: string) =>
      await channelWords(workspaceLocaleOf(persistencePort.repositories.workspaceSettings), workspaceId, (message, fields) =>
        logger.warn(message, fields),
      );

    const refuseWithoutModel = async (event: InboundEvent, actor: MemoryActor): Promise<void> => {
      logger.warn("an inbound message was not admitted: no model is configured", {
        connectionId: event.connectionId,
        workspaceId: actor.workspaceId,
      });
      const destination = messaging.buildReplyDestination(event.connectionId, {
        externalConversationId: event.externalConversationId,
        externalSenderId: event.externalSenderId,
        ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
        ...(event.subject === undefined || event.subject.trim() === "" ? {} : { subject: event.subject }),
        ...(event.externalMessageId === undefined ? {} : { externalMessageId: event.externalMessageId }),
      });
      if (destination === undefined) return;
      const t = await wordsFor(actor.workspaceId);
      const conversation = sha256Hex(event.externalConversationId).slice(0, 16);
      await messaging
        .send({
          effectId: `no-model:${event.connectionId}:${conversation}:${clock.now().slice(0, 10)}`,
          connectionId: event.connectionId,
          workspaceId: actor.workspaceId,
          destination,
          parts: [
            {
              content: t("channel.conversation.noModel", {
                path: renderTextRef(navPath("nav.route.settings", "nav.settings.models"), t) ?? "",
              }),
            },
          ],
        })
        .catch((error: unknown) =>
          logger.warn("the no-model notice could not be sent", { connectionId: event.connectionId, error: errorMessage(error) }),
        );
    };

    late.messagingAdmitImpl = async ({ event, actor }) => {
      // A button press decides a round and is never a turn; the message after
      // a ❌ press is the rejection's reason, not a turn either.
      if (event.kind === "interaction") {
        // A reminder's press was handled before admission; every other press is a round's.
        await channelApprovals.handleInteraction({ actor, event });
        return;
      }
      if (await channelApprovals.takePendingReason({ actor, event })) return;
      // Read at each message, not at startup: the first model added over IPC admits the next one.
      if (!isLocalConnectionId(event.connectionId) && !(await liveModelReady(actor.workspaceId))) {
        await refuseWithoutModel(event, actor);
        return;
      }
      const conversations = persistencePort.repositories.messagingConversations;
      // A forum topic of a group is a side chat of the group's Home, mapped
      // under a key of its own. A reply thread is not a topic, and the
      // owner's local connection has none. With `chat.home` off there are no
      // side chats: the group is one task, its topics included.
      const topicKey =
        event.threadIsTopic === true &&
        event.externalThreadId !== undefined &&
        !isLocalConnectionId(event.connectionId) &&
        homeChatOn((await persistencePort.repositories.workspaceSettings.get(actor.workspaceId)).settings)
          ? topicConversationKey(event.externalConversationId, event.externalThreadId)
          : undefined;
      /** The topic's side chat, if it has one, else the conversation's Home: the chat this message is in. */
      const currentChat = async () =>
        (topicKey === undefined ? undefined : await conversations.get(event.connectionId, topicKey)) ??
        (await conversations.get(event.connectionId, event.externalConversationId));
      // The operator's own DM, linked to their Home: its
      // messages are turns of the workspace Home, each answered here.
      const linkedHome = await linkedHomeOf(event, actor, topicKey);
      // The sender's own words: the message without a forward or an email's quoted
      // parts, as its connector reported them. Only these can be a command; the turn's prompt is read below.
      const senderWords = inboundParts(event).own;
      // Someone else wrote: the operator's heartbeat may want a look, and notices one left unanswered.
      late.heartbeatEvents?.messageArrived(actor.workspaceId, actor.principalId);
      if (!isLocalConnectionId(event.connectionId)) {
        const chatTask = linkedHome ?? (await currentChat())?.taskId;
        await persistencePort.repositories.heartbeats
          .noteInbound({
            connectionId: event.connectionId,
            conversationKey: topicKey ?? event.externalConversationId,
            workspaceId: actor.workspaceId,
            senderPrincipalId: actor.principalId,
            providerEventId: event.providerEventId,
            ...(chatTask === undefined ? {} : { taskId: chatTask }),
            at: new Date(clock.now()).toISOString(),
          })
          .catch((error: unknown) =>
            logger.warn("an inbound message could not be noted for the heartbeat", { error: errorMessage(error) }),
          );
      }
      /**
       * An `@name` prefix picks the persona for this turn.
       *
       * Before this, an inbound chat message always admitted with no
       * `agentDefinitionId`, so the orchestrator was unreachable from the channel
       * the scenario is actually driven from: a schedule could name `sdaddy`, a
       * chat message could not. A leading mention is the one shape that needs no
       * new schema, no new binding and no transport work — the operator's own
       * message says who they are talking to.
       *
       * Ids resolve first (so an id always works), then an exact
       * case-insensitive *name* among the enabled definitions. An unresolved
       * mention is *not* an error: the message is admitted exactly as it would
       * have been, because a chat message with a typo in it is still a message
       * the operator meant to send. Stripping the mention is what keeps it out of
       * the model's reading of the instruction.
       */
      /**
       * An approval can be answered from the conversation that raised it.
       *
       * The runtime's own approval interrupts had exactly one resolver: the
       * foreground `tavi approvals` command (or the workflow's own prompt on the
       * `run` path). A task admitted *from chat* that calls a gated tool therefore
       * suspended with nobody to answer it in the channel the operator is already
       * in — which is what "run on demand from Telegram" was blocked on.
       *
       * The command is the whole message (`approve`/`allow` or `reject`/`deny`,
       * optionally a round token or task id, then a scope for an approval or a
       * reason for a rejection), so it cannot be confused with an instruction to
       * the model. With no id the conversation's own task is the subject: one
       * conversation maps to one task, so the operator does not have to carry an
       * id through a chat. The decision is recorded under the *task's* own
       * principal and workspace, exactly as the CLI does, and the workspace is
       * checked here so a chat message cannot decide another workspace's task.
       */
      // Not on the local connection: its front ends decide rounds over IPC
      // (`approve`, with the round named), and a reply there is always text.
      // The grammar and the decision live in `channel-approvals.ts`.
      // An email reply's command is its first line — the rest is signature and
      // quoted text — and a bare verb there names the round in the subject.
      // Commands are the sender's own words: never a forward's or an email's quoted part.
      const commandText = !isEmailConnection(event.connectionId)
        ? senderWords
        : (senderWords.split(/\r?\n/).find((line) => line.trim() !== "") ?? "");
      const typedCommand = isLocalConnectionId(event.connectionId) ? null : parseApprovalCommand(commandText);
      // A question email's subject carries its token too: that names a
      // question, never a round, so a reply there is its answer below.
      const subjectNamed = subjectRoundToken(event.subject);
      const subjectQuestion =
        subjectNamed === undefined ? undefined : await persistencePort.repositories.needDeliveries.getByToken(subjectNamed);
      const subjectToken = subjectQuestion === undefined ? subjectNamed : undefined;
      let approvalCommand = typedCommand;
      if (typedCommand !== null && typedCommand.target === undefined) {
        // A bare verb under a question's subject is that question's answer, whatever task this conversation has.
        if (subjectQuestion !== undefined) approvalCommand = null;
        else if (subjectToken !== undefined) approvalCommand = { ...typedCommand, target: subjectToken };
      }
      if (approvalCommand !== null) {
        // In a linked DM a bare verb names Home's round, as the DM's turns are Home's.
        const conversationTaskId = linkedHome ?? (await currentChat())?.taskId;
        const destination = messaging.buildReplyDestination(event.connectionId, {
          externalConversationId: event.externalConversationId,
          externalSenderId: event.externalSenderId,
          ...(event.subject === undefined || event.subject.trim() === "" ? {} : { subject: event.subject }),
          ...(event.externalMessageId === undefined ? {} : { externalMessageId: event.externalMessageId }),
          ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
        });
        const reply = async (text: string): Promise<void> => {
          if (destination === undefined) return;
          try {
            const outcome = await messaging.send({
              effectId: clock.newId("msg"),
              connectionId: event.connectionId,
              workspaceId: actor.workspaceId,
              destination,
              parts: [{ content: text }],
            });
            // A provider refusal is a return value, not a throw: unchecked, the
            // operator sees nothing and the runtime believes it answered.
            if (outcome.status !== "accepted") {
              logger.warn("a chat approval acknowledgement was not accepted by the connector", {
                connectionId: event.connectionId,
                status: outcome.status,
              });
            }
          } catch (error) {
            // The decision is already recorded; the acknowledgement is best
            // effort, and a failed reply must not fail the ingest, which would
            // make the provider redeliver a command that has been applied.
            logger.warn("a chat approval acknowledgement could not be sent", { connectionId: event.connectionId, error });
          }
        };
        const answer = await channelApprovals.decide({
          actor,
          connectionId: event.connectionId,
          conversationTaskId,
          command: approvalCommand,
          ...(event.senderAuthentication === undefined ? {} : { senderAuthentication: event.senderAuthentication }),
          // Home's rounds raised in the canvas were never asked here: a bare verb decides only one this DM was asked.
          ...(linkedHome === undefined
            ? {}
            : { announcedIn: { connectionId: event.connectionId, conversationId: event.externalConversationId } }),
        });
        // `undefined`: the task is waiting on a question, and this message is
        // its answer — the wait-answering path below takes it.
        if (answer !== undefined) {
          await reply(answer);
          return;
        }
      }

      const resolveMention = async (content: string): Promise<{ readonly agentId: string; readonly content: string } | undefined> => {
        // The trailing class is the boundary an operator actually writes after a
        // name (`@sdaddy, run all projects`). A bare `\s|$` treated the comma as
        // part of nothing and silently dropped the mention.
        const match = /^@([A-Za-z0-9._-]{1,64})(?:[\s,;:.!?]|$)/.exec(content);
        if (match === null) return undefined;
        const token = match[1] ?? "";
        const workspaceId = actor.workspaceId;
        try {
          // `get` validates the row on the way out and *throws* on an unreadable
          // one, and this is the first caller to hand it text a stranger typed: a
          // hand-edited definition must cost the persona, never the message.
          const byId = await persistencePort.repositories.agents.get(workspaceId, token);
          const resolved =
            byId !== undefined && byId.enabled
              ? byId
              : (await persistencePort.repositories.agents.list(workspaceId)).agents.find(
                  (definition) => definition.enabled && definition.name.toLowerCase() === token.toLowerCase(),
                );
          if (resolved === undefined) return undefined;
          const prompt = content.slice(match[0].length).trim();
          return {
            agentId: resolved.agentId,
            // A bare `@agent` with nothing after it is not an instruction: the
            // original content is kept rather than admitting an empty prompt.
            content: prompt === "" ? content : prompt,
          };
        } catch {
          return undefined;
        }
      };

      // `event.externalMessageId` is already `string | undefined`, exactly
      // matching `InvocationContext.messagingReplyTo`'s own field type
      // (explicit `| undefined`, not a bare `?:` — the `exactOptionalPropertyTypes`
      // reason documented on that field in `@tavi/contracts`' ports), so it's assigned
      // directly rather than conditionally spread.
      const messagingReplyTo: NonNullable<InvocationContext["messagingReplyTo"]> = {
        connectionId: event.connectionId,
        externalConversationId: event.externalConversationId,
        externalSenderId: event.externalSenderId,
        externalMessageId: event.externalMessageId,
        ...(event.externalReferences === undefined ? {} : { externalReferences: event.externalReferences }),
        // A forum topic's replies and rounds stay in that topic.
        ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
        // An email reply keeps the thread's subject.
        ...(event.subject === undefined || event.subject.trim() === "" ? {} : { subject: event.subject }),
        // Who reads a reply: one-to-one only when known to be; unknown counts as a group.
        ...(replyAudienceOf(event, {
          local: isLocalConnectionId(event.connectionId),
          topic: topicKey !== undefined || event.threadIsTopic === true,
          email: channelDescriptorOf(messaging.providerOf(event.connectionId))?.kind === "email",
        }) === undefined
          ? {}
          : { audience: "one-to-one" as const }),
      };
      // The front end a message on the owner's own local connection was typed
      // in, which the owner set from the IPC connection;
      // never honoured from another connection's event. Only a new turn takes
      // it: a resume runs under the context its turn was asked in.
      const frontEnd: Pick<InvocationContext, "frontEnd"> =
        isLocalConnectionId(event.connectionId) && (event.frontEnd === "web" || event.frontEnd === "ipc")
          ? { frontEnd: event.frontEnd }
          : {};
      // A group's message reads only its chat's notes, from its first turn: the
      // conversation's mapping, which `memoryReachOf` reads on every later admission, is
      // recorded only after the first one. As `memoryReachOf` judges it: a topic, a group, or a
      // chat channel's thread.
      const groupReach: Pick<InvocationContext, "memoryReach"> =
        !isLocalConnectionId(event.connectionId) &&
        (topicKey !== undefined ||
          event.conversationKind === "group" ||
          (event.conversationKind === "thread" && channelDescriptorOf(messaging.providerOf(event.connectionId))?.kind === "chat"))
          ? { memoryReach: "chat-only" }
          : {};
      /**
       * A chat message either **answers a question the task is waiting on** or
       * is a new turn.
       *
       * Before this, every inbound message admitted a fresh `kind: "reply"` turn
       * with no `resume`. A task suspended on a wait — the shape an orchestrator
       * asking the operator a question produces — therefore never received the
       * answer: the suspended graph stayed suspended forever while the person's
       * reply was handled as an unrelated new turn.
       *
       * A conversation maps to exactly one task, and a suspended task is waiting
       * for the human who is typing in it, so no correlation id has to travel
       * through a chat: an active wait on this task *is* the correlation. Settled
       * with `"answered"` and resumed through the same `kind: "deadline"` path
       * `agent-communication.ts` already uses for a peer's reply.
       */

      /** A wait only a person can answer: a question, not a peer's reply or a worker's end (see below). */
      const isQuestion = (wait: AgentWaitIntentRecord | undefined): wait is AgentWaitIntentRecord =>
        wait !== undefined &&
        wait.state === "active" &&
        wait.correlationId === undefined &&
        wait.waitingOnWorkerTaskId === undefined &&
        wait.handoff === undefined &&
        wait.connect === undefined;
      /** Whether this sender owns the task a wait is on: only its owner may answer it. */
      const ownsWaitTask = async (wait: AgentWaitIntentRecord): Promise<boolean> => {
        const task = await persistencePort.repositories.tasks.get(wait.taskId);
        return task !== undefined && task.workspaceId === actor.workspaceId && task.principalId === actor.principalId;
      };
      /**
       * The question a message in this conversation answers: the conversation
       * task's own, or — when it asks nothing — the latest still open that was
       * asked in this chat, as a delegated worker at any depth asks in its
       * root's conversation.
       */
      const openQuestionOf = async (taskId: string): Promise<AgentWaitIntentRecord | undefined> => {
        const own = await persistencePort.repositories.agentWaits.getActiveByTask(taskId);
        // Only the task's owner answers its question: in a group chat any bound
        // member's message arrives here, as a press does (invariant 5).
        if (isQuestion(own)) return (await ownsWaitTask(own)) ? own : undefined;
        // Asked in this chat — in a forum topic, in this topic: a message in
        // one never answers another's — by a task of this chat's own tree, a
        // worker it delegated at any depth.
        // The newest such, never the chat's newest of any tree: a newer question
        // another tree asked (a topic's worker, say) does not hide this one.
        const topicThread = event.threadIsTopic === true ? event.externalThreadId : undefined;
        for (const asked of await persistencePort.repositories.needDeliveries.listOpenInChat(
          event.connectionId,
          event.externalConversationId,
          topicThread,
          OPEN_QUESTIONS_SCANNED,
        )) {
          const wait = await persistencePort.repositories.agentWaits.get(asked.waitId);
          if (!isQuestion(wait)) continue;
          const delegation =
            wait.taskId === taskId ? undefined : await persistencePort.repositories.agentDelegations.getByWorkerTaskId(wait.taskId);
          const inTree =
            wait.taskId === taskId ||
            delegation?.rootTaskId === taskId ||
            (delegation?.rootTaskId === undefined && delegation?.parentTaskId === taskId);
          if (inTree && (await ownsWaitTask(wait))) return wait;
        }
        return own;
      };

      /**
       * A room whose context is `recent`: its triggered turn also reads up to 20 of its messages
       * before this one, as one block beside it, each known author's words labelled theirs and anyone else's
       * replaced. Read once a message, and only for one the room policy admitted; a failed read reads nothing.
       */
      let roomContext: Promise<InboundBlock | undefined> | undefined;
      const withRoomContext = async (turn: InboundTurn): Promise<InboundTurn> => {
        roomContext ??= (async () => {
          if (event.conversationKind !== "group" && event.conversationKind !== "thread") return undefined;
          const room = await persistencePort.repositories.channelRooms.get(event.connectionId, event.externalConversationId);
          if (room?.context !== "recent" || room.workspaceId !== actor.workspaceId || messaging.fetchRecent === undefined) return undefined;
          const destination = messaging.buildReplyDestination(event.connectionId, {
            externalConversationId: event.externalConversationId,
            externalSenderId: event.externalSenderId,
            ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
          });
          if (destination === undefined) return undefined;
          const recent = await messaging
            .fetchRecent(event.connectionId, actor.workspaceId, destination, {
              limit: 20,
              ...(event.externalMessageId === undefined ? {} : { before: event.externalMessageId }),
              signal: AbortSignal.timeout(10_000),
            })
            .catch((error: unknown) => {
              // The turn goes on with its message alone; an operator sees why the room's context was not read.
              logger.warn("channels: a room's recent messages could not be read for its turn", {
                connectionId: event.connectionId,
                error: errorMessage(error),
              });
              return [];
            });
          // Known in this room's workspace, or not at all.
          const names = new Map<string, string | undefined>();
          for (const message of recent) {
            if (names.has(message.externalSenderId)) continue;
            const binding = await persistencePort.repositories.messagingIdentityBindings.get(event.connectionId, message.externalSenderId);
            names.set(
              message.externalSenderId,
              binding === undefined || binding.workspaceId !== actor.workspaceId ? undefined : (binding.displayName ?? binding.principalId),
            );
          }
          return roomContextBlock(
            recent.filter((message) => message.externalMessageId !== event.externalMessageId),
            {
              connectionId: event.connectionId,
              nameOf: (sender) => names.get(sender),
              ref: `${event.connectionId}:${event.providerEventId}:context`,
              at: clock.now(),
            },
          );
        })();
        const block = await roomContext;
        return block === undefined ? turn : { ...turn, inbound: [block, ...turn.inbound] };
      };

      /**
       * A server's prompt run as `/mcp-<server>-<prompt> [arguments]`, in the operator's own
       * chat: the command stays the person's request, and the prompt's text — the server's — joins the turn as quoted
       * data (`inbound-`, untrusted `mcp`, `tool:<server>`), shown to the person first. Undefined when the command could
       * not run: the person is told why, and no turn starts. Any other line, or another person's, is left as typed.
       */
      // One expansion a message: a start that turns into a reply (a CONFLICT) runs the text the person was shown.
      let expanded: Promise<InboundTurn | undefined> | undefined;
      const withMcpPrompt = (turn: InboundTurn, principalId: string): Promise<InboundTurn | undefined> => {
        if (turn.prompt === undefined || parsePromptCommand(turn.prompt) === undefined) return Promise.resolve(turn);
        expanded ??= expandMcpPrompt(turn, turn.prompt, principalId);
        return expanded;
      };
      const expandMcpPrompt = async (turn: InboundTurn, typed: string, principalId: string): Promise<InboundTurn | undefined> => {
        const say = async (text: string, kind: string): Promise<void> => {
          // A reply into the conversation, or — where the channel cannot reply — a message to it.
          const target = channelTarget(event.connectionId, event.externalConversationId);
          const destination =
            messaging.buildReplyDestination(event.connectionId, {
              externalConversationId: event.externalConversationId,
              externalSenderId: event.externalSenderId,
              ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
            }) ?? (target === undefined ? undefined : messaging.buildDestination(event.connectionId, { to: target }));
          if (destination !== undefined)
            await messaging.send({
              effectId: `mcp-prompt-${kind}:${event.connectionId}:${event.providerEventId}`,
              connectionId: event.connectionId,
              workspaceId: actor.workspaceId,
              destination,
              parts: [{ content: text }],
            });
        };
        try {
          const prompt = await mcpHost.bridge.promptFor(typed, { workspaceId: actor.workspaceId, principalId, ...groupReach });
          if (prompt === undefined) return turn;
          await say(
            `The prompt ${prompt.name} of ${prompt.serverName}, sent with your message as the server's words, not yours:\n\n${prompt.text}`,
            "shown",
          );
          return {
            prompt: typed,
            inbound: withPromptBlock(turn.inbound, { ...prompt, ref: `${event.connectionId}:${event.providerEventId}`, at: clock.now() }),
          };
        } catch (error) {
          await say(`${typed.split(/\s/)[0] ?? typed} did not run: ${errorMessage(error)}`, "failed");
          return undefined;
        }
      };

      /**
       * The message's attachments given the chat it joins, before its turn can read them: from then on only that
       * chat's tools read them (`chatOwnsArtifact`). The first chat keeps one; a redelivery changes nothing.
       */
      const claimAttachments = async (taskId: string): Promise<void> => {
        for (const { artifactId } of event.attachments ?? [])
          await persistencePort.repositories.artifacts.claimAttachmentForRun?.({ artifactId, runId: taskId });
      };

      /** `answerOnly`: the message is a reply to a question in a chat with no task of its own — it answers, or does nothing. */
      const admitReply = async (taskId: string, repliedTo?: AgentWaitIntentRecord, answerOnly = false): Promise<unknown> => {
        // Whose task this is: another bound member's message, on any channel, is a
        // turn of the person's task, under the person — their words admitted as labelled quoted data, never the
        // prompt, and the turn reads only the chat's notes. A sender bound in another workspace is refused before
        // anything of theirs is read as an answer.
        const owner = await persistencePort.repositories.tasks.get(taskId);
        if (owner === undefined || owner.workspaceId !== actor.workspaceId)
          throw new TaviError("NOT_AUTHORIZED", "This chat's task is outside this scope");
        await claimAttachments(taskId);
        const member = owner.principalId !== actor.principalId;
        const turn = await withRoomContext(
          inboundTurnOf(event, { sendersTask: !member, email: isEmailConnection(event.connectionId), at: clock.now() }),
        );
        const waiting = repliedTo ?? (await openQuestionOf(taskId));
        // The task the answer resumes: a worker's, when the question was its.
        const answeredTaskId = waiting?.taskId ?? taskId;
        /**
         * Only a wait a **human** can legitimately answer.
         *
         * A wait row has three shapes and only the third is answerable here: a
         * `correlationId` wait is an `agents.request` expecting a *peer agent's*
         * envelope, and a `waitingOnWorkerTaskId` wait expects a worker to
         * finish. Settling either with whatever an operator happened to type
         * hands the model the wrong thing as if it were the peer's answer, and
         * demotes the real reply or completion to an unrelated wake — re-opening
         * the exact bypass `agent-communication.ts` documents closing (it
         * filters on correlation id *and* envelope kind before settling).
         *
         * With no correlation and no worker, the wait is the bare-deadline shape
         * that a question to the operator (and only that) uses today, so a chat
         * message is the only thing that can resolve it. When `ask_user` lands it
         * should carry an explicit "expects a human" marker, which is the
         * discriminator this rule is standing in for.
         */
        // A browser handoff is the person's to end in the live view, not by a chat message.
        const answerableByHuman =
          waiting !== undefined &&
          waiting.correlationId === undefined &&
          waiting.waitingOnWorkerTaskId === undefined &&
          waiting.handoff === undefined &&
          waiting.connect === undefined;
        // Whitespace-only is not an answer: settling with it would tell the model
        // the operator said nothing, and Mailgun defaults an absent body to "".
        // Only the person's own words answer: never a forward, a quote or an unverified email.
        const answer = turn.prompt?.trim();
        if (answerableByHuman && answer !== undefined && answer !== "") {
          // A question with options reads the answer against them: a number or
          // label picks one, anything else is `other` where allowed.
          // An email's answer is its first line: what follows is a signature or
          // the quoted question. Only a first line that picks options is taken
          // alone; anything else is read whole.
          const firstLine = !isEmailConnection(event.connectionId)
            ? undefined
            : answer
                .split(/\r?\n/)
                .find((line) => line.trim() !== "")
                ?.trim();
          const firstPick =
            firstLine === undefined || firstLine === answer || waiting.choices === undefined
              ? undefined
              : matchChoiceAnswer(firstLine, waiting.choices);
          const matched =
            waiting.choices === undefined
              ? undefined
              : firstPick !== undefined && "answers" in firstPick && firstPick.other === undefined
                ? firstPick
                : matchChoiceAnswer(answer, waiting.choices);
          if (matched !== undefined && "refusal" in matched) {
            const destination = plainReplyDestination(messaging, event);
            if (destination !== undefined) {
              await messaging.send({
                effectId: clock.newId("msg"),
                connectionId: event.connectionId,
                workspaceId: actor.workspaceId,
                destination,
                parts: [{ content: matched.refusal }],
              });
            }
            return undefined;
          }
          const outcome: AgentWaitOutcome = {
            kind: "answered",
            ...(matched === undefined
              ? {}
              : { answers: [...matched.answers], ...(matched.other === undefined ? {} : { other: matched.other }) }),
            // Clamped, not rejected: the schema bounds this field and `settle()`
            // writes without validating, so an over-long answer would otherwise
            // store a row no read can parse — the answer lost to an internal
            // error, permanently. A visible truncation is the lesser failure.
            //
            // The marker is subtracted from the budget, not appended to it: the
            // first version sliced to the cap and *then* added the note, which
            // put the result back over the bound and poisoned the row anyway —
            // exactly the failure this clamping exists to prevent.
            replyText: clampWaitAnswer(answer),
            ...(event.externalMessageId === undefined ? {} : { externalMessageId: event.externalMessageId }),
          };
          // Conditional-transition-once, exactly as the deadline sweep and the
          // peer-reply path use it: losing this race means the wait was already
          // settled, so admitting a resume here would be redundant, not merely
          // harmless — fall through to an ordinary reply turn instead.
          if (
            await persistencePort.repositories.agentWaits.settle({
              waitId: waiting.waitId,
              outcome,
              resume: true,
              by: actor.principalId,
              via: event.connectionId,
            })
          ) {
            void channelApprovals.onQuestionSettled({ waitId: waiting.waitId, outcome, via: event.connectionId });
            const resumed = await workflow.admit({
              context: {
                workspaceId: actor.workspaceId,
                principalId: actor.principalId,
                runId: answeredTaskId,
                caller: actor.caller,
                messagingReplyTo,
              },
              operationKey: waitResumeOperationKey(waiting.waitId),
              kind: "deadline",
              taskId: answeredTaskId,
              resume: { waitOutcome: outcome, waitId: waiting.waitId, via: event.connectionId, decidedBy: actor.principalId },
            });
            await persistencePort.repositories.agentWaits.markResumed(waiting.waitId);
            return resumed;
          }
        }
        if (answerOnly) return undefined;
        // A repeat of an answer the question already took — a second press of
        // "2", the same reply sent twice — is acknowledged, not admitted as a
        // new instruction. Only a message that picks the options does
        // this: anything else is a new turn, as it always was.
        if (waiting === undefined && answer !== undefined && answer !== "") {
          const recent = await persistencePort.repositories.agentWaits.getRecentlySettledByTask(
            taskId,
            new Date(Date.parse(clock.now()) - REPEAT_ANSWER_WINDOW_MS).toISOString(),
          );
          const repeat =
            recent?.choices === undefined ||
            recent.correlationId !== undefined ||
            recent.waitingOnWorkerTaskId !== undefined ||
            recent.settledOutcome?.kind !== "answered"
              ? undefined
              : matchChoiceAnswer(answer, recent.choices);
          if (repeat !== undefined && "answers" in repeat && repeat.answers.length > 0 && repeat.other === undefined) {
            const destination = plainReplyDestination(messaging, event);
            const previous = recent?.settledOutcome;
            const taken =
              previous?.answers !== undefined && previous.answers.length > 0
                ? previous.answers.join(", ")
                : (previous?.other ?? previous?.replyText ?? "");
            if (destination !== undefined) {
              await messaging.send({
                effectId: `repeat-answer:${event.connectionId}:${event.providerEventId}`,
                connectionId: event.connectionId,
                workspaceId: actor.workspaceId,
                destination,
                parts: [{ content: (await wordsFor(actor.workspaceId))("channel.conversation.alreadyAnswered", { answer: taken }) }],
              });
            }
            return undefined;
          }
        }
        const prompted = member ? turn : await withMcpPrompt(turn, owner.principalId);
        if (prompted === undefined) return undefined;
        // A message while the chat waits on its owner in the browser (a captcha, a sign-in) moves past it: the page goes
        // back to the agent, and this turn answers the waiting call as not run. Before, the chat's every later turn failed.
        if (!member) await browserHandoffs?.supersede(taskId, actor.principalId);
        return conversationWorkflow.admit({
          context: {
            workspaceId: actor.workspaceId,
            principalId: owner.principalId,
            runId: taskId,
            caller: actor.caller,
            messagingReplyTo,
            ...frontEnd,
            ...(member ? { memoryReach: "chat-only" as const } : groupReach),
          },
          operationKey: clock.newId("msg"),
          kind: "reply",
          taskId,
          // No persona and no stripping here: the workflow validates an
          // `agentDefinitionId` only for a *new* admission, so a later `@other`
          // cannot change the task's persona. Leaving the text alone is honest —
          // the model sees the operator's mention in the message it was sent.
          ...(prompted.prompt === undefined ? {} : { prompt: prompted.prompt }),
          ...(prompted.inbound.length === 0 ? {} : { inbound: prompted.inbound }),
        });
      };

      // `/new` (or `/reset`) ends this conversation's current task:
      // what it still waits on is withdrawn, the task stays readable, and the
      // next message starts the conversation's next epoch. Not on the local
      // connection: its front ends start over with a new chat (New side chat,
      // `/side`), and a `/new` typed in the canvas is ordinary text — ending
      // the chat's mapping there would cancel a Home past its refusal and
      // leave the chat with nothing to continue.
      // A plugin's slash command: answered here, by the plugin, without a turn.
      const pluginCommand = isLocalConnectionId(event.connectionId) ? undefined : parsePluginCommandLine(senderWords);
      if (pluginCommand !== undefined && turnHooks.commands().some((command) => command.name === pluginCommand.name)) {
        const name = pluginCommand.name;
        // The chat's task only for the person whose chat it is: another member of a shared chat runs it with no task of theirs.
        // A DM linked to Home talks to the Home, as its turns do.
        const chatTaskId = linkedHome ?? (await currentChat())?.taskId;
        const owned = chatTaskId === undefined ? undefined : await persistencePort.repositories.tasks.get(chatTaskId);
        const taskId =
          owned !== undefined && owned.principalId === actor.principalId && owned.workspaceId === actor.workspaceId
            ? owned.taskId
            : `command-${event.providerEventId}`;
        const envelope: ModEnvelope = Object.freeze({
          workspaceId: actor.workspaceId,
          principalId: actor.principalId,
          taskId,
          runId: taskId,
          source: "messaging",
          channel: event.connectionId,
          attended: true,
        });
        // Where it was typed, for the memory commands (invariant 11): never in a group or by email.
        const place: MemoryCommandPlace =
          groupReach.memoryReach === "chat-only"
            ? "group"
            : channelDescriptorOf(messaging.providerOf(event.connectionId))?.kind === "email"
              ? "email"
              : "direct";
        memoryCommandPlaces.set(envelope, place);
        const answer = await turnHooks.runCommand(name, { envelope, args: pluginCommand.args });
        const destination = plainReplyDestination(messaging, event);
        // A command withdrawn since it was listed is said to be gone, never met with silence.
        const text = maskPluginText(
          answer?.text ?? (await wordsFor(actor.workspaceId))("channel.conversation.noPlugin", { name }),
          MOD_COMMAND_TEXT_MAX_CHARS,
        );
        if (destination !== undefined && text.trim() !== "") {
          await messaging.send({
            effectId: `plugin-command:${event.connectionId}:${event.providerEventId}`,
            connectionId: event.connectionId,
            workspaceId: actor.workspaceId,
            destination,
            parts: [{ content: text }],
          });
        }
        return;
      }
      if (!isLocalConnectionId(event.connectionId) && MESSAGING_RESET_COMMAND.test(senderWords.trim())) {
        // A DM linked to Home ends nothing: Home never ends, and ending
        // the DM's own conversation from here would be invisible while linked.
        if (linkedHome !== undefined) {
          const destination = messaging.buildReplyDestination(event.connectionId, {
            externalConversationId: event.externalConversationId,
            externalSenderId: event.externalSenderId,
            ...(event.subject === undefined || event.subject.trim() === "" ? {} : { subject: event.subject }),
          });
          if (destination !== undefined) {
            await messaging.send({
              effectId: `conversation-reset:${event.connectionId}:${event.providerEventId}`,
              connectionId: event.connectionId,
              workspaceId: actor.workspaceId,
              destination,
              parts: [
                {
                  content: (await wordsFor(actor.workspaceId))("channel.conversation.homeLinked"),
                },
              ],
            });
          }
          return;
        }
        // In a forum topic with a side chat of its own, `/new` ends that side
        // chat; anywhere else, the conversation's Home.
        const current = await currentChat();
        const owner = current === undefined ? undefined : await persistencePort.repositories.tasks.get(current.taskId);
        // Only the person the chat's task runs for ends it: a shared chat's
        // other members cannot cancel what is theirs.
        const owned = owner === undefined || (owner.workspaceId === actor.workspaceId && owner.principalId === actor.principalId);
        // The epoch ends first: a withdrawal that then fails leaves the chat
        // on its next task, never on a half-cancelled one.
        const ended = !owned
          ? undefined
          : await conversations.reset(event.connectionId, current?.externalConversationId ?? event.externalConversationId, clock.now());
        let withdrew = false;
        if (ended !== undefined) {
          withdrew = await withdrawConversationTask(ended.taskId, actor, event.connectionId);
          await markWithdrawn(ended);
          // Said in the ended chat itself, where the canvas still offers to continue it: it no longer reaches the chat app.
          const channel =
            channelDescriptorOf(messaging.providerOf(event.connectionId))?.label ?? textRef("notice.conversationReset.chatApp");
          await persistencePort.repositories.transcripts
            .postNotice({
              noticeId: clock.newId("notice"),
              createdAt: clock.now(),
              taskId: ended.taskId,
              kind: "conversation",
              sourceKey: `conversation-reset:${ended.taskId}`,
              ...noticeWordsOf({
                title: textRef("notice.conversationReset.title"),
                summary: textRef(withdrew ? "notice.conversationReset.summaryCancelled" : "notice.conversationReset.summary", { channel }),
              }),
              once: true,
            })
            .catch((error: unknown) =>
              logger.warn("a conversation's reset could not be noted in its chat", { taskId: ended.taskId, error: errorMessage(error) }),
            );
        }
        const destination = plainReplyDestination(messaging, event);
        if (destination !== undefined) {
          const t = await wordsFor(actor.workspaceId);
          await messaging.send({
            effectId: `conversation-reset:${event.connectionId}:${event.providerEventId}`,
            connectionId: event.connectionId,
            workspaceId: actor.workspaceId,
            destination,
            parts: [
              {
                content: !owned
                  ? t("channel.conversation.resetNotYours")
                  : ended === undefined
                    ? t("channel.conversation.nothingToReset")
                    : // No task id: a chat app's reader cannot use one. The earlier chat stays in the Tavi app.
                      withdrew
                      ? t("channel.conversation.startedCancelled")
                      : t("channel.conversation.started"),
              },
            ],
          });
        }
        return;
      }

      // A typed reply to a question's own message answers that question, in
      // any chat it was sent to — a named chat a scheduled task asked in has no
      // conversation to find it through.
      // An email reply that lost its thread still names its question by the subject's token.
      const repliedDelivery =
        (event.externalReplyToId === undefined
          ? undefined
          : await persistencePort.repositories.needDeliveries.getByMessage(
              event.connectionId,
              event.externalConversationId,
              event.externalReplyToId,
            )) ?? (subjectQuestion?.connectionId === event.connectionId ? subjectQuestion : undefined);
      const repliedWait =
        repliedDelivery === undefined ? undefined : await persistencePort.repositories.agentWaits.get(repliedDelivery.waitId);
      const repliedTask = isQuestion(repliedWait) ? await persistencePort.repositories.tasks.get(repliedWait.taskId) : undefined;
      if (linkedHome !== undefined) {
        // A turn of Home, never a mapping of this DM: Home is no conversation
        // Home, `/new` here ends nothing, and turning the link off
        // returns the DM to its own conversation. The reply target rides on
        // this admission's context only, so Home's next canvas turn answers
        // in the canvas. A Home mid-turn takes it as a busy conversation task does.
        const ownsReplied =
          repliedTask !== undefined && repliedTask.workspaceId === actor.workspaceId && repliedTask.principalId === actor.principalId;
        // While Home waits on a round — one raised in the canvas included — a
        // DM message is refused, as a message to Home from the canvas is:
        // admitted, it would set that round aside unseen.
        const waitingRound = ownsReplied ? undefined : await pendingRoundRefusal(persistencePort.repositories.tasks, linkedHome, "Home");
        if (waitingRound !== undefined) {
          const destination = messaging.buildReplyDestination(event.connectionId, {
            externalConversationId: event.externalConversationId,
            externalSenderId: event.externalSenderId,
          });
          if (destination !== undefined) {
            await messaging.send({
              effectId: `home-round-pending:${event.connectionId}:${event.providerEventId}`,
              connectionId: event.connectionId,
              workspaceId: actor.workspaceId,
              destination,
              parts: [{ content: waitingRound.error.message }],
            });
          }
          return;
        }
        await admitReply(linkedHome, ownsReplied ? repliedWait : undefined);
        return;
      }
      // The conversation's Home: its current epoch's task.
      const home = await conversations.get(event.connectionId, event.externalConversationId);
      const topic = topicKey === undefined ? undefined : await conversations.get(event.connectionId, topicKey);
      const existing = topic ?? home;
      if (repliedTask !== undefined && repliedTask.workspaceId === actor.workspaceId && repliedTask.principalId === actor.principalId) {
        // With no task of this chat's own, a reply that is not taken as the
        // answer (no text, or answered meanwhile) is dropped, never run as a
        // new instruction on the question's task.
        await admitReply(existing?.taskId ?? repliedTask.taskId, repliedWait, existing === undefined);
        return;
      }
      if (topic !== undefined) {
        // A topic's side chat goes on while the Home it was opened from is the
        // group's current one. Once `/new` ended that Home, the side chat ends
        // with it, whoever writes next — it was its parent's, and its parent is
        // over: what it waited on withdrawn under its own person, its grants
        // lapsed — and this message opens the topic's next side chat
        // (or, with no Home, starts the Home).
        const side = await persistencePort.repositories.tasks.get(topic.taskId);
        // A thread's own chat, started by the message the host opened it for (a room's `autoThread`),
        // is nobody's side chat: it goes on whatever the room's Home is, until `/new` in it.
        if (side !== undefined && side.parentChatId === undefined) {
          await admitReply(topic.taskId);
          return;
        }
        if (home !== undefined && side?.parentChatId === home.taskId) {
          await admitReply(topic.taskId);
          return;
        }
        const ended = await conversations.reset(event.connectionId, topic.externalConversationId, clock.now());
        if (ended !== undefined) {
          const sideActor: MemoryActor =
            side === undefined ? actor : { ...actor, workspaceId: side.workspaceId, principalId: side.principalId };
          await withdrawConversationTask(ended.taskId, sideActor, event.connectionId);
          await markWithdrawn(ended);
        }
      }
      if (home !== undefined) {
        const homeTask = topicKey === undefined ? undefined : await persistencePort.repositories.tasks.get(home.taskId);
        // A forum topic opens a side chat of the group's Home — only for the
        // person the Home runs for: a side chat is its parent's person's. Any
        // other member's message in a new topic is a turn of the Home, as every
        // message of the group was before topics were side chats.
        if (
          topicKey !== undefined &&
          homeTask !== undefined &&
          homeTask.workspaceId === actor.workspaceId &&
          homeTask.principalId === actor.principalId
        ) {
          await startConversationTask(topicKey, home.taskId);
          return;
        }
        await admitReply(home.taskId);
        return;
      }
      // A message the host opened a thread for (a room's `autoThread`), with no Home to be a side chat of: the
      // chat it starts is the thread's own, so its next message there goes on with it.
      await startConversationTask(event.threadOpened === true && topicKey !== undefined ? topicKey : event.externalConversationId);

      /**
       * Start the next task of conversation `key`: its Home, or — with
       * `parentChatId` — a forum topic's side chat of that Home.
       */
      async function startConversationTask(key: string, parentChatId?: string): Promise<void> {
        // Deterministic, not `clock.newId(...)`: this key's ONLY job is
        // recovering from a crash between `workflow.admit` resolving and
        // `messagingConversations.record` committing below — NOT
        // absorbing an arbitrary later message with different content.
        // `admit`'s own operationKey-idempotency
        // (`SqliteTaskRepository`'s `assertSameAdmission`) only resolves
        // silently when the retried content is byte-identical to the
        // original; a genuinely later message throws `CONFLICT` instead.
        // The key alone would leave a conversation permanently wedged on the
        // very first transient `record()` failure, since `ingest()` never
        // re-calls `admit` for an already-recorded `providerEventId`, so
        // the one message that WOULD replay identically can never be
        // redelivered to retry it. The `catch` below is what actually
        // recovers: on `CONFLICT`, the deterministic key already named a
        // real task (`tasks.getByOperationKey`), so this later message is
        // admitted as a `reply` against THAT task instead of being lost.
        // Resolved here, not at the top of the handler: a later message in an
        // existing conversation cannot change the persona (the workflow validates
        // the reference only for a new admission), so resolving there would query
        // the registry for a result every reply throws away.
        // The person starts their own chat: their words are the prompt, what they forward or quote is data.
        const expandedTurn = await withMcpPrompt(
          inboundTurnOf(event, { sendersTask: true, email: isEmailConnection(event.connectionId), at: clock.now() }),
          actor.principalId,
        );
        const turn = expandedTurn === undefined ? undefined : await withRoomContext(expandedTurn);
        if (turn === undefined) return;
        const mention = turn.prompt === undefined ? undefined : await resolveMention(turn.prompt);
        const agentDefinitionId = mention?.agentId;
        // Epoch 0 keeps the key every conversation had before epochs.
        const epoch = await conversations.nextEpoch(event.connectionId, key);
        const operationKey = `msg-start-${event.connectionId}-${key}${epoch === 0 ? "" : `-e${epoch}`}`;
        let taskId: string;
        try {
          const admission = await conversationWorkflow.admit({
            // `runId: "pending-admission"` is this codebase's own
            // placeholder for "not yet admitted" (matches `spawn()`'s
            // identical literal).
            context: {
              workspaceId: actor.workspaceId,
              principalId: actor.principalId,
              runId: "pending-admission",
              caller: actor.caller,
              messagingReplyTo,
              ...groupReach,
              // On the *context*, not as a sibling: the workflow reads
              // `input.context.agentDefinitionId` to resolve the persona, and it
              // validates the reference only for a new task (`taskId === undefined`)
              // — so a top-level field would have been silently ignored and the
              // chat would have looked routed while running the default prompt.
              ...(agentDefinitionId === undefined ? {} : { agentDefinitionId }),
            },
            operationKey,
            kind: "start",
            // An inbound conversation is a person talking: the task may ask a
            // follow-up question in that same conversation.
            executionPolicy: ATTENDED_TASK_POLICY,
            // Recorded on the task so the approval path can tell an operator's
            // conversation from a schedule fire's.
            origin: "messaging",
            // A forum topic's chat is a side chat of the group's Home.
            ...(parentChatId === undefined ? {} : { chatKind: "side" as const, parentChatId }),
            ...(mention === undefined ? (turn.prompt === undefined ? {} : { prompt: turn.prompt }) : { prompt: mention.content }),
            ...(turn.inbound.length === 0 ? {} : { inbound: turn.inbound }),
            // Once the task exists and before its first turn runs: the turn reads them as this chat's.
            onAdmitted: async (admitted) => await claimAttachments(admitted.taskId),
          });
          taskId = admission.taskId;
        } catch (error) {
          if (!(error instanceof TaviError) || error.code !== "CONFLICT") throw error;
          const recovered = await persistencePort.repositories.tasks.getByOperationKey(actor.workspaceId, actor.principalId, operationKey);
          // Believed unreachable given `SqliteTaskRepository.admit`'s own
          // invariant (`assertSameAdmission` only throws CONFLICT on this key
          // once `#findTaskByOperationKey` has already found a task for it) —
          // kept as a defensive fallback rather than an assertion, so a future
          // repository implementation that doesn't share that invariant still
          // surfaces the original error instead of a confusing `undefined`
          // dereference.
          if (recovered === undefined) throw error; // nothing to recover from — surface the original error
          taskId = recovered.taskId;
          // The recovered task's "start" turn only ever ran the FIRST
          // message's content (that's what the deterministic key's own
          // admission carries) — this message's content still needs its
          // own turn, so it goes in as a reply now.
          await admitReply(taskId);
        }
        // Idempotent by (connectionId, externalConversationId, taskId)
        // — safe to call again here even if an EARLIER
        // message already recorded this same mapping after recovering
        // from the identical crash window.
        await persistencePort.repositories.messagingConversations.record({
          connectionId: event.connectionId,
          externalConversationId: key,
          taskId,
          createdAt: clock.now(),
          ...providerAndKind(event),
          // Kept so a round raised by a task delegated from here can be
          // announced in this conversation.
          replyTo: {
            connectionId: messagingReplyTo.connectionId,
            externalConversationId: messagingReplyTo.externalConversationId,
            externalSenderId: messagingReplyTo.externalSenderId,
            ...(messagingReplyTo.externalMessageId === undefined ? {} : { externalMessageId: messagingReplyTo.externalMessageId }),
            // A Home's mapping never names a topic, even one its first message came from: what is
            // announced to the Home goes to the group, not that topic. The turn's own
            // context keeps the topic, so its first reply lands where the message was sent. A chat
            // mapped under the topic itself (a side chat, or a thread's own) keeps it.
            ...(messagingReplyTo.externalThreadId === undefined || (topicKey !== undefined && key !== topicKey)
              ? {}
              : { externalThreadId: messagingReplyTo.externalThreadId }),
          },
        });
      }
    };
  }
  return {};
}

export type ConversationsContext = SchedulesContext & ReturnType<typeof composeConversations>;

/** Where Tavi's own words answer an inbound message: its chat, sender, subject and thread, never quoting it. */
function plainReplyDestination(
  messaging: Pick<MessagingServicePort, "buildReplyDestination">,
  event: Pick<InboundEvent, "connectionId" | "externalConversationId" | "externalSenderId" | "subject" | "externalThreadId">,
) {
  return messaging.buildReplyDestination(event.connectionId, {
    externalConversationId: event.externalConversationId,
    externalSenderId: event.externalSenderId,
    ...(event.subject === undefined || event.subject.trim() === "" ? {} : { subject: event.subject }),
    ...(event.externalThreadId === undefined ? {} : { externalThreadId: event.externalThreadId }),
  });
}
