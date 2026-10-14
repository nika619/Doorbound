// Bundle each page's script and inline it into its HTML, so a view is one self-contained file
// (an MCP App resource is served as a single HTML document).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const pages = [
  ['src/view/stage.ts', 'src/view/stage.html', 'dist/stage.html'],
  ['src/sim/host.ts', 'src/sim/host.html', 'dist/host.html'],
];
mkdirSync('dist', { recursive: true });
for (const [entry, template, out] of pages) {
  const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', target: 'es2022', minify: true, write: false, legalComments: 'none' });
  const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
  const html = readFileSync(template, 'utf8').replace('<script>', '<script type="module">').replace('/*SCRIPT*/', () => js);
  writeFileSync(out, html);
  console.log(`${out} ${(html.length / 1024).toFixed(0)} kB`);
}
