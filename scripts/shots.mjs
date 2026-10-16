// Screenshots of the story page at every beat, for review and the README (needs a running server).
// node scripts/shots.mjs <outDir> [width height]
import { chromium } from 'playwright';
const [out, W = '1920', H = '1080'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(W), height: Number(H) } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:3939/');
await page.waitForTimeout(2600);
const targets = [
  ['01-hero', null, 0],
  ['02-problem-a', '#problem', 0.1], ['03-problem-b', '#problem', 0.4], ['04-problem-c', '#problem', 0.68], ['05-problem-d', '#problem', 0.97],
  ['06-maths-a', '#maths', 0.16], ['07-maths-b', '#maths', 0.47], ['08-maths-c', '#maths', 0.7], ['09-maths-d', '#maths', 0.98],
  ['10-replan-a', '#replan', 0.25], ['11-replan-b', '#replan', 0.62], ['12-replan-c', '#replan', 0.97],
  ['13-board', '#board', -0.1], ['14-proof', '#proof', -0.05], ['15-alexa', '#alexa', -0.05], ['16-try', '#try', -0.05],
];
for (const [name, sel, p] of targets) {
  await page.evaluate(([sel, p]) => {
    if (!sel) return scrollTo(0, 0);
    const el = document.querySelector(sel);
    const y = p < 0 ? el.offsetTop + p * innerHeight : el.offsetTop + p * (el.offsetHeight - innerHeight);
    scrollTo(0, y);
  }, [sel, p]);
  await page.waitForTimeout(name === '13-board' ? 4000 : name === '14-proof' ? 2200 : 1100);
  await page.screenshot({ path: `${out}/${name}.png` });
}
await browser.close();
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
