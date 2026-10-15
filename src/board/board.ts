// The departure board. Inside Alexa+ (an MCP App) it talks through the host; opened directly on a
// TV it reads /api/board. It derives everything from the same core functions as the server, so a
// screen only needs the state and the time.
//
// Performance: DOM built once per person and per step and reused. Per frame: one transform (the
// "now" line). Per second: text and geometry that actually changed. On a re-plan: blocks glide to
// their new place (FLIP from positions we already hold, so no layout reads).

import { laneTimeline, projectLane, type Change, type Lane, type LaneView } from '../core/departure.ts';
import { Bridge, windowPort } from './bridge.ts';

// ---------- data ----------

interface Dep {
  name: string;
  gateMs: number;
  startedAtMs: number;
  rev: number;
  lanes: Lane[];
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
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

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

// ---------- split-flap ----------

class Flap {
  readonly root = el('span', 'flap');
  private chars: string[];
  constructor(private readonly width: number) {
    this.chars = Array(width).fill(' ');
    this.root.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < width; i++) el('span', 'cell blank', this.root).append(el('span', 'ch', undefined, ' '));
  }
  set(text: string, tone: string) {
    if (this.root.dataset.tone !== tone) this.root.dataset.tone = tone;
    const next = text.toUpperCase().padEnd(this.width).slice(0, this.width);
    for (let i = 0; i < this.width; i++) {
      if (next[i] === this.chars[i]) continue;
      this.chars[i] = next[i];
      const cell = this.root.children[i] as HTMLElement;
      cell.classList.toggle('blank', next[i] === ' ');
      // A fresh element starts its animation by itself: no forced reflow to restart one.
      const ch = el('span', reduced.matches ? 'ch' : 'ch in', undefined, next[i]);
      if (!reduced.matches) ch.style.animationDelay = `${i * 20}ms`;
      cell.replaceChildren(ch);
    }
  }
}

// ---------- the board ----------

let bridge = window.parent !== window ? new Bridge(windowPort()) : null;
const screenKey = new URLSearchParams(location.hash.slice(1)).get('k'); // the fragment never reaches a server log
let board: Board | null = null;

