// The demo morning through the real MCP tools, on a fixed clock: what Alexa would say at each step.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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
  const ended = ((await client.callTool({ name: 'get_board', arguments: {} })).structuredContent as { ended?: { gateMs: number; atMs: number } }).ended;
  assert.equal(ended && ended.atMs - ended.gateMs, 3 * 60_000, "a screen's closing card: when they left, against when they had to");
  assert.match((await say(41, 'how_accurate')).text, /^I've checked \d+ of my chances against what happened\. /, 'both mornings were scored');
  // Four people busy: too many to read out what each is on, so names only.
  store.household = { people: [...household.people, { id: 'mum', name: 'Mum', steps: [{ id: 'yoga', name: 'Yoga', statedSec: 900 }] }] };
  await say(20, 'start_departure', { leaveAt: '08:20' });
  assert.equal((await say(21, 'step_done')).text, 'Who was that? Aarav, Isha, Dad or Mum?');
});

test('a household can be forgotten by voice, only after a yes, and its audit trail holds no names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tools-'));
  const store = await Store.open(dir);
  store.household = household;
  store.history = learnedHistory();
  const audit = new Audit(dir);
  const server = buildServer({ store, audit, client: 'test', boardHtml: () => '<html></html>', now: () => Date.now(), clockRate: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'alexa', version: '1' });
  await client.connect(a);
  await client.listTools();
  const text = async (name: string, args: Record<string, unknown> = {}) => ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text;
  await text('set_routine', { person: 'Isha', steps: [{ name: 'Shower', minutes: 8 }] });
  // A model that fills in confirm: true before anyone heard the warning gets the warning, not a deletion.
  assert.match(await text('forget_household', { confirm: true }), /cannot be undone\. Shall I delete it\?$/);
  assert.equal(store.household.people.length, 3, 'a yes nobody was asked for deletes nothing');
  assert.match(await text('forget_household'), /cannot be undone\. Shall I delete it\?$/);
  assert.equal(store.household.people.length, 3, 'nothing is deleted without a yes');
  assert.equal(await text('forget_household', { confirm: true }), 'Done. Doorbound has forgotten this household. Tell me a routine to start again.');
  assert.deepEqual([store.household.people.length, store.history.size, store.departure, store.scores.length], [0, 0, null, 0]);
  await audit.flush();
  const log = await readFile(join(dir, 'audit.jsonl'), 'utf8');
  assert.ok(!/isha/i.test(log) && /"person":"[0-9a-f]{12}"/.test(log), 'people appear only as hashes');
});

test('arrive-by and travel time: it works back to when to leave', async () => {
  const store = await Store.open(await mkdtemp(join(tmpdir(), 'tools-')));
  store.household = household;
  const now = new Date(2026, 9, 15, 7, 12).getTime();
  const server = buildServer({ store, audit: new Audit(await mkdtemp(join(tmpdir(), 'audit-'))), client: 'test', boardHtml: () => '<html></html>', now: () => now, clockRate: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'alexa', version: '1' });
  await client.connect(a);
  await client.listTools();
  const text = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text;
  assert.match(await text('start_departure', { arriveBy: '08:15', travelMinutes: 20 }), /^School run started to be there by 8:15, allowing 23 minutes for the 20-minute journey\. Everyone is on time\. Leave at 7:52, in 40 minutes\./);
  assert.equal(store.departure!.gateMs, new Date(2026, 9, 15, 7, 52).getTime(), 'the journey is planned at its long end, as the morning is');
  assert.match(await text('plan_tomorrow', { arriveBy: '8:15 am', travelMinutes: 20 }), /^To leave at 7:52 to be there by 8:15, allowing 23 minutes for the 20-minute journey with an 85% chance/);
  assert.equal(await text('start_departure', {}), 'When do you need to leave? Say a time, or when you need to be there and how long it takes to get there.');
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
  assert.match(await text('00:15'), /Leave at 12:15 am, in 35 minutes\./);
  assert.match(await text('12:15 am'), /Leave at 12:15 am, in 35 minutes\./, '"12:15 am" is just after midnight');
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

  const start = await say(0, 'start_departure', { leaveAt: '07:52' });
  assert.ok(!JSON.stringify(start.board).includes('forecasts'), 'open forecasts are server bookkeeping, not board data');
  assert.match(start.text, /^School run started\. Everyone is on time\. Leave at 7:52, in 40 minutes\. Isha is the tightest, with about a 9 in 10 chance\. Shall I set a reminder for 7:47, five minutes before you leave\?$/);
  await say(8.1, 'step_done', { person: 'Dad' });
  await say(12.1, 'step_done', { person: 'aarav' });
  const over = await say(14.5, 'still_going', { person: 'Isha', extraMinutes: 10 });
  assert.match(over.text, /^Re-routed: Isha has breakfast to go and Dad takes over pack bag for Isha\. Everyone still leaves at 7:52, and Isha is back on track, with about a 9 in 10 chance\.$/);
  const undo = await say(14.6, 'undo_reroute');
  assert.match(undo.text, /^Back to the old plan\. Isha is running late, with about (a [1-9] in \d+|an even) chance\.( Isha is \d+ minutes over on shower\.)? Leave at 7:52, or at (7:5\d|8:0\d) to be sure\.$/);
  const status = await say(15, 'departure_status');
  assert.ok(!status.error && status.board!.rev > start.board!.rev);
  assert.match((await say(15, 'how_accurate')).text, /^I've checked (none|only \d) of my chances against what really happened so far\./);
  assert.equal((await say(15, 'allow_change', { person: 'Aarav', step: 'teeth', optional: true })).text, "Got it: Aarav's brush teeth, it can be skipped. It applies from the next departure.");
  assert.match((await say(15, 'allow_change', { person: 'Aarav', step: 'piano', canWait: true })).text, /^Aarav has no step called piano\. Their steps are breakfast, brush teeth and shoes and bag\.$/);
  assert.match((await say(15, 'plan_tomorrow', { leaveAt: '07:40' })).text, /set alarms for Isha now, /, 'at 7:27, for 7:40, Isha should already be up');
  const tomorrow = await say(60, 'plan_tomorrow', { leaveAt: '07:49' }); // at 8:12, so 7:49 is tomorrow
  await say(60, 'allow_change', { person: 'Isha', step: 'shower', uses: 'bathroom' });
  await say(60, 'allow_change', { person: 'Aarav', step: 'teeth', uses: 'bathroom', optional: false }); // made skippable earlier in this test
  assert.match((await say(60, 'plan_tomorrow', { leaveAt: '07:49' })).text, / The bathroom: Isha, then Aarav\. Shall I set them\?$/);
  assert.match(tomorrow.text, /^To leave at 7:49 with an 85% chance of everyone making it, set alarms for Isha at \d+:\d\d, \w+ at \d+:\d\d and \w+ at \d+:\d\d\. That allows 10 minutes to get up\. Shall I set them\?$/);

  const nobody = await say(15, 'step_done', { person: 'Zed' });
  assert.ok(!nobody.error, 'an unknown name becomes a question, not a dead end');
  assert.match(nobody.text, /^I don't have anyone called Zed\. Who was that\? /);
  await client.close();
});
