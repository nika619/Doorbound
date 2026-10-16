// End-to-end check against a running server (npm run demo, or npm start). Plays the part of Alexa+'s
// MCP client over Streamable HTTP, then pokes the HTTP edges a stranger would.
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = process.env.DOORBOUND_URL ?? 'http://127.0.0.1:3939';
const url = new URL('/mcp', base);
const headers: Record<string, string> = process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {};
const step = (name: string) => console.log(`ok  ${name}`);

// ---------- the 2025-11-25 handshake, as Alexa+ uses today ----------
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
assert.equal(client.getNegotiatedProtocolVersion(), '2025-11-25');
step('initialize negotiates protocol 2025-11-25 over Streamable HTTP');

const { tools } = await client.listTools();
assert.deepEqual(tools.map((t) => t.name).sort(), ['change_departure', 'departure_status', 'end_departure', 'get_board', 'learned_times', 'set_routine', 'start_departure', 'step_done', 'still_going', 'undo_reroute']);
for (const t of tools) assert.ok(t.description && t.outputSchema, `${t.name} has a description and an output schema`);
assert.deepEqual((tools.find((t) => t.name === 'get_board')!._meta as { ui: { visibility: string[] } }).ui.visibility, ['app']);
step(`tools/list: ${tools.length} tools, one per thing a household says, each with an output schema; get_board is for the screen only`);

const res = await client.readResource({ uri: 'ui://doorbound/board.html' });
const page = res.contents[0] as { mimeType?: string; text?: string };
assert.equal(page.mimeType, 'text/html;profile=mcp-app');
assert.ok(page.text?.includes('<main id="board"'));
step('resources/read returns the board as an MCP App document');

type Result = { content: { type: string; text?: string }[]; structuredContent?: { rev: number }; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as Result;
  return { text: r.content.find((c) => c.type === 'text')?.text ?? '', board: r.structuredContent, isError: r.isError === true };
};
// Alexa reads these aloud: plain words, no markup.
const speakable = (text: string) => /^[A-Za-z0-9 ,.'’:%?-]+$/.test(text);

// The server's clock may run fast (demo), so departure times come from it.
const serverNow = Number((await fetch(new URL('/api/board?since=-2', base), { headers })).headers.get('X-Server-Now'));
const at = (minutes: number) => {
  const d = new Date(serverNow + minutes * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

await call('end_departure');
let r = await call('start_departure', { leaveAt: at(36) });
if (r.isError && /routine/.test(r.text)) {
  // An empty household: set up the demo family first.
  await call('set_routine', { person: 'Aarav', steps: [{ name: 'Breakfast', minutes: 8 }, { name: 'Brush teeth', minutes: 4 }, { name: 'Shoes and bag', minutes: 5 }] });
  await call('set_routine', { person: 'Isha', steps: [{ name: 'Shower', minutes: 8 }, { name: 'Get dressed', minutes: 6 }, { name: 'Breakfast', minutes: 4, quickVersion: { name: 'Breakfast to go', minutes: 2 } }, { name: 'Pack bag', minutes: 3, helpers: ['Dad'] }] });
  await call('set_routine', { person: 'Dad', steps: [{ name: 'Pack lunches', minutes: 8 }, { name: 'Unload dishwasher', minutes: 10, canWait: true }, { name: 'Start the car', minutes: 3 }] });
  r = await call('start_departure', { leaveAt: at(36) });
}
assert.ok(!r.isError && r.board && speakable(r.text), r.text);
step(`start_departure: "${r.text}"`);

r = await call('still_going', { person: 'Isha', extraMinutes: 25 });
assert.ok(!r.isError && speakable(r.text), r.text);
assert.match(r.text, /Re-routed|late|cutting it fine/, 'a 25-minute overrun is news');
step(`still_going: "${r.text}"`);

r = await call('departure_status');
assert.ok(!r.isError && speakable(r.text), r.text);
step(`departure_status: "${r.text}"`);

r = await call('undo_reroute');
assert.ok(speakable(r.text), r.text);
step(`undo_reroute: "${r.text}"`);

r = await call('step_done', { person: 'Zed' });
assert.ok(r.isError && /The household is/.test(r.text), 'an unknown person is an error that names the household');
step(`unknown person is an error result, never silence: "${r.text}"`);

r = await call('change_departure', { leaveAt: '25:99' });
assert.ok(r.isError, 'a malformed time is refused by the schema');
step('a malformed time is refused before it reaches the planner');

await call('end_departure');
r = await call('departure_status');
assert.ok(r.isError && /no departure running/i.test(r.text));
step('with no departure, status says what to say instead');
await client.close();

// ---------- the newer protocol, from the same endpoint ----------
const modern = new Client({ name: 'smoke-modern', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await modern.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
step(`a client that negotiates gets protocol ${modern.getNegotiatedProtocolVersion()} from the same endpoint`);
await modern.close();

// ---------- the HTTP edges ----------
const post = (body: string, extra: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers, ...extra }, body });
assert.equal((await post('{"jsonrpc":"2.0","id":1,"method":"ping"}', { origin: 'https://evil.example' })).status, 403);
step('a request from a foreign Origin is refused (DNS rebinding)');
assert.equal((await fetch(url, { headers })).status, 405);
step('GET /mcp is not offered (stateless server, no stream to resume)');
assert.equal((await post('{nope')).status, 400);
step('broken JSON is a 400, with no detail');
assert.equal((await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70_000) } }))).status, 413);
step('a body over 64 KB is refused before parsing');

const board = await fetch(new URL('/board', base));
const csp = board.headers.get('content-security-policy') ?? '';
assert.match(csp, /script-src 'sha256-/);
assert.ok(!csp.includes('unsafe-inline') && csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'"), csp);
assert.equal(board.headers.get('x-content-type-options'), 'nosniff');
assert.equal(board.headers.get('referrer-policy'), 'no-referrer');
step('/board: hash-only CSP, nothing loads from anywhere, no framing, nosniff, no referrer');
const story = await fetch(new URL('/', base));
assert.equal(story.status, 200);
assert.match(story.headers.get('content-security-policy') ?? '', /script-src 'sha256-/);
assert.ok((await story.text()).includes('Every morning is a'));
step('/ serves the story page under the same hash-only CSP');
assert.equal((await fetch(new URL('/nope', base))).status, 404);
assert.equal(await (await fetch(new URL('/healthz', base))).text(), 'ok');
step('unknown paths are 404; /healthz answers');

console.log('\nAll smoke checks passed.');
