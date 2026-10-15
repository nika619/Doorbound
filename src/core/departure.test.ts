import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GRACE_MS, laneTimeline, markDone, project, setGate, startDeparture, stillGoing, undoReroute } from './departure.ts';
import { household, learnedHistory } from './fixtures.ts';
import { reroute } from './reroute.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 15, 1, 42); // 7:12 in India; any fixed instant will do
const at = (min: number) => T0 + min * MIN;

test('a departure plans with learned times, not stated ones', () => {
  const dep = startDeparture(household, learnedHistory(), 'School run', at(28), at(0));
  const isha = dep.lanes.find((l) => l.personId === 'isha')!;
  assert.equal(isha.tasks[0].sec, 14 * 60, 'shower is planned at 14 minutes, not the 8 she said');
  const [aarav, ishaView, dad] = project(dep, at(0));
  assert.equal(aarav.readyMs, at(21));
  assert.equal(ishaView.readyMs, at(27));
  assert.equal(ishaView.status, 'ontime');
  assert.equal(dad.readyMs, at(21));
});

test('marking a step done moves the lane on and returns a fair sample to learn from', () => {
  const dep = startDeparture(household, new Map(), 'School run', at(28), at(0));
  const r = markDone(dep, 'aarav', at(11))!;
  assert.deepEqual(r.sample, { personId: 'aarav', stepId: 'breakfast', seconds: 660 });
  const view = project(r.dep, at(11))[0];
  assert.equal(view.current?.stepId, 'teeth');
  assert.equal(view.currentStartMs, at(11), 'the next step starts when the last one ended');
  assert.ok(r.dep.rev > dep.rev);
});

test('an overrunning step is assumed to need at least the grace period, so ready time drifts honestly', () => {
  const dep = startDeparture(household, new Map(), 'School run', at(28), at(0));
  const view = project(dep, at(20))[1]; // Isha's 8-minute shower, 12 minutes in, nobody said anything
  assert.equal(view.readyMs, at(20) + GRACE_MS + (360 + 240 + 180) * 1000);
});

test('"still going" re-plans the current step from now', () => {
  const dep = startDeparture(household, learnedHistory(), 'School run', at(28), at(0));
  const late = stillGoing(dep, 'isha', 300, at(14))!;
  const view = project(late, at(14))[1];
  assert.equal(view.readyMs, at(32), 'shower now ends at 14 + 5 minutes, so Isha is ready at 7:44');
  assert.equal(view.status, 'late');
  assert.equal(view.slackSec, -240);
});

test('the last step shows as boarding, and an empty lane as ready', () => {
  let dep = startDeparture(household, new Map(), 'School run', at(28), at(0));
  for (const m of [8, 12]) dep = markDone(dep, 'aarav', at(m))!.dep;
  assert.equal(project(dep, at(12))[0].status, 'boarding');
  dep = markDone(dep, 'aarav', at(17))!.dep;
  const v = project(dep, at(17))[0];
  assert.equal(v.status, 'ready');
  assert.equal(v.readyMs, at(17));
  assert.equal(markDone(dep, 'aarav', at(18)), null, 'nothing left to finish');
});

test('unknown people are refused rather than guessed', () => {
  const dep = startDeparture(household, new Map(), 'School run', at(28), at(0));
  assert.equal(markDone(dep, 'nobody', at(1)), null);
  assert.equal(stillGoing(dep, 'nobody', 60, at(1)), null);
});

test('moving the gate changes everyone\'s slack', () => {
  const dep = setGate(startDeparture(household, learnedHistory(), 'School run', at(28), at(0)), at(25));
  assert.equal(project(dep, at(0))[1].status, 'late');
});

test('undo restores the plan before the re-route, but only while nothing has happened since', () => {
  const h = learnedHistory();
  const late = stillGoing(startDeparture(household, h, 'School run', at(28), at(0)), 'isha', 300, at(14))!;
  const fixed = reroute(late, household, h, at(14));
  assert.ok(fixed.reroute);
  const undone = undoReroute(fixed)!;
  assert.deepEqual(undone.lanes, late.lanes);
  assert.equal(undone.reroute, null);
  const moved = markDone(fixed, 'aarav', at(15))!.dep;
  assert.equal(undoReroute(moved), null, 'undo after a real event would lose that event, so it is refused');
});

test('the runway puts done steps where they really were, the rest after the current one, and waiting steps after the gate', () => {
  let dep = startDeparture(household, new Map(), 'School run', at(28), at(0));
  dep = markDone(dep, 'dad', at(9))!.dep; // lunches took 9, not 8
  const dad = { ...dep.lanes[2], tasks: dep.lanes[2].tasks.map((t) => (t.stepId === 'dishwasher' ? { ...t, state: 'later' as const } : t)) };
  const blocks = laneTimeline(dad, at(28), at(10));
  assert.deepEqual(
    blocks.map((b) => [b.key, b.state, (b.startMs - at(0)) / MIN, (b.endMs - at(0)) / MIN]).sort((a, b) => (a[2] as number) - (b[2] as number)),
    [
      ['dad/lunches', 'done', 0, 9],
      ['dad/car', 'current', 9, 12],
      ['dad/dishwasher', 'later', 28, 38],
    ],
  );
  const car = laneTimeline(dad, at(28), at(15)).find((b) => b.key === 'dad/car')!;
  assert.equal(car.overrun, true, 'the car, planned to 7:24, is overrunning at 7:27');
  assert.equal(car.endMs, at(15) + GRACE_MS);
});
