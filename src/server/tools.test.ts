// The demo morning through the real MCP tools, on a fixed clock: what Alexa would say at each step.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { household, learnedHistory } from '../core/fixtures.ts';
import { Audit } from './audit.ts';
import { Store } from './store.ts';
import { buildServer } from './tools.ts';

test('a departure that crosses midnight is tonight, not this morning', async () => {
  const store = await Store.open(await mkdtemp(join(tmpdir(), 'tools-')));
  store.household = household;
  const now = new Date(2026, 9, 15, 23, 40).getTime();
  const server = buildServer({ store, audit: new Audit(await mkdtemp(join(tmpdir(), 'audit-'))), client: 'test', boardHtml: () => '<html></html>', now: () => now, clockRate: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'alexa', version: '1' });
  await client.connect(a);
  await client.listTools(); // so the client checks every reply against its declared output schema, as Alexa+ would
  const text = async (leaveAt: string) => ((await client.callTool({ name: 'start_departure', arguments: { leaveAt } })).content as { text: string }[])[0].text;
  assert.match(await text('00:15'), /Leave at 0:15, in 35 minutes\./);
  assert.equal(await text('23:30'), '23:30 has already passed today. Say a later time.');
});

test('the demo morning, as Alexa says it', async () => {
  const store = await Store.open(await mkdtemp(join(tmpdir(), 'tools-')));
  store.household = household;
  store.history = learnedHistory();
  let now = new Date(2026, 9, 15, 7, 12).getTime(); // local 7:12
  const server = buildServer({ store, audit: new Audit(await mkdtemp(join(tmpdir(), 'audit-'))), client: 'test', boardHtml: () => '<html></html>', now: () => now, clockRate: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'alexa', version: '1' });
  await client.connect(a);
  await client.listTools(); // so the client checks every reply against its declared output schema, as Alexa+ would
  const say = async (minute: number, name: string, args: Record<string, unknown> = {}) => {
    now = new Date(2026, 9, 15, 7, 12).getTime() + minute * 60_000;
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as { text: string }[])[0].text, error: r.isError === true, board: r.structuredContent as { rev: number } | undefined };
  };

  const start = await say(0, 'start_departure', { leaveAt: '07:49' });
  assert.ok(!JSON.stringify(start.board).includes('forecasts'), 'open forecasts are server bookkeeping, not board data');
  assert.match(start.text, /^School run started\. Everyone is on time\. Leave at 7:49, in 37 minutes\. Isha is the tightest, at 9\d%\.$/);
  await say(8.1, 'step_done', { person: 'Dad' });
  await say(12.1, 'step_done', { person: 'aarav' });
  const over = await say(14.5, 'still_going', { person: 'Isha', extraMinutes: 9 });
  assert.match(over.text, /^Re-routed: Isha has breakfast to go and Dad takes over pack bag for Isha\. Everyone still leaves at 7:49, and Isha is now at (8[5-9]|9\d)%\.$/);
  const undo = await say(14.6, 'undo_reroute');
  assert.match(undo.text, /^Back to the old plan\. Isha is running late, at \d+%\. Leave at 7:49, or at 7:5\d to be sure\.$/);
  const status = await say(15, 'departure_status');
  assert.ok(!status.error && status.board!.rev > start.board!.rev);
  assert.match((await say(15, 'how_accurate')).text, /^I've checked (none|only \d) of my chances against what really happened so far\./);
  assert.equal((await say(15, 'allow_change', { person: 'Aarav', step: 'teeth', optional: true })).text, "Got it: Aarav's brush teeth, it can be skipped. It applies from the next departure.");
  assert.match((await say(15, 'allow_change', { person: 'Aarav', step: 'piano', canWait: true })).text, /^Aarav has no step called piano\. Their steps are breakfast, brush teeth and shoes and bag\.$/);
  const tomorrow = await say(15, 'plan_tomorrow', { leaveAt: '07:49' });
  assert.match(tomorrow.text, /^To leave at 7:49 with an 85% chance of everyone making it: Isha by \d+:\d\d, \w+ by \d+:\d\d and \w+ by \d+:\d\d\. Shall I set alarms for those times\?$/);

  const nobody = await say(15, 'step_done', { person: 'Zed' });
  assert.ok(nobody.error);
  assert.match(nobody.text, /The household is Aarav, Isha and Dad/);
  await client.close();
});
