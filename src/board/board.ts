// The departure board. Inside Alexa+ (an MCP App) it talks through the host; opened directly on a
// TV it reads /api/board. It derives everything from the same core functions as the server, so a
// screen only needs the state and the time.
//
// Performance: DOM built once per person and per step and reused. Per frame: one transform (the
// "now" line). Per second: text and geometry that actually changed. On a re-plan: blocks glide to
// their new place (FLIP from positions we already hold, so no layout reads).

import { departurePaces, everyoneOnTime, laneMoments, laneTimeline, projectLane, type Change, type Departure, type Lane, type LaneView } from '../core/departure.ts';
import { DEMO_MORNING, demoStep, household as demoHousehold, learnedHistory } from '../core/fixtures.ts';
import { insights } from '../core/learn.ts';
import { quantile, sum } from '../core/stats.ts';
import { Bridge, windowPort } from './bridge.ts';

// ---------- data ----------

interface Dep {
  name: string;
  gateMs: number;
  startedAtMs: number;
  rev: number;
  lanes: Lane[];
  rho: number;
  kappa?: number;
  paceMean?: number;
  bias?: number;
  reroute: { atMs: number; changes: Change[]; stillLateSec: number; canUndo: boolean } | null;
}
interface Board {
  rev: number;
  serverNowMs: number;
  clockRate: number;
  unchanged?: boolean;
  people?: { id: string; name: string }[];
  departure?: Dep | null;
  insights?: { person: string; step: string; statedSec: number; learnedSec: number }[];
}
const isBoard = (x: unknown): x is Board => !!x && typeof x === 'object' && typeof (x as Board).rev === 'number' && typeof (x as Board).serverNowMs === 'number';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // never innerHTML: names come from people
  parent?.append(e);
  return e;
}
const setText = (e: HTMLElement, t: string) => {
  if (e.textContent !== t) e.textContent = t;
};
/** Append `text` word by word, each word revealed `from` steps of 60 ms later than the first. Returns the next step. */
function words(into: HTMLElement, text: string, from = 0): number {
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) into.append(part);
    else el('span', 'w', into, part).style.setProperty('--i', String(from++));
  }
  return from;
}
/** Plain words with one italic serif accent, the board's voice: "The <em>school run</em>". Revealed when it changes. */
function accent(e: HTMLElement, before: string, em: string, after = '') {
  const key = `${before}|${em}|${after}`;
  if (e.dataset.key === key) return;
  e.dataset.key = key;
  const m = el('em', '');
  e.replaceChildren();
  const i = words(e, before);
  e.append(m);
  words(e, after, words(m, em, i));
}
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
/** A chance as a person reads it: never a certain 0% or 100% while anything is left to do. */
const pct = (p: number) => `${Math.min(99, Math.max(1, Math.round(p * 100)))}%`;

// ---------- clock: the server's time, carried forward locally between syncs ----------

let syncPerf = performance.now();
let syncServer = Date.now();
let rate = 1;
const now = () => syncServer + (performance.now() - syncPerf) * rate;
let synced = false;
function syncClock(serverMs: number, sentPerf: number) {
  if (!Number.isFinite(serverMs)) return;
  const mid = (sentPerf + performance.now()) / 2; // the server stamped its time somewhere in the round trip
  const predicted = syncServer + (mid - syncPerf) * rate;
  const drift = serverMs - predicted;
  syncPerf = mid;
  // Small corrections are absorbed gently so the "now" line never twitches; the first sync and big ones jump.
  syncServer = predicted + (!synced || Math.abs(drift) > 250 ? drift : drift * 0.2);
  synced = true;
}

// ---------- sound: a flap clatter and a chime on a re-route, once someone has touched the screen ----------

let audio: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let soundOn = false; // off until someone switches it on: a kitchen screen should not surprise anyone
function unlock() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    if (!noise) {
      // 12 ms of decaying noise: the slap of one flap
      noise = audio.createBuffer(1, Math.floor(audio.sampleRate * 0.012), audio.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
    }
  } catch {
    audio = null; // no audio here (or not allowed): the board is silent, nothing else changes
  }
}
const live = () => (audio && noise && soundOn && audio.state === 'running' ? audio : null);
/** `n` flaps falling 20 ms apart, as the letters do on screen. */
function clatter(n: number) {
  const a = live();
  if (!a) return;
  for (let i = 0; i < Math.min(n, 10); i++) {
    const src = a.createBufferSource();
    const gain = a.createGain();
    const band = a.createBiquadFilter();
    src.buffer = noise;
    band.type = 'bandpass';
    band.frequency.value = 1800 + Math.random() * 900;
    gain.gain.value = 0.05;
    src.connect(band).connect(gain).connect(a.destination);
    src.start(a.currentTime + i * 0.02);
  }
}
/** Two soft notes, rising: something on the board changed for you. */
/** A short line said aloud, only with the sound on and where the screen can speak; a chime alone otherwise. */
function speak(text: string) {
  if (!live() || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(text), { rate: 0.95 }));
}

function chime() {
  const a = live();
  if (!a) return;
  [659.25, 987.77].forEach((hz, i) => {
    const o = a.createOscillator();
    const g = a.createGain();
    const t = a.currentTime + i * 0.14;
    o.frequency.value = hz;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + 1);
  });
}

// ---------- split-flap ----------

/** One half of a letter: the top or bottom half of `ch`. */
function half(cls: string, ch: string) {
  const h = el('span', cls);
  el('span', '', h, ch);
  return h;
}

