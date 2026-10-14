// Learns how long each person really takes for each step.
// The planning fallacy: people estimate from the plan, not from what happened last time.
// So the plan uses what happened, once there is enough of it.

/** Samples kept per (person, step). Fixed, so memory is O(1) per pair and estimates are O(1). */
export const WINDOW = 9;
/** Below this many samples, never plan for less time than the person said. */
const MIN_SAMPLES = 3;
/** Plan at the 70th percentile: a typical bad morning, not the best one. */
const QUANTILE = 0.7;

export type History = Map<string, number[]>;

export const keyOf = (personId: string, stepId: string) => `${personId}/${stepId}`;

/** Record one real duration in seconds. Oldest sample drops out once the window is full. */
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

/** Quantile by linear interpolation over a sorted copy. O(W log W) with W <= 9, so constant. */
export function quantile(samples: readonly number[], q: number): number {
  const s = [...samples].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}

/**
 * Seconds to plan for. With few samples, the larger of the stated time and what has happened,
 * so a slow start never makes the plan more optimistic. With enough samples, the learned quantile.
 * Rounded up to the next 30 seconds, because nobody reads seconds off a kitchen screen.
 */
export function estimate(history: History, personId: string, stepId: string, statedSec: number): number {
  const samples = history.get(keyOf(personId, stepId));
  let sec = statedSec;
  if (samples && samples.length > 0) {
    const learned = quantile(samples, samples.length >= MIN_SAMPLES ? QUANTILE : 0.5);
    sec = samples.length >= MIN_SAMPLES ? learned : Math.max(statedSec, learned);
  }
  return Math.ceil(sec / 30) * 30;
}

/** A learned difference worth telling someone about: at least 2 minutes and 25% off what they said. */
export interface Insight {
  personId: string;
  stepId: string;
  statedSec: number;
  learnedSec: number;
  samples: number;
}

export function insights(history: History, stated: Iterable<{ personId: string; stepId: string; statedSec: number }>): Insight[] {
  const out: Insight[] = [];
  for (const { personId, stepId, statedSec } of stated) {
    const samples = history.get(keyOf(personId, stepId));
    if (!samples || samples.length < MIN_SAMPLES) continue;
    const learnedSec = estimate(history, personId, stepId, statedSec);
    if (Math.abs(learnedSec - statedSec) >= 120 && Math.abs(learnedSec - statedSec) / statedSec >= 0.25)
      out.push({ personId, stepId, statedSec, learnedSec, samples: samples.length });
  }
  return out.sort((a, b) => Math.abs(b.learnedSec - b.statedSec) - Math.abs(a.learnedSec - a.statedSec));
}
