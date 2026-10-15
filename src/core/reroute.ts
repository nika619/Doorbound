// Re-plans a departure so everyone is ready by the gate with TARGET (85%) confidence, with the
// gentlest set of changes.
//
// Changes and their costs: a quicker version of a step (1), someone else does it (2), it waits until
// after the departure (3), it is skipped today (4). The plan is the cheapest set of changes, at most one
// per step, after which everyone makes the gate; among equally cheap plans, the one most likely to get
// the whole household there. A helper with too little spare time can free some the same way.
//
// Search: iterative deepening on total cost, depth-first over steps in a fixed order so each set of
// changes is met once. A person's remaining morning is a mean and a variance (stats.ts), so a change
// moves two numbers on at most two people, in O(1), and is undone by restoring them. Two admissible
// prunes: work only leaves a person's morning through a change to one of their own steps, so someone
// still late with none of their steps left in the order is a dead end; and each person still late needs
// at least one more change, of cost 1 or more. Checked optimal against brute force in the tests.
//
// When no plan gets everyone there, the best effort is exact too: a binary search for the least lateness
// any plan can reach (feasibility only grows with the lateness allowed), then the cheapest plan reaching
// it. A node budget caps the work; past it, a greedy pass stands in. Always: nobody on time is made late,
// a step in progress is never touched, only changes the household allowed are made, and the same input
// gives the same plan.

import type { History } from './learn.ts';
import { applyChanges, currentIndex, durationOf, laneMoments, project, TARGET, type Change, type ChangeKind, type Departure, type Household, type StepDef } from './departure.ts';
import { cdf, moments, posterior, quantile, sum, type Moments } from './stats.ts';

interface Option {
  kind: ChangeKind;
  cost: number;
  taskKey: string;
  name: string;
  /** Lane giving the step up, and lane taking it on (-1 for none). */
  from: number;
  to: number;
  /** What the change does to the giving lane, and what the taking lane takes on. */
  dFrom: Moments;
  add: Moments | null;
}

export const COST: Record<ChangeKind, number> = { quick: 1, handoff: 2, later: 3, skip: 4 };
/** Plans looked at before settling for the greedy one. Real households stay far below it. */
export const NODE_BUDGET = 20_000;
/** A changed lane must clear the gate by this much, so rounding in the running sums never flips a verdict. */
const EPS_MS = 1;

export interface Plan {
  changes: Change[];
  /** Seconds the latest person is still late at the target confidence (0 when the plan works). */
  stillLateSec: number;
  /** The search finished: no plan is less late, and none as late is cheaper. */
  optimal: boolean;
}

