import type { ModelConfigPort, ModelConfigRepositoryPort } from "../persistence/internal-contracts.js";
import {
  MODEL_ROLES,
  ModelCatalogEntrySchema,
  ModelConnectionSchema,
  ModelLifecycleEntrySchema,
  ModelTargetInputSchema,
  TaviError,
  assertSafeHeaders,
  normaliseBaseUrl,
  presetOf,
  presetPdfInput,
  presetVideoNever,
  readsVideo,
  videoDisclosure,
  withOwnedCapabilities,
  VIDEO_CATALOG_CAPABILITY,
  VIDEO_PROBED_CAPABILITY,
  type ModelCatalogEntry,
  type ModelCatalogEntryInput,
  type ModelConnection,
  type ModelConnectionInput,
  type ModelLifecycleEntry,
  type ModelResolution,
  type ModelRole,
  type ModelRoleBinding,
  type ModelSkip,
  type ModelTarget,
  type ModelTargetInput,
  type ModelWorkspaceDefault,
} from "@tavi/contracts";
import { definedOnly, errorMessage, nowTimestamp } from "@tavi/contracts/util";

export interface ModelConfigServiceOptions {
  readonly now?: () => string;
}

/**
 * Application-owned model configuration and role resolution.
 *
 * The service is the only place connection records are validated and the only
 * place a role is resolved. Three properties matter and are enforced here rather
 * than at the transport:
 *
 *  - **missing configuration is typed and early.** `resolveRole` throws
 *    `NOT_CONFIGURED` (or `CAPABILITY_MISSING`) before any model call, naming the
 *    workspace, the role and what was skipped, so a task cannot be sent to a
 *    provider the operator did not configure;
 *  - **credentials are references.** A connection stores an opaque reference and
 *    non-credential headers only. A credential header, or a value that looks like
 *    one under any name, is a validation failure rather than something silently
 *    stripped, and moving a binding is its own explicit operation;
 *  - **an update merges.** An omitted optional field keeps its stored value;
 *    clearing one is an explicit `null`.
 */
export class ModelConfigService implements ModelConfigPort {
  readonly #repository: ModelConfigRepositoryPort;
  readonly #now: () => string;

  constructor(repository: ModelConfigRepositoryPort, options: ModelConfigServiceOptions = {}) {
    this.#repository = repository;
    this.#now = options.now ?? nowTimestamp;
  }

  listConnections(): readonly ModelConnection[] {
    return this.#repository.listConnections();
  }

  getConnection(connectionId: string): ModelConnection {
    const found = this.#repository.getConnection(connectionId);
    if (found === undefined) {
      throw new TaviError("NOT_FOUND", `No model connection ${JSON.stringify(connectionId)} is configured`, {
        details: { connectionId },
      });
    }
    return found;
  }

