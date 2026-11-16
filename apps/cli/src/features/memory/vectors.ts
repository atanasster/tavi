import {
  TaviError,
  type EffectiveMemorySettings,
  type InvocationContext,
  type MemorySearchResult,
  type MemoryServicePort,
  type ModelTarget,
  type PersistencePort,
} from "@tavi/contracts";
import { errorMessage } from "@tavi/contracts/util";
import { sensitiveTopicOf } from "@tavi/agent-host/workflow";

import type { EmbeddingRoleService } from "./embedding-role.js";

/**
 * Hybrid recall in the owner.
 *
 * **The query.** With `retrieval: "hybrid"`, a turn's or the `memory.search`
 * tool's `semantic` text is embedded on the bound `embedding` role within the
 * recall deadline (1.5 s) and passed on as `queryVector`; the worker fuses
 * bm25 and cosine ranks over records SQL already found eligible. A chat on a
 * local connection never sends its query to a remote embedding connection
 * (invariant 14): its recall is lexical, `coverage: "partial"`.
 * Nor does any query or record go to a remote connection other than the one
 * whose disclosure was accepted (`retrievalConnection`). The deadline covers
 * the whole wrapper, and one turn's text is embedded once, however many model
 * calls the turn makes (a failure too is remembered for the turn). Any
 * failure — no role, a refusal, a timeout, a failed call — is words only with
 * `partial`, never a failed turn. The heartbeat never sets `semantic`.
 *
 * **The backfill** (on the `tavi.memory` tick). Approved, current,
 * non-sensitive revisions of the workspace's records, and the personal ones
 * of the people it serves, without a vector of the bound model are embedded,
 * 64 texts a call and at most 600 a minute across the owner, so a model
 * change re-embeds everything at that pace. Personal records go through a
 * remote connection only once personal memory's own disclosure was accepted
 * for that connection (`retrievalPersonal`), and then only the workspace principal's — the operator who
 * accepted it (`embeddedPrincipals`): other people's stay lexical there, as
 * everyone's do without it, and their vectors of that model
 * go (out of the worker's cache too) once no workspace binding it may embed them. A failed call backs
 * the workspace's backfill off for an hour on that model, and a failed
 * batch's texts are then retried one by one: a failure counts against a text
 * only on a call that carried it alone, and only when the service had just
 * answered (the call before it succeeded, or was the same text's counted
 * failure), so an outage or a rate limit never fails good texts, however
 * long it lasts (invariant 24). A text that failed three times alone on a model is
 * skipped until the model changes, and doctor counts it. Memory
 * paused or `lexical` embeds nothing, and `lexical` drops the worker's cache.
 * Vectors of a model no workspace binds any more are pruned.
 */

/** Hybrid recall's deadline on a turn: past it, words only. */
const MEMORY_RECALL_DEADLINE_MS = 1_500;
/** Texts one embedding call carries at most (the port's own bound). */
const MEMORY_VECTOR_BATCH = 64;
/** Texts the backfill embeds a minute at most, across the owner. */
export const MEMORY_VECTOR_PER_MINUTE = 600;
/** Failures on one model after which a text is skipped until the model changes. */
export const MEMORY_VECTOR_FAILURES_MAX = 3;
/** How long a workspace's backfill waits on a model after a failed embedding call (invariant 24). */
export const MEMORY_VECTOR_BACKOFF_MS = 60 * 60_000;
/** The run the backfill's embedding calls are recorded against (each attempt id starts with `MEMORY_EMBEDDING_ATTEMPT_PREFIX`). */
const MEMORY_VECTOR_RUN_ID = "memory-embeddings";
/** Query vectors (or their failures) the recall wrapper remembers, newest kept: one per turn's text. */
const QUERY_VECTOR_MEMO_MAX = 64;
const TOO_LONG = "the embedding call took too long";

/** The `model_key` of a vector: the connection and model that made it. */
function memoryVectorModelKey(target: ModelTarget): string {
  return `${target.connectionId}/${target.model}`;
}

/**
 * The people a workspace serves, its principal first: whose personal memory
 * its backfill embeds and its disclosure counts. Another person's
 * personal memory never leaves through this workspace's connection.
 */
