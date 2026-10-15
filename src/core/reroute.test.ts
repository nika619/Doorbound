import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentIndex, project, startDeparture, stillGoing, markDone, type Household, type PersonDef } from './departure.ts';
import { record, type History } from './learn.ts';
import { findReroute, reroute } from './reroute.ts';
import { household, learnedHistory } from './fixtures.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 15, 1, 42);
const at = (min: number) => T0 + min * MIN;

test('the morning from the design: Isha runs over, breakfast goes to-go and Dad packs her bag', () => {
  const h = learnedHistory();
  let dep = startDeparture(household, h, 'School run', at(28), at(0));
  dep = markDone(dep, 'dad', at(8))!.dep; // lunches done; Dad is on the dishwasher
  dep = markDone(dep, 'aarav', at(12))!.dep;
  dep = stillGoing(dep, 'isha', 300, at(14))!; // "Alexa, Isha's still in the shower"
  assert.equal(project(dep, at(14))[1].slackSec, -240, 'Isha would be four minutes late');
  const fixed = reroute(dep, household, h, at(14));
  assert.deepEqual(
    fixed.reroute!.changes.map((c) => [c.kind, c.taskKey, c.to]),
    [
      ['quick', 'isha/breakfast', undefined],
      ['handoff', 'isha/bag', 'dad'],
    ],
  );
  assert.equal(fixed.reroute!.stillLateSec, 0);
  const views = project(fixed, at(14));
  assert.ok(views.every((v) => v.readyMs <= fixed.gateMs), 'everyone makes the gate');
  assert.equal(views[1].readyMs, at(27), 'Isha is ready at 7:39');
  const dad = fixed.lanes[2];
  assert.equal(dad.tasks[currentIndex(dad) + 1].key, 'isha/bag', 'the bag goes straight after what Dad is doing');
});

test('a helper short of time frees some by putting off their own flexible step', () => {
  const hh: Household = {
    people: [
      { id: 'isha', name: 'Isha', steps: [{ id: 'shower', name: 'Shower', statedSec: 600 }, { id: 'bag', name: 'Pack bag', statedSec: 300, helpers: ['dad'] }] },
      { id: 'dad', name: 'Dad', steps: [{ id: 'lunches', name: 'Pack lunches', statedSec: 600 }, { id: 'dishwasher', name: 'Unload dishwasher', statedSec: 360, canWait: true }, { id: 'car', name: 'Start the car', statedSec: 120 }] },
    ],
  };
  const h: History = new Map();
  // Isha 21 min (1 late), Dad 18 min: 2 spare, not the 5 her bag needs, until his dishwasher waits.
  const dep = stillGoing(startDeparture(hh, h, 'School run', at(20), at(0)), 'isha', 15 * 60, at(1))!;
  const fixed = reroute(dep, hh, h, at(1));
  assert.deepEqual(fixed.reroute!.changes.map((c) => `${c.kind}:${c.taskKey}`), ['later:dad/dishwasher', 'handoff:isha/bag']);
  assert.ok(project(fixed, at(1)).every((v) => v.readyMs <= fixed.gateMs));
});

test('a helper who has finished everything starts the handed task now, and is not made late', () => {
  const hh: Household = {
    people: [
      { id: 'a', name: 'A', steps: [{ id: 'x', name: 'X', statedSec: 300 }] },
      { id: 'b', name: 'B', steps: [{ id: 'y', name: 'Y', statedSec: 600 }, { id: 'z', name: 'Z', statedSec: 300, helpers: ['a'] }] },
    ],
  };
  const h: History = new Map();
  let dep = startDeparture(hh, h, 'run', at(16), at(0));
  dep = markDone(dep, 'a', at(2))!.dep; // A is free from 7:14
  dep = stillGoing(dep, 'b', 600, at(10))!; // B: 20 min, 4 late; Z takes A 5 min starting now, 7:22 → 7:27
  const fixed = reroute(dep, hh, h, at(10));
  assert.deepEqual(fixed.reroute!.changes.map((c) => c.kind), ['handoff']);
  assert.equal(project(fixed, at(10))[0].readyMs, at(15), 'A starts at 10, not at 2 when A last finished');
});

