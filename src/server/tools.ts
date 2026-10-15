// The Alexa+ add-on surface: one tool per thing a household says in the morning.
// Every result has one plain sentence for Alexa to speak and the board state for the screen.
// Inputs are validated by schema; names are matched to the household, never trusted as ids.

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { markDone, project, setGate, startDeparture, stillGoing, undoReroute, type Change, type Departure, type PersonDef, type StepDef } from '../core/departure.ts';
import { insights, record } from '../core/learn.ts';
import { reroute } from '../core/reroute.ts';
import type { Audit } from './audit.ts';
import { changeSchema, laneSchema, LIMITS, type Store } from './store.ts';

export const BOARD_URI = 'ui://departures/board.html';

export interface Ctx {
  store: Store;
  audit: Audit;
  client: string;
  boardHtml: () => string;
  /** Server time. Runs faster than real time only in an explicitly labelled demo. */
  now: () => number;
  clockRate: number;
}

// ---------- the board the screen draws ----------

const boardSchema = z.object({
  rev: z.number(),
  serverNowMs: z.number(),
  clockRate: z.number(),
  unchanged: z.boolean().optional(),
  people: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  departure: z
    .object({
      name: z.string(),
      gateMs: z.number(),
      startedAtMs: z.number(),
      rev: z.number(),
      lanes: z.array(laneSchema),
      reroute: z.object({ atMs: z.number(), changes: z.array(changeSchema), stillLateSec: z.number(), canUndo: z.boolean() }).nullable(),
    })
    .nullable()
    .optional(),
  insights: z.array(z.object({ person: z.string(), step: z.string(), statedSec: z.number(), learnedSec: z.number() })).optional(),
});
type Board = z.infer<typeof boardSchema>;

function board(ctx: Ctx): Board {
  const { store } = ctx;
  const dep = store.departure;
  const people = store.household.people;
  const names = new Map(people.map((p) => [p.id, p]));
  return {
    rev: store.rev,
    serverNowMs: ctx.now(),
    clockRate: ctx.clockRate,
    people: people.map((p) => ({ id: p.id, name: p.name })),
    // The undo snapshot stays on the server: the screen only needs to know undo is possible.
    departure: dep && { ...dep, reroute: dep.reroute && { atMs: dep.reroute.atMs, changes: dep.reroute.changes, stillLateSec: dep.reroute.stillLateSec, canUndo: dep.reroute.rev === dep.rev } },
    insights: insights(store.history, people.flatMap((p) => p.steps.map((s) => ({ personId: p.id, stepId: s.id, statedSec: s.statedSec })))).slice(0, 3).map((i) => ({
      person: names.get(i.personId)?.name ?? i.personId,
      step: names.get(i.personId)?.steps.find((s) => s.id === i.stepId)?.name ?? i.stepId,
      statedSec: i.statedSec,
      learnedSec: i.learnedSec,
    })),
  };
}

// ---------- speech ----------

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const minutes = (sec: number) => {
  const m = Math.max(1, Math.round(Math.abs(sec) / 60));
  return `${m} minute${m === 1 ? '' : 's'}`;
};
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

function nameOf(store: Store, id: string) {
  return store.household.people.find((p) => p.id === id)?.name ?? id;
}

function describeChange(store: Store, c: Change): string {
  const owner = nameOf(store, c.taskKey.split('/')[0]);
  if (c.kind === 'quick') return `${owner} has the quick version of ${c.name.toLowerCase()}`;
  if (c.kind === 'handoff') return `${nameOf(store, c.to!)} takes over ${c.name.toLowerCase()} for ${owner}`;
  if (c.kind === 'later') return `${c.name.toLowerCase()} waits until after you leave`;
  return `${owner} skips ${c.name.toLowerCase()} today`;
}

