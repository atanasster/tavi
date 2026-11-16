import { describe, expect, it } from "vitest";

import {
  IdeaChipSchema,
  keyPageOf,
  MODEL_PROVIDER_PRESETS,
  ONBOARDING_ENV_VARIABLES,
  OnboardingDetectAnswerSchema,
  OnboardingFlowSchema,
  OnboardingFlowStepSchema,
  OnboardingPayloadSchema,
  OnboardingStatusSchema,
  OnboardingVerificationSchema,
  WORKSPACE_SETTING_KEYS,
  WorkspaceSettingsSchema,
  onboardingEnvPreset,
  type OnboardingFlow,
  type OnboardingStatus,
} from "../src/index.js";

/** Onboarding's contracts. */

const status: OnboardingStatus = {
  workspaceId: "default",
  providerId: "tavi.onboarding",
  steps: [
    {
      kind: "model",
      state: "done",
      detail: "OpenRouter · anthropic/claude-sonnet · verified 2 min ago",
      verifiedAt: "2026-10-20T09:00:00.000Z",
    },
    { kind: "channels", state: "todo", detail: "", items: [{ id: "telegram", label: "Telegram", state: "available" }] },
    { kind: "ideas", state: "blocked", detail: "", blockedBy: "model" },
  ],
  complete: true,
  firstRun: false,
  open: ["channels", "ideas"],
};

const flow: OnboardingFlow = {
  abi: "tavi.onboarding/1",
  version: 1,
  title: "Welcome to Tavi",
  steps: [
    {
      id: "model",
      kind: "model",
      title: "Pick a model",
      body: "Tavi needs one model.\nLocal or cloud.",
      optional: false,
      featured: ["openrouter"],
      recommended: "openrouter",
    },
  ],
  done: { title: "All set", body: "Ask me anything." },
};