  putConnection(input: ModelConnectionInput): ModelConnection {
    const existing = this.#repository.getConnection(input.connectionId);
    assertEditable(existing);
    const now = this.#now();

    if (existing !== undefined && existing.credentialRef !== input.credentialRef) {
      // Changing the binding is rebinding, not editing: the old reference may be
      // referenced by a service-manager unit, and a quiet swap would leave the
      // two out of step.
      throw new TaviError(
        "INVALID_INPUT",
        `Connection ${input.connectionId} is bound to credential ${existing.credentialRef}. ` +
          `Call rebindCredential to move it to ${input.credentialRef}; an ordinary update never rebinds.`,
        { details: { connectionId: input.connectionId } },
      );
    }

    // Merge semantics: an omitted optional field keeps its stored value, and an
    // explicit `null` clears one. A partial edit cannot silently wipe a default
    // model, a header set or the local-only flag.
    const defaultModel = input.defaultModel === undefined ? existing?.defaultModel : input.defaultModel;
    const headers = input.headers === undefined ? existing?.headers : input.headers;
    const localOnly = input.localOnly ?? existing?.localOnly ?? false;
    // PDF input: asked for, or kept while the endpoint stays the same, or what the endpoint's preset takes.
    const sameEndpoint = existing !== undefined && normaliseBaseUrl(existing.baseUrl) === normaliseBaseUrl(input.baseUrl);
    if (
      input.pdfInput === "openai-file" &&
      presetPdfInput(input.baseUrl) !== "openai-file" &&
      !(sameEndpoint && existing?.pdfInput === "openai-file")
    ) {
      throw new TaviError(
        "INVALID_INPUT",
        `Connection ${input.connectionId}'s endpoint is not known to take PDFs: run tavi models probe --pdf ${input.connectionId} to turn it on`,
        { details: { connectionId: input.connectionId } },
      );
    }
    const pdfInput = input.pdfInput ?? (sameEndpoint ? existing?.pdfInput : undefined) ?? presetPdfInput(input.baseUrl);
    // OpenRouter's engine belongs to its endpoint: it goes when the endpoint moves.
    const pdfEngine = input.pdfEngine === undefined ? (sameEndpoint ? existing?.pdfEngine : undefined) : input.pdfEngine;
    // Native video was confirmed for this endpoint's models: it goes when the endpoint moves, and only `setVideoModel` adds one.
    const videoModels = sameEndpoint ? existing?.videoModels : undefined;
    // The wire is the endpoint's: kept while unsaid and the endpoint the same (as PDF input is), and `chat` is stored as nothing.
    const wireApi = input.wireApi ?? (sameEndpoint ? existing?.wireApi : undefined);
    // The stream deadlines are the endpoint's pace: kept while unsaid and the endpoint the same, `null` back to the default.
    const streamFirstByteSeconds =
      input.streamFirstByteSeconds === undefined
        ? sameEndpoint
          ? existing?.streamFirstByteSeconds
          : undefined
        : input.streamFirstByteSeconds;
    const streamIdleSeconds =
      input.streamIdleSeconds === undefined ? (sameEndpoint ? existing?.streamIdleSeconds : undefined) : input.streamIdleSeconds;

    const parsed = ModelConnectionSchema.safeParse({
      connectionId: input.connectionId,
      label: input.label,
      // A new connection speaks what its preset does (Anthropic's own Messages API for Anthropic's endpoint); one
      // saved before keeps the kind it was saved with while its endpoint stays the same, until it is removed and
      // added again. An endpoint that moves takes the new one's kind, as its wire and PDF input do.
      kind: input.kind ?? (sameEndpoint ? existing?.kind : undefined) ?? presetOf(input.baseUrl)?.kind ?? "openai-compatible",
      baseUrl: input.baseUrl,
      credentialRef: input.credentialRef,
      localOnly,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(defaultModel === undefined || defaultModel === null ? {} : { defaultModel }),
      ...(headers === undefined || headers === null ? {} : { headers }),
      ...(pdfInput === undefined ? {} : { pdfInput }),
      ...(pdfEngine === undefined || pdfEngine === null ? {} : { pdfEngine }),
      ...(videoModels === undefined || videoModels.length === 0 ? {} : { videoModels }),
      ...(wireApi === undefined || wireApi === "chat" ? {} : { wireApi }),
      ...(streamFirstByteSeconds === undefined || streamFirstByteSeconds === null ? {} : { streamFirstByteSeconds }),
      ...(streamIdleSeconds === undefined || streamIdleSeconds === null ? {} : { streamIdleSeconds }),
    });
    if (!parsed.success) {
      throw new TaviError("INVALID_INPUT", `Invalid model connection: ${parsed.error.issues[0]?.message ?? "invalid"}`, {
        details: { connectionId: input.connectionId },
      });
    }
    assertEndpoint(parsed.data.baseUrl);
    assertHeaders(parsed.data.headers);

    const saved = this.#repository.upsertConnection(parsed.data);
    if (existing !== undefined && transportFactsChanged(existing, saved)) {
      // A capability claim belongs to the endpoint, model list and credential it
      // was observed against. Editing any of them makes the claim stale, so it is
      // withdrawn here instead of being silently reused for a different endpoint.
      this.#downgradeCapabilities(saved.connectionId, sameEndpoint);
    }
    return saved;
  }

