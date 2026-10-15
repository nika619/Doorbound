// The household from the design frame, shared by the tests.
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
