// Doorbound server: the MCP endpoint for Alexa+, the board for a screen, and (on this machine only) the simulator.
// Configuration is validated at start; an unsafe combination refuses to start rather than running open.

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import Anthropic from '@anthropic-ai/sdk';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { household as demoHousehold, learnedHistory } from '../core/fixtures.ts';
import { Audit } from './audit.ts';
import { baseHeaders, bearer, BodyTooLarge, clientOf, isLoopback, openOnce, pageCsp, RateLimiter, readBody, tokenMatches, type PageHashes } from './guard.ts';
import { consentPage, keyPage, linkHeaders, page } from './linkpage.ts';
import { accessOf, refreshOf, hookHousehold, hookKey, authorizationServerMetadata, authorizeRequest, formOk, formToken, householdOf, issueCode, issueToken, linking, newHouseholdKey, protectedResourceMetadata, redirectWith, screenHousehold, screenKey, type OAuthConfig } from './oauth.ts';
import { RETENTION_DAYS, sweep } from './retention.ts';
import { Store } from './store.ts';
import { boardOf, buildServer, endDeparture, findPerson, finishStep, type Ctx } from './tools.ts';
import { MODEL, ownTools, understand, type Heard, type Tool } from './understand.ts';
import { isZone } from '../core/zone.ts';

// From source (src/server/) the project is two levels up; the bundle (dist/server.mjs) sits beside the manifest.
const here = dirname(fileURLToPath(import.meta.url));
const root = existsSync(join(here, 'manifest.json')) ? join(here, '..') : join(here, '..', '..');

// ---------- configuration ----------
const env = process.env;
// This machine's own secrets (an Anthropic key for the simulator's model) go in .env, which git and the image ignore.
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const fail = (msg: string): never => {
  console.error(`Doorbound will not start: ${msg}`);
  process.exit(1);
};
const csv = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(env.PORT ?? 3939);
const HOST = env.HOST ?? '127.0.0.1';
const LOCAL = isLoopback(HOST);
// An empty variable (as compose passes for an unset one) means not set.
const AUTH_TOKEN = env.AUTH_TOKEN || undefined;
const SCREEN_KEY = env.SCREEN_KEY || undefined;
const TRUST_PROXY = env.TRUST_PROXY === '1';
const ALLOWED_HOSTS = csv(env.ALLOWED_HOSTS);
const ALLOWED_ORIGINS = csv(env.ALLOWED_ORIGINS);
const DEMO_SPEED = Number(env.DEMO_SPEED ?? 1);
// Alexa+ signs in with OAuth client credentials (oauth.ts): all three, or none.
const OAUTH: OAuthConfig | undefined =
  env.OAUTH_CLIENT_ID || env.OAUTH_CLIENT_SECRET
    ? { clientId: env.OAUTH_CLIENT_ID ?? '', clientSecret: env.OAUTH_CLIENT_SECRET ?? '', signingKey: env.OAUTH_SIGNING_KEY ?? '', publicUrl: (env.PUBLIC_URL ?? '').replace(/\/$/, ''), redirectUris: csv(env.OAUTH_REDIRECT_URIS) }
    : undefined;
