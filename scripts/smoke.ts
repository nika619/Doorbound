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
assert.deepEqual(tools.map((t) => t.name).sort(), ['allow_change', 'change_departure', 'departure_status', 'door_link', 'end_departure', 'forget_household', 'get_board', 'how_accurate', 'learned_times', 'plan_tomorrow', 'ready_to_go', 'set_routine', 'start_departure', 'step_done', 'still_going', 'tv_link', 'undo_reroute']);
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
assert.ok(!r.isError && /^I don't have anyone called Zed\. Who was that\? /.test(r.text) && speakable(r.text), r.text);
step(`unknown person is a question naming who is on what, never silence: "${r.text}"`);

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
// The simulator's model: only on the server's own machine (404 beyond it), only with a key there, never on bad input.
const understand = await fetch(new URL('/sim/understand', base));
assert.ok(understand.status === 404 || (understand.status === 200 && 'model' in ((await understand.json()) as object)), `GET /sim/understand: ${understand.status}`);
assert.ok([400, 404].includes((await fetch(new URL('/sim/understand', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status));
// The same for Alexa's voice (ElevenLabs): never beyond this machine, never on bad input.
const voice = await fetch(new URL('/sim/voice', base));
assert.ok(voice.status === 404 || (voice.status === 200 && 'voice' in ((await voice.json()) as object)), `GET /sim/voice: ${voice.status}`);
assert.ok([400, 404].includes((await fetch(new URL('/sim/voice', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status));
step("the simulator's model and voice endpoints stay on this machine and refuse bad input");

// ---------- Alexa+ sign-in (OAuth client credentials), when the server is set up for it ----------
if (process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET) {
  const meta = (await (await fetch(new URL('/.well-known/oauth-authorization-server', base))).json()) as { token_endpoint: string; grant_types_supported: string[] };
  assert.deepEqual(meta.grant_types_supported, process.env.OAUTH_REDIRECT_URIS ? ['client_credentials', 'authorization_code', 'refresh_token'] : ['client_credentials']);
  const pr = (await (await fetch(new URL('/.well-known/oauth-protected-resource', base))).json()) as { resource: string };
  const basic = (secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(process.env.OAUTH_CLIENT_ID!)}:${encodeURIComponent(secret)}`).toString('base64')}`;
  const token = (secret: string) =>
    fetch(new URL(new URL(meta.token_endpoint).pathname, base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic(secret) },
      body: new URLSearchParams({ grant_type: 'client_credentials', resource: pr.resource }),
    });
  const r = await token(process.env.OAUTH_CLIENT_SECRET);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const { access_token, expires_in } = (await r.json()) as { access_token: string; expires_in: number };
  assert.ok(expires_in <= 3600);
  const alexa = new Client({ name: 'alexa-plus', version: '1.0.0' });
  await alexa.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } }));
  assert.ok((await alexa.listTools()).tools.length > 0);
  await alexa.close();
  step('OAuth: discovery, client credentials for a one-hour token, MCP calls with it');
  const wrong = await token('wrong');
  assert.equal(wrong.status, 401);
  assert.equal(((await wrong.json()) as { error: string }).error, 'invalid_client');
  const forged = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${access_token.slice(0, -4)}AAAA` }, body: '{}' });
  assert.equal(forged.status, 401);
  assert.match(forged.headers.get('www-authenticate') ?? '', /resource_metadata=/);
  step('OAuth: a wrong secret is invalid_client; a tampered token is a 401 that points at the metadata');

  // ---------- account linking: one server, many households ----------
  const redirect = process.env.OAUTH_REDIRECT_URIS?.split(',')[0];
  if (redirect) {
    const { createHash, randomBytes } = await import('node:crypto');
    const tokenUrl = new URL(new URL(meta.token_endpoint).pathname, base);
    const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const fields = (html: string) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))]));
    /** Link one Alexa account: start a new household, or join with a key. Returns its tools client and the key shown, if any. */
    const link = async (join?: string) => {
      const verifier = randomBytes(32).toString('base64url');
      const q = new URLSearchParams({ client_id: process.env.OAUTH_CLIENT_ID!, redirect_uri: redirect, response_type: 'code', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'xyz' });
      const consent = await fetch(new URL(`/oauth/authorize?${q}`, base));
      assert.equal(consent.status, 200);
      assert.match(consent.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
      const post = await fetch(new URL('/oauth/authorize', base), { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...fields(await consent.text()), action: join ? 'join' : 'new', key: join ?? '' }) });
      let back: URL;
      let key: string | undefined;
      if (join) back = new URL(post.headers.get('location')!);
      else {
        const html = await post.text();
        key = /<div class="k">([^<]+)<\/div>/.exec(html)![1];
        back = new URL(/<a class="b" href="([^"]+)"/.exec(html)![1].replace(/&#38;/g, '&'));
      }
      assert.equal(back.origin + back.pathname, redirect);
      assert.equal(back.searchParams.get('state'), 'xyz');
      const t = await fetch(tokenUrl, { method: 'POST', headers: { ...form, Authorization: basic(process.env.OAUTH_CLIENT_SECRET!) }, body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: redirect, code_verifier: verifier }) });
      assert.equal(t.status, 200);
      const { access_token: token, refresh_token } = (await t.json()) as { access_token: string; refresh_token: string };
      assert.ok(refresh_token);
      const c = new Client({ name: 'alexa-plus-linked', version: '1.0.0' });
      await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      await c.listTools();
      const say = async (name: string, args: Record<string, unknown> = {}) => ((await c.callTool({ name, arguments: args })) as { content: { text: string }[]; structuredContent?: { people: { name: string }[] } });
      return { key, say, close: () => c.close() };
    };
    const a = await link();
    assert.match(a.key!, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}-[0-9A-Z]$/);
    await a.say('set_routine', { person: 'Noor', steps: [{ name: 'Shower', minutes: 7 }] });
    const partner = await link(a.key);
    assert.deepEqual((await partner.say('learned_times')).structuredContent?.people.map((p) => p.name), ['Noor'], 'a second Alexa account with the key sees the same household');
    const b = await link();
    assert.deepEqual((await b.say('learned_times')).structuredContent?.people, [], 'another household sees nothing of it');
    const tv = (await a.say('tv_link')).content[0].text.match(/#k=(\S+)/)![1];
    const board = (await (await fetch(new URL('/api/board', base), { headers: { 'X-Screen-Key': tv } })).json()) as { people: { name: string }[] };
    assert.deepEqual(board.people.map((p) => p.name), ['Noor'], "a household's TV link shows that household");
    // A TV's remote: OK on a row marks that step done, with that TV's key and nothing else.
    await a.say('start_departure', { leaveAt: at(30) });
    const remote = await fetch(new URL('/api/done', base), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Screen-Key': tv }, body: JSON.stringify({ person: 'noor' }) });
    assert.equal(remote.status, 200);
    assert.match(((await remote.json()) as { said: string }).said, /^Shower done\./);
    assert.equal((await fetch(new URL('/api/done', base), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Screen-Key': `${tv.slice(0, -3)}xyz` }, body: '{"person":"noor"}' })).status, 401);
    // A door sensor says "we've left": not before 15 minutes to leaving time, then it ends the morning.
    const door = (await a.say('door_link')).content[0].text.match(/POST to (\S+) when/)![1];
    const hook = new URL(door);
    const early = await a.say('start_departure', { leaveAt: at(30) });
    assert.ok(!(early as { isError?: boolean }).isError);
    assert.equal((await fetch(new URL(`${hook.pathname}${hook.search}`, base), { method: 'POST' })).status, 202, 'too early: ignored');
    await a.say('change_departure', { leaveAt: at(10) });
    const left = (await (await fetch(new URL(`${hook.pathname}${hook.search}`, base), { method: 'POST' })).json()) as { left: boolean };
    assert.equal(left.left, true);
    assert.equal((await fetch(new URL('/hooks/left?k=k.0123456789abcdef0123456789abcdef.forged', base), { method: 'POST' })).status, 401);
    for (const x of [a, partner, b]) await x.close();
    step('a front-door hook ends the morning, not before 15 minutes to leaving time; a forged key is refused');
    step('account linking: a new household with its key, a second account joining it, another household kept apart, its own TV link');
    const svc = new Client({ name: 'alexa-plus-service', version: '1.0.0' });
    await svc.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } }));
    assert.ok((await svc.listTools()).tools.length > 0);
    const refused = (await svc.callTool({ name: 'departure_status', arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(refused.isError && /Link Doorbound/.test(refused.content[0].text), "Alexa's own token reaches no household's data");
    await svc.close();
    step("Alexa's service token lists the tools but runs none on a linking server");
  }
}

console.log('\nAll smoke checks passed.');
