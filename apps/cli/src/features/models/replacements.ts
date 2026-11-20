import type { LifecycleLevel, ModelLifecycle } from "@tavi/contracts";

import { rhumbModelId, type RhumbCall } from "./rhumb-client.js";
import type { ModelUse } from "./targets-in-use.js";

/**
 * Replacements for a model in use that retires or is redirected: the
 * provider's own redirect target, and Rhumb's pick on the same provider for
 * each kind of use. Suggestions only: nothing is switched here.
 */

/** What a use asks of its replacement. */
export const REPLACEMENT_KINDS = ["agent", "cheap", "embedding", "video"] as const;
export type ReplacementKind = (typeof REPLACEMENT_KINDS)[number];

/** Levels that get a replacement: an info notice does not. */
const REPLACED_LEVELS: ReadonlySet<LifecycleLevel> = new Set(["warning", "error"]);

export interface ReplacementPick {
  readonly for: ReplacementKind;
  readonly model: string;
  readonly reason?: string;
}

export interface ModelReplacements {
  /** The provider's redirect target: its choice, which can be a smaller model. */
  readonly provider?: { readonly model: string; readonly via?: string };
  /** Rhumb's pick per kind of use, the old model left out. */
  readonly rhumb: readonly ReplacementPick[];
}

/** The kind of replacement a use asks for: the main work needs tools, background work the same on a cheap budget. */
export function replacementKindOf(use: ModelUse): ReplacementKind {
  switch (use.kind) {
    case "video":
      return "video";
    case "heartbeat":
    case "activity-summary":
      return "cheap";
    case "role":
    case "role-fallback":
      if (use.detail === "embedding") return "embedding";
      if (use.detail === "fast" || use.detail === "extraction" || use.detail === "compaction") return "cheap";
      return "agent";
    default:
      return "agent";
  }
}

/** The kinds a model's uses ask for, in {@link REPLACEMENT_KINDS} order. */
export function replacementKinds(usedBy: readonly ModelUse[]): ReplacementKind[] {
  const kinds = new Set(usedBy.map(replacementKindOf));
  return REPLACEMENT_KINDS.filter((kind) => kinds.has(kind));
}

/** Whether a warning at this level gets replacements. */
export function isReplacedLevel(level: LifecycleLevel): boolean {
  return REPLACED_LEVELS.has(level);
}

/**
 * `/v1/resolve`'s query for a kind, on one provider. The model being replaced
 * is never sent: only provider names leave the machine, and the old model is
 * skipped in the answer instead.
 */
export function replacementQuery(kind: ReplacementKind, provider: string): Record<string, string> {
  const base = { providers: provider };
  switch (kind) {
    case "agent":
      return { ...base, purpose: "agent-with-tools" };
    case "cheap":
      return { ...base, purpose: "agent-with-tools", budget: "cheap" };
    case "embedding":
      return { ...base, task: "embedding" };
    case "video":
      return { ...base, purpose: "agent-with-tools", needs: "input.video" };
  }
}

/** The provider's redirect target, when it names one other than the model itself. */
export function providerReplacement(lifecycle: ModelLifecycle | undefined, model: string): ModelReplacements["provider"] {
  const redirect = lifecycle?.redirect;
  if (redirect === undefined || redirect.to === model) return undefined;
  return { model: redirect.to, ...(redirect.via === undefined ? {} : { via: redirect.via }) };
}

interface ResolvedOffering {
  readonly provider?: string;
  readonly provider_model_id?: string;
  readonly status?: string;
}

interface ResolveAnswer {
  readonly reason?: string;
  readonly model?: ResolvedOffering;
  readonly alternatives?: readonly ResolvedOffering[];
}

/** Statuses never proposed in place of a model that goes. */
const GOING: ReadonlySet<string> = new Set(["deprecated", "retired"]);

/** The answer's model, else its first alternative, on `provider`, other than `old` and not itself going; with whether it is the top pick. */
function pickFrom(
  answer: ResolveAnswer | undefined,
  provider: string,
  old: string,
): { readonly model: string; readonly top: boolean } | undefined {
  const offered = [answer?.model, ...(Array.isArray(answer?.alternatives) ? answer.alternatives : [])];
  const index = offered.findIndex(
    (offering) =>
      offering?.provider === provider &&
      typeof offering.provider_model_id === "string" &&
      offering.provider_model_id !== old &&
      !GOING.has(offering.status ?? ""),
  );
  const found = offered[index]?.provider_model_id;
  return found === undefined ? undefined : { model: found, top: index === 0 };
}

/**
 * Rhumb's picks, kept per catalog version: a pick changes only when the
 * catalog does. `null` stands for "asked, and nothing fits".
 */
export class ReplacementCache {
  readonly #picks = new Map<string, ReplacementPick | null>();

  static key(catalogVersion: string, provider: string, model: string, kind: ReplacementKind): string {
    return [catalogVersion, provider, model, kind].join("\u0000");
  }

  get(catalogVersion: string, provider: string, model: string, kind: ReplacementKind): ReplacementPick | null | undefined {
    return this.#picks.get(ReplacementCache.key(catalogVersion, provider, model, kind));
  }

  set(catalogVersion: string, provider: string, model: string, kind: ReplacementKind, pick: ReplacementPick | null): void {
    this.#picks.set(ReplacementCache.key(catalogVersion, provider, model, kind), pick);
  }

