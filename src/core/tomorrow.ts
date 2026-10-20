// Tonight, for tomorrow: when each person has to start so the household makes the gate.
//
// Each person's whole morning is a sum of their learned steps, sharing a pace (pace.ts) that nothing has
// been seen of yet, so it is one log-normal T_p with CDF F_p. Starting at s_p, they are ready in time with
// probability F_p(g - s_p), and everyone together with the product (different people independent).
// Asked for the latest starts that keep that product at the target, the answer is not unique, so this
// gives the one with the most sleep in total: maximise sum s_p subject to sum ln F_p(g - s_p) >= ln target.
// Its optimality condition is that the last minute of everyone's sleep costs the same chance, that is
// equal reverse hazards f_p(t_p) / F_p(t_p) = lambda. A log-normal's ln F is concave in t, so the reverse
// hazard falls as t grows and each t_p(lambda) is a bisection; the product falls as lambda grows, so lambda
// is a bisection too. With one person it is just the target quantile.
//
// Steps that can wait or be skipped are left out: they never need anyone up earlier, since the morning's
// re-planner moves them when time is short. Getting up is a step too: from the alarm to the first step, as
// the person says it (10 minutes if they do not), with the same uncertainty as any stated step, so the
// times given are alarm times and the 85% already allows for a slow start.

import { durationOf, lanePart, startDeparture, TARGET, type Household } from './departure.ts';
import type { History } from './learn.ts';
import { total } from './pace.ts';
import { cdf, moments, posterior, sum, type LogNormal } from './stats.ts';

/** From the alarm to the first step, when nobody has said: 10 minutes. */
export const WAKE_SEC = 600;

export interface Start {
  personId: string;
  /** Their alarm: the latest time to get up. */
  startMs: number;
  /** Their own chance of being ready by the gate from that start. */
  pOnTime: number;
}

const pdf = (d: LogNormal, t: number) => Math.exp(-(((Math.log(t) - d.mu) / d.sigma) ** 2) / 2) / (t * d.sigma * Math.sqrt(2 * Math.PI));
/** Reverse hazard f / F of a log-normal at t seconds, from logs so the far left tail does not divide 0 by 0. */
const reverseHazard = (d: LogNormal, t: number) => {
  const F = cdf(d, t);
  return F > 1e-300 ? pdf(d, t) / F : Infinity;
};

/** The t at which the reverse hazard falls to lambda: it is decreasing in t. 60 halvings of [1 s, 1 day]. */
function tAt(d: LogNormal, lambda: number): number {
  let lo = 1;
  let hi = 86_400;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi); // geometric: the log-normal lives on a log scale
    if (reverseHazard(d, mid) > lambda) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Each person's whole morning, from the first step, as one log-normal. Steps that can wait or be skipped are left out. */
export function wholeMornings(household: Household, history: History, rho: number): { personId: string; d: LogNormal }[] {
  const dep = startDeparture(household, history, '', 0, 0, rho);
  const people = new Map(household.people.map((p) => [p.id, p]));
  const out: { personId: string; d: LogNormal }[] = [];
  for (const lane of dep.lanes) {
    const p = people.get(lane.personId)!;
    const kept = new Set(p.steps.filter((s) => !s.canWait && !s.optional).map((s) => s.id));
    const steps = lane.tasks.filter((t) => kept.has(t.stepId));
    if (!steps.length) continue;
    const getUp = { key: `${p.id}/~wake`, stepId: '~wake', forPerson: p.id, name: 'Getting up', state: 'todo' as const, ...posterior(p.wakeSec ?? WAKE_SEC) };
    const tasks = [getUp, ...steps];
    const { acc, c } = lanePart({ ...lane, tasks }, 0, rho);
    out.push({ personId: lane.personId, d: sum([total(acc, c)])! });
  }
  return out;
}

/** The latest starts giving the household `target` chance together, with the most total sleep. O(P log^2). */
export function planStarts(household: Household, history: History, gateMs: number, rho: number, target = TARGET): { starts: Start[]; pAll: number; order: { space: string; people: string[] }[] } {
  const people = wholeMornings(household, history, rho);
  if (!people.length) return { starts: [], pAll: 1, order: [] };
  const logAll = (lambda: number) => people.reduce((a, p) => a + Math.log(cdf(p.d, tAt(p.d, lambda))), 0);
  // ln of the product falls as lambda rises: find where it meets ln target.
  let lo = 1e-9;
  let hi = 1;
  while (logAll(hi) > Math.log(target)) hi *= 2;
  for (let i = 0; i < 80; i++) {
    const mid = Math.sqrt(lo * hi);
    if (logAll(mid) >= Math.log(target)) lo = mid;
    else hi = mid;
  }
  const starts = people.map(({ personId, d }) => {
    const t = tAt(d, lo);
    return { personId, startMs: gateMs - t * 1000, pOnTime: cdf(d, t) };
  });
  const order = stagger(household, history, starts);
  // Anyone moved earlier for a shared space has more time, so a better chance: recomputed, never worse.
  for (const s of starts) s.pOnTime = cdf(people.find((p) => p.personId === s.personId)!.d, (gateMs - s.startMs) / 1000);
  return { starts, pAll: starts.reduce((a, s) => a * s.pOnTime, 1), order };
}

/**
 * Shared spaces: alarms that would put two people in the bathroom at once (expected times) are moved so the
 * earlier user is out before the next arrives: the earlier one gets up sooner by the overlap. Returns who has
 * each space in what order. shortcut: uses expected times, not the full spread; a household that often
 * collides anyway learns longer steps from the mornings themselves.
 */
function stagger(household: Household, history: History, starts: Start[]): { space: string; people: string[] }[] {
  const out: { space: string; people: string[] }[] = [];
  const spaces = new Set(household.people.flatMap((p) => p.steps.flatMap((s) => (s.uses ? [s.uses] : []))));
  for (const space of spaces) {
    const users = starts.flatMap((s) => {
      const p = household.people.find((x) => x.id === s.personId)!;
      const k = p.steps.findIndex((x) => x.uses === space && !x.canWait && !x.optional);
      if (k < 0) return [];
      const mean = (id: string, sec: number) => moments(durationOf(history, p.id, id, sec)).mean * 1000;
      const arrive = moments(posterior(p.wakeSec ?? WAKE_SEC)).mean * 1000 + p.steps.slice(0, k).filter((x) => !x.canWait && !x.optional).reduce((a, x) => a + mean(x.id, x.statedSec), 0);
      return [{ s, arrive, use: mean(p.steps[k].id, p.steps[k].statedSec) }];
    });
    for (let pass = 0; pass < users.length; pass++) {
      users.sort((a, b) => a.s.startMs + a.arrive - (b.s.startMs + b.arrive));
      let moved = false;
      for (let i = 1; i < users.length; i++) {
        const overlap = users[i - 1].s.startMs + users[i - 1].arrive + users[i - 1].use - (users[i].s.startMs + users[i].arrive);
        if (overlap > 0) {
          users[i - 1].s.startMs -= overlap;
          moved = true;
        }
      }
      if (!moved) break;
    }
    if (users.length > 1) out.push({ space, people: users.map((u) => u.s.personId) });
  }
  return out;
}
