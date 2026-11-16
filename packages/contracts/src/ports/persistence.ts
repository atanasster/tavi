import type { AgentDefinitionRepositoryPort } from "../agents.js";
import type { ApprovalInboxRepositoryPort } from "../approval-inbox.js";
import type { ApprovalLinkRepositoryPort, ApprovalRoundRepositoryPort } from "../approval-rounds.js";
import type { BrowserHistoryRepositoryPort } from "../browser-history.js";
import type { CenterRepositoryPort } from "../center.js";
import type { ApprovalRoundDeliveryRepositoryPort, ChannelPurgeRepositoryPort, ChannelRoomRepositoryPort } from "../channel-rooms.js";
import type { TaskFoldersRepositoryPort } from "../chat-folders.js";
import type { ChatInstructionsRepositoryPort } from "../chat-instructions.js";
import type { TaskFindingRepositoryPort } from "../findings.js";
import type { HeartbeatRepositoryPort } from "../heartbeat.js";
import type { IdeaRepositoryPort } from "../ideas.js";
import type { McpRepositoryPort } from "../mcp-store.js";
import type { TaskMemoryUseRepositoryPort } from "../memory-use.js";
import type { MessagingGrantRepositoryPort } from "../messaging-grants.js";
import type {
  ChannelIngressRepositoryPort,
  MessagingConnectionRepositoryPort,
  MessagingConversationRepositoryPort,
  MessagingIdentityBindingRepositoryPort,
  MessagingInboxRepositoryPort,
  MessagingOutboxRepositoryPort,
} from "../messaging.js";
import type { NeedDeliveryRepositoryPort } from "../need-deliveries.js";
import type { OnboardingRepositoryPort } from "../onboarding.js";
import type { PluginRepositoryPort } from "../plugin-registry.js";
import type { ProjectRepositoryPort } from "../projects.js";
import type { ReminderRepositoryPort } from "../reminders.js";
import type { ReportRepositoryPort } from "../reports.js";
import type { ScheduleRepositoryPort } from "../schedules.js";
import type { SiteUsageRepositoryPort } from "../site-profiles.js";
import type { SiteRecipeRepositoryPort } from "../site-recipes.js";
import type { SystemPromptRepositoryPort } from "../system-prompts.js";
import type { TaskSummaryRepositoryPort } from "../task-summaries.js";
import type { ToolPolicyRepositoryPort } from "../tool-policy.js";
import type { TranscriptRepositoryPort } from "../transcript.js";
import type { SearchProviderRepositoryPort } from "../web-search.js";
import type { WorkspaceSettingsRepositoryPort } from "../workspace-settings.js";
import type { AgentDelegationRepositoryPort, AgentMailboxRepositoryPort, AgentWaitRepositoryPort } from "./agent-delegation.js";
import type { ApprovalRepositoryPort, CancellationRepositoryPort } from "./approvals.js";
import type { ArtifactRepositoryPort } from "./artifacts.js";
import type { EffectRepositoryPort } from "./effects.js";
import type { CheckpointReceiptRepositoryPort, ExecutionRepositoryPort } from "./execution.js";
import type { MemoryRepositoryPort } from "./memory-repository.js";
import type { ModelConfigRepositoryPort } from "./model.js";
import type { SkillRepositoryPort, SkillRolloutRepositoryPort } from "./skills.js";
import type { TaskRepositoryPort } from "./tasks.js";

