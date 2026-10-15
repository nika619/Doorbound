// A household's departure (the school run, the work run): who does what before the gate closes.
// Everything here is a pure function of the state and "now". State is immutable, so undo is
// keeping the previous object, and every screen derives the same picture from timestamps.
//
// Each step's duration is a log-normal learned from real mornings (stats.ts). A person's remaining
// morning is a sum of those, so the board can say not just "ready at 7:38" but "ready by 7:38 with
// 85% confidence, a 93% chance of making the gate".

import { keyOf, type History } from './learn.ts';
import { cdf, moments, posterior, quantile, remaining, sum, type LogNormal, type Moments } from './stats.ts';

export interface StepDef {
  id: string;
  name: string;
  statedSec: number;
  /** A faster version of the step, for example breakfast to go. */
  quick?: { name: string; sec: number };
  /** It can happen after the departure instead. */
  canWait?: boolean;
  /** It can be skipped today. */
  optional?: boolean;
  /** Other people (ids) who may do it instead. */
  helpers?: string[];
}

export interface PersonDef {
  id: string;
  name: string;
  steps: StepDef[];
}

export interface Household {
  people: PersonDef[];
}

export type TaskState = 'todo' | 'done' | 'later' | 'skipped';

export interface Task extends LogNormal {
  /** `${forPerson}/${stepId}`: unique within a departure. */
  key: string;
  stepId: string;
  /** Whose step it is. A helper may be doing it. */
  forPerson: string;
  name: string;
  state: TaskState;
  doneAtMs?: number;
  quick?: boolean;
  /** A handed-over task cannot have started before it was handed over. */
  notBeforeMs?: number;
  /** Someone said it is running over: from `fromMs`, this much more (log-normal) replaces the model. */
  extend?: LogNormal & { fromMs: number };
}

export interface Lane {
  personId: string;
  startedAtMs: number;
  tasks: Task[];
}

export type ChangeKind = 'quick' | 'handoff' | 'later' | 'skip';

export interface Change {
  kind: ChangeKind;
  taskKey: string;
  name: string;
  from: string;
  to?: string;
  /** Expected seconds saved for the person it was moved from. */
  savedSec: number;
}

export interface Reroute {
  atMs: number;
  /** Revision the re-plan produced. Undo is only offered while nothing has happened since. */
  rev: number;
  changes: Change[];
  /** Seconds the latest person is still late at the target confidence (0 when the plan works). */
  stillLateSec: number;
  /** The departure as it was, for undo. */
  before: Departure;
}

export interface Departure {
  name: string;
  gateMs: number;
  startedAtMs: number;
  rev: number;
  lanes: Lane[];
  reroute: Reroute | null;
}

/** Plan so each person is ready by the gate with at least this probability. */
export const TARGET = 0.85;
/** An overrunning step is assumed to need at least this much more, until someone says otherwise. */
export const GRACE_MS = 30_000;
/** "Still going, N more minutes": how sure that N is. */
const EXTEND_SIGMA = 0.25;

/** The learned duration of one person's step: their history, with what was said as the prior. */
export const durationOf = (history: History, personId: string, stepId: string, statedSec: number): LogNormal =>
  posterior(statedSec, history.get(keyOf(personId, stepId)));

export function startDeparture(household: Household, history: History, name: string, gateMs: number, nowMs: number): Departure {
  const lanes = household.people.map((p) => ({
    personId: p.id,
    startedAtMs: nowMs,
    tasks: p.steps.map((s) => ({ key: `${p.id}/${s.id}`, stepId: s.id, forPerson: p.id, name: s.name, state: 'todo' as const, ...durationOf(history, p.id, s.id, s.statedSec) })),
  }));
  return { name, gateMs, startedAtMs: nowMs, rev: 1, lanes, reroute: null };
}

// ---------- reading a lane ----------

/** Index of the first unfinished task, or -1. O(t) for t tasks in the lane. */
export function currentIndex(lane: Lane): number {
  return lane.tasks.findIndex((t) => t.state === 'todo');
}

/** When the current task started: when the previous task in this lane was done, or when it was handed over. */
export function currentStartMs(lane: Lane, idx: number): number {
  let start = lane.startedAtMs;
  for (let i = idx - 1; i >= 0; i--)
    if (lane.tasks[i].state === 'done') {
      start = lane.tasks[i].doneAtMs!;
      break;
    }
  return Math.max(start, lane.tasks[idx]?.notBeforeMs ?? start);
}

/** Time still to go on the current task, as mean and variance in seconds. */
export function currentRemaining(lane: Lane, idx: number, nowMs: number): Moments {
  const t = lane.tasks[idx];
  if (t.extend) return remaining(t.extend, (nowMs - t.extend.fromMs) / 1000, GRACE_MS / 1000);
  return remaining(t, (nowMs - currentStartMs(lane, idx)) / 1000, GRACE_MS / 1000);
}

