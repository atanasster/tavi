import type { ModelCallSite, ModelEmbedOutcome, ModelEmbedRequest, ModelEvent, ModelOutcome, ModelRequest } from "../model.js";
import type {
  ModelCatalogEntry,
  ModelConnection,
  ModelProvenance,
  ModelResolution,
  ModelRole,
  ModelRoleBinding,
  ModelState,
  ModelTargetInput,
  ModelWorkspaceDefault,
  PdfEngine,
  PdfInput,
  ProviderKind,
  WireApi,
} from "../models-config.js";
import type { AsyncRepository } from "../persistence-types.js";
import type { ProviderBindingReference } from "../provider-operation.js";
import type { InvocationContext } from "./invocation.js";

interface ModelConfigRepositoryPortDefinition {
  listConnections(): readonly ModelConnection[];
  getConnection(connectionId: string): ModelConnection | undefined;
  upsertConnection(connection: ModelConnection): ModelConnection;
  deleteConnection(connectionId: string): boolean;
  /** Connections referenced by any stored catalog entry or role binding. */
  referencedConnectionIds(): readonly string[];
  listCatalog(connectionId: string): readonly ModelCatalogEntry[];
  replaceCatalog(connectionId: string, entries: readonly ModelCatalogEntry[]): void;
  putCatalogEntry(entry: ModelCatalogEntry): ModelCatalogEntry;
  /**
   * Withdraw every capability claim for a connection, after an edit that changed
   * the endpoint, credential, model default or headers those claims were observed
   * against. Availability (`available`) survives; `capable` does not.
   */
  downgradeCapabilities(connectionId: string): void;
  getWorkspaceDefault(workspaceId: string): ModelWorkspaceDefault | undefined;
  setWorkspaceDefault(value: ModelWorkspaceDefault): void;
  clearWorkspaceDefault(workspaceId: string): boolean;
  listRoleBindings(workspaceId: string): readonly ModelRoleBinding[];
  getRoleBinding(workspaceId: string, role: ModelRole): ModelRoleBinding | undefined;
  setRoleBinding(binding: ModelRoleBinding): ModelRoleBinding;
  clearRoleBinding(workspaceId: string, role: ModelRole): boolean;
}

export type ModelConfigRepositoryPort = AsyncRepository<ModelConfigRepositoryPortDefinition>;

/**
 * Application-owned model configuration and role resolution.
 *
 * Resolution is a decision, not a lookup: it returns the target, where it came
 * from and what was skipped, so an operator can see why a task went where it
 * did. Missing configuration is a typed `NOT_CONFIGURED` error raised **before**
 * dispatch, never a silent fallback to another provider.
 */
type ModelConfigPortDefinition = {
  listConnections(): readonly ModelConnection[];
  getConnection(connectionId: string): ModelConnection;
  putConnection(input: ModelConnectionInput): ModelConnection;
  removeConnection(connectionId: string): void;
  /**
   * Move a connection to a different credential binding.
   *
   * Rebinding is a separate operation because it is a decision with
   * consequences: the previous binding may be referenced by a service manager
   * unit or a rotation policy, so it must be stated explicitly rather than
   * arriving as a side effect of an ordinary edit.
   */
  rebindCredential(input: { readonly connectionId: string; readonly credentialRef: string }): ModelConnection;
  /** Turn PDF input on for a connection whose PDF probe passed (`tavi models probe --pdf`); never for an endpoint that drops files. */
  confirmPdfInput(input: { readonly connectionId: string; readonly expectedUpdatedAt?: string }): ModelConnection;
  /**
   * Native video on or off for one model of a connection. On only once the
   * owner confirmed `videoDisclosure`, for a model its catalog or a probe says reads video, on a connection whose
   * endpoint ever takes one; never for a provider-managed connection.
   */
  setVideoModel(input: {
    readonly connectionId: string;
    readonly modelId: string;
    readonly enabled: boolean;
    readonly disclosureConfirmed?: boolean;
  }): ModelConnection;
  /**
   * A video probe's verdict on a model's catalog row (`video-probed` set or cleared, every other token kept), only
   * if the connection is as it was probed (`expectedUpdatedAt`); `undefined` when it changed meanwhile.
   */
  recordVideoProbe(input: {
    readonly connectionId: string;
    readonly modelId: string;
    readonly passed: boolean;
    readonly expectedUpdatedAt: string;
  }): ModelCatalogEntry | undefined;
  listCatalog(connectionId: string): readonly ModelCatalogEntry[];
  putCatalogEntry(input: ModelCatalogEntryInput): ModelCatalogEntry;
  /** Replace a connection's whole catalog; the connection id comes from the call. */
  replaceCatalog(connectionId: string, entries: readonly ModelCatalogEntryInput[]): void;
  getWorkspaceDefault(workspaceId: string): ModelWorkspaceDefault | undefined;
  setWorkspaceDefault(input: { readonly workspaceId: string; readonly target: ModelTargetInput }): ModelWorkspaceDefault;
  clearWorkspaceDefault(workspaceId: string): void;
  listRoleBindings(workspaceId: string): readonly ModelRoleBinding[];
  setRoleBinding(input: {
    readonly workspaceId: string;
    readonly role: ModelRole;
    readonly target: ModelTargetInput;
    readonly fallback?: readonly ModelTargetInput[];
  }): ModelRoleBinding;
  clearRoleBinding(workspaceId: string, role: ModelRole): void;
  /**
   * Resolve the target for a role, or throw `NOT_CONFIGURED` /
   * `CAPABILITY_MISSING`.
   *
   * `requireCapabilities` is how a caller states what the work needs (for
   * example `tools`), so an unsuitable model is rejected before dispatch rather
   * than failing mid-run.
   */
  resolveRole(input: {
    readonly workspaceId: string;
    readonly role: ModelRole;
    readonly requireCapabilities?: readonly string[];
  }): ModelResolution;
};
export type ModelConfigPort = AsyncRepository<ModelConfigPortDefinition>;