export type PersistenceRepositories = {
  readonly tasks: TaskRepositoryPort;
  readonly executions: ExecutionRepositoryPort;
  readonly effects: EffectRepositoryPort;
  readonly approvals: ApprovalRepositoryPort;
  readonly cancellations: CancellationRepositoryPort;
  readonly receipts: CheckpointReceiptRepositoryPort;
  readonly modelConfig: ModelConfigRepositoryPort;
  readonly memory: MemoryRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly skills: SkillRepositoryPort;
  readonly skillRollout: SkillRolloutRepositoryPort;
  readonly agentMailbox: AgentMailboxRepositoryPort;
  readonly agentWaits: AgentWaitRepositoryPort;
  readonly agentDelegations: AgentDelegationRepositoryPort;
  readonly messagingInbox: MessagingInboxRepositoryPort;
  readonly messagingOutbox: MessagingOutboxRepositoryPort;
  readonly messagingIdentityBindings: MessagingIdentityBindingRepositoryPort;
  readonly messagingConversations: MessagingConversationRepositoryPort;
  /** Configured messaging connections. */
  readonly messagingConnections: MessagingConnectionRepositoryPort;
  /** Where the channels' webhook ingress listens. */
  readonly channelIngress: ChannelIngressRepositoryPort;
  /** The rooms an operator listed on each connection. */
  readonly channelRooms: ChannelRoomRepositoryPort;
  /** Removed connections whose channel purges what they brought in. */
  readonly channelPurges: ChannelPurgeRepositoryPort;
  /** An operator's room and contact grants of tools on each connection. */
  readonly messagingGrants: MessagingGrantRepositoryPort;
  readonly schedules: ScheduleRepositoryPort;
  readonly agents: AgentDefinitionRepositoryPort;
  readonly projects: ProjectRepositoryPort;
  readonly reports: ReportRepositoryPort;
  /** Configured web search providers. */
  readonly searchProviders: SearchProviderRepositoryPort;
  /** Installed plugin versions and per-plugin operator settings. */
  readonly plugins: PluginRepositoryPort;
  /** The editable workspace system prompt and its per-task snapshots. */
  readonly systemPrompts: SystemPromptRepositoryPort;
  /** Per-workspace settings such as the timezone. */
  readonly workspaceSettings: WorkspaceSettingsRepositoryPort;
  /** The Command Center's workspace aggregates and change fingerprints. */
  readonly center: CenterRepositoryPort;
  /** Reminders and their fires. */
  readonly reminders: ReminderRepositoryPort;
  /** Generated task titles and summaries, and their queue. */
  readonly taskSummaries: TaskSummaryRepositoryPort;
  /** Each chat's own instructions, by revision. */
  readonly chatInstructions: ChatInstructionsRepositoryPort;
  /** Each chat's working folder, when it is not its origin's default. */
  readonly taskFolders: TaskFoldersRepositoryPort;
  /** The memories each chat's turns were given. */
  readonly memoryUse: TaskMemoryUseRepositoryPort;
  /** Browser sessions and visits, per task. */
  readonly browserHistory: BrowserHistoryRepositoryPort;
  /** Each task's findings: the records it gathered. */
  readonly findings: TaskFindingRepositoryPort;
  /** The browser steps that last led to results on each site. */
  readonly siteRecipes: SiteRecipeRepositoryPort;
  /** Each site profile's pages and final steps per day. */
  readonly siteUsage: SiteUsageRepositoryPort;
  /** The approvals inbox across tasks, and the history of decisions. */
  readonly approvalInbox: ApprovalInboxRepositoryPort;
  /** Operator tool rules and per-task session grants. */
  readonly toolPolicy: ToolPolicyRepositoryPort;
  /** Approval rounds as the channels see them, and their audit trail. */
  readonly approvalRounds: ApprovalRoundRepositoryPort;
  /** Single-use email links that decide a round or answer a question. */
  readonly approvalLinks: ApprovalLinkRepositoryPort;
  /** Where each question went and ❌ presses awaiting a reason, durably. */
  readonly needDeliveries: NeedDeliveryRepositoryPort;
  /** Where each approval round was delivered: its card and a room's notice, each edited on settlement. */
  readonly approvalRoundDeliveries: ApprovalRoundDeliveryRepositoryPort;
  /** A chat's saved history, one entry per admission. */
  readonly transcripts: TranscriptRepositoryPort;
  /** Heartbeats: config, scheduling state, the record and instructions history. */
  readonly heartbeats: HeartbeatRepositoryPort;
  /** Ideas, their runs, feedback and settings. */
  readonly ideas: IdeaRepositoryPort;
  /** Onboarding's install row, step marks and verifications. */
  readonly onboarding: OnboardingRepositoryPort;
  /** MCP server versions, tools, tree indexes and notices. */
  readonly mcp: McpRepositoryPort;
};
export type PersistencePort = import("../async-persistence.js").AsyncPersistencePort;
