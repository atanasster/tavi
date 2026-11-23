import { fullOnboardingRequest } from "@tavi/plugin-kit/onboarding/conformance";
import type { OnboardingFlow, OnboardingFlowRequest } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { BUILTIN_ONBOARDING_FLOW, createBuiltinOnboardingProvider } from "../src/onboarding.js";

/** The built-in onboarding flow in the workspace's language: every word a person reads in Bulgarian when it is Bulgarian. */

const request = (locale?: "en" | "bg"): OnboardingFlowRequest => ({
  ...fullOnboardingRequest("web", new AbortController().signal),
  ...(locale === undefined ? {} : { locale }),
});

/** Every text of a flow a person reads or sends. */
const words = (flow: OnboardingFlow): string[] => [
  flow.title ?? "",
  ...flow.steps.flatMap((step) => [step.title, step.body, ...(step.prompts ?? []).flatMap((prompt) => [prompt.label, prompt.prompt])]),
  flow.done?.title ?? "",
  flow.done?.body ?? "",
];

describe("the built-in onboarding flow in Bulgarian", () => {
  it("speaks English byte for byte with no language, or English, named", async () => {
    for (const locale of [undefined, "en"] as const)
      expect(words(await createBuiltinOnboardingProvider().flow(request(locale)))).toEqual(words(BUILTIN_ONBOARDING_FLOW));
  });

  it("writes every title, body and first idea in Bulgarian, the same steps in the same order", async () => {
    const english = await createBuiltinOnboardingProvider().flow(request());
    const bulgarian = await createBuiltinOnboardingProvider().flow(request("bg"));
    expect(bulgarian.title).toBe("Добре дошли в Tavi");
    expect(bulgarian.steps.map((step) => [step.id, step.kind, step.featured, step.surfaces])).toEqual(
      english.steps.map((step) => [step.id, step.kind, step.featured, step.surfaces]),
    );
    expect(bulgarian.steps.find((step) => step.kind === "ideas")?.prompts?.map((prompt) => prompt.uses)).toEqual(
      english.steps.find((step) => step.kind === "ideas")?.prompts?.map((prompt) => prompt.uses),
    );
    // No sentence left in English: every text has Cyrillic in it.
    for (const text of words(bulgarian)) expect(text).toMatch(/\p{Script=Cyrillic}/u);
    expect(bulgarian.steps.find((step) => step.kind === "search")?.body).toContain("Tavily");
  });
});
