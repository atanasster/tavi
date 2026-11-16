/**
 * A replacement for the built-in heartbeat provider (docs/HEARTBEAT-PLUGINS.md):
 * no model and no turns. A new signal whose title shares a word of four
 * letters or more (not a word such as "when" or "tell") with an instruction line is told now, citing that line;
 * everything else stays quiet. Tavi decides what is new, delivers and records.
 */

/** Words an instruction line is made of that name nothing it watches. */
const STOP_WORDS = new Set([
  "when",
  "tell",
  "with",
  "that",
  "this",
  "from",
  "have",
  "about",
  "there",
  "what",
  "them",
  "then",
  "into",
  "only",
  "also",
  "please",
]);

const words = (text) =>
  new Set(
    String(text)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word)),
  );

export function createRuleHeartbeat() {
  return {
    async tick(request) {
      request.signal.throwIfAborted();
      const lines = (request.instructions ?? "").split("\n");
      const items = [];
      for (const signal of request.signals) {
        const title = words(signal.title);
        const line = lines.findIndex((text) => [...words(text)].some((word) => title.has(word)));
        if (line >= 0) {
          items.push({
            key: `rules:${signal.key}`,
            signalKeys: [signal.key],
            urgency: "now",
            title: signal.title.slice(0, 120),
            sources: [{ label: signal.source, ref: signal.key }],
            instructionLine: line + 1,
          });
        }
      }
      return { items };
    },
    status() {
      return { ready: true };
    },
  };
}

export function register({ provideHeartbeat }) {
  provideHeartbeat(createRuleHeartbeat());
}
