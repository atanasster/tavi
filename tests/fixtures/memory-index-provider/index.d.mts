import type { MemoryProvider, MemorySnapshot } from "@tavi/contracts";

/** The fixture's own-index provider: no model, `index: "own"`, fed by `sync`. */
export function createIndexProvider(index?: Map<string, MemorySnapshot>, log?: unknown[]): MemoryProvider;
export function register(context: { readonly provideMemory: (provider: MemoryProvider) => void }): void;
