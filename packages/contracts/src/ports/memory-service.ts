import type { MemoryRelated, MemorySuperseded, MemoryView } from "../memory-ipc.js";
import type {
  EvidenceSource,
  MemoryDeletion,
  MemoryKind,
  MemoryProposeOutcome,
  MemoryProvenance,
  MemoryRecord,
  MemoryReview,
  MemoryRevision,
  MemoryScope,
  MemorySearchHit,
  MemorySearchResult,
  MemorySensitivity,
  MemoryStatus,
  PreferenceValueType,
} from "../memory.js";
import type { AsyncRepository } from "../persistence-types.js";

/**
 * The actor a memory operation runs as.
 *
 * Ownership is derived from this context, never from a caller-supplied id: the
 * principal is the person whose memory is in play, the workspace is where the
 * invocation acts, and the caller names the surface (CLI, connector binding) for
 * audit. A Telegram id or an email address is never an application principal.
 */
export interface MemoryActor {
  readonly principalId: string;
  readonly workspaceId: string;
  readonly agentId?: string;
  readonly runId?: string;
  readonly caller: string;
  /**
   * Who this invocation acts as, for the one rule memory states most plainly: a
   * model can propose but cannot approve its own proposals. `"operator"` is a
   * human surface (CLI, Desktop, an authenticated "remember this" command) or
   * another trusted service acting under operator authority; `"model"` is the
   * model itself, e.g. through the `memory.propose` tool. There is no default
   * — every caller states which one it is, so authority is never inherited by
   * omission.
   */
  readonly authority: "operator" | "model";
  /**
   * Threaded from `InvocationContext.memoryScopeRestricted` (a spawned
   * worker's own admitted context) — when true, `MemoryService` skips
   * auto-granting `personal`/`personal_workspace`/`personal_agent` scope
   * for this actor's `principalId`/`workspaceId`/`agentId` alone;
   * `run_local` and `shared_workspace` are unaffected.
   * By convention always set together with `allowedRecordIds` (mirroring
   * `InvocationContext`'s own pairing), not type-enforced.
   */
  readonly scopeRestricted?: boolean;
  /**
   * Threaded from `InvocationContext.delegatedMemoryRecordIds` — records
   * explicitly granted to this actor regardless of their own `MemoryScope`,
   * the same "named, therefore authorized" reasoning
   * `getArtifact` already uses for mailbox-referenced artifacts.
   */
  readonly allowedRecordIds?: readonly string[];
  /**
   * The chat a delegated task belongs to (its delegation root), whose chat
   * notes — its durable `run_local` records, and only those — this actor may
   * read. Absent, or equal to `runId`, for a chat's
   * own turns, which read their `run_local` scope whole.
   */
  readonly chatTaskId?: string;
  /**
   * A side chat's parent: its chat notes — its durable
   * `run_local` records, and only those — are read besides the side chat's
   * own. One level: the parent's own parent is not read.
   */
  readonly parentChatId?: string;
  /**
   * `"chat-only"` (from `InvocationContext.memoryReach`): only
   * the chat's own `run_local` scope is readable or writable — with the notes
   * `chatTaskId`/`parentChatId` add — and no personal, persona or shared
   * scope, preferences included. Absent: the actor's ordinary scopes.
   */
  readonly reach?: MemoryReach;
}

/** How far a turn's memory reaches: `"chat-only"` reads and writes only its chat's notes. */
export type MemoryReach = "chat-only";

/**
 * Whose view a read takes. Absent: the actor's own scopes.
 * `"operator"`: the operator's page in the actor's workspace — the shared
 * scope, the actor's personal scopes there and those naming no workspace,
 * every agent's among them (`operatorSeesMemory`), and the actor's chat notes
 * there (`operatorSeesChatNote`). Operator authority only; anything else is
 * `NOT_FOUND` as an unauthorized record is.
 */
export type MemoryReadView = "operator";