  /**
   * Drops the picks of every catalog version not in `versions`: once a sync
   * stores rows, picks of a version no row carries are never read again. A
   * listing that stopped early keeps older rows, and so their version.
   */
  keepVersions(versions: ReadonlySet<string>): void {
    for (const key of this.#picks.keys()) if (!versions.has(key.slice(0, key.indexOf("\u0000")))) this.#picks.delete(key);
  }

  clear(): void {
    this.#picks.clear();
  }
}

/** This process's picks: the owner's sync fills it, and the stored report reads it. */
export const replacementCache = new ReplacementCache();

/** One model in use that wants replacements: what {@link askReplacements} is given. */
export interface ReplacementRequest {
  readonly catalogVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly kinds: readonly ReplacementKind[];
}

/**
 * Asks Rhumb, in parallel, once per provider and kind that some model still
 * lacks a cached pick for (the query names no model, so one answer serves
 * them all), then picks for each model from that answer. Rhumb's
 * `no_candidate` is cached as nothing fits; any other failure leaves the
 * pick out and uncached, for the next sync to ask again. Never throws.
 */
export async function askReplacements(call: RhumbCall, cache: ReplacementCache, requests: readonly ReplacementRequest[]): Promise<void> {
  const wanted = requests.flatMap((request) =>
    request.kinds
      .filter((kind) => cache.get(request.catalogVersion, request.provider, request.model, kind) === undefined)
      .map((kind) => ({ ...request, kind })),
  );
  const asks = new Map<string, Promise<ResolveAnswer | "no-candidate" | "failed">>();
  for (const { provider, kind } of wanted) {
    const key = `${provider}\u0000${kind}`;
    if (!asks.has(key))
      asks.set(
        key,
        call("/v1/resolve", replacementQuery(kind, provider)).then(
          (answer) => (answer ?? {}) as ResolveAnswer,
          (error: unknown) => (error instanceof Error && /\bno_candidate\b/u.test(error.message) ? "no-candidate" : "failed"),
        ),
      );
  }
  for (const { catalogVersion, provider, model, kind } of wanted) {
    const answer = await asks.get(`${provider}\u0000${kind}`);
    if (answer === undefined || answer === "failed") continue;
    const picked = answer === "no-candidate" ? undefined : pickFrom(answer, provider, rhumbModelId(provider, model));
    // Rhumb's reason is for its top pick; an alternative gets none.
    const reason = picked?.top === true && answer !== "no-candidate" ? answer.reason : undefined;
    cache.set(
      catalogVersion,
      provider,
      model,
      kind,
      picked === undefined ? null : { for: kind, model: picked.model, ...(reason === undefined ? {} : { reason }) },
    );
  }
}

/** The replacements known for a model without asking anyone: its redirect, and the cached picks. */
export function knownReplacements(
  cache: ReplacementCache,
  request: {
    readonly provider: string | undefined;
    readonly model: string;
    readonly lifecycle: ModelLifecycle | undefined;
    readonly kinds: readonly ReplacementKind[];
  },
): ModelReplacements {
  const { provider, model, lifecycle } = request;
  const rhumb =
    provider === undefined || lifecycle === undefined
      ? []
      : request.kinds.flatMap((kind) => {
          const pick = cache.get(lifecycle.catalogVersion, provider, model, kind);
          return pick === undefined || pick === null ? [] : [pick];
        });
  const redirect = providerReplacement(lifecycle, model);
  return { ...(redirect === undefined ? {} : { provider: redirect }), rhumb };
}

/**
 * The replacements in one line, or `undefined` for none: the provider's
 * choice named as such, then Rhumb's picks with the use each is for.
 */
export function replacementsInWords(replacements: ModelReplacements | undefined): string | undefined {
  if (replacements === undefined) return undefined;
  const parts = [
    ...(replacements.provider === undefined ? [] : [`the provider moves it to ${replacements.provider.model}`]),
    ...(replacements.rhumb.length === 0
      ? []
      : [`Rhumb suggests ${replacements.rhumb.map((pick) => `${pick.model} (${REPLACEMENT_USES[pick.for]})`).join(", ")}`]),
  ];
  return parts.length === 0 ? undefined : parts.join("; ");
}

const REPLACEMENT_USES: Readonly<Record<ReplacementKind, string>> = {
  agent: "with tools",
  cheap: "background, cheaper",
  embedding: "embeddings",
  video: "with video",
};

/** Replacements read from an owner's answer, keeping only what has the expected shape. */
export function replacementsOf(value: unknown): ModelReplacements | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { provider, rhumb } = value as { provider?: unknown; rhumb?: unknown };
  const target = typeof provider === "object" && provider !== null ? (provider as { model?: unknown; via?: unknown }) : undefined;
  const picks = (Array.isArray(rhumb) ? rhumb : []).flatMap((pick: unknown): ReplacementPick[] => {
    const { for: kind, model } = (pick ?? {}) as { for?: unknown; model?: unknown };
    return typeof model === "string" && REPLACEMENT_KINDS.includes(kind as ReplacementKind)
      ? [{ for: kind as ReplacementKind, model }]
      : [];
  });
  return {
    ...(typeof target?.model === "string"
      ? { provider: { model: target.model, ...(typeof target.via === "string" ? { via: target.via } : {}) } }
      : {}),
    rhumb: picks,
  };
}
