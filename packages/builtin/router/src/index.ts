import {
  JEV_PROVIDER_ID,
  RouterProviderError,
  SECRET_KEY_REF_PATTERN,
  type BuiltinRouterProvider,
  type ModelPriceSheet,
  type ModelUsage,
  type RouterProvider,
  type RouterProviderLimits,
  type RouterProviderRequest,
  type RouterReadinessDependencies,
} from "@tavi/contracts";
import { z } from "zod";
import { DecisionFailure, decisionBody, parseDecision, parseUsage, readBoundedResponse } from "./typesafe.js";

export const JEV_MODEL = "jev-1.13.0";
/** The price sheet identity Jev is charged under. */
export const JEV_PRICING = { connectionId: "jev", model: JEV_MODEL } as const;

export interface JevProviderOptions {
  readonly readSecret: (reference: string) => Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
}

/** Jev's settings, kept under `providerSettings["tavi.router"]`: its one endpoint and model, and the credential's reference. */
export const JevRouterSettingsSchema = z.strictObject({
  endpoint: z.literal("https://api.typesafe.ai/v1/systemone").default("https://api.typesafe.ai/v1/systemone"),
  model: z.literal(JEV_MODEL).default(JEV_MODEL),
  credentialRef: z.string().max(128).regex(SECRET_KEY_REF_PATTERN).optional(),
});
export type JevRouterSettings = z.infer<typeof JevRouterSettingsSchema>;

/** The settings a call runs with: parsed here at each use, so no endpoint but Jev's is ever called. */
function jevSettings(settings: Readonly<Record<string, unknown>>): JevRouterSettings {
  const parsed = JevRouterSettingsSchema.safeParse(settings);
  if (!parsed.success) throw new RouterProviderError("invalid");
  return parsed.data;
}

/** The TypeSafe wire body: one feature's task text, or the batched features' texts as a JSON object. */
function body(request: Omit<RouterProviderRequest, "signal" | "checkpoint">): string {
  const feature = request.features[0];
  if (feature === undefined) throw new RouterProviderError("invalid");
  const task = request.features.length === 1 ? (request.prompts[feature] ?? "") : JSON.stringify(request.prompts);
  return decisionBody(
    jevSettings(request.settings).model,
    feature,
    task,
    request.candidates.map(({ feature: _feature, ...candidate }) => candidate),
  );
}

/** Whether a sheet can price Jev: its conservative reservation needs free output. */
export function jevPriceUsable(price: ModelPriceSheet): boolean {
  return price.output === 0 && (price.reasoning === undefined || price.reasoning === 0);
}

/** The protocol reserves conservatively only when output is free: unknown or priced output abstains. */
function maxCostUsd(price: ModelPriceSheet, limits: Pick<RouterProviderLimits, "requestTokenCap">): number | undefined {
  return !jevPriceUsable(price)
    ? undefined
    : (limits.requestTokenCap * Math.max(price.input, price.cacheRead, price.cacheWrite)) / 1_000_000;
}

/**
 * The Jev provider's readiness for `tavi router status`, offline or in an
 * owner. It makes no provider request: `present` means the credential
 * resolved locally, and its live validity stays untested.
 */
export async function jevReadiness(
  settings: Readonly<Record<string, unknown>>,
  deps: RouterReadinessDependencies,
): Promise<{ readonly credentialPresence: string; readonly liveCredentialValidity: "not-tested"; readonly priceReady: boolean }> {
  const jev = JevRouterSettingsSchema.parse(settings);
  let credentialPresence = "not-configured";
  if (jev.credentialRef !== undefined) {
    try {
      credentialPresence = (await deps.readSecret(jev.credentialRef)) === null ? "missing" : "present";
    } catch {
      credentialPresence = "unavailable";
    }
  }
  const price = await deps.price(JEV_PRICING.connectionId, JEV_PRICING.model, deps.now);
  return {
    credentialPresence,
    liveCredentialValidity: "not-tested",
    priceReady: price !== undefined && price.revision === deps.priceRevision && maxCostUsd(price, deps) !== undefined,
  };
}

/**
 * The Jev (TypeSafe direct) routing provider. It only speaks the wire protocol:
 * the host guard owns modes, disclosure consent, budgets, deadlines and receipts.
 */
export function createJevProvider(options: JevProviderOptions): RouterProvider {
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    pricing: JEV_PRICING,
    supportsBatch: true,
    maxCostUsd,
    measure: (request) => Buffer.byteLength(body(request)),
    unavailable: (settings) => (typeof settings["credentialRef"] === "string" ? undefined : "credentials"),
    async classify(request) {
      const settings = jevSettings(request.settings);
      const payload = body(request);
      const credentialRef = settings.credentialRef;
      if (credentialRef === undefined) throw new RouterProviderError("credentials");
      const credential = await options.readSecret(credentialRef).catch(() => {
        throw new RouterProviderError("credentials");
      });
      if (credential === null || credential.length === 0) throw new RouterProviderError("credentials");
      await request.checkpoint();
      const response = await fetch(settings.endpoint, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: payload,
        signal: request.signal,
      }).catch(() => {
        throw new RouterProviderError("transport");
      });
      const raw = await readBoundedResponse(response, request.limits.maxResponseBytes, request.signal).catch((error: unknown) => {
        if (error instanceof DecisionFailure) throw error;
        throw new RouterProviderError(error instanceof SyntaxError ? "invalid" : "transport");
      });
      request.signal.throwIfAborted();
      let usage: ModelUsage = {};
      try {
        usage = parseUsage(raw);
        // Threshold 0: the host applies thresholds; the chosen option is reported, not filtered.
        const feature = request.features[0] ?? "tools";
        const answer = parseDecision(raw, feature, request.candidates, 0);
        return {
          probabilities: answer.probabilities,
          ...(feature === "model" && answer.selectedIds[0] !== undefined ? { choice: answer.selectedIds[0] } : {}),
          ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
          usage,
        };
      } catch (error) {
        if (error instanceof DecisionFailure)
          throw new RouterProviderError(error.reason === "no-candidates" ? "invalid" : error.reason, usage);
        throw error;
      }
    },
  };
}

/** What the owner knows of Jev without running it: `tavi router` and `doctor` read it offline as in an owner. */
export const JEV_ROUTER: BuiltinRouterProvider = {
  id: JEV_PROVIDER_ID,
  settings: JevRouterSettingsSchema,
  pricing: JEV_PRICING,
  priceUsable: jevPriceUsable,
  readiness: jevReadiness,
};
