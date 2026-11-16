/**
 * What a mistyped name most likely meant: the closest of `candidates`, at most
 * a third of its letters apart (case aside), or `undefined` when none is that near.
 */
export function nearestOf<T extends string>(typed: string, candidates: readonly T[]): T | undefined {
  let best: { readonly candidate: T; readonly distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(typed.toLowerCase(), candidate.toLowerCase());
    if (distance <= Math.max(1, Math.floor(candidate.length / 3)) && (best === undefined || distance < best.distance))
      best = { candidate, distance };
  }
  return best?.candidate;
}

/** Levenshtein distance: insertions, deletions and substitutions. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
