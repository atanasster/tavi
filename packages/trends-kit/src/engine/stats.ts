/**
 * The statistics the velocity engine tests with:
 * a negative-binomial upper tail for over-dispersed counts (Poisson when the
 * baseline shows no extra variance), a normal tail for the robust z, and
 * Benjamini–Hochberg control across a sweep's tests. No dependency: each is
 * a few lines of standard numerics.
 */

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function logGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const shifted = x - 1;
  let sum = c[0] ?? 0;
  for (let index = 1; index < 9; index += 1) sum += (c[index] ?? 0) / (shifted + index);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** The terms of a tail sum past which it stops: far below any threshold the engine uses. */
const TAIL_EPSILON = 1e-17;
const TAIL_TERMS_MAX = 2_000_000;

/**
 * Σ_{n ≥ from} of a term that starts at exp(logFirst) and is the last times
 * `ratio(n)`, summed until negligible. A first term too small to represent is
 * far from the mean: the tail is 0 above it and 1 below it.
 */
function tailSum(from: number, logFirst: number, mean: number, ratio: (n: number) => number): number {
  let term = Math.exp(logFirst);
  if (term === 0) return from > mean ? 0 : 1;
  let sum = 0;
  for (let n = from; n < from + TAIL_TERMS_MAX; n += 1) {
    sum += term;
    const next = term * ratio(n);
    // The terms fall once past the mode; stop when what is left cannot matter.
    if (next === 0 || (next < TAIL_EPSILON * sum && next <= term)) break;
    term = next;
  }
  return Math.min(1, sum);
}

/** Up to this x the rising factorial is summed term by term. */
const RISING_SUM_MAX = 100_000;

/** P(X ≥ x) for X ~ Poisson(μ). */
export function poissonUpperTail(x: number, mu: number): number {
  if (x <= 0) return 1;
  if (mu <= 0) return 0;
  const logFirst = x * Math.log(mu) - mu - logGamma(x + 1);
  return tailSum(x, logFirst, mu, (n) => mu / (n + 1));
}

/**
 * P(X ≥ x) for X ~ NB with mean μ and dispersion k (Var = μ + μ²/k): fewer
 * false alarms than Poisson on social counts, which are over-dispersed.
 */
export function negativeBinomialUpperTail(x: number, mu: number, k: number): number {
  if (x <= 0) return 1;
  if (mu <= 0) return 0;
  if (!Number.isFinite(k)) return poissonUpperTail(x, mu);
  // ln Γ(x+k) − ln Γ(k) as a sum of logs while x is modest: the difference of two huge lnΓ loses every digit when k is large.
  let logRising = 0;
  if (x <= RISING_SUM_MAX) for (let i = 0; i < x; i += 1) logRising += Math.log(k + i);
  else logRising = logGamma(x + k) - logGamma(k);
  const logFirst = logRising - logGamma(x + 1) - k * Math.log1p(mu / k) + x * Math.log(mu / (k + mu));
  const q = mu / (k + mu);
  return tailSum(x, logFirst, mu, (n) => ((n + k) / (n + 1)) * q);
}

/** P(Z ≥ z) for a standard normal Z. */
export function normalUpperTail(z: number): number {
  return 0.5 * erfc(z / Math.SQRT2);
}

/** The complementary error function (Numerical Recipes' Chebyshev fit, relative error below 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? Number.NaN) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** The median absolute deviation. */
export function mad(values: readonly number[]): number {
  const centre = median(values);
  return median(values.map((value) => Math.abs(value - centre)));
}

/**
 * The negative binomial's dispersion by the method of moments: k = m²/(v − m),
 * floored at `floor`; infinite (Poisson) when the sample shows no more
 * variance than its mean, or too few values to say.
 */
export function dispersion(values: readonly number[], floor = 1): number {
  if (values.length < 2) return Number.POSITIVE_INFINITY;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  // Variance at the mean up to rounding: no over-dispersion to fit, and a vast k would only lose precision.
  if (mean <= 0 || variance - mean <= 1e-9 * mean) return Number.POSITIVE_INFINITY;
  const k = (mean * mean) / (variance - mean);
  return k > 1e6 * mean ? Number.POSITIVE_INFINITY : Math.max(floor, k);
}

/**
 * Benjamini–Hochberg at level q: which of `pValues` are discoveries, in their
 * order. Controls the expected share of false alarms among a sweep's alarms
 * across all its topics and sources.
 */
export function benjaminiHochberg(pValues: readonly number[], q: number): boolean[] {
  const m = pValues.length;
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  let cutoff = -1;
  for (const [rank, entry] of order.entries()) if (entry.p <= ((rank + 1) / m) * q) cutoff = rank;
  const passed = new Array<boolean>(m).fill(false);
  for (const [rank, entry] of order.entries()) if (rank <= cutoff) passed[entry.index] = true;
  return passed;
}
