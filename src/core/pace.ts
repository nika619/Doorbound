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
/**
 * Past this many pairs, older ones count half: habits change. Pairs from one morning share its pace, so the
 * evidence grows with mornings, not pairs: 5,000 is about two months of a three-person household.
 */
const PAIRS_KEPT = 5000;
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
    if (t.forPerson === lane.personId && !t.quick && !t.untimed && sec >= 1) out.push(reading(t, sec));
  }
  return out;
}

/** Posterior of today's pace Z for this lane. Readings r_k ~ N(sqrt(rho) Z, 1 - rho). O(t). */
export function paceOf(lane: Lane, rho: number, m0 = 0): Pace {
  const r = readings(lane);
  if (rho <= 0) return { z: 0, v: 1, n: r.length };
  // Prior N(m0, 1): m0 is what this weekday usually brings (weekdayMean), 0 until a household shows one.
  const precision = 1 + (r.length * rho) / (1 - rho);
  const s = r.reduce((a, b) => a + b, 0);
  return { z: (m0 + (Math.sqrt(rho) * s) / (1 - rho)) / precision, v: 1 / precision, n: r.length };
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
  /** The same for pairs of readings from different people in one morning (the household's shared pace). */
  crossProducts?: number;
  crossPairs?: number;
  /** Per weekday (0 Sunday to 6 Saturday): the sum and count of readings, for "Mondays run slow". */
  weekday?: [sum: number, n: number][];
}

/** A weekday's readings count as this many of none before its mean is trusted. */
const PRIOR_DAY = 15;
/** Readings kept per weekday before older ones count half. */
const DAY_KEPT = 300;

/**
 * What a weekday usually brings to anyone's pace, as a prior mean for Z: readings average sqrt(rho) Z, so the
 * shrunk mean reading over sqrt(rho). 0 until the household's own mornings show a difference. O(1).
 */
export function weekdayMean(s: PaceStats, rho: number, day: number): number {
  const [sum, n] = s.weekday?.[day] ?? [0, 0];
  return rho <= 0 ? 0 : Math.max(-1.5, Math.min(1.5, sum / (PRIOR_DAY + n) / Math.sqrt(rho)));
}

/** The household's rho: the pairs' mean product, shrunk towards RHO_PRIOR, kept in [0, RHO_MAX]. */
export const rhoOf = (s: PaceStats) => Math.max(0, Math.min(RHO_MAX, (PRIOR_PAIRS * RHO_PRIOR + s.products) / (PRIOR_PAIRS + s.pairs)));

/** A new reading `r`, paired with the same person's earlier readings this morning. O(n). */
export function recordPace(s: PaceStats, earlier: readonly number[], r: number, others: readonly number[] = [], day?: number): void {
  if (day !== undefined) {
    s.weekday ??= Array.from({ length: 7 }, () => [0, 0] as [number, number]);
    const d = s.weekday[day];
    d[0] += r;
    d[1]++;
    if (d[1] > DAY_KEPT) {
      d[0] /= 2;
      d[1] /= 2;
    }
  }
  for (const e of earlier) {
    s.products += e * r;
    s.pairs++;
  }
  for (const o of others) {
    s.crossProducts = (s.crossProducts ?? 0) + o * r;
    s.crossPairs = (s.crossPairs ?? 0) + 1;
  }
  if (s.pairs > PAIRS_KEPT) {
    s.products /= 2;
    s.pairs /= 2;
  }
  if ((s.crossPairs ?? 0) > PAIRS_KEPT) {
    s.crossProducts! /= 2;
    s.crossPairs! /= 2;
  }
}

// ---------- the household's shared pace ----------
//
// Whole households have slow mornings too (a late night, a storm, a Monday). So each person's pace is
// itself part shared: Z_p = sqrt(kappa) W + sqrt(1 - kappa) U_p, with W the household's pace. Two people's
// readings then have E[r_p r_q] = rho kappa, which is how kappa is learned; it starts at 0, so nothing
// changes until a household's own mornings show the link. The posterior over all of Z_1..Z_P is again
// normal: readings are linear in it (exact), and each step still running is a censored reading, folded in
// one at a time by the same moment match as censor() (assumed-density filtering). With kappa 0 every
// person's pace is exactly what paceOf and censor() give alone.

