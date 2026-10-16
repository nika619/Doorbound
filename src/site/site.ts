// The story page: what Departures is, told as a scroll story in the house style (pinned stages, one idea
// per beat, words that arrive, numbers that count). Every curve and number on it is computed here by the
// same core the server runs; the boards on it replay the demo morning in the browser.

import Lenis from 'lenis';
import { applyChanges, project, stillGoing, type Change, type Departure } from '../core/departure.ts';
import { DEMO_MORNING, demoStep, household, learnedHistory } from '../core/fixtures.ts';
import { findReroute } from '../core/reroute.ts';
import { cdf, moments, posterior, sum, type LogNormal } from '../core/stats.ts';

declare const __BOARD_HTML__: string; // the board page, built first and inlined here

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const expo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

const C = { amber: '#ffb547', go: '#8fdcaa', late: '#ff6b4a', ink: '#f3ede2', dim: '#8f887c', faint: '#5d574e', line: '#2a2620', cell: '#1c1a17' };
const COND = '"Barlow Condensed", "Arial Narrow", sans-serif';
const SERIF = '"Instrument Serif", Georgia, serif';
const BODY = 'Barlow, system-ui, sans-serif';

// ---------- words that arrive ----------

/** Split an element's text into word spans (keeping <em>), numbered for a 60 ms stagger. */
function splitWords(root: HTMLElement) {
  let i = 0;
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        for (const part of (child.textContent ?? '').split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) frag.append(part);
          else {
            const w = document.createElement('span');
            w.className = 'w';
            w.textContent = part;
            w.style.setProperty('--i', String(i++));
            frag.append(w);
          }
        }
        child.replaceWith(frag);
      } else walk(child);
    }
  };
  walk(root);
}
for (const el of $$('[data-words], .beat h2')) splitWords(el);
$$('.stat').forEach((s, i) => s.style.setProperty('--i', String(i)));

// ---------- the demo morning, worked out here ----------

const T0 = (() => {
  const d = new Date();
  d.setHours(7, 12, 0, 0);
  return d.getTime();
})();
const MIN = 60_000;
const history = learnedHistory();
const AT = T0 + 14.5 * MIN; // "Isha's still in the shower"
let before: Departure | null = null;
for (const e of DEMO_MORNING) if (e.at < 14.5) before = demoStep(before, e.act, T0 + e.at * MIN, history);
// The moment of the news, before any re-plan: what the search starts from.
const overrun = stillGoing(before!, 'isha', 8 * 60, AT)!;
const ishaAt = (d: Departure) => project(d, AT)[1].pOnTime;
const startChance = project(demoStep(null, { start: 36 }, T0, learnedHistory())!, T0)[1].pOnTime;
const plan = findReroute(overrun, household, history, AT);
const quick = plan.changes.find((c) => c.kind === 'quick')!;
const hand = plan.changes.find((c) => c.kind === 'handoff')!;
const tryPlan = (changes: Change[]) => ishaAt({ ...overrun, lanes: applyChanges(overrun, household, history, changes, AT) });
const NODES = [
  { label: 'Breakfast to go', cost: 1, p: tryPlan([quick]) },
  { label: 'Dad packs her bag', cost: 2, p: tryPlan([hand]) },
  { label: 'Both', cost: 3, p: tryPlan([quick, hand]) },
];
const pBefore = ishaAt(overrun);
const pct = (p: number) => `${Math.round(clamp(p, 0.01, 0.99) * 100)}%`;

// Isha's steps for the maths scene: as planned from what she said, and as learned.
const isha = household.people[1];
const SAID = isha.steps[0].statedSec;
const SAMPLES = history.get('isha/shower')!.slice(0, 5);
const ishaSteps: { name: string; d: LogNormal }[] = isha.steps.map((s) => ({ name: s.name, d: posterior(s.statedSec, history.get(`isha/${s.id}`)) }));
const morning = sum(ishaSteps.map((s) => moments(s.d)))!;
const GATE_MIN = 36;
const morningChance = cdf(morning, GATE_MIN * 60);

// ---------- canvas helpers ----------

