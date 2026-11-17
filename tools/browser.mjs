// Shared harness helpers: a static server for dist/ and a headed, GPU-accelerated
// browser launch (Playwright's Chromium build 1254, Brave as fallback).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium } from 'playwright';

export const ROOT = new URL('..', import.meta.url).pathname;
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };

export function serveDist() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = join(ROOT, 'dist', p);
      if (!file.startsWith(join(ROOT, 'dist')) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://localhost:${srv.address().port}/`, close: () => srv.close() }));
  });
}

export const CHROME_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-webgpu-developer-features', // un-quantised timestamp queries, richer adapter info
  '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--window-position=0,0',
];

// Launch headed with a 2560x1440 @ DPR 1 page. `which` = 'chromium' | 'brave'.
export async function launch(which = 'chromium') {
  // JT_NO_DEVFLAG=1 drops --enable-webgpu-developer-features (to check timestamp quantisation).
  const args = process.env.JT_NO_DEVFLAG ? CHROME_ARGS.filter((a) => !a.includes('developer')) : CHROME_ARGS;
  const opts = { headless: false, args };
  // JT_BROWSER=brave, or Playwright's Chromium not installed: Brave.
  if (process.env.JT_BROWSER === 'brave' || (which === 'chromium' && !existsSync(chromium.executablePath()))) which = 'brave';
  if (which === 'brave') opts.executablePath = BRAVE;
  const browser = await chromium.launch(opts);
  const context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  return { browser, page, which, version: browser.version() };
}

export function isSoftwareAdapter(info) {
  if (!info) return true;
  const s = `${info.vendor} ${info.architecture} ${info.device} ${info.description}`.toLowerCase();
  return !!info.isFallbackAdapter || /swiftshader|llvmpipe|software|basic render|lavapipe/.test(s);
}

// Open `query` on the served build and wait for WebGPU init. Returns adapter info or an error.
export async function openGame(page, base, query) {
  await page.goto(base + 'index.html' + query);
  await page.waitForFunction(() => window.__gpu || window.__gpuError, null, { timeout: 30000 });
  return page.evaluate(() => ({ adapter: window.__gpu || null, error: window.__gpuError || null }));
}
