// The Alexa+ add-on surface: one tool per thing a household says in the morning.
// Every result has one plain sentence for Alexa to speak and the board state for the screen.
// Inputs are validated by schema; names are matched to the household, never trusted as ids.

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { kappaOf, readings, reading, recordPace, rhoOf } from '../core/pace.ts';
import { planStarts, WAKE_SEC } from '../core/tomorrow.ts';
import { honesty, noteForecasts, settle } from '../core/score.ts';
import { currentIndex, currentRemaining, departurePaces, markDone, markReady, project, setGate, startDeparture, stillGoing, TARGET, undoReroute, type Change, type Departure, type LaneView, type PersonDef, type StepDef } from '../core/departure.ts';
import { insights, record } from '../core/learn.ts';
import { reroute } from '../core/reroute.ts';
import { quantile, sum } from '../core/stats.ts';
import type { Audit } from './audit.ts';
import { changeSchema, laneSchema, LIMITS, type Store } from './store.ts';

export const BOARD_URI = 'ui://doorbound/board.html';

export interface Ctx {
  store: Store;
  audit: Pick<Audit, 'record'>;
  client: string;
  boardHtml: () => string;
  /** Server time. Runs faster than real time only in an explicitly labelled demo. */
  now: () => number;
  clockRate: number;
  /** This household's private link for a TV or tablet, when the server can make one. */
  screenLink?: string;
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
      rho: z.number(),
      kappa: z.number().optional(),
      reroute: z.object({ atMs: z.number(), changes: z.array(changeSchema), stillLateSec: z.number(), canUndo: z.boolean() }).nullable(),
    })
    .nullable()
    .optional(),
  insights: z.array(z.object({ person: z.string(), step: z.string(), statedSec: z.number(), learnedSec: z.number() })).optional(),
});
type Board = z.infer<typeof boardSchema>;

function board(ctx: Ctx): Board {
  const { store } = ctx;
  // Open forecasts are the server's own bookkeeping (score.ts), not part of the board.
  const dep = store.departure && (({ forecasts: _, ...rest }) => rest)(store.departure);
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
/** A chance as Alexa should say it: never a certain 0% or 100%. */
const pct = (p: number) => `${Math.min(99, Math.max(1, Math.round(p * 100)))}%`;
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

function nameOf(store: Store, id: string) {
  return store.household.people.find((p) => p.id === id)?.name ?? id;
}

function describeChange(store: Store, c: Change): string {
  const [ownerId, stepId] = c.taskKey.split('/');
  const owner = nameOf(store, ownerId);
  const quick = store.household.people.find((p) => p.id === ownerId)?.steps.find((s) => s.id === stepId)?.quick?.name;
  if (c.kind === 'quick') return `${owner} has ${quick ? quick.toLowerCase() : `the quick version of ${c.name.toLowerCase()}`}`;
  if (c.kind === 'handoff') return `${nameOf(store, c.to!)} takes over ${c.name.toLowerCase()} for ${owner}`;
  if (c.kind === 'later') return `${c.name.toLowerCase()} waits until after you leave`;
  return `${owner} skips ${c.name.toLowerCase()} today`;
}

/** One or two sentences: who is behind, what changed, and the chance it works. */
function summary(ctx: Ctx, dep: Departure, rerouted: boolean): string {
  const now = ctx.now();
  const views = project(dep, now);
  const who = (v: LaneView) => nameOf(ctx.store, v.personId);
  if (rerouted && dep.reroute) {
    const changes = dep.reroute.changes.map((c) => describeChange(ctx.store, c));
    const lead = `Re-routed: ${list(changes)}.`;
    if (dep.reroute.stillLateSec > 0) {
      const late = views.filter((v) => v.pOnTime < TARGET).map(who);
      return `${lead} Even so, ${list(late)} will be about ${minutes(dep.reroute.stillLateSec)} late. Leaving at ${clock(dep.gateMs + Math.ceil(dep.reroute.stillLateSec / 60) * 60_000)} would work.`;
    }
    const before = project(dep.reroute.before, now);
    const helped = views.filter((_, i) => before[i].pOnTime < TARGET).map((v) => `${who(v)} is now at ${pct(v.pOnTime)}`);
    return `${lead} Everyone still leaves at ${clock(dep.gateMs)}${helped.length ? `, and ${list(helped)}` : ''}.`;
  }
  const behind = views.filter((v) => v.status === 'late' || v.status === 'tight');
  if (behind.length) {
    const works = Math.ceil(Math.max(...behind.map((v) => v.readyMs)) / 60_000) * 60_000;
    return `${list(behind.map((v) => `${who(v)} is ${v.status === 'late' ? 'running late' : 'cutting it fine'}, at ${pct(v.pOnTime)}`))}. Leave at ${clock(dep.gateMs)}, or at ${clock(works)} to be sure.`;
  }
  const going = views.filter((v) => v.status !== 'ready');
  if (!going.length) return `Everyone is ready. Leave at ${clock(dep.gateMs)}.`;
  const tightest = going.reduce((a, b) => (b.pOnTime < a.pOnTime ? b : a));
  const left = Math.max(0, Math.round((dep.gateMs - now) / 60_000));
  return `Everyone is on time. Leave at ${clock(dep.gateMs)}, in ${minutes(left * 60)}. ${who(tightest)} is the tightest, at ${pct(tightest.pOnTime)}.`;
}

// ---------- helpers ----------

const name = z.string().trim().min(1).max(LIMITS.name);
const leaveAt = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'a 24-hour time like 07:40').describe('Departure time, 24-hour, for example "07:40"');

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'x';