class Flap {
  readonly root = el('span', 'flap');
  private chars: string[];
  /** @param quiet no flip and no clatter: for numbers that tick over on their own */
  constructor(
    private readonly width: number,
    private readonly quiet = false,
  ) {
    this.chars = Array(width).fill(' ');
    this.root.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < width; i++) el('span', 'cell blank', this.root).append(half('h t', ' '), half('h b', ' '));
  }
  set(text: string, tone: string, align: 'left' | 'right' = 'left') {
    if (this.root.dataset.tone !== tone) this.root.dataset.tone = tone;
    const t = text.toUpperCase().slice(0, this.width);
    const next = align === 'left' ? t.padEnd(this.width) : t.padStart(this.width);
    let changed = 0;
    for (let i = 0; i < this.width; i++) {
      if (next[i] === this.chars[i]) continue;
      this.chars[i] = next[i];
      const cell = this.root.children[i] as HTMLElement;
      const [top, bottom] = cell.children as unknown as [HTMLElement, HTMLElement];
      const old = top.textContent ?? ' ';
      cell.classList.toggle('blank', next[i] === ' ');
      top.firstElementChild!.textContent = next[i];
      if (reduced.matches || this.quiet) bottom.firstElementChild!.textContent = next[i];
      else {
        // The old top half falls away, then the new bottom half swings down over the old one.
        // Fresh elements start their own animations: no forced reflow to restart one.
        const fall = half('h t fall', old);
        const land = half('h b land', next[i]);
        fall.style.animationDelay = `${changed * 20}ms`;
        land.style.animationDelay = `${150 + changed * 20}ms`;
        land.addEventListener(
          'animationend',
          () => {
            bottom.firstElementChild!.textContent = top.textContent;
            fall.remove();
            land.remove();
          },
          { once: true },
        );
        cell.append(fall, land);
      }
      changed++;
    }
    if (!this.quiet) clatter(changed);
  }
}

// ---------- the board ----------

/** The demo morning, acted out in the page by the same core, with no server: for the story page and a public preview. */
const replayMode = window.name === 'replay' || location.hash === '#replay';
let bridge = window.parent !== window && !replayMode ? new Bridge(windowPort()) : null;
const screenKey = new URLSearchParams(location.hash.slice(1)).get('k'); // the fragment never reaches a server log
let board: Board | null = null;

interface Row {
  li: HTMLLIElement;
  sr: HTMLElement;
  now: Flap;
  then: HTMLElement;
  status: Flap;
  chance: Flap;
  curve: SVGSVGElement;
  area: SVGPathElement;
  line: SVGPathElement;
  gate: SVGLineElement;
  tone: string;
  ready: HTMLElement;
  done: HTMLButtonElement;
  label: HTMLElement;
}
interface Blk {
  e: HTMLDivElement;
  x: number;
  y: number;
  w: number;
  html: string;
  cls: string;
}
interface Band {
  e: HTMLDivElement;
  tick: HTMLElement;
}
const rows = new Map<string, Row>();
const blocks = new Map<string, Blk>();
const bands = new Map<string, Band>();
const laneNames = new Map<string, HTMLElement>();
let scale = { x0: 0, x1: 1, px: 1 };
/** Runway lane height in board pixels; set by fit() for the size of the household. */
let laneH = 70;

/**
 * Three people fill the board at full size. More share the same space: rows and lanes shrink
 * together, and type and flaps with them, so eight people still fit on one screen.
 */
function fit(n: number) {
  const SPACE = 570; // what rows and lanes get together at 1080p: three people fill it at full size
  const row = Math.min(116, Math.floor((0.62 * SPACE) / n));
  laneH = Math.min(70, Math.floor((0.38 * SPACE) / n));
  const b = $('board');
  b.style.setProperty('--row', `${row}px`);
  b.style.setProperty('--fs', String(Math.min(1, (row - 10) / 56).toFixed(3)));
  b.style.setProperty('--lane', `${laneH}px`);
  b.style.setProperty('--blk', `${Math.round(laneH * 0.72)}px`);
  b.style.setProperty('--n', String(n));
  b.classList.toggle('dense', row < 90);
}

const nameOf = (id: string) => board?.people?.find((p) => p.id === id)?.name ?? id;

/** What the status flap says, and its tone. */
function statusOf(v: LaneView, dep: Dep, t: number): [string, string] {
  const departed = t >= dep.gateMs;
  if (v.status === 'ready') return departed ? ['DEPARTED', 'done'] : ['READY', 'done'];
  if (departed) return ['LEFT LATE', 'late'];
  if (v.status === 'late') return [`DELAYED +${Math.max(1, Math.round(-v.slackSec / 60))}`, 'late'];
  if (v.status === 'tight') return ['TIGHT', 'tight'];
  return v.status === 'boarding' ? ['BOARDING', 'board'] : ['ON TIME', 'ok'];
}
/**
 * When this person is likely to be ready: the density of their remaining time, from now (left) on,
 * filled up to the gate. The filled share of the curve is their chance. Each curve is scaled to its own
 * peak: the shape and the gate's place in it are what matter.
 */
