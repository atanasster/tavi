import { randomBytes } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID,
  MEMORY_IPC_DEFAULT_STATUSES,
  MEMORY_IPC_LIST_DEFAULT,
  MEMORY_IPC_PREVIEW_CHARS,
  MEMORY_IPC_REVISIONS_MAX,
  MEMORY_SEARCH_MAX,
  TASK_MEMORY_USE_MAX,
  TaviError,
  decodeMemoryListCursor,
  encodeMemoryListCursor,
  memoryEndDateField,
  memoryErasesAt,
  memoryProposalExpiresAt,
  memoryScopeForTarget,
  resolveMemoryValidUntil,
  memoryScopeKey,
  memoryScopeTarget,
  type MemoryActor,
  type MemoryForgetAnswer,
  type TaviErrorCode,
  type MemoryGetAnswer,
  memoryUsedCount,
  type MemoryItem,
  type MemoryUsedRef,
  type MemoryListAnswer,
  type MemoryPayload,
  type MemoryRecord,
  type MemoryRelated,
  type MemoryRevision,
  type MemorySuperseded,
  type MemoryServicePort,
  type MemoryScope,
  type MemoryScopeTarget,
  type MemoryUsageAnswer,
  type MemoryWriteAnswer,
  type PersistencePort,
  type EffectiveMemorySettings,
  effectiveMemorySettings,
  memoryQuotasOf,
  MEMORY_CARD_EXCERPT_CHARS,
  MEMORY_CARD_FORGOTTEN_SUMMARY,
  MEMORY_FORGET_UNREACHED,
  MEMORY_PROMPT_KEEP_DAYS,
  memoryCardCountOf,
  memoryCardStateOf,
  memoryCardTitleOf,
  memoryCommandReceiptKey,
  memoryDigestOf,
  memoryProvenanceUntrusted,
  type MemoryCardAllAnswer,
  type MemoryDecideAllAnswer,
  type MemoryCardAnswer,
  type MemoryCardItem,
  type MemoryWhyAnswer,
  type MemoryProviderAnswer,
  type MemoryReindexAnswer,
  type MemoryReviewNowAnswer,
  type MemoryConsolidateNowAnswer,
  hostTimeZone,
  type WorkspaceSettingsRepositoryPort,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";
import { operatorActor } from "../../server/config-commands.js";
import { decideMemoryRecord, discardAll, keepAllPlain } from "./bulk.js";
import type { MemoryJobsNow } from "./jobs-now.js";
import { memoryProviderCommand, type MemoryProviderCommandDependencies } from "./provider-owner.js";
import type { IpcAnswer } from "../../shared/ipc-decisions.js";
import { OFFER_READ_REUSE_MS, recentRead } from "../../shared/recent-read.js";

/**
 * `memory`: the operator's view of memory, and
 * the first human path for an agent's proposals.
 *
 * Reads and writes both go through the owner's memory service
 * (`MemoryServicePort`) — the instance the agent's tools propose
 * through — as the operator. Reads take the operator's view
 * (`view: "operator"`: `operatorSeesMemory`), which is wider than any one
 * invocation's: it spans every agent's scope in the workspace. Writes take the
 * record's own scope, so the service's lifecycle rules, compare-and-set and
 * quotas apply and every edit is a revision the operator authored. Only a
 * chat's use list (`memoryUse`) is read from its own repository.
 */

/** The review note a proposal applied with *Replace* is discarded with (the memory store counts it as replaced). */
const APPLIED_AS_CORRECTION = "applied as a correction";

export interface MemoryCommandDependencies {
  readonly memory: Pick<
    MemoryServicePort,
    "remember" | "correct" | "approve" | "reject" | "forget" | "usage" | "get" | "list" | "search" | "history" | "related" | "operatorView"
  >;
  readonly repositories: Pick<PersistencePort["repositories"], "tasks" | "memoryUse"> & {
    /** A memory card's notice and rows; absent, `card` is `NOT_FOUND`. */
    readonly transcripts?: Pick<PersistencePort["repositories"]["transcripts"], "getNotice" | "memoryPrompts" | "page"> &
      /** Where a card's *Keep all* posts its receipt; absent, `card-all` is `NOT_CONFIGURED`. */
      Partial<Pick<PersistencePort["repositories"]["transcripts"], "postMemoryCard">>;
  };
  /** A new receipt card's id; absent, `card-all` is `NOT_CONFIGURED`. */
  readonly newId?: (prefix: string) => string;
  /** The operator principal a workspace is served for, or undefined for one this owner does not serve. */
  readonly principalOf: (workspaceId: string) => string | undefined;
  /** Whether the request came through the canvas's bridge: an edit's author is then `operator:ui`. */
  readonly fromBridge: boolean;
  /** Who a write is attributed to, when not the CLI or the canvas: `operator:command` for a chat command. */
  readonly caller?: string;
  readonly now: () => Date;
  /**
   * The workspace's memory settings in effect: the quota a
   * write is charged to and how long a proposal waits. Absent: the defaults.
   */
  readonly memorySettings?: (workspaceId: string) => Promise<EffectiveMemorySettings>;
  /** The workspace's zone, where a *Keep longer* date holds through its day. Absent: UTC. */
  readonly timeZoneOf?: (workspaceId: string) => Promise<string | undefined>;
  /**
   * Before a forget: what its receipt says of the channels whose earlier card
   * messages still show the record (`memoryUnreachedNote`). Absent: the
   * receipt names only the chats that quoted or used it.
   */
  readonly channelNote?: (recordId: string) => Promise<string | undefined>;
  /** The memory providers and their sync: `provider`, `set-provider` and `egress`. Absent: those are `UNAVAILABLE`. */
  readonly providers?: Omit<MemoryProviderCommandDependencies, "actor" | "now">;
  /** The memory host's background jobs on demand: `reindex`, `review-now` and `consolidate-now`. Absent: those are `UNAVAILABLE`. */
  readonly jobs?: MemoryJobsNow;
}

export type MemoryAnswer = IpcAnswer<
  | MemoryListAnswer
  | MemoryGetAnswer
  | MemoryWriteAnswer
  | MemoryForgetAnswer
  | MemoryUsageAnswer
  | MemoryCardAnswer
  | MemoryCardAllAnswer
  | MemoryDecideAllAnswer
  | MemoryWhyAnswer
  | MemoryProviderAnswer
  | MemoryReindexAnswer
  | MemoryReviewNowAnswer
  | MemoryConsolidateNowAnswer
