// Stands in for a voice turn from another device: a separate MCP client calls one tool.
// Usage: tsx scripts/voice-turn.ts control_show '{"action":"pause"}'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const [name, json = '{}'] = process.argv.slice(2);
const client = new Client({ name: 'another-echo', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', process.env.MARQUEE_URL ?? 'http://127.0.0.1:3939')));
const sentAt = Date.now();
const result = (await client.callTool({ name, arguments: JSON.parse(json) })) as { content: { text?: string }[]; structuredContent?: { remainingMs?: number } };
console.log(JSON.stringify({ tool: name, sentAt, answeredAt: Date.now(), said: result.content[0]?.text, remainingMs: result.structuredContent?.remainingMs }));
await client.close();