function drawCurve(r: Row, d: { mu: number; sigma: number } | null, gateSec: number, tone: string) {
  if (r.curve.dataset.tone !== tone) r.curve.dataset.tone = tone;
  if (!d) {
    r.area.setAttribute('d', '');
    r.line.setAttribute('d', 'M0 45 H120');
    r.gate.style.display = 'none';
    return;
  }
  const xMax = Math.max(gateSec * 1.3, quantile(d, 0.995), 60);
  const f = (x: number) => (x <= 0 ? 0 : Math.exp(-((Math.log(x) - d.mu) ** 2) / (2 * d.sigma ** 2)) / x);
  const N = 60;
  const ys: number[] = [];
  for (let i = 0; i <= N; i++) ys.push(f((xMax * i) / N));
  const peak = Math.max(...ys) || 1;
  const pt = (i: number) => `${((120 * i) / N).toFixed(1)} ${(45 - (40 * ys[i]) / peak).toFixed(1)}`;
  let path = `M${pt(0)}`;
  for (let i = 1; i <= N; i++) path += ` L${pt(i)}`;
  r.line.setAttribute('d', path);
  const g = Math.max(0, Math.min(N, Math.floor((gateSec / xMax) * N)));
  let fill = 'M0 45';
  for (let i = 0; i <= g; i++) fill += ` L${pt(i)}`;
  r.area.setAttribute('d', `${fill} L${((120 * g) / N).toFixed(1)} 45 Z`);
  const gx = ((120 * gateSec) / xMax).toFixed(1);
  r.gate.style.display = '';
  r.gate.setAttribute('x1', gx);
  r.gate.setAttribute('x2', gx);
}

const SWEEP: Record<string, string> = { ok: '#8fdcaa26', tight: '#ffb54730', late: '#ff6b4a33' };
/** A band of light across a row, in the colour of what just happened to it. */
function sweep(li: HTMLElement, tone: string) {
  if (reduced.matches) return;
  li.style.setProperty('--sweep', SWEEP[tone] ?? '#ffb54726');
  li.classList.remove('sweep');
  void li.offsetWidth; // shortcut: restarts the sweep with one reflow; rare (a change of standing or a re-route)
  li.classList.add('sweep');
}

/** A re-route, choreographed: an amber scan crosses the runway, the people it touches light up. */
function choreograph(rr: { changes: Change[] }) {
  if (reduced.matches) return;
  const layer = $('layer');
  let scan = layer.querySelector<HTMLElement>('.scan');
  if (!scan) scan = el('div', 'scan', layer);
  scan.animate(
    [
      { transform: 'translateX(-160px)', opacity: 0 },
      { opacity: 1, offset: 0.15 },
      { opacity: 1, offset: 0.8 },
      { transform: `translateX(${layer.clientWidth || 1646}px)`, opacity: 0 },
    ],
    { duration: 1100, easing: 'cubic-bezier(.16,1,.3,1)' },
  );
  const touched = new Set(rr.changes.flatMap((c) => [c.from, c.to].filter(Boolean) as string[]));
  for (const id of touched) {
    const r = rows.get(id);
    if (r) setTimeout(() => sweep(r.li, 'tight'), 180);
  }
}

/** The tone of a chance: what the curve and the numbers are coloured by. */
const SEVERITY: Record<string, number> = { done: 0, ok: 1, tight: 2, late: 3 };
/** Steps already flagged as running over: each is announced once. */
const nudged = new Set<string>();
const toneOf = (v: LaneView) => (v.status === 'ready' ? 'done' : v.status === 'late' ? 'late' : v.status === 'tight' ? 'tight' : 'ok');

