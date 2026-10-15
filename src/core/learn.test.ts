import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insights, record, WINDOW, type History } from './learn.ts';

test('history is bounded: only the last WINDOW samples are kept', () => {
  const h: History = new Map();
  for (let i = 0; i < 50; i++) record(h, 'dad', 'lunches', 60 + i);
  assert.equal(h.get('dad/lunches')!.length, WINDOW);
  assert.equal(h.get('dad/lunches')![0], 60 + 50 - WINDOW, 'the oldest samples are the ones forgotten');
});

test('bad samples are ignored', () => {
  const h: History = new Map();
  for (const s of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) record(h, 'a', 'b', s);
  assert.equal(h.size, 0);
});

test('insights report only real, large gaps, biggest first, and only after three mornings', () => {
  const h: History = new Map();
  for (let i = 0; i < 5; i++) record(h, 'isha', 'shower', 14 * 60);
  for (let i = 0; i < 5; i++) record(h, 'aarav', 'teeth', 4 * 60);
  for (let i = 0; i < 5; i++) record(h, 'aarav', 'breakfast', 12 * 60);
  for (let i = 0; i < 2; i++) record(h, 'dad', 'lunches', 20 * 60);
  const found = insights(h, [
    { personId: 'isha', stepId: 'shower', statedSec: 8 * 60 },
    { personId: 'aarav', stepId: 'teeth', statedSec: 3 * 60 },
    { personId: 'aarav', stepId: 'breakfast', statedSec: 8 * 60 },
    { personId: 'dad', stepId: 'lunches', statedSec: 8 * 60 },
  ]);
  assert.deepEqual(found.map((i) => i.stepId), ['shower', 'breakfast'], 'a one-minute gap on teeth is not news, and two mornings are not enough');
  assert.ok(found[0].learnedSec > 8 * 60 && found[0].learnedSec <= 14 * 60, 'learned time sits between what was said and what happened, closer to what happened');
});
