// Offline audio check: renders the scripted 300 s journey (all 7 eras and 7 biomes,
// stingers 0-21, the finale and the loop back to the dawn), all 49 era x biome pairs
// held steady, every stinger 0-22 and finale() on their own, in headless Chromium with
// OfflineAudioContext, then fails on clipping, NaN/Inf, silence, discontinuities at
// transitions, stingers that are silent or too loud, a finale that does not end alone
// on the tonic, or era/biome pairs that measure (nearly) the same.
// Usage: node tools/audio-check.mjs [--wav out.wav] [--browser /path/to/chrome]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u == '/__blank') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>audio-check</title>'); }
  const f = path.join(root, u);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
let browser;
try { browser = await chromium.launch({ headless: true, executablePath: arg('--browser') || undefined }); }
catch (e) { console.log('bundled Chromium failed (' + e.message.split('\n')[0] + '), trying Brave'); browser = await chromium.launch({ headless: true, executablePath: BRAVE }); }
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() == 'error') console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(`http://127.0.0.1:${port}/__blank`);

const t0 = Date.now();
const r = await page.evaluate(async (wantWav) => {
  const { create } = await import('/src/audio/index.js');
  const D = (await import('/src/audio/data.js')).default;
  const J = await import('/src/audio/journey.js');
  const SR = 48000;

  // still: the drive is constant, so only suspend where an event happens.
  async function render(len, drive, events, over, still) {
    const ctx = new OfflineAudioContext(2, Math.ceil(len * SR), SR);
    const eng = create(over);
    await eng.start(ctx);
    const o = {}, dt = 1 / 30;
    drive(0, o); eng.set(o.era, o.eb, o.ba, o.bb, o.bbl, o.spd, o.surf);
    const fire = (t) => {
      drive(t, o); eng.set(o.era, o.eb, o.ba, o.bb, o.bbl, o.spd, o.surf);
      let ev = 0;
      for (const [et, id] of events) if (et > t - dt && et <= t) { ev = 1; if (id == -1) eng.loopRestart(); else if (id == -2) eng.finale(); else eng.stinger(id); }
      return ev;
    };
    if (still) {
      for (const [et] of events) ctx.suspend(Math.ceil(et * SR / 128) * 128 / SR).then(() => { fire(et); setTimeout(() => ctx.resume(), 40); });
    } else for (let k = 1; k * dt < len; k++) {
      const t = k * dt;
      ctx.suspend(t).then(() => { if (fire(t)) setTimeout(() => ctx.resume(), 40); else ctx.resume(); });
    }
    const b = await ctx.startRendering();
    return [b.getChannelData(0), b.getChannelData(1)];
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k], xr = re[i + k + len / 2], xi = im[i + k + len / 2];
          const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  // Spectral and dynamic features of [a, b) seconds.
  function features(L, R, a, b) {
    const N = 4096, re = new Float64Array(N), im = new Float64Array(N);
    const chroma = new Float64Array(12);
    let lo = 0, mid = 0, hi = 0, cen = 0, tot = 0, ss = 0, sm = 0, sd = 0, n = 0;
    for (let s = a * SR | 0; s + N < b * SR; s += N) {
      for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = (L[s + i] + R[s + i]) * 0.5 * w; im[i] = 0; }
      fft(re, im);
      for (let k = 1; k < N / 2; k++) {
        const f = k * SR / N, p = re[k] * re[k] + im[k] * im[k];
        tot += p; cen += p * f;
        if (f < 250) lo += p; else if (f < 2000) mid += p; else hi += p;
        if (f > 90 && f < 2200) chroma[((Math.round(12 * Math.log2(f / 440)) + 69) % 12 + 12) % 12] += Math.sqrt(p);
      }
    }
    for (let i = a * SR | 0; i < b * SR; i++) { const m = (L[i] + R[i]) / 2, d = (L[i] - R[i]) / 2; ss += L[i] * L[i] + R[i] * R[i]; sm += m * m; sd += d * d; n += 2; }
    // onsets: 10 ms energy frames, rise of > 4 dB over the previous 30 ms
    const F = SR / 100 | 0, e = [];
    for (let s = a * SR | 0; s + F < b * SR; s += F) { let q = 0; for (let i = 0; i < F; i++) q += L[s + i] * L[s + i] + R[s + i] * R[s + i]; e.push(10 * Math.log10(q / F + 1e-12)); }
    let on = 0, last = -9;
    for (let i = 3; i < e.length; i++) if (e[i] - Math.min(e[i - 1], e[i - 2], e[i - 3]) > 4 && e[i] > -50 && i - last > 5) { on++; last = i; }
    const cs = chroma.reduce((x, y) => x + y, 0) || 1;
    return {
      rms: 10 * Math.log10(ss / n + 1e-12), cen: cen / tot, lo: lo / tot, mid: mid / tot, hi: hi / tot,
      ons: on / (b - a), width: Math.sqrt(sd / (sm + 1e-12)), chroma: Array.from(chroma, (x) => x / cs),
    };
  }

  // ---- the journey ----
  const [L, R] = await render(J.LEN, J.journey, J.EVENTS);
  let peak = 0, bad = 0, ss = 0;
  for (let i = 0; i < L.length; i++) {
    const a = L[i], b = R[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) { bad++; continue; }
    peak = Math.max(peak, Math.abs(a), Math.abs(b)); ss += a * a + b * b;
  }
  const secRms = [];
  for (let s = 0; s + 1 <= J.LEN; s++) { let q = 0; for (let i = s * SR; i < (s + 1) * SR; i++) q += L[i] * L[i] + R[i] * R[i]; secRms.push(10 * Math.log10(q / (2 * SR) + 1e-12)); }
  // Transition windows: era blends, biome blends, stingers, loop restart, each plus
  // up to two bars at the slowest tempo so the bar-line change is inside.
  const W = J.WINDOWS;
  // Two discontinuity measures, each compared inside vs outside the windows:
  // raw sample-to-sample jump, and a click score (third difference over its local
  // 20 ms RMS) that catches small steps in quiet or smooth material.
  function jumps(L, R) {
    const n = L.length, inWin = new Uint8Array(n), d3 = new Float32Array(n);
    for (const [a, b] of W) inWin.fill(1, a * SR, Math.min(n, b * SR));
    const m = { jIn: 0, jOut: 0, jAt: 0, jWorst: 0, cIn: 0, cOut: 0, cAt: 0 };
    for (let i = 3; i < n; i++) {
      const j = Math.max(Math.abs(L[i] - L[i - 1]), Math.abs(R[i] - R[i - 1]));
      d3[i] = Math.max(Math.abs(L[i] - 3 * L[i - 1] + 3 * L[i - 2] - L[i - 3]), Math.abs(R[i] - 3 * R[i - 1] + 3 * R[i - 2] - R[i - 3]));
      if (j > m.jWorst) { m.jWorst = j; m.jAt = i / SR; }
      if (inWin[i]) m.jIn = Math.max(m.jIn, j); else m.jOut = Math.max(m.jOut, j);
    }
    const H = 480;
    let s = 0;
    for (let i = 0; i <= 2 * H; i++) s += d3[i] * d3[i];
    for (let i = H; i < n - H - 1; i++) {
      const c = d3[i] / (Math.sqrt(s / (2 * H + 1)) + 2e-4);
      if (inWin[i]) { if (c > m.cIn) { m.cIn = c; m.cAt = i / SR; } } else m.cOut = Math.max(m.cOut, c);
      s += d3[i + H + 1] * d3[i + H + 1] - d3[i - H] * d3[i - H];
    }
    return m;
  }
  const full = jumps(L, R);
  // Smooth pass: same drive with only the sustained voices (flute, bells, drone), no
  // drums, plucks, buzzy reed/brass or car noise, so a small step cannot hide behind them.
  const smoothInst = D.inst.map((r) => ([0, 2, 3, 4, 6, 9, 10, 11].includes(r[0]) ? r.map((x, k) => (k == 2 ? 0 : x)) : r));
  const [SL, SRr] = await render(J.LEN, J.journey, J.EVENTS, { inst: smoothInst, sfx: 0 });
  const smooth = jumps(SL, SRr);
  const timeline = [];
  for (let s = 0; s + 5 <= J.LEN; s += 5) timeline.push([s, features(L, R, s, s + 5)]);

  let wav = null;
  if (wantWav) {
    const n = L.length, u8 = new Uint8Array(44 + n * 4), dv = new DataView(u8.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
    dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) { dv.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); dv.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    wav = btoa(s);
  }

  // ---- every era x biome pair, held steady ----
  const combos = [];
  for (let e = 0; e < 7; e++) for (let b = 0; b < 7; b++) {
    const [cl, cr] = await render(16, (t, o) => Object.assign(o, { era: e, eb: 0, ba: b, bb: b, bbl: 0, spd: 30, surf: Math.min(3, e) }), [], undefined, true);
    let pk = 0, bd = 0;
    for (let i = 0; i < cl.length; i++) { if (!Number.isFinite(cl[i]) || !Number.isFinite(cr[i])) bd++; else pk = Math.max(pk, Math.abs(cl[i]), Math.abs(cr[i])); }
    combos.push({ e, b, pk, bd, f: features(cl, cr, 4, 16) });
  }
  // ---- every stinger on its own (era 2, biome 2 as a neutral bed), 10 s ----
  const stings = [];
  for (let id = 0; id < D.sting.length; id++) {
    const [sl, sr] = await render(10, (t, o) => Object.assign(o, { era: 2, eb: 0, ba: 2, bb: 2, bbl: 0, spd: 30, surf: 2 }), [[3, id]], undefined, true);
    let pk = 0, bd = 0;
    for (let i = 0; i < sl.length; i++) { if (!Number.isFinite(sl[i]) || !Number.isFinite(sr[i])) bd++; else pk = Math.max(pk, Math.abs(sl[i]), Math.abs(sr[i])); }
    const bed = features(sl, sr, 1, 3).rms, hit = features(sl, sr, 3.1, 5.5).rms;
    stings.push({ id, pk, bd, bed, hit });
  }
  // ---- finale(): modern era, savannah; called at 4 s, 32 s render ----
  const [fl, fr] = await render(32, (t, o) => Object.assign(o, { era: 6, eb: 0, ba: 0, bb: 0, bbl: 0, spd: 0, surf: 3 }), [[4, -2]], { sfx: 0 }, true);
  let fpk = 0, fbd = 0;
  for (let i = 0; i < fl.length; i++) { if (!Number.isFinite(fl[i]) || !Number.isFinite(fr[i])) fbd++; else fpk = Math.max(fpk, Math.abs(fl[i]), Math.abs(fr[i])); }
  const fin = { pk: fpk, bd: fbd, before: features(fl, fr, 0.5, 4).rms, motif: features(fl, fr, 9, 13), end: features(fl, fr, 26, 31.5).rms, endOns: features(fl, fr, 22, 31.5).ons };
  // pitch class of the ring-out, measured with the car silent: FFT peak of 14-20 s
  {
    const N = 65536, re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); re[i] = (fl[14 * SR + i] + fr[14 * SR + i]) * 0.5 * w; }
    fft(re, im);
    let bk = 0, bm = 0;
    for (let k = 40; k < N / 2; k++) { const p = re[k] * re[k] + im[k] * im[k]; if (k * SR / N < 2000 && p > bm) { bm = p; bk = k; } }
    fin.ringHz = bk * SR / N;
  }
  return {
    peak, bad, rms: 10 * Math.log10(ss / (2 * L.length)), secRms, full, smooth, timeline, combos, stings, fin, wav,
  };
}, !!arg('--wav'));
await browser.close();
server.close();