function findPerson(ctx: Ctx, who: string): PersonDef | undefined {
  const key = who.trim().toLowerCase();
  return ctx.store.household.people.find((p) => p.name.toLowerCase() === key || p.id === slug(who));
}

/**
 * The local HH:MM a household means: today's, or tomorrow's when today's has passed and tomorrow's is
 * within 12 hours (at 23:40, "leave at 00:10" is in half an hour). A time that passed earlier today stays
 * in the past, so it is refused as passed rather than read as tomorrow.
 */
function gateFrom(hhmm: string, nowMs: number): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(nowMs);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= nowMs) {
    const next = new Date(d);
    next.setDate(next.getDate() + 1); // by the calendar, so a clock change does not shift it
    if (next.getTime() - nowMs <= 12 * 3_600_000) return next.getTime();
  }
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

/**
 * Who a sentence is about. Alexa+ does not tell an add-on who is speaking, so "I'm done" can arrive with no
 * name. Then: the one person whose current step matches the step said ("the shower's done"), or the only
 * person still getting ready; otherwise a question naming who is on what, so the answer can come back.
 */
function whoFor(ctx: Ctx, dep: Departure, person: string | undefined, step: string | undefined): PersonDef | Result {
  const named = person ? findPerson(ctx, person) : undefined;
  if (named) return named;
  // A name we do not know (say, the account holder's) or "me" is treated like no name, and said so if it was a name.
  const unknown = person && !/^(i|me|myself)$/i.test(person.trim()) ? `I don't have anyone called ${person.trim()}. ` : '';
  const busy = dep.lanes.flatMap((l) => {
    const i = currentIndex(l);
    const p = ctx.store.household.people.find((x) => x.id === l.personId);
    return i < 0 || !p ? [] : [{ p, on: l.tasks[i].name.toLowerCase() }];
  });
  if (!busy.length) return refuse('Everyone is ready to go.');
  const key = step?.trim().toLowerCase();
  const matching = key ? busy.filter((b) => b.on.includes(key) || key.includes(b.on)) : busy;
  if (matching.length === 1 && !unknown) return matching[0].p;
  const ask = matching.length ? matching : busy;
  const lead = unknown + (key && !matching.length ? `Nobody is on ${key} right now. ` : '');
  // Up to three, say what each is on; more than that is too long to hear, so names only.
  const choices = ask.length > 3 ? `${list(ask.map((b) => b.p.name)).replace(/ and ([^ ]+)$/, ' or $1')}?` : `${list(ask.map((b, i) => `${b.p.name}${i ? '' : ' is'} on ${b.on}`))}.`;
  return say(ctx, `${lead}Who was that? ${choices}`);
}
const asked = (x: PersonDef | Result): x is Result => 'content' in x;
const whoParams = {
  person: name.optional().describe("Who it is. Use the name said; if none was said and you recognise the speaker's voice as someone in the household, use theirs; otherwise leave it out."),
  step: name.optional().describe('The step, if one was said and no person was, for example "shower". It is used to work out who.'),
};

