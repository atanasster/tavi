/**
 * A memory provider that keeps an index of its own, for tests and as a
 * sample (docs/MEMORY-PLUGINS.md): no model,
 * `index: "own"`. `sync` feeds an in-memory index (a `full` batch replaces it,
 * every removal is honoured); `recall` ranks the records of the scopes it is
 * asked about by the words they share with the query.
 *
 * The plugin's index is `globalThis.__taviMemoryIndex` (a Map by record id),
 * and every batch it took is logged on `globalThis.__taviMemoryIndexSyncs`
 * (ids and reasons only), and each query it was asked on
 * `globalThis.__taviMemoryIndexAsked`, so a test can see what reached it. While
 * `globalThis.__taviMemoryIndexDown` is true its sync throws, as a provider
 * that cannot take a batch now; while `globalThis.__taviMemoryIndexHang` is
 * true it never settles, as a provider that hangs (the host's deadline gives
 * up on it, and its batch's `signal` aborting sets
 * `globalThis.__taviMemoryIndexHangAborted`).
 */

const words = (text) => new Set(String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3));

export function createIndexProvider(index = new Map(), log = []) {
  return {
    async recall(request) {
      (globalThis.__taviMemoryIndexAsked ??= []).push({ purpose: request.purpose, query: request.query, scopeKeys: [...request.scopeKeys] });
      request.signal.throwIfAborted();
      const asked = words(request.query);
      const scopes = new Set(request.scopeKeys);
      const hits = [...index.values()]
        .filter((record) => scopes.size === 0 || scopes.has(record.scopeKey))
        .map((record) => ({ recordId: record.recordId, revisionId: record.revisionId, score: [...words(`${record.title ?? ""} ${record.body}`)].filter((word) => asked.has(word)).length }))
        .filter((hit) => hit.score > 0)
        .sort((left, right) => right.score - left.score || left.recordId.localeCompare(right.recordId))
        .slice(0, Math.min(request.limit, 50));
      return { hits };
    },
    async sync(batch) {
      if (globalThis.__taviMemoryIndexDown === true) throw new Error("the index is down");
      if (globalThis.__taviMemoryIndexHang === true) {
        batch.signal?.addEventListener("abort", () => (globalThis.__taviMemoryIndexHangAborted = true), { once: true });
        return await new Promise(() => {});
      }
      log.push({ full: batch.full === true, upserts: batch.upserts.map((record) => record.recordId), removals: batch.removals.map((removal) => ({ recordId: removal.recordId, reason: removal.reason })) });
      if (batch.full === true) index.clear();
      for (const record of batch.upserts) index.set(record.recordId, { ...record });
      for (const removal of batch.removals) index.delete(removal.recordId);
    },
    status() {
      return { ready: true, indexed: index.size };
    },
  };
}

export function register({ provideMemory }) {
  provideMemory(createIndexProvider((globalThis.__taviMemoryIndex ??= new Map()), (globalThis.__taviMemoryIndexSyncs ??= [])));
}
