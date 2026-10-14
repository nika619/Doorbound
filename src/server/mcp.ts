import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { addCue, createShow, fireCue, pause, resume, setScene, stageState, type Scene, type Show } from '../core/show.ts';

export const STAGE_URI = 'ui://marquee/stage.html';

/** The household's live show. One at a time: a home has one evening. */
export interface Store {
  get(nowMs: number): Show | null;
  set(show: Show | null): void;
}

const sceneSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('title'), headline: z.string(), subline: z.string().optional() }),
  z.object({ kind: z.literal('countdown'), label: z.string(), durationMs: z.number() }),
  z.object({ kind: z.literal('scoreboard'), home: z.string(), away: z.string(), homeScore: z.number(), awayScore: z.number() }),
]);

const stateSchema = z.object({
  show: z
    .object({
      id: z.string(),
      title: z.string(),
      rev: z.number(),
      scene: sceneSchema,
      sceneStartedAtMs: z.number(),
      pausedAtMs: z.number().nullable(),
      pausedTotalMs: z.number(),
      cues: z.array(z.object({ id: z.string(), label: z.string(), scene: sceneSchema, atMs: z.number().optional(), firedAtMs: z.number().optional() })),
    })
    .nullable(),
  serverNowMs: z.number(),
  elapsedMs: z.number(),
  remainingMs: z.number(),
});

// Alexa speaks the text and draws the view from the same result, so the text is a plain sentence with no symbols.
const ok = (speech: string, show: Show | null, nowMs: number) => ({
  content: [{ type: 'text' as const, text: speech }],
  structuredContent: stageState(show, nowMs),
});
// Amazon's guide: never return nothing; say what went wrong.
const fail = (speech: string) => ({ content: [{ type: 'text' as const, text: speech }], isError: true });
const NO_SHOW = 'There is no show on screen yet. Start one first, for example a birthday or a game night.';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
function spokenDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return [m ? plural(m, 'minute') : '', s || !m ? plural(s, 'second') : ''].filter(Boolean).join(' ');
}

