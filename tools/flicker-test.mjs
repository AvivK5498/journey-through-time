// Tree flicker measurement (round three). Drives in a biome, then records a burst of consecutive
// frames (parked: autopilot off, braked to a stop; or moving: autopilot on) and counts "blinks":
// pixels whose brightness jumps by more than BLINK levels and jumps back the next frame (or
// within 3 frames). Camera motion moves edges monotonically; a prop that toggles, a shadow that
// strobes or a leaf card that shimmers flips a pixel back and forth. A per-pixel blink heatmap
// is written next to a frame so the blinks can be located.
// Also reads back every prop list's instance count (?propdbg=1) to show list overflow.
//   node tools/flicker-test.mjs [--no-build] [--cases=forest-park,...] [--frames=90] [--extra=&hide=props]
//                               [--out=reports/round3/flicker] [--tag=before] [--size=1280x720]
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, serveDist, CHROME_ARGS } from './browser.mjs';
import { chromium } from 'playwright';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const N = Number(arg('frames', '90'));
const EXTRA = arg('extra', '');
const TAG = arg('tag', 'run');
const OUT = join(ROOT, arg('out', 'reports/round3/flicker'));
const [VW, VH] = arg('size', '1280x720').split('x').map(Number);
const BLINK = Number(arg('blink', '28'));
mkdirSync(OUT, { recursive: true });
// Private build (never clobbers dist/index.html, which other work may be testing).
if (!process.argv.includes('--no-build')) execSync('node tools/flicker-build.mjs', { cwd: ROOT, stdio: 'inherit' });

// name: biome, start clock, view, parked or moving, seconds of driving first.
const ALL = [
  { name: 'forest-park', b: 3, t0: 20, view: 0, park: true },
  { name: 'forest-park-fp', b: 3, t0: 20, view: 1, park: true },
  { name: 'forest-park-late', b: 3, t0: 250, view: 0, park: true },
  { name: 'forest-move', b: 3, t0: 20, view: 0, park: false },
  { name: 'forest-move-late', b: 3, t0: 250, view: 0, park: false },
  { name: 'forest-move-fp', b: 3, t0: 250, view: 1, park: false },
  { name: 'coast-park', b: 6, t0: 200, view: 0, park: true },
  { name: 'coast-move', b: 6, t0: 200, view: 0, park: false },
  { name: 'mountain-park', b: 5, t0: 100, view: 0, park: true },
  { name: 'mountain-move', b: 5, t0: 100, view: 0, park: false },
  { name: 'savannah-park', b: 0, t0: 20, view: 0, park: true },
  { name: 'savannah-move', b: 0, t0: 20, view: 0, park: false },
];
const SEL = arg('cases', '') ? arg('cases', '').split(',') : null;
const CASES = ALL.filter((c) => !SEL || SEL.includes(c.name));

