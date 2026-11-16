/**
 * A replacement for the built-in setup flow (docs/ONBOARDING-PLUGINS.md),
 * the guide's "ACME: Slack first, no Telegram". It chooses steps and words
 * only: readiness, every write and the fallback stay Tavi's. Plain JavaScript
 * with no imports, so the guide's `@tavi/plugin-kit/onboarding` helpers are
 * inlined: feature only what the request says is available.
 */

const STEPS = [
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
  { id: "service", kind: "service", title: "Keep Tavi running", body: "Start it with your computer.", optional: true, surfaces: ["cli"] },
  { id: "ideas", kind: "ideas", title: "Try something", body: "A few things Tavi can do for you now.", optional: true },
];

/** What a step of `kind` may feature now: presets, channel kinds or app ids. */
function availableFor(kind, request) {
  return kind === "model" ? request.presets : kind === "channels" ? request.channels : kind === "apps" ? request.apps : undefined;
}

/** `step` featuring only what is available, recommending only what it still features. */
function withAvailableFeatured(step, available) {
  if (available === undefined || step.featured === undefined) return step;
  const featured = step.featured.filter((id) => available.includes(id));
  const { featured: _featured, recommended, ...rest } = step;
  return { ...rest, featured, ...(recommended !== undefined && featured.includes(recommended) ? { recommended } : {}) };
}

export const acmeOnboarding = {
  async flow(request) {
    request.signal.throwIfAborted();
    return {
      abi: "tavi.onboarding/1",
      version: 1,
      title: "Welcome to Tavi at ACME",
      steps: STEPS.map((step) => withAvailableFeatured(step, availableFor(step.kind, request))),
      done: { title: "You're set up", body: "Questions? #tavi-help." },
    };
  },
};

export function register({ provideOnboarding }) {
  provideOnboarding(acmeOnboarding);
}
