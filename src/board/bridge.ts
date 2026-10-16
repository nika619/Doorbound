// The MCP Apps messages the board needs (spec 2026-01-26), over postMessage.
// About 2 KB in place of the ~450 KB SDK bundle. Conformance is tested against the official
// host-side AppBridge (bridge.test.ts), so this cannot drift from the spec unnoticed.

export interface Port {
  post(message: object): void;
  listen(handler: (message: unknown) => void): void;
}

/** The real port: only messages from our own host frame are read. */
export const windowPort = (): Port => ({
  // A sandboxed view cannot know its host's origin; the spec sends to "*" and the host checks the source.
  post: (m) => window.parent.postMessage(m, '*'),
  listen: (fn) => window.addEventListener('message', (e) => e.source === window.parent && fn(e.data)),
});

export interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

type Json = Record<string, unknown>;
const PROTOCOL = '2026-01-26';

export class Bridge {
  hostContext: Json = {};
  hostCapabilities: Json = {};
  onToolResult?: (result: ToolResult) => void;
  onContext?: (context: Json) => void;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly port: Port,
    private readonly info = { name: 'doorbound-board', version: '1.0.0' },
  ) {
    port.listen((m) => this.receive(m));
  }

  async connect(displayModes: string[]): Promise<void> {
    const r = await this.request('ui/initialize', { appInfo: this.info, appCapabilities: { availableDisplayModes: displayModes }, protocolVersion: PROTOCOL });
    this.hostContext = (r.hostContext as Json) ?? {};
    this.hostCapabilities = (r.hostCapabilities as Json) ?? {};
    this.notify('ui/notifications/initialized', {});
  }

  callTool(name: string, args: Json): Promise<ToolResult> {
    return this.request('tools/call', { name, arguments: args }) as Promise<ToolResult>;
  }

  requestDisplayMode(mode: 'inline' | 'fullscreen'): Promise<Json> {
    return this.request('ui/request-display-mode', { mode });
  }

  sizeChanged(width: number, height: number): void {
    this.notify('ui/notifications/size-changed', { width, height });
  }

  private request(method: string, params: Json, timeoutMs = 10_000): Promise<Json> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.port.post({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: Json): void {
    this.port.post({ jsonrpc: '2.0', method, params });
  }

  private respond(id: unknown, body: Json): void {
    this.port.post({ jsonrpc: '2.0', id, ...body });
  }

  private receive(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as Json;
    if (m.jsonrpc !== '2.0') return;
    // A response to one of our requests: only ids we issued are accepted.
    if (typeof m.id === 'number' && !('method' in m)) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(String((m.error as Json).message ?? 'request failed')));
      else p.resolve((m.result as Json) ?? {});
      return;
    }
    const params = (m.params ?? {}) as Json;
    switch (m.method) {
      case 'ui/notifications/tool-result':
        this.onToolResult?.(params as ToolResult);
        return;
      case 'ui/notifications/host-context-changed':
        this.hostContext = { ...this.hostContext, ...params };
        this.onContext?.(this.hostContext);
        return;
      case 'ui/resource-teardown':
      case 'ping':
        this.respond(m.id, { result: {} });
        return;
      default:
        // Any other request gets a proper "not supported" so the host is never left waiting.
        if (m.id !== undefined && typeof m.method === 'string') this.respond(m.id, { error: { code: -32601, message: 'Method not found' } });
    }
  }
}
