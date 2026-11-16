import {
  type ModelCatalogEntry,
  ModelCatalogEntrySchema,
  type ModelConnection,
  TaviError,
  VIDEO_CATALOG_CAPABILITY,
  scrubCredentialText,
} from "@tavi/contracts";
import { definedOnly, errorMessage, isRecord, nowTimestamp } from "@tavi/contracts/util";
import { BodyTooLargeError, readBoundedBody, sha256Hex } from "@tavi/node-kit";

/**
 * Model discovery and connection testing.
 *
 * Both operations are bounded and explicit: a request timeout, a response-size
 * bound, a model-count bound, and no fallback to another endpoint. A test runs
 * one synthetic generation with a small output limit and reports what it
 * actually observed, so `installed`/`available`/`capable` stay separate states
 * rather than one optimistic flag.
 */

/**
 * Response bodies are read up to this many bytes before parsing. A gateway's
 * listing carries a description and pricing per model — OpenRouter's is past
 * a megabyte for a few hundred models — so the bound is the 4 MB deepseek-harness
 * reads, not the 512 KB that refused it whole.
 */
export const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;
/** A provider listing more than this is truncated; the catalog is not a mirror. */
export const MAX_DISCOVERED_MODELS = 500;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;

export interface DiscoveredModel {
  readonly modelId: string;
  readonly displayName?: string;
  readonly ownedBy?: string;
}

/**
 * One entry of a listing, as the field names the standard `GET /models` and
 * the gateways that extend it use (OpenRouter's `name`, `context_length` and
 * `top_provider.max_completion_tokens`; LiteLLM's `limit.context`/`limit.output`;
 * camel-cased spellings from a few self-hosted servers). What deepseek-harness's
 * pi-ai discovery reads, read here for the same reason: a picker wants the
 * name and the capacities, and the official listing carries neither.
 */
interface ListingEntry {
  readonly id?: unknown;
  /** Sign in with ChatGPT's catalogue: the id is its `slug`, and only `visibility: "list"` is for a picker. */
  readonly slug?: unknown;
  readonly visibility?: unknown;
  readonly owned_by?: unknown;
  readonly name?: unknown;
  readonly display_name?: unknown;
  readonly displayName?: unknown;
  readonly contextWindow?: unknown;
  readonly context_window?: unknown;
  readonly context_length?: unknown;
  readonly max_input_tokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly max_output_tokens?: unknown;
  readonly maxTokens?: unknown;
  readonly max_tokens?: unknown;
  readonly limit?: { readonly context?: unknown; readonly output?: unknown } | null;
  readonly top_provider?: { readonly max_completion_tokens?: unknown } | null;
  /** OpenRouter's: what the model takes in, e.g. `["text", "image", "video"]`. */
  readonly architecture?: { readonly input_modalities?: unknown } | null;
}

/**
 * The capability tokens a listing itself discloses: `video` when it says the
 * model takes video in. Discovery owns
 * this token and sets or clears it on every run (`DISCOVERY_CAPABILITIES`).
 */
function listedCapabilities(raw: ListingEntry): string[] {
  const modalities = raw.architecture?.input_modalities;
  return Array.isArray(modalities) && modalities.some((modality) => typeof modality === "string" && modality.toLowerCase() === "video")
    ? [VIDEO_CATALOG_CAPABILITY]
    : [];
}

/** The capability tokens discovery owns: it replaces these on a row, and keeps the rest. */
export const DISCOVERY_CAPABILITIES: readonly string[] = [VIDEO_CATALOG_CAPABILITY];

/** The first candidate that is a positive integer, or nothing. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  return undefined;
}

/** The first candidate that is a non-empty string, or nothing. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * The entries of a listing: the standard `data` array, or the `models` map
 * some gateways answer with instead, each key the id the endpoint accepts and
 * only object values models (a primitive property is directory metadata).
 * Neither shape present is not a model list.
 */
