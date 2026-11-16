import { MEMORY_EXPORT_HARD_CAP } from "./limits.js";
import { appendSnippetNote } from "../persistence/store/memory.js";
import { authorizedScopeKeys, keepsOrigin, operatorSees, readScopeKeys, requireOperatorView } from "./access.js";
import {
  bound,
  citesRevokedSource,
  factValuesDiffer,
  hybridPool,
  isCurrent,
  memoryExactAndStemSet,
  memoryNearMatchQuery,
  memoryQueryTerms,
  memoryTermMatchesSet,
  NEAR_MATCH_QUERY_TOKENS,
  preferenceRank,
  toFtsPhraseQuery,
  validateOffset,
  MAX_QUERY_VECTOR_DIMS,
  type ParsedQueryTerm,
  memoryReadsAsDirective,
} from "./rules.js";
import type { MemoryServicePort, PersistencePort } from "../persistence/internal-contracts.js";
import {
  MEMORY_LIST_PAGE_DEFAULT,
  MEMORY_LIST_PAGE_MAX,
  MEMORY_AUTO_APPROVE_KIN_COSINE,
  MEMORY_AUTO_APPROVE_KIN_HITS,
  MEMORY_AUTO_APPROVE_KIN_JACCARD,
  MEMORY_MMR_JACCARD_THRESHOLD,
  MEMORY_NEAR_MATCH_JACCARD,
  MEMORY_RELEVANCE_FLOOR_RARITY,
  MEMORY_RRF_K,
  MEMORY_SEARCH_DEFAULT,
  MEMORY_SEARCH_MAX,
  MEMORY_SUPERSEDED_EXCERPT_CHARS,
  TaviError,
  memoryRelevanceCosineFloor,
  memoryScopeKey,
  memoryExcerptHead,
  memoryExcerptOf,
  memoryTextSimilarity,
  memoryTokenSet,
  CHAT_NOTES_KEY_PREFIX,
  MEMORY_OTHER_PEOPLE_LIMIT,
  MemoryPrincipalsInputSchema,
  MemoryViewInputSchema,
  allChatNotesKey,
  memoryCardTitleOf,
  memoryScopeTarget,
  type EvidenceSource,
  type MemoryReadView,
  type MemoryRelated,
  type MemoryView,
  type MemoryActor,
  type MemoryKind,
  type MemoryRecord,
  type ResolvedPreference,
  type ResolvedProfileEntry,
  type MemoryReview,
  type MemoryRevision,
  type MemoryScope,
  type MemorySearchResult,
  type MemoryStatus,
  type MemorySuperseded,
  parseOrThrow,
} from "@tavi/contracts";
import type { AccessPolicyPort, MemorySearchHit } from "@tavi/contracts";
import { clip, definedOnly, errorMessage } from "@tavi/contracts/util";

/** The most chats `counts` counts notes for in one call: past any session-list page. */
const MAX_COUNTED_CHATS = 500;
/** The longest search query a caller may send. */
const MAX_SEARCH_QUERY_CHARS = 512;
/** Weight of the recency and confirmation prior lists in reciprocal-rank fusion (k = 60). */
const MEMORY_RRF_PRIOR_WEIGHT = 0.05;
/** At most this many hits survive the floor on a query's sole matching term alone. */
const MEMORY_RELEVANCE_FLOOR_ANCHOR_HITS = 3;
/** Weight of the temporal range overlap list in reciprocal-rank fusion (k = 60). */
const MEMORY_TEMPORAL_RANGE_WEIGHT = 0.15;
/** Minimum distinct chats a revision must be used in after being recorded to count as confirmed. */
const MEMORY_CONFIRMATION_MIN_CHATS = 2;
/** Profile candidates read per kind: the 12-entry profile cap with a small over-fetch for the budget cut's count. */
const PROFILE_CANDIDATE_LIMIT = 24;

function overlapsTemporalRange(
  record: MemoryRecord,
  revision: MemoryRevision,
  range: { readonly from: string; readonly to: string },
): boolean {
  const validTo = record.validTo ?? revision.validTo;
  const isSuperseded = record.status === "superseded" || record.currentRevisionId !== revision.revisionId;
  if (range.from === "1970-01-01T00:00:00.000Z") {
    return isSuperseded || (validTo !== undefined && validTo <= range.to);
  }
  const observedAt = revision.observedAt ?? record.recordedAt;
  if (observedAt >= range.from && observedAt <= range.to) return true;
  if (validTo !== undefined) {
    const validFrom = record.validFrom ?? revision.validFrom;
    const intervalStart = validFrom !== undefined && validFrom < observedAt ? validFrom : observedAt;
    if (intervalStart <= range.to && validTo > range.from) return true;
  }
  return false;
}

/**
 * Memory's reads: one record, a list, a search and automatic recall's
 * eligible set, the resolved preferences and conflicting facts, an export,
 * the operator's view, a record's history and kin, and the counts. Every read
 * is scoped by the actor, never by the request (`./access.js`). The service
 * (`./service.ts`) answers its port's reads through this.
 */
export class MemoryReads {
  readonly #persistence: PersistencePort;
  readonly #now: () => string;
  readonly #policy: AccessPolicyPort | undefined;

  constructor(persistence: PersistencePort, options: { readonly now: () => string; readonly policy: AccessPolicyPort | undefined }) {
    this.#persistence = persistence;
    this.#now = options.now;
    this.#policy = options.policy;
  }

