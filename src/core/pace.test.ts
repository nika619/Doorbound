import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markDone, project, startDeparture, type Household } from './departure.ts';
import { draw, rng } from './fixtures.ts';
import { addPart, censor, paceOf, PARTS, readings, recordPace, rhoOf, total, type PaceStats } from './pace.ts';
import { moments, phi, posterior } from './stats.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 15, 1, 42);
const normal = (r: () => number) => Math.log(draw(r, { mu: 0, sigma: 1 }));

// One person, six steps, nothing learned yet: each step is posterior(stated), sigma 0.35, which is also
// how the simulated mornings below draw them, so any miscalibration comes from the pace and nothing else.
const STATED = [480, 300, 600, 240, 420, 180];
const solo: Household = { people: [{ id: 'p', name: 'P', steps: STATED.map((sec, i) => ({ id: `s${i}`, name: `S${i}`, statedSec: sec })) }] };
const steps = STATED.map((sec) => posterior(sec));

/** A morning from the model: one shared pace Z, then each step around it with correlation rho. */
function morning(r: () => number, rho: number): number[] {
  const z = normal(r);
  return steps.map((d) => Math.exp(d.mu + d.sigma * (Math.sqrt(rho) * z + Math.sqrt(1 - rho) * normal(r))));
}

test("today's pace is the exact posterior: matches numerical integration over Z", () => {
  const rho = 0.4;
  let dep = startDeparture(solo, new Map(), 'run', T0 + 60 * MIN, T0, rho);
  const took = [700, 380]; // both well over: a slow morning
  let t = T0;
  for (const sec of took) dep = markDone(dep, 'p', (t += sec * 1000))!.dep;
  const r = readings(dep.lanes[0]);
  assert.equal(r.length, 2);
  // Grid posterior of Z: prior N(0,1) times prod N(r_k; sqrt(rho) z, 1 - rho).
  let w = 0;
  let m1 = 0;
  let m2 = 0;
  for (let z = -8; z <= 8; z += 1e-3) {
    const like = Math.exp(-z * z / 2 - r.reduce((a, x) => a + (x - Math.sqrt(rho) * z) ** 2, 0) / (2 * (1 - rho)));
    w += like;
    m1 += like * z;
    m2 += like * z * z;
  }
  const p = paceOf(dep.lanes[0], rho);
  assert.ok(Math.abs(p.z - m1 / w) < 1e-6, `mean ${p.z} vs ${m1 / w}`);
  assert.ok(Math.abs(p.v - (m2 / w - (m1 / w) ** 2)) < 1e-6, `variance ${p.v}`);
  assert.ok(p.z > 0.5, 'two long steps say: slow morning');
  assert.ok(project(dep, t)[0].pace > 0.1, 'and the board says so');
});

test('a step still running moves the pace by the exact skew-normal moments (numerical integration)', () => {
  const d = posterior(480);
  for (const [z, v, rho, e] of [[0, 1, 0.3, 900], [0.4, 0.5, 0.5, 300], [-0.5, 0.7, 0.2, 2400], [0, 1, 0.8, 60]]) {
    const b = Math.sqrt(rho / (1 - rho));
    const a = (d.mu - Math.log(e)) / (d.sigma * Math.sqrt(1 - rho));
    let w = 0;
    let m1 = 0;
    let m2 = 0;
    for (let x = z - 12; x <= z + 12; x += 1e-3) {
      const like = Math.exp(-((x - z) ** 2) / (2 * v)) * phi(a + b * x);
      w += like;
      m1 += like * x;
      m2 += like * x * x;
    }
    const p = censor({ z, v, n: 0 }, d, rho, e);
    assert.ok(Math.abs(p.z - m1 / w) < 1e-5 && Math.abs(p.v - (m2 / w - (m1 / w) ** 2)) < 1e-5, `z ${z} v ${v} rho ${rho} e ${e}: ${p.z}, ${p.v}`);
  }
  assert.ok(censor({ z: 0, v: 1, n: 0 }, d, 0.3, 1200).z > 0.3, 'a shower at 20 minutes says: slow morning');
});

test('the running sums rebuild the exact covariance of the remaining steps', () => {
  const r = rng(11);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(r() * 12);
    const c = r() * 0.8;
    const ds = Array.from({ length: n }, () => ({ mu: 4 + 3 * r(), sigma: 0.05 + 0.95 * r() }));
    const acc = new Float64Array(PARTS);
    for (const d of ds) addPart(acc, moments(d), d.sigma);
    let mean = 0;
    let variance = 0;
    for (const [i, a] of ds.entries()) {
      const ma = moments(a);
      mean += ma.mean;
      variance += ma.variance;
      for (const [j, b] of ds.entries()) if (i !== j) variance += ma.mean * moments(b).mean * Math.expm1(c * a.sigma * b.sigma);
    }
    const got = total(acc, c);
    assert.ok(Math.abs(got.mean - mean) / mean < 1e-12);
    assert.ok(Math.abs(got.variance - variance) / variance < 1e-4, `trial ${trial}: ${got.variance} vs ${variance}`);
  }
});

