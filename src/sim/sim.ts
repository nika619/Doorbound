// The Alexa+ simulator: a real MCP client and a real MCP Apps host, standing in for the parts of
// Alexa+ that hackathon entrants cannot reach. Speech in (Web Speech API) → a deterministic router
// in place of Alexa's model → tools/call over Streamable HTTP → Alexa's reply spoken, and the board
// rendered from the ui:// resource in a sandboxed frame through the official AppBridge.

import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { DEMO_MORNING } from '../core/fixtures.ts';
import { route, type Call } from './router.ts';

const BOARD_URI = 'ui://doorbound/board.html';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
}
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// ---------- protocol inspector (bounded) ----------
const insp = $('insp');
function log(kind: 'out' | 'in' | 'err', text: string) {
  el('span', kind, insp, `${(performance.now() / 1000).toFixed(1).padStart(6)}s  ${text}\n`);
  if (insp.childElementCount > 200) insp.firstElementChild!.remove();
  insp.scrollTop = insp.scrollHeight;
}
let polls = 0;
let pollLine: HTMLElement | null = null;
function logPoll(unchanged: boolean) {
  polls++;
  pollLine ??= el('span', 'in', insp);
  pollLine.textContent = `        board view → get_board ×${polls} (${unchanged ? 'unchanged, a few bytes' : 'changed'})\n`;
  insp.append(pollLine);
}

