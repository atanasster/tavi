import { describe, expect, it } from "vitest";

import {
  FAST_MODEL_FAILED,
  fastModelFailure,
  fastModelFailureIn,
  MODEL_NOT_VERIFIED,
  modelUnverified,
  ONBOARDING_STEP_DETAIL_MAX,
  OnboardingStepStatusSchema,
  onboardingStepDetail,
  verifyAdvice,
  verifyAdviceText,
} from "../src/index.js";
import { createTranslator } from "../src/i18n.js";
import { CORE_BG } from "../src/locales/core-bg.js";
import { CORE_EN } from "../src/locales/core-en.js";
import { coreEnglish } from "../src/locales/core.js";

const bg = createTranslator({ en: CORE_EN, bg: CORE_BG }, "bg");

/** The onboarding host's words in Bulgarian; English is pinned by the host's own tests. */
describe("onboarding words in Bulgarian", () => {
  it("says a failed verify's advice with the provider and model named, and without", () => {
    expect(verifyAdvice("rate_limit", { preset: "openrouter" }, bg)).toBe(
      "OpenRouter ограничава заявките с този ключ. Изчакай минута и опитай пак.",
    );
    expect(verifyAdvice("invalid_request", {}, bg)).toBe(
      "Доставчикът отказа заявката за този модел. Избери друг модел или провери адреса.",
    );
    expect(verifyAdvice("timeout", { timeoutMs: 20_000 }, bg)).toBe(
      "Доставчикът не отговори за 20 секунди. Опитай пак или избери по-малък модел.",
    );
    expect(verifyAdvice("unreachable", { preset: "ollama" }, bg)).toBe("Ollama не работи: пусни го с `ollama serve`.");
  });

  it("keeps English advice as it was", () => {
    expect(verifyAdvice("model_retired")).toBe("this model has been retired. Pick another.");
    expect(verifyAdvice("unreachable", { baseUrl: "http://x" })).toBe(
      "Tavi couldn't reach the provider at http://x. Check the address and your network.",
    );
    expect(verifyAdviceText("auth")).toEqual({ key: "onboarding.advice.auth" });
  });

  it("says a step's detail from its key, a nested advice included", () => {
    const step = OnboardingStepStatusSchema.parse({
      kind: "model",
      state: "done",
      detail: `OpenRouter · m · verified · ${FAST_MODEL_FAILED}: The provider failed. Try again, or pick another model.`,
      detailText: {
        key: "onboarding.model.verifiedFastFailed",
        params: { connection: "OpenRouter", model: "m", fast: { key: "onboarding.advice.failedAny" } },
      },
    });
    expect(onboardingStepDetail(step, bg)).toBe(
      "OpenRouter · m · проверен · бързият модел не работи: Доставчикът даде грешка. Опитай пак или избери друг модел.",
    );
    expect(onboardingStepDetail(step)).toBe(step.detail);
    expect(fastModelFailureIn(step, bg)).toBe("Доставчикът даде грешка. Опитай пак или избери друг модел.");
    expect(fastModelFailureIn(step)).toBe(fastModelFailure(step));
  });

  it("falls back to the English detail for a key this build does not know, and cuts a long one", () => {
    expect(onboardingStepDetail({ detail: "As the owner says it", detailText: { key: "onboarding.unknown" } }, bg)).toBe(
      "As the owner says it",
    );
    expect(
      onboardingStepDetail({ detail: "x", detailText: { key: "onboarding.voice.missing", params: { missing: "я".repeat(400) } } }, bg),
    ).toHaveLength(ONBOARDING_STEP_DETAIL_MAX);
    expect(onboardingStepDetail({ detail: "No model is set up" }, bg)).toBe("No model is set up");
  });

  it("keeps the English templates in step with what the canvas reads from a detail", () => {
    const unverified = coreEnglish("onboarding.model.unverified", { connection: "A", model: "m" });
    expect(unverified).toContain(`· ${MODEL_NOT_VERIFIED} ·`);
    expect(modelUnverified({ kind: "model", state: "done", detail: unverified })).toBe(true);
    expect(coreEnglish("onboarding.model.verifiedFastFailed", { connection: "A", model: "m", fast: "f" })).toContain(
      `${FAST_MODEL_FAILED}: f`,
    );
  });

  it("says the host's own flow and why a plugin's was not used", () => {
    expect(bg("onboarding.flow.ideas.promptLabel")).toBe("Планирай седмицата ми");
    expect(
      bg("onboarding.fallback.notUsed", { provider: "acme.onboarding", reason: bg("onboarding.fallback.deadline", { seconds: "5" }) }),
    ).toBe("не ползвам acme.onboarding: не отговори за 5 сек");
    expect(bg("onboarding.service.selfManaged")).toBe("Ти го пускаш");
  });
});
