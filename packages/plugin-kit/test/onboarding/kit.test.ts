import type { OnboardingFlowStep } from "@tavi/contracts";
import { describe, expect, it } from "vitest";

import { describeOnboardingProviderConformance } from "../../src/onboarding/conformance.js";
import {
  classifyVerifyFailure,
  defineOnboardingFlow,
  isEmbeddingModel,
  stepKinds,
  suggestRoles,
  toolCapableFamily,
  VERIFY_ADVICE_CODES,
  verifyAdvice,
} from "../../src/onboarding/index.js";

/** The onboarding kit. */

const sample = defineOnboardingFlow({
  version: 1,
  title: "Welcome to Tavi",
  steps: [
    {
      id: "model",
      kind: "model",
      title: "Pick a model",
      body: "Tavi needs one model to think with.",
      optional: false,
      featured: ["openrouter", "ollama"],
      recommended: "openrouter",
    },
    {
      id: "about",
      kind: "about",
      title: "About you",
      body: "Your name and time zone.",
      optional: true,
      about: { fields: ["name", "timezone"] },
    },
    { id: "service", kind: "service", title: "Keep it running", body: "Start Tavi with your computer.", optional: true, surfaces: ["cli"] },
    {
      id: "ideas",
      kind: "ideas",
      title: "Try something",
      body: "A first thing to ask.",
      optional: true,
      prompts: [{ label: "Plan my week", prompt: "Help me plan my week." }],
    },
  ],
  done: { title: "All set", body: "Ask me anything." },
});

describeOnboardingProviderConformance("a sample flow", () => ({ flow: async () => sample }));

