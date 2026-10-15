import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startDeparture } from '../core/departure.ts';
import { household, learnedHistory } from '../core/fixtures.ts';
import { Audit } from './audit.ts';
import { Store } from './store.ts';

const fresh = () => mkdtemp(join(tmpdir(), 'departures-'));

test('a household survives a save and a reopen, departure included', async () => {
  const dir = await fresh();
  const a = await Store.open(dir);
  a.household = household;
  a.history = learnedHistory();
  a.departure = startDeparture(household, a.history, 'School run', 2_000_000, 1_000_000);
  await a.save();
  const b = await Store.open(dir);
  assert.deepEqual(b.household, household);
  assert.deepEqual([...b.history], [...a.history]);
  assert.deepEqual(b.departure, a.departure);
});

test('many saves in a burst coalesce and the last state wins', async () => {
  const dir = await fresh();
  const s = await Store.open(dir);
  s.household = household;
  const all = [];
  for (let i = 0; i < 50; i++) {
    s.history = new Map([[`p/s${i}`, [60]]]);
    all.push(s.save());
  }
  await Promise.all(all);
  const back = await Store.open(dir);
  assert.deepEqual([...back.history], [['p/s49', [60]]]);
  assert.ok(!(await readdir(dir)).some((f) => f.endsWith('.tmp')), 'no temp file left behind');
});

test('a tampered or corrupt file is set aside, not trusted and not deleted', async () => {
  const dir = await fresh();
  await writeFile(join(dir, 'household.json'), JSON.stringify({ version: 2, household: { people: [{ id: '../etc', name: 'x', steps: [] }] }, history: [], departure: null }));
  const s = await Store.open(dir);
  assert.deepEqual(s.household, { people: [] });
  assert.ok((await readdir(dir)).some((f) => f.startsWith('household.json.unreadable-')));
  await writeFile(join(dir, 'household.json'), '{not json');
  assert.deepEqual((await Store.open(dir)).household, { people: [] });
});

test('audit log lines are hashed and never contain the raw client address', async () => {
  const dir = await fresh();
  const a = new Audit(dir);
  a.record({ tool: 'step_done', ok: true, person: 'isha', client: '192.168.1.20' });
  await a.flush();
  const line = JSON.parse((await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim());
  assert.equal(line.tool, 'step_done');
  assert.equal(line.client.length, 12);
  assert.ok(!JSON.stringify(line).includes('192.168'));
});
