// A household's departure (the school run, the work run): who does what before the gate closes.
// Everything here is a pure function of the state and "now". State is immutable, so undo is
// keeping the previous object, and every screen derives the same picture from timestamps.
//
// Each step's duration is a log-normal learned from real mornings (stats.ts). A person's remaining
// morning is a sum of those, so the board can say not just "ready at 7:38" but "ready by 7:38 with
// 85% confidence, a 93% chance of making the gate". The steps of one person's morning share a pace
// (pace.ts): each finished step says how today is going, and the rest of their morning moves with it.

import { keyOf, statedBias, type History } from './learn.ts';
import { addPart, adjust, censor, householdPace, paceFactor, paceOf, PARTS, readings, RHO_PRIOR, total, type Pace } from './pace.ts';
import { cdf, moments, phi, posterior, PRIOR_SIGMA, quantile, remaining, sum, type LogNormal, type Moments } from './stats.ts';

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
  /** A space it needs to itself, shared with others (say "bathroom"): one person at a time, first come first served. */
  uses?: string;
}

export interface PersonDef {
  id: string;
  name: string;
  steps: StepDef[];
  /** From the alarm to starting the first step, in seconds, as they say it. Planning tomorrow uses it; default 10 minutes. */
  wakeSec?: number;
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
  /** Finished together with the rest ("I'm ready"): its own length is unknown, so nothing is learned from it. */
  untimed?: boolean;
  /** The shared space it needs (StepDef.uses). */
  uses?: string;
  /** When this person was let into that space after waiting for it: the step's clock starts then. */
  inAtMs?: number;
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
  /** How strongly one person's steps run slow or fast together in this household (pace.ts). */
  rho: number;
  /** How strongly different people's mornings run slow together (pace.ts); 0 until the household shows it. */
  kappa?: number;
  /** What this weekday usually brings to everyone's pace (pace.ts weekdayMean); 0 until the household shows one. */
  paceMean?: number;
  /** The household's planning-fallacy correction to stated times (learn.ts statedBias) when it started. */
  bias?: number;
  /** Chances given and not yet scored (score.ts). */
  forecasts?: { personId: string; p: number; atMs: number }[];
}

/** Plan so each person is ready by the gate with at least this probability. */
export const TARGET = 0.85;
/** An overrunning step is assumed to need at least this much more, until someone says otherwise. */
export const GRACE_MS = 30_000;
/** "Still going, N more minutes": how sure that N is. */
const EXTEND_SIGMA = 0.25;

/** The learned duration of one person's step: their history, with what was said as the prior. */
export const durationOf = (history: History, personId: string, stepId: string, statedSec: number, bias = 0): LogNormal =>
  posterior(statedSec * Math.exp(bias), history.get(keyOf(personId, stepId)));

/** The household's planning-fallacy correction for this history (learn.ts statedBias), for one step: from all the others. */
export const biasOf = (household: Household, history: History, leaveOut?: string) =>
  statedBias(history, household.people.flatMap((p) => p.steps.map((s) => ({ personId: p.id, stepId: s.id, statedSec: s.statedSec }))), leaveOut);

