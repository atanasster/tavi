/**
 * A rule-based heartbeat provider (docs/HEARTBEAT-PLUGINS.md), for tests:
 * no model. A new signal whose title shares a word of four letters or more
 * with an instruction line is told now, citing that line. What each tick was
 * given is kept on `globalThis.__taviRuleProviderSeen`, so a test can see what
 * egress let through.
 *
 * Lines starting `test:` make it misbehave on purpose: `test: flood` answers
 * 50 items, `test: extra-field` adds a field the contract does not have,
 * `test: huge` a 1 MB body, and `test: hang` waits until its tick is stopped.
 */

const words = (text) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4));

export function createRuleProvider() {
  return {
    async tick(request) {
      const lines = (request.instructions ?? "").split("\n");
      (globalThis.__taviRuleProviderSeen ??= []).push({
        instructions: request.instructions,
        signals: request.signals.length,
        recent: request.recent.length,
        memory: request.memory.length,
      });
      const tests = new Set(lines.map((line) => line.trim()).filter((line) => line.startsWith("test:")).map((line) => line.slice(5).trim()));
      if (tests.has("hang")) {
        await new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
      }
      if (tests.has("flood")) {
        return { items: Array.from({ length: 50 }, (_, index) => ({ key: `rules:flood:${index}`, urgency: "later", title: `Flood item ${index}`, sources: [{ label: "Rules" }] })) };
      }
      const items = [];
      for (const signal of request.signals) {
        const title = words(signal.title);
        const line = lines.findIndex((text) => !text.trim().startsWith("test:") && [...words(text)].some((word) => title.has(word)));
        if (line >= 0) items.push({ key: `rules:${signal.key}`, signalKeys: [signal.key], urgency: "now", title: signal.title.slice(0, 120), sources: [{ label: signal.source, ref: signal.key }], instructionLine: line + 1 });
      }
      if (tests.has("extra-field")) items.push({ key: "rules:extra", urgency: "now", title: "Has a field it may not", sources: [{ label: "Rules" }], unexpected: true });
      if (tests.has("huge")) items.push({ key: "rules:huge", urgency: "now", title: "Too long a body", body: "x".repeat(1024 * 1024), sources: [{ label: "Rules" }] });
      return { items };
    },
    status() {
      return { ready: true };
    },
  };
}

export function register({ provideHeartbeat }) {
  provideHeartbeat(createRuleProvider());
}