describe("role suggestions", () => {
  it("proposes a main and a fast model per preset, newest family first", () => {
    const discovered = [
      "openai/gpt-4.1-mini",
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-sonnet-4.5",
      "openai/text-embedding-3-small",
      "meta/llama",
    ];
    expect(suggestRoles("openrouter", discovered)).toEqual({
      main: "anthropic/claude-sonnet-4.5",
      fast: "anthropic/claude-haiku-4.5",
      candidates: [
        "anthropic/claude-sonnet-4.5",
        "anthropic/claude-sonnet-4",
        "anthropic/claude-haiku-4.5",
        "meta/llama",
        "openai/gpt-4.1-mini",
      ],
    });
  });

  it("prefers a plain alias to a dated snapshot", () => {
    expect(suggestRoles("openai", ["gpt-5-2025-08-07", "gpt-5", "gpt-5-mini"])).toMatchObject({ main: "gpt-5", fast: "gpt-5-mini" });
  });

  it("proposes OpenAI's GPT-6 tiers: sol as the main model, luna as the fast one", () => {
    const discovered = [
      "o3",
      "gpt-5",
      "gpt-5-nano",
      "gpt-5.6",
      "gpt-5.4-mini",
      "gpt-6-luna",
      "gpt-6.1-terra",
      "gpt-6.2-sol",
      "gpt-6.2-astra",
    ];
    expect(suggestRoles("openai", discovered)).toMatchObject({ main: "gpt-6.2-sol", fast: "gpt-6-luna" });
    expect(suggestRoles("openrouter", ["openai/gpt-5.6", "openai/gpt-6.1-sol", "openai/gpt-6-luna"])).toMatchObject({
      main: "openai/gpt-6.1-sol",
      fast: "openai/gpt-6-luna",
    });
  });

  it("proposes Gemini 4 before an older Pro, and a newer preview before a deprecated plain model", () => {
    const discovered = [
      "gemini-2.5-pro",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "gemini-3.8-flash",
      "gemini-4-argon",
      "gemini-4-carbon",
    ];
    expect(suggestRoles("gemini", discovered)).toMatchObject({
      main: "gemini-4-carbon",
      fast: "gemini-3.8-flash",
      candidates: ["gemini-4-carbon", "gemini-4-argon", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-3-flash-preview"],
    });
    expect(suggestRoles("gemini", ["models/gemini-2.5-pro", "models/gemini-3.1-pro-preview"])).toMatchObject({
      main: "models/gemini-3.1-pro-preview",
    });
  });

  it("proposes an OpenRouter model's plain id, never its :batch variant, and a variant after the plain id", () => {
    const discovered = [
      "anthropic/claude-sonnet-5.5:batch",
      "anthropic/claude-sonnet-5.5:free",
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-haiku-5.5:batch",
    ];
    expect(suggestRoles("openrouter", discovered)).toEqual({
      main: "anthropic/claude-sonnet-5.5",
      candidates: ["anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5.5:free"],
    });
  });

  it("proposes only tool-capable local models, and no fast model when nothing smaller is there", () => {
    expect(suggestRoles("ollama", ["nomic-embed-text:latest", "gemma2:2b", "qwen3:8b"])).toEqual({
      main: "qwen3:8b",
      candidates: ["qwen3:8b"],
    });
    expect(suggestRoles("ollama", ["qwen3:8b", "qwen3:4b"])).toMatchObject({ main: "qwen3:8b", fast: "qwen3:4b" });
    expect(suggestRoles("ollama", ["gemma2:2b", "mistral-small3.2:24b"])).toMatchObject({ main: "mistral-small3.2:24b" });
  });

  it("falls back to the first chat model for a connection made by hand, and to nothing when there is none", () => {
    expect(suggestRoles("custom", ["zeta", "alpha", "bge-m3"])).toEqual({ main: "alpha", candidates: ["alpha", "zeta"] });
    expect(suggestRoles("openrouter", [])).toEqual({ candidates: [] });
  });

  it("knows embedding models and tool-capable local families", () => {
    for (const model of ["nomic-embed-text", "bge-m3:latest", "all-minilm:l6-v2", "mxbai-embed-large"])
      expect(isEmbeddingModel(model), model).toBe(true);
    for (const model of [
      "qwen3:8b",
      "llama3.1:8b",
      "library/gpt-oss:20b",
      "mistral-small:24b",
      "mistral-small3.2:24b",
      "mistral",
      "meta-llama-3.1-8b-instruct",
      "qwen/qwen3-8b",
    ])
      expect(toolCapableFamily(model), model).toBe(true);
    for (const model of ["gemma2:2b", "llama2:7b", "nomic-embed-text", "phi3:mini"]) expect(toolCapableFamily(model), model).toBe(false);
  });
});

describe("verify advice", () => {
  it("names the provider's key page for a refused key, and how to start a local server", () => {
    expect(verifyAdvice("auth", { preset: "openrouter" })).toBe(
      "The key was refused. Check it, or create a new one at https://openrouter.ai/settings/keys.",
    );
    expect(verifyAdvice("unreachable", { preset: "ollama" })).toBe("Ollama isn't running: start it with `ollama serve`.");
    expect(verifyAdvice("model_unavailable", { preset: "openai", model: "gpt-9" })).toBe("This account can't use gpt-9. Pick another.");
    expect(verifyAdvice("timeout", { preset: "openai", timeoutMs: 20_000 })).toBe(
      "OpenAI didn't answer within 20 seconds. Try again, or pick a smaller model.",
    );
  });

  it("has advice for every code, without a preset", () => {
    for (const code of VERIFY_ADVICE_CODES) expect(verifyAdvice(code).length, code).toBeGreaterThan(10);
  });

  it("classifies a failure by its model code, status or message", () => {
    expect(classifyVerifyFailure({ modelCode: "quota_exceeded" })).toBe("quota_exceeded");
    expect(classifyVerifyFailure({ status: 401 })).toBe("auth");
    expect(classifyVerifyFailure({ message: "NOT_AUTHORIZED: Model listing failed with HTTP 401" })).toBe("auth");
    expect(classifyVerifyFailure({ message: "MODEL_FAILED: 404 model_not_found" })).toBe("model_unavailable");
    expect(classifyVerifyFailure({ message: "UNAVAILABLE: The connection test exceeded 20000ms" })).toBe("timeout");
    expect(classifyVerifyFailure({ message: "UNAVAILABLE: fetch failed: connect ECONNREFUSED 127.0.0.1:11434" })).toBe("unreachable");
    expect(classifyVerifyFailure({ status: 429 })).toBe("rate_limit");
    expect(classifyVerifyFailure({ modelCode: "provider", message: "MODEL_FAILED: boom" })).toBe("provider");
    expect(classifyVerifyFailure({ modelCode: "invalid_request", message: "MODEL_FAILED: The model `m1` does not exist" })).toBe(
      "model_unavailable",
    );
    expect(classifyVerifyFailure({ modelCode: "invalid_request", message: "MODEL_FAILED: max_tokens too large" })).toBe("invalid_request");
  });
});

describe("flow helpers", () => {
  it("fills in the ABI and lists a surface's steps", () => {
    expect(sample.abi).toBe("tavi.onboarding/1");
    expect(stepKinds(sample, "web")).toEqual(["model", "about", "ideas"]);
    expect(stepKinds(sample, "cli")).toEqual(["model", "about", "service", "ideas"]);
  });

  it("refuses a flow the host would refuse", () => {
    const [model, about] = sample.steps as readonly [OnboardingFlowStep, OnboardingFlowStep];
    expect(() => defineOnboardingFlow({ ...sample, steps: [...sample.steps, { ...about, id: "again" }] })).toThrow(/appears twice/);
    expect(() => defineOnboardingFlow({ ...sample, steps: [{ ...model, recommended: "anthropic" }] })).toThrow(/one of featured/);
    expect(() => defineOnboardingFlow({ ...sample, title: "Welcome‮" })).toThrow(/bidirectional/);
    expect(() => defineOnboardingFlow({ ...sample, steps: [] })).toThrow();
  });
});
