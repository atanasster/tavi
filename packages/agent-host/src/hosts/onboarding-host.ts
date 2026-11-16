import {
  FAST_MODEL_FAILED,
  MODEL_NOT_VERIFIED,
  ONBOARDING_ABI,
  ONBOARDING_FEATURED_MAX,
  ONBOARDING_FLOW_DEADLINE_MS,
  ONBOARDING_REQUIRED_STEPS,
  ONBOARDING_STEP_DETAIL_MAX,
  ONBOARDING_STEP_KINDS,
  OnboardingFlowSchema,
  OnboardingStatusSchema,
  verificationMatches,
  onboardingFirstRun,
  type OnboardingFlow,
  type OnboardingFlowRequest,
  type OnboardingFlowStep,
  type OnboardingInstall,
  type OnboardingProvider,
  type OnboardingStatus,
  type OnboardingStepKind,
  type OnboardingStepRecord,
  type OnboardingStepStatus,
  type OnboardingSurface,
  type OnboardingVerification,
  type IdeaCapability,
  availableFor,
  stepOnSurface,
  verifyAdvice,
  VERIFY_ADVICE_CODES,
  withAvailableFeatured,
  type VerifyAdviceCode,
} from "@tavi/contracts";
import { clip } from "@tavi/contracts/util";

/**
 * The onboarding host: what
 * is true, what is allowed, and which flow runs. A provider chooses the steps
 * and their words; the host derives every step's state from live
 * configuration, repairs or replaces a flow it cannot use, and never lets one
 * hide the model step while it is open. Nothing here writes configuration.
 */

/** What the model step's detail says when `fast` failed verify: what steps that run on `fast` read. */
export { FAST_MODEL_FAILED } from "@tavi/contracts";

/** The built-in flow's plugin id; a null `provider_id` means it. */
export const BUILTIN_ONBOARDING_PROVIDER_ID = "tavi.onboarding";

// ------------------------------------------------------------------ registry

export interface OnboardingProviderEntry {
  readonly provider: OnboardingProvider;
  readonly kind: "builtin" | "plugin";
  /** What the person was told at approval. */
  readonly disclosure?: string;
  /** A plugin's flow approved to receive each step's words (`receives: ["status-detail"]`); else kind and state only. */
  readonly receivesDetail?: boolean;
  /** Its plugin's lifetime: aborted when the plugin stops. */
  readonly signal?: AbortSignal;
}

/** The flows installed, by plugin id; withdrawn when their plugin stops. */
export class OnboardingProviderRegistry {
  readonly #entries = new Map<string, OnboardingProviderEntry>();

