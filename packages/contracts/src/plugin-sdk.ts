import type { z } from "zod";
import type { ResourceScope } from "./plugin.js";
import type { LanguageModelProvider } from "./language-model.js";
import type { WebSearchProvider, WebFetchProvider } from "./web-search.js";

export type { ResourceScope } from "./plugin.js";
export type {
  HeartbeatItem,
  HeartbeatPrecheck,
  HeartbeatPrecheckRequest,
  HeartbeatProvider,
  HeartbeatProviderStatus,
  HeartbeatSignal,
  HeartbeatSignalSource,
  HeartbeatTickRequest,
  HeartbeatTickResult,
  LedgerEntry,
  MemoryExcerpt,
  BudgetLeft,
} from "./heartbeat.js";
export { HEARTBEAT_ABI, HEARTBEAT_LIMITS, HeartbeatProviderError } from "./heartbeat.js";
export type {
  ConsolidationDraft,
  MemoryCaptureMessage,
  MemoryCaptureRequest,
  MemoryCaptureResult,
  MemoryConsolidateRequest,
  MemoryConsolidateResult,
  MemoryDraft,
  MemoryProvider,
  MemoryProviderModelHost,
  MemoryProviderStatus,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemorySnapshot,
  MemorySyncBatch,
  RankedId,
} from "./memory-provider.js";
export { MEMORY_PROVIDER_ABI, MEMORY_PROVIDER_LIMITS, MemoryProviderError } from "./memory-provider.js";

/** One account instance; settings and credential references are host inputs. */
export interface ProviderFactoryContext<Settings> {
  readonly instanceId: string;
  readonly settings: Settings;
  readonly scope: ResourceScope;
  readonly signal: AbortSignal;
  /** Resolves only credential names explicitly configured on this instance. */
  credential(name: string): Promise<string | null>;
  /** Fetch factories only: host mediation and observations for a reviewed transport. */
  readonly observeFetch?: ObserveFetch;
}

export interface FetchObservationHooks {
  /** Translate a reviewed transport's own URL/DNS/proxy policy refusal. */
  blocked(): never;
  authorize(url: string, addresses: readonly { address: string; family: number }[]): void;
  /** Called inside the real TLS connector before handing its socket to the client. */
  connected(url: string, socket: unknown): void;
  response(url: string, response: ObservedFetchResponse): ObservedFetchResponse;
}
/** Minimal Fetch stream shape shared by Node and Undici, with no runtime dependency. */
export interface ObservedFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: {
    cancel(reason?: unknown): Promise<void>;
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
      cancel(reason?: unknown): Promise<void>;
    };
  } | null;
}
export interface ObservedFetchLimits {
  maxResponseBytes: number;
  maxBodyChars: number;
  timeoutMs: number;
  maxRedirects: number;
  userAgent: string;
}
export type ObserveFetch = (
  id: string,
  create: (limits: ObservedFetchLimits, hooks: FetchObservationHooks) => WebFetchProvider,
) => WebFetchProvider;

export interface ProviderFactory<Provider, Settings> {
  readonly settingsSchema: z.ZodType<Settings>;
  create(context: ProviderFactoryContext<Settings>): Provider | Promise<Provider>;
}

export type SearchProviderFactory<Settings> = ProviderFactory<WebSearchProvider, Settings>;
export type FetchProviderFactory<Settings> = ProviderFactory<WebFetchProvider, Settings>;
export type ModelProviderFactory<Settings> = ProviderFactory<LanguageModelProvider, Settings>;

/** Host-only contribution surface, shared by builtin and approved external code. */
export interface ProviderFactories<Provider> {
  register<Settings>(id: string, factory: ProviderFactory<Provider, Settings>, owner: ResourceScope): void;
}
