import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addCue, createShow, elapsedMs, fireCue, pause, remainingMs, resolve, resume, setScene, type Scene } from './show.ts';

const T0 = 1_800_000_000_000;
const title: Scene = { kind: 'title', headline: 'Happy Birthday Aarav' };
const countdown: Scene = { kind: 'countdown', label: 'Candles', durationMs: 60_000 };

test('elapsed time excludes paused time', () => {
  let s = createShow('Party', countdown, T0);
  assert.equal(elapsedMs(s, T0 + 10_000), 10_000);
  s = pause(s, T0 + 10_000);
  assert.equal(elapsedMs(s, T0 + 25_000), 10_000, 'frozen while paused');
  s = resume(s, T0 + 25_000);
  assert.equal(elapsedMs(s, T0 + 30_000), 15_000, 'no time lost or gained on resume');
});

test('pause and resume are idempotent', () => {
  const s = createShow('Party', countdown, T0);
  const p = pause(s, T0 + 1000);
  assert.equal(pause(p, T0 + 2000), p, 'second pause changes nothing');
  assert.equal(resume(s, T0 + 2000), s, 'resume when running changes nothing');
});

test('countdown reaches zero and never goes negative', () => {
  const s = createShow('Party', countdown, T0);
  assert.equal(remainingMs(s, T0 + 59_000), 1000);
  assert.equal(remainingMs(s, T0 + 60_000), 0);
  assert.equal(remainingMs(s, T0 + 999_000), 0);
});

test('a timed cue starts at its scheduled time even if nobody looked until later', () => {
  let s = createShow('Party', title, T0);
  s = addCue(s, { label: 'candles', scene: countdown, atMs: T0 + 5000 }, T0);
  assert.equal(resolve(s, T0 + 4999).scene.kind, 'title', 'not due yet');
  const late = resolve(s, T0 + 20_000);
  assert.equal(late.scene.kind, 'countdown');
  assert.equal(late.sceneStartedAtMs, T0 + 5000, 'clock starts at the cue time');
  assert.equal(remainingMs(late, T0 + 20_000), 45_000);
  assert.equal(resolve(late, T0 + 30_000), late, 'a fired cue does not fire twice');
});

test('due cues fire in time order, whatever order they were added in', () => {
  let s = createShow('Party', title, T0);
  s = addCue(s, { label: 'second', scene: { kind: 'title', headline: 'B' }, atMs: T0 + 2000 }, T0);
  s = addCue(s, { label: 'first', scene: { kind: 'title', headline: 'A' }, atMs: T0 + 1000 }, T0);
  const r = resolve(s, T0 + 10_000);
  assert.deepEqual(r.scene, { kind: 'title', headline: 'B' });
  assert.equal(r.sceneStartedAtMs, T0 + 2000);
});

test('a named cue fires by label, case-insensitively, and unknown names return null', () => {
  let s = createShow('Party', title, T0);
  s = addCue(s, { label: 'Cake time', scene: countdown }, T0);
  const fired = fireCue(s, 'cake TIME', T0 + 3000);
  assert.ok(fired);
  assert.equal(fired.scene.kind, 'countdown');
  assert.equal(fired.sceneStartedAtMs, T0 + 3000);
  assert.equal(fireCue(s, 'fireworks', T0), null);
});

test('every change bumps the revision so a screen can detect staleness', () => {
  const s = createShow('Party', title, T0);
  assert.ok(setScene(s, countdown, T0).rev > s.rev);
  assert.ok(pause(s, T0).rev > s.rev);
  assert.ok(addCue(s, { label: 'x', scene: title }, T0).rev > s.rev);
});
