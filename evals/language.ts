/**
 * How the evals tell Bulgarian from English with no model: the share of
 * Cyrillic letters among Cyrillic and Latin ones. Shared by
 * `evals/reply-language/eval.ts` (a whole reply) and `evals/ideas/eval.ts`
 * (each field of a reworded idea), so both read "Bulgarian" the same way.
 *
 * Erasable TypeScript only, so `node` runs it with no build.
 */

/** At least this share of Cyrillic letters reads as Bulgarian: names, units and codes in Latin are allowed for. */
export const BULGARIAN_AT = 0.7;

/** A text's Cyrillic and Latin letters, and the Cyrillic share of them (undefined with neither). */
export function cyrillicShare(text: string): { readonly cyrillic: number; readonly latin: number; readonly share?: number } {
  const cyrillic = (text.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
  return cyrillic + latin === 0 ? { cyrillic, latin } : { cyrillic, latin, share: cyrillic / (cyrillic + latin) };
}