export function startDeparture(household: Household, history: History, name: string, gateMs: number, nowMs: number, rho = RHO_PRIOR, kappa = 0, paceMean = 0): Departure {
  const bias = biasOf(household, history);
  const lanes = household.people.map((p) => ({
    personId: p.id,
    startedAtMs: nowMs,
    tasks: p.steps.map((s) => ({ key: `${p.id}/${s.id}`, stepId: s.id, forPerson: p.id, name: s.name, state: 'todo' as const, ...durationOf(history, p.id, s.id, s.statedSec, biasOf(household, history, keyOf(p.id, s.id))) , ...(s.uses ? { uses: s.uses } : {}) })),
  }));
  return { name, gateMs, startedAtMs: nowMs, rev: 1, lanes, reroute: null, rho, kappa, ...(paceMean ? { paceMean } : {}), ...(bias ? { bias } : {}) };
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

/** Time still to go on the current task, as mean and variance in seconds, at today's pace. */
export function currentRemaining(lane: Lane, idx: number, nowMs: number, rho: number, pace = paceOf(lane, rho)): Moments {
  const t = lane.tasks[idx];
  if (t.extend) return remaining(t.extend, (nowMs - t.extend.fromMs) / 1000, GRACE_MS / 1000);
  return remaining(adjust(t, pace, rho), (nowMs - currentStartMs(lane, idx)) / 1000, GRACE_MS / 1000);
}

/** A step still to come, at today's pace. */
export const stepMoments = (d: LogNormal, pace: Pace, rho: number) => moments(adjust(d, pace, rho));

/** Today's pace for one lane: `before` its running step's elapsed time is known, and `ahead` of it, for the steps after. */
export interface LanePace {
  before: Pace;
  ahead: Pace;
  /** Queuing for a shared space: which, and the time until it is theirs (whoever is in, then whoever is ahead). */
  wait?: { space: string; moments: Moments };
  /** Waits expected later, at steps that will need a shared space someone else is likely to be using: where, and how long. */
  later?: { at: number; moments: Moments }[];
}

/**
 * Who is in each shared space and who is queuing, from the steps in progress: the person let in (inAtMs),
 * else whoever reached it first; the rest queue in the order they arrived. Returns, per lane, the lanes
 * ahead of it in its queue (the one inside first), or null when it is not queuing. O(P log P).
 */
export function queues(dep: Pick<Departure, 'lanes'>): (number[] | null)[] {
  const at = dep.lanes.map((l) => {
    const i = currentIndex(l);
    const t = l.tasks[i];
    return i < 0 || !t.uses ? null : { space: t.uses, in: t.inAtMs ?? -Infinity, arrived: currentStartMs(l, i) };
  });
  const out: (number[] | null)[] = dep.lanes.map(() => null);
  for (const space of new Set(at.flatMap((a) => (a ? [a.space] : [])))) {
    const users = at.flatMap((a, li) => (a?.space === space ? [li] : []));
    // Inside: the latest let in, if anyone was; else the first to arrive. Then the queue, by arrival.
    const inside = users.reduce((best, li) => (at[li]!.in > at[best]!.in || (at[li]!.in === at[best]!.in && at[li]!.arrived < at[best]!.arrived) ? li : best));
    const line = [inside, ...users.filter((li) => li !== inside).sort((a, b) => at[a]!.arrived - at[b]!.arrived)];
    line.forEach((li, k) => (out[li] = k ? line.slice(0, k) : null));
  }
  return out;
}

/** One lane on its own: its finished steps' readings, then how long the current one has run (unless it is only queuing). */
export function lanePace(lane: Lane, nowMs: number, rho: number, queuing = false, m0 = 0): LanePace {
  const before = paceOf(lane, rho, m0);
  const idx = currentIndex(lane);
  const t = lane.tasks[idx];
  return { before, ahead: idx < 0 || t.extend || queuing ? before : censor(before, t, rho, (nowMs - currentStartMs(lane, idx)) / 1000) };
}

/** Every lane, sharing the household's pace when it has one (kappa > 0); otherwise each on its own, exactly. */
export function departurePaces(dep: Pick<Departure, 'lanes' | 'rho' | 'kappa' | 'paceMean'>, nowMs: number): LanePace[] {
  const queue = queues(dep);
  let paces: LanePace[];
  if (!(dep.kappa! > 0) || dep.lanes.length < 2) paces = dep.lanes.map((l, i) => lanePace(l, nowMs, dep.rho, !!queue[i], dep.paceMean ?? 0));
  else {
    // Queuing is not evidence about anyone's pace: only steps really under way count as running.
    const running = dep.lanes.map((l, li) => {
      const i = currentIndex(l);
      return i < 0 || l.tasks[i].extend || queue[li] ? null : { d: l.tasks[i], elapsedSec: (nowMs - currentStartMs(l, i)) / 1000 };
    });
    const { before, ahead } = householdPace(dep.lanes.map(readings), running, dep.rho, dep.kappa!, dep.paceMean ?? 0);
    paces = before.map((b, i) => ({ before: b, ahead: ahead[i] }));
  }
  // The wait for a shared space: what the person inside still needs, then each whole step queued ahead.
  // Those are steps already in progress, which a re-plan never touches, so the re-planner stays exact.
  queue.forEach((ahead, li) => {
    if (!ahead) return;
    let mean = 0;
    let variance = 0;
    ahead.forEach((a, k) => {
      const l = dep.lanes[a];
      const i = currentIndex(l);
      const m = k === 0 ? currentRemaining(l, i, nowMs, dep.rho, paces[a].before) : stepMoments(l.tasks[i], paces[a].before, dep.rho);
      mean += m.mean;
      variance += m.variance;
    });
    paces[li] = { ...paces[li], wait: { space: dep.lanes[li].tasks[currentIndex(dep.lanes[li])].uses!, moments: { mean, variance } } };
  });
  anticipate(dep, nowMs, paces, queue);
  return paces;
}

/**
 * Steps that will need a shared space later. Whoever is inside and queuing now goes first; then, first come first
 * served by expected arrival, each later user waits W = max(0, F - A) for the space to be free at F, having
 * arrived at A. With F and A taken as independent normals, W's mean and variance are Clark's closed forms, and
 * its covariance with the arrival is -Var(A) P(W > 0) (Stein's lemma), which keeps the lane's spread right:
 * a late arrival waits less. The space is then free at A + W + R, R the step's own length. One upcoming
 * step per person per space. O(P t) per space.
 */
function anticipate(dep: Pick<Departure, 'lanes' | 'rho'>, nowMs: number, paces: LanePace[], queue: (number[] | null)[]): void {
  const spaces = new Set(dep.lanes.flatMap((l) => l.tasks.flatMap((t) => (t.state === 'todo' && t.uses ? [t.uses] : []))));
  for (const space of spaces) {
    // Free when everyone inside or queuing now is done.
    let free: Moments | null = null;
    const line = dep.lanes.flatMap((l, li) => (l.tasks[currentIndex(l)]?.uses === space ? [li] : [])).sort((a, b) => (queue[a]?.length ?? 0) - (queue[b]?.length ?? 0));
    for (const li of line) {
      const l = dep.lanes[li];
      const i = currentIndex(l);
      const m = queue[li] ? { mean: paces[li].wait!.moments.mean + stepMoments(l.tasks[i], paces[li].before, dep.rho).mean, variance: paces[li].wait!.moments.variance + stepMoments(l.tasks[i], paces[li].before, dep.rho).variance } : currentRemaining(l, i, nowMs, dep.rho, paces[li].before);
      free = m;
    }
    // Later users, in order of when they are expected to get there.
    const later = dep.lanes.flatMap((l, li) => {
      const i = currentIndex(l);
      if (i < 0 || l.tasks[i].uses === space) return [];
      const at = l.tasks.findIndex((t, k) => k > i && t.state === 'todo' && t.uses === space);
      if (at < 0) return [];
      const acc = lanePart({ ...l, tasks: l.tasks.slice(0, at) }, nowMs, dep.rho, paces[li]).acc;
      return [{ li, at, arrive: total(acc, dep.rho * paces[li].ahead.v), own: stepMoments(l.tasks[at], paces[li].ahead, dep.rho) }];
    });
    later.sort((a, b) => a.arrive.mean - b.arrive.mean);
    for (const u of later) {
      let w: Moments = { mean: 0, variance: 0 };
      if (free) {
        const mu = free.mean - u.arrive.mean;
        const sd = Math.sqrt(free.variance + u.arrive.variance) || 1e-9;
        const a = mu / sd;
        const pdf = Math.exp(-a * a / 2) / Math.sqrt(2 * Math.PI);
        const p = phi(a);
        const ew = mu * p + sd * pdf;
        const ew2 = (mu * mu + sd * sd) * p + mu * sd * pdf;
        // The wait's own variance, plus twice its covariance with the arrival already in the lane's sum.
        w = { mean: ew, variance: Math.max(0, ew2 - ew * ew) - 2 * u.arrive.variance * p };
      }
      paces[u.li] = { ...paces[u.li], later: [...(paces[u.li].later ?? []), { at: u.at, moments: w }] };
      free = { mean: u.arrive.mean + w.mean + u.own.mean, variance: Math.max(0, u.arrive.variance + w.variance + u.own.variance) };
    }
  }
}

/**
 * How strongly the rest of the step in progress moves with the pace, as the sigma a whole step would need
 * for the same covariance with the steps after it: d E[rest | Z] / dZ over (mean sqrt(rho)), the delta
 * method, exact for a step that has only just started. 0 when it is on someone's say-so ("still going").
 */
function loading(lane: Lane, idx: number, nowMs: number, rho: number, ahead: Pace, mean: number): number {
  const t = lane.tasks[idx];
  if (rho <= 0 || t.extend || mean <= 0) return 0;
  const e = (nowMs - currentStartMs(lane, idx)) / 1000;
  const at = (z: number) => remaining({ mu: t.mu + t.sigma * Math.sqrt(rho) * z, sigma: t.sigma * Math.sqrt(1 - rho) }, e, GRACE_MS / 1000).mean;
  const h = 1e-3;
  return Math.max(0, (at(ahead.z + h) - at(ahead.z - h)) / (2 * h) / (mean * Math.sqrt(rho)));
}

/**
 * Everything this lane still has to do, from now, as the running sums of pace.ts, with today's pace for
 * the steps to come and the covariance factor c it leaves. O(t).
 */
export function lanePart(lane: Lane, nowMs: number, rho: number, lp = lanePace(lane, nowMs, rho)): { acc: Float64Array; c: number; pace: Pace } {
  const acc = new Float64Array(PARTS);
  const { before, ahead: pace } = lp;
  const idx = currentIndex(lane);
  if (idx >= 0 && lp.wait) {
    // Queuing: first the wait, then the whole step, not yet begun.
    addPart(acc, lp.wait.moments, 0);
    addPart(acc, stepMoments(lane.tasks[idx], before, rho), lane.tasks[idx].sigma);
  } else if (idx >= 0) {
    const cur = currentRemaining(lane, idx, nowMs, rho, before); // exact as it is: X | X > elapsed under the readings
    addPart(acc, cur, loading(lane, idx, nowMs, rho, pace, cur.mean));
  }
  if (idx >= 0) {
    for (let i = idx + 1; i < lane.tasks.length; i++) {
      const t = lane.tasks[i];
      if (t.state === 'todo') addPart(acc, stepMoments(t, pace, rho), t.sigma);
    }
    for (const w of lp.later ?? []) if (w.at < lane.tasks.length) addPart(acc, w.moments, 0);
  }
  return { acc, c: rho * pace.v, pace };
}

/** Mean and variance of everything this lane still has to do, from now. O(t). */
export function laneMoments(lane: Lane, nowMs: number, rho: number, lp?: LanePace): Moments {
  const { acc, c } = lanePart(lane, nowMs, rho, lp);
  return total(acc, c);
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
  /** Today's pace against a usual morning: 0.2 means this person's steps are running about 20% long. */
  pace: number;
  /**
   * When the step in progress should be done: its start plus its usual length at today's pace, or what was
   * said when it ran over. Fixed while the step runs, so a countdown to it ticks down ("3 min left").
   */
  stepEndMs: number;
  /** Queuing for this shared space instead of doing the step. */
  waitingFor?: string;
}

/** Where a person stands at `nowMs`. O(t). */
export function projectLane(lane: Lane, gateMs: number, nowMs: number, rho: number, lp = lanePace(lane, nowMs, rho)): LaneView {
  const idx = currentIndex(lane);
  const { acc, c, pace: p } = lanePart(lane, nowMs, rho, lp);
  // Today's pace, once there is something to go on: a finished step, or what this weekday usually brings.
  const pace = p.n || p.z ? paceFactor(p, rho, lane.tasks.reduce((a, t) => a + t.sigma, 0) / lane.tasks.length) : 0;
  if (idx < 0) {
    const last = lane.tasks.findLast((t) => t.state === 'done');
    const readyMs = last?.doneAtMs ?? lane.startedAtMs;
    return { personId: lane.personId, current: null, next: null, currentStartMs: readyMs, readyMs, expectedMs: readyMs, earlyMs: readyMs, lateMs: readyMs, pOnTime: readyMs <= gateMs ? 1 : 0, status: 'ready', slackSec: Math.round((gateMs - readyMs) / 1000), pace, stepEndMs: readyMs };
  }
  const m = total(acc, c);
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
    pace,
    stepEndMs: lp.wait ? nowMs + (lp.wait.moments.mean + Math.exp(adjust(lane.tasks[idx], lp.before, rho).mu)) * 1000 : stepEnd(lane, idx, rho, lp.before),
    ...(lp.wait ? { waitingFor: lp.wait.space } : {}),
  };
}

