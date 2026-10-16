// Measured numbers, not claims.
//   tsx scripts/bench.ts          the planner and the board's per-second work, in process
//   tsx scripts/bench.ts load     a load test against a running server started with TRUST_PROXY=1,
//                                 so each simulated screen or speaker counts as its own client
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { household, householdAtLimits, learnedHistory, randomHousehold, randomMorning, rng } from '../src/core/fixtures.ts';
import { laneTimeline, projectLane, startDeparture } from '../src/core/departure.ts';
import { findReroute } from '../src/core/reroute.ts';

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const ms = (x: number) => `${x < 1 ? x.toFixed(3) : x.toFixed(1)} ms`;
const summary = (label: string, xs: number[]) => console.log(`${label.padEnd(44)} p50 ${ms(pct(xs, 0.5)).padStart(10)}   p95 ${ms(pct(xs, 0.95)).padStart(10)}   max ${ms(Math.max(...xs)).padStart(10)}   (n=${xs.length})`);

if (process.argv[2] !== 'load') {
  console.log(`Node ${process.version}, ${process.platform}\n`);
  // Warm up the JIT so the first samples are not compile time.
  for (let i = 0; i < 200; i++) {
    const r = rng(i);
    const hh = randomHousehold(r, 5, 7);
    const m = randomMorning(r, hh);
    findReroute(m.dep, hh, m.h, m.now);
  }
  for (const [label, make, n] of [
    ['re-plan, random households (1-5 people)', (r: () => number) => randomHousehold(r, 5, 7), 2000],
    ['re-plan, at the limits (8 people x 15 steps)', householdAtLimits, 100],
  ] as const) {
    const r = rng(20261015);
    const times: number[] = [];
    let optimal = 0;
    let needed = 0;
    for (let i = 0; i < n; i++) {
      const hh = make(r);
      const m = randomMorning(r, hh);
      const t = performance.now();
      const plan = findReroute(m.dep, hh, m.h, m.now);
      times.push(performance.now() - t);
      if (plan.changes.length || plan.stillLateSec) {
        needed++;
        if (plan.optimal) optimal++;
      }
    }
    summary(label, times);
    console.log(`${''.padEnd(44)} needed a re-plan: ${needed}; proven optimal: ${optimal} (${((100 * optimal) / Math.max(1, needed)).toFixed(0)}%)`);
  }
  // What a screen does once a second: project every lane and lay out its runway.
  const dep = startDeparture(household, learnedHistory(), 'School run', Date.now() + 36 * 60_000, Date.now());
  const ticks: number[] = [];
  for (let i = 0; i < 20_000; i++) {
    const t = performance.now();
    for (const lane of dep.lanes) {
      projectLane(lane, dep.gateMs, Date.now(), dep.rho);
      laneTimeline(lane, dep.gateMs, Date.now(), dep.rho);
    }
    ticks.push(performance.now() - t);
  }
  summary("the board's work per second (3 people)", ticks);
  console.log(`board payload for the demo household: ${JSON.stringify({ departure: dep, people: household.people }).length} bytes of JSON; an unchanged poll is a 204 with no body`);
} else {
  const base = process.env.DOORBOUND_URL ?? 'http://127.0.0.1:3940';
  const SCREENS = Number(process.env.SCREENS ?? 300);
  const SPEAKERS = Number(process.env.SPEAKERS ?? 30);
  const SECONDS = Number(process.env.SECONDS ?? 20);
  const ip = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
  console.log(`load: ${SCREENS} screens polling once a second, ${SPEAKERS} speakers calling a tool every 2 s, for ${SECONDS} s, against ${base}\n`);

  // Start a morning so the board has something to say.
  const setup = new Client({ name: 'bench', version: '1' });
  await setup.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { 'X-Forwarded-For': ip(1 << 20) } } }));
  const now = Number((await fetch(new URL('/api/board?since=-2', base), { headers: { 'X-Forwarded-For': ip(1 << 21) } })).headers.get('X-Server-Now'));
  const d = new Date(now + 36 * 60_000);
  await setup.callTool({ name: 'start_departure', arguments: { leaveAt: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` } });
  await setup.close();

  const end = performance.now() + SECONDS * 1000;
  const lat = { board: [] as number[], tool: [] as number[] };
  const status = new Map<string, number>();
  const count = (k: string) => status.set(k, (status.get(k) ?? 0) + 1);
  const screen = async (i: number) => {
    let rev = -1;
    await new Promise((r) => setTimeout(r, Math.random() * 1000)); // screens are not in step
    while (performance.now() < end) {
      const t = performance.now();
      try {
        const res = await fetch(new URL(`/api/board?since=${rev}`, base), { headers: { 'X-Forwarded-For': ip(i) } });
        if (res.status === 200) rev = ((await res.json()) as { rev: number }).rev;
        else await res.arrayBuffer();
        count(`board ${res.status}`);
      } catch {
        count('board network error');
      }
      lat.board.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (performance.now() - t))));
    }
  };
  const speaker = async (i: number) => {
    const c = new Client({ name: `speaker-${i}`, version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { 'X-Forwarded-For': ip(50_000 + i) } } }));
    await new Promise((r) => setTimeout(r, Math.random() * 2000));
    while (performance.now() < end) {
      const t = performance.now();
      try {
        const r = await c.callTool({ name: 'departure_status', arguments: {} });
        count(r.isError ? 'tool error result' : 'tool ok');
      } catch {
        count('tool failed');
      }
      lat.tool.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, Math.max(0, 2000 - (performance.now() - t))));
    }
    await c.close();
  };
  const t0 = performance.now();
  await Promise.all([...Array.from({ length: SCREENS }, (_, i) => screen(i)), ...Array.from({ length: SPEAKERS }, (_, i) => speaker(i))]);
  const wall = (performance.now() - t0) / 1000;
  summary('board poll (GET /api/board)', lat.board);
  summary('tool call (POST /mcp, departure_status)', lat.tool);
  console.log(`\nthroughput: ${((lat.board.length + lat.tool.length) / wall).toFixed(0)} requests/s over ${wall.toFixed(1)} s`);
  console.log(`responses: ${[...status].map(([k, v]) => `${k}: ${v}`).join(', ')}`);
}
