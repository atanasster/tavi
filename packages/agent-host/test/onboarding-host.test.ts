import {
  ONBOARDING_ABI,
  ONBOARDING_STEP_DETAIL_MAX,
  type OnboardingFlow,
  type OnboardingStatus,
  type OnboardingStepKind,
  type OnboardingVerification,
} from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_ONBOARDING_PROVIDER_ID,
  OnboardingProviderRegistry,
  deriveStatus,
  flowOrder,
  placesOn,
  hostFallbackFlow,
  resolveFlow,
  validateFlow,
  type FlowContext,
  type OnboardingFacts,
} from "../src/hosts/onboarding-host.js";

/** The onboarding host: status from live state, and the flow it runs. */

const AT = "2026-10-20T09:00:00.000Z";
const REVISION = "a".repeat(64);
const ORDER: readonly OnboardingStepKind[] = ["model", "about", "search", "apps", "channels", "service", "ideas"];
const MAIN = {
  connectionId: "openrouter",
  model: "anthropic/claude-sonnet",
  baseUrl: "https://openrouter.ai/api/v1",
  label: "OpenRouter",
  credentialRevision: REVISION,
};

const verified = (overrides: Partial<OnboardingVerification> = {}): OnboardingVerification => ({
  workspaceId: "default",
  subject: "model",
  role: "main",
  subjectId: MAIN.connectionId,
  model: MAIN.model,
  baseUrl: MAIN.baseUrl,
  credentialRevision: REVISION,
  ok: true,
  toolsOk: true,
  at: AT,
  ...overrides,
});

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    workspaceId: "default",
    providerId: null,
    install: { providerId: null },
    marks: [],
    verifications: [],
    order: ORDER,
    model: { hasConnection: false },
    about: { namePreference: false },
    search: { installed: true, ready: [] },
    apps: { available: [{ id: "gmail", label: "Gmail" }], connected: [] },
    channels: { available: true, connections: [] },
    service: { supported: true, running: false, installed: false },
    ideas: { tried: false, startedTurn: false },
    ...overrides,
  };
}

const stateOf = (status: OnboardingStatus, kind: OnboardingStepKind) => status.steps.find((step) => step.kind === kind)?.state;