/** The step in progress's target end: started plus its median at today's pace (or as said, if running over). */
function stepEnd(lane: Lane, idx: number, rho: number, before: Pace): number {
  const t = lane.tasks[idx];
  if (t.extend) return t.extend.fromMs + Math.exp(t.extend.mu) * 1000;
  return currentStartMs(lane, idx) + Math.exp(adjust(t, before, rho).mu) * 1000;
}

export function project(dep: Departure, nowMs: number): LaneView[] {
  const paces = departurePaces(dep, nowMs);
  return dep.lanes.map((l, i) => projectLane(l, dep.gateMs, nowMs, dep.rho, paces[i]));
}

/**
 * Chance that everyone makes the gate: the product of each person's. When the household shares a pace
 * (kappa > 0) their mornings are linked positively, so the true chance is at least this (Harris-FKG).
 */
export const everyoneOnTime = (views: LaneView[]) => views.reduce((p, v) => p * v.pOnTime, 1);

// ---------- events ----------

const bump = (dep: Departure, lanes: Lane[]): Departure => ({ ...dep, lanes, rev: dep.rev + 1 });
const laneOf = (dep: Departure, personId: string) => dep.lanes.findIndex((l) => l.personId === personId);

export interface Sample {
  personId: string;
  stepId: string;
  seconds: number;
  /** The measured time was too far off to be the step itself (a forgotten or doubled "done"), so it was capped. */
  capped?: 'long' | 'short';
}

