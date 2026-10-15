// Builds each page into one self-contained HTML file (an MCP App resource must be a single document)
// and records a SHA-256 of every inline script and style, so the server can send a CSP that allows
// exactly those blocks and nothing else.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const font = (family, weight, file) =>
  `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${readFileSync(file).toString('base64')}) format('woff2')}`;
const FONTS = [
  font('Barlow Condensed', 700, 'node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2'),
  font('Barlow', 500, 'node_modules/@fontsource/barlow/files/barlow-latin-500-normal.woff2'),
].join('');

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('base64');
const between = (html, open, close) => [...html.matchAll(new RegExp(`${open}([\\s\\S]*?)${close}`, 'g'))].map((m) => m[1]);
// Browsers turn CRLF into LF before hashing inline blocks, so hash (and ship) LF only.
const lf = (text) => text.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));

const pages = [
  { name: 'board', entry: 'src/board/board.ts', template: 'src/board/board.html' },
  // The simulator embeds the board in a srcdoc frame, which inherits its CSP: it must allow the board's code too.
  { name: 'sim', entry: 'src/sim/sim.ts', template: 'src/sim/sim.html', embeds: ['board'] },
];

mkdirSync('dist', { recursive: true });
const manifest = {};
for (const page of pages) {
  if (!existsSync(page.entry)) continue;
  const out = await build({ entryPoints: [page.entry], bundle: true, format: 'esm', target: 'es2022', platform: 'browser', minify: true, write: false, legalComments: 'none', define: { 'process.env.NODE_ENV': '"production"' } });
  const js = lf(out.outputFiles[0].text).replaceAll('</script', '<\\/script');
  const html = lf(readFileSync(page.template, 'utf8'))
    .replace('/*FONTS*/', () => FONTS)
    .replace('<script>/*SCRIPT*/</script>', () => `<script type="module">${js}</script>`);
  const hashes = { scripts: between(html, '<script type="module">', '</script>').map(sha), styles: between(html, '<style>', '</style>').map(sha) };
  for (const other of page.embeds ?? []) {
    hashes.scripts.push(...manifest[other].scripts);
    hashes.styles.push(...manifest[other].styles);
  }
  manifest[page.name] = hashes;
  writeFileSync(`dist/${page.name}.html`, html);
  console.log(`dist/${page.name}.html  ${(html.length / 1024).toFixed(1)} kB  (${(gzipSync(html).length / 1024).toFixed(1)} kB gzip, of which script ${(js.length / 1024).toFixed(1)} kB)`);
}
writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));
