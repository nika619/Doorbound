// The other tests check the maths against mornings drawn from the model itself. These check it against
// mornings that do not follow it: heavy tails, a different shape, people who underestimate, late taps.
// Each scenario: 20 households, each learning from 5 past mornings (through 'done', as real ones go),
// then 400 mornings looked at a random moment. The thresholds sit a little above what was measured, so
// a change that makes Doorbound less honest fails here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markDone, project, startDeparture, type Household } from './departure.ts';
import { draw, rng } from './fixtures.ts';
import { record, type History } from './learn.ts';

const T0 = Date.UTC(2026, 9, 15, 1, 42);
const STATED = [480, 300, 600, 240, 420, 180];
const TYPICAL = STATED.reduce((a, b) => a + b, 0);

type Truth = (r: () => number, normal: () => number, i: number, z: number) => number;
const lognormalStep: Truth = (_, normal, i, z) => STATED[i] * Math.exp(0.35 * (Math.sqrt(0.3) * z + Math.sqrt(0.7) * normal()));

/** Gamma(k) by Marsaglia and Tsang, on the test's own random stream. */
function gamma(r: () => number, normal: () => number, k: number): number {
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Calibration error (binned |said - happened|, weighted) and what happened when it said 80-90%. */
function measure(seed: number, truth: Truth, said: number[], lateTaps = 0): { ece: number; at85: number } {
  const r = rng(seed);
  const normal = () => Math.log(draw(r, { mu: 0, sigma: 1 }));
  const hh: Household = { people: [{ id: 'p', name: 'P', steps: said.map((sec, i) => ({ id: `s${i}`, name: `S${i}`, statedSec: Math.round(sec) })) }] };
  const bins = new Map<number, [number, number, number]>();
  let n = 0;
  for (let house = 0; house < 20; house++) {
    const h: History = new Map();
    for (let m = 0; m < 5; m++) {
      const z = normal();
      let past = startDeparture(hh, h, 'run', T0 + 3_600_000, T0, 0.3);
      let at = T0;
      for (let i = 0; i < 6; i++) {
        at += truth(r, normal, i, z) * 1000;
        const late = r() < lateTaps ? 1_200_000 : 0; // "done" said 20 minutes late
        const done = markDone(past, 'p', at + late)!;
        if (done.sample) record(h, 'p', done.sample.stepId, done.sample.seconds);
        past = done.dep;
        at += late;
      }
    }
    for (let k = 0; k < 400; k++) {
      const z = normal();
      const ends: number[] = [];
      for (let i = 0; i < 6; i++) ends.push((ends.at(-1) ?? T0) + truth(r, normal, i, z) * 1000);
      const gate = T0 + TYPICAL * (0.75 + 0.6 * r()) * 1000;
      const t = T0 + r() * (gate - T0);
      if (ends.at(-1)! <= t) continue;
      let dep = startDeparture(hh, h, 'run', gate, T0, 0.3);
      for (const e of ends) if (e <= t) dep = markDone(dep, 'p', e)!.dep;
      const p = project(dep, t)[0].pOnTime;
      const b = Math.min(9, Math.floor(p * 10));
      const e = bins.get(b) ?? [0, 0, 0];
      e[0] += p;
      e[1] += ends.at(-1)! <= gate ? 1 : 0;
      e[2]++;
      bins.set(b, e);
      n++;
    }
  }
  const b8 = bins.get(8)!;
  return { ece: [...bins.values()].reduce((s, [p, o]) => s + Math.abs(p - o), 0) / n, at85: b8[1] / b8[2] };
}

const scenarios: [string, Truth, number[], number, number][] = [
  // name, truth, what people say, share of late taps, the most calibration error allowed
  ['real mornings follow the model', lognormalStep, STATED, 0, 0.03],
  ['heavy tails: 8% of steps take 1.5 to 3 times as long', (r, normal, i, z) => STATED[i] * Math.exp(0.3 * (Math.sqrt(0.3) * z + Math.sqrt(0.7) * normal())) * (r() < 0.08 ? 1.5 + 1.5 * r() : 1), STATED, 0, 0.05],
  ['gamma-shaped steps, not log-normal', (r, normal, i, z) => ((STATED[i] * Math.exp(0.2 * Math.sqrt(0.3) * z) * gamma(r, normal, 8)) / 8) * 1.04, STATED, 0, 0.04],
  ['underestimators: they say 60% of the truth', lognormalStep, STATED.map((s) => s * 0.6), 0, 0.03],
  ['forgotten taps: 5% of "done"s 20 minutes late', lognormalStep, STATED, 0.05, 0.09],
];

for (const [name, truth, said, late, most] of scenarios)
  test(`honest when mornings do not follow the model: ${name}`, () => {
    const { ece, at85 } = measure(31, truth, said, late);
    console.log(`${name}: calibration error ${(ece * 100).toFixed(2)}%, said 80-90% and ${(at85 * 100).toFixed(1)}% happened`);
    assert.ok(ece < most, `${(ece * 100).toFixed(2)}%`);
  });
