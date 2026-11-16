import {
  MEMORY_PROVIDER_LIMITS,
  MemoryProviderError,
  memoryCardTitleOf,
  memoryScopeKey,
  type InvocationContext,
  type MemoryActor,
  type MemoryCaptureMessage,
  type MemoryCaptureRequest,
  type MemoryProviderModelHost,
  type MemoryRecord,
  type MemoryScope,
  type MemoryServicePort,
  type ModelPort,
  type ModelTarget,
} from "@tavi/contracts";

import { retrievalKeywordsFrom } from "../context/retrieval-query.js";

/**
 * What a background memory job hands its provider, shared by the idle review, the epoch flush and the tidy-up: a
 * deadline the provider cannot hold past, one metered model call, and the titles it is told are kept.
 */

/** `work`, or a rejection with the signal's reason once it aborts: a provider never holds the review past its deadline. */
export async function withinSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // Whatever the provider's work comes to after the deadline is nobody's to handle: it must not surface as unhandled.
  work.catch(() => undefined);
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("the review was stopped");
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("the review was stopped"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * The model host a background memory job hands its provider: one
 * metered `extraction` call on `target`, its answer capped at
 * `maxOutputTokens`, under an attempt id starting with `attemptPrefix`,
 * keeping no copy of its request. A second call throws `budget`.
 */
export function meteredMemoryHost(input: {
  readonly models: ModelPort;
  readonly target: ModelTarget;
  readonly context: InvocationContext;
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
  readonly signal: AbortSignal;
  readonly attemptPrefix: string;
  readonly attemptNumber: number;
  readonly maxOutputTokens: number;
  /** The call, as its error names it when it does not complete. */
  readonly what: string;
  /** The ledger's site for the call. */
  readonly site: "memory-review" | "consolidation" | "epoch-flush";
  /** What the ledger counts the call as: `extraction`, or the flush's `summary` (it shares the fold's). */
  readonly purpose?: "extraction" | "summary";
}): MemoryProviderModelHost {
  let called = false;
  return Object.freeze({
    complete: async (request: Parameters<MemoryProviderModelHost["complete"]>[0]) => {
      // One metered call a run: a second would go past the run's bound.
      if (called) throw new MemoryProviderError("budget");
      called = true;
      const attemptId = `${input.attemptPrefix}${input.newId("attempt")}`;
      const outcome = await input.models.stream(
        {
          connectionId: input.target.connectionId,
          model: input.target.model,
          runId: input.context.runId,
          attemptId,
          purpose: input.purpose ?? "extraction",
          attemptNumber: input.attemptNumber,
          maxOutputTokens: Math.min(request.maxOutputTokens, input.maxOutputTokens),
          // A provider's capture or tidy-up drafts: short JSON, which a reasoning model need not think at length for.
          reasoningEffort: "low",
          messages: [
            ...(request.instructions === undefined
              ? []
              : [{ id: `${attemptId}-system`, role: "system" as const, text: request.instructions, createdAt: input.now() }]),
            { id: `${attemptId}-input`, role: "user", text: request.prompt, createdAt: input.now() },
          ],
          tools: [],
        },
        // Memory text: the call keeps no copy of its request.
        { signal: input.signal, onEvent: () => {}, context: input.context, keepRequest: false, site: input.site },
      );
      if (outcome.status !== "completed") throw new Error(outcome.error?.message ?? `${input.what} did not complete`);
      return { text: outcome.text, usage: outcome.usage };
    },
  });
}

/**
 * What a capture is told is already kept (`MemoryCaptureRequest.known`):
 * up to `MEMORY_PROVIDER_LIMITS.known` approved or pending records (approved
 * and non-local-origin only when `external`) in the scopes it reads — matching
 * the span's keywords first, then newest first — never a sensitive record's,
 * falling back to `memoryCardTitleOf` when a revision has no explicit title.
 * A dedup and update hint only: the host validates and dedups again when it
 * files. A failed read knows nothing.
 */
export async function knownTitles(
  memory: Partial<Pick<MemoryServicePort, "list" | "history" | "search" | "get">>,
  actor: MemoryActor,
  knows: { readonly personal: boolean; readonly chat: boolean },
  external: boolean,
  span?: readonly Pick<MemoryCaptureMessage, "role" | "text">[],
): Promise<MemoryCaptureRequest["known"]> {
  const { list, history, search, get } = memory;
  if (list === undefined || history === undefined || actor.runId === undefined) return [];
  try {
    const scopes: MemoryScope[] = [
      ...(knows.personal
        ? [
            { kind: "personal" as const, principalId: actor.principalId },
            { kind: "personal_workspace" as const, principalId: actor.principalId, workspaceId: actor.workspaceId },
            ...(actor.agentId === undefined
              ? []
              : [
                  {
                    kind: "personal_agent" as const,
                    principalId: actor.principalId,
                    workspaceId: actor.workspaceId,
                    agentId: actor.agentId,
                  },
                  { kind: "personal_agent" as const, principalId: actor.principalId, agentId: actor.agentId },
                ]),
          ]
        : []),
      ...(knows.chat
        ? [{ kind: "run_local" as const, principalId: actor.principalId, workspaceId: actor.workspaceId, runId: actor.runId }]
        : []),
    ];
    if (scopes.length === 0) return [];
    const allowedScopeKeys = new Set(scopes.map(memoryScopeKey));
    const eligible = (record: MemoryRecord): boolean =>
      record.sensitivity !== "sensitive" &&
      record.currentRevisionId !== undefined &&
      (!external || (record.status === "approved" && record.localOrigin !== true));
    const searched: MemoryRecord[] = [];
    if (span !== undefined && span.length > 0 && search !== undefined && get !== undefined) {
      const keywords = retrievalKeywordsFrom(
        [...span]
          .reverse()
          .map((message) => message.text)
          .join("\n"),
      );
      if (keywords.length > 0) {
        const result = await Promise.resolve(
          search.call(memory, {
            actor,
            query: keywords.join(" "),
            match: "any",
            limit: MEMORY_PROVIDER_LIMITS.known,
            ...(external ? { excludeLocalOrigin: true } : {}),
          }),
        ).catch(() => ({ hits: [] }));
        const found = await Promise.all(
          result.hits.map(async (hit) => await Promise.resolve(get.call(memory, { actor, recordId: hit.recordId })).catch(() => undefined)),
        );
        for (const record of found) {
          if (record !== undefined && allowedScopeKeys.has(record.scopeKey) && eligible(record)) {
            searched.push(record);
          }
        }
      }
    }
    const listed = (
      await Promise.all(
        scopes.map(
          async (scope) =>
            await list.call(memory, {
              actor,
              scope,
              statuses: external ? ["approved"] : ["approved", "proposed"],
              limit: MEMORY_PROVIDER_LIMITS.known,
            }),
        ),
      )
    )
      .flat()
      .filter(eligible)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    const seen = new Set<string>();
    const records: MemoryRecord[] = [];
    for (const record of [...searched, ...listed]) {
      if (seen.has(record.recordId)) continue;
      seen.add(record.recordId);
      records.push(record);
      if (records.length >= MEMORY_PROVIDER_LIMITS.known) break;
    }
    const known = await Promise.all(
      records.map(async (record) => {
        const { revisions } = await history.call(memory, { actor, recordId: record.recordId });
        const revision = revisions.find((entry) => entry.revisionId === record.currentRevisionId);
        const title = revision === undefined ? null : memoryCardTitleOf(revision);
        return title === null
          ? undefined
          : Object.freeze({
              recordId: record.recordId,
              kind: record.kind,
              title: title.slice(0, MEMORY_PROVIDER_LIMITS.title),
              ...(record.kind === "fact" && record.topicKey !== undefined ? { topicKey: record.topicKey } : {}),
            });
      }),
    );
    return known.filter((entry) => entry !== undefined);
  } catch {
    return [];
  }
}