/** One key's resolved preference (`MemoryServicePort.resolvePreferences`). */
export interface ResolvedPreference {
  readonly key: string;
  /** The winning revision's typed value, when it carries one. */
  readonly value: unknown;
  readonly winner: MemoryRecord;
  readonly overridden: readonly MemoryRecord[];
  /**
   * True when two or more same-scope approved records are both current for
   * this key: similarity/insertion order never breaks the tie silently
   * (unresolved same-scope conflicts are flagged rather than letting
   * similarity ranking choose). `winner` is still reported so a caller has
   * *a* value to fall back on, but should surface the conflict.
   */
  readonly conflict: boolean;
  readonly conflictRecordIds: readonly string[];
}

/** One entry in the person's always-in-context profile: an approved lesson or a core `me.*` fact. */
export interface ResolvedProfileEntry {
  readonly recordId: string;
  readonly revisionId: string;
  readonly kind: "lesson" | "fact";
  readonly scope: MemoryScope;
  readonly title?: string;
  readonly snippet: string;
  readonly recordedAt: string;
  readonly topicKey?: string;
  readonly usedChats: number;
  readonly conflict: boolean;
  readonly conflictsWith?: readonly string[];
}

/** What `propose` and `remember` both take: the record's scope, kind and content. */
interface MemoryWriteInput {
  readonly actor: MemoryActor;
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  /** Keep a `run_local` record for its chat's life: a chat note. Refused on any other scope. */
  readonly durable?: boolean;
  /** The chat the record is written from. */
  readonly originTaskId?: string;
  /** Made from a chat that used or runs on a local connection (`MemoryRecord.localOrigin`). A tidy-up is, when any record it replaces is. */
  readonly localOrigin?: boolean;
  readonly title?: string;
  readonly body?: string;
  readonly artifactId?: string;
  readonly preferenceKey?: string;
  readonly preference?: { readonly valueType: PreferenceValueType; readonly value: unknown };
  /** See `MemoryRecord.topicKey`. Immutable once set — never accepted by `correct`. */
  readonly topicKey?: string;
  /** Write-time search terms indexed in `keys`, at most `MAX_MEMORY_KEYWORDS`. */
  readonly keywords?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sensitivity?: MemorySensitivity;
  readonly observedAt?: string;
  /** When a preference or lesson stops applying; the sweep then marks it `expired`. */
  readonly expiryAt?: string;
  /** When a fact ends: out of recall from then, but kept, approved, as history. */
  readonly validTo?: string;
}