  get #memory() {
    return this.#persistence.repositories.memory;
  }

  /**
   * The records a proposal's revision supersedes: the memory
   * revisions its `contains` lineage edges come from, each with its record.
   * Edges from anything else are not inputs.
   */
  supersedesOf(
    revisionId: string,
    recordId: string,
  ): readonly { readonly recordId: string; readonly revisionId: string; readonly revision?: MemoryRevision }[] {
    const inputs: { recordId: string; revisionId: string; revision?: MemoryRevision }[] = [];
    for (const edge of this.#memory.listLineage({ toRevisionId: revisionId })) {
      if (edge.dependencyKind !== "contains") continue;
      const revision = this.#memory.getRevision(edge.fromRevisionId);
      // A forgotten input's revisions are gone: the edge (marked `blocked` by the forget) still names it.
      const inputRecordId = revision?.recordId ?? (edge.affectedSourceIds.length === 1 ? edge.affectedSourceIds[0] : undefined);
      if (inputRecordId === undefined || inputRecordId === recordId) continue;
      inputs.push({ recordId: inputRecordId, revisionId: edge.fromRevisionId, ...(revision === undefined ? {} : { revision }) });
    }
    return inputs;
  }

  /**
   * A single record by id. `deleted` is reported as `NOT_FOUND`, same as an
   * unauthorized one. Authorized either by scope, or by an explicit
   * `actor.allowedRecordIds` grant — without the
   * latter, `search()`/`resolvePreferences()` could surface a granted
   * record's id while a direct `get()` for that same id threw `NOT_FOUND`,
   * and — more consequentially — `spawn()`'s own
   * re-grant validation (`packages/agent-host/src/agents/agent-communication.ts`,
   * checking whether a restricted worker may share one of ITS granted
   * records with a grandchild) calls this exact method under a
   * `scopeRestricted`/`allowedRecordIds`-carrying actor and would
   * otherwise incorrectly reject re-sharing a record the worker was
   * legitimately granted.
   */
  get(input: { readonly actor: MemoryActor; readonly recordId: string; readonly view?: MemoryReadView }): MemoryRecord {
    if (input.view === "operator") return this.#operatorRecord(input.actor, input.recordId);
    const record = this.#memory.getRecord(input.recordId);
    const authorized = authorizedScopeKeys(this.#policy, input.actor);
    const explicitlyGranted = input.actor.allowedRecordIds?.includes(input.recordId) === true;
    const chatNote = record?.durable === true && authorized.includes(`${CHAT_NOTES_KEY_PREFIX}${record.scopeKey}`);
    if (record === undefined || !(authorized.includes(record.scopeKey) || chatNote || explicitlyGranted)) {
      // An unauthorized record is reported as absent: existence itself is
      // information.
      throw new TaviError("NOT_FOUND", `Memory record ${input.recordId} does not exist`);
    }
    if (record.status === "deleted") {
      throw new TaviError("NOT_FOUND", `Memory record ${input.recordId} does not exist`);
    }
    return record;
  }

  /**
   * A bounded, offset-paginated page of records. Always excludes `deleted`
   * tombstones regardless of the requested `statuses`; sensitive records are
   * included, labeled — this is an explicit inspection path, not automatic
   * retrieval.
   */
  list(input: Parameters<MemoryServicePort["list"]>[0]): readonly (MemoryRecord & { readonly currentRevision?: MemoryRevision })[] {
    const limit = bound(input.limit ?? MEMORY_LIST_PAGE_DEFAULT, MEMORY_LIST_PAGE_MAX);
    const offset = validateOffset(input.offset);
    const scopeKeys = this.#viewScopeKeys(input);
    if (scopeKeys.length === 0) return [];
    const records = this.#memory.listRecords({
      scopeKeys,
      limit,
      offset,
      ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
      ...(input.originTaskId === undefined ? {} : { originTaskId: input.originTaskId }),
      ...(input.past === true ? { past: { now: this.#now() } } : {}),
      // A listing never includes erased records, whatever the caller asks for.
      statuses: (input.statuses ?? ["proposed", "approved", "rejected", "superseded", "revoked", "expired"]).filter(
        (status) => status !== "deleted",
      ),
    });
    if (input.withCurrentRevision !== true) return records;
    return records.map((record) => {
      const currentRevision = record.currentRevisionId === undefined ? undefined : this.#memory.getRevision(record.currentRevisionId);
      return currentRevision === undefined ? record : { ...record, currentRevision };
    });
  }

  search(input: Parameters<MemoryServicePort["search"]>[0]): MemorySearchResult {
    const query = input.query.trim();
    // Meaning alone: a turn whose words hold no keyword still recalls under hybrid.
    // Blank words with no vector have nothing to match: no hits, as when no search ran.
    const meaningOnly = query.length === 0 && (input.semantic?.trim() ?? "") !== "" && input.view !== "operator";
    if (query.length === 0 && !meaningOnly) {
      throw new TaviError("INVALID_INPUT", "A search query must not be blank");
    }
    if (meaningOnly && input.queryVector === undefined) return { hits: [], coverage: "complete" };
    if (query.length > MAX_SEARCH_QUERY_CHARS) {
      throw new TaviError("INVALID_INPUT", `Search query exceeds ${MAX_SEARCH_QUERY_CHARS} characters`);
    }
    if (
      input.queryVector !== undefined &&
      (input.queryVector.vector.length === 0 || input.queryVector.vector.length > MAX_QUERY_VECTOR_DIMS)
    ) {
      throw new TaviError("INVALID_INPUT", `A query vector needs 1 to ${MAX_QUERY_VECTOR_DIMS} dimensions`);
    }
    const limit = bound(input.limit ?? MEMORY_SEARCH_DEFAULT, MEMORY_SEARCH_MAX);
    if (input.view === "operator") return this.#operatorSearch(input, query, limit);
    if (input.scopeKeys !== undefined || input.chats !== undefined || input.chatNotes !== undefined) {
      throw new TaviError("INVALID_INPUT", "scopeKeys, chats and chatNotes narrow the operator's view only");
    }
    const scopeKeys = readScopeKeys(this.#policy, input.actor, input.scope);
    const now = this.#now();
    // Recheck cited-source validity on every call, not just once at propose
    // time. Computed once, before ranking (so hybrid's
    // fusion never gives a revoked source's record a slot), and threaded into
    // the nested `resolvePreferences`/`resolveFactConflicts` calls below
    // (their internal-only second parameter), so one `search()` call triggers
    // the `listEvidence` lookup once, not up to three times.
    const revokedSourceIds = this.#revokedSourceIds(input.actor);
    const requestedMatch = input.match ?? "all";
    const includePast = input.includePast === true || (input.range !== undefined && input.range.to < now);
    let retriedAny = false;
    let lexicalAnyFound = false;
    let hits: readonly {
      readonly record: MemoryRecord;
      readonly revision: MemoryRevision;
      readonly snippet: string;
      readonly match?: "meaning";
      readonly cosine?: number;
    }[];
    let nearDuplicateKeys: ReadonlySet<string> = new Set();
    // Hybrid recall ranks a wider lexical pool before fusing it with the cosine ranks.
    const hybrid = input.queryVector !== undefined;
    let coverage: "complete" | "partial" = "complete";
    let reducedReason: string | undefined;
    try {
      // Quoted as an FTS5 phrase so the caller's text is never parsed as query
      // syntax: a stray `"`, `*` or `NEAR(` is a literal token, not a syntax
      // error reported as "index unavailable" (no matches is distinct from a
      // failed index).
      const searchLexical = (mode: "all" | "any") =>
        this.#memory.search({
          scopeKeys,
          query: toFtsPhraseQuery(query, mode),
          limit: hybrid || input.range !== undefined ? hybridPool(limit) : limit,
          now,
          ...(input.includeSensitive === true ? { includeSensitive: true } : {}),
          ...(input.excludeLocalOrigin === true ? { excludeLocalOrigin: true } : {}),
          ...(revokedSourceIds.size === 0 ? {} : { excludeSourceIds: [...revokedSourceIds] }),
          ...(includePast ? { includePast: true } : {}),
        });
      hits = meaningOnly ? [] : searchLexical(requestedMatch);
      if (!meaningOnly && requestedMatch === "all" && hits.length === 0 && query.split(/\s+/).length > 1) {
        const grantedAll = this.#explicitlyGrantedSearchHits(
          input.actor,
          query,
          "all",
          now,
          input.includeSensitive === true,
          revokedSourceIds,
          new Set(),
          includePast,
        ).filter((hit) => keepsOrigin(input, hit.record));
        if (grantedAll.length === 0) {
          hits = searchLexical("any");
          retriedAny = true;
          lexicalAnyFound = hits.some(
            (hit) =>
              (input.includeSensitive === true || hit.record.sensitivity !== "sensitive") &&
              keepsOrigin(input, hit.record) &&
              !citesRevokedSource(hit.revision.sourceIds, revokedSourceIds),
          );
        }
      }
    } catch (error) {
      // A failed index is distinct from "no matches": the caller can retry or
      // fall back rather than being told there is nothing to find.
      return {
        hits: [],
        coverage: "unavailable",
        reducedReason: errorMessage(error, "search index unavailable").slice(0, 300),
      };
    }
    if (input.queryVector !== undefined) {
      try {
        const fused = this.#fuseHybrid(
          input.actor.workspaceId,
          scopeKeys,
          query,
          input.queryVector,
          hits,
          limit,
          input.applyFloor === true ? hybridPool(limit) : limit,
          now,
          revokedSourceIds,
          input.excludeLocalOrigin === true,
          includePast,
          input.range,
          input.rankingPriors !== false,
        );
        hits = fused.hits;
        nearDuplicateKeys = fused.nearDuplicateKeys;
        if (fused.missing > 0) {
          coverage = "partial";
          reducedReason = meaningOnly
            ? `${fused.missing} of ${fused.eligible} records have no vector yet, and the message held no words to match them by`
            : `${fused.missing} of ${fused.eligible} records have no vector yet, so they matched by their words only`;
        }
      } catch (error) {
        // Words alone, said rather than hidden.
        hits = hits.slice(0, limit);
        coverage = "partial";
        reducedReason = `meaning search failed (${errorMessage(error, "unknown error").slice(0, 200)}); ${meaningOnly ? "the message held no words to match by" : "matched by words only"}`;
      }
    }
    // Sensitivity is filtered here, not left to the repository: automatic
    // retrieval has no declared purpose yet.
    // A chat on a remote model recalls no local chat's record.
    const sensitivityFiltered = hits.filter(
      (hit) => (input.includeSensitive === true || hit.record.sensitivity !== "sensitive") && keepsOrigin(input, hit.record),
    );
    const scopedVisible =
      revokedSourceIds.size === 0
        ? sensitivityFiltered
        : sensitivityFiltered.filter((hit) => !citesRevokedSource(hit.revision.sourceIds, revokedSourceIds));
    // Explicitly-granted records participate in this
    // same search, exempted from scope authorization but not from any other
    // filter — see `#explicitlyGrantedSearchHits`'s own doc comment.
    // Granted records are matched by words: a meaning-only search has none to match them by.
    const grantedHits = meaningOnly
      ? []
      : this.#explicitlyGrantedSearchHits(
          input.actor,
          query,
          retriedAny ? "any" : requestedMatch,
          now,
          input.includeSensitive === true,
          revokedSourceIds,
          new Set(scopedVisible.map((hit) => hit.record.recordId)),
          includePast,
        ).filter((hit) => keepsOrigin(input, hit.record));
    const matchedAny = lexicalAnyFound || (retriedAny && grantedHits.length > 0);
    const includeSensitive = input.includeSensitive === true;
    const rawPoolVisible = [...scopedVisible, ...grantedHits];
    const poolVisible =
      input.queryVector !== undefined || rawPoolVisible.length <= 1
        ? rawPoolVisible
        : this.#applyRankingPriors(
            rawPoolVisible.map((hit, index) => ({
              hit,
              score: 1 / (MEMORY_RRF_K + index + 1),
              order: index,
            })),
            query,
            input.range,
            input.rankingPriors !== false,
          );
    const conflictsWith = this.#detectConflicts(input.actor, poolVisible, includeSensitive, revokedSourceIds);
    const filteredVisible =
      input.applyFloor === true
        ? this.#applyFloorAndMmr({
            scopeKeys,
            query,
            ...(input.queryVector === undefined ? {} : { queryVector: input.queryVector }),
            candidates: poolVisible,
            conflictsWith,
            nearDuplicateKeys,
            ...(input.alreadyShownIds === undefined ? {} : { alreadyShownIds: input.alreadyShownIds }),
            now,
            includeSensitive,
            excludeLocalOrigin: input.excludeLocalOrigin === true,
            revokedSourceIds,
          })
        : poolVisible;
    // Re-bounded to the caller's own `limit`: `grantedHits` is bounded
    // separately (at `MAX_SHARED_MEMORY_RECORD_IDS`), but the merged list
    // must still honor the documented "maximum hits to return" contract
    // rather than silently returning up to `limit + 32`.
    const visible = filteredVisible.slice(0, limit);
    return {
      hits: this.#renderHitsWithConflicts(visible, conflictsWith, now),
      coverage,
      ...(reducedReason === undefined ? {} : { reducedReason }),
      ...(matchedAny ? { match: "any" as const } : {}),
    };
  }

  eligible(input: Parameters<MemoryServicePort["eligible"]>[0]): readonly MemorySearchHit[] {
    const recordIds = [...new Set(input.recordIds)];
    if (recordIds.length > MEMORY_SEARCH_MAX) {
      throw new TaviError("INVALID_INPUT", `At most ${MEMORY_SEARCH_MAX} record ids are checked at once`);
    }
    if (recordIds.length === 0) return [];
    const scopeKeys = readScopeKeys(this.#policy, input.actor, input.scope);
    const now = this.#now();
    const includeSensitive = input.includeSensitive === true;
    // `search`'s filters, in its order, by id instead of by words (invariant 4).
    const found = this.#memory.eligibleByIds({ scopeKeys, recordIds, now });
    const revokedSourceIds = this.#revokedSourceIds(input.actor);
    const scopedVisible = found.filter(
      (hit) =>
        (includeSensitive || hit.record.sensitivity !== "sensitive") &&
        keepsOrigin(input, hit.record) &&
        !citesRevokedSource(hit.revision.sourceIds, revokedSourceIds),
    );
    const asked = new Set(recordIds);
    // An explicit grant with no words to match holds every word: only the ids asked for are kept.
    const granted = this.#explicitlyGrantedSearchHits(
      input.actor,
      "",
      "all",
      now,
      includeSensitive,
      revokedSourceIds,
      new Set(scopedVisible.map((hit) => hit.record.recordId)),
    ).filter((hit) => asked.has(hit.record.recordId) && keepsOrigin(input, hit.record));
    const byId = new Map([...scopedVisible, ...granted].map((hit) => [hit.record.recordId, hit]));
    const visible = recordIds.flatMap((recordId) => {
      const hit = byId.get(recordId);
      return hit === undefined ? [] : [hit];
    });
    const conflictsWith = this.#detectConflicts(input.actor, visible, includeSensitive, revokedSourceIds);
    return this.#renderHitsWithConflicts(visible, conflictsWith, now);
  }

  /**
   * Detect preference and fact conflicts for `visible` using the same
   * detectors `resolvePreferences` and `resolveFactConflicts` use.
   */
  #detectConflicts(
    actor: MemoryActor,
    visible: readonly {
      readonly record: MemoryRecord;
      readonly revision: MemoryRevision;
      readonly snippet: string;
      readonly match?: "meaning";
    }[],
    includeSensitive: boolean,
    revokedSourceIds: ReadonlySet<string>,
  ): ReadonlyMap<string, readonly string[]> {
    // A preference hit's conflict status reuses the same same-scope-tier
    // detector `resolvePreferences` uses, rather than a second definition of
    // "conflict" living only in search — scoped to only the keys actually
    // present in this result, not a full unfiltered sweep of every preference
    // the actor can see.
    const hitPreferenceKeys = [
      ...new Set(
        visible
          .filter((hit) => hit.record.kind === "preference" && hit.record.preferenceKey !== undefined)
          .map((hit) => hit.record.preferenceKey as string),
      ),
    ];
    // Each conflicting record id → the others it conflicts with, so a prompt can name them.
    const conflictsWith = new Map<string, readonly string[]>();
    const noteConflict = (recordIds: readonly string[]): void => {
      for (const recordId of recordIds) conflictsWith.set(recordId, recordIds.filter((other) => other !== recordId).slice(0, 8));
    };
    if (hitPreferenceKeys.length > 0) {
      for (const resolved of this.resolvePreferences(
        {
          actor,
          keys: hitPreferenceKeys,
          ...(includeSensitive ? { includeSensitive: true } : {}),
        },
        revokedSourceIds,
      ).preferences) {
        if (resolved.conflict) noteConflict(resolved.conflictRecordIds);
      }
    }
    // Same pattern for `kind: "fact"` hits, grouped by `topicKey` instead of
    // `preferenceKey`: contradictory facts retain provenance and conflict
    // status until resolved.
    const hitTopicKeys = [
      ...new Set(
        visible
          .filter((hit) => hit.record.kind === "fact" && hit.record.topicKey !== undefined)
          .map((hit) => hit.record.topicKey as string),
      ),
    ];
    if (hitTopicKeys.length > 0) {
      for (const resolved of this.resolveFactConflicts(
        {
          actor,
          topicKeys: hitTopicKeys,
          ...(includeSensitive ? { includeSensitive: true } : {}),
        },
        revokedSourceIds,
      )) {
        if (resolved.conflict) noteConflict(resolved.records.map((record) => record.recordId));
      }
    }
    return conflictsWith;
  }

  /**
   * Search hits as `search` and `eligible` answer them: each with its
   * precomputed conflict status.
   */
  #renderHitsWithConflicts(
    visible: readonly {
      readonly record: MemoryRecord;
      readonly revision: MemoryRevision;
      readonly snippet: string;
      readonly match?: "meaning";
    }[],
    conflictsWith: ReadonlyMap<string, readonly string[]>,
    now: string,
  ): MemorySearchHit[] {
    // Preference and fact conflicts never mix in `conflictsWith`: the
    // preference sweep only ever names `kind: "preference"` records and the
    // fact sweep `kind: "fact"` ones — `kind` is a single discriminant, so no
    // record id is noted by both.
    return visible.map((hit) => {
      const isSupersededHit = hit.record.status === "superseded" || hit.record.currentRevisionId !== hit.revision.revisionId;
      const isEndedFactHit = hit.record.kind === "fact" && hit.record.validTo !== undefined && hit.record.validTo <= now;
      const others = isSupersededHit || isEndedFactHit ? undefined : conflictsWith.get(hit.record.recordId);
      const conflict = others !== undefined;
      return {
        recordId: hit.record.recordId,
        revisionId: hit.revision.revisionId,
        scope: hit.record.scope,
        kind: hit.record.kind,
        snippet: hit.snippet,
        recordedAt: hit.revision.recordedAt,
        superseded: isSupersededHit,
        conflict,
        ...(others === undefined || others.length === 0 ? {} : { conflictsWith: [...others] }),
        ...definedOnly({ title: hit.revision.title, observedAt: hit.revision.observedAt, match: hit.match }),
      };
    });
  }

  /**
   * Post-ranking relevance floor and MMR near-duplicate filter for automatic
   * turn recall (`applyFloor: true`).
   *
   * - Conflicting records (`conflict: true`) and items already shown in the
   *   epoch's context delta (`alreadyShownIds`) are exempt from both passes.
   * - Lexical floor: a hit matching only a single query term of a multi-term
   *   query (and without a qualifying hybrid cosine score) is kept only when
   *   that term is rare across active records in scope (`< 5%`), or appears in
   *   the record's `title` or `topicKey`/`preferenceKey` without being a
   *   repeated boilerplate title word across the scope. When that one term is
   *   the only query term any candidate matched, its best
   *   `MEMORY_RELEVANCE_FLOOR_ANCHOR_HITS` hits are kept however common it is.
   * - Hybrid floor: a hit with `< 2` matched query terms is kept when its
   *   cosine similarity meets `memoryRelevanceCosineFloor(modelKey)` (`0.30`
   *   default).
   * - MMR pass: drops any non-exempt candidate whose token Jaccard similarity
   *   to an already-selected higher-ranked item is `>= 0.60` or whose vector
   *   cosine similarity is `>= 0.90` — except a pair of facts that may
   *   contradict: lexically near yet each holding a body token the other
   *   lacks, or one ended or replaced.
   */
  #applyFloorAndMmr<
    THit extends {
      readonly record: MemoryRecord;
      readonly revision: MemoryRevision;
      readonly snippet: string;
      readonly match?: "meaning";
      readonly cosine?: number;
    },
  >(input: {
    readonly scopeKeys: readonly string[];
    readonly query: string;
    readonly queryVector?: { readonly modelKey: string; readonly vector: readonly number[]; readonly personal?: false };
    readonly candidates: readonly THit[];
    readonly conflictsWith: ReadonlyMap<string, readonly string[]>;
    readonly nearDuplicateKeys: ReadonlySet<string>;
    readonly alreadyShownIds?: readonly string[];
    readonly now: string;
    readonly includeSensitive: boolean;
    readonly excludeLocalOrigin: boolean;
    readonly revokedSourceIds: ReadonlySet<string>;
  }): readonly THit[] {
    if (input.candidates.length === 0) return input.candidates;
    const alreadyShown = new Set(input.alreadyShownIds ?? []);
    const isExempt = (hit: THit): boolean =>
      input.conflictsWith.has(hit.record.recordId) ||
      alreadyShown.has(hit.record.recordId) ||
      alreadyShown.has(hit.revision.revisionId) ||
      alreadyShown.has(`memory:${hit.revision.revisionId}`);

    const queryTerms = memoryQueryTerms(input.query);
    const cosineFloor = input.queryVector === undefined ? undefined : memoryRelevanceCosineFloor(input.queryVector.modelKey);
    const analyzed = input.candidates.map((hit) => {
      const fullText = [
        hit.revision.title,
        hit.revision.body,
        hit.record.topicKey,
        hit.record.preferenceKey,
        ...(hit.revision.keywords ?? []),
      ]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      const fullSet = memoryExactAndStemSet(fullText);
      const titleSet = memoryExactAndStemSet(hit.revision.title ?? "");
      // Write-time keywords count as matched terms (`fullSet`) but never exempt a
      // single-term match from the rarity check: only a record's own key does.
      const keySet = memoryExactAndStemSet(
        [hit.record.topicKey, hit.record.preferenceKey].filter((part): part is string => part !== undefined).join(" "),
      );
      const matchedTerms = queryTerms.filter((term) => memoryTermMatchesSet(term, fullSet));
      return { hit, fullSet, titleSet, keySet, matchedTerms };
    });

    let cachedTotalActive: number | undefined;
    const getTotalActive = (): number => {
      if (cachedTotalActive !== undefined) return cachedTotalActive;
      if (input.scopeKeys.length === 0) {
        cachedTotalActive = input.candidates.length;
        return cachedTotalActive;
      }
      cachedTotalActive = this.#memory.countCurrent({
        scopeKeys: input.scopeKeys,
        now: input.now,
        ...(input.includeSensitive ? { includeSensitive: true } : {}),
        ...(input.excludeLocalOrigin ? { excludeLocalOrigin: true } : {}),
      });
      return cachedTotalActive;
    };

    const getRareMaxCount = (): number => Math.max(1, Math.ceil(getTotalActive() * MEMORY_RELEVANCE_FLOOR_RARITY) - 1);

    const termDfMemo = new Map<string, number>();
    const getTermDf = (term: ParsedQueryTerm): number => {
      const cached = termDfMemo.get(term.raw);
      if (cached !== undefined) return cached;
      const rareMaxCount = getRareMaxCount();
      const candidateMatches = analyzed.filter((entry) => memoryTermMatchesSet(term, entry.fullSet)).length;
      if (rareMaxCount === 0 || candidateMatches > rareMaxCount || input.scopeKeys.length === 0) {
        termDfMemo.set(term.raw, candidateMatches);
        return candidateMatches;
      }
      try {
        const hits = this.#memory.search({
          scopeKeys: input.scopeKeys,
          query: toFtsPhraseQuery(term.raw, "all"),
          limit: rareMaxCount + 1,
          now: input.now,
          ...(input.includeSensitive ? { includeSensitive: true } : {}),
          ...(input.excludeLocalOrigin ? { excludeLocalOrigin: true } : {}),
          ...(input.revokedSourceIds.size === 0 ? {} : { excludeSourceIds: [...input.revokedSourceIds] }),
        });
        const df = Math.max(candidateMatches, hits.length);
        termDfMemo.set(term.raw, df);
        return df;
      } catch {
        termDfMemo.set(term.raw, candidateMatches);
        return candidateMatches;
      }
    };

    const titleDfMemo = new Map<string, number>();
    const getCandidateTitleDf = (term: ParsedQueryTerm): number => {
      const cached = titleDfMemo.get(term.raw);
      if (cached !== undefined) return cached;
      const count = analyzed.filter((entry) => memoryTermMatchesSet(term, entry.titleSet)).length;
      titleDfMemo.set(term.raw, count);
      return count;
    };

    const maxMatchedTerms = analyzed.reduce((max, entry) => Math.max(max, entry.matchedTerms.length), 0);
    const boilerplateThreshold = analyzed.length >= 5 ? Math.ceil(analyzed.length * 0.8) : Infinity;
    const isBoilerplateOnlyMatch = (entry: (typeof analyzed)[number]): boolean => {
      if (entry.matchedTerms.length === 0 || entry.matchedTerms.length >= maxMatchedTerms) return false;
      const rareMaxCount = getRareMaxCount();
      return entry.matchedTerms.every((term) => {
        if (memoryTermMatchesSet(term, entry.keySet)) return false;
        if (memoryTermMatchesSet(term, entry.titleSet) && getCandidateTitleDf(term) <= Math.max(3, rareMaxCount)) return false;
        const candidateMatches = analyzed.filter((other) => memoryTermMatchesSet(term, other.fullSet)).length;
        return candidateMatches >= boilerplateThreshold;
      });
    };

    // The query's only anchor: when one query term is all that matched any
    // candidate ("ideas for a vegetarian dinner" where only "vegetarian" is
    // held), its best hits stay however common it is in scope, so the floor
    // never answers nothing for a question memory does hold. Weak matches
    // beside a fuller one are still dropped.
    const matchedQueryTerms = new Set(analyzed.flatMap((entry) => entry.matchedTerms.map((term) => term.raw)));
    const soleAnchor = matchedQueryTerms.size === 1 ? [...matchedQueryTerms][0] : undefined;
    let anchorKept = 0;

    const floorSurvivors: THit[] = [];
    for (const entry of analyzed) {
      const { hit, titleSet, keySet, matchedTerms } = entry;
      if (isExempt(hit)) {
        floorSurvivors.push(hit);
        continue;
      }
      const matchesMultipleOrSingleQueryTerm =
        (matchedTerms.length >= 2 && !isBoilerplateOnlyMatch(entry)) || (queryTerms.length === 1 && matchedTerms.length === 1);
      if (matchesMultipleOrSingleQueryTerm) {
        floorSurvivors.push(hit);
        continue;
      }
      if (cosineFloor !== undefined && hit.cosine !== undefined && hit.cosine >= cosineFloor) {
        floorSurvivors.push(hit);
        continue;
      }
      if (matchedTerms.length === 1) {
        const term = matchedTerms[0]!;
        const rareMaxCount = getRareMaxCount();
        const matchesKey = memoryTermMatchesSet(term, keySet);
        const matchesNonBoilerplateTitle = memoryTermMatchesSet(term, titleSet) && getCandidateTitleDf(term) <= Math.max(3, rareMaxCount);
        const isRareInScope = rareMaxCount > 0 && getTermDf(term) <= rareMaxCount;
        if (matchesKey || matchesNonBoilerplateTitle || isRareInScope) {
          floorSurvivors.push(hit);
        } else if (term.raw === soleAnchor && anchorKept < MEMORY_RELEVANCE_FLOOR_ANCHOR_HITS) {
          anchorKept += 1;
          floorSurvivors.push(hit);
        }
      }
    }

    const isPastFact = (hit: THit): boolean =>
      hit.record.kind === "fact" &&
      (hit.record.status === "superseded" ||
        hit.record.currentRevisionId !== hit.revision.revisionId ||
        (hit.record.validTo !== undefined && hit.record.validTo <= input.now));
    // A fact pair that reads as the same sentence with another value
    // ("lives in Lisbon" / "lives in Porto": each holds a word the other
    // lacks) may contradict rather than repeat, and an ended or replaced fact
    // is history beside the current one: neither is a near-duplicate. A
    // paraphrase with few shared words is still dropped by its vector.
    const isFactPair = (left: THit, right: THit): boolean => left.record.kind === "fact" && right.record.kind === "fact";
    const differsBothWays = (left: string, right: string): boolean => {
      const leftTokens = memoryTokenSet(left);
      const rightTokens = memoryTokenSet(right);
      return [...leftTokens].some((token) => !rightTokens.has(token)) && [...rightTokens].some((token) => !leftTokens.has(token));
    };
    const mmrSurvivors: THit[] = [];
    for (const hit of floorSurvivors) {
      if (isExempt(hit)) {
        mmrSurvivors.push(hit);
        continue;
      }
      const hitBody = hit.revision.body ?? hit.snippet;
      const hitHead = memoryExcerptHead(hit.revision.title, hitBody);
      const isNearDuplicate = mmrSurvivors.some((earlier) => {
        if (earlier.record.recordId === hit.record.recordId && earlier.revision.revisionId !== hit.revision.revisionId) {
          return false;
        }
        const factPair = isFactPair(earlier, hit);
        if (factPair && (isPastFact(earlier) || isPastFact(hit))) return false;
        const earlierBody = earlier.revision.body ?? earlier.snippet;
        const earlierHead = memoryExcerptHead(earlier.revision.title, earlierBody);
        const lexicallyNear =
          memoryTextSimilarity(hitBody, earlierBody) >= MEMORY_MMR_JACCARD_THRESHOLD ||
          memoryTextSimilarity(hitHead, earlierHead) >= MEMORY_MMR_JACCARD_THRESHOLD;
        if (lexicallyNear) return !(factPair && differsBothWays(hitBody, earlierBody));
        return input.nearDuplicateKeys.has(`${earlier.revision.revisionId}:${hit.revision.revisionId}`);
      });
      if (!isNearDuplicate) {
        mmrSurvivors.push(hit);
      }
    }
    return mmrSurvivors;
  }

  /**
   * Hybrid recall's fusion: reciprocal-rank fusion (k = 60)
   * over the bm25 ranks of `lexical`, the cosine ranks of the records SQL
   * found eligible (filter before rank, invariant 4), and exact preference or
   * topic key matches of the query's words. A record only one list holds
   * still ranks by that list. Canonical rows are re-read for every hit the
   * lexical pool did not carry, and re-checked as `search` checks its own.
   * A record citing a revoked source is left out before any list is ranked,
   * so it never takes one of the `limit` slots.
   */
  #fuseHybrid(
    workspaceId: string,
    scopeKeys: readonly string[],
    query: string,
    queryVector: { readonly modelKey: string; readonly vector: readonly number[]; readonly personal?: false },
    pool: ReturnType<PersistencePort["repositories"]["memory"]["search"]>,
    limit: number,
    poolCap: number,
    now: string,
    revokedSourceIds: ReadonlySet<string>,
    excludeLocalOrigin: boolean,
    includePast = false,
    range?: { readonly from: string; readonly to: string },
    priors = true,
  ): {
    readonly hits: readonly {
      readonly record: MemoryRecord;
      readonly revision: MemoryRevision;
      readonly snippet: string;
      readonly match?: "meaning";
      readonly cosine?: number;
    }[];
    readonly nearDuplicateKeys: ReadonlySet<string>;
    readonly eligible: number;
    readonly missing: number;
  } {
    const words = [...memoryTokenSet(query)].slice(0, NEAR_MATCH_QUERY_TOKENS);
    const keys = words.length === 0 ? [] : [...new Set([...words, words.join("."), words.join("_"), words.join("-")])];
    const lexical =
      revokedSourceIds.size === 0 ? pool : pool.filter((hit) => !citesRevokedSource(hit.revision.sourceIds, revokedSourceIds));
    const candidates = this.#memory.vectorCandidates({
      scopeKeys,
      workspaceId,
      now,
      modelKey: queryVector.modelKey,
      vector: queryVector.vector,
      limit: hybridPool(limit),
      keys,
      ...(queryVector.personal === false ? { personal: false } : {}),
      ...(excludeLocalOrigin ? { excludeLocalOrigin: true } : {}),
      ...(revokedSourceIds.size === 0 ? {} : { excludeSourceIds: [...revokedSourceIds] }),
      ...(includePast ? { includePast: true } : {}),
    });
    const fused = new Map<string, { recordId: string; score: number; order: number }>();
    let order = 0;
    const rank = (list: readonly { readonly recordId: string; readonly revisionId: string }[]): void => {
      list.forEach((hit, index) => {
        const entry = fused.get(hit.revisionId) ?? { recordId: hit.recordId, score: 0, order: order++ };
        entry.score += 1 / (MEMORY_RRF_K + index + 1);
        fused.set(hit.revisionId, entry);
      });
    };
    rank(lexical.map((hit) => ({ recordId: hit.record.recordId, revisionId: hit.revision.revisionId })));
    rank(candidates.ranked);
    rank(candidates.keyMatches);
    const lexicalById = new Map(lexical.map((hit) => [hit.revision.revisionId, hit]));
    const cosineByRevisionId = new Map(candidates.ranked.map((hit) => [hit.revisionId, hit.score]));
    const keyMatchIds = new Set(candidates.keyMatches.map((hit) => hit.revisionId));
    const nearDuplicateKeys = new Set<string>();
    for (const pair of candidates.nearDuplicates ?? []) {
      nearDuplicateKeys.add(`${pair.leftRevisionId}:${pair.rightRevisionId}`);
      nearDuplicateKeys.add(`${pair.rightRevisionId}:${pair.leftRevisionId}`);
    }
    const candidateEntries: {
      hit: { record: MemoryRecord; revision: MemoryRevision; snippet: string; match?: "meaning"; cosine?: number };
      score: number;
      order: number;
    }[] = [];
    for (const [revisionId, entry] of [...fused.entries()].sort(([, a], [, b]) => b.score - a.score || a.order - b.order)) {
      const cosine = cosineByRevisionId.get(revisionId);
      const known = lexicalById.get(revisionId);
      if (known !== undefined) {
        candidateEntries.push({
          hit: cosine === undefined ? known : { ...known, cosine },
          score: entry.score,
          order: entry.order,
        });
        continue;
      }
      const record = this.#memory.getRecord(entry.recordId);
      const revision = this.#memory.getRevision(revisionId);
      if (record === undefined || revision === undefined || record.status !== "approved" || record.currentRevisionId !== revisionId)
        continue;
      const isEndedFact = includePast && record.kind === "fact" && record.validTo !== undefined && record.validTo <= now;
      if (
        (record.expiryAt !== undefined && record.expiryAt <= now) ||
        (record.validTo !== undefined && record.validTo <= now && !isEndedFact) ||
        (record.validFrom !== undefined && record.validFrom > now)
      )
        continue;
      const baseSnippet = memoryExcerptOf(revision.body ?? "");
      candidateEntries.push({
        hit: {
          record,
          revision,
          snippet:
            isEndedFact && record.validTo !== undefined
              ? appendSnippetNote(baseSnippet, `(ended ${record.validTo.slice(0, 10)})`)
              : baseSnippet,
          ...(keyMatchIds.has(revisionId) ? {} : { match: "meaning" as const }),
          ...(cosine === undefined ? {} : { cosine }),
        },
        score: entry.score,
        order: entry.order,
      });
    }
    const hits = this.#applyRankingPriors(candidateEntries, query, range, priors).slice(0, poolCap);
    return { hits, nearDuplicateKeys, eligible: candidates.eligible, missing: candidates.missing };
  }

  /**
   * Apply bounded recency (`observedAt`, falling back to `record.recordedAt` so
   * later edits do not bump recency), post-revision confirmation (`>= 2`
   * distinct chats since the current active revision was recorded) RRF prior
   * lists at weight `0.05` (`MEMORY_RRF_PRIOR_WEIGHT`), and an optional
   * temporal range overlap list at weight `0.15` (`MEMORY_TEMPORAL_RANGE_WEIGHT`).
   */
  #applyRankingPriors<
    THit extends {
      readonly record: MemoryRecord;
      readonly revision: MemoryRevision;
    },
  >(
    entries: readonly {
      readonly hit: THit;
      readonly score: number;
      readonly order: number;
    }[],
    query: string,
    range?: { readonly from: string; readonly to: string },
    priors = true,
  ): readonly THit[] {
    if (entries.length <= 1) return entries.map((entry) => entry.hit);
    const scores = new Map<string, number>();
    for (const entry of entries) {
      scores.set(entry.hit.revision.revisionId, entry.score);
    }

    const observedAtOf = (hit: THit): string => hit.revision.observedAt ?? hit.record.recordedAt;
    if (range !== undefined) {
      const overlapping = entries
        .filter((entry) => overlapsTemporalRange(entry.hit.record, entry.hit.revision, range))
        .sort((left, right) => observedAtOf(right.hit).localeCompare(observedAtOf(left.hit)) || left.order - right.order);
      overlapping.forEach((entry, index) => {
        const revisionId = entry.hit.revision.revisionId;
        scores.set(revisionId, (scores.get(revisionId) ?? 0) + MEMORY_TEMPORAL_RANGE_WEIGHT / (MEMORY_RRF_K + index + 1));
      });
    }

    const ranked = (): readonly THit[] =>
      [...entries]
        .sort((left, right) => {
          const leftScore = scores.get(left.hit.revision.revisionId) ?? left.score;
          const rightScore = scores.get(right.hit.revision.revisionId) ?? right.score;
          return rightScore - leftScore || left.order - right.order;
        })
        .map((entry) => entry.hit);
    // The recency and confirmation priors are switched off as a whole (`rankingPriors: false`); the range list is not.
    if (!priors) return ranked();

    const queryTerms = memoryQueryTerms(query);
    const matchedTermMaskByRevision = new Map<string, ReadonlySet<string>>();
    if (queryTerms.length > 0) {
      for (const entry of entries) {
        const fullText = [
          entry.hit.revision.title,
          entry.hit.revision.body,
          entry.hit.record.topicKey,
          entry.hit.record.preferenceKey,
          ...(entry.hit.revision.keywords ?? []),
        ]
          .filter((part): part is string => part !== undefined)
          .join(" ");
        const fullSet = memoryExactAndStemSet(fullText);
        const matched = new Set(queryTerms.filter((term) => memoryTermMatchesSet(term, fullSet)).map((term) => term.raw));
        matchedTermMaskByRevision.set(entry.hit.revision.revisionId, matched);
      }
    }
    const competesOnTopicOrTerms = (left: THit, right: THit): boolean => {
      if (left.record.topicKey !== undefined && left.record.topicKey === right.record.topicKey) return true;
      if (left.record.preferenceKey !== undefined && left.record.preferenceKey === right.record.preferenceKey) return true;
      // With no words to share (a meaning-only query), only a shared key makes two records rivals:
      // recency must not lift a newer, unrelated record over the closer one.
      if (queryTerms.length === 0) return false;
      const leftTerms = matchedTermMaskByRevision.get(left.revision.revisionId);
      const rightTerms = matchedTermMaskByRevision.get(right.revision.revisionId);
      // Rivals share a matched word: a record that matched none (found by meaning) has no word rival.
      if (leftTerms === undefined || rightTerms === undefined || leftTerms.size === 0 || rightTerms.size === 0) return false;
      for (const term of leftTerms) {
        if (rightTerms.has(term)) return true;
      }
      return false;
    };

    for (const entry of entries) {
      const ownObservedAt = observedAtOf(entry.hit);
      const competingTimestamps = new Set<string>([ownObservedAt]);
      for (const other of entries) {
        if (other.hit.revision.revisionId === entry.hit.revision.revisionId) continue;
        if (competesOnTopicOrTerms(entry.hit, other.hit)) {
          competingTimestamps.add(observedAtOf(other.hit));
        }
      }
      if (competingTimestamps.size <= 1) continue;
      const orderedTimestamps = [...competingTimestamps].sort((a, b) => b.localeCompare(a));
      const groupCount = orderedTimestamps.length;
      const groupIndex = orderedTimestamps.indexOf(ownObservedAt);
      const recencyWeight = MEMORY_RRF_PRIOR_WEIGHT * ((groupCount - 1 - groupIndex) / (groupCount - 1));
      if (recencyWeight > 0) {
        const revisionId = entry.hit.revision.revisionId;
        scores.set(revisionId, (scores.get(revisionId) ?? 0) + recencyWeight / (MEMORY_RRF_K + groupIndex + 1));
      }
    }

    // Any revision number: `sinceCurrentRevision` counts only the chats that
    // used the record after its current revision was recorded, so a correction
    // starts its confirmation over rather than being left out of it.
    const currentApprovedIds = entries
      .filter((entry) => entry.hit.record.status === "approved" && entry.hit.record.currentRevisionId === entry.hit.revision.revisionId)
      .map((entry) => entry.hit.record.recordId);
    if (currentApprovedIds.length > 0) {
      const useCounts = this.#memory.recordUseCounts({
        recordIds: currentApprovedIds,
        sinceCurrentRevision: true,
      });
      const confirmed = entries
        .filter(
          (entry) =>
            entry.hit.record.status === "approved" &&
            entry.hit.record.currentRevisionId === entry.hit.revision.revisionId &&
            (useCounts[entry.hit.record.recordId] ?? 0) >= MEMORY_CONFIRMATION_MIN_CHATS,
        )
        .sort((left, right) => {
          const leftUses = useCounts[left.hit.record.recordId] ?? 0;
          const rightUses = useCounts[right.hit.record.recordId] ?? 0;
          return rightUses - leftUses || left.order - right.order;
        });
      confirmed.forEach((entry, index) => {
        const revisionId = entry.hit.revision.revisionId;
        scores.set(revisionId, (scores.get(revisionId) ?? 0) + MEMORY_RRF_PRIOR_WEIGHT / (MEMORY_RRF_K + index + 1));
      });
    }

    return ranked();
  }

  /**
   * Sweeps up to `MEMORY_EXPORT_HARD_CAP` (2000) approved preference records
   * across the actor's authorized scopes; there is no `truncated` signal on
   * this port. That cap sits comfortably under `DEFAULT_MEMORY_QUOTAS.maxRecords`
   * (5000, and quotas are typically configured much lower for a single
   * principal), so an installation would have to be quota-configured well
   * past the default before this sweep itself became the bottleneck; `export`
   * is the path that signals truncation because it is not bounded by a
   * per-kind record quota the same way.
   */
  resolvePreferences(
    input: Parameters<MemoryServicePort["resolvePreferences"]>[0],
    // Internal-only: `search()` computes this once and threads it into its
    // own nested calls so one `search()` doesn't repeat the `listEvidence`
    // lookup for each of its internal conflict-detection calls (the
    // source-validity recheck still runs — it's the redundant re-fetch that's
    // avoided). Never supplied through the public `MemoryServicePort` type.
    precomputedRevokedSourceIds?: ReadonlySet<string>,
  ): {
    readonly preferences: readonly ResolvedPreference[];
    readonly truncated: boolean;
    readonly profile?: readonly ResolvedProfileEntry[];
  } {
    const authorized = new Set(authorizedScopeKeys(this.#policy, input.actor));
    // `truncated`: the sweep reached its bound, so a key may be missing.
    const { records: scopedRecords, truncated } = this.listAllRecords(
      [...authorized],
      { kinds: ["preference"], statuses: ["approved"] },
      MEMORY_EXPORT_HARD_CAP,
    );
    // Explicitly-granted records resolve alongside the
    // actor's own scope-authorized ones — unconditionally, unlike `search`,
    // since there is no query here to match against.
    const grantedRecords = this.#explicitlyGrantedRecords(
      input.actor,
      { kinds: ["preference"], statuses: ["approved"] },
      new Set(scopedRecords.map((record) => record.recordId)),
    );
    const candidates = [...scopedRecords, ...grantedRecords].filter(
      (record) =>
        record.preferenceKey !== undefined &&
        (input.includeSensitive === true || record.sensitivity !== "sensitive") &&
        keepsOrigin(input, record),
    );
    // Recheck cited-source validity on every call.
    const revokedSourceIds = precomputedRevokedSourceIds ?? this.#revokedSourceIds(input.actor);
    const records = this.#excludeRevokedSourceRecords(candidates, revokedSourceIds);
    const wanted = input.keys === undefined ? undefined : new Set(input.keys);
    const byKey = new Map<string, MemoryRecord[]>();
    for (const record of records) {
      const key = record.preferenceKey;
      if (key === undefined) continue;
      if (wanted !== undefined && !wanted.has(key)) continue;
      byKey.set(key, [...(byKey.get(key) ?? []), record]);
    }

    const now = this.#now();
    const resolved: ResolvedPreference[] = [];
    for (const [key, candidates] of byKey) {
      // The plan's precedence, highest first, then a deterministic tiebreak
      // (validFrom, recordedAt, recordId) so ambiguity is reported rather than
      // silently settled by whatever order SQLite happened to return.
      const ordered = [...candidates].sort((left, right) => {
        const leftRank = preferenceRank(left.scope);
        const rightRank = preferenceRank(right.scope);
        if (leftRank !== rightRank) return leftRank - rightRank;
        const leftValidFrom = left.validFrom ?? "";
        const rightValidFrom = right.validFrom ?? "";
        if (leftValidFrom !== rightValidFrom) return rightValidFrom.localeCompare(leftValidFrom);
        if (left.recordedAt !== right.recordedAt) return right.recordedAt.localeCompare(left.recordedAt);
        return left.recordId.localeCompare(right.recordId);
      });
      // An ineligible top-precedence candidate (expired, or not yet valid)
      // must not void the whole key: fall through to the next-highest still-
      // current candidate rather than hiding a live lower-tier value behind a
      // stale higher-tier one.
      const current = ordered.filter((candidate) => isCurrent(candidate, now));
      const winner = current[0];
      if (winner === undefined) continue;
      const winningRevision = winner.currentRevisionId === undefined ? undefined : this.#memory.getRevision(winner.currentRevisionId);
      // Two distinct scope keys can still share one precedence rank — two
      // records at the SAME scope kind and the SAME workspace-scoping
      // (e.g. two `personal` records, which `#preferenceRank` can't and
      // shouldn't distinguish further) — and the unique index that stops
      // duplicates within one scope key cannot see across them. That is
      // an unresolved same-tier conflict, surfaced rather than
      // ranked away. The workspace-scoped vs. workspace-agnostic
      // `personal_agent` split is no longer such a case: `#preferenceRank`
      // gives them distinct ranks in the explicit precedence
      // order, so the more specific one now wins outright instead of
      // being reported as an ambiguous tie.
      // Ties are evaluated among the *current* candidates: an expired
      // same-tier sibling is not a live conflict.
      const topRank = preferenceRank(winner.scope);
      const tiedAtTop = current.filter((candidate) => preferenceRank(candidate.scope) === topRank);
      const conflict = tiedAtTop.length > 1;
      resolved.push({
        key,
        value: winningRevision?.preference?.value,
        winner,
        overridden: ordered.filter((candidate) => candidate.recordId !== winner.recordId),
        conflict,
        conflictRecordIds: conflict ? tiedAtTop.map((record) => record.recordId) : [],
      });
    }
    const profile =
      input.includeProfile === true && input.includeSensitive !== true && precomputedRevokedSourceIds === undefined
        ? this.resolveProfile(
            {
              actor: input.actor,
              ...(input.excludeLocalOrigin === undefined ? {} : { excludeLocalOrigin: input.excludeLocalOrigin }),
            },
            revokedSourceIds,
          )
        : undefined;
    return {
      preferences: resolved,
      truncated,
      ...(profile === undefined ? {} : { profile }),
    };
  }

  /**
   * The reader's always-in-context profile entries: approved, in-force lessons
   * (ordered by how many chats used them, then newest) and core `me.*` facts
   * (newest first, from the reader's personal scopes only), excluding
   * sensitive records, beliefs/opinions, revoked sources, and `localOrigin`
   * records when `excludeLocalOrigin` is set. Each kind is read bounded, at
   * `PROFILE_CANDIDATE_LIMIT`.
   * Group chats (`reach: "chat-only"`) and restricted workers (`scopeRestricted`)
   * receive no personal profile.
   */
  resolveProfile(
    input: { readonly actor: MemoryActor; readonly excludeLocalOrigin?: boolean },
    precomputedRevokedSourceIds?: ReadonlySet<string>,
  ): readonly ResolvedProfileEntry[] {
    if (input.actor.reach === "chat-only" || input.actor.scopeRestricted === true) return [];
    const scopeKeys = authorizedScopeKeys(this.#policy, input.actor);
    if (scopeKeys.length === 0) return [];
    // Facts about the person come only from the person's own scopes: another
    // member's `me.*` fact in the shared workspace scope is not about this reader.
    const personalScopes: MemoryScope[] = [
      { kind: "personal", principalId: input.actor.principalId },
      { kind: "personal_workspace", principalId: input.actor.principalId, workspaceId: input.actor.workspaceId },
    ];
    if (input.actor.agentId !== undefined) {
      personalScopes.push(
        { kind: "personal_agent", principalId: input.actor.principalId, agentId: input.actor.agentId },
        {
          kind: "personal_agent",
          principalId: input.actor.principalId,
          agentId: input.actor.agentId,
          workspaceId: input.actor.workspaceId,
        },
      );
    }
    const personalKeys = new Set(personalScopes.map(memoryScopeKey));
    const revokedSourceIds = precomputedRevokedSourceIds ?? this.#revokedSourceIds(input.actor);
    // Bounded and set-based: eligibility, ordering and the current revision in
    // SQL, cut a little past the profile's own entry cap.
    const candidates = this.#memory.profileCandidates({
      lessonScopeKeys: scopeKeys,
      factScopeKeys: scopeKeys.filter((key) => personalKeys.has(key)),
      now: this.#now(),
      limit: PROFILE_CANDIDATE_LIMIT,
      ...(input.excludeLocalOrigin === true ? { excludeLocalOrigin: true } : {}),
      ...(revokedSourceIds.size === 0 ? {} : { excludeSourceIds: [...revokedSourceIds] }),
    });
    // Every turn carries the profile, so it holds only what reads as a lesson or
    // fact about the person: never a record proposed after its chat read untrusted
    // content, nor one shaped like an injection (search still finds both).
    const profileSafe = ({ revision }: { readonly revision: MemoryRevision }): boolean =>
      revision.provenance?.integrity !== "untrusted" && !memoryReadsAsDirective(revision.title, revision.body);
    const lessons = candidates.lessons.filter(profileSafe);
    const facts = candidates.facts.filter(profileSafe);
    const factsByTopic = new Map<string, string[]>();
    for (const { record } of facts) {
      if (record.topicKey === undefined) continue;
      factsByTopic.set(record.topicKey, [...(factsByTopic.get(record.topicKey) ?? []), record.recordId]);
    }
    const resolvedLessons: ResolvedProfileEntry[] = lessons.map(({ record, revision, usedChats }) => ({
      recordId: record.recordId,
      revisionId: revision.revisionId,
      kind: "lesson",
      scope: record.scope,
      ...(revision.title === undefined ? {} : { title: revision.title }),
      snippet: memoryExcerptOf(revision.body ?? ""),
      recordedAt: revision.recordedAt,
      usedChats,
      conflict: false,
    }));
    const resolvedFacts: ResolvedProfileEntry[] = facts.map(({ record, revision }) => {
      const siblings =
        record.topicKey === undefined ? [] : (factsByTopic.get(record.topicKey) ?? []).filter((otherId) => otherId !== record.recordId);
      return {
        recordId: record.recordId,
        revisionId: revision.revisionId,
        kind: "fact",
        scope: record.scope,
        ...(revision.title === undefined ? {} : { title: revision.title }),
        snippet: memoryExcerptOf(revision.body ?? ""),
        recordedAt: revision.recordedAt,
        ...(record.topicKey === undefined ? {} : { topicKey: record.topicKey }),
        usedChats: 0,
        conflict: siblings.length > 0,
        ...(siblings.length === 0 ? {} : { conflictsWith: siblings }),
      };
    });
    return [...resolvedLessons, ...resolvedFacts];
  }

  resolveFactConflicts(
    input: Parameters<MemoryServicePort["resolveFactConflicts"]>[0],
    // Internal-only — see `resolvePreferences`'s matching parameter.
    precomputedRevokedSourceIds?: ReadonlySet<string>,
  ): readonly {
    topicKey: string;
    records: readonly MemoryRecord[];
    conflict: boolean;
  }[] {
    const authorized = new Set(authorizedScopeKeys(this.#policy, input.actor));
    const scopedRecords = this.listAllRecords([...authorized], { kinds: ["fact"], statuses: ["approved"] }, MEMORY_EXPORT_HARD_CAP).records;
    // Explicitly-granted records — see
    // `resolvePreferences`'s matching comment.
    const grantedRecords = this.#explicitlyGrantedRecords(
      input.actor,
      { kinds: ["fact"], statuses: ["approved"] },
      new Set(scopedRecords.map((record) => record.recordId)),
    );
    const visible = [...scopedRecords, ...grantedRecords].filter(
      (record) => record.topicKey !== undefined && (input.includeSensitive === true || record.sensitivity !== "sensitive"),
    );
    // Recheck cited-source validity on every call, same as
    // `search`/`resolvePreferences`.
    const revokedSourceIds = precomputedRevokedSourceIds ?? this.#revokedSourceIds(input.actor);
    const records = this.#excludeRevokedSourceRecords(visible, revokedSourceIds);
    const wanted = input.topicKeys === undefined ? undefined : new Set(input.topicKeys);
    const byTopic = new Map<string, MemoryRecord[]>();
    for (const record of records) {
      const topicKey = record.topicKey;
      if (topicKey === undefined) continue;
      if (wanted !== undefined && !wanted.has(topicKey)) continue;
      byTopic.set(topicKey, [...(byTopic.get(topicKey) ?? []), record]);
    }

    const now = this.#now();
    const resolved: { topicKey: string; records: readonly MemoryRecord[]; conflict: boolean }[] = [];
    for (const [topicKey, candidates] of byTopic) {
      // No precedence tie-break, unlike `resolvePreferences`: a fact is not
      // mutually exclusive by scope the way a preference's single active
      // value is, so every current, approved record sharing a `topicKey` is
      // returned as-is — recency and confidence never pick a "winner": recency
      // or a model confidence score alone does not settle truth.
      const current = candidates.filter((candidate) => isCurrent(candidate, now));
      if (current.length === 0) continue;
      const ordered = [...current].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
      resolved.push({ topicKey, records: ordered, conflict: ordered.length > 1 });
    }
    return resolved;
  }

  export(input: Parameters<MemoryServicePort["export"]>[0]): {
    readonly records: readonly MemoryRecord[];
    readonly revisions: readonly MemoryRevision[];
    readonly evidence: readonly EvidenceSource[];
    readonly reviews: readonly MemoryReview[];
    readonly truncated: boolean;
  } {
    const scopeKeys = readScopeKeys(this.#policy, input.actor, input.scope);
    // Every status an operator export must show — explicitly, never `deleted`
    // tombstones, which `list()`'s own default already excludes but `export`
    // must state for itself since it is the one path meant to show everything
    // authorized, not the "current, usable" subset `list` shows by default.
    const { records, truncated } = this.listAllRecords(
      scopeKeys,
      { statuses: ["proposed", "approved", "rejected", "superseded", "revoked", "expired"] },
      MEMORY_EXPORT_HARD_CAP,
    );
    const revisions = records.flatMap((record) => this.#memory.listRevisions(record.recordId));
    const recordIds = new Set(records.map((record) => record.recordId));
    // Evidence is scoped to the exported record set, not every source visible
    // in the authorized scopes: a scope-wide fetch would hand back citations
    // belonging to records the caller cannot otherwise name in this export.
    const evidence = this.#memory
      .listEvidence({ scopeKeys, limit: MEMORY_EXPORT_HARD_CAP })
      .filter((source) => source.recordId === undefined || recordIds.has(source.recordId));
    return {
      records,
      revisions,
      evidence,
      reviews: records.flatMap((record) => this.#memory.listReviews(record.recordId)),
      truncated,
    };
  }

  /**
   * Page `listRecords` to exhaustion, bounded by `hardCap`, signalling
   * truncation. Requests one record *past* the cap on the final page so the
   * loop can actually observe whether more exist — stopping exactly at
   * `records.length >= hardCap` can never overshoot when `hardCap` is a
   * multiple of the page size, which made `records.length > hardCap` (and
   * therefore `truncated`) unreachable.
   */
  listAllRecords(
    scopeKeys: readonly string[],
    filter: {
      readonly kinds?: readonly MemoryKind[];
      readonly statuses?: readonly MemoryStatus[];
      readonly past?: { readonly now: string };
      readonly lapsedExpiry?: { readonly now: string };
    },
    hardCap: number,
  ): { readonly records: readonly MemoryRecord[]; readonly truncated: boolean } {
    const records: MemoryRecord[] = [];
    let offset = 0;
    for (;;) {
      const limit = Math.min(MEMORY_LIST_PAGE_MAX, hardCap + 1 - records.length);
      const page = this.#memory.listRecords({ scopeKeys: [...scopeKeys], limit, offset, ...filter });
      records.push(...page);
      if (page.length < limit || records.length > hardCap) {
        return { records: records.slice(0, hardCap), truncated: records.length > hardCap };
      }
      offset += limit;
    }
  }

  /** Records counted distinctly, bytes for the current revision only — see `usage` on the repository. */
  usage(input: { readonly actor: MemoryActor; readonly view?: MemoryReadView }): { readonly records: number; readonly bytes: number } {
    if (input.view === "operator") {
      requireOperatorView(input.actor, "read the operator's view of");
      return this.#memory.usage(this.#operatorScopeKeys(input.actor));
    }
    return this.#memory.usage(authorizedScopeKeys(this.#policy, input.actor));
  }

  /**
   * The operator's page: the scopes it shows that hold a
   * record, and other people's personal records in the workspace, counted
   * per person and never listed. Filtered as the listing is, so the counts
   * answer "how many more like these are there"; `otherProposals` counts
   * their proposals whatever `statuses` asks, so a page listing only approved
   * memory still says how many of other people's proposals wait.
   */
  operatorView(input: Parameters<MemoryServicePort["operatorView"]>[0]): MemoryView {
    requireOperatorView(input.actor, "read the operator's view of");
    const { workspaceId, principalId, kinds, statuses } = parseOrThrow(
      MemoryViewInputSchema,
      {
        workspaceId: input.actor.workspaceId,
        principalId: input.actor.principalId,
        ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
        ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
      },
      "The memory view request is not valid",
    );
    const others = (wanted: readonly MemoryStatus[] | undefined) =>
      this.#memory.otherPeopleCounts({
        workspaceId,
        excludePrincipalId: principalId,
        ...(wanted === undefined || wanted.length === 0 ? {} : { statuses: wanted }),
        ...(kinds === undefined || kinds.length === 0 ? {} : { kinds }),
        limit: MEMORY_OTHER_PEOPLE_LIMIT,
      });
    return {
      scopes: this.#memory.operatorScopes({ workspaceId, principalId }).flatMap(({ scopeKey, scope }) => {
        const target = memoryScopeTarget(scope);
        return target === undefined ? [] : [{ scopeKey, target }];
      }),
      otherPeople: others(statuses).map((row) => ({ ...row })),
      otherProposals: others(["proposed"]).map((row) => ({ ...row })),
    };
  }

  /** A record's revisions (newest first) and reviews, authorized as `get` is. */
  history(input: Parameters<MemoryServicePort["history"]>[0]): {
    readonly revisions: readonly MemoryRevision[];
    readonly reviews: readonly MemoryReview[];
  } {
    const record = this.get(input);
    return { revisions: this.#memory.listRevisions(record.recordId), reviews: this.#memory.listReviews(record.recordId) };
  }

  /**
   * What a waiting proposal is related to, computed when it is
   * shown: the record in force it **updates** (one holding its preference
   * key, or its fact's topic key), and the record in force its body is a
   * near match of ("similar to …"). Only records in force count, so an ended
   * fact is neither. A sensitive proposal names neither by title, nor is a
   * sensitive record named. A failed index read is no near match. Asked with
   * `kin` (auto-approve), it names a kept record akin to it too
   * (`#kinOf`), `null` for none; an unreadable index answers no `kin`.
   */
  related(input: Parameters<MemoryServicePort["related"]>[0]): ReturnType<MemoryServicePort["related"]> {
    const record = this.get(input);
    if (record.status !== "proposed") return {};
    // A record read by an explicit grant alone names none of its scope's others.
    if (input.view !== "operator" && !authorizedScopeKeys(this.#policy, input.actor).includes(record.scopeKey)) return {};
    const now = this.#now();
    const revision = this.#shownRevision(record);
    // A tidy-up's "before": its inputs, in its own scope, at the revisions it was drafted from.
    const inputs = revision === undefined ? [] : this.supersedesOf(revision.revisionId, record.recordId);
    const supersedes = inputs.map((entry): MemorySuperseded => {
      const other = this.#memory.getRecord(entry.recordId);
      const shown =
        entry.revision !== undefined &&
        other !== undefined &&
        other.status !== "deleted" &&
        other.sensitivity !== "sensitive" &&
        record.sensitivity !== "sensitive";
      const body = shown ? (entry.revision?.body ?? "") : "";
      return {
        recordId: entry.recordId,
        revisionId: entry.revisionId,
        title: shown && entry.revision !== undefined ? memoryCardTitleOf(entry.revision) : null,
        excerpt: !shown || body === "" ? null : clip(body, MEMORY_SUPERSEDED_EXCERPT_CHARS),
        stale: other?.status !== "approved" || other.currentRevisionId !== entry.revisionId,
      };
    });
    const replaced = new Set(supersedes.map((entry) => entry.recordId));
    const named = (other: MemoryRecord, otherRevision?: MemoryRevision): string | null => {
      if (record.sensitivity === "sensitive" || other.sensitivity === "sensitive") return null;
      return memoryCardTitleOf(otherRevision ?? this.#shownRevision(other) ?? {});
    };
    let updates: MemoryRelated | undefined;
    if (
      (record.kind === "fact" || record.kind === "lesson") &&
      record.supersedesRecordId !== undefined &&
      !replaced.has(record.supersedesRecordId)
    ) {
      const target = this.#memory.getRecord(record.supersedesRecordId);
      if (
        target !== undefined &&
        target.recordId !== record.recordId &&
        target.scopeKey === record.scopeKey &&
        target.kind === record.kind &&
        target.status === "approved" &&
        isCurrent(target, now)
      ) {
        updates = {
          recordId: target.recordId,
          title: named(target),
          ...(target.currentRevisionId === undefined ? {} : { currentRevisionId: target.currentRevisionId }),
        };
      }
    }
    const key = record.kind === "preference" ? record.preferenceKey : record.kind === "fact" ? record.topicKey : undefined;
    if (updates === undefined && key !== undefined && (record.kind === "preference" || record.kind === "fact")) {
      const holder = this.#memory
        .keyHolders({ scopeKey: record.scopeKey, kind: record.kind, key, now, excludeRecordId: record.recordId })
        .find((other) => !replaced.has(other.recordId));
      if (holder !== undefined) {
        updates = {
          recordId: holder.recordId,
          title: named(holder),
          ...(holder.currentRevisionId === undefined ? {} : { currentRevisionId: holder.currentRevisionId }),
        };
      }
    }
    let similarTo: MemoryRelated | undefined;
    const query = revision?.body === undefined ? undefined : memoryNearMatchQuery(revision.body);
    if (revision?.body !== undefined && query !== undefined) {
      try {
        const [top] = this.#memory.search({ scopeKeys: [record.scopeKey], query, limit: 1, now, includeSensitive: true });
        if (
          top !== undefined &&
          top.record.recordId !== updates?.recordId &&
          !replaced.has(top.record.recordId) &&
          top.revision.body !== undefined &&
          memoryTextSimilarity(revision.body, top.revision.body) >= MEMORY_NEAR_MATCH_JACCARD
        ) {
          similarTo = { recordId: top.record.recordId, title: named(top.record, top.revision) };
        }
      } catch {
        // A hint only: an unreadable index shows none.
      }
    }
    const kin =
      input.kin === undefined ? undefined : this.#kinOf(record, revision, replaced, input.kin.vector, input.actor.workspaceId, now);
    let mayUpdate: MemoryRelated | undefined;
    if (record.kind === "fact" && updates === undefined && supersedes.length === 0) {
      const factKin = kin !== undefined ? kin : this.#kinOf(record, revision, replaced, undefined, input.actor.workspaceId, now);
      if (factKin !== undefined && factKin !== null && (record.topicKey === undefined || factKin.topicKey === undefined)) {
        const kinRevision = this.#shownRevision(factKin);
        const isNearDuplicate =
          revision?.body !== undefined &&
          kinRevision?.body !== undefined &&
          memoryTextSimilarity(revision.body, kinRevision.body) >= MEMORY_NEAR_MATCH_JACCARD &&
          !factValuesDiffer(revision.body, kinRevision.body);
        if (!isNearDuplicate) {
          mayUpdate = {
            recordId: factKin.recordId,
            title: named(factKin, kinRevision),
            ...(factKin.currentRevisionId === undefined ? {} : { currentRevisionId: factKin.currentRevisionId }),
          };
          if (similarTo?.recordId === mayUpdate.recordId) {
            similarTo = undefined;
          }
        }
      }
    }
    return {
      ...definedOnly({ updates, mayUpdate, similarTo }),
      ...(supersedes.length === 0 ? {} : { supersedes }),
      ...(kin === undefined ? {} : { kin: kin === null ? null : { recordId: kin.recordId, title: named(kin) } }),
    };
  }

  /**
   * Auto-approve's kin: a kept record of `record`'s
   * kind in its scope among the top `MEMORY_AUTO_APPROVE_KIN_HITS` lexical
   * hits for its body whose body's token-set Jaccard similarity is at least
   * `MEMORY_AUTO_APPROVE_KIN_JACCARD`, or, given `vector` (made under hybrid
   * recall's rules by the owner), among hybrid recall's candidates (approved,
   * current, in force, never sensitive) with cosine at least
   * `MEMORY_AUTO_APPROVE_KIN_COSINE`. Never a tidy-up's input. `null` for
   * none; undefined when an index cannot be read, which the caller reads as
   * akin.
   */
  #kinOf(
    record: MemoryRecord,
    revision: MemoryRevision | undefined,
    replaced: ReadonlySet<string>,
    vector: { readonly modelKey: string; readonly vector: readonly number[] } | undefined,
    workspaceId: string,
    now: string,
  ): MemoryRecord | null | undefined {
    const other = (candidate: MemoryRecord): boolean =>
      candidate.recordId !== record.recordId &&
      candidate.kind === record.kind &&
      candidate.status === "approved" &&
      !replaced.has(candidate.recordId);
    const query = revision?.body === undefined ? undefined : memoryNearMatchQuery(revision.body);
    if (revision?.body !== undefined && query !== undefined) {
      const body = revision.body;
      try {
        const hits = this.#memory.search({
          scopeKeys: [record.scopeKey],
          query,
          limit: MEMORY_AUTO_APPROVE_KIN_HITS,
          now,
          includeSensitive: true,
        });
        const kin = hits.find(
          (hit) =>
            other(hit.record) &&
            hit.revision.body !== undefined &&
            memoryTextSimilarity(body, hit.revision.body) >= MEMORY_AUTO_APPROVE_KIN_JACCARD,
        );
        if (kin !== undefined) return kin.record;
      } catch {
        return undefined;
      }
    }
    if (vector === undefined) return null;
    if (vector.vector.length === 0 || vector.vector.length > MAX_QUERY_VECTOR_DIMS) return undefined;
    try {
      const { ranked } = this.#memory.vectorCandidates({
        scopeKeys: [record.scopeKey],
        workspaceId,
        now,
        modelKey: vector.modelKey,
        vector: vector.vector,
        limit: MEMORY_AUTO_APPROVE_KIN_HITS,
      });
      for (const hit of ranked) {
        if (hit.score < MEMORY_AUTO_APPROVE_KIN_COSINE) break;
        const candidate = this.#memory.getRecord(hit.recordId);
        if (candidate !== undefined && other(candidate)) return candidate;
      }
      return null;
    } catch {
      return undefined;
    }
  }

  /**
   * The Center rail's and the session list's counts: proposals in
   * the operator's page, and each named chat's notes — the operator's durable
   * notes there, approved or waiting, never a forgotten one or another
   * person's. A chat with none is left out.
   */
  counts(input: Parameters<MemoryServicePort["counts"]>[0]): {
    readonly proposed: number;
    readonly chatNotes: Readonly<Record<string, number>>;
  } {
    requireOperatorView(input.actor, "count");
    if ((input.taskIds?.length ?? 0) > MAX_COUNTED_CHATS) {
      throw new TaviError("INVALID_INPUT", `At most ${MAX_COUNTED_CHATS} chats' notes are counted at once`);
    }
    const { workspaceId, principalId } = input.actor;
    return {
      proposed: this.#memory.countOperatorProposals({ workspaceId, principalId }),
      chatNotes:
        input.taskIds === undefined || input.taskIds.length === 0
          ? {}
          : this.#memory.countChatNotes({ workspaceId, principalId, taskIds: input.taskIds }),
    };
  }

  /**
   * Every person with personal memory in `statuses` that belongs with the
   * actor's workspace, uncapped, unlike `operatorView`'s `otherPeople`:
   * retention must reach every person.
   */
  principals(input: Parameters<MemoryServicePort["principals"]>[0]): readonly string[] {
    requireOperatorView(input.actor, "list the people of");
    const { workspaceId, statuses } = parseOrThrow(
      MemoryPrincipalsInputSchema,
      { workspaceId: input.actor.workspaceId, statuses: input.statuses },
      "The memory principals request is not valid",
    );
    return this.#memory.workspacePrincipals({ workspaceId, statuses });
  }

  /** The revision a record shows: its approved one, or a proposal's latest. */
  #shownRevision(record: MemoryRecord): MemoryRevision | undefined {
    if (record.currentRevisionId !== undefined) return this.#memory.getRevision(record.currentRevisionId);
    return this.#memory.listRevisions(record.recordId)[0];
  }

  /** A record on the operator's page (`MemoryReadView`), else `NOT_FOUND`: whether another person's record exists is not said. */
  #operatorRecord(actor: MemoryActor, recordId: string): MemoryRecord {
    requireOperatorView(actor, "read the operator's view of");
    const record = this.#memory.getRecord(recordId);
    if (record === undefined || record.status === "deleted" || !operatorSees(actor, record)) {
      throw new TaviError("NOT_FOUND", `Memory record ${recordId} does not exist`);
    }
    return record;
  }

  /** Every scope key of the operator's page that holds a record (`operatorView`'s `scopes`). */
  #operatorScopeKeys(actor: MemoryActor): string[] {
    return this.#memory.operatorScopes({ workspaceId: actor.workspaceId, principalId: actor.principalId }).map((scope) => scope.scopeKey);
  }

  /**
   * The keys a `list` or `search` reads. The actor's view: its
   * authorized scopes (or the one it names), narrowed by `scopeKeys`. The
   * operator's view: every chat's notes alone with `chatNotes`; else the
   * page's scopes, narrowed by `scopeKeys`, and the named `chats`' notes —
   * keys built here from the actor's own person and workspace, so a caller
   * names a chat, never another person's key.
   */
  #viewScopeKeys(input: {
    readonly actor: MemoryActor;
    readonly scope?: MemoryScope;
    readonly view?: MemoryReadView;
    readonly scopeKeys?: readonly string[];
    readonly chats?: readonly string[];
    readonly chatNotes?: boolean;
  }): readonly string[] {
    const narrowed = (keys: readonly string[]): string[] =>
      input.scopeKeys === undefined ? [...keys] : keys.filter((key) => input.scopeKeys?.includes(key) === true);
    if (input.view !== "operator") {
      if (input.chats !== undefined || input.chatNotes !== undefined) {
        throw new TaviError("INVALID_INPUT", "chats and chatNotes narrow the operator's view only");
      }
      return narrowed(readScopeKeys(this.#policy, input.actor, input.scope));
    }
    requireOperatorView(input.actor, "read the operator's view of");
    if (input.scope !== undefined) throw new TaviError("INVALID_INPUT", "The operator's view takes scope keys, not a scope");
    const { principalId, workspaceId } = input.actor;
    if (input.chatNotes === true) {
      if (input.scopeKeys !== undefined || input.chats !== undefined) {
        throw new TaviError("INVALID_INPUT", "Every chat's notes are read on their own, without scope keys or chats");
      }
      return [allChatNotesKey(principalId, workspaceId)];
    }
    return [
      ...narrowed(this.#operatorScopeKeys(input.actor)),
      ...[...new Set(input.chats ?? [])].map(
        (runId) => `${CHAT_NOTES_KEY_PREFIX}${memoryScopeKey({ kind: "run_local", principalId, workspaceId, runId })}`,
      ),
    ];
  }

  /**
   * The operator page's search: its scopes' approved, current
   * revisions by their words, sensitive ones included (the page labels and
   * withholds them), with none of automatic recall's own filters — no
   * conflict detection, no granted records, no revoked-source recheck — as
   * the page searched before the port. A failed index is `unavailable`.
   */
  #operatorSearch(input: Parameters<MemoryServicePort["search"]>[0], query: string, limit: number): MemorySearchResult {
    const scopeKeys = this.#viewScopeKeys(input);
    if (scopeKeys.length === 0) return { hits: [], coverage: "complete" };
    const requestedMatch = input.match ?? "all";
    const now = this.#now();
    let match: "all" | "any" | undefined;
    let hits;
    try {
      const searchLexical = (mode: "all" | "any") =>
        this.#memory
          .search({
            scopeKeys,
            query: toFtsPhraseQuery(query, mode),
            limit,
            now,
            includeSensitive: true,
          })
          .filter((hit) => operatorSees(input.actor, hit.record));
      hits = searchLexical(requestedMatch);
      if (requestedMatch === "all" && hits.length === 0 && query.split(/\s+/).length > 1) {
        const partial = searchLexical("any");
        if (partial.length > 0) {
          hits = partial;
          match = "any";
        }
      }
    } catch (error) {
      return { hits: [], coverage: "unavailable", reducedReason: errorMessage(error, "search index unavailable").slice(0, 300) };
    }
    return {
      hits: hits.map((hit) => ({
        recordId: hit.record.recordId,
        revisionId: hit.revision.revisionId,
        scope: hit.record.scope,
        kind: hit.record.kind,
        snippet: hit.snippet,
        recordedAt: hit.revision.recordedAt,
        superseded: hit.record.currentRevisionId !== hit.revision.revisionId,
        conflict: false,
        ...(hit.revision.title === undefined ? {} : { title: hit.revision.title }),
        ...(hit.revision.observedAt === undefined ? {} : { observedAt: hit.revision.observedAt }),
      })),
      coverage: "complete",
      ...(match === undefined ? {} : { match }),
    };
  }

  /**
   * Records `actor.allowedRecordIds` names explicitly,
   * fetched directly by id — bypassing scope authorization entirely, since
   * the grant itself is the authorization (the same "named, therefore
   * authorized" reasoning `getArtifact` already uses for mailbox-referenced
   * artifacts). A `forget()`ed record is a tombstone (`status: "deleted"`)
   * and is excluded exactly like every other read path, so a stale grant
   * can never resurrect an erased record (`allowedRecordIds` is captured
   * once at spawn and never revalidated against the granter's own ongoing
   * access, but a forgotten record must still disappear). `excludeRecordIds` skips ids already
   * present in the caller's scope-authorized set, so a merge never
   * double-counts a record that happens to be both in scope and granted.
   */
  #explicitlyGrantedRecords(
    actor: MemoryActor,
    filter: { readonly kinds?: readonly MemoryKind[]; readonly statuses?: readonly MemoryStatus[] },
    excludeRecordIds: ReadonlySet<string>,
  ): readonly MemoryRecord[] {
    if (actor.allowedRecordIds === undefined || actor.allowedRecordIds.length === 0) return [];
    const wantedKinds = filter.kinds === undefined ? undefined : new Set(filter.kinds);
    const wantedStatuses = filter.statuses === undefined ? undefined : new Set(filter.statuses);
    const records: MemoryRecord[] = [];
    for (const recordId of actor.allowedRecordIds) {
      if (excludeRecordIds.has(recordId)) continue;
      const record = this.#memory.getRecord(recordId);
      if (record === undefined || record.status === "deleted") continue;
      if (wantedKinds !== undefined && !wantedKinds.has(record.kind)) continue;
      if (wantedStatuses !== undefined && !wantedStatuses.has(record.status)) continue;
      records.push(record);
    }
    return records;
  }

  /**
   * `search()`'s own explicit-grant path. The
   * repository's `search` is indexed by scope key, not by record id, so an
   * explicitly-granted record outside the actor's authorized scopes cannot
   * simply be added to that call's `scopeKeys` (it would leak every other
   * record sharing that same scope key, not just the granted one). Instead
   * each granted id is fetched directly and matched against `query` by
   * requiring every whitespace-separated token to appear somewhere in its
   * title/body (order-independent, case-insensitive) — the same
   * implicit-AND-of-tokens the FTS path gets from quoting each token
   * separately (`toFtsPhraseQuery`, this file's own comment on why the
   * whole query is never quoted as one phrase). A plain whole-query
   * substring check was tried first and rejected: it required the query's
   * words to appear contiguously and in order, so it silently missed
   * matches the FTS-backed scope-authorized path would find for the exact
   * same content — this remains a disclosed
   * simplification (no relevance ranking, no stemming/prefix matching),
   * but not one with strictly narrower recall than its sibling path.
   * Adequate for a bound of `MAX_SHARED_MEMORY_RECORD_IDS` (32) records.
   * Every other
   * filter `search()` already applies to its scope-authorized hits
   * (current/approved, sensitivity, revoked-source citations) applies here
   * too, so a granted record is exempted from scope authorization only —
   * never from the rest of what makes a hit visible.
   */
  #explicitlyGrantedSearchHits(
    actor: MemoryActor,
    query: string,
    match: "all" | "any",
    now: string,
    includeSensitive: boolean,
    revokedSourceIds: ReadonlySet<string>,
    excludeRecordIds: ReadonlySet<string>,
    includePast = false,
  ): readonly { readonly record: MemoryRecord; readonly revision: MemoryRevision; readonly snippet: string }[] {
    if (actor.allowedRecordIds === undefined || actor.allowedRecordIds.length === 0) return [];
    const needles = query
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    const hits: { record: MemoryRecord; revision: MemoryRevision; snippet: string }[] = [];
    for (const recordId of actor.allowedRecordIds) {
      if (excludeRecordIds.has(recordId)) continue;
      const record = this.#memory.getRecord(recordId);
      if (record === undefined) continue;
      const isEndedFact =
        includePast &&
        record.kind === "fact" &&
        record.status === "approved" &&
        (record.validFrom === undefined || record.validFrom <= now) &&
        (record.expiryAt === undefined || record.expiryAt > now) &&
        record.validTo !== undefined &&
        record.validTo <= now;
      if (!isCurrent(record, now) && !isEndedFact) continue;
      if (!includeSensitive && record.sensitivity === "sensitive") continue;
      if (record.currentRevisionId === undefined) continue;
      const revision = this.#memory.getRevision(record.currentRevisionId);
      if (revision === undefined || citesRevokedSource(revision.sourceIds, revokedSourceIds)) continue;
      const haystack = `${revision.title ?? ""} ${revision.body ?? ""} ${(revision.keywords ?? []).join(" ")}`.toLowerCase();
      if (
        needles.length > 0 &&
        !(match === "any" ? needles.some((needle) => haystack.includes(needle)) : needles.every((needle) => haystack.includes(needle)))
      )
        continue;
      const baseSnippet = memoryExcerptOf(revision.body ?? "");
      hits.push({
        record,
        revision,
        snippet:
          isEndedFact && record.validTo !== undefined
            ? appendSnippetNote(baseSnippet, `(ended ${record.validTo.slice(0, 10)})`)
            : baseSnippet,
      });
    }
    return hits;
  }

  /**
   * The actor's authorized evidence sources currently revoked. `propose`
   * refuses citing one at write time (`#assertSourcesAvailable`), but a
   * source can also be revoked *after* a record that already cites it was
   * approved — source validity must be rechecked before subsequent model
   * calls, not just once at insert. `search`/
   * `resolvePreferences`/`resolveFactConflicts` use this to exclude a hit
   * whose evidence has since been withdrawn, rather than presenting it as
   * still-current: expired or unavailable evidence is never presented as
   * currently verifiable.
   */
  // Bounded by `MEMORY_LIST_PAGE_MAX` (`listEvidence`'s own limit), inherited
  // unchanged from `#assertSourcesAvailable`'s pre-existing propose-time
  // check. There, a false negative missed rejecting one write; here it is a
  // *standing* correctness property (unavailable evidence is never presented
  // as currently verifiable) re-evaluated on every
  // `search`/`resolvePreferences`/`resolveFactConflicts` call — an actor
  // with more than `MEMORY_LIST_PAGE_MAX` authorized evidence sources, where
  // the revoked one falls outside the most-recently-observed page, will not
  // have it excluded until a real evidence-revocation API can query by the
  // specific cited ids instead of listing-then-filtering.
  #revokedSourceIds(actor: MemoryActor): ReadonlySet<string> {
    const authorized = new Set(authorizedScopeKeys(this.#policy, actor));
    return new Set(
      this.#memory
        .listEvidence({ scopeKeys: [...authorized], limit: MEMORY_LIST_PAGE_MAX })
        .filter((source) => source.revocationStatus === "revoked")
        .map((source) => source.sourceId),
    );
  }

  /** Shared by `resolvePreferences`/`resolveFactConflicts`: drop any record whose current revision cites a revoked source. */
  #excludeRevokedSourceRecords(records: readonly MemoryRecord[], revoked: ReadonlySet<string>): readonly MemoryRecord[] {
    if (revoked.size === 0) return records;
    return records.filter((record) => {
      const revision = record.currentRevisionId === undefined ? undefined : this.#memory.getRevision(record.currentRevisionId);
      return !citesRevokedSource(revision?.sourceIds, revoked);
    });
  }
}
