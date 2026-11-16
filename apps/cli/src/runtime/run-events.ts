import { createRunEventBus, createLiveHub } from "@tavi/runtime";
import { readAgentTree } from "../features/agents/tree.js";
import type { ToolRule, GrantScopeKind, MessagingGrantRecord, ChannelDescriptor, InvocationContext } from "@tavi/contracts";
import { createAbortRegistry, createAdmissionTracker } from "../features/run/run-events.js";
import { channelDescriptorOf } from "../features/channels/catalog.js";
import { createInFlightFires } from "@tavi/agent-host/schedule-scheduler";
import { ideaChatEnded } from "../features/ideas/owner.js";
import { errorMessage } from "@tavi/contracts/util";
import { withBuiltinAgents } from "../features/agents/builtin.js";
import { inOperatorDirectChat } from "./chat-scope.js";
import { messagingGrantRules, messagingProfileRules } from "./messaging-rules.js";
import type { ResearchToolsContext } from "./research-tools.js";

/** The run event bus and live hub, aborts and admissions, and the messaging tool profile. */
export function composeRunEvents(composed: ResearchToolsContext) {
  const { access, browser, clock, late, liveSource, logger, messaging, options, ownerSession, persistencePort, sitePolicy } = composed;

  /**
   * The daemon's event fan-out.
   *
   * Created here rather than at the end because the scheduler, the wait sweep,
   * agent communication and messaging are each handed the workflow port *before*
   * the runtime is assembled — wrapping only at the return left all of them
   * emitting nothing.
   */
  const runEventBus = createRunEventBus({
    epoch: ownerSession,
    onDiagnostic: (message, fields) => logger.warn(message, fields),
  });
  late.runEventBus = runEventBus;
  // A watch covers a chat's task tree, and a task that ends stops its streams.
  const liveHub = createLiveHub({
    source: liveSource,
    taskTree: async (workspaceId, taskId) =>
      (await readAgentTree(persistencePort.repositories, workspaceId, taskId)).nodes.map((node) => node.taskId),
    ancestors: async (workspaceId, taskId) => (await readAgentTree(persistencePort.repositories, workspaceId, taskId, 1)).ancestors,
    newSubscriptionId: () => clock.newId("live"),
    // A sub-agent's session is labelled with its agent: the definition's name, else the worker's id.
    agentLabel: async (workspaceId, taskId) => {
      const delegation = await persistencePort.repositories.agentDelegations.getByWorkerTaskId(taskId);
      if (delegation === undefined || delegation.workspaceId !== workspaceId) return undefined;
      const definition =
        delegation.agentDefinitionId === undefined
          ? undefined
          : await withBuiltinAgents(persistencePort.repositories.agents).get(workspaceId, delegation.agentDefinitionId);
      return definition?.name ?? delegation.workerAgentId;
    },
    onError: (error) => logger.warn("live browser view failed", { error: errorMessage(error) }),
  });
  // A chat an idea started whose turn finished without failure: the idea is done.
  runEventBus.onCompleted((taskId) => {
    void ideaChatEnded(persistencePort.repositories, taskId, `ifb-${clock.newId("feedback")}`, new Date(clock.now()).toISOString()).catch(
      (error: unknown) => logger.warn("an idea could not be marked done", { taskId, error: errorMessage(error) }),
    );
  });
  // A finished turn's browser sessions stay open, inactive, for the chat's next turn.
  runEventBus.onCompleted((taskId) => {
    sitePolicy.taskEnded(taskId);
    void browser
      .taskEnded?.(taskId)
      .catch((error: unknown) => logger.warn("browser sessions could not be marked inactive", { error: errorMessage(error) }));
  });
  const abortRegistry = createAbortRegistry();
  const admissions = createAdmissionTracker();
  const scheduleFires = createInFlightFires();

  // The messaging profile: a task a chat started does not run a shell,
  // write files or spend a credential. `--messaging-allow-tool` lifts it only
  // in the operator's own one-to-one chats.
  const messagingProfile = messagingProfileRules([]);
  const liftedMessagingProfile = messagingProfileRules(options.messagingAllowTools ?? []);
  if ((options.messagingAllowTools ?? []).length > 0) {
    logger.info(
      "--messaging-allow-tool applies only in the operator's own one-to-one chats: never in a group, a thread, an email thread or another person's chat",
      { tools: options.messagingAllowTools },
    );
  }
  const channelKindOf = (connectionId: string): ChannelDescriptor["kind"] | undefined =>
    channelDescriptorOf(messaging.providerOf(connectionId))?.kind;
  const profileFor = async (invocation: InvocationContext | undefined): Promise<readonly ToolRule[]> => {
    if (invocation === undefined || liftedMessagingProfile.length === messagingProfile.length) return messagingProfile;
    const own = await inOperatorDirectChat(
      {
        bindingOf: (connectionId, senderId) => persistencePort.repositories.messagingIdentityBindings.get(connectionId, senderId),
        operatorOf: (workspaceId) => access.resolveWorkspace(workspaceId)?.principalId,
        channelKindOf,
      },
      invocation,
    );
    return own ? liftedMessagingProfile : messagingProfile;
  };
  // The operator's room and contact grants, read for every turn, so a revoked one stops at the next.
  const grantsOf = (connectionId: string, scopeKind: GrantScopeKind, scopeId: string): Promise<readonly MessagingGrantRecord[]> =>
    persistencePort.repositories.messagingGrants.listForScope(connectionId, scopeKind, scopeId);
  const messagingProfileFor = async (invocation: InvocationContext | undefined): Promise<readonly ToolRule[]> => {
    const profile = await profileFor(invocation);
    if (invocation === undefined) return profile;
    if (invocation.messagingReplyTo !== undefined || invocation.chatTaskId === undefined)
      return messagingGrantRules(profile, invocation, grantsOf, clock.now(), { channelKindOf });
    // A worker a chat's turn delegated to is held to that chat's denies, and never lifted by its allows.
    const root = await late.channelApprovals.replyTargetOf(invocation.chatTaskId);
    return root === undefined
      ? profile
      : messagingGrantRules(profile, { workspaceId: invocation.workspaceId, messagingReplyTo: root }, grantsOf, clock.now(), {
          channelKindOf,
          delegated: true,
        });
  };
  return { abortRegistry, admissions, liveHub, messagingProfileFor, runEventBus, scheduleFires };
}

export type RunEventsContext = ResearchToolsContext & ReturnType<typeof composeRunEvents>;
