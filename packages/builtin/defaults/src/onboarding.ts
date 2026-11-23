import { ONBOARDING_FEATURED_MAX, type OnboardingFlow, type OnboardingProvider } from "@tavi/contracts";
import { coreEnglish, type CoreT } from "@tavi/contracts/locales/core";
import { coreIn } from "@tavi/contracts/locales/core-server";
import { availableFor, defineOnboardingFlow, withAvailableFeatured } from "@tavi/plugin-kit/onboarding";

/**
 * The built-in onboarding flow, `tavi.onboarding`. One list of steps, which
 * the host shows per surface:
 * - the canvas walks model → about → apps → tasks → channels → voice → search → ideas;
 * - the terminal walks model → about → tasks → channels → voice → service → ideas, and
 *   leaves apps and search to the canvas, where a browser sign-in is at home
 *   (its tasks step points at the commands that connect a task app).
 * The copy says what each step reads, changes and costs. The host
 * applies the recommendation rule — Ollama when it runs a tool-capable model —
 * over the OpenRouter recommended here.
 */

/** Bumped when a step is added: a dismissed checklist comes back once, with only the new steps. */
export const BUILTIN_ONBOARDING_FLOW_VERSION = 3;

/**
 * The built-in flow in `t`'s words: every title, body and first idea a person
 * reads (and sends, for an idea's prompt) comes from the `plugins.onboarding.*`
 * catalogue keys. English by default.
 */
export function builtinOnboardingFlow(t: CoreT = coreEnglish): OnboardingFlow {
  return defineOnboardingFlow({
    version: BUILTIN_ONBOARDING_FLOW_VERSION,
    title: t("plugins.onboarding.title"),
    steps: [
      {
        id: "model",
        kind: "model",
        title: t("plugins.onboarding.model.title"),
        body: t("plugins.onboarding.model.body"),
        optional: false,
        featured: ["openrouter", "ollama", "anthropic", "openai"],
        recommended: "openrouter",
      },
      {
        id: "about",
        kind: "about",
        title: t("plugins.onboarding.about.title"),
        body: t("plugins.onboarding.about.body"),
        optional: true,
        about: { fields: ["name", "timezone", "activeHours"] },
      },
      {
        id: "apps",
        kind: "apps",
        title: t("plugins.onboarding.apps.title"),
        body: t("plugins.onboarding.apps.body"),
        optional: true,
        featured: ["gmail"],
        surfaces: ["web"],
      },
      {
        id: "tasks",
        kind: "tasks",
        title: t("plugins.onboarding.tasks.title"),
        body: t("plugins.onboarding.tasks.body"),
        optional: true,
      },
      {
        id: "channels",
        kind: "channels",
        title: t("plugins.onboarding.channels.title"),
        body: t("plugins.onboarding.channels.body"),
        optional: true,
        featured: ["telegram"],
      },
      {
        id: "voice",
        kind: "voice",
        title: t("plugins.onboarding.voice.title"),
        body: t("plugins.onboarding.voice.body"),
        optional: true,
      },
      {
        id: "search",
        kind: "search",
        title: t("plugins.onboarding.search.title"),
        body: t("plugins.onboarding.search.body"),
        optional: true,
        surfaces: ["web"],
      },
      {
        id: "service",
        kind: "service",
        title: t("plugins.onboarding.service.title"),
        body: t("plugins.onboarding.service.body"),
        optional: true,
        surfaces: ["cli"],
      },
      {
        id: "ideas",
        kind: "ideas",
        title: t("plugins.onboarding.ideas.title"),
        body: t("plugins.onboarding.ideas.body"),
        optional: true,
        prompts: [
          { label: t("plugins.onboarding.ideas.week.label"), prompt: t("plugins.onboarding.ideas.week.prompt") },
          {
            label: t("plugins.onboarding.ideas.research.label"),
            prompt: t("plugins.onboarding.ideas.research.prompt"),
            uses: ["web"],
          },
          { label: t("plugins.onboarding.ideas.remind.label"), prompt: t("plugins.onboarding.ideas.remind.prompt"), uses: ["reminders"] },
        ],
      },
    ],
    done: {
      title: t("plugins.onboarding.done.title"),
      body: t("plugins.onboarding.done.body"),
    },
  });
}

export const BUILTIN_ONBOARDING_FLOW: OnboardingFlow = builtinOnboardingFlow();

/**
 * The built-in provider: the same steps on every surface, featuring only the
 * presets, channels and apps the request says are available now, in its
 * language (the host
 * checks that again, and orders and filters by surface). A channel step whose
 * featured channels are none of those installed features the installed ones:
 * Telegram is a preference, never a requirement.
 */
export function createBuiltinOnboardingProvider(): OnboardingProvider {
  return {
    flow: async (request) => {
      request.signal.throwIfAborted();
      // In the request's language (the workspace's), English when it names none.
      const flow =
        request.locale === undefined || request.locale === "en" ? BUILTIN_ONBOARDING_FLOW : builtinOnboardingFlow(coreIn(request.locale));
      return defineOnboardingFlow({
        ...flow,
        steps: flow.steps.map((step) => {
          const offered = withAvailableFeatured(step, availableFor(step.kind, request));
          return step.kind === "channels" && offered.featured?.length === 0
            ? { ...offered, featured: request.channels.slice(0, ONBOARDING_FEATURED_MAX) }
            : offered;
        }),
      });
    },
  };
}