// Tree instances (props.js ?propdbg=1 readback) over N consecutive frames: trees well inside
// the view that vanish or appear between two frames, blink (gone for one or two frames, then
// back), swap near/far model, or move vertically. Rates per second of frames recorded.
async function instStats({ N }) {
  const D = window.__propDbg;
  D.recs.length = 0; D.missed = 0; D.rec = N;
  const t0 = performance.now();
  await new Promise((res) => { const f = () => (D.recs.length >= N - D.missed || performance.now() - t0 > 20000 ? res() : setTimeout(f, 50)); f(); });
  const R = D.recs.sort((a, b) => a.n - b.n);
  const NAMES = { 0: 'acacia', 1: 'acaciaFar', 23: 'broad', 24: 'broadFar', 25: 'spruce', 26: 'spruceFar', 5: 'palm', 18: 'palmFar', 19: 'palm2' };
  const NEARL = new Set([0, 23, 25, 5, 19]);
  const frames = R.map((r) => {
    const m = new Map(), T = r.trees;
    // Opacity of each (tree, list): props.js fade code, fract(b.w): 0..0.49 near-side, 0.5..0.99 far-side.
    const op = new Map();
    for (let o = 0; o < T.length; o += 5) {
      const x = T[o], y = T[o + 1], z = T[o + 2], l = T[o + 3], fr = T[o + 4];
      const k = Math.round(x * 4) + ',' + Math.round(z * 4);
      const a = 1 - (fr >= 0.5 ? fr - 0.5 : fr) / 0.49;
      const near = NEARL.has(l);
      const e = m.get(k);
      // The tree's entry keeps the near-model list when both are drawn (a crossfade).
      if (!e || near) m.set(k, { l, x, y, z });
      op.set(k + (near ? 'n' : 'f'), a);
    }
    return { n: r.n, m, op, vp: r.vp, eye: r.eye };
  });
  const inside = (f, t) => {
    const v = f.vp, X = t.x, Y = t.y + 5, Z = t.z;
    const cx = v[0] * X + v[4] * Y + v[8] * Z + v[12], cy = v[1] * X + v[5] * Y + v[9] * Z + v[13], cw = v[3] * X + v[7] * Y + v[11] * Z + v[15];
    return cw > 1 && Math.abs(cx / cw) < 0.8 && Math.abs(cy / cw) < 0.8;
  };
  const dist = (f, t) => Math.hypot(t.x - f.eye[0], t.z - f.eye[2]);
  const ev = { vanish: 0, appear: 0, blink: 0, lodSwap: 0, lodFlipBack: 0, yJump: 0 };
  const dists = { vanish: [], appear: [], blink: [], lodSwap: [] };
  const swaps = {};
  let pairs = 0;
  for (let i = 1; i < frames.length; i++) {
    const A = frames[i - 1], B = frames[i];
    if (B.n !== A.n + 1) continue;
    pairs++;
    for (const [k, a] of A.m) {
      const b = B.m.get(k);
      if (!b) { if (inside(A, a) && inside(B, a)) { ev.vanish++; dists.vanish.push(dist(B, a)); } continue; }
      if (b.l !== a.l && inside(B, b)) { ev.lodSwap++; dists.lodSwap.push(dist(B, b)); const s = NAMES[a.l] + '>' + NAMES[b.l]; swaps[s] = (swaps[s] || 0) + 1; }
      if (Math.abs(b.y - a.y) > 0.03 && inside(B, b)) ev.yJump++;
    }
    for (const [k, b] of B.m) if (!A.m.has(k) && inside(A, b) && inside(B, b)) { ev.appear++; dists.appear.push(dist(B, b)); }
    if (i + 1 < frames.length && frames[i + 1].n === B.n + 1) {
      const C = frames[i + 1];
      for (const [k, a] of A.m) {
        const c = C.m.get(k), b = B.m.get(k);
        if (c && !b && inside(B, a)) { ev.blink++; dists.blink.push(dist(B, a)); }
        if (c && b && b.l !== a.l && c.l === a.l) ev.lodFlipBack++;
      }
    }
  }
  // Trees that change state twice or more inside the view (gone and back, far-near-far): a toggle.
  const hist = new Map();
  for (let i = 0; i < frames.length; i++) {
    const F = frames[i];
    const seen = new Set();
    for (const [k, t] of F.m) { seen.add(k); if (!inside(F, t)) continue; let h = hist.get(k); if (!h) hist.set(k, h = { s: [], t }); h.s.push(i + ':' + t.l); }
    for (const [k, h] of hist) if (!seen.has(k) && inside(F, h.t)) h.s.push(i + ':-');
  }
  let toggles = 0; const tEx = [];
  for (const [k, h] of hist) {
    let ch = 0;
    for (let i = 1; i < h.s.length; i++) if (h.s[i].split(':')[1] !== h.s[i - 1].split(':')[1]) ch++;
    if (ch >= 2) { toggles++; if (tEx.length < 6) tEx.push({ k, d: Math.round(Math.hypot(h.t.x - frames[0].eye[0], h.t.z - frames[0].eye[2])), seq: h.s.filter((x, i) => i === 0 || x.split(':')[1] !== h.s[i - 1].split(':')[1]).slice(0, 8).join(' ') }); }
  }
  // Hard pops: a tree's near- or far-model opacity changes by more than 0.25 in one frame
  // (appearing, vanishing or swapping model with no fade), inside the view.
  let pops = 0; const popD = [];
  for (let i = 1; i < frames.length; i++) {
    const A = frames[i - 1], B = frames[i];
    if (B.n !== A.n + 1) continue;
    const keys = new Set([...A.op.keys(), ...B.op.keys()]);
    for (const k of keys) {
      const d = (B.op.get(k) || 0) - (A.op.get(k) || 0);
      if (d > 0.25 || d < -0.25) {
        const t = B.m.get(k.slice(0, -1)) || A.m.get(k.slice(0, -1));
        if (t && inside(A, t) && inside(B, t)) { pops++; popD.push(dist(B, t)); }
      }
    }
  }
  const sec = (R[R.length - 1].ts - R[0].ts) / 1000 || pairs / 60;
  const med = (a) => (a.length ? Math.round(a.sort((x, y) => x - y)[a.length >> 1]) : null);
  const out = { hardPopsPerS: +(pops / sec).toFixed(1), hardPopMedianM: med(popD), pairs, seconds: +sec.toFixed(2), missed: D.missed, trees: frames.length ? frames[frames.length - 1].m.size : 0, swaps, toggles, toggleExamples: tEx, overFrames: Array.from(D.over).map((n, l) => (n ? `${l}:${n}` : null)).filter(Boolean) };
  for (const k in ev) out[k + 'PerS'] = +(ev[k] / sec).toFixed(1);
  for (const k in dists) out[k + 'MedianM'] = med(dists[k]);
  return out;
}