/** Learning takes a step's time only within this many sigmas (log scale) of its model; beyond, it is capped there. */
const CAP_SIGMA = 2.5;

/**
 * A forgotten "done" turns a ten-minute shower into three hours, and one such sample would skew the step for
 * nine mornings. So the time learned is capped at CAP_SIGMA sigmas of the step's model (sigma at least the
 * prior's, so a young model can still move), unless someone said it was running over: then a long time is real.
 */
function capped(d: LogNormal, seconds: number, confirmedLong: boolean): Pick<Sample, 'seconds' | 'capped'> {
  const s = Math.max(d.sigma, PRIOR_SIGMA) * CAP_SIGMA;
  const hi = Math.exp(d.mu + s);
  const lo = Math.exp(d.mu - s);
  if (seconds > hi && !confirmedLong) return { seconds: Math.round(hi), capped: 'long' };
  if (seconds < lo) return { seconds: Math.max(1, Math.round(lo)), capped: 'short' };
  return { seconds };
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
  const done = bump(dep, dep.lanes.with(li, { ...lane, tasks }));
  return {
    dep: task.uses ? admit(done, task.uses, nowMs) : done,
    sample: fair ? { personId, stepId: task.stepId, ...capped(task, Math.round((nowMs - startMs) / 1000), !!task.extend) } : null,
  };
}

