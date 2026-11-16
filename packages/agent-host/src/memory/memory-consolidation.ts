import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MEMORY_PROVIDER_LIMITS,
  consolidationDraftsFrom,
  memoryEndDate,
  resolveMemoryValidUntil,
  type ConsolidationDraft,
  type InvocationContext,
  type MemoryActor,
  type MemoryKind,
  type MemoryProvider,
  type MemoryScope,
  type MemorySensitiveMode,
  type MemoryServicePort,
  type MemorySnapshot,
  type ModelPort,
  type ModelTarget,
} from "@tavi/contracts";
import { definedOnly } from "@tavi/contracts/util";

import { localCaptureDate } from "./epoch-flush.js";
import { fileCapturedDraft, NO_CAPTURE_DROPS, type CaptureDropCounts } from "./memory-capture.js";
import { meteredMemoryHost, withinSignal } from "./provider-host.js";

/**
 * Consolidation: the workspace's memory provider reads one person's kept
 * records and drafts tidy-ups, which the host files as proposals a person
 * decides — never auto-approved, and nothing changed until one is approved
 * (memory invariant 8). The pure half lives here; the weekly run on the
 * `tavi.memory` tick that picks the person, the records, the model and the
 * marks is `apps/cli/src/features/memory/consolidation.ts`.
 *
 * **Drafts become proposals** under author `provider:<id>:consolidate`, each
 * naming what it supersedes at the revision it was drafted from (`supersedes`,
 * written as `contains` lineage edges):
 *  - **merge**: a new record of the inputs' scope and kind, superseding each;
 *  - **supersede**: a correction, filed the same way — a new record
 *    superseding the one it corrects, so it is decided as one card;
 *  - **expire**: the record's own words with an end date, mapped by kind
 *    (a fact's `validTo`, a lesson's `expiryAt`), superseding it.
 *
 * **Validation.** Each draft is held to `ConsolidationDraftSchema`; its ids
 * must be among the records given, no record is named twice in one run, a
 * merge's inputs share a scope and kind with its replacement, and a date is
 * future and at most five years ahead. Then the capture pipeline: a secret
 * drops it, a sensitive one follows the `sensitive` setting, and exact dedup
 * answers a tidy-up already waiting (never one of its own inputs).
 */

/** At most this many drafts a run files. */
export const MEMORY_CONSOLIDATION_MAX_DRAFTS = MEMORY_PROVIDER_LIMITS.draftsPerConsolidation;
/** A run's answer, its time and the records it reads, at most. */
const MEMORY_CONSOLIDATION_MAX_OUTPUT_TOKENS = MEMORY_PROVIDER_LIMITS.consolidateOutputTokens;
const MEMORY_CONSOLIDATION_TIMEOUT_MS = MEMORY_PROVIDER_LIMITS.consolidateMs;
export const MEMORY_CONSOLIDATION_RECORDS_MAX = MEMORY_PROVIDER_LIMITS.consolidateRecords;
/** Every consolidation call's attempt id starts with this: doctor's spend line reads them by it. */
export const MEMORY_CONSOLIDATION_ATTEMPT_PREFIX = "memory-consolidate-";
/** Transport metadata, distinct from a turn's attempts, the summary's, the flush's and the review's. */
const MEMORY_CONSOLIDATION_ATTEMPT_NUMBER = 1_000_003;

/** Whose consolidation filed a proposal: `provider:<id>:consolidate`, the built-in's under its own id. */
export function memoryConsolidateCaller(providerId: string | undefined): string {
  return `provider:${providerId ?? BUILTIN_MEMORY_PROVIDER_ID}:consolidate`;
}

/** Whether a proposal's author is a consolidation's: never auto-approved (invariant 2). */
export function isConsolidationAuthor(author: string): boolean {
  return /^provider:[^:]+:consolidate$/.test(author);
}

/** One record a consolidation reads: the snapshot the provider is given, and what the host files by. */
export interface ConsolidationRecord {
  readonly snapshot: MemorySnapshot;
  readonly scope: MemoryScope;
  readonly topicKey?: string;
}

/** What a run dropped, by reason (counts only): the capture pipeline's, and drafts that failed validation. */
export interface ConsolidationDropCounts extends CaptureDropCounts {
  readonly invalid: number;
}

