import { memoryExactAndStemSet, memoryQueryTerms, memoryTermMatchesSet } from "../../memory/rules.js";
import { nearDuplicateVectorPairs, scoreVectors, unitVector, vectorBytes, vectorFromBytes } from "../../memory/vectors.js";
import type { MemoryRepositoryPort } from "../internal-contracts.js";
import {
  MAX_SEARCH_SNIPPET_CHARS,
  TaviError,
  MEMORY_EXCERPT_SNIPPET_TOKENS,
  MEMORY_MMR_COSINE_THRESHOLD,
  MEMORY_RRF_K,
  memoryCardTitleOf,
  memoryExcerptOf,
  memoryScopeKey,
  memoryTokenSet,
  type EvidenceSource,
  type LineageEdge,
  type MemoryCaptureSourceStats,
  type MemoryDeletion,
  type MemoryKind,
  type MemoryRecord,
  type MemoryReview,
  type MemoryRevision,
  type MemoryScope,
  type MemoryStatus,
  type PreferenceValue,
  MEMORY_CARD_FORGOTTEN_SUMMARY,
  MEMORY_MERGE_INPUT_FORGOTTEN,
  MEMORY_RESTORE_RECONCILE_REASON,
  MAX_LIVE_REVISION_IDS,
} from "@tavi/contracts";
import { nowTimestamp } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";
import { deleteIdeasCiting, unquoteIdeasCiting } from "../ideas-repository.js";
import type { StoreContext } from "./context.js";
import { noteErasure } from "../erasure.js";
import {
  OPERATOR_MEMORY,
  PENDING_PROVIDER_VALID,
  VECTOR_ELIGIBLE_SQL,
  WORKSPACE_PERSONAL_MEMORY,
  memoryVectorText,
  pendingProvidersOf,
  pendingProvidersSql,
  scopeKeyFilter,
  toEvidenceSource,
  toLineageEdge,
  toMemoryDeletion,
  toMemoryRecord,
  toMemoryReview,
  toMemoryRevision,
  toMemoryScope,
  type EvidenceSourceRow,
  type LineageEdgeRow,
  type MemoryDeletionRow,
  type MemoryRecordRow,
  type MemoryReviewRow,
  type MemoryRevisionRow,
  type MemorySearchRow,
} from "./memory-rows.js";
import { parseJsonColumn } from "./stored-values.js";

/**
 * `#searchSupersededFacts`'s SQL prefilter over a candidate's title, body and
 * keywords: recall-safe, never stricter than the exact-and-stem check it
 * precedes. Each query token must appear as a substring by the shared prefix
 * of its exact form and stem, less the two characters a Porter suffix
 * rewrite can change (`LIKE` folds ASCII case; clitic stripping only removes
 * characters). A token too short for a safe prefix, or not ASCII, does not
 * narrow, and a candidate whose text holds non-ASCII characters (diacritics
 * the fold would remove) always passes.
 */
function supersededTermFilter(
  terms: readonly { readonly tokens: readonly { readonly exact: string; readonly stem: string }[] }[],
  isAny: boolean,
): { readonly sql: string; readonly parameters: readonly string[] } {
  const text = "(COALESCE(title, '') || ' ' || COALESCE(body, '') || ' ' || COALESCE(keywords_json, ''))";
  const parameters: string[] = [];
  const clauses = terms.map((term) => {
    const tokenClauses = term.tokens.flatMap((token) => {
      let shared = 0;
      while (shared < token.exact.length && shared < token.stem.length && token.exact[shared] === token.stem[shared]) shared += 1;
      const prefix = token.exact.slice(0, Math.min(shared, token.stem.length - 2));
      if (prefix.length < 3 || !/^[a-z0-9]+$/u.test(prefix)) return [];
      parameters.push(`%${prefix}%`);
      return [`${text} LIKE ?`];
    });
    return tokenClauses.length === 0 ? "1" : `(${tokenClauses.join(" AND ")})`;
  });
  const matched = clauses.length === 0 ? "1" : `(${clauses.join(isAny ? " OR " : " AND ")})`;
  return { sql: `(${matched} OR length(CAST(${text} AS BLOB)) <> length(${text}))`, parameters };
}

export function appendSnippetNote(snippet: string, note: string): string {
  const suffix = ` ${note}`;
  if (snippet.length + suffix.length <= MAX_SEARCH_SNIPPET_CHARS) {
    return `${snippet}${suffix}`;
  }
  const headBudget = Math.max(0, MAX_SEARCH_SNIPPET_CHARS - suffix.length - 1);
  return `${snippet.slice(0, headBudget).trimEnd()}…${suffix}`;
}

/** `countChatNotes`' query for `taskCount` task ids: parameters are the principal, the workspace, then each task id. */
export function countChatNotesSql(taskCount: number): string {
  return `SELECT m.run_id, count(*) AS n FROM tavi_memory_records m INDEXED BY tavi_memory_chat_notes_idx
        WHERE m.scope_kind = 'run_local' AND m.durable = 1 AND m.principal_id = ? AND m.workspace_id = ? AND m.status IN ('approved', 'proposed')
          AND m.run_id IN (${Array.from({ length: taskCount }, () => "?").join(", ")})
        GROUP BY m.run_id`;
}

/**
 * Personal memory storage.
 *
 * Two invariants live here rather than in the service, because a service must not
 * be able to bypass them:
 *
 *  - **authorization is a SQL filter.** Every read takes the authorized scope-key
 *    set and filters on it, so a caller cannot obtain another principal's rows by
 *    asking nicely. Returned rows are still re-verified by the service;
 *  - **canonical and search state change together.** A revision is inserted and
 *    indexed in one transaction, and forgetting tombstones, de-indexes, bumps the
 *    scope's revocation generation and journals the deletion in one transaction.
 *    There is deliberately no best-effort post-commit indexing for this path.
 */
export class SqliteMemoryRepository implements MemoryRepositoryPort {
  readonly #store: StoreContext;

  constructor(store: StoreContext) {
    this.#store = store;
  }