/**
 * Input for creating or updating a connection; timestamps are service-owned.
 *
 * Updating merges: an omitted optional field keeps its stored value, so a partial
 * edit cannot silently wipe a default model or a header set. Clearing is explicit
 * — `null` means "remove it".
 */
export interface ModelConnectionInput {
  readonly connectionId: string;
  readonly label: string;
  readonly kind?: ProviderKind;
  readonly baseUrl: string;
  readonly credentialRef: string;
  readonly defaultModel?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly localOnly?: boolean;
  /**
   * `none` turns PDF input off; `openai-file` is accepted only where the
   * endpoint's preset takes PDFs: anywhere else it is turned on by
   * `confirmPdfInput`, after `tavi models probe --pdf` passes.
   */
  readonly pdfInput?: PdfInput;
  readonly pdfEngine?: PdfEngine | null;
  /** Omitted: the stored wire, else `chat`. */
  readonly wireApi?: WireApi;
  /** The stream deadlines, in seconds; `null` puts one back to its default. */
  readonly streamFirstByteSeconds?: number | null;
  readonly streamIdleSeconds?: number | null;
}

export interface ModelCatalogEntryInput {
  /** Optional on input: `replaceCatalog` takes the connection from its argument. */
  readonly connectionId?: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly provenance: ModelProvenance;
  readonly state?: ModelState;
  readonly capabilities?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly discoveredAt?: string;
}

/**
 * Model transport port.
 *
 * One generation per call. The adapter streams events and returns exactly one
 * terminal outcome; it never executes tools and never runs a multi-step loop —
 * LangGraph owns the agent loop and Tavi's dispatcher owns tool execution.
 */
export type ModelPort = {
  /** Host identity resolution before grant evaluation; never exposes a provider handle. */
  readonly resolveBinding?: (
    request: Pick<ModelRequest, "connectionId" | "model">,
    context: InvocationContext,
  ) => Promise<ProviderBindingReference>;
  /**
   * `onEvent` is called for every transport event in arrival order. It is not
   * awaited before the next event is produced, so a slow consumer must buffer
   * rather than block the transport.
   */
  stream(
    request: ModelRequest,
    options: {
      readonly signal: AbortSignal;
      readonly onEvent: (event: ModelEvent) => void;
      readonly context?: InvocationContext;
      readonly expectedBindingHash?: string;
      /**
       * `false`: the ledger keeps no copy of the request, only its usage: a
       * background memory call such as the idle
       * review, whose request is a chat's words read again. Absent:
       * kept as the workspace's `keptModelRequests` says.
       */
      readonly keepRequest?: false;
      /** Which caller this is, recorded on the attempt for `tavi doctor`'s per-site report; never part of the request. */
      readonly site?: ModelCallSite;
      /**
       * `1h`: a provider that caches only what is marked keeps this call's tools and system text for an hour
       * rather than five minutes — for a caller whose next call comes later than that but within the hour (a
       * heartbeat checking every 15 minutes). Never part of the request.
       */
      readonly cacheTtl?: "1h";
      /**
       * What ties calls that share a prefix but not a run — a heartbeat's ticks, each its own task — for the
       * provider's cache routing (`session_id`, `prompt_cache_key`). Absent: the run. Sent only as a digest.
       */
      readonly cacheKey?: string;
    },
  ): Promise<ModelOutcome>;
  /**
   * Texts to vectors on the request's connection and model: one
   * provider call, one terminal outcome. Absent on a transport that cannot
   * embed (an external language-model provider, most fixtures); the accounted
   * port then refuses with `CAPABILITY_MISSING`. Dispatch is checked as for
   * `stream` (binding hash, authorization, cancellation), the attempt is
   * recorded with purpose `embedding`, and the ledger keeps its usage, never
   * its texts.
   */
  readonly embed?: (
    request: ModelEmbedRequest,
    options: {
      readonly signal: AbortSignal;
      readonly context?: InvocationContext;
      readonly expectedBindingHash?: string;
    },
  ) => Promise<ModelEmbedOutcome>;
};