export function workspacePrincipals(principalId: string | undefined, people: readonly string[]): readonly string[] {
  return [...new Set([...(principalId === undefined ? [] : [principalId]), ...people])];
}

/**
 * Whether the workspace's bound embedding connection may embed personal
 * records: a local one always (nothing leaves the machine), a
 * remote one only when personal memory's own disclosure was accepted for that
 * very connection (`retrievalPersonal`) and
 * it is the accepted `retrievalConnection`. Otherwise they stay lexical there.
 */
function embedsPersonal(
  settings: Pick<EffectiveMemorySettings, "retrievalConnection" | "retrievalPersonal">,
  role: { readonly target: Pick<ModelTarget, "connectionId">; readonly locality: "local" | "remote" },
): boolean {
  if (role.locality === "local") return true;
  return (
    settings.retrievalPersonal !== undefined &&
    settings.retrievalPersonal === role.target.connectionId &&
    settings.retrievalConnection === role.target.connectionId
  );
}

/**
 * Whose personal records the workspace's bound embedding connection may
 * embed: a local one everyone's it serves (`principalIds`); a remote
 * one, under `embedsPersonal`, only the workspace principal's — the operator
 * who accepted personal memory's disclosure, for their own memory alone.
 * Another person's personal record never goes to a remote connection by it.
 */
function embeddedPrincipals(
  settings: Pick<EffectiveMemorySettings, "retrievalConnection" | "retrievalPersonal">,
  role: { readonly target: Pick<ModelTarget, "connectionId">; readonly locality: "local" | "remote" },
  principalId: string | undefined,
  principalIds: readonly string[],
): readonly string[] {
  if (role.locality === "local") return principalIds;
  return principalId !== undefined && embedsPersonal(settings, role) ? [principalId] : [];
}

/** Turn recall's times under hybrid, newest last, for doctor's p95 (in-process). */
export class MemoryRecallTimes {
  readonly #samples: number[] = [];
  readonly #max: number;

  constructor(max = 500) {
    this.#max = max;
  }

