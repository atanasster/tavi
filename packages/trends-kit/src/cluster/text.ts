/**
 * Text as clustering reads it: NFKC, case and accents folded,
 * words where the script has spaces, character bigrams where it has none
 * (CJK, Thai), so a Japanese comment and an English one are both tokens.
 */
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/** The text folded for comparison: one space between words, a Latin letter's accents dropped (a kana's voicing mark kept), lower case. */
export const foldText = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** A text's tokens, in order: words, and bigrams of a spaceless script's runs. */
export function tokensOf(text: string): string[] {
  const tokens: string[] = [];
  for (const run of foldText(text).split(/[^\p{L}\p{N}]+/u)) {
    if (run === "") continue;
    if (!SPACELESS.test(run)) {
      tokens.push(run);
      continue;
    }
    const chars = [...run];
    if (chars.length === 1) tokens.push(run);
    for (let index = 0; index + 1 < chars.length; index += 1) tokens.push(`${chars[index] ?? ""}${chars[index + 1] ?? ""}`);
  }
  return tokens;
}

/** A 32-bit FNV-1a hash of a string, mixed with `seed`. */
export function hash32(text: string, seed = 0): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // A final avalanche, so nearby seeds give unrelated hashes.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}
