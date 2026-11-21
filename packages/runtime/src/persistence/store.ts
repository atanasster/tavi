import { assertProfileFormat } from "./profile-validation.js";
import { SqliteTaskMemoryUseRepository } from "./memory-use.js";
import { SqliteChatInstructionsRepository } from "./chat-instructions.js";
import { SqliteTaskFoldersRepository } from "./task-folders.js";
import { SqliteHeartbeatRepository } from "./heartbeat-repository.js";
import { MemoryVectorCache } from "../memory/vectors.js";
import type { PersistencePort } from "./internal-contracts.js";
import { queryTaskNeeds } from "./task-needs.js";
import { nextWakeups, type NextWakeups, type NextWakeupsInput } from "./store/wakeups.js";
import { queryArtifacts } from "./artifact-list.js";
import {
  type ArtifactsPayload,
  type ArtifactsResult,
  type TaskListFilters,
  type TaskListResult,
  type TaskPromptsFilters,
  type TaskPromptsResult,
  TaviError,
  type AdmissionRecord,
  type AdmissionState,
  type AdmissionOutcome,
  type ArtifactRecord,
  type TaskStatus,
  type TaskRecord,
  type MemoryReach,
  type PastChatHit,
} from "@tavi/contracts";
import { queryTaskList, queryTaskPrompts } from "./task-list.js";
import { queryChatMeasurement, type ChatMeasurement } from "./chat-measurement.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { nowTimestamp } from "@tavi/contracts/util";
import { runMigrations } from "./migrations.js";
import { SqlitePluginRepository } from "./plugin-repository.js";
import { SqliteMcpRepository } from "./mcp-repository.js";
import { SqliteToolPolicyRepository } from "./tool-policy-repository.js";
import { SqliteWorkspaceSettingsRepository } from "./workspace-settings-repository.js";
import { SqliteChannelIngressRepository, SqliteMessagingConnectionRepository } from "./messaging-connection-repository.js";
import { SqliteCenterRepository } from "./center.js";
import { SqliteReminderRepository } from "./reminders-repository.js";
import { SqliteIdeaRepository } from "./ideas-repository.js";
import { SqliteOnboardingRepository } from "./onboarding-repository.js";
import { SqliteTaskSummaryRepository } from "./task-summaries.js";
import { SqliteBrowserHistoryRepository } from "./browser-history.js";
import { SqliteTaskFindingRepository } from "./findings.js";
import { SqliteSiteRecipeRepository } from "./site-recipes.js";
import { SqliteSiteUsageRepository } from "./site-usage.js";
import { SqliteApprovalInboxRepository } from "./approval-inbox.js";
import { SqliteApprovalLinkRepository, SqliteApprovalRoundRepository } from "./approval-round-repository.js";
import { SqliteNeedDeliveryRepository } from "./need-delivery-repository.js";
import {
  SqliteApprovalRoundDeliveryRepository,
  SqliteChannelPurgeRepository,
  SqliteChannelRoomRepository,
  SqliteMessagingGrantRepository,
} from "./channel-group-repositories.js";
import { SqliteTranscriptRepository } from "./transcript-repository.js";
import { loadBetterSqlite3, type Database } from "./sqlite-loader.js";
import { clearStatements } from "./statement-cache.js";
import { onErasure } from "./erasure.js";
import {
  commitAdmission,
  getAdmission,
  hasRunningAdmission,
  latestSettledAdmission,
  listAdmissions,
  listClaimedAdmissions,
  type ClaimedAdmission,
} from "./store/admissions.js";
import { SqliteAgentDefinitionRepository } from "./store/agent-definitions.js";
import { SqliteAgentDelegationRepository } from "./store/agent-delegations.js";
import { SqliteAgentMailboxRepository } from "./store/agent-mailbox.js";
import { SqliteAgentWaitRepository } from "./store/agent-waits.js";
import { SqliteApprovalRepository } from "./store/approvals.js";
import {
  artifactStagingDirectory,
  claimAttachmentForRun,
  derivedPreviewExists,
  eraseArtifacts,
  getArtifact,
  listPendingReview,
  pruneArtifacts,
  pruneVideo,
  putArtifact,
  putStagedArtifact,
  readArtifactBody,
  resolveArtifactPath,
  setReviewState,
  type ArtifactPutFields,
} from "./store/artifacts.js";
import { SqliteCancellationRepository } from "./store/cancellations.js";
import { SqliteCheckpointReceiptRepository } from "./store/checkpoint-receipts.js";
import { SqliteEffectRepository } from "./store/effects.js";
import { SqliteExecutionRepository } from "./store/executions.js";
import {
  countCheckpoints,
  getMeta,
  integrityCheck,
  listApplicationTables,
  listMeta,
  listSaverTables,
  listTables,
  memoryCallSpend,
  memoryEmbeddingSpend,
  migrationStatus,
  optimizeQueryPlanner,
  pruneTransport,
  reclaimSpace,
  setMeta,
  tableColumns,
  transportRowCounts,
} from "./store/maintenance.js";
import { SqliteMemoryRepository, reconcileMemoryDeletions } from "./store/memory.js";
import {
  SqliteMessagingConversationRepository,
  SqliteMessagingIdentityBindingRepository,
  SqliteMessagingInboxRepository,
  SqliteMessagingOutboxRepository,
} from "./store/messaging.js";
import { SqliteModelConfigRepository } from "./store/model-config.js";
import { SqliteProjectRepository } from "./store/projects.js";
import { SqliteReportRepository } from "./store/reports.js";
import { SqliteScheduleRepository } from "./store/schedules.js";
import { SqliteSearchProviderRepository } from "./store/search-providers.js";
import { SqliteSkillRepository, SqliteSkillRolloutRepository } from "./store/skills.js";
import { SqliteSystemPromptRepository } from "./store/system-prompts.js";
import { searchTaskHistory } from "./store/task-history.js";
import { SqliteTaskRepository } from "./store/task-repository.js";
import { getTask, listTasks, updateTaskStatus } from "./store/tasks.js";
export type { ClaimedAdmission } from "./store/admissions.js";
export { RECLAIM_MIN_FREE_BYTES } from "./store/maintenance.js";
export { countChatNotesSql } from "./store/memory.js";