/**
 * Commit a new departure: re-plan if anyone is late, score what can be scored, note the chances of the
 * people in `note`, persist, audit. Returns whether a re-route happened.
 */
function commit(ctx: Ctx, tool: string, dep: Departure | null, person?: string, note?: string[]): boolean {
  const now = ctx.now();
  const prev = ctx.store.departure;
  // A departure ended or replaced: what it said about people still out is settled now.
  if (prev && (!dep || dep.startedAtMs !== prev.startedAtMs)) settle(prev, now, ctx.store.scores, true);
  let next = dep;
  let rerouted = false;
  if (next) {
    const fixed = reroute(next, ctx.store.household, ctx.store.history, now);
    rerouted = fixed !== next;
    next = settle(fixed, now, ctx.store.scores);
    if (note) next = noteForecasts(next, now, note);
  }
  ctx.store.departure = next;
  ctx.store.touch();
  void ctx.store.save();
  ctx.audit.record({ tool, ok: true, person, client: ctx.client });
  return rerouted;
}

// ---------- the server ----------

export function buildServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'doorbound', version: '1.0.0' });
  const ui = { resourceUri: BOARD_URI };
  const out = { outputSchema: boardSchema };

  registerAppResource(server, 'Doorbound board', BOARD_URI, { description: "The household's departure board: who is doing what, who is on time, and the runway to the gate." }, async () => ({
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
        wakeMinutes: z.number().min(1).max(60).optional().describe('How long they take from the alarm to starting the first step, if said. Default 10 minutes.'),
      }),
      ...out,
      _meta: { ui },
    },
    async ({ person, steps, wakeMinutes }) => {
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
      const wakeSec = wakeMinutes !== undefined ? Math.round(wakeMinutes * 60) : existing?.wakeSec;
      const def: PersonDef = { id, name: existing?.name ?? person.trim(), steps: defs, ...(wakeSec ? { wakeSec } : {}) };
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
    'allow_change',
    {
      title: 'Say what can bend on a rushed morning',
      description:
        "Use when the customer says how one step can bend when time is short, for example: Isha's breakfast can be to go in 2 minutes; Dad can pack Isha's bag; the dishwasher can wait; Aarav can skip reading. Changes only that step; the re-planner may then use it. Returns the board.",
      inputSchema: z.object({
        person: name.describe('Whose step it is'),
        step: name.describe('The step, as it was named, for example "Breakfast"'),
        quickVersion: z.object({ name, minutes: z.number().min(0.5).max(120) }).optional().describe('A faster version, for example breakfast to go'),
        canWait: z.boolean().optional().describe('It can be done after leaving'),
        optional: z.boolean().optional().describe('It can be skipped'),
        helper: name.optional().describe('Someone else who may do it instead'),
      }),
      ...out,
      _meta: { ui },
    },
    async ({ person, step, quickVersion, canWait, optional, helper }) => {
      const p = findPerson(ctx, person);
      if (!p) return noOne(ctx, person);
      const key = step.trim().toLowerCase();
      const s = p.steps.find((x) => x.id === slug(step) || x.name.toLowerCase() === key) ?? p.steps.find((x) => x.name.toLowerCase().includes(key) || key.includes(x.name.toLowerCase()));
      if (!s) return refuse(`${p.name} has no step called ${step}. Their steps are ${list(p.steps.map((x) => x.name.toLowerCase()))}.`);
      if (quickVersion && quickVersion.minutes * 60 >= s.statedSec) return refuse(`A quicker version has to take less than ${minutes(s.statedSec)}.`);
      const h = helper === undefined ? undefined : findPerson(ctx, helper);
      if (helper !== undefined && (!h || h.id === p.id)) return h ? refuse(`${p.name} already does it.`) : noOne(ctx, helper);
      const next: StepDef = {
        ...s,
        ...(quickVersion ? { quick: { name: quickVersion.name, sec: Math.round(quickVersion.minutes * 60) } } : {}),
        ...(canWait !== undefined ? { canWait: canWait || undefined } : {}),
        ...(optional !== undefined ? { optional: optional || undefined } : {}),
        ...(h ? { helpers: [...new Set([...(s.helpers ?? []), h.id])].slice(0, LIMITS.helpers) } : {}),
      };
      ctx.store.household = { people: ctx.store.household.people.map((x) => (x.id === p.id ? { ...x, steps: x.steps.map((y) => (y.id === s.id ? next : y)) } : x)) };
      ctx.store.touch();
      void ctx.store.save();
      ctx.audit.record({ tool: 'allow_change', ok: true, person: p.id, client: ctx.client });
      const said = [quickVersion && `${quickVersion.name.toLowerCase()} in ${minutes(quickVersion.minutes * 60)}`, canWait && 'it can wait until after you leave', optional && 'it can be skipped', h && `${h.name} can do it`].filter(Boolean);
      return say(ctx, `Got it: ${p.name}'s ${s.name.toLowerCase()}, ${said.length ? list(said as string[]) : 'no change'}. ${ctx.store.departure ? 'It applies from the next departure.' : 'I will only use it when time is short.'}`);
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
      const rho = rhoOf(ctx.store.pace);
      const dep = startDeparture(hh, ctx.store.history, label ?? 'School run', gateMs, now, rho, kappaOf(ctx.store.pace, rho));
      const rerouted = commit(ctx, 'start_departure', dep, undefined, hh.people.map((p) => p.id));
      return say(ctx, `${dep.name} started. ${summary(ctx, ctx.store.departure!, rerouted)}`);
    },
  );

  registerAppTool(
    server,
    'step_done',
    {
      title: 'Someone finished a step',
      description: 'Use when someone says they finished what they were doing, for example "I\'m done", "the shower\'s done" or "Aarav has brushed his teeth". If it is unclear who, the reply asks; pass the answer back as person. Moves them to their next step, learns how long it really took, and re-plans if anyone is late. Returns the board.',
      inputSchema: z.object(whoParams),
      ...out,
      _meta: { ui },
    },
    async ({ person, step }) => {
      const dep = ctx.store.departure;
      if (!dep) return refuse(NO_DEPARTURE);
      const p = whoFor(ctx, dep, person, step);
      if (asked(p)) return p;
      const lane = dep.lanes.find((l) => l.personId === p.id);
      const task = lane?.tasks.find((t) => t.state === 'todo');
      const finished = task?.name;
      const earlier = lane ? readings(lane) : [];
      const others = dep.lanes.flatMap((l) => (l.personId === p.id ? [] : readings(l)));
      const r = markDone(dep, p.id, ctx.now());
      if (!r) return refuse(`${p.name} has nothing left to do. ${p.name} is ready to go.`);
      if (r.sample) {
        record(ctx.store.history, r.sample.personId, r.sample.stepId, r.sample.seconds);
        if (task && r.sample.seconds >= 1) recordPace(ctx.store.pace, earlier, reading(task, r.sample.seconds), others);
      }
      const rerouted = commit(ctx, 'step_done', r.dep, p.id, [p.id]);
      const next = project(ctx.store.departure!, ctx.now()).find((v) => v.personId === p.id)!;
      const pct = Math.round(Math.abs(next.pace) * 100);
      const pace = !next.current || pct < 15 ? '' : next.pace > 0 ? ` ${p.name} is running about ${pct}% slow this morning, so I've planned the rest longer.` : ` ${p.name} is about ${pct}% quicker than usual this morning.`;
      const forIt = next.current ? Math.max(60, Math.round((next.stepEndMs - ctx.now()) / 60_000) * 60) : 0;
      const lead = next.current ? `${p.name} is on to ${next.current.name.toLowerCase()}, about ${minutes(forIt)}.${pace}` : `${p.name} is ready to go.`;
      const note = r.sample?.capped === 'long' ? ' That took far longer than usual, so I have counted it as a slow morning, not a new normal.' : '';
      return say(ctx, rerouted ? `${finished} done.${note} ${summary(ctx, ctx.store.departure!, true)}` : `${finished} done.${note} ${lead}`);
    },
  );

  registerAppTool(
    server,
    'ready_to_go',
    {
      title: 'Someone is ready to leave',
      description: 'Use when someone is ready to go, for example "I\'m ready", "Isha\'s ready to go" or "Aarav\'s all set". Marks all of their remaining steps done at once, so a family only has to say when they start and when each person is ready; every "done" in between makes the plan smarter. If it is unclear who, the reply asks; pass the answer back as person. Returns the board.',
      inputSchema: z.object({ person: whoParams.person }),
      ...out,
      _meta: { ui },
    },
    async ({ person }) => {
      const dep = ctx.store.departure;
      if (!dep) return refuse(NO_DEPARTURE);
      const p = whoFor(ctx, dep, person, undefined);
      if (asked(p)) return p;
      const next = markReady(dep, p.id, ctx.now());
      if (!next) return refuse(`${p.name} has nothing left to do. ${p.name} is ready to go.`);
      commit(ctx, 'ready_to_go', next, p.id);
      const left = project(ctx.store.departure!, ctx.now()).filter((v) => v.current).length;
      return say(ctx, `${p.name} is ready to go.${left ? ` ${summary(ctx, ctx.store.departure!, false)}` : ' Everyone is ready. Have a good day.'}`);
    },
  );

  registerAppTool(
    server,
    'still_going',
    {
      title: 'A step is running over',
      description: 'Use when someone is taking longer than planned, for example "Isha\'s still in the shower" or "Aarav needs five more minutes". Re-plans the morning so everyone still makes the departure if the household allows it, and says what changed. Returns the board.',
      inputSchema: z.object({
        ...whoParams,
        extraMinutes: z.number().min(1).max(60).optional().describe('How much longer they need, if said. Otherwise the long end of what the step usually still needs.'),
      }),
      ...out,
      _meta: { ui },
    },
    async ({ person, step, extraMinutes }) => {
      const dep = ctx.store.departure;
      if (!dep) return refuse(NO_DEPARTURE);
      const p = whoFor(ctx, dep, person, step);
      if (asked(p)) return p;
      const now = ctx.now();
      const li = dep.lanes.findIndex((l) => l.personId === p.id);
      const lane = dep.lanes[li];
      const idx = lane ? currentIndex(lane) : -1;
      if (!lane || idx < 0) return refuse(`${p.name} has nothing left to do.`);
      // Nobody said how long: plan for the long end (the TARGET quantile) of what this step usually still needs, at the household's pace.
      const extra = Math.round(extraMinutes !== undefined ? extraMinutes * 60 : Math.max(120, quantile(sum([currentRemaining(lane, idx, now, dep.rho, departurePaces(dep, now)[li].before)])!, TARGET)));
      const rerouted = commit(ctx, 'still_going', stillGoing(dep, p.id, extra, now), p.id);
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
    'plan_tomorrow',
    {
      title: 'When everyone has to start',
      description:
        'Use the evening before, when the customer asks when people need to get up or start, for example "we leave at 7:40 tomorrow, when should everyone be up?". Works back from the departure time to the latest time each person can start their routine and still give the household an 85% chance of leaving on time together, from how long their steps really take. Changes nothing. Offer to set an alarm for each person at their time.',
      inputSchema: z.object({ leaveAt }),
      annotations: { readOnlyHint: true },
      ...out,
      _meta: { ui },
    },
    async ({ leaveAt: at }) => {
      const now = ctx.now();
      let gateMs = gateFrom(at, now);
      if (gateMs <= now) {
        const d = new Date(gateMs);
        d.setDate(d.getDate() + 1); // the next time it is that o'clock
        gateMs = d.getTime();
      }
      const { starts } = planStarts(ctx.store.household, ctx.store.history, gateMs, rhoOf(ctx.store.pace));
      if (!starts.length) return refuse("Nobody has a routine yet. Tell me someone's steps first, for example: Isha showers for 8 minutes, then gets dressed.");
      const named = [...starts].sort((a, b) => a.startMs - b.startMs).map((s) => `${ctx.store.household.people.find((p) => p.id === s.personId)!.name} ${s.startMs <= now + 60_000 ? 'now' : `at ${clock(s.startMs)}`}`); // asked late, an alarm already past means: up now
      const wakes = new Set(ctx.store.household.people.filter((p) => p.steps.length).map((p) => p.wakeSec ?? WAKE_SEC));
      const allow = wakes.size === 1 ? ` That allows ${minutes([...wakes][0])} to get up.` : '';
      return say(ctx, `To leave at ${clock(gateMs)} with an 85% chance of everyone making it, set alarms for ${list(named)}.${allow} Shall I set them?`);
    },
  );

  registerAppTool(
    server,
    'tv_link',
    {
      title: 'Put the board on a TV',
      description: "Use when the customer asks how to show the board on a TV, a tablet or another screen. Returns this household's private link to open in that screen's browser. Changes nothing.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      ...out,
      _meta: { ui },
    },
    async () =>
      ctx.screenLink
        ? say(ctx, `Open this link in the browser on that screen: ${ctx.screenLink} . Keep it private: anyone with it can see your household's board.`)
        : refuse('This Doorbound server has no TV link set up. Its owner can set SCREEN_KEY.'),
  );

  registerAppTool(
    server,
    'how_accurate',
    {
      title: 'How honest the chances have been',
      description: 'Use when the customer asks whether the chances can be trusted, or how accurate Doorbound has been. Every chance it gave (at the start, and after each finished step) is checked against whether that person made the gate; this compares what it said with what happened in this household. Changes nothing.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      ...out,
      _meta: { ui },
    },
    async () => {
      const { n, bands } = honesty(ctx.store.scores);
      if (n < 10) return say(ctx, `I've checked ${n === 0 ? 'none' : `only ${n}`} of my chances against what really happened so far. Ask me again after a few more mornings.`);
      const labels = ['under 50%', '50 to 80%', '80% or more'];
      const parts = bands.flatMap((b, i) => (b.n < 5 ? [] : [`when I said ${labels[i]} (${pct(b.said)} on average), you made it ${Math.round(b.happened * b.n)} times out of ${b.n}`]));
      if (!parts.length) return say(ctx, `I've checked ${n} chances, but not enough of any one kind to say yet. Ask me again after a few more mornings.`);
      return say(ctx, `I've checked ${n} of my chances against what happened. ${parts.join('; ').replace(/^w/, 'W')}.`);
    },
  );

  registerAppTool(
    server,
    'end_departure',
    {
      title: 'End the departure',
      description: "Use when everyone has left (\"we've left\", \"we're out of the door\"), or the customer cancels the departure (left: false). Leaving counts everyone not yet marked ready as ready now, so the morning is scored by when the household really went. Clears the board; learned times are kept. Returns the board.",
      inputSchema: z.object({ left: z.boolean().optional().describe('true (the default) when everyone has gone out of the door; false when the departure is cancelled') }),
      annotations: { idempotentHint: true },
      ...out,
      _meta: { ui },
    },
    async ({ left = true }) => {
      const dep = ctx.store.departure;
      if (!dep) return refuse(NO_DEPARTURE);
      const now = ctx.now();
      // Out of the door means ready, whatever was not said; a cancelled morning is scored for nobody.
      ctx.store.departure = left ? dep.lanes.reduce((d, l) => markReady(d, l.personId, now) ?? d, dep) : { ...dep, forecasts: [] };
      commit(ctx, 'end_departure', null);
      if (!left) return say(ctx, `${dep.name} cancelled.`);
      const lateMin = Math.round((now - dep.gateMs) / 60_000);
      return say(ctx, `${dep.name} done${lateMin > 1 ? `, ${minutes(lateMin * 60)} after ${clock(dep.gateMs)}` : ', on time'}. Have a good day.`);
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
