import {
  LOCAL_NO_KEY_CREDENTIAL,
  TaviError,
  TaviErrorCodeSchema,
  MODEL_PROVIDER_PRESETS,
  ONBOARDING_ENV_KEYS,
  normaliseBaseUrl,
  presetOf,
  type CredentialsPayload,
  type ModelsPayload,
  type OnboardingConnectAnswer,
  type OnboardingDetectAnswer,
  type OnboardingSignInAnswer,
  type OnboardingSignInStatusAnswer,
  type OnboardingVerifyAnswer,
  type OnboardingVerifyResult,
  type OnboardingVerifyRole,
  type AsyncPersistenceRepositories,
  type IdeaCapability,
  type OnboardingFlow,
  type OnboardingFlowAnswer,
  type OnboardingPayload,
  type OnboardingProviderAnswer,
  type OnboardingReachedAnswer,
  type OnboardingResetAnswer,
  type OnboardingStatus,
  type OnboardingStepKind,
  type OnboardingSurface,
  classifyVerifyFailure,
  LASTING_VERIFY_CODES,
  lifecycleByModel,
  suggestRoles,
  type ModelLifecycle,
  verifyAdvice,
  textRef,
  TextRefSchema,
} from "@tavi/contracts";
import { DEFAULT_LOCALE, type Locale } from "@tavi/contracts/i18n";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { errorMessage } from "@tavi/contracts/util";
import {
  BUILTIN_ONBOARDING_PROVIDER_ID,
  deriveStatus,
  placesOn,
  hostFallbackFlow,
  resolveFlow,
  type FlowContext,
  type OnboardingLiveFacts,
  type OnboardingProviderRegistry,
  type ResolvedFlow,
} from "@tavi/agent-host/onboarding-host";

import { refuseKeyed, type IpcAnswer } from "../../shared/ipc-decisions.js";
import { detect, localServerRuns } from "./detect.js";
import type { OpenRouterSignIns } from "./openrouter.js";
import { CHATGPT_ENDPOINTS, chatGptCredentialOf, type ChatGptCredential, type ChatGptSignIns } from "./chatgpt.js";
import { CHATGPT_PREVIEW_VARIABLE } from "./previews.js";
import { DEFAULT_TEST_TIMEOUT_MS } from "@tavi/runtime";

/**
 * `onboarding`: status, the flow to walk
 * and onboarding's own marks, for the workspace operator only. Every
 * configuration write a step makes goes through its own command; this one
 * writes only onboarding's tables. The owner dispatches it; the CLI runs it
 * offline over the store with the same dependencies.
 */

export interface OnboardingCommandDependencies {
  readonly repositories: Pick<AsyncPersistenceRepositories, "onboarding">;
  readonly principalOf: (workspaceId: string) => string | undefined;
  readonly providers: OnboardingProviderRegistry;
  /** Every family's live facts for a workspace (`liveOnboardingFacts`). */
  readonly facts: (workspaceId: string) => Promise<OnboardingLiveFacts>;
  /** What Tavi can do in the workspace now: the Ideas census, read, never built here (invariant 15). */
  readonly census: (workspaceId: string) => Promise<readonly IdeaCapability[]>;
  /** The channel kinds and connectable app ids available now, for `featured`. */
  readonly channelKinds: () => readonly string[];
  readonly appIds: (workspaceId: string) => Promise<readonly string[]>;
  readonly now: () => Date;
  /** The workspace's language: the host's own flow and a plugin's flow are asked in it. Absent: English. */
  readonly locale?: (workspaceId: string) => Promise<Locale>;
  /** Through the `tavi ui` bridge: `reset` and `provider` are the terminal's. */
  readonly fromBridge?: boolean;
  /** Detection in the process the flow runs in: its own environment and a fetch for the loopback probes. */
  readonly detection?: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly fetch: typeof globalThis.fetch;
    readonly service?: boolean;
  };
  /** The `credentials` and `models` commands, as a client would send them: every write goes through them (invariant 4). */
  readonly config?: {
    credentials(payload: CredentialsPayload): Promise<IpcAnswer<unknown>>;
    models(payload: ModelsPayload): Promise<IpcAnswer<unknown>>;
  };
  /** A connection and model as verify checks them, for a verify of a target that is not a role yet. */
  readonly target?: (connectionId: string, model: string) => Promise<NonNullable<OnboardingLiveFacts["model"]["main"]> | undefined>;
  /** One verify in flight per workspace and role, none again within 5 s; one gate per owner. */
  readonly verifyGate?: OnboardingVerifyGate;
  /** The owner's OpenRouter sign-ins, in its callback router; absent, `sign-in` is refused. */
  readonly signIns?: OpenRouterSignIns;
  /**
   * Sign in with ChatGPT: the owner's loopback sign-ins for the canvas,
   * and whether the credential store is encrypted at rest — a sign-in's token
   * record is kept only then. Absent, ChatGPT is not offered here.
   */
  readonly chatGpt?: {
    readonly signIns?: ChatGptSignIns;
    readonly encrypted: () => boolean;
    readonly kept?: () => Promise<ChatGptCredential | undefined>;
  };
}

