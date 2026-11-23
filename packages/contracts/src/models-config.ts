import { z } from "zod";

import { IdSchema, SECRET_KEY_REF_PATTERN, TimestampSchema } from "./ids.js";
import { canvasCoreEnglish, type CanvasCoreT } from "./locales/core-canvas.js";

/**
 * User-configured model connections, catalog and role bindings.
 *
 * These records are application-owned: nothing here is an AI SDK object, and the
 * secret material is only ever an opaque reference resolved by the secret layer.
 * These rules are enforced at this boundary rather than at call time:
 *
 *  - several named connections, including several accounts at one provider;
 *  - presets plus custom endpoints, and no cloud key required for local use;
 *  - catalog/manual/live provenance with `available` and `capable` kept separate;
 *  - workspace defaults and per-role overrides with an explicit ordered fallback;
 *  - typed missing-configuration errors before dispatch, so a task is never
 *    silently sent somewhere the operator did not configure.
 */

/**
 * Role slots a workspace resolves: `main`, `extraction` and `compaction`,
 * plus `fast` — a cheaper, quicker target for work that does not need
 * `main` — and `embedding`, a model that turns text into vectors. Adding one
 * is a contract change *and* a schema change: `tavi_model_roles.role` is
 * pinned by a CHECK constraint.
 */
export const MODEL_ROLES = ["main", "extraction", "compaction", "fast", "embedding"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Provider kinds. `openai-compatible` covers cloud APIs and local servers that
 * speak the same protocol, which is why `baseUrl` is always explicit.
 */
/**
 * How Tavi talks to a connection: `openai-compatible` (Chat Completions or the
 * Responses API) for most, `anthropic-messages` for Anthropic's own Messages
 * API, which takes prompt-cache breakpoints and returns thinking blocks that
 * its compatibility layer does not.
 */
export const PROVIDER_KINDS = ["openai-compatible", "anthropic-messages"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * Which of OpenAI's two APIs a connection speaks: `chat` (Chat
 * Completions, what every OpenAI-compatible server implements, and the
 * default) or `responses` (`POST /v1/responses`), which Sign in with ChatGPT
 * requires. A wire, not a kind: the endpoint, its key handling and its models
 * are OpenAI's either way.
 */
export const WIRE_APIS = ["chat", "responses"] as const;
export type WireApi = (typeof WIRE_APIS)[number];

/** Setup suggestions, not an allowlist. Endpoints/docs verified 2026-09-20. */
export interface ModelProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  /** Empty for Custom: the operator must supply an endpoint. */
  readonly baseUrl: string;
  readonly requiresKey: boolean;
  readonly localOnly: boolean;
  readonly docsUrl: string;
  /** Where a person creates a key, for a provider that takes one: what "create a key" links to (`keyPageOf`). */
  readonly keysUrl?: string;
  readonly note?: string;
  /** How the endpoint takes a PDF, unasked: absent, it takes none until `tavi models probe --pdf` passes. */
  readonly pdfInput?: "openai-file";
  /** It never takes one, whatever a probe says: it drops file parts silently. */
  readonly pdfNever?: true;
  /** It never takes a video, whatever a catalog or a probe says: its Chat Completions take none. */
  readonly videoNever?: true;
  /**
   * What its prompt cache takes beyond a plain request (`promptCacheOf`): a
   * preset without it — Gemini's compatibility layer, the local servers, a
   * custom endpoint — is sent no provider-specific cache field, which it may refuse.
   */
  readonly promptCache?: PromptCacheCapabilities;
}

/** A provider's prompt-cache extensions, by preset. */
export interface PromptCacheCapabilities {
  /**
   * `cache_control` breakpoints for the models that cache only what is marked:
   * an `anthropic/…` model (up to four) and a `google/…` one (the last only).
   */
  readonly breakpoints?: true;
  /** A `session_id` that keeps a chat's calls on one provider, so its cache is the one read (OpenRouter's sticky routing). */
  readonly sessionId?: true;
  /** A `prompt_cache_key` that routes a chat's calls to the same cache (OpenAI). */
  readonly promptCacheKey?: true;
}
/** The `core` key of each preset's note, by preset id. */
const PRESET_NOTE_KEYS = {
  anthropic: "model.preset.note.anthropic",
  ollama: "model.preset.note.ollama",
  lmstudio: "model.preset.note.lmstudio",
  custom: "model.preset.note.custom",
} as const;