interface MemoryConsolidationInput {
  readonly models: ModelPort;
  readonly memory: Pick<MemoryServicePort, "propose">;
  readonly provider: Pick<MemoryProvider, "consolidate">;
  /** Its id, which authors what it drafts (`memoryConsolidateCaller`); absent, the built-in's. */
  readonly providerId?: string;
  /** The model the call runs on: the `extraction` role, else the workspace's default (chosen by the caller). */
  readonly target: ModelTarget;
  /** The person and workspace: `principalId` is whose memory, `runId` the chat that holds the run's mark (the ledger's run). */
  readonly context: InvocationContext;
  /** At most `MEMORY_CONSOLIDATION_RECORDS_MAX`, batched by the caller. */
  readonly records: readonly ConsolidationRecord[];
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
  readonly timeZone?: string;
  readonly sensitive?: MemorySensitiveMode;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Called once the provider answered, before any draft is filed: the run's
   * mark is claimed here, so a week is consolidated at most once across
   * restarts. False (already claimed) files nothing.
   */
  readonly claim?: () => Promise<boolean>;
}

export interface MemoryConsolidationResult {
  /** The proposals filed, by record id. */
  readonly recordIds: readonly string[];
  /** Drafts the provider answered, before validation. */
  readonly drafts: number;
  readonly dropped: ConsolidationDropCounts;
  readonly claimed: boolean;
}

/** A draft as the propose call it becomes, or why it is not one. */
type Planned =
  | {
      readonly ok: true;
      readonly propose: Omit<Parameters<MemoryServicePort["propose"]>[0], "nearMatch" | "actor">;
      readonly scope: MemoryScope;
    }
  | { readonly ok: false };

/**
 * One consolidation: the provider's `consolidate` over the records, with one
 * bounded model call it may make (`host.complete`, on `target`, keeping no
 * copy of its request), then each draft validated and filed as a
 * proposal by its author. Throws when the call or the provider fails or does
 * not complete in time. `claim` runs between the answer and the filing.
 */
export async function runMemoryConsolidation(input: MemoryConsolidationInput): Promise<MemoryConsolidationResult> {
  const { context } = input;
  const none = { ...NO_CAPTURE_DROPS, invalid: 0 };
  if (input.records.length === 0)
    return { recordIds: [], drafts: 0, dropped: none, claimed: input.claim === undefined ? true : await input.claim() };
  const consolidate = input.provider.consolidate?.bind(input.provider);
  if (consolidate === undefined) throw new Error("the memory provider drafts no tidy-ups");
  const timeout = AbortSignal.timeout(input.timeoutMs ?? MEMORY_CONSOLIDATION_TIMEOUT_MS);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  const host = meteredMemoryHost({
    models: input.models,
    target: input.target,
    context,
    newId: input.newId,
    now: input.now,
    signal,
    attemptPrefix: MEMORY_CONSOLIDATION_ATTEMPT_PREFIX,
    attemptNumber: MEMORY_CONSOLIDATION_ATTEMPT_NUMBER,
    maxOutputTokens: MEMORY_CONSOLIDATION_MAX_OUTPUT_TOKENS,
    what: "the consolidation call",
    site: "consolidation",
  });
  const records = input.records.slice(0, MEMORY_CONSOLIDATION_RECORDS_MAX);
  const answer = await withinSignal(
    consolidate(
      Object.freeze({
        records: Object.freeze(records.map((record) => Object.freeze({ ...record.snapshot }))),
        now: input.now(),
        today: localCaptureDate(input.now(), input.timeZone),
        limits: Object.freeze({ maxDrafts: MEMORY_CONSOLIDATION_MAX_DRAFTS }),
        host,
        signal,
      }),
    ),
    signal,
  );
  const drafts = consolidationDraftsFrom(answer, MEMORY_CONSOLIDATION_MAX_DRAFTS);
  if (input.claim !== undefined && !(await input.claim())) return { recordIds: [], drafts: drafts.length, dropped: none, claimed: false };
  const byId = new Map(records.map((record) => [record.snapshot.recordId, record]));
  const named = new Set<string>();
  const dropped = { ...none };
  const recordIds: string[] = [];
  const caller = memoryConsolidateCaller(input.providerId);
  for (const draft of drafts) {
    const planned = planDraft(draft, byId, named, input.now(), input.timeZone);
    if (!planned.ok) {
      dropped.invalid += 1;
      continue;
    }
    const actor: MemoryActor = {
      principalId: context.principalId,
      workspaceId: context.workspaceId,
      caller,
      authority: "model",
      // The service reads and writes an agent scope only as that agent.
      ...(planned.scope.kind === "personal_agent" ? { agentId: planned.scope.agentId } : {}),
    };
    try {
      const outcome = await fileCapturedDraft(input.memory, { ...planned.propose, actor }, input.sensitive, { nearMatch: false });
      if (outcome.filed) recordIds.push(outcome.record.recordId);
      else dropped[outcome.dropped] += 1;
    } catch {
      // A proposal the service refuses (an input changed meanwhile, a bound, a quota) is skipped; the rest still go.
      dropped.invalid += 1;
    }
  }
  return { recordIds, drafts: drafts.length, dropped, claimed: true };
}

