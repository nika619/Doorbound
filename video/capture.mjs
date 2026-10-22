// The real board, filmed frame by frame: the demo morning's replay under a stopped clock that moves exactly
// 1/60 s per frame, with every CSS and Web Animation stepped by hand. No screen recording, so no judder.
//   npm run build && node video/capture.mjs        (writes video/out/footage/<segment>/00000.jpg ...)
import { mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const FPS = 60;
const dt = 1000 / FPS;
// Seconds into the replay (20x clock: one demo minute is 3 s). Each segment is one story beat.
const SEGMENTS = { A: [0, 9], B: [23.6, 28.6], C: [39.5, 52], D: [111.5, 119.5] };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1.25 });
await page.clock.install({ time: new Date(2026, 9, 22, 6, 0) });
await page.clock.pauseAt(new Date(2026, 9, 22, 6, 0, 1)); // installed, the fake clock still runs in real time until paused
await page.goto(pathToFileURL('dist/board.html').href + '#replay');
await page.evaluate(() => document.fonts.ready);
// Animations started by the page run on the real clock; hold each one and move it with ours.
const step = (ms) =>
  page.evaluate((ms) => {
    for (const a of document.getAnimations()) {
      if (a.__t === undefined) (a.__t = 0), a.pause();
      a.__t += ms;
      a.currentTime = a.__t;
    }
  }, ms);
const advance = async (ms) => {
  for (let left = ms; left > 0; left -= 500) {
    await page.clock.runFor(Math.min(500, left));
    await step(Math.min(500, left));
  }
};

let at = 0; // replay ms so far
for (const [name, [from, to]] of Object.entries(SEGMENTS)) {
  await advance(from * 1000 - at);
  const dir = `video/out/footage/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = Math.round((to - from) * FPS);
  // Proof the clock is right: the board's own clock at this segment (7:12 plus a twentieth of the replay time).
  console.log(`${name} opens at board clock ${await page.evaluate(() => document.getElementById('clock')?.textContent)}`);
  for (let i = 0; i < frames; i++) {
    await page.screenshot({ path: `${dir}/${String(i).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 92 });
    await page.clock.runFor(dt);
    await step(dt);
  }
  at = to * 1000;
  console.log(`${name}: ${frames} frames, replay ${from}-${to} s`);
}
await browser.close();
