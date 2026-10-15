import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyChanges, currentIndex, everyoneOnTime, markDone, project, startDeparture, stillGoing, TARGET, type Change, type Departure, type Household, type PersonDef } from './departure.ts';
import { record, type History } from './learn.ts';
import { COST, findReroute, NODE_BUDGET, reroute } from './reroute.ts';
import { household, learnedHistory, rng } from './fixtures.ts';
import { moments, posterior } from './stats.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 15, 1, 42);
const at = (min: number) => T0 + min * MIN;
const onTime = (dep: Departure, now: number) => project(dep, now).every((v) => v.readyMs <= dep.gateMs);

/** The demo morning, as the server runs it: every event is followed by a re-plan. */
function demoMorning(): { dep: Departure; h: History } {
  const h = learnedHistory();
  let dep = reroute(startDeparture(household, h, 'School run', at(35), at(0)), household, h, at(0));
  dep = reroute(markDone(dep, 'dad', at(8.1))!.dep, household, h, at(8.1));
  dep = reroute(markDone(dep, 'aarav', at(12.1))!.dep, household, h, at(12.1));
  return { dep: stillGoing(dep, 'isha', 8 * 60, at(14.5))!, h }; // "Isha's still in the shower. Eight more minutes."
}

test('the demo morning: Isha runs over, breakfast goes to-go and Dad packs her bag', () => {
  const { dep, h } = demoMorning();
  assert.equal(dep.reroute, null, 'nothing needed changing before now');
  assert.ok(project(dep, at(14.5))[1].pOnTime < 0.5, 'Isha is now more likely late than not');
  const plan = findReroute(dep, household, h, at(14.5));
  assert.deepEqual(
    plan.changes.map((c) => [c.kind, c.taskKey, c.to]),
    [
      ['quick', 'isha/breakfast', undefined],
      ['handoff', 'isha/bag', 'dad'],
    ],
  );
  assert.equal(plan.stillLateSec, 0);
  assert.equal(plan.optimal, true);
  const fixed = reroute(dep, household, h, at(14.5));
  const views = project(fixed, at(14.5));
  assert.ok(views.every((v) => v.pOnTime >= TARGET), 'everyone makes the gate with 85% confidence');
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
  const dep = stillGoing(startDeparture(hh, h, 'School run', at(24), at(0)), 'isha', 17 * 60, at(1))!;
  const plan = findReroute(dep, hh, h, at(1));
  assert.deepEqual(plan.changes.map((c) => `${c.kind}:${c.taskKey}`).sort(), ['handoff:isha/bag', 'later:dad/dishwasher']);
  assert.ok(onTime(reroute(dep, hh, h, at(1)), at(1)));
});

test('a helper who has finished everything starts the handed task now, not when they last finished', () => {
  const hh: Household = {
    people: [
      { id: 'a', name: 'A', steps: [{ id: 'x', name: 'X', statedSec: 300 }] },
      { id: 'b', name: 'B', steps: [{ id: 'y', name: 'Y', statedSec: 600 }, { id: 'z', name: 'Z', statedSec: 300, helpers: ['a'] }] },
    ],
  };
  const h: History = new Map();
  let dep = startDeparture(hh, h, 'run', at(20), at(0));
  dep = markDone(dep, 'a', at(2))!.dep; // A is free from minute 2
  dep = stillGoing(dep, 'b', 600, at(10))!;
  const fixed = reroute(dep, hh, h, at(10));
  assert.deepEqual(fixed.reroute!.changes.map((c) => c.kind), ['handoff']);
  const a = project(fixed, at(10))[0];
  assert.ok(Math.abs(a.expectedMs - (at(10) + moments(posterior(300)).mean * 1000)) < 1, 'A starts Z at 10, not at 2');
});

test('when nothing allowed is enough, it says how late, and changes nothing it does not need', () => {
  const h = learnedHistory();
  const dep = stillGoing(startDeparture(household, h, 'School run', at(35), at(0)), 'aarav', 1800, at(1))!;
  const plan = findReroute(dep, household, h, at(1));
  assert.equal(plan.changes.length, 0, "Aarav's steps allow no changes");
  assert.ok(plan.stillLateSec > 0);
  assert.equal(plan.optimal, true, 'and it knows no plan does better');
});