/** How soon a verify of the same workspace and role may run again: each one spends a real completion. */
const VERIFY_REPEAT_MS = 5_000;

export interface OnboardingVerifyGate {
  /** A release when the verify may run, or undefined when one runs or ran within `VERIFY_REPEAT_MS`. */
  begin(key: string, now: number): (() => void) | undefined;
}

export function createVerifyGate(): OnboardingVerifyGate {
  const running = new Set<string>();
  const started = new Map<string, number>();
  return {
    begin: (key, now) => {
      if (running.has(key) || now - (started.get(key) ?? Number.NEGATIVE_INFINITY) < VERIFY_REPEAT_MS) return undefined;
      running.add(key);
      started.set(key, now);
      return () => running.delete(key);
    },
  };
}

export type OnboardingAnswer = IpcAnswer<
  | OnboardingStatus
  | OnboardingFlowAnswer
  | OnboardingProviderAnswer
  | OnboardingResetAnswer
  | OnboardingDetectAnswer
  | OnboardingConnectAnswer
  | OnboardingVerifyAnswer
  | OnboardingSignInAnswer
  | OnboardingSignInStatusAnswer
  | OnboardingReachedAnswer
>;

/** The host's own flow's prompts, in `locale`: what an ideas step without its own falls back to, whichever provider's flow it is. */
const fallbackPrompts = (locale: Locale): FlowContext["fallbackPrompts"] =>
  hostFallbackFlow(coreIn(locale)).steps.find((step) => step.kind === "ideas")?.prompts ?? [];

/** The workspace's language, English when the owner cannot say. */
const localeFor = async (deps: OnboardingCommandDependencies, workspaceId: string): Promise<Locale> =>
  (await deps.locale?.(workspaceId).catch(() => undefined)) ?? DEFAULT_LOCALE;

/** Onboarding's own rows for a workspace: read once per answer. */
interface OnboardingRecords {
  readonly install: Awaited<ReturnType<OnboardingCommandDependencies["repositories"]["onboarding"]["install"]>>;
  readonly marks: Awaited<ReturnType<OnboardingCommandDependencies["repositories"]["onboarding"]["steps"]>>;
  readonly verifications: Awaited<ReturnType<OnboardingCommandDependencies["repositories"]["onboarding"]["verifications"]>>;
}

async function recordsOf(deps: OnboardingCommandDependencies, workspaceId: string): Promise<OnboardingRecords> {
  const [install, marks, verifications] = await Promise.all([
    deps.repositories.onboarding.install(),
    deps.repositories.onboarding.steps(workspaceId),
    deps.repositories.onboarding.verifications(workspaceId),
  ]);
  return { install, marks, verifications };
}

/** The flow that answers: the selected one when installed, else the built-in, else none (null). */
function flowInUse(deps: OnboardingCommandDependencies, selected: string | null): string | null {
  const wanted = selected ?? BUILTIN_ONBOARDING_PROVIDER_ID;
  if (deps.providers.get(wanted) !== undefined) return wanted;
  return deps.providers.get(BUILTIN_ONBOARDING_PROVIDER_ID) === undefined ? null : BUILTIN_ONBOARDING_PROVIDER_ID;
}

function statusOf(
  deps: OnboardingCommandDependencies,
  workspaceId: string,
  facts: OnboardingLiveFacts,
  records: OnboardingRecords,
  flow: OnboardingFlow,
  surface: OnboardingSurface,
  flowFallback?: string,
): OnboardingStatus {
  return deriveStatus({
    ...facts,
    ...records,
    workspaceId,
    // With the built-in flow disabled and no plugin's installed, status still answers.
    providerId: flowInUse(deps, records.install.providerId),
    order: flowKinds(flow),
    places: placesOn(flow, surface),
    ...(flowFallback === undefined ? {} : { flowFallback }),
    flow: { version: flow.version, kinds: flowKinds(flow) },
  });
}

/** Every step kind the flow has, whatever the surface walks. */
const flowKinds = (flow: OnboardingFlow): readonly OnboardingStepKind[] => [...new Set(flow.steps.map((step) => step.kind))];