if (OAUTH) {
  if (!OAUTH.clientId || OAUTH.clientSecret.length < 32) fail('OAUTH_CLIENT_ID, an OAUTH_CLIENT_SECRET of at least 32 characters and PUBLIC_URL go together.');
  // Whoever holds the client secret (Amazon does) must not be able to mint a household's token: a separate key signs.
  if (OAUTH.signingKey.length < 32 || OAUTH.signingKey === OAUTH.clientSecret) fail('set OAUTH_SIGNING_KEY: 32 or more random characters, not the client secret, known only to this server.');
  const u = URL.canParse(OAUTH.publicUrl) ? new URL(OAUTH.publicUrl) : null;
  if (!u || u.pathname !== '/' || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))))
    fail('PUBLIC_URL must be the https origin clients use, for example https://doorbound.example.com.');
  for (const uri of OAUTH.redirectUris ?? []) {
    const r = URL.canParse(uri) ? new URL(uri) : null;
    if (!r || r.hash || (r.protocol !== 'https:' && !(r.protocol === 'http:' && isLoopback(r.hostname)))) fail(`OAUTH_REDIRECT_URIS: ${uri} is not an https URL.`);
  }
}
if (env.OAUTH_REDIRECT_URIS && !OAUTH) fail('OAUTH_REDIRECT_URIS needs the OAUTH_ settings too.');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail('PORT must be 1 to 65535.');
if (AUTH_TOKEN !== undefined && AUTH_TOKEN.length < 32) fail('AUTH_TOKEN must be at least 32 characters.');
if (SCREEN_KEY !== undefined && SCREEN_KEY.length < 16) fail('SCREEN_KEY must be at least 16 characters.');
// Listening on loopback behind a tunnel is public all the same: an outside name in ALLOWED_HOSTS says so.
const PUBLIC = !LOCAL || ALLOWED_HOSTS.some((h) => !isLoopback(h));
if (PUBLIC && !AUTH_TOKEN && !OAUTH) fail(`${LOCAL ? `ALLOWED_HOSTS=${ALLOWED_HOSTS.join(',')}` : `HOST=${HOST}`} reaches beyond this machine; set AUTH_TOKEN (or the OAUTH_ settings) first.`);
if (!LOCAL && !ALLOWED_HOSTS.length) fail('set ALLOWED_HOSTS to the host names clients will use.');
if (!(DEMO_SPEED >= 1 && DEMO_SPEED <= 60)) fail('DEMO_SPEED must be between 1 and 60.');

// ---------- state ----------
const dataDir = env.DATA_DIR ?? join(root, 'data');
// The server's own household: what AUTH_TOKEN, SCREEN_KEY and, on a single-household server, Alexa+ reach.
const store = await Store.open(dataDir);
if (env.DEMO_SEED === '1') {
  // Every start is the same morning, so a recorded demo can be replayed. (Playing it teaches the history too.)
  store.household = demoHousehold;
  store.history = learnedHistory();
  store.departure = null;
  await store.save();
}
const audit = new Audit(dataDir);
// Linked households (account linking): one folder each, named by the fingerprint of the household's key.
// One Store per household, ever (openOnce): up to a thousand kept, none dropped while in use.
const households = openOnce((id) => Store.open(join(dataDir, 'households', id)), 1000, 60_000);
const householdStore = households.get;
const householdExists = (id: string) => households.has(id) || existsSync(join(dataDir, 'households', id, 'household.json'));
// Households nobody has used for RETENTION days are deleted: checked at start and once a day.
const retention = Number(env.HOUSEHOLD_RETENTION_DAYS ?? RETENTION_DAYS);
if (!(Number.isInteger(retention) && retention >= 30 && retention <= 3650)) fail('HOUSEHOLD_RETENTION_DAYS must be a whole number of days from 30 to 3650.');
const forgetIdle = async () => {
  for (const id of await sweep(join(dataDir, 'households'), Date.now(), retention)) households.delete(id);
};
void forgetIdle();
setInterval(forgetIdle, 86_400_000).unref();
const t0 = Date.now();
// The demo clock is an explicit, labelled option for recording a morning in under two minutes.
const now = DEMO_SPEED === 1 ? Date.now : () => t0 + (Date.now() - t0) * DEMO_SPEED;
const publicBase = OAUTH?.publicUrl ?? `http://localhost:${PORT}`;
/** Everything a request's tools see: its household's store, and that household's TV link if there is one. */
function ctxFor(s: Store, client: string, household: string | null): Ctx {
  // On a shared server, every audit line says which household it was (its fingerprint, never its key).
  const log = household ? { record: (e: Parameters<Audit['record']>[0]) => audit.record({ ...e, household }) } : audit;
  return {
    store: s,
    audit: log,
    client,
    boardHtml: () => pages.board.html,
    now,
    clockRate: DEMO_SPEED,
    linked: !!household,
    // Read when asked, so a link replaced during this request is the new one.
    get screenLink() {
      return household && OAUTH ? `${publicBase}/board#k=${screenKey(OAUTH, household, s.keyGen)}` : SCREEN_KEY ? `${publicBase}/board#k=${SCREEN_KEY}` : undefined;
    },
    get doorLink() {
      return household && OAUTH ? `${publicBase}/hooks/left?k=${hookKey(OAUTH, household, s.keyGen)}` : undefined;
    },
  };
}
const requestCtx = new AsyncLocalStorage<Ctx>();
/** The household a TV or door key opens, while its generation is current: a forgotten household's, or a replaced link, opens nothing. */
async function current(k: { household: string; gen: number } | null): Promise<string | null> {
  return k && (await householdStore(k.household)).keyGen === k.gen ? k.household : null;
}