// ---------- the server's clock ----------
let serverNow = Date.now();
let syncedAt = performance.now();
let rate = 1;
const now = () => serverNow + (performance.now() - syncedAt) * rate;
async function syncClock() {
  const sent = performance.now();
  const res = await fetch('/api/board?since=-2', { cache: 'no-store' });
  serverNow = Number(res.headers.get('X-Server-Now'));
  syncedAt = (sent + performance.now()) / 2;
  rate = Number(res.headers.get('X-Clock-Rate')) || 1;
  const badge = $('clockRate');
  badge.hidden = rate === 1;
  badge.textContent = `DEMO CLOCK ×${rate}`;
  badge.classList.add('on');
}
const clockIn = (minutes: number) => {
  const d = new Date(now() + minutes * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// ---------- MCP client ----------
const client = new Client({ name: 'doorbound-alexa-sim', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', location.href)));
const protocol = client.getNegotiatedProtocolVersion();
$('proto').textContent = `MCP ${protocol}`;
log('in', `initialize → protocol ${protocol}, server ${client.getServerVersion()?.name ?? '?'}`);
const { tools } = await client.listTools();
log('in', `tools/list → ${tools.map((t) => t.name).join(', ')}`);

// ---------- understanding: a real model when this machine has a key, else the phrase list ----------
const { model } = (await fetch('/sim/understand', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {}), () => ({}))) as { model?: string | null };
const brain = model ? { model } : null;
const brainChip = $('brain');
brainChip.hidden = false;
brainChip.textContent = brain ? brain.model.replace(/-(\d+)-(\d+)$/, ' $1.$2').replaceAll('-', ' ').toUpperCase() : 'PHRASE LIST';
brainChip.title = brain ? 'A real language model chooses the tool from what was said, as Alexa+ does.' : "A fixed phrase list stands in for Alexa+'s language model. Put ANTHROPIC_API_KEY in .env to use a real one.";
let lastSaid: string | undefined;
async function understood(utterance: string, who: string | null): Promise<Call | string | null> {
  if (!brain) return route(utterance, people, who, clockIn);
  const clock = new Date(now()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  log('out', `${brain.model} ← "${utterance}"`);
  const r = (await fetch('/sim/understand', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: utterance, who, people, clock, asked: lastSaid }) }).then(
    (res) => res.json(),
    () => ({ error: 'unreachable' }),
  )) as Call | { say: string } | { error: string };
  if ('tool' in r) return r;
  if ('say' in r) return r.say;
  log('err', `${brain.model}: ${r.error}; the phrase list answers this one`);
  return route(utterance, people, who, clockIn);
}

// ---------- household ----------
let people: string[] = [];
let speaker: string | null = 'Mum';
function setPeople(names: string[]) {
  if (names.join() === people.join()) return;
  people = names;
  const who = $('who');
  who.replaceChildren();
  for (const name of ['Mum', ...names]) {
    const b = el('button', '', who);
    b.type = 'button';
    b.dataset.name = name;
    b.setAttribute('aria-label', `Speak as ${name}`);
    el('span', 'av', b, name.charAt(0).toUpperCase()).setAttribute('aria-hidden', 'true');
    el('span', 'nm', b, name.toUpperCase()).setAttribute('aria-hidden', 'true');
    b.setAttribute('aria-pressed', String(name === speaker));
    b.addEventListener('click', () => {
      speaker = name;
      for (const x of who.children) x.setAttribute('aria-pressed', String(x === b));
    });
  }
}
async function loadPeople() {
  const body = (await (await fetch('/api/board?since=-1', { cache: 'no-store' })).json()) as { people?: { name: string }[] };
  setPeople((body.people ?? []).map((p) => p.name));
}

// ---------- conversation ----------
const voiceOn = 'speechSynthesis' in window;
/** Append `text` word by word: each word blurs in 45 ms after the one before. */
function words(into: HTMLElement, text: string) {
  let i = 0;
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) into.append(part);
    else el('span', 'w', into, part).style.setProperty('--i', String(i++));
  }
}
function addMsg(kind: 'you' | 'alexa', text: string, who: string, error = false) {
  const log = $('log');
  const m = el('div', `msg ${kind}${error ? ' err' : ''}`, log);
  el('span', 'who-l', m, who.toUpperCase());
  m.append(document.createTextNode(text));
  if (log.childElementCount > 100) log.firstElementChild!.remove();
  log.scrollTop = log.scrollHeight;
  // The captions under the screen: what was just said, and Alexa's answer, as subtitles.
  if (kind === 'you') {
    const cap = $('capYou');
    cap.replaceChildren();
    el('b', '', cap, who.toUpperCase());
    words(el('span', '', cap), `“${text}”`);
    const alexa = $('capAlexa');
    alexa.classList.remove('err');
    alexa.replaceChildren();
    el('b', '', alexa, 'ALEXA');
    el('em', '', alexa, '…');
    const b = [...$('who').children].find((x) => (x as HTMLElement).dataset.name === who);
    if (b) {
      b.classList.add('talking');
      setTimeout(() => b.classList.remove('talking'), 1600);
    }
  } else {
    const alexa = $('capAlexa');
    alexa.classList.toggle('err', error);
    alexa.replaceChildren();
    el('b', '', alexa, 'ALEXA');
    words(el('em', '', alexa), text);
  }
}
let replyTimer: ReturnType<typeof setTimeout> | undefined;
function alexaSays(text: string, error = false) {
  lastSaid = text;
  addMsg('alexa', text, 'Alexa', error);
  const reply = $('reply');
  reply.textContent = text;
  reply.classList.toggle('show', mode === 'inline' || !view);
  clearTimeout(replyTimer);
  replyTimer = setTimeout(() => reply.classList.remove('show'), 7000);
  if (voiceOn) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.04;
    u.voice = speechSynthesis.getVoices().find((v) => /en[-_](US|GB|IN)/i.test(v.lang) && /female|aria|jenny|zira|samantha/i.test(v.name)) ?? null;
    speechSynthesis.speak(u);
  }
}

// ---------- the board view ----------
// `ready` settles when the board finishes ui/initialize: the spec forbids sending it anything before that.
let view: { iframe: HTMLIFrameElement; bridge: AppBridge; ready: Promise<void> } | null = null;
let mode: 'inline' | 'fullscreen' = 'inline';
function setMode(m: 'inline' | 'fullscreen') {
  mode = m;
  if (view) view.iframe.className = `view ${m}`;
}