test('when nothing is enough, the best effort still gets the latest person closer', () => {
  const { dep, h } = demoMorning();
  const worse = stillGoing(dep, 'isha', 20 * 60, at(14.5))!;
  const plan = findReroute(worse, household, h, at(14.5));
  assert.ok(plan.stillLateSec > 0);
  assert.deepEqual(plan.changes.map((c) => c.taskKey).sort(), ['isha/bag', 'isha/breakfast']);
  const fixed = reroute(worse, household, h, at(14.5));
  assert.ok(project(fixed, at(14.5))[1].readyMs < project(worse, at(14.5))[1].readyMs);
  assert.ok(project(fixed, at(14.5))[2].readyMs <= fixed.gateMs, 'Dad, on time, stays on time');
});

test('nobody late, nothing changes: the same object comes back', () => {
  const h = learnedHistory();
  const dep = startDeparture(household, h, 'School run', at(35), at(0));
  assert.equal(reroute(dep, household, h, at(1)), dep);
});

// ---------- random households ----------

function randomHousehold(r: () => number, maxPeople: number, maxSteps: number, flex = 1): Household {
  const n = 1 + Math.floor(r() * maxPeople);
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const people: PersonDef[] = ids.map((id) => ({
    id,
    name: id,
    steps: Array.from({ length: 1 + Math.floor(r() * maxSteps) }, (_, j) => {
      const statedSec = 60 * (1 + Math.floor(r() * 15));
      return {
        id: `s${j}`,
        name: `step ${j}`,
        statedSec,
        quick: r() < 0.3 * flex ? { name: `quick ${j}`, sec: Math.max(30, Math.floor(statedSec * (0.2 + r() * 0.6))) } : undefined,
        canWait: r() < 0.25 * flex,
        optional: r() < 0.15 * flex,
        helpers: r() < 0.4 * flex ? ids.filter((o) => o !== id && r() < 0.6) : undefined,
      };
    }),
  }));
  return { people };
}

/** A random morning in progress: some steps done, some running over. */
function randomMorning(r: () => number, hh: Household) {
  const h: History = new Map();
  for (const p of hh.people) for (const s of p.steps) if (r() < 0.5) for (let k = 0; k < 4; k++) record(h, p.id, s.id, s.statedSec * (0.6 + r() * 1.4));
  let dep = startDeparture(hh, h, 'run', at(Math.floor(r() * 50)), at(0));
  let now = at(0);
  for (let e = 0; e < 6; e++) {
    now += Math.floor(r() * 6) * MIN;
    const who = hh.people[Math.floor(r() * hh.people.length)].id;
    dep = (r() < 0.5 ? markDone(dep, who, now)?.dep : stillGoing(dep, who, 60 * Math.floor(1 + r() * 10), now)) ?? dep;
  }
  return { h, dep, now };
}

/** Every change the household allows, step by step, enumerated independently of the planner. */
function allowed(dep: Departure, hh: Household, h: History): Change[][] {
  const out: Change[][] = [];
  for (const lane of dep.lanes)
    for (let i = currentIndex(lane) + 1; i < lane.tasks.length; i++) {
      const t = lane.tasks[i];
      const def = hh.people.find((p) => p.id === t.forPerson)!.steps.find((s) => s.id === t.stepId)!;
      if (t.state !== 'todo') continue;
      const base = { taskKey: t.key, name: t.name, from: lane.personId, savedSec: 0 };
      const opts: Change[] = [];
      if (def.quick && !t.quick && moments(posterior(def.quick.sec)).mean < moments(t).mean) opts.push({ ...base, kind: 'quick' });
      for (const to of def.helpers ?? []) if (to !== lane.personId && dep.lanes.some((l) => l.personId === to)) opts.push({ ...base, kind: 'handoff', to });
      if (def.canWait) opts.push({ ...base, kind: 'later' });
      if (def.optional) opts.push({ ...base, kind: 'skip' });
      if (opts.length) out.push(opts);
    }
  return out;
}

