import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MEMORY_PROVIDER_ABI,
  MEMORY_PROVIDER_LIMITS,
  type MemoryProvider,
  type PluginMemoryDeclaration,
} from "@tavi/contracts";
import {
  CAPTURE_MAX_OUTPUT_TOKENS,
  CONSOLIDATION_MAX_OUTPUT_TOKENS,
  MEMORY_CONSOLIDATE_PROMPT,
  MEMORY_FLUSH_MARKER,
  MEMORY_FLUSH_PROMPT,
  MEMORY_REVIEW_MARKER,
  MEMORY_REVIEW_PROMPT,
  consolidationCandidates,
  memoryConsolidateInput,
  memoryReviewInput,
  parseCaptureDrafts,
  parseConsolidationDrafts,
  renderCaptureSpan,
  renderConsolidationRecords,
  selectCaptureSpan,
} from "@tavi/plugin-kit/memory";

/**
 * The built-in memory provider, `tavi.memoryprovider`: what recall and the
 * idle review use in every workspace until another provider is chosen, and
 * what they fall
 * back to when that one is unavailable.
 *
 * **Recall** ranks with the host's own index — bm25 over the memory
 * service's full-text index, fused with its vectors under `retrieval:
 * "hybrid"` — which the host offers it as `host.lexical`.
 * That index lives with the records (the worker keeps the vectors beside
 * them), so the built-in needs no `sync` and no candidates, and its answer
 * is exactly the host's ranking: ids only, which the host renders from its
 * own rows.
 *
 * **Capture** is the idle review: one bounded call on the span with
 * the shared draft schema (`@tavi/plugin-kit/memory`), its answer read as drafts.
 * The host validates and files them; a person decides each.
 *
 * **Consolidate** is the weekly tidy-up, when the workspace
 * turns it on: one bounded call over the person's kept facts and lessons,
 * rendered with handles (`@tavi/plugin-kit/memory`), its answer read back as merge,
 * supersede and expire drafts naming only records it was given. The host
 * files each as a proposal with lineage; nothing is changed until a person
 * approves it.
 */

/** What the built-in declares, as an external provider's manifest would. */
export const BUILTIN_MEMORY_DECLARATION: PluginMemoryDeclaration = Object.freeze({
  abi: MEMORY_PROVIDER_ABI,
  capabilities: Object.freeze(["recall", "capture", "consolidate"]) as PluginMemoryDeclaration["capabilities"],
  // The host's own index: it neither keeps an index through `sync` nor needs the candidates.
  index: "host",
  receives: Object.freeze(["records", "conversation"]) as PluginMemoryDeclaration["receives"],
});

const stopped = (signal: AbortSignal, what: string): Error =>
  signal.reason instanceof Error ? signal.reason : new Error(`${BUILTIN_MEMORY_PROVIDER_ID}: the ${what} was stopped`);

export function createBuiltinMemoryProvider(): Required<Pick<MemoryProvider, "recall" | "capture" | "consolidate" | "status">> {
  return {
    async recall(request) {
      if (request.signal.aborted) throw stopped(request.signal, "recall");
      const hits = await request.host.lexical(
        request.query.slice(0, MEMORY_PROVIDER_LIMITS.queryChars),
        Math.min(request.limit, MEMORY_PROVIDER_LIMITS.hits),
      );
      return { hits: hits.map(({ recordId, revisionId, score }) => ({ recordId, revisionId, score })) };
    },
    async capture(request) {
      if (request.signal.aborted) throw stopped(request.signal, "capture");
      const span = renderCaptureSpan(selectCaptureSpan(request.span, MEMORY_PROVIDER_LIMITS.spanChars));
      if (span === "") return { proposals: [] };
      // A rollover's span is about to be condensed; a review's chat goes on.
      const rollover = request.occasion === "rollover";
      const answer = await request.host.complete({
        instructions: rollover ? MEMORY_FLUSH_PROMPT : MEMORY_REVIEW_PROMPT,
        prompt: memoryReviewInput(request.today, span, request.known, rollover ? MEMORY_FLUSH_MARKER : MEMORY_REVIEW_MARKER),
        maxOutputTokens: CAPTURE_MAX_OUTPUT_TOKENS,
      });
      return {
        proposals: parseCaptureDrafts(
          answer.text,
          Math.min(request.limits.maxProposals, MEMORY_PROVIDER_LIMITS.draftsPerCapture),
          request.known,
        ),
      };
    },
    async consolidate(request) {
      if (request.signal.aborted) throw stopped(request.signal, "consolidation");
      // A lone record with nothing to merge it with and no date to go out of date by is left out of the call.
      const input = renderConsolidationRecords(
        consolidationCandidates(request.records.slice(0, MEMORY_PROVIDER_LIMITS.consolidateRecords)),
      );
      if (input.handles.size < 1) return { drafts: [] };
      const today = request.today ?? request.now.slice(0, 10);
      const answer = await request.host.complete({
        instructions: MEMORY_CONSOLIDATE_PROMPT,
        prompt: memoryConsolidateInput(today, input.text),
        maxOutputTokens: CONSOLIDATION_MAX_OUTPUT_TOKENS,
      });
      return {
        drafts: parseConsolidationDrafts(
          answer.text,
          input.handles,
          Math.min(request.limits.maxDrafts, MEMORY_PROVIDER_LIMITS.draftsPerConsolidation),
        ),
      };
    },
    status: () => ({ ready: true }),
  };
}