export function findReroute(dep: Departure, household: Household, history: History, nowMs: number): Plan {
  const views = project(dep, nowMs);
  const P = dep.lanes.length;
  const gateSec = (dep.gateMs - nowMs) / 1000;
  const mean = new Float64Array(P);
  const variance = new Float64Array(P);
  const touched = new Int32Array(P);
  for (let i = 0; i < P; i++) {
    const m = laneMoments(dep.lanes[i], nowMs);
    mean[i] = m.mean;
    variance[i] = m.variance;
  }
  const okAtStart = views.map((v) => v.readyMs <= dep.gateMs);

  const dist = (i: number) => sum([{ mean: mean[i], variance: Math.max(0, variance[i]) }]);
  /** How far past the gate lane i is ready, at the target confidence, in ms. Same arithmetic as projectLane. */
  const over = (i: number) => (mean[i] > 0 ? nowMs + quantile(dist(i)!, TARGET) * 1000 : views[i].readyMs) - dep.gateMs;
  /** Lateness each lane may keep, in ms: none for anyone on time, some for anyone already late in a best effort. */
  const allow = new Float64Array(P);
  const ok = (i: number) => (!touched[i] && okAtStart[i]) || over(i) <= allow[i] - EPS_MS;
  const pOn = (i: number) => (mean[i] > 0 ? cdf(dist(i)!, gateSec) : views[i].readyMs <= dep.gateMs ? 1 : 0);

  if (okAtStart.every(Boolean)) return { changes: [], stillLateSec: 0, optimal: true };

  // Candidate changes, step by step: late people first (latest first), then everyone else, each in
  // their own order. Only unstarted steps: you cannot hand someone a half-finished shower.
  const laneOf = new Map(dep.lanes.map((l, i) => [l.personId, i]));
  const defs = new Map<string, StepDef>(household.people.flatMap((p) => p.steps.map((s) => [`${p.id}/${s.id}`, s])));
  const order = [...dep.lanes.keys()].sort((a, b) => over(b) - over(a) || dep.lanes[a].personId.localeCompare(dep.lanes[b].personId));
  const steps: Option[][] = [];
  /** Position in `steps` of each lane's last changeable step, or -1. */
  const lastOf = new Int32Array(P).fill(-1);
  for (const li of order) {
    const lane = dep.lanes[li];
    for (let i = currentIndex(lane) + 1; i < lane.tasks.length; i++) {
      const t = lane.tasks[i];
      const def = defs.get(t.key);
      if (t.state !== 'todo' || !def) continue;
      const m = moments(t);
      const gone = { mean: -m.mean, variance: -m.variance };
      const base = { taskKey: t.key, name: t.name, from: li, to: -1, add: null };
      const opts: Option[] = [];
      if (def.quick && !t.quick) {
        const q = moments(posterior(def.quick.sec));
        if (q.mean < m.mean) opts.push({ ...base, kind: 'quick', cost: COST.quick, dFrom: { mean: q.mean - m.mean, variance: q.variance - m.variance } });
      }
      for (const h of def.helpers ?? []) {
        const to = laneOf.get(h);
        if (to !== undefined && to !== li) opts.push({ ...base, kind: 'handoff', cost: COST.handoff, to, dFrom: gone, add: moments(durationOf(history, h, t.stepId, def.statedSec)) });
      }
      if (def.canWait) opts.push({ ...base, kind: 'later', cost: COST.later, dFrom: gone });
      if (def.optional) opts.push({ ...base, kind: 'skip', cost: COST.skip, dFrom: gone });
      if (opts.length) {
        lastOf[li] = steps.length;
        steps.push(opts);
      }
    }
  }

  const chosen: Option[] = [];
  function apply(o: Option): number[] {
    const saved = [mean[o.from], variance[o.from], o.to < 0 ? 0 : mean[o.to], o.to < 0 ? 0 : variance[o.to]];
    mean[o.from] += o.dFrom.mean;
    variance[o.from] += o.dFrom.variance;
    touched[o.from]++;
    if (o.add) {
      mean[o.to] += o.add.mean;
      variance[o.to] += o.add.variance;
      touched[o.to]++;
    }
    chosen.push(o);
    return saved;
  }
  function undo(o: Option, saved: number[]) {
    chosen.pop();
    mean[o.from] = saved[0];
    variance[o.from] = saved[1];
    touched[o.from]--;
    if (o.add) {
      mean[o.to] = saved[2];
      variance[o.to] = saved[3];
      touched[o.to]--;
    }
  }

  // ---------- exact: cheapest plan that gets everyone there ----------
  let nodes = 0;
  let exhausted = false;
  /** Something in this level was cut only for cost, so a deeper level could still find a plan. */
  let cut = false;
  interface Found {
    opts: Option[];
    p: number;
    lateMs: number;
  }

  /** The cheapest plan keeping everyone within `lateMs` of the gate (those on time, on time), likeliest among equals. */
  function solve(lateMs: number): Found | null {
    for (let i = 0; i < P; i++) allow[i] = okAtStart[i] ? 0 : lateMs;
    let best = null as Found | null; // `as`: assigned inside search(), which TS cannot see
    function search(from: number, budget: number): void {
      if (nodes++ >= NODE_BUDGET) {
        exhausted = true;
        return;
      }
      let late = 0;
      for (let i = 0; i < P; i++)
        if (!ok(i)) {
          if (lastOf[i] < from) return; // nothing left in the order can help them
          late++;
        }
      if (late === 0) {
        let p = 1;
        let worst = 0;
        for (let i = 0; i < P; i++) {
          p *= pOn(i);
          worst = Math.max(worst, over(i));
        }
        if (!best || p > best.p) best = { opts: [...chosen], p, lateMs: worst };
        return; // anything added would cost more
      }
      if (late > budget) {
        cut = true;
        return;
      }
      for (let k = from; k < steps.length && !exhausted; k++)
        for (const o of steps[k])
          if (o.cost > budget) cut = true;
          else {
            const saved = apply(o);
            search(k + 1, budget - o.cost);
            undo(o, saved);
          }
    }
    for (let c = 0; !best && !exhausted; c++) {
      cut = false;
      search(0, c);
      if (!cut) break; // the whole tree fitted in this level: no plan at any cost
    }
    return best;
  }

  /** Stand-in past the budget: one change at a time, each the one that most cuts the worst then the total lateness. */
  function greedy(): Found {
    allow.fill(0);
    /** [worst, total] lateness in ms, or null if someone on time would be made late. */
    function score(): [number, number] | null {
      let worst = 0;
      let total = 0;
      for (let i = 0; i < P; i++) {
        if (ok(i)) continue;
        if (okAtStart[i]) return null;
        const late = Math.max(0, over(i) + EPS_MS);
        worst = Math.max(worst, late);
        total += late;
      }
      return [worst, total];
    }
    const better = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    const used = new Set<number>();
    let current = score()!;
    while (current[0] > 0) {
      // O(K·P) per round for K candidate changes, at most K rounds.
      let pick: { k: number; o: Option; s: [number, number] } | null = null;
      for (let k = 0; k < steps.length; k++) {
        if (used.has(k)) continue;
        for (const o of steps[k]) {
          const saved = apply(o);
          const s = score();
          undo(o, saved);
          if (s && better(s, current) && (!pick || better(s, pick.s) || (!better(pick.s, s) && o.cost < pick.o.cost))) pick = { k, o, s };
        }
      }
      if (!pick) break;
      used.add(pick.k);
      apply(pick.o);
      current = pick.s;
    }
    return { opts: [...chosen], p: 0, lateMs: current[0] };
  }

  let found = solve(0);
  if (!found && !exhausted) {
    // Nobody can get everyone there: the least lateness any plan reaches, in whole seconds. At `hi`, changing nothing does.
    const lateNow = Math.max(...okAtStart.map((okay, i) => (okay ? 0 : over(i))));
    let lo = 1;
    let hi = Math.ceil((lateNow + EPS_MS) / 1000);
    while (lo < hi && !exhausted) {
      const mid = (lo + hi) >> 1;
      const f = solve(mid * 1000);
      if (f) [hi, found] = [mid, f];
      else lo = mid + 1;
    }
    found ??= { opts: [], p: 0, lateMs: lateNow };
  }
  if (exhausted && !(found && found.lateMs <= 0)) {
    const g = greedy();
    if (!found || g.lateMs < found.lateMs) found = g;
  }
  const toChange = (o: Option): Change => ({ kind: o.kind, taskKey: o.taskKey, name: o.name, from: dep.lanes[o.from].personId, to: o.to < 0 ? undefined : dep.lanes[o.to].personId, savedSec: Math.round(-o.dFrom.mean) });
  return { changes: found!.opts.map(toChange), stillLateSec: Math.max(0, Math.ceil(found!.lateMs / 1000)), optimal: !exhausted };
}

/** Re-plan if anyone is late. Returns the same object when nobody is, so callers can skip work. */
export function reroute(dep: Departure, household: Household, history: History, nowMs: number): Departure {
  const { changes, stillLateSec } = findReroute(dep, household, history, nowMs);
  if (changes.length === 0 && stillLateSec === 0) return dep;
  const rev = dep.rev + 1;
  // One level of undo: the state just before this re-plan, without its own history, so memory stays O(1).
  return { ...dep, rev, lanes: applyChanges(dep, household, history, changes, nowMs), reroute: { atMs: nowMs, rev, changes, stillLateSec, before: { ...dep, reroute: null } } };
}
