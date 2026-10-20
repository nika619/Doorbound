import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentIndex, everyoneOnTime, GRACE_MS, laneTimeline, markDone, markReady, project, setGate, startDeparture, stillGoing, TARGET, undoReroute } from './departure.ts';
import { readings } from './pace.ts';
import { draw, household, learnedHistory, rng } from './fixtures.ts';
import { reroute } from './reroute.ts';
import { moments, posterior, quantile } from './stats.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 15, 1, 42); // 7:12 in India; any fixed instant will do
const at = (min: number) => T0 + min * MIN;
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

test('a departure plans with learned times, not stated ones, and says how sure it is', () => {
  const dep = startDeparture(household, learnedHistory(), 'School run', at(40), at(0));
  const shower = dep.lanes[1].tasks[0];
  assert.ok(Math.exp(shower.mu) > 11 * 60 && Math.exp(shower.mu) < 14 * 60, 'a typical shower is planned near the 14 minutes it takes, not the 8 she said');
  const [aarav, isha, dad] = project(dep, at(0));
  for (const v of [aarav, isha, dad]) {
    assert.ok(v.earlyMs < v.expectedMs && v.expectedMs < v.readyMs && v.readyMs < v.lateMs, `${v.personId}: p10 < mean < p85 < p90`);
    assert.equal(v.status, 'ontime');
    assert.ok(v.pOnTime >= TARGET);
  }
  assert.ok(isha.pOnTime < aarav.pOnTime, 'Isha is the tightest');
  assert.ok(near(everyoneOnTime([aarav, isha, dad]), aarav.pOnTime * isha.pOnTime * dad.pOnTime, 1e-12));
});

test('the chance of making the gate is right, mid-morning and mid-step (Monte Carlo, 100k mornings)', () => {
  const h = learnedHistory();
  let dep = startDeparture(household, h, 'School run', at(30), at(0), 0); // rho 0: independent steps, as drawn below
  dep = markDone(dep, 'aarav', at(9))!.dep;
  const now = at(12); // Isha 12 minutes into her shower, Aarav 3 minutes into his teeth
  const views = project(dep, now);
  const r = rng(3);
  for (const li of [0, 1]) {
    const lane = dep.lanes[li];
    const idx = currentIndex(lane);
    const startMs = li === 0 ? at(9) : at(0);
    let hit = 0;
    let n = 0;
    while (n < 100_000) {
      const cur = draw(r, lane.tasks[idx]);
      if (startMs + cur * 1000 <= now) continue; // that morning, the step would already be over: not this morning
      n++;
      let end = startMs + cur * 1000;
      for (let i = idx + 1; i < lane.tasks.length; i++) end += draw(r, lane.tasks[i]) * 1000;
      if (end <= dep.gateMs) hit++;
    }
    assert.ok(Math.abs(views[li].pOnTime - hit / n) < 0.02, `${lane.personId}: analytic ${views[li].pOnTime.toFixed(3)} vs simulated ${(hit / n).toFixed(3)}`);
  }
});

test('a forgotten or doubled "done" is capped before it is learned, unless the step was said to run over', () => {
  let dep = startDeparture(household, new Map(), 'School run', at(60), at(0));
  const forgot = markDone(dep, 'isha', at(180))!; // an 8-minute shower "done" three hours late
  assert.equal(forgot.sample!.capped, 'long');
  assert.ok(forgot.sample!.seconds < 25 * 60 && forgot.sample!.seconds > 15 * 60, `learned ${forgot.sample!.seconds} s, not 3 hours`);
  assert.equal(forgot.dep.lanes[1].tasks[0].doneAtMs, at(180), 'the board keeps when it really finished');
  const doubled = markDone(markDone(dep, 'aarav', at(8))!.dep, 'aarav', at(8) + 2000)!; // "done" twice: teeth in 2 s
  assert.equal(doubled.sample!.capped, 'short');
  dep = stillGoing(dep, 'isha', 30 * 60, at(20))!;
  const long = markDone(dep, 'isha', at(45))!;
  assert.equal(long.sample!.capped, undefined, 'someone said it was running over: a long shower is real');
  assert.equal(long.sample!.seconds, 45 * 60);
});

