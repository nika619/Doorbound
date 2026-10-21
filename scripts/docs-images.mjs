// The README's images, made from the product so they never drift from it: the board when someone slips
// and after the re-route (and the re-route as a GIF), the inline card, the simulator mid-morning, and the
// story page's chapters.
//   npm run build && node scripts/docs-images.mjs        (needs ffmpeg and Playwright's Chromium)
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const tmp = mkdtempSync(join(tmpdir(), 'docs-images-'));
const jpg = (png, name, width) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', png, ...(width ? ['-vf', `scale=${width}:-1`] : []), '-q:v', '3', `docs/${name}`]);
mkdirSync('docs', { recursive: true });
const browser = await chromium.launch();

// ---------- the board, replaying the demo morning ----------
const board = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await board.goto(pathToFileURL('dist/board.html').href + '#replay');
// Before the news: 7:26, Isha's shower running past its usual time, half a minute before Mum says so.
await board.waitForFunction(() => document.getElementById('clock')?.textContent === '7:26', null, { timeout: 120_000 });
await board.waitForTimeout(1500);
await board.screenshot({ path: join(tmp, 'tight.png') });
jpg(join(tmp, 'tight.png'), 'board-tight.jpg', 1600);
await board.waitForFunction(() => document.body.innerText.includes('Re-routed'), null, { timeout: 120_000 });
for (let i = 0; i < 45; i++) {
  await board.screenshot({ path: join(tmp, `f${String(i).padStart(3, '0')}.png`) });
  await board.waitForTimeout(66);
}
await board.waitForTimeout(1500);
await board.screenshot({ path: join(tmp, 'rerouted.png') });
jpg(join(tmp, 'rerouted.png'), 'board-rerouted.jpg', 1600);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', '15', '-i', join(tmp, 'f%03d.png'), '-vf', 'scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer', 'docs/reroute.gif']);

// ---------- the story page ----------
const site = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await site.goto(pathToFileURL('dist/site.html').href);
await site.waitForTimeout(2600);
await site.screenshot({ path: join(tmp, 'story.png') });
jpg(join(tmp, 'story.png'), 'story.jpg', 1600);
for (const [id, at, name] of [['maths', 0.47, 'story-maths.jpg'], ['pace', 0.55, 'story-pace.jpg'], ['replan', 0.97, 'story-replan.jpg']]) {
  await site.evaluate(([id, at]) => {
    const el = document.getElementById(id);
    scrollTo(0, el.offsetTop + at * (el.offsetHeight - innerHeight));
  }, [id, at]);
  await site.waitForTimeout(1800);
  await site.screenshot({ path: join(tmp, `${id}.png`) });
  jpg(join(tmp, `${id}.png`), name, 1600);
}

// ---------- a real server: the inline card and the simulator ----------
const port = 39_400 + Math.floor(Math.random() * 400);
const data = join(tmp, 'data');
const server = spawn(process.execPath, ['dist/server.mjs'], { env: { ...process.env, PORT: String(port), DEMO_SEED: '1', DEMO_SPEED: '20', DATA_DIR: data }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 40; i++) {
  if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}
const sim = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await sim.goto(`${base}/sim`);
await sim.click('#play');
await sim.waitForTimeout(26_000); // the scripted morning, at twenty times speed, into the re-route
await sim.screenshot({ path: join(tmp, 'sim.png') });
jpg(join(tmp, 'sim.png'), 'simulator.jpg', 1600);
const card = await browser.newPage({ viewport: { width: 520, height: 330 }, deviceScaleFactor: 2 });
await card.goto(`${base}/board`);
await card.waitForTimeout(6000); // past the entrance animation
await card.screenshot({ path: join(tmp, 'card.png') });
jpg(join(tmp, 'card.png'), 'card.jpg');
server.kill();
await browser.close();
rmSync(tmp, { recursive: true, force: true });
console.log('docs/: board-tight.jpg, board-rerouted.jpg, reroute.gif, story.jpg, story-maths.jpg, story-pace.jpg, story-replan.jpg, simulator.jpg, card.jpg');
