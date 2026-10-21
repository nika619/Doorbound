// The simulator end to end in a real browser: a server with the demo household, the play button, Alexa's
// first answer, the board opening on the Echo Show, and not one page error on the way. Runs in CI.
//   npm run build && node scripts/sim-check.mjs        (needs Playwright's Chromium)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const data = mkdtempSync(join(tmpdir(), 'sim-check-'));
const port = 39_800 + Math.floor(Math.random() * 100);
// No keys in the environment: this checks the simulator as anyone cloning the repository gets it.
const env = { PATH: process.env.PATH, PORT: String(port), DEMO_SEED: '1', DEMO_SPEED: '20', DATA_DIR: data };
const server = spawn(process.execPath, ['dist/server.mjs'], { env, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 40 && !(await fetch(`${base}/healthz`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 250));

const browser = await chromium.launch();
const problems = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  // The MCP client asks once for a server-sent event stream; a stateless server's 405 is the expected answer.
  page.on('console', (m) => m.type() === 'error' && !/status of 405/.test(m.text()) && problems.push(`console: ${m.text()}`));
  await page.goto(`${base}/sim`);
  await page.getByRole('button', { name: /Play a morning/ }).click();
  await page.waitForFunction(() => /started/i.test(document.getElementById('capAlexa')?.textContent ?? ''), null, { timeout: 20_000 });
  await page.waitForSelector('iframe.view', { state: 'visible', timeout: 10_000 });
  if (!(await page.locator('#hero.gone').count())) problems.push('the play button did not get out of the way');
  // The board on its own, live from the server (not the replay).
  const board = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  board.on('pageerror', (e) => problems.push(`board page error: ${e.message}`));
  await board.goto(`${base}/board`);
  await board.waitForFunction(() => document.querySelectorAll('.row').length === 3, null, { timeout: 10_000 });
} catch (e) {
  problems.push(String(e));
} finally {
  await browser.close();
  server.kill();
  rmSync(data, { recursive: true, force: true });
}
console.log(problems.length ? `FAIL  ${problems.join('\n      ')}` : 'ok    the simulator plays a morning and the board shows the household, with no page errors');
// In GitHub Actions, each problem is also an annotation on the run.
if (process.env.GITHUB_ACTIONS) for (const p of problems) console.log(`::error title=sim-check::${p.replace(/\r?\n/g, ' ')}`);
process.exit(problems.length ? 1 : 0);