  insertRecord(input: {
    readonly record: MemoryRecord;
    readonly revision: MemoryRevision;
    readonly preference?: PreferenceValue;
    readonly contentKey?: string;
  }): void {
    this.#store.transaction(() => {
      this.#insertRecordRow(input.record, input.contentKey);
      this.#insertRevisionRow(input.revision, input.preference);
      this.#indexRevision(input.revision);
    });
  }

  /**
   * Replace an approved value with a new revision, in one transaction.
   *
   * The compare-and-set runs *first*, against the record row; the new revision
   * is inserted only when it wins. A lost CAS therefore writes nothing — no
   * orphan revision, no index change — where the previous implementation
   * inserted the revision before the CAS and left a "PHANTOM-CORRECTION" row
   * behind when the CAS lost. On success the previous revision is marked
   * `superseded` with its `valid_to` closed, and the new one starts its own
   * interval at `now`.
   *
   * The record's own end dates are kept unless given: a fact's
   * `valid_to` is when it ends, not a closed interval, so an *Edit* must not
   * drop it. `expectedStatus: "expired"` revives an expired record.
   */
  correctRevision(input: {
    readonly recordId: string;
    readonly expectedCurrentRevisionId: string | null;
    readonly revision: MemoryRevision;
    readonly preference?: PreferenceValue;
    readonly now: string;
    readonly expectedStatus?: "approved" | "expired";
    readonly validTo?: string | null;
    readonly expiryAt?: string | null;
    readonly topicKey?: string;
    readonly contentKey?: string | null;
  }): boolean {
    return this.#store.transaction(() => {
      const result = this.#store.handle
        .prepare(
          `UPDATE tavi_memory_records
              SET current_revision_id = @newRevisionId,
                  status = 'approved',
                  valid_from = @now,
                  valid_to = CASE WHEN @validToProvided THEN @validTo ELSE valid_to END,
                  expiry_at = CASE WHEN @expiryAtProvided THEN @expiryAt ELSE expiry_at END,
                  topic_key = CASE WHEN @topicKeyProvided THEN @topicKey ELSE topic_key END,
                  content_key = CASE WHEN @contentKeyProvided THEN @contentKey ELSE content_key END,
                  updated_at = @now
            WHERE record_id = @recordId
              AND status = @expectedStatus
              AND COALESCE(current_revision_id, '') = COALESCE(@expectedCurrentRevisionId, '')
              AND (@topicKeyProvided = 0 OR topic_key IS NULL)`,
        )
        .run({
          recordId: input.recordId,
          newRevisionId: input.revision.revisionId,
          now: input.now,
          expectedCurrentRevisionId: input.expectedCurrentRevisionId,
          expectedStatus: input.expectedStatus ?? "approved",
          validToProvided: input.validTo === undefined ? 0 : 1,
          validTo: input.validTo ?? null,
          expiryAtProvided: input.expiryAt === undefined ? 0 : 1,
          expiryAt: input.expiryAt ?? null,
          topicKeyProvided: input.topicKey === undefined ? 0 : 1,
          topicKey: input.topicKey ?? null,
          contentKeyProvided: input.contentKey === undefined ? 0 : 1,
          contentKey: input.contentKey ?? null,
        });
      if (result.changes === 0) return false;
      // A new revision: ideas quoting the old words stop quoting them (invariant 1); the next look quotes the new ones.
      unquoteIdeasCiting(this.#store.handle, input.recordId, input.now);
      if (input.expectedCurrentRevisionId !== null) {
        this.#store.handle
          .prepare(
            `UPDATE tavi_memory_revisions
                SET status = 'superseded', superseded_by_revision_id = @newRevisionId, valid_to = @now
              WHERE revision_id = @previousRevisionId`,
          )
          .run({
            previousRevisionId: input.expectedCurrentRevisionId,
            newRevisionId: input.revision.revisionId,
            now: input.now,
          });
      }
      this.#insertRevisionRow(input.revision, input.preference, { status: "active", validFrom: input.now });
      // The previous revision's row is replaced, so search never matches a
      // revision that is no longer current for its record; its vector goes
      // with it, and the new one is embedded by the backfill.
      this.#deleteIndexRows(input.recordId);
      this.#dropVectors(input.recordId);
      this.#indexRevision(input.revision);
      return true;
    });
  }

  getRecord(recordId: string): MemoryRecord | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_memory_records WHERE record_id = ?").get(recordId) as
      | MemoryRecordRow
      | undefined;
    return row === undefined ? undefined : toMemoryRecord(row);
  }

  findByContent(input: {
    readonly scopeKey: string;
    readonly kind: MemoryKind;
    readonly contentKey: string;
    readonly now: string;
    readonly limit: number;
  }): readonly MemoryRecord[] {
    // Live only (`memoryRecordIsLive`): a pending proposal or an approved record, either in force at `now`.
    return (
      this.#store.handle
        .prepare(
          `SELECT * FROM tavi_memory_records
          WHERE scope_key = @scopeKey AND kind = @kind AND content_key = @contentKey
            AND status IN ('proposed', 'approved') AND (valid_to IS NULL OR valid_to > @now) AND (expiry_at IS NULL OR expiry_at > @now)
          ORDER BY recorded_at, record_id LIMIT @limit`,
        )
        .all({
          scopeKey: input.scopeKey,
          kind: input.kind,
          contentKey: input.contentKey,
          now: input.now,
          limit: input.limit,
        }) as MemoryRecordRow[]
    ).map(toMemoryRecord);
  }

  keyHolders(input: {
    readonly scopeKey: string;
    readonly kind: "preference" | "fact";
    readonly key: string;
    readonly now: string;
    readonly excludeRecordId?: string;
  }): readonly MemoryRecord[] {
    const column = input.kind === "preference" ? "preference_key" : "topic_key";
    return (
      this.#store.handle
        .prepare(
          `SELECT * FROM tavi_memory_records
          WHERE scope_key = @scopeKey AND kind = @kind AND ${column} = @key AND status = 'approved'
            AND (valid_to IS NULL OR valid_to > @now) AND (expiry_at IS NULL OR expiry_at > @now)
            AND record_id <> @exclude
          ORDER BY updated_at DESC, record_id LIMIT 20`,
        )
        .all({
          scopeKey: input.scopeKey,
          kind: input.kind,
          key: input.key,
          now: input.now,
          exclude: input.excludeRecordId ?? "",
        }) as MemoryRecordRow[]
    ).map(toMemoryRecord);
  }

  listRecords(input: {
    readonly scopeKeys: readonly string[];
    readonly kinds?: readonly MemoryKind[];
    readonly statuses?: readonly MemoryStatus[];
    readonly originTaskId?: string;
    readonly past?: { readonly now: string };
    readonly lapsedExpiry?: { readonly now: string };
    readonly limit: number;
    readonly offset?: number;
  }): readonly MemoryRecord[] {
    if (input.scopeKeys.length === 0) return [];
    const scoped = scopeKeyFilter(input.scopeKeys, "");
    const clauses = [scoped.sql];
    const parameters: unknown[] = [...scoped.parameters];
    if (input.kinds !== undefined && input.kinds.length > 0) {
      clauses.push(`kind IN (${input.kinds.map(() => "?").join(", ")})`);
      parameters.push(...input.kinds);
    }
    if (input.past !== undefined) {
      // `memoryRecordIsPast` in SQL: an ended or lapsed approved record, or an expired one that had been approved.
      clauses.push(
        `((status = 'approved' AND ((valid_to IS NOT NULL AND valid_to <= ?) OR (expiry_at IS NOT NULL AND expiry_at <= ?)))
          OR (status = 'expired' AND current_revision_id IS NOT NULL))`,
      );
      parameters.push(input.past.now, input.past.now);
    } else if (input.lapsedExpiry !== undefined) {
      clauses.push("status = 'approved' AND expiry_at IS NOT NULL AND expiry_at <= ?");
      parameters.push(input.lapsedExpiry.now);
    } else if (input.statuses !== undefined && input.statuses.length > 0) {
      clauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`);
      parameters.push(...input.statuses);
    }
    if (input.originTaskId !== undefined) {
      clauses.push("origin_task_id = ?");
      parameters.push(input.originTaskId);
    }
    parameters.push(input.limit, input.offset ?? 0);
    const rows = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_memory_records WHERE ${clauses.join(" AND ")}
          ORDER BY updated_at DESC, record_id LIMIT ? OFFSET ?`,
      )
      .all(...parameters) as MemoryRecordRow[];
    return rows.map(toMemoryRecord);
  }

  listRevisions(recordId: string): readonly MemoryRevision[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_memory_revisions WHERE record_id = ? ORDER BY revision_number DESC")
      .all(recordId) as MemoryRevisionRow[];
    return rows.map(toMemoryRevision);
  }

  getRevision(revisionId: string): MemoryRevision | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_memory_revisions WHERE revision_id = ?").get(revisionId) as
      | MemoryRevisionRow
      | undefined;
    return row === undefined ? undefined : toMemoryRevision(row);
  }

  liveRevisionIds(revisionIds: readonly string[]): readonly string[] {
    const ids = [...new Set(revisionIds)];
    if (ids.length === 0) return [];
    if (ids.length > MAX_LIVE_REVISION_IDS)
      throw new TaviError("INVALID_INPUT", `At most ${MAX_LIVE_REVISION_IDS} revision ids are checked at once`);
    // By the revision's primary key; a forgotten record's revisions are deleted, so they never match.
    const rows = this.#store.handle
      .prepare(
        `SELECT r.revision_id FROM tavi_memory_revisions r JOIN tavi_memory_records m ON m.record_id = r.record_id
          WHERE r.revision_id IN (SELECT value FROM json_each(?))
            AND r.status <> 'revoked' AND m.status NOT IN ('revoked', 'deleted', 'rejected')`,
      )
      .all(JSON.stringify(ids)) as { revision_id: string }[];
    return rows.map((row) => row.revision_id);
  }

  applyLifecycle(input: {
    readonly recordId: string;
    readonly expectedCurrentRevisionId: string | null;
    readonly expectedStatus?: MemoryStatus;
    readonly status: MemoryStatus;
    readonly currentRevisionId?: string | null;
    readonly validFrom?: string | null;
    readonly validTo?: string | null;
    readonly updatedAt: string;
    /** Reindex when the record becomes approved, so approval makes it findable. */
    readonly reindexOnApproval?: boolean;
  }): boolean {
    return this.#store.transaction(() => {
      // The compare-and-set covers the revision *and* the lifecycle state, and a
      // tombstoned or revoked record is never revived by an ordinary update:
      // without those two guards a stale caller could flip a forgotten record
      // back to `approved` while its revisions are already gone.
      // `valid_from`/`valid_to` are protected the same way `current_revision_id`
      // is: a caller that omits them (e.g. `revoke`, which sets only `validTo`)
      // must not silently null out the other one. `@validFromProvided`/
      // `@validToProvided` distinguish "not supplied" from "explicitly cleared".
      const result = this.#store.handle
        .prepare(
          `UPDATE tavi_memory_records
              SET status = @status,
                  current_revision_id = COALESCE(@currentRevisionId, current_revision_id),
                  valid_from = CASE WHEN @validFromProvided THEN @validFrom ELSE valid_from END,
                  valid_to = CASE WHEN @validToProvided THEN @validTo ELSE valid_to END,
                  updated_at = @updatedAt
            WHERE record_id = @recordId
              AND status NOT IN ('deleted', 'revoked')
              AND status = COALESCE(@expectedStatus, status)
              AND COALESCE(current_revision_id, '') = COALESCE(@expectedCurrentRevisionId, '')`,
        )
        .run({
          recordId: input.recordId,
          expectedCurrentRevisionId: input.expectedCurrentRevisionId,
          expectedStatus: input.expectedStatus ?? null,
          status: input.status,
          currentRevisionId: input.currentRevisionId ?? null,
          validFromProvided: input.validFrom === undefined ? 0 : 1,
          validFrom: input.validFrom ?? null,
          validToProvided: input.validTo === undefined ? 0 : 1,
          validTo: input.validTo ?? null,
          updatedAt: input.updatedAt,
        });
      if (result.changes === 0) return false;
      // No longer approved (rejected, archived, revoked, expired…): ideas never quote what recall would not use (invariant 1).
      if (input.status !== "approved") unquoteIdeasCiting(this.#store.handle, input.recordId, input.updatedAt);
      if (input.status === "approved" && input.reindexOnApproval !== false) {
        const revisionId =
          input.currentRevisionId ??
          (
            this.#store.handle.prepare("SELECT current_revision_id FROM tavi_memory_records WHERE record_id = ?").get(input.recordId) as
              | { current_revision_id: string | null }
              | undefined
          )?.current_revision_id ??
          null;
        if (revisionId !== null) {
          // The revision's own interval starts here too, so `asOf` inspection
          // can answer "when was this first approved" for the very first
          // revision, not only for one that later went through a correction.
          this.#store.handle
            .prepare(
              `UPDATE tavi_memory_revisions SET valid_from = COALESCE(valid_from, @validFrom)
                WHERE revision_id = @revisionId`,
            )
            .run({ revisionId, validFrom: input.validFrom ?? input.updatedAt });
          const revision = this.getRevision(revisionId);
          // A proposal becomes searchable exactly when it is approved: indexing
          // only at insert time would leave approved memory unfindable.
          if (revision !== undefined) {
            this.#deleteIndexRow(revision.revisionId);
            this.#indexRevision(revision);
          }
        }
      }
      // A record that leaves `approved` (expired, revoked, superseded,
      // rejected) loses its vectors in this transaction.
      if (input.status !== "approved") this.#dropVectors(input.recordId);
      if (input.status === "revoked") {
        // The current revision closes its own interval alongside the record:
        // both stop being "active" through the same compare-and-set.
        this.#store.handle
          .prepare(
            `UPDATE tavi_memory_revisions SET status = 'revoked', valid_to = COALESCE(valid_to, @validTo)
              WHERE record_id = @recordId AND status = 'active'`,
          )
          .run({ recordId: input.recordId, validTo: input.validTo ?? input.updatedAt });
      }
      return true;
    });
  }

  recordReview(review: MemoryReview): void {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_memory_reviews
           (review_id, record_id, revision_id, revision_hash, reviewer_principal_id, decision, reason, decided_at)
         VALUES (@reviewId, @recordId, @revisionId, @revisionHash, @reviewerPrincipalId, @decision, @reason, @decidedAt)`,
      )
      .run({
        reviewId: review.reviewId,
        recordId: review.recordId,
        revisionId: review.revisionId,
        revisionHash: review.revisionHash,
        reviewerPrincipalId: review.reviewerPrincipalId,
        decision: review.decision,
        reason: review.reason ?? null,
        decidedAt: review.decidedAt,
      });
  }

  listReviews(recordId: string): readonly MemoryReview[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_memory_reviews WHERE record_id = ? ORDER BY decided_at DESC")
      .all(recordId) as MemoryReviewRow[];
    return rows.map(toMemoryReview);
  }

  insertEvidence(source: EvidenceSource): void {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_evidence_sources
           (source_id, scope_key, record_id, revision_id, conversation_id, message_id, artifact_id,
            operator_input, observed_at, content_hash, capture_basis, retention_policy,
            revocation_status, access_revoked_at, claimed_author)
         VALUES (@sourceId, @scopeKey, @recordId, @revisionId, @conversationId, @messageId, @artifactId,
                 @operatorInput, @observedAt, @contentHash, @captureBasis, @retentionPolicy,
                 @revocationStatus, @accessRevokedAt, @claimedAuthor)`,
      )
      .run({
        sourceId: source.sourceId,
        scopeKey: source.scopeKey,
        recordId: source.recordId ?? null,
        revisionId: source.revisionId ?? null,
        conversationId: source.conversationId ?? null,
        messageId: source.messageId ?? null,
        artifactId: source.artifactId ?? null,
        operatorInput: source.operatorInput ? 1 : 0,
        observedAt: source.observedAt,
        contentHash: source.contentHash,
        captureBasis: source.captureBasis,
        retentionPolicy: source.retentionPolicy,
        revocationStatus: source.revocationStatus,
        accessRevokedAt: source.accessRevokedAt ?? null,
        claimedAuthor: source.claimedAuthor ?? null,
      });
  }

  listEvidence(input: { readonly scopeKeys: readonly string[]; readonly limit: number }): readonly EvidenceSource[] {
    if (input.scopeKeys.length === 0) return [];
    const placeholders = input.scopeKeys.map(() => "?").join(", ");
    const rows = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_evidence_sources WHERE scope_key IN (${placeholders})
          ORDER BY observed_at DESC LIMIT ?`,
      )
      .all(...input.scopeKeys, input.limit) as EvidenceSourceRow[];
    return rows.map(toEvidenceSource);
  }

  insertLineage(edge: LineageEdge): void {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_lineage_edges
           (edge_id, from_revision_id, to_revision_id, claim_id, dependency_kind, derived_freshness,
            freshness_reason, affected_source_ids_json, last_validated_generation)
         VALUES (@edgeId, @fromRevisionId, @toRevisionId, @claimId, @dependencyKind, @derivedFreshness,
                 @freshnessReason, @affectedSourceIdsJson, @lastValidatedGeneration)`,
      )
      .run({
        edgeId: edge.edgeId,
        fromRevisionId: edge.fromRevisionId,
        toRevisionId: edge.toRevisionId,
        claimId: edge.claimId ?? null,
        dependencyKind: edge.dependencyKind,
        derivedFreshness: edge.derivedFreshness,
        freshnessReason: edge.freshnessReason ?? null,
        affectedSourceIdsJson: JSON.stringify(edge.affectedSourceIds),
        lastValidatedGeneration: edge.lastValidatedGeneration,
      });
  }

  listLineage(input: { readonly toRevisionId: string }): readonly LineageEdge[] {
    const rows = this.#store.handle
      .prepare("SELECT * FROM tavi_lineage_edges WHERE to_revision_id = ? ORDER BY edge_id")
      .all(input.toRevisionId) as LineageEdgeRow[];
    return rows.map(toLineageEdge);
  }

  forget(input: { readonly recordId: string; readonly deletion: MemoryDeletion; readonly updatedAt: string }): void {
    this.#store.transaction(() => {
      const record = this.#store.handle.prepare("SELECT scope_key FROM tavi_memory_records WHERE record_id = ?").get(input.recordId) as
        | { scope_key: string }
        | undefined;
      if (record === undefined) {
        throw new TaviError("NOT_FOUND", `Memory record ${input.recordId} does not exist`);
      }
      // Search rows are removed *first*: the removal locates them through the
      // revision rows, so deleting the revisions first would silently leave the
      // erased body in the index. The ids are kept for the lineage update.
      const erasedRevisionIds = (
        this.#store.handle.prepare("SELECT revision_id FROM tavi_memory_revisions WHERE record_id = ?").all(input.recordId) as {
          revision_id: string;
        }[]
      ).map((row) => row.revision_id);
      this.#deleteIndexRows(input.recordId);
      noteErasure(this.#store.handle);
      // Its vectors go now, and leave the worker's cache (invariant 9).
      this.#dropVectors(input.recordId);
      // The body is erased and the revision texts are dropped; the record row
      // survives as a tombstone so a replay cannot resurrect it.
      this.#store.handle.prepare("DELETE FROM tavi_memory_revisions WHERE record_id = ?").run(input.recordId);
      // Its rows on memory cards go too (invariant 9): the card then
      // shows it as forgotten, and its token answers nothing. `record_id`
      // has no foreign key, so nothing cascades from the record.
      const cards = this.#store.handle
        .prepare("SELECT DISTINCT notice_id FROM tavi_memory_prompts WHERE record_id = ?")
        .all(input.recordId) as { notice_id: string }[];
      this.#store.handle.prepare("DELETE FROM tavi_memory_prompts WHERE record_id = ?").run(input.recordId);
      // Ideas that quoted it go with it: their "why this" would repeat what was forgotten.
      deleteIdeasCiting(this.#store.handle, input.recordId);
      // A card left with no rows says so in its summary, so it still reads
      // as forgotten after the week the sweep keeps a decided card's rows.
      const emptied = this.#store.handle.prepare(
        "UPDATE tavi_chat_notices SET summary = ? WHERE notice_id = ? AND NOT EXISTS (SELECT 1 FROM tavi_memory_prompts p WHERE p.notice_id = tavi_chat_notices.notice_id)",
      );
      for (const card of cards) emptied.run(MEMORY_CARD_FORGOTTEN_SUMMARY, card.notice_id);
      // Evidence pointing at the erased record stops being usable, and lineage
      // through it is marked blocked: both are content-free states that keep a
      // dependency from being read as still valid.
      this.#store.handle
        .prepare(
          `UPDATE tavi_evidence_sources
              SET revocation_status = 'revoked', access_revoked_at = @updatedAt
            WHERE record_id = @recordId AND revocation_status <> 'revoked'`,
        )
        .run({ recordId: input.recordId, updatedAt: input.updatedAt });
      // Lineage rows that pointed *from* the erased revisions are updated per
      // `dependency_kind` — not
      // collapsed into one state, since the three kinds mean different
      // things and a future regenerator/reviewer needs to tell them apart:
      //  - `requires`: the dependent's operational correctness depends on
      //    this source outright, with nothing to regenerate from — `blocked`.
      //  - `contains`: the dependent copied/synthesized this source's
      //    content — also `blocked` ("exclude that derived record until
      //    rebuilt"), but `affected_source_ids_json` additionally records
      //    which forgotten record must be excluded when it is regenerated,
      //    which a plain `requires` block has no equivalent of.
      //  - `background`: a contextual citation with no retained content or
      //    necessary premise — `dirty` for review, not blocked: ordinary
      //    staleness does not cancel unrelated work.
      //    `freshness_reason` reflects only this transition, not a
      //    compounding history — an already-`dirty` row for an unrelated
      //    reason is left as-is (single reason field, no multi-cause
      //    tracking, an intentional simplification). The further "remove
      //    the obsolete citation" step is content-rewrite
      //    work for the not-yet-built regenerator that reads this state,
      //    not for `forget()` itself.
      // The revision ids are captured before deletion, because afterwards
      // nothing links the edge to the record.
      for (const revisionId of erasedRevisionIds) {
        this.#store.handle
          .prepare(
            `UPDATE tavi_lineage_edges
                SET derived_freshness = 'blocked',
                    freshness_reason = 'source forgotten (required dependency)'
              WHERE from_revision_id = ? AND dependency_kind = 'requires' AND derived_freshness <> 'blocked'`,
          )
          .run(revisionId);
        this.#store.handle
          .prepare(
            `UPDATE tavi_lineage_edges
                SET derived_freshness = 'dirty',
                    freshness_reason = 'source forgotten (background citation, needs review)'
              WHERE from_revision_id = ? AND dependency_kind = 'background' AND derived_freshness NOT IN ('dirty', 'blocked')`,
          )
          .run(revisionId);
        const containsRows = this.#store.handle
          .prepare(
            `SELECT edge_id, affected_source_ids_json FROM tavi_lineage_edges
              WHERE from_revision_id = ? AND dependency_kind = 'contains'`,
          )
          .all(revisionId) as { readonly edge_id: string; readonly affected_source_ids_json: string }[];
        for (const row of containsRows) {
          const affected = new Set(parseJsonColumn<string[]>(row.affected_source_ids_json, "affected source ids"));
          affected.add(input.recordId);
          this.#store.handle
            .prepare(
              `UPDATE tavi_lineage_edges
                  SET derived_freshness = 'blocked',
                      freshness_reason = 'source forgotten (contained content must be excluded and regenerated)',
                      affected_source_ids_json = ?
                WHERE edge_id = ?`,
            )
            .run(JSON.stringify([...affected]), row.edge_id);
        }
      }
      // A tidy-up still waiting that would supersede it (consolidation's
      // `contains` edges into a proposal's revision) is forgotten with it:
      // it holds a merge of the forgotten words. Erased, with its own journal
      // row, as whoever forgot the input.
      const merges = this.#store.handle.prepare(
        `SELECT DISTINCT v.record_id, r.scope_key FROM tavi_lineage_edges e
           JOIN tavi_memory_revisions v ON v.revision_id = e.to_revision_id
           JOIN tavi_memory_records r ON r.record_id = v.record_id
          WHERE e.from_revision_id = ? AND e.dependency_kind = 'contains' AND r.status = 'proposed' AND r.record_id <> ?`,
      );
      const erasedMerges = new Map<string, string>();
      for (const revisionId of erasedRevisionIds) {
        for (const row of merges.all(revisionId, input.recordId) as { readonly record_id: string; readonly scope_key: string }[])
          erasedMerges.set(row.record_id, row.scope_key);
      }
      for (const [recordId, scopeKey] of erasedMerges) {
        this.forget({
          recordId,
          deletion: {
            deletionId: prefixedId("memdel"),
            recordId,
            scopeKey,
            deletionGeneration: this.revocationGeneration(scopeKey) + 1,
            requestedBy: input.deletion.requestedBy,
            reason: MEMORY_MERGE_INPUT_FORGOTTEN,
            requestedAt: input.updatedAt,
            cleanupStatus: "pending",
          },
          updatedAt: input.updatedAt,
        });
      }
      // The scope generation moves even when this record's own generation is
      // lower than another record's: caches reconcile against the scope.
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_memory_scope_generations (scope_key, revocation_generation)
           VALUES (@scopeKey, @generation)
           ON CONFLICT(scope_key) DO UPDATE SET
             revocation_generation = tavi_memory_scope_generations.revocation_generation + 1`,
        )
        .run({ scopeKey: record.scope_key, generation: input.deletion.deletionGeneration });
      this.#store.handle
        .prepare(
          `UPDATE tavi_memory_records
              SET status = 'deleted',
                  current_revision_id = NULL,
                  content_key = NULL,
                  valid_to = @updatedAt,
                  revocation_generation = revocation_generation + 1,
                  updated_at = @updatedAt
            WHERE record_id = @recordId`,
        )
        .run({ recordId: input.recordId, updatedAt: input.updatedAt });
      // The journal carries scope and generation only; the body is already gone.
      // Its status is recorded here rather than taken from the caller: this
      // transaction is what performs the cleanup, so it is also what may claim it.
      const generation = this.revocationGeneration(record.scope_key);
      this.#store.handle
        .prepare(
          `INSERT INTO tavi_memory_deletions
             (deletion_id, record_id, scope_key, deletion_generation, requested_by, reason,
              requested_at, cleanup_status, cleaned_at)
           VALUES (@deletionId, @recordId, @scopeKey, @deletionGeneration, @requestedBy, @reason,
                   @requestedAt, 'pending', NULL)`,
        )
        .run({
          deletionId: input.deletion.deletionId,
          recordId: input.deletion.recordId,
          scopeKey: record.scope_key,
          deletionGeneration: generation,
          requestedBy: input.deletion.requestedBy,
          reason: input.deletion.reason,
          requestedAt: input.deletion.requestedAt,
        });
      this.#store.handle
        .prepare(
          `UPDATE tavi_memory_deletions
              SET cleanup_status = 'complete', cleaned_at = @updatedAt
            WHERE deletion_id = @deletionId`,
        )
        .run({ deletionId: input.deletion.deletionId, updatedAt: input.updatedAt });
    });
  }

  /** The records a deletion journal row names that are not erased: what the start-up pass forgets again. */
  recordsToReconcile(): readonly string[] {
    // `CROSS JOIN` keeps the journal as the outer loop: with `tavi_memory_deletions_record_idx` the planner
    // would otherwise walk every memory record to probe the (smaller) journal.
    return (
      this.#store.handle
        .prepare(
          `SELECT DISTINCT r.record_id FROM tavi_memory_deletions d
             CROSS JOIN tavi_memory_records r ON r.record_id = d.record_id
            WHERE r.status <> 'deleted'
            ORDER BY r.record_id`,
        )
        .all() as { readonly record_id: string }[]
    ).map((row) => row.record_id);
  }

  /**
   * Forget one record the journal names again, as its newest row's
   * requester, through `forget`: its revisions and vectors, index rows,
   * prompt rows and waiting merges go, and a new journal row records it.
   */
  reconcileForget(recordId: string, now: string): void {
    const journal = this.#store.handle
      .prepare(
        "SELECT scope_key, requested_by FROM tavi_memory_deletions WHERE record_id = ? ORDER BY requested_at DESC, deletion_id DESC LIMIT 1",
      )
      .get(recordId) as { readonly scope_key: string; readonly requested_by: string } | undefined;
    const record = this.#store.handle.prepare("SELECT scope_key, status FROM tavi_memory_records WHERE record_id = ?").get(recordId) as
      | { readonly scope_key: string; readonly status: string }
      | undefined;
    if (journal === undefined || record === undefined || record.status === "deleted") return;
    this.forget({
      recordId,
      deletion: {
        deletionId: prefixedId("memdel"),
        recordId,
        scopeKey: record.scope_key,
        deletionGeneration: this.revocationGeneration(record.scope_key) + 1,
        requestedBy: journal.requested_by,
        reason: MEMORY_RESTORE_RECONCILE_REASON,
        requestedAt: now,
        cleanupStatus: "pending",
      },
      updatedAt: now,
    });
  }

  listDeletions(input: { readonly scopeKeys: readonly string[]; readonly limit: number }): readonly MemoryDeletion[] {
    if (input.scopeKeys.length === 0) return [];
    const placeholders = input.scopeKeys.map(() => "?").join(", ");
    const rows = this.#store.handle
      .prepare(
        `SELECT * FROM tavi_memory_deletions WHERE scope_key IN (${placeholders})
          ORDER BY requested_at DESC LIMIT ?`,
      )
      .all(...input.scopeKeys, input.limit) as MemoryDeletionRow[];
    return rows.map(toMemoryDeletion);
  }

  getDeletion(deletionId: string): MemoryDeletion | undefined {
    const row = this.#store.handle.prepare("SELECT * FROM tavi_memory_deletions WHERE deletion_id = ?").get(deletionId) as
      | MemoryDeletionRow
      | undefined;
    return row === undefined ? undefined : toMemoryDeletion(row);
  }

  markDeletionPending(deletionId: string, providers: readonly string[] = []): void {
    this.#store.transaction(() => {
      const row = this.#store.handle
        .prepare("SELECT pending_providers_json FROM tavi_memory_deletions WHERE deletion_id = ?")
        .get(deletionId) as { readonly pending_providers_json: string | null } | undefined;
      if (row === undefined) return;
      // Added to those it waits for already: a provider leaves the list only by taking the removal.
      const waiting = [
        ...new Set([
          ...pendingProvidersOf(row.pending_providers_json),
          ...providers.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128),
        ]),
      ].sort();
      this.#store.handle
        .prepare(
          "UPDATE tavi_memory_deletions SET cleanup_status = 'pending', cleaned_at = NULL, pending_providers_json = ? WHERE deletion_id = ?",
        )
        .run(waiting.length === 0 ? null : JSON.stringify(waiting), deletionId);
    });
  }

  pendingDeletions(limit: number, filter: { readonly provider?: string; readonly unassigned?: boolean } = {}): readonly MemoryDeletion[] {
    const named = `SELECT 1 FROM ${pendingProvidersSql("tavi_memory_deletions.pending_providers_json")} p WHERE ${PENDING_PROVIDER_VALID}`;
    const [where, args]: [string, string[]] =
      filter.provider !== undefined
        ? [` AND EXISTS (${named} AND p.value = ?)`, [filter.provider]]
        : filter.unassigned === true
          ? [` AND NOT EXISTS (${named})`, []]
          : ["", []];
    const rows = this.#store.handle
      .prepare(`SELECT * FROM tavi_memory_deletions WHERE cleanup_status = 'pending'${where} ORDER BY requested_at, deletion_id LIMIT ?`)
      .all(...args, Math.max(0, Math.min(limit, 1_000))) as MemoryDeletionRow[];
    return rows.map(toMemoryDeletion);
  }

  pendingDeletionCounts(): {
    readonly total: number;
    readonly byProvider: readonly { readonly provider: string; readonly removals: number }[];
  } {
    const total = (
      this.#store.handle.prepare("SELECT COUNT(*) AS n FROM tavi_memory_deletions WHERE cleanup_status = 'pending'").get() as {
        readonly n: number;
      }
    ).n;
    const byProvider = this.#store.handle
      .prepare(
        `SELECT p.value AS provider, COUNT(DISTINCT d.deletion_id) AS removals
           FROM tavi_memory_deletions d, ${pendingProvidersSql("d.pending_providers_json")} p
          WHERE d.cleanup_status = 'pending' AND ${PENDING_PROVIDER_VALID}
          GROUP BY p.value ORDER BY p.value`,
      )
      .all() as { readonly provider: string; readonly removals: number }[];
    return { total, byProvider };
  }

  completeDeletion(input: { readonly deletionId: string; readonly cleanedAt: string; readonly providerId?: string }): void {
    this.#store.transaction(() => {
      if (input.providerId !== undefined) {
        const row = this.#store.handle
          .prepare("SELECT pending_providers_json FROM tavi_memory_deletions WHERE deletion_id = ? AND cleanup_status = 'pending'")
          .get(input.deletionId) as { readonly pending_providers_json: string | null } | undefined;
        if (row === undefined) return;
        const waiting = pendingProvidersOf(row.pending_providers_json).filter((id) => id !== input.providerId);
        // Another provider still waits for it: the row stays pending, without this one.
        if (waiting.length > 0) {
          this.#store.handle
            .prepare("UPDATE tavi_memory_deletions SET pending_providers_json = ? WHERE deletion_id = ?")
            .run(JSON.stringify(waiting), input.deletionId);
          return;
        }
      }
      this.#store.handle
        .prepare(
          "UPDATE tavi_memory_deletions SET cleanup_status = 'complete', cleaned_at = @cleanedAt, pending_providers_json = NULL WHERE deletion_id = @deletionId AND cleanup_status = 'pending'",
        )
        .run({ deletionId: input.deletionId, cleanedAt: input.cleanedAt });
    });
  }

  revocationGeneration(scopeKey: string): number {
    const row = this.#store.handle
      .prepare("SELECT revocation_generation AS generation FROM tavi_memory_scope_generations WHERE scope_key = ?")
      .get(scopeKey) as { generation: number } | undefined;
    return row?.generation ?? 0;
  }

  deindex(recordId: string): void {
    this.#store.transaction(() => {
      this.#deleteIndexRows(recordId);
      this.#dropVectors(recordId);
    });
  }

  /**
   * Stored record count and body bytes inside the given scopes.
   *
   * Records are counted distinctly (a record with several revisions must not
   * multiply its own quota), and bytes are charged for the *current* revision
   * only — retained history is not charged, so a correction never inflates the
   * quota it is itself checked against.
   */
  usage(scopeKeys: readonly string[]): { readonly records: number; readonly bytes: number } {
    if (scopeKeys.length === 0) return { records: 0, bytes: 0 };
    const scoped = scopeKeyFilter(scopeKeys, "r");
    const row = this.#store.handle
      .prepare(
        `SELECT COUNT(DISTINCT r.record_id) AS records,
                COALESCE(SUM(LENGTH(CAST(COALESCE(v.body, '') AS BLOB)) +
                             LENGTH(CAST(COALESCE(v.title, '') AS BLOB))), 0) AS bytes
           FROM tavi_memory_records r
           LEFT JOIN tavi_memory_revisions v ON v.revision_id = r.current_revision_id
          WHERE ${scoped.sql} AND r.status <> 'deleted'`,
      )
      .get(...scoped.parameters) as { records: number; bytes: number };
    return { records: row.records, bytes: row.bytes };
  }

  search(input: {
    readonly scopeKeys: readonly string[];
    readonly query: string;
    readonly limit: number;
    readonly now: string;
    readonly includeSensitive?: boolean;
    readonly excludeLocalOrigin?: boolean;
    readonly excludeSourceIds?: readonly string[];
    readonly includePast?: boolean;
  }): readonly { readonly record: MemoryRecord; readonly revision: MemoryRevision; readonly snippet: string }[] {
    if (input.scopeKeys.length === 0 || input.query.trim() === "") return [];
    const scoped = scopeKeyFilter(input.scopeKeys, "r");
    const excluded = input.excludeSourceIds ?? [];
    const includePast = input.includePast === true;
    // Eligibility is filtered *before* ranking: an expired, superseded, revoked,
    // unapproved, sensitive (unless requested) or local-origin (when excluded)
    // record is not a search result at any rank.
    const queryTable = (table: "tavi_memory_fts" | "tavi_memory_fts_stem"): MemorySearchRow[] =>
      this.#store.handle
        .prepare(
          // Only identities and the snippet come from the search: the canonical
          // rows are fetched by id afterwards, so a stale index cannot return a
          // body that canonical memory no longer approves.
          `SELECT m.revision_id AS revision_id, r.record_id AS record_id,
                  snippet(${table}, 1, '[', ']', '…', ${MEMORY_EXCERPT_SNIPPET_TOKENS}) AS snippet
             FROM ${table}
             JOIN tavi_memory_fts_map m ON m.row_id = ${table}.rowid
             JOIN tavi_memory_revisions v ON v.revision_id = m.revision_id
             JOIN tavi_memory_records r ON r.record_id = v.record_id
            WHERE ${table} MATCH ?
              AND ${scoped.sql}
              AND r.status = 'approved'
              AND r.current_revision_id = v.revision_id
              ${input.includeSensitive === true ? "" : "AND r.sensitivity = 'normal' AND v.sensitivity = 'normal'"}
              ${input.excludeLocalOrigin === true ? "AND r.local_origin = 0" : ""}
              AND (r.valid_from IS NULL OR r.valid_from <= ?)
              AND (r.valid_to IS NULL OR r.valid_to > ?${includePast ? " OR r.kind = 'fact'" : ""})
              AND (r.expiry_at IS NULL OR r.expiry_at > ?)
              ${excluded.length === 0 ? "" : "AND NOT EXISTS (SELECT 1 FROM json_each(v.source_ids_json) s WHERE s.value IN (SELECT value FROM json_each(?)))"}
            ORDER BY bm25(${table}), r.updated_at DESC
            LIMIT ?`,
        )
        .all(
          input.query,
          ...scoped.parameters,
          input.now,
          input.now,
          input.now,
          ...(excluded.length === 0 ? [] : [JSON.stringify(excluded)]),
          input.limit,
        ) as MemorySearchRow[];

    const exactRows = queryTable("tavi_memory_fts");
    const stemRows = queryTable("tavi_memory_fts_stem");
    const isAny = input.query.includes('" OR "');
    const supersededRows = includePast
      ? this.#searchSupersededFacts({
          scopeKeys: input.scopeKeys,
          query: input.query,
          isAny,
          limit: input.limit,
          includeSensitive: input.includeSensitive === true,
          excludeLocalOrigin: input.excludeLocalOrigin === true,
          excluded,
        })
      : [];
    const supersededNoteByRevisionId = new Map(supersededRows.map((entry) => [entry.row.revision_id, entry.note]));
    let rows: MemorySearchRow[];
    if (!isAny) {
      // Under `match: "all"`, tiered: exact matches in their own bm25 order, then stem-only matches in theirs.
      const seen = new Set<string>();
      rows = [];
      for (const row of [...exactRows, ...stemRows, ...supersededRows.map((entry) => entry.row)]) {
        if (seen.has(row.revision_id)) continue;
        seen.add(row.revision_id);
        rows.push(row);
        if (rows.length >= input.limit) break;
      }
    } else {
      // Under `match: "any"`, RRF-fused (`1.0` for `tavi_memory_fts`, `0.5` for `tavi_memory_fts_stem`).
      const fused = new Map<string, { row: MemorySearchRow; score: number; order: number }>();
      let order = 0;
      exactRows.forEach((row, index) => {
        fused.set(row.revision_id, {
          row,
          score: 1.0 / (MEMORY_RRF_K + index + 1),
          order: order++,
        });
      });
      stemRows.forEach((row, index) => {
        const existing = fused.get(row.revision_id);
        const added = 0.5 / (MEMORY_RRF_K + index + 1);
        if (existing !== undefined) {
          existing.score += added;
          if (!String(existing.row.snippet ?? "").includes("[") && String(row.snippet ?? "").includes("[")) {
            existing.row = row;
          }
        } else {
          fused.set(row.revision_id, { row, score: added, order: order++ });
        }
      });
      supersededRows.forEach((entry, index) => {
        if (!fused.has(entry.row.revision_id)) {
          // Below a current exact match (1.0) at the same rank: a replaced value never outranks the one in force.
          const weight = entry.exactMatched ? 0.75 : 0.25;
          fused.set(entry.row.revision_id, {
            row: entry.row,
            score: weight / (MEMORY_RRF_K + index + 1),
            order: order++,
          });
        }
      });
      rows = [...fused.values()]
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, input.limit)
        .map((entry) => entry.row);
    }

    const hits: { record: MemoryRecord; revision: MemoryRevision; snippet: string }[] = [];
    for (const row of rows) {
      const record = this.getRecord(row.record_id);
      const revision = this.getRevision(row.revision_id);
      // Eligibility is re-checked here, not only in the FTS query: the two
      // statements are not one transaction, so a record forgotten or superseded
      // in between must not be reported. Erasure wins over a stale index entry.
      if (record === undefined || revision === undefined) continue;
      const supersededNote = supersededNoteByRevisionId.get(revision.revisionId);
      if (supersededNote !== undefined) {
        if (record.kind !== "fact" || (record.status !== "approved" && record.status !== "superseded")) continue;
        hits.push({
          record,
          revision,
          snippet: appendSnippetNote(memoryExcerptOf(revision.body ?? ""), supersededNote),
        });
        continue;
      }
      if (record.status !== "approved" || record.currentRevisionId !== revision.revisionId) continue;
      if (record.expiryAt !== undefined && record.expiryAt <= input.now) continue;
      const isEndedFact = includePast && record.kind === "fact" && record.validTo !== undefined && record.validTo <= input.now;
      if (record.validTo !== undefined && record.validTo <= input.now && !isEndedFact) continue;
      if (record.validFrom !== undefined && record.validFrom > input.now) continue;
      const baseSnippet = memoryExcerptOf(revision.body ?? "", String(row.snippet ?? ""));
      hits.push({
        record,
        revision,
        // The whole body when it is short, else the index's window around the match.
        snippet:
          isEndedFact && record.validTo !== undefined
            ? appendSnippetNote(baseSnippet, `(ended ${record.validTo.slice(0, 10)})`)
            : baseSnippet,
      });
    }
    return hits;
  }

  /**
   * Supplement `search` under `includePast: true` with the latest superseded
   * revision of approved or consolidated-superseded fact records in scope whose
   * `title` or `body` matches the query terms, annotated with
   * `(replaced <YYYY-MM-DD> by <title>)`.
   */
  #searchSupersededFacts(input: {
    readonly scopeKeys: readonly string[];
    readonly query: string;
    readonly isAny: boolean;
    readonly limit: number;
    readonly includeSensitive: boolean;
    readonly excludeLocalOrigin: boolean;
    readonly excluded: readonly string[];
  }): readonly { readonly row: MemorySearchRow; readonly note: string; readonly exactMatched: boolean; readonly matchedCount: number }[] {
    const rawTerms = [...input.query.matchAll(/"([^"]+)"/gu)].map((match) => match[1]?.trim() ?? "").filter((term) => term !== "");
    const terms = memoryQueryTerms((rawTerms.length > 0 ? rawTerms : [input.query]).join(" "));
    if (terms.length === 0) return [];
    const scoped = scopeKeyFilter(input.scopeKeys, "r");
    const excludedJson = input.excluded.length === 0 ? undefined : JSON.stringify(input.excluded);
    // The terms narrow the candidates in SQL, before the cut at 200, so an
    // older replacement stays reachable; the exact-and-stem check below decides.
    const termFilter = supersededTermFilter(terms, input.isAny);
    const candidateRows = this.#store.handle
      .prepare(
        `SELECT * FROM (
         SELECT v.revision_id AS revision_id,
                r.record_id AS record_id,
                v.title AS title,
                v.body AS body,
                v.keywords_json AS keywords_json,
                COALESCE(v.valid_to, v_curr.recorded_at) AS replaced_at,
                v_curr.title AS replacement_title,
                v_curr.body AS replacement_body
           FROM tavi_memory_records r
           JOIN tavi_memory_revisions v ON v.record_id = r.record_id
           JOIN tavi_memory_revisions v_curr ON v_curr.revision_id = r.current_revision_id
          WHERE ${scoped.sql}
            AND r.kind = 'fact'
            AND r.status = 'approved'
            AND v.status = 'superseded'
            AND v.revision_number = (
              SELECT MAX(v2.revision_number)
                FROM tavi_memory_revisions v2
               WHERE v2.record_id = r.record_id AND v2.status = 'superseded'
            )
            ${input.includeSensitive ? "" : "AND r.sensitivity = 'normal' AND v.sensitivity = 'normal' AND v_curr.sensitivity = 'normal'"}
            ${input.excludeLocalOrigin ? "AND r.local_origin = 0" : ""}
            ${excludedJson === undefined ? "" : "AND NOT EXISTS (SELECT 1 FROM json_each(v.source_ids_json) s WHERE s.value IN (SELECT value FROM json_each(?))) AND NOT EXISTS (SELECT 1 FROM json_each(v_curr.source_ids_json) s WHERE s.value IN (SELECT value FROM json_each(?)))"}
         UNION ALL
         SELECT v.revision_id AS revision_id,
                r.record_id AS record_id,
                v.title AS title,
                v.body AS body,
                v.keywords_json AS keywords_json,
                COALESCE(r.updated_at, v_target.recorded_at) AS replaced_at,
                v_target.title AS replacement_title,
                v_target.body AS replacement_body
           FROM tavi_memory_records r
           JOIN tavi_memory_revisions v ON v.revision_id = r.current_revision_id
           JOIN tavi_lineage_edges e ON e.from_revision_id = v.revision_id AND e.dependency_kind = 'contains'
           JOIN tavi_memory_revisions v_target ON v_target.revision_id = e.to_revision_id
           JOIN tavi_memory_records r_target ON r_target.record_id = v_target.record_id
          WHERE ${scoped.sql}
            AND r.kind = 'fact'
            AND r.status = 'superseded'
            AND r_target.status = 'approved'
            ${input.includeSensitive ? "" : "AND r.sensitivity = 'normal' AND v.sensitivity = 'normal' AND r_target.sensitivity = 'normal' AND v_target.sensitivity = 'normal'"}
            ${input.excludeLocalOrigin ? "AND r.local_origin = 0 AND r_target.local_origin = 0" : ""}
            ${excludedJson === undefined ? "" : "AND NOT EXISTS (SELECT 1 FROM json_each(v.source_ids_json) s WHERE s.value IN (SELECT value FROM json_each(?))) AND NOT EXISTS (SELECT 1 FROM json_each(v_target.source_ids_json) s WHERE s.value IN (SELECT value FROM json_each(?)))"}
         )
          WHERE ${termFilter.sql}
          ORDER BY replaced_at DESC
          LIMIT 200`,
      )
      .all(
        ...scoped.parameters,
        ...(excludedJson === undefined ? [] : [excludedJson, excludedJson]),
        ...scoped.parameters,
        ...(excludedJson === undefined ? [] : [excludedJson, excludedJson]),
        ...termFilter.parameters,
      ) as {
      revision_id: string;
      record_id: string;
      title: string | null;
      body: string | null;
      keywords_json: string | null;
      replaced_at: string;
      replacement_title: string | null;
      replacement_body: string | null;
    }[];

    const seenRevisions = new Set<string>();
    const matches: { row: MemorySearchRow; note: string; exactMatched: boolean; matchedCount: number; replacedAt: string }[] = [];
    for (const candidate of candidateRows) {
      if (seenRevisions.has(candidate.revision_id)) continue;
      seenRevisions.add(candidate.revision_id);
      const keywords = candidate.keywords_json === null ? [] : parseJsonColumn<string[]>(candidate.keywords_json, "keywords");
      const text = `${candidate.title ?? ""} ${candidate.body ?? ""} ${keywords.join(" ")}`;
      const fullSet = memoryExactAndStemSet(text);
      const matchedTerms = terms.filter((term) => memoryTermMatchesSet(term, fullSet));
      if (input.isAny ? matchedTerms.length === 0 : matchedTerms.length < terms.length) continue;
      const exactTokens = memoryTokenSet(text);
      const exactMatched = matchedTerms.some((term) => term.tokens.every((token) => exactTokens.has(token.exact)));
      const replacementTitle =
        memoryCardTitleOf({
          ...(candidate.replacement_title === null ? {} : { title: candidate.replacement_title }),
          ...(candidate.replacement_body === null ? {} : { body: candidate.replacement_body }),
        }) ?? "newer revision";
      const note = `(replaced ${candidate.replaced_at.slice(0, 10)} by ${replacementTitle})`;
      matches.push({
        row: {
          revision_id: candidate.revision_id,
          record_id: candidate.record_id,
          snippet: candidate.body ?? "",
        },
        note,
        exactMatched,
        matchedCount: matchedTerms.length,
        replacedAt: candidate.replaced_at,
      });
    }
    return matches.sort((a, b) => b.matchedCount - a.matchedCount || b.replacedAt.localeCompare(a.replacedAt)).slice(0, input.limit);
  }

  eligibleByIds(input: {
    readonly scopeKeys: readonly string[];
    readonly recordIds: readonly string[];
    readonly now: string;
  }): readonly { readonly record: MemoryRecord; readonly revision: MemoryRevision; readonly snippet: string }[] {
    const recordIds = [...new Set(input.recordIds)];
    if (input.scopeKeys.length === 0 || recordIds.length === 0) return [];
    const scoped = scopeKeyFilter(input.scopeKeys, "r");
    // `search`'s eligibility, by id instead of by words (invariant 4).
    const rows = this.#store.handle
      .prepare(
        `SELECT v.revision_id AS revision_id, r.record_id AS record_id
           FROM tavi_memory_records r
           JOIN tavi_memory_revisions v ON v.revision_id = r.current_revision_id
          WHERE r.record_id IN (${recordIds.map(() => "?").join(", ")})
            AND ${scoped.sql}
            AND r.status = 'approved'
            AND (r.valid_from IS NULL OR r.valid_from <= ?)
            AND (r.valid_to IS NULL OR r.valid_to > ?)
            AND (r.expiry_at IS NULL OR r.expiry_at > ?)`,
      )
      .all(...recordIds, ...scoped.parameters, input.now, input.now, input.now) as { revision_id: string; record_id: string }[];
    const hits: { record: MemoryRecord; revision: MemoryRevision; snippet: string }[] = [];
    for (const row of rows) {
      const record = this.getRecord(row.record_id);
      const revision = this.getRevision(row.revision_id);
      // Re-checked on the canonical rows, as `search` does its own.
      if (record === undefined || revision === undefined) continue;
      if (record.status !== "approved" || record.currentRevisionId !== revision.revisionId) continue;
      if (record.expiryAt !== undefined && record.expiryAt <= input.now) continue;
      if (record.validTo !== undefined && record.validTo <= input.now) continue;
      if (record.validFrom !== undefined && record.validFrom > input.now) continue;
      hits.push({ record, revision, snippet: memoryExcerptOf(revision.body ?? "") });
    }
    return hits;
  }

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
  } {
    const query = unitVector(input.vector);
    if (input.scopeKeys.length === 0 || query === undefined) return { ranked: [], keyMatches: [], eligible: 0, missing: 0 };
    const scoped = scopeKeyFilter(input.scopeKeys, "r");
    // Filter before rank (invariant 4): the ids come from SQL with the same
    // eligibility as lexical search, sensitive records left out; only their
    // vectors are scored. A revoked source's record, a local-origin record
    // when excluded, and, with `personal: false`, a personal one are left out
    // here too, so none takes a slot.
    const excluded = input.excludeSourceIds ?? [];
    const includePast = input.includePast === true;
    const eligible = this.#store.handle
      .prepare(
        `SELECT v.revision_id AS revision_id, r.record_id AS record_id, r.preference_key AS preference_key, r.topic_key AS topic_key
           FROM tavi_memory_records r
           JOIN tavi_memory_revisions v ON v.revision_id = r.current_revision_id
          WHERE ${scoped.sql}
            AND r.status = 'approved'
            AND r.sensitivity = 'normal' AND v.sensitivity = 'normal'
            ${input.excludeLocalOrigin === true ? "AND r.local_origin = 0" : ""}
            AND (r.valid_from IS NULL OR r.valid_from <= ?)
            AND (r.valid_to IS NULL OR r.valid_to > ?${includePast ? " OR r.kind = 'fact'" : ""})
            AND (r.expiry_at IS NULL OR r.expiry_at > ?)
            ${input.personal === false ? "AND r.workspace_id IS NOT NULL" : ""}
            ${excluded.length === 0 ? "" : "AND NOT EXISTS (SELECT 1 FROM json_each(v.source_ids_json) s WHERE s.value IN (SELECT value FROM json_each(?)))"}
          ORDER BY r.updated_at DESC`,
      )
      .all(...scoped.parameters, input.now, input.now, input.now, ...(excluded.length === 0 ? [] : [JSON.stringify(excluded)])) as {
      revision_id: string;
      record_id: string;
      preference_key: string | null;
      topic_key: string | null;
    }[];
    const recordOf = new Map(eligible.map((row) => [row.revision_id, row.record_id]));
    const vectors = this.#store.memoryVectors.ensure(input.workspaceId, input.modelKey, () =>
      this.#workspaceVectors(input.workspaceId, input.modelKey),
    );
    const scored = scoreVectors(
      query,
      eligible.map((row) => row.revision_id),
      vectors,
      input.limit,
    );
    const keys = new Set((input.keys ?? []).map((key) => key.toLowerCase()));
    const keyMatches =
      keys.size === 0
        ? []
        : eligible
            .filter(
              (row) =>
                (row.preference_key !== null && keys.has(row.preference_key.toLowerCase())) ||
                (row.topic_key !== null && keys.has(row.topic_key.toLowerCase())),
            )
            .slice(0, input.limit)
            .map((row) => ({ recordId: row.record_id, revisionId: row.revision_id }));
    const ranked = scored.ranked.flatMap((hit) => {
      const recordId = recordOf.get(hit.revisionId);
      return recordId === undefined ? [] : [{ recordId, revisionId: hit.revisionId, score: hit.score }];
    });
    const nearDuplicates = nearDuplicateVectorPairs(
      ranked.map((hit) => hit.revisionId),
      vectors,
      MEMORY_MMR_COSINE_THRESHOLD,
    );
    return {
      // Scored from `eligible`'s own revisions, so each names its record.
      ranked,
      keyMatches,
      eligible: eligible.length,
      missing: scored.missing,
      ...(nearDuplicates.length === 0 ? {} : { nearDuplicates }),
    };
  }

  vectorBacklog(input: {
    readonly workspaceId: string;
    readonly principalIds: readonly string[];
    readonly modelKey: string;
    readonly now: string;
    readonly limit: number;
    readonly maxFailures: number;
    readonly revisionIds?: readonly string[];
    readonly withLocalOrigin?: boolean;
  }): readonly { readonly revisionId: string; readonly text: string }[] {
    const rows = this.#store.handle
      .prepare(
        `SELECT v.revision_id AS revision_id, v.title AS title, v.body AS body, v.preference_key AS preference_key, v.preference_value AS preference_value
           FROM tavi_memory_records r
           JOIN tavi_memory_revisions v ON v.revision_id = r.current_revision_id
          WHERE ${VECTOR_ELIGIBLE_SQL}
            AND NOT EXISTS (SELECT 1 FROM tavi_memory_vectors x WHERE x.revision_id = v.revision_id AND x.model_key = @modelKey)
            AND NOT EXISTS (SELECT 1 FROM tavi_memory_vector_failures f WHERE f.revision_id = v.revision_id AND f.model_key = @modelKey AND f.failures >= @maxFailures)
            AND (@only IS NULL OR v.revision_id IN (SELECT value FROM json_each(@only)))
            AND (@withLocal = 1 OR r.local_origin = 0)
          ORDER BY r.updated_at, v.revision_id
          LIMIT @limit`,
      )
      .all({
        workspaceId: input.workspaceId,
        principalIds: JSON.stringify(input.principalIds),
        now: input.now,
        modelKey: input.modelKey,
        maxFailures: input.maxFailures,
        limit: input.limit,
        only: input.revisionIds === undefined ? null : JSON.stringify(input.revisionIds),
        withLocal: input.withLocalOrigin === true ? 1 : 0,
      }) as {
      revision_id: string;
      title: string | null;
      body: string | null;
      preference_key: string | null;
      preference_value: string | null;
    }[];
    return rows.map((row) => ({ revisionId: row.revision_id, text: memoryVectorText(row) })).filter((row) => row.text !== "");
  }

  putVectors(input: {
    readonly vectors: readonly { readonly revisionId: string; readonly modelKey: string; readonly vector: readonly number[] }[];
    readonly now: string;
  }): number {
    // The cache takes the vectors only once the transaction committed: a rollback leaves no cached vector the database lacks.
    const cached: { readonly revisionId: string; readonly modelKey: string; readonly unit: Float32Array }[] = [];
    const stored = this.#store.transaction(() => {
      let count = 0;
      for (const entry of input.vectors) {
        const unit = unitVector(entry.vector);
        if (unit === undefined) continue;
        // Only an approved, current, non-sensitive revision gets a vector (invariant 7):
        // a record forgotten, ended or marked sensitive since the backlog was read gets none.
        const eligible = this.#store.handle
          .prepare(
            `SELECT 1 FROM tavi_memory_records r
               JOIN tavi_memory_revisions v ON v.revision_id = r.current_revision_id
              WHERE v.revision_id = ? AND r.status = 'approved' AND r.sensitivity = 'normal' AND v.sensitivity = 'normal'
                AND (r.valid_to IS NULL OR r.valid_to > ?)
                AND (r.expiry_at IS NULL OR r.expiry_at > ?)`,
          )
          .get(entry.revisionId, input.now, input.now);
        if (eligible === undefined) continue;
        this.#store.handle
          .prepare(
            `INSERT INTO tavi_memory_vectors (revision_id, model_key, dims, vector, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(revision_id, model_key) DO UPDATE SET dims = excluded.dims, vector = excluded.vector, created_at = excluded.created_at`,
          )
          .run(entry.revisionId, entry.modelKey, unit.length, vectorBytes(unit), input.now);
        this.#store.handle
          .prepare("DELETE FROM tavi_memory_vector_failures WHERE revision_id = ? AND model_key = ?")
          .run(entry.revisionId, entry.modelKey);
        cached.push({ revisionId: entry.revisionId, modelKey: entry.modelKey, unit });
        count += 1;
      }
      return count;
    });
    // Each joins (or replaces itself in) its model's caches; another model's vector of the revision stays in its own.
    for (const entry of cached) this.#store.memoryVectors.put(entry.revisionId, entry.modelKey, entry.unit);
    return stored;
  }

  recordVectorFailures(input: { readonly revisionIds: readonly string[]; readonly modelKey: string; readonly now: string }): void {
    this.#store.transaction(() => {
      for (const revisionId of input.revisionIds) {
        if (this.getRevision(revisionId) === undefined) continue;
        this.#store.handle
          .prepare(
            `INSERT INTO tavi_memory_vector_failures (revision_id, model_key, failures, failed_at) VALUES (@revisionId, @modelKey, 1, @now)
             ON CONFLICT(revision_id, model_key) DO UPDATE SET
               failures = tavi_memory_vector_failures.failures + 1, failed_at = excluded.failed_at`,
          )
          .run({ revisionId, modelKey: input.modelKey, now: input.now });
      }
    });
  }

  pruneVectors(input: {
    readonly keepModelKeys: readonly string[];
    readonly keepPersonal?: readonly { readonly modelKey: string; readonly principalIds: readonly string[] }[];
  }): number {
    const evicted: { readonly modelKey: string; readonly revisionIds: readonly string[] }[] = [];
    const removed = this.#store.transaction(() => {
      const keep = JSON.stringify(input.keepModelKeys);
      let count = Number(
        this.#store.handle.prepare("DELETE FROM tavi_memory_vectors WHERE model_key NOT IN (SELECT value FROM json_each(?))").run(keep)
          .changes,
      );
      this.#store.handle
        .prepare("DELETE FROM tavi_memory_vector_failures WHERE model_key NOT IN (SELECT value FROM json_each(?))")
        .run(keep);
      // Personal records of people no workspace binding the model may embed for: their vectors of it go.
      for (const entry of input.keepPersonal ?? []) {
        const personal = `SELECT v.revision_id FROM tavi_memory_revisions v JOIN tavi_memory_records r ON r.record_id = v.record_id
          WHERE r.workspace_id IS NULL AND r.principal_id NOT IN (SELECT value FROM json_each(@people))`;
        const parameters = { modelKey: entry.modelKey, people: JSON.stringify(entry.principalIds) };
        const revisionIds = (
          this.#store.handle
            .prepare(`SELECT revision_id FROM tavi_memory_vectors WHERE model_key = @modelKey AND revision_id IN (${personal})`)
            .all(parameters) as { revision_id: string }[]
        ).map((row) => row.revision_id);
        if (revisionIds.length === 0) continue;
        count += Number(
          this.#store.handle
            .prepare(`DELETE FROM tavi_memory_vectors WHERE model_key = @modelKey AND revision_id IN (${personal})`)
            .run(parameters).changes,
        );
        this.#store.handle
          .prepare(`DELETE FROM tavi_memory_vector_failures WHERE model_key = @modelKey AND revision_id IN (${personal})`)
          .run(parameters);
        evicted.push({ modelKey: entry.modelKey, revisionIds });
      }
      this.#store.memoryVectors.retainModels(input.keepModelKeys);
      return count;
    });
    // Out of the caches once the deletes committed; another model's vector of the revision stays in its own.
    for (const entry of evicted) this.#store.memoryVectors.evict(entry.revisionIds, entry.modelKey);
    return removed;
  }

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
  } {
    const row = this.#store.handle
      .prepare(
        `SELECT COUNT(*) AS eligible,
                COALESCE(SUM(r.workspace_id IS NULL), 0) AS personal,
                COALESCE(SUM(EXISTS (SELECT 1 FROM tavi_memory_vectors x WHERE x.revision_id = v.revision_id AND x.model_key = @modelKey)), 0) AS indexed,
                COALESCE(SUM(EXISTS (SELECT 1 FROM tavi_memory_vector_failures f WHERE f.revision_id = v.revision_id AND f.model_key = @modelKey AND f.failures >= @maxFailures)), 0) AS failed
           FROM tavi_memory_records r
           JOIN tavi_memory_revisions v ON v.revision_id = r.current_revision_id
          WHERE ${VECTOR_ELIGIBLE_SQL}`,
      )
      .get({
        workspaceId: input.workspaceId,
        principalIds: JSON.stringify(input.principalIds),
        now: input.now,
        modelKey: input.modelKey ?? "",
        maxFailures: input.maxFailures,
      }) as { eligible: number; personal: number; indexed: number; failed: number };
    const cache = this.#store.memoryVectors.size(input.workspaceId);
    return {
      eligible: row.eligible,
      personal: row.personal,
      indexed: row.indexed,
      failed: row.failed,
      missing: Math.max(0, row.eligible - row.indexed - row.failed),
      cachedVectors: cache.vectors,
      cachedBytes: cache.bytes,
    };
  }

  dropVectorCache(workspaceId: string): void {
    this.#store.memoryVectors.drop(workspaceId);
  }

  captureStats(input: { readonly since: string; readonly now: string }): readonly MemoryCaptureSourceStats[] {
    const rows = this.#store.handle
      .prepare(
        `WITH record_outcomes AS (
           SELECT
             CASE
               WHEN v.author LIKE 'provider:%:capture' THEN v.author
               WHEN v.author LIKE 'provider:%:consolidate' THEN v.author
               WHEN v.author = 'epoch-flush' OR v.author LIKE 'epoch-flush:%' THEN 'epoch-flush'
               WHEN v.author = 'operator' OR v.author LIKE 'operator:%' THEN 'operator'
               -- tavi memory remember writes as cli, and so does a model in a foreground tavi run:
               -- only the model's memory.propose stamps the chat it was written from.
               WHEN v.author = 'cli' AND r.origin_task_id IS NULL THEN 'operator'
               -- The model's memory.propose always records the chat it was written from; its author is the turn's surface.
               WHEN r.origin_task_id IS NOT NULL THEN 'tool'
               ELSE 'other'
             END AS source,
             CASE WHEN rev.decision = 'approved' AND (rev.reason IS NULL OR rev.reason NOT LIKE 'auto-approve%') THEN 1 ELSE 0 END AS kept,
             CASE WHEN rev.decision = 'approved' AND rev.reason LIKE 'auto-approve%' THEN 1 ELSE 0 END AS auto_kept,
             CASE WHEN rev.decision = 'rejected' AND rev.reason = 'applied as a correction' THEN 1 ELSE 0 END AS replaced,
             CASE WHEN rev.decision = 'rejected' AND (rev.reason IS NULL OR rev.reason <> 'applied as a correction') THEN 1 ELSE 0 END AS discarded,
             CASE
               WHEN rev.decision IS NULL
                 AND (
                   r.status = 'expired'
                   OR (r.status = 'proposed' AND ((r.expiry_at IS NOT NULL AND r.expiry_at <= @now) OR (r.valid_to IS NOT NULL AND r.valid_to <= @now)))
                 )
                 THEN 1
               ELSE 0
             END AS expired_unreviewed
           FROM tavi_memory_records r
           JOIN tavi_memory_revisions v
             ON v.record_id = r.record_id AND v.revision_number = 1
           LEFT JOIN tavi_memory_reviews rev
             ON rev.review_id = (
               SELECT mrev.review_id
               FROM tavi_memory_reviews mrev
               WHERE mrev.record_id = r.record_id AND mrev.revision_id = v.revision_id
               ORDER BY mrev.decided_at ASC, mrev.review_id ASC
               LIMIT 1
             )
           WHERE r.recorded_at >= @since AND r.status <> 'deleted'
         )
         SELECT
           source,
           COUNT(*) AS proposed,
           COALESCE(SUM(kept), 0) AS kept,
           COALESCE(SUM(auto_kept), 0) AS auto_kept,
           COALESCE(SUM(replaced), 0) AS replaced,
           COALESCE(SUM(discarded), 0) AS discarded,
           COALESCE(SUM(expired_unreviewed), 0) AS expired_unreviewed
         FROM record_outcomes
         GROUP BY source
         ORDER BY source ASC`,
      )
      .all({ since: input.since, now: input.now }) as {
      source: string;
      proposed: number;
      kept: number;
      auto_kept: number;
      replaced: number;
      discarded: number;
      expired_unreviewed: number;
    }[];
    return rows.map((row) => ({
      source: row.source,
      proposed: row.proposed,
      kept: row.kept,
      autoKept: row.auto_kept,
      replaced: row.replaced,
      discarded: row.discarded,
      expiredUnreviewed: row.expired_unreviewed,
    }));
  }

  operatorScopes(input: {
    readonly workspaceId: string;
    readonly principalId: string;
  }): readonly { readonly scopeKey: string; readonly scope: MemoryScope }[] {
    const rows = this.#store.handle
      .prepare(`SELECT DISTINCT r.scope_key, r.scope_kind, r.principal_id, r.workspace_id, r.agent_id, r.run_id FROM tavi_memory_records r
        WHERE r.status <> 'deleted' AND ${OPERATOR_MEMORY("r")} ORDER BY r.scope_key`)
      .all(input.workspaceId, input.principalId, input.principalId) as Pick<
      MemoryRecordRow,
      "scope_key" | "scope_kind" | "principal_id" | "workspace_id" | "agent_id" | "run_id"
    >[];
    return rows.map((row) => ({ scopeKey: row.scope_key, scope: toMemoryScope(row as MemoryRecordRow) }));
  }

  otherPeopleCounts(input: {
    readonly workspaceId: string;
    readonly excludePrincipalId: string;
    readonly statuses?: readonly MemoryStatus[];
    readonly kinds?: readonly MemoryKind[];
    readonly limit: number;
  }): readonly { readonly principalId: string; readonly count: number }[] {
    const kinds = input.kinds ?? [];
    const statuses = input.statuses ?? [];
    const rows = this.#store.handle
      .prepare(`SELECT r.principal_id, count(*) AS n FROM tavi_memory_records r
        WHERE ${WORKSPACE_PERSONAL_MEMORY("r")} AND r.principal_id <> ? AND r.status <> 'deleted'
          ${kinds.length > 0 ? `AND r.kind IN (${kinds.map(() => "?").join(", ")})` : ""}
          ${statuses.length > 0 ? `AND r.status IN (${statuses.map(() => "?").join(", ")})` : ""}
        GROUP BY r.principal_id ORDER BY n DESC, r.principal_id LIMIT ?`)
      .all(input.workspaceId, input.workspaceId, input.workspaceId, input.excludePrincipalId, ...kinds, ...statuses, input.limit) as {
      principal_id: string;
      n: number;
    }[];
    return rows.map((row) => ({ principalId: row.principal_id, count: row.n }));
  }

  workspacePrincipals(input: { readonly workspaceId: string; readonly statuses: readonly MemoryStatus[] }): readonly string[] {
    if (input.statuses.length === 0) return [];
    const rows = this.#store.handle
      .prepare(`SELECT DISTINCT r.principal_id FROM tavi_memory_records r
        WHERE ${WORKSPACE_PERSONAL_MEMORY("r")} AND r.status IN (${input.statuses.map(() => "?").join(", ")})
        ORDER BY r.principal_id`)
      .all(input.workspaceId, input.workspaceId, input.workspaceId, ...input.statuses) as { principal_id: string }[];
    return rows.map((row) => row.principal_id);
  }

  countOperatorProposals(input: { readonly workspaceId: string; readonly principalId: string }): number {
    const row = this.#store.handle
      .prepare(`SELECT count(*) AS n FROM tavi_memory_records r WHERE r.status = 'proposed' AND ${OPERATOR_MEMORY("r")}`)
      .get(input.workspaceId, input.principalId, input.principalId) as { n: number };
    return row.n;
  }

  countChatNotes(input: {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly taskIds: readonly string[];
  }): Readonly<Record<string, number>> {
    const taskIds = [...new Set(input.taskIds)];
    if (taskIds.length === 0) return {};
    const rows = this.#store.handle.prepare(countChatNotesSql(taskIds.length)).all(input.principalId, input.workspaceId, ...taskIds) as {
      run_id: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map((row) => [row.run_id, row.n]));
  }

  recordUseCounts(input: {
    readonly recordIds: readonly string[];
    readonly sinceCurrentRevision?: boolean;
  }): Readonly<Record<string, number>> {
    const uniqueIds = [...new Set(input.recordIds)];
    if (uniqueIds.length === 0) return {};
    const counts: Record<string, number> = {};
    for (let offset = 0; offset < uniqueIds.length; offset += 500) {
      const batch = uniqueIds.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(", ");
      const sql =
        input.sinceCurrentRevision === true
          ? `SELECT u.record_id AS record_id, COUNT(DISTINCT u.task_id) AS n
               FROM tavi_task_memory_use u
               JOIN tavi_memory_records r ON r.record_id = u.record_id
               JOIN tavi_memory_revisions v ON v.revision_id = r.current_revision_id
              WHERE u.record_id IN (${placeholders})
                AND r.status = 'approved'
                AND v.status = 'active'
                AND u.last_used_at >= v.recorded_at
              GROUP BY u.record_id`
          : `SELECT u.record_id AS record_id, COUNT(DISTINCT u.task_id) AS n
               FROM tavi_task_memory_use u
              WHERE u.record_id IN (${placeholders})
              GROUP BY u.record_id`;
      const rows = this.#store.handle.prepare(sql).all(...batch) as { record_id: string; n: number }[];
      for (const row of rows) counts[row.record_id] = row.n;
    }
    return counts;
  }

  countCurrent(input: {
    readonly scopeKeys: readonly string[];
    readonly now: string;
    readonly includeSensitive?: boolean;
    readonly excludeLocalOrigin?: boolean;
  }): number {
    if (input.scopeKeys.length === 0) return 0;
    const scoped = scopeKeyFilter(input.scopeKeys, "r");
    const row = this.#store.handle
      .prepare(
        `SELECT count(*) AS n FROM tavi_memory_records r
          WHERE ${scoped.sql}
            AND r.status = 'approved'
            AND (r.valid_from IS NULL OR r.valid_from <= ?)
            AND (r.valid_to IS NULL OR r.valid_to > ?)
            AND (r.expiry_at IS NULL OR r.expiry_at > ?)
            ${input.includeSensitive === true ? "" : "AND r.sensitivity = 'normal'"}
            ${input.excludeLocalOrigin === true ? "AND r.local_origin = 0" : ""}`,
      )
      .get(...scoped.parameters, input.now, input.now, input.now) as { n: number };
    return row.n;
  }

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
  } {
    const excludedJson = (input.excludeSourceIds ?? []).length === 0 ? undefined : JSON.stringify(input.excludeSourceIds);
    // One statement per kind: eligibility, the current revision and the ordering in SQL, cut at `limit`.
    const select = (kind: "lesson" | "fact", scopeKeys: readonly string[]): { record_id: string; revision_id: string; n: number }[] => {
      if (scopeKeys.length === 0) return [];
      const scoped = scopeKeyFilter(scopeKeys, "r");
      return this.#store.handle
        .prepare(
          `SELECT r.record_id AS record_id, v.revision_id AS revision_id,
                  ${kind === "lesson" ? "(SELECT COUNT(DISTINCT u.task_id) FROM tavi_task_memory_use u WHERE u.record_id = r.record_id)" : "0"} AS n
             FROM tavi_memory_records r
             JOIN tavi_memory_revisions v ON v.revision_id = r.current_revision_id
            WHERE ${scoped.sql}
              AND r.kind = '${kind}'
              AND r.status = 'approved'
              AND r.sensitivity = 'normal' AND v.sensitivity = 'normal'
              AND (r.valid_from IS NULL OR r.valid_from <= ?)
              AND (r.valid_to IS NULL OR r.valid_to > ?)
              AND (r.expiry_at IS NULL OR r.expiry_at > ?)
              ${kind === "fact" ? "AND r.topic_key LIKE 'me.%' AND r.topic_key NOT LIKE 'me.belief%' AND r.topic_key NOT LIKE 'me.opinion%' AND r.topic_key <> 'me.home_area'" : ""}
              ${input.excludeLocalOrigin === true ? "AND r.local_origin = 0" : ""}
              ${excludedJson === undefined ? "" : "AND NOT EXISTS (SELECT 1 FROM json_each(v.source_ids_json) s WHERE s.value IN (SELECT value FROM json_each(?)))"}
            ORDER BY n DESC, v.recorded_at DESC, r.record_id ASC
            LIMIT ?`,
        )
        .all(...scoped.parameters, input.now, input.now, input.now, ...(excludedJson === undefined ? [] : [excludedJson]), input.limit) as {
        record_id: string;
        revision_id: string;
        n: number;
      }[];
    };
    const lessonRows = select("lesson", input.lessonScopeKeys);
    const factRows = select("fact", input.factScopeKeys);
    const ids = [...lessonRows, ...factRows];
    if (ids.length === 0) return { lessons: [], facts: [] };
    const records = new Map(
      (
        this.#store.handle
          .prepare(`SELECT * FROM tavi_memory_records WHERE record_id IN (${ids.map(() => "?").join(", ")})`)
          .all(...ids.map((row) => row.record_id)) as MemoryRecordRow[]
      ).map((row) => [row.record_id, toMemoryRecord(row)]),
    );
    const revisions = new Map(
      (
        this.#store.handle
          .prepare(`SELECT * FROM tavi_memory_revisions WHERE revision_id IN (${ids.map(() => "?").join(", ")})`)
          .all(...ids.map((row) => row.revision_id)) as MemoryRevisionRow[]
      ).map((row) => [row.revision_id, toMemoryRevision(row)]),
    );
    const pair = (row: { record_id: string; revision_id: string }) => {
      const record = records.get(row.record_id);
      const revision = revisions.get(row.revision_id);
      return record === undefined || revision === undefined ? undefined : { record, revision };
    };
    return {
      lessons: lessonRows.flatMap((row) => {
        const found = pair(row);
        return found === undefined ? [] : [{ ...found, usedChats: row.n }];
      }),
      facts: factRows.flatMap((row) => {
        const found = pair(row);
        return found === undefined ? [] : [found];
      }),
    };
  }

  /** The stored vectors of `modelKey` for the workspace's records (its own and every personal one): what its cache loads. */
  *#workspaceVectors(workspaceId: string, modelKey: string): Generator<readonly [string, Float32Array]> {
    const rows = this.#store.handle
      .prepare(
        `SELECT x.revision_id AS revision_id, x.dims AS dims, x.vector AS vector
           FROM tavi_memory_vectors x
           JOIN tavi_memory_revisions v ON v.revision_id = x.revision_id
           JOIN tavi_memory_records r ON r.record_id = v.record_id
          WHERE x.model_key = ? AND (r.workspace_id = ? OR r.workspace_id IS NULL)`,
      )
      .all(modelKey, workspaceId) as { revision_id: string; dims: number; vector: Uint8Array }[];
    for (const row of rows) {
      const vector = vectorFromBytes(row.vector, row.dims);
      if (vector !== undefined) yield [row.revision_id, vector];
    }
  }

  /** Delete a record's vectors (every revision's) and evict them from the cache. */
  #dropVectors(recordId: string): void {
    const revisionIds = (
      this.#store.handle
        .prepare(
          "SELECT DISTINCT x.revision_id AS revision_id FROM tavi_memory_vectors x JOIN tavi_memory_revisions v ON v.revision_id = x.revision_id WHERE v.record_id = ?",
        )
        .all(recordId) as { revision_id: string }[]
    ).map((row) => row.revision_id);
    if (revisionIds.length === 0) return;
    this.#store.handle
      .prepare("DELETE FROM tavi_memory_vectors WHERE revision_id IN (SELECT revision_id FROM tavi_memory_revisions WHERE record_id = ?)")
      .run(recordId);
    this.#store.memoryVectors.evict(revisionIds);
  }

  rebuildSearchIndex(): { readonly indexed: number; readonly verified: boolean } {
    return this.#store.transaction(() => {
      this.#store.handle.exec("DELETE FROM tavi_memory_fts");
      this.#store.handle.exec("DELETE FROM tavi_memory_fts_stem");
      this.#store.handle.exec("DELETE FROM tavi_memory_fts_map");
      const rows = this.#store.handle
        .prepare(
          `SELECT v.* FROM tavi_memory_revisions v
             JOIN tavi_memory_records r ON r.record_id = v.record_id
            WHERE r.status <> 'deleted'`,
        )
        .all() as MemoryRevisionRow[];
      for (const row of rows) this.#indexRevision(toMemoryRevision(row));
      // Coverage is checked as *sets* plus a row count, so a mapping without a
      // search row (or the reverse) is a failure rather than a matching total.
      const indexed = (this.#store.handle.prepare("SELECT COUNT(*) AS count FROM tavi_memory_fts_map").get() as { count: number }).count;
      const mapped = (
        this.#store.handle.prepare("SELECT COUNT(DISTINCT revision_id) AS count FROM tavi_memory_fts_map").get() as { count: number }
      ).count;
      const searchable = (this.#store.handle.prepare("SELECT COUNT(*) AS count FROM tavi_memory_fts").get() as { count: number }).count;
      const stemmed = (this.#store.handle.prepare("SELECT COUNT(*) AS count FROM tavi_memory_fts_stem").get() as { count: number }).count;
      const expected = new Set(rows.map((row) => row.revision_id));
      const actual = new Set(
        (
          this.#store.handle.prepare("SELECT revision_id FROM tavi_memory_fts_map").all() as {
            revision_id: string;
          }[]
        ).map((row) => row.revision_id),
      );
      const covered = expected.size === actual.size && [...expected].every((revisionId) => actual.has(revisionId));
      return { indexed, verified: covered && mapped === searchable && mapped === stemmed && indexed === expected.size };
    });
  }

  #insertRecordRow(record: MemoryRecord, contentKey?: string): void {
    // The scope key is *derived* from the scope, never taken from the caller: a
    // supplied key that disagrees with the scope would store the record under
    // another principal's key and make it readable by them.
    if (record.scopeKey !== memoryScopeKey(record.scope)) {
      throw new TaviError(
        "INVALID_INPUT",
        `Record ${record.recordId} declares scope key ${record.scopeKey} for scope ${record.scope.kind}`,
        { details: { recordId: record.recordId, scopeKey: record.scopeKey } },
      );
    }
    if (record.kind === "preference" && record.preferenceKey === undefined) {
      // A preference without a key cannot participate in the one-active-value
      // index, which is the only thing preventing two contradictory values.
      throw new TaviError("INVALID_INPUT", `Preference ${record.recordId} needs a preference key`);
    }
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_memory_records
           (record_id, scope_key, scope_kind, principal_id, workspace_id, agent_id, run_id, kind, status,
            sensitivity, preference_key, topic_key, current_revision_id, valid_from, valid_to, expiry_at, confidence,
            confidence_basis, supersedes_record_id, revocation_generation, recorded_at, updated_at, durable, origin_task_id,
            content_key, local_origin)
         VALUES (@recordId, @scopeKey, @scopeKind, @principalId, @workspaceId, @agentId, @runId, @kind, @status,
                 @sensitivity, @preferenceKey, @topicKey, @currentRevisionId, @validFrom, @validTo, @expiryAt, @confidence,
                 @confidenceBasis, @supersedesRecordId, @revocationGeneration, @recordedAt, @updatedAt, @durable, @originTaskId,
                 @contentKey, @localOrigin)`,
      )
      .run({
        recordId: record.recordId,
        scopeKey: record.scopeKey,
        scopeKind: record.scope.kind,
        principalId: record.scope.kind === "shared_workspace" ? "" : record.scope.principalId,
        workspaceId: "workspaceId" in record.scope ? (record.scope.workspaceId ?? null) : null,
        agentId: record.scope.kind === "personal_agent" ? record.scope.agentId : null,
        runId: record.scope.kind === "run_local" ? record.scope.runId : null,
        kind: record.kind,
        status: record.status,
        sensitivity: record.sensitivity,
        preferenceKey: record.preferenceKey ?? null,
        topicKey: record.topicKey ?? null,
        currentRevisionId: record.currentRevisionId ?? null,
        validFrom: record.validFrom ?? null,
        validTo: record.validTo ?? null,
        expiryAt: record.expiryAt ?? null,
        confidence: record.confidence ?? null,
        confidenceBasis: record.confidenceBasis ?? null,
        supersedesRecordId: record.supersedesRecordId ?? null,
        revocationGeneration: record.revocationGeneration,
        recordedAt: record.recordedAt,
        updatedAt: record.updatedAt,
        durable: record.durable === true ? 1 : 0,
        originTaskId: record.originTaskId ?? null,
        contentKey: contentKey ?? null,
        localOrigin: record.localOrigin === true ? 1 : 0,
      });
  }

  #insertRevisionRow(
    revision: MemoryRevision,
    preference?: PreferenceValue,
    lifecycle?: { readonly status: "active" | "superseded" | "revoked"; readonly validFrom?: string | null },
  ): void {
    this.#store.handle
      .prepare(
        `INSERT INTO tavi_memory_revisions
           (revision_id, record_id, revision_number, schema_version, title, body, artifact_id, content_hash,
            author, source_ids_json, observed_at, recorded_at, sensitivity, preference_key, preference_type,
            preference_value, status, valid_from, provenance_json, keywords_json)
         VALUES (@revisionId, @recordId, @revisionNumber, @schemaVersion, @title, @body, @artifactId, @contentHash,
                 @author, @sourceIdsJson, @observedAt, @recordedAt, @sensitivity, @preferenceKey, @preferenceType,
                 @preferenceValue, @status, @validFrom, @provenanceJson, @keywordsJson)`,
      )
      .run({
        revisionId: revision.revisionId,
        recordId: revision.recordId,
        revisionNumber: revision.revisionNumber,
        schemaVersion: revision.schemaVersion,
        title: revision.title ?? null,
        body: revision.body ?? null,
        artifactId: revision.artifactId ?? null,
        contentHash: revision.contentHash,
        author: revision.author,
        sourceIdsJson: JSON.stringify(revision.sourceIds),
        observedAt: revision.observedAt ?? null,
        recordedAt: revision.recordedAt,
        sensitivity: revision.sensitivity,
        preferenceKey: preference?.key ?? null,
        preferenceType: preference?.valueType ?? null,
        preferenceValue: preference === undefined ? null : JSON.stringify(preference.value),
        status: lifecycle?.status ?? "active",
        validFrom: lifecycle?.validFrom ?? null,
        provenanceJson: revision.provenance === undefined ? null : JSON.stringify(revision.provenance),
        keywordsJson: JSON.stringify(revision.keywords ?? []),
      });
  }

  /** Index a revision: bounded searchable text plus the stable row-id mapping. */
  #indexRevision(revision: MemoryRevision): void {
    const row = this.#store.handle
      .prepare(
        `INSERT INTO tavi_memory_fts_map (revision_id) VALUES (?)
         ON CONFLICT(revision_id) DO UPDATE SET revision_id = excluded.revision_id
         RETURNING row_id`,
      )
      .get(revision.revisionId) as { row_id: number };
    const keys = (revision.keywords ?? []).join(" ");
    this.#store.handle
      .prepare("INSERT INTO tavi_memory_fts (rowid, title, body, keys) VALUES (?, ?, ?, ?)")
      .run(row.row_id, revision.title ?? "", revision.body ?? "", keys);
    this.#store.handle
      .prepare("INSERT INTO tavi_memory_fts_stem (rowid, title, body, keys) VALUES (?, ?, ?, ?)")
      .run(row.row_id, revision.title ?? "", revision.body ?? "", keys);
  }

  #deleteIndexRow(revisionId: string): void {
    const row = this.#store.handle.prepare("SELECT row_id FROM tavi_memory_fts_map WHERE revision_id = ?").get(revisionId) as
      | { row_id: number }
      | undefined;
    if (row === undefined) return;
    this.#store.handle.prepare("DELETE FROM tavi_memory_fts WHERE rowid = ?").run(row.row_id);
    this.#store.handle.prepare("DELETE FROM tavi_memory_fts_stem WHERE rowid = ?").run(row.row_id);
    this.#store.handle.prepare("DELETE FROM tavi_memory_fts_map WHERE row_id = ?").run(row.row_id);
  }

  #deleteIndexRows(recordId: string): void {
    const rows = this.#store.handle
      .prepare(
        `SELECT m.row_id FROM tavi_memory_fts_map m
           JOIN tavi_memory_revisions v ON v.revision_id = m.revision_id
          WHERE v.record_id = ?`,
      )
      .all(recordId) as { row_id: number }[];
    for (const row of rows) {
      this.#store.handle.prepare("DELETE FROM tavi_memory_fts WHERE rowid = ?").run(row.row_id);
      this.#store.handle.prepare("DELETE FROM tavi_memory_fts_stem WHERE rowid = ?").run(row.row_id);
      this.#store.handle.prepare("DELETE FROM tavi_memory_fts_map WHERE row_id = ?").run(row.row_id);
    }
  }
}

/**
 * The start-up pass that keeps forgotten memory forgotten (invariant 9): every record a deletion journal row names that is not
 * `deleted` — brought back by a restored backup (`restoreSnapshot` carries
 * the replaced database's journal over), or left by a forget a crash cut
 * short — is forgotten through the ordinary forget path, with reason
 * `reconciled after restore`. Whatever a row's `cleanup_status`: a provider
 * removal still pending stays the provider sync's to resend. One
 * transaction a record, so one that fails is passed over and tried again at
 * the next start. The worker runs it before it serves anything, so before
 * the first turn. Answers how many were forgotten and how many failed.
 */
export function reconcileMemoryDeletions(
  store: StoreContext,
  now: string = nowTimestamp(),
): { readonly forgotten: number; readonly failed: number } {
  const memory = new SqliteMemoryRepository(store);
  let forgotten = 0;
  let failed = 0;
  for (const recordId of memory.recordsToReconcile()) {
    try {
      store.transactionImmediate(() => memory.reconcileForget(recordId, now));
      forgotten += 1;
    } catch {
      failed += 1;
    }
  }
  return { forgotten, failed };
}