/** Mean and variance of everything this lane still has to do, from now. O(t). */
export function laneMoments(lane: Lane, nowMs: number): Moments {
  const idx = currentIndex(lane);
  if (idx < 0) return { mean: 0, variance: 0 };
  const m = currentRemaining(lane, idx, nowMs);
  let mean = m.mean;
  let variance = m.variance;
  for (let i = idx + 1; i < lane.tasks.length; i++) {
    if (lane.tasks[i].state !== 'todo') continue;
    const s = moments(lane.tasks[i]);
    mean += s.mean;
    variance += s.variance;
  }
  return { mean, variance };
}

/** Probability that work with these moments, starting now, is done by the gate. */
export function onTimeProbability(m: Moments, gateMs: number, nowMs: number): number {
  const d = sum([m]);
  return d ? cdf(d, (gateMs - nowMs) / 1000) : nowMs <= gateMs ? 1 : 0;
}

export type Status = 'ready' | 'boarding' | 'ontime' | 'tight' | 'late';

export interface LaneView {
  personId: string;
  current: Task | null;
  next: Task | null;
  currentStartMs: number;
  /** Ready by this time with TARGET confidence. */
  readyMs: number;
  /** Expected (mean) ready time. */
  expectedMs: number;
  /** 10th and 90th percentile ready times: the honest spread. */
  earlyMs: number;
  lateMs: number;
  /** Chance of being ready by the gate. */
  pOnTime: number;
  status: Status;
  /** Gate minus the confident ready time, in seconds: negative means late. */
  slackSec: number;
}

/** Where a person stands at `nowMs`. O(t). */
export function projectLane(lane: Lane, gateMs: number, nowMs: number): LaneView {
  const idx = currentIndex(lane);
  if (idx < 0) {
    const last = lane.tasks.findLast((t) => t.state === 'done');
    const readyMs = last?.doneAtMs ?? lane.startedAtMs;
    return { personId: lane.personId, current: null, next: null, currentStartMs: readyMs, readyMs, expectedMs: readyMs, earlyMs: readyMs, lateMs: readyMs, pOnTime: readyMs <= gateMs ? 1 : 0, status: 'ready', slackSec: Math.round((gateMs - readyMs) / 1000) };
  }
  const m = laneMoments(lane, nowMs);
  const d = sum([m])!;
  const at = (p: number) => nowMs + quantile(d, p) * 1000;
  const next = lane.tasks.slice(idx + 1).find((t) => t.state === 'todo') ?? null;
  const pOnTime = cdf(d, (gateMs - nowMs) / 1000);
  const readyMs = at(TARGET);
  const status: Status = pOnTime < 0.5 ? 'late' : pOnTime < TARGET ? 'tight' : next === null ? 'boarding' : 'ontime';
  return {
    personId: lane.personId,
    current: lane.tasks[idx],
    next,
    currentStartMs: currentStartMs(lane, idx),
    readyMs,
    expectedMs: nowMs + m.mean * 1000,
    earlyMs: at(0.1),
    lateMs: at(0.9),
    pOnTime,
    status,
    slackSec: Math.round((gateMs - readyMs) / 1000),
  };
}

export function project(dep: Departure, nowMs: number): LaneView[] {
  return dep.lanes.map((l) => projectLane(l, dep.gateMs, nowMs));
}

/** Chance that everyone makes the gate. People's mornings are taken as independent. */
export const everyoneOnTime = (views: LaneView[]) => views.reduce((p, v) => p * v.pOnTime, 1);

// ---------- events ----------

const bump = (dep: Departure, lanes: Lane[]): Departure => ({ ...dep, lanes, rev: dep.rev + 1 });
const laneOf = (dep: Departure, personId: string) => dep.lanes.findIndex((l) => l.personId === personId);

export interface Sample {
  personId: string;
  stepId: string;
  seconds: number;
}

/**
 * The person finished what they were doing. Returns the new state and, when it is a fair
 * measurement (their own step, done the normal way), the real duration to learn from.
 */
export function markDone(dep: Departure, personId: string, nowMs: number): { dep: Departure; sample: Sample | null } | null {
  const li = laneOf(dep, personId);
  if (li < 0) return null;
  const lane = dep.lanes[li];
  const idx = currentIndex(lane);
  if (idx < 0) return null;
  const task = lane.tasks[idx];
  const startMs = currentStartMs(lane, idx);
  const tasks = lane.tasks.with(idx, { ...task, state: 'done', doneAtMs: nowMs });
  const fair = task.forPerson === personId && !task.quick;
  return {
    dep: bump(dep, dep.lanes.with(li, { ...lane, tasks })),
    sample: fair ? { personId, stepId: task.stepId, seconds: Math.round((nowMs - startMs) / 1000) } : null,
  };
}

