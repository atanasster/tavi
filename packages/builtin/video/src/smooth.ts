/**
 * Smoothing a joint's series: gaps
 * of at most three frames are filled by straight lines between their
 * neighbours, then a Savitzky-Golay filter (window 5, quadratic) smooths
 * what has four neighbours; the ends, and points beside a gap left open,
 * stay as measured.
 */

/** The longest run of missing frames filled in. */
export const MAX_GAP_FRAMES = 3;

/** Gaps of up to `maxGap` frames between two measured ones, filled linearly; longer ones and the ends stay open. */
export function fillGaps(values: readonly (number | undefined)[], maxGap = MAX_GAP_FRAMES): (number | undefined)[] {
  const filled = [...values];
  let index = 0;
  while (index < filled.length) {
    if (filled[index] !== undefined) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < filled.length && filled[index] === undefined) index += 1;
    const before = filled[start - 1];
    const after = filled[index];
    const length = index - start;
    if (before === undefined || after === undefined || length > maxGap) continue;
    for (let offset = 0; offset < length; offset += 1) filled[start + offset] = before + ((after - before) * (offset + 1)) / (length + 1);
  }
  return filled;
}

/** Savitzky-Golay, window 5, order 2: (−3, 12, 17, 12, −3) / 35. */
const SG5 = [-3, 12, 17, 12, -3] as const;

export function savitzkyGolay(values: readonly (number | undefined)[]): (number | undefined)[] {
  return values.map((value, index) => {
    if (value === undefined) return undefined;
    let total = 0;
    for (let offset = -2; offset <= 2; offset += 1) {
      const neighbour = values[index + offset];
      if (neighbour === undefined) return value;
      total += (SG5[offset + 2] as number) * neighbour;
    }
    return total / 35;
  });
}

/** Gaps filled, then smoothed. */
export function smoothSeries(values: readonly (number | undefined)[]): (number | undefined)[] {
  return savitzkyGolay(fillGaps(values));
}
