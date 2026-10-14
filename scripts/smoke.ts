// End-to-end check against a running server (npm start). Plays the part of a voice assistant's MCP client.
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = process.env.MARQUEE_URL ?? 'http://127.0.0.1:3939';
const url = new URL('/mcp', base);
const step = (name: string) => console.log(`ok  ${name}`);
type State = { show: { title: string; rev: number; scene: { kind: string }; sceneStartedAtMs: number; pausedAtMs: number | null; cues: { atMs?: number }[] } | null; remainingMs: number; serverNowMs: number };

const client = new Client({ name: 'smoke', version: '0.0.0' }); // default mode: the 2025 initialize handshake
await client.connect(new StreamableHTTPClientTransport(url));
assert.equal(client.getNegotiatedProtocolVersion(), '2025-11-25');
step('initialize negotiates protocol 2025-11-25 over Streamable HTTP');

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, ['add_cue', 'control_show', 'fire_cue', 'get_stage_state', 'set_score', 'start_countdown', 'start_show']);
const stageTool = tools.find((t) => t.name === 'get_stage_state')!;
assert.deepEqual((stageTool._meta as { ui: { visibility: string[] } }).ui.visibility, ['app']);
for (const t of tools) assert.ok(t.description && t.outputSchema, `${t.name} has a description and an output schema`);
step(`tools/list returns ${tools.length} tools, each described with an output schema; get_stage_state is app-only`);

const res = await client.readResource({ uri: 'ui://marquee/stage.html' });
const html = res.contents[0] as { mimeType?: string; text?: string };
assert.equal(html.mimeType, 'text/html;profile=mcp-app');
assert.ok((html.text ?? '').includes('<main id="stage"'));
step('resources/read returns the stage as an MCP App document');

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  return { text: r.content.find((c) => c.type === 'text')?.text ?? '', state: r.structuredContent as State, isError: r.isError === true };
};
const speakable = (text: string) => /^[A-Za-z0-9 ,.'’:-]+$/.test(text);

let r = await call('start_show', { title: "Aarav's 7th birthday", headline: 'Happy Birthday Aarav', subline: 'Seven today' });
assert.equal(r.state.show?.title, "Aarav's 7th birthday");
assert.ok(speakable(r.text), `speakable: ${r.text}`);
step(`start_show: "${r.text}"`);

r = await call('start_countdown', { label: 'Candles', seconds: 60 });
assert.equal(r.state.show?.scene.kind, 'countdown');
assert.ok(r.state.remainingMs > 59_000 && r.state.remainingMs <= 60_000);
assert.ok(speakable(r.text), `speakable: ${r.text}`);
step(`start_countdown: "${r.text}"`);

await sleep(1500);
r = await call('control_show', { action: 'pause' });
const frozen = r.state.remainingMs;
await sleep(1200);
r = await call('get_stage_state');
assert.equal(r.state.remainingMs, frozen, 'the clock is frozen while paused');
r = await call('control_show', { action: 'resume' });
await sleep(1000);
r = await call('get_stage_state');
assert.ok(Math.abs(frozen - r.state.remainingMs - 1000) < 150, `after 1 s of running, 1 s has gone (got ${frozen - r.state.remainingMs} ms)`);
step('pause freezes the clock; resume loses nothing');

r = await call('add_cue', { label: 'cake time', headline: 'Make a wish', inSeconds: 2 });
const cueAt = r.state.show!.cues.at(-1)!.atMs!;
assert.ok(speakable(r.text), `speakable: ${r.text}`);
await sleep(2400);
r = await call('get_stage_state');
assert.equal(r.state.show?.scene.kind, 'title');
assert.equal(r.state.show?.sceneStartedAtMs, cueAt, 'the cue started at its scheduled time, not when we looked');
step('a timed cue fires by itself at its scheduled time');

r = await call('fire_cue', { label: 'fireworks' });
assert.ok(r.isError && r.text.includes('cake time'), 'an unknown cue returns an error that lists the real ones');
step(`unknown cue returns an error result: "${r.text}"`);

const evil = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: 'https://evil.example' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
assert.equal(evil.status, 403);
step('a request from a foreign Origin is refused with 403');

await call('control_show', { action: 'end' });
r = await call('control_show', { action: 'pause' });
assert.ok(r.isError, 'controlling an empty stage is an error, not silence');
step('an empty stage answers with an error result, never with nothing');
await client.close();

const modern = new Client({ name: 'smoke-modern', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
await modern.connect(new StreamableHTTPClientTransport(url));
step(`a client that negotiates gets protocol ${modern.getNegotiatedProtocolVersion()} from the same endpoint`);
await modern.close();
console.log('\nAll smoke checks passed.');
