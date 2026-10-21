// Does a real language model, given only Doorbound's own tool list, turn what a family says into the right
// tool call? The question Alexa+ will answer every morning. Scores the model (src/server/understand.ts) and,
// for comparison, the simulator's phrase list (src/sim/router.ts) on the same 42 things people say.
//   npm run understand-eval        (needs ANTHROPIC_API_KEY in .env; one run is a few cents, printed at the end)
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { household } from '../src/core/fixtures.ts';
import { Audit } from '../src/server/audit.ts';
import { Store } from '../src/server/store.ts';
import { MODEL, ownTools, understand, type Understood } from '../src/server/understand.ts';
import { route } from '../src/sim/router.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Put ANTHROPIC_API_KEY=... in .env (git ignores it) and run again.');
  process.exit(1);
}

interface Case {
  text: string;
  who?: string;
  asked?: string;
  tool: string | null; // null: nothing Doorbound does; Alexa should just answer
  args?: Record<string, unknown>;
  absent?: string[]; // arguments the words do not give, which must be left for Doorbound to ask
}
const CASES: Case[] = [
  { text: 'Start the school run. We leave in 40 minutes.', tool: 'start_departure', args: { leaveAt: '7:52' } },
  { text: 'We need to be out the door at 7:50.', tool: 'start_departure', args: { leaveAt: '7:50' } },
  { text: "Start the morning. We have to be at school by 8:30 and it's a 20 minute drive.", tool: 'start_departure', args: { arriveBy: '8:30', travelMinutes: 20 } },
  { text: 'We leave at 7:49 tomorrow. When should everyone be up?', tool: 'plan_tomorrow', args: { leaveAt: '7:49' } },
  { text: 'If we leave at quarter to eight tomorrow, when do the kids need to get up?', tool: 'plan_tomorrow', args: { leaveAt: '7:45' } },
  { text: "Isha's done with her shower.", tool: 'step_done', args: { person: 'Isha' } },
  { text: "I'm done.", who: 'Aarav', tool: 'step_done', args: { person: 'Aarav' } },
  { text: "I'm done.", tool: 'step_done', absent: ['person'] },
  { text: 'Dad finished the lunches.', tool: 'step_done', args: { person: 'Dad' } },
  { text: 'Aarav brushed his teeth.', tool: 'step_done', args: { person: 'Aarav' } },
  { text: 'Isha.', asked: 'Who is done: Isha, on her shower, or Aarav, on breakfast?', tool: 'step_done', args: { person: 'Isha' } },
  { text: "Isha's still in the shower.", tool: 'still_going', args: { person: 'Isha' } },
  { text: 'I need five more minutes.', who: 'Isha', tool: 'still_going', args: { person: 'Isha', extraMinutes: 5 } },
  { text: "Aarav's going to be another ten minutes on breakfast.", tool: 'still_going', args: { person: 'Aarav', extraMinutes: 10 } },
  { text: 'Aarav is ready to go.', tool: 'ready_to_go', args: { person: 'Aarav' } },
  { text: "I'm ready.", who: 'Dad', tool: 'ready_to_go', args: { person: 'Dad' } },
  { text: 'We need to leave 5 minutes early.', tool: 'change_departure', args: { shiftMinutes: -5 } },
  { text: 'Push the leaving time back ten minutes.', tool: 'change_departure', args: { shiftMinutes: 10 } },
  { text: "Actually, we're leaving at 8.", tool: 'change_departure', args: { leaveAt: '8:00' } },
  { text: 'Undo that.', tool: 'undo_reroute' },
  { text: 'Put it back the way it was.', tool: 'undo_reroute' },
  { text: 'How are we doing?', tool: 'departure_status' },
  { text: 'Are we going to make it?', tool: 'departure_status' },
  { text: "Who's running late?", tool: 'departure_status' },
  { text: 'What have you learned?', tool: 'learned_times' },
  { text: "How long does Isha's shower usually take?", tool: 'learned_times' },
  { text: 'How accurate have your predictions been?', tool: 'how_accurate' },
  { text: "We've left.", tool: 'end_departure', args: { left: true } },
  { text: "We're out the door.", tool: 'end_departure', args: { left: true } },
  { text: "Cancel this morning, school's closed.", tool: 'end_departure', absent: ['left'] },
  { text: "Aarav can skip breakfast if he's running late.", tool: 'allow_change', args: { person: 'Aarav', optional: true } },
  { text: 'Dad can unload the dishwasher later.', tool: 'allow_change', args: { person: 'Dad', canWait: true } },
  { text: "If we're tight, Isha can do a five minute shower.", tool: 'allow_change', args: { person: 'Isha' } },
  { text: 'Dad can help Aarav with his shoes and bag.', tool: 'allow_change', args: { person: 'Aarav', helper: 'Dad' } },
  { text: "Aarav and Isha share the bathroom; Isha's shower needs it.", tool: 'allow_change', args: { person: 'Isha' } },
  { text: "Isha's morning is shower, get dressed, breakfast, then pack her bag.", tool: 'set_routine', args: { person: 'Isha' } },
  { text: 'Put the board on the TV.', tool: 'tv_link' },
  { text: 'How do I connect our front door sensor?', tool: 'door_link' },
  { text: 'Delete everything you know about our family.', tool: 'forget_household', absent: ['confirm'] },
  { text: 'Show me the board.', tool: 'get_board' },
  { text: "What's the weather today?", tool: null },
  { text: 'Play some music.', tool: null },
];