>;

/** Recorded when `forget` names no reason; the journal requires one. */
const DEFAULT_FORGET_REASON = "forgotten by the operator";

export async function memoryCommand(deps: MemoryCommandDependencies, payload: MemoryPayload): Promise<MemoryAnswer> {
  try {
    const workspaceId = payload.workspaceId ?? DEFAULT_WORKSPACE_ID;
    // As `center`: a workspace this owner does not serve would otherwise
    // answer an empty, plausible-looking list.
    const principalId = deps.principalOf(workspaceId);
    if (principalId === undefined) {
      throw new TaviError("NOT_FOUND", `workspace ${workspaceId} is not configured on this owner`, { details: { workspaceId } });
    }
    const operator = { principalId, workspaceId };
    const settings = (await deps.memorySettings?.(workspaceId)) ?? effectiveMemorySettings(undefined);
    const proposalDays = settings.limits.proposalDays;
    const actorFor = (scope: MemoryScope): MemoryActor => ({
      principalId,
      workspaceId,
      caller: deps.caller ?? operatorActor(deps.fromBridge),
      authority: "operator",
      // The service reads an agent scope only as that agent's actor, and a
      // chat's notes only as that chat's.
      ...(scope.kind === "personal_agent" ? { agentId: scope.agentId } : {}),
      ...(scope.kind === "run_local" ? { runId: scope.runId } : {}),
    });

    /** Every read is the operator's page (`view: "operator"`), as the operator. */
    const read = {
      actor: { principalId, workspaceId, caller: deps.caller ?? operatorActor(deps.fromBridge), authority: "operator" },
      view: "operator",
    } as const;
    /** A card row's state: a proposal applied with *Replace* reads Replaced, not Discarded. */
    const cardStateOf = async (record: MemoryRecord): Promise<MemoryCardItem["state"]> => {
      if (record.status !== "rejected") return memoryCardStateOf(record.status);
      const { reviews } = await deps.memory.history({ ...read, recordId: record.recordId });
      return reviews[0]?.decision === "rejected" && reviews[0].reason === APPLIED_AS_CORRECTION ? "replaced" : "discarded";
    };
    /** A record the operator sees, or `NOT_FOUND` — whether another person's record exists is not said. */
    const visible = async (recordId: string): Promise<MemoryRecord> => await deps.memory.get({ ...read, recordId });
    /** A record the operator sees, or undefined for one forgotten or not theirs. */
    const visibleOrNone = async (recordId: string): Promise<MemoryRecord | undefined> => {
      try {
        return await visible(recordId);
      } catch (error) {
        if (TaviError.from(error).code === "NOT_FOUND") return undefined;
        throw error;
      }
    };
    /** The revision a record shows: its approved one, or a proposal's only one. */
    const currentRevision = async (record: MemoryRecord): Promise<MemoryRevision | undefined> =>
      shownRevision(record, (await deps.memory.history({ ...read, recordId: record.recordId })).revisions);
    /** A chat in this workspace, or `NOT_FOUND` alike for one that does not exist and one elsewhere. */
    const chatTask = async (taskId: string): Promise<string> => {
      const task = await deps.repositories.tasks.get(taskId);
      if (task === undefined || task.workspaceId !== workspaceId) throw new TaviError("NOT_FOUND", `Task ${taskId} does not exist`);
      return taskId;
    };
    /** The scope a write targets: a chat's notes only for a chat in this workspace. */
    const writable = async (target: MemoryScopeTarget): Promise<MemoryScope> => {
      const scope = memoryScopeForTarget(target, operator);
      // As `editable`: the shared scope is changed by an explicit share only.
      if (scope.kind === "shared_workspace") {
        throw new TaviError("NOT_AUTHORIZED", "Shared workspace memory is changed by an explicit share, not from here");
      }
      if (scope.kind === "run_local") await chatTask(scope.runId);
      return scope;
    };
    /** A visible record the operator may change: the shared scope is changed by an explicit share only. */
    const editable = async (recordId: string): Promise<MemoryRecord> => {
      const record = await visible(recordId);
      if (record.scope.kind === "shared_workspace") {
        throw new TaviError("NOT_AUTHORIZED", "Shared workspace memory is changed by an explicit share, not from here");
      }
      return record;
    };
    const written = async (record: MemoryRecord): Promise<MemoryItem> =>
      item(record, await currentRevision(record), { preview: false, reveal: false, proposalDays });
    /**
     * What a proposal is related to, computed by the service when it is shown: the record
     * in force it **updates**, and the record in force its body is a near match of ("similar to …").
     */
    const relatedOf = async (
      record: MemoryRecord,
    ): Promise<{
      readonly updates?: MemoryRelated;
      readonly mayUpdate?: MemoryRelated;
      readonly similarTo?: MemoryRelated;
      readonly supersedes?: MemorySuperseded[];
    }> => {
      if (record.status !== "proposed") return {};
      const { updates, mayUpdate, similarTo, supersedes } = await deps.memory.related({ ...read, recordId: record.recordId });
      // A tidy-up also names what it supersedes, its "before".
      return {
        ...definedOnly({ updates, mayUpdate, similarTo }),
        ...(supersedes === undefined || supersedes.length === 0 ? {} : { supersedes: [...supersedes] }),
      };
    };
    /**
     * What a card's item says a proposal is related to: what it updates or is similar to, and whether it is a
     * tidy-up, kept only in the app — a card shows no tidy-up's "before".
     */
    const cardRelatedOf = async (
      record: MemoryRecord,
    ): Promise<{
      readonly updates?: MemoryRelated;
      readonly mayUpdate?: MemoryRelated;
      readonly similarTo?: MemoryRelated;
      readonly tidyUp?: true;
    }> => {
      const { updates, mayUpdate, similarTo, supersedes } = await relatedOf(record);
      return {
        ...definedOnly({ updates, mayUpdate, similarTo }),
        ...(supersedes === undefined ? {} : { tidyUp: true as const }),
      };
    };
    /** A proposal as the page shows it, with what it updates or is similar to, or supersedes. */
    const shown = async (record: MemoryRecord, options: { readonly preview: boolean; readonly reveal: boolean }): Promise<MemoryItem> => {
      const revision = await currentRevision(record);
      return { ...item(record, revision, { ...options, proposalDays }), ...(await relatedOf(record)) };
    };
    /**
     * What one answer used, and what a listing showed it: its saved turn's `memoryUsed`, each record as the
     * reader sees it now — forgotten since, or not the reader's, it is left out and counted. Absent `seq`,
     * the chat's newest turn.
     */
    const usedByTurn = async (taskId: string, seq: number | undefined): Promise<Omit<MemoryWhyAnswer, "taskId">> => {
      await chatTask(taskId);
      const transcripts = deps.repositories.transcripts;
      if (transcripts === undefined) throw new TaviError("NOT_FOUND", `Task ${taskId} has no saved turns here`);
      const page =
        seq === undefined ? await transcripts.page(taskId, { limit: 1 }) : await transcripts.page(taskId, { after: seq - 1, limit: 1 });
      const entry = page.entries.at(-1);
      if (seq !== undefined && entry?.seq !== seq) throw new TaviError("NOT_FOUND", `Chat ${taskId} has no turn ${seq}`);
      if (entry === undefined) return { records: [] };
      const used = entry.turn.memoryUsed;
      const answered = { seq: entry.seq, answeredAt: entry.createdAt };
      if (used === undefined) return { ...answered, records: [], used: { recorded: false, used: 0, forgotten: 0, preferences: 0 } };
      const visible = async (refs: readonly MemoryUsedRef[]): Promise<MemoryItem[]> => {
        const shown: MemoryItem[] = [];
        for (const ref of refs) {
          const record = await visibleOrNone(ref.recordId);
          if (record === undefined) continue;
          shown.push(item(record, await currentRevision(record), { preview: true, reveal: false, proposalDays }));
        }
        return shown;
      };
      const records = await visible(used.records);
      const listed = await visible(used.listed?.records ?? []);
      return {
        ...answered,
        records,
        ...(used.listed === undefined ? {} : { listed }),
        used: {
          recorded: true,
          used: memoryUsedCount(used),
          forgotten: used.records.length - records.length,
          preferences: used.preferences,
          ...(used.listed === undefined
            ? {}
            : { listed: { count: memoryUsedCount(used.listed), forgotten: used.listed.records.length - listed.length } }),
        },
      };
    };

    switch (payload.action) {
      case "list": {
        const statuses = payload.statuses ?? MEMORY_IPC_DEFAULT_STATUSES;
        const view = await deps.memory.operatorView({
          actor: read.actor,
          statuses: [...statuses],
          ...(payload.kinds === undefined ? {} : { kinds: payload.kinds }),
        });
        const wanted = payload.scopes === undefined ? undefined : new Set<string>(payload.scopes);
        // A chat's notes are listed only when the chat is named, and only its
        // durable records: never its working memory.
        const chats = (payload.scopes ?? []).filter((target) => target.startsWith("chat:"));
        if (payload.chatNotes === true && (payload.scopes !== undefined || payload.usedInTaskId !== undefined)) {
          throw new TaviError("INVALID_INPUT", "Every chat's notes are listed on their own, without scopes or a chat's use");
        }
        if (
          payload.past === true &&
          (payload.statuses !== undefined ||
            payload.query !== undefined ||
            payload.usedInTaskId !== undefined ||
            payload.usedInTurn !== undefined)
        ) {
          throw new TaviError("INVALID_INPUT", "Past records are listed on their own, without statuses, a query or a chat's use");
        }
        // Every chat's notes, and only notes: never a run's working memory. The service builds the notes'
        // keys from the operator's own person and workspace; the page names the chats.
        const keys =
          payload.chatNotes === true
            ? { chatNotes: true }
            : {
                ...(wanted === undefined
                  ? {}
                  : { scopeKeys: view.scopes.filter((scope) => wanted.has(scope.target)).map((scope) => scope.scopeKey) }),
                ...(chats.length === 0 ? {} : { chats: chats.map((target) => chatOf(memoryScopeForTarget(target, operator))) }),
              };
        const limit = payload.limit ?? MEMORY_IPC_LIST_DEFAULT;
        if (payload.usedInTurn !== undefined) {
          if (
            payload.usedInTaskId !== undefined ||
            payload.chatNotes === true ||
            payload.query !== undefined ||
            payload.cursor !== undefined
          ) {
            throw new TaviError("INVALID_INPUT", "What one answer used is one page; it takes no chat's use, notes, query or cursor");
          }
          const turn = await usedByTurn(payload.usedInTurn.taskId, payload.usedInTurn.seq);
          const kinds = payload.kinds === undefined ? undefined : new Set<string>(payload.kinds);
          const allowed = new Set<string>(statuses);
          const matches = (record: MemoryItem): boolean =>
            (kinds === undefined || kinds.has(record.kind)) &&
            allowed.has(record.status) &&
            (wanted === undefined || wanted.has(record.target)) &&
            (payload.originTaskId === undefined || record.originTaskId === payload.originTaskId);
          const matching = turn.records.filter(matches);
          const listed = turn.listed?.filter(matches);
          const records = matching.slice(0, limit);
          // So `used = listed + forgotten + hidden + more` holds: what the filters left out is not "more not listed".
          const used =
            turn.used === undefined
              ? undefined
              : {
                  ...turn.used,
                  hidden: turn.records.length - matching.length,
                  ...(turn.used.listed === undefined
                    ? {}
                    : { listed: { ...turn.used.listed, hidden: (turn.listed?.length ?? 0) - (listed?.length ?? 0) } }),
                };
          return {
            ok: true,
            result: {
              records,
              ...(listed === undefined ? {} : { listed: listed.slice(0, limit) }),
              otherPeople: view.otherPeople,
              otherProposals: view.otherProposals,
              ...(used === undefined ? {} : { used }),
            },
          };
        }
        if (payload.usedInTaskId !== undefined) {
          if (payload.query !== undefined || payload.cursor !== undefined) {
            throw new TaviError("INVALID_INPUT", "What a chat used is one page; it takes no query or cursor");
          }
          // The chat's records, most recently used first, as far as the operator
          // sees them now: a record forgotten since, or another person's, is left out.
          await chatTask(payload.usedInTaskId);
          const used = await deps.repositories.memoryUse.list(payload.usedInTaskId, TASK_MEMORY_USE_MAX);
          const kinds = payload.kinds === undefined ? undefined : new Set<string>(payload.kinds);
          const allowed = new Set<string>(statuses);
          // Read together, in the order used, then filtered as a listing is.
          const records = await Promise.all(used.map((use) => visibleOrNone(use.recordId)));
          const shown = records
            .filter(
              (record): record is MemoryRecord =>
                record !== undefined &&
                (kinds === undefined || kinds.has(record.kind)) &&
                allowed.has(record.status) &&
                (wanted === undefined || wanted.has(memoryScopeTarget(record.scope) ?? "")) &&
                (payload.originTaskId === undefined || record.originTaskId === payload.originTaskId),
            )
            .slice(0, limit);
          const revisions = await Promise.all(shown.map((record) => currentRevision(record)));
          // When the chat's turns last had each, for its panel's "Used here".
          const usedAt = new Map(used.map((use) => [use.recordId, use.lastUsedAt]));
          const listed = shown.map((record, index) => {
            const at = usedAt.get(record.recordId);
            return {
              ...item(record, revisions[index], { preview: true, reveal: false, proposalDays }),
              ...(at === undefined ? {} : { usedAt: at }),
            };
          });
          return { ok: true, result: { records: listed, otherPeople: view.otherPeople, otherProposals: view.otherProposals } };
        }
        if (payload.query !== undefined) {
          if (payload.cursor !== undefined) {
            throw new TaviError("INVALID_INPUT", "A memory search answers one page of the best matches; it takes no cursor");
          }
          const query = payload.query;
          // The index holds approved, current revisions only; the other
          // filters apply to what it found.
          const kinds = payload.kinds === undefined ? undefined : new Set<string>(payload.kinds);
          const allowed = new Set<string>(statuses);
          const found = async (mode: "all" | "any"): Promise<{ items: MemoryItem[]; match: "all" | "any"; hadHits: boolean }> => {
            const result = await deps.memory.search({
              ...read,
              ...keys,
              query,
              match: mode,
              // Filtered by origin below, so asked for the most a search returns rather than one page.
              limit: payload.originTaskId === undefined ? Math.min(limit, MEMORY_SEARCH_MAX) : MEMORY_SEARCH_MAX,
            });
            if (result.coverage === "unavailable") throw new TaviError("UNAVAILABLE", result.reducedReason ?? "search index unavailable");
            const items: MemoryItem[] = [];
            for (const hit of result.hits) {
              if (items.length >= limit) break;
              if (!(kinds === undefined || kinds.has(hit.kind))) continue;
              const record = await visibleOrNone(hit.recordId);
              if (record === undefined || !allowed.has(record.status)) continue;
              if (payload.originTaskId !== undefined && record.originTaskId !== payload.originTaskId) continue;
              const { revisions } = await deps.memory.history({ ...read, recordId: record.recordId });
              items.push(
                item(
                  record,
                  revisions.find((revision) => revision.revisionId === hit.revisionId),
                  { preview: true, reveal: false, snippet: hit.snippet, proposalDays },
                ),
              );
            }
            return { items, match: result.match ?? mode, hadHits: result.hits.length > 0 };
          };
          // Operator search stays precise — every word — and only when that finds
          // nothing does it run again for records holding any of them, answered as partial matches.
          let records: MemoryItem[];
          let match: "all" | "any" = "all";
          try {
            const first = await found("all");
            records = first.items;
            if (records.length > 0 && first.match === "any") {
              match = "any";
            } else if (records.length === 0 && first.hadHits && first.match !== "any" && query.trim().split(/\s+/).length > 1) {
              const partial = await found("any");
              records = partial.items;
              if (records.length > 0) match = "any";
            }
          } catch (error) {
            if (TaviError.from(error).code !== "UNAVAILABLE") throw error;
            // A failed index is distinct from "no matches".
            return {
              ok: true,
              result: { records: [], otherPeople: view.otherPeople, otherProposals: view.otherProposals, coverage: "unavailable" },
            };
          }
          return {
            ok: true,
            result: { records, otherPeople: view.otherPeople, otherProposals: view.otherProposals, coverage: "complete", match },
          };
        }
        const offset = payload.cursor === undefined ? 0 : decodeCursor(payload.cursor);
        // One row past the page says whether another page exists.
        const page = await deps.memory.list({
          ...read,
          ...keys,
          // *Past*: ended facts and expired preferences and lessons, in place of the statuses.
          ...(payload.past === true ? { past: true } : { statuses: [...statuses] }),
          limit: limit + 1,
          offset,
          ...(payload.kinds === undefined ? {} : { kinds: payload.kinds }),
          ...(payload.originTaskId === undefined ? {} : { originTaskId: payload.originTaskId }),
        });
        const records: MemoryItem[] = [];
        for (const record of page.slice(0, limit)) {
          // A proposal says what it updates and what it is similar to.
          records.push(await shown(record, { preview: true, reveal: false }));
        }
        return {
          ok: true,
          result: {
            records,
            otherPeople: view.otherPeople,
            otherProposals: view.otherProposals,
            ...(page.length > limit ? { nextCursor: encodeMemoryListCursor(offset + limit) } : {}),
          },
        };
      }
      case "get": {
        const record = await visible(payload.recordId);
        const history = await deps.memory.history({ ...read, recordId: record.recordId });
        const revisions = history.revisions;
        const current = revisions.find((revision) => revision.revisionId === record.currentRevisionId) ?? revisions[0];
        const reviews = [...history.reviews]
          .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt))
          .slice(0, MEMORY_IPC_REVISIONS_MAX);
        return {
          ok: true,
          result: {
            record: {
              ...item(record, current, { preview: false, reveal: payload.reveal === true, proposalDays }),
              ...(await relatedOf(record)),
            },
            revisions: revisions.slice(0, MEMORY_IPC_REVISIONS_MAX).map((revision) => ({
              revisionId: revision.revisionId,
              revisionNumber: revision.revisionNumber,
              status: revision.status,
              author: revision.author,
              recordedAt: revision.recordedAt,
              sourceCount: revision.sourceIds.length,
              ...(revision.validFrom === undefined ? {} : { validFrom: revision.validFrom }),
              ...(revision.validTo === undefined ? {} : { validTo: revision.validTo }),
            })),
            revisionCount: revisions.length,
            reviews: reviews.map((review) => ({
              decision: review.decision,
              reviewerPrincipalId: review.reviewerPrincipalId,
              decidedAt: review.decidedAt,
              revisionId: review.revisionId,
              ...(review.reason === undefined ? {} : { reason: review.reason }),
            })),
          },
        };
      }
      case "remember": {
        if (payload.kind !== "preference" && (payload.preferenceKey !== undefined || payload.preferenceValue !== undefined)) {
          throw new TaviError("INVALID_INPUT", "preferenceKey and preferenceValue apply to kind preference only");
        }
        const scope = await writable(payload.scope);
        const origin =
          scope.kind === "run_local" ? scope.runId : payload.originTaskId === undefined ? undefined : await chatTask(payload.originTaskId);
        const record = await deps.memory.remember({
          actor: actorFor(scope),
          scope,
          kind: payload.kind,
          ...(scope.kind === "run_local" ? { durable: true } : {}),
          ...(origin === undefined ? {} : { originTaskId: origin }),
          body: payload.body,
          ...definedOnly({
            title: payload.title,
            sensitivity: payload.sensitivity,
            preferenceKey: payload.preferenceKey,
          }),
          ...(payload.preferenceValue === undefined
            ? {}
            : { preference: { valueType: "string" as const, value: payload.preferenceValue } }),
          ...(payload.topicKey === undefined ? {} : { topicKey: payload.topicKey }),
          ...(payload.reason === undefined ? {} : { reason: payload.reason }),
        });
        return { ok: true, result: await written(record) };
      }
      case "correct": {
        if (
          payload.title === undefined &&
          payload.body === undefined &&
          payload.preferenceValue === undefined &&
          payload.until === undefined
        ) {
          throw new TaviError("INVALID_INPUT", "A correction needs a new title, body, preference value or end date");
        }
        const record = await editable(payload.recordId);
        let timeZone: string | undefined;
        if (typeof payload.until === "string") {
          try {
            timeZone = await deps.timeZoneOf?.(workspaceId);
          } catch {
            // An unreadable zone is UTC.
          }
        }
        const dates = keepLongerDates(record, payload.until, deps.now().toISOString(), timeZone);
        const corrected = await deps.memory.correct({
          actor: actorFor(record.scope),
          recordId: record.recordId,
          ...definedOnly({
            expectedRevisionId: payload.expectedRevisionId,
            title: payload.title,
            body: payload.body,
          }),
          ...(payload.preferenceValue === undefined
            ? {}
            : { preference: { valueType: "string" as const, value: payload.preferenceValue } }),
          ...dates,
          ...(payload.reason === undefined ? {} : { reason: payload.reason }),
        });
        return { ok: true, result: await written(corrected) };
      }
      case "approve":
      case "reject": {
        const record = await editable(payload.recordId);
        const input = {
          actor: actorFor(record.scope),
          recordId: record.recordId,
          ...(payload.expectedRevisionId === undefined ? {} : { expectedRevisionId: payload.expectedRevisionId }),
          ...(payload.note === undefined ? {} : { reason: payload.note }),
        };
        const decided = payload.action === "approve" ? await deps.memory.approve(input) : await deps.memory.reject(input);
        return { ok: true, result: await written(decided) };
      }
      case "replace": {
        // *Replace*: the update applied as a correction of the record it updates, held to
        // that record's revision, then the proposal discarded as applied. Never a MEMORY_CONFLICT.
        const proposal = await editable(payload.recordId);
        if (proposal.status !== "proposed")
          throw new TaviError("CONFLICT", `Memory record ${proposal.recordId} is ${proposal.status}; only a waiting update is replaced`);
        const revision = await currentRevision(proposal);
        if (payload.expectedRevisionId !== undefined && payload.expectedRevisionId !== revision?.revisionId) {
          throw new TaviError("REVISION_CONFLICT", "The proposal changed since it was read", { details: { recordId: proposal.recordId } });
        }
        const { updates, mayUpdate } = await relatedOf(proposal);
        const targetRef = updates ?? mayUpdate;
        if (targetRef === undefined) throw new TaviError("INVALID_INPUT", "This proposal updates nothing kept now; keep it instead");
        if (payload.targetRevisionId !== undefined && payload.targetRevisionId !== targetRef.currentRevisionId) {
          throw new TaviError("REVISION_CONFLICT", "What it replaces changed since it was read", {
            details: { recordId: targetRef.recordId },
          });
        }
        const target = await editable(targetRef.recordId);
        // Held to the revision the update was drafted against, not only the one the reviewer saw: a
        // target corrected after the proposal was filed (its revision in force then is no longer current)
        // would take words written without the correction.
        const filedAt = revision?.recordedAt ?? proposal.recordedAt;
        const targetRevisions = (await deps.memory.history({ ...read, recordId: target.recordId })).revisions;
        const currentTargetRevision = targetRevisions.find((entry) => entry.revisionId === target.currentRevisionId);
        if (
          currentTargetRevision !== undefined &&
          currentTargetRevision.recordedAt > filedAt &&
          targetRevisions.some((entry) => entry.revisionId !== currentTargetRevision.revisionId && entry.recordedAt <= filedAt)
        ) {
          throw new TaviError("REVISION_CONFLICT", "What it replaces changed after this update was proposed", {
            details: { recordId: target.recordId },
          });
        }
        const preference = revision?.preference;
        const assignedTopicKey =
          target.kind === "fact" && target.topicKey === undefined
            ? (proposal.topicKey ?? `auto.m_${randomBytes(4).toString("hex")}`)
            : undefined;
        const corrected = await deps.memory.correct({
          actor: actorFor(target.scope),
          recordId: target.recordId,
          ...(targetRef.currentRevisionId === undefined ? {} : { expectedRevisionId: targetRef.currentRevisionId }),
          ...(revision?.title === undefined ? {} : { title: revision.title }),
          ...(revision?.body === undefined ? {} : { body: revision.body }),
          ...(preference === undefined ? {} : { preference: { valueType: preference.valueType, value: preference.value } }),
          ...(assignedTopicKey === undefined ? {} : { topicKey: assignedTopicKey }),
          // The update's own end date replaces the kept one's; none clears it (a fact's `validTo`, else `expiryAt`).
          ...(target.kind === "fact" ? { validTo: proposal.validTo ?? null } : { expiryAt: proposal.expiryAt ?? null }),
          // The update's words carry where they came from onto the record they replace.
          ...(revision?.provenance === undefined ? {} : { provenance: revision.provenance }),
          ...(revision?.keywords === undefined ? {} : { keywords: revision.keywords }),
          reason: "replaced by an update",
        });
        try {
          await deps.memory.reject({
            actor: actorFor(proposal.scope),
            recordId: proposal.recordId,
            ...(revision === undefined ? {} : { expectedRevisionId: revision.revisionId }),
            reason: APPLIED_AS_CORRECTION,
          });
        } catch (error) {
          // Decided elsewhere after the correction landed: the update is applied, and the proposal no longer waits.
          const code = TaviError.from(error).code;
          if (code !== "CONFLICT" && code !== "REVISION_CONFLICT") throw error;
        }
        return { ok: true, result: await written(corrected) };
      }
      case "forget": {
        const record = await editable(payload.recordId);
        // Read before the forget edits the cards: which channels' messages cannot be edited.
        const channels = await deps.channelNote?.(record.recordId).catch(() => undefined);
        const deletion = await deps.memory.forget({
          actor: actorFor(record.scope),
          recordId: record.recordId,
          reason: payload.reason ?? DEFAULT_FORGET_REASON,
        });
        // The receipt names what no forget reaches.
        return { ok: true, result: { ...deletion, unreached: [MEMORY_FORGET_UNREACHED, ...(channels === undefined ? [] : [channels])] } };
      }
      case "move": {
        const record = await editable(payload.recordId);
        if (record.status !== "approved")
          throw new TaviError("INVALID_INPUT", "Only an approved record can be moved; decide the proposal first");
        if (payload.expectedRevisionId !== undefined && payload.expectedRevisionId !== record.currentRevisionId) {
          throw new TaviError("REVISION_CONFLICT", "The record changed since it was read", { details: { recordId: record.recordId } });
        }
        const scope = await writable(payload.to);
        if (memoryScopeKey(scope) === record.scopeKey) throw new TaviError("INVALID_INPUT", "The record is already there");
        const revision = await currentRevision(record);
        if (revision?.body === undefined) throw new TaviError("INVALID_INPUT", "Only a record with a body can be moved");
        const preference = revision.preference;
        const origin = record.originTaskId ?? (record.scope.kind === "run_local" ? record.scope.runId : undefined);
        // Two service calls, not one transaction: the copy is made first, and
        // undone if the original cannot be forgotten as it was copied — an edit
        // landed in between, or the forget failed — so a move never leaves the
        // record twice, nor loses an edit with the original.
        const moved = await deps.memory.remember({
          actor: actorFor(scope),
          scope,
          kind: record.kind,
          body: revision.body,
          ...(revision.title === undefined ? {} : { title: revision.title }),
          sensitivity: record.sensitivity,
          ...(record.preferenceKey === undefined ? {} : { preferenceKey: record.preferenceKey }),
          ...(preference === undefined ? {} : { preference: { valueType: preference.valueType, value: preference.value } }),
          ...(record.topicKey === undefined ? {} : { topicKey: record.topicKey }),
          ...(record.expiryAt === undefined ? {} : { expiryAt: record.expiryAt }),
          // A fact's end goes with it.
          ...(record.validTo === undefined ? {} : { validTo: record.validTo }),
          ...(scope.kind === "run_local" ? { durable: true } : {}),
          ...(origin === undefined ? {} : { originTaskId: origin }),
          // A local chat's record stays one.
          ...(record.localOrigin === true ? { localOrigin: true } : {}),
          // Where its words came from moves with it.
          ...(revision.provenance === undefined ? {} : { provenance: revision.provenance }),
          ...(revision.keywords === undefined ? {} : { keywords: revision.keywords }),
          reason: payload.reason ?? `moved from ${memoryScopeTarget(record.scope) ?? "another scope"}`,
        });
        // Words the target already held are that record: never this move's to undo.
        const created = moved.known === undefined;
        const undo = async (): Promise<void> => {
          if (!created) return;
          await deps.memory.forget({ actor: actorFor(scope), recordId: moved.recordId, reason: "a move that did not complete" });
        };
        try {
          const now = await visibleOrNone(record.recordId);
          if (now?.status !== "approved" || now.currentRevisionId !== record.currentRevisionId) {
            throw new TaviError("REVISION_CONFLICT", "The record changed while it was moved; read it again", {
              details: { recordId: record.recordId },
            });
          }
          await deps.memory.forget({ actor: actorFor(record.scope), recordId: record.recordId, reason: `moved to ${payload.to}` });
        } catch (error) {
          await undo();
          throw error;
        }
        return { ok: true, result: await written(moved) };
      }
      case "card": {
        // A memory card: its rows hold ids, its text is read now from the memory rows.
        const transcripts = deps.repositories.transcripts;
        const notice = await transcripts?.getNotice(payload.noticeId);
        if (transcripts === undefined || notice === undefined || notice.kind !== "memory")
          throw new TaviError("NOT_FOUND", `Memory card ${payload.noticeId} does not exist`);
        await chatTask(notice.taskId);
        const rows = await transcripts.memoryPrompts(notice.noticeId);
        const items: MemoryCardItem[] = [];
        for (const row of rows) {
          const record = await visibleOrNone(row.recordId);
          const base = { token: row.token, number: row.number, recordId: row.recordId };
          if (record === undefined) {
            // Another person's memory is theirs: the card says only that it waits for them (invariant 21).
            // The service says neither whether it exists; the row names whose it is, and a forget takes its rows.
            const theirs = row.principalId !== principalId || row.workspaceId !== workspaceId;
            items.push({ ...base, state: theirs ? "hidden" : "forgotten", sensitive: false, title: null, excerpt: null });
            continue;
          }
          const revision = await currentRevision(record);
          const sensitive = record.sensitivity === "sensitive";
          const title = sensitive ? null : memoryCardTitleOf(revision ?? {});
          const body = sensitive ? undefined : revision?.body?.replace(/\s+/g, " ").trim();
          const excerpt = body === undefined || body === "" || body === title ? null : excerptOf(body);
          const target = memoryScopeTarget(record.scope);
          items.push({
            ...base,
            state: await cardStateOf(record),
            kind: record.kind,
            ...(target === undefined ? {} : { target }),
            sensitive,
            title,
            excerpt,
            ...(record.currentRevisionId === undefined
              ? revision === undefined
                ? {}
                : { currentRevisionId: revision.revisionId }
              : { currentRevisionId: record.currentRevisionId }),
            ...(record.status === "proposed" ? { expiresAt: memoryProposalExpiresAt(record, proposalDays) } : {}),
            ...(await cardRelatedOf(record)),
            // What the chat read before it was proposed: kept one at a time, never by *Keep all*.
            ...(revision?.provenance !== undefined && memoryProvenanceUntrusted(revision.provenance)
              ? { provenance: revision.provenance }
              : {}),
          });
        }
        // A forgotten record's rows went with it: the card counts what it was posted with. Once the sweep
        // deleted a settled card's rows (a week on), nothing is missing, only decided, unless a forget
        // took the card's last row and said so in its summary.
        const young = Date.parse(notice.createdAt) > deps.now().getTime() - MEMORY_PROMPT_KEEP_DAYS * 86_400_000;
        const emptiedByForget = items.length === 0 && notice.summary === MEMORY_CARD_FORGOTTEN_SUMMARY;
        const forgotten = items.length > 0 || young || emptiedByForget ? Math.max(0, memoryCardCountOf(notice.title) - items.length) : 0;
        // A digest's card says how many waited when it was sent, the listed ones included.
        const digest = memoryDigestOf(notice.title);
        return {
          ok: true,
          result: {
            noticeId: notice.noticeId,
            taskId: notice.taskId,
            title: notice.title,
            items,
            forgotten,
            ...(digest === undefined ? {} : { digest }),
          },
        };
      }
      case "card-all": {
        // A card's *Keep all* / *Discard all* in the app, under the one bulk rule (features/memory/bulk.ts).
        const transcripts = deps.repositories.transcripts;
        const notice = await transcripts?.getNotice(payload.noticeId);
        if (transcripts === undefined || notice === undefined || notice.kind !== "memory")
          throw new TaviError("NOT_FOUND", `Memory card ${payload.noticeId} does not exist`);
        if (transcripts.postMemoryCard === undefined || deps.newId === undefined)
          throw new TaviError("NOT_CONFIGURED", "A card's Keep all needs the owner's chat notices");
        await chatTask(notice.taskId);
        /** The `memory` command again, as this same reader: each decision is its own compare-and-set. */
        const run = async (inner: MemoryPayload): Promise<unknown> => {
          const answer = await memoryCommand(deps, { ...inner, workspaceId } as MemoryPayload);
          if (!answer.ok) throw new TaviError(answer.error.code as TaviErrorCode, answer.error.message);
          return answer.result;
        };
        const read = async (recordId: string): Promise<MemoryItem | undefined> => {
          try {
            return ((await run({ action: "get", recordId } as MemoryPayload)) as MemoryGetAnswer).record;
          } catch (error) {
            if (TaviError.from(error).code === "NOT_FOUND") return undefined;
            throw error;
          }
        };
        // The card's own records the reader sees, as they are now: another person's, or one forgotten, is passed over.
        const listed: MemoryItem[] = [];
        for (const row of await transcripts.memoryPrompts(notice.noticeId)) {
          const record = await read(row.recordId);
          if (record !== undefined) listed.push(record);
        }
        const decide = (decision: "approve" | "reject") => (record: MemoryItem) =>
          decideMemoryRecord({ record, decision, run, reread: () => read(record.recordId) });
        if (payload.decision === "discard") {
          return { ok: true, result: { kept: 0, discarded: await discardAll(listed, decide("reject")), needsLook: 0 } };
        }
        const { kept, needsLook } = await keepAllPlain(listed, decide("approve"));
        if (kept.length === 0) return { ok: true, result: { kept: 0, discarded: 0, needsLook } };
        // Its receipt: a *Saved · N* card of exactly what this keep kept, in the same chat, whose Undo forgets those.
        const receipt = await transcripts.postMemoryCard({
          noticeId: deps.newId("notice"),
          taskId: notice.taskId,
          sourceKey: memoryCommandReceiptKey("web", deps.newId("cmd")),
          createdAt: deps.now().toISOString(),
          records: kept.map((recordId) => ({ recordId, workspaceId, principalId })),
        });
        return { ok: true, result: { kept: kept.length, discarded: 0, needsLook, receiptNoticeId: receipt.notice.noticeId } };
      }
      case "decide-all": {
        // The Center's bulk Keep / Discard over the proposals it lists, under the one rule (features/memory/bulk.ts).
        const run = async (inner: MemoryPayload): Promise<unknown> => {
          const answer = await memoryCommand(deps, { ...inner, workspaceId } as MemoryPayload);
          if (!answer.ok) throw new TaviError(answer.error.code as TaviErrorCode, answer.error.message);
          return answer.result;
        };
        const read = async (recordId: string): Promise<MemoryItem | undefined> => {
          try {
            return ((await run({ action: "get", recordId } as MemoryPayload)) as MemoryGetAnswer).record;
          } catch (error) {
            if (TaviError.from(error).code === "NOT_FOUND") return undefined;
            throw error;
          }
        };
        // Each named record as it is now; one the reader does not see, or forgotten, is passed over. The shared
        // scope is changed by an explicit share only, as everywhere here.
        const listed: MemoryItem[] = [];
        for (const recordId of new Set(payload.recordIds)) {
          const record = await read(recordId);
          if (record !== undefined && record.target !== "shared") listed.push(record);
        }
        const decide = (decision: "approve" | "reject") => (record: MemoryItem) =>
          decideMemoryRecord({ record, decision, run, reread: () => read(record.recordId) });
        if (payload.decision === "discard")
          return { ok: true, result: { kept: [], discarded: await discardAll(listed, decide("reject")), needsLook: 0 } };
        const { kept, needsLook } = await keepAllPlain(listed, decide("approve"));
        return { ok: true, result: { kept: [...kept], discarded: 0, needsLook } };
      }
      case "why":
        // What an answer used, as its saved turn recorded it.
        return { ok: true, result: { taskId: payload.taskId, ...(await usedByTurn(payload.taskId, payload.seq)) } };
      case "usage": {
        const visible = await deps.memory.usage({ actor: read.actor, view: "operator" });
        // What a record the operator writes is checked against: the service's
        // own count for the operator actor, and the workspace's quotas
        // (`memory.limits.maxRecords` and the byte quota that follows it).
        const charged = await deps.memory.usage({ actor: actorFor({ kind: "personal", principalId }) });
        return { ok: true, result: { ...visible, quota: { ...charged, ...memoryQuotasOf(settings) } } };
      }
      case "provider":
      case "set-provider":
      case "egress":
        // The workspace's memory provider and its egress: the owner's registry, each change after its disclosure.
        if (deps.providers === undefined)
          throw new TaviError("UNAVAILABLE", "The memory provider is chosen on a running owner: start tavi serve");
        return {
          ok: true,
          result: await memoryProviderCommand(
            { ...deps.providers, actor: deps.caller ?? operatorActor(deps.fromBridge), now: () => deps.now().toISOString() },
            workspaceId,
            payload,
          ),
        };
      case "reindex":
      case "review-now":
      case "consolidate-now": {
        // The memory host's jobs on demand: the same code the tick runs, between ticks.
        if (deps.jobs === undefined)
          throw new TaviError("UNAVAILABLE", "The memory host's jobs run on a running owner, or offline under ownership");
        if (payload.action === "reindex") return { ok: true, result: await deps.jobs.reindex(workspaceId) };
        if (payload.action === "review-now") {
          if (payload.taskId !== undefined) await chatTask(payload.taskId);
          return { ok: true, result: await deps.jobs.reviewNow(workspaceId, payload.taskId) };
        }
        return { ok: true, result: await deps.jobs.consolidateNow(workspaceId, payload.principalId) };
      }
    }
  } catch (error) {
    const failure = TaviError.from(error);
    return { ok: false, error: { code: failure.code, message: failure.message } };
  }
}