async function openView(args: Record<string, unknown>, result: CallToolResult) {
  const res = await client.readResource({ uri: BOARD_URI });
  log('in', `resources/read ${BOARD_URI} → ${res.contents[0].mimeType}`);
  const iframe = document.createElement('iframe');
  iframe.className = 'view inline';
  iframe.title = 'Doorbound board';
  // An opaque origin: the board can reach this page only through the MCP Apps bridge.
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.srcdoc = 'text' in res.contents[0] ? String(res.contents[0].text) : '';
  $('screen').append(iframe);
  $('home').classList.add('gone');
  const bridge = new AppBridge(
    client,
    { name: 'doorbound-alexa-sim', version: '1.0.0' },
    { serverTools: {}, logging: {} },
    { hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], platform: 'web', theme: 'dark', locale: navigator.language } },
  );
  let initialised!: () => void;
  const ready = new Promise<void>((r) => (initialised = r));
  bridge.oninitialized = () => {
    initialised();
    log('in', 'board view initialised (ui/initialize, protocol 2026-01-26)');
    void bridge.sendToolInput({ arguments: args });
    void bridge.sendToolResult(result);
  };
  bridge.onrequestdisplaymode = async ({ mode: m }) => {
    log('out', `board view → ui/request-display-mode ${m}`);
    setMode(m === 'fullscreen' ? 'fullscreen' : 'inline');
    await bridge.sendHostContextChange({ displayMode: mode });
    return { mode };
  };
  bridge.oncalltool = async (params) => {
    const r = (await client.callTool(params)) as CallToolResult;
    if (params.name === 'get_board') logPoll((r.structuredContent as { unchanged?: boolean } | undefined)?.unchanged === true);
    else {
      log('out', `board view → tools/call ${params.name} ${JSON.stringify(params.arguments ?? {})}`);
      const text = r.content.find((c) => c.type === 'text');
      if (text && 'text' in text) alexaSays(String(text.text), r.isError === true);
    }
    return r;
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  view = { iframe, bridge, ready };
}

async function hear(utterance: string, who: string | null) {
  addMsg('you', utterance, who ?? 'Someone');
  await syncClock();
  const call = await understood(utterance, who);
  if (!call) return alexaSays("Sorry, I can't help with that in Doorbound yet.");
  if (typeof call === 'string') return alexaSays(call);
  log('out', `tools/call ${call.tool} ${JSON.stringify(call.args)}`);
  const started = performance.now();
  let r: CallToolResult;
  try {
    r = (await client.callTool({ name: call.tool, arguments: call.args })) as CallToolResult;
  } catch (e) {
    log('err', `${call.tool} failed: ${(e as Error).message}`);
    return alexaSays('Doorbound is not answering right now.', true);
  }
  log(r.isError ? 'err' : 'in', `← ${call.tool} ${r.isError ? 'error result' : 'result'} in ${Math.round(performance.now() - started)} ms`);
  const text = r.content.find((c) => c.type === 'text');
  alexaSays(text && 'text' in text ? String(text.text) : '', r.isError === true);
  const board = r.structuredContent as { people?: { name: string }[] } | undefined;
  if (board?.people) setPeople(board.people.map((p) => p.name));
  if (r.isError) return;
  if (!view) await openView(call.args, r);
  else {
    await view.ready;
    await view.bridge.sendToolResult(r);
  }
}

// ---------- input: voice, typing, suggestions ----------
$<HTMLFormElement>('say').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('text');
  const text = input.value.trim().slice(0, 300);
  if (!text) return;
  input.value = '';
  void hear(text, speaker);
});
for (const s of ['Start the school run. We leave in 40 minutes.', "I'm done.", "Isha's still in the shower.", 'How are we doing?', 'We need to leave 5 minutes early.', 'Undo that.', 'What have you learned?', 'We leave at 7:49 tomorrow. When should everyone be up?']) {
  const b = el('button', '', $('tries'), s);
  b.type = 'button';
  b.addEventListener('click', () => void hear(s, speaker));
}