  add(ms: number): void {
    this.#samples.push(ms);
    if (this.#samples.length > this.#max) this.#samples.splice(0, this.#samples.length - this.#max);
  }

  /** The 95th percentile in milliseconds, or null before any hybrid recall ran. */
  p95(): number | null {
    if (this.#samples.length === 0) return null;
    const sorted = [...this.#samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    return p95 === undefined ? null : Math.round(p95);
  }

  get count(): number {
    return this.#samples.length;
  }
}

export interface HybridRecallDependencies {
  readonly memorySettings: (workspaceId: string) => Promise<EffectiveMemorySettings>;
  readonly embeddings: Pick<EmbeddingRoleService, "role" | "embed">;
  /** Whether the chat (or worker) ran on a local connection: its query never goes to a remote embedding connection. */
  readonly chatIsLocal: (workspaceId: string, taskId: string) => Promise<boolean>;
  /**
   * Whether the task is a heartbeat check's: its words are other people's
   * (signals), so a `memory.search` it makes stays lexical whatever the
   * setting (invariant 14). Absent: no task is.
   */
  readonly heartbeatTask?: (taskId: string) => Promise<boolean>;
  /**
   * The workspace's principal: the operator whose own personal memory a
   * remote connection may embed once they accepted it (`embeddedPrincipals`).
   * Absent or unknown: no personal record of anyone goes to a remote one.
   */
  readonly workspacePrincipal?: (workspaceId: string) => string | undefined;
  readonly times?: MemoryRecallTimes;
  readonly deadlineMs?: number;
  readonly now?: () => number;
}

type SearchInput = Parameters<MemoryServicePort["search"]>[0];

/**
 * Whether the bound embedding role may receive memory text and queries:
 * a local connection always, a remote one only when its disclosure was the
 * one accepted (invariant 14). Answers why not, or undefined.
 */
export function embeddingRefusal(
  settings: EffectiveMemorySettings,
  role: { readonly target: ModelTarget; readonly locality: "local" | "remote" },
): string | undefined {
  if (role.locality !== "remote" || role.target.connectionId === settings.retrievalConnection) return undefined;
  return `the embedding connection ${role.target.connectionId} has no accepted disclosure; accept it with \`tavi memory config retrieval hybrid --yes\``;
}

/** A query embedded, or why it was not. */
type EmbeddedQuery = { readonly modelKey: string; readonly vector: readonly number[] } | { readonly failure: string };

/** A failed embedding's reason, as recall reports it. */
function embedFailure(error: unknown): string {
  const failure = TaviError.from(error);
  return failure.code === "ABORTED" || failure.code === "CANCELLED" || /timeout|aborted/i.test(failure.message)
    ? TOO_LONG
    : `the embedding call failed (${failure.message.slice(0, 120)})`;
}

/** A lexical answer marked partial, naming why meaning search did not run (an unavailable one stays unavailable). */
function wordsOnly(result: MemorySearchResult, reason: string): MemorySearchResult {
  if (result.coverage === "unavailable") return result;
  return {
    ...result,
    coverage: "partial",
    reducedReason: (result.reducedReason === undefined ? reason : `${reason}; ${result.reducedReason}`).slice(0, 300),
  };
}

/**
 * Wrap a memory service's `search` with hybrid recall. `search` is the
 * service's own (lexical, or fused when given `queryVector`). A caller's own
 * `queryVector` is never passed through: only this wrapper sets it.
 */
export function hybridSearch(
  search: (input: SearchInput) => Promise<MemorySearchResult>,
  deps: HybridRecallDependencies,
): (input: SearchInput) => Promise<MemorySearchResult> {
  const now = deps.now ?? (() => performance.now());
  /** Each turn's query vector by workspace, run, model, locality and text: a turn's later model calls reuse it (one query a turn). */
  const memo = new Map<string, Promise<EmbeddedQuery>>();
  const remember = (key: string, embedded: Promise<EmbeddedQuery>): void => {
    memo.set(key, embedded);
    while (memo.size > QUERY_VECTOR_MEMO_MAX) {
      const oldest = memo.keys().next();
      if (oldest.done === true) break;
      memo.delete(oldest.value);
    }
  };
  return async (input) => {
    // The recall deadline runs from here, so the lookups before the call count against it too.
    const deadline = AbortSignal.timeout(deps.deadlineMs ?? MEMORY_RECALL_DEADLINE_MS);
    // `semantic` stays on the words-only search: with blank words (a turn with no keyword) it answers no hits, not a refusal.
    const { queryVector: _ignored, ...lexical } = input;
    const semantic = input.semantic;
    const settings = await deps.memorySettings(input.actor.workspaceId);
    const text = semantic?.trim() ?? "";
    if (settings.retrieval !== "hybrid" || text === "" || input.actor.runId === undefined) return search(lexical);
    const runId = input.actor.runId;
    if ((await deps.heartbeatTask?.(input.actor.chatTaskId ?? runId)) === true || (await deps.heartbeatTask?.(runId)) === true)
      return search(lexical);
    const started = now();
    try {
      let role: Awaited<ReturnType<EmbeddingRoleService["role"]>>;
      try {
        role = await deps.embeddings.role(input.actor.workspaceId);
      } catch (error) {
        return wordsOnly(await search(lexical), `no embedding model (${errorMessage(error).slice(0, 120)})`);
      }
      const refused = embeddingRefusal(settings, role);
      if (refused !== undefined) return wordsOnly(await search(lexical), refused);
      const local = await deps.chatIsLocal(input.actor.workspaceId, input.actor.chatTaskId ?? runId).catch(() => true); // Unknown is local: its words stay off a remote embedding connection.
      if (local && role.locality === "remote") {
        return wordsOnly(
          await search(lexical),
          "this chat runs on a local connection, so its words are not sent to the remote embedding connection",
        );
      }
      const key = JSON.stringify([input.actor.workspaceId, runId, memoryVectorModelKey(role.target), local, text]);
      let embedded = memo.get(key);
      if (embedded === undefined) {
        if (deadline.aborted) return wordsOnly(await search(lexical), TOO_LONG);
        const context: InvocationContext = {
          workspaceId: input.actor.workspaceId,
          principalId: input.actor.principalId,
          runId,
          caller: "memory",
        };
        embedded = deps.embeddings.embed({ context, texts: [text], signal: deadline, localOnly: local }).then(
          (answer): EmbeddedQuery => {
            const vector = answer.vectors[0];
            if (vector === undefined || vector.length === 0)
              return { failure: embedFailure(new TaviError("MODEL_FAILED", "The embedding call answered no vector")) };
            return { modelKey: memoryVectorModelKey(answer.target), vector: Array.from(vector) };
          },
          (error: unknown): EmbeddedQuery => ({ failure: embedFailure(error) }),
        );
        remember(key, embedded);
      }
      const query = await embedded;
      if ("failure" in query) return wordsOnly(await search(lexical), query.failure);
      try {
        // Personal records this connection may not embed are ranked by their words alone: through a
        // remote one, everyone's but the accepting operator's own.
        const personal = embeddedPrincipals(settings, role, deps.workspacePrincipal?.(input.actor.workspaceId), [
          input.actor.principalId,
        ]).includes(input.actor.principalId);
        return await search({ ...lexical, queryVector: personal ? query : { ...query, personal: false } });
      } catch (error) {
        return wordsOnly(await search(lexical), embedFailure(error));
      }
    } finally {
      deps.times?.add(now() - started);
    }
  };
}

type ProposeInput = Parameters<MemoryServicePort["propose"]>[0];

/** How long automatic capture waits on a draft's embedding before it dedups by words alone: a background call, not a turn's. */
const MEMORY_NEAR_MATCH_EMBED_MS = 10_000;

/** The text a draft is embedded from, as the backfill embeds a record: title, body, and a preference's key and value, one per line. */
function draftVectorText(input: ProposeInput): string {
  const value =
    input.preference === undefined
      ? undefined
      : typeof input.preference.value === "string"
        ? input.preference.value
        : JSON.stringify(input.preference.value);
  const parts = [input.title, input.body, input.preferenceKey === undefined ? undefined : `${input.preferenceKey}: ${value ?? ""}`]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "");
  return Array.from(parts.join("\n")).slice(0, 8_000).join("");
}

/**
 * A draft's vector under exactly hybrid recall's rules, or undefined:
 * `retrieval: "hybrid"`, a chat to charge it to that is not a heartbeat's,
 * an embedding role whose disclosure was accepted when it is remote, and
 * never a remote one for a chat that ran on a local connection (invariant
 * 14), and never a sensitive draft's — marked, or on the host's list
 * (`sensitiveTopicOf`, invariant 7). The draft is memory text about to be filed or kept, which the
 * accepted disclosure already covers. A failed or slow call is no vector,
 * never a failure. Shared by capture's near match and auto-approve's kin.
 */
export function hybridDraftVector(
  deps: HybridRecallDependencies,
): (input: ProposeInput) => Promise<{ readonly modelKey: string; readonly vector: number[] } | undefined> {
  return async (input) => {
    if (input.actor.runId === undefined) return undefined;
    const runId = input.actor.runId;
    const text = draftVectorText(input);
    if (text === "") return undefined;
    // A sensitive draft — marked, or on the host's list — is never embedded (invariants 7/14): words alone.
    if (input.sensitivity === "sensitive" || sensitiveTopicOf([text, input.topicKey]) !== undefined) return undefined;
    try {
      const settings = await deps.memorySettings(input.actor.workspaceId);
      if (settings.retrieval !== "hybrid") return undefined;
      if ((await deps.heartbeatTask?.(runId)) === true) return undefined;
      const role = await deps.embeddings.role(input.actor.workspaceId);
      if (embeddingRefusal(settings, role) !== undefined) return undefined;
      const local = await deps.chatIsLocal(input.actor.workspaceId, input.actor.chatTaskId ?? runId).catch(() => true); // Unknown is local: its words stay off a remote embedding connection.
      if (local && role.locality === "remote") return undefined;
      // A personal draft goes to a remote connection only as personal records do (`embeddedPrincipals`).
      if (
        input.scope.kind === "personal" &&
        !embeddedPrincipals(settings, role, deps.workspacePrincipal?.(input.actor.workspaceId), [input.scope.principalId]).includes(
          input.scope.principalId,
        )
      )
        return undefined;
      const context: InvocationContext = {
        workspaceId: input.actor.workspaceId,
        principalId: input.actor.principalId,
        runId,
        caller: "memory",
      };
      const answer = await deps.embeddings.embed({
        context,
        texts: [text],
        signal: AbortSignal.timeout(MEMORY_NEAR_MATCH_EMBED_MS),
        localOnly: local,
      });
      const vector = answer.vectors[0];
      if (vector === undefined || vector.length === 0) return undefined;
      return { modelKey: memoryVectorModelKey(answer.target), vector: Array.from(vector) };
    } catch {
      return undefined;
    }
  };
}

/**
 * Automatic capture's near match by meaning (cosine ≥ 0.92
 * once hybrid is on). A `propose` asking for the near-match drop is given
 * its draft's vector (`nearMatchVector`) under exactly hybrid recall's rules
 * (`hybridDraftVector`). Anything else — or a failed or slow call — is
 * dedup by words alone, never a failed capture. A caller's own vector is
 * never passed through.
 */
export function hybridNearMatch(deps: HybridRecallDependencies): (input: ProposeInput) => Promise<ProposeInput> {
  const draftVector = hybridDraftVector(deps);
  return async (input) => {
    const { nearMatchVector: _ignored, ...plain } = input;
    if (input.nearMatch !== "drop") return plain;
    const vector = await draftVector(plain);
    return vector === undefined ? plain : { ...plain, nearMatchVector: vector };
  };
}

export interface MemoryVectorBackfillDependencies {
  readonly memory: Pick<
    PersistencePort["repositories"]["memory"],
    "vectorBacklog" | "putVectors" | "recordVectorFailures" | "dropVectorCache" | "pruneVectors"
  >;
  readonly embeddings: Pick<EmbeddingRoleService, "role" | "embed">;
  /**
   * The owner's workspaces: each one's principal (whom the calls are charged
   * to) and the people it serves, its principal among them — whose personal
   * memory its backfill embeds (through a remote connection only its
   * principal's, with `retrievalPersonal`, `embeddedPrincipals`), and nobody else's.
   */
  readonly workspaces: () => readonly {
    readonly workspaceId: string;
    readonly principalId: string;
    readonly principalIds: readonly string[];
  }[];
  readonly memorySettings: (workspaceId: string) => Promise<EffectiveMemorySettings>;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

/** What one backfill pass did (`tavi memory reindex` reads it; the tick ignores it). */
interface MemoryVectorPass {
  /** Texts embedded and stored this pass. */
  readonly embedded: number;
  /** Texts whose embedding call failed this pass. */
  readonly failed: number;
  /** The minute's allowance ran out with texts still due: `retryInMs` until it frees again. */
  readonly limited: boolean;
  readonly retryInMs?: number;
  /** A workspace's backfill waits on its model after a failed call (an hour, invariant 24). */
  readonly backingOff: boolean;
}

export interface MemoryVectorBackfill {
  /**
   * Embed what is due, within the minute's allowance: every served
   * workspace, or only `workspaceId` (pruning then waits for a full tick).
   * Never throws.
   */
  tick(options?: { readonly workspaceId?: string }): Promise<MemoryVectorPass>;
}

/**
 * Prune what no workspace may keep: the vectors and failure counts of
 * a model no workspace binds any more, and a bound model's vectors of the
 * personal records no workspace binding it may embed — from the database and
 * every cache. The backfill's full tick runs it, and so does a settings write
 * that ends hybrid recall or personal memory's opt-in, so an opt-out takes
 * effect with the write even with the `tavi.memory` tick off.
 * Nothing is pruned when a binding or the settings cannot be read. Answers how
 * many vectors went; never throws.
 */
export async function pruneMemoryVectors(
  deps: Pick<MemoryVectorBackfillDependencies, "workspaces" | "memorySettings" | "log"> & {
    readonly memory: Pick<PersistencePort["repositories"]["memory"], "pruneVectors">;
    readonly embeddings: Pick<EmbeddingRoleService, "role">;
  },
): Promise<number> {
  try {
    /** The models some workspace binds. */
    const bound = new Set<string>();
    /** By model: the people whose personal records some workspace binding it may embed. */
    const personal = new Map<string, Set<string>>();
    for (const workspace of deps.workspaces()) {
      let role: Awaited<ReturnType<EmbeddingRoleService["role"]>>;
      try {
        role = await deps.embeddings.role(workspace.workspaceId);
      } catch (error) {
        if (TaviError.from(error).code === "NOT_CONFIGURED") continue;
        throw error;
      }
      const modelKey = memoryVectorModelKey(role.target);
      bound.add(modelKey);
      const people = personal.get(modelKey) ?? new Set<string>();
      for (const principalId of embeddedPrincipals(
        await deps.memorySettings(workspace.workspaceId),
        role,
        workspace.principalId,
        workspace.principalIds,
      ))
        people.add(principalId);
      personal.set(modelKey, people);
    }
    const pruned = await deps.memory.pruneVectors({
      keepModelKeys: [...bound],
      keepPersonal: [...bound].map((modelKey) => ({ modelKey, principalIds: [...(personal.get(modelKey) ?? [])] })),
    });
    if (pruned > 0) deps.log("memory vectors: pruned", { vectors: pruned });
    return pruned;
  } catch (error) {
    deps.log("memory vectors: pruning failed", { reason: errorMessage(error).slice(0, 200) });
    return 0;
  }
}

export function createMemoryVectorBackfill(deps: MemoryVectorBackfillDependencies): MemoryVectorBackfill {
  /** Texts sent in the last minute, by when: the owner-wide 600-a-minute bound. */
  const sent: { at: number; count: number }[] = [];
  const allowance = (at: number): number => {
    for (let oldest = sent[0]; oldest !== undefined && oldest.at <= at - 60_000; oldest = sent[0]) sent.shift();
    return MEMORY_VECTOR_PER_MINUTE - sent.reduce((total, entry) => total + entry.count, 0);
  };
  const aborted = (): boolean => deps.signal?.aborted === true;
  /**
   * By workspace and model: when its backfill may call again after a failed
   * call, and the revisions of a failed batch still to retry one by one,
   * oldest first. In-process: a restart retries the batch once more.
   */
  const backoff = new Map<string, number>();
  const suspects = new Map<string, string[]>();
  /**
   * By workspace and model: the last call's failure, absent after a success.
   * A lone failure counts against its text only when the call before it
   * succeeded, or was that same text's counted failure — so a sustained
   * outage, which fails every call, counts none (invariant 24).
   */
  const lastFailure = new Map<string, { readonly revisionId: string | undefined; readonly counted: boolean }>();
  return {
    async tick(options = {}) {
      const pass = { embedded: 0, failed: 0, limited: false, backingOff: false };
      const answer = (): MemoryVectorPass => {
        if (!pass.limited) return { ...pass };
        const oldest = sent[0]?.at;
        return { ...pass, retryInMs: oldest === undefined ? 0 : Math.max(0, oldest + 60_000 - deps.now().getTime()) };
      };
      for (const workspace of deps.workspaces()) {
        if (aborted()) return answer();
        if (options.workspaceId !== undefined && workspace.workspaceId !== options.workspaceId) continue;
        try {
          let role: Awaited<ReturnType<EmbeddingRoleService["role"]>> | undefined;
          try {
            role = await deps.embeddings.role(workspace.workspaceId);
          } catch {
            // No binding, or one that cannot be read: nothing to embed this tick (pruning reads it again, and holds off).
          }
          const settings = await deps.memorySettings(workspace.workspaceId);
          // Personal records through a remote connection only once their own disclosure was accepted for it, and
          // then only the accepting principal's.
          const principalIds = role === undefined ? [] : embeddedPrincipals(settings, role, workspace.principalId, workspace.principalIds);
          if (settings.retrieval !== "hybrid") {
            // Back to lexical: the worker's vectors for it go.
            await deps.memory.dropVectorCache(workspace.workspaceId);
            continue;
          }
          // A remote connection whose disclosure was not accepted gets nothing (invariant 14).
          if (!settings.enabled || role === undefined || embeddingRefusal(settings, role) !== undefined) continue;
          // A local chat's records go only to a local connection, whatever was accepted for a remote one.
          const withLocalOrigin = role.locality === "local";
          const modelKey = memoryVectorModelKey(role.target);
          const key = JSON.stringify([workspace.workspaceId, modelKey]);
          if (deps.now().getTime() < (backoff.get(key) ?? 0)) {
            pass.backingOff = true;
            continue;
          }
          backoff.delete(key);
          let embedded = 0;
          let failed = 0;
          for (;;) {
            const pending = suspects.get(key) ?? [];
            // A failed batch's texts go one at a time, so a failure is the text's own; then batches again.
            const left = allowance(deps.now().getTime());
            const room = Math.min(pending.length > 0 ? 1 : MEMORY_VECTOR_BATCH, left);
            if (room <= 0 || aborted()) {
              // Out of the minute's allowance: say so only when something is still due.
              if (left <= 0 && !aborted()) {
                const still = await deps.memory.vectorBacklog({
                  workspaceId: workspace.workspaceId,
                  principalIds,
                  modelKey,
                  now: deps.now().toISOString(),
                  limit: 1,
                  maxFailures: MEMORY_VECTOR_FAILURES_MAX,
                  withLocalOrigin,
                });
                if (still.length > 0 || pending.length > 0) pass.limited = true;
              }
              break;
            }
            const suspect = pending[0];
            const due = await deps.memory.vectorBacklog({
              workspaceId: workspace.workspaceId,
              principalIds,
              modelKey,
              now: deps.now().toISOString(),
              limit: room,
              maxFailures: MEMORY_VECTOR_FAILURES_MAX,
              withLocalOrigin,
              ...(suspect === undefined ? {} : { revisionIds: [suspect] }),
            });
            if (pending.length > 0 && due.length === 0) {
              // Embedded, ended, forgotten or failed out since: nothing to retry.
              pending.shift();
              if (pending.length === 0) suspects.delete(key);
              continue;
            }
            if (due.length === 0) break;
            sent.push({ at: deps.now().getTime(), count: due.length });
            try {
              const answer = await deps.embeddings.embed({
                context: {
                  workspaceId: workspace.workspaceId,
                  principalId: workspace.principalId,
                  runId: MEMORY_VECTOR_RUN_ID,
                  caller: "memory",
                },
                texts: due.map((entry) => entry.text),
                signal: deps.signal ?? new AbortController().signal,
                // A local chat's records go only to the local connection read above: a binding changed since is refused.
                ...(withLocalOrigin ? { localOnly: true } : {}),
              });
              // The model the call used: a binding changed mid-flight stores under the model that made the vectors.
              const usedKey = memoryVectorModelKey(answer.target);
              lastFailure.delete(key);
              embedded += await deps.memory.putVectors({
                vectors: due.flatMap((entry, index) => {
                  const vector = answer.vectors[index];
                  return vector === undefined ? [] : [{ revisionId: entry.revisionId, modelKey: usedKey, vector: Array.from(vector) }];
                }),
                now: deps.now().toISOString(),
              });
              if (pending.length > 0) {
                pending.shift();
                if (pending.length === 0) suspects.delete(key);
              }
              if (usedKey !== modelKey) break;
            } catch (error) {
              // No retry this tick, and none on this model for an hour (invariant 24).
              failed += due.length;
              pass.backingOff = true;
              backoff.set(key, deps.now().getTime() + MEMORY_VECTOR_BACKOFF_MS);
              const [alone] = due;
              if (due.length === 1 && alone !== undefined) {
                // A call that carried the text alone: the failure is counted against it (the third skips it until
                // the model changes) when the service had just answered, and it goes to the back of the retry line
                // so the others are not held up.
                const revisionId = alone.revisionId;
                const previous = lastFailure.get(key);
                const counted = previous === undefined || (previous.revisionId === revisionId && previous.counted);
                if (counted) await deps.memory.recordVectorFailures({ revisionIds: [revisionId], modelKey, now: deps.now().toISOString() });
                lastFailure.set(key, { revisionId, counted });
                const head = pending.shift();
                if (head !== undefined) {
                  pending.push(head);
                  suspects.set(key, pending);
                }
              } else {
                // A batch's failure may be the service's, not any one text's: its texts are retried alone, later.
                lastFailure.set(key, { revisionId: undefined, counted: false });
                suspects.set(
                  key,
                  due.map((entry) => entry.revisionId),
                );
              }
              deps.log("memory vectors: an embedding call failed", {
                workspaceId: workspace.workspaceId,
                texts: due.length,
                reason: errorMessage(error).slice(0, 200),
              });
              break;
            }
          }
          pass.embedded += embedded;
          pass.failed += failed;
          if (embedded > 0 || failed > 0)
            deps.log("memory vectors: backfill", { workspaceId: workspace.workspaceId, model: modelKey, embedded, failed });
        } catch (error) {
          deps.log("memory vectors: the backfill failed", {
            workspaceId: workspace.workspaceId,
            reason: errorMessage(error).slice(0, 200),
          });
        }
      }
      // Pruning reads every workspace's binding: a pass over one workspace leaves it to the tick.
      if (aborted() || options.workspaceId !== undefined) return answer();
      await pruneMemoryVectors(deps);
      return answer();
    },
  };
}

/**
 * Doctor's vector line: retrieval, the model, the accepted
 * remote connection, whether personal records are embedded, vectors indexed,
 * missing and failed, the cache, turn recall's p95 and today's embedding spend.
 */
export interface MemoryVectorsDoctor {
  readonly retrieval: "lexical" | "hybrid";
  readonly model: string | null;
  readonly locality: "local" | "remote" | null;
  /** The remote embedding connection whose disclosure was accepted (`memory.retrievalConnection`), or null. */
  readonly retrievalConnection: string | null;
  /** The remote connection personal memory's own disclosure was accepted for (`memory.retrievalPersonal`), or null. */
  readonly retrievalPersonal: string | null;
  /** Whether personal records are embedded through its connection: everyone's on a local one, the principal's own on a remote one. */
  readonly personal: boolean;
  readonly indexed: number;
  readonly missing: number;
  readonly failed: number;
  readonly cache: { readonly vectors: number; readonly bytes: number };
  readonly recallP95Ms: number | null;
  readonly recalls: number;
  /** Today's embedding calls across the owner (the backfill's and every query's): count, failures, input tokens, estimated dollars. */
  readonly spend?: MemoryEmbeddingSpend;
}

export interface MemoryEmbeddingSpend {
  readonly calls: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly estimatedUsd: number;
}

export async function memoryVectorsDoctor(input: {
  readonly workspaceId: string;
  /** The workspace's principal: whose personal records alone a remote connection may embed (`embeddedPrincipals`). */
  readonly principalId: string | undefined;
  /** The people the workspace serves (`workspacePrincipals`): whose personal records a local connection embeds, so count. */
  readonly principalIds: readonly string[];
  readonly settings: EffectiveMemorySettings;
  readonly memory: Pick<PersistencePort["repositories"]["memory"], "vectorStats">;
  readonly embeddings: Pick<EmbeddingRoleService, "role">;
  readonly times?: MemoryRecallTimes;
  readonly now: string;
  readonly spend?: MemoryEmbeddingSpend;
}): Promise<MemoryVectorsDoctor> {
  let model: string | null = null;
  let locality: "local" | "remote" | null = null;
  let personal = false;
  let principalIds: readonly string[] = [];
  try {
    const role = await input.embeddings.role(input.workspaceId);
    model = memoryVectorModelKey(role.target);
    locality = role.locality;
    // Personal records the connection may not embed stay lexical: neither indexed nor missing.
    personal = embedsPersonal(input.settings, role);
    principalIds = embeddedPrincipals(input.settings, role, input.principalId, input.principalIds);
  } catch {
    // No embedding model bound: nothing can be indexed.
  }
  const stats = await input.memory.vectorStats({
    workspaceId: input.workspaceId,
    principalIds,
    ...(model === null ? {} : { modelKey: model }),
    now: input.now,
    maxFailures: MEMORY_VECTOR_FAILURES_MAX,
  });
  return {
    retrieval: input.settings.retrieval,
    model,
    locality,
    retrievalConnection: input.settings.retrievalConnection ?? null,
    retrievalPersonal: input.settings.retrievalPersonal ?? null,
    personal,
    indexed: stats.indexed,
    missing: stats.missing,
    failed: stats.failed,
    cache: { vectors: stats.cachedVectors, bytes: stats.cachedBytes },
    recallP95Ms: input.times?.p95() ?? null,
    recalls: input.times?.count ?? 0,
    ...(input.spend === undefined ? {} : { spend: input.spend }),
  };
}