  /**
   * PDF input on, for a connection whose probe passed (`tavi models probe --pdf`). An endpoint
   * whose preset says it drops file parts (Anthropic's compatibility layer) never takes it.
   */
  confirmPdfInput(input: { readonly connectionId: string; readonly expectedUpdatedAt?: string }): ModelConnection {
    const existing = this.getConnection(input.connectionId);
    assertEditable(existing);
    // The probe ran against the connection as it was: one edited meanwhile was not probed.
    if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) {
      throw new TaviError("CONFLICT", `Connection ${input.connectionId} changed while it was probed; probe it again`, {
        details: { connectionId: input.connectionId },
      });
    }
    if (presetOf(existing.baseUrl)?.pdfNever === true) {
      throw new TaviError(
        "UNSUPPORTED",
        `Connection ${input.connectionId}'s endpoint drops PDF file parts; PDFs reach it as text and rendered pages`,
        { details: { connectionId: input.connectionId } },
      );
    }
    return this.#repository.upsertConnection({ ...existing, pdfInput: "openai-file", updatedAt: this.#now() });
  }

  /**
   * Native video on or off for one of a connection's models: on only with the
   * disclosure confirmed, for a model whose catalog row says it reads video (the provider's catalog, or a passing
   * `tavi models probe --video`), never on an endpoint that takes none or a provider-managed connection. Off always.
   */
  setVideoModel(input: {
    readonly connectionId: string;
    readonly modelId: string;
    readonly enabled: boolean;
    readonly disclosureConfirmed?: boolean;
  }): ModelConnection {
    const existing = this.getConnection(input.connectionId);
    assertEditable(existing);
    const current = existing.videoModels ?? [];
    if (!input.enabled) {
      if (!current.includes(input.modelId)) return existing;
      const rest = current.filter((model) => model !== input.modelId);
      const { videoModels: _dropped, ...without } = existing;
      return this.#repository.upsertConnection({ ...without, ...(rest.length === 0 ? {} : { videoModels: rest }), updatedAt: this.#now() });
    }
    // Whether it can be on at all, before the person is asked to confirm anything.
    if (presetVideoNever(existing.baseUrl))
      throw new TaviError("UNSUPPORTED", `Connection ${input.connectionId}'s endpoint takes no video: chats on it see a video's frames`, {
        details: { connectionId: input.connectionId },
      });
    const row = this.#repository.listCatalog(input.connectionId).find((entry) => entry.modelId === input.modelId);
    if (row === undefined || !readsVideo(row.capabilities))
      throw new TaviError(
        "UNSUPPORTED",
        `Model ${input.modelId} on ${input.connectionId} is not known to read video: the provider's catalog does not say so (tavi models discover ${input.connectionId} reads it)`,
        { details: { connectionId: input.connectionId, modelId: input.modelId } },
      );
    if (current.includes(input.modelId)) return existing;
    const disclosure = videoDisclosure(presetOf(existing.baseUrl)?.name ?? existing.label, input.modelId);
    if (input.disclosureConfirmed !== true)
      throw new TaviError("INVALID_INPUT", `${disclosure} Confirm it to turn video on (tavi models video --yes).`, {
        details: { connectionId: input.connectionId, modelId: input.modelId, disclosure },
      });
    if (current.length >= 32)
      throw new TaviError("INVALID_INPUT", `Connection ${input.connectionId} has native video on for 32 models, the most`, {
        details: { connectionId: input.connectionId },
      });
    return this.#repository.upsertConnection({ ...existing, videoModels: [...current, input.modelId], updatedAt: this.#now() });
  }

  /** See `ModelConfigPort.recordVideoProbe`: one synchronous step, so no edit lands between the check and the write. */
  recordVideoProbe(input: {
    readonly connectionId: string;
    readonly modelId: string;
    readonly passed: boolean;
    readonly expectedUpdatedAt: string;
  }): ModelCatalogEntry | undefined {
    const connection = this.getConnection(input.connectionId);
    if (connection.updatedAt !== input.expectedUpdatedAt) return undefined;
    const before = this.#repository.listCatalog(input.connectionId).find((entry) => entry.modelId === input.modelId);
    return this.#repository.putCatalogEntry(
      this.#parseCatalogEntry(input.connectionId, {
        connectionId: input.connectionId,
        modelId: input.modelId,
        provenance: before?.provenance ?? "live",
        state: before?.state ?? "available",
        capabilities: withOwnedCapabilities(
          before?.capabilities ?? [],
          [VIDEO_PROBED_CAPABILITY],
          input.passed ? [VIDEO_PROBED_CAPABILITY] : [],
        ),
        ...(before?.displayName === undefined ? {} : { displayName: before.displayName }),
        ...(before?.contextWindow === undefined ? {} : { contextWindow: before.contextWindow }),
        ...(before?.maxTokens === undefined ? {} : { maxTokens: before.maxTokens }),
        ...(before?.discoveredAt === undefined ? {} : { discoveredAt: before.discoveredAt }),
      }),
    );
  }

  /**
   * Move a connection to a different credential binding.
   *
   * This is the supported path the ordinary update points at: rebinding is a
   * deliberate operation with instructions, not a field edit.
   */
  rebindCredential(input: { readonly connectionId: string; readonly credentialRef: string }): ModelConnection {
    const existing = this.getConnection(input.connectionId);
    assertEditable(existing);
    const parsed = ModelConnectionSchema.safeParse({
      ...existing,
      credentialRef: input.credentialRef,
      updatedAt: this.#now(),
    });
    if (!parsed.success) {
      throw new TaviError("INVALID_INPUT", `Invalid credential reference: ${parsed.error.issues[0]?.message ?? "invalid"}`, {
        details: { connectionId: input.connectionId },
      });
    }
    const saved = this.#repository.upsertConnection(parsed.data);
    // Rebinding is a transport change: what a previous test observed about this
    // connection no longer describes it.
    this.#downgradeCapabilities(saved.connectionId, true);
    return saved;
  }

  /**
   * A transport change's withdrawal of capability claims, but for what a
   * model is, not what a test saw: on the same endpoint, the catalog's and a
   * probe's video tokens stay with the video models they qualify;
   * where the endpoint moved, they go
   * with them.
   */
  #downgradeCapabilities(connectionId: string, sameEndpoint: boolean): void {
    const kept = sameEndpoint ? this.#repository.listCatalog(connectionId).filter((entry) => readsVideo(entry.capabilities)) : [];
    this.#repository.downgradeCapabilities(connectionId);
    for (const entry of kept) {
      const after = this.#repository.listCatalog(connectionId).find((row) => row.modelId === entry.modelId);
      if (after === undefined) continue;
      this.#repository.putCatalogEntry({
        ...after,
        capabilities: withOwnedCapabilities(after.capabilities, VIDEO_CAPABILITIES, entry.capabilities),
      });
    }
  }

  removeConnection(connectionId: string): void {
    const existing = this.#repository.getConnection(connectionId);
    if (existing === undefined) {
      throw new TaviError("NOT_FOUND", `No model connection ${JSON.stringify(connectionId)} is configured`, {
        details: { connectionId },
      });
    }
    assertEditable(existing);
    // A connection that a role or a default still names must not vanish
    // underneath it: the operator would otherwise discover the hole at the
    // next task instead of here. Its own discovered models go with it.
    if (this.#repository.referencedConnectionIds().includes(connectionId)) {
      throw new TaviError(
        "CONFLICT",
        `Connection ${connectionId} is still used by a model role or a workspace default: point them at another model first`,
        { details: { connectionId } },
      );
    }
    this.#repository.deleteConnection(connectionId);
  }

  listCatalog(connectionId: string): readonly ModelCatalogEntry[] {
    this.getConnection(connectionId);
    return this.#repository.listCatalog(connectionId);
  }

  putCatalogEntry(input: ModelCatalogEntryInput): ModelCatalogEntry {
    if (input.connectionId === undefined) {
      throw new TaviError("INVALID_INPUT", "A catalog entry needs a connection id");
    }
    this.getConnection(input.connectionId);
    return this.#repository.putCatalogEntry(this.#parseCatalogEntry(input.connectionId, input));
  }

  /**
   * Replace a connection's catalog.
   *
   * Every entry is validated first and the write happens once, inside the
   * repository's transaction: a rejected entry leaves the previous catalog
   * exactly as it was, rather than a merge of the old and the requested one.
   */
  replaceCatalog(connectionId: string, entries: readonly ModelCatalogEntryInput[]): void {
    this.getConnection(connectionId);
    const parsed = entries.map((entry, index) => this.#parseCatalogEntry(connectionId, entry, index));
    this.#repository.replaceCatalog(connectionId, parsed);
  }

  listModelLifecycle(): readonly ModelLifecycleEntry[] {
    return this.#repository.listLifecycle();
  }

  /** Every entry is validated, and must be the connection's own, before the connection's lifecycles are replaced. */
  replaceModelLifecycle(connectionId: string, entries: readonly ModelLifecycleEntry[]): void {
    this.getConnection(connectionId);
    const parsed = entries.map((entry, index) => {
      const result = ModelLifecycleEntrySchema.safeParse(entry);
      if (!result.success)
        throw new TaviError("INVALID_INPUT", `Lifecycle entry ${index} is not valid: ${result.error.issues[0]?.message ?? "invalid"}`, {
          details: { connectionId, index },
        });
      if (result.data.connectionId !== connectionId)
        throw new TaviError("INVALID_INPUT", `Lifecycle entry ${index} belongs to ${result.data.connectionId}, not ${connectionId}`, {
          details: { connectionId, index },
        });
      return result.data;
    });
    const repeated = parsed.find((entry, index) => parsed.findIndex((other) => other.modelId === entry.modelId) !== index);
    if (repeated !== undefined)
      throw new TaviError("INVALID_INPUT", `Lifecycle entries name ${repeated.modelId} more than once`, {
        details: { connectionId, modelId: repeated.modelId },
      });
    this.#repository.replaceLifecycle(connectionId, parsed);
  }

  getWorkspaceDefault(workspaceId: string): ModelWorkspaceDefault | undefined {
    return this.#repository.getWorkspaceDefault(workspaceId);
  }

  setWorkspaceDefault(input: { readonly workspaceId: string; readonly target: ModelTargetInput }): ModelWorkspaceDefault {
    const value: ModelWorkspaceDefault = {
      workspaceId: input.workspaceId,
      target: this.#resolveTarget(input.target, input.workspaceId),
      updatedAt: this.#now(),
    };
    this.#repository.setWorkspaceDefault(value);
    return value;
  }

  clearWorkspaceDefault(workspaceId: string): void {
    this.#repository.clearWorkspaceDefault(workspaceId);
  }

  listRoleBindings(workspaceId: string): readonly ModelRoleBinding[] {
    return this.#repository.listRoleBindings(workspaceId);
  }

  setRoleBinding(input: {
    readonly workspaceId: string;
    readonly role: ModelRole;
    readonly target: ModelTargetInput;
    readonly fallback?: readonly ModelTargetInput[];
  }): ModelRoleBinding {
    const fallbackInput = [...(input.fallback ?? [])];
    if (fallbackInput.length > 3) {
      throw new TaviError("INVALID_INPUT", "At most three fallback targets are allowed", {
        details: { role: input.role },
      });
    }
    const targets = [
      this.#resolveTarget(input.target, input.workspaceId),
      ...fallbackInput.map((candidate) => this.#resolveTarget(candidate, input.workspaceId)),
    ];

    // A fallback chain is an ordered decision. A duplicate entry would silently
    // become a second attempt at the same provider, which is a retry, not a
    // fallback.
    const seen = new Set<string>();
    for (const target of targets) {
      const key = `${target.connectionId}\u0000${target.model}`;
      if (seen.has(key)) {
        throw new TaviError("INVALID_INPUT", `Duplicate target ${target.connectionId}/${target.model} in the chain`, {
          details: { role: input.role },
        });
      }
      seen.add(key);
    }

    const [primary, ...fallback] = targets;
    if (primary === undefined) throw new TaviError("INVALID_INPUT", "A role binding needs a target");
    const binding: ModelRoleBinding = {
      workspaceId: input.workspaceId,
      role: input.role,
      target: primary,
      fallback,
      updatedAt: this.#now(),
    };
    this.#repository.setRoleBinding(binding);
    return binding;
  }

  clearRoleBinding(workspaceId: string, role: ModelRole): void {
    this.#repository.clearRoleBinding(workspaceId, role);
  }

  /**
   * Resolve the target for a role.
   *
   * Order: a role override, then the workspace default (never for
   * `embedding`, which only its own binding resolves), then a typed refusal. Every candidate is checked against the catalog, so a model
   * known to be unavailable, or one that lacks a capability the caller declared
   * it needs, is skipped with a recorded reason instead of being dispatched to.
   * The connection record travels with the resolution, so a caller needs no
   * second lookup to use it.
   */
  resolveRole(input: {
    readonly workspaceId: string;
    readonly role: ModelRole;
    readonly requireCapabilities?: readonly string[];
  }): ModelResolution {
    if (!(MODEL_ROLES as readonly string[]).includes(input.role)) {
      throw new TaviError("INVALID_INPUT", `Unknown model role ${JSON.stringify(input.role)}`, {
        details: { role: input.role },
      });
    }

    const binding = this.#repository.getRoleBinding(input.workspaceId, input.role);
    // Embedding is a different kind of model: a chat model as its default would only fail, so only its own binding counts.
    if (binding === undefined && input.role === "embedding") {
      throw new TaviError(
        "NOT_CONFIGURED",
        `No embedding model is bound in workspace ${input.workspaceId}. ` +
          "Bind one with `tavi models set-role embedding --connection <id> --model <id>`.",
        { details: { workspaceId: input.workspaceId, role: input.role } },
      );
    }
    const workspaceDefault = this.#repository.getWorkspaceDefault(input.workspaceId);
    const source = binding !== undefined ? "role-override" : "workspace-default";
    const chain: readonly ModelTarget[] =
      binding !== undefined ? [binding.target, ...binding.fallback] : workspaceDefault !== undefined ? [workspaceDefault.target] : [];

    if (chain.length === 0) {
      throw new TaviError(
        "NOT_CONFIGURED",
        `No model is configured for role ${input.role} in workspace ${input.workspaceId}. ` +
          `Set a role binding or a workspace default before running this task.`,
        { details: { workspaceId: input.workspaceId, role: input.role } },
      );
    }

    const required = input.requireCapabilities ?? [];
    const skipped: ModelSkip[] = [];
    for (let index = 0; index < chain.length; index += 1) {
      const target = chain[index];
      if (target === undefined) continue;
      const connection = this.#repository.getConnection(target.connectionId);
      if (
        connection === undefined ||
        (connection.providerBinding !== undefined && connection.providerBinding.workspaceId !== input.workspaceId)
      ) {
        skipped.push({ target, reason: "missing-connection" });
        continue;
      }
      const entry = this.#repository.listCatalog(target.connectionId).find((candidate) => candidate.modelId === target.model);
      if (entry !== undefined && entry.state === "unavailable") {
        skipped.push({ target, reason: "unavailable-model" });
        continue;
      }
      if (required.length > 0 && entry !== undefined) {
        // A model the operator typed (no catalog row) is permitted by design;
        // once the catalog knows the model, its declared capabilities are what
        // this check uses.
        const declared = new Set(entry.capabilities);
        if (required.some((capability) => !declared.has(capability))) {
          skipped.push({ target, reason: "capability-missing" });
          continue;
        }
      }
      return {
        workspaceId: input.workspaceId,
        role: input.role,
        target,
        connection,
        source,
        skipped,
        fallback: chain.slice(index + 1),
        localOnly: connection.localOnly,
      };
    }

    if (required.length > 0) {
      throw new TaviError(
        "CAPABILITY_MISSING",
        `No configured target for role ${input.role} declares the required capabilities ` +
          `(${required.join(", ")}); ${describe(skipped)}`,
        {
          details: {
            workspaceId: input.workspaceId,
            role: input.role,
            requiredCapabilities: required,
            skipped: skipped.map((skip) => skip.reason),
          },
        },
      );
    }
    throw new TaviError("NOT_CONFIGURED", `Every configured target for role ${input.role} is unusable: ${describe(skipped)}`, {
      details: {
        workspaceId: input.workspaceId,
        role: input.role,
        skipped: skipped.map((skip) => skip.reason),
      },
    });
  }

  /** Resolve an operator-supplied target to a concrete connection/model pair. */
  #resolveTarget(target: ModelTargetInput, workspaceId: string): ModelTarget {
    const parsed = ModelTargetInputSchema.safeParse(target);
    if (!parsed.success) {
      throw new TaviError("INVALID_INPUT", `Invalid model target: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    const connection = this.getConnection(parsed.data.connectionId);
    if (connection.providerBinding !== undefined && connection.providerBinding.workspaceId !== workspaceId)
      throw new TaviError("NOT_AUTHORIZED", "Provider connection belongs to another workspace");
    const model = parsed.data.model ?? connection.defaultModel;
    if (model === undefined || model.trim() === "") {
      throw new TaviError(
        "NOT_CONFIGURED",
        `Connection ${connection.connectionId} has no default model, so a target must name one explicitly`,
        { details: { connectionId: connection.connectionId } },
      );
    }
    return { connectionId: connection.connectionId, model };
  }

  #parseCatalogEntry(connectionId: string, input: ModelCatalogEntryInput, index?: number): ModelCatalogEntry {
    const parsed = ModelCatalogEntrySchema.safeParse({
      connectionId,
      modelId: input.modelId,
      provenance: input.provenance,
      state: input.state ?? "available",
      capabilities: input.capabilities ?? [],
      ...definedOnly({
        displayName: input.displayName,
        contextWindow: input.contextWindow,
        maxTokens: input.maxTokens,
        discoveredAt: input.discoveredAt,
      }),
    });
    if (!parsed.success) {
      const where = index === undefined ? "" : ` at index ${index}`;
      throw new TaviError("INVALID_INPUT", `Invalid catalog entry${where}: ${parsed.error.issues[0]?.message ?? "invalid"}`, {
        details: { connectionId, modelId: input.modelId },
      });
    }
    return parsed.data;
  }
}

/**
 * Whether an edit changed the facts a capability observation depends on.
 *
 * `label` is deliberately excluded: renaming a connection does not invalidate
 * what was measured, and treating it as a change would throw away evidence for a
 * cosmetic edit.
 */
/** The tokens that say a model reads video, which a same-endpoint transport change keeps. */
const VIDEO_CAPABILITIES: readonly string[] = [VIDEO_CATALOG_CAPABILITY, VIDEO_PROBED_CAPABILITY];

function transportFactsChanged(before: ModelConnection, after: ModelConnection): boolean {
  return (
    before.kind !== after.kind ||
    before.baseUrl !== after.baseUrl ||
    before.credentialRef !== after.credentialRef ||
    before.defaultModel !== after.defaultModel ||
    JSON.stringify(before.headers ?? {}) !== JSON.stringify(after.headers ?? {})
  );
}

function describe(skipped: readonly ModelSkip[]): string {
  if (skipped.length === 0) return "no candidate was configured";
  return skipped.map((skip) => `${skip.target.connectionId}/${skip.target.model}: ${skip.reason}`).join(", ");
}

/** An endpoint must be an absolute http(s) URL and must not embed credentials. */
function assertEndpoint(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TaviError("INVALID_INPUT", `Model endpoint ${JSON.stringify(baseUrl)} is not an absolute URL`, {
      details: { baseUrl },
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TaviError("INVALID_INPUT", `Model endpoint must use http or https, not ${url.protocol}`, {
      details: { baseUrl },
    });
  }
  if (url.username !== "" || url.password !== "") {
    // Credentials in a URL end up in logs, diagnostics and error messages.
    throw new TaviError("INVALID_INPUT", "Model endpoint must not embed credentials; use a credential reference", {
      details: { baseUrl: `${url.origin}${url.pathname}` },
    });
  }
}

function assertHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  try {
    assertSafeHeaders(headers);
  } catch (error) {
    throw new TaviError("INVALID_INPUT", errorMessage(error));
  }
}

function assertEditable(connection: ModelConnection | undefined): void {
  if (connection?.providerBinding !== undefined)
    throw new TaviError("CONFLICT", "Provider-managed connections are configured through their plugin instance");
}