/** A card's excerpt: the body cut to `MEMORY_CARD_EXCERPT_CHARS` UTF-16 units, the schema's measure, never splitting a surrogate pair. */
function excerptOf(body: string): string {
  let excerpt = "";
  for (const ch of body) {
    if (excerpt.length + ch.length > MEMORY_CARD_EXCERPT_CHARS) break;
    excerpt += ch;
  }
  return excerpt;
}

/** The revision a record shows, of its `revisions` (newest first): its approved one, or a proposal's only one. */
function shownRevision(record: MemoryRecord, revisions: readonly MemoryRevision[]): MemoryRevision | undefined {
  if (record.currentRevisionId !== undefined) return revisions.find((revision) => revision.revisionId === record.currentRevisionId);
  return revisions[0];
}

/** The chat a chat target's scope names. */
function chatOf(scope: MemoryScope): string {
  if (scope.kind !== "run_local") throw new TaviError("INTERNAL", "A chat target names a chat's scope");
  return scope.runId;
}

/**
 * A record as the page shows it. A sensitive record's title, body, topic and
 * preference keys and confidence basis are withheld unless revealed; a listed body is a preview. Evidence is a count.
 */
function item(
  record: MemoryRecord,
  revision: MemoryRevision | undefined,
  options: { readonly preview: boolean; readonly reveal: boolean; readonly snippet?: string; readonly proposalDays: number },
): MemoryItem {
  const redacted = record.sensitivity === "sensitive" && !options.reveal;
  let body = redacted ? null : (revision?.body ?? null);
  let truncated = false;
  if (body !== null && options.preview && body.length > MEMORY_IPC_PREVIEW_CHARS) {
    // By code point, so a preview never ends in half a character.
    body = Array.from(body).slice(0, MEMORY_IPC_PREVIEW_CHARS).join("");
    truncated = true;
  }
  const target = memoryScopeTarget(record.scope);
  // Every scope has a target; run-local memory reaches here only as a chat's notes.
  if (target === undefined) throw new TaviError("INTERNAL", `Memory record ${record.recordId} has no operator scope`);
  // A sensitive record's free-text keys say what it is about, so they are
  // withheld with its title and body.
  const { topicKey: _topicKey, preferenceKey: _preferenceKey, confidenceBasis: _confidenceBasis, ...withheld } = record;
  return {
    ...(redacted ? withheld : record),
    target,
    title: redacted ? null : (revision?.title ?? null),
    body,
    redacted,
    truncated,
    sourceCount: revision?.sourceIds.length ?? 0,
    ...(record.status === "proposed" ? { expiresAt: memoryProposalExpiresAt(record, options.proposalDays) } : {}),
    // An expired record that had been approved is erased a window after the sweep marked it.
    ...(record.status === "expired" && record.currentRevisionId !== undefined
      ? { erasesAt: memoryErasesAt(record, options.proposalDays) }
      : {}),
    ...(options.snippet === undefined || redacted ? {} : { snippet: options.snippet }),
    // Where its words may have come from: said on every review surface and by `tavi memory show`.
    ...(revision?.provenance === undefined ? {} : { provenance: revision.provenance }),
  };
}