describe("onboarding contracts", () => {
  it("round-trips a status and a flow", () => {
    expect(OnboardingStatusSchema.parse(status)).toEqual(status);
    expect(OnboardingFlowSchema.parse(flow)).toEqual(flow);
  });

  it("holds flow copy to plain text, and an ideas step alone to prompts", () => {
    const step = flow.steps[0];
    expect(OnboardingFlowSchema.safeParse({ ...flow, title: "Two\nlines" }).success).toBe(false);
    expect(OnboardingFlowSchema.safeParse({ ...flow, title: "x".repeat(81) }).success).toBe(false);
    expect(OnboardingFlowSchema.safeParse({ ...flow, steps: [{ ...step, prompts: [{ label: "Hi", prompt: "Hello" }] }] }).success).toBe(
      false,
    );
    expect(OnboardingFlowSchema.safeParse({ ...flow, steps: [{ ...step, featured: ["a", "b", "c", "d", "e"] }] }).success).toBe(false);
    expect(OnboardingFlowSchema.safeParse({ ...flow, abi: "tavi.onboarding/2" }).success).toBe(false);
    expect(OnboardingFlowSchema.safeParse({ ...flow, extra: true }).success).toBe(false);
  });

  it("accepts every action's payload, and refuses an env variable outside the allowlist", () => {
    for (const payload of [
      { action: "status" },
      { action: "flow", surface: "cli" },
      { action: "detect" },
      { action: "connect-detected", preset: "openrouter", variable: "OPENROUTER_API_KEY" },
      { action: "connect-detected", preset: "ollama" },
      { action: "verify" },
      { action: "verify", role: "fast" },
      { action: "skip", step: "channels" },
      { action: "restore", step: "channels" },
      { action: "complete-step", step: "about" },
      { action: "confirm-service", mode: "self-managed" },
      { action: "dismiss" },
      { action: "complete" },
      { action: "reset", workspaceId: "default" },
      { action: "provider" },
      { action: "provider", id: "acme.onboarding" },
    ])
      expect(OnboardingPayloadSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(true);
    expect(
      OnboardingPayloadSchema.safeParse({ action: "connect-detected", preset: "openai", variable: "AWS_SECRET_ACCESS_KEY" }).success,
    ).toBe(false);
    expect(OnboardingPayloadSchema.safeParse({ action: "skip", step: "everything" }).success).toBe(false);
    expect(OnboardingDetectAnswerSchema.safeParse({ env: ["HOME"], local: [], existing: [] }).success).toBe(false);
  });

  it("maps each allowlisted variable to its preset", () => {
    expect(ONBOARDING_ENV_VARIABLES).toEqual([
      "OPENROUTER_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
    ]);
    expect(onboardingEnvPreset("GOOGLE_API_KEY")).toBe("gemini");
    expect(onboardingEnvPreset("OPENROUTER_API_KEY")).toBe("openrouter");
  });

  it("holds a verification to a revision hash, never a value", () => {
    const base = {
      workspaceId: "default",
      subject: "model",
      role: "main",
      subjectId: "openrouter",
      model: "m",
      ok: true,
      at: "2026-10-20T09:00:00.000Z",
    } as const;
    expect(OnboardingVerificationSchema.safeParse({ ...base, credentialRevision: "f".repeat(64) }).success).toBe(true);
    expect(OnboardingVerificationSchema.safeParse({ ...base, credentialRevision: "sk-or-v1-secret" }).success).toBe(false);
  });

  it("gives an idea chip an optional uses line", () => {
    expect(
      IdeaChipSchema.parse({ label: "Plan", prompt: "Plan my week", uses: [{ capability: "calendar", approval: false }] }).uses,
    ).toEqual([{ capability: "calendar", approval: false }]);
    expect(IdeaChipSchema.parse({ label: "Plan", prompt: "Plan my week" }).uses).toBeUndefined();
  });

  it("adds operator.name to the workspace settings, as one line of plain text", () => {
    expect(WORKSPACE_SETTING_KEYS).toContain("operatorName");
    expect(WorkspaceSettingsSchema.parse({ operatorName: "  Robin " })).toEqual({ operatorName: "Robin" });
    expect(WorkspaceSettingsSchema.safeParse({ operatorName: "" }).success).toBe(false);
    expect(WorkspaceSettingsSchema.safeParse({ operatorName: "A‮B" }).success).toBe(false);
    expect(WorkspaceSettingsSchema.safeParse({ operatorName: "x".repeat(81) }).success).toBe(false);
  });
});

describe("an info step's frame", () => {
  const step = (kind: string, frame: string) => ({ id: "s", kind, title: "Title", body: "Body.", optional: true, frame });
  it("is a contribution id, on an info step only", () => {
    expect(OnboardingFlowStepSchema.safeParse(step("info", "intro")).success).toBe(true);
    expect(OnboardingFlowStepSchema.safeParse(step("about", "intro")).success).toBe(false);
    expect(OnboardingFlowStepSchema.safeParse(step("info", "../evil")).success).toBe(false);
  });
});

describe("the closing screen's id", () => {
  it("is reserved: a step named done is refused with a clear message, as is a flow holding one", () => {
    const done = { id: "done", kind: "about", title: "Title", body: "Body.", optional: true };
    const parsed = OnboardingFlowStepSchema.safeParse(done);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({ path: ["id"], message: expect.stringContaining("reserved for the closing screen") }),
    ]);
    expect(OnboardingFlowSchema.safeParse({ ...flow, steps: [...flow.steps, done] }).success).toBe(false);
    // Only the exact id: one that merely starts with it is a step like any other.
    expect(OnboardingFlowStepSchema.safeParse({ ...done, id: "done-today" }).success).toBe(true);
  });
});

describe("where a key is made", () => {
  it("is a cloud provider's keys page, and its documentation where it names none", () => {
    const preset = (id: string) => MODEL_PROVIDER_PRESETS.find((each) => each.id === id)!;
    expect(keyPageOf(preset("openrouter"))).toBe("https://openrouter.ai/settings/keys");
    expect(keyPageOf(preset("anthropic"))).toBe("https://platform.claude.com/settings/keys");
    // A local server takes no key of a provider's: its documentation is what there is.
    expect(keyPageOf(preset("ollama"))).toBe(preset("ollama").docsUrl);
    // Every provider that takes a key, but Custom (whatever endpoint it is), says where one is made.
    for (const each of MODEL_PROVIDER_PRESETS.filter((one) => one.requiresKey && one.id !== "custom"))
      expect(each.keysUrl, each.id).toMatch(/^https:\/\//);
  });
});