  install(id: string, entry: OnboardingProviderEntry): () => void {
    this.#entries.set(id, entry);
    return () => {
      if (this.#entries.get(id) === entry) this.#entries.delete(id);
    };
  }

  get(id: string): OnboardingProviderEntry | undefined {
    return this.#entries.get(id);
  }

  list(): readonly (OnboardingProviderEntry & { readonly id: string })[] {
    return [...this.#entries.entries()].map(([id, entry]) => ({ ...entry, id }));
  }
}

// ------------------------------------------------------------------ status

/** A default model target as the host checks it against verifications. */
export interface OnboardingModelTarget {
  readonly connectionId: string;
  readonly model: string;
  readonly baseUrl: string;
  /** The connection's name as a person reads it. */
  readonly label: string;
  /** `providerCredentialRevision` of the bound secret; absent when it could not be read. */
  readonly credentialRevision?: string;
  /** A model plugin's connection, which `models test` cannot verify: the plugin's name. */
  readonly providedBy?: string;
}

/** An app, channel connection or search provider as a step's items list it. */
export interface OnboardingItem {
  readonly id: string;
  readonly label: string;
}

/** What live configuration says, gathered by the owner (or the CLI offline) for one workspace. */
export interface OnboardingLiveFacts {
  readonly model: {
    /** Any model connection exists, in any workspace: what `firstRun` reads. */
    readonly hasConnection: boolean;
    readonly main?: OnboardingModelTarget;
    /** Present only when it is a different target from `main`. */
    readonly fast?: OnboardingModelTarget;
  };
  readonly about: { readonly operatorName?: string; readonly namePreference: boolean };
  /** `installed`: a search provider kind exists here; `ready`: the enabled providers that can answer. */
  readonly search: { readonly installed: boolean; readonly ready: readonly OnboardingItem[] };
  /** `available`: connectable apps; `connected`: those with a signed-in account. */
  readonly apps: { readonly available: readonly OnboardingItem[]; readonly connected: readonly OnboardingItem[] };
  /** `available`: a channel plugin is enabled; `paired`: enabled connections with a bound or allowed person. */
  readonly channels: { readonly available: boolean; readonly connections: readonly (OnboardingItem & { readonly paired: boolean })[] };
  /** `running`: the owner itself runs as the service (`TAVI_SERVICE=1`); `installed`: a unit for this data directory exists. */
  readonly service: { readonly supported: boolean; readonly running: boolean; readonly installed: boolean };
  /** An idea was tried, or the operator started a turn of their own. */
  readonly ideas: { readonly tried: boolean; readonly startedTurn: boolean };
  /**
   * Where the person keeps tasks: `home`, the `tasks.home` setting when one is
   * saved (absent while the default stands); `apps`, the task apps added here,
   * each by its task home (`mcp:<server>`). Absent: nothing could be read.
   */
  readonly tasks?: {
    readonly home?: string;
    readonly apps: readonly (OnboardingItem & { readonly connected: boolean })[];
  };
}

export interface OnboardingFacts extends OnboardingLiveFacts {
  readonly workspaceId: string;
  readonly providerId: string | null;
  readonly install: OnboardingInstall;
  readonly marks: readonly OnboardingStepRecord[];
  readonly verifications: readonly OnboardingVerification[];
  /** The step kinds in flow order, on every surface; status lists exactly these. */
  readonly order: readonly OnboardingStepKind[];
  /** Each step's flow title, and where it is done when not on the surface that asked (`placesOn`). */
  readonly places?: Partial<Record<OnboardingStepKind, { readonly title: string; readonly elsewhere?: OnboardingSurface }>>;
  readonly flowFallback?: string;
  /** The flow in use: its version and every step kind it has, for a dismissed card's return. */
  readonly flow?: { readonly version: number; readonly kinds: readonly OnboardingStepKind[] };
}

/**
 * A dismissed card comes back once when the flow's version is above
 * the dismissed one and an open step is of a kind the dismissed flow did not
 * have: those steps only. A dismissal from before the kinds were kept never
 * comes back, so a version bump alone cannot re-show the card.
 */
function returningSteps(facts: OnboardingFacts, open: readonly OnboardingStepKind[]): readonly OnboardingStepKind[] | undefined {
  const { dismissedAt, dismissedFlowVersion, dismissedStepKinds } = facts.install;
  if (dismissedAt === undefined || facts.flow === undefined || dismissedStepKinds === undefined) return undefined;
  if (facts.flow.version <= (dismissedFlowVersion ?? 0)) return undefined;
  const fresh = open.filter((kind) => !dismissedStepKinds.includes(kind));
  return fresh.length === 0 ? undefined : fresh;
}

const adviceCode = (code: string | undefined): VerifyAdviceCode =>
  (VERIFY_ADVICE_CODES as readonly string[]).includes(code ?? "") ? (code as VerifyAdviceCode) : "provider";

/** The verification of `role` that counts for `target`: one matching its live connection, model, endpoint and revision. */
function modelVerification(
  facts: OnboardingFacts,
  role: "main" | "fast",
  target: OnboardingModelTarget,
): OnboardingVerification | undefined {
  const forRole = facts.verifications.filter(
    (verification) => verification.subject === "model" && verification.role === role && verification.subjectId === target.connectionId,
  );
  // A provider-managed connection has no revision to match: its newest verification of this model, from a turn, is its record.
  if (target.providedBy !== undefined) return forRole.find((verification) => verification.model === target.model);
  const revision = target.credentialRevision;
  if (revision === undefined) return undefined;
  return forRole.find((verification) =>
    verificationMatches(verification, {
      connectionId: target.connectionId,
      model: target.model,
      baseUrl: target.baseUrl,
      credentialRevision: revision,
    }),
  );
}

function modelStep(facts: OnboardingFacts): OnboardingStepStatus {
  const { main, fast } = facts.model;
  if (main === undefined) return { kind: "model", state: "todo", detail: "No model is set up" };
  const name = `${main.label} · ${main.model}`;
  const current = modelVerification(facts, "main", main);
  const fastVerification = fast === undefined ? undefined : modelVerification(facts, "fast", fast);
  const fastFailed = fastVerification?.ok === false ? fastVerification : undefined;
  const fastNote =
    fastFailed === undefined || fast === undefined
      ? ""
      : ` · ${FAST_MODEL_FAILED}: ${verifyAdvice(adviceCode(fastFailed.errorCode), { model: fast.model, baseUrl: fast.baseUrl })}`;
  if (current?.ok === false) {
    return {
      kind: "model",
      state: "todo",
      detail: `${name} · ${verifyAdvice(adviceCode(current.errorCode), { model: main.model, baseUrl: main.baseUrl })}`,
    };
  }
  if (current?.ok === true) {
    const tools = current.toolsOk === false ? ` · ${verifyAdvice("no-tools")}` : "";
    return { kind: "model", state: "done", detail: `${name} · verified${tools}${fastNote}`, verifiedAt: current.at };
  }
  if (main.providedBy !== undefined)
    return { kind: "model", state: "done", detail: `${name} · Provided by ${main.providedBy}, not verified here${fastNote}` };
  // Set up, and chats run on it: done, with Verify offered for the one check not made yet.
  return { kind: "model", state: "done", detail: `${name} · ${MODEL_NOT_VERIFIED} · Verify${fastNote}` };
}

const marked = (facts: OnboardingFacts, kind: OnboardingStepKind): OnboardingStepRecord | undefined =>
  facts.marks.find((mark) => mark.kind === kind);

function liveStep(
  facts: OnboardingFacts,
  kind: Exclude<OnboardingStepKind, "model">,
): Omit<OnboardingStepStatus, "kind"> & { readonly state: "done" | "todo" | "unavailable" } {
  const mark = marked(facts, kind)?.mark;
  switch (kind) {
    case "about": {
      if (facts.about.operatorName !== undefined) return { state: "done", detail: facts.about.operatorName };
      return facts.about.namePreference || mark === "completed"
        ? { state: "done", detail: "Done" }
        : { state: "todo", detail: "Your name and time zone" };
    }
    case "search": {
      if (!facts.search.installed) return { state: "unavailable", detail: "No search provider is installed" };
      const failed = new Set(
        facts.verifications
          .filter((verification) => verification.subject === "search" && !verification.ok)
          .map((verification) => verification.subjectId),
      );
      const ready = facts.search.ready.filter((provider) => !failed.has(provider.id));
      return ready.length > 0
        ? { state: "done", detail: ready.map((provider) => provider.label).join(", ") }
        : { state: "todo", detail: "Web search is not set up" };
    }
    case "apps": {
      const { available, connected } = facts.apps;
      if (available.length === 0 && connected.length === 0) return { state: "unavailable", detail: "No app can be connected here" };
      const items = [
        ...connected.map((app) => ({ ...app, state: "connected" as const })),
        ...available
          .filter((app) => !connected.some((other) => other.id === app.id))
          .map((app) => ({ ...app, state: "available" as const })),
      ];
      return {
        state: connected.length > 0 ? "done" : "todo",
        detail: connected.length > 0 ? connected.map((app) => app.label).join(", ") : "No app is connected",
        items: items.slice(0, 32),
      };
    }
    case "channels": {
      if (!facts.channels.available) return { state: "unavailable", detail: "No channel plugin is enabled" };
      const paired = facts.channels.connections.filter((connection) => connection.paired);
      const items = facts.channels.connections.map(({ id, label, paired: isPaired }) => ({
        id,
        label,
        state: isPaired ? ("connected" as const) : ("needs-sign-in" as const),
      }));
      if (paired.length > 0)
        return { state: "done", detail: paired.map((connection) => connection.label).join(", "), items: items.slice(0, 32) };
      return {
        state: "todo",
        detail: facts.channels.connections.length > 0 ? "Pair yourself on a channel" : "No channel is connected",
        ...(items.length === 0 ? {} : { items: items.slice(0, 32) }),
      };
    }
    case "service": {
      if (!facts.service.supported) return { state: "unavailable", detail: "Runs as a service on macOS and Linux only" };
      if (facts.service.running) return { state: "done", detail: "Running as a service" };
      if (facts.service.installed) return { state: "done", detail: "Service installed" };
      return mark === "self-managed"
        ? { state: "done", detail: "You run it yourself" }
        : { state: "todo", detail: "Channels and schedules stop when tavi serve stops" };
    }
    case "tasks": {
      const apps = facts.tasks?.apps ?? [];
      const items = apps.map(({ id, label, connected }) => ({
        id,
        label,
        state: connected ? ("connected" as const) : ("needs-sign-in" as const),
      }));
      const withItems = items.length === 0 ? {} : { items: items.slice(0, 32) };
      const home = facts.tasks?.home;
      // A saved home is the answer; Tavi's own list chosen as it stands (nothing to save) is the step's mark.
      if (home !== undefined && home !== "tavi")
        return { state: "done", detail: apps.find((app) => app.id === home)?.label ?? home.slice("mcp:".length), ...withItems };
      if (home === "tavi" || mark === "completed") return { state: "done", detail: "Tavi's own list", ...withItems };
      return { state: "todo", detail: "Tavi's own list, or a task app you use", ...withItems };
    }
    case "ideas":
      return facts.ideas.tried || facts.ideas.startedTurn
        ? { state: "done", detail: "Done" }
        : { state: "todo", detail: "Try a first idea" };
    case "info":
      return mark === "seen" || mark === "completed" ? { state: "done", detail: "Seen" } : { state: "todo", detail: "" };
  }
}

/** The status: each step from live state, then the person's marks; nothing is remembered as done. */
export function deriveStatus(facts: OnboardingFacts): OnboardingStatus {
  const model = modelStep(facts);
  const modelBlocks = model.state !== "done";
  const steps = facts.order.map((kind): OnboardingStepStatus => {
    const createdRef = marked(facts, kind)?.createdRef;
    const place = facts.places?.[kind];
    const step = {
      ...(kind === "model" ? model : { kind, ...liveStep(facts, kind) }),
      ...(place === undefined ? {} : { title: place.title, ...(place.elsewhere === undefined ? {} : { elsewhere: place.elsewhere }) }),
    };
    // A detail past the schema's cap (a long label list or advice) is cut, never refused.
    const derived = { ...step, detail: clip(step.detail, ONBOARDING_STEP_DETAIL_MAX) };
    const live = createdRef === undefined ? derived : { ...derived, createdRef };
    if (live.state === "done" || live.state === "unavailable") return live;
    if (marked(facts, kind)?.mark === "skipped") return { ...live, state: "skipped" };
    if (kind === "ideas" && modelBlocks) return { ...live, state: "blocked", blockedBy: "model" };
    return live;
  });
  const required = steps.filter((step) => ONBOARDING_REQUIRED_STEPS.includes(step.kind));
  const open = steps.filter((step) => step.state !== "done" && step.state !== "unavailable").map((step) => step.kind);
  const returning = returningSteps(facts, open);
  return OnboardingStatusSchema.parse({
    workspaceId: facts.workspaceId,
    providerId: facts.providerId,
    steps,
    complete: required.every((step) => step.state === "done"),
    ...(returning !== undefined
      ? { returning }
      : facts.install.dismissedAt === undefined
        ? {}
        : { dismissedAt: facts.install.dismissedAt }),
    firstRun: onboardingFirstRun(facts.install, facts.model.hasConnection),
    ...(facts.install.completedAt === undefined ? {} : { completedAt: facts.install.completedAt }),
    open,
    ...(facts.flowFallback === undefined ? {} : { flowFallback: facts.flowFallback }),
  });
}

// ------------------------------------------------------------------ flow validation

/** What a flow is checked against for one surface. */
export interface FlowContext {
  readonly surface: OnboardingSurface;
  /** The model step is not done: it must come first and may not be optional. */
  readonly modelOpen: boolean;
  readonly presets: readonly string[];
  readonly channels: readonly string[];
  readonly apps: readonly string[];
  /** Ollama is running with a tool-capable model: the recommendation rule's case. */
  readonly ollamaReady: boolean;
  /** The host's own prompts (`hostFallbackFlow`'s), for an ideas step that brings none. */
  readonly fallbackPrompts: NonNullable<OnboardingFlowStep["prompts"]>;
  /** What Tavi can do here now (the Ideas census): a prompt that uses anything else is dropped. */
  readonly census: readonly IdeaCapability[];
}

/** The ideas step's prompts: its own, else the host's fallback ones, less any that needs what the census lacks. */
function promptsFor(step: OnboardingFlowStep, context: FlowContext): NonNullable<OnboardingFlowStep["prompts"]> {
  const own = step.prompts === undefined || step.prompts.length === 0 ? context.fallbackPrompts : step.prompts;
  return own.filter((prompt) => prompt.uses === undefined || prompt.uses.every((capability) => context.census.includes(capability)));
}

const HOST_MODEL_STEP: OnboardingFlowStep = {
  id: "model",
  kind: "model",
  title: "Choose a model",
  body: "Tavi needs one model to think with: a cloud service with a key, or a model running on this computer.",
  optional: false,
};

/**
 * A flow as the host will run it, or a throw when it is unusable: the
 * schema checked, what is not available now dropped from `featured`, the
 * model step present, required and first while open, a service step only in
 * a terminal, an ideas step given prompts, and the recommendation rule
 * applied. A flow left with no step on the surface is refused.
 */
export function validateFlow(raw: unknown, context: FlowContext): OnboardingFlow {
  const parsed = OnboardingFlowSchema.parse(raw);
  let steps = parsed.steps.map((step): OnboardingFlowStep => {
    const rest = withAvailableFeatured(step, availableFor(step.kind, context));
    return {
      ...rest,
      ...(step.kind === "model" ? { optional: false } : {}),
      ...(step.kind === "ideas" ? { prompts: promptsFor(step, context) } : {}),
      // A plugin's own frame is the canvas's: the terminal has nothing to show it in.
      ...(step.frame !== undefined ? { surfaces: ["web" as const] } : {}),
      // Only a terminal can install the service: the canvas lists it, with where it is done.
      ...(step.kind === "service" ? { surfaces: ["cli" as const] } : {}),
    };
  });
  if (!steps.some((step) => step.kind === "model")) steps = [HOST_MODEL_STEP, ...steps];
  if (context.modelOpen) {
    const model = steps.find((step) => step.kind === "model") as OnboardingFlowStep;
    // First on this surface, and shown on it whatever the provider said.
    const { surfaces: _surfaces, ...shown } = model;
    steps = [shown, ...steps.filter((step) => step !== model)];
  }
  if (context.ollamaReady && context.presets.includes("ollama")) {
    steps = steps.map((step) => {
      if (step.kind !== "model") return step;
      const featured = [...new Set(["ollama", ...(step.featured ?? [])])].slice(0, ONBOARDING_FEATURED_MAX);
      return { ...step, featured, recommended: "ollama" };
    });
  }
  const flow = OnboardingFlowSchema.parse({ ...parsed, steps });
  if (!flow.steps.some((step) => stepOnSurface(step, context.surface))) throw new Error(`the flow shows no step on ${context.surface}`);
  return flow;
}

/** The flow used when no provider can answer: every kind once, with plain words. */
export function hostFallbackFlow(): OnboardingFlow {
  const titles: Readonly<Record<OnboardingStepKind, readonly [string, string]>> = {
    model: [HOST_MODEL_STEP.title, HOST_MODEL_STEP.body],
    about: ["About you", "Your name and time zone, so Tavi can address you and say times in your zone."],
    search: ["Web search", "A search provider lets Tavi look things up on the web."],
    apps: ["Connect an app", "Mail, calendar and other apps Tavi can read and act in, with your approval."],
    tasks: ["Where do you keep tasks?", "Tavi's own to-do list, or a task app you already use, such as Todoist."],
    channels: ["Message Tavi", "Reach Tavi from a chat app. Only people you pair are answered."],
    service: ["Keep it running", "Channels and schedules stop when tavi serve stops. Start it with your computer."],
    ideas: ["Try something", "A first thing to ask, from what Tavi can do here."],
    info: ["Good to know", "Tavi asks before it acts on your behalf."],
  };
  return OnboardingFlowSchema.parse({
    abi: ONBOARDING_ABI,
    // Bumped when a kind is added (2: tasks), so a checklist dismissed on this flow comes back once with it.
    version: 2,
    title: "Set up Tavi",
    steps: ONBOARDING_STEP_KINDS.filter((kind) => kind !== "info").map((kind) => ({
      id: kind,
      kind,
      title: titles[kind][0],
      body: titles[kind][1],
      optional: kind !== "model",
      ...(kind === "service" ? { surfaces: ["cli"] } : {}),
      ...(kind === "ideas" ? { prompts: [{ label: "Plan my week", prompt: "Help me plan my week." }] } : {}),
    })),
    done: { title: "All set", body: "Ask Tavi anything, or come back to setup with tavi onboard." },
  });
}

export interface ResolvedFlow {
  readonly flow: OnboardingFlow;
  /** The provider whose flow this is: the selected one, the built-in one, or the host's own when neither answered. */
  readonly providerId: string;
  /** Why the selected provider's flow was not used. */
  readonly fallback?: string;
}

const withDeadline = async <T>(work: (signal: AbortSignal) => Promise<T>, deadlineMs: number, outer?: AbortSignal): Promise<T> => {
  const controller = new AbortController();
  const abort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("deadline"));
          reject(new Error(`it did not answer within ${String(deadlineMs / 1000)} s`));
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener("abort", abort);
  }
};

