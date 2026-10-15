// Append-only record of every change: when, which tool, whether it worked, and a hashed client.
// No arguments beyond the person concerned, and never a credential. Rotated at 1 MB so it stays bounded.

import { createHash } from 'node:crypto';
import { appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 1_000_000;

export class Audit {
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly dir: string) {}

  record(entry: { tool: string; ok: boolean; person?: string; client: string }): void {
    const file = join(this.dir, 'audit.jsonl');
    const line = JSON.stringify({ t: new Date().toISOString(), tool: entry.tool, ok: entry.ok, person: entry.person, client: createHash('sha256').update(entry.client).digest('hex').slice(0, 12) }) + '\n';
    // Serialised so lines never interleave and rotation never races an append.
    this.chain = this.chain
      .then(async () => {
        const size = await stat(file).then((s) => s.size, () => 0);
        if (size > MAX_BYTES) await rename(file, join(this.dir, 'audit.1.jsonl'));
        await appendFile(file, line, { mode: 0o600 });
      })
      .catch((e) => console.error('audit write failed', (e as Error).message));
  }

  flush(): Promise<void> {
    return this.chain;
  }
}
