// Conformance: our 2 KB view bridge against the official host-side AppBridge, with the real MCP server behind it.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Audit } from '../server/audit.ts';
import { Store } from '../server/store.ts';
import { buildServer } from '../server/tools.ts';
import { household } from '../core/fixtures.ts';
import { Bridge, type Port } from './bridge.ts';

/** Joins a host Transport to a view Port, as the iframe's postMessage would. */
function link(): { transport: Transport; port: Port } {
  let toView: (m: unknown) => void = () => {};
  const transport: Transport = {
    async start() {},
    async close() {},
    async send(message) {
      queueMicrotask(() => toView(structuredClone(message)));
    },
  };
  const port: Port = {
    post: (m) => queueMicrotask(() => transport.onmessage?.(structuredClone(m) as never)),
    listen: (fn) => {
      toView = fn;
    },
  };
  return { transport, port };
}

test('the board bridge completes the MCP Apps handshake and calls real tools through the official host bridge', async () => {
  const store = await Store.open(await mkdtemp(join(tmpdir(), 'bridge-')));
  store.household = household;
  const server = buildServer({ store, audit: new Audit(await mkdtemp(join(tmpdir(), 'audit-'))), client: 'test', boardHtml: () => '<html></html>', now: Date.now, clockRate: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'host', version: '1' });
  await client.connect(a);

  const host = new AppBridge(client, { name: 'test-host', version: '1' }, { serverTools: {}, logging: {} }, { hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], platform: 'web' } });
  const initialized = new Promise<void>((r) => (host.oninitialized = () => r()));
  const { transport, port } = link();
  await host.connect(transport);

  const view = new Bridge(port);
  await view.connect(['inline', 'fullscreen']);
  await initialized;
  assert.equal(view.hostContext.displayMode, 'inline', 'host context arrives with the handshake');

  // tools/call from the view reaches the real server through the host.
  const status = await view.callTool('departure_status', {});
  assert.equal(status.isError, true);
  assert.match(status.content![0].text!, /no departure running/i);

  // The host forwards a tool result to the view.
  const got = new Promise<unknown>((r) => (view.onToolResult = (res) => r(res.structuredContent)));
  await host.sendToolResult({ content: [{ type: 'text', text: 'hi' }], structuredContent: { rev: 7 } });
  assert.deepEqual(await got, { rev: 7 });

  // Context changes are merged.
  const ctxChanged = new Promise<void>((r) => (view.onContext = () => r()));
  await host.sendHostContextChange({ displayMode: 'fullscreen' });
  await ctxChanged;
  assert.equal(view.hostContext.displayMode, 'fullscreen');

  // Teardown is acknowledged, so the host never hangs.
  await host.teardownResource({});
  await client.close();
});
