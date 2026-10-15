// The Alexa+ simulator: a real MCP client and a real MCP Apps host, standing in for the parts of
// Alexa+ that hackathon entrants cannot reach. Speech in (Web Speech API) → a deterministic router
// in place of Alexa's model → tools/call over Streamable HTTP → Alexa's reply spoken, and the board
// rendered from the ui:// resource in a sandboxed frame through the official AppBridge.

import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { route } from './router.ts';

const BOARD_URI = 'ui://departures/board.html';
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
  const line = el('span', kind, insp, `${(performance.now() / 1000).toFixed(1).padStart(6)}s  ${text}\n`);
  if (insp.childElementCount > 200) insp.firstElementChild!.remove();
  line.scrollIntoView({ block: 'nearest' });
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
const client = new Client({ name: 'departures-alexa-sim', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', location.href)));
const protocol = client.getNegotiatedProtocolVersion();
$('proto').textContent = `MCP ${protocol}`;
log('in', `initialize → protocol ${protocol}, server ${client.getServerVersion()?.name ?? '?'}`);
const { tools } = await client.listTools();
log('in', `tools/list → ${tools.map((t) => t.name).join(', ')}`);

// ---------- household ----------
let people: string[] = [];
let speaker: string | null = 'Mum';
function setPeople(names: string[]) {
  if (names.join() === people.join()) return;
  people = names;
  const who = $('who');
  who.replaceChildren();
  for (const name of ['Mum', ...names]) {
    const b = el('button', '', who, name.toUpperCase());
    b.type = 'button';
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
function addMsg(kind: 'you' | 'alexa', text: string, who: string, error = false) {
  const log = $('log');
  const m = el('div', `msg ${kind}${error ? ' err' : ''}`, log);
  el('span', 'w', m, who.toUpperCase());
  m.append(document.createTextNode(text));
  if (log.childElementCount > 100) log.firstElementChild!.remove();
  m.scrollIntoView({ block: 'end', behavior: 'smooth' });
}
let replyTimer: ReturnType<typeof setTimeout> | undefined;
function alexaSays(text: string, error = false) {
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
  iframe.title = 'Departures board';
  // An opaque origin: the board can reach this page only through the MCP Apps bridge.
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.srcdoc = 'text' in res.contents[0] ? String(res.contents[0].text) : '';
  $('screen').append(iframe);
  $('home').classList.add('gone');
  const bridge = new AppBridge(
    client,
    { name: 'departures-alexa-sim', version: '1.0.0' },
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
  const call = route(utterance, people, who, clockIn);
  if (!call) return alexaSays("Sorry, I can't help with that in Departures yet.");
  log('out', `tools/call ${call.tool} ${JSON.stringify(call.args)}`);
  const started = performance.now();
  let r: CallToolResult;
  try {
    r = (await client.callTool({ name: call.tool, arguments: call.args })) as CallToolResult;
  } catch (e) {
    log('err', `${call.tool} failed: ${(e as Error).message}`);
    return alexaSays('Departures is not answering right now.', true);
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
for (const s of ['Start the school run. We leave in 36 minutes.', "I'm done.", "Isha's still in the shower.", 'How are we doing?', 'We need to leave 5 minutes early.', 'Undo that.', 'What have you learned?']) {
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
const DEMO: [number, string | null, string][] = [
  [0, 'Mum', 'Alexa, start the school run. We leave in 36 minutes.'],
  [8.1, 'Dad', "I'm done with the lunches."],
  [12.1, 'Aarav', "I'm done with breakfast."],
  [14.5, 'Mum', "Alexa, Isha's still in the shower. Eight more minutes, she says."],
  [16.0, 'Mum', 'How are we doing?'],
  [16.4, 'Aarav', "I'm done."],
  [18.8, 'Dad', "I'm done."],
  [21.0, 'Isha', "I'm done."],
  [21.6, 'Aarav', "I'm done."],
  [22.0, 'Dad', "I'm done."],
  [25.0, 'Dad', "I'm done."],
  [27.4, 'Isha', "I'm done."],
  [29.6, 'Isha', "I'm done."],
];
$('play').addEventListener('click', async () => {
  const play = $<HTMLButtonElement>('play');
  play.disabled = true;
  await client.callTool({ name: 'end_departure', arguments: {} }).catch(() => undefined);
  await syncClock();
  const start = performance.now();
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