/**
 * A draft as the proposal it becomes (see the module comment), or not one:
 * an id it was not given, a record already named this run, inputs of
 * different scopes or kinds, a replacement of another kind, or a date past,
 * unreadable or more than five years ahead.
 */
function planDraft(
  draft: ConsolidationDraft,
  byId: ReadonlyMap<string, ConsolidationRecord>,
  named: Set<string>,
  now: string,
  timeZone: string | undefined,
): Planned {
  const ids = draft.action === "merge" ? draft.recordIds : [draft.recordId];
  const inputs = ids.map((recordId) => byId.get(recordId));
  if (inputs.some((record) => record === undefined || named.has(record.snapshot.recordId))) return { ok: false };
  const records = inputs as ConsolidationRecord[];
  const [first] = records;
  if (first === undefined) return { ok: false };
  const kind: MemoryKind = first.snapshot.kind;
  if (records.some((record) => record.snapshot.scopeKey !== first.snapshot.scopeKey || record.snapshot.kind !== kind)) return { ok: false };
  const until = draft.action === "expire" ? draft.validUntil : draft.replacement.validUntil;
  let endDate: { readonly validTo: string } | { readonly expiryAt: string } | undefined;
  if (until !== undefined) {
    const resolved = resolveMemoryValidUntil(until, now, timeZone);
    if (!resolved.ok) return { ok: false };
    endDate = memoryEndDate(kind, resolved.at);
  }
  // A topic key every input shares stays: the replacement is about the same thing.
  const topicKey = records.every((record) => record.topicKey !== undefined && record.topicKey === first.topicKey)
    ? first.topicKey
    : undefined;
  const supersedes = records.map((record) => ({ recordId: record.snapshot.recordId, revisionId: record.snapshot.revisionId }));
  let content: { readonly title?: string; readonly body: string; readonly sensitive?: boolean; readonly keywords?: readonly string[] };
  if (draft.action === "expire") {
    if (endDate === undefined) return { ok: false };
    content = { ...(first.snapshot.title === undefined ? {} : { title: first.snapshot.title }), body: first.snapshot.body };
  } else {
    // Preferences are never given to a consolidation; a replacement keeps its inputs' kind.
    if (draft.replacement.kind !== kind || draft.replacement.preferenceKey !== undefined) return { ok: false };
    content = {
      ...(draft.replacement.title === undefined ? {} : { title: draft.replacement.title }),
      body: draft.replacement.body,
      ...(draft.replacement.sensitive === true ? { sensitive: true } : {}),
      ...(draft.replacement.keywords === undefined || draft.replacement.keywords.length === 0
        ? {}
        : { keywords: draft.replacement.keywords }),
    };
  }
  for (const record of records) named.add(record.snapshot.recordId);
  return {
    ok: true,
    scope: first.scope,
    propose: {
      scope: first.scope,
      kind,
      body: content.body,
      ...definedOnly({ title: content.title, topicKey, keywords: content.keywords }),
      ...(endDate ?? {}),
      ...(content.sensitive === true ? { sensitivity: "sensitive" as const } : {}),
      supersedes,
    },
  };
}