const CLOCK = new Date(2026, 9, 15, 7, 12); // a Thursday, as the demo morning starts
const clockIn = (m: number) => {
  const d = new Date(CLOCK.getTime() + m * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
// "07:52", "7:52", "7:52 am" are the same time; names compare without case.
const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/^0(\d:)/, '$1').replace(/\s*a\.?m\.?$/, '') : v);
function grade(c: Case, u: Understood | null): { tool: boolean; all: boolean } {
  const tool = c.tool === null ? !u || 'say' in u : !!u && 'tool' in u && u.tool === c.tool;
  if (!tool || !u || !('tool' in u)) return { tool, all: tool };
  const args = Object.entries(c.args ?? {}).every(([k, v]) => norm(u.args[k]) === norm(v));
  const absent = (c.absent ?? []).every((k) => u.args[k] === undefined || u.args[k] === false);
  return { tool, all: args && absent };
}

const store = await Store.open(await mkdtemp(join(tmpdir(), 'understand-')));
store.household = household;
const tools = await ownTools({ store, audit: new Audit(await mkdtemp(join(tmpdir(), 'audit-'))), client: 'eval', boardHtml: () => '', now: () => CLOCK.getTime(), clockRate: 1 });
const people = household.people.map((p) => p.name);
const model = new Anthropic();
const score = { model: { tool: 0, all: 0 }, rules: { tool: 0, all: 0 } };
const tokens = { input: 0, write: 0, read: 0, output: 0 };
for (const c of CASES) {
  const { understood: u, usage } = await understand(model, tools, { text: c.text, who: c.who ?? null, people, clock: '7:12 AM', asked: c.asked });
  tokens.input += usage.input_tokens;
  tokens.write += usage.cache_creation_input_tokens ?? 0;
  tokens.read += usage.cache_read_input_tokens ?? 0;
  tokens.output += usage.output_tokens;
  const r = route(c.text, people, c.who ?? null, clockIn);
  const m = grade(c, u);
  const g = grade(c, r);
  for (const [k, v] of [['model', m], ['rules', g]] as const) {
    score[k].tool += +v.tool;
    score[k].all += +v.all;
  }
  if (!m.all) console.log(`model miss: "${c.text}"${c.who ? ` (${c.who})` : ''} → ${JSON.stringify(u)}; wanted ${c.tool ?? 'no tool'} ${JSON.stringify(c.args ?? {})}`);
}
const n = CASES.length;
const pct = (k: number) => `${k}/${n} (${Math.round((100 * k) / n)}%)`;
console.log(`\n${MODEL}: right tool ${pct(score.model.tool)}, right tool and arguments ${pct(score.model.all)}`);
console.log(`phrase list: right tool ${pct(score.rules.tool)}, right tool and arguments ${pct(score.rules.all)}`);
// List prices for Claude Haiku 5.5 (Oct 2026): $0.10 per million input tokens, writes 1.25x, cache reads 0.1x, $0.50 output.
const usd = (tokens.input * 0.1 + tokens.write * 0.125 + tokens.read * 0.01 + tokens.output * 0.5) / 1e6;
console.log(`tokens: ${tokens.input} in, ${tokens.write} cache writes, ${tokens.read} cache reads, ${tokens.output} out; about $${usd.toFixed(3)}`);
