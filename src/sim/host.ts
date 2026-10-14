// A small MCP host in a web page: a real MCP client over Streamable HTTP, plus the MCP Apps
// bridge that renders ui:// views in sandboxed iframes. This is the seed of the Alexa+ simulator.
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { AppBridge, getToolUiResourceUri, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

const $ = (id: string) => document.getElementById(id)!;
const client = new Client({ name: 'marquee-sim', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', location.href)));
const { tools } = await client.listTools();
$('status').textContent = `Connected. Protocol ${client.getNegotiatedProtocolVersion()}. ${tools.length} tools.`;

interface View {
  bridge: AppBridge;
  logs: unknown[];
}
const views: View[] = [];
// Exposed so a test can read what each screen believes.
Object.assign(window, { __views: views, __client: client });

async function openView(uri: string, args: Record<string, unknown>, result: CallToolResult) {
  const resource = await client.readResource({ uri });
  const first = resource.contents[0];
  const iframe = document.createElement('iframe');
  iframe.title = `Marquee screen ${views.length + 1}`;
  // No allow-same-origin: the view runs in its own opaque origin and can reach us only through the bridge.
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.srcdoc = 'text' in first ? String(first.text) : '';
  $('views').append(iframe);

  const bridge = new AppBridge(
    client,
    { name: 'marquee-sim', version: '0.1.0' },
    { serverTools: {}, serverResources: {}, logging: {} },
    { hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], platform: 'web' } },
  );
  const view: View = { bridge, logs: [] };
  views.push(view);
  bridge.onloggingmessage = (p) => view.logs.push({ ...(p.data as object), receivedAt: Date.now() });
  bridge.oninitialized = () => {
    void bridge.sendToolInput({ arguments: args });
    void bridge.sendToolResult(result);
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
}

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const spoken = result.content.find((c) => c.type === 'text');
  $('transcript').textContent += `${name}: ${spoken && 'text' in spoken ? spoken.text : ''}\n`;
  // One screen per device: the first tool with a view opens it; later turns update it through the server clock.
  const uri = getToolUiResourceUri(tools.find((t) => t.name === name) ?? {});
  if (uri && views.length === 0) await openView(uri, args, result);
  return result;
}
Object.assign(window, { __call: call });

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
  button.addEventListener('click', () => void call(button.dataset.tool!, JSON.parse(button.dataset.args!)));
}
$('second').addEventListener('click', async () => {
  const result = (await client.callTool({ name: 'get_stage_state', arguments: {} })) as CallToolResult;
  await openView('ui://marquee/stage.html', {}, result);
});