/** The current step is running over: about `extraSec` more from now. */
export function stillGoing(dep: Departure, personId: string, extraSec: number, nowMs: number): Departure | null {
  const li = laneOf(dep, personId);
  if (li < 0) return null;
  const lane = dep.lanes[li];
  const idx = currentIndex(lane);
  if (idx < 0) return null;
  const tasks = lane.tasks.with(idx, { ...lane.tasks[idx], extend: { fromMs: nowMs, mu: Math.log(Math.max(30, extraSec)), sigma: EXTEND_SIGMA } });
  return bump(dep, dep.lanes.with(li, { ...lane, tasks }));
}

export function setGate(dep: Departure, gateMs: number): Departure {
  return { ...dep, gateMs, rev: dep.rev + 1 };
}

/** Undo the last re-plan, only if nothing has happened since; otherwise undo would lose real events. */
export function undoReroute(dep: Departure): Departure | null {
  return dep.reroute && dep.reroute.rev === dep.rev ? { ...dep.reroute.before, rev: dep.rev + 1, reroute: null } : null;
}

/** Apply a list of changes. Each change touches one task; O(T) overall. */
export function applyChanges(dep: Departure, household: Household, history: History, changes: Change[], nowMs: number): Lane[] {
  const lanes = dep.lanes.map((l) => ({ ...l, tasks: [...l.tasks] }));
  const byPerson = new Map(lanes.map((l) => [l.personId, l]));
  const stepDef = (personId: string, stepId: string) => household.people.find((p) => p.id === personId)?.steps.find((s) => s.id === stepId);
  for (const c of changes) {
    const from = byPerson.get(c.from)!;
    const i = from.tasks.findIndex((t) => t.key === c.taskKey);
    const task = from.tasks[i];
    const def = stepDef(task.forPerson, task.stepId)!;
    if (c.kind === 'quick') from.tasks[i] = { ...task, name: def.quick!.name, ...posterior(def.quick!.sec), quick: true };
    else if (c.kind === 'later') from.tasks[i] = { ...task, state: 'later' };
    else if (c.kind === 'skip') from.tasks[i] = { ...task, state: 'skipped' };
    else {
      from.tasks.splice(i, 1);
      const to = byPerson.get(c.to!)!;
      const at = currentIndex(to);
      // Help now: straight after what the helper is doing, so it is done well before the gate.
      to.tasks.splice(at < 0 ? to.tasks.length : at + 1, 0, { ...task, ...durationOf(history, c.to!, task.stepId, def.statedSec), notBeforeMs: nowMs, extend: undefined });
    }
  }
  return lanes;
}

// ---------- the runway ----------

export interface Block {
  key: string;
  name: string;
  forPerson: string;
  startMs: number;
  endMs: number;
  state: 'done' | 'current' | 'todo' | 'later';
  quick?: boolean;
  /** The step in progress has run past what was planned for it. */
  overrun?: boolean;
}

/**
 * Each task as a span of expected time, for drawing a lane: done steps where they really were, the
 * current one ending at its expected remaining time, the rest queued after it, and steps that wait
 * queued after the gate. Skipped steps are left out. O(t) for t tasks.
 */
export function laneTimeline(lane: Lane, gateMs: number, nowMs: number): Block[] {
  const out: Block[] = [];
  const idx = currentIndex(lane);
  let cursor = lane.startedAtMs;
  let after = gateMs;
  lane.tasks.forEach((t, i) => {
    const base = { key: t.key, name: t.name, forPerson: t.forPerson, quick: t.quick };
    if (t.state === 'done') {
      const startMs = Math.max(cursor, t.notBeforeMs ?? cursor);
      out.push({ ...base, startMs, endMs: Math.max(startMs, t.doneAtMs!), state: 'done' });
      cursor = Math.max(cursor, t.doneAtMs!);
    } else if (t.state === 'todo' && i === idx) {
      const startMs = currentStartMs(lane, idx);
      const endMs = Math.max(startMs, nowMs) + currentRemaining(lane, idx, nowMs).mean * 1000;
      const planned = startMs + quantile(t, TARGET) * 1000;
      out.push({ ...base, startMs, endMs, state: 'current', overrun: !!t.extend || nowMs > planned });
      cursor = endMs;
    } else if (t.state === 'todo') {
      const ms = moments(t).mean * 1000;
      out.push({ ...base, startMs: cursor, endMs: cursor + ms, state: 'todo' });
      cursor += ms;
    } else if (t.state === 'later') {
      const ms = moments(t).mean * 1000;
      out.push({ ...base, startMs: after, endMs: after + ms, state: 'later' });
      after += ms;
    }
  });
  return out;
}
