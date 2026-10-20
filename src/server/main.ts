// Doorbound server: the MCP endpoint for Alexa+, the board for a screen, and (on this machine only) the simulator.
// Configuration is validated at start; an unsafe combination refuses to start rather than running open.

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { household as demoHousehold, learnedHistory } from '../core/fixtures.ts';
import { Audit } from './audit.ts';
import { baseHeaders, bearer, BodyTooLarge, clientOf, isLoopback, pageCsp, RateLimiter, readBody, tokenMatches, type PageHashes } from './guard.ts';
import { consentPage, keyPage, linkHeaders, page } from './linkpage.ts';
import { accessOf, authorizationServerMetadata, authorizeRequest, formOk, formToken, householdOf, issueCode, issueToken, linking, newHouseholdKey, protectedResourceMetadata, redirectWith, screenHousehold, screenKey, type OAuthConfig } from './oauth.ts';
import { Store } from './store.ts';
import { boardOf, buildServer, type Ctx } from './tools.ts';

// From source (src/server/) the project is two levels up; the bundle (dist/server.mjs) sits beside the manifest.
const here = dirname(fileURLToPath(import.meta.url));
const root = existsSync(join(here, 'manifest.json')) ? join(here, '..') : join(here, '..', '..');

// ---------- configuration ----------
const env = process.env;
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
    ? { clientId: env.OAUTH_CLIENT_ID ?? '', clientSecret: env.OAUTH_CLIENT_SECRET ?? '', publicUrl: (env.PUBLIC_URL ?? '').replace(/\/$/, ''), redirectUris: csv(env.OAUTH_REDIRECT_URIS) }
    : undefined;
if (OAUTH) {
  if (!OAUTH.clientId || OAUTH.clientSecret.length < 32) fail('OAUTH_CLIENT_ID, an OAUTH_CLIENT_SECRET of at least 32 characters and PUBLIC_URL go together.');
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
const households = new Map<string, Store>();
async function householdStore(id: string): Promise<Store> {
  let s = households.get(id);
  if (!s) {
    s = await Store.open(join(dataDir, 'households', id));
    // shortcut: forgets the first opened, not the least recently used; fine below a thousand active households
    if (households.size >= 1000) households.delete(households.keys().next().value!);
    households.set(id, s);
  }
  return s;
}
const householdExists = (id: string) => households.has(id) || existsSync(join(dataDir, 'households', id, 'household.json'));
const t0 = Date.now();
// The demo clock is an explicit, labelled option for recording a morning in under two minutes.
const now = DEMO_SPEED === 1 ? Date.now : () => t0 + (Date.now() - t0) * DEMO_SPEED;
const publicBase = OAUTH?.publicUrl ?? `http://localhost:${PORT}`;
/** Everything a request's tools see: its household's store, and that household's TV link if there is one. */
function ctxFor(s: Store, client: string, household: string | null): Ctx {
  const screenLink = household && OAUTH ? `${publicBase}/board#k=${screenKey(OAUTH, household)}` : SCREEN_KEY ? `${publicBase}/board#k=${SCREEN_KEY}` : undefined;
  // On a shared server, every audit line says which household it was (its fingerprint, never its key).
  const log = household ? { record: (e: Parameters<Audit['record']>[0]) => audit.record({ ...e, household }) } : audit;
  return { store: s, audit: log, client, boardHtml: () => pages.board.html, now, clockRate: DEMO_SPEED, screenLink };
}
const requestCtx = new AsyncLocalStorage<Ctx>();

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
function limited(res: ServerResponse, limiter: RateLimiter, client: string): boolean {
  const wait = limiter.take(client, Date.now());
  if (wait) send(res, 429, 'Too many requests.', { 'Retry-After': String(wait) });
  return wait > 0;
}

async function mcpRoute(req: IncomingMessage, res: ServerResponse, client: string) {
  if (req.method !== 'POST') return send(res, 405, 'Method not allowed.', { Allow: 'POST' });
  if (!validateHost(req, res) || !validateOrigin(req, res)) return; // the validators answer 403 themselves
  // Whose household this request is for: a linked household's token names it; AUTH_TOKEN, and Alexa's own
  // service token on a single-household server, mean the server's own; Alexa's service token on a linking
  // server means nobody's (null): it may list tools, never run one.
  let household: string | null = null;
  let own = !AUTH_TOKEN && !OAUTH;
  if (AUTH_TOKEN || OAUTH) {
    const presented = bearer(req);
    const access = OAUTH ? accessOf(OAUTH, presented, Date.now() / 1000) : null;
    own = !!AUTH_TOKEN && tokenMatches(presented, AUTH_TOKEN);
    if (!own && !access) return send(res, 401, 'Unauthorized.', { 'WWW-Authenticate': OAUTH ? `Bearer resource_metadata="${OAUTH.publicUrl}/.well-known/oauth-protected-resource"` : 'Bearer' });
    if (!own) {
      household = access!.household ?? null;
      own = !household && !linking(OAUTH!);
    }
  }
  if (limited(res, limits.mcp, client)) return;
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
  await requestCtx.run(ctxFor(s, client, household), () => mcp(req, res, body));
}

async function boardRoute(req: IncomingMessage, res: ServerResponse, url: URL, client: string) {
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed.', { Allow: 'GET' });
  // A screen beyond this machine must present the screen key (or the full token); a linked household's TV, its own key.
  const key = req.headers['x-screen-key'];
  const presented = typeof key === 'string' ? key : bearer(req);
  const household = OAUTH && presented ? screenHousehold(OAUTH, presented) : null;
  if (!household && (PUBLIC || SCREEN_KEY)) {
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
    await (await householdStore(id)).save(); // so the key can be joined from another account at once
    audit.record({ tool: 'link_new_household', ok: true, client });
    return html(200, keyPage(key, redirectWith(r.redirectUri, { code: issueCode(o, r, id, nowSec), state: r.state })));
  }
  const id = householdOf(q.get('key') ?? '');
  const ok = !!id && householdExists(id);
  audit.record({ tool: 'link_household', ok, client });
  if (!ok) return html(200, consentPage(r, formToken(o, r, nowSec), "That key doesn't open a household. Check it, or start a new one."));
  res.writeHead(302, { Location: redirectWith(r.redirectUri, { code: issueCode(o, r, id!, nowSec), state: r.state }), 'Cache-Control': 'no-store' }).end();
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
