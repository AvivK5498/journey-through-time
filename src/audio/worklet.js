// AudioWorklet processor. This function is never called on the main thread: its
// source text is wrapped as '(' + fn + ')()' into a Blob URL and loaded with
// audioWorklet.addModule, so it must not reference anything outside itself.
// All buffers are allocated in the constructor; process() allocates nothing.
export default function () {
  const SR = sampleRate, T = 2 * Math.PI, NV = 64, KL = 2048, B = 128;
  const sin = Math.sin, min = Math.min, max = Math.max, abs = Math.abs;
  const PN = ['era', 'eb', 'ba', 'bb', 'bbl', 'spd', 'surf'];
  let sd = 0x2545f491;
  const rnd = () => { sd ^= sd << 13; sd ^= sd >>> 17; sd ^= sd << 5; return (sd >>> 0) / 4294967296; };
  const nz = () => rnd() * 2 - 1;
  const ex = (s) => Math.exp(-1 / (s * SR + 1));
  const fl32 = (n) => new Float32Array(n);

  // ---- voices (struct of arrays) ----
  const vOn = new Uint8Array(NV), vAlg = new Uint8Array(NV), vSt = new Uint8Array(NV), vDl = new Int32Array(NV), vKw = new Int32Array(NV);
  const vAge = new Float64Array(NV), vLen = new Float64Array(NV);
  const vF = fl32(NV), vPh = fl32(NV), vPh2 = fl32(NV), vE = fl32(NV), vAi = fl32(NV), vDc = fl32(NV), vRc = fl32(NV), vG = fl32(NV),
    vL = fl32(NV), vR = fl32(NV), vRv = fl32(NV), vDy = fl32(NV), vB = fl32(NV), vV = fl32(NV), vS1 = fl32(NV), vS2 = fl32(NV),
    vX = fl32(NV), vM = fl32(NV), vKd = fl32(NV), vSl = fl32(NV), vSc = fl32(NV);
  const ks = fl32(NV * KL), BC = ex(0.025);

  // ---- buses ----
  const bL = fl32(B), bR = fl32(B), bRv = fl32(B), bDy = fl32(B);

  // ---- small SVF bank for drone, car and ambience ----
  const fs1 = fl32(12), fs2 = fl32(12), fa1 = fl32(12), fa2 = fl32(12), fa3 = fl32(12), fk = fl32(12);
  let fbp = 0;
  const sf = (i, fc, q) => {
    const g = Math.tan(Math.PI * min(fc, SR * 0.45) / SR), k = 1 / q, a = 1 / (1 + g * (g + k));
    fa1[i] = a; fa2[i] = g * a; fa3[i] = g * g * a; fk[i] = k;
  };
  const fl = (i, x) => {
    const s1 = fs1[i], s2 = fs2[i], v3 = x - s2, v1 = fa1[i] * s1 + fa2[i] * v3, v2 = s2 + fa2[i] * s1 + fa3[i] * v3;
    fs1[i] = 2 * v1 - s1; fs2[i] = 2 * v2 - s2; fbp = v1; return v2;
  };
  const blep = (t, d) => t < d ? (t /= d, t + t - t * t - 1) : t > 1 - d ? (t = (t - 1) / d, t * t + t + t + 1) : 0;

  // ---- effects ----
  const DL = 2 * SR | 0, dbL = fl32(DL), dbR = fl32(DL);
  const rLn = new Int32Array(4), rOf = new Int32Array(4), rI = new Int32Array(4), rlp = fl32(4), ro = fl32(4);
  let rTot = 0;
  for (let k = 0; k < 4; k++) { rLn[k] = [1913, 2333, 2791, 3271][k] * SR / 48000 | 0; rOf[k] = rTot; rTot += rLn[k]; }
  const rb = fl32(rTot);

  // ---- data (set in constructor) ----
  let MU = 1, SX = 1, IN, ER, BI, ST, SM, TON, NP, NB, pI, pRo, pOw, pOc, pK, pPat, pG, pT, pA, pLo, pLl, pLd, pFl, thAt, bBL, ORN, mt4, eAc, FI, FN, FM;
  const eW = fl32(16), bW = fl32(16), aw = fl32(5), awT = fl32(5);

  // ---- musical state ----
  let ns = 0, sN = 0, barN = -1, cyc = 0, cl = 16, vr = 0, bpm = 0, sw = 0, dens = 1, root = 0, ad = 0, cb = null, cbI = 0, BL = 16;
  let strip = 0, stripNow = 0, lpP = 0, stP = -1, stA = -1, stS = 0, fin = 0, finP = 0, eOn = 1, eG = 1;
  let pe = 0, peb = 0, pba = 0, pbb = 0, pbl = 0, psp = 0, psf = 0;
  let dT = 0, dLv = 0, rf = 0.8, rfT = 0.8, dtS = 0.5;
  // ---- noise-maker state ----
  let spS = 0, s0 = 1, s1 = 0, s2 = 0, eph = 0, wph = 0, c1 = 0, c2 = 0, cg = 0, cb1 = 0, cb2 = 0, wtp = 0, lf = 0;
  let bT = SR, bN = 0, bC = 0, bph = 0, bpn = 0.5, jp = 0, tE = 0, tP = 0, d0 = 0, d1 = 0, d2 = 0, d3 = 0, d4 = 0;
  let dw = 0, dlp = 0, lg = 1;
  const TC = ex(0.035);

  const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const deg = (a, d) => { const o = Math.floor(d / 7); return a[d - o * 7] + 12 * o; };
  const ci = (x, n) => x < 0 ? 0 : x >= n ? n - 1 : x | 0;

  function trig(i, n, vel, dl, len, sl0) {
    const p = IN[i], a = p[0];
    let v = 0, m = 1e9;
    for (let k = 0; k < NV; k++) {
      if (!vOn[k]) { v = k; m = -1; break; }
      const e = vE[k] * vG[k] + (vSt[k] ? 0 : 1);
      if (e < m) { m = e; v = k; }
    }
    const f = p[11] || mtof(n + p[1]);
    vOn[v] = 1; vAlg[v] = a; vSt[v] = 0; vDl[v] = dl | 0; vAge[v] = 0; vLen[v] = len;
    vF[v] = f; vPh[v] = 0; vPh2[v] = 0; vE[v] = 0; vAi[v] = 1 / (p[3] * SR + 1); vDc[v] = ex(p[4]); vRc[v] = ex(p[5]);
    vG[v] = p[2] * vel * MU; vRv[v] = p[9]; vDy[v] = p[10]; vB[v] = p[6]; vV[v] = p[7];
    vS1[v] = vS2[v] = vX[v] = 0; vM[v] = 1; vSl[v] = sl0 || 1; vSc[v] = 1 / (0.09 * SR);
    const pn = max(-1, min(1, p[8] + (rnd() - 0.5) * 0.2)) * 0.785 + 0.785;
    vL[v] = Math.cos(pn); vR[v] = sin(pn);
    if (a == 2) {
      // excitation: one period of a zero-mean triangle (string pulled at 30%)
      // plus a little smoothed noise, so the loop starts with no DC and no seam
      const c = 0.3 + 0.6 * p[6], o = v * KL, d = vKd[v] = SR / f - (1 - c) / c, ec = 0.1 + 0.3 * p[6];
      let y = 0, z = 0;
      vKw[v] = 0;
      for (let k = 0; k < KL; k++) {
        y += ec * (nz() - y); z += ec * (y - z);
        let u = (k - KL + d) / d; u -= Math.floor(u);
        ks[o + k] = (u < 0.3 ? u / 0.3 : (1 - u) / 0.7) - 0.5 + z * p[6] * 1.5;
      }
      vX[v] = ks[o + (KL - d | 0)];
    }
  }

  function voice(v) {
    const a = vAlg[v], f = vF[v], g = vG[v], pl = vL[v], pr = vR[v], rs = vRv[v], ds = vDy[v], b = vB[v], vb = vV[v];
    const ai = vAi[v], dc = vDc[v], rc = vRc[v], len = vLen[v], dt = f / SR, o = v * KL, kd = vKd[v], kc = 0.3 + 0.6 * b, sc = vSc[v];
    let ph = vPh[v], ph2 = vPh2[v], e = vE[v], st = vSt[v], dl = vDl[v], age = vAge[v], s1 = vS1[v], s2 = vS2[v], x = vX[v], m = vM[v], kw = vKw[v], sl = vSl[v];
    const fc = min(SR * 0.45, a == 0 ? 300 + b * 5000 : a == 1 ? f : a == 3 ? f * (1.5 + 2.5 * b) : a == 4 ? f * (1.5 + 7 * b * e * e) : a == 7 || a == 9 || a == 10 ? f * (2 + 8 * b) : a == 8 ? 650 + b * 600 : a == 6 && f > 100 ? f : 5000 + b * 6000);
    const q = a == 1 ? 5 : a == 3 ? 3 : a == 4 ? 1.3 : a == 8 ? 2.2 : a == 9 ? 1.1 : a == 10 ? 1.5 : 0.9;
    const gg = Math.tan(Math.PI * fc / SR), k = 1 / q, a1 = 1 / (1 + gg * (gg + k)), a2 = gg * a1, a3 = gg * a2;
    for (let i = 0; i < B; i++) {
      if (dl > 0) { dl--; continue; }
      if (st == 0) { e += ai; if (e >= 1) { e = 1; st = 1; } } else e *= age < len ? dc : rc;
      sl += (1 - sl) * sc;
      age++;
      let s = 0, lp = 0, bp = 0;
      if (a != 2 && a != 5 && a != 11) {
        let n = nz();
        if (a == 3 || a == 4 || (a >= 7 && a <= 10)) {
          const vi = a == 3 || a == 7 || a == 8 || a == 9 ? 1 + 0.005 * vb * sin(T * (a == 7 ? 5.6 : a == 8 ? 4.6 : 5.3) * age / SR) * min(1, age / (0.4 * SR)) : 1;
          const d1 = dt * sl * vi;
          ph += d1; if (ph >= 1) ph -= 1;
          n = 2 * ph - 1 - blep(ph, d1);
          if (a == 4 || a == 7 || a == 8 || a == 9) { ph2 += d1 * (a == 9 ? 1.01 : a == 8 ? 1.006 : 1.004); if (ph2 >= 1) ph2 -= 1; n = 0.6 * (n + 2 * ph2 - 1); }
        }
        const v3 = n - s2, v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3;
        s1 = 2 * v1 - s1; s2 = 2 * v2 - s2; lp = v2; bp = v1;
        if (a == 6) bp = n - k * v1 - v2;
      }
      switch (a) {
        case 0: ph += dt * (1 + vb * m); m *= BC; if (ph >= 1) ph -= 1;
          s = sin(T * ph) * e + bp * b * e * e * 2; break;
        case 1: {
          const vi = 1 + 0.006 * vb * sin(T * 5 * age / SR) * min(1, age / (0.35 * SR));
          ph += dt * sl * vi; if (ph >= 1) ph -= 1;
          s = (sin(T * ph) + 0.15 * sin(2 * T * ph) + bp * b * 1.4) * e + bp * b * 3 * max(0, 1 - age / (0.06 * SR));
          break;
        }
        case 2: {
          let rp = kw - kd; if (rp < 0) rp += KL;
          const i0 = rp | 0, fr = rp - i0, y0 = ks[o + i0], y = y0 + (ks[o + ((i0 + 1) & (KL - 1))] - y0) * fr;
          x += kc * (y - x); ks[o + kw] = x * 0.9985; kw = (kw + 1) & (KL - 1);
          s = y * e; break;
        }
        case 3: s = (lp * 0.6 + bp * 0.7) * e; break;
        case 4: case 7: case 9: s = lp * e; break;
        case 5: ph += dt; ph2 += dt * vb; if (ph >= 1) ph -= 1; if (ph2 >= 1) ph2 -= 1;
          s = sin(T * ph + b * 5 * e * e * sin(T * ph2)) * e; break;
        case 8: s = (lp * 0.5 + bp * 0.9) * e; break;
        case 10: s = (lp * 0.9 + sin(T * ph) * 0.5) * e; break;
        case 11: {
          ph += dt; if (ph >= 1) ph -= 1;
          const ee = e * e;
          s = (sin(T * ph) + 0.5 * sin(2 * T * ph) * e + 0.28 * sin(3 * T * ph) * ee + 0.14 * sin(4 * T * ph) * ee * e) * e * 0.8;
          break;
        }
        default: s = bp * e;
      }
      s *= g;
      bL[i] += s * pl; bR[i] += s * pr; bRv[i] += s * rs; bDy[i] += s * ds;
    }
    vPh[v] = ph; vPh2[v] = ph2; vE[v] = e; vSt[v] = st; vDl[v] = dl; vAge[v] = age; vS1[v] = s1; vS2[v] = s2; vX[v] = x; vM[v] = m; vKw[v] = kw; vSl[v] = sl;
    if (st && age > len && e < 3e-4) vOn[v] = 0;
  }

  function bar() {
    if (lpP) { lpP = 0; strip = 8; barN = 0; cyc = 0; fin = 0; finP = 0; } else if (++barN >= cl) { barN = 0; cyc++; }
    // form: A = theme (8 bars), B = variation (8), sometimes C = breakdown (8)
    if (!barN) { vr = cyc ? rnd() * 3 | 0 : 0; cl = cyc && rnd() < 0.5 ? 24 : 16; }
    if (fin) fin++;
    if (finP) { finP = 0; if (!fin) fin = 1; }
    const ne = ER.length, nb = BI.length, e0 = ci(pe, ne), e1 = ci(pe + 1, ne), b0 = ci(pba, nb), b1 = ci(pbb, nb);
    eW.fill(0); bW.fill(0);
    eW[e0] += 1 - peb; eW[e1] += peb; bW[b0] += 1 - pbl; bW[b1] += pbl;
    cbI = pbl < 0.5 ? b0 : b1; cb = BI[cbI];
    BL = fin ? 16 : bBL[cbI];
    bpm = bpm ? bpm + (cb.bpm - bpm) * 0.4 : cb.bpm;
    sw = cb.sw; root = cb.roots[barN & 7]; ad = rnd() < 0.5; rfT = fin ? 0.9 : cb.rev;
    dens = 0; dT = 0;
    let ac = 0;
    for (let k = 0; k < nb; k++) { dens += bW[k] * BI[k].dens; dT += bW[k] * BI[k].drone; }
    for (let k = 0; k < ne; k++) { dT += eW[k] * ER[k].drone; ac += eW[k] * eAc[k]; }
    for (let p = 0; p < NP; p++) { const w = pOw[p]; pT[p] = fin ? 0 : strip ? pK[p] : w < 100 ? eW[w] : bW[w - 100] * (pFl[p] & 1 ? ac : 1); if (pRo[p] == 7) pA[p] = 0; }
    stripNow = strip > 0 ? 1 : 0;
    if (strip) { dT = 0; strip--; }
    if (fin) dT = 0;
  }

  function step(off) {
    const s = sN;
    if (!s) bar();
    if (stP >= 0) { stA = stP; stS = 0; stP = -1; }
    const sl = SR * 15 / bpm, t0 = off + (s & 1 ? sw * sl : 0), du = stA >= 0 ? 0.6 : 1, sec = barN >= 8 && barN < 16, brk = barN >= 16;
    for (let p = 0; p < NP; p++) {
      const g = pG[p] += (pT[p] - pG[p]) / (BL - s);
      if (g < 0.004) continue;
      const i = pI[p], pv = pPat[p * 16 + s], gv = g * du, ob = pOw[p] >= 100 ? pOw[p] - 100 : cbI, B = BI[ob], rt = B.roots[barN & 7];
      let r = pRo[p];
      if (r == 4 && stripNow) r = 0;
      if (r == 0 || r == 4) {
        if (s >= bBL[ob]) continue;
        const TH = B.thm, t = thAt[ob * 128 + (brk ? barN & 1 : barN & 7) * bBL[ob] + s];
        if (t < 0 || (sec && vr == 2 && s & 3 && r == 0) || (brk && barN & 2)) continue;
        if (r == 4 && t > 4 && (t < mt4[ob] || t >= mt4[ob] + 5)) continue;
        let d = TH[t * 3 + 1], L = TH[t * 3 + 2];
        if (sec && r == 0 && vr) {
          if (vr == 1 && t & 1 && L < 6) d = rt + B.ch[rnd() * B.ch.length | 0];
          else L *= 1.5;
        }
        const oc = pOc[p], n = TON + deg(B.mel, d) + oc, vel = (s & 7 ? 0.82 : 1) * (0.9 + 0.2 * rnd()) * gv, hd = t0 + (0.004 + rnd() * 0.01) * SR, ln = L * sl * 0.92;
        const k = r == 0 && L >= 3 ? ORN[ob * 8 + (t & 7)] : 0;
        if (k == 1 || k == 5) {
          trig(i, TON + deg(B.mel, k == 1 ? d + 1 : d - 1) + oc, vel * 0.45, hd, 0.05 * SR);
          trig(i, n, vel, hd + 0.07 * SR, ln - 0.05 * SR);
        } else if (k == 2) {
          trig(i, n, vel * 0.7, hd, 0.045 * SR);
          trig(i, TON + deg(B.mel, d + 1) + oc, vel * 0.5, hd + 0.045 * SR, 0.045 * SR);
          trig(i, n, vel, hd + 0.09 * SR, ln - 0.09 * SR);
        } else if (k == 3 || k == 4) trig(i, n, vel, hd, ln, k == 3 ? 0.8909 : 1.1225);
        else trig(i, n, vel, hd, ln);
        if (IN[i][0] == 2 && L >= 6) trig(i, n, vel * 0.5, hd + L * sl * 0.5, ln * 0.5);
      } else if (r == 3) {
        let v = pv;
        if (!v && rnd() < ((barN & 7) == 7 && s >= BL - 4 ? 0.45 : 0.04) * dens * (pFl[p] & 2 ? 0 : 1)) v = 0.35;
        if (!v || (v < 0.95 && rnd() > dens - (brk ? 0.5 : 0.08))) continue;
        trig(i, 0, v * gv * (0.85 + 0.3 * rnd()), t0 + rnd() * 0.01 * SR, sl);
      } else if (pv) {
        if (r == 6) {
          for (let k = pLo[p], z = k + pLl[p]; k < z; k++) trig(i, TON + deg(B.sc, rt + pLd[k]) + pOc[p], pv * gv * 0.8, t0 + rnd() * 0.015 * SR, sl * BL);
        } else if (r == 7) {
          const k = pA[p]++;
          trig(i, TON + deg(B.sc, rt + (pLl[p] ? pLd[pLo[p] + k % pLl[p]] : 0)) + pOc[p], pv * gv * (0.85 + 0.3 * rnd()), t0 + rnd() * 0.01 * SR, sl * 3);
        } else if (rnd() > 0.1) {
          const c = B.ch, nc = c.length;
          let d;
          if (r == 1) { const k = pA[p]++ % nc; d = rt + c[ad ? k : nc - 1 - k]; }
          else { if (barN & 1) continue; d = rt + ((barN & 3) == 2 ? 4 : 0); }
          trig(i, TON + deg(B.sc, d) + pOc[p], pv * gv * (0.8 + 0.3 * rnd()), t0 + rnd() * 0.012 * SR, r == 1 ? sl * 2 : sl * 24);
        }
      }
    }
    if (fin == 2) {
      for (let j = 0; j < FN.length; j += 3) if (FN[j] == s) trig(FI, TON + deg(FM, FN[j + 1]), 0.85 + 0.1 * rnd(), t0 + rnd() * 0.008 * SR, FN[j + 2] * sl * 0.95);
    } else if (fin == 3 && !s) trig(FI, TON + deg(FM, 0), 0.9, t0, 200 * sl);
    if (stA >= 0) {
      const a = ST[stA], mel = SM[stA] >= 0 ? BI[SM[stA]].mel : cb.mel;
      let more = 0;
      for (let j = 0; j < a.length; j += 5) {
        if (a[j] == stS) { const i = a[j + 1]; trig(i, TON + deg(mel, a[j + 2]), a[j + 4] / 9, t0 + rnd() * 0.006 * SR, a[j + 3] * sl * 0.95); }
        if (a[j] > stS) more = 1;
      }
      stS++; if (!more) stA = -1;
    }
    sN = s + 1 >= BL ? 0 : s + 1;
  }

  class P extends AudioWorkletProcessor {
    static get parameterDescriptors() { return PN.map((name) => ({ name, defaultValue: 0, automationRate: 'k-rate' })); }
    constructor(o) {
      super();
      const D = o.processorOptions;
      IN = D.inst; ER = D.eras; BI = D.bios; ST = D.sting; SM = D.stm || []; TON = D.ton; MU = D.mus ?? 1; SX = D.sfx ?? 1;
      FI = D.fin.i; FN = D.fin.n; FM = D.fin.mel;
      NB = BI.length;
      bBL = new Int16Array(NB); ORN = new Int8Array(NB * 8); mt4 = new Int16Array(NB); thAt = new Int16Array(NB * 128).fill(-1);
      BI.forEach((b, k) => {
        bBL[k] = b.bl || 16;
        const og = b.orn || [0];
        for (let i = 0; i < 8; i++) ORN[k * 8 + i] = og[i % og.length];
        for (let t = 0; t < b.thm.length; t += 3) { thAt[k * 128 + b.thm[t]] = t / 3; if (!mt4[k] && b.thm[t] >= 4 * bBL[k]) mt4[k] = t / 3; }
      });
      eAc = fl32(ER.length);
      ER.forEach((e, k) => { eAc[k] = e.ac ?? 1; });
      const pl = [];
      ER.forEach((e, k) => e.parts.forEach((p) => pl.push([k, p])));
      BI.forEach((b, k) => b.parts.forEach((p) => pl.push([k + 100, p])));
      NP = pl.length;
      let nl = 0;
      pl.forEach(([, p]) => { nl += p[5] ? p[5].length : 0; });
      pI = new Int16Array(NP); pRo = new Int8Array(NP); pOw = new Int16Array(NP); pOc = new Int16Array(NP); pK = fl32(NP); pFl = new Uint8Array(NP);
      pLo = new Int16Array(NP); pLl = new Int16Array(NP); pLd = fl32(nl + 1);
      pPat = fl32(NP * 16); pG = fl32(NP); pT = fl32(NP); pA = new Int32Array(NP);
      nl = 0;
      pl.forEach(([w, p], k) => {
        pOw[k] = w; pI[k] = p[0]; pRo[k] = p[1]; pOc[k] = p[3]; pK[k] = p[4]; pFl[k] = p[6] || 0;
        if (p[5]) { pLo[k] = nl; pLl[k] = p[5].length; for (const d of p[5]) pLd[nl++] = d; }
        for (let s = 0; s < 16; s++) { const c = p[2][s]; pPat[k * 16 + s] = c && c != '.' ? c / 9 : 0; }
      });
      this.port.onmessage = (e) => { const d = e.data; if (d == -1) { lpP = 1; eOn = 1; } else if (d == -2) { finP = 1; eOn = 0; } else if (d >= 0 && ST[d]) stP = d; };
    }
    process(_, O, pr) {
      const oL = O[0][0], oR = O[0][1];
      if (!oL) return true;
      pe = pr.era[0]; peb = pr.eb[0] / 1000; pba = pr.ba[0]; pbb = pr.bb[0]; pbl = pr.bbl[0] / 1000; psp = pr.spd[0] / 20; psf = pr.surf[0];
      bL.fill(0); bR.fill(0); bRv.fill(0); bDy.fill(0);
      while (ns < B) { step(ns | 0); ns += SR * 15 / bpm; }
      ns -= B;
      for (let v = 0; v < NV; v++) if (vOn[v]) voice(v);

      // block-rate control for noise makers
      const nb = BI.length, b0 = ci(pba, nb), b1 = ci(pbb, nb);
      for (let k = 0; k < 5; k++) { awT[k] = (1 - pbl) * BI[b0].amb[k] + pbl * BI[b1].amb[k]; aw[k] += (awT[k] - aw[k]) * 0.006; }
      const sf_ = ci(psf, 3);
      s0 += ((sf_ == 0) - s0) * 0.03; s1 += ((sf_ == 1) - s1) * 0.03; s2 += ((sf_ == 2) - s2) * 0.03;
      rf += (rfT - rf) * 0.003;
      lf += B / SR;
      const sp = spS, f0 = mtof(TON - 24);
      sf(0, 90 + sp * 6, 0.9); sf(1, 320 + sp * 18 + 140 * sin(lf * 0.7), 0.9); sf(8, 440 + sp * 16 + 160 * sin(lf * 0.53), 0.9);
      sf(2, 560 + 260 * sin(lf * 0.41) + 170 * sin(lf * 0.93), 7); sf(3, 520, 0.7); sf(4, 260, 0.7); sf(5, 900, 0.7);
      sf(6, 2300, 6); sf(7, 1200, 1.2); sf(9, 300 + 140 * sin(lf * 0.31), 1.4); sf(10, 300 + 140 * sin(lf * 0.37 + 1), 1.4);
      const dtT = 0.75 * 60 / bpm;
      for (let i = 0; i < B; i++) {
        spS += (psp - spS) * 0.0001;
        const n1 = nz(), n2 = nz(), n3 = nz(), tv = min(spS / 25, 1.4), wv = min(spS / 40, 1.5), wa = wv * wv * 0.05 + aw[4] * 0.03;
        // car: engine hum + faint turbine whine
        const ef = (26 + spS * 1.4) / SR; eph += ef; if (eph >= 1) eph -= 1; wph += ef * 6.5; if (wph >= 1) wph -= 1;
        eG += (eOn - eG) * 2e-5; // the ending: the engine is switched off (fades over ~1 s)
        const en = (fl(0, 2 * eph - 1 + 1.5 * sin(T * eph)) * (0.025 + 0.03 * min(spS / 40, 1.2)) + sin(T * wph) * 0.004 * min(spS / 30, 1)) * eG;
        // wind (two decorrelated bands), ice howl, water
        fl(1, n1); const wl = fbp * wa; fl(8, n2); const wr = fbp * wa;
        fl(2, n3); const hw = fbp * aw[1] * 0.1 * (0.7 + 0.3 * sin(lf * 0.21));
        wtp += 0.31 / SR; if (wtp >= 1) wtp -= 1;
        const wt = fl(3, n1) * aw[2] * 0.12 * (0.55 + 0.45 * sin(T * wtp) * sin(T * 2.7 * wtp));
        // crickets
        c1 += 4250 / SR; c2 += 4680 / SR; cg += 17 / SR; cb1 += 0.61 / SR; cb2 += 0.47 / SR;
        if (c1 >= 1) c1 -= 1; if (c2 >= 1) c2 -= 1; if (cg >= 1) cg -= 1; if (cb1 >= 1) cb1 -= 1; if (cb2 >= 1) cb2 -= 1;
        const g1 = max(0, sin(T * cg)), k1 = max(0, sin(T * cb1)), k2 = max(0, sin(T * cb2)), ca = aw[0] * 0.05 * g1 * g1;
        const cl = sin(T * c1) * ca * k1 * k1, cr = sin(T * c2) * ca * k2 * k2;
        // birds
        let bo = 0;
        if (bN > 0) {
          const x = bC / (0.09 * SR);
          if (x < 1) { bph += (2500 + 1300 * (1 - x)) / SR; if (bph >= 1) bph -= 1; bo = sin(T * bph) * sin(Math.PI * x) * aw[3] * 0.028; }
          if (++bC > 0.15 * SR) { bC = 0; bN--; }
        } else if (--bT <= 0) { bT = (1.5 + rnd() * 5) * SR; if (rnd() < aw[3]) { bN = 2 + (rnd() * 4 | 0); bpn = rnd(); } }
        // tyres: trail rustle, dirt crunch, stone joints
        const ty = fl(4, n2) * 0.1 * s0 * tv + fl(5, n3) * 0.07 * s1 * tv;
        fl(6, rnd() < spS * s1 * 0.00025 ? nz() : 0); const cr_ = fbp * 0.35 * s1;
        jp += spS / 6 / SR; if (jp >= 1) { jp = rnd() * 0.4; tE = 1; tP = 0; } // paving joints every ~4-6 m
        tE *= TC; tP += 62 / SR;
        fl(7, n1);
        const sto = (sin(T * tP) * tE * 0.07 * min(spS / 20, 1) + fbp * 0.025 * tv) * s2;
        // drone: tonic + fifth, slow filter drift
        dLv += (dT - dLv) * 0.00002;
        let dnL = 0, dnR = 0;
        if (dLv > 1e-4) {
          d0 += f0 / SR; d1 += f0 * 1.0035 / SR; d2 += f0 * 1.5 / SR; d3 += f0 * 1.497 / SR; d4 += f0 * 0.5 / SR;
          if (d0 >= 1) d0 -= 1; if (d1 >= 1) d1 -= 1; if (d2 >= 1) d2 -= 1; if (d3 >= 1) d3 -= 1; if (d4 >= 1) d4 -= 1;
          const sub = sin(T * d4) * 0.6, dg = dLv * 0.07 * MU;
          dnL = (fl(9, 2 * d0 - 1 + 0.6 * (2 * d2 - 1)) + sub) * dg;
          dnR = (fl(10, 2 * d1 - 1 + 0.6 * (2 * d3 - 1)) + sub) * dg;
        }
        const sfx = en + ty + cr_ + sto;
        bL[i] += (sfx + wl + hw * 0.8 + wt + cl + bo * (1 - bpn)) * SX + dnL;
        bR[i] += (sfx + wr + hw * 0.6 + wt * 0.8 + cr + bo * bpn) * SX + dnR;
        bRv[i] += (hw * 0.5 + bo * 0.6) * SX + (dnL + dnR) * 0.25;
      }
      // delay (ping-pong, dotted eighth) + 4-line feedback-delay reverb + limiter
      for (let i = 0; i < B; i++) {
        dtS += (dtT - dtS) * 0.00002;
        let rp = dw - dtS * SR; if (rp < 0) rp += DL;
        const i0 = rp | 0, i1 = (i0 + 1) % DL, fr = rp - i0;
        const yl = dbL[i0] + (dbL[i1] - dbL[i0]) * fr, yr = dbR[i0] + (dbR[i1] - dbR[i0]) * fr;
        dlp += 0.45 * (yr - dlp);
        dbL[dw] = bDy[i] + dlp * 0.42; dbR[dw] = yl; dw = (dw + 1) % DL;
        const ri = (bRv[i] + (yl + yr) * 0.15) * 0.5;
        let sm = 0;
        for (let k = 0; k < 4; k++) { ro[k] = rb[rOf[k] + rI[k]]; sm += ro[k]; }
        sm *= 0.5;
        for (let k = 0; k < 4; k++) {
          rlp[k] += 0.55 * (ro[k] - sm - rlp[k]);
          rb[rOf[k] + rI[k]] = rlp[k] * rf + (k & 1 ? -ri : ri);
          if (++rI[k] >= rLn[k]) rI[k] = 0;
        }
        let L = (bL[i] + yl * 0.5 + (ro[0] + ro[2]) * 0.4) * 0.62, R = (bR[i] + yr * 0.5 + (ro[1] + ro[3]) * 0.4) * 0.62;
        const pk = max(abs(L), abs(R));
        if (pk * lg > 0.84) lg = 0.84 / pk; else lg += (1 - lg) * 0.00015;
        oL[i] = L * lg; oR[i] = R * lg;
      }
      return true;
    }
  }
  registerProcessor('jtt-audio', P);
}
