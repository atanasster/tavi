import type * as Public from "@tavi/contracts";

export type AdmitRequest = Omit<Public.AdmitRequest, "newTaskId" | "newAdmissionId" | "newThreadId" | "now" | "prompt"> & {
  readonly newTaskId: () => string;
  readonly newAdmissionId: () => string;
  readonly newThreadId: () => string;
  readonly now: () => string;
  readonly initializeSnapshot?: (task: Public.TaskRecord) => Public.BoundTaskPromptSnapshot;
};

type WorkerData<T> = T extends Public.DatabaseTime
  ? () => string
  : T extends ArrayBufferView | ArrayBuffer | Date
    ? T
    : T extends object
      ? { [K in keyof T]: WorkerData<T[K]> }
      : T;
type WorkerRepository<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: WorkerData<A>) => Awaited<R> : T[K] };
export type TaskRepositoryPort = Omit<WorkerRepository<Public.TaskRepositoryPort>, "admit" | "openHome"> & {
  admit(request: AdmitRequest): Public.AdmitResult;
  openHome(request: AdmitRequest): string;
};
export type ExecutionRepositoryPort = WorkerRepository<Public.ExecutionRepositoryPort>;
export type EffectRepositoryPort = WorkerRepository<Public.EffectRepositoryPort>;
export type ApprovalRepositoryPort = WorkerRepository<Public.ApprovalRepositoryPort>;
export type CancellationRepositoryPort = WorkerRepository<Public.CancellationRepositoryPort>;
export type CheckpointReceiptRepositoryPort = WorkerRepository<Public.CheckpointReceiptRepositoryPort>;
export type ModelConfigRepositoryPort = WorkerRepository<Public.ModelConfigRepositoryPort>;
export type MemoryRepositoryPort = WorkerRepository<Public.MemoryRepositoryPort>;
export type SkillRepositoryPort = WorkerRepository<Public.SkillRepositoryPort>;
export type SkillRolloutRepositoryPort = WorkerRepository<Public.SkillRolloutRepositoryPort>;
export type AgentMailboxRepositoryPort = WorkerRepository<Public.AgentMailboxRepositoryPort>;
export type AgentWaitRepositoryPort = WorkerRepository<Public.AgentWaitRepositoryPort>;
export type AgentDelegationRepositoryPort = WorkerRepository<Public.AgentDelegationRepositoryPort>;
export type MessagingInboxRepositoryPort = WorkerRepository<Public.MessagingInboxRepositoryPort>;
export type MessagingOutboxRepositoryPort = WorkerRepository<Public.MessagingOutboxRepositoryPort>;
export type MessagingIdentityBindingRepositoryPort = WorkerRepository<Public.MessagingIdentityBindingRepositoryPort>;
export type MessagingConnectionRepositoryPort = WorkerRepository<Public.MessagingConnectionRepositoryPort>;
export type ChannelIngressRepositoryPort = WorkerRepository<Public.ChannelIngressRepositoryPort>;
export type MessagingConversationRepositoryPort = WorkerRepository<Public.MessagingConversationRepositoryPort>;
export type ScheduleRepositoryPort = WorkerRepository<Public.ScheduleRepositoryPort>;
export type AgentDefinitionRepositoryPort = WorkerRepository<Public.AgentDefinitionRepositoryPort>;
export type ProjectRepositoryPort = WorkerRepository<Public.ProjectRepositoryPort>;
export type ReportRepositoryPort = WorkerRepository<Public.ReportRepositoryPort>;
export type SearchProviderRepositoryPort = WorkerRepository<Public.SearchProviderRepositoryPort>;
export type PluginRepositoryPort = WorkerRepository<Public.PluginRepositoryPort>;
export type SystemPromptRepositoryPort = WorkerRepository<Public.SystemPromptRepositoryPort>;
export type WorkspaceSettingsRepositoryPort = WorkerRepository<Public.WorkspaceSettingsRepositoryPort>;
export type CenterRepositoryPort = WorkerRepository<Public.CenterRepositoryPort>;
export type ReminderRepositoryPort = WorkerRepository<Public.ReminderRepositoryPort>;
export type TaskSummaryRepositoryPort = WorkerRepository<Public.TaskSummaryRepositoryPort>;
export type ChatInstructionsRepositoryPort = WorkerRepository<Public.ChatInstructionsRepositoryPort>;
export type TaskFoldersRepositoryPort = WorkerRepository<Public.TaskFoldersRepositoryPort>;
export type HeartbeatRepositoryPort = WorkerRepository<Public.HeartbeatRepositoryPort>;
export type IdeaRepositoryPort = WorkerRepository<Public.IdeaRepositoryPort>;
export type OnboardingRepositoryPort = WorkerRepository<Public.OnboardingRepositoryPort>;
export type TaskMemoryUseRepositoryPort = WorkerRepository<Public.TaskMemoryUseRepositoryPort>;
export type BrowserHistoryRepositoryPort = WorkerRepository<Public.BrowserHistoryRepositoryPort>;
export type TaskFindingRepositoryPort = WorkerRepository<Public.TaskFindingRepositoryPort>;
export type SiteRecipeRepositoryPort = WorkerRepository<Public.SiteRecipeRepositoryPort>;
export type SiteUsageRepositoryPort = WorkerRepository<Public.SiteUsageRepositoryPort>;
export type ApprovalInboxRepositoryPort = WorkerRepository<Public.ApprovalInboxRepositoryPort>;
export type ToolPolicyRepositoryPort = WorkerRepository<Public.ToolPolicyRepositoryPort>;
export type ApprovalRoundRepositoryPort = WorkerRepository<Public.ApprovalRoundRepositoryPort>;
export type ApprovalLinkRepositoryPort = WorkerRepository<Public.ApprovalLinkRepositoryPort>;
export type NeedDeliveryRepositoryPort = WorkerRepository<Public.NeedDeliveryRepositoryPort>;
export type ChannelRoomRepositoryPort = WorkerRepository<Public.ChannelRoomRepositoryPort>;
export type ChannelPurgeRepositoryPort = WorkerRepository<Public.ChannelPurgeRepositoryPort>;
export type MessagingGrantRepositoryPort = WorkerRepository<Public.MessagingGrantRepositoryPort>;
export type ApprovalRoundDeliveryRepositoryPort = WorkerRepository<Public.ApprovalRoundDeliveryRepositoryPort>;
export type TranscriptRepositoryPort = WorkerRepository<Public.TranscriptRepositoryPort>;
export interface PersistencePort {
  readonly databasePath: string;
  transaction<T>(body: () => T): T;
  /** The public repository map (`PersistenceRepositories`), each port as the worker serves it. */
  readonly repositories: {
    readonly [K in keyof Public.PersistenceRepositories]: K extends "tasks"
      ? TaskRepositoryPort
      : WorkerRepository<Public.PersistenceRepositories[K]>;
  };
}

export type MemoryServicePort = WorkerRepository<Public.MemoryServicePort>;

export type SkillServicePort = WorkerRepository<Public.SkillServicePort>;

export type ModelConfigPort = WorkerRepository<Public.ModelConfigPort>;

export type RouterRepositoryPort = WorkerRepository<Public.RouterRepositoryPort>;

export type RoutineServicePort = WorkerRepository<Public.RoutineServicePort>;
