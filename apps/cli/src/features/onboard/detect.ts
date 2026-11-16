import {
  MODEL_PROVIDER_PRESETS,
  ONBOARDING_ENV_VARIABLES,
  type OnboardingDetectAnswer,
  type OnboardingEnvVariable,
  isEmbeddingModel,
  toolCapableFamily,
} from "@tavi/contracts";
import { readJsonBody } from "../../shared/json-body.js";

/**
 * Detection: which allowlisted env
 * variables are set and which local model servers answer — names and counts,
 * never a value. Nothing is downloaded or started, and nothing here writes.
 */

/** How long a local server has to answer before it counts as not running. */
const DETECT_TIMEOUT_MS = 500;

/** The local presets' loopback endpoints, as 127.0.0.1 so a probe never waits on name resolution. */
const LOCAL_PRESETS = MODEL_PROVIDER_PRESETS.filter((preset) => preset.localOnly && preset.baseUrl !== "").map((preset) => ({
  id: preset.id,
  baseUrl: preset.baseUrl.replace("//localhost:", "//127.0.0.1:"),
}));

export interface DetectDependencies {
  /** The environment of the process the flow runs in: the CLI's own, or the owner's. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof globalThis.fetch;
  readonly existing: () => Promise<readonly string[]>;
  /** The owner runs as a service, whose environment holds no shell variables. */
  readonly service?: boolean;
  readonly timeoutMs?: number;
}

/** The allowlisted variables set to a non-empty value, by name. */
function detectedVariables(env: Readonly<Record<string, string | undefined>>): readonly OnboardingEnvVariable[] {
  return ONBOARDING_ENV_VARIABLES.filter((name) => (env[name] ?? "").trim() !== "");
}

const getJson = async (fetch: typeof globalThis.fetch, url: string, timeoutMs: number, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return readJsonBody(response);
};

const modelIds = (body: unknown): readonly string[] => {
  const data = (body as { readonly data?: unknown } | null)?.data;
  return Array.isArray(data)
    ? data.flatMap((entry: unknown) => (typeof (entry as { id?: unknown } | null)?.id === "string" ? [(entry as { id: string }).id] : []))
    : [];
};

/**
 * Whether an Ollama model calls tools: `POST /api/show` reports `capabilities`
 * on current versions; an older one answers without them, and the model's
 * family decides.
 */
async function ollamaCallsTools(deps: DetectDependencies, origin: string, model: string, timeoutMs: number): Promise<boolean> {
  if (isEmbeddingModel(model)) return false;
  try {
    const body = await getJson(deps.fetch, `${origin}/api/show`, timeoutMs, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const capabilities = (body as { readonly capabilities?: unknown } | null)?.capabilities;
    if (Array.isArray(capabilities)) return capabilities.includes("tools");
  } catch {
    // Unanswered: the family below decides.
  }
  return toolCapableFamily(model);
}

/** A local server's models, or undefined when it does not answer. */
async function probeLocal(
  deps: DetectDependencies,
  preset: { readonly id: string; readonly baseUrl: string },
): Promise<OnboardingDetectAnswer["local"][number] | undefined> {
  const timeoutMs = deps.timeoutMs ?? DETECT_TIMEOUT_MS;
  let models: readonly string[];
  try {
    models = modelIds(await getJson(deps.fetch, `${preset.baseUrl}/models`, timeoutMs)).filter((model) => !isEmbeddingModel(model));
  } catch {
    return undefined;
  }
  const origin = new URL(preset.baseUrl).origin;
  const tools = await Promise.all(
    models.map(async (model) =>
      preset.id === "ollama" ? await ollamaCallsTools(deps, origin, model, timeoutMs) : toolCapableFamily(model),
    ),
  );
  return { preset: preset.id, models: models.length, toolCapableModels: tools.filter(Boolean).length };
}

export async function detect(deps: DetectDependencies): Promise<OnboardingDetectAnswer> {
  const [local, existing] = await Promise.all([
    Promise.all(LOCAL_PRESETS.map(async (preset) => await probeLocal(deps, preset))),
    deps.existing().catch(() => []),
  ]);
  return {
    env: detectedVariables(deps.env),
    local: local.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
    existing,
    ...(deps.service === true ? { service: true } : {}),
  };
}

/** The local models a detected server lists, for `connect-detected`'s check that it runs. */
export async function localServerRuns(deps: Pick<DetectDependencies, "fetch" | "timeoutMs">, presetId: string): Promise<boolean> {
  const preset = LOCAL_PRESETS.find((candidate) => candidate.id === presetId);
  if (preset === undefined) return false;
  try {
    await getJson(deps.fetch, `${preset.baseUrl}/models`, deps.timeoutMs ?? DETECT_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}
