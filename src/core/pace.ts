// Today's pace: a slow morning is slow all the way through.
//
// The steps of one person's morning are not independent. Tired, distracted or ahead of themselves, the
// same person runs slow (or fast) across all of them. So a step's log-duration is its learned median plus
// a share of a pace common to the whole morning:
//
//   ln X_j = mu_j + sigma_j (sqrt(rho) Z + sqrt(1 - rho) E_j),    Z, E_j ~ N(0, 1), all independent.
//
// Each step keeps its learned spread sigma_j, and two steps of the same morning get log-scale correlation
// rho. Every finished step is a noisy reading of Z, so after n readings Z is normal again (conjugate), and
// each step still to come shifts by sigma_j sqrt(rho) E[Z] and shares the uncertainty rho Var[Z] that is
// left. That shared part makes a sum of steps wider than independent steps would: a planner that ignores
// it says 85% and delivers less (pace.test.ts measures by how much).
//
// A step still running is evidence too: if the shower has gone 12 minutes, today is likely slow. That
// reading is censored (only "longer than 12 minutes" is known), so it updates Z through a normal CDF; the
// posterior is skew-normal and is replaced by the normal with its exact mean and variance (censor()).
//
// rho is learned per household from pairs of steps finished in the same morning: for standardised
// readings r_i, r_j of one morning, E[r_i r_j] = rho. Until there are enough pairs it leans on RHO_PRIOR.

import type { Lane } from './departure.ts';
import { phi, type LogNormal, type Moments } from './stats.ts';

/** Correlation assumed before a household has shown its own: moderate, an assumption, not a measurement. */
export const RHO_PRIOR = 0.3;
/** RHO_PRIOR counts as this many pairs of same-morning steps. */
const PRIOR_PAIRS = 20;
/** Above this the model would trust one reading for the whole morning. */
export const RHO_MAX = 0.8;
/** Past this many pairs, older ones count half: habits change. */
const PAIRS_KEPT = 400;
/** A reading this many sigma out is likelier a late tap on "done" than a real step: clamped. */
const CLAMP = 3;

export interface Pace {
  /** Posterior mean and variance of Z: 0 and 1 before anything is done today. */
  z: number;
  v: number;
  /** Readings it rests on. */
  n: number;
}

/** How far a step took from its learned median, in its own sigmas. */
export const reading = (d: LogNormal, seconds: number) => Math.max(-CLAMP, Math.min(CLAMP, (Math.log(seconds) - d.mu) / d.sigma));

/**
 * Readings from the steps this person finished today: their own steps, done the normal way, timed as the
 * board times them (from the previous step's end, or from a handover). O(t).
 */
export function readings(lane: Lane): number[] {
  const out: number[] = [];
  let cursor = lane.startedAtMs;
  for (const t of lane.tasks) {
    if (t.state !== 'done') continue;
    const sec = (t.doneAtMs! - Math.max(cursor, t.notBeforeMs ?? cursor)) / 1000;
    cursor = t.doneAtMs!;
    if (t.forPerson === lane.personId && !t.quick && sec >= 1) out.push(reading(t, sec));
  }
  return out;
}

/** Posterior of today's pace Z for this lane. Readings r_k ~ N(sqrt(rho) Z, 1 - rho). O(t). */
export function paceOf(lane: Lane, rho: number): Pace {
  const r = readings(lane);
  if (rho <= 0 || !r.length) return { z: 0, v: 1, n: r.length };
  const precision = 1 + (r.length * rho) / (1 - rho);
  const s = r.reduce((a, b) => a + b, 0);
  return { z: (Math.sqrt(rho) * s) / (1 - rho) / precision, v: 1 / precision, n: r.length };
}

/**
 * The step in progress, `d` (its learned log-normal), has run `elapsedSec` and is not done. Its likelihood
 * for Z is P(X > e | Z) = Phi(a + b Z), with a = (mu - ln e) / (sigma sqrt(1 - rho)) and
 * b = sqrt(rho / (1 - rho)); against a normal prior that gives the skew-normal posterior, whose mean and
 * variance are closed-form (the probit update). O(1).
 */
