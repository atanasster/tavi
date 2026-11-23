import { ONBOARDING_ABI, type OnboardingFlowAnswer } from "@tavi/contracts";

/** The built-in provider's Welcome as the setup tests script it: a model step, an optional About you, and its done page. */
export const WELCOME_FLOW: OnboardingFlowAnswer = {
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
      {
        id: "about",
        kind: "about",
        title: "About you",
        body: "Your name and time zone.",
        optional: true,
        about: { fields: ["name", "timezone"] },
      },
    ],
    done: { title: "You're set up", body: "Ask Tavi anything." },
  },
};