async function flowFor(
  deps: OnboardingCommandDependencies,
  workspaceId: string,
  surface: OnboardingSurface,
  facts: OnboardingLiveFacts,
  records: OnboardingRecords,
  detected?: OnboardingDetectAnswer,
): Promise<ResolvedFlow> {
  const [census, apps, locale] = await Promise.all([
    deps.census(workspaceId).catch(() => []),
    deps.appIds(workspaceId).catch(() => []),
    localeFor(deps, workspaceId),
  ]);
  // The status a provider sees is the host's, in the host fallback's order: it chooses an order of its own.
  const status = statusOf(deps, workspaceId, facts, records, hostFallbackFlow(), surface);
  const context: FlowContext = {
    surface,
    modelOpen: status.steps.find((step) => step.kind === "model")?.state !== "done",
    presets: MODEL_PROVIDER_PRESETS.map((preset) => preset.id),
    channels: deps.channelKinds(),
    apps,
    // Only the flow a person walks probes local servers; a status read never waits on them.
    ollamaReady: detected?.local.some((server) => server.preset === "ollama" && server.toolCapableModels > 0) === true,
    fallbackPrompts: fallbackPrompts(locale),
    census,
  };
  // Preset ids only, never a value: a running local server, or a preset whose key is set.
  const presetsDetected =
    detected === undefined
      ? []
      : [
          ...new Set([
            ...detected.local.filter((server) => server.models > 0).map((server) => server.preset),
            ...Object.entries(ONBOARDING_ENV_KEYS)
              .filter(([, names]) => names.some((name) => (detected.env as readonly string[]).includes(name)))
              .map(([preset]) => preset),
          ]),
        ];
  return await resolveFlow(
    deps.providers,
    records.install.providerId,
    { surface, status, census, presets: context.presets, channels: context.channels, apps, detected: presetsDetected, locale },
    context,
  );
}

/**
 * The resolved flow a status read orders by, kept a few seconds per registry,
 * workspace and surface (CORE-14): Home and the canvas read status often, and a
 * slow plugin flow must not hold every read for its deadline. A change to the
 * facts or records a flow is shown resolves it again; a walk always resolves afresh.
 */
const STATUS_FLOW_TTL_MS = 15_000;
interface KeptFlow {
  readonly at: number;
  readonly seen: string;
  readonly resolved: ResolvedFlow;
}
const statusFlows = new WeakMap<object, Map<string, KeptFlow>>();

/** The status in the order the flow walks on `surface` (the web's when not named). */

export async function onboardingStatus(
  deps: OnboardingCommandDependencies,
  workspaceId: string,
  surface: OnboardingSurface = "web",
): Promise<OnboardingStatus> {
  const [facts, records] = await Promise.all([deps.facts(workspaceId), recordsOf(deps, workspaceId)]);
  const cache = statusFlows.get(deps.providers) ?? new Map<string, KeptFlow>();
  statusFlows.set(deps.providers, cache);
  const key = `${workspaceId}\u0000${surface}`;
  // The language too: a flow resolved in one says its fallback in it.
  const seen = JSON.stringify([facts, records, await localeFor(deps, workspaceId)]);
  const now = deps.now().getTime();
  const kept = cache.get(key);
  const resolved =
    kept !== undefined && kept.seen === seen && now - kept.at < STATUS_FLOW_TTL_MS
      ? kept.resolved
      : await flowFor(deps, workspaceId, surface, facts, records);
  if (resolved !== kept?.resolved) cache.set(key, { at: now, seen, resolved });
  // Every step the flow has, on every surface, so each counts the same; one done elsewhere says where.
  const status = statusOf(deps, workspaceId, facts, records, resolved.flow, surface, resolved.fallback);
  // The funnel is this machine's own record, beside what live state says.
  const funnel = await deps.repositories.onboarding.funnel(workspaceId);
  const offered = { ...status, ...(deps.chatGpt === undefined ? {} : { chatGptSignIn: true }) };
  return Object.keys(funnel).length === 0 ? offered : { ...offered, funnel };
}

