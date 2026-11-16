import type { MemoryProvider } from "@tavi/contracts";

/** The fixture's rule-based provider: no model, `index: "host"`. */
export function createKeywordProvider(): MemoryProvider;
export function register(context: { readonly provideMemory: (provider: MemoryProvider) => void }): void;