/** A shared space was just freed: the next in its queue goes in now, and their step's clock starts now. */
function admit(dep: Departure, space: string, nowMs: number): Departure {
  const q = queues(dep);
  const li = dep.lanes.findIndex((l, i) => !q[i] && l.tasks[currentIndex(l)]?.uses === space);
  if (li < 0) return dep;
  const lane = dep.lanes[li];
  const k = currentIndex(lane);
  const t = lane.tasks[k];
  if (t.inAtMs !== undefined) return dep;
  return { ...dep, lanes: dep.lanes.with(li, { ...lane, tasks: lane.tasks.with(k, { ...t, inAtMs: nowMs, notBeforeMs: Math.max(t.notBeforeMs ?? nowMs, nowMs) }) }) };
}

/** "I'm ready": everything the person had left is done now. Untimed, so nothing is learned from it. */
export function markReady(dep: Departure, personId: string, nowMs: number): Departure | null {
  const li = laneOf(dep, personId);
  if (li < 0 || currentIndex(dep.lanes[li]) < 0) return null;
  const lane = dep.lanes[li];
  const space = lane.tasks[currentIndex(lane)].uses;
  const tasks = lane.tasks.map((t) => (t.state === 'todo' ? { ...t, state: 'done' as const, doneAtMs: nowMs, untimed: true } : t));
  const done = bump(dep, dep.lanes.with(li, { ...lane, tasks }));
  return space ? admit(done, space, nowMs) : done;
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
  return { ...dep, gateMs, rev: dep.rev + 1, forecasts: [] }; // forecasts were about the old gate
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
      to.tasks.splice(at < 0 ? to.tasks.length : at + 1, 0, { ...task, ...durationOf(history, c.to!, task.stepId, def.statedSec, dep.bias), notBeforeMs: nowMs, extend: undefined });
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
  /** Queuing for this shared space: the block starts when it is expected to be free. */
  waitingFor?: string;
}