function rowFor(id: string, index: number): Row {
  let r = rows.get(id);
  if (r) return r;
  const li = el('li', 'row', $('rows'));
  li.style.animationDelay = `${index * 90}ms`;
  const sr = el('span', 'sr', li);
  const label = el('span', 'name', li);
  label.setAttribute('aria-hidden', 'true');
  const doing = el('div', 'doing', li);
  doing.setAttribute('aria-hidden', 'true');
  const now = new Flap(17);
  doing.append(now.root);
  const then = el('span', 'then', doing);
  const status = new Flap(10);
  li.append(status.root);
  const chanceBox = el('div', 'chance', li);
  chanceBox.setAttribute('aria-hidden', 'true');
  const chance = new Flap(3, true);
  chance.root.classList.add('pct');
  chanceBox.append(chance.root);
  const svg = (tag: string, parent: Element) => parent.appendChild(document.createElementNS('http://www.w3.org/2000/svg', tag));
  const curve = svg('svg', chanceBox) as SVGSVGElement;
  curve.setAttribute('class', 'curve');
  curve.setAttribute('viewBox', '0 0 120 46');
  curve.setAttribute('preserveAspectRatio', 'none');
  const area = svg('path', curve) as SVGPathElement;
  area.setAttribute('class', 'area');
  const line = svg('path', curve) as SVGPathElement;
  line.setAttribute('class', 'line');
  const gate = svg('line', curve) as SVGLineElement;
  gate.setAttribute('class', 'gate');
  gate.setAttribute('y1', '0');
  gate.setAttribute('y2', '46');
  const ready = el('span', 'ready', li);
  ready.setAttribute('aria-hidden', 'true');
  const done = el('button', 'done', li) as HTMLButtonElement;
  done.type = 'button';
  const setDone = (armedNow: boolean) => {
    done.textContent = armedNow ? 'TAP AGAIN' : 'DONE';
    done.setAttribute('aria-label', `${armedNow ? 'Tap again to confirm' : 'Done'}: ${nameOf(id)}`);
  };
  setDone(false);
  done.hidden = replayMode; // inside Alexa+ a tap; on a TV, the remote (OK twice); the replay is only a replay
  let armed: ReturnType<typeof setTimeout> | undefined;
  done.addEventListener('click', () => {
    // Two taps, so a brush against the screen never marks a step done.
    if (!armed) {
      done.classList.add('arm');
      setDone(true);
      armed = setTimeout(() => {
        armed = undefined;
        done.classList.remove('arm');
        setDone(false);
      }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = undefined;
    done.classList.remove('arm');
    setDone(false);
    void act('step_done', { person: nameOf(id) }, id);
  });
  r = { li, sr, now, then, status, chance, curve, area, line, gate, tone: '', ready, done, label };
  rows.set(id, r);
  return r;
}

/** Rebuild what depends on the structure: who is on the board and where every step sits. */
function structure() {
  const dep = board?.departure;
  const people = board?.people ?? [];
  const hasDep = !!dep && dep.lanes.length > 0;
  $('table').hidden = !people.length;
  $('runway').hidden = !hasDep;
  $('when').hidden = !hasDep;
  $('empty').hidden = hasDep;
  $('ghost').hidden = !hasDep;
  setText($('eyebrow'), hasDep ? 'DOORBOUND · TODAY' : 'DOORBOUND');
  if (dep) accent($('title'), 'The ', dep.name.toLowerCase());
  else accent($('title'), people.length ? 'The ' : '', people.length ? 'next departure' : 'Doorbound');
  if (people.length) accent($('emptyBig'), 'Ready when ', 'you are', '.');
  else accent($('emptyBig'), 'Tell Alexa your ', 'mornings', '.');
  setText(
    $('emptySay'),
    people.length
      ? 'Say: "Alexa, start the school run. We leave at 7:40."'
      : 'For example: "Alexa, Isha showers for 8 minutes, then gets dressed for 6, then has breakfast." Doorbound learns how long things really take, and keeps everyone on time.',
  );

  fit(Math.max(1, dep?.lanes.length ?? people.length));

  // Rows, in household order; people who left the household are removed.
  const ids = new Set(people.map((p) => p.id));
  for (const [id, r] of rows) if (!ids.has(id)) (r.li.remove(), rows.delete(id));
  people.forEach((p, i) => {
    const r = rowFor(p.id, i);
    setText(r.label, p.name.toUpperCase());
    $('rows').append(r.li); // re-append keeps order; a no-op for the browser when already in place
  });
  if (!dep) {
    for (const p of people) {
      const r = rows.get(p.id)!;
      r.now.set('', 'done');
      setText(r.then, '');
      r.status.set('SCHEDULED', 'done');
      r.chance.set('', 'done');
      drawCurve(r, null, 0, 'done');
      setText(r.ready, '');
      setText(r.sr, `${p.name}: scheduled.`);
    }
    for (const b of blocks.values()) b.e.remove();
    blocks.clear();
    for (const b of bands.values()) b.e.remove();
    bands.clear();
    return;
  }

  // Runway scale: fixed for the whole departure so nothing slides about. Wide enough for the late end of everyone's spread.
  const t = now();
  const paces = departurePaces(dep, t);
  const all = dep.lanes.flatMap((l, i) => laneTimeline(l, dep.gateMs, t, dep.rho, paces[i]));
  const spread = dep.lanes.map((l, i) => projectLane(l, dep.gateMs, t, dep.rho, paces[i]).lateMs);
  const x0 = Math.min(dep.startedAtMs, ...all.map((b) => b.startMs)) - 60_000;
  const x1 = Math.max(dep.gateMs + 8 * 60_000, ...all.map((b) => b.endMs), ...spread) + 60_000;
  const width = $('layer').clientWidth || 1646;
  scale = { x0, x1, px: width / (x1 - x0) };
  $('gateline').style.transform = `translateX(${(dep.gateMs - x0) * scale.px}px)`;
  setText($('gatelabel'), `GATE ${hhmm(dep.gateMs)}`);
  for (const tick of document.querySelectorAll('.tick')) tick.remove();
  for (let m = Math.ceil(x0 / 300_000) * 300_000; m <= x1; m += 300_000) {
    if (Math.abs(m - dep.gateMs) * scale.px < 150) continue; // the gate label speaks for that spot
    const tk = el('span', 'tick', $('layer'), hhmm(m));
    tk.style.left = `${(m - x0) * scale.px}px`;
  }
  dep.lanes.forEach((lane, i) => {
    let n = laneNames.get(lane.personId);
    if (!n) laneNames.set(lane.personId, (n = el('div', 'lane-name', $('lanes'))));
    setText(n, nameOf(lane.personId).toUpperCase());
    n.style.top = `${i * laneH}px`;
  });
  second(true);
}

/** Once a second (and after every change): text, statuses and the geometry that moves. */
function second(animate = false) {
  const dep = board?.departure;
  if (!dep) return;
  const t = now();
  const departed = t >= dep.gateMs;
  const minsLeft = Math.max(0, Math.ceil((dep.gateMs - t) / 60_000));
  setText($('clock'), hhmm(t));
  setText($('gate'), hhmm(dep.gateMs));
  setText($('gateK'), departed ? 'DEPARTED' : 'LEAVE');
  setText($('left'), departed ? 'CLOSED' : `${minsLeft} MIN`);
  const ghost = $('ghost');
  const g = departed ? '' : String(minsLeft);
  if (ghost.dataset.key !== g) {
    ghost.dataset.key = g;
    ghost.replaceChildren();
    words(ghost, g);
  }

  const seen = new Set<string>();
  const late: string[] = [];
  const views: LaneView[] = [];
  const moved = new Set((dep.reroute?.changes ?? []).filter((c) => c.kind !== 'later').map((c) => c.taskKey));
  const waits = new Set((dep.reroute?.changes ?? []).filter((c) => c.kind === 'later').map((c) => c.taskKey));
  const paces = departurePaces(dep, t); // the household's pace, shared by every row as on the server
  dep.lanes.forEach((lane, li) => {
    const v = projectLane(lane, dep.gateMs, t, dep.rho, paces[li]);
    views.push(v);
    const r = rows.get(lane.personId);
    const [status, tone] = statusOf(v, dep, t);
    const chanceTone = toneOf(v);
    if (r) {
      r.now.set(v.current?.name ?? (v.status === 'ready' ? 'Ready to go' : ''), tone === 'late' ? 'late' : 'plain');
      const then = v.next?.name ?? (v.current ? 'out of the door' : '');
      // Today's pace, once it is clear (15% or more), in 5% steps so it does not flicker.
      const pc = v.current && Math.abs(v.pace) >= 0.15 ? Math.round(v.pace * 20) * 5 : 0;
      // What to do now, in minutes: a countdown to the step's target end, then how far over it is.
      const left = v.current ? leftOn(v, t) : null;
      const key = `${then}|${pc}|${left?.text}`;
      if (r.then.dataset.key !== key) {
        r.then.dataset.key = key;
        const tag = pc ? [el('i', `pace ${pc > 0 ? 'slow' : 'fast'}`, undefined, pc > 0 ? `SLOW TODAY +${pc}%` : `AHEAD ${pc}%`)] : [];
        const clock = left ? [el('i', `left${left.over ? ' over' : ''}`, undefined, left.text.toUpperCase())] : [];
        r.then.replaceChildren(...clock, ...(then ? [el('b', '', undefined, 'THEN'), then] : []), ...tag);
      }
      r.status.set(status, tone);
      r.chance.set(v.status === 'ready' ? '' : pct(v.pOnTime), chanceTone, 'right');
      drawCurve(r, v.current ? sum([laneMoments(lane, t, dep.rho, paces[li])]) : null, (dep.gateMs - t) / 1000, chanceTone);
      // A change of standing sweeps the row in its new colour, so the eye goes to it.
      if (r.tone && r.tone !== chanceTone && chanceTone !== 'done') sweep(r.li, chanceTone);
      r.tone = chanceTone;
      setText(r.ready, hhmm(v.readyMs));
      if (r.ready.dataset.tone !== chanceTone) r.ready.dataset.tone = chanceTone;
      r.done.disabled = !v.current;
      const sentence = `${nameOf(lane.personId)}: ${status.toLowerCase()}${v.current ? `, now ${v.current.name}, a ${pct(v.pOnTime)} chance of being ready by ${hhmm(dep.gateMs)}${left ? `, ${left.text} on ${v.current.name}` : ''}${pc > 0 ? `, running ${pc}% slow today` : pc < 0 ? `, ${-pc}% ahead today` : ''}` : ''}.`;
      setText(r.sr, sentence);
      // The screen speaks first where the server cannot: a chime when someone slips to TIGHT or LATE, or a step runs over.
      const worse = SEVERITY[chanceTone] > SEVERITY[r.tone];
      const overKey = left?.over && v.current ? `${lane.personId}/${v.current.key}` : '';
      if ((r.tone && worse) || (overKey && !nudged.has(overKey))) {
        if (overKey) nudged.add(overKey);
        chime();
        speak(overKey ? `${nameOf(lane.personId)}, ${v.current!.name.toLowerCase()} is over time.` : `${nameOf(lane.personId)} is ${chanceTone === 'late' ? 'running late' : 'cutting it fine'}.`);
        announce(sentence);
      }
      if (tone === 'late') late.push(sentence);
    }
    // The spread of when they will be ready, behind their steps.
    let band = bands.get(lane.personId);
    if (!band) {
      const e = el('div', 'band', $('layer')) as HTMLDivElement;
      band = { e, tick: el('i', '', e) };
      bands.set(lane.personId, band);
    }
    band.e.hidden = !v.current;
    if (v.current) {
      const x = (v.earlyMs - scale.x0) * scale.px;
      band.e.style.transform = `translate3d(${x}px,${li * laneH}px,0)`;
      band.e.style.width = `${Math.max(12, (v.lateMs - v.earlyMs) * scale.px)}px`;
      band.tick.style.transform = `translateX(${(v.readyMs - v.earlyMs) * scale.px - 1}px)`;
      if (band.e.dataset.tone !== chanceTone) band.e.dataset.tone = chanceTone;
    }
    for (const b of laneTimeline(lane, dep.gateMs, t, dep.rho, paces[li])) {
      seen.add(b.key);
      let blk = blocks.get(b.key);
      const x = (b.startMs - scale.x0) * scale.px;
      const y = li * laneH;
      const w = Math.max(10, (b.endMs - b.startMs) * scale.px - 6);
      const label = w > 170 ? `${b.name} · ${Math.round((b.endMs - b.startMs) / 60_000)}` : w > 56 ? `${Math.round((b.endMs - b.startMs) / 60_000)}` : '';
      const cls = `blk ${b.state}${b.overrun ? ' overrun' : ''}${b.endMs > dep.gateMs && b.state !== 'later' ? ' over' : ''}${moved.has(b.key) ? ' moved' : ''}${waits.has(b.key) ? ' later' : ''}`;
      if (!blk) {
        const e = el('div', cls, $('layer')) as HTMLDivElement;
        e.style.transform = `translate3d(${x}px,${y}px,0)`;
        e.style.width = `${w}px`;
        blk = { e, x, y, w, html: '', cls };
        blocks.set(b.key, blk);
      } else if (blk.x !== x || blk.y !== y || blk.w !== w) {
        if (animate && !reduced.matches && (Math.abs(blk.x - x) > 1 || blk.y !== y)) {
          // FLIP from where it was (we hold the old position: no layout read). A step handed to someone
          // else lifts out of its lane, arcs over and lands in the new one.
          const from = { transform: `translate3d(${blk.x}px,${blk.y}px,0)`, width: `${blk.w}px` };
          const to = { transform: `translate3d(${x}px,${y}px,0)`, width: `${w}px` };
          const lifted = { transform: `translate3d(${(blk.x + x) / 2}px,${Math.min(blk.y, y) - 34}px,0) scale(1.06)`, boxShadow: '0 22px 44px -10px #ffb54799', offset: 0.5 };
          blk.e.animate(blk.y !== y ? [from, lifted, to] : [from, to], { duration: blk.y !== y ? 1150 : 800, delay: 220, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
        }
        blk.e.style.transform = `translate3d(${x}px,${y}px,0)`;
        blk.e.style.width = `${w}px`;
        Object.assign(blk, { x, y, w });
      }
      if (blk.cls !== cls) blk.e.className = blk.cls = cls;
      if (blk.html !== label) {
        blk.html = label;
        blk.e.replaceChildren(document.createTextNode(label));
      }
    }
  });
  for (const [k, blk] of blocks) if (!seen.has(k)) (blk.e.remove(), blocks.delete(k));

  // Everyone on time: the chance that the whole household makes the gate, coloured by whoever is worst off.
  const allTone = views.some((v) => v.status === 'late') ? 'late' : views.some((v) => v.status === 'tight') ? 'tight' : 'ok';
  const allEl = $('all');
  showAll(allEl, views.every((v) => v.status === 'ready') ? null : Math.min(99, Math.max(1, Math.round(everyoneOnTime(views) * 100))));
  if (allEl.dataset.tone !== allTone) allEl.dataset.tone = allTone;
  $('hair').style.transform = `scaleX(${Math.min(1, Math.max(0, (t - dep.startedAtMs) / (dep.gateMs - dep.startedAtMs))).toFixed(4)})`;
  footer(dep, late, views.every((v) => v.status === 'ready'));
}

let allShown = NaN;
let allRaf = 0;
/** The household's chance; a jump of 3 points or more counts up to the new value so the eye catches it. */
function showAll(e: HTMLElement, n: number | null) {
  if (n === allShown) return;
  cancelAnimationFrame(allRaf);
  const from = allShown;
  allShown = n ?? NaN;
  if (n === null) return setText(e, 'ALL SET');
  if (!Number.isFinite(from) || Math.abs(n - from) < 3 || reduced.matches) return setText(e, `${n}%`);
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / 1200);
    setText(e, `${k === 1 ? n : Math.round(from + (n - from) * (1 - 2 ** (-10 * k)))}%`);
    if (k < 1) allRaf = requestAnimationFrame(step);
  };
  allRaf = requestAnimationFrame(step);
}

let lastLive = '';
function footer(dep: Dep, late: string[], allReady: boolean) {
  const msg = $('msg');
  const ins = board?.insights?.[0];
  if (ins) accent($('learned'), `Learned: ${ins.person}'s ${ins.step.toLowerCase()} takes `, `${Math.round(ins.learnedSec / 60)} minutes`, `, not ${Math.round(ins.statedSec / 60)}.`);
  else $('learned').replaceChildren();
  setText($('tag'), replayMode ? `REPLAY · ILLUSTRATIVE DATA · CLOCK ×${rate}` : rate > 1 ? `DEMO CLOCK ×${rate}` : '');
  let card = document.querySelector<HTMLElement>('.reroute');
  const rr = dep.reroute;
  if (rr && rr.changes.length && !allReady) {
    const key = `${rr.atMs}:${rr.canUndo}`;
    if (!card || card.dataset.key !== key) {
      const fresh = !card || card.dataset.at !== String(rr.atMs);
      card?.remove();
      card = el('div', `reroute${rr.stillLateSec ? ' stuck' : ''}`);
      card.dataset.key = key;
      card.dataset.at = String(rr.atMs);
      const next = words(el('div', 'k', card), rr.stillLateSec ? 'Still late.' : 'Re-routed.') + 1;
      const chips = el('div', 'chips', card);
      const lines = rr.changes.map(describe);
      if (rr.stillLateSec) lines.push(`Leave at ${hhmm(dep.gateMs + Math.ceil(rr.stillLateSec / 60) * 60_000)} to make it`);
      lines.forEach((line, i) => el('span', 'w', chips, line).style.setProperty('--i', String(next + i)));
      if (rr.canUndo && bridge) {
        const b = el('button', 'undo', card, 'UNDO') as HTMLButtonElement;
        b.type = 'button';
        b.addEventListener('click', () => void act('undo_reroute', {}));
      }
      msg.hidden = true;
      $('foot').prepend(card);
      if (fresh) {
        announce(`Re-routed. ${rr.changes.map(describe).join('. ')}.`);
        chime();
        choreograph(rr);
      }
    }
  } else {
    card?.remove();
    msg.hidden = false;
    if (allReady) accent($('msgText'), 'Everyone is ', 'ready', `. Leave at ${hhmm(dep.gateMs)}.`);
    else setText($('msgText'), late.length ? late.join(' ') : bridge ? 'Say "Alexa, I\'m done" when you finish a step.' : 'Tell Alexa when you finish a step.');
  }
  const liveText = late.join(' ');
  if (liveText !== lastLive) {
    lastLive = liveText;
    if (liveText) announce(liveText);
  }
}

function describe(c: Change): string {
  const owner = nameOf(c.taskKey.split('/')[0]);
  if (c.kind === 'quick') return `${owner}: quick ${c.name.toLowerCase()}`;
  if (c.kind === 'handoff') return `${nameOf(c.to!)} takes ${owner}'s ${c.name.toLowerCase()}`;
  if (c.kind === 'later') return `${c.name} after you leave`;
  return `${owner} skips ${c.name.toLowerCase()}`;
}

const announce = (text: string) => setText($('live'), text);

// ---------- inline card (Alexa's conversation view) ----------

function cardView() {
  const dep = board?.departure;
  const t = now();
  setText($('cardEyebrow'), dep ? `DOORBOUND · ${dep.name.toUpperCase()}` : 'DOORBOUND');
  const line = $('cardLine');
  if (!dep) {
    accent(line, board?.people?.length ? 'No departure ' : 'Tell Alexa your ', board?.people?.length ? 'yet' : 'mornings');
    $('cardChips').replaceChildren();
    return;
  }
  accent(line, `Leave ${hhmm(dep.gateMs)} · `, t >= dep.gateMs ? 'departed' : `${Math.max(0, Math.ceil((dep.gateMs - t) / 60_000))} min`);
  const chips = $('cardChips');
  chips.replaceChildren();
  const paces = departurePaces(dep, t);
  for (const [li, lane] of dep.lanes.entries()) {
    const v = projectLane(lane, dep.gateMs, t, dep.rho, paces[li]);
    const [status, tone] = statusOf(v, dep, t);
    const c = el('span', 'chip', chips, `${nameOf(lane.personId).toUpperCase()} · ${v.current ? `${v.current.name.toUpperCase()} · ${leftOn(v, t).text.toUpperCase()}` : status}`);
    c.dataset.tone = tone === 'board' ? 'ok' : tone;
  }
}

/** "4 min left", "about now" or "2 min over": the step in progress against its target end. */
function leftOn(v: LaneView, t: number): { text: string; over: boolean } {
  if (v.waitingFor) return { text: `waiting · ${v.waitingFor}`, over: true };
  const ms = v.stepEndMs - t;
  if (ms > 30_000) return { text: `${Math.ceil(ms / 60_000)} min left`, over: false };
  if (ms > -60_000) return { text: 'about now', over: false };
  return { text: `${Math.floor(-ms / 60_000)} min over`, over: true };
}

// ---------- layout ----------

let mode: 'inline' | 'fullscreen' = 'fullscreen';
function applyMode() {
  const host = bridge?.hostContext.displayMode;
  mode = !replayMode && (host === 'inline' || (host === undefined && innerWidth < 760)) ? 'inline' : 'fullscreen';
  $('board').hidden = mode !== 'fullscreen';
  $('card').hidden = mode !== 'inline';
  if (mode === 'fullscreen') {
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    $('board').style.transform = `translate(${(innerWidth - 1920 * s) / 2}px,${(innerHeight - 1080 * s) / 2}px) scale(${s})`;
    structure();
  } else {
    cardView();
    bridge?.sizeChanged(innerWidth, $('card').scrollHeight);
  }
}
// Fit whenever the frame changes size, however that happens (window, host resizing the iframe, rotation).
new ResizeObserver(() => applyMode()).observe(document.documentElement);
$('open').addEventListener('click', () => void bridge?.requestDisplayMode('fullscreen').then(applyMode));
addEventListener('pointerdown', unlock, { passive: true });
$('sound').addEventListener('click', () => {
  soundOn = !soundOn;
  $('sound').setAttribute('aria-pressed', String(soundOn));
});

// ---------- talking to the server ----------

async function act(tool: string, args: Record<string, unknown>, personId?: string) {
  if (!bridge) {
    // A TV or tablet on its private link: the remote's OK says the step is done, nothing more.
    if (replayMode || tool !== 'step_done' || !personId) return;
    try {
      const res = await fetch('/api/done', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(screenKey ? { 'X-Screen-Key': screenKey } : {}) }, body: JSON.stringify({ person: personId }) });
      const said = ((await res.json()) as { said?: string }).said;
      if (said) announce(said);
      if (pending) clearTimeout(pending);
      void poll();
    } catch {
      announce('That did not go through. Try again, or ask Alexa.');
    }
    return;
  }
  try {
    const r = await bridge.callTool(tool, args);
    if (isBoard(r.structuredContent)) adopt(r.structuredContent, performance.now());
    const text = r.content?.find((c) => c.type === 'text')?.text;
    if (text) announce(text);
  } catch {
    announce('That did not go through. Try again, or ask Alexa.');
  }
}

