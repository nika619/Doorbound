import assert from 'node:assert/strict';
import { test } from 'node:test';
import { at, isZone, wall } from './zone.ts';

test("a household's clock, wherever the server is", () => {
  const ms = Date.UTC(2026, 9, 15, 2, 10); // 7:40 in Pune (UTC+5:30), a Thursday
  assert.deepEqual([wall(ms, 'Asia/Kolkata').h, wall(ms, 'Asia/Kolkata').mi, wall(ms, 'Asia/Kolkata').wd], [7, 40, 4]);
  assert.equal(at(2026, 10, 15, 7, 40, 'Asia/Kolkata'), ms);
  // Ohio in summer time and in winter: the same 7:40 is a different UTC hour.
  assert.equal(at(2026, 10, 15, 7, 40, 'America/New_York'), Date.UTC(2026, 9, 15, 11, 40));
  assert.equal(at(2026, 12, 15, 7, 40, 'America/New_York'), Date.UTC(2026, 11, 15, 12, 40));
  // Tomorrow across a month's end, and the spring-forward gap (2:30 does not exist on 8 March 2026).
  assert.equal(at(2026, 10, 32, 7, 40, 'Asia/Kolkata'), Date.UTC(2026, 10, 1, 2, 10));
  assert.equal(at(2026, 3, 8, 2, 30, 'America/New_York'), Date.UTC(2026, 2, 8, 7, 30));
  assert.deepEqual([isZone('Asia/Kolkata'), isZone('Mars/Olympus'), isZone('UTC')], [true, false, true]);
});
