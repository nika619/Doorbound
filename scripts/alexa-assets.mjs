// The images an Alexa+ add-on listing needs, made from the product itself: the icon in the six sizes
// Alexa+ asks for, and a 600x900 portrait of the real board mid-morning (the re-route in the demo).
//   npm run build && node scripts/alexa-assets.mjs        writes alexa/*.png
import { mkdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#14120f"/>
  <rect x="22" y="18" width="56" height="64" rx="8" fill="#ffb547"/>
  <path fill="#14120f" fill-rule="evenodd" d="M34 30h12a20 20 0 0 1 0 40h-12zM41 37h5a13 13 0 0 1 0 26h-5z"/>
  <rect x="22" y="49" width="56" height="2.4" fill="#14120f"/>
</svg>`; // a split-flap tile showing D: the board's own letterforms, in its amber on its warm dark

mkdirSync('alexa', { recursive: true });
const browser = await chromium.launch();
for (const size of [64, 72, 88, 126, 180, 241]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${ICON}`);
  await page.screenshot({ path: `alexa/icon-${size}.png` });
  await page.close();
}
// The board is landscape, so the portrait card frames a sharp capture of it with the story around it.
const board = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await board.goto(pathToFileURL('dist/board.html').href + '#replay');
await board.waitForFunction(() => document.body.innerText.includes('Re-routed'), null, { timeout: 120_000 });
await board.waitForTimeout(4000); // let the re-route's choreography land
const shot = (await board.screenshot()).toString('base64');
const font = (pkg, file) => `url(data:font/woff2;base64,${readFileSync(`node_modules/@fontsource/${pkg}/files/${file}`).toString('base64')})`;
const card = await browser.newPage({ viewport: { width: 600, height: 900 }, deviceScaleFactor: 1 });
await card.setContent(`<style>
@font-face { font-family: C; font-weight: 700; src: ${font('barlow-condensed', 'barlow-condensed-latin-700-normal.woff2')}; }
@font-face { font-family: B; src: ${font('barlow', 'barlow-latin-400-normal.woff2')}; }
@font-face { font-family: S; font-style: italic; src: ${font('instrument-serif', 'instrument-serif-latin-400-italic.woff2')}; }
html, body { margin: 0; width: 600px; height: 900px; background: radial-gradient(520px 420px at 80% 18%, #ffb54722, transparent 70%), #0d0c0a; color: #f3ede2; }
main { padding: 54px 40px 0; }
.k { font: 700 15px/1 C; letter-spacing: .26em; color: #ffb547; }
h1 { margin: 22px 0 0; font: 700 70px/.92 C; text-transform: uppercase; letter-spacing: .005em; }
h1 em { font: italic 400 76px/1 S; text-transform: none; color: #ffb547; }
p { margin: 18px 0 0; font: 400 20px/1.4 B; color: #b9b1a4; }
img { display: block; width: 520px; margin: 34px 0 0; border-radius: 12px; border: 1px solid #ffffff1a; box-shadow: 0 30px 80px #000c; }
q { display: block; margin: 34px 0 0; font: 400 21px/1.35 B; }
.a { margin-top: 10px; font: 700 19px/1.3 C; letter-spacing: .04em; color: #ffb547; }
</style><main><div class="k">DOORBOUND · ON ALEXA+</div><h1>Every morning<br>is a <em>departure.</em></h1>
<p>Real chances of leaving on time, learned from your own mornings, and a gentle re-plan when someone runs late.</p>
<img src="data:image/png;base64,${shot}" alt="">
<q>Isha's still in the shower. Nine more minutes, she says.</q>
<div class="a">RE-ROUTED: BREAKFAST TO GO, DAD PACKS HER BAG. EVERYONE STILL LEAVES AT 7:49.</div></main>`);
await card.evaluate(() => document.fonts.ready);
await card.screenshot({ path: 'alexa/carousel.png' });
await browser.close();
console.log('alexa/icon-{64,72,88,126,180,241}.png and alexa/carousel.png written');
