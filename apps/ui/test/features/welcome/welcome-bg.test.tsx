// @vitest-environment jsdom
import { ONBOARDING_ABI, type OnboardingFlowAnswer, type OnboardingStatus } from "@tavi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Welcome } from "../../../src/features/welcome/Welcome.js";
import { setLocale } from "../../../src/lib/i18n.js";
import type { SettingsClient } from "../../../src/lib/ipc.js";
import { flush, settledBy, unmountAll } from "../../support/dom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Setup's Welcome in Bulgarian: its rail, its step counter and its own controls. The flow's titles are the owner's, and stay as sent. */

const { mount } = settledBy(() => flush(6));

beforeEach(async () => {
  await setLocale("bg");
});

afterEach(async () => {
  unmountAll();
  await setLocale("en");
});

const FLOW: OnboardingFlowAnswer = {
  providerId: "tavi.onboarding",
  flow: {
    abi: ONBOARDING_ABI,
    version: 1,
    title: "Welcome to Tavi",
    steps: [
      {
        id: "model",
        kind: "model",
        title: "Choose the model Tavi thinks with",
        body: "Tavi needs one model.",
        optional: false,
        featured: ["openrouter", "openai"],
        recommended: "openrouter",
      },
      { id: "about", kind: "about", title: "About you", body: "Your name.", optional: true, about: { fields: ["name", "timezone"] } },
    ],
    done: { title: "You're set up", body: "Ask Tavi anything." },
  },
};

const status = (model: "todo" | "done", providerId: string | null = "tavi.onboarding"): OnboardingStatus => ({
  workspaceId: "default",
  providerId,
  steps: [
    { kind: "model", state: model, detail: "" },
    { kind: "about", state: "todo", detail: "" },
  ],
  complete: model === "done",
  firstRun: model === "todo",
  open: model === "done" ? ["about"] : ["model", "about"],
});

const owner = (answers: Record<string, unknown>): SettingsClient => ({
  request: (async (command: string, payload: Record<string, unknown>) => ({
    ok: true,
    result: answers[`${command}:${String(payload["action"])}`] ?? {},
  })) as SettingsClient["request"],
});

const welcome = (client: SettingsClient, stepId?: string) => (
  <Welcome client={client} workspaceId="default" stepId={stepId} all onStep={() => {}} onLeave={() => {}} onSettings={() => {}} />
);

describe("Welcome in Bulgarian", () => {
  it("counts the steps, names the rail and offers the model providers", async () => {
    const page = await mount(
      welcome(
        owner({ "onboarding:flow": FLOW, "onboarding:status": status("todo"), "onboarding:detect": { env: [], local: [], existing: [] } }),
      ),
    );
    expect(page.querySelector("ol[aria-label='Стъпки']")).not.toBeNull();
    expect(page.querySelector(".welcome-progress")?.textContent).toBe("Готови: 0 от 2");
    expect(page.querySelector(".welcome-panel .eyebrow")?.textContent).toBe("Стъпка 1 от 2");
    expect(page.textContent).toContain("Препоръчан");
    for (const word of ["0 of 2 done", "Step 1 of 2", "Recommended", "Show all providers", "Model providers"])
      expect(page.textContent).not.toContain(word);
    expect(page.querySelector("ol[aria-label='Setup steps']")).toBeNull();
  });

  it("marks an optional step, and offers to skip it or leave it for later", async () => {
    const page = await mount(welcome(owner({ "onboarding:flow": FLOW, "onboarding:status": status("done") }), "about"));
    expect(page.querySelector(".welcome-progress")?.textContent).toBe("Готови: 1 от 2");
    expect(page.querySelector(".welcome-panel .eyebrow")?.textContent).toBe("Стъпка 2 от 2 · по желание");
    expect(page.textContent).toContain("По-късно");
    for (const word of ["1 of 2 done", "optional", "Do this later", "Don't show again", "Skip", "Continue", "Back"])
      expect(page.textContent).not.toContain(word);
  });

  it("says a step's state from its key, not the owner's English", async () => {
    const done = status("done");
    const answer: OnboardingStatus = {
      ...done,
      steps: [
        done.steps[0] ?? { kind: "model", state: "done", detail: "" },
        { kind: "about", state: "done", detail: "Done", detailText: { key: "onboarding.step.done" } },
      ],
    };
    const page = await mount(welcome(owner({ "onboarding:flow": FLOW, "onboarding:status": answer }), "about"));
    expect(page.querySelector(".welcome-state")?.textContent).toBe("Готово");
  });

  it("says setup is turned off when no flow is installed", async () => {
    const page = await mount(welcome(owner({ "onboarding:flow": FLOW, "onboarding:status": status("todo", null) })));
    expect(page.querySelector("h1")?.textContent).toBe("Първите стъпки са изключени");
    expect(page.textContent).not.toContain("Guided setup is turned off");
    expect(page.textContent).not.toContain("Go to Home");
  });
});
