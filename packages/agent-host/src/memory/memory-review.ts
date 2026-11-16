import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MEMORY_PROVIDER_LIMITS,
  memoryDraftsFrom,
  type InvocationContext,
  type MemoryCaptureMessage,
  type MemoryProvider,
  type MemorySensitiveMode,
  type MemoryServicePort,
  type ModelPort,
  type ModelTarget,
  type TranscriptEntry,
  type WorkflowMessage,
  selectCaptureSpan,
} from "@tavi/contracts";

import {
  EPOCH_FLUSH_INPUT_CHARS,
  EPOCH_FLUSH_MAX_OUTPUT_TOKENS,
  EPOCH_FLUSH_MAX_PROPOSALS,
  EPOCH_FLUSH_TIMEOUT_MS,
  fileCaptureProposals,
  localCaptureDate,
  proposalOf,
} from "./epoch-flush.js";
import { NO_CAPTURE_DROPS, type CaptureDropCounts } from "./memory-capture.js";
import { knownTitles, meteredMemoryHost, withinSignal } from "./provider-host.js";
import { isSubstantiveMessage } from "../context/retrieval-query.js";

/**
 * The idle review: once a chat has
 * been idle for `MEMORY_REVIEW_IDLE_MS` with at least
 * `MEMORY_REVIEW_MIN_MESSAGES` new substantive person messages since its
 * mark, one bounded call reads what was said since — the person's prompts
 * and steers and the assistant's final answers, never a tool's output or
 * quoted data, never a turn whose input carried untrusted data, and never one
 * that came in from a messaging conversation (invariant 6) — and
 * proposes what is worth remembering, through the same capture pipeline as
 * the flush. The pure half lives here; the `tavi.memory` tick that picks the
 * chat, the model and the marks is `apps/cli/src/features/memory/idle-review.ts`.
 */

/** How long a chat waits after its newest saved turn before it is reviewed. */
export const MEMORY_REVIEW_IDLE_MS = 10 * 60_000;
/** New substantive person messages since the mark that make a chat due. */
export const MEMORY_REVIEW_MIN_MESSAGES = 3;
/** Reviews one person may cost a day, failures included. */
export const MEMORY_REVIEW_DAILY_MAX = 24;
/** A failed review is tried again no sooner than this. */
export const MEMORY_REVIEW_RETRY_MS = 3_600_000;
/** Failures on one span after which the mark moves past it. */
export const MEMORY_REVIEW_FAILURES_MAX = 3;
/** The most drafts one review files, its answer, its time and what it reads: the flush's bounds. */
const MEMORY_REVIEW_MAX_PROPOSALS = EPOCH_FLUSH_MAX_PROPOSALS;
const MEMORY_REVIEW_MAX_OUTPUT_TOKENS = EPOCH_FLUSH_MAX_OUTPUT_TOKENS;
const MEMORY_REVIEW_TIMEOUT_MS = EPOCH_FLUSH_TIMEOUT_MS;
const MEMORY_REVIEW_INPUT_CHARS = EPOCH_FLUSH_INPUT_CHARS;
/** Every review call's attempt id starts with this: doctor's spend line reads them by it. */
export const MEMORY_REVIEW_ATTEMPT_PREFIX = "memory-review-";
/** Transport metadata, distinct from a turn's attempts, the summary's and the flush's. */
const MEMORY_REVIEW_ATTEMPT_NUMBER = 1_000_002;
/**
 * The proposals' author: the built-in provider's capture. Kept as it
 * was first written (before the provider had its id, `tavi.memoryprovider`),
 * so the records it already filed and the ones it files now read alike.
 */
export const MEMORY_REVIEW_CALLER = "provider:tavi.memory:capture";

/** Whose capture filed a proposal: `MEMORY_REVIEW_CALLER` for the built-in, `provider:<id>:capture` for another. */
export function memoryCaptureCaller(providerId: string | undefined): string {
  return providerId === undefined || providerId === BUILTIN_MEMORY_PROVIDER_ID ? MEMORY_REVIEW_CALLER : `provider:${providerId}:capture`;
}

/** A saved turn as the review reads it; `createdAt`, when known, dates its words in the span. */
export type MemoryReviewEntry = Pick<TranscriptEntry, "seq" | "turn"> & Partial<Pick<TranscriptEntry, "createdAt">>;

