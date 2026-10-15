// The statistics behind "will everyone make the gate?".
//
// A step's duration is modelled as log-normal: always positive, right-skewed (a shower can run
// long, never negative), and the usual model for task times. Its parameters are learned per person
// and step with the stated time as a prior, so a new routine is planned from what people say and a
// lived-in one from what they do. A person's remaining morning is a sum of such steps; the sum is
// approximated by one log-normal with the same mean and variance (Fenton-Wilkinson), which gives a
// closed-form probability of being ready before the gate. Validated against simulation in tests.

/** Standard normal CDF. Abramowitz & Stegun 7.1.26 via erf; absolute error below 1.5e-7. */
export function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Inverse standard normal CDF. Acklam's rational approximation; relative error below 1.2e-9. */
export function phiInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -phiInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** A log-normal duration in seconds: ln(seconds) ~ Normal(mu, sigma^2). */
export interface LogNormal {
  mu: number;
  sigma: number;
}

export interface Moments {
  mean: number;
  variance: number;
}

/** How unsure a stated time is before any real morning: about ±40% at one sigma. */
export const PRIOR_SIGMA = 0.35;
/** The stated time counts as this many observations. Real mornings outweigh it from the third on. */
export const PRIOR_WEIGHT = 2;
/** Nobody repeats a step to the second: a floor on the spread. */
const MIN_SIGMA = 0.08;

/**
 * Posterior log-normal for one person's step: the stated time is a prior worth PRIOR_WEIGHT samples.
 * The spread pools the prior's spread, the samples' scatter, and the gap between what was said and
 * what happened, so a habitual underestimate also widens the uncertainty. O(n) for n <= 9 samples.
 */
export function posterior(statedSec: number, samples: readonly number[] = []): LogNormal {
  const k = PRIOR_WEIGHT;
  const m0 = Math.log(statedSec);
  let sum = k * m0;
  for (const x of samples) sum += Math.log(x);
  const mu = sum / (k + samples.length);
  let ss = k * (PRIOR_SIGMA ** 2 + (m0 - mu) ** 2);
  for (const x of samples) ss += (Math.log(x) - mu) ** 2;
  return { mu, sigma: Math.max(MIN_SIGMA, Math.sqrt(ss / (k + samples.length))) };
}

export const median = (d: LogNormal) => Math.exp(d.mu);

export function moments(d: LogNormal): Moments {
  const s2 = d.sigma ** 2;
  const mean = Math.exp(d.mu + s2 / 2);
  return { mean, variance: Math.expm1(s2) * mean * mean };
}

/**
 * Time still to go on a step that has already run `elapsedSec`: the moments of X - e given X > e.
 * Closed form for the truncated log-normal; if the step is already far past anything expected, the
 * remainder is taken as short and uncertain rather than as zero.
 */
export function remaining(d: LogNormal, elapsedSec: number, floorSec = 30): Moments {
  if (elapsedSec <= 0) return moments(d);
  const z = (Math.log(elapsedSec) - d.mu) / d.sigma;
  const tail = phi(-z);
  if (tail < 1e-6) return { mean: floorSec, variance: floorSec * floorSec };
  const s = d.sigma;
  const e1 = (Math.exp(d.mu + (s * s) / 2) * phi(s - z)) / tail;
  const e2 = (Math.exp(2 * d.mu + 2 * s * s) * phi(2 * s - z)) / tail;
  return { mean: Math.max(floorSec, e1 - elapsedSec), variance: Math.max(0, e2 - e1 * e1) };
}

/** Fenton-Wilkinson: one log-normal with the mean and variance of a sum of independent parts. O(n). */
export function sum(parts: Iterable<Moments>): LogNormal | null {
  let mean = 0;
  let variance = 0;
  for (const p of parts) {
    mean += p.mean;
    variance += p.variance;
  }
  if (mean <= 0) return null;
  const s2 = Math.log1p(variance / (mean * mean));
  return { mu: Math.log(mean) - s2 / 2, sigma: Math.sqrt(s2) };
}

/** P(duration <= x). */
export const cdf = (d: LogNormal, x: number) => (x <= 0 ? 0 : phi((Math.log(x) - d.mu) / d.sigma));
/** The duration not exceeded with probability p. */
export const quantile = (d: LogNormal, p: number) => Math.exp(d.mu + d.sigma * phiInv(p));
