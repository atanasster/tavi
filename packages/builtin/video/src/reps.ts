/**
 * Repetitions in a joint's flexion:
 * a rep rises from a low by at least `minRange` degrees to its peak, its key
 * frame (a squat's bottom), and falls back by at least as much. Its start is
 * the last frame of the low before the rise (a pause before it is not the
 * rep's), and its end the first frame back at the low after the fall (nor a
 * pause after it), "at the low" meaning within 2° (or a tenth of the range,
 * if less) of its least value. A dip during the rise or a bounce at the bottom smaller than
 * the range is part of the rep; a movement that never comes back is no rep.
 */

export interface Rep {
  readonly startIndex: number;
  readonly bottomIndex: number;
  readonly endIndex: number;
}

/** The reps in `values` (gaps skipped), each at least `minRange` degrees up and back down. */
export function findReps(values: readonly (number | undefined)[], minRange: number): Rep[] {
  const tolerance = Math.min(2, minRange / 10);
  const measured = values.flatMap((value, index) => (value === undefined ? [] : [{ index, value }]));
  const reps: Rep[] = [];
  let cursor = 0;
  while (cursor < measured.length) {
    // The low: its least value, followed until the rise passes the range.
    let low = cursor;
    let peak = -1;
    let at = cursor;
    for (; at < measured.length; at += 1) {
      const point = measured[at] as { readonly index: number; readonly value: number };
      if (peak < 0) {
        if (point.value < (measured[low] as { readonly value: number }).value) low = at;
        else if (point.value - (measured[low] as { readonly value: number }).value >= minRange) peak = at;
        continue;
      }
      // The first frame of the highest point: a bounce back to it later is the same bottom.
      if (point.value > (measured[peak] as { readonly value: number }).value) peak = at;
      else if ((measured[peak] as { readonly value: number }).value - point.value >= minRange) break;
    }
    if (peak < 0 || at >= measured.length) break;
    const peakValue = (measured[peak] as { readonly value: number }).value;
    // The fall: down to its least value, until the next rise passes a quarter of the range.
    let bottomOfFall = at;
    for (let next = at; next < measured.length; next += 1) {
      const value = (measured[next] as { readonly value: number }).value;
      if (value < (measured[bottomOfFall] as { readonly value: number }).value) bottomOfFall = next;
      else if (value - (measured[bottomOfFall] as { readonly value: number }).value >= minRange / 4) break;
    }
    const lowValue = (measured[low] as { readonly value: number }).value;
    const endValue = (measured[bottomOfFall] as { readonly value: number }).value;
    // The start: the last frame before the peak still at the low; the end: the first after it back at the low.
    let start = low;
    for (let index = low; index < peak; index += 1)
      if ((measured[index] as { readonly value: number }).value <= lowValue + tolerance) start = index;
    let end = bottomOfFall;
    for (let index = peak + 1; index <= bottomOfFall; index += 1) {
      if ((measured[index] as { readonly value: number }).value <= endValue + tolerance) {
        end = index;
        break;
      }
    }
    if (peakValue - endValue >= minRange)
      reps.push({
        startIndex: (measured[start] as { readonly index: number }).index,
        bottomIndex: (measured[peak] as { readonly index: number }).index,
        endIndex: (measured[end] as { readonly index: number }).index,
      });
    // The next rep's low begins where this one's fall ended.
    cursor = bottomOfFall;
  }
  return reps;
}
