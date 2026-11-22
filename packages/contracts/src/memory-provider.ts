import { z } from "zod";

import { IdSchema } from "./ids.js";
import { coreEnglish, type CoreT } from "./locales/core.js";
import { MAX_MEMORY_KEYWORDS, MAX_MEMORY_KEYWORD_CHARS, MAX_PREFERENCE_KEY_CHARS, MEMORY_SEARCH_MAX, type MemoryKind } from "./memory.js";
import type { ModelUsage } from "./model.js";
import { defineProviderError } from "./util.js";

/**
 * The memory provider contract:
 * what ranks memory for recall, drafts proposals from a chat's span, drafts
 * tidy-ups and keeps an index of its own. The host — `MemoryService` and the
 * owner around it — keeps governance: scopes, authority, lifecycle, erasure,
 * egress and rendering. A provider answers ids, never text; the host
 * re-checks every id against the actor's eligibility and renders from its
 * own rows. Its drafts are only proposals: the host validates each one and
 * files it through the capture pipeline, and a person decides.
 *
 * The built-in is `tavi.memoryprovider` (`@tavi/plugin-defaults/memory`); an approved
 * plugin that `provides: ["memory"]` is another. Every one passes
 * `@tavi/plugin-kit/memory/conformance`'s provider suite.
 */

/** The memory contract a provider plugin is built for; another is refused before its code runs. */
export const MEMORY_PROVIDER_ABI = "tavi.memory/1";

/** The built-in provider's id: recall, capture and the fallback when a selected provider is unavailable. */
export const BUILTIN_MEMORY_PROVIDER_ID = "tavi.memoryprovider";

/** The bounds the host holds every provider to. */
export const MEMORY_PROVIDER_LIMITS = {
  /** Hits one recall answers at most (`MEMORY_SEARCH_MAX`). */
  hits: MEMORY_SEARCH_MAX,
  /** Eligible records an `index: "host"` provider is given at most. */
  candidates: 500,
  /** A recall query's characters at most. */
  queryChars: 2_000,
  /** `host.lexical` calls one recall may make at most; past them, the call throws `budget`. */
  lexicalCalls: 3,
  /** Drafts one capture answers at most, and one consolidation. */
  draftsPerCapture: 5,
  draftsPerConsolidation: 20,
  /** A draft's title and body, at most. */
  title: 120,
  body: 1_000,
  /** Write-time keywords on a draft, at most, and each keyword's character bound. */
  keywords: MAX_MEMORY_KEYWORDS,
  keywordChars: MAX_MEMORY_KEYWORD_CHARS,
  /** A capture span's characters at most, as the host renders it. */
  spanChars: 24_000,
  /** Approved or pending titles a capture is given for dedup, at most. */
  known: 50,
  /** How long recall may take on a turn, and anywhere else; past it, the host's own search answers. */
  recallTurnMs: 1_500,
  recallOtherMs: 5_000,
  /** How long one capture may take. */
  captureMs: 30_000,
  /**
   * How long one `sync` may take before the host stops waiting (memory audit
   * 2): past it the batch counts as missed (a forget's row stays pending, any
   * other change leaves the provider stale) and its `signal` aborts, so no
   * forget, approval or tick waits on a provider that never settles.
   */
  syncMs: 10_000,
  /** Records one consolidation reads at most, its answer's tokens and how long it may take. */
  consolidateRecords: 500,
  consolidateOutputTokens: 2_000,
  consolidateMs: 60_000,
  /** Records one merge draft names at most (`MEMORY_SUPERSEDES_MAX`), and a reason's characters. */
  mergeRecords: 20,
  reason: 300,
} as const;

/** What a provider may do; `recall` is required. */
export const MEMORY_PROVIDER_CAPABILITIES = ["recall", "capture", "consolidate"] as const;
export type MemoryProviderCapability = (typeof MEMORY_PROVIDER_CAPABILITIES)[number];

/** What an external provider may receive, each only when also switched on per workspace. */
export const MEMORY_PROVIDER_RECEIVES = ["records", "conversation"] as const;
export type MemoryProviderReceive = (typeof MEMORY_PROVIDER_RECEIVES)[number];

/** Why a provider's call failed, as it throws it (`MemoryProviderError`). */
export const MEMORY_PROVIDER_FAILURES = ["transport", "invalid", "budget"] as const;
export type MemoryProviderFailure = (typeof MEMORY_PROVIDER_FAILURES)[number];

/**
 * A provider's typed failure. The message is the reason alone, so a provider
 * that throws one leaks nothing of its own; the host counts any throw or
 * timeout as `failed:<reason>` and falls back to its own search.
 */