/** A provider's words for why it failed, never its own text: a thrown message may carry anything. */
const failureReason = (error: unknown): string => {
  if (error instanceof Error && /^it did not answer within/u.test(error.message)) return error.message;
  if (error !== null && typeof error === "object" && "issues" in error) return "its flow is not valid";
  return "it failed";
};

/**
 * The flow for one request: the selected provider's, validated; on any
 * error or past the deadline, the built-in one's, and failing that the host's
 * own. Onboarding can never be broken by a plugin (invariant 7).
 */
/**
 * What a flow is asked with, its own frozen copy (the host validates against
 * its context, which shares nothing with it). A plugin's flow gets the status
 * without its words: each step's kind and state only, so no name,
 * endpoint, model or account label reaches it — unless its approval granted
 * `status-detail`, when it gets each step as Tavi shows it, within the
 * status's own bounds.
 */
function requestFor(
  entry: OnboardingProviderEntry,
  request: Omit<OnboardingFlowRequest, "signal">,
  signal: AbortSignal,
): OnboardingFlowRequest {
  // Granted `status-detail`: each step's words, when it was verified and its rows; never what the flow created, nor
  // the card's or the funnel's own records.
  const detailed = entry.receivesDetail === true;
  const status: OnboardingStatus =
    entry.kind === "builtin"
      ? request.status
      : {
          workspaceId: request.status.workspaceId,
          providerId: request.status.providerId,
          steps: request.status.steps.map((step) => ({
            kind: step.kind,
            state: step.state,
            detail: detailed ? step.detail : "",
            ...(step.blockedBy === undefined ? {} : { blockedBy: step.blockedBy }),
            ...(detailed && step.verifiedAt !== undefined ? { verifiedAt: step.verifiedAt } : {}),
            ...(detailed && step.items !== undefined ? { items: step.items } : {}),
          })),
          complete: request.status.complete,
          firstRun: request.status.firstRun,
          open: [...request.status.open],
        };
  return deepFreeze({
    surface: request.surface,
    status: structuredClone(status),
    census: [...request.census],
    presets: [...request.presets],
    channels: [...request.channels],
    apps: [...request.apps],
    detected: [...request.detected],
    signal,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !(value instanceof AbortSignal) && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

export async function resolveFlow(
  registry: OnboardingProviderRegistry,
  selected: string | null,
  request: Omit<OnboardingFlowRequest, "signal">,
  context: FlowContext,
  options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
): Promise<ResolvedFlow> {
  const deadlineMs = options.deadlineMs ?? ONBOARDING_FLOW_DEADLINE_MS;
  const attempt = async (id: string): Promise<OnboardingFlow> => {
    const entry = registry.get(id);
    if (entry === undefined) throw new Error("it is not installed");
    const signal =
      entry.signal === undefined
        ? options.signal
        : options.signal === undefined
          ? entry.signal
          : AbortSignal.any([entry.signal, options.signal]);
    const raw = await withDeadline(async (inner) => await entry.provider.flow(requestFor(entry, request, inner)), deadlineMs, signal);
    return validateFlow(raw, context);
  };
  const wanted = selected ?? BUILTIN_ONBOARDING_PROVIDER_ID;
  // The built-in flow disabled or not installed is a configuration, not a failure: the host's own flow, said nothing about.
  if (wanted === BUILTIN_ONBOARDING_PROVIDER_ID && registry.get(wanted) === undefined)
    return { flow: validateFlow(hostFallbackFlow(), context), providerId: "host" };
  let fallback: string | undefined;
  try {
    return { flow: await attempt(wanted), providerId: wanted };
  } catch (error) {
    fallback = `${wanted}'s flow was not used: ${failureReason(error)}`;
  }
  if (wanted !== BUILTIN_ONBOARDING_PROVIDER_ID) {
    try {
      return { flow: await attempt(BUILTIN_ONBOARDING_PROVIDER_ID), providerId: BUILTIN_ONBOARDING_PROVIDER_ID, fallback };
    } catch {
      // Neither answered: the host's own flow below.
    }
  }
  return { flow: validateFlow(hostFallbackFlow(), context), providerId: "host", fallback };
}

/** The step kinds a flow walks on a surface, in its order. */
export function flowOrder(flow: OnboardingFlow, surface: OnboardingSurface): readonly OnboardingStepKind[] {
  return flow.steps.filter((step) => stepOnSurface(step, surface)).map((step) => step.kind);
}

/** Each step's title, and, for one not shown on `surface`, the surface it is done on. */
export function placesOn(flow: OnboardingFlow, surface: OnboardingSurface): NonNullable<OnboardingFacts["places"]> {
  return Object.fromEntries(
    flow.steps.map((step) => [
      step.kind,
      { title: step.title, ...(stepOnSurface(step, surface) ? {} : { elsewhere: step.surfaces?.[0] ?? surface }) },
    ]),
  );
}
