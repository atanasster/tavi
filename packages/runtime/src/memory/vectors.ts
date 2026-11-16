/**
 * Hybrid recall's vectors.
 *
 * Brute force, no vector extension: vectors are stored unit-normalised,
 * so cosine is a plain dot product, and only the vectors of records SQL found
 * eligible are scored (filter before rank, invariant 4). The worker keeps a
 * workspace's vectors in memory once hybrid recall first runs there (about
 * 6 KiB a 1,536-dimension vector), so a turn does not re-read the blobs. The
 * memory repository keeps the cache in step with every vector write and
 * delete, and the cache of a workspace is dropped when its retrieval goes back
 * to lexical.
 */

/** A vector scaled to length 1, or undefined for a zero, empty or non-finite one. */
export function unitVector(values: ArrayLike<number>): Float32Array | undefined {
  if (values.length === 0) return undefined;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!Number.isFinite(value)) return undefined;
    sum += value * value;
  }
  if (!(sum > 0) || !Number.isFinite(sum)) return undefined;
  const norm = Math.sqrt(sum);
  const unit = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) unit[index] = values[index]! / norm;
  return unit;
}

/** The stored bytes of a vector: little-endian float32. */
export function vectorBytes(vector: Float32Array): Buffer {
  const bytes = Buffer.alloc(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) bytes.writeFloatLE(vector[index]!, index * 4);
  return bytes;
}

/** A stored vector read back; undefined when its byte length does not match `dims`. */
export function vectorFromBytes(bytes: Uint8Array, dims: number): Float32Array | undefined {
  if (bytes.byteLength !== dims * 4) return undefined;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dims);
  for (let index = 0; index < dims; index += 1) vector[index] = buffer.readFloatLE(index * 4);
  return vector;
}

/** The dot product of two vectors of one dimension. */
function dot(left: Float32Array, right: Float32Array): number {
  let sum = 0;
  const length = left.length;
  for (let index = 0; index < length; index += 1) sum += left[index]! * right[index]!;
  return sum;
}

/**
 * The best `limit` of `revisionIds` by cosine with `query` (unit vectors, so a
 * dot product), from `vectors`; an id with no vector, or one of another
 * dimension, is counted in `missing` and not scored. Ties keep input order.
 */
export function scoreVectors(
  query: Float32Array,
  revisionIds: readonly string[],
  vectors: ReadonlyMap<string, Float32Array>,
  limit: number,
): { readonly ranked: readonly { readonly revisionId: string; readonly score: number }[]; readonly missing: number } {
  const scored: { revisionId: string; score: number; order: number }[] = [];
  let missing = 0;
  for (let order = 0; order < revisionIds.length; order += 1) {
    const revisionId = revisionIds[order]!;
    const vector = vectors.get(revisionId);
    if (vector === undefined || vector.length !== query.length) {
      missing += 1;
      continue;
    }
    scored.push({ revisionId, score: dot(query, vector), order });
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return { ranked: scored.slice(0, Math.max(0, limit)).map(({ revisionId, score }) => ({ revisionId, score })), missing };
}

/**
 * Pairs of revisions in `revisionIds` whose unit vectors in `vectors` have
 * cosine (dot product) at least `threshold`.
 */
export function nearDuplicateVectorPairs(
  revisionIds: readonly string[],
  vectors: ReadonlyMap<string, Float32Array>,
  threshold: number,
): readonly { readonly leftRevisionId: string; readonly rightRevisionId: string; readonly cosine: number }[] {
  const pairs: { leftRevisionId: string; rightRevisionId: string; cosine: number }[] = [];
  for (let i = 0; i < revisionIds.length; i += 1) {
    const leftRevisionId = revisionIds[i]!;
    const left = vectors.get(leftRevisionId);
    if (left === undefined) continue;
    for (let j = i + 1; j < revisionIds.length; j += 1) {
      const rightRevisionId = revisionIds[j]!;
      const right = vectors.get(rightRevisionId);
      if (right === undefined || right.length !== left.length) continue;
      const cosine = dot(left, right);
      if (cosine >= threshold) {
        pairs.push({ leftRevisionId, rightRevisionId, cosine });
      }
    }
  }
  return pairs;
}

/** One workspace's cached vectors, all of one model. */
interface WorkspaceVectors {
  readonly modelKey: string;
  readonly vectors: Map<string, Float32Array>;
}

/**
 * The worker's per-workspace vector cache. Loaded once per workspace and model
 * (`ensure`), updated by every stored vector of its model (`put`), evicted by
 * every deleted one (`evict`), and dropped whole on a return to lexical recall
 * (`drop`) or when no workspace binds its model any more (`retainModels`). A transaction that rolls back after an eviction leaves the cache
 * short, which reads as a missing vector (lexical, `partial`), never a stale one.
 */
export class MemoryVectorCache {
  readonly #workspaces = new Map<string, WorkspaceVectors>();

  /** The workspace's vectors of `modelKey`, loaded with `load` when absent or of another model. */
  ensure(workspaceId: string, modelKey: string, load: () => Iterable<readonly [string, Float32Array]>): ReadonlyMap<string, Float32Array> {
    const cached = this.#workspaces.get(workspaceId);
    if (cached !== undefined && cached.modelKey === modelKey) return cached.vectors;
    const vectors = new Map(load());
    this.#workspaces.set(workspaceId, { modelKey, vectors });
    return vectors;
  }

  /**
   * A vector stored: it joins every loaded cache of its model. Another
   * workspace's cache holding an id it never ranks costs memory, not
   * correctness: only eligible ids are scored.
   */
  put(revisionId: string, modelKey: string, vector: Float32Array): void {
    for (const cached of this.#workspaces.values()) {
      if (cached.modelKey === modelKey) cached.vectors.set(revisionId, vector);
    }
  }

  /** Vectors deleted: they leave every cache (of `modelKey` only, when given). */
  evict(revisionIds: Iterable<string>, modelKey?: string): void {
    const ids = [...revisionIds];
    if (ids.length === 0) return;
    for (const cached of this.#workspaces.values()) {
      if (modelKey !== undefined && cached.modelKey !== modelKey) continue;
      for (const revisionId of ids) cached.vectors.delete(revisionId);
    }
  }

  /** Drop every cache of a model not in `modelKeys`: those vectors were pruned. */
  retainModels(modelKeys: readonly string[]): void {
    const keep = new Set(modelKeys);
    for (const [workspaceId, cached] of this.#workspaces) if (!keep.has(cached.modelKey)) this.#workspaces.delete(workspaceId);
  }

  /** Forget a workspace's cache: its recall is lexical again. */
  drop(workspaceId: string): void {
    this.#workspaces.delete(workspaceId);
  }

  /** How many vectors, and their bytes, the workspace's cache holds. */
  size(workspaceId: string): { readonly vectors: number; readonly bytes: number } {
    const cached = this.#workspaces.get(workspaceId);
    if (cached === undefined) return { vectors: 0, bytes: 0 };
    let bytes = 0;
    for (const vector of cached.vectors.values()) bytes += vector.byteLength;
    return { vectors: cached.vectors.size, bytes };
  }
}
