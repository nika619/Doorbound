// Re-plans a departure so everyone makes the gate, with as few and as gentle changes as possible.
//
// Changes, gentlest first: a quicker version of a step (cost 1), someone else does it (2),
// it waits until after the departure (3), it is skipped today (4). A helper with too little
// spare time can free some by making their own flexible steps quicker or later, the same way.
//
// The cheapest set of changes is a covering problem (NP-hard in general). With a few dozen
// steps a greedy pass is fast, predictable and easy to say out loud: for each late person, the
// gentlest kind of change first; within a kind, the smallest change that closes the gap, else
// the biggest and continue. Fewest changes, least overshoot.
//
// Guarantees (property-tested): nobody on time is made late; a step in progress is never
// touched; only changes the household allowed are made; the same input gives the same plan.
// Cost: O(k log k) per late person for k candidate changes; O(P·T·log(P·T)) overall.

import { estimate, type History } from './learn.ts';
import { applyChanges, currentIndex, project, type Change, type ChangeKind, type Departure, type Household, type Lane, type StepDef } from './departure.ts';

interface Option {
  kind: ChangeKind;
  cost: number;
  taskKey: string;
  name: string;
  from: string;
  savedMs: number;
  to?: string;
  /** Time the helper needs, for a handoff. */
  helperMs?: number;
}

const COSTS = [1, 2, 3, 4] as const;

/** Ascending by saving, ties by key: deterministic order for the binary search below. */
const bySaving = (a: Option, b: Option) => a.savedMs - b.savedMs || a.taskKey.localeCompare(b.taskKey) || (a.to ?? '').localeCompare(b.to ?? '');

/** Index of the smallest option saving at least `needMs`, else of the biggest. O(log k). */
function pickIndex(sorted: Option[], needMs: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].savedMs >= needMs) hi = mid;
    else lo = mid + 1;
  }
  return lo < sorted.length ? lo : sorted.length - 1;
}

export function findReroute(dep: Departure, household: Household, history: History, nowMs: number): { changes: Change[]; stillLateSec: number } {
  const ready = new Map(project(dep, nowMs).map((v) => [v.personId, v.readyMs]));
  const defs = new Map(household.people.map((p) => [p.id, new Map(p.steps.map((s) => [s.id, s]))]));
  const lanes = new Map(dep.lanes.map((l) => [l.personId, l]));
  const used = new Set<string>();
  const changes: Change[] = [];

  // Every change the household allows on a lane's unstarted steps. The step in progress stays put:
  // you cannot hand someone a half-finished shower.
  function optionsFor(lane: Lane, withHandoffs: boolean): Option[] {
    const out: Option[] = [];
    for (let i = currentIndex(lane) + 1; i < lane.tasks.length; i++) {
      const task = lane.tasks[i];
      if (task.state !== 'todo' || used.has(task.key)) continue;
      const def: StepDef | undefined = defs.get(task.forPerson)?.get(task.stepId);
      if (!def) continue;
      const base = { taskKey: task.key, name: task.name, from: lane.personId, savedMs: task.sec * 1000 };
      if (def.quick && !task.quick && def.quick.sec < task.sec) out.push({ ...base, kind: 'quick', cost: 1, savedMs: (task.sec - def.quick.sec) * 1000 });
      if (withHandoffs)
        for (const helper of def.helpers ?? [])
          if (helper !== lane.personId && lanes.has(helper))
            out.push({ ...base, kind: 'handoff', cost: 2, to: helper, helperMs: estimate(history, helper, task.stepId, def.statedSec) * 1000 });
      if (def.canWait) out.push({ ...base, kind: 'later', cost: 3 });
      if (def.optional) out.push({ ...base, kind: 'skip', cost: 4 });
    }
    return out;
  }

  const take = (o: Option) => {
    used.add(o.taskKey);
    ready.set(o.from, ready.get(o.from)! - o.savedMs);
    changes.push({ kind: o.kind, taskKey: o.taskKey, name: o.name, from: o.from, to: o.to, savedSec: Math.round(o.savedMs / 1000) });
  };

  /** Pick changes from `options` to save `needMs`, gentlest kind first. Returns what is still needed. */
  function cover(options: Option[], needMs: number, accept: (o: Option) => boolean): number {
    for (const cost of COSTS) {
      if (needMs <= 0) break;
      const level = options.filter((o) => o.cost === cost).sort(bySaving);
      while (needMs > 0 && level.length > 0) {
        const pick = level.splice(pickIndex(level, needMs), 1)[0];
        if (used.has(pick.taskKey) || !accept(pick)) continue;
        take(pick);
        needMs -= pick.savedMs;
      }
    }
    return needMs;
  }

  /** Make room in a helper's morning by making their own flexible steps quicker or later. Plans first, commits only on success. */
  function makeRoom(helper: string, needMs: number): boolean {
    const own = optionsFor(lanes.get(helper)!, false);
    const plan: Option[] = [];
    for (const cost of COSTS) {
      const level = own.filter((o) => o.cost === cost).sort(bySaving);
      while (needMs > 0 && level.length > 0) {
        const pick = level.splice(pickIndex(level, needMs), 1)[0];
        if (plan.some((p) => p.taskKey === pick.taskKey)) continue;
        plan.push(pick);
        needMs -= pick.savedMs;
      }
    }
    if (needMs > 0) return false;
    plan.forEach(take);
    return true;
  }

  const late = [...ready].filter(([, ms]) => ms > dep.gateMs).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  let stillLateMs = 0;
  for (const [personId] of late) {
    const remaining = cover(optionsFor(lanes.get(personId)!, true), ready.get(personId)! - dep.gateMs, (o) => {
      if (o.kind !== 'handoff') return true;
      // A helper who has finished everything starts the new task now, not when they last finished.
      const startMs = () => Math.max(ready.get(o.to!)!, nowMs);
      const short = startMs() + o.helperMs! - dep.gateMs;
      if (short > 0 && !makeRoom(o.to!, short)) return false; // would make the helper late
      ready.set(o.to!, startMs() + o.helperMs!);
      return true;
    });
    if (remaining > 0) stillLateMs = Math.max(stillLateMs, remaining);
  }
  return { changes, stillLateSec: Math.ceil(stillLateMs / 1000) };
}

/** Re-plan if anyone is late. Returns the same object when nobody is, so callers can skip work. */
export function reroute(dep: Departure, household: Household, history: History, nowMs: number): Departure {
  const { changes, stillLateSec } = findReroute(dep, household, history, nowMs);
  if (changes.length === 0 && stillLateSec === 0) return dep;
  const rev = dep.rev + 1;
  // One level of undo: the state just before this re-plan, without its own history, so memory stays O(1).
  return { ...dep, rev, lanes: applyChanges(dep, household, history, changes, nowMs), reroute: { atMs: nowMs, rev, changes, stillLateSec, before: { ...dep, reroute: null } } };
}