function listingEntries(body: unknown): readonly { readonly key?: string; readonly raw: ListingEntry }[] | undefined {
  const listing = body as { readonly data?: unknown; readonly models?: unknown } | null;
  if (Array.isArray(listing?.data)) return (listing.data as readonly unknown[]).map((raw) => ({ raw: (raw ?? {}) as ListingEntry }));
  // An array of `models`, as Sign in with ChatGPT's account catalogue answers: each by its slug, the listed ones only.
  // Only one that names a slug: an empty or unknown array is no model list.
  if (Array.isArray(listing?.models)) {
    if (!(listing.models as readonly unknown[]).some((raw) => typeof (raw as ListingEntry | null)?.slug === "string")) return undefined;
    return (listing.models as readonly unknown[])
      .map((raw) => (raw ?? {}) as ListingEntry)
      .filter((raw) => typeof raw.slug === "string" && raw.slug !== "" && (raw.visibility === undefined || raw.visibility === "list"))
      .map((raw) => ({ key: raw.slug as string, raw }));
  }
  const models = listing?.models;
  if (!isRecord(models)) return undefined;
  return Object.entries(models)
    .filter(([, raw]) => isRecord(raw))
    .map(([key, raw]) => ({ key, raw: raw as ListingEntry }));
}

/**
 * A gateway's batch-only variant: OpenRouter lists `<model>:batch` beside each
 * model it can batch, and its `chat/completions` — the only endpoint tavi
 * calls — refuses every one. Nothing but the id suffix marks it.
 */
function isBatchOnly(modelId: string): boolean {
  return modelId.endsWith(":batch");
}

export interface ModelDiscoveryOptions {
  readonly connection: ModelConnection;
  /** Never read from the environment here; the store decides what a reference means. */
  readonly readSecret: (credentialRef: string) => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly now?: () => string;
}

/**
 * List the models a connection offers.
 *
 * Provenance is `live` and the result is written into the catalog by the caller:
 * discovery observes, it does not decide what a workspace uses.
 */
export async function discoverModels(options: ModelDiscoveryOptions): Promise<readonly ModelCatalogEntry[]> {
  const now = options.now ?? nowTimestamp;
  const credential = await options.readSecret(options.connection.credentialRef);
  if (credential === null) {
    // A declared binding that resolves to nothing is a configuration failure the
    // operator must fix; discovering anonymously would report a misleading
    // "unauthorized" instead.
    throw new TaviError(
      "NOT_CONFIGURED",
      `Connection ${options.connection.connectionId} has no credential bound for ` +
        `${options.connection.credentialRef}; bind one before discovering models`,
      { details: { connectionId: options.connection.connectionId } },
    );
  }

  // Anthropic lists 20 models a page unless asked for more: the most it allows, so one page holds them all.
  const url = `${trimTrailingSlash(options.connection.baseUrl)}/models${options.connection.kind === "anthropic-messages" ? "?limit=1000" : ""}`;
  const response = await requestJson(url, credential, options, "model discovery");
  const entries = listingEntries(response);
  if (entries === undefined) {
    throw new TaviError("UNAVAILABLE", `Model discovery from ${url} did not return a model list`, {
      details: { connectionId: options.connection.connectionId },
    });
  }

  const discoveredAt = now();
  const models: ModelCatalogEntry[] = [];
  for (const { key, raw } of entries) {
    if (models.length >= MAX_DISCOVERED_MODELS) break;
    // A map's key is the id the endpoint accepts; its nested `id` may be a canonical name instead.
    const modelId = label(key, raw.id);
    if (modelId === undefined || isBatchOnly(modelId)) continue;
    // The name a gateway gives; `owned_by` is who serves it, not what it is called.
    const displayName = label(raw.name, raw.display_name, raw.displayName);
    const contextWindow = capacity(raw.contextWindow, raw.context_window, raw.context_length, raw.max_input_tokens, raw.limit?.context);
    const maxTokens = capacity(
      raw.maxOutputTokens,
      raw.max_output_tokens,
      raw.maxTokens,
      raw.max_tokens,
      raw.limit?.output,
      raw.top_provider?.max_completion_tokens,
    );
    models.push(
      ModelCatalogEntrySchema.parse({
        connectionId: options.connection.connectionId,
        modelId,
        provenance: "live",
        state: "available",
        capabilities: listedCapabilities(raw),
        discoveredAt,
        ...definedOnly({
          displayName,
          contextWindow,
          maxTokens,
        }),
      }),
    );
  }
  return models;
}