/** Ceiling on how strongly different people's mornings move together. */
export const KAPPA_MAX = 0.9;
/** kappa's prior, 0, counts as this many cross pairs. */
const PRIOR_CROSS = 20;

/** The household's kappa from cross pairs: their mean product over rho, shrunk towards 0. */
export const kappaOf = (s: PaceStats, rho: number) =>
  rho <= 0 ? 0 : Math.max(0, Math.min(KAPPA_MAX, (s.crossProducts ?? 0) / rho / (PRIOR_CROSS + (s.crossPairs ?? 0))));

/** A step in progress: its learned log-normal and how long it has run. */
export interface Running {
  d: LogNormal;
  elapsedSec: number;
}

/** Inverse of a small symmetric positive-definite matrix, Gauss-Jordan. O(P^3), P <= 8. */
function inverse(a: number[][]): number[][] {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    const piv = m[c][c];
    for (let j = 0; j < 2 * n; j++) m[c][j] /= piv;
    for (let r = 0; r < n; r++)
      if (r !== c) {
        const f = m[r][c];
        if (f) for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[c][j];
      }
  }
  return m.map((row) => row.slice(n));
}

/** Fold in "person p's step has run elapsedSec and is not done": the multivariate form of censor(). O(P^2). */
function censorJoint(mu: number[], S: number[][], p: number, run: Running, rho: number): void {
  if (run.elapsedSec <= 0) return;
  const b = Math.sqrt(rho / (1 - rho));
  const a = (run.d.mu - Math.log(run.elapsedSec)) / (run.d.sigma * Math.sqrt(1 - rho));
  const s2 = 1 + b * b * S[p][p];
  const k = Math.max(-30, (a + b * mu[p]) / Math.sqrt(s2));
  const lambda = Math.exp(-k * k / 2) / Math.sqrt(2 * Math.PI) / phi(k);
  const col = S.map((row) => row[p]);
  const shift = (b * lambda) / Math.sqrt(s2);
  const shrink = ((b * b) / s2) * lambda * (lambda + k);
  for (let i = 0; i < mu.length; i++) {
    mu[i] += col[i] * shift;
    for (let j = 0; j < mu.length; j++) S[i][j] -= col[i] * col[j] * shrink;
  }
}

/**
 * Today's pace for everyone at once. `before[p]` leaves out p's own running step (it is what that step is
 * conditioned on, before its elapsed time is applied to it), `ahead[p]` has everything (for the steps after it).
 */
export function householdPace(readingsBy: readonly (readonly number[])[], running: readonly (Running | null)[], rho: number, kappa: number, m0 = 0): { before: Pace[]; ahead: Pace[] } {
  const P = readingsBy.length;
  const ns = readingsBy.map((r) => r.length);
  if (rho <= 0) {
    const flat = ns.map((n) => ({ z: 0, v: 1, n }));
    return { before: flat, ahead: flat };
  }
  const k = Math.min(Math.max(kappa, 0), KAPPA_MAX);
  // Prior precision: the inverse of (1 - k) I + k J is (I - k / (1 - k + k P) J) / (1 - k) (Sherman-Morrison).
  const off = -k / (1 - k + k * P) / (1 - k);
  const lam = ns.map((n, i) => ns.map((_, j) => (i === j ? 1 / (1 - k) + off + (n * rho) / (1 - rho) : off)));
  const S0 = inverse(lam);
  // The prior's own pull towards the weekday's mean m0: Lambda0 times m0 for every person (the prior precision's row sums).
  const pull = m0 * (1 / (1 - k) + off * P);
  const h = readingsBy.map((r) => pull + (Math.sqrt(rho) * r.reduce((a, x) => a + x, 0)) / (1 - rho));
  const mu0 = S0.map((row) => row.reduce((a, x, j) => a + x * h[j], 0));
  const run = (skip: number) => {
    const mu = [...mu0];
    const S = S0.map((row) => [...row]);
    running.forEach((r, p) => {
      if (r && p !== skip) censorJoint(mu, S, p, r, rho);
    });
    return { mu, S };
  };
  const all = run(-1);
  const ahead = ns.map((n, p) => ({ z: all.mu[p], v: all.S[p][p], n }));
  const before = ns.map((n, p) => {
    if (!running[p]) return ahead[p];
    const o = run(p);
    return { z: o.mu[p], v: o.S[p][p], n };
  });
  return { before, ahead };
}