test('"ready" finishes everything left at once, and nothing is learned from those steps', () => {
  const dep = markReady(markDone(startDeparture(household, new Map(), 'School run', at(40), at(0)), 'isha', at(10))!.dep, 'isha', at(24))!;
  const isha = dep.lanes[1];
  assert.equal(currentIndex(isha), -1);
  assert.deepEqual(isha.tasks.map((t) => [t.state, !!t.untimed]), [['done', false], ['done', true], ['done', true], ['done', true]]);
  assert.equal(project(dep, at(24))[1].readyMs, at(24));
  assert.equal(readings(isha).length, 1, 'only the timed shower is a reading of her pace');
  assert.equal(markReady(dep, 'isha', at(25)), null, 'nothing left: nothing to do');
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

test('with no news, the expected ready time only ever moves later, and never by less than the grace period', () => {
  const dep = startDeparture(household, new Map(), 'School run', at(28), at(0));
  let last = 0;
  for (let m = 0; m <= 60; m += 0.5) {
    const v = project(dep, at(m))[1]; // Isha's 8-minute shower, nobody saying anything for an hour
    assert.ok(v.expectedMs >= last, `minute ${m}`);
    assert.ok(v.expectedMs >= at(m) + GRACE_MS + (moments(dep.lanes[1].tasks[1]).mean + moments(dep.lanes[1].tasks[2]).mean + moments(dep.lanes[1].tasks[3]).mean) * 1000 - 1);
    last = v.expectedMs;
  }
});

test('"still going" replaces the model for the current step with what was said, from now', () => {
  const dep = startDeparture(household, learnedHistory(), 'School run', at(35), at(0));
  const before = project(dep, at(14.5))[1];
  const late = stillGoing(dep, 'isha', 480, at(14.5))!;
  const v = project(late, at(14.5))[1];
  const rest = late.lanes[1].tasks.slice(1).reduce((a, t) => a + moments(t).mean, 0);
  assert.ok(near(v.expectedMs, at(14.5) + (moments(late.lanes[1].tasks[0].extend!).mean + rest) * 1000));
  assert.ok(near(Math.exp(late.lanes[1].tasks[0].extend!.mu), 480, 1e-9), 'the median is what was said');
  assert.ok(v.pOnTime < before.pOnTime);
  assert.equal(v.status, 'late');
  assert.ok(v.slackSec < 0);
});

test('the last step shows as boarding, and an empty lane as ready', () => {
  let dep = startDeparture(household, new Map(), 'School run', at(28), at(0));
  for (const m of [8, 12]) dep = markDone(dep, 'aarav', at(m))!.dep;
  assert.equal(project(dep, at(12))[0].status, 'boarding');
  dep = markDone(dep, 'aarav', at(17))!.dep;
  const v = project(dep, at(17))[0];
  assert.equal(v.status, 'ready');
  assert.equal(v.readyMs, at(17));
  assert.equal(v.pOnTime, 1);
  assert.equal(markDone(dep, 'aarav', at(18)), null, 'nothing left to finish');
});

test('unknown people are refused rather than guessed', () => {
  const dep = startDeparture(household, new Map(), 'School run', at(28), at(0));
  assert.equal(markDone(dep, 'nobody', at(1)), null);
  assert.equal(stillGoing(dep, 'nobody', 60, at(1)), null);
});

test("moving the gate changes everyone's chances", () => {
  const dep = startDeparture(household, learnedHistory(), 'School run', at(35), at(0));
  const earlier = setGate(dep, at(25));
  assert.equal(project(earlier, at(0))[1].status, 'late', 'Isha cannot make a gate earlier than her expected ready time');
  assert.ok(project(earlier, at(0)).every((v, i) => v.pOnTime <= project(dep, at(0))[i].pOnTime));
});

test('undo restores the plan before the re-route, but only while nothing has happened since', () => {
  const h = learnedHistory();
  const late = stillGoing(startDeparture(household, h, 'School run', at(35), at(0)), 'isha', 480, at(14.5))!;
  const fixed = reroute(late, household, h, at(14.5));
  assert.ok(fixed.reroute);
  const undone = undoReroute(fixed)!;
  assert.deepEqual(undone.lanes, late.lanes);
  assert.equal(undone.reroute, null);
  const moved = markDone(fixed, 'aarav', at(15))!.dep;
  assert.equal(undoReroute(moved), null, 'undo after a real event would lose that event, so it is refused');
});

test('the runway puts done steps where they really were, the rest after the current one, and waiting steps after the gate', () => {
  let dep = startDeparture(household, new Map(), 'School run', at(28), at(0), 0); // rho 0: this checks the layout, pace.test.ts the pace
  dep = markDone(dep, 'dad', at(9))!.dep; // lunches took 9, not 8
  const dad = { ...dep.lanes[2], tasks: dep.lanes[2].tasks.map((t) => (t.stepId === 'dishwasher' ? { ...t, state: 'later' as const } : t)) };
  const blocks = laneTimeline(dad, at(28), at(10), dep.rho);
  assert.deepEqual(
    blocks.map((b) => [b.key, b.state]),
    [
      ['dad/lunches', 'done'],
      ['dad/dishwasher', 'later'],
      ['dad/car', 'current'],
    ],
  );
  const [lunches, dishwasher, car] = blocks;
  assert.deepEqual([lunches.startMs, lunches.endMs], [at(0), at(9)]);
  assert.equal(car.startMs, at(9));
  assert.ok(car.endMs > at(10), 'the car is expected to end after now');
  assert.equal(dishwasher.startMs, at(28));
  assert.ok(near(dishwasher.endMs - dishwasher.startMs, moments(posterior(600)).mean * 1000));
  assert.equal(car.overrun, false);
  const planned = at(9) + quantile(posterior(180), TARGET) * 1000; // 7:25:18, at 85%
  const later = laneTimeline(dad, at(28), planned + MIN, dep.rho).find((b) => b.key === 'dad/car')!;
  assert.equal(later.overrun, true, 'past its 85% time, the car is overrunning');
  assert.ok(later.endMs >= planned + MIN + GRACE_MS);
});

test('the step in progress has a fixed target end, so a countdown to it ticks down', () => {
  const dep = startDeparture(household, new Map(), 'School run', at(40), at(0), 0);
  const [, isha] = project(dep, at(2));
  assert.ok(near(isha.stepEndMs, at(0) + 480_000, 1), 'an 8-minute shower started at 0 should end at 8');
  assert.equal(project(dep, at(5))[1].stepEndMs, isha.stepEndMs, 'it does not drift as time passes');
  const told = stillGoing(dep, 'isha', 5 * 60, at(9))!;
  assert.ok(near(project(told, at(9))[1].stepEndMs, at(14), 1000), '"five more minutes" moves the target to then');
});
