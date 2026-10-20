// What the household has really taken for each step. The statistics live in stats.ts; this keeps
// the samples. The planning fallacy: people estimate from the plan, not from last time, so the
// plan must learn from last time.

import { posterior } from './stats.ts';

/** Samples kept per (person, step). Fixed, so memory is O(1) per pair. */
export const WINDOW = 9;

export type History = Map<string, number[]>;

export const keyOf = (personId: string, stepId: string) => `${personId}/${stepId}`;

/** Record one real duration in seconds. The oldest sample drops out once the window is full. */
export function record(history: History, personId: string, stepId: string, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const key = keyOf(personId, stepId);
  const samples = history.get(key);
  if (!samples) history.set(key, [seconds]);
  else {
    samples.push(seconds);
    if (samples.length > WINDOW) samples.shift(); // shift on <= 10 items: constant work
  }
}

/** Real mornings of any step count as this many of none before the household's habit is trusted. */
const BIAS_PRIOR = 10;

/**
 * The household's own planning fallacy: how its stated times compare with what happens, across every step
 * that has real mornings, as the mean log ratio, shrunk towards none by BIAS_PRIOR mornings and kept within
 * a factor of e^1.5. 0.47 means things take about 1.6 times what is said. Applied to every stated time, it
 * corrects steps with few or no mornings of their own. O(steps).
 */
export function statedBias(history: History, stated: Iterable<{ personId: string; stepId: string; statedSec: number }>, leaveOut?: string): number {
  let sum = 0;
  let n = 0;
  for (const { personId, stepId, statedSec } of stated) {
    // A step's own mornings already teach it directly; counting them here again would use them twice.
    if (keyOf(personId, stepId) === leaveOut) continue;
    for (const x of history.get(keyOf(personId, stepId)) ?? []) {
      sum += Math.log(x / statedSec);
      n++;
    }
  }
  return Math.max(-1.5, Math.min(1.5, sum / (BIAS_PRIOR + n)));
}

/** A learned difference worth telling someone about: at least 2 minutes and 25% off what they said. */
export interface Insight {
  personId: string;
  stepId: string;
  statedSec: number;
  /** The posterior median: what a typical morning now looks like. */
  learnedSec: number;
  samples: number;
}

/** Biggest gaps first. Needs three real mornings before it says anything. */
export function insights(history: History, stated: Iterable<{ personId: string; stepId: string; statedSec: number }>): Insight[] {
  const out: Insight[] = [];
  for (const { personId, stepId, statedSec } of stated) {
    const samples = history.get(keyOf(personId, stepId));
    if (!samples || samples.length < 3) continue;
    const learnedSec = Math.round(Math.exp(posterior(statedSec, samples).mu) / 30) * 30;
    const gap = Math.abs(learnedSec - statedSec);
    if (gap >= 120 && gap / statedSec >= 0.25) out.push({ personId, stepId, statedSec, learnedSec, samples: samples.length });
  }
  return out.sort((a, b) => Math.abs(b.learnedSec - b.statedSec) - Math.abs(a.learnedSec - a.statedSec));
}
