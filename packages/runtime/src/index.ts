/**
 * @tavi/runtime — PluginHost, persistence, access policy and shared services.
 *
 * Import policy: `runtime` may import `contracts` and nothing else
 * from the workspace. Concrete plugins and connectors import runtime, never the
 * other way around; plugin-to-plugin collaboration goes through injected ports.
 */

export {
  asSecretReader,
  createChainedSecretStore,
  createEnvironmentSecretStore,
  createCredentialKey,
  createEncryptedFileSecretStore,
  createKeychainCredentialKey,
  credentialKeyReference,
  deleteKeychainCredentialKey,
  createFileSecretStore,
  createSessionSecretStore,
  CREDENTIAL_KEY_BYTES,
  decryptSecret,
  describeSecretStore,
  ENCRYPTED_SECRET_FAMILY,
  ENCRYPTED_SECRET_PREFIX,
  encryptSecret,
  credentialKeySystemdName,
  exportCredentialKey,
  moveCredentialKeyToFile,
  moveCredentialKeyToSystemd,
  SYSTEMD_CREDENTIAL_KEY_NAME,
  moveCredentialKeyToKeychain,
  readCredentialKey,
  readPrivateFile,
  type CredentialKeyMove,
  type CredentialKeySystemdMove,
  type CredentialKeyOptions,
  type CredentialKeyReference,
  type EncryptedFileSecretStoreOptions,
  type EnvironmentSecretStoreOptions,
  type FileSecretStoreOptions,
} from "./access/secrets.js";
export {
  CREDENTIAL_KEYCHAIN_SERVICE,
  credentialKeychainOfKind,
  systemCredentialKeychain,
  wincredKeychain,
  type CredentialKeychain,
  type CredentialKeychainKind,
  type KeyringEntry,
} from "./access/keychain.js";
export {
  AccessPolicy,
  createSecretReader,
  createSecretReaderFromEnv,
  readSecretFile,
  type SecretBinding,
  type SecretReaderOptions,
  type WorkspaceGrant,
} from "./access/policy.js";
export { createClock, createLogger, createNullLogger, type LoggerOptions, type LogLevel } from "./clock.js";
export {
  classifierSaysInjection,
  createInjectionDetector,
  INJECTION_CLASSIFIER_INSTRUCTIONS,
  INJECTION_CLASSIFIER_MAX_CHARS,
  INJECTION_SCAN_MAX_CHARS,
  injectionPatternSignals,
  type InjectionClassifier,
  type InjectionDetector,
  type InjectionHit,
  type InjectionScanItem,
} from "./injection-detector.js";
export {
  ChatFolders,
  credentialFiles,
  credentialHomes,
  windowsProtectedPlaces,
  persistenceLocations,
  type ChatFolderScope,
  type ChatFolderTask,
  type ChatFolderTurn,
  type ChatFoldersOptions,
} from "./chat-folders.js";
export {
  FolderSpace,
  applyFolderPrune,
  emptyFolderTrash,
  emptyScratch,
  isBookkeepingArtifact,
  measureFolder,
  planFolderPrune,
  type FolderMeasure,
  type FolderPruneDependencies,
  type FolderPruneEntry,
  type FolderPruneOptions,
  type FolderPrunePlan,
  type FolderPruneResult,
  type FolderPruneTask,
  type FolderSpaceOptions,
  type FolderTrashEmptied,
  type FolderTrashEntry,
  type FolderUsage,
} from "./folder-retention.js";
export {
  createArtifactMaterializer,
  type ArtifactMaterializerOptions,
  type MaterializeArtifact,
  type MaterializeOutcome,
} from "./artifact-folders.js";
export {
  APPLICATION_TABLES,
  ROUTINE_TABLES,
  FTS_SHADOW_TABLES,
  MIGRATIONS,
  SAVER_EXPECTED_COLUMNS,
  SAVER_SCHEMA_VERSION,
  SAVER_SCHEMA_VERSION_KEY,
  SAVER_TABLES,
  type Migration,
  type MigrationResult,
} from "./persistence/migrations.js";
export { DatabaseClient, type OpenDatabaseOptions, type WorkerOperationCounts } from "./persistence/client.js";
export { OWNER_TEMPORARY_STAGING, ownerStagingDirectory } from "./persistence/temporary-files.js";
export { AsyncDataDirectoryOwner } from "./persistence/ownership-client.js";
export {
  assertOwnership,
  clearDiscovery,
  clearStopping,
  markStopping,
  clearToken,
  ipcPaths,
  mintToken,
  publishDiscovery,
  readDiscovery,
  readToken,
  tokenMatches,
  type OwnershipProof,
  type IpcCredentialPaths,
} from "./ipc/credentials.js";
export type { IpcConnection } from "./ipc/transport.js";
export {
  RUN_EVENT_RING_BYTES,
  RUN_EVENT_TOTAL_BYTES,
  createRunEventBus,
  encodedEventBytes,
  type RunEventBus,
  type RunEventBusOptions,
  type RunEventBusStats,
  type RunEventSubscription,
  type SubscribeResult,
} from "./ipc/bus.js";
export { createLiveHub, type LiveHub, type LiveHubConnection, type LiveHubOptions, type LiveHubWatchInput } from "./ipc/live-hub.js";
export {
  FrameReader,
  clampMessage,
  createIpcClient,
  createIpcServer,
  encodeFrame,
  type IpcClient,
  type IpcClientLiveFrame,
  type IpcClientOptions,
  type IpcClientRequestOptions,
  type IpcClientResponse,
  type IpcServer,
  type IpcServerOptions,
} from "./ipc/transport.js";
export { acquireDataDirectoryOwnership, type AsyncDataDirectoryOwner as DataDirectoryOwner } from "./persistence/ownership-client.js";
export type { AcquireOwnershipOptions } from "./persistence/ownership.js";
export { assertLocalFilesystem } from "./persistence/local-filesystem.js";
export { assertBoundedPayload, assertPositiveLimit, hashEffectInputs } from "./persistence/values.js";
export type { ArtifactRecord, ClaimedAdmission } from "./persistence/store.js";
export {
  MEASUREMENT_CHAT_KINDS,
  SIDE_CHAT_RETURN_WINDOW_HOURS,
  SITE_USAGE_WINDOW_DAYS,
  type CacheReadShare,
  type ChatKindPromptCache,
  type ChatKindUsage,
  type ChatMeasurement,
  type MeasurementChatKind,
  type PrefixChurn,
  type SideChatMeasurement,
  type SiteUsage,
} from "./persistence/chat-measurement.js";
export type { ModelConfigServiceOptions } from "./models/config.js";
export { DEFAULT_MEMORY_QUOTAS, type MemoryQuotas, type MemoryServiceOptions } from "./memory/service.js";
export { memoryNearMatchQuery, toFtsPhraseQuery } from "./memory/rules.js";
export {
  checkLocalePack,
  hashPluginDirectory,
  isLocalePackError,
  localizedPluginManifest,
  ownerCodeFacts,
  readPluginManifest,
  readPluginMessages,
  readPluginSiteProfiles,
  readPluginSnapshot,
  validatePluginDirectory,
  type PluginFile,
  type PluginFileCheck,
  type ResolvedExternalPlugin,
  type PluginLiveStatus,
} from "./plugins/registry.js";
export { PluginRegistry, devAuditId, type PluginRegistryOptions } from "./plugins/async-registry.js";
export type { SkillRolloutServiceOptions } from "./skills/rollout.js";
export {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  MAX_DISCOVERED_MODELS,
  MAX_DISCOVERY_BYTES,
  OBSERVED_CAPABILITIES,
  discoverModels,
  hashDraft,
  isDiscoveryStale,
  testConnection,
  sanitizeFailureMessage,
  DISCOVERY_CAPABILITIES,
  DEFAULT_TEST_TIMEOUT_MS,
  type ConnectionTestOptions,
  type ConnectionTestResult,
  type DiscoveredModel,
  type ModelDiscoveryOptions,
  type ObservedCapability,
} from "./models/discovery.js";
export {
  AccessPolicyService,
  ClockService,
  LoggerService,
  ModelService,
  PersistenceService,
  SecretReaderService,
  ToolRegistryService,
  WorkflowService,
} from "./ports.js";
export { PluginHostError } from "./plugin-host/errors.js";
export {
  TurnHookRegistry,
  declarationFor,
  hookMatchOf,
  type TurnHookDecision,
  type TurnHookFailure,
  type TurnHookFailureKind,
  type TurnHookRegistryOptions,
} from "./plugin-host/turn-hooks.js";
export {
  PluginHost,
  startHost,
  type PluginHostOptions,
  type ShutdownReport,
} from "./plugin-host/host.js";
export {
  OwnedResourceScope,
  disposeWithDeadline,
  type DisposalOutcome,
} from "./plugin-host/resources.js";
export { ToolRegistry, findUnrepresentable, type ExternalToolRegistration, type ToolRegistration } from "./tools/registry.js";
export { createMessagingService, type MessageTaken, type MessagingServiceOptions } from "./messaging/service.js";
export {
  createRoomPolicy,
  DEFAULT_FLOOD_LIMITS,
  type FloodLimits,
  type RoomNotice,
  type RoomPolicy,
  type RoomVerdict,
} from "./messaging/room-policy.js";
export { attachmentLine, mediaTypeAllowed, sniffMediaType, takeInMedia, type MediaPolicy } from "./messaging/media-intake.js";
export {
  PairingRegistry,
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
  type Pairing,
  type PairingRequest,
  type PairingState,
} from "./messaging/pairing.js";
export { resolveSenderActor } from "./messaging/identity.js";
export {
  ChannelHost,
  connectionOf,
  primaryCredentialRef,
  type ChannelAttachment,
  type ChannelHostOptions,
  type ChannelRecord,
  type ChannelView,
} from "./messaging/channel-host.js";
export {
  applyIngressServerLimits,
  clientAddressOf,
  createChannelIngress,
  createFailureBuckets,
  createIngressGuards,
  createTrustedProxies,
  failureKeyOf,
  INGRESS_SERVER_LIMITS,
  isTrustedProxyEntry,
  readBody,
  type ByteBudget,
  type IngressByteBudget,
  type ChannelIngressOptions,
  type FailureBuckets,
  type IngressGuards,
  type TrustedProxies,
} from "./messaging/ingress.js";
export * from "./host-policy.js";
export * from "./address-guard.js";
export * from "./fetch-tool.js";
export { htmlToText } from "@tavi/contracts";
export { routineHash, canonicalRoutineJson } from "./routines/service.js";
export {
  RoutineService,
  RoutineExecutionService,
  RoutineNewsService,
  RoutinePublicationService,
  RoutineDeliveryService,
  type RoutineServiceOptions,
  type RoutineExecutionOptions,
} from "./persistence/routine-facades.js";
export type { RoutineWorkerConfiguration } from "./persistence/routine-configuration.js";

