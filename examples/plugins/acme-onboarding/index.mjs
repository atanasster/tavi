/**
 * A replacement for the built-in setup flow (docs/ONBOARDING-PLUGINS.md),
 * the guide's "ACME: Slack first, no Telegram". It chooses steps and words
 * only: readiness, every write and the fallback stay Tavi's. Plain JavaScript
 * with no imports, so the guide's `@tavi/plugin-kit/onboarding` helpers are
 * inlined: feature only what the request says is available. Its words are
 * in its language packs (`locales/en.json`, `locales/bg.json`).
 */

/**
 * The steps, their words named by message keys: `ctx.t` reads each from
 * `locales/<lang>.json` in the workspace's language when the flow is asked
 * for, so a language changed in Settings is followed at the next ask.
 */
const STEPS = [
  { id: "model", kind: "model", optional: false, featured: ["openrouter"], recommended: "openrouter" },
  { id: "slack", kind: "channels", optional: true, featured: ["slack"] },
  { id: "about", kind: "about", optional: true, about: { fields: ["name", "timezone"] } },
  { id: "service", kind: "service", optional: true, surfaces: ["cli"] },
  { id: "ideas", kind: "ideas", optional: true },
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

/** The flow, its words from `t` (`ctx.t`), looked up on each ask. */
export function createAcmeOnboarding(t) {
  return {
    async flow(request) {
      request.signal.throwIfAborted();
      const worded = STEPS.map((step) => ({ ...step, title: t(`step.${step.id}.title`), body: t(`step.${step.id}.body`) }));
      return {
        abi: "tavi.onboarding/1",
        version: 1,
        title: t("flow.title"),
        steps: worded.map((step) => withAvailableFeatured(step, availableFor(step.kind, request))),
        done: { title: t("done.title"), body: t("done.body") },
      };
    },
  };
}

export function register({ provideOnboarding, t }) {
  provideOnboarding(createAcmeOnboarding(t));
}