/** Capability tokens a connection test can observe. */
export const OBSERVED_CAPABILITIES = ["chat", "streaming", "tools"] as const;
export type ObservedCapability = (typeof OBSERVED_CAPABILITIES)[number];

export interface ConnectionTestResult {
  readonly connectionId: string;
  readonly modelId: string;
  readonly ok: boolean;
  /** Observed capabilities; a failed test observes none. */
  readonly capabilities: readonly ObservedCapability[];
  readonly latencyMs: number;
  readonly testedAt: string;
  /**
   * Hash of the exact draft that was tested.
   *
   * A stored result is only meaningful for the draft it was produced from, so a
   * changed endpoint, model, credential reference or header invalidates it.
   */
  readonly draftHash: string;
  /**
   * A failure that says nothing lasting about the model — a rate limit, a
   * provider fault, a timeout, a key not set: a caller does not record the
   * model as unavailable on it (a run would skip it).
   */
  readonly transient?: boolean;
  /** The adapter's `ModelError` code for a failure, when it gave one: what verify's advice reads. */
  readonly failureCode?: string;
  readonly providerRequestId?: string;
  /** Safe failure summary; never a credential or a raw request dump. */
  readonly message?: string;
}

export const DEFAULT_TEST_TIMEOUT_MS = 20_000;

/**
 * The tool offered by a connection test.
 *
 * Offering a tool is the only way to observe whether the model *can* call one;
 * without it the `tools` capability would be unreachable and a model that cannot
 * use tools would still be marked capable for work that needs them.
 */
const PROBE_TOOL = {
  id: "probe.noop",
  name: "probe_noop",
  description: "Record that the connection test reached you. Call it with no arguments.",
  inputJsonSchema: { type: "object", properties: {}, additionalProperties: false },
} as const;

export interface ConnectionTestOptions {
  readonly connection: ModelConnection;
  readonly modelId: string;
  /**
   * Runs one bounded generation; injected so the test never holds a transport.
   *
   * The signal is aborted when the test reaches its deadline, so a provider that
   * accepts the connection and then stalls cannot hang the command.
   */
  readonly generate: (input: {
    readonly prompt: string;
    readonly maxOutputTokens: number;
    readonly signal: AbortSignal;
    readonly tools: readonly (typeof PROBE_TOOL)[];
  }) => Promise<{ readonly text: string; readonly toolCallNames: readonly string[]; readonly streamed: boolean }>;
  readonly now?: () => string;
  readonly timeoutMs?: number;
}

/**
 * Test a connection with synthetic input and bounded cost.
 *
 * The prompt asks for a single short word and the output limit is 512 tokens —
 * enough for a reasoning model to reach its answer or the probe call
 * — so a test cannot become the most expensive
 * call in a workspace. The result says
 * what was observed (`chat`, `streaming`) rather than assuming it from the model
 * name, and a failure is reported as a typed outcome instead of an exception: a
 * connection test is a diagnostic, not a task.
 */
