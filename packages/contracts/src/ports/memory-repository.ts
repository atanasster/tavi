import type {
  EvidenceSource,
  LineageEdge,
  MemoryDeletion,
  MemoryKind,
  MemoryRecord,
  MemoryReview,
  MemoryRevision,
  MemoryScope,
  MemoryStatus,
  PreferenceValue,
} from "../memory.js";
import type { AsyncRepository } from "../persistence-types.js";
import type { MemoryCaptureSourceStats } from "./memory-service.js";

/**
 * Personal memory storage.
 *
 * The repository owns the invariants a service must not be able to bypass: scope
 * filtering in SQL, the canonical-plus-FTS write as one transaction, and the
 * content-free deletion journal. Lifecycle *decisions* (who may approve, what
 * supersedes what) belong to `MemoryService`, not here.
 */
/** The most revision ids `liveRevisionIds` checks in one call. */
export const MAX_LIVE_REVISION_IDS = 2048;

interface MemoryRepositoryPortDefinition {
  /** Insert a record and its first revision, indexing the revision, in one transaction. */
  insertRecord(input: {
    readonly record: MemoryRecord;
    readonly revision: MemoryRevision;
    readonly preference?: PreferenceValue;
    /** The record's content key: a SHA-256 hex of its normalised content, never the text. */
    readonly contentKey?: string;
  }): void;
  getRecord(recordId: string): MemoryRecord | undefined;
  /**
   * Exact dedup's candidates: the live records (pending
   * proposals and approved records in force at `now`) of `kind` in the scope
   * whose content key is `contentKey`. At most `limit` of them.
   */
  findByContent(input: {
    readonly scopeKey: string;
    readonly kind: MemoryKind;
    readonly contentKey: string;
    readonly now: string;
    readonly limit: number;
  }): readonly MemoryRecord[];
  /**
   * The approved records in force at `now` in the scope that hold a
   * preference key or a fact's topic key: what a proposal with
   * that key would update. `excludeRecordId` is the proposal itself.
   */
  keyHolders(input: {
    readonly scopeKey: string;
    readonly kind: "preference" | "fact";
    readonly key: string;
    readonly now: string;
    readonly excludeRecordId?: string;
  }): readonly MemoryRecord[];
  /** Records visible in the given scope keys; the caller passes the authorized set. */
  listRecords(input: {
    readonly scopeKeys: readonly string[];
    readonly kinds?: readonly MemoryKind[];
    readonly statuses?: readonly MemoryStatus[];
    /** Only records written from this chat (`MemoryRecord.originTaskId`). */
    readonly originTaskId?: string;
    /**
     * Only *past* records at `now` (`memoryRecordIsPast`), in place of
     * `statuses`: approved ones whose `validTo` or `expiryAt` passed, and
     * expired ones that had been approved.
     */
    readonly past?: { readonly now: string };
    /**
     * Only approved records whose `expiryAt` passed by `now`, in
     * place of `statuses`: what the sweep marks expired. Ended facts and
     * already-expired records are left out.
     */
    readonly lapsedExpiry?: { readonly now: string };
    readonly limit: number;
    readonly offset?: number;
  }): readonly MemoryRecord[];
  listRevisions(recordId: string): readonly MemoryRevision[];
  getRevision(revisionId: string): MemoryRevision | undefined;
  /**
   * Which of `revisionIds` are still in force: the revision exists and is not
   * revoked, and its record is not revoked, deleted or rejected. A forgotten
   * record's revisions are erased, so they are never returned; a superseded
   * revision that is still kept is. Ids only — no content leaves — and one
   * primary-key lookup per call (at most `MAX_LIVE_REVISION_IDS` ids).
   */
  liveRevisionIds(revisionIds: readonly string[]): readonly string[];
  /**
   * Apply a lifecycle change with an expected current revision.
   *
   * Returns false when the stored current revision differs, which is how a
   * concurrent edit becomes `REVISION_CONFLICT` rather than a silent
   * last-writer-wins.
   */
  applyLifecycle(input: {
    readonly recordId: string;
    readonly expectedCurrentRevisionId: string | null;
    /** Optional expected lifecycle state, part of the compare-and-set. */
    readonly expectedStatus?: MemoryStatus;
    readonly status: MemoryStatus;
    readonly currentRevisionId?: string | null;
    readonly validFrom?: string | null;
    readonly validTo?: string | null;
    readonly updatedAt: string;
    /** Reindex when the record becomes approved; defaults to on. */
    readonly reindexOnApproval?: boolean;
  }): boolean;
  /**
   * Replace an approved value with a new revision, atomically.
   *
   * The compare-and-set against the record row runs *first*; the revision is
   * inserted, the previous one closed and superseded, and the index replaced
   * only when the CAS wins. A lost CAS returns `false` having written nothing.
   * The record's `validTo` and `expiryAt` are kept unless given (`null`
   * clears one); `expectedStatus: "expired"` revives an expired
   * record to `approved` (compare-and-set on `expired`).
   */
  correctRevision(input: {
    readonly recordId: string;
    readonly expectedCurrentRevisionId: string | null;
    readonly revision: MemoryRevision;
    readonly preference?: PreferenceValue;
    readonly now: string;
    /** Absent: `approved`. */
    readonly expectedStatus?: "approved" | "expired";
    readonly validTo?: string | null;
    readonly expiryAt?: string | null;
    /** Assigned when an untagged fact is replaced by a near-matched update (`topic_key IS NULL`). */
    readonly topicKey?: string;
    /** The corrected content's key; `null` clears it. Absent: kept. */
    readonly contentKey?: string | null;
  }): boolean;
  recordReview(review: MemoryReview): void;
  listReviews(recordId: string): readonly MemoryReview[];
  insertEvidence(source: EvidenceSource): void;
  listEvidence(input: { readonly scopeKeys: readonly string[]; readonly limit: number }): readonly EvidenceSource[];
  insertLineage(edge: LineageEdge): void;
  listLineage(input: { readonly toRevisionId: string }): readonly LineageEdge[];
  /**
   * Forget a record: tombstone it, drop its search row, increment its scope's
   * revocation generation and write the content-free journal entry — all in one
   * transaction, so no reader ever sees a half-erased record.
   */
  forget(input: { readonly recordId: string; readonly deletion: MemoryDeletion; readonly updatedAt: string }): void;
  listDeletions(input: { readonly scopeKeys: readonly string[]; readonly limit: number }): readonly MemoryDeletion[];
  /** The persisted deletion journal entry by its own id, the authoritative read-back for `forget`. */
  getDeletion(deletionId: string): MemoryDeletion | undefined;
  /**
   * A forget's cleanup is not over: the memory `providers`
   * that held the record could not take its removal now. The row goes back
   * to `pending` and names them (added to any it named already),
   * and holds nothing of the record (no body). No row: nothing.
   */
  markDeletionPending(deletionId: string, providers?: readonly string[]): void;
  /**
   * `pending` journal rows, oldest first, at most `limit`, with the providers
   * each waits for (`pendingProviders`): the removals the host resends.
   * With `provider`, only the rows waiting for it; with
   * `unassigned`, only those naming none yet (as a forget writes them). A
   * provider uninstalled for good then never starves another's.
   */
  pendingDeletions(limit: number, filter?: { readonly provider?: string; readonly unassigned?: boolean }): readonly MemoryDeletion[];
  /** How many journal rows are `pending`, and how many of them wait for each provider, by provider id: counted, never capped. */
  pendingDeletionCounts(): {
    readonly total: number;
    readonly byProvider: readonly { readonly provider: string; readonly removals: number }[];
  };
  /**
   * A pending row's cleanup finished: `complete`, at `cleanedAt`. With
   * `providerId`, that provider took the removal: it leaves the row's
   * providers, and the row completes only once none is left. A row already
   * complete is left as it is.
   */
  completeDeletion(input: { readonly deletionId: string; readonly cleanedAt: string; readonly providerId?: string }): void;
  /** The current revocation generation for a scope key; 0 when never revoked. */
  revocationGeneration(scopeKey: string): number;
  /** Stored record count and body bytes inside the given scopes. */
  usage(scopeKeys: readonly string[]): { readonly records: number; readonly bytes: number };
  /**
   * Remove a record's search rows without erasing its body.
   *
   * Revocation stops a record being retrievable while retaining it for audit;
   * erasure is `forget`. Both must leave the index consistent.
   */
  deindex(recordId: string): void;
  search(input: {
    readonly scopeKeys: readonly string[];
    readonly query: string;
    readonly limit: number;
    readonly now: string;
    readonly includeSensitive?: boolean;
    readonly excludeLocalOrigin?: boolean;
    readonly excludeSourceIds?: readonly string[];
    readonly includePast?: boolean;
  }): readonly { readonly record: MemoryRecord; readonly revision: MemoryRevision; readonly snippet: string }[];
  /**
   * The records of `recordIds` that `search` would find eligible in
   * `scopeKeys` at `now`, whatever words they hold: approved,
   * at their current revision, in force, in scope, with the same filter as
   * `search`'s. In no particular order; an id that fails any of it is left out.
   */
  eligibleByIds(input: {
    readonly scopeKeys: readonly string[];
    readonly recordIds: readonly string[];
    readonly now: string;
  }): readonly { readonly record: MemoryRecord; readonly revision: MemoryRevision; readonly snippet: string }[];
  /**
   * Rebuild the search index from eligible canonical revisions and verify row
   * coverage. Not a repair path for disagreement: a plain rebuild from FTS
   * content would not fix that.
   */
  rebuildSearchIndex(): { readonly indexed: number; readonly verified: boolean };
  /**
   * Hybrid recall's candidates (invariant 4): the records
   * eligible for automatic recall in `scopeKeys` at `now` (approved, current,
   * in force, never sensitive) come from SQL first, and only their cached
   * vectors of `modelKey` are scored against `vector` (a dot product: both
   * unit-normalised). Answers the best `limit` by cosine, the eligible ones
   * whose preference or topic key is one of `keys`, how many were eligible
   * and how many of those had no vector to score (`missing`). The worker's
   * cache of `workspaceId`'s vectors is loaded on first use. `personal: false`
   * leaves personal records (no workspace) out of meaning search, neither
   * scored nor counted: the workspace keeps them to their words.
   * A record whose current revision cites one of `excludeSourceIds` (a
   * revoked source) is not eligible, so it never takes a ranked slot.
   */
  vectorCandidates(input: {
    readonly scopeKeys: readonly string[];
    readonly workspaceId: string;
    readonly now: string;
    readonly modelKey: string;
    readonly vector: readonly number[];
    readonly limit: number;
    readonly keys?: readonly string[];
    readonly personal?: boolean;
    readonly excludeLocalOrigin?: boolean;
    readonly excludeSourceIds?: readonly string[];
    readonly includePast?: boolean;
  }): {
    readonly ranked: readonly { readonly recordId: string; readonly revisionId: string; readonly score: number }[];
    readonly keyMatches: readonly { readonly recordId: string; readonly revisionId: string }[];
    readonly eligible: number;
    readonly missing: number;
    readonly nearDuplicates?: readonly { readonly leftRevisionId: string; readonly rightRevisionId: string; readonly cosine: number }[];
  };
  /**
   * The approved, current, non-sensitive revisions of `workspaceId`'s records
   * (its own, and the personal ones of `principalIds`: the people the
   * workspace serves) with no vector of `modelKey`, oldest first, skipping one
   * that failed `maxFailures` times on that model: what the backfill embeds
   * next. Each answer holds the text to embed. `revisionIds`, when
   * given, narrows it to those revisions: the backfill retrying a failed
   * batch's texts one by one. A record made from a local chat
   * (`localOrigin`) is left out unless `withLocalOrigin`: only a local
   * embedding connection embeds one.
   */
  vectorBacklog(input: {
    readonly workspaceId: string;
    readonly principalIds: readonly string[];
    readonly modelKey: string;
    readonly now: string;
    readonly limit: number;
    readonly maxFailures: number;
    readonly revisionIds?: readonly string[];
    readonly withLocalOrigin?: boolean;
  }): readonly { readonly revisionId: string; readonly text: string }[];
  /**
   * Store vectors, each unit-normalised first, replacing one of the same
   * revision and model; a vector of another model stays. A revision
   * no longer approved and current, or sensitive, gets none; neither does a
   * zero or non-finite vector, nor a record ended or expired. Each stored
   * vector joins every loaded cache of its model once the write committed. Answers how many were stored.
   */
  putVectors(input: {
    readonly vectors: readonly { readonly revisionId: string; readonly modelKey: string; readonly vector: readonly number[] }[];
    readonly now: string;
  }): number;
  /** Count one more failed embedding of each revision on `modelKey` (each model counts its own). */
  recordVectorFailures(input: { readonly revisionIds: readonly string[]; readonly modelKey: string; readonly now: string }): void;
  /**
   * Delete the vectors and failure counts of every model not in
   * `keepModelKeys` (no workspace binds it any more), and drop the caches of
   * those models. `keepPersonal`, per model listed, names the people whose
   * personal records may keep a vector of it: those of any other person go,
   * from the database and every cache (no workspace binding that model may
   * embed them any more). Answers how many vectors went.
   */
  pruneVectors(input: {
    readonly keepModelKeys: readonly string[];
    readonly keepPersonal?: readonly { readonly modelKey: string; readonly principalIds: readonly string[] }[];
  }): number;
  /**
   * What doctor and the disclosure show: eligible revisions (the
   * workspace's own and the personal ones of `principalIds`; `personal` of
   * them personal), those with a vector of `modelKey`, without one, failed
   * out, and the worker's cache for the workspace.
   */
  vectorStats(input: {
    readonly workspaceId: string;
    readonly principalIds: readonly string[];
    readonly modelKey?: string;
    readonly now: string;
    readonly maxFailures: number;
  }): {
    readonly eligible: number;
    readonly personal: number;
    readonly indexed: number;
    readonly missing: number;
    readonly failed: number;
    readonly cachedVectors: number;
    readonly cachedBytes: number;
  };
  /** Drop the worker's vector cache for a workspace: its retrieval went back to lexical. */
  dropVectorCache(workspaceId: string): void;
  /**
   * 30-day capture outcome counts per revision-1 source (`tool`: the model's
   * `memory.propose`, which stamps its chat; `epoch-flush`,
   * `provider:<id>:capture`, `provider:<id>:consolidate`, `operator`, and
   * `other`) for records recorded at or after `since`, auto-approved ones as
   * `autoKept` apart from `kept`: counts only, never memory text.
   */
  captureStats(input: { readonly since: string; readonly now: string }): readonly MemoryCaptureSourceStats[];
  /**
   * The operator's page: every scope `operatorSeesMemory`
   * admits for `principalId` in `workspaceId` that holds a record not
   * deleted, by key. Read only by `MemoryService.operatorView` and the
   * operator view of its reads.
   */
  operatorScopes(input: {
    readonly workspaceId: string;
    readonly principalId: string;
  }): readonly { readonly scopeKey: string; readonly scope: MemoryScope }[];
  /**
   * Other people's personal records that belong with the workspace (recorded
   * in it, or naming none and held by someone it knows), counted per person,
   * largest first, cut at `limit`: `statuses` and `kinds` filter as a listing does.
   */
  otherPeopleCounts(input: {
    readonly workspaceId: string;
    readonly excludePrincipalId: string;
    readonly statuses?: readonly MemoryStatus[];
    readonly kinds?: readonly MemoryKind[];
    readonly limit: number;
  }): readonly { readonly principalId: string; readonly count: number }[];
  /** Every person with personal memory in `statuses` that belongs with the workspace, uncapped (`principals`). */
  workspacePrincipals(input: { readonly workspaceId: string; readonly statuses: readonly MemoryStatus[] }): readonly string[];
  /** Proposals in the operator's page for `principalId` in `workspaceId` (`counts`). */
  countOperatorProposals(input: { readonly workspaceId: string; readonly principalId: string }): number;
  /** Each chat's notes in force or waiting — its durable `run_local` records of `principalId`, approved or proposed — by chat (`counts`). */
  countChatNotes(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly taskIds: readonly string[];
  }): Readonly<Record<string, number>>;
  /**
   * Distinct chats (`tavi_task_memory_use.task_id`) that used each record in
   * `recordIds`. With `sinceCurrentRevision: true`, counts only uses at or
   * after the record's current revision was recorded (`u.last_used_at >= v.recorded_at`).
   */
  recordUseCounts(input: {
    readonly recordIds: readonly string[];
    readonly sinceCurrentRevision?: boolean;
  }): Readonly<Record<string, number>>;
  /** Approved records in force at `now` in the scopes (sensitive and local-origin ones left out unless asked): the relevance floor's rarity base. */
  countCurrent(input: {
    readonly scopeKeys: readonly string[];
    readonly now: string;
    readonly includeSensitive?: boolean;
    readonly excludeLocalOrigin?: boolean;
  }): number;
  /**
   * The profile's candidates, bounded: in-force, non-sensitive lessons in
   * `lessonScopeKeys` (most chats used first, then newest) and core `me.*`
   * facts in `factScopeKeys` (newest first; never `me.belief*`,
   * `me.opinion*` or `me.home_area`), each cut at `limit`, with their
   * current revisions. Revisions citing `excludeSourceIds` are left out.
   */
  profileCandidates(input: {
    readonly lessonScopeKeys: readonly string[];
    readonly factScopeKeys: readonly string[];
    readonly now: string;
    readonly limit: number;
    readonly excludeLocalOrigin?: boolean;
    readonly excludeSourceIds?: readonly string[];
  }): {
    readonly lessons: readonly { readonly record: MemoryRecord; readonly revision: MemoryRevision; readonly usedChats: number }[];
    readonly facts: readonly { readonly record: MemoryRecord; readonly revision: MemoryRevision }[];
  };
}

export type MemoryRepositoryPort = AsyncRepository<MemoryRepositoryPortDefinition>;