// Pages are built once (npm run build) and held in memory: serving is a buffer write.
type Page = { html: string; hashes: PageHashes };
const manifest = (() => {
  try {
    return JSON.parse(readFileSync(join(root, 'dist', 'manifest.json'), 'utf8')) as Record<string, PageHashes>;
  } catch {
    return fail('run "npm run build" first.');
  }
})();
const load = (name: string): Page | null => (manifest[name] ? { html: readFileSync(join(root, 'dist', `${name}.html`), 'utf8'), hashes: manifest[name] } : null);
const pages = { board: load('board') ?? fail('the board page is missing from the build.'), sim: load('sim'), site: load('site') };

// ---------- guards ----------
const validateHost = !ALLOWED_HOSTS.length ? localhostHostValidation() : hostHeaderValidation(LOCAL ? [...ALLOWED_HOSTS, 'localhost', '127.0.0.1', '[::1]'] : ALLOWED_HOSTS);
const validateOrigin = LOCAL ? localhostOriginValidation() : originValidation(ALLOWED_ORIGINS);
const limits = { mcp: new RateLimiter(20, 40), board: new RateLimiter(5, 10), page: new RateLimiter(5, 20), link: new RateLimiter(1, 5),
  // Every household's token requests come from Alexa+'s few servers: plenty for them, and only failed client
  // logins count against the strict limit that stops guessing.
  token: new RateLimiter(50, 200), tokenFail: new RateLimiter(1, 5) };
const mcp = toNodeHandler(createMcpHandler(() => buildServer(requestCtx.getStore()!)));
const MAX_BODY = 64 * 1024;

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers }).end(body);
}
/**
 * A POST that changes something must say it is JSON. A page on another site cannot send that without asking
 * first (a CORS preflight), which this server never grants: no cross-site request can reach these routes.
 */
function notJson(req: IncomingMessage, res: ServerResponse): boolean {
  const ok = /^application\/json\b/i.test(req.headers['content-type'] ?? '');
  if (!ok) send(res, 415, 'Send JSON.');
  return !ok;
}
function limited(res: ServerResponse, limiter: RateLimiter, client: string): boolean {
  const wait = limiter.take(client, Date.now());
  if (wait) send(res, 429, 'Too many requests.', { 'Retry-After': String(wait) });
  return wait > 0;
}

