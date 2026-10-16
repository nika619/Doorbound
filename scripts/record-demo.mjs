// Records the demo video: the story page and the simulator's demo morning, captured in a real browser,
// cut together with a synthesized music bed. Under three minutes.
//
//   npm run demo            (in another terminal; a fresh start, so the morning plays from the top)
//   node scripts/record-demo.mjs
//
// Writes dist/video/demo.mp4. Needs ffmpeg on the PATH and Playwright's Chromium.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.DOORBOUND_URL ?? 'http://127.0.0.1:3939';
const out = 'dist/video';
const size = { width: 1920, height: 1080 };
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const ff = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const only = (dir) => join(dir, readdirSync(dir).find((f) => f.endsWith('.webm')));
/** A file's length in seconds, read from ffmpeg's own report (ffprobe is not always installed). */
const duration = (file) => {
  const m = spawnSync('ffmpeg', ['-i', file]).stderr.toString().match(/Duration: (\d+):(\d+):([\d.]+)/);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
};

const browser = await chromium.launch();

// ---------- 1. the story page, scrolled at a reading pace ----------
const storyCtx = await browser.newContext({ viewport: size, recordVideo: { dir: `${out}/story`, size } });
const story = await storyCtx.newPage();
const t0 = Date.now();
const mark = () => (Date.now() - t0) / 1000;
await story.goto(`${base}/`);
/** Scroll to the top of `sel` plus `p` of its scrollable length, eased, over `ms`. */
const glide = (sel, p, ms) =>
  story.evaluate(
    ([sel, p, ms]) =>
      new Promise((done) => {
        const el = sel ? document.querySelector(sel) : null;
        const to = el ? el.offsetTop + p * Math.max(0, el.offsetHeight - innerHeight) : 0;
        const from = scrollY;
        const start = performance.now();
        const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
        const step = (now) => {
          const t = Math.min(1, (now - start) / ms);
          scrollTo(0, from + (to - from) * ease(t));
          if (t < 1) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      }),
    [sel, p, ms],
  );
const hold = (ms) => story.waitForTimeout(ms);
await hold(5500); // the headline arrives, the board starts its morning
const storyStart = 1.2; // skip the blank first frames
await glide('#problem', 0, 2200);
for (const p of [0.25, 0.5, 0.75, 1]) {
  await glide('#problem', p, 2600);
  await hold(1300);
}
const cut1 = mark();
await glide('#maths', 0, 1600);
for (const p of [0.25, 0.5, 0.75, 1]) {
  await glide('#maths', p, 2600);
  await hold(1400);
}
await glide('#replan', 0, 1600);
for (const p of [0.35, 0.7, 1]) {
  await glide('#replan', p, 2600);
  await hold(1500);
}
await glide('#board', -0.05, 2000);
await hold(5000);
await glide('#proof', -0.05, 1800);
await hold(3800);
await glide('#alexa', -0.05, 1800);
await hold(3600);
await glide('#try', 0, 1800);
await hold(4500);
const storyEnd = mark();
await storyCtx.close();

// ---------- 2. the demo morning in the simulator ----------
const simCtx = await browser.newContext({ viewport: size, recordVideo: { dir: `${out}/sim`, size } });
const sim = await simCtx.newPage();
const s0 = Date.now();
await sim.goto(`${base}/sim`);
await sim.waitForTimeout(2500);
const simStart = (Date.now() - s0) / 1000 - 0.8;
await sim.click('#play');
await sim.waitForTimeout(93_000); // 31 minutes of morning at 20x, and a beat to read the last line
const simEnd = (Date.now() - s0) / 1000;
await simCtx.close();
await browser.close();

// ---------- 3. cut, speed and score ----------
const storyVideo = only(`${out}/story`);
const simVideo = only(`${out}/sim`);
const enc = ['-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p', '-an'];
ff('-ss', String(storyStart), '-to', String(cut1), '-i', storyVideo, ...enc, `${out}/a.mp4`);
ff('-ss', String(simStart), '-to', String(simEnd), '-i', simVideo, '-vf', 'setpts=PTS/1.3', ...enc, `${out}/b.mp4`); // the morning, a little faster
ff('-ss', String(cut1), '-to', String(storyEnd), '-i', storyVideo, ...enc, `${out}/c.mp4`);
ff('-i', `${out}/a.mp4`, '-i', `${out}/b.mp4`, '-i', `${out}/c.mp4`, '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0,fade=t=in:d=0.6', ...enc, `${out}/picture.mp4`);
const seconds = duration(`${out}/picture.mp4`);
// A calm bed, synthesized: two slow pads a fifth apart, a soft pulse on the beat (100 BPM), gentle echo.
const pad = 'sin(2*PI*110*t)*0.10+sin(2*PI*164.81*t)*0.07+sin(2*PI*220*t)*0.05*(0.6+0.4*sin(2*PI*0.07*t))+sin(2*PI*277.18*t)*0.035*(0.5+0.5*sin(2*PI*0.05*t))';
const pulse = 'sin(2*PI*55*t)*0.22*exp(-9*mod(t,0.6))';
ff('-f', 'lavfi', '-i', `aevalsrc='(${pad}+${pulse})*0.8':s=48000:d=${seconds}`, '-af', `aecho=0.6:0.5:180|360:0.25|0.15,lowpass=f=2400,afade=t=in:d=2,afade=t=out:st=${Math.max(0, seconds - 4)}:d=4`, '-c:a', 'aac', '-b:a', '192k', `${out}/music.m4a`);
ff('-i', `${out}/picture.mp4`, '-i', `${out}/music.m4a`, '-c:v', 'copy', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', `${out}/demo.mp4`);
console.log(`dist/video/demo.mp4  ${seconds.toFixed(1)} s`);
