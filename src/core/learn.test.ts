import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimate, insights, quantile, record, WINDOW, type History } from './learn.ts';

test('with no history the plan uses the stated time, rounded up to 30 s', () => {
  assert.equal(estimate(new Map(), 'isha', 'shower', 8 * 60), 480);
  assert.equal(estimate(new Map(), 'isha', 'shower', 61), 90);
});

test('with one or two samples the plan never becomes more optimistic than what was said', () => {
  const h: History = new Map();
  record(h, 'isha', 'shower', 5 * 60);
  assert.equal(estimate(h, 'isha', 'shower', 8 * 60), 480, 'one fast morning does not shrink the plan');
  record(h, 'isha', 'shower', 14 * 60);
  assert.ok(estimate(h, 'isha', 'shower', 8 * 60) > 480, 'a slow morning grows it at once');
});

test('with three or more samples the plan follows reality at the 70th percentile', () => {
  const h: History = new Map();
  for (const m of [13, 14, 15, 12, 16]) record(h, 'isha', 'shower', m * 60);
  assert.equal(estimate(h, 'isha', 'shower', 8 * 60), 15 * 60);
});

test('history is bounded: only the last WINDOW samples count', () => {
  const h: History = new Map();
  for (let i = 0; i < 50; i++) record(h, 'dad', 'lunches', i < 40 ? 60 : 600);
  assert.equal(h.get('dad/lunches')!.length, WINDOW);
  assert.equal(estimate(h, 'dad', 'lunches', 300), 600, 'old fast mornings are forgotten');
});

test('bad samples are ignored', () => {
  const h: History = new Map();
  for (const s of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) record(h, 'a', 'b', s);
  assert.equal(h.size, 0);
});

test('quantile interpolates and handles a single sample', () => {
  assert.equal(quantile([10], 0.7), 10);
  assert.equal(quantile([0, 10], 0.5), 5);
  assert.equal(quantile([3, 1, 2], 0), 1);
  assert.equal(quantile([3, 1, 2], 1), 3);
});

test('insights report only real, large gaps, biggest first', () => {
  const h: History = new Map();
  for (let i = 0; i < 5; i++) record(h, 'isha', 'shower', 14 * 60);
  for (let i = 0; i < 5; i++) record(h, 'aarav', 'teeth', 4 * 60);
  for (let i = 0; i < 5; i++) record(h, 'aarav', 'breakfast', 12 * 60);
  const found = insights(h, [
    { personId: 'isha', stepId: 'shower', statedSec: 8 * 60 },
    { personId: 'aarav', stepId: 'teeth', statedSec: 3 * 60 },
    { personId: 'aarav', stepId: 'breakfast', statedSec: 8 * 60 },
  ]);
  assert.deepEqual(found.map((i) => i.stepId), ['shower', 'breakfast'], 'a one-minute difference on teeth is not news');
});