export async function onboardingCommand(deps: OnboardingCommandDependencies, payload: OnboardingPayload): Promise<OnboardingAnswer> {
  if (payload.action === "provider") {
    if (deps.fromBridge === true && payload.id !== undefined) return refuseKeyed("NOT_AUTHORIZED", "onboard.refuse.canvasProvider");
    if (payload.id !== undefined) {
      const entry = deps.providers.get(payload.id);
      if (entry === undefined) {
        const installed = deps.providers
          .list()
          .map((provider) => provider.id)
          .join(", ");
        return refuseKeyed("NOT_FOUND", "onboard.refuse.noFlow", {
          id: payload.id,
          installed: installed === "" ? textRef("onboard.refuse.none") : installed,
        });
      }
      await deps.repositories.onboarding.setProvider(payload.id === BUILTIN_ONBOARDING_PROVIDER_ID ? null : payload.id);
    }
    const install = await deps.repositories.onboarding.install();
    const providers = deps.providers.list().map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      ...(provider.disclosure === undefined ? {} : { disclosure: provider.disclosure }),
    }));
    return { ok: true, result: { providerId: flowInUse(deps, install.providerId), providers } satisfies OnboardingProviderAnswer };
  }
  const workspaceId = payload.workspaceId ?? "default";
  // Operator only: a workspace no operator acts in has nobody to onboard.
  if (deps.principalOf(workspaceId) === undefined)
    return refuseKeyed("NOT_AUTHORIZED", "onboard.refuse.noOperator", { workspace: workspaceId });
  const at = deps.now().toISOString();
  const surface = "surface" in payload ? payload.surface : undefined;
  const status = async (): Promise<OnboardingAnswer> => ({ ok: true, result: await onboardingStatus(deps, workspaceId, surface) });
  switch (payload.action) {
    case "status":
      await deps.repositories.onboarding.noteSeen(at);
      return await status();
    case "flow": {
      const [facts, records, detected] = await Promise.all([
        deps.facts(workspaceId),
        recordsOf(deps, workspaceId),
        // Detection is a suggestion: one that fails suggests nothing.
        deps.detection === undefined ? undefined : detectHere(deps, deps.detection).catch(() => undefined),
      ]);
      const resolved = await flowFor(deps, workspaceId, payload.surface, facts, records, detected);
      await deps.repositories.onboarding.setFlowVersion(resolved.flow.version);
      return {
        ok: true,
        result: {
          flow: resolved.flow,
          providerId: resolved.providerId,
          ...(resolved.fallback === undefined ? {} : { fallback: resolved.fallback }),
        } satisfies OnboardingFlowAnswer,
      };
    }
    case "skip":
      if (payload.step === "model") return refuseKeyed("INVALID_INPUT", "onboard.refuse.modelSkip");
      await deps.repositories.onboarding.setStep({ workspaceId, kind: payload.step, mark: "skipped", now: at });
      await deps.repositories.onboarding.recordEvent({ workspaceId, kind: payload.step, event: "skipped", now: at });
      return await status();
    case "reached":
      await deps.repositories.onboarding.recordEvent({ workspaceId, kind: payload.step, event: "reached", now: at });
      return { ok: true, result: { recorded: true } satisfies OnboardingReachedAnswer };
    case "restore":
      await deps.repositories.onboarding.restoreStep(workspaceId, payload.step, at);
      return await status();
    case "complete-step":
      // Only steps whose completion live state cannot show are marked: the rest are done when they are true.
      if (payload.step !== "about" && payload.step !== "tasks" && payload.step !== "info")
        return refuseKeyed("INVALID_INPUT", "onboard.refuse.notMarked", { step: payload.step });
      await deps.repositories.onboarding.setStep({
        workspaceId,
        kind: payload.step,
        mark: payload.step === "info" ? "seen" : "completed",
        now: at,
      });
      return await status();
    case "created":
      await deps.repositories.onboarding.recordCreated({ workspaceId, kind: payload.step, createdRef: payload.ref, now: at });
      return await status();
    case "confirm-service":
      await deps.repositories.onboarding.setStep({ workspaceId, kind: "service", mark: "self-managed", now: at });
      return await status();
    case "dismiss": {
      // For the flow in use now, with every kind it has: a later version's card shows only what it adds.
      const [facts, records] = await Promise.all([deps.facts(workspaceId), recordsOf(deps, workspaceId)]);
      const resolved = await flowFor(deps, workspaceId, surface ?? "web", facts, records);
      await deps.repositories.onboarding.dismiss(resolved.flow.version, at, flowKinds(resolved.flow));
      return await status();
    }
    case "complete":
      await deps.repositories.onboarding.complete(at);
      return await status();
    case "reset":
      if (deps.fromBridge === true) return refuseKeyed("NOT_AUTHORIZED", "onboard.refuse.canvasReset");
      return { ok: true, result: { cleared: await deps.repositories.onboarding.reset(workspaceId, at) } satisfies OnboardingResetAnswer };
    case "detect": {
      if (deps.detection === undefined) return refuseKeyed("UNSUPPORTED", "onboard.refuse.noDetection");
      return { ok: true, result: await detectHere(deps, deps.detection) };
    }
    case "connect-detected":
      return await connectDetected(deps, workspaceId, payload.preset, payload.variable);
    case "connect-key": {
      const config = deps.config;
      if (config === undefined) return refuseKeyed("UNSUPPORTED", "onboard.refuse.noConnect");
      const preset = MODEL_PROVIDER_PRESETS.find((candidate) => candidate.id === payload.preset);
      if (preset === undefined) return refuseKeyed("INVALID_INPUT", "onboard.refuse.unknownProvider", { preset: payload.preset });
      if ((preset.baseUrl === "") !== (payload.baseUrl !== undefined))
        return refuseKeyed("INVALID_INPUT", preset.baseUrl === "" ? "onboard.refuse.needsEndpoint" : "onboard.refuse.endpointFixed", {
          provider: preset.name,
        });
      const endpoint = payload.baseUrl === undefined ? undefined : new URL(payload.baseUrl);
      if (
        endpoint !== undefined &&
        (!["http:", "https:"].includes(endpoint.protocol) ||
          endpoint.username !== "" ||
          endpoint.password !== "" ||
          endpoint.search !== "" ||
          endpoint.hash !== "")
      )
        return refuseKeyed("INVALID_INPUT", "onboard.refuse.badEndpoint");
      return await storeProviderKey(
        deps,
        config,
        workspaceId,
        endpoint === undefined ? preset : { ...preset, baseUrl: payload.baseUrl as string },
        payload.key,
      );
    }
    case "connect-signed-in": {
      const config = deps.config;
      if (deps.chatGpt === undefined)
        return refuseKeyed("UNSUPPORTED", "onboard.refuse.chatGptPreview", { variable: CHATGPT_PREVIEW_VARIABLE });
      if (config === undefined) return refuseKeyed("UNSUPPORTED", "onboard.refuse.chatGptUnavailable");
      // A token record is kept only in an encrypted store, and only one that is a whole ChatGPT sign-in.
      if (!deps.chatGpt.encrypted()) return refuseKeyed("NOT_CONFIGURED", "onboard.refuse.chatGptEncrypted");
      if (chatGptCredentialOf(payload.credential) === undefined) return refuseKeyed("INVALID_INPUT", "onboard.refuse.notChatGpt");
      return await storeProviderKey(deps, config, workspaceId, CHATGPT_PROVIDER, payload.credential);
    }
    case "sign-in": {
      const config = deps.config;
      if (payload.preset === "chatgpt") {
        const chatGpt = deps.chatGpt;
        if (chatGpt === undefined)
          return refuseKeyed("UNSUPPORTED", "onboard.refuse.chatGptPreview", { variable: CHATGPT_PREVIEW_VARIABLE });
        if (config === undefined || chatGpt.signIns === undefined) return refuseKeyed("UNSUPPORTED", "onboard.refuse.chatGptUnavailable");
        if (!chatGpt.encrypted()) return refuseKeyed("NOT_CONFIGURED", "onboard.refuse.chatGptEncrypted");
        // Signed in before: the same registration and account again, never a second one (OpenAI's returning sign-in).
        const kept = await chatGpt.kept?.().catch(() => undefined);
        const started = await chatGpt.signIns.start(async (credential) => {
          const stored = await storeProviderKey(deps, config, workspaceId, CHATGPT_PROVIDER, JSON.stringify(credential));
          if (!stored.ok) {
            const code = TaviErrorCodeSchema.safeParse(stored.error.code);
            throw new TaviError(code.success ? code.data : "UNAVAILABLE", stored.error.message);
          }
          return stored.result;
        }, kept);
        return { ok: true, result: { url: started.url, state: started.state } satisfies OnboardingSignInAnswer };
      }
      const signIns = deps.signIns;
      if (signIns === undefined || config === undefined) return refuseKeyed("UNSUPPORTED", "onboard.refuse.noSignIn");
      if (payload.callbackOrigin === undefined) return refuseKeyed("INVALID_INPUT", "onboard.refuse.openRouterOrigin");
      // The browser comes back to `tavi ui` on this computer: a callback anywhere else is refused.
      const origin = new URL(payload.callbackOrigin);
      if (
        origin.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
        origin.pathname !== "/" ||
        origin.search !== ""
      )
        return refuseKeyed("INVALID_INPUT", "onboard.refuse.loopback");
      const preset = MODEL_PROVIDER_PRESETS.find((candidate) => candidate.id === "openrouter");
      if (preset === undefined) return refuseKeyed("NOT_FOUND", "onboard.refuse.noOpenRouter");
      const started = signIns.start(origin.origin, async (key) => {
        const stored = await storeProviderKey(deps, config, workspaceId, preset, key);
        if (!stored.ok) {
          const code = TaviErrorCodeSchema.safeParse(stored.error.code);
          throw new TaviError(code.success ? code.data : "UNAVAILABLE", stored.error.message);
        }
        return stored.result;
      });
      return { ok: true, result: { url: started.url, state: started.state } satisfies OnboardingSignInAnswer };
    }
    case "sign-in-status": {
      // A ChatGPT sign-in's state is its own; any other is OpenRouter's.
      const chatGpt = deps.chatGpt?.signIns;
      if (chatGpt?.owns(payload.state) === true)
        return { ok: true, result: chatGpt.status(payload.state) satisfies OnboardingSignInStatusAnswer };
      if (deps.signIns === undefined) return refuseKeyed("UNSUPPORTED", "onboard.refuse.noSignIn");
      return { ok: true, result: deps.signIns.status(payload.state) satisfies OnboardingSignInStatusAnswer };
    }
    case "verify":
      return await verify(deps, workspaceId, payload.role, payload.target);
  }
}