/** What a preset's setup says about it beyond its name, in the reader's language; undefined when it says nothing. */
export function presetNote(preset: Pick<ModelProviderPreset, "id" | "note">, t: CanvasCoreT = canvasCoreEnglish): string | undefined {
  const key = Object.hasOwn(PRESET_NOTE_KEYS, preset.id) ? PRESET_NOTE_KEYS[preset.id as keyof typeof PRESET_NOTE_KEYS] : undefined;
  return key === undefined ? preset.note : t(key);
}

/** Where to create a key for `preset`: its keys page, or its documentation when it names none. */
export function keyPageOf(preset: Pick<ModelProviderPreset, "docsUrl" | "keysUrl">): string {
  return preset.keysUrl ?? preset.docsUrl;
}

export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    requiresKey: true,
    localOnly: false,
    docsUrl: "https://openrouter.ai/docs/api_reference/overview",
    keysUrl: "https://openrouter.ai/settings/keys",
    pdfInput: "openai-file",
    promptCache: { breakpoints: true, sessionId: true },
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    requiresKey: true,
    localOnly: false,
    docsUrl: "https://developers.openai.com/api/reference/overview",
    keysUrl: "https://platform.openai.com/api-keys",
    pdfInput: "openai-file",
    videoNever: true,
    promptCache: { promptCacheKey: true },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    requiresKey: true,
    localOnly: false,
    docsUrl: "https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk",
    keysUrl: "https://platform.claude.com/settings/keys",
    pdfNever: true,
    videoNever: true,
    note: canvasCoreEnglish("model.preset.note.anthropic"),
  },
  {
    id: "gemini",
    name: "Gemini",
    kind: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    requiresKey: true,
    localOnly: false,
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    keysUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    requiresKey: false,
    localOnly: true,
    docsUrl: "https://docs.ollama.com/api/openai-compatibility",
    note: canvasCoreEnglish("model.preset.note.ollama"),
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    requiresKey: false,
    localOnly: true,
    docsUrl: "https://lmstudio.ai/docs/developer/openai-compat",
    note: canvasCoreEnglish("model.preset.note.lmstudio"),
  },
  {
    id: "custom",
    name: "Custom",
    kind: "openai-compatible",
    baseUrl: "",
    requiresKey: true,
    localOnly: false,
    docsUrl: "https://developers.openai.com/api/reference/overview",
    note: canvasCoreEnglish("model.preset.note.custom"),
  },
];

/**
 * How a connection takes a PDF a tool hands the model: `none`, or a Chat
 * Completions `file` part. Off unless the
 * endpoint's preset says so or `tavi models probe --pdf` passed.
 */
export const PDF_INPUTS = ["none", "openai-file"] as const;
export type PdfInput = (typeof PDF_INPUTS)[number];

/** OpenRouter's `file-parser` engines: how it turns a PDF into what the model reads. */
export const PDF_ENGINES = ["pdf-text", "mistral-ocr", "native"] as const;
export type PdfEngine = (typeof PDF_ENGINES)[number];

/** A base URL as endpoints are compared: trimmed, its scheme and host lower-cased, without trailing slashes. */
export function normaliseBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const parts = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/i.exec(trimmed);
  return parts === null ? trimmed : `${(parts[1] ?? "").toLowerCase()}${(parts[2] ?? "").toLowerCase()}${parts[3] ?? ""}`;
}

/** The preset an endpoint is, by its base URL (`normaliseBaseUrl`); undefined for any other. */
export function presetOf(baseUrl: string): ModelProviderPreset | undefined {
  const normalised = normaliseBaseUrl(baseUrl);
  return MODEL_PROVIDER_PRESETS.find((preset) => preset.baseUrl !== "" && normaliseBaseUrl(preset.baseUrl) === normalised);
}