type Ctx = CanvasRenderingContext2D;
const font = (ctx: Ctx, f: string) => (ctx.font = f);
const density = (d: LogNormal, x: number) => (x <= 0 ? 0 : Math.exp(-((Math.log(x) - d.mu) ** 2) / (2 * d.sigma ** 2)) / (x * d.sigma * Math.sqrt(2 * Math.PI)));
const peak = (d: LogNormal) => density(d, Math.exp(d.mu - d.sigma ** 2));

/** A distribution's curve over [0, xMax] seconds, drawn into a box; `drawn` reveals it left to right, `fillTo` shades up to a time. */
function curve(ctx: Ctx, d: LogNormal, box: { x: number; y: number; w: number; h: number }, xMax: number, yMax: number, o: { color: string; drawn?: number; fillTo?: number; fillAlpha?: number; width?: number }) {
  const N = 140;
  const X = (s: number) => box.x + (box.w * s) / xMax;
  const Y = (v: number) => box.y + box.h - (box.h * v) / yMax;
  const last = Math.floor(N * (o.drawn ?? 1));
  if (o.fillTo !== undefined && o.fillTo > 0) {
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    for (let i = 0; i <= N; i++) {
      const s = (xMax * i) / N;
      if (s > o.fillTo) break;
      ctx.lineTo(X(s), Y(density(d, s)));
    }
    ctx.lineTo(X(Math.min(o.fillTo, xMax)), Y(density(d, Math.min(o.fillTo, xMax))));
    ctx.lineTo(X(Math.min(o.fillTo, xMax)), Y(0));
    ctx.closePath();
    ctx.globalAlpha *= o.fillAlpha ?? 0.22;
    ctx.fillStyle = o.color;
    ctx.fill();
    ctx.globalAlpha /= o.fillAlpha ?? 0.22;
  }
  ctx.beginPath();
  for (let i = 0; i <= last; i++) {
    const s = (xMax * i) / N;
    const v = density(d, s);
    if (i === 0) ctx.moveTo(X(s), Y(v));
    else ctx.lineTo(X(s), Y(v));
  }
  ctx.strokeStyle = o.color;
  ctx.lineWidth = o.width ?? 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function axis(ctx: Ctx, box: { x: number; y: number; w: number; h: number }, xMaxMin: number, step: number, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(box.x, box.y + box.h);
  ctx.lineTo(box.x + box.w, box.y + box.h);
  ctx.stroke();
  font(ctx, `500 13px ${BODY}`);
  ctx.fillStyle = C.dim;
  ctx.textAlign = 'center';
  for (let m = 0; m <= xMaxMin; m += step) {
    const x = box.x + (box.w * m) / xMaxMin;
    ctx.fillRect(x - 0.5, box.y + box.h, 1, 6);
    ctx.fillText(`${m}`, x, box.y + box.h + 24);
  }
  ctx.textAlign = 'left';
  font(ctx, `700 12px ${COND}`);
  ctx.fillText('MINUTES', box.x + box.w - 60, box.y + box.h + 44);
  ctx.globalAlpha = 1;
}

function label(ctx: Ctx, text: string, x: number, y: number, color = C.dim, size = 14, align: CanvasTextAlign = 'left') {
  font(ctx, `700 ${size}px ${COND}`);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  if ('letterSpacing' in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = '0.2em';
  ctx.fillText(text.toUpperCase(), x, y);
  if ('letterSpacing' in ctx) (ctx as Ctx & { letterSpacing: string }).letterSpacing = '0px';
  ctx.textAlign = 'left';
}

function big(ctx: Ctx, text: string, x: number, y: number, size: number, color = C.ink, align: CanvasTextAlign = 'left') {
  font(ctx, `700 ${size}px ${COND}`);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

function italic(ctx: Ctx, text: string, x: number, y: number, size: number, color = C.amber, align: CanvasTextAlign = 'left') {
  font(ctx, `italic 400 ${size}px ${SERIF}`);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

function block(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, stroke: string, text = '', r = 8) {
  if (w <= 1) return;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (text && w > 60) {
    font(ctx, `500 ${Math.min(17, h * 0.36)}px ${BODY}`);
    ctx.fillStyle = C.ink;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w - 8, h);
    ctx.clip();
    ctx.fillText(text, x + 14, y + h / 2 + 6);
    ctx.restore();
  }
}

/** A ring gauge with a big number in the middle. */
function ring(ctx: Ctx, cx: number, cy: number, r: number, p: number, color: string, text: string, sub: string) {
  ctx.lineCap = 'round';
  ctx.lineWidth = r * 0.12;
  ctx.strokeStyle = C.line;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(p));
  ctx.stroke();
  ctx.lineCap = 'butt';
  big(ctx, text, cx, cy + r * 0.22, r * 0.62, color, 'center');
  label(ctx, sub, cx, cy + r * 0.5, C.dim, Math.max(11, r * 0.09), 'center');
}

// ---------- the scenes ----------

type Draw = (ctx: Ctx, w: number, h: number, p: number) => void;

/** 02: eight minutes said, twelve taken; 3 in 10 on time; one overrun lands on everyone. */
const problem: Draw = (ctx, w, h, p) => {
  const m = w * 0.04;
  const u = (w - 2 * m) / 16;
  const by = h * 0.48;
  const bh = Math.min(64, h * 0.09);
  // beats 1-2: the bar
  const aBar = 1 - seg(p, 0.5, 0.56);
  if (aBar > 0) {
    ctx.globalAlpha = aBar;
    const grow = expo(seg(p, 0.02, 0.14));
    const over = expo(seg(p, 0.27, 0.42));
    label(ctx, 'Isha · shower', m, by - 26, C.dim, 15);
    block(ctx, m, by, 8 * u * grow, bh, C.cell, '#3a352d', 'Said 8 minutes');
    if (over > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(m + 8 * u + 4, by, 4 * u * over - 4, bh, 8);
      ctx.clip();
      ctx.fillStyle = '#3a1d18';
      ctx.fillRect(m + 8 * u, by, 4 * u, bh);
      ctx.strokeStyle = '#ff6b4a55';
      ctx.lineWidth = 6;
      for (let x = -bh; x < 4 * u; x += 16) {
        ctx.beginPath();
        ctx.moveTo(m + 8 * u + x, by + bh);
        ctx.lineTo(m + 8 * u + x + bh, by);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = C.late;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(m + 8 * u + 4, by, 4 * u * over - 4, bh, 8);
      ctx.stroke();
    }
    // the giant number counts the minutes
    const mins = 8 + 4 * over;
    big(ctx, `${Math.round(mins)}`, w - m, by - bh * 0.6, Math.min(h * 0.34, w * 0.2), over > 0.5 ? C.late : C.ink, 'right');
    italic(ctx, over > 0.5 ? 'it took' : 'she said', w - m, by + bh * 1.9, Math.min(44, w * 0.04), over > 0.5 ? C.late : C.amber, 'right');
    // minute ticks
    font(ctx, `500 13px ${BODY}`);
    ctx.fillStyle = C.faint;
    for (let i = 0; i <= 12; i += 2) ctx.fillText(`${i}`, m + i * u - 3, by + bh + 28);
    ctx.globalAlpha = 1;
  }
  // beat 3: three in ten
  const aRing = seg(p, 0.52, 0.58) * (1 - seg(p, 0.75, 0.8));
  if (aRing > 0) {
    ctx.globalAlpha = aRing;
    const r = Math.min(w, h) * 0.24;
    const cx = w * 0.42;
    const cy = h * 0.44;
    const t = expo(seg(p, 0.54, 0.7));
    ring(ctx, cx, cy, r, 0.3 * t, C.amber, `${Math.round(30 * t)}%`, 'finished on time');
    // ten people, three on time
    const dx = Math.min(44, w * 0.04);
    for (let i = 0; i < 10; i++) {
      ctx.beginPath();
      ctx.arc(cx - 4.5 * dx + i * dx, cy + r * 1.42, dx * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = i < 3 && t > (i + 1) / 4 ? C.amber : C.line;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  // beat 4: three lanes, one gate
  const aLanes = seg(p, 0.77, 0.83);
  if (aLanes > 0) {
    ctx.globalAlpha = aLanes;
    const span = 44;
    const lu = (w - 2 * m - 90) / span;
    const x0 = m + 90;
    const gx = x0 + 36 * lu;
    const push = 12 * expo(seg(p, 0.84, 0.97)); // her shower runs twelve minutes long
    const lanes: [string, [string, number][]][] = [
      ['Aarav', [['Breakfast', 11], ['Teeth', 4], ['Shoes', 5]]],
      ['Isha', [['Shower', 12 + push], ['Dressed', 6], ['Breakfast', 4], ['Bag', 3]]],
      ['Dad', [['Lunches', 9], ['Dishwasher', 11], ['Car', 3]]],
    ];
    const lh = Math.min(96, h * 0.15);
    const top = h * 0.5 - (lanes.length * lh) / 2;
    lanes.forEach(([name, steps], li) => {
      const y = top + li * lh;
      label(ctx, name, m, y + lh * 0.45, C.dim, 15);
      let t = 0;
      for (const [s, len] of steps) {
        const late = t + len > 36;
        block(ctx, x0 + t * lu + 2, y, len * lu - 4, lh * 0.66, late ? '#2b1814' : C.cell, late ? C.late : '#3a352d', `${s}`);
        t += len;
      }
    });
    const late = push > 3;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = late ? C.late : C.amber;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(gx, top - 30);
    ctx.lineTo(gx, top + lanes.length * lh + 10);
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, late ? 'Gate 7:48 · late' : 'Gate 7:48', gx + 10, top - 16, late ? C.late : C.amber, 14);
    ctx.globalAlpha = 1;
  }
};

/** 03: a curve that learns, steps that add up, a door that asks. */
const maths: Draw = (ctx, w, h, p) => {
  const m = w * 0.04;
  // chart A: one step, said vs learned
  const aA = 1 - seg(p, 0.48, 0.54);
  if (aA > 0) {
    ctx.globalAlpha = aA;
    const box = { x: m, y: h * 0.16, w: w - 2 * m, h: h * 0.56 };
    const xMax = 30 * 60;
    const prior = posterior(SAID);
    const yMax = peak(prior) * 1.15;
    axis(ctx, box, 30, 5, aA);
    // dots land one by one at what really happened
    const k = seg(p, 0.27, 0.47) * SAMPLES.length;
    const landed = Math.floor(k);
    const drop = expo(k - landed);
    const d0 = posterior(SAID, SAMPLES.slice(0, landed));
    const d1 = posterior(SAID, SAMPLES.slice(0, Math.min(SAMPLES.length, landed + 1)));
    const t = landed < SAMPLES.length ? drop : 0;
    const d = { mu: mix(d0.mu, d1.mu, t), sigma: mix(d0.sigma, d1.sigma, t) };
    ctx.globalAlpha = aA;
    curve(ctx, d, box, xMax, yMax, { color: C.amber, drawn: expo(seg(p, 0.01, 0.17)), fillTo: xMax, fillAlpha: 0.12, width: 3 });
    const X = (s: number) => box.x + (box.w * s) / xMax;
    const r = Math.min(9, w * 0.008);
    for (let i = 0; i < Math.min(SAMPLES.length, Math.ceil(k)); i++) {
      const fall = i < landed ? 1 : drop;
      const yEnd = box.y + box.h - r - i * r * 2.3;
      ctx.beginPath();
      ctx.arc(X(SAMPLES[i]) + (i % 2 ? 3 : -3), mix(box.y - 40, yEnd, fall), r, 0, Math.PI * 2);
      ctx.fillStyle = C.ink;
      ctx.fill();
    }
    // what she said, and what it has become
    ctx.fillStyle = C.amber;
    ctx.fillRect(X(SAID) - 1, box.y + box.h, 2, 14);
    label(ctx, 'said 8', X(SAID), box.y + box.h + 62, C.amber, 13, 'center');
    if (k > 0) label(ctx, 'took 14', X(SAMPLES[0]), box.y + box.h + 62, C.ink, 13, 'center');
    const med = Math.exp(d.mu) / 60;
    ctx.setLineDash([5, 6]);
    ctx.strokeStyle = C.amber;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(X(med * 60), box.y);
    ctx.lineTo(X(med * 60), box.y + box.h);
    ctx.stroke();
    ctx.setLineDash([]);
    italic(ctx, `plans ${med.toFixed(1)} min`, X(med * 60) + 12, box.y + 26, Math.min(34, w * 0.03));
    ctx.globalAlpha = 1;
  }
  // chart B: her morning adds up, then the door
  const aB = seg(p, 0.5, 0.56);
  if (aB > 0) {
    ctx.globalAlpha = aB;
    const leftW = w * 0.3;
    const rows = ishaSteps.length;
    const rowH = (h * 0.62) / rows;
    const gather = expo(seg(p, 0.6, 0.74));
    ishaSteps.forEach((s, i) => {
      const box = { x: m, y: h * 0.14 + i * rowH, w: leftW - m, h: rowH * 0.62 };
      ctx.globalAlpha = aB * (1 - 0.65 * gather);
      label(ctx, s.name, box.x, box.y + 4, C.dim, 13);
      curve(ctx, s.d, { ...box, y: box.y + 10 }, 20 * 60, peak(s.d) * 1.1, { color: C.dim, fillTo: 20 * 60, fillAlpha: 0.1, width: 1.8 });
      // a thread from each step into the sum
      ctx.strokeStyle = C.amber;
      ctx.globalAlpha = aB * gather * 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(leftW + 6, box.y + box.h * 0.6);
      ctx.bezierCurveTo(leftW + 70, box.y + box.h * 0.6, leftW + 40, h * 0.5, leftW + 110, h * 0.5);
      ctx.stroke();
    });
    ctx.globalAlpha = aB;
    const box = { x: leftW + 130, y: h * 0.14, w: w - leftW - 130 - m, h: h * 0.6 };
    const xMax = 50 * 60;
    axis(ctx, box, 50, 10, aB);
    const door = expo(seg(p, 0.76, 0.86));
    const gateS = mix(50, GATE_MIN, door) * 60;
    const fill = seg(p, 0.8, 0.95);
    curve(ctx, morning, box, xMax, peak(morning) * 1.15, { color: C.go, drawn: gather, fillTo: fill > 0 ? gateS * fill + 0 : 0, fillAlpha: 0.32, width: 3 });
    label(ctx, "Isha's whole morning", box.x, box.y - 12, C.dim, 13);
    if (door > 0) {
      const gx = box.x + (box.w * gateS) / xMax;
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = C.amber;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(gx, box.y - 10);
      ctx.lineTo(gx, box.y + box.h);
      ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, 'gate 7:48', gx + 10, box.y + 8, C.amber, 13);
      const shown = morningChance * expo(fill);
      big(ctx, `${Math.round(shown * 100)}%`, box.x + box.w, box.y + box.h * 0.42, Math.min(h * 0.2, w * 0.12), C.go, 'right');
      italic(ctx, 'ready in time', box.x + box.w, box.y + box.h * 0.42 + Math.min(46, w * 0.04), Math.min(34, w * 0.03), C.go, 'right');
    }
    ctx.globalAlpha = 1;
  }
};

/** 04: her chance falls; the search tries the gentlest fixes; the cheapest that works wins. */
const replan: Draw = (ctx, w, h, p) => {
  const m = w * 0.04;
  const narrow = w < 640; // phones: the gauge on top, the options under it
  const r = narrow ? Math.min(w * 0.16, h * 0.13) : Math.min(w, h) * 0.17;
  const cx = narrow ? w / 2 : m + r * 1.2;
  const cy = narrow ? r + 34 : h * 0.46;
  // the gauge: from where the morning started, down to the moment, then back up with the plan
  const fallT = expo(seg(p, 0.03, 0.22));
  const riseT = expo(seg(p, 0.72, 0.9));
  const value = riseT > 0 ? mix(pBefore, NODES[2].p, riseT) : mix(startChance, pBefore, fallT);
  const color = value >= 0.85 ? C.go : value >= 0.5 ? C.amber : C.late;
  ring(ctx, cx, cy, r, value, color, pct(value), 'Isha · 7:48');
  label(ctx, riseT > 0.5 ? 'after the re-plan' : fallT > 0.5 ? '"eight more minutes"' : 'at the start', cx, cy - r - 28, C.dim, 13, 'center');
  // the search tree
  const tx = narrow ? -80 + m : cx + r * 1.6;
  const nodeW = narrow ? w - 2 * m : Math.min(360, w - tx - m - 100);
  const nh = Math.min(84, h * 0.12);
  const gap = nh * 0.4;
  const top = narrow ? cy + r + 40 : cy - (NODES.length * nh + (NODES.length - 1) * gap) / 2;
  NODES.forEach((n, i) => {
    const show = expo(seg(p, 0.36 + i * 0.09, 0.44 + i * 0.09));
    if (show <= 0) return;
    const ok = n.p >= 0.85;
    const chosen = ok && i === NODES.length - 1;
    const settle = seg(p, 0.66, 0.74);
    const fade = !chosen ? 1 - 0.6 * settle : 1;
    const y = top + i * (nh + gap);
    const x = tx + 80 + (1 - show) * 30;
    ctx.globalAlpha = show * fade;
    // the branch
    if (!narrow) {
      ctx.strokeStyle = chosen && settle > 0 ? C.amber : C.line;
      ctx.lineWidth = chosen && settle > 0 ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + r * 1.15, cy);
      ctx.bezierCurveTo(tx + 20, cy, tx + 30, y + nh / 2, x, y + nh / 2);
      ctx.stroke();
    }
    // the node
    ctx.beginPath();
    ctx.roundRect(x, y, nodeW, nh, 14);
    ctx.fillStyle = chosen && settle > 0 ? '#1d1a12' : '#15130f';
    ctx.fill();
    ctx.strokeStyle = chosen && settle > 0 ? C.amber : ok ? C.go : '#3a352d';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    label(ctx, `cost ${n.cost}`, x + 18, y + 24, C.amber, 12);
    font(ctx, `500 ${Math.min(21, nh * 0.27)}px ${BODY}`);
    ctx.fillStyle = C.ink;
    ctx.fillText(n.label, x + 18, y + nh * 0.72);
    big(ctx, pct(n.p), x + nodeW - 18, y + nh * 0.68, nh * 0.48, ok ? C.go : C.late, 'right');
    // a verdict mark
    if (!narrow) label(ctx, ok ? (chosen ? 'chosen' : 'works') : 'not enough', x + nodeW - 18, y + 24, ok ? C.go : C.late, 12, 'right');
  });
  ctx.globalAlpha = 1;
  if (seg(p, 0.74, 0.8) > 0) {
    ctx.globalAlpha = seg(p, 0.74, 0.8);
    italic(ctx, 'cheapest plan that works: proven', tx + 80, top + NODES.length * (nh + gap) + 20, Math.min(30, w * 0.026));
    ctx.globalAlpha = 1;
  }
};

// ---------- scroll stories: pinned stages drawn from progress ----------

interface Story {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: Ctx;
  beats: HTMLElement[];
  count: HTMLElement;
  draw: Draw;
  top: number;
  height: number;
  p: number;
  beat: number;
}
const scenes: Record<string, Draw> = { problem, maths, replan };
const stories: Story[] = $$('[data-story]').map((el) => {
  const canvas = $<HTMLCanvasElement>('canvas', el);
  return { el, canvas, ctx: canvas.getContext('2d')!, beats: $$('.beat', el), count: $('.count b', el), draw: scenes[el.dataset.story!], top: 0, height: 1, p: -1, beat: -1 };
});

function measure() {
  for (const s of stories) {
    s.top = s.el.offsetTop;
    s.height = s.el.offsetHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    s.canvas.width = Math.round(s.canvas.clientWidth * dpr);
    s.canvas.height = Math.round(s.canvas.clientHeight * dpr);
    s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    s.p = -1;
  }
  sections = $$('[data-sec]').map((el) => ({ el, top: el.offsetTop }));
  docH = document.documentElement.scrollHeight;
}

function render(s: Story, p: number) {
  const n = s.beats.length;
  const beat = Math.min(n - 1, Math.floor(p * n));
  if (beat !== s.beat) {
    s.beats.forEach((b, i) => b.classList.toggle('in', i === beat));
    s.count.textContent = String(beat + 1);
    s.beat = beat;
  }
  if (p === s.p) return;
  s.p = p;
  const w = s.canvas.clientWidth;
  const h = s.canvas.clientHeight;
  s.ctx.clearRect(0, 0, w, h);
  s.draw(s.ctx, w, h, p);
}

// ---------- chrome: hairline, rail and nav follow the page ----------

let sections: { el: HTMLElement; top: number }[] = [];
let docH = 1;
const railLinks = $$<HTMLAnchorElement>('.rail a');
const navLinks = $$<HTMLAnchorElement>('.nav a.l');
let current = '';
function onScroll() {
  const y = scrollY;
  $('#hairline').style.transform = `scaleX(${clamp(y / Math.max(1, docH - innerHeight)).toFixed(4)})`;
  for (const s of stories) {
    if (y + innerHeight < s.top - 200 || y > s.top + s.height + 200) continue;
    render(s, clamp((y - s.top) / Math.max(1, s.height - innerHeight)));
  }
  let id = sections[0]?.el.id ?? '';
  for (const s of sections) if (s.top <= y + innerHeight * 0.4) id = s.el.id;
  if (id !== current) {
    current = id;
    const group = id === 'replan' ? 'replan' : id === 'alexa' ? 'proof' : id;
    for (const a of railLinks) a.classList.toggle('on', a.hash === `#${group}`);
    for (const a of navLinks) a.classList.toggle('on', a.hash === `#${group}` || (group === 'replan' && a.hash === '#maths'));
  }
}

// ---------- reveals and counts when things come into view ----------

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      io.unobserve(e.target);
      if (e.target.id === 'proof') countUp();
      if (e.target.id === 'board') startBoard($('#boardScreen'));
    }
  },
  { rootMargin: '0px 0px -20% 0px', threshold: 0.12 },
);
for (const el of $$('[data-reveal]')) io.observe(el);