// An always-on kitchen screen (the household's TV link in a tablet's or an Echo Show's browser): while a
// departure is running, keep the display awake where the browser allows it. Inside Alexa+ the host decides.
let wake: WakeLockSentinel | null = null;
async function keepAwake(on: boolean) {
  try {
    if (on && !wake && !bridge && !replayMode && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => (wake = null));
    } else if (!on && wake) await wake.release();
  } catch {
    // not allowed here (no permission, battery saver): the screen's own settings decide
  }
}

function adopt(next: Board, sentPerf: number) {
  syncClock(next.serverNowMs, sentPerf);
  rate = next.clockRate || 1;
  if (next.unchanged) return;
  void keepAwake(!!next.departure);
  const first = !board;
  board = next;
  if (mode === 'fullscreen') {
    structure();
    if (!first) second(true);
  } else cardView();
}

// ---------- replay: the demo morning acted out by the core, in the page ----------

function replay() {
  const RATE = 20;
  const people = demoHousehold.people.map((p) => ({ id: p.id, name: p.name }));
  const stated = demoHousehold.people.flatMap((p) => p.steps.map((s) => ({ personId: p.id, stepId: s.id, statedSec: s.statedSec })));
  const names = new Map(demoHousehold.people.map((p) => [p.id, p]));
  let h = learnedHistory();
  let dep: Departure | null = null;
  let next = 0;
  let rev = 0;
  let t0 = 0;
  const begin = () => {
    const d = new Date();
    d.setHours(7, 12, 0, 0);
    t0 = d.getTime();
    h = learnedHistory();
    dep = null;
    next = 0;
    syncServer = t0;
    syncPerf = performance.now();
    synced = true;
    rate = RATE;
  };
  const publish = (t: number) =>
    adopt(
      {
        rev: ++rev,
        serverNowMs: t,
        clockRate: RATE,
        people,
        departure: dep && { ...dep, reroute: dep.reroute && { atMs: dep.reroute.atMs, changes: dep.reroute.changes, stillLateSec: dep.reroute.stillLateSec, canUndo: false } },
        insights: insights(h, stated)
          .slice(0, 3)
          .map((i) => ({ person: names.get(i.personId)!.name, step: names.get(i.personId)!.steps.find((s) => s.id === i.stepId)!.name, statedSec: i.statedSec, learnedSec: i.learnedSec })),
      },
      performance.now(),
    );
  begin();
  setInterval(() => {
    const t = now();
    while (next < DEMO_MORNING.length && t >= t0 + DEMO_MORNING[next].at * 60_000) {
      const at = t0 + DEMO_MORNING[next].at * 60_000;
      dep = demoStep(dep, DEMO_MORNING[next++].act, at, h);
      publish(at);
    }
    // Hold the finished board for a moment past the gate, then start the morning again.
    if (dep && t > dep.gateMs + 90_000) {
      begin();
      publish(t0);
    }
  }, 100);
}