export class MemoryProviderError extends defineProviderError<MemoryProviderFailure>() {}

/** The failure a thrown value carries, whatever class it has; `transport` when it carries none. */
export function memoryProviderFailure(error: unknown): MemoryProviderFailure {
  // A plugin's thrown value may be a Proxy or carry a throwing getter: reading it must not throw.
  try {
    if (error === null || typeof error !== "object" || !("reason" in error)) return "transport";
    const reason = (error as { reason: unknown }).reason;
    return MEMORY_PROVIDER_FAILURES.find((failure) => failure === reason) ?? "transport";
  } catch {
    return "transport";
  }
}

/**
 * An approved, normal-sensitivity record as the host hands it to a provider.
 * An ended fact stays (it is kept, and the host re-filters every hit by date
 * anyway); an expired record is sent as a removal.
 */
export interface MemorySnapshot {
  readonly recordId: string;
  readonly revisionId: string;
  readonly scopeKey: string;
  readonly kind: MemoryKind;
  readonly title?: string;
  readonly body: string;
  readonly observedAt?: string;
  readonly recordedAt: string;
  /** `validTo` or `expiryAt`, whichever is set. */
  readonly validUntil?: string;
}

/** One ranked record: ids and a score, never text. */
export interface RankedId {
  readonly recordId: string;
  readonly revisionId: string;
  readonly score: number;
}

/** One recall, a frozen copy. */
export interface MemoryRecallRequest {
  /**
   * At most `MEMORY_PROVIDER_LIMITS.queryChars`. A turn's: the keywords of
   * its retrieval window (the person's newest message, the one before it,
   * the last answer). A tool's: the model's query. A heartbeat's: the
   * keywords of its instructions or new signals' titles.
   */
  readonly query: string;
  /** The router reranks a turn's result; it never calls recall itself. `heartbeat` reaches only the built-in. */
  readonly purpose: "turn" | "tool" | "heartbeat";
  /** Opaque keys of the scopes this actor may read, for an own index to pre-filter; empty for the built-in. */
  readonly scopeKeys: readonly string[];
  /** Only for an `index: "host"` provider: host-filtered eligible records, at most `MEMORY_PROVIDER_LIMITS.candidates`. */
  readonly candidates?: readonly MemorySnapshot[];
  /** At most `MEMORY_SEARCH_MAX`. */
  readonly limit: number;
  readonly host: {
    /**
     * The host's own ranked search over the actor's eligible records, ids
     * only: bm25 over its index, fused with its vectors' ranks under
     * `retrieval: "hybrid"`, never anything the actor may not read.
     * At most `MEMORY_PROVIDER_LIMITS.lexicalCalls` calls a recall; past
     * them, and once the recall has answered or run late, it throws `budget`.
     */
    lexical(query: string, limit: number): Promise<readonly RankedId[]>;
    /**
     * Not offered yet: the host supplies only `lexical`, and hybrid retrieval
     * stays the host's (the locality rule needs the chat's connection).
     * Typed for when it is: then only under `hybrid`, never for `heartbeat`,
     * and metered. A provider must work without it.
     */
    embed?(texts: readonly string[]): Promise<readonly Float32Array[]>;
  };
  /** Aborted at the recall deadline: `MEMORY_PROVIDER_LIMITS.recallTurnMs` on a turn, `recallOtherMs` otherwise. */
  readonly signal: AbortSignal;
}

export interface MemoryRecallResult {
  readonly hits: readonly RankedId[];
  readonly coverage?: "complete" | "partial";
}

/** One message of a capture span: the person's or the assistant's own words, never tool output or quoted data. */
export interface MemoryCaptureMessage {
  readonly role: "person" | "assistant";
  readonly text: string;
  readonly at: string;
}

/** What a provider drafts: a proposal the host validates and files, never a record. */
export interface MemoryDraft {
  readonly kind: "preference" | "fact" | "lesson";
  /** At most `MEMORY_PROVIDER_LIMITS.title`; absent files the proposal untitled, as a model's draft without one is today. */
  readonly title?: string;
  /** At most `MEMORY_PROVIDER_LIMITS.body`. */
  readonly body: string;
  readonly scope: "everywhere" | "chat";
  /** A preference's key and value: both on a preference, neither on another kind. */
  readonly preferenceKey?: string;
  readonly preferenceValue?: string;
  readonly topicKey?: string;
  /** A kept fact this draft updates (`MemoryCaptureRequest.known`), when the span says it changed. */
  readonly updatesRecordId?: string;
  /** Up to `MEMORY_PROVIDER_LIMITS.keywords` write-time search terms for the word index. */
  readonly keywords?: readonly string[];
  /** An ISO date or date-time in the future; the host maps it by kind and drops a draft whose date is past or no date. */
  readonly validUntil?: string;
  readonly sensitive?: boolean;
  /** Whose words it rests on: a hint. Auto-approve also needs the host's own quote check. */
  readonly from?: "person" | "assistant";
}

