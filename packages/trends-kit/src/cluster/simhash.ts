import { hash32, tokensOf } from "./text.js";

/**
 * SimHash for short posts: a post of fewer than 20 tokens has
 * too few shingles for MinHash to judge, so two whose 64-bit SimHashes differ
 * in at most 3 bits are near-duplicates.
 */
export const SHORT_POST_TOKENS = 20;
export const SIMHASH_MAX_DISTANCE = 3;

/** A 64-bit SimHash as two 32-bit halves, so comparing two needs no BigInt. */
export type SimHash = readonly [high: number, low: number];

/** A text's 64-bit SimHash over its tokens. */
export function simhashOf(text: string): SimHash {
  const weights = new Array<number>(64).fill(0);
  for (const token of tokensOf(text)) {
    const high = hash32(token, 0x2545f491);
    const low = hash32(token, 0x9e3779b9);
    for (let bit = 0; bit < 32; bit += 1) {
      weights[bit] = (weights[bit] ?? 0) + (((low >>> bit) & 1) === 1 ? 1 : -1);
      weights[bit + 32] = (weights[bit + 32] ?? 0) + (((high >>> bit) & 1) === 1 ? 1 : -1);
    }
  }
  let low = 0;
  let high = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if ((weights[bit] ?? 0) > 0) low |= 1 << bit;
    if ((weights[bit + 32] ?? 0) > 0) high |= 1 << bit;
  }
  return [high >>> 0, low >>> 0];
}

/** The bits set in a 32-bit number. */
const popcount = (value: number): number => {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
};

/** The number of bits two SimHashes differ in. */
export function hammingDistance(a: SimHash, b: SimHash): number {
  return popcount((a[0] ^ b[0]) >>> 0) + popcount((a[1] ^ b[1]) >>> 0);
}
