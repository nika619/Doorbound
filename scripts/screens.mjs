// The board at real Echo Show and TV sizes, replaying the demo morning: nothing may scroll, run off the
// screen or be set below 12 px. Decorative layers and screen-reader text are allowed to overflow.
//   npm run build && npm run screens        (writes a screenshot per size to dist/screens/)
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const SIZES = [
  [960, 480, 'Echo Show 5'],
  [1024, 600, 'Echo Show 5 (1st gen)'],
  [1280, 800, 'Echo Show 8 and 10'],
  [1920, 1080, 'Echo Show 15 and 21, TVs'],
];
const ALLOWED = /\b(ghost|w|sr|blk)\b/; // the background numeral, its letters, hidden screen-reader text, runway labels that ellipsize
mkdirSync('dist/screens', { recursive: true });
const browser = await chromium.launch();
let bad = 0;
for (const [w, h, name] of SIZES) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(pathToFileURL('dist/board.html').href + '#replay');
  await page.waitForSelector('.row', { timeout: 30_000 });
  await page.waitForTimeout(6000);
  const found = await page.evaluate((allowed) => {
    const ok = new RegExp(allowed);
    const shown = [...document.querySelectorAll('body *')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !ok.test(e.className);
    });
    const leaf = (e) => e.children.length === 0 && e.textContent.trim();
    return [
      ...(document.documentElement.scrollHeight > innerHeight + 1 ? ['the page scrolls'] : []),
      ...shown.filter((e) => e.getBoundingClientRect().right > innerWidth + 1 || e.getBoundingClientRect().bottom > innerHeight + 1).map((e) => `off screen: ${e.className || e.tagName}`),
      ...shown.filter((e) => leaf(e) && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').map((e) => `cut off: "${e.textContent.trim().slice(0, 24)}"`),
      ...shown.filter((e) => leaf(e) && parseFloat(getComputedStyle(e).fontSize) < 12).map((e) => `under 12 px: "${e.textContent.trim().slice(0, 24)}"`),
    ];
  }, ALLOWED.source);
  await page.screenshot({ path: `dist/screens/${w}x${h}.png` });
  console.log(`${found.length ? 'FAIL' : 'ok  '}  ${name} (${w}x${h})${found.length ? `: ${[...new Set(found)].join('; ')}` : ''}`);
  bad += found.length ? 1 : 0;
}
await browser.close();
process.exit(bad ? 1 : 0);
