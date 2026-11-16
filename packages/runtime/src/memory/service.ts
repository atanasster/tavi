import { MEMORY_EXPORT_HARD_CAP } from "./limits.js";
import { MemoryReads } from "./reads.js";
import { authorizeScope, authorizedScopeKeys, requireOperator } from "./access.js";
import {
  factValuesDiffer,
  hashContent,
  isCurrent,
  isUniqueConstraintError,
  memoryNearMatchQuery,
  validateBounds,
  validateReason,
  MAX_QUERY_VECTOR_DIMS,
} from "./rules.js";
import { memoryContentKey } from "./content-key.js";
import type { MemoryServicePort, PersistencePort } from "../persistence/internal-contracts.js";
import {
  DEFAULT_MEMORY_RETENTION_DAYS,
  MEMORY_FTS_SCHEMA_VERSION,
  MEMORY_LIST_PAGE_MAX,
  MEMORY_NEAR_MATCH_COSINE,
  MEMORY_NEAR_MATCH_JACCARD,
  MEMORY_SUPERSEDES_MAX,
  TaviError,
  TimestampSchema,
  memoryScopeKey,
  MemoryProvenanceSchema,
  joinMemoryProvenance,
  type MemoryProvenance,
  memoryTextSimilarity,
  type MemoryActor,
  type MemoryDeletion,
  type MemoryKind,
  type MemoryProposeOutcome,
  type MemoryRecord,
  type MemoryRevision,
} from "@tavi/contracts";
import type { AccessPolicyPort } from "@tavi/contracts";
import { definedOnly, nowTimestamp } from "@tavi/contracts/util";
import { prefixedId } from "@tavi/node-kit";

/** A preference with `validTo` would leave the one-active-value index (`valid_to IS NULL`), so it expires instead. */
const PREFERENCE_VALID_TO_REFUSAL = "A preference expires: use expiryAt, not validTo";

/** The live records of one content key exact dedup reads, at most. */
const CONTENT_MATCH_LIMIT = 500;

function normalizeKeywords(keywords: readonly string[] | undefined): string[] | undefined {
  if (keywords === undefined || keywords.length === 0) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const folded = trimmed.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(trimmed);
  }
  return out.length === 0 ? undefined : out;
}

export interface MemoryQuotas {
  /** Stored record ceiling across the actor's scopes. */
  readonly maxRecords: number;
  /** Stored body/title bytes ceiling across the actor's scopes. */
  readonly maxBytes: number;
}

/** A generous default that still bounds an installation. */
export const DEFAULT_MEMORY_QUOTAS: MemoryQuotas = { maxRecords: 5_000, maxBytes: 32 * 1024 * 1024 };

export interface MemoryServiceOptions {
  readonly now?: () => string;
  readonly newId?: (prefix: string) => string;
  readonly quotas?: MemoryQuotas;
  /**
   * Grant source for the shared workspace scope. Omitting it is the secure
   * default: nobody can read `shared_workspace` memory, since workspace
   * membership alone was never meant to grant it: shared memory is never
   * created by silently broadening personal scope.
   */
  readonly policy?: AccessPolicyPort;
}

/**
 * Personal memory lifecycle.
 *
 * The service owns authorization and the lifecycle rules; the repository owns
 * scope filtering and the transactional invariants. Three properties are worth
 * stating because they are the whole point of the layer:
 *
 *  - **a model can propose, a person approves.** `propose` never approves, and
 *    approval is an explicit act over one exact revision;
 *  - **every read is scoped by the actor, never by the request.** The requested
 *    scope is validated against the scopes the actor may use, and an unauthorized
 *    object is reported as `NOT_FOUND` rather than revealing that it exists;
 *  - **an edit is a compare-and-set.** A stale expectation is `REVISION_CONFLICT`,
 *    never a silent overwrite, and quota exhaustion is typed rather than a
 *    silent eviction of approved memory.
 */

export class MemoryService implements MemoryServicePort {
  readonly #persistence: PersistencePort;
  readonly #now: () => string;
  readonly #newId: (prefix: string) => string;
  readonly #quotas: MemoryQuotas;
  readonly #policy: AccessPolicyPort | undefined;
  readonly #reads: MemoryReads;

  constructor(persistence: PersistencePort, options: MemoryServiceOptions = {}) {
    this.#persistence = persistence;
    this.#now = options.now ?? nowTimestamp;
    this.#newId = options.newId ?? prefixedId;
    this.#quotas = options.quotas ?? DEFAULT_MEMORY_QUOTAS;
    this.#policy = options.policy;
    this.#reads = new MemoryReads(persistence, { now: this.#now, policy: this.#policy });
  }

