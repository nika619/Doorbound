import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markDone, setGate, startDeparture, stillGoing, type Household } from './departure.ts';
import { draw, household, learnedHistory, rng } from './fixtures.ts';
import { reroute } from './reroute.ts';
import { honesty, noteForecasts, settle, type Score } from './score.ts';
import { posterior } from './stats.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 15, 1, 42);
const at = (m: number) => T0 + m * MIN;

test('a forecast is scored when its person is ready, and stays open until then', () => {
  const scores: Score[] = [];
  let dep = noteForecasts(startDeparture(household, new Map(), 'run', at(40), at(0)), at(0));
  assert.equal(dep.forecasts!.length, 3);
  for (const m of [7, 11, 16]) dep = markDone(dep, 'aarav', at(m))!.dep; // Aarav is ready at 16, gate 40
  dep = settle(dep, at(16), scores);
  assert.equal(scores.length, 1);
  assert.equal(scores[0][1], 1);
  assert.deepEqual(dep.forecasts!.map((f) => f.personId), ['isha', 'dad']);
});

test('when the departure ends, the unfinished miss it after the gate and are dropped before it', () => {
  const dep = noteForecasts(startDeparture(household, new Map(), 'run', at(30), at(0)), at(0));
  const early: Score[] = [];
  settle(dep, at(10), early, true);
  assert.equal(early.length, 0, 'ended before the gate: no outcome, nothing scored');
  const late: Score[] = [];
  settle(dep, at(31), late, true);
  assert.deepEqual(late.map((s) => s[1]), [0, 0, 0]);
});

test('a re-route drops the forecasts of the people whose plan it changed; a new gate drops them all', () => {
  const h = learnedHistory();
  let dep = noteForecasts(startDeparture(household, h, 'run', at(37), at(0)), at(0));
  dep = stillGoing(dep, 'isha', 25 * 60, at(14.5))!;
  const fixed = reroute(dep, household, h, at(14.5));
  const moved = new Set(fixed.reroute!.changes.flatMap((c) => [c.from, c.to ?? c.from]));
  assert.ok(moved.size > 0 && fixed.forecasts!.every((f) => !moved.has(f.personId)));
  assert.deepEqual(setGate(dep, at(40)).forecasts, []);
});

test('the bands say what was said and what happened', () => {
  const { n, bands, brier } = honesty([[0.9, 1], [0.9, 1], [0.9, 0], [0.6, 1], [0.2, 0]]);
  assert.equal(n, 5);
  assert.ok(Math.abs(bands[2].said - 0.9) < 1e-12 && Math.abs(bands[2].happened - 2 / 3) < 1e-12);
  assert.equal(bands[1].n, 1);
  assert.ok(Math.abs(brier - (0.01 + 0.01 + 0.81 + 0.16 + 0.04) / 5) < 1e-12);
});

test('kept score over 2,000 simulated mornings, it reports its own calibration truthfully', () => {
  // One person, steps drawn from the model with a shared pace; forecasts at the start and after each step.
  const solo: Household = { people: [{ id: 'p', name: 'P', steps: [480, 300, 600, 240].map((sec, i) => ({ id: `s${i}`, name: `S${i}`, statedSec: sec })) }] };
  const steps = solo.people[0].steps.map((s) => posterior(s.statedSec));
  const r = rng(9);
  const normal = () => Math.log(draw(r, { mu: 0, sigma: 1 }));
  const scores: Score[] = []; // all of them: the store keeps the last SCORES_KEPT, the test wants every one
  for (let k = 0; k < 2000; k++) {
    const today: Score[] = [];
    const z = normal();
    const gate = at(23 + 14 * r());
    let dep = noteForecasts(startDeparture(solo, new Map(), 'run', gate, at(0), 0.3), at(0));
    let t = at(0);
    for (const d of steps) {
      t += Math.exp(d.mu + d.sigma * (Math.sqrt(0.3) * z + Math.sqrt(0.7) * normal())) * 1000;
      dep = noteForecasts(settle(markDone(dep, 'p', t)!.dep, t, today), t);
    }
    scores.push(...today);
  }
  const { bands } = honesty(scores);
  assert.ok(scores.length > 7000, `${scores.length} scored`);
  for (const b of bands) assert.ok(Math.abs(b.said - b.happened) < 0.025, `said ${b.said.toFixed(3)}, happened ${b.happened.toFixed(3)} (n ${b.n})`);
});
