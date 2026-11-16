/**
 * A rule-based memory provider, for tests and as a sample
 * (docs/MEMORY-PLUGINS.md): no model, `index: "host"`. It ranks the
 * `candidates` the host hands it by the words they share with the query, or,
 * given none (`records` egress off), the host's own `lexical` ids. Its
 * capture drafts a fact from a person's message that starts "remember that".
 *
 * What each call was given is kept on `globalThis.__taviMemoryKeywordSeen`
 * (ids, counts and the query, so a test can see what egress let through).
 * A query holding `test-hang` waits until its recall is stopped.
 */

const words = (text) => new Set(String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3));

const seen = () => (globalThis.__taviMemoryKeywordSeen ??= []);

export function createKeywordProvider() {
  return {
    async recall(request) {
      seen().push({ call: "recall", purpose: request.purpose, query: request.query, scopeKeys: [...request.scopeKeys], candidates: request.candidates?.map((record) => ({ recordId: record.recordId, scopeKey: record.scopeKey })) });
      request.signal.throwIfAborted();
      if (request.query.includes("test-hang")) {
        await new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
      }
      const limit = Math.min(request.limit, 50);
      if (request.candidates === undefined) return { hits: (await request.host.lexical(request.query, limit)).slice(0, limit) };
      const asked = words(request.query);
      const hits = request.candidates
        .map((record) => ({ recordId: record.recordId, revisionId: record.revisionId, score: [...words(`${record.title ?? ""} ${record.body}`)].filter((word) => asked.has(word)).length }))
        .filter((hit) => hit.score > 0)
        .sort((left, right) => right.score - left.score || left.recordId.localeCompare(right.recordId))
        .slice(0, limit);
      return { hits };
    },
    async capture(request) {
      seen().push({ call: "capture", span: request.span.length, known: request.known.map((entry) => entry.recordId) });
      request.signal.throwIfAborted();
      const proposals = [];
      for (const message of request.span) {
        const said = /^remember that (.+)$/i.exec(message.text.trim());
        if (message.role === "person" && said !== null && proposals.length < request.limits.maxProposals) {
          proposals.push({ kind: "fact", title: said[1].slice(0, 60), body: said[1].slice(0, request.limits.bodyChars), scope: "everywhere", from: "person" });
        }
      }
      return { proposals };
    },
    status() {
      return { ready: true };
    },
  };
}

export function register({ provideMemory }) {
  provideMemory(createKeywordProvider());
}