export async function testConnection(options: ConnectionTestOptions): Promise<ConnectionTestResult> {
  const now = options.now ?? nowTimestamp;
  const draftHash = hashDraft(options.connection, options.modelId);
  const started = Date.now();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const generated = await options.generate({
      // One synthetic call with a 512-token output limit: enough room for a
      // reasoning model's thinking tokens before calling the probe tool.
      prompt: "Call the probe_noop tool with no arguments. If you cannot call tools, reply with the single word: ok",
      maxOutputTokens: 512,
      signal: controller.signal,
      tools: [PROBE_TOOL],
    });
    const capabilities: ObservedCapability[] = ["chat"];
    if (generated.streamed) capabilities.push("streaming");
    if (generated.toolCallNames.length > 0) capabilities.push("tools");
    return {
      connectionId: options.connection.connectionId,
      modelId: options.modelId,
      ok: true,
      capabilities,
      latencyMs: Date.now() - started,
      testedAt: now(),
      draftHash,
    };
  } catch (error) {
    const taviError = controller.signal.aborted
      ? new TaviError("UNAVAILABLE", `The connection test exceeded ${timeoutMs}ms`)
      : TaviError.from(error);
    // Only what the provider says of the model or its key lasts; the rest may pass (a rate limit or a provider fault is transient).
    const modelCode = controller.signal.aborted ? undefined : taviError.details?.["code"];
    const lasting = modelCode === "auth" || modelCode === "invalid_request" || modelCode === "quota_exceeded";
    return {
      connectionId: options.connection.connectionId,
      modelId: options.modelId,
      ok: false,
      capabilities: [],
      latencyMs: Date.now() - started,
      testedAt: now(),
      draftHash,
      ...(lasting ? {} : { transient: true }),
      ...(typeof modelCode === "string" ? { failureCode: modelCode } : {}),
      // Bounded and scrubbed here, because a provider can echo the request body.
      message: sanitizeFailureMessage(`${taviError.code}: ${taviError.message}`),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Longest failure summary kept from a provider; the rest is noise or worse. */
const MAX_FAILURE_MESSAGE_CHARS = 300;

/**
 * Bound a failure message and strip anything credential-shaped.
 *
 * A provider that echoes the request in an error body would otherwise put the
 * credential into the CLI's JSON output and the operator's terminal.
 */
export function sanitizeFailureMessage(message: string): string {
  // One scrubber, in `contracts`, so the model-invocation path and this one cannot
  // drift: the patterns used to live only here, and the invocation path — the one
  // that writes into `tavi_tasks.final_text` and the terminal — never ran them at
  // all.
  return scrubCredentialText(message).slice(0, MAX_FAILURE_MESSAGE_CHARS);
}

/** The identity of a draft: what makes a stored test result stale. */
export function hashDraft(connection: ModelConnection, modelId: string): string {
  return sha256Hex(
    JSON.stringify({
      connectionId: connection.connectionId,
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      credentialRef: connection.credentialRef,
      headers: connection.headers ?? null,
      modelId,
    }),
  ).slice(0, 32);
}

/** A discovery result is stale once the connection it described has changed. */
export function isDiscoveryStale(entry: ModelCatalogEntry, connection: ModelConnection): boolean {
  return entry.connectionId !== connection.connectionId || connection.updatedAt > (entry.discoveredAt ?? "");
}

/** The Messages API version a native Anthropic connection is listed under, as the AI SDK's own provider sends. */
const ANTHROPIC_API_VERSION = "2023-06-01";

async function requestJson(url: string, credential: string, options: ModelDiscoveryOptions, what: string): Promise<unknown> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(url, {
      method: "GET",
      headers: {
        // Anthropic's own API takes its key and version as headers of its own; any other, a bearer token.
        ...(options.connection.kind === "anthropic-messages"
          ? { "x-api-key": credential, "anthropic-version": ANTHROPIC_API_VERSION }
          : { authorization: `Bearer ${credential}` }),
        accept: "application/json",
        ...(options.connection.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new TaviError(
        response.status === 401 || response.status === 403 ? "NOT_AUTHORIZED" : "UNAVAILABLE",
        `${what} at ${url} failed with HTTP ${response.status}`,
        { details: { connectionId: options.connection.connectionId, status: response.status } },
      );
    }
    const body = await readBounded(response);
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (error instanceof TaviError) throw error;
    throw new TaviError("UNAVAILABLE", `${what} at ${url} failed: ${errorMessage(error)}`, {
      details: { connectionId: options.connection.connectionId },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a response body, refusing it as soon as it exceeds the bound.
 *
 * The limit is enforced while bytes arrive rather than after `response.text()`
 * has buffered the whole body: a declared bound that is checked afterwards is
 * not a bound, it is a post-mortem.
 */
async function readBounded(response: Response): Promise<string> {
  try {
    const { bytes } = await readBoundedBody(response, MAX_DISCOVERY_BYTES);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (!(error instanceof BodyTooLargeError)) throw error;
    throw new TaviError(
      "UNAVAILABLE",
      error.declared === undefined
        ? `Response exceeded ${MAX_DISCOVERY_BYTES} bytes and was refused`
        : `Response declared ${error.declared} bytes, above the ${MAX_DISCOVERY_BYTES}-byte limit`,
    );
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