export function censor(p: Pace, d: LogNormal, rho: number, elapsedSec: number): Pace {
  if (rho <= 0 || elapsedSec <= 0) return p;
  const b = Math.sqrt(rho / (1 - rho));
  const a = (d.mu - Math.log(elapsedSec)) / (d.sigma * Math.sqrt(1 - rho));
  const s = Math.sqrt(1 + b * b * p.v);
  const k = Math.max(-30, (a + b * p.z) / s); // past -30 the ratio below is -k to 0.1%, and Phi would underflow
  const lambda = Math.exp(-k * k / 2) / Math.sqrt(2 * Math.PI) / phi(k);
  return { z: p.z + (p.v * b * lambda) / s, v: p.v - ((p.v * p.v * b * b) / (s * s)) * lambda * (lambda + k), n: p.n };
}

/** A step given today's pace: shifted by what Z is believed to be, as wide as what Z leaves open. */
export const adjust = (d: LogNormal, p: Pace, rho: number): LogNormal => ({ mu: d.mu + d.sigma * Math.sqrt(rho) * p.z, sigma: d.sigma * Math.sqrt(1 - rho + rho * p.v) });

/** Today's pace as a fraction of a usual step: 0.2 means steps are running about 20% long. */
export const paceFactor = (p: Pace, rho: number, sigma: number) => Math.expm1(sigma * Math.sqrt(rho) * p.z);

// ---------- a lane's remaining morning, as sums that take steps in and out in O(1) ----------

/** Terms kept of exp(x) - 1 below; at x = 0.8, the largest a lane can reach, the first dropped is under 4e-5 of the sum. */
const TERMS = 6;
export const PARTS = 2 + 2 * TERMS;

/**
 * Adds (sign 1) or removes (sign -1) a step: its mean, its own variance, and its share of the power sums
 * A_k = sum m_i sigma_i^k and B_k = sum m_i^2 sigma_i^2k. With those, the covariance the shared pace adds,
 * sum over i != j of m_i m_j (exp(c sigma_i sigma_j) - 1) for c = rho Var[Z], is sum_k c^k / k! (A_k^2 - B_k):
 * exact to the dropped terms, and still a running sum, which is what lets the re-planner try a change
 * in O(1). `sigma` is the step's learned sigma, capped at 1 here (beyond +-170% a step is noise anyway, and
 * the cap keeps c sigma_i sigma_j <= RHO_MAX); 0 keeps a part out of the covariance (the step in progress,
 * which is conditioned on how long it has already run).
 */
export function addPart(acc: Float64Array, m: Moments, sigma: number, sign = 1): Float64Array {
  acc[0] += sign * m.mean;
  acc[1] += sign * m.variance;
  const sg = Math.min(sigma, 1);
  let s = 1;
  for (let k = 1; k <= TERMS; k++) {
    s *= sg;
    acc[1 + k] += sign * m.mean * s;
    acc[1 + TERMS + k] += sign * m.mean * m.mean * s * s;
  }
  return acc;
}

/** Mean and variance of the whole remaining morning, from its running sums. O(TERMS). */
export function total(acc: Float64Array, c: number): Moments {
  let cov = 0;
  let ck = 1;
  for (let k = 1; k <= TERMS; k++) {
    ck *= c / k;
    cov += ck * (acc[1 + k] ** 2 - acc[1 + TERMS + k]);
  }
  return { mean: acc[0], variance: Math.max(0, acc[1] + cov) };
}

// ---------- learning rho ----------

/** Same-morning pairs seen so far, and the sum of their reading products. */
export interface PaceStats {
  products: number;
  pairs: number;
}

/** The household's rho: the pairs' mean product, shrunk towards RHO_PRIOR, kept in [0, RHO_MAX]. */
export const rhoOf = (s: PaceStats) => Math.max(0, Math.min(RHO_MAX, (PRIOR_PAIRS * RHO_PRIOR + s.products) / (PRIOR_PAIRS + s.pairs)));

/** A new reading `r`, paired with the same person's earlier readings this morning. O(n). */
export function recordPace(s: PaceStats, earlier: readonly number[], r: number): void {
  for (const e of earlier) {
    s.products += e * r;
    s.pairs++;
  }
  if (s.pairs > PAIRS_KEPT) {
    s.products /= 2;
    s.pairs /= 2;
  }
}