/** One or two sentences: who is late, what changed, and whether it works. */
function summary(ctx: Ctx, dep: Departure, rerouted: boolean): string {
  const now = ctx.now();
  const views = project(dep, now);
  const parts: string[] = [];
  if (rerouted && dep.reroute) {
    const changes = dep.reroute.changes.map((c) => describeChange(ctx.store, c));
    parts.push(changes.length ? `Re-routed. ${list(changes)}.` : 'Nothing in the routines can be moved.');
    if (dep.reroute.stillLateSec > 0) {
      const late = views.filter((v) => v.status === 'late').map((v) => nameOf(ctx.store, v.personId));
      return `${parts[0]} Even so, ${list(late)} will be ${minutes(dep.reroute.stillLateSec)} late. Leaving at ${clock(dep.gateMs + Math.ceil(dep.reroute.stillLateSec / 60) * 60_000)} would work.`;
    }
    parts.push(`Everyone still leaves at ${clock(dep.gateMs)}.`);
    return parts.join(' ');
  }
  const late = views.filter((v) => v.status === 'late');
  if (late.length) return `${list(late.map((v) => `${nameOf(ctx.store, v.personId)} is ${minutes(v.slackSec)} behind`))}. Leave at ${clock(dep.gateMs)}.`;
  const going = views.filter((v) => v.status !== 'ready');
  if (!going.length) return `Everyone is ready. Leave at ${clock(dep.gateMs)}.`;
  const tight = going.reduce((a, b) => (b.slackSec < a.slackSec ? b : a));
  const left = Math.max(0, Math.round((dep.gateMs - now) / 60_000));
  return `Everyone is on time. Leave at ${clock(dep.gateMs)}, in ${minutes(left * 60)}. ${nameOf(ctx.store, tight.personId)} is the tightest, with ${minutes(tight.slackSec)} to spare.`;
}

// ---------- helpers ----------

const name = z.string().trim().min(1).max(LIMITS.name);
const leaveAt = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'a 24-hour time like 07:40').describe('Departure time, 24-hour, for example "07:40"');

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'x';

function findPerson(ctx: Ctx, who: string): PersonDef | undefined {
  const key = who.trim().toLowerCase();
  return ctx.store.household.people.find((p) => p.name.toLowerCase() === key || p.id === slug(who));
}

/** Today's (or tomorrow's, if already past) local time HH:MM as epoch ms. */
function gateFrom(hhmm: string, nowMs: number): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(nowMs);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

type Result = { content: { type: 'text'; text: string }[]; structuredContent?: Board; isError?: boolean };
const say = (ctx: Ctx, text: string): Result => ({ content: [{ type: 'text', text }], structuredContent: board(ctx) });
// Amazon's guide: never return nothing; say what went wrong and what to say instead.
const refuse = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });

function noOne(ctx: Ctx, who: string) {
  const names = ctx.store.household.people.map((p) => p.name);
  return refuse(names.length ? `I don't have anyone called ${who}. The household is ${list(names)}.` : 'Nobody is set up yet. Tell me someone\'s morning routine first.');
}
const NO_DEPARTURE = 'There is no departure running. Say, for example, start the school run, leave at 7:40.';

/** Commit a new departure: re-plan if anyone is late, persist, audit. Returns whether a re-route happened. */
function commit(ctx: Ctx, tool: string, dep: Departure | null, person?: string): boolean {
  let next = dep;
  let rerouted = false;
  if (next) {
    const fixed = reroute(next, ctx.store.household, ctx.store.history, ctx.now());
    rerouted = fixed !== next;
    next = fixed;
  }
  ctx.store.departure = next;
  ctx.store.touch();
  void ctx.store.save();
  ctx.audit.record({ tool, ok: true, person, client: ctx.client });
  return rerouted;
}

// ---------- the server ----------