export interface SqliteStoreOptions {
  /** Absolute path to `tavi.sqlite`, or ":memory:" for a disposable spike run. */
  readonly databasePath: string;
  /** Directory for artifact bodies. Required unless the database is in-memory. */
  readonly artifactsDirectory?: string;
  readonly inMemory?: boolean;
}

// Re-exported (not redeclared) from `@tavi/contracts` — a local duplicate
// of this shape previously drifted out of sync with the port's own
// `ArtifactRecord` when `reviewState`/`reviewedBy`/`reviewedAt` were added:
// a hand-kept copy of a shape silently loses fields added to the original.
// `index.ts`'s
// existing `export type { ArtifactRecord } from "./persistence/store.js"`
// keeps working unchanged against this re-export.
export type { ArtifactRecord };

/** How long a second connection waits for the write lock before failing. */
const BUSY_TIMEOUT_MS = 5000;
/** How soon after a forget the write-ahead log is truncated, and how often again while a reader holds it. */
const ERASURE_SCRUB_DELAY_MS = 1000;
const ERASURE_SCRUB_RETRY_MS = 30_000;

export class SqliteStore {
  readonly #db: Database;
  readonly #artifactsDirectory: string;
  #transactionDepth = 0;
  #port: PersistencePort | undefined;
  #scrubTimer: NodeJS.Timeout | undefined;
  /** Hybrid recall's per-workspace vectors, one cache for the worker. */
  readonly memoryVectors = new MemoryVectorCache();

