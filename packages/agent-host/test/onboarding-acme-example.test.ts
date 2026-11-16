import { ONBOARDING_ABI, type OnboardingProvider } from "@tavi/contracts";
import { availableFor, defineOnboardingFlow, withAvailableFeatured } from "@tavi/plugin-kit/onboarding";
import { describeOnboardingProviderConformance } from "@tavi/plugin-kit/onboarding/conformance";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_ONBOARDING_PROVIDER_ID,
  flowOrder,
  OnboardingProviderRegistry,
  resolveFlow,
  type FlowContext,
} from "../src/hosts/onboarding-host.js";

/**
 * docs/ONBOARDING-PLUGINS.md's worked example, as the guide prints it: ACME's flow puts Slack first and leaves Telegram out. It passes the
 * conformance suite, changes the order both the canvas and the terminal walk,
 * and once its plugin is gone the host falls back to the built-in flow.
 */

// ---- the example, as in the guide -------------------------------------------
const acmeOnboarding: OnboardingProvider = {
  async flow(request) {
    request.signal.throwIfAborted();
    const steps = [
      {
        id: "model",
        kind: "model",
        title: "Pick the model ACME pays for",
        body: "Use the company OpenRouter key from the ACME wiki.",
        optional: false,
        featured: ["openrouter"],
        recommended: "openrouter",
      },
      {
        id: "slack",
        kind: "channels",
        title: "Message Tavi from Slack",
        body: "Pair yourself in #tavi. Telegram is not used at ACME.",
        optional: true,
        featured: ["slack"],
      },
      {
        id: "about",
        kind: "about",
        title: "About you",
        body: "Your name and time zone.",
        optional: true,
        about: { fields: ["name", "timezone"] },
      },
      {
        id: "service",
        kind: "service",
        title: "Keep Tavi running",
        body: "Start it with your computer.",
        optional: true,
        surfaces: ["cli"],
      },
      { id: "ideas", kind: "ideas", title: "Try something", body: "A few things Tavi can do for you now.", optional: true },
    ] as const;
    return defineOnboardingFlow({
      abi: ONBOARDING_ABI,
      version: 1,
      title: "Welcome to Tavi at ACME",
      steps: steps.map((step) => withAvailableFeatured(step, availableFor(step.kind, request))),
      done: { title: "You're set up", body: "Questions? #tavi-help." },
    });
  },
};
// ------------------------------------------------------------------------------

describeOnboardingProviderConformance("ACME example", () => acmeOnboarding);

const context = (surface: FlowContext["surface"], channels: readonly string[]): FlowContext => ({
  surface,
  modelOpen: true,
  presets: ["openrouter", "openai"],
  channels,
  apps: ["gmail"],
  ollamaReady: false,
  fallbackPrompts: [{ label: "Plan my week", prompt: "Help me plan my week." }],
  census: [],
});
const request = (surface: FlowContext["surface"], channels: readonly string[]) => ({
  surface,
  status: { workspaceId: "default", providerId: "acme.onboarding", steps: [], complete: false, firstRun: true, open: [] },
  census: [],
  presets: ["openrouter", "openai"],
  channels,
  apps: ["gmail"],
  detected: [],
});

describe("a plugin's flow in the host", () => {
  it("changes the order the canvas and the terminal walk, featuring Slack only where it is installed", async () => {
    const registry = new OnboardingProviderRegistry();
    registry.install("acme.onboarding", { provider: acmeOnboarding, kind: "plugin" });
    const web = await resolveFlow(
      registry,
      "acme.onboarding",
      request("web", ["slack", "telegram"]),
      context("web", ["slack", "telegram"]),
    );
    expect(web.providerId).toBe("acme.onboarding");
    expect(flowOrder(web.flow, "web")).toEqual(["model", "channels", "about", "ideas"]);
    expect(web.flow.steps.find((step) => step.kind === "channels")?.featured).toEqual(["slack"]);
    const cli = await resolveFlow(registry, "acme.onboarding", request("cli", []), context("cli", []));
    expect(flowOrder(cli.flow, "cli")).toEqual(["model", "channels", "about", "service", "ideas"]);
    expect(cli.flow.steps.find((step) => step.kind === "channels")?.featured ?? []).toEqual([]);
  });

  it("falls back to the built-in flow once the plugin's flow is withdrawn", async () => {
    const registry = new OnboardingProviderRegistry();
    registry.install(BUILTIN_ONBOARDING_PROVIDER_ID, {
      provider: {
        flow: async () =>
          defineOnboardingFlow({
            version: 1,
            title: "Welcome",
            steps: [{ id: "model", kind: "model", title: "Model", body: "Pick one.", optional: false }],
            done: { title: "Done", body: "Done." },
          }),
      },
      kind: "builtin",
    });
    const withdraw = registry.install("acme.onboarding", { provider: acmeOnboarding, kind: "plugin" });
    expect((await resolveFlow(registry, "acme.onboarding", request("web", []), context("web", []))).providerId).toBe("acme.onboarding");
    withdraw();
    const after = await resolveFlow(registry, "acme.onboarding", request("web", []), context("web", []));
    expect(after.providerId).toBe(BUILTIN_ONBOARDING_PROVIDER_ID);
  });

  it("hands a plugin's flow the status without its words, in a copy it cannot change", async () => {
    const registry = new OnboardingProviderRegistry();
    let seen: Parameters<OnboardingProvider["flow"]>[0] | undefined;
    registry.install("acme.onboarding", {
      provider: {
        flow: async (given) => {
          seen = given;
          return await acmeOnboarding.flow(given);
        },
      },
      kind: "plugin",
    });
    const status = {
      workspaceId: "default",
      providerId: "acme.onboarding",
      steps: [
        { kind: "about" as const, state: "done" as const, detail: "Robin" },
        { kind: "model" as const, state: "done" as const, detail: "OpenRouter · anthropic/claude-sonnet · https://openrouter.ai/api/v1" },
      ],
      complete: true,
      firstRun: false,
      open: [],
    };
    const asked = { ...request("web", ["slack"]), status };
    await resolveFlow(registry, "acme.onboarding", asked, context("web", ["slack"]));
    expect(JSON.stringify(seen?.status)).not.toContain("Robin");
    expect(JSON.stringify(seen?.status)).not.toContain("openrouter.ai");
    expect(seen?.status.steps.map((step) => [step.kind, step.state])).toEqual([
      ["about", "done"],
      ["model", "done"],
    ]);
    expect(Object.isFrozen(seen?.status.steps[0])).toBe(true);
    expect(Object.isFrozen(seen?.channels)).toBe(true);
    expect(seen?.channels).not.toBe(asked.channels);
  });
});
