import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweep } from './retention.ts';

test('households idle past the retention period are deleted; recent ones and anything else are kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'households-'));
  const now = Date.now();
  const make = async (id: string, ageDays: number) => {
    await mkdir(join(dir, id));
    await writeFile(join(dir, id, 'household.json'), '{}');
    const t = new Date(now - ageDays * 86_400_000);
    await utimes(join(dir, id, 'household.json'), t, t);
  };
  const old = 'a'.repeat(32);
  const recent = 'b'.repeat(32);
  await make(old, 200);
  await make(recent, 10);
  await mkdir(join(dir, 'not-a-household'));
  assert.deepEqual(await sweep(dir, now, 180), [old]);
  assert.deepEqual((await readdir(dir)).sort(), [recent, 'not-a-household'].sort());
  assert.deepEqual(await sweep(join(dir, 'missing'), now), [], 'no folder: nothing to do, no throw');
});
