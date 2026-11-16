import { describe, expect, it } from "vitest";
import { settlesWithin } from "../conformance/settles.js";

import {
  ConsolidationDraftSchema,
  MEMORY_PROVIDER_LIMITS,
  type MemoryCaptureRequest,
  type MemoryConsolidateRequest,
  type MemoryDraft,
  type MemoryKind,
  type MemoryProvider,
  type MemoryRecallRequest,
  type MemoryRecallResult,
  type MemorySnapshot,
} from "@tavi/contracts";

/**
 * The conformance suite every memory provider passes (docs/MEMORY.md
 * invariant 15) — the built-in `tavi.memoryprovider`
 * and any plugin with `provides: ["memory"]`. It holds a provider to what the
 * host relies on: answers within the contract's bounds; ids only, never
 * text, and only ids it was given; tidy-up drafts that name only
 * records it was given; removals honoured; a stop when its signal aborts; a sensible answer when it holds no records; the same ranking for
 * the same index; and its secrets kept out of its errors. The shapes are the
 * contract's (`@tavi/contracts`, `MEMORY_PROVIDER_ABI`).
 *
 * Test-only: it imports vitest, so it is exported for tests and never built.
 */

/** A provider as far as this suite exercises it: the whole contract, consolidation included. */
export type MemoryProviderUnderTest = MemoryProvider;

/** The contract's `MEMORY_PROVIDER_LIMITS`, as far as this suite holds a provider to them. */
export const MEMORY_PROVIDER_KIT_LIMITS = {
  hits: MEMORY_PROVIDER_LIMITS.hits,
  draftsPerCapture: MEMORY_PROVIDER_LIMITS.draftsPerCapture,
  draftsPerConsolidation: MEMORY_PROVIDER_LIMITS.draftsPerConsolidation,
  title: MEMORY_PROVIDER_LIMITS.title,
  body: MEMORY_PROVIDER_LIMITS.body,
} as const;

export interface MemoryProviderConformanceOptions {
  /** `own`: it keeps an index through `sync`. `host`: it ranks the `candidates` it is given (the manifest's `index`). */
  readonly index: "own" | "host";
  /** Secrets the provider holds (keys, tokens): none may appear in its answers, status or errors. */
  readonly secrets?: readonly string[];
}

const AT = "2026-10-11T09:00:00.000Z";
const SCOPE = "personal|p=alice";
const snapshot = (n: number, kind: MemoryKind, body: string, title?: string): MemorySnapshot =>
  Object.freeze({
    recordId: `mem-${n}`,
    revisionId: `rev-${n}`,
    scopeKey: SCOPE,
    kind,
    body,
    recordedAt: AT,
    ...(title === undefined ? {} : { title }),
  });
/** The fixed index every case reads: text that names no id, so text in an answer is plainly text. */
const RECORDS: readonly MemorySnapshot[] = Object.freeze([
  snapshot(1, "fact", "Alice keeps a vegetable garden behind the house", "Garden"),
  snapshot(2, "fact", "Alice moved to Lisbon last spring"),
  snapshot(3, "preference", "Alice prefers green tea in the afternoon"),
  snapshot(4, "lesson", "Lead with the answer, then the garden details"),
]);

