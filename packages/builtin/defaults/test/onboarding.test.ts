import { describeOnboardingProviderConformance, fullOnboardingRequest } from "@tavi/plugin-kit/onboarding/conformance";
import { stepKinds } from "@tavi/plugin-kit/onboarding";
import { describe, expect, it } from "vitest";

import { BUILTIN_ONBOARDING_FLOW, createBuiltinOnboardingProvider } from "../src/onboarding.js";

/** The built-in onboarding flow. */

describeOnboardingProviderConformance("tavi.onboarding", () => createBuiltinOnboardingProvider());

describe("the built-in onboarding flow", () => {
  it("walks the canvas and the terminal in their own orders", () => {
    expect(stepKinds(BUILTIN_ONBOARDING_FLOW, "web")).toEqual(["model", "about", "apps", "tasks", "channels", "voice", "search", "ideas"]);
    expect(stepKinds(BUILTIN_ONBOARDING_FLOW, "cli")).toEqual(["model", "about", "tasks", "channels", "voice", "service", "ideas"]);
  });

  it("recommends OpenRouter among the featured providers, and features Telegram and Gmail (its account carries the calendar)", () => {
    const steps = new Map(BUILTIN_ONBOARDING_FLOW.steps.map((step) => [step.kind, step]));
    expect(steps.get("model")).toMatchObject({
      featured: ["openrouter", "ollama", "anthropic", "openai"],
      recommended: "openrouter",
      optional: false,
    });
    expect(steps.get("apps")?.featured).toEqual(["gmail"]);
    expect(steps.get("channels")?.featured).toEqual(["telegram"]);
    expect(steps.get("ideas")?.prompts).toHaveLength(3);
  });

  it("says what the model step costs and where the key lives", () => {
    const body = BUILTIN_ONBOARDING_FLOW.steps[0]?.body ?? "";
    expect(body).toContain("bills per use");
    // Where the key lives, in a reader's words: the file's permission bits are not one.
    expect(body).toContain("Tavi's credentials file");
    expect(body).not.toContain("0600");
  });

  it("says which search providers need no key: Tavily to start with, and SearXNG", () => {
    const body = BUILTIN_ONBOARDING_FLOW.steps.find((step) => step.kind === "search")?.body ?? "";
    expect(body).toContain("Tavily");
    expect(body).toContain("SearXNG");
  });

  it("features only what the request offers, and recommends nothing it no longer features", async () => {
    const request = {
      ...fullOnboardingRequest("web", new AbortController().signal),
      presets: ["ollama", "openai"],
      channels: [],
      apps: ["gmail"],
    };
    const steps = new Map((await createBuiltinOnboardingProvider().flow(request)).steps.map((step) => [step.kind, step]));
    expect(steps.get("model")?.featured).toEqual(["ollama", "openai"]);
    expect(steps.get("model")?.recommended).toBeUndefined();
    expect(steps.get("channels")?.featured).toEqual([]);
    expect(steps.get("apps")?.featured).toEqual(["gmail"]);
  });

  it("features the installed channels when Telegram is not one of them", async () => {
    const flowWith = async (channels: readonly string[]) =>
      new Map(
        (
          await createBuiltinOnboardingProvider().flow({ ...fullOnboardingRequest("web", new AbortController().signal), channels })
        ).steps.map((step) => [step.kind, step]),
      ).get("channels")?.featured;
    expect(await flowWith(["telegram", "discord"])).toEqual(["telegram"]);
    expect(await flowWith(["discord", "slack"])).toEqual(["discord", "slack"]);
    expect(await flowWith(["a", "b", "c", "d", "e"])).toHaveLength(4);
  });

  it("refuses a request already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(createBuiltinOnboardingProvider().flow(fullOnboardingRequest("web", controller.signal))).rejects.toThrow("stopped");
  });
});