async function mcpRoute(req: IncomingMessage, res: ServerResponse, client: string) {
  if (req.method !== 'POST') return send(res, 405, 'Method not allowed.', { Allow: 'POST' });
  if (!validateOrigin(req, res)) return; // answers 403 itself; the Host was checked for every route
  // Whose household this request is for: a linked household's token names it; AUTH_TOKEN, and Alexa's own
  // service token on a single-household server, mean the server's own; Alexa's service token on a linking
  // server means nobody's (null): it may list tools, never run one.
  let household: string | null = null;
  let issued = Infinity;
  let own = !AUTH_TOKEN && !OAUTH;
  if (AUTH_TOKEN || OAUTH) {
    const presented = bearer(req);
    const access = OAUTH ? accessOf(OAUTH, presented, Date.now() / 1000) : null;
    own = !!AUTH_TOKEN && tokenMatches(presented, AUTH_TOKEN);
    if (!own && !access) return send(res, 401, 'Unauthorized.', { 'WWW-Authenticate': OAUTH ? `Bearer resource_metadata="${OAUTH.publicUrl}/.well-known/oauth-protected-resource"` : 'Bearer' });
    if (!own) {
      household = access!.household ?? null;
      issued = access!.iat;
      own = !household && !linking(OAUTH!);
    }
  }
  // Alexa+ calls every household from a few of Amazon's addresses: a linked household gets its own rate.
  if (limited(res, limits.mcp, household ? `household:${household}` : client)) return;
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'));
  } catch (e) {
    return send(res, e instanceof BodyTooLarge ? 413 : 400, e instanceof BodyTooLarge ? 'Request too large.' : 'Invalid JSON.');
  }
  if (!own && !household) {
    const msg = body as { method?: string; id?: unknown };
    if (Array.isArray(body)) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported.' } });
    if (msg?.method === 'tools/call')
      return json(res, 200, { jsonrpc: '2.0', id: msg.id ?? null, result: { content: [{ type: 'text', text: 'Link Doorbound to your household first: in the Alexa app, open Doorbound and choose Link account.' }], isError: true } });
  }
  const s = household ? await householdStore(household) : store;
  // A forgotten household's sign-ins stop working: Alexa will ask to link again.
  if (household && issued <= s.revokedBefore) return send(res, 401, 'Unauthorized.', { 'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${OAUTH!.publicUrl}/.well-known/oauth-protected-resource"` });
  await requestCtx.run(ctxFor(s, client, household), () => mcp(req, res, body));
}

async function boardRoute(req: IncomingMessage, res: ServerResponse, url: URL, client: string) {
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed.', { Allow: 'GET' });
  // A screen beyond this machine must present the screen key (or the full token); a linked household's TV, its own key.
  // A key that is presented must be right even here: a forgotten household's TV goes blank, not onto this machine's.
  const key = req.headers['x-screen-key'];
  const presented = typeof key === 'string' ? key : bearer(req);
  const household = await current(OAUTH && presented ? screenHousehold(OAUTH, presented) : null);
  if (!household && (PUBLIC || SCREEN_KEY || typeof key === 'string')) {
    const ok = (SCREEN_KEY && tokenMatches(presented, SCREEN_KEY)) || (AUTH_TOKEN && tokenMatches(presented, AUTH_TOKEN));
    if (!ok) return send(res, 401, 'Unauthorized.');
  }
  if (limited(res, limits.board, client)) return;
  const meta = { 'X-Server-Now': String(Math.round(now())), 'X-Clock-Rate': String(DEMO_SPEED), 'Cache-Control': 'no-store' };
  // Polled about once a second: when nothing changed, answer with no body at all.
  const s = household ? await householdStore(household) : store;
  if (Number(url.searchParams.get('since')) === s.rev) return res.writeHead(204, meta).end();
  res.writeHead(200, { ...meta, 'Content-Type': 'application/json' }).end(JSON.stringify(boardOf(ctxFor(s, client, household))));
}

function pageRoute(req: IncomingMessage, res: ServerResponse, page: Page, client: string, microphone = false) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });
  if (limited(res, limits.page, client)) return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...pageCsp(page.hashes, { microphone }) }).end(req.method === 'HEAD' ? undefined : page.html);
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  send(res, status, JSON.stringify(body), { 'Content-Type': 'application/json', ...headers });

/** Account linking: Alexa+ opens this in the Alexa app; the person starts a household or joins one with its key. */
async function authorizeRoute(req: IncomingMessage, res: ServerResponse, url: URL, client: string) {
  const o = OAUTH!;
  const html = (status: number, body: string) => res.writeHead(status, linkHeaders(o.redirectUris!)).end(body);
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, 'Method not allowed.', { Allow: 'GET, POST' });
  if (limited(res, req.method === 'POST' ? limits.link : limits.page, client)) return;
  let q = url.searchParams;
  if (req.method === 'POST') {
    if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) return html(400, page('Something went wrong', '<p>That form could not be read.</p>'));
    try {
      q = new URLSearchParams((await readBody(req, 8 * 1024)).toString('utf8'));
    } catch {
      return html(400, page('Something went wrong', '<p>That form could not be read.</p>'));
    }
  }
  const r = authorizeRequest(o, q);
  if ('error' in r) {
    // Only a registered redirect URI is ever redirected to; anything else is shown here.
    if (r.redirectUri) return res.writeHead(302, { Location: redirectWith(r.redirectUri, { error: r.error, error_description: r.description, state: r.state ?? '' }), 'Cache-Control': 'no-store' }).end();
    return html(400, page("Can't link", `<h1>Can't link Doorbound</h1><p>${r.description} Start again from the Alexa app.</p>`));
  }
  const nowSec = Date.now() / 1000;
  if (req.method === 'GET') return html(200, consentPage(r, formToken(o, r, nowSec)));
  if (!formOk(o, r, q.get('t') ?? '', nowSec)) return html(400, page('Expired', '<h1>This page has expired</h1><p>Start linking again from the Alexa app.</p>'));
  if (q.get('action') === 'new') {
    const key = newHouseholdKey();
    const id = householdOf(key)!;
    const s = await householdStore(id);
    const tz = q.get('tz') ?? '';
    if (isZone(tz)) s.household = { ...s.household, timeZone: tz }; // the family's clock, from the linking page
    await s.save(); // so the key can be joined from another account at once
    audit.record({ tool: 'link_new_household', ok: true, client });
    return html(200, keyPage(key, redirectWith(r.redirectUri, { code: issueCode(o, r, id, nowSec), state: r.state })));
  }
  const id = householdOf(q.get('key') ?? '');
  const ok = !!id && householdExists(id);
  audit.record({ tool: 'link_household', ok, client });
  if (!ok) return html(200, consentPage(r, formToken(o, r, nowSec), "That key doesn't open a household. Check it, or start a new one."));
  res.writeHead(302, { Location: redirectWith(r.redirectUri, { code: issueCode(o, r, id!, nowSec), state: r.state }), 'Cache-Control': 'no-store' }).end();
}