/** The host's own lexical search over `records`: ids only, the more terms matched the higher. */
function hostLexical(records: readonly MemorySnapshot[]): MemoryRecallRequest["host"]["lexical"] {
  return async (query, limit) => {
    const terms = query
      .toLowerCase()
      .split(/\W+/)
      .filter((term) => term.length > 0);
    return records
      .map((record) => ({
        recordId: record.recordId,
        revisionId: record.revisionId,
        score: terms.filter((term) => record.body.toLowerCase().includes(term)).length,
      }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.recordId.localeCompare(right.recordId))
      .slice(0, limit);
  };
}

interface Given {
  readonly provider: MemoryProviderUnderTest;
  /** A recall over what the provider holds: its synced index, or these as candidates. */
  readonly recall: (
    query: string,
    options?: { readonly limit?: number; readonly signal?: AbortSignal; readonly lexical?: MemoryRecallRequest["host"]["lexical"] },
  ) => Promise<MemoryRecallResult>;
  /** What it was given, by id. */
  readonly holds: () => ReadonlyMap<string, MemorySnapshot>;
  /** Take a record away: a removal to an own index, or out of the candidates. */
  readonly remove: (recordId: string) => Promise<void>;
}

/** The provider, given `records`: synced fully to an own index, or held as the host's candidates. */
async function given(
  subject: () => MemoryProviderUnderTest | Promise<MemoryProviderUnderTest>,
  options: MemoryProviderConformanceOptions,
  records: readonly MemorySnapshot[],
): Promise<Given> {
  const provider = await subject();
  const held = new Map(records.map((record) => [record.recordId, record]));
  if (options.index === "own") {
    expect(provider.sync, 'an index: "own" provider keeps its index through sync').toBeTypeOf("function");
    await provider.sync?.(Object.freeze({ upserts: Object.freeze([...records]), removals: Object.freeze([]), full: true }));
  }
  return {
    provider,
    holds: () => held,
    remove: async (recordId) => {
      held.delete(recordId);
      if (options.index === "own")
        await provider.sync?.(
          Object.freeze({
            upserts: Object.freeze([]),
            removals: Object.freeze([Object.freeze({ recordId, reason: "forgotten" as const })]),
          }),
        );
    },
    recall: async (query, recallOptions = {}) =>
      await provider.recall(
        Object.freeze({
          query,
          purpose: "turn" as const,
          scopeKeys: Object.freeze([SCOPE]),
          ...(options.index === "host" ? { candidates: Object.freeze([...held.values()]) } : {}),
          limit: recallOptions.limit ?? 10,
          host: Object.freeze({ lexical: recallOptions.lexical ?? hostLexical([...held.values()]) }),
          signal: recallOptions.signal ?? new AbortController().signal,
        }),
      ),
  };
}

/** Read the answer once as plain JSON, as the host does, and hold it to the contract. */
function expectValidRecall(answer: MemoryRecallResult, limit: number, held: ReadonlyMap<string, MemorySnapshot>): void {
  const raw = JSON.parse(JSON.stringify(answer)) as { hits?: unknown; coverage?: unknown };
  expect(Array.isArray(raw.hits), "hits is a list").toBe(true);
  const hits = raw.hits as Record<string, unknown>[];
  expect(hits.length).toBeLessThanOrEqual(Math.min(limit, MEMORY_PROVIDER_KIT_LIMITS.hits));
  if (raw.coverage !== undefined) expect(["complete", "partial"]).toContain(raw.coverage);
  const seen = new Set<string>();
  for (const hit of hits) {
    // Ids and a score, never text: the host renders from its own rows.
    expect(Object.keys(hit).sort(), JSON.stringify(hit)).toEqual(["recordId", "revisionId", "score"]);
    expect(Number.isFinite(hit["score"]), JSON.stringify(hit)).toBe(true);
    const record = held.get(String(hit["recordId"]));
    expect(record, `${String(hit["recordId"])} is a record it was given`).toBeDefined();
    expect(hit["revisionId"], "the revision it was given").toBe(record?.revisionId);
    expect(seen.has(String(hit["recordId"])), "each record once").toBe(false);
    seen.add(String(hit["recordId"]));
  }
  const text = JSON.stringify(raw);
  for (const record of RECORDS) expect(text).not.toContain(record.body);
}

interface ProviderCase {
  readonly title: string;
  readonly run: (
    subject: () => MemoryProviderUnderTest | Promise<MemoryProviderUnderTest>,
    options: MemoryProviderConformanceOptions,
  ) => Promise<void>;
}

const PROVIDER_CASES: readonly ProviderCase[] = [
  {
    title: "answers ranked ids within the bounds, only of records it was given, never their text",
    run: async (subject, options) => {
      const subjectGiven = await given(subject, options, RECORDS);
      for (const [query, limit] of [
        ["garden", 10],
        ["Alice garden Lisbon tea", 2],
        ["answer details", 1],
      ] as const) {
        expectValidRecall(await subjectGiven.recall(query, { limit }), limit, subjectGiven.holds());
      }
    },
  },
  {
    title: "honours a removal: a removed record is never answered again",
    run: async (subject, options) => {
      const subjectGiven = await given(subject, options, RECORDS);
      await subjectGiven.remove("mem-1");
      for (const query of ["garden", "vegetable garden behind the house", "Alice"]) {
        const answer = await subjectGiven.recall(query, { limit: 10 });
        expect(
          answer.hits.map((hit) => hit.recordId),
          query,
        ).not.toContain("mem-1");
        expectValidRecall(answer, 10, subjectGiven.holds());
      }
      const status = subjectGiven.provider.status?.();
      if (options.index === "own" && status?.indexed !== undefined) expect(status.indexed).toBe(RECORDS.length - 1);
    },
  },
  {
    title: "answers sensibly when it holds no records",
    run: async (subject, options) => {
      const empty = await given(subject, options, []);
      const answer = await empty.recall("garden", { lexical: async () => [] });
      expectValidRecall(answer, 10, empty.holds());
      expect(answer.hits).toEqual([]);
    },
  },
  {
    title: "a full sync drops what it does not carry",
    run: async (subject, options) => {
      if (options.index === "host") return;
      const subjectGiven = await given(subject, options, RECORDS);
      await subjectGiven.provider.sync?.(
        Object.freeze({ upserts: Object.freeze([RECORDS[1] as MemorySnapshot]), removals: Object.freeze([]), full: true }),
      );
      const answer = await subjectGiven.recall("Alice garden Lisbon tea", { limit: 10, lexical: async () => [] });
      expectValidRecall(answer, 10, new Map([["mem-2", RECORDS[1] as MemorySnapshot]]));
    },
  },
  {
    title: "stops when its signal aborts",
    run: async (subject, options) => {
      const subjectGiven = await given(subject, options, RECORDS);
      const controller = new AbortController();
      controller.abort(new Error("the recall ran past its deadline"));
      await settlesWithin(subjectGiven.recall("garden", { signal: controller.signal }), 1_000);
      if (subjectGiven.provider.capture !== undefined)
        await settlesWithin(subjectGiven.provider.capture(captureRequest(controller.signal)), 1_000);
      if (subjectGiven.provider.consolidate !== undefined)
        await settlesWithin(subjectGiven.provider.consolidate(consolidateRequest(controller.signal)), 1_000);
    },
  },
  {
    title: "ranks the same index the same way every time",
    run: async (subject, options) => {
      const subjectGiven = await given(subject, options, RECORDS);
      const first = await subjectGiven.recall("Alice garden tea", { limit: 10 });
      const second = await subjectGiven.recall("Alice garden tea", { limit: 10 });
      expect(second.hits).toEqual(first.hits);
      const again = await given(subject, options, RECORDS);
      expect((await again.recall("Alice garden tea", { limit: 10 })).hits.map((hit) => hit.recordId)).toEqual(
        first.hits.map((hit) => hit.recordId),
      );
    },
  },
  {
    title: "keeps its secrets out of its answers, its status and its errors",
    run: async (subject, options) => {
      const secrets = options.secrets ?? [];
      const subjectGiven = await given(subject, options, RECORDS);
      let text = JSON.stringify(await subjectGiven.recall("garden")) + JSON.stringify(subjectGiven.provider.status?.() ?? {});
      try {
        text += JSON.stringify(
          await subjectGiven.recall("garden", {
            lexical: async () => {
              throw new Error("the host's search failed");
            },
          }),
        );
      } catch (error) {
        text += error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      }
      for (const secret of secrets) expect(text).not.toContain(secret);
    },
  },
  {
    title: "drafts proposals within the bounds, when it captures",
    run: async (subject) => {
      const provider = await subject();
      if (provider.capture === undefined) return;
      const request = captureRequest(new AbortController().signal);
      const knownFacts = new Set(request.known.filter((entry) => entry.kind === "fact").map((entry) => entry.recordId));
      const answer = JSON.parse(JSON.stringify(await provider.capture(request))) as {
        proposals?: unknown;
      };
      expect(Array.isArray(answer.proposals)).toBe(true);
      const drafts = answer.proposals as MemoryDraft[];
      expect(drafts.length).toBeLessThanOrEqual(MEMORY_PROVIDER_KIT_LIMITS.draftsPerCapture);
      for (const draft of drafts) {
        expect(["preference", "fact", "lesson"]).toContain(draft.kind);
        expect(["everywhere", "chat"]).toContain(draft.scope);
        expect(draft.title?.length ?? 0).toBeLessThanOrEqual(MEMORY_PROVIDER_KIT_LIMITS.title);
        expect(draft.body.length).toBeLessThanOrEqual(MEMORY_PROVIDER_KIT_LIMITS.body);
        if (draft.updatesRecordId !== undefined) {
          expect(draft.kind).toBe("fact");
          expect(knownFacts.has(draft.updatesRecordId), `${draft.updatesRecordId} is a known fact it was given`).toBe(true);
        }
      }
    },
  },
  {
    title: "drafts tidy-ups within the bounds, naming only records it was given, when it consolidates",
    run: async (subject) => {
      const provider = await subject();
      if (provider.consolidate === undefined) return;
      const given = new Map(TIDY_RECORDS.map((record) => [record.recordId, record]));
      const answer = JSON.parse(JSON.stringify(await provider.consolidate(consolidateRequest(new AbortController().signal)))) as {
        drafts?: unknown;
      };
      expect(Array.isArray(answer.drafts)).toBe(true);
      const drafts = answer.drafts as unknown[];
      expect(drafts.length).toBeLessThanOrEqual(MEMORY_PROVIDER_KIT_LIMITS.draftsPerConsolidation);
      for (const draft of drafts) {
        const parsed = ConsolidationDraftSchema.safeParse(draft);
        expect(parsed.success, JSON.stringify(draft)).toBe(true);
        if (!parsed.success) continue;
        const named = parsed.data.action === "merge" ? parsed.data.recordIds : [parsed.data.recordId];
        for (const recordId of named) expect(given.has(recordId), `${recordId} is a record it was given`).toBe(true);
        if (parsed.data.action === "merge")
          expect(new Set(named.map((recordId) => given.get(recordId)?.scopeKey)).size, "a merge stays in one scope").toBe(1);
      }
    },
  },
];

/** The records a consolidation is given: facts and lessons only, as the host gives them. */
const TIDY_RECORDS: readonly MemorySnapshot[] = Object.freeze(RECORDS.filter((record) => record.kind !== "preference"));

function consolidateRequest(signal: AbortSignal): MemoryConsolidateRequest {
  // The model's answer, in the built-in's shape: one merge of the two facts, one supersede of an unknown handle.
  const text = JSON.stringify({
    tidy: [
      { action: "merge", ids: ["m1", "m2"], body: "Alice keeps a garden in Lisbon", reason: "same home" },
      { action: "supersede", id: "m99", body: "Invented", reason: "x" },
    ],
  });
  return Object.freeze({
    records: TIDY_RECORDS,
    now: AT,
    today: AT.slice(0, 10),
    limits: Object.freeze({ maxDrafts: MEMORY_PROVIDER_KIT_LIMITS.draftsPerConsolidation }),
    host: Object.freeze({ complete: async () => Object.freeze({ text, usage: Object.freeze({ inputTokens: 0, outputTokens: 0 }) }) }),
    signal,
  });
}

function captureRequest(signal: AbortSignal): MemoryCaptureRequest {
  const text = JSON.stringify({
    memories: [
      { kind: "fact", title: "Home city", body: "Moved to Porto last week.", scope: "everywhere", topicKey: "me.home_city", updates: "k1" },
    ],
  });
  return Object.freeze({
    span: Object.freeze([
      Object.freeze({
        role: "person" as const,
        text: "I moved to Porto last week, and I'd like replies in Portuguese from now on",
        at: AT,
      }),
      Object.freeze({ role: "assistant" as const, text: "Noted: Porto, and replies in Portuguese.", at: AT }),
    ]),
    today: AT.slice(0, 10),
    known: Object.freeze([Object.freeze({ recordId: "mem-2", kind: "fact" as const, title: "Moved to Lisbon", topicKey: "me.home_city" })]),
    limits: Object.freeze({ maxProposals: MEMORY_PROVIDER_KIT_LIMITS.draftsPerCapture, bodyChars: MEMORY_PROVIDER_KIT_LIMITS.body }),
    policy: Object.freeze({ sensitive: "skip" as const }),
    host: Object.freeze({ complete: async () => Object.freeze({ text, usage: Object.freeze({ inputTokens: 0, outputTokens: 0 }) }) }),
    signal,
  });
}

/** Every provider case's title, as the suite names them. */
export function memoryProviderConformanceCases(): readonly string[] {
  return PROVIDER_CASES.map((entry) => entry.title);
}

/** One provider case by title: how a kit's tests show a broken provider fails the case naming its fault. */
export async function runMemoryProviderConformanceCase(
  title: string,
  subject: () => MemoryProviderUnderTest | Promise<MemoryProviderUnderTest>,
  options: MemoryProviderConformanceOptions,
): Promise<void> {
  const entry = PROVIDER_CASES.find((candidate) => candidate.title === title);
  if (entry === undefined) throw new Error(`No memory provider conformance case is titled ${JSON.stringify(title)}`);
  await entry.run(subject, options);
}

/** The provider suite: `subject` builds a fresh provider per case. */
export function describeMemoryProviderConformance(
  name: string,
  subject: () => MemoryProviderUnderTest | Promise<MemoryProviderUnderTest>,
  options: MemoryProviderConformanceOptions,
): void {
  describe(`memory provider conformance: ${name}`, () => {
    for (const entry of PROVIDER_CASES) it(entry.title, async () => await entry.run(subject, options));
  });
}