describe("onboarding status", () => {
  it("is a first run with everything open on an empty install, the ideas step blocked by the model", () => {
    const status = deriveStatus(facts());
    expect(status.firstRun).toBe(true);
    expect(status.complete).toBe(false);
    expect(status.steps.map((step) => [step.kind, step.state])).toEqual([
      ["model", "todo"],
      ["about", "todo"],
      ["search", "todo"],
      ["apps", "todo"],
      ["channels", "todo"],
      ["service", "todo"],
      ["ideas", "blocked"],
    ]);
    expect(status.steps.find((step) => step.kind === "ideas")?.blockedBy).toBe("model");
    expect(status.open).toEqual(ORDER);
  });

  it("takes the tasks step as done for a saved home or Tavi's own list marked, with the task apps as its rows", () => {
    const tasksOf = (status: OnboardingStatus) => status.steps.find((step) => step.kind === "tasks");
    const order: readonly OnboardingStepKind[] = ["model", "tasks"];
    expect(tasksOf(deriveStatus(facts({ order })))).toMatchObject({ state: "todo", detail: "Tavi's own list, or a task app you use" });
    const marked = facts({ order, marks: [{ workspaceId: "default", kind: "tasks", mark: "completed", at: AT }] });
    expect(tasksOf(deriveStatus(marked))).toMatchObject({ state: "done", detail: "Tavi's own list" });
    const saved = facts({
      order,
      tasks: {
        home: "mcp:todoist2",
        apps: [
          { id: "mcp:todoist", label: "Todoist (home)", connected: false },
          { id: "mcp:todoist2", label: "Todoist (work)", connected: true },
        ],
      },
    });
    expect(tasksOf(deriveStatus(saved))).toEqual({
      kind: "tasks",
      state: "done",
      detail: "Todoist (work)",
      items: [
        { id: "mcp:todoist", label: "Todoist (home)", state: "needs-sign-in" },
        { id: "mcp:todoist2", label: "Todoist (work)", state: "connected" },
      ],
    });
    // A home whose server is no longer listed is still the answer, by its server name.
    expect(tasksOf(deriveStatus(facts({ order, tasks: { home: "mcp:things", apps: [] } })))?.detail).toBe("things");
  });

  it("names every step the flow has, on every surface, with its title and where a step this surface does not do is done", () => {
    const flowed = validateFlow(flow([step("model"), step("apps", { surfaces: ["web"] }), step("service")]), context());
    const status = deriveStatus(
      facts({
        order: flowed.steps.map((entry) => entry.kind),
        places: placesOn(flowed, "cli"),
        model: { hasConnection: true, main: MAIN },
      }),
    );
    expect(status.steps.map((entry) => [entry.kind, entry.title, entry.elsewhere])).toEqual([
      ["model", flowed.steps[0]?.title, undefined],
      ["apps", flowed.steps[1]?.title, "web"],
      ["service", flowed.steps[2]?.title, undefined],
    ]);
    expect(deriveStatus(facts({ order: ["service"], places: placesOn(flowed, "web") })).steps[0]?.elsewhere).toBe("cli");
  });

  it("marks the model done only with a verification of the live target, and complete with it", () => {
    const live = facts({ model: { hasConnection: true, main: MAIN }, verifications: [verified()] });
    const status = deriveStatus(live);
    expect(stateOf(status, "model")).toBe("done");
    expect(status.steps[0]).toMatchObject({ detail: "OpenRouter · anthropic/claude-sonnet · verified", verifiedAt: AT });
    expect(status.complete).toBe(true);
    expect(status.firstRun).toBe(false);
    expect(stateOf(status, "ideas")).toBe("todo");
  });

  it("keeps a model set up but asks to verify it again when the default model, its endpoint or its key changes", () => {
    const base = { hasConnection: true, main: MAIN };
    for (const main of [
      { ...MAIN, model: "openai/gpt-5" },
      { ...MAIN, baseUrl: "https://example.com/v1" },
      { ...MAIN, credentialRevision: "b".repeat(64) },
    ]) {
      const model = deriveStatus(facts({ model: { ...base, main }, verifications: [verified()] })).steps.find(
        (step) => step.kind === "model",
      );
      // Chats run on it: set up, with Verify offered — never "not set up".
      expect(model?.state, JSON.stringify(main)).toBe("done");
      expect(model?.detail).toMatch(/not verified yet · Verify$/);
    }
  });

  it("reports a failed verify with advice, and a model that called no tool as done with a warning", () => {
    const failed = deriveStatus(
      facts({
        model: { hasConnection: true, main: MAIN },
        verifications: [verified({ ok: false, toolsOk: undefined, errorCode: "auth" })],
      }),
    );
    expect(failed.steps[0]).toMatchObject({ state: "todo", detail: expect.stringContaining("The key was refused") });
    const noTools = deriveStatus(facts({ model: { hasConnection: true, main: MAIN }, verifications: [verified({ toolsOk: false })] }));
    expect(noTools.steps[0]).toMatchObject({ state: "done", detail: expect.stringContaining("didn't call a tool") });
  });

  it("keeps the model done when only the fast model failed, and says so", () => {
    const fast = { ...MAIN, model: "anthropic/claude-haiku" };
    const status = deriveStatus(
      facts({
        model: { hasConnection: true, main: MAIN, fast },
        verifications: [
          verified(),
          verified({ role: "fast", model: fast.model, ok: false, toolsOk: undefined, errorCode: "model_unavailable" }),
        ],
      }),
    );
    expect(status.steps[0]).toMatchObject({
      state: "done",
      detail: expect.stringContaining("Fast model failed: This account can't use anthropic/claude-haiku"),
    });
  });

  it("shows a provider-managed connection as done, unverified, until a turn fails it", () => {
    const { credentialRevision: _revision, ...unbound } = MAIN;
    const main = { ...unbound, providedBy: "acme.models" };
    expect(deriveStatus(facts({ model: { hasConnection: true, main } })).steps[0]).toMatchObject({
      state: "done",
      detail: expect.stringContaining("Provided by acme.models, not verified here"),
    });
    expect(
      stateOf(
        deriveStatus(
          facts({
            model: { hasConnection: true, main },
            verifications: [verified({ credentialRevision: undefined, ok: false, toolsOk: undefined, errorCode: "auth" })],
          }),
        ),
        "model",
      ),
    ).toBe("todo");
  });

  it("derives each optional step's done and unavailable states from live state", () => {
    const done = deriveStatus(
      facts({
        about: { operatorName: "Robin", namePreference: false },
        search: { installed: true, ready: [{ id: "brave", label: "Brave" }] },
        apps: { available: [{ id: "gmail", label: "Gmail" }], connected: [{ id: "gmail", label: "Gmail" }] },
        channels: { available: true, connections: [{ id: "telegram", label: "Telegram", paired: true }] },
        service: { supported: true, running: false, installed: true },
        ideas: { tried: true, startedTurn: false },
      }),
    );
    expect(done.steps.slice(1).map((step) => step.state)).toEqual(["done", "done", "done", "done", "done", "done"]);
    const unavailable = deriveStatus(
      facts({
        search: { installed: false, ready: [] },
        apps: { available: [], connected: [] },
        channels: { available: false, connections: [] },
        service: { supported: false, running: false, installed: false },
      }),
    );
    expect(["search", "apps", "channels", "service"].map((kind) => stateOf(unavailable, kind as OnboardingStepKind))).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(unavailable.open).toEqual(["model", "about", "ideas"]);
  });

  it("is not done for a channel with nobody paired, nor search whose verify failed", () => {
    const status = deriveStatus(
      facts({
        channels: { available: true, connections: [{ id: "telegram", label: "Telegram", paired: false }] },
        search: { installed: true, ready: [{ id: "brave", label: "Brave" }] },
        verifications: [{ workspaceId: "default", subject: "search", subjectId: "brave", ok: false, errorCode: "auth", at: AT }],
      }),
    );
    expect(stateOf(status, "channels")).toBe("todo");
    expect(stateOf(status, "search")).toBe("todo");
  });

  it("applies skips and marks, but never over a step that is done", () => {
    const status = deriveStatus(
      facts({
        about: { operatorName: "Robin", namePreference: false },
        marks: [
          { workspaceId: "default", kind: "about", mark: "skipped", at: AT },
          { workspaceId: "default", kind: "channels", mark: "skipped", at: AT },
          { workspaceId: "default", kind: "service", mark: "self-managed", at: AT },
        ],
      }),
    );
    expect([stateOf(status, "about"), stateOf(status, "channels"), stateOf(status, "service")]).toEqual(["done", "skipped", "done"]);
    expect(deriveStatus(facts({ marks: [{ workspaceId: "default", kind: "about", mark: "completed", at: AT }] })).steps[1]?.state).toBe(
      "done",
    );
  });
});