export function buildServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'departures', version: '1.0.0' });
  const ui = { resourceUri: BOARD_URI };
  const out = { outputSchema: boardSchema };

  registerAppResource(server, 'Departures board', BOARD_URI, { description: "The household's departure board: who is doing what, who is on time, and the runway to the gate." }, async () => ({
    contents: [{ uri: BOARD_URI, mimeType: RESOURCE_MIME_TYPE, text: ctx.boardHtml() }],
  }));

  registerAppTool(
    server,
    'set_routine',
    {
      title: "Set someone's morning routine",
      description:
        "Use when the customer describes a person's steps before leaving the house, or changes them. Replaces that person's routine. Each step has a name and the minutes the person thinks it takes; optionally a quicker version, whether it can wait until after leaving, whether it can be skipped, and who else may do it. Returns the board.",
      inputSchema: z.object({
        person: name.describe('The person, for example "Isha"'),
        steps: z
          .array(
            z.object({
              name,
              minutes: z.number().min(0.5).max(120),
              quickVersion: z.object({ name, minutes: z.number().min(0.5).max(120) }).optional().describe('A faster version, for example breakfast to go'),
              canWait: z.boolean().optional().describe('It can be done after leaving'),
              optional: z.boolean().optional().describe('It can be skipped on a rushed morning'),
              helpers: z.array(name).max(LIMITS.helpers).optional().describe('Other people in the household who may do it instead'),
            }),
          )
          .min(1)
          .max(LIMITS.steps),
      }),
      ...out,
      _meta: { ui },
    },
    async ({ person, steps }) => {
      const hh = ctx.store.household;
      const existing = findPerson(ctx, person);
      if (!existing && hh.people.length >= LIMITS.people) return refuse(`A household can have up to ${LIMITS.people} people.`);
      const id = existing?.id ?? slug(person);
      const seen = new Set<string>();
      const defs: StepDef[] = steps.map((s) => {
        let sid = slug(s.name);
        for (let n = 2; seen.has(sid); n++) sid = `${slug(s.name).slice(0, 28)}-${n}`;
        seen.add(sid);
        return {
          id: sid,
          name: s.name,
          statedSec: Math.round(s.minutes * 60),
          quick: s.quickVersion && s.quickVersion.minutes < s.minutes ? { name: s.quickVersion.name, sec: Math.round(s.quickVersion.minutes * 60) } : undefined,
          canWait: s.canWait || undefined,
          optional: s.optional || undefined,
          helpers: s.helpers?.map(slug).filter((h) => h !== id),
        };
      });
      const def: PersonDef = { id, name: existing?.name ?? person.trim(), steps: defs };
      ctx.store.household = { people: existing ? hh.people.map((p) => (p.id === id ? def : p)) : [...hh.people, def] };
      ctx.store.touch();
      void ctx.store.save();
      ctx.audit.record({ tool: 'set_routine', ok: true, person: id, client: ctx.client });
      const total = Math.round(defs.reduce((a, s) => a + s.statedSec, 0) / 60);
      return say(ctx, `${def.name}'s routine is set: ${defs.length} step${defs.length === 1 ? '' : 's'}, about ${minutes(total * 60)}.${ctx.store.departure ? ' It applies from the next departure.' : ''}`);
    },
  );

  registerAppTool(
    server,
    'start_departure',
    {
      title: 'Start a departure',
      description: 'Use when the customer starts getting everyone out of the door, for example "start the school run, we leave at 7:40". Plans every routine against the departure time using how long steps have really taken before. Returns the board.',
      inputSchema: z.object({ leaveAt, name: name.optional().describe('Name of the departure, default "School run"') }),
      ...out,
      _meta: { ui },
    },
    async ({ leaveAt: at, name: label }) => {
      const now = ctx.now();
      const hh = ctx.store.household;
      if (!hh.people.some((p) => p.steps.length)) return refuse("Nobody has a routine yet. Tell me someone's steps first, for example: Isha showers for 8 minutes, then gets dressed.");
      const gateMs = gateFrom(at, now);
      if (gateMs <= now) return refuse(`${at} has already passed today. Say a later time.`);
      if (gateMs - now > 6 * 3_600_000) return refuse('That is more than six hours away. Start the departure closer to the time.');
      const dep = startDeparture(hh, ctx.store.history, label ?? 'School run', gateMs, now);
      const rerouted = commit(ctx, 'start_departure', dep);
      return say(ctx, `${dep.name} started. ${summary(ctx, ctx.store.departure!, rerouted)}`);
    },
  );

  registerAppTool(
    server,
    'step_done',
    {
      title: 'Someone finished a step',
      description: 'Use when someone says they finished what they were doing, for example "I\'m done with breakfast" or "Aarav has brushed his teeth". Moves them to their next step, learns how long it really took, and re-plans if anyone is late. Returns the board.',
      inputSchema: z.object({ person: name.describe('Who finished') }),
      ...out,
      _meta: { ui },
    },
    async ({ person }) => {
      const dep = ctx.store.departure;
      if (!dep) return refuse(NO_DEPARTURE);
      const p = findPerson(ctx, person);
      if (!p) return noOne(ctx, person);
      const lane = dep.lanes.find((l) => l.personId === p.id);
      const finished = lane?.tasks.find((t) => t.state === 'todo')?.name;
      const r = markDone(dep, p.id, ctx.now());
      if (!r) return refuse(`${p.name} has nothing left to do. ${p.name} is ready to go.`);
      if (r.sample) record(ctx.store.history, r.sample.personId, r.sample.stepId, r.sample.seconds);
      const rerouted = commit(ctx, 'step_done', r.dep, p.id);
      const next = project(ctx.store.departure!, ctx.now()).find((v) => v.personId === p.id)!;
      const lead = next.current ? `${p.name} is on to ${next.current.name.toLowerCase()}.` : `${p.name} is ready to go.`;
      return say(ctx, rerouted ? `${finished} done. ${summary(ctx, ctx.store.departure!, true)}` : `${finished} done. ${lead}`);
    },
  );

  registerAppTool(
    server,
    'still_going',
    {
      title: 'A step is running over',
      description: 'Use when someone is taking longer than planned, for example "Isha\'s still in the shower" or "Aarav needs five more minutes". Re-plans the morning so everyone still makes the departure if the household allows it, and says what changed. Returns the board.',
      inputSchema: z.object({
        person: name.describe('Who is running over'),
        extraMinutes: z.number().min(1).max(60).optional().describe('How much longer they need, if said. Otherwise half the planned time, at least two minutes.'),
      }),
      ...out,
      _meta: { ui },
    },
    async ({ person, extraMinutes }) => {
      const dep = ctx.store.departure;
      if (!dep) return refuse(NO_DEPARTURE);
      const p = findPerson(ctx, person);
      if (!p) return noOne(ctx, person);
      const task = dep.lanes.find((l) => l.personId === p.id)?.tasks.find((t) => t.state === 'todo');
      if (!task) return refuse(`${p.name} has nothing left to do.`);
      const extra = Math.round((extraMinutes ?? Math.max(2, task.sec / 120)) * 60);
      const rerouted = commit(ctx, 'still_going', stillGoing(dep, p.id, extra, ctx.now()), p.id);
      return say(ctx, rerouted ? summary(ctx, ctx.store.departure!, true) : `Noted, ${minutes(extra)} more for ${p.name}. ${summary(ctx, ctx.store.departure!, false)}`);
    },
  );

  registerAppTool(
    server,
    'change_departure',
    {
      title: 'Change the departure time',
      description: 'Use when the customer moves the departure, either to a time ("leave at 7:30 instead") or by minutes ("we need to leave ten minutes early" is shiftMinutes -10). Re-plans against the new time. Returns the board.',
      inputSchema: z.object({
        leaveAt: leaveAt.optional(),
        shiftMinutes: z.number().int().min(-120).max(120).optional().describe('Minutes to move the departure: negative is earlier'),
      }),
      ...out,
      _meta: { ui },
    },
    async ({ leaveAt: at, shiftMinutes }) => {
      const dep = ctx.store.departure;
      if (!dep) return refuse(NO_DEPARTURE);
      if (!at === (shiftMinutes === undefined)) return refuse('Say either a new time, or how many minutes earlier or later.');
      const gateMs = at ? gateFrom(at, ctx.now()) : dep.gateMs + shiftMinutes! * 60_000;
      if (gateMs <= ctx.now()) return refuse(`${clock(gateMs)} has already passed. Say a later time.`);
      const rerouted = commit(ctx, 'change_departure', setGate(dep, gateMs));
      return say(ctx, `Departure moved to ${clock(gateMs)}. ${summary(ctx, ctx.store.departure!, rerouted)}`);
    },
  );

  registerAppTool(
    server,
    'undo_reroute',
    {
      title: 'Undo the last re-route',
      description: 'Use when the customer rejects the changes from the last re-plan, for example "undo" or "no, keep the old plan". Only possible before anything else has happened. Returns the board.',
      inputSchema: z.object({}),
      ...out,
      _meta: { ui },
    },
    async () => {
      const dep = ctx.store.departure;
      if (!dep?.reroute) return refuse('There is nothing to undo.');
      const back = undoReroute(dep);
      if (!back) return refuse('Too much has happened since the re-route to undo it safely. Tell me what to change instead.');
      ctx.store.departure = back;
      ctx.store.touch();
      void ctx.store.save();
      ctx.audit.record({ tool: 'undo_reroute', ok: true, client: ctx.client });
      return say(ctx, `Back to the old plan. ${summary(ctx, back, false)}`);
    },
  );

  registerAppTool(
    server,
    'departure_status',
    {
      title: 'How are we doing',
      description: 'Use when the customer asks how the morning is going, who is late, or how long until they leave. Changes nothing. Returns the board.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      ...out,
      _meta: { ui },
    },
    async () => {
      const dep = ctx.store.departure;
      return dep ? say(ctx, summary(ctx, dep, false)) : refuse(NO_DEPARTURE);
    },
  );

  registerAppTool(
    server,
    'learned_times',
    {
      title: 'What the household has learned',
      description: 'Use when the customer asks how long things really take, or what has been learned. Compares the time each person said with the time it has really taken. Changes nothing. Returns the board.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      ...out,
      _meta: { ui },
    },
    async () => {
      const found = board(ctx).insights ?? [];
      if (!found.length) return say(ctx, 'Nothing surprising yet. After three or four mornings I can tell you how long things really take.');
      return say(ctx, found.map((i) => `${i.person}'s ${i.step.toLowerCase()} takes about ${minutes(i.learnedSec)}, not ${minutes(i.statedSec)}.`).join(' '));
    },
  );

  registerAppTool(
    server,
    'end_departure',
    {
      title: 'End the departure',
      description: 'Use when everyone has left, or the customer cancels the departure. Clears the board; learned times are kept. Returns the board.',
      inputSchema: z.object({}),
      annotations: { idempotentHint: true },
      ...out,
      _meta: { ui },
    },
    async () => {
      if (!ctx.store.departure) return refuse(NO_DEPARTURE);
      const name = ctx.store.departure.name;
      commit(ctx, 'end_departure', null);
      return say(ctx, `${name} ended. Have a good day.`);
    },
  );

  // Only the screen calls this, about once a second. When nothing changed it answers in a few bytes.
  registerAppTool(
    server,
    'get_board',
    {
      title: 'Read the board',
      description: 'Returns the board, or only the revision and the time when nothing changed since `sinceRev`. Called by the departure board to stay in step.',
      inputSchema: z.object({ sinceRev: z.number().int().optional() }),
      annotations: { readOnlyHint: true },
      ...out,
      _meta: { ui: { resourceUri: BOARD_URI, visibility: ['app'] } },
    },
    async ({ sinceRev }) => {
      if (sinceRev === ctx.store.rev) return { content: [{ type: 'text', text: 'Unchanged.' }], structuredContent: { rev: ctx.store.rev, serverNowMs: ctx.now(), clockRate: ctx.clockRate, unchanged: true } };
      return say(ctx, ctx.store.departure ? summary(ctx, ctx.store.departure, false) : 'No departure running.');
    },
  );

  return server;
}

export { board as boardOf };
