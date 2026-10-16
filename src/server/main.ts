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
import { authorizationServerMetadata, issueToken, protectedResourceMetadata, verifyAccessToken, type OAuthConfig } from './oauth.ts';
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
  env.OAUTH_CLIENT_ID || env.OAUTH_CLIENT_SECRET ? { clientId: env.OAUTH_CLIENT_ID ?? '', clientSecret: env.OAUTH_CLIENT_SECRET ?? '', publicUrl: (env.PUBLIC_URL ?? '').replace(/\/$/, '') } : undefined;
if (OAUTH) {
  if (!OAUTH.clientId || OAUTH.clientSecret.length < 32) fail('OAUTH_CLIENT_ID, an OAUTH_CLIENT_SECRET of at least 32 characters and PUBLIC_URL go together.');
  const u = URL.canParse(OAUTH.publicUrl) ? new URL(OAUTH.publicUrl) : null;
  if (!u || u.pathname !== '/' || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))))
    fail('PUBLIC_URL must be the https origin clients use, for example https://doorbound.example.com.');
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail('PORT must be 1 to 65535.');
if (AUTH_TOKEN !== undefined && AUTH_TOKEN.length < 32) fail('AUTH_TOKEN must be at least 32 characters.');
if (SCREEN_KEY !== undefined && SCREEN_KEY.length < 16) fail('SCREEN_KEY must be at least 16 characters.');
// Listening on loopback behind a tunnel is public all the same: an outside name in ALLOWED_HOSTS says so.
const PUBLIC = !LOCAL || ALLOWED_HOSTS.some((h) => !isLoopback(h));
if (PUBLIC && !AUTH_TOKEN && !OAUTH) fail(`${LOCAL ? `ALLOWED_HOSTS=${ALLOWED_HOSTS.join(',')}` : `HOST=${HOST}`} reaches beyond this machine; set AUTH_TOKEN (or the OAUTH_ settings) first.`);
if (!LOCAL && !ALLOWED_HOSTS.length) fail('set ALLOWED_HOSTS to the host names clients will use.');
if (!(DEMO_SPEED >= 1 && DEMO_SPEED <= 60)) fail('DEMO_SPEED must be between 1 and 60.');

// ---------- state ----------
const store = await Store.open(env.DATA_DIR ?? join(root, 'data'));
if (env.DEMO_SEED === '1') {
  // Every start is the same morning, so a recorded demo can be replayed. (Playing it teaches the history too.)
  store.household = demoHousehold;
  store.history = learnedHistory();
  store.departure = null;
  await store.save();
}
const audit = new Audit(env.DATA_DIR ?? join(root, 'data'));
const t0 = Date.now();
// The demo clock is an explicit, labelled option for recording a morning in under two minutes.
const now = DEMO_SPEED === 1 ? Date.now : () => t0 + (Date.now() - t0) * DEMO_SPEED;
const requestClient = new AsyncLocalStorage<string>();
const ctx: Ctx = {
  store,
  audit,
  get client() {
    return requestClient.getStore() ?? 'unknown';
  },
  boardHtml: () => pages.board.html,
  now,
  clockRate: DEMO_SPEED,
};

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
const limits = { mcp: new RateLimiter(20, 40), board: new RateLimiter(5, 10), page: new RateLimiter(5, 20), token: new RateLimiter(1, 5) };
const mcp = toNodeHandler(createMcpHandler(() => buildServer(ctx)));
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
  if (AUTH_TOKEN || OAUTH) {
    const presented = bearer(req);
    const ok = (AUTH_TOKEN && tokenMatches(presented, AUTH_TOKEN)) || (OAUTH && verifyAccessToken(OAUTH, presented, Date.now() / 1000));
    if (!ok) return send(res, 401, 'Unauthorized.', { 'WWW-Authenticate': OAUTH ? `Bearer resource_metadata="${OAUTH.publicUrl}/.well-known/oauth-protected-resource"` : 'Bearer' });
  }
  if (limited(res, limits.mcp, client)) return;
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'));
  } catch (e) {
    return send(res, e instanceof BodyTooLarge ? 413 : 400, e instanceof BodyTooLarge ? 'Request too large.' : 'Invalid JSON.');
  }
  await requestClient.run(client, () => mcp(req, res, body));
}

function boardRoute(req: IncomingMessage, res: ServerResponse, url: URL, client: string) {
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed.', { Allow: 'GET' });
  // A screen beyond this machine must present the screen key (or the full token).
  const key = req.headers['x-screen-key'];
  const presented = typeof key === 'string' ? key : bearer(req);
  if (PUBLIC || SCREEN_KEY) {
    const ok = (SCREEN_KEY && tokenMatches(presented, SCREEN_KEY)) || (AUTH_TOKEN && tokenMatches(presented, AUTH_TOKEN));
    if (!ok) return send(res, 401, 'Unauthorized.');
  }
  if (limited(res, limits.board, client)) return;
  const meta = { 'X-Server-Now': String(Math.round(now())), 'X-Clock-Rate': String(DEMO_SPEED), 'Cache-Control': 'no-store' };
  // Polled about once a second: when nothing changed, answer with no body at all.
  if (Number(url.searchParams.get('since')) === store.rev) return res.writeHead(204, meta).end();
  res.writeHead(200, { ...meta, 'Content-Type': 'application/json' }).end(JSON.stringify(boardOf(ctx)));
}

function pageRoute(req: IncomingMessage, res: ServerResponse, page: Page, client: string, microphone = false) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });
  if (limited(res, limits.page, client)) return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...pageCsp(page.hashes, { microphone }) }).end(req.method === 'HEAD' ? undefined : page.html);
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  send(res, status, JSON.stringify(body), { 'Content-Type': 'application/json', ...headers });

async function tokenRoute(req: IncomingMessage, res: ServerResponse, url: URL, client: string) {
  if (req.method !== 'POST') return send(res, 405, 'Method not allowed.', { Allow: 'POST' });
  if (limited(res, limits.token, client)) return;
  if (url.search) return json(res, 400, { error: 'invalid_request', error_description: 'Nothing goes in the query string, credentials least of all.' });
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] ?? '')) return json(res, 400, { error: 'invalid_request', error_description: 'Send a form body (application/x-www-form-urlencoded).' });
  let form: URLSearchParams;
  try {
    form = new URLSearchParams((await readBody(req, 8 * 1024)).toString('utf8'));
  } catch (e) {
    return json(res, e instanceof BodyTooLarge ? 413 : 400, { error: 'invalid_request', error_description: 'Unreadable body.' });
  }
  const r = issueToken(OAUTH!, form, req.headers.authorization, Date.now() / 1000);
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
        return boardRoute(req, res, url, client);
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