const resultOf = <T>(answer: IpcAnswer<unknown>): T => {
  if (!answer.ok)
    throw Object.assign(new Error(answer.error.message), {
      code: answer.error.code,
      ...(answer.error.i18n === undefined ? {} : { i18n: answer.error.i18n }),
    });
  return answer.result as T;
};

async function detectHere(
  deps: OnboardingCommandDependencies,
  detection: NonNullable<OnboardingCommandDependencies["detection"]>,
): Promise<OnboardingDetectAnswer> {
  return await detect({
    env: detection.env,
    fetch: detection.fetch,
    ...(detection.service === undefined ? {} : { service: detection.service }),
    existing: async () =>
      deps.config === undefined
        ? []
        : resultOf<readonly { readonly connectionId: string }[]>(await deps.config.models({ action: "list" })).map(
            (connection) => connection.connectionId,
          ),
  });
}

/**
 * Use a detected key or local server: one explicit owner action. The
 * key is read here from this process's environment and written to the
 * credential store through `credentials set`; the connection is added — or,
 * when it is the one this flow created, rebound — through `models`, then
 * discovered. Nothing answers the key.
 */
async function connectDetected(
  deps: OnboardingCommandDependencies,
  workspaceId: string,
  presetId: string,
  variable: string | undefined,
): Promise<OnboardingAnswer> {
  const config = deps.config;
  const detection = deps.detection;
  if (config === undefined || detection === undefined) return refuseKeyed("UNSUPPORTED", "onboard.refuse.noConnectDetected");
  const preset = MODEL_PROVIDER_PRESETS.find((candidate) => candidate.id === presetId && candidate.baseUrl !== "");
  if (preset === undefined) return refuseKeyed("INVALID_INPUT", "onboard.refuse.notDetectable", { preset: presetId });
  let value: string;
  if (variable !== undefined) {
    const allowed = (ONBOARDING_ENV_KEYS as Readonly<Record<string, readonly string[]>>)[preset.id] ?? [];
    if (!allowed.includes(variable))
      return refuseKeyed("INVALID_INPUT", "onboard.refuse.notKeyFor", {
        variable,
        provider: preset.name,
        allowed: allowed.length === 0 ? textRef("onboard.refuse.none") : allowed.join(", "),
      });
    const found = (detection.env[variable] ?? "").trim();
    if (found === "") return refuseKeyed("NOT_FOUND", "onboard.refuse.notSet", { variable });
    value = found;
  } else {
    if (!preset.localOnly) return refuseKeyed("INVALID_INPUT", "onboard.refuse.needsKey", { provider: preset.name });
    if (!(await localServerRuns({ fetch: detection.fetch }, preset.id)))
      return refuseKeyed("NOT_FOUND", "onboard.refuse.notRunning", { provider: preset.name });
    // A keyless local server still needs a stored binding: the adapter and discovery resolve one.
    value = LOCAL_NO_KEY_CREDENTIAL;
  }
  return await storeProviderKey(deps, config, workspaceId, preset, value);
}

