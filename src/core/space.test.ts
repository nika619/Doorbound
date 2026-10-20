import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markDone, project, queues, startDeparture, type Household } from './departure.ts';
import { draw, rng } from './fixtures.ts';
import { posterior } from './stats.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 15, 1, 42);
const at = (m: number) => T0 + m * MIN;
// One bathroom: A showers first thing; B has breakfast, then needs the same bathroom.
const hh: Household = {
  people: [
    { id: 'a', name: 'A', steps: [{ id: 's1', name: 'Shower', statedSec: 600, uses: 'bathroom' }, { id: 's2', name: 'Dress', statedSec: 300 }] },
    { id: 'b', name: 'B', steps: [{ id: 's3', name: 'Breakfast', statedSec: 240 }, { id: 's4', name: 'Shower', statedSec: 480, uses: 'bathroom' }, { id: 's5', name: 'Shoes', statedSec: 180 }] },
  ],
};

test('a shared space: first come, first in; the next waits, and their clock starts when they get in', () => {
  let dep = startDeparture(hh, new Map(), 'run', at(40), at(0), 0);
  dep = markDone(dep, 'b', at(4))!.dep; // B reaches the bathroom; A is in it
  assert.deepEqual(queues(dep), [null, [0]]);
  const [a, b] = project(dep, at(5));
  assert.equal(b.waitingFor, 'bathroom');
  assert.ok(b.expectedMs > a.currentStartMs + 600_000 + 480_000, "B's morning holds A's shower, then B's whole shower");
  dep = markDone(dep, 'a', at(11))!.dep; // A is out at 11: B goes in
  assert.equal(dep.lanes[1].tasks[1].inAtMs, at(11));
  assert.equal(project(dep, at(12))[1].waitingFor, undefined);
  const done = markDone(dep, 'b', at(19))!;
  assert.equal(done.sample!.seconds, 8 * 60, 'B showered 8 minutes; the 7 spent waiting are not learned as shower');
});

/**
 * The forecast must see the queue coming, not only once it forms. 20,000 simulated mornings, first come
 * first served, each looked at a random moment: B's chance against what happened, split by whether B was
 * already queuing or inside, or still on breakfast with the queue ahead of them.
 */
test('calibrated with a shared bathroom, before the queue forms as well as during it (20k mornings)', () => {
  const r = rng(4);
  const d = (sec: number) => posterior(sec);
  const groups = { during: new Map<number, number[]>(), before: new Map<number, number[]>() };
  const counts = { during: 0, before: 0 };
  for (let k = 0; k < 20_000; k++) {
    const [a1, a2, b3, b4, b5] = [600, 300, 240, 480, 180].map((s) => draw(r, d(s)));
    const aEnd = a1; // A is in first: B cannot get there before time 0
    const bIn = Math.max(b3, aEnd);
    const bEnd = bIn + b4 + b5;
    const gate = T0 + (1100 + 900 * r()) * 1000;
    const t = T0 + r() * (gate - T0);
    if (T0 + bEnd * 1000 <= t) continue;
    let dep = startDeparture(hh, new Map(), 'run', gate, T0, 0);
    const events = ([[aEnd, 'a'], [aEnd + a2, 'a'], [b3, 'b'], [bIn + b4, 'b'], [bEnd, 'b']] as [number, string][]).sort((x, y) => x[0] - y[0]);
    for (const [s, who] of events) if (T0 + s * 1000 <= t) dep = markDone(dep, who, T0 + s * 1000)!.dep;
    const p = project(dep, t)[1].pOnTime;
    const g = T0 + b3 * 1000 <= t ? 'during' : 'before';
    const bin = Math.min(9, Math.floor(p * 10));
    const e = groups[g].get(bin) ?? [0, 0];
    e[0] += p;
    e[1] += T0 + bEnd * 1000 <= gate ? 1 : 0;
    groups[g].set(bin, e);
    counts[g]++;
  }
  for (const g of ['during', 'before'] as const) {
    const ece = [...groups[g].values()].reduce((s, [p, o]) => s + Math.abs(p - o), 0) / counts[g];
    console.log(`${g}: calibration error ${ece.toFixed(4)} over ${counts[g]} looks`);
    // Without anticipating the queue, 'before' was 0.28: it said 94% and 66% happened.
    assert.ok(ece < 0.025, `${g}: ${ece}`);
  }
});