test('when nothing allowed is enough, it says how late, and changes nothing it does not need', () => {
  const h = learnedHistory();
  const dep = stillGoing(startDeparture(household, h, 'School run', at(28), at(0)), 'aarav', 1800, at(1))!;
  const { changes, stillLateSec } = findReroute(dep, household, h, at(1));
  assert.equal(changes.length, 0, "Aarav's steps allow no changes");
  assert.ok(stillLateSec > 0);
});

test('nobody late, nothing changes: the same object comes back', () => {
  const h = learnedHistory();
  const dep = startDeparture(household, h, 'School run', at(28), at(0));
  assert.equal(reroute(dep, household, h, at(1)), dep);
});

// ---------- properties over random households ----------

function rng(seed: number) {
  // mulberry32: small, fast, and reproducible from the seed
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHousehold(r: () => number): Household {
  const n = 1 + Math.floor(r() * 5);
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const people: PersonDef[] = ids.map((id) => ({
    id,
    name: id,
    steps: Array.from({ length: 1 + Math.floor(r() * 7) }, (_, j) => {
      const statedSec = 60 * (1 + Math.floor(r() * 15));
      return {
        id: `s${j}`,
        name: `step ${j}`,
        statedSec,
        quick: r() < 0.3 ? { name: `quick ${j}`, sec: Math.max(30, Math.floor(statedSec * (0.2 + r() * 0.6))) } : undefined,
        canWait: r() < 0.25,
        optional: r() < 0.15,
        helpers: r() < 0.4 ? ids.filter((o) => o !== id && r() < 0.6) : undefined,
      };
    }),
  }));
  return { people };
}

test('properties hold on 2,000 random mornings', () => {
  const r = rng(20261015);
  for (let run = 0; run < 2000; run++) {
    const hh = randomHousehold(r);
    const h: History = new Map();
    for (const p of hh.people) for (const s of p.steps) if (r() < 0.5) for (let k = 0; k < 4; k++) record(h, p.id, s.id, s.statedSec * (0.6 + r() * 1.4));
    const start = at(0);
    let dep = startDeparture(hh, h, 'run', start + Math.floor(r() * 50) * MIN, start);
    let now = start;
    for (let e = 0; e < 6; e++) {
      now += Math.floor(r() * 6) * MIN;
      const who = hh.people[Math.floor(r() * hh.people.length)].id;
      dep = (r() < 0.5 ? markDone(dep, who, now)?.dep : stillGoing(dep, who, 60 * Math.floor(r() * 10), now)) ?? dep;
    }
    const before = project(dep, now);
    const fixed = reroute(dep, hh, h, now);
    const after = project(fixed, now);
    const changes = fixed.reroute?.changes ?? [];

    // 1. Nobody who was on time is made late.
    before.forEach((b, i) => {
      if (b.readyMs <= dep.gateMs) assert.ok(after[i].readyMs <= dep.gateMs, `run ${run}: ${b.personId} was on time`);
    });
    // 2. If it reports success, everyone makes the gate.
    if (fixed !== dep && fixed.reroute!.stillLateSec === 0) assert.ok(after.every((a) => a.readyMs <= dep.gateMs), `run ${run}: success means on time`);
    // 3. Only allowed changes; 4. never the step in progress.
    for (const c of changes) {
      const [owner, stepId] = c.taskKey.split('/');
      const def = hh.people.find((p) => p.id === owner)!.steps.find((s) => s.id === stepId)!;
      if (c.kind === 'quick') assert.ok(def.quick);
      if (c.kind === 'handoff') assert.ok(def.helpers?.includes(c.to!));
      if (c.kind === 'later') assert.ok(def.canWait);
      if (c.kind === 'skip') assert.ok(def.optional);
      const lane = dep.lanes.find((l) => l.personId === c.from)!;
      const cur = currentIndex(lane);
      assert.notEqual(lane.tasks[cur]?.key, c.taskKey, `run ${run}: touched a step in progress`);
    }
    // 5. No task lost or duplicated.
    const keys = (d: typeof dep) => d.lanes.flatMap((l) => l.tasks.map((t) => t.key)).sort().join(',');
    assert.equal(keys(fixed), keys(dep), `run ${run}: tasks lost or duplicated`);
    // 6. One change per task at most.
    assert.equal(new Set(changes.map((c) => c.taskKey)).size, changes.length);
    // 7. Deterministic.
    assert.deepEqual(reroute(dep, hh, h, now).lanes, fixed.lanes);
  }
});
