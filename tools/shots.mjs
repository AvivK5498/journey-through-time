// Fixed-pose captures and a recording of the scripted drive, for the visual critic.
//   node tools/shots.mjs [--view=0|1|both] [--fps=30] [--no-video] [--keep-frames] [--browser=brave] [--no-build]
// Writes reports/shots/pose{N}_v{view}.png (2560x1440) and reports/shots/drive_v{view}.mp4
// (60 s, rendered frame by frame at fixed time steps via ?script=1&capture=1, so the
// recording is deterministic and independent of capture speed).

import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ROOT, serveDist, launch, openGame, isSoftwareAdapter } from './browser.mjs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const flag = (k) => process.argv.includes(`--${k}`);
const viewArg = arg('view', '0');
const views = viewArg === 'both' ? [0, 1] : [Number(viewArg)];
const fps = Number(arg('fps', '30'));
const SECONDS = 60;
const OUT = join(ROOT, 'reports/shots');

function findFfmpeg() {
  const w = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (w.status === 0 && w.stdout.trim()) return w.stdout.trim();
  const pw = join(homedir(), 'Library/Caches/ms-playwright');
  for (const d of existsSync(pw) ? readdirSync(pw).filter((x) => x.startsWith('ffmpeg')).sort().reverse() : []) {
    const f = join(pw, d, 'ffmpeg-mac');
    if (existsSync(f)) return f; // Playwright's build: VP8/webm only
  }
  return null;
}

function die(msg) { console.error(`\nSHOTS FAILED: ${msg}\n`); process.exit(1); }

if (!flag('no-build')) execSync('node build.mjs', { cwd: ROOT, stdio: 'inherit' });
mkdirSync(OUT, { recursive: true });

const srv = await serveDist();
const run = await launch(arg('browser', 'chromium'));
try {
  for (const view of views) {
    for (let n = 0; n < 6; n++) {
      const r = await openGame(run.page, srv.url, `?pose=${n}&view=${view}`);
      if (r.error) die(r.error);
      if (isSoftwareAdapter(r.adapter)) die(`software adapter: ${JSON.stringify(r.adapter)}`);
      await run.page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
      const file = join(OUT, `pose${n}_v${view}.png`);
      await run.page.screenshot({ path: file });
      console.log('wrote', file);
    }
  }

  if (!flag('no-video')) {
    const ffmpeg = findFfmpeg();
    for (const view of views) {
      const dir = join(OUT, `drive_v${view}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const r = await openGame(run.page, srv.url, `?script=1&capture=1&view=${view}`);
      if (r.error) die(r.error);
      await run.page.waitForFunction(() => window.__captureReady, null, { timeout: 60000 });
      const total = SECONDS * fps;
      const t0 = Date.now();
      // Warm the pipelines so the first frames are complete.
      for (let i = 0; i < 5; i++) await run.page.evaluate(() => window.__step(0));
      for (let i = 0; i < total; i++) {
        await run.page.evaluate((t) => window.__step(t), i / fps);
        await run.page.screenshot({ path: join(dir, String(i).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 92 });
        if (i % (fps * 10) === 0) console.log(`drive v${view}: frame ${i}/${total}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      }
      if (ffmpeg) {
        const mp4 = /ffmpeg-mac$/.test(ffmpeg);
        const out = join(OUT, `drive_v${view}.${mp4 ? 'webm' : 'mp4'}`);
        const codec = mp4 ? ['-c:v', 'libvpx', '-b:v', '20M'] : ['-c:v', 'libx264', '-crf', '23', '-preset', 'medium', '-pix_fmt', 'yuv420p'];
        const res = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, '%05d.jpg'), ...codec, out], { stdio: 'inherit' });
        if (res.status !== 0) die('ffmpeg failed');
        console.log('wrote', out);
        if (!flag('keep-frames')) rmSync(dir, { recursive: true, force: true });
      } else {
        console.log(`no ffmpeg found; frame sequence left in ${dir}`);
      }
    }
  }
} finally {
  await run.browser.close();
  srv.close();
}
