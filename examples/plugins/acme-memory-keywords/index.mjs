/**
 * A replacement for the built-in memory provider (docs/MEMORY-PLUGINS.md):
 * no model, `index: "host"`. Recall ranks the `candidates` Tavi hands it by
 * the words they share with the query or, given none (`records` egress off),
 * takes the host's own `lexical` ids. Capture drafts a fact from a person's
 * message that starts "remember that"; Tavi reviews every draft.
 */

const words = (text) =>
  new Set(
    String(text)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3),
  );

export function createKeywordMemory() {
  return {
    async recall(request) {
      request.signal.throwIfAborted();
      const limit = Math.min(request.limit, 50);
      if (request.candidates === undefined) return { hits: (await request.host.lexical(request.query, limit)).slice(0, limit) };
      const asked = words(request.query);
      const hits = request.candidates
        .map((record) => ({
          recordId: record.recordId,
          revisionId: record.revisionId,
          score: [...words(`${record.title ?? ""} ${record.body}`)].filter((word) => asked.has(word)).length,
        }))
        .filter((hit) => hit.score > 0)
        .sort((left, right) => right.score - left.score || left.recordId.localeCompare(right.recordId))
        .slice(0, limit);
      return { hits };
    },
    async capture(request) {
      request.signal.throwIfAborted();
      const proposals = [];
      for (const message of request.span) {
        const said = /^remember that (.+)$/i.exec(message.text.trim());
        if (message.role === "person" && said !== null && proposals.length < request.limits.maxProposals) {
          proposals.push({
            kind: "fact",
            title: said[1].slice(0, 60),
            body: said[1].slice(0, request.limits.bodyChars),
            scope: "everywhere",
            from: "person",
          });
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
  provideMemory(createKeywordMemory());
}
