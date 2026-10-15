// The household from the design frame, and reproducible randomness, shared by the tests.
import { markDone, startDeparture, stillGoing, type Household, type PersonDef } from './departure.ts';
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

/** A random household: up to `maxPeople` people with up to `maxSteps` steps, `flex` scaling how often a step can change. */
export function randomHousehold(r: () => number, maxPeople: number, maxSteps: number, flex = 1): Household {
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

/** A random morning in progress: some history, some steps done, some running over. */
export function randomMorning(r: () => number, hh: Household, t0 = Date.UTC(2026, 9, 15, 1, 42)) {
  const at = (min: number) => t0 + min * 60_000;
  const h: History = new Map();
  for (const p of hh.people) for (const s of p.steps) if (r() < 0.5) for (let k = 0; k < 4; k++) record(h, p.id, s.id, s.statedSec * (0.6 + r() * 1.4));
  let dep = startDeparture(hh, h, 'run', at(Math.floor(r() * 50)), at(0));
  let now = at(0);
  for (let e = 0; e < 6; e++) {
    now += Math.floor(r() * 6) * 60_000;
    const who = hh.people[Math.floor(r() * hh.people.length)].id;
    dep = (r() < 0.5 ? markDone(dep, who, now)?.dep : stillGoing(dep, who, 60 * Math.floor(1 + r() * 10), now)) ?? dep;
  }
  return { h, dep, now };
}

/** The largest household the limits allow, every step with every kind of change: 8 people x 15 steps. */
export function householdAtLimits(r: () => number): Household {
  const ids = Array.from({ length: 8 }, (_, i) => `p${i}`);
  const step = (j: number, id: string) => ({ id: `s${j}`, name: `step ${j}`, statedSec: 60 * (1 + Math.floor(r() * 10)), quick: { name: 'quick', sec: 30 }, canWait: true, optional: true, helpers: ids.filter((o) => o !== id) });
  return { people: ids.map((id) => ({ id, name: id, steps: Array.from({ length: 15 }, (_, j) => step(j, id)) })) };
}