/**
 * "We've left", from a door sensor, smart lock or home routine: a POST with the household's hook key (in the
 * query, since most of those can only call a URL; or as a Bearer) or, for the server's own household, AUTH_TOKEN.
 * Counted only from 15 minutes before leaving time, so taking the bins out at seven does not end the morning.
 */
async function hookRoute(req: IncomingMessage, res: ServerResponse, url: URL, client: string) {
  if (req.method !== 'POST') return send(res, 405, 'Method not allowed.', { Allow: 'POST' });
  if (limited(res, limits.page, client)) return;
  // In the URL for sensors that can only call one; in an X-Hook-Key header for those that can send one.
  const header = req.headers['x-hook-key'];
  const presented = url.searchParams.get('k') ?? (typeof header === 'string' ? header : bearer(req));
  const household = await current(OAUTH && presented ? hookHousehold(OAUTH, presented) : null);
  if (!household && !(AUTH_TOKEN && tokenMatches(presented ?? undefined, AUTH_TOKEN)) && (PUBLIC || AUTH_TOKEN || OAUTH)) return send(res, 401, 'Unauthorized.');
  const s = household ? await householdStore(household) : store;
  if (url.pathname === '/hooks/done') {
    // An NFC tag on the bathroom door, a smart button, a phone shortcut, a home automation: this person's
    // current step is done, exactly as if they had said so. No voice assistant needed.
    const ctx = ctxFor(s, client, household);
    const p = findPerson(ctx, url.searchParams.get('person') ?? '');
    if (!p) return json(res, 404, { said: 'Nobody by that name here.' });
    const r = finishStep(ctx, p);
    return json(res, r.error ? 409 : 200, { said: r.text });
  }
  const dep = s.departure;
  if (!dep) return json(res, 200, { left: false, reason: 'no departure running' });
  if (now() < dep.gateMs - 15 * 60_000) return json(res, 202, { left: false, reason: 'too early: before 15 minutes to leaving time' });
  const said = endDeparture(ctxFor(s, client, household), true, 'door_hook');
  json(res, 200, { left: true, said });
}

/**
 * A TV's remote: OK on a person's row marks their step done. Only with that screen's key (or AUTH_TOKEN, or
 * on this machine), and only that: the same as saying "Isha's done" to Alexa.
 */
/**
 * The simulator's Alexa, a real model: GET names it; POST turns what someone said into one tool call, chosen
 * from the add-on's own tool list. Only on this machine, and only with ANTHROPIC_API_KEY set.
 */