  constructor(options: SqliteStoreOptions) {
    const DatabaseCtor = loadBetterSqlite3();
    const path = options.inMemory === true ? ":memory:" : options.databasePath;
    if (!options.inMemory) {
      mkdirSync(dirname(path), { recursive: true });
      assertProfileFormat(path);
    }
    this.#db = new DatabaseCtor(path);
    this.#artifactsDirectory = options.artifactsDirectory ?? (options.inMemory === true ? "" : join(dirname(path), "artifacts"));

    // WAL keeps one writer plus concurrent readers predictable; the busy timeout
    // makes a second connection wait rather than fail immediately.
    //
    // Wrapped because `runMigrations` can legitimately refuse — a schema this
    // binary does not recognise — and a constructor that throws after opening a
    // handle leaks it: the caller never receives an object to `close()`. Each leak
    // holds a WAL connection to the very file the error tells the operator to
    // leave alone.
    try {
      // A new file reclaims what its deletions free a step at a time
      // (`reclaimSpace`). Ignored by a file that already has tables:
      // switching an existing one takes a `VACUUM`, which `reclaimSpace` does.
      this.#db.pragma("auto_vacuum = INCREMENTAL");
      this.#db.pragma("journal_mode = WAL");
      this.#db.pragma("synchronous = NORMAL");
      this.#db.pragma("foreign_keys = ON");
      this.#db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      // A deletion overwrites what it removes with zeros, overflow pages
      // included, so a forgotten memory, chat or checkpoint is not left
      // readable in the file's free space. `FAST` would skip freed pages, and
      // a long memory or turn spills onto those; measured, `ON` costs a turn's
      // writes nothing noticeable and a deletion about a millisecond more per
      // megabyte it frees. The write-ahead log's older frames are truncated
      // after a forget (`scrubErased`).
      this.#db.pragma("secure_delete = ON");
      // The planner and the page cache: 64 MB of cache (the default is
      // 2 MB), sorts and temporary indexes in memory, reads through a
      // 256 MB map, and a write-ahead log trimmed back to 64 MB after a
      // checkpoint rather than left at its high-water mark. `ANALYZE` (run
      // by `PRAGMA optimize` below and in the retention sweep) samples at
      // most 1000 rows of each index instead of reading it whole.
      this.#db.pragma("cache_size = -64000");
      this.#db.pragma("temp_store = MEMORY");
      this.#db.pragma("mmap_size = 268435456");
      this.#db.pragma("journal_size_limit = 67108864");
      this.#db.pragma("analysis_limit = 1000");
      runMigrations(this.#db);
      onErasure(this.#db, () => this.#scheduleScrub(ERASURE_SCRUB_DELAY_MS));
      // Statistics for the tables that lack or have outgrown them, so the
      // planner chooses among the partial indexes on evidence: every table
      // is checked (`0x10000`), not only those this connection has used,
      // and only a missing or stale one is analysed. Best effort: statistics
      // are an optimisation, and `ANALYZE` reads table pages a damaged file
      // may not have — an open that failed here would keep `tavi doctor`
      // from ever running the integrity check that reports the damage.
      try {
        this.#db.pragma("optimize = 0x10002");
      } catch {
        // The planner falls back to its defaults; the retention sweep retries.
      }
    } catch (error) {
      try {
        this.#db.close();
      } catch {
        // The refusal is the error worth reporting; a failed cleanup must not
        // replace it.
      }
      throw error;
    }
  }

  /**
   * Truncates the write-ahead log once something a person asked to forget was
   * erased (`noteErasure`). The deletion's own pages are zeroed, but frames an
   * earlier write left in the log can still hold the words until the log is
   * overwritten. The checkpoint waits a moment, so a forget's follow-up
   * operations (its checkpoints pruned or deleted) are covered by the same
   * one, and runs between operations, never inside a transaction.
   */
  #scheduleScrub(delayMs: number): void {
    if (this.#db.name === ":memory:" || !this.#db.open) return;
    if (this.#scrubTimer !== undefined) clearTimeout(this.#scrubTimer);
    this.#scrubTimer = setTimeout(() => {
      this.#scrubTimer = undefined;
      if (!this.scrubErased()) this.#scheduleScrub(ERASURE_SCRUB_RETRY_MS);
    }, delayMs);
    this.#scrubTimer.unref();
  }

  /**
   * Checkpoints the write-ahead log into the file and truncates it to zero
   * bytes: what `secure_delete` zeroed reaches the file, and older frames go.
   * Never waits: a reader holding an old snapshot (a checkpoint cursor, a
   * backup) makes it answer `false`, and the scheduled scrub tries again
   * later. Outside a transaction only.
   */
  scrubErased(): boolean {
    if (this.#db.name === ":memory:" || !this.#db.open || this.#db.inTransaction) return false;
    this.#db.pragma("busy_timeout = 0");
    try {
      const [result] = this.#db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
      return result?.busy === 0;
    } catch {
      return false;
    } finally {
      this.#db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  }

  get handle(): Database {
    return this.#db;
  }

  get artifactsDirectory(): string {
    return this.#artifactsDirectory;
  }

  get databasePath(): string {
    return this.#db.name;
  }

  get isOpen(): boolean {
    return this.#db.open;
  }

  /**
   * Short application transactions only.
   *
   * Re-entrant so a repository helper can be called from inside a caller's
   * transaction. Never hold one across graph invocation, model/network work or
   * asynchronous saver serialization.
   */
  transaction<T>(fn: () => T): T {
    if (this.#transactionDepth > 0) {
      this.#transactionDepth += 1;
      try {
        return fn();
      } finally {
        this.#transactionDepth -= 1;
      }
    }
    const wrapped = this.#db.transaction(fn) as () => T;
    this.#transactionDepth += 1;
    try {
      return wrapped();
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  /**
   * A compare-and-set transaction that acquires its write lock up front.
   *
   * `transaction()`'s default `BEGIN` is deferred: a plain `SELECT` inside it
   * takes only a read lock, so a read-then-conditionally-write sequence (the
   * shape every CAS in this file uses) is not actually atomic against another
   * writer under WAL — a concurrent commit between the read and the write
   * surfaces as a raw `SQLITE_BUSY`/snapshot-conflict exception instead of
   * the typed `false` a CAS is supposed to return. `BEGIN IMMEDIATE` takes
   * the write lock before the first statement runs, so the read inside it is
   * already serialized against other writers. Use this for a genuine
   * read-compare-write, not for a plain read-only transaction.
   */
  transactionImmediate<T>(fn: () => T): T {
    if (this.#transactionDepth > 0) {
      // Already inside a transaction: SQLite has one write lock per
      // connection, so there is nothing further to acquire — proceed as an
      // ordinary nested call (better-sqlite3 handles this as a savepoint).
      this.#transactionDepth += 1;
      try {
        return fn();
      } finally {
        this.#transactionDepth -= 1;
      }
    }
    const wrapped = this.#db.transaction(fn).immediate as () => T;
    this.#transactionDepth += 1;
    try {
      return wrapped();
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  putArtifact(input: ArtifactPutFields & { readonly body: string | Uint8Array }): ArtifactRecord {
    return putArtifact(this, input);
  }

  get artifactStagingDirectory(): string {
    return artifactStagingDirectory(this);
  }

  putStagedArtifact(input: ArtifactPutFields & { readonly stagedPath: string }): ArtifactRecord {
    return putStagedArtifact(this, input);
  }

  getArtifact(artifactId: string): ArtifactRecord | undefined {
    return getArtifact(this, artifactId);
  }

  readArtifactBody(artifactId: string): Uint8Array | undefined {
    return readArtifactBody(this, artifactId);
  }

  pruneArtifacts(input: { readonly olderThan: string; readonly dryRun: boolean; readonly includeReports?: boolean }): {
    readonly artifacts: number;
    readonly bytes: number;
  } {
    return pruneArtifacts(this, input);
  }

  derivedPreviewExists(workspaceId: string, source: string): boolean {
    return derivedPreviewExists(this, workspaceId, source);
  }

  pruneVideo(input: { readonly workspaceId: string; readonly olderThan: string }): { readonly artifacts: number; readonly bytes: number } {
    return pruneVideo(this, input);
  }

  eraseArtifacts(artifactIds: readonly string[]): { readonly artifacts: number; readonly bytes: number } {
    return eraseArtifacts(this, artifactIds);
  }

  listPendingReview(workspaceId: string, limit: number): readonly ArtifactRecord[] {
    return listPendingReview(this, workspaceId, limit);
  }

  claimAttachmentForRun(input: { readonly artifactId: string; readonly runId: string }): void {
    return claimAttachmentForRun(this, input);
  }

  setReviewState(input: {
    readonly artifactId: string;
    readonly reviewState: "approved" | "rejected";
    readonly reviewedBy: string;
    readonly reviewedAt: string;
    readonly note?: string;
  }): void {
    return setReviewState(this, input);
  }

  resolveArtifactPath(relativePath: string): string {
    return resolveArtifactPath(this, relativePath);
  }

  listTables(): readonly string[] {
    return listTables(this);
  }

  listApplicationTables(): readonly string[] {
    return listApplicationTables(this);
  }

  getMeta(key: string): string | undefined {
    return getMeta(this, key);
  }

  setMeta(key: string, value: string, now: string): void {
    return setMeta(this, key, value, now);
  }

  integrityCheck(mode: "quick" | "full" = "quick"): { readonly ok: boolean; readonly problems: readonly string[] } {
    return integrityCheck(this, mode);
  }

  reclaimSpace(): {
    readonly autoVacuum: "none" | "full" | "incremental";
    readonly freeBytes: number;
    readonly reclaimedBytes: number;
    readonly action: "none" | "incremental_vacuum" | "vacuum";
  } {
    return reclaimSpace(this);
  }

  /** Refreshes drifted planner statistics (`PRAGMA optimize`); the retention sweep runs it. */
  optimize(): void {
    optimizeQueryPlanner(this);
  }

  migrationStatus(): {
    readonly applied: readonly string[];
    readonly latest: string | null;
    readonly unknown: readonly string[];
  } {
    return migrationStatus(this);
  }

  transportRowCounts(): {
    readonly inbox: number;
    readonly inboxUnprocessed: number;
    readonly outbox: number;
    readonly mailbox: number;
    readonly waitIntents: number;
  } {
    return transportRowCounts(this);
  }

  /** Chat usage by kind and side-chat use, for `doctor`; see `chat-measurement.ts`. */
  chatMeasurement(input: { readonly now: string; readonly returnWindowHours?: number }): ChatMeasurement {
    return queryChatMeasurement(this.#db, input);
  }

  memoryCallSpend(input: {
    readonly workspaceIds: readonly string[];
    readonly since: string;
    readonly purpose: "extraction" | "summary";
    readonly attemptPrefix: string;
  }): {
    readonly calls: number;
    readonly failed: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly estimatedUsd: number;
  } {
    return memoryCallSpend(this, input);
  }

  memoryEmbeddingSpend(input: { readonly since: string; readonly attemptPrefix: string }): {
    readonly calls: number;
    readonly failed: number;
    readonly inputTokens: number;
    readonly estimatedUsd: number;
  } {
    return memoryEmbeddingSpend(this, input);
  }

  pruneTransport(input: { readonly olderThan: string; readonly dryRun: boolean }): {
    readonly inbox: number;
    readonly outbox: number;
    readonly mailbox: number;
    readonly waitIntents: number;
  } {
    return pruneTransport(this, input);
  }

  tableColumns(table: string): readonly string[] {
    return tableColumns(this, table);
  }

  listMeta(): Readonly<Record<string, string>> {
    return listMeta(this);
  }

  listSaverTables(): readonly string[] {
    return listSaverTables(this);
  }

  /** The canvas projection, independent of the tasks list. */
  listArtifacts(filters: ArtifactsPayload): ArtifactsResult {
    return queryArtifacts(this.handle, filters);
  }

  listTaskSessions(filters: TaskListFilters): TaskListResult {
    return queryTaskList(this.handle, filters);
  }

  /** A task's follow-up prompts (`tasks prompts`); undefined when it is not found in the workspace named. */
  taskPrompts(filters: TaskPromptsFilters): TaskPromptsResult | undefined {
    return queryTaskPrompts(this.handle, filters);
  }

  taskNeeds(workspaceId: string, taskIds: readonly string[]): ReturnType<typeof queryTaskNeeds> {
    return queryTaskNeeds(this.handle, workspaceId, taskIds);
  }

  listTasks(limit: number): readonly TaskRecord[] {
    return listTasks(this, limit);
  }

  getTask(taskId: string): TaskRecord | undefined {
    return getTask(this, taskId);
  }

  updateTaskStatus(taskId: string, status: TaskStatus, finalText: string | null): void {
    return updateTaskStatus(this, taskId, status, finalText);
  }

  commitAdmission(input: {
    readonly admissionId: string;
    readonly taskId: string;
    readonly state: AdmissionState;
    readonly result: AdmissionOutcome;
    readonly checkpointNamespace?: string;
  }): void {
    return commitAdmission(this, input);
  }

  listAdmissions(taskId: string): readonly AdmissionRecord[] {
    return listAdmissions(this, taskId);
  }

  listClaimedAdmissions(limit: number): readonly ClaimedAdmission[] {
    return listClaimedAdmissions(this, limit);
  }

  hasRunningAdmission(taskId: string): boolean {
    return hasRunningAdmission(this, taskId);
  }

  latestSettledAdmission(taskId: string): AdmissionRecord | undefined {
    return latestSettledAdmission(this, taskId);
  }

  searchTaskHistory(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly terms: readonly string[];
    readonly limit: number;
    readonly excludeTaskId?: string;
    readonly reach?: MemoryReach;
  }): readonly PastChatHit[] {
    return searchTaskHistory(this, input);
  }

  getAdmission(taskId: string, operationKey: string): AdmissionRecord | undefined {
    return getAdmission(this, taskId, operationKey);
  }

  close(): void {
    if (this.#scrubTimer !== undefined) {
      clearTimeout(this.#scrubTimer);
      this.#scrubTimer = undefined;
      // Closing the last connection checkpoints and removes the log anyway; this covers one that is not the last.
      this.scrubErased();
    }
    clearStatements(this.#db);
    if (this.#db.open) this.#db.close();
  }

  countCheckpoints(): number {
    return countCheckpoints(this);
  }

  /** When each due-work sweep next has something to do (`store/wakeups.ts`). */
  nextWakeups(input: NextWakeupsInput): NextWakeups {
    return nextWakeups(this, input);
  }

  routineSchedule(routineId: string): { schedule_id: string } | undefined {
    return this.handle.prepare("SELECT schedule_id FROM tavi_routine_triggers WHERE routine_id=? LIMIT 1").get(routineId) as
      | { schedule_id: string }
      | undefined;
  }

  importProjects(input: {
    workspaceId: string;
    settings: Partial<import("@tavi/contracts").CollectorSettings>;
    projects: readonly import("@tavi/contracts").Project[];
    now: string;
  }): { settings: import("@tavi/contracts").CollectorSettings; created: number; skipped: readonly string[] } {
    return this.transactionImmediate(() => {
      const projects = this.asPort().repositories.projects;
      const seen = new Set<string>();
      for (const project of input.projects) {
        if (seen.has(project.id)) throw new TaviError("INVALID_INPUT", "Duplicate project in import");
        seen.add(project.id);
      }
      const settings = projects.putSettings({
        workspaceId: input.workspaceId,
        settings: { ...projects.getSettings(input.workspaceId), ...input.settings },
        now: input.now,
      });
      let created = 0;
      const skipped: string[] = [];
      for (const project of input.projects) {
        if (projects.get(input.workspaceId, project.id) !== undefined) {
          skipped.push(project.id);
          continue;
        }
        projects.create({ workspaceId: input.workspaceId, project, enabled: true, now: input.now });
        created++;
      }
      return { settings, created, skipped };
    });
  }

  reconcileMemoryDeletions(now: string = nowTimestamp()): { readonly forgotten: number; readonly failed: number } {
    return reconcileMemoryDeletions(this, now);
  }

  /**
   * The repositories over this store. Built once: the worker reaches it on
   * every `service.*` and `pluginRegistry.*` call, and the repositories hold
   * no state of their own beyond the store they read.
   */
  asPort(): PersistencePort {
    this.#port ??= this.#buildPort();
    return this.#port;
  }

  #buildPort(): PersistencePort {
    return {
      databasePath: this.databasePath,
      transaction: <T>(fn: () => T): T => this.transaction(fn),
      repositories: {
        tasks: new SqliteTaskRepository(this),
        executions: new SqliteExecutionRepository(this),
        effects: new SqliteEffectRepository(this),
        approvals: new SqliteApprovalRepository(this),
        cancellations: new SqliteCancellationRepository(this),
        receipts: new SqliteCheckpointReceiptRepository(this),
        modelConfig: new SqliteModelConfigRepository(this),
        memory: new SqliteMemoryRepository(this),
        artifacts: this,
        skills: new SqliteSkillRepository(this),
        skillRollout: new SqliteSkillRolloutRepository(this),
        agentMailbox: new SqliteAgentMailboxRepository(this),
        agentWaits: new SqliteAgentWaitRepository(this),
        agentDelegations: new SqliteAgentDelegationRepository(this),
        messagingInbox: new SqliteMessagingInboxRepository(this),
        messagingOutbox: new SqliteMessagingOutboxRepository(this),
        messagingIdentityBindings: new SqliteMessagingIdentityBindingRepository(this),
        messagingConversations: new SqliteMessagingConversationRepository(this),
        schedules: new SqliteScheduleRepository(this),
        agents: new SqliteAgentDefinitionRepository(this),
        projects: new SqliteProjectRepository(this),
        reports: new SqliteReportRepository(this),
        searchProviders: new SqliteSearchProviderRepository(this),
        plugins: new SqlitePluginRepository(() => this.handle),
        mcp: new SqliteMcpRepository(() => this.handle),
        systemPrompts: new SqliteSystemPromptRepository(this),
        workspaceSettings: new SqliteWorkspaceSettingsRepository(this),
        messagingConnections: new SqliteMessagingConnectionRepository(this),
        channelIngress: new SqliteChannelIngressRepository(this),
        channelRooms: new SqliteChannelRoomRepository(() => this.handle),
        channelPurges: new SqliteChannelPurgeRepository(() => this.handle),
        messagingGrants: new SqliteMessagingGrantRepository(() => this.handle),
        center: new SqliteCenterRepository(() => this.handle),
        reminders: new SqliteReminderRepository(this),
        taskSummaries: new SqliteTaskSummaryRepository(() => this.handle),
        chatInstructions: new SqliteChatInstructionsRepository(
          () => this.handle,
          (work) => this.transactionImmediate(work),
        ),
        taskFolders: new SqliteTaskFoldersRepository(
          () => this.handle,
          (work) => this.transactionImmediate(work),
        ),
        heartbeats: new SqliteHeartbeatRepository(
          () => this.handle,
          (work) => this.transactionImmediate(work),
        ),
        ideas: new SqliteIdeaRepository(
          () => this.handle,
          (work) => this.transactionImmediate(work),
        ),
        onboarding: new SqliteOnboardingRepository(
          () => this.handle,
          (work) => this.transactionImmediate(work),
        ),
        memoryUse: new SqliteTaskMemoryUseRepository(() => this.handle),
        browserHistory: new SqliteBrowserHistoryRepository(this),
        findings: new SqliteTaskFindingRepository(this),
        siteRecipes: new SqliteSiteRecipeRepository(() => this.handle),
        siteUsage: new SqliteSiteUsageRepository(() => this.handle),
        approvalInbox: new SqliteApprovalInboxRepository(() => this.handle),
        toolPolicy: new SqliteToolPolicyRepository(() => this.handle),
        approvalRounds: new SqliteApprovalRoundRepository(() => this.handle),
        approvalLinks: new SqliteApprovalLinkRepository(() => this.handle),
        needDeliveries: new SqliteNeedDeliveryRepository(() => this.handle),
        approvalRoundDeliveries: new SqliteApprovalRoundDeliveryRepository(() => this.handle),
        transcripts: new SqliteTranscriptRepository(
          () => this.handle,
          (relativePath) => this.resolveArtifactPath(relativePath),
        ),
      },
    };
  }
}
