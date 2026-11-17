// Private build for tools/flicker-test.mjs (and witness checks): same as build.mjs (minified, WGSL
// stripped) but written to dist/flicker.html so testing never clobbers dist/index.html.
import * as esbuild from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const minifyWgsl = (src) => src.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/\s*([{}()[\];,:=<>*&|!@])\s*/g, '$1').trim();
const wgsl = { name: 'wgsl', setup(b) { b.onLoad({ filter: /src[\\/].*\.js$/ }, async (a) => { const c = await readFile(a.path, 'utf8'); if (!c.includes('/* wgsl */')) return null; return { contents: c.replace(/\/\* wgsl \*\/ `([^`]*)`/g, (_, x) => '`' + minifyWgsl(x) + '`'), loader: 'js' }; }); } };
const r = await esbuild.build({ entryPoints: ['src/main.js'], bundle: true, format: 'esm', target: 'es2022', minify: true, write: false, legalComments: 'none', plugins: [wgsl], logLevel: 'warning' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const tpl = await readFile('template.html', 'utf8');
const html = tpl.replace('<!--APP-->', () => '<script type="module">' + js + '</script>');
await writeFile('dist/flicker.html', html);
console.log('dist/flicker.html', (Buffer.byteLength(html) / 1024).toFixed(1), 'KB');
