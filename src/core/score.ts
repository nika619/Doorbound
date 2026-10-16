// Doorbound keeps score of itself. Every chance it gives a person (at the start, and after each step they
// finish) is noted, and checked against what happened once they are ready or the departure ends: did they
// make the gate? Over many mornings that says whether its 85% really means 85% in this household, with
// real mornings rather than simulated ones.
//
// A forecast is about the plan as it stood. If a re-route later changes that person's plan, or the gate
// moves, the forecast no longer describes what ran and is dropped rather than scored.

import { currentIndex, projectLane, type Departure } from './departure.ts';

export interface Forecast {
  personId: string;
  p: number;
  atMs: number;
}

/** A settled forecast: the chance given, and whether they made it (1) or not (0). */
export type Score = [p: number, hit: 0 | 1];

/** Scores kept: about three months of a three-person household. Oldest go first. */
export const SCORES_KEPT = 600;

/** Note the chance of each unfinished person in `who` (default everyone), as the board shows it now. */
export function noteForecasts(dep: Departure, nowMs: number, who?: readonly string[]): Departure {
  const add: Forecast[] = [];
  for (const lane of dep.lanes)
    if ((!who || who.includes(lane.personId)) && currentIndex(lane) >= 0) add.push({ personId: lane.personId, p: projectLane(lane, dep.gateMs, nowMs, dep.rho).pOnTime, atMs: nowMs });
  return add.length ? { ...dep, forecasts: [...(dep.forecasts ?? []), ...add] } : dep;
}

/**
 * Score the forecasts whose outcome is known: everyone finished is in time or not. When the departure
 * `ended`, anyone unfinished after the gate missed it; anyone unfinished before the gate has no outcome,
 * and their forecasts are dropped. Appends to `scores`. O(F + t).
 */
export function settle(dep: Departure, nowMs: number, scores: Score[], ended = false): Departure {
  if (!dep.forecasts?.length) return dep;
  const outcome = new Map<string, 0 | 1 | null>();
  for (const lane of dep.lanes) {
    if (currentIndex(lane) < 0) {
      const readyMs = lane.tasks.findLast((t) => t.state === 'done')?.doneAtMs ?? lane.startedAtMs;
      outcome.set(lane.personId, readyMs <= dep.gateMs ? 1 : 0);
    } else if (ended) outcome.set(lane.personId, nowMs > dep.gateMs ? 0 : null);
  }
  const left: Forecast[] = [];
  for (const f of dep.forecasts) {
    const o = outcome.get(f.personId);
    if (o === undefined) left.push(f);
    else if (o !== null) scores.push([f.p, o]);
  }
  if (scores.length > SCORES_KEPT) scores.splice(0, scores.length - SCORES_KEPT);
  return { ...dep, forecasts: left };
}

export interface Band {
  /** Forecasts in this band, the mean chance given, and the share that made it. */
  n: number;
  said: number;
  happened: number;
}

/** How honest the chances have been: forecasts in three bands (under 50%, 50-80%, 80% and up), and the Brier score. */
export function honesty(scores: readonly Score[]): { n: number; bands: Band[]; brier: number } {
  const edges = [0.5, 0.8, Infinity];
  const sums = edges.map(() => ({ n: 0, said: 0, hit: 0 }));
  let brier = 0;
  for (const [p, hit] of scores) {
    const s = sums[edges.findIndex((e) => p < e)];
    s.n++;
    s.said += p;
    s.hit += hit;
    brier += (p - hit) ** 2;
  }
  return { n: scores.length, bands: sums.map((s) => ({ n: s.n, said: s.n ? s.said / s.n : 0, happened: s.n ? s.hit / s.n : 0 })), brier: scores.length ? brier / scores.length : 0 };
}
