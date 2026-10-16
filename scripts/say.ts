// Play one voice turn against a running server, the way Alexa+ would: a separate MCP client calls one tool.
// Usage:  tsx scripts/say.ts <tool> '<json args>'
//         tsx scripts/say.ts start_departure '{"leaveIn": 28}'   (leaveIn: minutes from the server's clock)
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = process.env.DOORBOUND_URL ?? 'http://127.0.0.1:3939';
const [tool, json = '{}'] = process.argv.slice(2);
if (!tool) throw new Error('usage: tsx scripts/say.ts <tool> [json]');
const args = JSON.parse(json) as Record<string, unknown>;
if (typeof args.leaveIn === 'number') {
  // The demo clock may run fast, so the time comes from the server, not this machine.
  const serverNow = Number((await fetch(new URL('/api/board?since=-2', base))).headers.get('X-Server-Now'));
  const d = new Date(serverNow + args.leaveIn * 60_000);
  args.leaveAt = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  delete args.leaveIn;
}
const headers: Record<string, string> = process.env.AUTH_TOKEN ? { Authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {};
const client = new Client({ name: 'say', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers } }));
const r = (await client.callTool({ name: tool, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
console.log(`${r.isError ? 'ERROR ' : ''}${r.content[0]?.text ?? ''}`);
await client.close();