interface MemoryServicePortDefinition {
  /**
   * Record a proposal; a model's suggestion is never approved by the same call.
   * Exact dedup: the same normalised content (kind, scope,
   * preference or topic key, body and a preference's value) as a pending
   * proposal or a record in force answers that record, `known: "exact"`, and
   * writes nothing. An ended or expired record is never matched.
   */
  propose(
    input: MemoryWriteInput & {
      /**
       * Automatic capture's near-match drop: `"drop"` files
       * nothing when the top lexical hit in the scope is a near match (token-set
       * Jaccard at least `MEMORY_NEAR_MATCH_JACCARD`), and answers that record
       * with `known: "near"`. Absent: a near match is filed (the tool's path),
       * and the queue shows a "similar to" hint.
       */
      readonly nearMatch?: "drop";
      /**
       * The draft's unit vector and the model that made it (`connection/model`),
       * set only by the owner's hybrid wrapper under `retrieval: "hybrid"` (the
       * draft embedded as a record is, under hybrid recall's locality and
       * disclosure rules): with `nearMatch: "drop"`, a record in force in the
       * scope whose vector of that model has cosine at least
       * `MEMORY_NEAR_MATCH_COSINE` with it is a near match too. A caller's own
       * is never passed through.
       */
      readonly nearMatchVector?: { readonly modelKey: string; readonly vector: readonly number[] };
      /**
       * A tidy-up: the approved records this proposal
       * replaces, each at the revision it was drafted from (at most
       * `MEMORY_SUPERSEDES_MAX`, each visible to the actor and approved at that
       * revision now, else `REVISION_CONFLICT`). Written as `contains` lineage
       * edges from each input revision to the proposal's. Approving the
       * proposal checks each input is still at that revision
       * (`REVISION_CONFLICT` otherwise) and marks them `superseded` in the same
       * transaction; nothing is deleted or rewritten, and their revisions stay
       * readable. Exact dedup never answers one of the inputs.
       */
      readonly supersedes?: readonly { readonly recordId: string; readonly revisionId: string }[];
      /**
       * An update, from automatic capture or `memory.propose`'s `updates`: the
       * approved, in-force fact or lesson of the proposal's own kind in its
       * scope this proposal updates (`MemoryRecord.supersedesRecordId`).
       * Exempted from near-match drop, and resolved directly as `updates` by `related`.
       */
      readonly supersedesRecordId?: string;
      /**
       * Where the words may have come from, when untrusted: `memory.propose`
       * stamps its call's context label. A
       * tidy-up's revision carries the join of this and its inputs'
       * provenance, read through its `supersedes` lineage.
       */
      readonly provenance?: MemoryProvenance;
    },
  ): MemoryProposeOutcome;
  /**
   * Propose and approve exact normalized content in one operator call — an
   * explicit "remember this" does not need a second confirmation solely
   * because it is memory. Requires `authority: "operator"`; use
   * `propose` for a model's suggestion, which always needs a later `approve`.
   * Words already kept in the scope answer that record, and a waiting
   * proposal of them is approved: both with `known: "exact"`, so a
   * caller can tell a record this call created from one that was there.
   */
  remember(
    input: MemoryWriteInput & {
      /** The provenance a moved record keeps; see `propose`. */
      readonly provenance?: MemoryProvenance;
      readonly reason?: string;
    },
  ): MemoryProposeOutcome;
  /** Approve an exact revision; a stale expectation is a revision conflict. */
  approve(input: {
    readonly actor: MemoryActor;
    readonly recordId: string;
    readonly expectedRevisionId?: string;
    readonly reason?: string;
  }): MemoryRecord;
  reject(input: {
    readonly actor: MemoryActor;
    readonly recordId: string;
    readonly expectedRevisionId?: string;
    readonly reason?: string;
  }): MemoryRecord;
  /**
   * Replace an approved value with a new revision, closing the previous validity
   * interval in the same transaction; a concurrent edit is a conflict.
   *
   * Dates (*Keep longer*): a `validTo` or `expiryAt` not given is
   * kept, `null` clears it, and a date given must be in the future. An
   * `expired` record that had been approved is accepted when given a date,
   * compare-and-set on `expired`, and returns to `approved`; a preference
   * whose key has another active value by then is `MEMORY_CONFLICT`.
   */
  correct(input: {
    readonly actor: MemoryActor;
    readonly recordId: string;
    readonly expectedRevisionId?: string;
    readonly body?: string;
    readonly title?: string;
    readonly preference?: { readonly valueType: PreferenceValueType; readonly value: unknown };
    readonly topicKey?: string;
    readonly keywords?: readonly string[];
    readonly validTo?: string | null;
    readonly expiryAt?: string | null;
    /**
     * Provenance joined onto the new revision: an update applied by
     * *Replace* brings its own. The previous revision's is always kept.
     */
    readonly provenance?: MemoryProvenance;
    readonly reason?: string;
  }): MemoryRecord;
  /** Revoke access to a record without erasing it; it stops being retrievable. */
  revoke(input: { readonly actor: MemoryActor; readonly recordId: string; readonly reason: string }): MemoryRecord;
  /** Erase a record: body, revisions, index and lineage, with a content-free receipt. */
  forget(input: { readonly actor: MemoryActor; readonly recordId: string; readonly reason: string }): MemoryDeletion;
  /** One record the actor may read, else `NOT_FOUND`; `view: "operator"` reads it as the operator's page does (`MemoryReadView`). */
  get(input: { readonly actor: MemoryActor; readonly recordId: string; readonly view?: MemoryReadView }): MemoryRecord;
  list(input: {
    readonly actor: MemoryActor;
    readonly scope?: MemoryScope;
    readonly kinds?: readonly MemoryKind[];
    readonly statuses?: readonly MemoryStatus[];
    /** Only *past* records (`memoryRecordIsPast`), in place of `statuses`. */
    readonly past?: boolean;
    readonly limit?: number;
    readonly offset?: number;
    /** Read as the operator's page does (`MemoryReadView`); `scope` is then not taken. */
    readonly view?: MemoryReadView;
    /** Only these of the readable scopes, by key (`operatorView`'s `scopes`); a key outside them reads nothing. */
    readonly scopeKeys?: readonly string[];
    /** These chats' notes besides (their durable `run_local` records): the operator view only. */
    readonly chats?: readonly string[];
    /** Every chat's notes of the operator in the workspace, and only those: the operator view only. */
    readonly chatNotes?: boolean;
    /** Only records written from this chat (`MemoryRecord.originTaskId`). */
    readonly originTaskId?: string;
    /**
     * Each record with its current revision (`currentRevision`, as `history`
     * reads it) in the same read: an external provider's snapshots.
     * A record with no current revision carries none.
     */
    readonly withCurrentRevision?: boolean;
  }): readonly (MemoryRecord & { readonly currentRevision?: MemoryRevision })[];
  search(input: {
    readonly actor: MemoryActor;
    /**
     * The words to match. Blank only with `semantic` (a turn whose words hold
     * no keyword): with `queryVector` recall then ranks by meaning
     * alone; without it there is nothing to match, so no hits. A blank query
     * with neither is refused.
     */
    readonly query: string;
    readonly scope?: MemoryScope;
    /**
     * Search as the operator's page does (`MemoryReadView`): over its
     * scopes (narrowed by `scopeKeys`, with `chats` or only `chatNotes`),
     * sensitive records included and labelled, no conflict detection, and
     * no explicitly granted records. `scope` is then not taken.
     */
    readonly view?: MemoryReadView;
    /** See `list`'s; the operator view only. */
    readonly scopeKeys?: readonly string[];
    /** See `list`'s; the operator view only. */
    readonly chats?: readonly string[];
    /** See `list`'s; the operator view only. */
    readonly chatNotes?: boolean;
    readonly limit?: number;
    /**
     * Include `sensitivity: "sensitive"` records. Default excluded: automatic
     * prompt assembly has no declared purpose yet (sensitive records are
     * excluded from automatic prompt assembly and require explicit
     * purpose/data-release authority); an explicit inspection surface (CLI `memory show`, export)
     * passes `true`.
     */
    readonly includeSensitive?: boolean;
    /**
     * Leave out every `localOrigin` record: the reader is a chat on a remote
     * model, which never recalls what a local chat wrote.
     */
    readonly excludeLocalOrigin?: boolean;
    /**
     * `all` (the default): a hit holds every term of `query`; when no record
     * holds every term of a multi-word query, `search` retries with `any` and
     * sets `match: "any"` on `MemorySearchResult`. `any`: a hit holds at least
     * one, ranked by how well it matches — what automatic retrieval asks with
     * its keywords from the chat's recent turns.
     */
    readonly match?: "all" | "any";
    /**
     * Text to rank by meaning under hybrid recall: the
     * person's newest message on a turn (≤ `MEMORY_SEMANTIC_QUERY_MAX_CHARS`),
     * the model's query on the `memory.search` tool. Only the owner's hybrid
     * wrapper reads it: with `retrieval: "hybrid"` it embeds the text (never
     * a local chat's on a remote connection, within the recall deadline) and
     * passes `queryVector`; otherwise it is ignored. The heartbeat never sets it.
     */
    readonly semantic?: string;
    /**
     * The query's unit vector and the model that made it (`connection/model`),
     * set by the hybrid wrapper: recall then fuses bm25 and cosine ranks over
     * already-eligible records (RRF, k = 60), and a record with no vector of
     * that model is ranked by its words only, with `coverage: "partial"`.
     * `personal: false`: the workspace's embedding connection may not embed
     * personal records (a remote one whose personal-memory disclosure was
     * not accepted, `retrievalPersonal`), so they are ranked by their words alone and not counted
     * as missing a vector.
     */
    readonly queryVector?: { readonly modelKey: string; readonly vector: readonly number[]; readonly personal?: false };
    /**
     * Automatic recall: a turn's context, the `memory.search`
     * tool, or a heartbeat check. The owner then asks the workspace's memory
     * provider to rank, through the composition's registry, and renders only
     * the ids it answers that this search finds eligible. Absent (an operator's
     * search, the CLI): the service answers directly. The service ignores it.
     */
    readonly purpose?: "turn" | "tool" | "heartbeat";
    /**
     * The turn and step a turn's recall belongs to (`<turnId>:<step>`): the
     * context path searches more than once a step under the router, and the
     * owner asks the provider once per key, re-checking its ids against a
     * fresh search every time (a turn calls recall once). Absent: each
     * search asks. The service ignores it.
     */
    readonly recallKey?: string;
    /**
     * Apply the turn-recall relevance floor and MMR near-duplicate drop: drops
     * weak single-term matches (unless the term is rare in the reader's active
     * records in scope, matches a key segment, or matches in the title) and
     * near-duplicate lower-ranked hits. Direct `memory.search` tool and operator
     * calls leave this off.
     */
    readonly applyFloor?: boolean;
    /**
     * The bounded recency and confirmation priors in ranking. On unless
     * `false`: an internal switch for the eval, not a setting.
     */
    readonly rankingPriors?: boolean;
    /**
     * Record or revision ids (`recordId`, `revisionId`, or `memory:<revisionId>`)
     * that the chat's previous context blocks already showed; exempted from the
     * relevance floor.
     */
    readonly alreadyShownIds?: readonly string[];
    /**
     * When true, also return approved facts whose `validTo` has passed (marked
     * `(ended <YYYY-MM-DD>)`) and the latest superseded revision of replaced
     * facts (marked `(replaced <YYYY-MM-DD> by <title>)`). Never includes
     * expired preferences or lessons.
     */
    readonly includePast?: boolean;
    /**
     * Optional deterministic temporal range parsed from the query. Boosts hits
     * whose `observedAt` or validity interval overlaps `[from, to]` in RRF
     * without filtering out non-overlapping hits, and enables `includePast` when
     * `to` lies wholly in the past.
     */
    readonly range?: { readonly from: string; readonly to: string };
  }): MemorySearchResult;
  /**
   * The records of `recordIds` this actor's `search` would find eligible,
   * whatever words they hold, rendered as its hits are (invariant 4): the
   * same scope and reach, status, current revision,
   * validity and expiry, sensitivity, revoked-source and explicit-grant
   * filters, the same title and excerpt (`memoryExcerptOf`) and conflict
   * flags. Answers in the order asked, each id once; an id that fails any
   * filter is left out, never named. What a provider ranked with an index of
   * its own is checked by, before it renders. At most `MEMORY_SEARCH_MAX` ids.
   */
  eligible(input: {
    readonly actor: MemoryActor;
    readonly recordIds: readonly string[];
    /** See `search`'s. */
    readonly scope?: MemoryScope;
    /** See `search`'s; default excluded. */
    readonly includeSensitive?: boolean;
    /** See `search`'s. */
    readonly excludeLocalOrigin?: boolean;
  }): readonly MemorySearchHit[];
  /**
   * Resolve preferences by scope precedence, returning the winning record per
   * key plus the sources it overrode.
   *
   * `truncated` is true when the sweep reached its bound (`MEMORY_EXPORT_HARD_CAP`
   * approved preference records) and so may have missed a key: context
   * assembly flags it rather than calling the
   * set complete.
   */
  resolvePreferences(input: {
    readonly actor: MemoryActor;
    readonly keys?: readonly string[];
    /** See `search`'s `includeSensitive`; default excluded. */
    readonly includeSensitive?: boolean;
    /** See `search`'s. */
    readonly excludeLocalOrigin?: boolean;
    /** Include the reader's profile entries (`lessons` and core `me.*` facts) alongside preferences. */
    readonly includeProfile?: boolean;
  }): {
    readonly preferences: readonly ResolvedPreference[];
    readonly truncated: boolean;
    readonly profile?: readonly ResolvedProfileEntry[];
  };
  /**
   * Group approved, current `kind: "fact"` records by `topicKey` and flag
   * which groups are contradictory (contradictory facts retain
   * provenance and conflict status until resolved). Unlike
   * `resolvePreferences`, there is no precedence tie-break and no "winner":
   * facts are not mutually exclusive by scope the way preferences are, so
   * every current, approved record sharing a `topicKey` is returned, and
   * `conflict` is simply `records.length > 1`. Recency or confidence never
   * resolves a conflict on its own — `correct`/`revoke` (existing,
   * unchanged) is how an operator resolves one.
   */
  resolveFactConflicts(input: {
    readonly actor: MemoryActor;
    readonly topicKeys?: readonly string[];
    readonly includeSensitive?: boolean;
  }): readonly {
    readonly topicKey: string;
    readonly records: readonly MemoryRecord[];
    readonly conflict: boolean;
  }[];
  /**
   * Everything the actor may see in a scope, for operator inspection and
   * export. Never includes `deleted` tombstones; evidence is scoped to the
   * exported records, not every source in the authorized scopes.
   */
  export(input: { readonly actor: MemoryActor; readonly scope?: MemoryScope }): {
    readonly records: readonly MemoryRecord[];
    readonly revisions: readonly MemoryRevision[];
    readonly evidence: readonly EvidenceSource[];
    readonly reviews: readonly MemoryReview[];
    /** True when the export hit its page cap and does not cover every record. */
    readonly truncated: boolean;
  };
  /**
   * Stored record count and body bytes for the actor's scopes, against
   * quotas; `view: "operator"`, for every scope of the operator's page.
   */
  usage(input: { readonly actor: MemoryActor; readonly view?: MemoryReadView }): { readonly records: number; readonly bytes: number };
  /**
   * The operator's page: the scopes it shows that hold a
   * record, and other people's personal records in the workspace counted per
   * person, never listed (`otherProposals` counts their proposals whatever
   * `statuses` asks). Operator authority only.
   */
  operatorView(input: {
    readonly actor: MemoryActor;
    readonly statuses?: readonly Exclude<MemoryStatus, "deleted">[];
    readonly kinds?: readonly MemoryKind[];
  }): MemoryView;
  /**
   * A record's revisions, newest first, and its reviews, as stored:
   * authorized as `get` is.
   */
  history(input: { readonly actor: MemoryActor; readonly recordId: string; readonly view?: MemoryReadView }): {
    readonly revisions: readonly MemoryRevision[];
    readonly reviews: readonly MemoryReview[];
  };
  /**
   * What a proposal is related to, authorized as `get` is:
   * the record in force it **updates** (one holding its preference key, or
   * its fact's topic key), and the record in force its body is a near match
   * of (`similarTo`). Only records in force in the proposal's own scope
   * count; a sensitive proposal or record is named by no title. Nothing for
   * a record that does not wait.
   *
   * A tidy-up also names what it **supersedes**: each input at the
   * revision it was drafted from, with that revision's title and excerpt
   * (the "before"), and `stale` once the input is no longer approved at it
   * (approving then fails with `REVISION_CONFLICT`). An input forgotten
   * since, or not readable here, is named by no title. Its inputs are never
   * its `updates` or `similarTo`.
   *
   * Asked with `kin` (auto-approve), it also answers `kin`: a kept
   * record of the proposal's kind in its scope that is among the top
   * lexical hits for its body with token-set Jaccard similarity of at least
   * `MEMORY_AUTO_APPROVE_KIN_JACCARD`, or, given the draft's `vector`, among
   * hybrid recall's candidates with cosine of at least
   * `MEMORY_AUTO_APPROVE_KIN_COSINE` — perhaps the same thing, perhaps its
   * contradiction ("Lives in Berlin" beside "Lives in Lisbon"); `null` when
   * there is none. Never its tidy-up inputs; an unreadable index answers no
   * `kin` at all, which the caller reads as akin.
   */
  related(input: {
    readonly actor: MemoryActor;
    readonly recordId: string;
    readonly view?: MemoryReadView;
    readonly kin?: { readonly vector?: { readonly modelKey: string; readonly vector: readonly number[] } };
  }): {
    readonly updates?: MemoryRelated;
    readonly mayUpdate?: MemoryRelated;
    readonly similarTo?: MemoryRelated;
    readonly supersedes?: readonly MemorySuperseded[];
    readonly kin?: MemoryRelated | null;
  };
  /**
   * Counts for the Center rail and the session list: proposals in
   * the operator's page, and each of `taskIds`' chat notes (the operator's
   * durable notes there, approved or waiting; a chat with none is left out).
   * Operator authority only.
   */
  counts(input: { readonly actor: MemoryActor; readonly taskIds?: readonly string[] }): {
    readonly proposed: number;
    readonly chatNotes: Readonly<Record<string, number>>;
  };
  /**
   * Every person with personal memory in `statuses` that belongs with the
   * actor's workspace, uncapped: whom the retention sweep and the digest run
   * for. Operator authority only.
   */
  principals(input: { readonly actor: MemoryActor; readonly statuses: readonly Exclude<MemoryStatus, "deleted">[] }): readonly string[];
  /**
   * Expire proposals nobody reviewed within the window (`status: "expired"`),
   * or whose own `expiryAt` or `validTo` passed;
   * mark approved records whose `expiryAt` passed `expired` (compare-and-set
   * on `approved`; never for a `validTo`: an ended fact is kept); and
   * erase rejections and expired records the window after that (after the
   * sweep's mark, not the date), and run-local records past theirs (default
   * retention). Each erased record goes through the same `forget`
   * path an explicit request uses, so the deletion journal, index removal and
   * dependent-lineage handling are identical either way — this differs only
   * in what decided a record was eligible. Requires operator authority, scoped to
   * the actor's own authorized scopes (a
   * multi-principal sweep iterates principals, a maintenance-scheduler
   * concern outside this service). `run_local` candidates are further
   * limited to the actor's own current run — there is no way to name a
   * *past* run's id from outside it, so a scheduler needs its own way to
   * enumerate stale runs, not just principals, to reach that memory too.
   *
   * Best-effort, not all-or-nothing: a candidate whose `forget` fails (e.g.
   * already forgotten by a concurrent sweep) is simply absent from the
   * result rather than aborting the rest of the sweep.
   */
  sweepExpired(input: {
    readonly actor: MemoryActor;
    readonly policy?: { readonly proposedOrRejected: number; readonly runLocal: number };
  }): readonly { readonly recordId: string; readonly reason: string; readonly outcome: "expired" | "forgotten" }[];
}
export type MemoryServicePort = AsyncRepository<MemoryServicePortDefinition>;

