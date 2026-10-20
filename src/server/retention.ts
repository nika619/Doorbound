// Households nobody has used for a long time are deleted, not kept forever: the data is children's routines.
// A household's file is rewritten whenever anything changes, so its age is how long it has been idle.

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Days without any change before a linked household is deleted. */
export const RETENTION_DAYS = 180;

/** Delete every household folder under `dir` idle for more than `days`. Returns the ones that went. Never throws. */
export async function sweep(dir: string, nowMs: number, days = RETENTION_DAYS): Promise<string[]> {
  const gone: string[] = [];
  for (const id of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{32}$/.test(id)) continue; // only household folders
    const age = await stat(join(dir, id, 'household.json')).then((s) => nowMs - s.mtimeMs, () => Infinity);
    if (age > days * 86_400_000) {
      await rm(join(dir, id), { recursive: true, force: true }).catch(() => {});
      gone.push(id);
    }
  }
  return gone;
}