const db = (x) => (20 * Math.log10(x)).toFixed(2);
const f2 = (x) => x.toFixed(2);
const PCN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const top = (c) => c.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, i]) => PCN[i]).join(' ');
console.log(`rendered in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log('\nTimeline (5 s windows): t  rms dBFS  centroid Hz  low/mid/high energy  onsets/s  width  top pitch classes');
for (const [s, f] of r.timeline) console.log(`${String(s).padStart(4)}  ${f2(f.rms).padStart(7)}  ${f.cen.toFixed(0).padStart(6)}  ${f2(f.lo)}/${f2(f.mid)}/${f2(f.hi)}  ${f2(f.ons).padStart(5)}  ${f2(f.width)}  ${top(f.chroma)}`);
const ERA = ['Origins', 'Farmers', 'Empires', 'Connected', 'Sail+sci', 'Industry', 'Modern'], BIO = ['Savannah', 'Ice', 'Desert', 'Forest', 'Steppe', 'Mountains', 'Coast'];
console.log('\nEra x biome (all 49, steady 12 s each):');
const vec = (f) => [f.rms / 6, f.cen / 400, f.lo * 3, f.mid * 3, f.hi * 3, f.ons / 1.5, f.width * 3, ...f.chroma.map((x) => x * 6)];
for (const c of r.combos) console.log(`${(ERA[c.e] + ' / ' + BIO[c.b]).padEnd(24)} rms ${f2(c.f.rms)}  cen ${c.f.cen.toFixed(0).padStart(5)}  l/m/h ${f2(c.f.lo)}/${f2(c.f.mid)}/${f2(c.f.hi)}  ons ${f2(c.f.ons)}  width ${f2(c.f.width)}  pcs ${top(c.f.chroma)}`);
let minD = 1e9, minP = '';
const pairs = [], eraGap = [];
for (let i = 0; i < 49; i++) for (let j = i + 1; j < 49; j++) {
  const a = vec(r.combos[i].f), b = vec(r.combos[j].f);
  const d = Math.sqrt(a.reduce((s, x, k) => s + (x - b[k]) ** 2, 0));
  pairs.push([d, `${ERA[r.combos[i].e]}/${BIO[r.combos[i].b]} vs ${ERA[r.combos[j].e]}/${BIO[r.combos[j].b]}`]);
  if (d < minD) { minD = d; minP = `${ERA[r.combos[i].e]}/${BIO[r.combos[i].b]} vs ${ERA[r.combos[j].e]}/${BIO[r.combos[j].b]}`; }
}

const fails = [];
if (r.peak > Math.pow(10, -1 / 20)) fails.push(`clipping: peak ${db(r.peak)} dBFS > -1 dBFS`);
if (r.bad) fails.push(`${r.bad} NaN/Infinity samples`);
const quiet = r.secRms.map((v, i) => [v, i]).filter(([v]) => v < -50);
if (quiet.length || r.rms < -30) fails.push(`silence: ${quiet.length} one-second windows below -50 dBFS, overall ${f2(r.rms)} dBFS`);
// Raw jumps only on the full mix: in the smooth pass a bright bell is louder than its
// surroundings by design; the click score is level-independent and applies to both.
for (const [k, m] of [['full mix', r.full], ['smooth pass', r.smooth]]) {
  if (k == 'full mix' && m.jIn > 2 * m.jOut && m.jIn > 0.02) fails.push(`${k}: jump at a transition ${m.jIn.toFixed(4)} vs ${m.jOut.toFixed(4)} elsewhere`);
  if (m.cIn > 1.5 * m.cOut) fails.push(`${k}: click score at a transition ${m.cIn.toFixed(1)} (at ${m.cAt.toFixed(3)} s) vs ${m.cOut.toFixed(1)} elsewhere`);
}
for (const c of r.combos) {
  if (c.bd) fails.push(`${ERA[c.e]}/${BIO[c.b]}: ${c.bd} NaN/Infinity samples`);
  if (c.pk > Math.pow(10, -1 / 20)) fails.push(`${ERA[c.e]}/${BIO[c.b]}: clipping, peak ${db(c.pk)} dBFS`);
  if (c.f.rms < -40) fails.push(`${ERA[c.e]}/${BIO[c.b]}: nearly silent (${f2(c.f.rms)} dBFS)`);
}
for (const t of r.stings) {
  if (t.bd) fails.push(`stinger ${t.id}: ${t.bd} NaN/Infinity samples`);
  if (t.pk > Math.pow(10, -1 / 20)) fails.push(`stinger ${t.id}: clipping, peak ${db(t.pk)} dBFS`);
  if (t.hit < t.bed - 3 && t.hit < -26) fails.push(`stinger ${t.id}: inaudible over the bed (${f2(t.hit)} vs ${f2(t.bed)} dBFS)`);
}
{
  const f = r.fin;
  if (f.bd) fails.push(`finale: ${f.bd} NaN/Infinity samples`);
  if (f.pk > Math.pow(10, -1 / 20)) fails.push(`finale: clipping, peak ${db(f.pk)} dBFS`);
  if (f.motif.rms < -60) fails.push(`finale: the motif is not audible (${f2(f.motif.rms)} dBFS)`);
  if (f.motif.rms > f.before - 2 || f.motif.ons > 3.5) fails.push(`finale: arrangement did not drop away (${f2(f.motif.rms)} dBFS, ${f2(f.motif.ons)} onsets/s vs ${f2(f.before)} dBFS before)`);
  if (f.end > f.motif.rms) fails.push(`finale: does not ring out (end ${f2(f.end)} vs ${f2(f.motif.rms)} dBFS)`);
  if (f.endOns > 0.8) fails.push(`finale: the end is not alone (${f2(f.endOns)} onsets/s)`);
  if (Math.abs(f.ringHz - 587.33) > 12 && Math.abs(f.ringHz - 293.66) > 8 && Math.abs(f.ringHz - 1174.7) > 20) fails.push(`finale: ring-out is ${f.ringHz.toFixed(1)} Hz, not the tonic D`);
}
if (minD < 0.25) fails.push(`era/biome pairs nearly identical: ${minP} (distance ${f2(minD)})`);
// the same biome in era 2 (First farmers) and era 7 (Modern) has to sound clearly different
for (let b = 0; b < 7; b++) {
  const a = vec(r.combos[1 * 7 + b].f), c = vec(r.combos[6 * 7 + b].f);
  const d = Math.sqrt(a.reduce((s, x, k) => s + (x - c[k]) ** 2, 0));
  eraGap.push(d);
  if (d < 0.6) fails.push(`${BIO[b]}: era 2 and era 7 too alike (distance ${f2(d)})`);
}

console.log('\nJourney summary');
console.log(`  peak            ${db(r.peak)} dBFS`);
console.log(`  RMS             ${f2(r.rms)} dBFS (1 s windows ${f2(Math.min(...r.secRms))} .. ${f2(Math.max(...r.secRms))})`);
console.log(`  NaN/Inf         ${r.bad}`);
for (const [k, m] of [['full mix   ', r.full], ['smooth pass', r.smooth]]) {
  console.log(`  ${k}     worst jump ${m.jWorst.toFixed(4)} at ${m.jAt.toFixed(3)} s; in transition windows ${m.jIn.toFixed(4)} vs elsewhere ${m.jOut.toFixed(4)}`);
  console.log(`                  click score in transition windows ${m.cIn.toFixed(1)} (at ${m.cAt.toFixed(3)} s) vs elsewhere ${m.cOut.toFixed(1)}`);
}
console.log(`  closest era/biome pair: ${minP}, distance ${f2(minD)}`);
pairs.sort((a, b) => a[0] - b[0]);
console.log('  closest five pairs: ' + pairs.slice(0, 5).map(([d, n]) => `${n} ${f2(d)}`).join('; '));
console.log(`  era 2 vs era 7 distance per biome: ${eraGap.map(f2).join(' ')}`);
console.log(`  combinations rendered: ${r.combos.length}, worst peak ${db(Math.max(...r.combos.map((c) => c.pk)))} dBFS`);
console.log(`  stingers rendered: ${r.stings.length}, worst peak ${db(Math.max(...r.stings.map((c) => c.pk)))} dBFS, quietest vs bed ${f2(Math.min(...r.stings.map((c) => c.hit - c.bed)))} dB`);
console.log(`  finale: before ${f2(r.fin.before)} dBFS, motif alone ${f2(r.fin.motif.rms)}, end ${f2(r.fin.end)}, ring-out ${r.fin.ringHz.toFixed(1)} Hz, peak ${db(r.fin.pk)} dBFS`);
if (r.wav) { fs.writeFileSync(arg('--wav'), Buffer.from(r.wav, 'base64')); console.log(`  wrote ${arg('--wav')}`); }
console.log(fails.length ? '\nFAIL\n  ' + fails.join('\n  ') : '\nPASS');
process.exit(fails.length ? 1 : 0);