test('a late tap clamps, and only the person\'s own normal steps count as readings', () => {
  let dep = startDeparture(solo, new Map(), 'run', T0 + 60 * MIN, T0, 0.3);
  dep = markDone(dep, 'p', T0 + 3 * 3_600_000)!.dep; // "done" pressed three hours late
  assert.deepEqual(readings(dep.lanes[0]), [3]);
  const lane = { ...dep.lanes[0], tasks: dep.lanes[0].tasks.map((t, i) => (i === 0 ? { ...t, quick: true } : t)) };
  assert.deepEqual(readings(lane), []);
});

/**
 * The claim the product rests on: when it says 85%, it is 85%. 40,000 simulated mornings with a shared
 * pace (rho 0.3), each looked at a random moment before a gate somewhere between hopeless and easy,
 * usually with a step in progress. The pace model's chances are compared with what happened, in ten bins; so are those of the
 * same model with steps taken as independent (rho 0), which is what Doorbound did before.
 */
test('calibrated: the chance it gives is the chance it delivers (40k simulated mornings, rho 0.3)', () => {
  const r = rng(7);
  const TRUE_RHO = 0.3;
  const N = 40_000;
  const bins = (rho: number) => ({ rho, p: new Float64Array(10), o: new Float64Array(10), n: new Float64Array(10), brier: 0 });
  const models = [bins(TRUE_RHO), bins(0)];
  const typical = STATED.reduce((a, b) => a + b, 0);
  for (let k = 0; k < N; k++) {
    const took = morning(r, TRUE_RHO);
    const gateMs = T0 + typical * (0.75 + 0.6 * r()) * 1000;
    // Looked at a random moment before the gate, as a kitchen screen is: often mid-step.
    const t = T0 + r() * (gateMs - T0);
    const ends: number[] = [];
    for (const sec of took) ends.push((ends.at(-1) ?? T0) + sec * 1000);
    if (ends.at(-1)! <= t) continue; // already ready: nothing to predict
    const hit = ends.at(-1)! <= gateMs ? 1 : 0;
    for (const m of models) {
      let dep = startDeparture(solo, new Map(), 'run', gateMs, T0, m.rho);
      for (const e of ends) if (e <= t) dep = markDone(dep, 'p', e)!.dep;
      const p = project(dep, t)[0].pOnTime;
      const b = Math.min(9, Math.floor(p * 10));
      m.p[b] += p;
      m.o[b] += hit;
      m.n[b]++;
      m.brier += (p - hit) ** 2;
    }
  }
  /** Expected calibration error: the bins' |said - happened|, weighted by how often each was said. */
  const ece = (m: (typeof models)[0]) => m.n.reduce((a, n, b) => a + (n ? Math.abs(m.p[b] - m.o[b]) : 0), 0) / m.n.reduce((a, b) => a + b, 0);
  const [pace, indep] = models;
  const said85 = (m: (typeof models)[0]) => m.o[8] / m.n[8]; // what happened when it said 80-90%
  const msg = `ECE pace ${ece(pace).toFixed(4)} vs independent ${ece(indep).toFixed(4)}; said 80-90%: pace ${(said85(pace) * 100).toFixed(1)}%, independent ${(said85(indep) * 100).toFixed(1)}%; Brier ${(pace.brier / N).toFixed(4)} vs ${(indep.brier / N).toFixed(4)}`;
  console.log(msg);
  // 0.008: twice the error the log-normal sum approximation alone gives when steps really are independent (0.004).
  assert.ok(ece(pace) < 0.008, msg);
  assert.ok(ece(indep) > 3 * ece(pace), msg);
  assert.ok(Math.abs(said85(pace) - pace.p[8] / pace.n[8]) < 0.015, msg);
  assert.ok(pace.brier < indep.brier, msg);
});

test('rho is learned from same-morning pairs (300 simulated mornings, true rho 0.5)', () => {
  const r = rng(5);
  const s: PaceStats = { products: 0, pairs: 0 };
  for (let k = 0; k < 300; k++) {
    const z = normal(r);
    const today: number[] = [];
    for (let i = 0; i < 6; i++) {
      const x = Math.sqrt(0.5) * z + Math.sqrt(0.5) * normal(r);
      recordPace(s, today, x);
      today.push(x);
    }
  }
  assert.ok(Math.abs(rhoOf(s) - 0.5) < 0.1, `learned ${rhoOf(s)}`);
  assert.equal(rhoOf({ products: 0, pairs: 0 }), 0.3, 'with no mornings yet, the prior');
});