export function buildServer(store: Store, stageHtml: () => string, clock: () => number = Date.now): McpServer {
  const server = new McpServer({ name: 'marquee', version: '0.1.0' });
  const ui = { resourceUri: STAGE_URI };

  registerAppResource(server, 'Marquee stage', STAGE_URI, { description: 'The live stage: the current scene of the household show.' }, async () => ({
    contents: [{ uri: STAGE_URI, mimeType: RESOURCE_MIME_TYPE, text: stageHtml() }],
  }));

  registerAppTool(
    server,
    'start_show',
    {
      title: 'Start a show',
      description:
        'Use when the customer wants the screen dressed for an occasion, such as a birthday, a festival, a welcome or a game night. Puts a title scene on screen and returns the live show.',
      inputSchema: z.object({
        title: z.string().min(1).max(80).describe('Short name of the occasion, for example "Aarav\'s 7th birthday"'),
        headline: z.string().min(1).max(60).describe('The large line shown on screen, for example "Happy Birthday Aarav"'),
        subline: z.string().max(80).optional().describe('A smaller second line, for example "Seven today"'),
      }),
      outputSchema: stateSchema,
      _meta: { ui },
    },
    async ({ title, headline, subline }) => {
      const now = clock();
      const show = createShow(title, { kind: 'title', headline, subline }, now);
      store.set(show);
      return ok(`${title} is on screen.`, show, now);
    },
  );

  registerAppTool(
    server,
    'start_countdown',
    {
      title: 'Start a countdown',
      description: 'Use when the customer wants a countdown on screen now, such as candles, kick-off or midnight. Replaces the current scene and returns the live show.',
      inputSchema: z.object({
        label: z.string().min(1).max(40).describe('What is being counted down to, for example "Candles"'),
        seconds: z.number().int().min(1).max(86_400).describe('Length of the countdown in seconds'),
      }),
      outputSchema: stateSchema,
      _meta: { ui },
    },
    async ({ label, seconds }) => {
      const now = clock();
      const scene: Scene = { kind: 'countdown', label, durationMs: seconds * 1000 };
      const current = store.get(now);
      const show = current ? setScene(current, scene, now) : createShow(label, scene, now);
      store.set(show);
      return ok(`${label} countdown started, ${spokenDuration(seconds)}.`, show, now);
    },
  );

  registerAppTool(
    server,
    'set_score',
    {
      title: 'Set the score',
      description: 'Use when the customer gives or updates a score for a game. Shows a scoreboard with both sides and returns the live show.',
      inputSchema: z.object({
        home: z.string().min(1).max(24).describe('Name of the first side'),
        away: z.string().min(1).max(24).describe('Name of the second side'),
        homeScore: z.number().int().min(0).max(999),
        awayScore: z.number().int().min(0).max(999),
      }),
      outputSchema: stateSchema,
      _meta: { ui },
    },
    async ({ home, away, homeScore, awayScore }) => {
      const now = clock();
      const scene: Scene = { kind: 'scoreboard', home, away, homeScore, awayScore };
      const current = store.get(now);
      const show = current ? setScene(current, scene, now) : createShow(`${home} against ${away}`, scene, now);
      store.set(show);
      return ok(`${home} ${homeScore}, ${away} ${awayScore}.`, show, now);
    },
  );

  registerAppTool(
    server,
    'add_cue',
    {
      title: 'Add a cue',
      description:
        'Use when the customer plans something for later in the show. A cue changes the scene either after a delay, or when the customer calls it by name. Returns the live show with its cue list.',
      inputSchema: z.object({
        label: z.string().min(1).max(40).describe('The name the customer will call it by, for example "cake time"'),
        headline: z.string().min(1).max(60).describe('The large line for the new scene, or the countdown label'),
        subline: z.string().max(80).optional().describe('A smaller second line. Ignored for a countdown cue.'),
        countdownSeconds: z.number().int().min(1).max(86_400).optional().describe('If given, the cue starts a countdown of this length'),
        inSeconds: z.number().int().min(1).max(86_400).optional().describe('If given, the cue fires by itself after this many seconds. If absent, it waits to be called.'),
      }),
      outputSchema: stateSchema,
      _meta: { ui },
    },
    async ({ label, headline, subline, countdownSeconds, inSeconds }) => {
      const now = clock();
      const current = store.get(now);
      if (!current) return fail(NO_SHOW);
      const scene: Scene = countdownSeconds ? { kind: 'countdown', label: headline, durationMs: countdownSeconds * 1000 } : { kind: 'title', headline, subline };
      const show = addCue(current, { label, scene, atMs: inSeconds ? now + inSeconds * 1000 : undefined }, now);
      store.set(show);
      return ok(inSeconds ? `Cue ${label} is set for ${spokenDuration(inSeconds)} from now.` : `Cue ${label} is ready. Say its name when you want it.`, show, now);
    },
  );

  registerAppTool(
    server,
    'fire_cue',
    {
      title: 'Fire a cue',
      description: 'Use when the customer calls a cue by its name during the show. Changes the scene to that cue now and returns the live show.',
      inputSchema: z.object({ label: z.string().min(1).max(40).describe('The cue name as the customer said it') }),
      outputSchema: stateSchema,
      _meta: { ui },
    },
    async ({ label }) => {
      const now = clock();
      const current = store.get(now);
      if (!current) return fail(NO_SHOW);
      const show = fireCue(current, label, now);
      if (!show) {
        const names = current.cues.map((c) => c.label).join(', ');
        return fail(names ? `There is no cue called ${label}. The cues are: ${names}.` : `There is no cue called ${label}. This show has no cues yet.`);
      }
      store.set(show);
      return ok(`${label}.`, show, now);
    },
  );

  registerAppTool(
    server,
    'control_show',
    {
      title: 'Pause, resume or end the show',
      description: 'Use when the customer wants to pause the screen, carry on, or end the show. Returns the live show, or an empty stage after ending.',
      inputSchema: z.object({ action: z.enum(['pause', 'resume', 'end']) }),
      outputSchema: stateSchema,
      annotations: { idempotentHint: true },
      _meta: { ui },
    },
    async ({ action }) => {
      const now = clock();
      const current = store.get(now);
      if (!current) return fail(NO_SHOW);
      if (action === 'end') {
        store.set(null);
        return ok(`${current.title} has ended.`, null, now);
      }
      const show = action === 'pause' ? pause(current, now) : resume(current, now);
      store.set(show);
      return ok(action === 'pause' ? 'Paused.' : 'Carrying on.', show, now);
    },
  );

  // Only the stage calls this: it is how every screen stays on the server's clock.
  registerAppTool(
    server,
    'get_stage_state',
    {
      title: 'Read the stage',
      description: 'Returns the live show and the server time. Called by the stage view to stay in step.',
      outputSchema: stateSchema,
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: STAGE_URI, visibility: ['app'] } },
    },
    async () => {
      const now = clock();
      const show = store.get(now);
      return ok(show ? `${show.title} is on screen.` : 'The stage is empty.', show, now);
    },
  );

  return server;
}