let brain: Promise<{ model: Anthropic; tools: Tool[] }> | undefined;
async function understandRoute(req: IncomingMessage, res: ServerResponse, client: string) {
  if (PUBLIC) return send(res, 404, 'Not found.');
  if (req.method === 'GET') return json(res, 200, { model: env.ANTHROPIC_API_KEY ? MODEL : null });
  if (!env.ANTHROPIC_API_KEY) return send(res, 404, 'Not found.');
  if (req.method !== 'POST') return send(res, 405, 'Method not allowed.', { Allow: 'GET, POST' });
  if (notJson(req, res) || limited(res, limits.board, client)) return;
  let h: Heard;
  try {
    h = JSON.parse((await readBody(req, 4096)).toString('utf8')) as Heard;
  } catch {
    return send(res, 400, 'Invalid JSON.');
  }
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
  const ok = str(h.text, 300) && h.text.trim() && str(h.clock, 12) && (h.who === null || str(h.who, 40)) && (h.asked === undefined || str(h.asked, 600)) && Array.isArray(h.people) && h.people.length <= 12 && h.people.every((p) => str(p, 40));
  if (!ok) return send(res, 400, 'Bad request.');
  brain ??= ownTools(ctxFor(store, client, null)).then((tools) => ({ model: new Anthropic(), tools }));
  try {
    const { model, tools } = await brain;
    json(res, 200, { ...(await understand(model, tools, { text: h.text, who: h.who, people: h.people, clock: h.clock, asked: h.asked })).understood, model: MODEL });
  } catch (e) {
    // The simulator falls back to its phrase list for this one; the reason shows in its MCP log.
    json(res, 502, { error: e instanceof Anthropic.APIError ? `${e.status ?? ''} ${e.message}`.trim() : (e as Error).message });
  }
}

/**
 * Alexa's voice in the simulator: ElevenLabs, from this machine only and only with ELEVENLABS_API_KEY in .env.
 * GET names the voice; POST says one reply and returns the MP3. The key never leaves the server.
 */
const VOICE = { name: 'Sarah', id: 'EXAVITQu4vr4xnSDxMaL', model: 'eleven_v4_turbo' }; // until Mayank picks from voice-audition/
async function voiceRoute(req: IncomingMessage, res: ServerResponse, client: string) {
  if (PUBLIC) return send(res, 404, 'Not found.');
  if (req.method === 'GET') return json(res, 200, { voice: env.ELEVENLABS_API_KEY ? VOICE.name : null });
  if (!env.ELEVENLABS_API_KEY) return send(res, 404, 'Not found.');
  if (req.method !== 'POST') return send(res, 405, 'Method not allowed.', { Allow: 'GET, POST' });
  if (notJson(req, res) || limited(res, limits.board, client)) return;
  let text: unknown;
  try {
    text = (JSON.parse((await readBody(req, 2048)).toString('utf8')) as { text?: unknown }).text;
  } catch {
    return send(res, 400, 'Invalid JSON.');
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 600) return send(res, 400, 'Bad request.');
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE.id}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: VOICE.model }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return json(res, 502, { error: `ElevenLabs ${r.status}` });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }).end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    json(res, 502, { error: (e as Error).message });
  }
}

async function doneRoute(req: IncomingMessage, res: ServerResponse, client: string) {
  if (req.method !== 'POST') return send(res, 405, 'Method not allowed.', { Allow: 'POST' });
  if (notJson(req, res)) return;
  const key = req.headers['x-screen-key'];
  const presented = typeof key === 'string' ? key : bearer(req);
  const household = await current(OAUTH && presented ? screenHousehold(OAUTH, presented) : null);
  if (!household && (PUBLIC || SCREEN_KEY || typeof key === 'string') && !((SCREEN_KEY && tokenMatches(presented, SCREEN_KEY)) || (AUTH_TOKEN && tokenMatches(presented, AUTH_TOKEN)))) return send(res, 401, 'Unauthorized.');
  if (limited(res, limits.board, client)) return;
  let person: unknown;
  try {
    person = (JSON.parse((await readBody(req, 1024)).toString('utf8')) as { person?: unknown }).person;
  } catch {
    return send(res, 400, 'Invalid JSON.');
  }
  const s = household ? await householdStore(household) : store;
  const p = typeof person === 'string' ? s.household.people.find((x) => x.id === person) : undefined;
  if (!p) return json(res, 404, { said: 'Nobody by that name here.' });
  const r = finishStep(ctxFor(s, client, household), p);
  json(res, r.error ? 409 : 200, { said: r.text });
}