/** The person's own words in a saved turn: its prompt, then each steer, in order. */
function personWords(entry: MemoryReviewEntry): readonly string[] {
  const words: string[] = [];
  if (entry.turn.prompt !== undefined && entry.turn.prompt.trim() !== "") words.push(entry.turn.prompt);
  for (const item of entry.turn.items) if (item.kind === "steer" && item.text.trim() !== "") words.push(item.text);
  return words;
}

/**
 * Whether automatic capture leaves a saved turn out whole: it ran in a chat
 * that had read untrusted data by then, or came with a notices block, or it
 * came in from a messaging conversation, such as the operator's DM linked to
 * Home (invariant 6).
 */
const leftOut = (entry: MemoryReviewEntry): boolean => entry.turn.tainted === true || entry.turn.channel === "messaging";

/**
 * The span the review reads, as messages: for each saved turn not left out
 * (`tainted`, or held to a messaging channel), the person's prompt and steers and, when the turn completed,
 * the assistant's final answer. A tool call's output is never in a saved
 * turn, and neither is a notices block or a side chat's background.
 */
export function memoryReviewSpan(entries: readonly MemoryReviewEntry[]): readonly WorkflowMessage[] {
  return reviewWords(entries).map((word) => ({ id: word.id, role: word.role === "person" ? "user" : "assistant", text: word.text }));
}

/** The span's words in order, each with the saved turn it came from. */
function reviewWords(
  entries: readonly MemoryReviewEntry[],
): readonly { readonly id: string; readonly role: "person" | "assistant"; readonly text: string; readonly entry: MemoryReviewEntry }[] {
  const words: { id: string; role: "person" | "assistant"; text: string; entry: MemoryReviewEntry }[] = [];
  for (const entry of entries) {
    if (leftOut(entry)) continue;
    personWords(entry).forEach((text, index) => words.push({ id: `review-${entry.seq}-person-${index}`, role: "person", text, entry }));
    const answer = entry.turn.outcome.status === "completed" ? entry.turn.outcome.finalText : undefined;
    if (answer !== undefined && answer.trim() !== "")
      words.push({ id: `review-${entry.seq}-answer`, role: "assistant", text: answer, entry });
  }
  return words;
}

/**
 * The span a review hands its provider: the person's and the
 * assistant's words as `memoryReviewSpan` reads them, each dated by its
 * saved turn (else `now`), bounded as the built-in renders it
 * (`selectCaptureSpan`, `MEMORY_REVIEW_INPUT_CHARS`).
 */
function memoryReviewCaptureSpan(entries: readonly MemoryReviewEntry[], now: string): readonly MemoryCaptureMessage[] {
  return selectCaptureSpan(
    reviewWords(entries).map((word) => ({ role: word.role, text: word.text, at: word.entry.createdAt ?? now })),
    MEMORY_REVIEW_INPUT_CHARS,
  );
}

/**
 * The person's own messages of the span a review reads (its prompts and
 * steers, never a tainted or messaging turn's): what auto-approve's quote
 * check matches a draft's words against.
 */
export function memoryReviewPersonMessages(entries: readonly MemoryReviewEntry[]): readonly string[] {
  return reviewWords(entries)
    .filter((word) => word.role === "person")
    .map((word) => word.text);
}

/**
 * How many of the person's messages in `entries` are substantive: at
 * least 3 keywords each, a CJK run counting one per 4 characters
 * (`isSubstantiveMessage`). A tainted or messaging turn's do not count: the
 * review would not read them.
 */
export function substantiveMessageCount(entries: readonly MemoryReviewEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (leftOut(entry)) continue;
    for (const text of personWords(entry)) if (isSubstantiveMessage(text)) count += 1;
  }
  return count;
}