/** The model a provider may call, metered by the host on the capture model. */
export interface MemoryProviderModelHost {
  /**
   * One bounded completion. `instructions` goes first, as the call's system
   * text; `prompt` is the input. The host chooses the model, meters the
   * call and keeps no copy of its request.
   */
  complete(input: {
    readonly instructions?: string;
    readonly prompt: string;
    readonly maxOutputTokens: number;
  }): Promise<{ readonly text: string; readonly usage: ModelUsage }>;
}

export interface MemoryCaptureRequest {
  /** Oldest first, at most `MEMORY_PROVIDER_LIMITS.spanChars` as the host renders it (`renderCaptureSpan`). */
  readonly span: readonly MemoryCaptureMessage[];
  /** Today in the person's time zone (YYYY-MM-DD), so a time-bound draft can be given its end date. */
  readonly today: string;
  /** Up to `MEMORY_PROVIDER_LIMITS.known` approved or pending titles in the same scopes, for dedup; the host dedups again. */
  readonly known: readonly {
    readonly recordId: string;
    readonly kind: MemoryKind;
    readonly title: string;
    readonly topicKey?: string;
  }[];
  readonly limits: { readonly maxProposals: number; readonly bodyChars: number };
  readonly policy: { readonly sensitive: "skip" | "suggest" };
  /**
   * What the span is: an idle chat's newest words (`review`, the default), or a span about to be condensed as the
   * chat rolls over into a new epoch (`rollover`, the epoch flush).
   */
  readonly occasion?: "review" | "rollover";
  readonly host: MemoryProviderModelHost;
  /** Aborted at `MEMORY_PROVIDER_LIMITS.captureMs`, or when the owner stops. */
  readonly signal: AbortSignal;
}

export interface MemoryCaptureResult {
  readonly proposals: readonly MemoryDraft[];
}

export interface MemoryConsolidateRequest {
  /**
   * One person's approved, normal-sensitivity facts and lessons in force, at
   * most `MEMORY_PROVIDER_LIMITS.consolidateRecords`, batched by scope, kind
   * and topic (records of one batch sit together). Never a chat's words.
   */
  readonly records: readonly MemorySnapshot[];
  readonly now: string;
  /** Today in the workspace's zone (YYYY-MM-DD), so an `expire` draft can be given its date. */
  readonly today?: string;
  readonly limits: { readonly maxDrafts: number };
  readonly host: MemoryProviderModelHost;
  /** Aborted at `MEMORY_PROVIDER_LIMITS.consolidateMs`, or when the owner stops. */
  readonly signal: AbortSignal;
}

/** A tidy-up the host files as a proposal with lineage. */
export type ConsolidationDraft =
  | { readonly action: "merge"; readonly recordIds: readonly string[]; readonly replacement: MemoryDraft; readonly reason: string }
  | { readonly action: "supersede"; readonly recordId: string; readonly replacement: MemoryDraft; readonly reason: string }
  | { readonly action: "expire"; readonly recordId: string; readonly validUntil: string; readonly reason: string };

export interface MemoryConsolidateResult {
  readonly drafts: readonly ConsolidationDraft[];
}

/** Why a record leaves a provider's index. */
export const MEMORY_REMOVAL_REASONS = ["forgotten", "revoked", "superseded", "expired", "egress-off"] as const;
export type MemoryRemovalReason = (typeof MEMORY_REMOVAL_REASONS)[number];

export interface MemorySyncBatch {
  readonly upserts: readonly MemorySnapshot[];
  /** Must be honoured: a removed record is never answered again. Idempotent, so a resend is harmless. */
  readonly removals: readonly { readonly recordId: string; readonly reason: MemoryRemovalReason }[];
  /** A full resync: drop everything not in `upserts`. */
  readonly full?: boolean;
  /** Aborts when the host stops waiting (`MEMORY_PROVIDER_LIMITS.syncMs`) or the plugin stops: the batch then counts as missed, and is sent again. */
  readonly signal?: AbortSignal;
}

export interface MemoryProviderStatus {
  readonly ready: boolean;
  readonly indexed?: number;
  readonly detail?: string;
}