  get #memory() {
    return this.#persistence.repositories.memory;
  }

  propose(input: Parameters<MemoryServicePort["propose"]>[0]): MemoryProposeOutcome {
    return this.#propose(input);
  }

  #propose(input: Parameters<MemoryServicePort["propose"]>[0]): MemoryProposeOutcome {
    const scope = authorizeScope(this.#policy, input.actor, input.scope, "write");
    if (input.durable === true && scope.kind !== "run_local") {
      throw new TaviError("INVALID_INPUT", "Only a chat's own memory can be kept as a chat note");
    }
    if (input.body === undefined && input.artifactId === undefined) {
      throw new TaviError("INVALID_INPUT", "A memory record needs a body or an artifact reference");
    }
    if (input.kind === "preference" && input.preferenceKey === undefined) {
      throw new TaviError("INVALID_INPUT", "A preference needs a key so one active value is enforceable");
    }
    if (input.kind === "preference" && input.validTo !== undefined) {
      throw new TaviError("INVALID_INPUT", PREFERENCE_VALID_TO_REFUSAL);
    }
    validateBounds({
      title: input.title,
      body: input.body,
      preferenceKey: input.preferenceKey,
      topicKey: input.topicKey,
      keywords: input.keywords,
      sourceIds: input.sourceIds,
      observedAt: input.observedAt,
      expiryAt: input.expiryAt,
      validTo: input.validTo,
    });
    const keywords = normalizeKeywords(input.keywords);
    this.#assertSourcesAvailable(input.actor, input.sourceIds);
    const stamped = this.#validProvenance(input.provenance);

    const now = this.#now();
    const scopeKey = memoryScopeKey(scope);
    const supersedes = this.#supersededInputs(input, scopeKey);
    let supersedesRecordId: string | undefined;
    if (input.supersedesRecordId !== undefined) {
      // A fact or a lesson names what it updates; a preference updates by its key.
      if (input.kind !== "fact" && input.kind !== "lesson") {
        throw new TaviError("INVALID_INPUT", "Only a fact or lesson proposal can name a record it updates");
      }
      const target = this.get({ actor: input.actor, recordId: input.supersedesRecordId });
      if (target.scopeKey !== scopeKey || target.kind !== input.kind || target.status !== "approved" || !isCurrent(target, now)) {
        throw new TaviError(
          "INVALID_INPUT",
          `Memory record ${input.supersedesRecordId} is not an approved ${input.kind} in force in this scope`,
        );
      }
      // A sensitive record is never named to a drafter (`known` leaves it out), so nothing drafted updates it.
      if (target.sensitivity === "sensitive") {
        throw new TaviError(
          "INVALID_INPUT",
          `Memory record ${input.supersedesRecordId} is sensitive; it is corrected, not updated by a proposal`,
        );
      }
      supersedesRecordId = target.recordId;
    }
    // Dedup, before the quota: a duplicate costs nothing. Only pending proposals and
    // records in force are matched, so an ended fact said again is a new record.
    const contentKey = memoryContentKey({
      kind: input.kind,
      scopeKey,
      preferenceKey: input.preferenceKey,
      topicKey: input.topicKey,
      body: input.body,
      ...(input.preference === undefined ? {} : { preferenceValue: input.preference.value }),
    });
    // A tidy-up's own inputs are never what it duplicates: approving it supersedes them.
    const same =
      contentKey === undefined
        ? undefined
        : this.#sameContent(scopeKey, input.kind, contentKey, now, new Set(supersedes.map((entry) => entry.recordId)));
    if (same !== undefined) return { ...same, known: "exact" };
    if (input.nearMatch === "drop" && input.body !== undefined) {
      const near =
        this.#nearMatch(scopeKey, input, input.body, now) ?? this.#nearByMeaning(scopeKey, input.actor.workspaceId, input, input.body, now);
      if (near !== undefined) return { ...near, known: "near" };
    }
    this.#assertWithinQuota(input.actor, input.body ?? "");

    // A tidy-up's provenance is the join of its inputs': words merged
    // from a record proposed after a page was read still say so when the merge is reviewed.
    const provenance = supersedes.reduce<MemoryProvenance | undefined>(
      (joined, entry) => joinMemoryProvenance(joined, this.#memory.getRevision(entry.revisionId)?.provenance),
      stamped,
    );
    const recordId = this.#newId("mem");
    const revisionId = this.#newId("memrev");
    const record: MemoryRecord = {
      recordId,
      kind: input.kind,
      scope,
      scopeKey: memoryScopeKey(scope),
      status: "proposed",
      sensitivity: input.sensitivity ?? "normal",
      revocationGeneration: 0,
      recordedAt: now,
      updatedAt: now,
      ...definedOnly({
        preferenceKey: input.preferenceKey,
        topicKey: input.topicKey,
        expiryAt: input.expiryAt,
        supersedesRecordId,
      }),
      // A fact's end: kept through approval, which sets only `validFrom`.
      ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
      ...(input.durable === true ? { durable: true as const } : {}),
      ...(input.originTaskId === undefined ? {} : { originTaskId: input.originTaskId }),
      // A tidy-up or update of a local chat's note is that chat's too.
      ...(input.localOrigin === true ||
      (supersedesRecordId !== undefined && this.#memory.getRecord(supersedesRecordId)?.localOrigin === true) ||
      supersedes.some((entry) => this.#memory.getRecord(entry.recordId)?.localOrigin === true)
        ? { localOrigin: true as const }
        : {}),
    };
    const revision: MemoryRevision = {
      revisionId,
      recordId,
      revisionNumber: 1,
      schemaVersion: MEMORY_FTS_SCHEMA_VERSION,
      contentHash: hashContent(input.title, input.body),
      author: input.actor.caller,
      sourceIds: [...(input.sourceIds ?? [])],
      recordedAt: now,
      sensitivity: record.sensitivity,
      status: "active",
      ...definedOnly({
        title: input.title,
        body: input.body,
        artifactId: input.artifactId,
        observedAt: input.observedAt,
        keywords,
        provenance,
      }),
    };
    const preference =
      input.preference === undefined || input.preferenceKey === undefined
        ? undefined
        : {
            revisionId,
            key: input.preferenceKey,
            valueType: input.preference.valueType,
            value: input.preference.value,
          };
    this.#persistence.transaction(() => {
      this.#memory.insertRecord({
        record,
        revision,
        ...(preference === undefined ? {} : { preference }),
        ...(contentKey === undefined ? {} : { contentKey }),
      });
      // A tidy-up's lineage (invariant 8): each input revision `contains` into the proposal's,
      // the edge ids sorting in the order the inputs were named (`listLineage` reads by edge id).
      for (const [index, input] of supersedes.entries()) {
        this.#memory.insertLineage({
          edgeId: revisionId.length <= 100 ? `${revisionId}:supersedes:${String(index).padStart(2, "0")}` : this.#newId("lineage"),
          fromRevisionId: input.revisionId,
          toRevisionId: revisionId,
          dependencyKind: "contains",
          derivedFreshness: "clean",
          affectedSourceIds: [],
          lastValidatedGeneration: 0,
        });
      }
    });
    return this.#requireRecord(recordId);
  }

  /**
   * A proposal's `supersedes`, checked: at most
   * `MEMORY_SUPERSEDES_MAX`, each named once, each a record the actor reads
   * in the proposal's own scope, approved at the revision named now
   * (`REVISION_CONFLICT` otherwise, so a tidy-up drafted from an older
   * revision is drafted again).
   */
  #supersededInputs(
    input: Pick<Parameters<MemoryServicePort["propose"]>[0], "actor" | "supersedes" | "kind">,
    scopeKey: string,
  ): readonly { readonly recordId: string; readonly revisionId: string }[] {
    const named = input.supersedes ?? [];
    if (named.length === 0) return [];
    if (named.length > MEMORY_SUPERSEDES_MAX) {
      throw new TaviError("INVALID_INPUT", `A proposal supersedes at most ${MEMORY_SUPERSEDES_MAX} records`);
    }
    if (new Set(named.map((entry) => entry.recordId)).size !== named.length) {
      throw new TaviError("INVALID_INPUT", "A proposal names each record it supersedes once");
    }
    return named.map((entry) => {
      const record = this.get({ actor: input.actor, recordId: entry.recordId });
      if (record.scopeKey !== scopeKey || record.kind !== input.kind) {
        throw new TaviError("INVALID_INPUT", `Memory record ${record.recordId} is not of this proposal's scope and kind`);
      }
      if (record.status !== "approved" || record.currentRevisionId !== entry.revisionId) {
        throw new TaviError("REVISION_CONFLICT", `Memory record ${record.recordId} is no longer at revision ${entry.revisionId}`);
      }
      return { recordId: record.recordId, revisionId: entry.revisionId };
    });
  }

  /**
   * The live record (a pending proposal, or an approved one in force) of the
   * same normalised content, if any, by its key. An approved one is preferred
   * to a proposal.
   */
  #sameContent(
    scopeKey: string,
    kind: MemoryKind,
    contentKey: string,
    now: string,
    except: ReadonlySet<string> = new Set(),
  ): MemoryRecord | undefined {
    const matches = this.#memory
      .findByContent({ scopeKey, kind, contentKey, now, limit: CONTENT_MATCH_LIMIT })
      .filter((record) => !except.has(record.recordId));
    return matches.find((record) => record.status === "approved") ?? matches[0];
  }

  /**
   * Automatic capture's near match: the top lexical hit among
   * the records in force in the scope, when its body's token-set Jaccard
   * similarity to `body` is at least `MEMORY_NEAR_MATCH_JACCARD`. Bodies are
   * compared here because only the service reads them; the hit is never
   * returned to the model as text. A failed index read is no match.
   *
   * Only a hit of the draft's kind counts. A draft that is an update — its
   * preference key or fact's topic key is held by a record in force, or is
   * the hit's — is never a near match: it is filed, so its card offers
   * *Replace*.
   */
  #nearMatch(
    scopeKey: string,
    draft: {
      readonly kind: MemoryKind;
      readonly preferenceKey?: string;
      readonly topicKey?: string;
      readonly supersedesRecordId?: string;
    },
    body: string,
    now: string,
  ): MemoryRecord | undefined {
    if (draft.supersedesRecordId !== undefined) return undefined;
    const key = draft.kind === "preference" ? draft.preferenceKey : draft.kind === "fact" ? draft.topicKey : undefined;
    if (
      key !== undefined &&
      (draft.kind === "preference" || draft.kind === "fact") &&
      this.#memory.keyHolders({ scopeKey, kind: draft.kind, key, now }).length > 0
    ) {
      return undefined;
    }
    const query = memoryNearMatchQuery(body);
    if (query === undefined) return undefined;
    let hits: ReturnType<PersistencePort["repositories"]["memory"]["search"]>;
    try {
      hits = this.#memory.search({ scopeKeys: [scopeKey], query, limit: 1, now, includeSensitive: true });
    } catch {
      return undefined;
    }
    const [top] = hits;
    if (top?.revision.body === undefined || top.record.kind !== draft.kind) return undefined;
    const hitKey = draft.kind === "preference" ? top.record.preferenceKey : draft.kind === "fact" ? top.record.topicKey : undefined;
    if (key !== undefined && hitKey === key) return undefined;
    if (draft.kind === "fact" && factValuesDiffer(body, top.revision.body)) return undefined;
    return memoryTextSimilarity(body, top.revision.body) >= MEMORY_NEAR_MATCH_JACCARD ? top.record : undefined;
  }

  /**
   * Automatic capture's near match by meaning under hybrid:
   * given the draft's vector (`nearMatchVector`, set only by the owner's
   * hybrid wrapper), the record in force in the scope whose vector of that
   * model scores highest, when its cosine is at least
   * `MEMORY_NEAR_MATCH_COSINE`. The candidates are hybrid recall's (approved,
   * current, in force, never sensitive: invariant 4), and the same rules as
   * `#nearMatch` hold: only a hit of the draft's kind, and never for an
   * update. A failed read is no match.
   */
  #nearByMeaning(
    scopeKey: string,
    workspaceId: string,
    draft: {
      readonly kind: MemoryKind;
      readonly preferenceKey?: string;
      readonly topicKey?: string;
      readonly supersedesRecordId?: string;
      readonly nearMatchVector?: { readonly modelKey: string; readonly vector: readonly number[] };
    },
    body: string,
    now: string,
  ): MemoryRecord | undefined {
    if (draft.supersedesRecordId !== undefined) return undefined;
    const vector = draft.nearMatchVector;
    if (vector === undefined || vector.vector.length === 0 || vector.vector.length > MAX_QUERY_VECTOR_DIMS) return undefined;
    const key = draft.kind === "preference" ? draft.preferenceKey : draft.kind === "fact" ? draft.topicKey : undefined;
    if (
      key !== undefined &&
      (draft.kind === "preference" || draft.kind === "fact") &&
      this.#memory.keyHolders({ scopeKey, kind: draft.kind, key, now }).length > 0
    ) {
      return undefined;
    }
    let top: { readonly recordId: string; readonly score: number } | undefined;
    try {
      [top] = this.#memory.vectorCandidates({
        scopeKeys: [scopeKey],
        workspaceId,
        now,
        modelKey: vector.modelKey,
        vector: vector.vector,
        limit: 1,
      }).ranked;
    } catch {
      return undefined;
    }
    if (top === undefined || top.score < MEMORY_NEAR_MATCH_COSINE) return undefined;
    const record = this.#memory.getRecord(top.recordId);
    if (record === undefined || record.kind !== draft.kind) return undefined;
    const hitKey = draft.kind === "preference" ? record.preferenceKey : draft.kind === "fact" ? record.topicKey : undefined;
    if (key !== undefined && hitKey === key) return undefined;
    if (draft.kind === "fact") {
      const targetBody = record.currentRevisionId === undefined ? undefined : this.#memory.getRevision(record.currentRevisionId)?.body;
      if (targetBody !== undefined && factValuesDiffer(body, targetBody)) return undefined;
    }
    return record;
  }

  /** Propose then immediately approve, as one operator call. */
  remember(input: Parameters<MemoryServicePort["remember"]>[0]): MemoryProposeOutcome {
    return this.#remember(input);
  }

  #remember(input: Parameters<MemoryServicePort["remember"]>[0]): MemoryProposeOutcome {
    requireOperator(input.actor, "remember");
    const { reason, ...proposeInput } = input;
    const { known, ...proposed } = this.#propose(proposeInput);
    // The same words already kept are that record; a waiting proposal of them is approved.
    const kept =
      proposed.status === "approved"
        ? proposed
        : this.approve({ actor: input.actor, recordId: proposed.recordId, ...(reason === undefined ? {} : { reason }) });
    return known === undefined ? kept : { ...kept, known };
  }

  approve(input: Parameters<MemoryServicePort["approve"]>[0]): MemoryRecord {
    requireOperator(input.actor, "approve");
    const record = this.get({ actor: input.actor, recordId: input.recordId });
    if (record.status === "approved") return record;
    if (record.status !== "proposed") {
      throw new TaviError("CONFLICT", `Memory record ${record.recordId} is ${record.status} and cannot be approved`);
    }
    const revisionId = input.expectedRevisionId ?? record.currentRevisionId ?? this.#latestRevisionId(record.recordId);
    // Approval is always over one exact revision, and the review records which.
    const revision = this.#memory.getRevision(revisionId);
    if (revision === undefined || revision.recordId !== record.recordId) {
      throw new TaviError("REVISION_CONFLICT", `Revision ${revisionId} is not a revision of ${record.recordId}`);
    }
    const now = this.#now();
    // A tidy-up and the inputs it supersedes change together, or not at all (invariant 8).
    return this.#persistence.transaction(() => {
      this.#supersedeInputs(record, revisionId, now);
      if (record.preferenceKey !== undefined) {
        // A value past its `expiryAt` the sweep has not marked yet no longer blocks a new one.
        this.#expireLapsedPreferences(record, now);
        this.#assertNoActivePreferenceClash(record);
      }
      let applied: boolean;
      try {
        applied = this.#memory.applyLifecycle({
          recordId: record.recordId,
          expectedCurrentRevisionId: record.currentRevisionId ?? null,
          expectedStatus: "proposed",
          status: "approved",
          currentRevisionId: revisionId,
          validFrom: now,
          updatedAt: now,
        });
      } catch (error) {
        // The pre-check above closes the ordinary window; a concurrent approval
        // that still races through it hits the database's own partial unique
        // index and must not escape as a raw driver error (typed errors only).
        if (isUniqueConstraintError(error)) {
          throw new TaviError("MEMORY_CONFLICT", `Preference ${record.preferenceKey ?? ""} already has an active value in this scope`, {
            details: { recordId: record.recordId },
          });
        }
        throw error;
      }
      if (!applied) {
        throw new TaviError("REVISION_CONFLICT", `Memory record ${record.recordId} changed while approving it`);
      }
      this.#memory.recordReview({
        reviewId: this.#newId("memreview"),
        recordId: record.recordId,
        revisionId,
        revisionHash: revision.contentHash,
        reviewerPrincipalId: input.actor.principalId,
        decision: "approved",
        decidedAt: now,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      return this.#requireRecord(record.recordId);
    });
  }

  /**
   * Approving a tidy-up: each record its revision supersedes
   * must still be approved at the revision it was drafted from — a
   * compare-and-set, `REVISION_CONFLICT` otherwise, so a stale tidy-up is
   * drafted again rather than overwrite a later edit — and is marked
   * `superseded`, out of recall and its index, its revisions kept readable.
   * Nothing is deleted or rewritten (invariant 8). Runs inside the approval's
   * transaction, so a refused input leaves every record as it was.
   */
  #supersedeInputs(record: MemoryRecord, revisionId: string, now: string): void {
    for (const input of this.#reads.supersedesOf(revisionId, record.recordId)) {
      const superseded = this.#memory.applyLifecycle({
        recordId: input.recordId,
        expectedCurrentRevisionId: input.revisionId,
        expectedStatus: "approved",
        status: "superseded",
        updatedAt: now,
      });
      if (!superseded) {
        throw new TaviError(
          "REVISION_CONFLICT",
          `Memory record ${input.recordId} changed since this tidy-up was suggested: run consolidation again`,
          { details: { recordId: record.recordId, supersedes: input.recordId } },
        );
      }
      this.#memory.deindex(input.recordId);
    }
  }

  reject(input: Parameters<MemoryServicePort["reject"]>[0]): MemoryRecord {
    requireOperator(input.actor, "reject");
    const record = this.get({ actor: input.actor, recordId: input.recordId });
    if (record.status === "rejected") return record;
    if (record.status !== "proposed") {
      throw new TaviError("CONFLICT", `Memory record ${record.recordId} is ${record.status} and cannot be rejected`);
    }
    const revisionId = input.expectedRevisionId ?? record.currentRevisionId ?? this.#latestRevisionId(record.recordId);
    const revision = this.#memory.getRevision(revisionId);
    const now = this.#now();
    const applied = this.#memory.applyLifecycle({
      recordId: record.recordId,
      expectedCurrentRevisionId: record.currentRevisionId ?? null,
      expectedStatus: "proposed",
      status: "rejected",
      updatedAt: now,
    });
    if (!applied) {
      throw new TaviError("REVISION_CONFLICT", `Memory record ${record.recordId} changed while rejecting it`);
    }
    this.#memory.recordReview({
      reviewId: this.#newId("memreview"),
      recordId: record.recordId,
      revisionId,
      revisionHash: revision?.contentHash ?? "unknown",
      reviewerPrincipalId: input.actor.principalId,
      decision: "rejected",
      decidedAt: now,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return this.#requireRecord(record.recordId);
  }

  /**
   * Replace an approved value with a new revision.
   *
   * The write is one repository transaction (`correctRevision`): the
   * compare-and-set against the record runs first, and the new revision is
   * inserted — with the previous one marked `superseded` and its interval
   * closed — only when the CAS wins. A lost CAS writes nothing and reports
   * `REVISION_CONFLICT`; it never leaves an orphan revision behind. The
   * record's own `status` stays `approved` across a correction — `superseded`
   * is a revision-level state, and `supersedesRecordId` records cross-record
   * supersession (a proposed fact or lesson naming the kept one it updates, or
   * sharing/promotion), not an in-place correction here.
   */
  correct(input: Parameters<MemoryServicePort["correct"]>[0]): MemoryRecord {
    requireOperator(input.actor, "correct");
    const record = this.get({ actor: input.actor, recordId: input.recordId });
    const now = this.#now();
    const datesGiven = input.validTo !== undefined || input.expiryAt !== undefined;
    // *Keep longer* on an expired record that had been approved returns it to approved.
    const reviving = record.status === "expired" && record.currentRevisionId !== undefined && datesGiven;
    if (record.status !== "approved" && !reviving) {
      throw new TaviError(
        "CONFLICT",
        record.status === "expired" && record.currentRevisionId !== undefined
          ? `Memory record ${record.recordId} has expired; give it a new date to keep it longer`
          : `Memory record ${record.recordId} is ${record.status}; only approved memory is corrected`,
      );
    }
    if (record.currentRevisionId !== (input.expectedRevisionId ?? record.currentRevisionId)) {
      // The caller's expectation refers to a revision that is no longer current.
      throw new TaviError("REVISION_CONFLICT", `Memory record ${record.recordId} was corrected by someone else`);
    }
    if (input.preference !== undefined && record.preferenceKey === undefined) {
      throw new TaviError("INVALID_INPUT", `Memory record ${record.recordId} is not a preference`);
    }
    if (record.preferenceKey !== undefined && input.validTo !== undefined && input.validTo !== null) {
      throw new TaviError("INVALID_INPUT", PREFERENCE_VALID_TO_REFUSAL);
    }
    if (input.topicKey !== undefined && (record.kind !== "fact" || record.topicKey !== undefined)) {
      throw new TaviError("INVALID_INPUT", `Memory record ${record.recordId} cannot be assigned a topic key`);
    }
    validateBounds({ title: input.title, body: input.body, topicKey: input.topicKey, keywords: input.keywords });
    for (const [name, date] of [
      ["validTo", input.validTo],
      ["expiryAt", input.expiryAt],
    ] as const) {
      if (date === undefined || date === null) continue;
      if (!TimestampSchema.safeParse(date).success) throw new TaviError("INVALID_INPUT", `${name} must be an ISO 8601 timestamp`);
      // A date moves an end later; an end already past is a forget, not a correction.
      if (date <= now) throw new TaviError("INVALID_INPUT", `${name} must be in the future`);
    }
    if (reviving) {
      // Revived, the record must be current: the date it lapsed on is moved, not the other one only.
      const validTo = input.validTo === undefined ? record.validTo : (input.validTo ?? undefined);
      const expiryAt = input.expiryAt === undefined ? record.expiryAt : (input.expiryAt ?? undefined);
      if ((validTo !== undefined && validTo <= now) || (expiryAt !== undefined && expiryAt <= now)) {
        throw new TaviError("INVALID_INPUT", `Memory record ${record.recordId} would still be past: move the date it expired on`);
      }
      if (record.preferenceKey !== undefined) {
        // Another value kept for its key meanwhile wins: the person replaces it, or keeps this one gone.
        this.#expireLapsedPreferences(record, now);
        this.#assertNoActivePreferenceClash(record);
      }
    }

    const previous = this.#memory.listRevisions(record.recordId);
    const currentRevision = previous[0];
    const previousBytes = Buffer.byteLength(currentRevision?.title ?? "", "utf8") + Buffer.byteLength(currentRevision?.body ?? "", "utf8");
    const newBytes =
      Buffer.byteLength(input.title ?? currentRevision?.title ?? "", "utf8") +
      Buffer.byteLength(input.body ?? currentRevision?.body ?? "", "utf8");
    this.#assertCorrectionWithinQuota(input.actor, previousBytes, newBytes);

    // Keywords given replace the old ones (an empty list clears them). None given: the old ones
    // are kept while the words are (a date or value change), and dropped with words they described.
    const sameWords =
      (input.body === undefined || input.body === currentRevision?.body) &&
      (input.title === undefined || input.title === currentRevision?.title);
    const keywords = input.keywords !== undefined ? normalizeKeywords(input.keywords) : sameWords ? currentRevision?.keywords : undefined;
    const nextNumber = (currentRevision?.revisionNumber ?? 0) + 1;
    // A correction keeps where the words came from, joined with what an applied update brings.
    const provenance = joinMemoryProvenance(currentRevision?.provenance, this.#validProvenance(input.provenance));
    const revisionId = this.#newId("memrev");
    const revision: MemoryRevision = {
      revisionId,
      recordId: record.recordId,
      revisionNumber: nextNumber,
      schemaVersion: MEMORY_FTS_SCHEMA_VERSION,
      contentHash: hashContent(input.title ?? currentRevision?.title, input.body ?? currentRevision?.body),
      author: input.actor.caller,
      sourceIds: [],
      recordedAt: now,
      sensitivity: record.sensitivity,
      status: "active",
      // An omitted title is kept as the body is: a date or value correction never un-titles a record.
      ...((input.title ?? currentRevision?.title) === undefined ? {} : { title: input.title ?? currentRevision?.title }),
      ...((input.body ?? currentRevision?.body) === undefined ? {} : { body: input.body ?? currentRevision?.body }),
      ...(currentRevision?.observedAt === undefined ? {} : { observedAt: currentRevision.observedAt }),
      ...(keywords === undefined ? {} : { keywords }),
      ...(provenance === undefined ? {} : { provenance }),
    };
    // A body-only correction must not silently un-type a preference: carry the
    // previous typed value forward when the caller supplies none.
    const priorValue = currentRevision?.preference;
    const preference =
      record.preferenceKey === undefined
        ? undefined
        : input.preference !== undefined
          ? { revisionId, key: record.preferenceKey, valueType: input.preference.valueType, value: input.preference.value }
          : priorValue === undefined
            ? undefined
            : { revisionId, key: record.preferenceKey, valueType: priorValue.valueType, value: priorValue.value };

    let applied: boolean;
    try {
      applied = this.#memory.correctRevision({
        recordId: record.recordId,
        expectedCurrentRevisionId: record.currentRevisionId ?? null,
        revision,
        now,
        ...(preference === undefined ? {} : { preference }),
        // The corrected content's key, so dedup matches what the record says now.
        contentKey:
          memoryContentKey({
            kind: record.kind,
            scopeKey: record.scopeKey,
            preferenceKey: record.preferenceKey,
            topicKey: input.topicKey ?? record.topicKey,
            body: revision.body,
            ...(preference === undefined ? {} : { preferenceValue: preference.value }),
          }) ?? null,
        ...(reviving ? { expectedStatus: "expired" as const } : {}),
        ...definedOnly({ topicKey: input.topicKey, validTo: input.validTo, expiryAt: input.expiryAt }),
      });
    } catch (error) {
      // A revival that races another value of its key through the pre-check meets the database's own index.
      if (isUniqueConstraintError(error)) {
        throw new TaviError("MEMORY_CONFLICT", `Preference ${record.preferenceKey ?? ""} already has an active value in this scope`, {
          details: { recordId: record.recordId },
        });
      }
      throw error;
    }
    if (!applied) {
      throw new TaviError("REVISION_CONFLICT", `Memory record ${record.recordId} changed while correcting it`);
    }
    this.#memory.recordReview({
      reviewId: this.#newId("memreview"),
      recordId: record.recordId,
      revisionId,
      revisionHash: revision.contentHash,
      reviewerPrincipalId: input.actor.principalId,
      decision: "approved",
      decidedAt: now,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return this.#requireRecord(record.recordId);
  }

  /** Revoke an approved record. Idempotent: revoking an already-revoked record is a no-op. */
  revoke(input: Parameters<MemoryServicePort["revoke"]>[0]): MemoryRecord {
    requireOperator(input.actor, "revoke");
    const record = this.get({ actor: input.actor, recordId: input.recordId });
    if (record.status === "revoked") return record;
    if (record.status !== "approved") {
      throw new TaviError("CONFLICT", `Memory record ${record.recordId} is ${record.status}; only approved memory is revoked`);
    }
    validateReason(input.reason);
    const now = this.#now();
    const applied = this.#memory.applyLifecycle({
      recordId: record.recordId,
      expectedCurrentRevisionId: record.currentRevisionId ?? null,
      expectedStatus: "approved",
      status: "revoked",
      validTo: now,
      updatedAt: now,
      reindexOnApproval: false,
    });
    if (!applied) {
      throw new TaviError("REVISION_CONFLICT", `Memory record ${record.recordId} changed while revoking it`);
    }
    // A revoked record stops being retrievable, but its body is retained until an
    // explicit forgetting request.
    this.#memory.deindex(record.recordId);
    return this.#requireRecord(record.recordId);
  }

  /**
   * Erase a record. The repository's `forget` transaction is authoritative
   * for `deletionGeneration` and `cleanupStatus` — it recomputes both rather
   * than trusting the caller — so only the caller's own identity fields are
   * built here, and the persisted receipt is read back by its own id rather
   * than "latest in scope", which could return a sibling deletion if two
   * share a scope and timestamp.
   */
  forget(input: Parameters<MemoryServicePort["forget"]>[0]): MemoryDeletion {
    requireOperator(input.actor, "forget");
    const record = this.get({ actor: input.actor, recordId: input.recordId });
    validateReason(input.reason);
    const now = this.#now();
    const deletionId = this.#newId("memdel");
    const deletion: MemoryDeletion = {
      deletionId,
      recordId: record.recordId,
      scopeKey: record.scopeKey,
      deletionGeneration: this.#memory.revocationGeneration(record.scopeKey) + 1,
      requestedBy: input.actor.principalId,
      reason: input.reason,
      requestedAt: now,
      cleanupStatus: "pending",
    };
    this.#memory.forget({ recordId: record.recordId, deletion, updatedAt: now });
    // The pre-write `deletion` object is never returned as a fallback: its
    // cleanupStatus ("pending") is already stale the instant the transaction
    // above completes, since the repository always advances it to "complete"
    // in that same transaction. A missing row here is a real bug, not a
    // reason to hand back a receipt that quietly lies about cleanup status.
    const persisted = this.#memory.getDeletion(deletionId);
    if (persisted === undefined) {
      throw new TaviError("INTERNAL", `Deletion ${deletionId} was not persisted`);
    }
    return persisted;
  }

  // The port's reads (`./reads.ts`).
  get(...args: Parameters<MemoryReads["get"]>): ReturnType<MemoryReads["get"]> {
    return this.#reads.get(...args);
  }
  list(...args: Parameters<MemoryReads["list"]>): ReturnType<MemoryReads["list"]> {
    return this.#reads.list(...args);
  }
  search(...args: Parameters<MemoryReads["search"]>): ReturnType<MemoryReads["search"]> {
    return this.#reads.search(...args);
  }
  eligible(...args: Parameters<MemoryReads["eligible"]>): ReturnType<MemoryReads["eligible"]> {
    return this.#reads.eligible(...args);
  }
  resolvePreferences(...args: Parameters<MemoryReads["resolvePreferences"]>): ReturnType<MemoryReads["resolvePreferences"]> {
    return this.#reads.resolvePreferences(...args);
  }
  resolveProfile(...args: Parameters<MemoryReads["resolveProfile"]>): ReturnType<MemoryReads["resolveProfile"]> {
    return this.#reads.resolveProfile(...args);
  }
  resolveFactConflicts(...args: Parameters<MemoryReads["resolveFactConflicts"]>): ReturnType<MemoryReads["resolveFactConflicts"]> {
    return this.#reads.resolveFactConflicts(...args);
  }
  export(...args: Parameters<MemoryReads["export"]>): ReturnType<MemoryReads["export"]> {
    return this.#reads.export(...args);
  }
  usage(...args: Parameters<MemoryReads["usage"]>): ReturnType<MemoryReads["usage"]> {
    return this.#reads.usage(...args);
  }
  operatorView(...args: Parameters<MemoryReads["operatorView"]>): ReturnType<MemoryReads["operatorView"]> {
    return this.#reads.operatorView(...args);
  }
  history(...args: Parameters<MemoryReads["history"]>): ReturnType<MemoryReads["history"]> {
    return this.#reads.history(...args);
  }
  related(...args: Parameters<MemoryReads["related"]>): ReturnType<MemoryReads["related"]> {
    return this.#reads.related(...args);
  }
  counts(...args: Parameters<MemoryReads["counts"]>): ReturnType<MemoryReads["counts"]> {
    return this.#reads.counts(...args);
  }
  principals(...args: Parameters<MemoryReads["principals"]>): ReturnType<MemoryReads["principals"]> {
    return this.#reads.principals(...args);
  }

  /** A caller's provenance, checked at the port: `INVALID_INPUT` when it is not one. */
  #validProvenance(provenance: MemoryProvenance | undefined): MemoryProvenance | undefined {
    if (provenance === undefined) return undefined;
    const parsed = MemoryProvenanceSchema.safeParse(provenance);
    if (!parsed.success) throw new TaviError("INVALID_INPUT", "A memory provenance must be a bounded label summary");
    // Only an untrusted provenance is stored: absent is the one encoding of clean.
    if (parsed.data.integrity !== "untrusted") return undefined;
    // Joined with the identity, so what is stored is canonical (sources ordered, refs newest first).
    return joinMemoryProvenance(parsed.data, { integrity: "trusted", sources: [], refs: [] });
  }

  /**
   * Retention over the actor's authorized scopes, in two steps:
   *
   *  - a proposal nobody reviewed within `policy.proposedOrRejected` days of
   *    being proposed (or by its own earlier `expiryAt`) becomes `expired`.
   *    Its body stays for that window, so the operator can still see what
   *    lapsed; the record is not current and never was, so nothing is
   *    deindexed;
   *  - an approved record whose own `expiryAt` passed (a preference or
   *    lesson) becomes `expired` too, compare-and-set on `approved`
   *    and its revision, so a concurrent *Keep longer* wins. A fact's
   *    `validTo` never marks it: an ended fact stays approved, as history;
   *  - a rejection, or any expired record, untouched for another window
   *    since it lapsed (its `updatedAt`, the mark, never its own date), and
   *    a run-local record past its own, is erased through the ordinary
   *    `forget` path.
   *
   * `run_local`'s "7 days after task completion" is approximated as 7 days
   * since the record was last touched (`updatedAt`): completion isn't a fact
   * this service tracks on a memory record, and a record that is still being
   * actively used keeps advancing `updatedAt` via correction, so this only
   * sweeps a `run_local` record that has genuinely gone quiet. A run-local
   * proposal is erased with its run rather than expired.
   *
   * Best-effort per record, not all-or-nothing: a candidate whose change
   * fails (e.g. it was already forgotten, or approved, by a concurrent call)
   * is simply absent from the returned list rather than aborting the rest of
   * the sweep. A caller does not need to distinguish "already gone" from
   * "swept just now" — both mean the record is gone.
   *
   * Each candidate list is capped at `MEMORY_EXPORT_HARD_CAP` (2000), the
   * same bound `export`/`resolvePreferences` use, with no `truncated`
   * signal on this return type: re-running a sweep with an unchanged policy
   * naturally reaches the next 2000 eligible records (already-swept ones no
   * longer match), so a scheduler that runs this repeatedly needs no signal
   * to eventually catch up. A single call is not guaranteed complete past
   * that cap.
   */
  sweepExpired(input: Parameters<MemoryServicePort["sweepExpired"]>[0]): readonly {
    readonly recordId: string;
    readonly reason: string;
    readonly outcome: "expired" | "forgotten";
  }[] {
    requireOperator(input.actor, "sweep");
    const policy = input.policy ?? DEFAULT_MEMORY_RETENTION_DAYS;
    const now = this.#now();
    const cutoff = (days: number): string => new Date(new Date(now).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const proposedOrRejectedCutoff = cutoff(policy.proposedOrRejected);
    const runLocalCutoff = cutoff(policy.runLocal);

    const scopeKeys = authorizedScopeKeys(this.#policy, input.actor);
    const runLocal = this.#reads.listAllRecords(scopeKeys, {}, MEMORY_EXPORT_HARD_CAP).records.filter(
      (record) =>
        // A chat note lives as long as its chat: it is not working memory.
        record.scope.kind === "run_local" && record.durable !== true && record.status !== "deleted" && record.updatedAt <= runLocalCutoff,
    );
    const runLocalIds = new Set(runLocal.map((record) => record.recordId));
    const lapsed = this.#reads
      .listAllRecords(scopeKeys, { statuses: ["proposed", "rejected", "expired"] }, MEMORY_EXPORT_HARD_CAP)
      .records.filter((record) => !runLocalIds.has(record.recordId));
    // Proposed at `recordedAt`: a proposal is never edited, only decided. Its
    // own end date lapses it too, a fact's `validTo` as a preference's
    // `expiryAt`: nothing nobody approved is kept as history.
    const toExpire = lapsed.filter(
      (record) =>
        record.status === "proposed" &&
        (record.recordedAt <= proposedOrRejectedCutoff ||
          (record.expiryAt !== undefined && record.expiryAt <= now) ||
          (record.validTo !== undefined && record.validTo <= now)),
    );
    // An approved preference or lesson past its `expiryAt` expires. A
    // fact's `validTo` never marks it: an ended fact is kept, approved, as history.
    // Read through the *lapsedExpiry* filter, so the cap bounds only the records to mark.
    const toMark = this.#reads
      .listAllRecords(scopeKeys, { lapsedExpiry: { now } }, MEMORY_EXPORT_HARD_CAP)
      .records.filter((record) => !runLocalIds.has(record.recordId));
    // An expired record is erased a window after it expired: after the
    // sweep's mark (`updatedAt`), not its `expiryAt`, so a record that expired
    // long before the sweep first saw it still gets the whole window.
    const toForget = [
      ...lapsed.filter(
        (record) => (record.status === "rejected" || record.status === "expired") && record.updatedAt <= proposedOrRejectedCutoff,
      ),
      ...runLocal,
    ];

    const swept: { recordId: string; reason: string; outcome: "expired" | "forgotten" }[] = [];
    for (const record of toMark) {
      // Compare-and-set on `approved` and the revision read: a *Keep longer*
      // that lands first moved the date in a new revision, and wins.
      if (this.#markExpired(record, now)) {
        swept.push({ recordId: record.recordId, reason: "retention: expired on its own date", outcome: "expired" });
      }
    }
    for (const record of toExpire) {
      // Compare-and-set on `proposed`: an approval that lands first wins, and
      // this record is then simply not swept.
      const applied = this.#memory.applyLifecycle({
        recordId: record.recordId,
        expectedCurrentRevisionId: null,
        expectedStatus: "proposed",
        status: "expired",
        updatedAt: now,
      });
      if (applied) {
        swept.push({
          recordId: record.recordId,
          reason: `retention: proposal not reviewed within ${policy.proposedOrRejected} days`,
          outcome: "expired",
        });
      }
    }
    // Best-effort, not all-or-nothing: one record already forgotten by a
    // concurrent sweep or an explicit request must not abandon every
    // candidate after it. forget() is safe to retry on the records that did
    // succeed, since a swept record simply won't appear as a candidate again.
    for (const record of toForget) {
      // Re-read: a *Keep longer* that revived the record since the read above wins, and it is not erased.
      const current = this.#memory.getRecord(record.recordId);
      if (current === undefined || current.status !== record.status || current.updatedAt !== record.updatedAt) continue;
      const reason =
        record.scope.kind === "run_local"
          ? `retention: run-local memory expired after ${policy.runLocal} days`
          : `retention: ${record.status} memory erased ${policy.proposedOrRejected} days after it lapsed`;
      try {
        this.forget({ actor: input.actor, recordId: record.recordId, reason });
        swept.push({ recordId: record.recordId, reason, outcome: "forgotten" });
      } catch {
        // Skipped, not re-thrown: this record's own state (already gone, or
        // otherwise no longer eligible) is why it isn't in the swept list.
      }
    }
    return swept;
  }

  #assertWithinQuota(actor: MemoryActor, body: string): void {
    const usage = this.#memory.usage(authorizedScopeKeys(this.#policy, actor));
    if (usage.records + 1 > this.#quotas.maxRecords) {
      throw new TaviError("QUOTA_EXCEEDED", "This principal's memory record quota is full", {
        details: { records: usage.records, maxRecords: this.#quotas.maxRecords },
      });
    }
    if (usage.bytes + Buffer.byteLength(body, "utf8") > this.#quotas.maxBytes) {
      throw new TaviError("QUOTA_EXCEEDED", "This principal's memory byte quota is full", {
        details: { bytes: usage.bytes, maxBytes: this.#quotas.maxBytes },
      });
    }
  }

  /** A correction is charged only for the bytes it adds, never a record slot. */
  #assertCorrectionWithinQuota(actor: MemoryActor, previousBytes: number, newBytes: number): void {
    const delta = newBytes - previousBytes;
    if (delta <= 0) return;
    const usage = this.#memory.usage(authorizedScopeKeys(this.#policy, actor));
    if (usage.bytes + delta > this.#quotas.maxBytes) {
      throw new TaviError("QUOTA_EXCEEDED", "This principal's memory byte quota is full", {
        details: { bytes: usage.bytes, maxBytes: this.#quotas.maxBytes },
      });
    }
  }

  #latestRevisionId(recordId: string): string {
    const latest = this.#memory.listRevisions(recordId)[0];
    if (latest === undefined) {
      throw new TaviError("NOT_FOUND", `Memory record ${recordId} has no revisions`);
    }
    return latest.revisionId;
  }

  #requireRecord(recordId: string): MemoryRecord {
    const record = this.#memory.getRecord(recordId);
    if (record === undefined) throw new TaviError("NOT_FOUND", `Memory record ${recordId} does not exist`);
    return record;
  }

  /** Every cited source must exist, be visible to the actor, and not be revoked. */
  /**
   * A cited source that is *known and revoked* is refused; an id with no
   * matching `EvidenceSource` row is not itself an error — there is no
   * service-level path that creates evidence records ahead of a citation, so
   * an unrecognized id is simply not yet backed by one. What this closes is
   * the case that matters: citing evidence whose access has already been
   * withdrawn.
   */
  #assertSourcesAvailable(actor: MemoryActor, sourceIds: readonly string[] | undefined): void {
    if (sourceIds === undefined || sourceIds.length === 0) return;
    const authorized = new Set(authorizedScopeKeys(this.#policy, actor));
    const visible = new Map(
      this.#memory
        .listEvidence({ scopeKeys: [...authorized], limit: MEMORY_LIST_PAGE_MAX })
        .map((source) => [source.sourceId, source] as const),
    );
    for (const sourceId of sourceIds) {
      const source = visible.get(sourceId);
      if (source !== undefined && source.revocationStatus === "revoked") {
        throw new TaviError("SOURCE_UNAVAILABLE", `Source ${sourceId} has been revoked`, {
          details: { sourceId },
        });
      }
    }
  }

  /** The approved preferences in `record`'s scope, every page: the one-active-value rule reads them all. */
  #approvedPreferences(record: MemoryRecord): readonly MemoryRecord[] {
    return this.#reads.listAllRecords([record.scopeKey], { kinds: ["preference"], statuses: ["approved"] }, MEMORY_EXPORT_HARD_CAP).records;
  }

  /**
   * Mark `expired` every other approved value of `record`'s preference key whose
   * `expiryAt` has passed: until the sweep marks it,
   * such a value is still `approved` with no `valid_to`, so the one-active-value
   * index would refuse a new value it no longer stands in the way of. The same
   * compare-and-set as the sweep's, in the same worker call as the write it
   * makes room for.
   */
  #expireLapsedPreferences(record: MemoryRecord, now: string): void {
    const key = record.preferenceKey;
    if (key === undefined) return;
    for (const other of this.#approvedPreferences(record)) {
      if (other.recordId === record.recordId || other.preferenceKey !== key || other.expiryAt === undefined || other.expiryAt > now)
        continue;
      this.#markExpired(other, now);
    }
  }

  /** An approved record past its `expiryAt` becomes `expired`, compare-and-set on `approved` and its revision; false when it moved on. */
  #markExpired(record: MemoryRecord, now: string): boolean {
    // The status, its vectors and its index rows change together, or not at all (as `approve` does).
    return this.#persistence.transaction(() => {
      const applied = this.#memory.applyLifecycle({
        recordId: record.recordId,
        expectedCurrentRevisionId: record.currentRevisionId ?? null,
        expectedStatus: "approved",
        status: "expired",
        updatedAt: now,
      });
      // Out of the index with its status: *Keep longer* indexes it again as it revives it.
      if (applied) this.#memory.deindex(record.recordId);
      return applied;
    });
  }

  /**
   * Pre-checks the one-active-preference-per-scope-and-key rule
   * before the write, so the ordinary case reports `MEMORY_CONFLICT` rather
   * than relying only on the database's partial unique index.
   */
  #assertNoActivePreferenceClash(record: MemoryRecord): void {
    const key = record.preferenceKey;
    if (key === undefined) return;
    const clash = this.#approvedPreferences(record).find(
      (other) => other.recordId !== record.recordId && other.preferenceKey === key && other.validTo === undefined,
    );
    if (clash !== undefined) {
      throw new TaviError("MEMORY_CONFLICT", `Preference ${key} already has an active value in this scope`, {
        details: { recordId: record.recordId, conflictRecordId: clash.recordId },
      });
    }
  }
}
