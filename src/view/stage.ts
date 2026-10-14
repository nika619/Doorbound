// The stage. One file, two homes: inside an MCP host it talks through the host bridge;
// opened directly (a TV) it reads the same state over plain HTTP.
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
import { elapsedMs, remainingMs, resolve, type Show, type StageState } from '../core/show.ts';

const $ = (id: string) => document.getElementById(id)!;
const embedded = window.parent !== window;
const app = embedded ? new App({ name: 'marquee-stage', version: '0.1.0' }, {}) : null;

let state: StageState | null = null;
let offsetMs = 0; // server clock minus this device's clock
const serverNow = () => Date.now() + offsetMs;

function adopt(s: StageState, sentAt: number, receivedAt: number) {
  // The server stamped its time somewhere between send and receive; the midpoint is the best guess.
  offsetMs = s.serverNowMs - (sentAt + receivedAt) / 2;
  state = s;
}

async function sync() {
  const sentAt = Date.now();
  try {
    const s: StageState = app
      ? ((await app.callServerTool({ name: 'get_stage_state', arguments: {} })).structuredContent as unknown as StageState)
      : await (await fetch('/api/state', { cache: 'no-store' })).json();
    adopt(s, sentAt, Date.now());
  } catch {
    // Keep drawing from the last known state; the clock still runs.
  }
}

let drawnKey = '';
function setText(id: string, text: string) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}
const clockText = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : String(s);
};

function draw(show: Show | null, now: number) {
  const scene = show?.scene;
  // Restart the entrance animation only when the scene itself changes.
  const key = show ? `${show.id}:${show.sceneStartedAtMs}:${scene!.kind}` : 'empty';
  if (key !== drawnKey) {
    drawnKey = key;
    $('headline').hidden = scene?.kind !== 'title' && !!scene;
    $('subline').hidden = scene?.kind !== 'title' && !!scene;
    $('count').hidden = scene?.kind !== 'countdown';
    $('score').hidden = scene?.kind !== 'scoreboard';
  }
  document.body.classList.toggle('paused', !!show && show.pausedAtMs !== null);
  const toggle = $('toggle') as HTMLButtonElement;
  toggle.hidden = !show || !app;
  toggle.textContent = show?.pausedAtMs !== null ? 'Resume' : 'Pause';
  toggle.setAttribute('aria-label', show?.pausedAtMs !== null ? 'Resume the show' : 'Pause the show');

  if (!show || !scene) {
    setText('eyebrow', '');
    setText('headline', 'Marquee');
    setText('subline', 'Say the occasion to start a show.');
    return;
  }
  setText('eyebrow', show.title);
  if (scene.kind === 'title') {
    setText('headline', scene.headline);
    setText('subline', scene.subline ?? '');
  } else if (scene.kind === 'countdown') {
    const left = remainingMs(show, now);
    setText('eyebrow', scene.label);
    setText('digits', clockText(left));
    $('ring').setAttribute('stroke-dashoffset', String(1 - left / scene.durationMs));
    $('ring').style.visibility = left > 0 ? 'visible' : 'hidden'; // a round line cap leaves a dot at zero
  } else {
    setText('home', scene.home);
    setText('away', scene.away);
    setText('homePts', String(scene.homeScore));
    setText('awayPts', String(scene.awayScore));
  }
}

function frame() {
  const now = serverNow();
  // Timed cues fire on screen at their moment, without waiting for the next sync.
  draw(state?.show ? resolve(state.show, now) : null, now);
  requestAnimationFrame(frame);
}

$('toggle').addEventListener('click', async () => {
  const paused = state?.show?.pausedAtMs !== null;
  await app?.callServerTool({ name: 'control_show', arguments: { action: paused ? 'resume' : 'pause' } });
  void sync();
});

if (app) {
  // The host hands over the result of the tool call that opened this view: draw it at once.
  app.ontoolresult = (result) => {
    const s = result.structuredContent as unknown as StageState | undefined;
    if (s?.serverNowMs) adopt(s, Date.now(), Date.now());
  };
  await app.connect();
  if (app.getHostCapabilities()?.logging) {
    // Lets a host or a test see what this screen believes, once a second.
    setInterval(() => {
      const show = state?.show ? resolve(state.show, serverNow()) : null;
      void app.sendLog({
        level: 'debug',
        data: { at: serverNow(), rev: show?.rev ?? 0, kind: show?.scene.kind ?? 'empty', paused: show ? show.pausedAtMs !== null : false, elapsedMs: show ? elapsedMs(show, serverNow()) : 0, remainingMs: show ? remainingMs(show, serverNow()) : 0, offsetMs },
      });
    }, 1000);
  }
}
await sync();
setInterval(sync, 1000);
requestAnimationFrame(frame);