/** A memory provider: the built-in, or an approved plugin's (`provides: ["memory"]`). */
export interface MemoryProvider {
  recall(request: MemoryRecallRequest): Promise<MemoryRecallResult>;
  /** Drafts from a span; the host files them. */
  capture?(request: MemoryCaptureRequest): Promise<MemoryCaptureResult>;
  /** Tidy-up drafts; the host files them. */
  consolidate?(request: MemoryConsolidateRequest): Promise<MemoryConsolidateResult>;
  /** Keep an index of its own; removals must be honoured. */
  sync?(batch: MemorySyncBatch): Promise<void>;
  status?(): MemoryProviderStatus;
}

/** A recall answer as the host reads it: ids and a finite score only, at most `MEMORY_PROVIDER_LIMITS.hits`. */
export const RankedIdSchema = z.strictObject({
  recordId: IdSchema,
  revisionId: IdSchema,
  score: z.number().finite(),
});
export const MemoryRecallResultSchema = z.strictObject({
  hits: z.array(RankedIdSchema).max(MEMORY_PROVIDER_LIMITS.hits),
  coverage: z.enum(["complete", "partial"]).optional(),
});

/**
 * A draft's keywords, read leniently: they are a search hint, so a bad list
 * never drops the draft. A string is one keyword; a non-string entry, an empty
 * one or one past `keywordChars` is left out, case-folded repeats once; the
 * first `MEMORY_PROVIDER_LIMITS.keywords` are kept. Anything else is none.
 */
const DraftKeywordsSchema = z
  .union([z.string(), z.array(z.unknown())])
  .transform((raw): string[] | undefined => {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const entry of typeof raw === "string" ? [raw] : raw) {
      if (kept.length >= MEMORY_PROVIDER_LIMITS.keywords) break;
      if (typeof entry !== "string") continue;
      const keyword = entry.trim();
      if (keyword === "" || keyword.length > MEMORY_PROVIDER_LIMITS.keywordChars) continue;
      const folded = keyword.toLowerCase();
      if (seen.has(folded)) continue;
      seen.add(folded);
      kept.push(keyword);
    }
    return kept.length === 0 ? undefined : kept;
  })
  .optional()
  .catch(undefined);

/** One draft as the host validates it: bounds and kinds; a draft that fails is dropped, the rest still go. */
export const MemoryDraftSchema = z
  .strictObject({
    kind: z.enum(["preference", "fact", "lesson"]),
    title: z.string().trim().min(1).max(MEMORY_PROVIDER_LIMITS.title).optional(),
    body: z.string().trim().min(1).max(MEMORY_PROVIDER_LIMITS.body),
    scope: z.enum(["everywhere", "chat"]),
    preferenceKey: z.string().trim().min(1).max(MAX_PREFERENCE_KEY_CHARS).optional(),
    preferenceValue: z.string().trim().min(1).max(MEMORY_PROVIDER_LIMITS.body).optional(),
    topicKey: z.string().trim().min(1).max(MAX_PREFERENCE_KEY_CHARS).optional(),
    updatesRecordId: IdSchema.optional(),
    keywords: DraftKeywordsSchema,
    validUntil: z.string().trim().min(1).max(64).optional(),
    sensitive: z.boolean().optional(),
    from: z.enum(["person", "assistant"]).optional(),
  })
  // A preference needs both its key and value, so one active value is enforceable; another kind takes neither.
  .refine(
    (draft) => (draft.kind === "preference") === (draft.preferenceKey !== undefined && draft.preferenceValue !== undefined),
    "a preference has both preferenceKey and preferenceValue; another kind does not",
  )
  .refine((draft) => draft.updatesRecordId === undefined || draft.kind === "fact", "only a fact draft may name a record it updates");

const ConsolidationReasonSchema = z.string().trim().min(1).max(MEMORY_PROVIDER_LIMITS.reason);

/**
 * One tidy-up draft as the host validates it: bounds and
 * shapes only. The host then checks each id is one of the records it gave,
 * that a merge's inputs share a scope and kind with its replacement, and the
 * secret, sensitive and dedup rules; a draft that fails is dropped.
 */
export const ConsolidationDraftSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("merge"),
    recordIds: z
      .array(IdSchema)
      .min(2)
      .max(MEMORY_PROVIDER_LIMITS.mergeRecords)
      .refine((ids) => new Set(ids).size === ids.length, "each record is named once"),
    replacement: MemoryDraftSchema,
    reason: ConsolidationReasonSchema,
  }),
  z.strictObject({ action: z.literal("supersede"), recordId: IdSchema, replacement: MemoryDraftSchema, reason: ConsolidationReasonSchema }),
  z.strictObject({
    action: z.literal("expire"),
    recordId: IdSchema,
    validUntil: z.string().trim().min(1).max(64),
    reason: ConsolidationReasonSchema,
  }),
]);

