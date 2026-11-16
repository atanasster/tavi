import { MEMORY_PROVIDER_LIMITS, renderCaptureSpan, selectCaptureSpan, type MemoryProvider } from "@tavi/contracts";
import {
  CAPTURE_MAX_OUTPUT_TOKENS,
  MEMORY_FLUSH_MARKER,
  MEMORY_FLUSH_PROMPT,
  MEMORY_REVIEW_MARKER,
  MEMORY_REVIEW_PROMPT,
  memoryReviewInput,
  parseCaptureDrafts,
} from "@tavi/plugin-kit/memory";

import type { EpochFlushProvider } from "../../src/memory/epoch-flush.js";

/**
 * A capture as the built-in provider (`@tavi/plugin-defaults/memory`) drafts one, built from the kit it is
 * made of: the host runs the flush through whichever provider it is handed, and these tests hand it this one.
 */
export function flushProvider(): EpochFlushProvider {
  const provider: Pick<MemoryProvider, "capture"> = {
    async capture(request) {
      const span = renderCaptureSpan(selectCaptureSpan(request.span, MEMORY_PROVIDER_LIMITS.spanChars));
      if (span === "") return { proposals: [] };
      const rollover = request.occasion === "rollover";
      const answer = await request.host.complete({
        instructions: rollover ? MEMORY_FLUSH_PROMPT : MEMORY_REVIEW_PROMPT,
        prompt: memoryReviewInput(request.today, span, request.known, rollover ? MEMORY_FLUSH_MARKER : MEMORY_REVIEW_MARKER),
        maxOutputTokens: CAPTURE_MAX_OUTPUT_TOKENS,
      });
      return { proposals: parseCaptureDrafts(answer.text, request.limits.maxProposals, request.known) };
    },
  };
  return { provider };
}

/** The adapter's flush option, drafting through `flushProvider`. */
export const FLUSH = { provider: async () => flushProvider() } as const;
