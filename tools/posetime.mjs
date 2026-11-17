// GPU time at fixed moments of the scripted drive, A/B against debug flags, interleaved to
// average out other GPU load.
//   node tools/posetime.mjs [--rounds=3] [--times=8,33,58.5,66.3] [--view=0] [--q='&hide=grass' ...]
// Each sample: open ?script=1&capture=1<q>, step to t, render 150 frames at t, read the median
// of the newest GPU frame times. The machine's GPU is shared: compare queries within one run.
import { serveDist, launch, openGame } from './browser.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
const rounds = Number(arg('rounds', '3'));
const times = arg('times', '8,33,58.5,66.3').split(',').map(Number);
const view = arg('view', '0');
const qs = ['', ...process.argv.filter((a) => a.startsWith('--q=')).map((a) => a.slice(4))];

const srv = await serveDist();
const run = await launch('chromium');
const res = {};
try {
  for (let r = 0; r < rounds; r++) {
    for (const q of qs) {
      await openGame(run.page, srv.url, `?script=1&capture=1&view=${view}${q}`);
      await run.page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
      for (const t of times) {
        const ms = await run.page.evaluate(async (t) => {
          for (let i = 0; i < 150; i++) {
            window.__step(t);
            if (i % 30 === 29) await new Promise((r) => setTimeout(r, 30));
          }
          await new Promise((r) => setTimeout(r, 600));
          const T = window.__timing, n = Math.min(T.ringCount, 96), a = [];
          for (let i = 1; i <= n; i++) a.push(T.ring[(T.ringPos - i + T.ring.length) % T.ring.length]);
          a.sort((x, y) => x - y);
          return a[a.length >> 1];
        }, t);
        (res[`t=${t} ${q || '(base)'}`] ||= []).push(ms);
      }
    }
  }
} finally { await run.browser.close(); srv.close(); }
for (const [k, v] of Object.entries(res).sort()) {
  const s = [...v].sort((a, b) => a - b);
  console.log(k.padEnd(32), 'median', s[s.length >> 1].toFixed(2), ' samples', v.map((x) => x.toFixed(2)).join(' '));
}