interface MemoryReviewInput {
  readonly models: ModelPort;
  /** `list`, `history`, `search` and `get`, when given, read the titles a capture is told it already knows (`known`) and resolve `updatesRecordId`. */
  readonly memory: Pick<MemoryServicePort, "propose"> & Partial<Pick<MemoryServicePort, "list" | "history" | "search" | "get">>;
  /**
   * The provider that drafts from the span: the workspace's, from the
   * composition's registry, else the built-in `tavi.memoryprovider`. The host
   * files what it drafts.
   */
  readonly provider: Pick<MemoryProvider, "capture">;
  /** Its id, which authors what it drafts (`memoryCaptureCaller`); absent, the built-in's. */
  readonly providerId?: string;
  /**
   * Which records' titles it may be told (`known`): an external
   * provider's follow the workspace's `records` egress (`chat`) and
   * `includePersonal` too (`personal`), and it is told approved titles
   * only: a proposal is never sent anywhere, as the sync's rule is. Absent:
   * both, approved or waiting, as the built-in's.
   */
  readonly knows?: { readonly personal: boolean; readonly chat: boolean };
  /** The model the review runs on: the `extraction` role, else the chat's own (chosen by the caller). */
  readonly target: ModelTarget;
  /** The chat reviewed: `runId` is its task, `principalId` the person whose memory it proposes. */
  readonly context: InvocationContext;
  readonly entries: readonly MemoryReviewEntry[];
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
  readonly timeZone?: string;
  readonly sensitive?: MemorySensitiveMode;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Called once the call answered, before any draft is filed: the span's
   * mark is claimed here, so it is reviewed at most once across restarts
   * (invariant 17). False (already claimed) files nothing.
   */
  readonly claim?: () => Promise<boolean>;
}

/**
 * One review: the provider's `capture` over the span, with one bounded model
 * call it may make (`host.complete`, on `target`, keeping no copy of its
 * request), then each draft it answers validated (`memoryDraftsFrom`)
 * and filed through the capture pipeline as its author (`memoryCaptureCaller`). Throws
 * when the call or the provider fails or does not complete in time; a draft
 * the pipeline drops is counted. `claim` runs between the answer and the filing.
 */
export async function runMemoryReview(input: MemoryReviewInput): Promise<{
  readonly recordIds: readonly string[];
  /** Each filed proposal with its draft's `from`, for auto-approve. */
  readonly filed: readonly { readonly recordId: string; readonly from?: "person" | "assistant" }[];
  readonly dropped: CaptureDropCounts;
  readonly proposals: number;
  readonly claimed: boolean;
}> {
  const { context } = input;
  const span = memoryReviewCaptureSpan(input.entries, input.now());
  if (span.length === 0)
    return {
      recordIds: [],
      filed: [],
      dropped: NO_CAPTURE_DROPS,
      proposals: 0,
      claimed: input.claim === undefined ? true : await input.claim(),
    };
  const capture = input.provider.capture?.bind(input.provider);
  if (capture === undefined) throw new Error("the memory provider drafts no proposals");
  const timeout = AbortSignal.timeout(input.timeoutMs ?? MEMORY_REVIEW_TIMEOUT_MS);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  const host = meteredMemoryHost({
    models: input.models,
    target: input.target,
    context,
    newId: input.newId,
    now: input.now,
    signal,
    attemptPrefix: MEMORY_REVIEW_ATTEMPT_PREFIX,
    attemptNumber: MEMORY_REVIEW_ATTEMPT_NUMBER,
    maxOutputTokens: MEMORY_REVIEW_MAX_OUTPUT_TOKENS,
    what: "the review call",
    site: "memory-review",
  });
  const actor = {
    principalId: context.principalId,
    workspaceId: context.workspaceId,
    runId: context.runId,
    ...(context.agentDefinitionId === undefined ? {} : { agentId: context.agentDefinitionId }),
    caller: memoryCaptureCaller(input.providerId),
    authority: "model" as const,
  };
  const known = await knownTitles(input.memory, actor, input.knows ?? { personal: true, chat: true }, input.knows !== undefined, span);
  const answer = await withinSignal(
    capture(
      Object.freeze({
        span: Object.freeze(span.map((message) => Object.freeze(message))),
        today: localCaptureDate(input.now(), input.timeZone),
        known: Object.freeze(known),
        limits: Object.freeze({ maxProposals: MEMORY_REVIEW_MAX_PROPOSALS, bodyChars: MEMORY_PROVIDER_LIMITS.body }),
        policy: Object.freeze({ sensitive: input.sensitive ?? "skip" }),
        host,
        signal,
      }),
    ),
    signal,
  );
  const proposals = memoryDraftsFrom(answer, MEMORY_REVIEW_MAX_PROPOSALS).map(proposalOf);
  if (input.claim !== undefined && !(await input.claim()))
    return { recordIds: [], filed: [], dropped: NO_CAPTURE_DROPS, proposals: proposals.length, claimed: false };
  const filed = await fileCaptureProposals({
    memory: input.memory,
    proposals,
    knownRecordIds: known.map((entry) => entry.recordId),
    actor,
    chatTaskId: context.runId,
    now: input.now,
    ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
  });
  return { ...filed, proposals: proposals.length, claimed: true };
}