/** What an endpoint's prompt cache takes beyond a plain request, by its preset; none for an unknown endpoint. */
export function promptCacheOf(baseUrl: string): PromptCacheCapabilities {
  return presetOf(baseUrl)?.promptCache ?? {};
}

/** Whether an endpoint never takes a video, by its preset. */
export function presetVideoNever(baseUrl: string): boolean {
  return presetOf(baseUrl)?.videoNever === true;
}

/**
 * The capability tokens that say a model reads video: the
 * provider's catalog sets and clears `video` on every discovery; a passing
 * `tavi models probe --video` writes `video-probed`, which only a failing
 * re-probe clears. Each writer replaces only the tokens it owns.
 */
export const VIDEO_CATALOG_CAPABILITY = "video";
export const VIDEO_PROBED_CAPABILITY = "video-probed";

/** `existing` with the tokens `owned` replaced by `next`'s: what one writer of a catalog row's capabilities may change. */
export function withOwnedCapabilities(existing: readonly string[], owned: readonly string[], next: readonly string[]): string[] {
  return [...new Set([...existing.filter((token) => !owned.includes(token)), ...next.filter((token) => owned.includes(token))])];
}

/** Whether a catalog row says the model reads video: its catalog or a probe. */
export function readsVideo(capabilities: readonly string[]): boolean {
  return capabilities.includes(VIDEO_CATALOG_CAPABILITY) || capabilities.includes(VIDEO_PROBED_CAPABILITY);
}

/** What the owner confirms before a model gets video input: the whole clip goes to the provider, each time. */
export function videoDisclosure(provider: string, model: string, t: CanvasCoreT = canvasCoreEnglish): string {
  return t("model.video.disclosure", { provider, model });
}

/** What a connection to `baseUrl` takes unasked: its preset's PDF input, or none. */
export function presetPdfInput(baseUrl: string): PdfInput {
  return presetOf(baseUrl)?.pdfInput ?? "none";
}

/**
 * What a keyless local preset's credential binding holds (`ollama`,
 * `lmstudio`): discovery and the adapter resolve a stored credential, and the
 * local server ignores it.
 */
export const LOCAL_NO_KEY_CREDENTIAL = "local-no-key";

/** Connection ids appear in logs, URLs and CLI arguments, so they are slug-safe. */
export const CONNECTION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/**
 * Credential references are opaque registered bindings.
 *
 * A reference is never a filesystem path or an environment-variable name chosen
 * by a model; the secret layer decides what a reference resolves to. One pattern
 * is shared with the secret layer so a reference valid in configuration is valid
 * at resolution time.
 */
export const CREDENTIAL_REF_PATTERN = SECRET_KEY_REF_PATTERN;

/** Headers that must never come from stored, model-visible configuration. */
export const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "api-key"] as const;

/** Bound on stored non-credential headers, so the row cannot become a blob store. */
export const MAX_CONNECTION_HEADERS = 16;

/**
 * Values that are credentials regardless of the header name carrying them.
 *
 * The name check alone is not enough: `x-custom: "Bearer sk-live-…"` would be
 * written to the settings database, which must never hold a credential. The
 * patterns are deliberately conservative — a false positive costs an operator one
 * edit, a false negative persists a live secret in `tavi.sqlite` and every backup
 * of it.
 */
export const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /^\s*bearer\s+\S+/i,
  /^\s*basic\s+[A-Za-z0-9+/=]{8,}\s*$/i,
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr|glpat|xox[baprs]|npm)_?-[A-Za-z0-9_-]{8,}/,
  /\bAKIA[0-9A-Z]{12,}\b/,
];

/** The longest a connection's stream deadline may be set to: an hour, past which a stall is not caught at all. */
export const MAX_STREAM_TIMEOUT_SECONDS = 3600;
/** A connection's stream deadline, in whole seconds. */
export const StreamTimeoutSecondsSchema = z.number().int().min(1).max(MAX_STREAM_TIMEOUT_SECONDS);
/** A provider stream's deadlines when its connection sets none: to first output (a reasoning call's own), and between chunks. */
export const STREAM_FIRST_BYTE_SECONDS = 60;
export const STREAM_REASONING_FIRST_BYTE_SECONDS = 180;
export const STREAM_IDLE_SECONDS = 90;
/**
 * A local server's first-output deadline when its connection sets none: it reads the whole prompt before its first
 * byte, at a few hundred tokens a second on a desktop GPU, so a turn's tools and history take minutes.
 */
