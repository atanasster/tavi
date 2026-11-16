/**
 * MinHash: a set's signature is, for each of a fixed family of hash
 * functions, the least hash of its members. The share of positions where two
 * signatures agree estimates the sets' Jaccard similarity, and banding the
 * signature finds the candidate pairs without comparing every pair. A kit
 * names its shingles and its hash family: a signature it keeps compares only
 * with one made by the same family.
 */

/** The signature of `shingles` under `hashes` seeded hashes, `hash(shingle, index)` the index-th of them. */
export function minhashSignature<Shingle>(
  shingles: Iterable<Shingle>,
  hashes: number,
  hash: (shingle: Shingle, index: number) => number,
): Uint32Array {
  const signature = new Uint32Array(hashes).fill(0xffffffff);
  for (const shingle of shingles) {
    for (let index = 0; index < hashes; index += 1) {
      const value = hash(shingle, index);
      if (value < (signature[index] ?? 0xffffffff)) signature[index] = value;
    }
  }
  return signature;
}

/** The estimated Jaccard similarity of two signatures of `hashes` values: the share they agree on; none when either is another length. */
export function minhashSimilarity(a: ArrayLike<number>, b: ArrayLike<number>, hashes: number): number {
  if (a.length !== hashes || b.length !== hashes) return 0;
  let same = 0;
  for (let index = 0; index < hashes; index += 1) if (a[index] === b[index]) same += 1;
  return same / hashes;
}

/** A signature's band keys, `<band>:<its values in base 36, joined by dots>`: two sets sharing any one are candidates; none when it does not split into `bands`. */
export function minhashBands(signature: ArrayLike<number>, bands: number): string[] {
  if (bands < 1 || signature.length === 0 || signature.length % bands !== 0) return [];
  const rows = signature.length / bands;
  return Array.from(
    { length: bands },
    (_, band) =>
      `${String(band)}:${Array.from(signature)
        .slice(band * rows, band * rows + rows)
        .map((value) => value.toString(36))
        .join(".")}`,
  );
}
