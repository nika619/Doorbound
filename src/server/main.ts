import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { resolve, stageState, type Show } from '../core/show.ts';
import { buildServer, type Store } from './mcp.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT ?? 3939);
// 127.0.0.1 by default. Set HOST=0.0.0.0 to let a TV on the same network open /stage.
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA = join(root, 'data', 'show.json');

// shortcut: one JSON file for one household; move to SQLite when shows need history or more than one home.
let live: Show | null = null;
try {
  live = JSON.parse(readFileSync(DATA, 'utf8'));
} catch {
  /* first run: empty stage */
}
const store: Store = {
  get(nowMs) {
    if (!live) return null;
    const upToDate = resolve(live, nowMs);
    if (upToDate !== live) this.set(upToDate);
    return live;
  },
  set(show) {
    live = show;
    mkdirSync(dirname(DATA), { recursive: true });
    writeFileSync(DATA, JSON.stringify(show));
  },
};

const page = (name: string) => readFileSync(join(root, 'dist', name), 'utf8');
const mcp = toNodeHandler(createMcpHandler(() => buildServer(store, () => page('stage.html'))));
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/mcp') {
    // The MCP endpoint only answers local callers; the spec requires Origin checking on Streamable HTTP.
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    void mcp(req, res);
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  if (path === '/api/state') {
    const now = Date.now();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(stageState(store.get(now), now)));
    return;
  }
  const file = path === '/stage' ? 'stage.html' : path === '/' ? 'host.html' : null;
  if (!file) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(file));
  } catch {
    res.writeHead(500).end('Run "npm run build:view" first.');
  }
}).listen(PORT, HOST, () => {
  console.log(`Marquee: MCP at http://${HOST}:${PORT}/mcp, simulator at http://${HOST}:${PORT}/, stage at http://${HOST}:${PORT}/stage`);
});