function countUp() {
  for (const v of $$('[data-count]')) {
    const target = Number(v.dataset.count);
    const dp = Number(v.dataset.dp ?? 0);
    const text = v.firstChild as Text;
    const fmt = (x: number) => x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    if (reduced) {
      text.textContent = fmt(target);
      continue;
    }
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 1600);
      text.textContent = fmt(k === 1 ? target : target * expo(k));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

// ---------- the boards: the real board page, replaying the demo morning ----------

function startBoard(screen: HTMLElement) {
  if (screen.firstChild) return;
  const f = document.createElement('iframe');
  f.name = 'replay'; // the board reads this and acts out the demo morning itself
  f.title = 'The Departures board, replaying the demo morning';
  f.setAttribute('sandbox', 'allow-scripts'); // an opaque origin: it can reach nothing here
  f.loading = 'lazy';
  f.srcdoc = __BOARD_HTML__;
  screen.append(f);
}
startBoard($('#heroScreen'));

// ---------- the marquee ----------

const phrases = ["I'm done.", "She's still in the <em>shower.</em>", 'We need to leave ten minutes early.', 'How are we <em>doing?</em>', 'Undo that.', 'What have you <em>learned?</em>'];
const track = $('#marquee');
for (let k = 0; k < 2; k++)
  for (const ph of phrases) {
    const span = document.createElement('span');
    const parts = ph.split(/<em>|<\/em>/);
    span.append(parts[0]);
    if (parts[1]) {
      const em = document.createElement('em');
      em.textContent = parts[1];
      span.append(em, parts[2] ?? '');
    }
    if (k) span.setAttribute('aria-hidden', 'true');
    track.append(span);
  }

// ---------- links and buttons ----------

const lenis = reduced ? null : new Lenis({ autoRaf: true, lerp: 0.085 });
for (const a of $$<HTMLAnchorElement>('a[href^="#"]'))
  a.addEventListener('click', (e) => {
    const target = a.hash === '#top' ? 0 : $(a.hash);
    if (target === null) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target as HTMLElement | number, { duration: 1.6 });
    else if (typeof target === 'number') scrollTo(0, 0);
    else target.scrollIntoView();
  });
$('#copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText('npm install && npm run demo');
    $('#copy').textContent = 'COPIED';
  } catch {
    $('#copy').textContent = 'SELECT IT';
  }
});
// Served without the server (a static copy), there is no live simulator to open: point at the commands.
fetch('/healthz')
  .then((r) => r.ok || Promise.reject())
  .catch(() => {
    for (const a of $$<HTMLAnchorElement>('a.live')) a.href = '#try';
  });

// ---------- go ----------

let ticking = false;
const schedule = () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    onScroll();
  });
};
if (lenis) lenis.on('scroll', schedule);
addEventListener('scroll', schedule, { passive: true });
addEventListener('resize', () => {
  measure();
  schedule();
});
await document.fonts.ready;
measure();
onScroll();
requestAnimationFrame(() => $('#top').classList.add('in'));
