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

test("with no name said, it works out who from the step, or asks", async () => {
  const store = await Store.open(await mkdtemp(join(tmpdir(), 'tools-')));
  store.household = household;
  let now = new Date(2026, 9, 15, 7, 12).getTime();
  const server = buildServer({ store, audit: new Audit(await mkdtemp(join(tmpdir(), 'audit-'))), client: 'test', boardHtml: () => '<html></html>', now: () => now, clockRate: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'alexa', version: '1' });
  await client.connect(a);
  await client.listTools();
  const say = async (minute: number, name: string, args: Record<string, unknown> = {}) => {
    now = new Date(2026, 9, 15, 7, 12).getTime() + minute * 60_000;
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as { text: string }[])[0].text, error: r.isError === true };
  };
  await say(0, 'start_departure', { leaveAt: '07:49' });
  assert.deepEqual(await say(5, 'step_done'), { text: 'Who was that? Aarav is on breakfast, Isha on shower and Dad on pack lunches.', error: false });
  assert.match((await say(9, 'step_done', { step: 'Shower' })).text, /^Shower done\. Isha is on to get dressed, about \d+ minutes\./);
  assert.equal((await say(9.5, 'step_done', { step: 'piano' })).text, 'Nobody is on piano right now. Who was that? Aarav is on breakfast, Isha on get dressed and Dad on pack lunches.');
  assert.match((await say(10, 'still_going', { step: 'lunches' })).text, /Dad|Re-routed/);
  for (const [m, who] of [[11, 'Aarav'], [12, 'Aarav'], [13, 'Aarav'], [14, 'Dad'], [15, 'Dad'], [16, 'Dad']] as const) await say(m, 'step_done', { person: who });
  assert.match((await say(18, 'step_done')).text, /^Get dressed done\./, 'only Isha is left, so it is her');
  assert.equal((await say(18.5, 'step_done', { person: 'me', step: 'piano' })).text.startsWith('Nobody is on piano'), true, '"me" is no name, not an unknown one');
  assert.equal((await say(19, 'ready_to_go')).text, 'Isha is ready to go. Everyone is ready. Have a good day.');
  assert.equal((await say(20, 'end_departure')).text, 'School run done, on time. Have a good day.');
  // Only "start" and "we've left": everyone counts as ready when they went, and the morning is scored.
  await say(21, 'start_departure', { leaveAt: '07:49' });
  assert.match((await say(40, 'end_departure')).text, /^School run done, 3 minutes after 7:49\./);
  assert.match((await say(41, 'how_accurate')).text, /^I've checked \d+ of my chances against what happened\. /, 'both mornings were scored');
  // Four people busy: too many to read out what each is on, so names only.
  store.household = { people: [...household.people, { id: 'mum', name: 'Mum', steps: [{ id: 'yoga', name: 'Yoga', statedSec: 900 }] }] };
  await say(20, 'start_departure', { leaveAt: '08:20' });
  assert.equal((await say(21, 'step_done')).text, 'Who was that? Aarav, Isha, Dad or Mum?');
});

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
  assert.match((await say(15, 'plan_tomorrow', { leaveAt: '07:40' })).text, /set alarms for Isha now, /, 'at 7:27, for 7:40, Isha should already be up');
  const tomorrow = await say(60, 'plan_tomorrow', { leaveAt: '07:49' }); // at 8:12, so 7:49 is tomorrow
  assert.match(tomorrow.text, /^To leave at 7:49 with an 85% chance of everyone making it, set alarms for Isha at \d+:\d\d, \w+ at \d+:\d\d and \w+ at \d+:\d\d\. That allows 10 minutes to get up\. Shall I set them\?$/);

  const nobody = await say(15, 'step_done', { person: 'Zed' });
  assert.ok(!nobody.error, 'an unknown name becomes a question, not a dead end');
  assert.match(nobody.text, /^I don't have anyone called Zed\. Who was that\? /);
  await client.close();
});