/**
 * 30-day capture outcome counts for one revision-1 source (`tool`,
 * `epoch-flush`, `provider:<id>:capture`, `provider:<id>:consolidate`,
 * `operator`, `other`): counts only, never memory text.
 */
export interface MemoryCaptureSourceStats {
  readonly source: string;
  readonly proposed: number;
  /** Kept by a person's review. */
  readonly kept: number;
  /** Kept by the operator's standing auto-approve rule, never by a person: apart from `kept` so it does not lift the keep rate. */
  readonly autoKept: number;
  readonly replaced: number;
  readonly discarded: number;
  readonly expiredUnreviewed: number;
}

/**
 * The port suite a `MemoryServicePort` passes:
 * `describeMemoryServiceConformance` in `@tavi/plugin-kit/memory/conformance`. An
 * embedder's `memoryOverride` declares it, and the owner refuses to start
 * with an override that does not.
 */
export const MEMORY_PORT_CONFORMANCE = "tavi.memory-port/1";

/** What the owner hands an embedder's memory service when it builds it. */
export interface MemoryOverrideDependencies {
  /** The owner's clock, as an ISO timestamp: what the built-in service stamps its rows with. */
  readonly now: () => string;
  /**
   * Wake the Command Center pages that read `scope` after a write to it
   * (`onChange`): the built-in's tables bump them by trigger, a replacement's
   * records live elsewhere. Best effort; a chat's own memory wakes nothing.
   */
  readonly onChange: (scope: MemoryScope) => Promise<void>;
}

/**
 * An embedder's whole memory service in place of the built-in:
 * programmatic `serve()` and `composeTaviRuntime()` only, never a plugin.
 * `conformance` declares it passes the port suite; backup, export and
 * `tavi reset` then cover only Tavi's own tables.
 */
export interface MemoryOverride {
  readonly conformance: typeof MEMORY_PORT_CONFORMANCE;
  readonly create: (dependencies: MemoryOverrideDependencies) => MemoryServicePort;
}

/**
 * Persistence for model connections, their catalog and role bindings.
 *
 * Role bindings and workspace defaults are scoped by `workspace_id` in SQL; a
 * connection is installation-level, because an installation has
 * one trusted operator and connections carry no principal-scoped data. Credential
 * material is never stored — only the opaque reference.
 */