let failures = 0;
let pending: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
async function poll() {
  if (inFlight) return; // the request out will schedule the next
  inFlight = true;
  const sent = performance.now();
  try {
    if (bridge) {
      const r = await bridge.callTool('get_board', { sinceRev: board?.rev ?? -1 });
      if (isBoard(r.structuredContent)) adopt(r.structuredContent, sent);
    } else {
      const res = await fetch(`/api/board?since=${board?.rev ?? -1}`, { cache: 'no-store', headers: screenKey ? { 'X-Screen-Key': screenKey } : {} });
      if (res.status === 204) {
        rate = Number(res.headers.get('X-Clock-Rate')) || 1;
        syncClock(Number(res.headers.get('X-Server-Now')), sent);
      } else if (res.ok) {
        const body: unknown = await res.json();
        if (isBoard(body)) adopt(body, sent);
      } else throw new Error(String(res.status));
    }
    failures = 0;
  } catch {
    failures++;
    if (failures >= 3) setText($('msgText'), 'Reconnecting…');
  }
  // Back off when the server is away; never more than one request in flight.
  inFlight = false;
  pending = setTimeout(poll, failures ? Math.min(10_000, 1000 * 2 ** failures) : 1000);
}
// A TV remote's D-pad arrives as arrow keys: up and down move between people's Done buttons; OK presses one.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button.done')].filter((b) => !b.hidden && !b.disabled);
  if (!buttons.length) return;
  e.preventDefault();
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const down = e.key === 'ArrowDown';
  buttons[at < 0 ? (down ? 0 : buttons.length - 1) : (at + (down ? 1 : -1) + buttons.length) % buttons.length].focus();
});

