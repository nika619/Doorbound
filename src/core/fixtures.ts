// The household from the design frame, and reproducible randomness, shared by the tests.
import type { Household } from './departure.ts';
import { record, type History } from './learn.ts';

export const household: Household = {
  people: [
    { id: 'aarav', name: 'Aarav', steps: [{ id: 'breakfast', name: 'Breakfast', statedSec: 480 }, { id: 'teeth', name: 'Brush teeth', statedSec: 240 }, { id: 'shoes', name: 'Shoes and bag', statedSec: 300 }] },
    {
      id: 'isha',
      name: 'Isha',
      steps: [
        { id: 'shower', name: 'Shower', statedSec: 480 },
        { id: 'dress', name: 'Get dressed', statedSec: 360 },
        { id: 'breakfast', name: 'Breakfast', statedSec: 240, quick: { name: 'Breakfast to go', sec: 120 } },
        { id: 'bag', name: 'Pack bag', statedSec: 180, helpers: ['dad'] },
      ],
    },
    { id: 'dad', name: 'Dad', steps: [{ id: 'lunches', name: 'Pack lunches', statedSec: 480 }, { id: 'dishwasher', name: 'Unload dishwasher', statedSec: 600, canWait: true }, { id: 'car', name: 'Start the car', statedSec: 180 }] },
  ],
};
export function learnedHistory(): History {
  const h: History = new Map();
  for (let i = 0; i < 5; i++) {
    record(h, 'isha', 'shower', 14 * 60);
    record(h, 'aarav', 'breakfast', 12 * 60);
  }
  return h;
}

/** mulberry32: small, fast uniforms in [0, 1), reproducible from the seed. */
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A log-normal draw (Box-Muller). */
export function draw(r: () => number, d: { mu: number; sigma: number }): number {
  return Math.exp(d.mu + d.sigma * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()));
}
