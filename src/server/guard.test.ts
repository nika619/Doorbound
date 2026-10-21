import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { BodyTooLarge, openOnce, pageCsp, RateLimiter, readBody, tokenMatches } from './guard.ts';

test('token comparison: exact match only, any length, never throws', () => {
  const secret = 'x'.repeat(40);
  assert.equal(tokenMatches(secret, secret), true);
  assert.equal(tokenMatches(secret + 'y', secret), false);
  assert.equal(tokenMatches('short', secret), false);
  assert.equal(tokenMatches(undefined, secret), false);
  assert.equal(tokenMatches('', secret), false);
});

test('rate limiter: a burst is allowed, then requests wait, then it refills', () => {
  const rl = new RateLimiter(2, 4);
  for (let i = 0; i < 4; i++) assert.equal(rl.take('a', 0), 0, `burst ${i}`);
  assert.ok(rl.take('a', 0) > 0, 'fifth request in the same instant waits');
  assert.equal(rl.take('b', 0), 0, 'other clients are unaffected');
  assert.equal(rl.take('a', 500), 0, 'half a second refills one token at 2 per second');
});

test('rate limiter memory is capped: the least recently seen client is evicted', () => {
  const rl = new RateLimiter(1, 1, 3);
  for (const c of ['a', 'b', 'c']) rl.take(c, 0);
  rl.take('a', 1); // a is now most recent
  rl.take('d', 2); // evicts b
  assert.equal(rl.size, 3);
  assert.equal(rl.take('b', 2), 0, 'b starts with a fresh bucket because it was evicted');
});

function fakeRequest(body: Buffer, declared?: number) {
  const s = new PassThrough() as unknown as IncomingMessage & PassThrough;
  (s as { headers: Record<string, string> }).headers = declared === undefined ? {} : { 'content-length': String(declared) };
  queueMicrotask(() => s.end(body));
  return s;
}

test('body reader: accepts up to the limit, rejects early when the declared or actual size is over', async () => {
  assert.equal((await readBody(fakeRequest(Buffer.alloc(10)), 10)).length, 10);
  await assert.rejects(readBody(fakeRequest(Buffer.alloc(5), 999), 10), BodyTooLarge);
  await assert.rejects(readBody(fakeRequest(Buffer.alloc(11)), 10), BodyTooLarge);
});

test('page CSP allows nothing by default and only hashed inline code', () => {
  const csp = pageCsp({ scripts: ['abc'], styles: ['def'] })['Content-Security-Policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'sha256-abc'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('peek says what take would, without spending: for limits that count only failures', () => {
  const rl = new RateLimiter(1, 2);
  assert.equal(rl.peek('a', 0), 0, 'a client never seen is free');
  rl.take('a', 0);
  rl.take('a', 0);
  assert.equal(rl.peek('a', 0), 1);
  assert.equal(rl.peek('a', 0), 1, 'peeking spends nothing');
  assert.equal(rl.peek('a', 1000), 0, 'and it refills');
});

test('a household is opened once, shared by requests at the same moment, and not evicted while busy', async () => {
  let t = 0;
  const opened: string[] = [];
  const cache = openOnce(async (id) => (opened.push(id), { id }), 2, 60_000, () => t);
  const [a, b] = await Promise.all([cache.get('x'), cache.get('x')]);
  assert.equal(a, b, 'two requests at once get the same store');
  await cache.get('y');
  t = 30_000;
  await cache.get('z'); // the cache is full, but x was used 30 s ago: it stays, and the cache grows
  assert.deepEqual([cache.has('x'), cache.has('y'), cache.has('z')], [true, true, true]);
  t = 200_000;
  await cache.get('w'); // now x has been idle long enough to go
  assert.deepEqual([cache.has('x'), opened], [false, ['x', 'y', 'z', 'w']]);
});
