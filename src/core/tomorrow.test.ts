import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Household } from './departure.ts';
import { household, learnedHistory } from './fixtures.ts';
import { cdf, quantile } from './stats.ts';
import { planStarts, wholeMornings } from './tomorrow.ts';

const GATE = Date.UTC(2026, 9, 17, 2, 19); // 7:49 in India
const solo: Household = { people: [household.people[1]] };

test('one person: start at the gate minus the 85% quantile of their whole morning', () => {
  const [{ d }] = wholeMornings(solo, learnedHistory(), 0.3);
  const { starts, pAll } = planStarts(solo, learnedHistory(), GATE, 0.3);
  assert.ok(Math.abs((GATE - starts[0].startMs) / 1000 - quantile(d, 0.85)) < 1);
  assert.ok(Math.abs(pAll - 0.85) < 1e-6);
});

test('the household together makes the gate with exactly the target chance', () => {
  for (const target of [0.5, 0.85, 0.95]) {
    const { starts, pAll } = planStarts(household, learnedHistory(), GATE, 0.3, target);
    assert.equal(starts.length, 3);
    assert.ok(Math.abs(pAll - target) < 1e-6, `${target}: ${pAll}`);
    assert.ok(starts.every((s) => s.startMs < GATE && s.pOnTime > target), 'each alone is safer than all together');
  }
});

test('no plan with the same chance gives more sleep in total (brute force over one person, solved for the other)', () => {
  const two: Household = { people: household.people.slice(0, 2) };
  const [a, b] = wholeMornings(two, learnedHistory(), 0.3);
  const ours = planStarts(two, learnedHistory(), GATE, 0.3).starts.reduce((x, s) => x + (GATE - s.startMs) / 1000, 0);
  let best = Infinity;
  for (let t1 = 60; t1 < 7200; t1 += 0.5) {
    const f1 = cdf(a.d, t1);
    if (f1 <= 0.85) continue;
    best = Math.min(best, t1 + quantile(b.d, 0.85 / f1));
  }
  assert.ok(ours <= best + 1, `ours ${ours.toFixed(1)} s awake-time vs brute force ${best.toFixed(1)} s`);
});

test('the times are alarms: getting up is planned as a step of its own, as long as each person says', () => {
  const plain = planStarts(solo, learnedHistory(), GATE, 0.3).starts[0].startMs;
  const slow = planStarts({ people: [{ ...solo.people[0], wakeSec: 1500 }] }, learnedHistory(), GATE, 0.3).starts[0].startMs;
  assert.ok(plain - slow > 13 * 60_000, `25 minutes to get up instead of 10 moves the alarm ${((plain - slow) / 60_000).toFixed(1)} min earlier`);
  const [{ d }] = wholeMornings(solo, learnedHistory(), 0.3);
  const steps = wholeMornings({ people: [{ ...solo.people[0], steps: [] }] }, learnedHistory(), 0.3);
  assert.equal(steps.length, 0, 'nobody with no steps needs an alarm');
  assert.ok(Math.exp(d.mu) > 10 * 60, 'the whole morning includes getting up');
});

test('one bathroom: alarms are staggered so nobody is due in it while someone else is', () => {
  const both: Household = {
    people: [
      { id: 'a', name: 'A', steps: [{ id: 'sh', name: 'Shower', statedSec: 600, uses: 'bathroom' }, { id: 'dr', name: 'Dress', statedSec: 300 }] },
      { id: 'b', name: 'B', steps: [{ id: 'sh', name: 'Shower', statedSec: 600, uses: 'bathroom' }, { id: 'dr', name: 'Dress', statedSec: 300 }] },
    ],
  };
  const { starts, pAll, order } = planStarts(both, new Map(), GATE, 0.3);
  assert.deepEqual(order.map((o) => o.space), ['bathroom']);
  const first = starts.find((s) => s.personId === order[0].people[0])!;
  const second = starts.find((s) => s.personId === order[0].people[1])!;
  assert.ok(second.startMs - first.startMs >= 9 * 60_000, 'the first is up early enough to be out of the shower before the second needs it');
  assert.ok(pAll >= 0.85, 'moving someone earlier only helps');
});

test('steps that can wait or be skipped never get anyone up earlier', () => {
  const dad = household.people[2];
  const [{ d: all }] = wholeMornings({ people: [{ ...dad, steps: dad.steps.map((s) => ({ ...s, canWait: false })) }] }, new Map(), 0.3);
  const [{ d: kept }] = wholeMornings({ people: [dad] }, new Map(), 0.3);
  assert.ok(Math.exp(kept.mu) < Math.exp(all.mu) - 400, 'the dishwasher (10 min, can wait) is left out');
});
