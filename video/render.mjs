// Renders video/film.html: Playwright draws each frame with window.seek(t), JPEGs stream straight into ffmpeg
// (no frames on disk), then the mix goes on at -14 LUFS for YouTube.
//   node video/render.mjs                      the film: 1920x1080, 60 fps, out/doorbound.mp4
//   node video/render.mjs --stills 2,10,40     a contact sheet of single frames (out/sheet.jpg), to review first
//   node video/render.mjs --from 80 --to 100 --fps 30 --scale 0.5     a quick draft of one stretch
import { spawn, execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

// Chromium will not load ES modules (three.js) from file://, so the project is served on this machine only.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const root = process.cwd();
const server = createServer(async (req, res) => {
  const path = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  try { res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(await readFile(path)); }
  catch { res.writeHead(404).end(); }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const fps = Number(flag('fps', 60)), scale = Number(flag('scale', 1)), stills = flag('stills', '');
// The GPU (through ANGLE on Direct3D 11) draws the 3D world; without these flags Chromium falls back to software.
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: scale });
page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });
page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text()));
await page.goto(`${origin}/video/film.html?render=1`);
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => window.WORLD, null, { timeout: 60_000 }); // the 3D world, loaded and lit
const total = await page.evaluate(() => window.DURATION);
const shot = (t) => page.evaluate((t) => window.seek(t), t).then(() => page.screenshot({ type: 'jpeg', quality: 95 }));

if (stills) {
  // One frame per time, tiled four across with its time burned in: the storyboard to critique.
  const times = stills.split(',').map(Number);
  const files = [];
  for (const [i, t] of times.entries()) {
    const f = `video/out/still-${String(i).padStart(2, '0')}.jpg`;
    await page.evaluate((t) => window.seek(t), t);
    await page.screenshot({ path: f, type: 'jpeg', quality: 85 });
    files.push(f);
  }
  await browser.close();
  server.close();
  const inputs = files.flatMap((f) => ['-i', f]);
  const labelled = files.map((_, i) => `[${i}:v]scale=480:270,drawtext=text='${times[i]}s':x=8:y=8:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6[v${i}]`).join(';');
  const cols = 4, rows = Math.ceil(files.length / cols);
  const layout = files.map((_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 270}`).join('|');
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', `${labelled};${files.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=black[out]`, '-map', '[out]', '-frames:v', '1', 'video/out/sheet.jpg']);
  console.log(`video/out/sheet.jpg: ${files.length} frames, ${cols}x${rows}`);
  process.exit();
}

const from = Number(flag('from', 0)), to = Math.min(total, Number(flag('to', total)));
const N = Math.round((to - from) * fps);
const silent = `video/out/picture-${from}-${to}.mp4`;
const enc = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', '-r', String(fps), silent], { stdio: ['pipe', 'inherit', 'inherit'] });
const started = Date.now();
for (let i = 0; i < N; i++) {
  const buf = await shot(from + i / fps);
  if (!enc.stdin.write(buf)) await new Promise((r) => enc.stdin.once('drain', r));
  if (i % (fps * 10) === 0) console.log(`${(from + i / fps).toFixed(0)} s of ${to.toFixed(0)}, ${((Date.now() - started) / 1000).toFixed(0)} s so far`);
}
enc.stdin.end();
await new Promise((r) => enc.on('close', r));
await browser.close();
server.close();
// The mix, cut to the same stretch, loudness-normalised for YouTube (-14 LUFS, true peak -1.5 dB).
const final = from === 0 && to === total ? 'video/out/doorbound.mp4' : `video/out/draft-${from}-${to}.mp4`;
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', silent, '-ss', String(from), '-t', String(to - from), '-i', 'video/out/mix.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', '-shortest', final], { stdio: 'inherit' });
console.log(`${final}: ${N} frames at ${fps} fps in ${((Date.now() - started) / 1000).toFixed(0)} s`);