const srv = await serveDist();
// Playwright's Chromium when installed, else Brave (as tools/browser.mjs launch('brave')).
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const browser = await chromium.launch({ headless: false, args: CHROME_ARGS })
  .catch(() => chromium.launch({ headless: false, args: CHROME_ARGS, executablePath: BRAVE }));
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
const results = {};
try {
  for (const c of CASES) {
    const p = await ctx.newPage();
    await p.bringToFront();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(`${srv.url}flicker.html?autodrive=1&seed=${arg('seed', '1')}&fresh=1&quality=high&propdbg=1&grab=1&biome=${c.b}&biomelock=1&t0=${c.t0}&view=${c.view}${EXTRA}`);
    await p.waitForFunction(() => window.__game || window.__gpuError, null, { timeout: 90000 });
    await p.waitForTimeout(Number(arg('drive', '9')) * 1000);
    if (c.park) {
      await p.keyboard.press('KeyP'); // autopilot off
      await p.keyboard.down('KeyS');
      await p.waitForFunction(() => Math.abs(window.__drive.car.v) < 0.3, null, { timeout: 15000 }).catch(() => {});
      await p.keyboard.up('KeyS');
      await p.waitForTimeout(2500);
    }
    const r = await p.evaluate(async ({ N, BLINK }) => {
      const G = window.__grab;
      const clock0 = window.__game.state.clock;
      G.frames.length = 0; G.missed = 0; G.left = N;
      await new Promise((res) => { const f = () => (G.frames.length >= N ? res() : setTimeout(f, 50)); f(); });
      G.frames.sort((x, y) => x.n - y.n);
      const W = G.w, H = G.h;
      const L = G.frames.map((f) => f.l);
      const gaps = G.frames.reduce((n, f, i) => n + (i && f.n !== G.frames[i - 1].n + 1 ? 1 : 0), 0);
      const oc = new OffscreenCanvas(W, H);
      const g = oc.getContext('2d');
      const npx = W * H;
      const heat = new Uint16Array(npx);
      let blinks = 0, blinks3 = 0, sad = 0, blinksTop = 0;
      const topN = Math.floor(H * 0.48) * W; // the band above the car: the tree line
      for (let t = 1; t < N - 1; t++) {
        const a = L[t - 1], b = L[t], c = L[t + 1];
        for (let k = 0; k < npx; k++) {
          const d1 = b[k] - a[k], d2 = c[k] - b[k];
          sad += d1 < 0 ? -d1 : d1;
          if ((d1 > BLINK && d2 < -BLINK) || (d1 < -BLINK && d2 > BLINK)) { blinks++; heat[k]++; if (k < topN) blinksTop++; }
        }
      }
      // Slower toggles: out and back within 3 frames.
      for (let t = 1; t < N - 3; t++) {
        const a = L[t - 1], b = L[t], e = L[t + 2];
        for (let k = 0; k < npx; k++) {
          const d1 = b[k] - a[k], d3 = e[k] - a[k];
          if ((d1 > BLINK || d1 < -BLINK) && d3 < 6 && d3 > -6) blinks3++;
        }
      }
      // Heatmap image: last frame dimmed, blinks in red.
      const img = g.createImageData(W, H);
      const lf = L[N - 1];
      let hmax = 1; for (let k = 0; k < npx; k++) if (heat[k] > hmax) hmax = heat[k];
      for (let k = 0, j = 0; k < npx; k++, j += 4) {
        const v = lf[k] * 0.45, hh = Math.min(1, heat[k] / 6);
        img.data[j] = v + (255 - v) * hh; img.data[j + 1] = v * (1 - hh); img.data[j + 2] = v * (1 - hh); img.data[j + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let k = 0; k < buf.length; k += 8192) s += String.fromCharCode.apply(null, buf.subarray(k, k + 8192));
      const D = window.__propDbg;
      const over = D ? Array.from(D.count).map((n, l) => (n >= D.cap[l] ? `${l}:${n}` : null)).filter(Boolean) : null;
      const counts = D ? Array.from(D.count) : null;
      const st = window.__game.state;
      const per = (x) => +(x / (N - 2) / (npx / 1e6)).toFixed(1);
      return { W, H, blinkPerMpxFrame: per(blinks), blinkTopPerMpxFrame: +(blinksTop / (N - 2) / (topN / 1e6)).toFixed(1), blink3PerMpxFrame: per(blinks3), meanAbsDiff: +(sad / (N - 2) / npx).toFixed(3),
        hotPixels: heat.reduce((n, v) => n + (v >= 3 ? 1 : 0), 0), clockMoved: +(st.clock - clock0).toFixed(2), clock: +st.clock.toFixed(1),
        speed: +window.__drive.car.v.toFixed(1), biome: st.biomeA, gaps, missed: G.missed, overflow: over, counts, jpeg: btoa(s) };
    }, { N, BLINK });
    r.inst = await p.evaluate(instStats, { N: Number(arg('instframes', String(N))) });
    writeFileSync(join(OUT, `${TAG}_${c.name}.jpg`), Buffer.from(r.jpeg, 'base64'));
    delete r.jpeg;
    r.errors = errs.slice(0, 3);
    results[c.name] = r;
    console.log(c.name, JSON.stringify({ ...r, counts: undefined }));
    await p.close();
  }
} finally {
  await browser.close();
  srv.close();
}
writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify(results, null, 1));
