import { minhashBands, minhashSignature, minhashSimilarity as similarityOf } from "@tavi/domain-kit";

import { hash32, tokensOf } from "./text.js";

/**
 * MinHash over 5-word shingles: two texts whose shingle sets
 * overlap by Jaccard 0.8 or more are near-duplicates, the threshold memory
 * capture uses. Locality-sensitive banding finds the candidate pairs without
 * comparing every pair.
 */
export const MINHASH_PERMUTATIONS = 128;
export const MINHASH_BANDS = 32;
const SHINGLE_WORDS = 5;
export const NEAR_DUPLICATE_JACCARD = 0.8;

/** A text's shingles: its runs of five tokens (the whole text when shorter). */
export function shinglesOf(text: string, size = SHINGLE_WORDS): Set<string> {
  const tokens = tokensOf(text);
  const shingles = new Set<string>();
  if (tokens.length <= size) {
    if (tokens.length > 0) shingles.add(tokens.join(" "));
    return shingles;
  }
  for (let index = 0; index + size <= tokens.length; index += 1) shingles.add(tokens.slice(index, index + size).join(" "));
  return shingles;
}

/** A shingle set's signature: the least hash of each of `MINHASH_PERMUTATIONS` seeded hashes. */
export function minhashOf(shingles: ReadonlySet<string>): Uint32Array {
  return minhashSignature(shingles, MINHASH_PERMUTATIONS, (shingle, seed) => hash32(shingle, seed * 0x9e3779b1));
}

/** Two signatures' estimated Jaccard similarity. */
export function minhashSimilarity(a: Uint32Array, b: Uint32Array): number {
  return similarityOf(a, b, MINHASH_PERMUTATIONS);
}

/** A signature's band keys: texts sharing any one are candidates (`minhash` rows in items.db). */
export function bandKeysOf(signature: Uint32Array): string[] {
  return minhashBands(signature, MINHASH_BANDS);
}

/** A bucket up to this size has every pair compared; a larger one, each member against its first `BUCKET_ANCHORS`. */
const BUCKET_ALL_PAIRS_MAX = 64;
const BUCKET_ANCHORS = 8;

/** The pairs of `signatures` (by index) whose estimated Jaccard is at least `threshold`, found through their bands. */
export function nearDuplicatePairs(signatures: readonly Uint32Array[], threshold = NEAR_DUPLICATE_JACCARD): [number, number][] {
  const buckets = new Map<string, number[]>();
  signatures.forEach((signature, index) => {
    for (const key of bandKeysOf(signature)) buckets.set(key, [...(buckets.get(key) ?? []), index]);
  });
  const pairs = new Set<string>();
  const found: [number, number][] = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    // A large bucket (a wave of copies) is compared against its first few members only: every copy joins them, so the wave is still one group, in linear time.
    const anchors = members.length > BUCKET_ALL_PAIRS_MAX ? BUCKET_ANCHORS : members.length;
    for (let i = 0; i < anchors; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i] ?? 0;
        const b = members[j] ?? 0;
        const key = `${String(a)}:${String(b)}`;
        if (pairs.has(key)) continue;
        pairs.add(key);
        const left = signatures[a];
        const right = signatures[b];
        if (left !== undefined && right !== undefined && minhashSimilarity(left, right) >= threshold) found.push([a, b]);
      }
    }
  }
  return found;
}