interface Row {
  li: HTMLLIElement;
  sr: HTMLElement;
  now: Flap;
  then: HTMLElement;
  status: Flap;
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
const rows = new Map<string, Row>();
const blocks = new Map<string, Blk>();
const laneNames = new Map<string, HTMLElement>();
let scale = { x0: 0, x1: 1, px: 1 };
const LANE_H = 70;

const nameOf = (id: string) => board?.people?.find((p) => p.id === id)?.name ?? id;

function statusOf(v: LaneView, dep: Dep, t: number): [string, string] {
  const departed = t >= dep.gateMs;
  if (v.status === 'ready') return departed ? ['DEPARTED', 'done'] : ['READY', 'done'];
  if (v.status === 'late') return [`DELAYED +${Math.max(1, Math.round(-v.slackSec / 60))}`, 'late'];
  if (departed) return ['LEFT LATE', 'late'];
  return v.status === 'boarding' ? ['BOARDING', 'board'] : ['ON TIME', 'ok'];
}

function rowFor(id: string): Row {
  let r = rows.get(id);
  if (r) return r;
  const li = el('li', 'row', $('rows'));
  const sr = el('span', 'sr', li);
  const label = el('span', 'name', li);
  label.setAttribute('aria-hidden', 'true');
  const now = new Flap(18);
  li.append(now.root);
  const then = el('span', 'then', li);
  then.setAttribute('aria-hidden', 'true');
  const status = new Flap(10);
  li.append(status.root);
  const ready = el('span', 'ready', li);
  ready.setAttribute('aria-hidden', 'true');
  const done = el('button', 'done', li, 'DONE') as HTMLButtonElement;
  done.type = 'button';
  done.hidden = !bridge; // a TV is read-only; voice and the Echo Show's touch screen change things
  let armed: ReturnType<typeof setTimeout> | undefined;
  done.addEventListener('click', () => {
    // Two taps, so a brush against the screen never marks a step done.
    if (!armed) {
      done.classList.add('arm');
      done.textContent = 'TAP AGAIN';
      armed = setTimeout(() => {
        armed = undefined;
        done.classList.remove('arm');
        done.textContent = 'DONE';
      }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = undefined;
    done.classList.remove('arm');
    done.textContent = 'DONE';
    void act('step_done', { person: nameOf(id) });
  });
  r = { li, sr, now, then, status, ready, done, label };
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
  setText($('title'), dep?.name ?? (people.length ? 'Next departure' : 'Departures'));
  setText($('emptyBig'), people.length ? '' : 'Tell Alexa your mornings.');
  setText(
    $('emptySay'),
    people.length
      ? 'Say: "Alexa, start the school run. We leave at 7:40."'
      : 'For example: "Alexa, Isha showers for 8 minutes, then gets dressed for 6, then has breakfast." Departures learns how long things really take, and keeps everyone on time.',
  );

  // Rows, in household order; people who left the household are removed.
  const ids = new Set(people.map((p) => p.id));
  for (const [id, r] of rows) if (!ids.has(id)) (r.li.remove(), rows.delete(id));
  for (const p of people) {
    const r = rowFor(p.id);
    setText(r.label, p.name.toUpperCase());
    $('rows').append(r.li); // re-append keeps order; a no-op for the browser when already in place
  }
  if (!dep) {
    for (const p of people) {
      const r = rows.get(p.id)!;
      r.now.set('', 'done');
      setText(r.then, '');
      r.status.set('SCHEDULED', 'done');
      setText(r.ready, '');
      setText(r.sr, `${p.name}: scheduled.`);
    }
    for (const b of blocks.values()) b.e.remove();
    blocks.clear();
    return;
  }

  // Runway scale: fixed for the whole departure so nothing slides about.
  const t = now();
  const all = dep.lanes.flatMap((l) => laneTimeline(l, dep.gateMs, t));
  const x0 = Math.min(dep.startedAtMs, ...all.map((b) => b.startMs)) - 60_000;
  const x1 = Math.max(dep.gateMs + 8 * 60_000, ...all.map((b) => b.endMs)) + 60_000;
  const width = $('layer').clientWidth || 1646;
  scale = { x0, x1, px: width / (x1 - x0) };
  $('gateline').style.transform = `translateX(${(dep.gateMs - x0) * scale.px}px)`;
  setText($('gatelabel'), `GATE ${hhmm(dep.gateMs)}`);
  for (const tick of document.querySelectorAll('.tick')) tick.remove();
  for (let m = Math.ceil(x0 / 300_000) * 300_000; m <= x1; m += 300_000) {
    const tk = el('span', 'tick', $('layer'), hhmm(m));
    tk.style.left = `${(m - x0) * scale.px}px`;
  }
  dep.lanes.forEach((lane, i) => {
    let n = laneNames.get(lane.personId);
    if (!n) laneNames.set(lane.personId, (n = el('div', 'lane-name', $('lanes'))));
    setText(n, nameOf(lane.personId).toUpperCase());
    n.style.top = `${i * LANE_H}px`;
  });
  second(true);
}

/** Once a second (and after every change): text, statuses and the geometry that moves. */
function second(animate = false) {
  const dep = board?.departure;
  if (!dep) return;
  const t = now();
  const departed = t >= dep.gateMs;
  setText($('clock'), hhmm(t));
  setText($('gate'), hhmm(dep.gateMs));
  setText($('gateK'), departed ? 'DEPARTED' : 'GATE CLOSES');
  setText($('left'), departed ? 'CLOSED' : `${Math.max(0, Math.ceil((dep.gateMs - t) / 60_000))} MIN`);

  const seen = new Set<string>();
  const live: string[] = [];
  const moved = new Set((dep.reroute?.changes ?? []).filter((c) => c.kind !== 'later').map((c) => c.taskKey));
  const waits = new Set((dep.reroute?.changes ?? []).filter((c) => c.kind === 'later').map((c) => c.taskKey));
  dep.lanes.forEach((lane, li) => {
    const v = projectLane(lane, dep.gateMs, t);
    const r = rows.get(lane.personId);
    const [status, tone] = statusOf(v, dep, t);
    if (r) {
      r.now.set(v.current?.name ?? (v.status === 'ready' ? 'Ready to go' : ''), tone === 'late' ? 'late' : 'plain');
      setText(r.then, v.next?.name ?? (v.current ? 'Gate' : ''));
      r.status.set(status, tone);
      setText(r.ready, hhmm(v.readyMs));
      r.ready.classList.toggle('late', v.readyMs > dep.gateMs);
      r.done.disabled = !v.current;
      const sentence = `${nameOf(lane.personId)}: ${status.toLowerCase()}${v.current ? `, now ${v.current.name}` : ''}, ready at ${hhmm(v.readyMs)}.`;
      setText(r.sr, sentence);
      if (tone === 'late') live.push(sentence);
    }
    for (const b of laneTimeline(lane, dep.gateMs, t)) {
      seen.add(b.key);
      let blk = blocks.get(b.key);
      const x = (b.startMs - scale.x0) * scale.px;
      const y = li * LANE_H;
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
          // FLIP from where it was (we hold the old position: no layout read).
          blk.e.animate([{ transform: `translate3d(${blk.x}px,${blk.y}px,0)`, width: `${blk.w}px` }, { transform: `translate3d(${x}px,${y}px,0)`, width: `${w}px` }], { duration: 750, easing: 'cubic-bezier(.2,.8,.2,1)' });
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
  footer(dep, live);
}

let lastLive = '';
function footer(dep: Dep, late: string[]) {
  const msg = $('msg');
  const ins = board?.insights?.[0];
  setText($('learned'), ins ? `Learned: ${ins.person}'s ${ins.step.toLowerCase()} takes ${Math.round(ins.learnedSec / 60)} minutes, not the ${Math.round(ins.statedSec / 60)} planned.` : '');
  setText($('tag'), rate > 1 ? `DEMO CLOCK ×${rate}` : '');
  let card = document.querySelector<HTMLElement>('.reroute');
  const rr = dep.reroute;
  if (rr && (rr.changes.length || rr.stillLateSec)) {
    const key = `${rr.atMs}:${rr.canUndo}`;
    if (!card || card.dataset.key !== key) {
      card?.remove();
      card = el('div', `reroute${rr.stillLateSec ? ' stuck' : ''}`);
      card.dataset.key = key;
      el('div', 'k', card, rr.stillLateSec ? 'STILL LATE' : 'RE-ROUTED');
      const chips = el('div', 'chips', card);
      for (const c of rr.changes) el('span', '', chips, describe(c));
      if (rr.stillLateSec) el('span', '', chips, `Leave at ${hhmm(dep.gateMs + Math.ceil(rr.stillLateSec / 60) * 60_000)} to make it`);
      if (rr.canUndo && bridge) {
        const b = el('button', 'undo', card, 'UNDO') as HTMLButtonElement;
        b.type = 'button';
        b.addEventListener('click', () => void act('undo_reroute', {}));
      }
      msg.hidden = true;
      $('foot').prepend(card);
      announce(`Re-routed. ${rr.changes.map(describe).join('. ')}.`);
    }
  } else {
    card?.remove();
    msg.hidden = false;
    setText($('msgText'), late.length ? late.join(' ') : bridge ? 'Say "Alexa, I\'m done" when you finish a step.' : 'Tell Alexa when you finish a step.');
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
  setText($('cardEyebrow'), dep ? `DEPARTURES · ${dep.name.toUpperCase()}` : 'DEPARTURES');
  const line = $('cardLine');
  line.replaceChildren();
  if (!dep) {
    line.append(document.createTextNode(board?.people?.length ? 'No departure running' : 'Tell Alexa your mornings'));
    $('cardChips').replaceChildren();
    return;
  }
  line.append(document.createTextNode(`Leave ${hhmm(dep.gateMs)} · `));
  el('b', '', line, t >= dep.gateMs ? 'departed' : `${Math.max(0, Math.ceil((dep.gateMs - t) / 60_000))} min`);
  const chips = $('cardChips');
  chips.replaceChildren();
  for (const lane of dep.lanes) {
    const v = projectLane(lane, dep.gateMs, t);
    const [status, tone] = statusOf(v, dep, t);
    const c = el('span', 'chip', chips, `${nameOf(lane.personId).toUpperCase()} · ${status}`);
    c.dataset.tone = tone;
  }
}

// ---------- layout ----------

let mode: 'inline' | 'fullscreen' = 'fullscreen';
function applyMode() {
  const host = bridge?.hostContext.displayMode;
  mode = host === 'inline' || (host === undefined && innerWidth < 760) ? 'inline' : 'fullscreen';
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

// ---------- talking to the server ----------

async function act(tool: string, args: Record<string, unknown>) {
  if (!bridge) return;
  try {
    const r = await bridge.callTool(tool, args);
    if (isBoard(r.structuredContent)) adopt(r.structuredContent, performance.now());
    const text = r.content?.find((c) => c.type === 'text')?.text;
    if (text) announce(text);
  } catch {
    announce('That did not go through. Try again, or ask Alexa.');
  }
}

function adopt(next: Board, sentPerf: number) {
  syncClock(next.serverNowMs, sentPerf);
  rate = next.clockRate || 1;
  if (next.unchanged) return;
  const first = !board;
  board = next;
  if (mode === 'fullscreen') {
    structure();
    if (!first) second(true);
  } else cardView();
}

let failures = 0;
async function poll() {
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
      }
      else if (res.ok) {
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
  setTimeout(poll, failures ? Math.min(10_000, 1000 * 2 ** failures) : 1000);
}

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
applyMode();
await document.fonts.ready;
void poll();
requestAnimationFrame(frame);