type Recognition = { lang: string; interimResults: boolean; start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null };
const SR = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
const mic = $<HTMLButtonElement>('mic');
if (!SR) mic.hidden = true;
else {
  let rec: Recognition | null = null;
  const stop = () => rec?.stop();
  mic.addEventListener('pointerdown', () => {
    rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.onresult = (e) => void hear(e.results[0][0].transcript, speaker);
    rec.onend = () => (mic.classList.remove('on'), $('bar').classList.remove('on'));
    rec.start();
    mic.classList.add('on');
    $('bar').classList.add('on');
  });
  mic.addEventListener('pointerup', stop);
  mic.addEventListener('pointerleave', stop);
}

// ---------- the demo morning: the design-frame story, on the server's clock ----------
const DEMO = DEMO_MORNING.map((e) => [e.at, e.who, e.say] as const);
const GATE_MIN = 'start' in DEMO_MORNING[0].act ? DEMO_MORNING[0].act.start : 36;
/** The morning as a line: a dot per line said, the news in red, the gate at the end; it fills as time passes. */
function timeline(startPerf: number) {
  const tl = $('tl');
  tl.hidden = false;
  for (const x of tl.querySelectorAll('.tick, .lbl')) x.remove();
  const ticks = DEMO.map(([minute, , line]) => {
    const key = /still/i.test(line);
    const t = el('div', `tick${key ? ' key' : ''}`, tl);
    t.style.left = `${(100 * minute) / GATE_MIN}%`;
    if (key || minute === 0) el('div', `lbl${key ? ' key' : ''}`, tl, key ? 'STILL IN THE SHOWER' : 'START').style.left = `${(100 * minute) / GATE_MIN}%`;
    return [minute, t] as const;
  });
  el('div', 'lbl end', tl, 'GATE').style.left = '100%';
  const fill = $('tlFill');
  const step = () => {
    const minutes = ((performance.now() - startPerf) * rate) / 60_000;
    fill.style.transform = `scaleX(${Math.min(1, minutes / GATE_MIN).toFixed(4)})`;
    for (const [m, t] of ticks) t.classList.toggle('past', m <= minutes);
    if (minutes < GATE_MIN + 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
$('play').addEventListener('click', async () => {
  const play = $<HTMLButtonElement>('play');
  play.disabled = true;
  play.textContent = 'Playing…';
  await client.callTool({ name: 'end_departure', arguments: {} }).catch(() => undefined);
  await syncClock();
  const start = performance.now();
  timeline(start);
  for (const [minute, who, line] of DEMO) {
    const at = start + (minute * 60_000) / rate;
    await new Promise((r) => setTimeout(r, Math.max(0, at - performance.now())));
    await hear(line, who);
    // The customer taps "Open the board" on the inline card, as Alexa's design guide expects.
    if (minute === 0 && view) {
      await view.ready;
      setMode('fullscreen');
      await view.bridge.sendHostContextChange({ displayMode: 'fullscreen' });
    }
  }
  play.disabled = false;
  play.textContent = 'Play again →';
});

// ---------- the drawer: the whole conversation, and every MCP message ----------
const drawer = $('drawer');
const drawerBtn = $('drawerBtn');
drawerBtn.addEventListener('click', () => {
  const open = !drawer.classList.contains('open');
  drawer.classList.toggle('open', open);
  drawerBtn.setAttribute('aria-expanded', String(open));
});
for (const [tab, panel] of [['tabLog', 'log'], ['tabInsp', 'insp']] as const)
  $(tab).addEventListener('click', () => {
    for (const [t, p] of [['tabLog', 'log'], ['tabInsp', 'insp']] as const) {
      $(t).setAttribute('aria-selected', String(t === tab));
      $(p).hidden = p !== panel;
    }
  });

// ---------- home screen clock ----------
await syncClock();
await loadPeople();
function home() {
  $('homeTime').textContent = hhmm(now());
  $('homeDate').textContent = new Date(now()).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
home();
setInterval(home, 1000);
