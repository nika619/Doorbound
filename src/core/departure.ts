// A household's departure (the school run, the work run): who does what before the gate closes.
// Everything here is a pure function of the state and "now". State is immutable, so undo is
// keeping the previous object, and every screen can derive the same picture from timestamps.

import { estimate, type History } from './learn.ts';

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

export interface Task {
  /** `${forPerson}/${stepId}`: unique within a departure. */
  key: string;
  stepId: string;
  /** Whose step it is. A helper may be doing it. */
  forPerson: string;
  name: string;
  sec: number;
  state: TaskState;
  doneAtMs?: number;
  quick?: boolean;
  /** A handed-over task cannot have started before it was handed over. */
  notBeforeMs?: number;
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
  savedSec: number;
}

export interface Reroute {
  atMs: number;
  /** Revision the re-plan produced. Undo is only offered while nothing has happened since. */
  rev: number;
  changes: Change[];
  /** Seconds someone is still late after every allowed change (0 when the plan works). */
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

/** An overrunning step is assumed to need at least this much more, until someone says otherwise. */
export const GRACE_MS = 30_000;

export function startDeparture(household: Household, history: History, name: string, gateMs: number, nowMs: number): Departure {
  const lanes = household.people.map((p) => ({
    personId: p.id,
    startedAtMs: nowMs,
    tasks: p.steps.map((s) => ({ key: `${p.id}/${s.id}`, stepId: s.id, forPerson: p.id, name: s.name, sec: estimate(history, p.id, s.id, s.statedSec), state: 'todo' as const })),
  }));
  return { name, gateMs, startedAtMs: nowMs, rev: 1, lanes, reroute: null };
}

// ---------- reading a lane ----------

/** Index of the first unfinished task, or -1. O(t) for t tasks in the lane. */
export function currentIndex(lane: Lane): number {
  return lane.tasks.findIndex((t) => t.state === 'todo');
}

/** When the current task started: the moment the previous task in this lane was done. */
export function currentStartMs(lane: Lane, idx: number): number {
  let start = lane.startedAtMs;
  for (let i = idx - 1; i >= 0; i--)
    if (lane.tasks[i].state === 'done') {
      start = lane.tasks[i].doneAtMs!;
      break;
    }
  return Math.max(start, lane.tasks[idx]?.notBeforeMs ?? start);
}

export type Status = 'ready' | 'boarding' | 'ontime' | 'late';

export interface LaneView {
  personId: string;
  current: Task | null;
  next: Task | null;
  currentStartMs: number;
  readyMs: number;
  status: Status;
  /** Positive: minutes to spare. Negative: minutes late. In seconds. */
  slackSec: number;
}

/** Where everyone stands at `nowMs`. O(T) for T tasks in the departure. */
export function projectLane(lane: Lane, gateMs: number, nowMs: number): LaneView {
  const idx = currentIndex(lane);
  if (idx < 0) {
    const last = lane.tasks.findLast((t) => t.state === 'done');
    const readyMs = last?.doneAtMs ?? lane.startedAtMs;
    return { personId: lane.personId, current: null, next: null, currentStartMs: readyMs, readyMs, status: 'ready', slackSec: Math.round((gateMs - readyMs) / 1000) };
  }
  const current = lane.tasks[idx];
  const startMs = currentStartMs(lane, idx);
  let t = nowMs + Math.max(startMs + current.sec * 1000 - nowMs, GRACE_MS);
  let next: Task | null = null;
  for (let i = idx + 1; i < lane.tasks.length; i++) {
    const task = lane.tasks[i];
    if (task.state !== 'todo') continue;
    next ??= task;
    t += task.sec * 1000;
  }
  const slackSec = Math.round((gateMs - t) / 1000);
  const status: Status = slackSec < 0 ? 'late' : next === null ? 'boarding' : 'ontime';
  return { personId: lane.personId, current, next, currentStartMs: startMs, readyMs: t, status, slackSec };
}

export function project(dep: Departure, nowMs: number): LaneView[] {
  return dep.lanes.map((l) => projectLane(l, dep.gateMs, nowMs));
}

// ---------- events ----------

const bump = (dep: Departure, lanes: Lane[], keepReroute = true): Departure => ({ ...dep, lanes, rev: dep.rev + 1, reroute: keepReroute ? dep.reroute : null });
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

/** The current step is running over: plan for `extraSec` more from now. */
export function stillGoing(dep: Departure, personId: string, extraSec: number, nowMs: number): Departure | null {
  const li = laneOf(dep, personId);
  if (li < 0) return null;
  const lane = dep.lanes[li];
  const idx = currentIndex(lane);
  if (idx < 0) return null;
  const elapsedSec = Math.max(0, Math.round((nowMs - currentStartMs(lane, idx)) / 1000));
  const tasks = lane.tasks.with(idx, { ...lane.tasks[idx], sec: elapsedSec + extraSec });
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
    if (c.kind === 'quick') from.tasks[i] = { ...task, name: def.quick!.name, sec: def.quick!.sec, quick: true };
    else if (c.kind === 'later') from.tasks[i] = { ...task, state: 'later' };
    else if (c.kind === 'skip') from.tasks[i] = { ...task, state: 'skipped' };
    else {
      from.tasks.splice(i, 1);
      const to = byPerson.get(c.to!)!;
      const at = currentIndex(to);
      // Help now: straight after what the helper is doing, so it is done well before the gate.
      to.tasks.splice(at < 0 ? to.tasks.length : at + 1, 0, { ...task, sec: estimate(history, c.to!, task.stepId, def.statedSec), notBeforeMs: nowMs });
    }
  }
  return lanes;
}
