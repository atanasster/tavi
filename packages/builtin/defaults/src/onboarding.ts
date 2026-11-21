import { ONBOARDING_FEATURED_MAX, type OnboardingFlow, type OnboardingProvider } from "@tavi/contracts";
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

export const BUILTIN_ONBOARDING_FLOW: OnboardingFlow = defineOnboardingFlow({
  version: BUILTIN_ONBOARDING_FLOW_VERSION,
  title: "Welcome to Tavi",
  steps: [
    {
      id: "model",
      kind: "model",
      title: "Choose the model Tavi thinks with",
      body: "Tavi needs one model to answer you. A cloud provider takes a key and bills per use; OpenRouter is one key for many models. A model on this computer (Ollama, LM Studio) is free and private, but small ones handle agent work less well.\nThe key is stored in Tavi's credentials file on this computer, never in a chat.",
      optional: false,
      featured: ["openrouter", "ollama", "anthropic", "openai"],
      recommended: "openrouter",
    },
    {
      id: "about",
      kind: "about",
      title: "About you",
      body: "Your name and time zone, so Tavi addresses you and says times in your zone. They are saved in this workspace's settings and, when memory is on, as two preferences you can see and forget.",
      optional: true,
      about: { fields: ["name", "timezone", "activeHours"] },
    },
    {
      id: "apps",
      kind: "apps",
      title: "Connect an app",
      body: "Let Tavi read your mail or calendar to help with them. Each app says what it reads; anything that sends or changes something asks you first.",
      optional: true,
      featured: ["gmail"],
      surfaces: ["web"],
    },
    {
      id: "tasks",
      kind: "tasks",
      title: "Where do you keep tasks?",
      body: "Tavi keeps a to-do list of its own that works everywhere you reach it, with nothing to set up. If you already keep tasks in an app such as Todoist, connect it and Tavi adds to that instead; nothing is copied between the two.",
      optional: true,
    },
    {
      id: "channels",
      kind: "channels",
      title: "Message Tavi from your phone",
      body: "Reach Tavi from a chat app. You pair yourself with a one-time code; strangers are never answered.",
      optional: true,
      featured: ["telegram"],
    },
    {
      id: "voice",
      kind: "voice",
      title: "Understand voice messages",
      body: "Send Tavi a voice message and it is turned into text on this computer: nothing you say leaves it. That takes FFmpeg and whisper.cpp, which Homebrew installs as your user (never with sudo), and Whisper's base speech model (about 148 MB, MIT licence) from Hugging Face, kept only when its checksum matches.",
      optional: true,
    },
    {
      id: "search",
      kind: "search",
      title: "Web search",
      body: "A search provider lets Tavi look things up. Most need a key of their own; Tavily can start without one, and SearXNG needs only its address.",
      optional: true,
      surfaces: ["web"],
    },
    {
      id: "service",
      kind: "service",
      title: "Keep Tavi running",
      body: "Channels, reminders and schedules work only while tavi serve runs. Tavi can start it with your computer, as your user, never with sudo.",
      optional: true,
      surfaces: ["cli"],
    },
    {
      id: "ideas",
      kind: "ideas",
      title: "Try something",
      body: "A first thing to ask, from what Tavi can do here now. Nothing is sent until you send it.",
      optional: true,
      prompts: [
        { label: "Plan my week", prompt: "Help me plan my week: ask me what I have on, then suggest a simple schedule." },
        {
          label: "Research a topic",
          prompt: "Research a topic for me and give me a short summary with sources. Ask me which topic first.",
          uses: ["web"],
        },
        { label: "Remind me later", prompt: "Remind me tomorrow at 9:00 to check what I asked you today.", uses: ["reminders"] },
      ],
    },
  ],
  done: {
    title: "You're set up",
    body: "Ask Tavi anything. Steps you skipped stay on the Home checklist and in tavi onboard.",
  },
});

/**
 * The built-in provider: the same steps on every surface, featuring only the
 * presets, channels and apps the request says are available now (the host
 * checks that again, and orders and filters by surface). A channel step whose
 * featured channels are none of those installed features the installed ones:
 * Telegram is a preference, never a requirement.
 */
export function createBuiltinOnboardingProvider(): OnboardingProvider {
  return {
    flow: async (request) => {
      request.signal.throwIfAborted();
      return defineOnboardingFlow({
        ...BUILTIN_ONBOARDING_FLOW,
        steps: BUILTIN_ONBOARDING_FLOW.steps.map((step) => {
          const offered = withAvailableFeatured(step, availableFor(step.kind, request));
          return step.kind === "channels" && offered.featured?.length === 0
            ? { ...offered, featured: request.channels.slice(0, ONBOARDING_FEATURED_MAX) }
            : offered;
        }),
      });
    },
  };
}
