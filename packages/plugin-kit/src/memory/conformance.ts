/**
 * `@tavi/plugin-kit/memory/conformance`: the two
 * suites every memory implementation passes — the port suite for a
 * `MemoryServicePort` (the built-in service, or an embedder's
 * `memoryOverride`) and the provider suite for a memory provider.
 *
 * Test-only: it imports vitest, so it is exported for tests and never built.
 */
export {
  describeMemoryServiceConformance,
  memoryServiceConformanceCases,
  runMemoryServiceConformanceCase,
  type MemoryPortEnvironment,
  type MemoryPortFactory,
  type MemoryPortHarness,
} from "./port-conformance.js";
export {
  MEMORY_PROVIDER_KIT_LIMITS,
  describeMemoryProviderConformance,
  memoryProviderConformanceCases,
  runMemoryProviderConformanceCase,
  type MemoryProviderConformanceOptions,
  type MemoryProviderUnderTest,
} from "./provider-conformance.js";