export { routineModelPort, routinePluginReads, routineResearchTools } from "./routines/grants.js";
export { routineRunLateNote } from "./routines/runs.js";
export { observeRoutineModels, observeRoutineTools, routineFailureSettlement, type RoutineFailureSettlement } from "./routines/failures.js";

export { parseModelJson, renderRoutineNewsHtml, type RoutineNewsOptions, type RoutineRenderPolicy } from "./routines/news.js";
export {
  PUBLICATION_BOUNDARIES,
  STAGE_GRACE_MS,
  type RoutinePublication,
  type PublicationBoundary,
  type RoutinePublicationOptions,
} from "./routines/publication.js";
export { routineDeliveryTime, type RoutineDeliveryOptions } from "./routines/delivery.js";

export { OWNER_HEARTBEAT_STALE_MS, changedSections } from "./routines/control.js";
export { RoutineControlService, routineSkillContext } from "./routines/async-control.js";
export * from "./routines/corpus.js";
export * from "./publisher-registry.js";
export * from "./routines/clustering.js";
export * from "./routines/async-evaluation.js";

export * from "./model-accounting.js";
export * from "./router/async-repository.js";
export * from "./router/slot.js";
export * from "./router/guard.js";

export { MemoryService, SkillService, SkillRolloutService, ModelConfigService } from "./persistence/service-facades.js";

export {
  createSnapshot,
  exportTables,
  restoreSnapshot,
  readRecordedOwner,
  type ExportResult,
  type RestoreResult,
} from "./persistence/administration-client.js";
export { readSnapshotManifest, snapshotBytes, type SnapshotManifest } from "./persistence/snapshot-files.js";
export { resetDataDirectory, type ResetResult } from "./persistence/reset.js";

export { AsyncWork } from "./async-work.js";

export { ProviderFactoryRegistry, type ProviderInstance, type ProviderInstanceInput } from "./plugin-host/provider-factories.js";
export { SearchFactoriesService, FetchFactoriesService, ModelFactoriesService } from "./ports.js";

export { PROFILE_FORMAT } from "./persistence/profile-format.js";

export { ProviderBindings, providerRevision, executeProvider, type ResolvedProvider } from "./plugin-host/provider-bindings.js";

export { scopedProvider, recordedProviderCall, type ProviderExecutionOptions } from "./provider-execution.js";

export * from "./provider-dispatch.js";

export * from "./models/provider.js";

export { SiteSkillRegistry } from "./site-skills.js";
export { SERVE_SESSION_PREFIX, liveOwnerProcess } from "./persistence/owner-process.js";
