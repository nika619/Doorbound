// Departures server: the MCP endpoint for Alexa+, the board for a screen, and (on this machine only) the simulator.
// Configuration is validated at start; an unsafe combination refuses to start rather than running open.

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostHeaderValidation, localhostHostValidation, localhostOriginValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { household as demoHousehold, learnedHistory } from '../core/fixtures.ts';
import { Audit } from './audit.ts';
import { baseHeaders, bearer, BodyTooLarge, clientOf, isLoopback, pageCsp, RateLimiter, readBody, tokenMatches, type PageHashes } from './guard.ts';
import { Store } from './store.ts';
import { boardOf, buildServer, type Ctx } from './tools.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------- configuration ----------
const env = process.env;
const fail = (msg: string): never => {
  console.error(`Departures will not start: ${msg}`);
  process.exit(1);
};
const csv = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(env.PORT ?? 3939);
const HOST = env.HOST ?? '127.0.0.1';
const LOCAL = isLoopback(HOST);
const AUTH_TOKEN = env.AUTH_TOKEN;
const SCREEN_KEY = env.SCREEN_KEY;
const TRUST_PROXY = env.TRUST_PROXY === '1';
const ALLOWED_HOSTS = csv(env.ALLOWED_HOSTS);
const ALLOWED_ORIGINS = csv(env.ALLOWED_ORIGINS);
const DEMO_SPEED = Number(env.DEMO_SPEED ?? 1);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail('PORT must be 1 to 65535.');
if (AUTH_TOKEN !== undefined && AUTH_TOKEN.length < 32) fail('AUTH_TOKEN must be at least 32 characters.');
if (SCREEN_KEY !== undefined && SCREEN_KEY.length < 16) fail('SCREEN_KEY must be at least 16 characters.');
if (!LOCAL && !AUTH_TOKEN) fail(`HOST=${HOST} reaches beyond this machine; set AUTH_TOKEN first.`);
if (!LOCAL && !ALLOWED_HOSTS.length) fail('set ALLOWED_HOSTS to the host names clients will use.');
if (!(DEMO_SPEED >= 1 && DEMO_SPEED <= 60)) fail('DEMO_SPEED must be between 1 and 60.');

// ---------- state ----------
const store = await Store.open(env.DATA_DIR ?? join(root, 'data'));
if (env.DEMO_SEED === '1' && !store.household.people.length) {
  store.household = demoHousehold;
  store.history = learnedHistory();
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
const load = (name: string): Page => ({ html: readFileSync(join(root, 'dist', `${name}.html`), 'utf8'), hashes: manifest[name] });
const pages = { board: load('board'), sim: load('sim') };

// ---------- guards ----------
const validateHost = LOCAL ? localhostHostValidation() : hostHeaderValidation(ALLOWED_HOSTS);
const validateOrigin = LOCAL ? localhostOriginValidation() : originValidation(ALLOWED_ORIGINS);
const limits = { mcp: new RateLimiter(20, 40), board: new RateLimiter(5, 10), page: new RateLimiter(5, 20) };
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
  if (AUTH_TOKEN && !tokenMatches(bearer(req), AUTH_TOKEN)) return send(res, 401, 'Unauthorized.', { 'WWW-Authenticate': 'Bearer' });
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
  if (!LOCAL || SCREEN_KEY) {
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
        // The simulator is a development tool: never served beyond this machine.
        return LOCAL ? pageRoute(req, res, pages.sim, client, true) : send(res, 404, 'Not found.');
      case '/healthz':
        return send(res, 200, 'ok');
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
  console.log(`Departures: MCP ${base}/mcp · board ${base}/board${LOCAL ? ` · simulator ${base}/` : ''}${DEMO_SPEED > 1 ? ` · demo clock ×${DEMO_SPEED}` : ''}`);
});

async function shutdown() {
  server.close();
  await store.save();
  await audit.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
