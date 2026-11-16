/**
 * `@tavi/plugin-kit/memory`: what a memory
 * service port and a memory provider share. The conformance suites
 * themselves are test-only, under `@tavi/plugin-kit/memory/conformance`; this entry
 * carries the declaration an embedder's `memoryOverride` makes, and the
 * capture and consolidation pieces the built-in provider sends (the span or
 * records, the draft schema, how an answer is read), for a replacement to
 * send as they are or build on.
 */
export {
  CAPTURE_SPAN_MESSAGE_CHARS,
  MEMORY_PORT_CONFORMANCE,
  renderCaptureSpan,
  selectCaptureSpan,
  type MemoryOverride,
  type MemoryOverrideDependencies,
} from "@tavi/contracts";
export {
  CAPTURE_DRAFT_INSTRUCTIONS,
  CAPTURE_MAX_OUTPUT_TOKENS,
  MEMORY_REVIEW_MARKER,
  MEMORY_FLUSH_MARKER,
  MEMORY_FLUSH_PROMPT,
  MEMORY_REVIEW_PROMPT,
  memoryReviewInput,
  parseCaptureDrafts,
} from "./capture.js";
export {
  CONSOLIDATION_INPUT_CHARS,
  CONSOLIDATION_MAX_OUTPUT_TOKENS,
  CONSOLIDATION_RECORD_CHARS,
  MEMORY_CONSOLIDATE_MARKER,
  MEMORY_CONSOLIDATE_PROMPT,
  consolidationCandidates,
  memoryConsolidateInput,
  parseConsolidationDrafts,
  renderConsolidationRecords,
  type ConsolidationInput,
} from "./consolidation.js";
