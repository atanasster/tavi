import { tokensOf } from "./text.js";

/**
 * Lexical themes: TF-IDF vectors per item, average-linkage
 * agglomerative clustering by cosine similarity, merging until the closest
 * two clusters are less alike than `tau`. The nearest-neighbour chain keeps
 * it O(n²), fine for the few thousand items a topic holds.
 */
export const CLUSTER_ITEMS_MAX = 3_000;
/**
 * The similarity below which clusters are left apart, tuned on the 4.2
 * fixture: its three themes come out exactly for any tau from 0.10 to 0.25
 * (and, with noise made of shared filler words, best at 0.12 to 0.15).
 */
export const CLUSTER_TAU = 0.15;

type Vector = Map<string, number>;

/** Each text's TF-IDF vector, unit length; words in at most one text, or in more than half, carry nothing. */
export function tfidfVectors(texts: readonly string[], stopwords: ReadonlySet<string> = new Set()): Vector[] {
  const counts = texts.map((text) => {
    const tf = new Map<string, number>();
    for (const token of tokensOf(text)) if (!stopwords.has(token) && token.length > 1) tf.set(token, (tf.get(token) ?? 0) + 1);
    return tf;
  });
  const df = new Map<string, number>();
  for (const tf of counts) for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  const n = texts.length;
  return counts.map((tf) => {
    const vector: Vector = new Map();
    let norm = 0;
    for (const [token, count] of tf) {
      const docs = df.get(token) ?? 0;
      if (docs < 2 || docs > n / 2) continue;
      const weight = (1 + Math.log(count)) * Math.log(n / docs);
      vector.set(token, weight);
      norm += weight * weight;
    }
    const length = Math.sqrt(norm);
    if (length > 0) for (const [token, weight] of vector) vector.set(token, weight / length);
    return vector;
  });
}

export const cosine = (a: Vector, b: Vector): number => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [token, weight] of small) sum += weight * (large.get(token) ?? 0);
  return sum;
};

/** Vectors as sorted token ids and their weights, so a dot product is one merge of two short arrays. */
function packed(vectors: readonly Vector[]): { readonly ids: Int32Array; readonly weights: Float32Array }[] {
  const idOf = new Map<string, number>();
  return vectors.map((vector) => {
    const entries = [...vector]
      .map(([token, weight]) => {
        let id = idOf.get(token);
        if (id === undefined) {
          id = idOf.size;
          idOf.set(token, id);
        }
        return [id, weight] as const;
      })
      .sort((a, b) => a[0] - b[0]);
    return { ids: Int32Array.from(entries.map(([id]) => id)), weights: Float32Array.from(entries.map(([, weight]) => weight)) };
  });
}

/** Average-linkage clusters of `vectors` (each a list of indexes), merged while their similarity is at least `tau`. */
export function agglomerate(vectors: readonly Vector[], tau = CLUSTER_TAU): number[][] {
  const n = vectors.length;
  if (n === 0) return [];
  const similarity = new Float32Array(n * n);
  const sparse = packed(vectors);
  for (let i = 0; i < n; i += 1) {
    const a = sparse[i] ?? { ids: new Int32Array(), weights: new Float32Array() };
    for (let j = i + 1; j < n; j += 1) {
      const b = sparse[j] ?? { ids: new Int32Array(), weights: new Float32Array() };
      let value = 0;
      for (let x = 0, y = 0; x < a.ids.length && y < b.ids.length; ) {
        const left = a.ids[x] ?? 0;
        const right = b.ids[y] ?? 0;
        if (left === right) {
          value += (a.weights[x] ?? 0) * (b.weights[y] ?? 0);
          x += 1;
          y += 1;
        } else if (left < right) x += 1;
        else y += 1;
      }
      similarity[i * n + j] = value;
      similarity[j * n + i] = value;
    }
  }
  const size = new Array<number>(n).fill(1);
  const members: number[][] = Array.from({ length: n }, (_, index) => [index]);
  const active = new Set(Array.from({ length: n }, (_, index) => index));
  const nearest = (i: number): [number, number] => {
    let best = -1;
    let value = Number.NEGATIVE_INFINITY;
    for (const j of active) {
      if (j === i) continue;
      const s = similarity[i * n + j] ?? 0;
      if (s > value || (s === value && j < best)) {
        value = s;
        best = j;
      }
    }
    return [best, value];
  };
  const chain: number[] = [];
  const finished: number[][] = [];
  while (active.size > 1) {
    if (chain.length === 0) chain.push(active.values().next().value ?? 0);
    const top = chain.at(-1) ?? 0;
    const [next, value] = nearest(top);
    if (next === -1) break;
    if (chain.length >= 2 && chain.at(-2) === next) {
      // Reciprocal nearest neighbours: merge them, or stop if even they are too far apart.
      chain.pop();
      chain.pop();
      if (value < tau) {
        // Each is the other's nearest, and below tau: neither can ever merge, since an average-linkage merge is never
        // closer to a cluster than the nearer of its parts (reducibility). Both are final.
        finished.push(members[top] ?? [], members[next] ?? []);
        active.delete(top);
        active.delete(next);
        chain.length = 0;
        continue;
      }
      const [keep, drop] = top < next ? [top, next] : [next, top];
      for (const other of active) {
        if (other === keep || other === drop) continue;
        const merged =
          ((similarity[keep * n + other] ?? 0) * (size[keep] ?? 1) + (similarity[drop * n + other] ?? 0) * (size[drop] ?? 1)) /
          ((size[keep] ?? 1) + (size[drop] ?? 1));
        similarity[keep * n + other] = merged;
        similarity[other * n + keep] = merged;
      }
      size[keep] = (size[keep] ?? 1) + (size[drop] ?? 1);
      members[keep] = [...(members[keep] ?? []), ...(members[drop] ?? [])];
      active.delete(drop);
      continue;
    }
    chain.push(next);
  }
  return [...finished, ...[...active].map((index) => members[index] ?? [])];
}

/** A cluster's distinguishing words: class-based TF-IDF over the clusters' pooled tokens, at most `limit`. */
export function clusterKeywords(
  texts: readonly string[],
  clusters: readonly (readonly number[])[],
  limit = 10,
  stopwords: ReadonlySet<string> = new Set(),
): string[][] {
  const pooled = clusters.map((cluster) => {
    const tf = new Map<string, number>();
    for (const index of cluster)
      for (const token of tokensOf(texts[index] ?? ""))
        if (!stopwords.has(token) && token.length > 1) tf.set(token, (tf.get(token) ?? 0) + 1);
    return tf;
  });
  const total = new Map<string, number>();
  for (const tf of pooled) for (const [token, count] of tf) total.set(token, (total.get(token) ?? 0) + count);
  const average = [...total.values()].reduce((sum, count) => sum + count, 0) / Math.max(1, clusters.length);
  return pooled.map((tf) => {
    const words = [...tf.values()].reduce((sum, count) => sum + count, 0) || 1;
    return [...tf]
      .map(([token, count]) => [token, (count / words) * Math.log(1 + average / (total.get(token) ?? 1))] as const)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([token]) => token);
  });
}