// Back on screen (a tablet woken, a tab brought forward): catch up at once and take the wake lock again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || replayMode) return;
  if (pending) clearTimeout(pending);
  failures = 0;
  void poll();
  void keepAwake(!!board?.departure);
});

// ---------- the frame loop: one transform per frame, the rest once a second ----------

let lastSecond = 0;
const nowline = $('nowline');
function frame() {
  const dep = board?.departure;
  if (dep && mode === 'fullscreen') {
    const t = now();
    nowline.style.transform = `translateX(${Math.max(0, (t - scale.x0) * scale.px)}px)`;
    const s = Math.floor(t / 1000);
    if (s !== lastSecond) {
      lastSecond = s;
      second();
    }
  } else if (dep && mode === 'inline') {
    const s = Math.floor(now() / 1000);
    if (s !== lastSecond) ((lastSecond = s), cardView());
  }
  requestAnimationFrame(frame);
}

if (bridge) {
  bridge.onToolResult = (r) => isBoard(r.structuredContent) && adopt(r.structuredContent, performance.now());
  bridge.onContext = () => applyMode();
  try {
    await bridge.connect(['inline', 'fullscreen']);
  } catch {
    bridge = null; // framed by something that is not an MCP host: behave like a plain screen
  }
}
$('board').classList.toggle('readonly', !bridge);
$('sound').hidden = !bridge; // only a touch screen can switch it, and only a touch unlocks audio
applyMode();
await document.fonts.ready;
if (replayMode) replay();
else void poll();
requestAnimationFrame(frame);
