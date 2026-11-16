/**
 * A replacement for the built-in Jev router (docs/PLUGINS.md, Routing
 * providers): no model and no network, so it costs nothing and reports no
 * usage. A candidate's probability is the share of its description's words
 * the task's prompt mentions; the `model` feature picks `fast` for a short
 * task and `main` for a long one. Tavi applies the thresholds, egress and
 * deadlines, and falls back to its baseline on any failure.
 */

const SHORT_PROMPT_CHARS = 400;

const words = (text) =>
  new Set(
    String(text)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3),
  );

/** How much of `description` the prompt mentions, in [0.05, 0.95]: never certain either way. */
function overlap(prompt, description) {
  const wanted = words(description);
  if (wanted.size === 0) return 0.05;
  const asked = words(prompt);
  const shared = [...wanted].filter((word) => asked.has(word)).length;
  return Math.min(0.95, Math.max(0.05, shared / wanted.size));
}

export function createKeywordRouter() {
  return {
    async classify(request) {
      request.signal.throwIfAborted();
      if (request.features[0] === "model") {
        const short = (request.prompts.model ?? "").length <= SHORT_PROMPT_CHARS;
        return { choice: short ? "fast" : "main", probabilities: short ? { main: 0.1, fast: 0.9 } : { main: 0.9, fast: 0.1 } };
      }
      const probabilities = {};
      for (const candidate of request.candidates)
        probabilities[candidate.id] = overlap(request.prompts[candidate.feature] ?? "", candidate.description);
      return { probabilities };
    },
    status: () => ({ ready: true }),
  };
}

export function register({ provideRouter }) {
  provideRouter(createKeywordRouter());
}
