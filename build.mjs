// Build: esbuild bundles src/main.js, inlines it into template.html -> dist/index.html.
//   node build.mjs          minified production build, prints size
//   node build.mjs --unmin  dist/index.html without minification (readable stacks)
//   node build.mjs --dev    unminified build (dist/dev.html) served on http://localhost:5173, rebuilt on change
// WGSL inside /* wgsl */ `...` template literals is stripped of comments and
// whitespace in production builds.

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const dev = process.argv.includes('--dev');
const unmin = process.argv.includes('--unmin'); // debugging: readable dist/index.html
const PORT = Number(process.env.PORT) || 5173;

function minifyWgsl(src) {
  return src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}()[\];,:=<>*&|!@])\s*/g, '$1')
    .trim();
}

const wgslPlugin = {
  name: 'wgsl-min',
  setup(b) {
    if (dev) return;
    b.onLoad({ filter: /src[\\/].*\.js$/ }, async (args) => {
      const code = await readFile(args.path, 'utf8');
      if (!code.includes('/* wgsl */')) return null;
      return { contents: code.replace(/\/\* wgsl \*\/ `([^`]*)`/g, (_, body) => '`' + minifyWgsl(body) + '`'), loader: 'js' };
    });
  },
};

let html = '';
const htmlPlugin = {
  name: 'inline-html',
  setup(b) {
    b.onEnd(async (res) => {
      if (res.errors.length) return;
      const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
      const tpl = await readFile('template.html', 'utf8');
      html = tpl.replace('<!--APP-->', () => '<script type="module">' + js + '</script>');
      await mkdir('dist', { recursive: true });
      const out = dev ? 'dist/dev.html' : 'dist/index.html'; // dev never clobbers the deliverable
      await writeFile(out, html);
      const bytes = Buffer.byteLength(html);
      const gz = gzipSync(html).length;
      console.log(`${out}  ${(bytes / 1024).toFixed(1)} KB${dev ? ' (dev, unminified)' : ' minified'}  ${(gz / 1024).toFixed(1)} KB gzip  (js ${(Buffer.byteLength(js) / 1024).toFixed(1)} KB)`);
    });
  },
};

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !dev && !unmin,
  write: false,
  legalComments: 'none',
  plugins: [wgslPlugin, htmlPlugin],
  logLevel: 'warning',
};

if (!dev) {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } else {
      res.writeHead(404); res.end();
    }
  }).listen(PORT, '127.0.0.1', () => console.log(`dev server: http://localhost:${PORT}/  (rebuilds on change; reload the page)`));
}