describe("edge cases", () => {
  it("cuts a long detail to the schema's limit rather than refusing the status", () => {
    const labels = Array.from({ length: 40 }, (_, index) => ({
      id: `search-${index}`,
      label: `A rather long search provider name ${index}`,
    }));
    const detail =
      deriveStatus(facts({ search: { installed: true, ready: labels } })).steps.find((entry) => entry.kind === "search")?.detail ?? "";
    expect(detail).toHaveLength(ONBOARDING_STEP_DETAIL_MAX);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("drops a prompt that uses what the census lacks, its own or the fallback's", () => {
    const prompts = [
      { label: "Plan my week", prompt: "Help me plan my week." },
      { label: "Research", prompt: "Research a topic.", uses: ["web" as const] },
    ];
    const ideasOf = (result: OnboardingFlow) =>
      result.steps.find((entry) => entry.kind === "ideas")?.prompts?.map((prompt) => prompt.label);
    expect(ideasOf(validateFlow(flow([step("model"), step("ideas", { prompts })]), context()))).toEqual(["Plan my week"]);
    expect(ideasOf(validateFlow(flow([step("model"), step("ideas", { prompts })]), context({ census: ["web"] })))).toEqual([
      "Plan my week",
      "Research",
    ]);
    expect(ideasOf(validateFlow(flow([step("model"), step("ideas")]), context({ fallbackPrompts: prompts })))).toEqual(["Plan my week"]);
  });
});

const context = (overrides: Partial<FlowContext> = {}): FlowContext => ({
  surface: "web",
  modelOpen: true,
  presets: ["openrouter", "ollama", "openai"],
  channels: ["telegram"],
  apps: ["gmail"],
  ollamaReady: false,
  fallbackPrompts: [{ label: "Plan my week", prompt: "Help me plan my week." }],
  census: [],
  ...overrides,
});

const flow = (steps: OnboardingFlow["steps"]): OnboardingFlow => ({
  abi: ONBOARDING_ABI,
  version: 1,
  title: "Welcome",
  steps,
  done: { title: "Done", body: "Done." },
});
const step = (kind: OnboardingStepKind, extra: Partial<OnboardingFlow["steps"][number]> = {}) => ({
  id: kind,
  kind,
  title: kind,
  body: kind,
  optional: true,
  ...extra,
});

describe("a dismissed checklist", () => {
  const dismissed = (version: number, kinds?: readonly OnboardingStepKind[]) => ({
    providerId: null,
    dismissedAt: AT,
    dismissedFlowVersion: version,
    ...(kinds === undefined ? {} : { dismissedStepKinds: [...kinds] }),
  });

  it("stays dismissed for the same version, and for a newer one that adds no step", () => {
    expect(deriveStatus(facts({ install: dismissed(1, ORDER), flow: { version: 1, kinds: ORDER } }))).toMatchObject({ dismissedAt: AT });
    const bumped = deriveStatus(facts({ install: dismissed(1, ORDER), flow: { version: 2, kinds: ORDER } }));
    expect(bumped.dismissedAt).toBe(AT);
    expect(bumped.returning).toBeUndefined();
  });

  it("comes back once with only the open steps a newer version adds", () => {
    const before = ORDER.filter((kind) => kind !== "search");
    const status = deriveStatus(facts({ install: dismissed(1, before), flow: { version: 2, kinds: ORDER } }));
    expect(status.returning).toEqual(["search"]);
    expect(status.dismissedAt).toBeUndefined();
    // A new step already done brings nothing back.
    const searched = deriveStatus(
      facts({
        install: dismissed(1, before),
        flow: { version: 2, kinds: ORDER },
        search: { installed: true, ready: [{ id: "brave", label: "Brave" }] },
      }),
    );
    expect(searched.returning).toBeUndefined();
    expect(searched.dismissedAt).toBe(AT);
    // Dismissed again for version 2: final.
    expect(deriveStatus(facts({ install: dismissed(2, ORDER), flow: { version: 2, kinds: ORDER } })).returning).toBeUndefined();
  });

  it("says when setup was first finished, so Home can promise the morning's ideas", () => {
    expect(deriveStatus(facts({ install: { providerId: null, completedAt: AT } })).completedAt).toBe(AT);
    expect(deriveStatus(facts()).completedAt).toBeUndefined();
  });

  it("never comes back for a dismissal that kept no kinds", () => {
    expect(deriveStatus(facts({ install: dismissed(1), flow: { version: 5, kinds: ORDER } }))).toMatchObject({ dismissedAt: AT });
  });
});

describe("flow validation", () => {
  it("forces the model step first and required while it is open", () => {
    const missing = validateFlow(flow([step("about"), step("ideas")]), context());
    expect(missing.steps.map((entry) => entry.kind)).toEqual(["model", "about", "ideas"]);
    const later = validateFlow(flow([step("about"), step("model", { surfaces: ["cli"] })]), context());
    expect(later.steps[0]).toMatchObject({ kind: "model", optional: false });
    expect(later.steps[0]?.surfaces).toBeUndefined();
    // Done, a flow may put it where it likes.
    expect(validateFlow(flow([step("about"), step("model")]), context({ modelOpen: false })).steps.map((entry) => entry.kind)).toEqual([
      "about",
      "model",
    ]);
  });

  it("drops what is not available, keeps a service step a terminal's, and gives an ideas step prompts", () => {
    const valid = validateFlow(
      flow([
        step("model", { featured: ["openrouter", "acme"], recommended: "acme" }),
        step("channels", { featured: ["telegram", "slack"] }),
        step("service"),
        step("ideas"),
      ]),
      context(),
    );
    expect(valid.steps.map((entry) => entry.kind)).toEqual(["model", "channels", "service", "ideas"]);
    expect(valid.steps[2]?.surfaces).toEqual(["cli"]);
    expect(valid.steps[0]).toMatchObject({ featured: ["openrouter"] });
    expect(valid.steps[0]?.recommended).toBeUndefined();
    expect(valid.steps[1]?.featured).toEqual(["telegram"]);
    expect(valid.steps[3]?.prompts).toEqual([{ label: "Plan my week", prompt: "Help me plan my week." }]);
    expect(validateFlow(flow([step("model"), step("service")]), context({ surface: "cli" })).steps.map((entry) => entry.kind)).toEqual([
      "model",
      "service",
    ]);
  });

  it("recommends Ollama when it runs a tool-capable model, whatever the flow says", () => {
    const valid = validateFlow(
      flow([step("model", { featured: ["openrouter", "openai"], recommended: "openrouter" })]),
      context({ ollamaReady: true }),
    );
    expect(valid.steps[0]).toMatchObject({ featured: ["ollama", "openrouter", "openai"], recommended: "ollama" });
  });

  it("refuses an invalid flow", () => {
    expect(() => validateFlow({ ...flow([step("model")]), abi: "tavi.onboarding/9" }, context())).toThrow();
  });
});

describe("a framed info step", () => {
  it("is the canvas's alone, whatever surfaces the flow named", () => {
    const framed = validateFlow(flow([step("model"), step("info", { frame: "intro", surfaces: ["cli"] })]), context({ surface: "web" }));
    expect(framed.steps.find((candidate) => candidate.kind === "info")?.surfaces).toEqual(["web"]);
    const terminal = validateFlow(flow([step("model"), step("info", { frame: "intro" })]), context({ surface: "cli" }));
    expect(flowOrder(terminal, "cli")).toEqual(["model"]);
  });
});

describe("flow resolution", () => {
  const request = { surface: "web" as const, status: deriveStatus(facts()), census: [], presets: [], channels: [], apps: [], detected: [] };

  it("uses the selected provider's flow, validated", async () => {
    const registry = new OnboardingProviderRegistry();
    registry.install("acme.onboarding", { provider: { flow: async () => flow([step("about"), step("model")]) }, kind: "plugin" });
    const resolved = await resolveFlow(registry, "acme.onboarding", request, context());
    expect(resolved).toMatchObject({ providerId: "acme.onboarding" });
    expect(resolved.fallback).toBeUndefined();
    expect(resolved.flow.steps[0]?.kind).toBe("model");
  });

  it("tells a plugin's flow each step's words only when its approval granted status-detail", async () => {
    const detailed = {
      ...request,
      status: {
        ...request.status,
        steps: request.status.steps.map((entry) => (entry.kind === "model" ? { ...entry, detail: "OpenRouter · verified" } : entry)),
      },
    };
    const seen: Record<string, string | undefined> = {};
    const registry = new OnboardingProviderRegistry();
    for (const [id, receivesDetail] of [
      ["acme.plain", false],
      ["acme.detail", true],
    ] as const)
      registry.install(id, {
        provider: {
          flow: async (asked) => {
            seen[id] = asked.status.steps.find((entry) => entry.kind === "model")?.detail;
            return flow([step("model")]);
          },
        },
        kind: "plugin",
        ...(receivesDetail ? { receivesDetail } : {}),
      });
    await resolveFlow(registry, "acme.plain", detailed, context());
    await resolveFlow(registry, "acme.detail", detailed, context());
    expect(seen).toEqual({ "acme.plain": "", "acme.detail": "OpenRouter · verified" });
  });

  it("falls back to the built-in flow when the selected one throws, is slow or is invalid, and to the host's own after that", async () => {
    const registry = new OnboardingProviderRegistry();
    registry.install(BUILTIN_ONBOARDING_PROVIDER_ID, {
      provider: { flow: async () => flow([step("model"), step("about")]) },
      kind: "builtin",
    });
    registry.install("acme.throws", {
      provider: {
        flow: async () => {
          throw new Error("secret sk-123 leaked");
        },
      },
      kind: "plugin",
    });
    registry.install("acme.slow", { provider: { flow: async () => await new Promise<never>(() => undefined) }, kind: "plugin" });
    registry.install("acme.invalid", { provider: { flow: async () => ({ abi: "nope" }) as unknown as OnboardingFlow }, kind: "plugin" });
    const thrown = await resolveFlow(registry, "acme.throws", request, context());
    expect(thrown).toMatchObject({ providerId: BUILTIN_ONBOARDING_PROVIDER_ID, fallback: "acme.throws's flow was not used: it failed" });
    expect(thrown.fallback).not.toContain("sk-123");
    expect(await resolveFlow(registry, "acme.slow", request, context(), { deadlineMs: 20 })).toMatchObject({
      providerId: BUILTIN_ONBOARDING_PROVIDER_ID,
      fallback: expect.stringContaining("did not answer"),
    });
    expect(await resolveFlow(registry, "acme.invalid", request, context())).toMatchObject({
      providerId: BUILTIN_ONBOARDING_PROVIDER_ID,
      fallback: expect.stringContaining("not valid"),
    });
    const none = await resolveFlow(new OnboardingProviderRegistry(), null, request, context());
    expect(none.providerId).toBe("host");
    expect(none.fallback).toBeUndefined();
    expect(flowOrder(none.flow, "web")).toEqual(["model", "about", "search", "apps", "tasks", "channels", "ideas"]);
    expect(flowOrder(hostFallbackFlow(), "cli")).toContain("service");
  });
});