/** The workspace's zone, read from its settings: the host's when it has none set. */
export function workspaceZoneOf(settings: Pick<WorkspaceSettingsRepositoryPort, "get">): (workspaceId: string) => Promise<string> {
  return async (workspaceId) => (await settings.get(workspaceId)).settings.timezone ?? hostTimeZone();
}

/**
 * `workspaceZoneOf` that remembers each zone it read, for a reader that
 * cannot wait (an approval card's `assess`): `known` answers the zone as last
 * read, or undefined before the first read of that workspace. `refresh` reads
 * it as tools are offered, once for all the hooks of a step.
 */
export function rememberedWorkspaceZone(settings: Pick<WorkspaceSettingsRepositoryPort, "get">): {
  readonly zoneOf: (workspaceId: string) => Promise<string>;
  readonly known: (workspaceId: string) => string | undefined;
  readonly refresh: (workspaceId: string) => Promise<void>;
} {
  const read = workspaceZoneOf(settings);
  const zones = new Map<string, string>();
  const zoneOf = async (workspaceId: string): Promise<string> => {
    const zone = await read(workspaceId);
    zones.set(workspaceId, zone);
    return zone;
  };
  return {
    zoneOf,
    known: (workspaceId) => zones.get(workspaceId),
    refresh: recentRead(zoneOf, OFFER_READ_REUSE_MS),
  };
}

/**
 * A *Keep longer* as the dates `correct` takes: `until` moves the
 * date the record has — its `expiryAt`, else its `validTo` — or, when it has
 * none, the one its kind takes. `null` clears that date. Absent: no
 * date is given, so `correct` keeps both.
 */
export function keepLongerDates(
  record: Pick<MemoryRecord, "kind" | "validTo" | "expiryAt">,
  until: string | null | undefined,
  now: string,
  timeZone?: string,
): { readonly validTo?: string | null; readonly expiryAt?: string | null } {
  if (until === undefined) return {};
  const field = record.expiryAt !== undefined ? "expiryAt" : record.validTo !== undefined ? "validTo" : memoryEndDateField(record.kind);
  if (until === null) return { [field]: null };
  const resolved = resolveMemoryValidUntil(until, now, timeZone);
  if (!resolved.ok) throw new TaviError("INVALID_INPUT", resolved.reason.replace("validUntil", "The new date"));
  return { [field]: resolved.at };
}

function decodeCursor(cursor: string): number {
  const offset = decodeMemoryListCursor(cursor);
  if (offset === undefined) throw new TaviError("INVALID_INPUT", "Invalid memory cursor; list again from the first page");
  return offset;
}