/**
 * Each task as a span of expected time, for drawing a lane: done steps where they really were, the
 * current one ending at its expected remaining time, the rest queued after it, and steps that wait
 * queued after the gate, all at today's pace. Skipped steps are left out. O(t) for t tasks.
 */
export function laneTimeline(lane: Lane, gateMs: number, nowMs: number, rho: number, lp = lanePace(lane, nowMs, rho)): Block[] {
  const out: Block[] = [];
  const idx = currentIndex(lane);
  const { before, ahead: pace } = lp;
  let cursor = lane.startedAtMs;
  let after = gateMs;
  lane.tasks.forEach((t, i) => {
    const base = { key: t.key, name: t.name, forPerson: t.forPerson, quick: t.quick };
    if (t.state === 'done') {
      const startMs = Math.max(cursor, t.notBeforeMs ?? cursor);
      out.push({ ...base, startMs, endMs: Math.max(startMs, t.doneAtMs!), state: 'done' });
      cursor = Math.max(cursor, t.doneAtMs!);
    } else if (t.state === 'todo' && i === idx && lp.wait) {
      const startMs = nowMs + lp.wait.moments.mean * 1000;
      const endMs = startMs + stepMoments(t, before, rho).mean * 1000;
      out.push({ ...base, startMs, endMs, state: 'current', waitingFor: lp.wait.space });
      cursor = endMs;
    } else if (t.state === 'todo' && i === idx) {
      const startMs = currentStartMs(lane, idx);
      const endMs = Math.max(startMs, nowMs) + currentRemaining(lane, idx, nowMs, rho, before).mean * 1000;
      const planned = startMs + quantile(t, TARGET) * 1000;
      out.push({ ...base, startMs, endMs, state: 'current', overrun: !!t.extend || nowMs > planned });
      cursor = endMs;
    } else if (t.state === 'todo') {
      cursor += (lp.later?.find((w) => w.at === i)?.moments.mean ?? 0) * 1000; // waiting for a shared space first
      const ms = stepMoments(t, pace, rho).mean * 1000;
      out.push({ ...base, startMs: cursor, endMs: cursor + ms, state: 'todo' });
      cursor += ms;
    } else if (t.state === 'later') {
      const ms = stepMoments(t, pace, rho).mean * 1000;
      out.push({ ...base, startMs: after, endMs: after + ms, state: 'later' });
      after += ms;
    }
  });
  return out;
}
