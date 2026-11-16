import { minhashBands as bandsOf, minhashSignature, minhashSimilarity as similarityOf } from "@tavi/domain-kit";

/**
 * Near-duplicate postings: MinHash over a description's 5-word
 * shingles, 64 hashes in 16 bands of 4. Two postings whose signatures share a
 * band are compared; at an estimated Jaccard of 0.8 or more, with their
 * companies agreeing, they are one job (a repost with a new id, or the same ad
 * on another board).
 */

export const MINHASH_HASHES = 64;
export const MINHASH_BANDS = 16;
const SHINGLE_WORDS = 5;
/** The estimated Jaccard at which two descriptions are one ad. */
export const MINHASH_JOIN = 0.8;
/** Shingles read from one description: 16 KiB of text is about 2,500 words. */
const SHINGLES_MAX = 4_000;

/** FNV-1a over a string's UTF-16 units: the shingle's 32-bit value. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Murmur3's finaliser: a well-mixed 32-bit value from `value ^ seed`, one hash function per seed. */
function mix(value: number, seed: number): number {
  let hash = (value ^ seed) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** The 64 seeds, fixed, so a signature stored today compares with one made later. */
const SEEDS: readonly number[] = Array.from({ length: MINHASH_HASHES }, (_, index) => mix(index + 1, 0x9e3779b9));

/** The signature of `text`, or `undefined` when it has fewer than five words. */
export function minhashOf(text: string): readonly number[] | undefined {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < SHINGLE_WORDS) return undefined;
  const shingles = new Set<number>();
  for (let index = 0; index + SHINGLE_WORDS <= words.length && shingles.size < SHINGLES_MAX; index += 1)
    shingles.add(fnv1a(words.slice(index, index + SHINGLE_WORDS).join(" ")));
  return Array.from(minhashSignature(shingles, MINHASH_HASHES, (shingle, index) => mix(shingle, SEEDS[index] ?? 0)));
}

/** The signature's band keys, for the store's lookup: `<band>:<its 4 values>`. */
export function minhashBands(signature: readonly number[]): string[] {
  return bandsOf(signature, MINHASH_BANDS);
}

/** The estimated Jaccard similarity of two signatures: the share of hashes they agree on. */
export function minhashSimilarity(a: readonly number[], b: readonly number[]): number {
  return similarityOf(a, b, MINHASH_HASHES);
}