/**
 * The drafts in a provider's consolidation answer the host files:
 * each read as plain data and held to `ConsolidationDraftSchema`; one that
 * fails is dropped and the rest still go, at most `max` of them. An answer
 * that is not `{ drafts: [...] }` drafts nothing.
 */
export function consolidationDraftsFrom(answer: unknown, max: number): readonly ConsolidationDraft[] {
  let drafts: unknown;
  try {
    // A plugin's answer may be a Proxy or carry getters: it is read once, as JSON.
    drafts = (JSON.parse(JSON.stringify(answer ?? null)) as { drafts?: unknown } | null)?.drafts;
  } catch {
    return [];
  }
  if (!Array.isArray(drafts)) return [];
  const read: ConsolidationDraft[] = [];
  for (const draft of drafts) {
    if (read.length >= max) break;
    const parsed = ConsolidationDraftSchema.safeParse(draft);
    if (parsed.success) read.push(parsed.data as ConsolidationDraft);
  }
  return read;
}

/** A plugin's memory provider (`provides: ["memory"]`): what it does and asks to receive, reviewed before its code runs. */
export const PluginMemoryDeclarationSchema = z.strictObject({
  abi: z.literal(MEMORY_PROVIDER_ABI),
  capabilities: z
    .array(z.enum(MEMORY_PROVIDER_CAPABILITIES))
    .min(1)
    .max(MEMORY_PROVIDER_CAPABILITIES.length)
    .refine((capabilities) => new Set(capabilities).size === capabilities.length, "each capability is listed once")
    .refine((capabilities) => capabilities.includes("recall"), 'a memory provider recalls: capabilities include "recall"'),
  /** `own`: it keeps an index through `sync`. `host`: it ranks the `candidates` it is given. */
  index: z.enum(["own", "host"]),
  receives: z
    .array(z.enum(MEMORY_PROVIDER_RECEIVES))
    .max(MEMORY_PROVIDER_RECEIVES.length)
    .refine((receives) => new Set(receives).size === receives.length, "each field is listed once")
    .default([]),
});
export type PluginMemoryDeclaration = z.infer<typeof PluginMemoryDeclarationSchema>;

const RECEIVE_DISCLOSURES = {
  records: "memory.provider.receives.records",
  conversation: "memory.provider.receives.conversation",
} as const satisfies Record<MemoryProviderReceive, string>;

const CAPABILITY_DISCLOSURES = {
  recall: "memory.provider.does.recall",
  capture: "memory.provider.does.capture",
  consolidate: "memory.provider.does.consolidate",
} as const satisfies Record<MemoryProviderCapability, string>;

/** What approving a memory provider means, derived from what it does and what it asks to receive. */
export function describeMemoryDeclaration(memory: PluginMemoryDeclaration, t: CoreT = coreEnglish): string {
  const does = memory.capabilities.map((capability) => t(CAPABILITY_DISCLOSURES[capability])).join(", ");
  const fields = memory.receives.map((field) => t(RECEIVE_DISCLOSURES[field]));
  const receives =
    fields.length === 0
      ? t("memory.provider.receives.nothing")
      : fields.reduce((first, second) => t("memory.provider.receives.both", { first, second }));
  return t(memory.index === "own" ? "memory.provider.describeOwnIndex" : "memory.provider.describe", { does, receives });
}

/**
 * The drafts in a provider's capture answer the host files: each one
 * read as plain data and held to `MemoryDraftSchema`; one that fails is
 * dropped and the rest still go, at most `max` of them. An answer that is
 * not `{ proposals: [...] }` drafts nothing.
 */
export function memoryDraftsFrom(answer: unknown, max: number): readonly MemoryDraft[] {
  let proposals: unknown;
  try {
    // A plugin's answer may be a Proxy or carry getters: it is read once, as JSON.
    proposals = (JSON.parse(JSON.stringify(answer ?? null)) as { proposals?: unknown } | null)?.proposals;
  } catch {
    return [];
  }
  if (!Array.isArray(proposals)) return [];
  const drafts: MemoryDraft[] = [];
  for (const proposal of proposals) {
    if (drafts.length >= max) break;
    const draft = MemoryDraftSchema.safeParse(proposal);
    if (!draft.success) continue;
    // Zod leaves an absent optional field absent, which is what `MemoryDraft` means by optional;
    // keywords read as none are left out the same way.
    const { keywords, ...rest } = draft.data;
    drafts.push((keywords === undefined ? rest : { ...rest, keywords }) as MemoryDraft);
  }
  return drafts;
}