/**
 * A provider's key stored as a typed one would be: the connection
 * added at the preset's endpoint — or this flow's own rebound, only while it
 * still points there — before its key is stored with `credentials set`, then
 * discovered. The connection id is recorded first; a connection or a stored
 * key of the preset's name that is anyone else's gets a suffix. Nothing
 * answers the key.
 */
/** What a connection is made from: a preset, or Sign in with ChatGPT's own, which speaks the Responses API. */
type StoredProvider = Pick<(typeof MODEL_PROVIDER_PRESETS)[number], "id" | "name" | "baseUrl" | "localOnly"> & {
  readonly wireApi?: "responses";
};

/** Sign in with ChatGPT's connection: OpenAI's API, on the Responses wire, its credential the token record. */
const CHATGPT_PROVIDER: StoredProvider = {
  id: "chatgpt",
  name: "ChatGPT",
  baseUrl: CHATGPT_ENDPOINTS.resource,
  localOnly: false,
  wireApi: "responses",
};

async function storeProviderKey(
  deps: OnboardingCommandDependencies,
  config: NonNullable<OnboardingCommandDependencies["config"]>,
  workspaceId: string,
  preset: StoredProvider,
  value: string,
): Promise<IpcAnswer<OnboardingConnectAnswer>> {
  const connections = new Map(
    resultOf<readonly { readonly connectionId: string; readonly baseUrl: string }[]>(await config.models({ action: "list" })).map(
      (connection) => [connection.connectionId, connection],
    ),
  );
  const stored = new Set(resultOf<{ readonly credentials: readonly string[] }>(await config.credentials({ action: "list" })).credentials);
  const own = (await deps.repositories.onboarding.steps(workspaceId)).find((step) => step.kind === "model")?.createdRef;
  // Only what this flow created is rebound or overwritten (invariant 14), and only while it still points at the
  // preset's own endpoint: a connection or a stored key of the same name that is anyone else's gets a suffix.
  const ours = (candidate: string) =>
    candidate === own &&
    (connections.get(candidate) === undefined ||
      normaliseBaseUrl(connections.get(candidate)?.baseUrl ?? "") === normaliseBaseUrl(preset.baseUrl));
  const free = (candidate: string) => ours(candidate) || (!connections.has(candidate) && !stored.has(candidate));
  let connectionId = preset.id;
  for (let suffix = 2; !free(connectionId); suffix += 1) connectionId = `${preset.id}-${String(suffix)}`;
  const at = deps.now().toISOString();
  // Recorded before the first write, so an interrupted run resumes on the same id.
  await deps.repositories.onboarding.recordCreated({ workspaceId, kind: "model", createdRef: connectionId, now: at });
  try {
    // The connection first, at the preset's own endpoint, then its key: the key is bound to that origin before it is stored.
    if (connections.has(connectionId)) resultOf(await config.models({ action: "rebind", connectionId, credentialRef: connectionId }));
    else
      resultOf(
        await config.models({
          action: "add",
          connectionId,
          label: connectionId === preset.id ? preset.name : `${preset.name} ${connectionId.slice(preset.id.length + 1)}`,
          baseUrl: preset.baseUrl,
          credentialRef: connectionId,
          localOnly: preset.localOnly,
          ...(preset.wireApi === undefined ? {} : { wireApi: preset.wireApi }),
        }),
      );
    resultOf(await config.credentials({ action: "set", reference: connectionId, value }));
    const discovered = resultOf<{ readonly models: readonly { readonly modelId: string }[] }>(
      await config.models({ action: "discover", connectionId }),
    ).models.map((entry) => entry.modelId);
    // What a lifecycle sync stored of this connection's models (one set up again keeps its rows): none for a new one.
    // A failed read proposes models as if none were stored.
    const shown = await config.models({ action: "show", connectionId }).catch(() => undefined);
    const lifecycle = lifecycleByModel(
      shown?.ok === true
        ? ((shown.result as { readonly catalog?: readonly { readonly modelId: string; readonly lifecycle?: ModelLifecycle }[] }).catalog ??
            [])
        : [],
    );
    const suggested = suggestRoles(preset.id, discovered, lifecycle === undefined ? {} : { lifecycle });
    return {
      ok: true,
      result: {
        connectionId,
        models: discovered.slice(0, 500),
        suggested: {
          ...(suggested.main === undefined ? {} : { main: suggested.main }),
          ...(suggested.fast === undefined ? {} : { fast: suggested.fast }),
        },
      } satisfies OnboardingConnectAnswer,
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // A keyed refusal keeps its key, so the canvas still says it in the workspace's language.
    const i18n = TextRefSchema.safeParse((error as { i18n?: unknown }).i18n);
    return {
      ok: false,
      error: {
        code: typeof code === "string" ? code : "UNAVAILABLE",
        message: errorMessage(error),
        ...(i18n.success && i18n.data !== undefined ? { i18n: i18n.data } : {}),
      },
    };
  }
}

/** Verify one role: `models test` on its live target, recorded against the target's credential revision. */
async function verifyRole(
  deps: OnboardingCommandDependencies,
  config: NonNullable<OnboardingCommandDependencies["config"]>,
  workspaceId: string,
  role: OnboardingVerifyRole,
  target: NonNullable<OnboardingLiveFacts["model"]["main"]>,
): Promise<OnboardingVerifyResult> {
  const base = { role, connectionId: target.connectionId, model: target.model } as const;
  if (target.providedBy !== undefined)
    return {
      ...base,
      ok: false,
      errorCode: "provider-managed",
      advice: coreIn(await localeFor(deps, workspaceId))("onboard.say.providedBy", { provider: target.providedBy }),
    };
  const preset = presetOf(target.baseUrl)?.id;
  const context = {
    ...(preset === undefined ? {} : { preset }),
    model: target.model,
    baseUrl: target.baseUrl,
    timeoutMs: DEFAULT_TEST_TIMEOUT_MS,
  };
  const answer = await config.models({ action: "test", connectionId: target.connectionId, model: target.model, workspaceId });
  // The command refused to test (a guard, a gone connection): its own reason, and nothing recorded of the model.
  if (!answer.ok)
    return { ...base, ok: false, errorCode: answer.error.code.toLowerCase().slice(0, 64), advice: answer.error.message.slice(0, 400) };
  const tested = answer.result as {
    readonly ok: boolean;
    readonly capabilities: readonly string[];
    readonly transient?: boolean;
    readonly failureCode?: string;
    readonly message?: string;
  };
  const at = deps.now().toISOString();
  const record = async (ok: boolean, extra: { readonly toolsOk?: boolean; readonly errorCode?: string }) =>
    await deps.repositories.onboarding.recordVerification({
      workspaceId,
      subject: "model",
      role,
      subjectId: target.connectionId,
      model: target.model,
      ...(target.baseUrl === "" ? {} : { baseUrl: target.baseUrl }),
      ...(target.credentialRevision === undefined ? {} : { credentialRevision: target.credentialRevision }),
      ok,
      ...extra,
      at,
    });
  if (tested.ok) {
    const toolsOk = tested.capabilities.includes("tools");
    await record(true, { toolsOk });
    return {
      ...base,
      ok: true,
      toolsOk,
      ...(toolsOk ? {} : { advice: verifyAdvice("no-tools", {}, coreIn(await localeFor(deps, workspaceId))) }),
    };
  }
  const code = classifyVerifyFailure({
    ...(tested.failureCode === undefined ? {} : { modelCode: tested.failureCode }),
    ...(tested.message === undefined ? {} : { message: tested.message }),
  });
  // Only a lasting refusal marks the model failed; a timeout or a busy provider says nothing of it (invariant 17).
  if ((LASTING_VERIFY_CODES as readonly string[]).includes(code) && tested.transient !== true) await record(false, { errorCode: code });
  // The funnel counts every failed verify, transient ones too, by its code.
  await deps.repositories.onboarding.recordEvent({ workspaceId, kind: "model", event: "failed", errorCode: code, now: at });
  // The advice is a person's to read: in the workspace's language.
  return { ...base, ok: false, errorCode: code, advice: verifyAdvice(code, context, coreIn(await localeFor(deps, workspaceId))) };
}

/** `verify`: `main`, then `fast` when it is another target. It never changes the configured target (invariant 3). */
async function verify(
  deps: OnboardingCommandDependencies,
  workspaceId: string,
  only: OnboardingVerifyRole | undefined,
  named?: { readonly connectionId: string; readonly model: string },
): Promise<OnboardingAnswer> {
  const config = deps.config;
  if (config === undefined) return refuseKeyed("UNSUPPORTED", "onboard.refuse.noVerify");
  let targets: readonly (readonly [OnboardingVerifyRole, NonNullable<OnboardingLiveFacts["model"]["main"]> | undefined])[];
  if (named !== undefined && only !== undefined) {
    const target = await deps.target?.(named.connectionId, named.model);
    if (target === undefined) return refuseKeyed("NOT_FOUND", "onboard.refuse.noConnection", { connection: named.connectionId });
    targets = [[only, target]];
  } else {
    const facts = await deps.facts(workspaceId);
    if (facts.model.main === undefined) return refuseKeyed("NOT_CONFIGURED", "onboard.refuse.noModel");
    targets = (
      [
        ["main", facts.model.main],
        ["fast", facts.model.fast],
      ] as const
    ).filter(([role, target]) => target !== undefined && (only === undefined || only === role));
  }
  if (targets.length === 0)
    return refuseKeyed("NOT_CONFIGURED", only === "fast" ? "onboard.refuse.noFastApart" : "onboard.refuse.noMainApart");
  // Every role's gate before any test: a refused second role never wastes the first one's completion.
  const releases: (() => void)[] = [];
  for (const [role] of targets) {
    const release = deps.verifyGate?.begin(`${workspaceId}\u0000${role}`, deps.now().getTime());
    if (deps.verifyGate !== undefined && release === undefined) {
      for (const taken of releases) taken();
      return refuseKeyed("RATE_LIMITED", role === "fast" ? "onboard.refuse.verifyFastSoon" : "onboard.refuse.verifyMainSoon");
    }
    if (release !== undefined) releases.push(release);
  }
  const results: OnboardingVerifyResult[] = [];
  try {
    for (const [role, target] of targets)
      results.push(await verifyRole(deps, config, workspaceId, role, target as NonNullable<typeof target>));
  } finally {
    for (const release of releases) release();
  }
  return { ok: true, result: { results, status: await onboardingStatus(deps, workspaceId) } satisfies OnboardingVerifyAnswer };
}