export const STREAM_LOCAL_FIRST_BYTE_SECONDS = 600;

export const ModelConnectionSchema = z.object({
  /** Host projection of an approved provider instance; edited through plugin configuration. */
  providerBinding: z
    .object({
      instanceId: z.string().min(1).max(256),
      workspaceId: IdSchema,
      principalId: IdSchema,
      bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  connectionId: z.string().min(1).max(64).regex(CONNECTION_ID_PATTERN, "connection id must be a lowercase slug"),
  /** Operator-facing name; several connections may point at one provider. */
  label: z.string().min(1).max(120),
  kind: z.enum(PROVIDER_KINDS),
  /** Explicit endpoint. There is no ambient or gateway default. */
  baseUrl: z.string().min(1).max(500),
  /** Opaque binding resolved by the secret layer, never a secret value. */
  credentialRef: z.string().min(1).max(128).regex(CREDENTIAL_REF_PATTERN, "credential ref must be a slug"),
  defaultModel: z.string().min(1).max(256).optional(),
  /** Non-credential headers only; see `CREDENTIAL_HEADERS`. */
  headers: z.record(z.string().min(1).max(64), z.string().max(500)).optional(),
  /**
   * Declares that the endpoint is operator-controlled local infrastructure.
   *
   * The access layer's local-only policy does not exist yet; this flag is the
   * fact it will use, recorded here so nothing has to guess locality from a
   * provider name later.
   */
  localOnly: z.boolean(),
  /** How a PDF a tool hands the model reaches it: stored, or, when nothing is stored, its endpoint's preset's. */
  pdfInput: z.enum(PDF_INPUTS).optional(),
  /** OpenRouter's `file-parser` engine for those PDFs; absent, OpenRouter's own choice. */
  pdfEngine: z.enum(PDF_ENGINES).optional(),
  /** The models on this connection the owner turned native video on for, after its disclosure. */
  videoModels: z.array(z.string().min(1).max(256)).max(32).optional(),
  /** Absent: `chat`. `responses` for a ChatGPT sign-in's connection. */
  wireApi: z.enum(WIRE_APIS).optional(),
  /**
   * How long a call waits for the provider's first output before it fails over, in seconds. Absent: 60, or 180 for a
   * call that reasons first (`STREAM_FIRST_BYTE_SECONDS`), or 600 for a server on this computer.
   */
  streamFirstByteSeconds: StreamTimeoutSecondsSchema.optional(),
  /** How long a streaming reply may go quiet between chunks before it fails over, in seconds. Absent: 90. */
  streamIdleSeconds: StreamTimeoutSecondsSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ModelConnection = z.infer<typeof ModelConnectionSchema>;

/** A model the connection offers, and where that knowledge came from. */
export const MODEL_PROVENANCE = ["catalog", "manual", "live"] as const;
export type ModelProvenance = (typeof MODEL_PROVENANCE)[number];

/**
 * `available` means the connection lists it; `capable` means a qualified probe
 * succeeded. They are separate states because a listed model can still be
 * unusable for the tools/streaming this application needs.
 */
export const MODEL_STATES = ["available", "capable", "unavailable"] as const;
export type ModelState = (typeof MODEL_STATES)[number];

export const ModelCatalogEntrySchema = z.object({
  connectionId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(256).optional(),
  provenance: z.enum(MODEL_PROVENANCE),
  state: z.enum(MODEL_STATES),
  /** Capability tokens the probe verified, e.g. `tools`, `streaming`. */
  capabilities: z
    .array(z.string().min(1).max(64))
    .max(32)
    .default(() => []),
  /** The largest request plus response the model takes, in tokens, when the listing disclosed it. */
  contextWindow: z.number().int().positive().optional(),
  /** The most output tokens one response may hold, when the listing disclosed it. */
  maxTokens: z.number().int().positive().optional(),
  discoveredAt: TimestampSchema.optional(),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

/** One candidate in an ordered fallback chain, as stored and resolved. */
export const ModelTargetSchema = z.object({
  connectionId: z.string().min(1).max(64),
  model: z.string().min(1).max(256),
});
export type ModelTarget = z.infer<typeof ModelTargetSchema>;

/**
 * A target as an operator supplies it.
 *
 * The model may be omitted, in which case the connection's `defaultModel` is
 * used — that is the only reader of that field, and it keeps a role binding from
 * having to repeat the model on every workspace.
 */
export const ModelTargetInputSchema = z.object({
  connectionId: z.string().min(1).max(64),
  model: z.string().min(1).max(256).optional(),
});
export type ModelTargetInput = z.infer<typeof ModelTargetInputSchema>;

/** A role binding: the target to try first and the explicit ordered fallback. */
export const ModelRoleBindingSchema = z.object({
  workspaceId: IdSchema,
  role: z.enum(MODEL_ROLES),
  target: ModelTargetSchema,
  /** At most three: an ordered chain is a decision, not a retry storm. */
  fallback: z
    .array(ModelTargetSchema)
    .max(3)
    .default(() => []),
  updatedAt: TimestampSchema,
});
export type ModelRoleBinding = z.infer<typeof ModelRoleBindingSchema>;

/** A workspace's default target when a role has no override. */
export const ModelWorkspaceDefaultSchema = z.object({
  workspaceId: IdSchema,
  target: ModelTargetSchema,
  updatedAt: TimestampSchema,
});
export type ModelWorkspaceDefault = z.infer<typeof ModelWorkspaceDefaultSchema>;

/** Where a resolved target came from, for diagnostics and inspection. */
export const MODEL_RESOLUTION_SOURCES = ["role-override", "workspace-default"] as const;
export type ModelResolutionSource = (typeof MODEL_RESOLUTION_SOURCES)[number];

/** Why a candidate in the chain was not used. */
export const MODEL_SKIP_REASONS = ["missing-connection", "unavailable-model", "capability-missing"] as const;
export type ModelSkipReason = (typeof MODEL_SKIP_REASONS)[number];

export const ModelSkipSchema = z.object({
  target: ModelTargetSchema,
  reason: z.enum(MODEL_SKIP_REASONS),
});
export type ModelSkip = z.infer<typeof ModelSkipSchema>;

export const ModelResolutionSchema = z.object({
  workspaceId: IdSchema,
  role: z.enum(MODEL_ROLES),
  /** The first target that resolved to a usable connection. */
  target: ModelTargetSchema,
  /** The full connection record, so a dispatcher needs no second lookup. */
  connection: ModelConnectionSchema,
  source: z.enum(MODEL_RESOLUTION_SOURCES),
  /** Candidates that were tried and why they were not used, in order. */
  skipped: z
    .array(ModelSkipSchema)
    .max(4)
    .default(() => []),
  /** Remaining explicit fallback after the chosen target, in order. */
  fallback: z
    .array(ModelTargetSchema)
    .max(3)
    .default(() => []),
  /**
   * Whether the chosen endpoint is operator-controlled local infrastructure.
   * Enforcement belongs to the access layer; this is the fact it needs.
   */
  localOnly: z.boolean(),
});
export type ModelResolution = z.infer<typeof ModelResolutionSchema>;

/**
 * Reject any stored header that is credential-bearing — by name *or* by value.
 *
 * A header is stored in `tavi.sqlite`, its backups and its diagnostics, so both
 * checks matter: the name check keeps the obvious key out, and the value check
 * keeps a renamed one out.
 */
export function assertSafeHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  if (headers === undefined) return;
  const names = Object.keys(headers);
  if (names.length > MAX_CONNECTION_HEADERS) {
    throw new Error(`at most ${MAX_CONNECTION_HEADERS} non-credential headers may be stored`);
  }
  for (const name of names) {
    if ((CREDENTIAL_HEADERS as readonly string[]).includes(name.toLowerCase())) {
      throw new Error(`header ${name} is a credential header and must come from the secret layer`);
    }
    const value = headers[name] ?? "";
    if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`header ${name} carries a value that looks like a credential; use a credential reference instead`);
    }
  }
}