async function tokenRoute(req: IncomingMessage, res: ServerResponse, url: URL, client: string) {
  if (req.method !== 'POST') return send(res, 405, 'Method not allowed.', { Allow: 'POST' });
  if (limited(res, limits.token, client)) return;
  const wait = limits.tokenFail.peek(client, Date.now());
  if (wait) return send(res, 429, 'Too many failed sign-ins.', { 'Retry-After': String(wait) });
  if (url.search) return json(res, 400, { error: 'invalid_request', error_description: 'Nothing goes in the query string, credentials least of all.' });
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) return json(res, 400, { error: 'invalid_request', error_description: 'Send a form body (application/x-www-form-urlencoded).' });
  let form: URLSearchParams;
  try {
    form = new URLSearchParams((await readBody(req, 8 * 1024)).toString('utf8'));
  } catch (e) {
    return json(res, e instanceof BodyTooLarge ? 413 : 400, { error: 'invalid_request', error_description: 'Unreadable body.' });
  }
  if (form.get('grant_type') === 'refresh_token') {
    const rt = refreshOf(OAUTH!, form.get('refresh_token') ?? undefined, Date.now() / 1000);
    if (rt && rt.iat <= (await householdStore(rt.household)).revokedBefore)
      return json(res, 400, { error: 'invalid_grant', error_description: 'This household was forgotten. Link Doorbound again.' }, { 'Cache-Control': 'no-store' });
  }
  const r = issueToken(OAUTH!, form, req.headers.authorization, Date.now() / 1000);
  if (r.status === 401) limits.tokenFail.take(client, Date.now());
  audit.record({ tool: 'oauth_token', ok: r.status === 200, client });
  json(res, r.status, r.body, { Pragma: 'no-cache', ...r.headers });
}

const server = createServer(async (req, res) => {
  baseHeaders(res, TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
  const client = clientOf(req, TRUST_PROXY);
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Every route checks the Host: a web page whose name resolves to this machine (DNS rebinding) is refused.
    // /healthz is exempt: health checks call it by address, and it says nothing.
    if (url.pathname !== '/healthz' && !validateHost(req, res)) return;
    switch (url.pathname) {
      case '/mcp':
        return await mcpRoute(req, res, client);
      case '/api/board':
        return await boardRoute(req, res, url, client);
      case '/board':
        return pageRoute(req, res, pages.board, client);
      case '/':
        // The story page: no data, no tools, the board replaying in the browser. Safe to serve anywhere.
        return pages.site ? pageRoute(req, res, pages.site, client) : send(res, 404, 'Not found.');
      case '/sim/voice':
        return await voiceRoute(req, res, client);
      case '/sim/understand':
        return await understandRoute(req, res, client);
      case '/sim':
        // The simulator is a development tool: never served beyond this machine.
        return !PUBLIC && pages.sim ? pageRoute(req, res, pages.sim, client, true) : send(res, 404, 'Not found.');
      case '/healthz':
        return send(res, 200, 'ok');
      case '/.well-known/oauth-authorization-server':
        return OAUTH ? json(res, 200, authorizationServerMetadata(OAUTH)) : send(res, 404, 'Not found.');
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        return OAUTH ? json(res, 200, protectedResourceMetadata(OAUTH)) : send(res, 404, 'Not found.');
      case '/api/done':
        return await doneRoute(req, res, client);
      case '/hooks/left':
      case '/hooks/done':
        return await hookRoute(req, res, url, client);
      case '/oauth/authorize':
        return OAUTH && linking(OAUTH) ? await authorizeRoute(req, res, url, client) : send(res, 404, 'Not found.');
      case '/oauth/token':
        return OAUTH ? await tokenRoute(req, res, url, client) : send(res, 404, 'Not found.');
      default:
        return send(res, 404, 'Not found.');
    }
  } catch (e) {
    console.error(`${req.method} ${req.url}:`, (e as Error).message); // no stack or detail to the client
    if (!res.headersSent) send(res, 500, 'Something went wrong.');
  }
});
// Slow or oversized requests cannot hold the server.
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 64;
server.listen(PORT, HOST, () => {
  const base = `http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`;
  console.log(`Doorbound: MCP ${base}/mcp · story ${base}/ · board ${base}/board${!PUBLIC ? ` · simulator ${base}/sim` : ''}${DEMO_SPEED > 1 ? ` · demo clock ×${DEMO_SPEED}` : ''}`);
});

async function shutdown() {
  server.close();
  await store.save();
  await audit.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