test('the plan is the cheapest that works, and the likeliest among the cheapest: brute force on 1,000 mornings', () => {
  const r = rng(424242);
  let checked = 0;
  let nontrivial = 0;
  while (checked < 1000) {
    const hh = randomHousehold(r, 3, 4, 1.6);
    const { h, dep, now } = randomMorning(r, hh);
    if (onTime(dep, now)) continue;
    const steps = allowed(dep, hh, h);
    if (steps.reduce((a, s) => a * (s.length + 1), 1) > 5000) continue;
    checked++;
    // Every combination: each step unchanged or changed one allowed way.
    let bestCost = Infinity;
    let bestP = 0;
    const pick: Change[] = [];
    (function walk(k: number) {
      if (k === steps.length) {
        const cost = pick.reduce((a, c) => a + COST[c.kind], 0);
        if (cost > bestCost) return;
        const after = { ...dep, lanes: applyChanges(dep, hh, h, pick, now) };
        if (!onTime(after, now)) return;
        const p = everyoneOnTime(project(after, now));
        if (cost < bestCost || p > bestP) [bestCost, bestP] = [cost, p];
        return;
      }
      walk(k + 1);
      for (const c of steps[k]) {
        pick.push(c);
        walk(k + 1);
        pick.pop();
      }
    })(0);
    const plan = findReroute(dep, hh, h, now);
    if (bestCost === Infinity) {
      assert.ok(plan.stillLateSec > 0, `run ${checked}: no plan exists, so it must say how late`);
      continue;
    }
    if (bestCost > 0) nontrivial++;
    assert.equal(plan.stillLateSec, 0, `run ${checked}: a plan exists`);
    assert.equal(plan.changes.reduce((a, c) => a + COST[c.kind], 0), bestCost, `run ${checked}: cheapest`);
    const p = everyoneOnTime(project({ ...dep, lanes: applyChanges(dep, hh, h, plan.changes, now) }, now));
    assert.ok(p >= bestP - 1e-9, `run ${checked}: likeliest among the cheapest (${p} vs ${bestP})`);
  }
  assert.ok(nontrivial > 150, `the test is not vacuous: ${nontrivial} mornings needed changes`);
});

test('guarantees hold on 2,000 random mornings', () => {
  const r = rng(20261015);
  for (let run = 0; run < 2000; run++) {
    const hh = randomHousehold(r, 5, 7);
    const { h, dep, now } = randomMorning(r, hh);
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
      assert.notEqual(lane.tasks[currentIndex(lane)]?.key, c.taskKey, `run ${run}: touched a step in progress`);
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

test('a household at the limits re-plans within the node budget, in well under a second', () => {
  const r = rng(99);
  let worst = 0;
  for (let run = 0; run < 30; run++) {
    // 8 people with 15 steps each, every step with every kind of change allowed: 1,200 candidate changes.
    const ids = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const step = (j: number, id: string) => ({ id: `s${j}`, name: `step ${j}`, statedSec: 60 * (1 + Math.floor(r() * 10)), quick: { name: 'quick', sec: 30 }, canWait: true, optional: true, helpers: ids.filter((o) => o !== id) });
    const hh: Household = { people: ids.map((id) => ({ id, name: id, steps: Array.from({ length: 15 }, (_, j) => step(j, id)) })) };
    const { h, dep, now } = randomMorning(r, hh);
    const t0 = performance.now();
    const fixed = reroute(dep, hh, h, now);
    worst = Math.max(worst, performance.now() - t0);
    project(dep, now).forEach((b, i) => {
      if (b.readyMs <= dep.gateMs) assert.ok(project(fixed, now)[i].readyMs <= dep.gateMs);
    });
  }
  assert.ok(worst < 1000, `worst ${worst.toFixed(0)} ms for NODE_BUDGET ${NODE_BUDGET}`);
});
