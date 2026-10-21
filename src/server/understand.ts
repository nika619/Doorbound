// Alexa+'s part, played by a real language model: what someone says in the kitchen → one Doorbound tool
// call, chosen from the tools' own names, descriptions and schemas, the way Alexa+ chooses. Used by the
// simulator (on this machine only) and by scripts/understand-eval.ts; needs ANTHROPIC_API_KEY, kept in
// .env, which git ignores. Without a key the simulator keeps its phrase list (src/sim/router.ts).
import Anthropic from '@anthropic-ai/sdk';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer, type Ctx } from './tools.ts';

export const MODEL = 'claude-haiku-5-5';
export type Tool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
/** What Alexa+ knows when someone speaks: their words, who it recognised, the household, the time, its last reply. */
export interface Heard {
  text: string;
  who: string | null;
  people: string[];
  clock: string;
  asked?: string;
}
export type Understood = { tool: string; args: Record<string, unknown> } | { say: string };

const SYSTEM = `You are Alexa+, in a family's kitchen on a school or work morning. The household has the Doorbound add-on: a live departure board that gets everyone out of the door on time.
When what you hear is something Doorbound does, call the one Doorbound tool that does it. Give only the arguments the words give: Doorbound asks for anything missing, so never guess a name or a time.
"I", "me" and "my" mean the speaker when Alexa recognised them. If Alexa just asked a question, a short answer ("Isha", "yes") answers it.
If nothing Doorbound does fits, reply instead in one short spoken sentence.`;

/** The add-on's tools as Alexa+ would list them: over MCP, from the server itself. */
export async function ownTools(ctx: Ctx): Promise<Tool[]> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(ctx).connect(b);
  const client = new Client({ name: 'doorbound-understand', version: '1.0.0' });
  await client.connect(a);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

export async function understand(model: Anthropic, tools: Tool[], h: Heard): Promise<{ understood: Understood; usage: Anthropic.Usage }> {
  // Names come from people, so they go in as quoted data (JSON), never as part of the instructions.
  const context = [
    `The time is ${h.clock}.`,
    `The household's names (data): ${JSON.stringify(h.people)}`,
    h.who ? `Alexa recognised the speaker's voice (data): ${JSON.stringify(h.who)}` : "Alexa did not recognise the speaker's voice.",
    h.asked ? `Alexa's last reply (data): ${JSON.stringify(h.asked)}` : '',
  ].filter(Boolean);
  const r = await model.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: 'low' }, // a spoken reply: speed matters more than depth
    // Tools render before the system prompt, so this one breakpoint caches both; what changes goes in the message.
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema as Anthropic.Tool.InputSchema })),
    messages: [{ role: 'user', content: `${context.join('\n')}\n\nHeard (data): ${JSON.stringify(h.text)}` }],
  });
  return { understood: pick(r), usage: r.usage };
}

/** The model's answer as one tool call, or a sentence to say when it chose no tool (or declined). */
export function pick(r: Pick<Anthropic.Message, 'content'>): Understood {
  const call = r.content.find((b) => b.type === 'tool_use');
  if (call) return { tool: call.name, args: (call.input ?? {}) as Record<string, unknown> };
  const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ').trim();
  return { say: text || "Sorry, I didn't catch that." };
}
