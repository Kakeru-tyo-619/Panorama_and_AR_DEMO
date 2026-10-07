/**
 * 方位を使った円筒パノラマ合成（特徴点による位置合わせは行わない）。
 *
 * 仕様の 1)傾き補正 2)円筒への投影 3)配置 は、出力パノラマの各画素から
 * 「どの写真のどの画素か」を逆算する1回の写像でまとめて行う：
 *   パノラマ画素 (u,v) → 方位 a = u/s, 円筒の高さ h = (vc - v)/s
 *   → 世界の方向 (sin a, h, cos a) → 撮影時の heading/pitch/roll で逆回転
 *   → ピンホール投影で元画像の座標 (xs, ys)
 * pitch/roll が小さいとき、これは「roll 分の逆回転 + pitch 分の上下移動 + atan による円筒変換」と一致する。
 * 0°/360°をまたぐ画像は、列番号を PW で折り返して両端に描く。
 */
import { DEG, focalFromHfov } from './angles';

export type Img = { data: Uint8ClampedArray; width: number; height: number };
export type ShotPose = { heading: number; pitch: number; roll: number }; // 度

export const PANO_WIDTH = 4096;
export const MAX_PANO_HEIGHT = 2048; // iOS の Canvas 面積制限（約1,670万画素）より十分小さくする

type Prepared = {
  img: Img;
  f: number;
  cx: number;
  cy: number;
  heading: number; // rad
  cp: number;
  sp: number;
  cr: number;
  sr: number;
  halfAngle: number; // 横方向に走査する範囲（rad）
  gain: number;
};

export type PanoGeometry = { PW: number; PH: number; s: number; vc: number };

export function panoGeometry(srcW: number, srcH: number, hfovDeg: number): PanoGeometry {
  const f = focalFromHfov(srcW, hfovDeg);
  const s = PANO_WIDTH / (2 * Math.PI); // 1ラジアンあたりの画素数
  // 縦はカメラの縦画角から計算：画像上端の円筒高さ h = (H/2)/f
  let PH = Math.round((s * srcH) / f);
  PH = Math.min(MAX_PANO_HEIGHT, PH + (PH % 2));
  return { PW: PANO_WIDTH, PH, s, vc: PH / 2 };
}

function prepare(img: Img, pose: ShotPose, hfovDeg: number): Prepared {
  const f = focalFromHfov(img.width, hfovDeg);
  const p = pose.pitch * DEG;
  const r = pose.roll * DEG;
  return {
    img,
    f,
    cx: img.width / 2,
    cy: img.height / 2,
    heading: pose.heading * DEG,
    cp: Math.cos(p),
    sp: Math.sin(p),
    cr: Math.cos(r),
    sr: Math.sin(r),
    halfAngle: Math.min(80 * DEG, Math.atan(Math.hypot(img.width, img.height) / 2 / f)),
    gain: 1,
  };
}

/**
 * 1枚の写真を、パノラマの行 [row0,row1) の範囲に逆写像で描く。
 * visit(出力インデックス, r, g, b, 重み) を呼ぶ。重みは画像の左右の端に近いほど小さくなる線形の重み。
 * scale はパノラマ解像度に対する比率（低解像度の統計用）。
 */
function warp(
  P: Prepared,
  g: PanoGeometry,
  scale: number,
  row0: number,
  row1: number,
  visit: (idx: number, r: number, gg: number, b: number, w: number) => void,
) {
  const PW = Math.round(g.PW * scale);
  const s = g.s * scale;
  const vc = g.vc * scale;
  const { data, width: W, height: H } = P.img;
  const c0 = Math.floor((P.heading - P.halfAngle) * s);
  const c1 = Math.ceil((P.heading + P.halfAngle) * s);
  const halfW = W / 2;
  for (let row = row0; row < row1; row++) {
    const h = (vc - (row + 0.5)) / s;
    const base = (row - row0) * PW;
    for (let c = c0; c <= c1; c++) {
      const d = (c + 0.5) / s - P.heading;
      const x = Math.sin(d);
      const z = Math.cos(d);
      // pitch の逆回転
      const y1 = h * P.cp - z * P.sp;
      const z1 = h * P.sp + z * P.cp;
      if (z1 <= 0.05) continue;
      // roll の逆回転
      const x2 = x * P.cr - y1 * P.sr;
      const y2 = x * P.sr + y1 * P.cr;
      const fx = P.cx + (P.f * x2) / z1;
      const fy = P.cy - (P.f * y2) / z1;
      const xs = fx - 0.5;
      const ys = fy - 0.5;
      if (xs < 0 || ys < 0 || xs > W - 1 || ys > H - 1) continue;
      // バイリニア補間
      const x0 = xs | 0, y0 = ys | 0;
      const ax = xs - x0, ay = ys - y0;
      const xA = x0 + (x0 < W - 1 ? 1 : 0);
      const yA = y0 + (y0 < H - 1 ? 1 : 0);
      const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + xA) * 4;
      const i01 = (yA * W + x0) * 4, i11 = (yA * W + xA) * 4;
      const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
      const r = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
      const gg = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
      const b = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
      const wEdge = Math.max(0.001, 1 - Math.abs(fx - halfW) / halfW);
      let col = c % PW;
      if (col < 0) col += PW;
      visit(base + col, r, gg, b, wEdge);
    }
  }
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 明るさ合わせ：隣り合う写真の重なり部分の平均輝度から、各写真にかける係数を求める */
function computeGains(shots: Prepared[], g: PanoGeometry): { gains: number[]; pairs: number } {
  const n = shots.length;
  const q = 0.25;
  const PWq = Math.round(g.PW * q);
  const PHq = Math.round(g.PH * q);
  // 各写真の低解像度の輝度（0=無効, 1〜255=輝度+1）
  const lums = shots.map((P) => {
    const L = new Uint8Array(PWq * PHq);
    warp(P, g, q, 0, PHq, (idx, r, gg, b) => {
      L[idx] = Math.min(255, Math.max(1, Math.round(lum(r, gg, b)) + 1));
    });
    return L;
  });
  const order = shots.map((_, i) => i).sort((a, b) => shots[a].heading - shots[b].heading);
  type Pair = { i: number; j: number; li: number; lj: number };
  const pairs: Pair[] = [];
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const j = order[(k + 1) % n];
    if (i === j) continue;
    if (n === 2 && k === 1) continue;
    const A = lums[i], B = lums[j];
    let si = 0, sj = 0, cnt = 0;
    for (let t = 0; t < A.length; t++) {
      if (A[t] && B[t]) {
        si += A[t] - 1;
        sj += B[t] - 1;
        cnt++;
      }
    }
    if (cnt > 50 && si > 0 && sj > 0) pairs.push({ i, j, li: Math.log(si / cnt), lj: Math.log(sj / cnt) });
  }
  const means = lums.map((L) => {
    let s = 0, c = 0;
    for (let t = 0; t < L.length; t++) if (L[t]) { s += L[t] - 1; c++; }
    return c ? s / c : 0;
  });
  // 最小二乗：Σ (x_i + l_i − x_j − l_j)² + λΣx² を Gauss-Seidel で解く（x = log 係数）
  const x = new Float64Array(n);
  const lambda = 0.01;
  for (let it = 0; it < 200; it++) {
    for (let i = 0; i < n; i++) {
      let num = 0, den = lambda;
      for (const p of pairs) {
        if (p.i === i) { num += x[p.j] + p.lj - p.li; den += 1; }
        else if (p.j === i) { num += x[p.i] + p.li - p.lj; den += 1; }
      }
      x[i] = num / den;
    }
  }
  let gains = Array.from(x, (v) => Math.min(2, Math.max(0.5, Math.exp(v))));
  // 全体の平均輝度が変わらないように正規化
  const before = means.reduce((a, b) => a + b, 0);
  const after = means.reduce((a, m, i) => a + m * gains[i], 0);
  if (after > 0) gains = gains.map((v) => (v * before) / after);
  return { gains, pairs: pairs.length };
}

export type StitchOutput = {
  rgba: Uint8ClampedArray; // PW×PH（未撮影は灰色・不透明。範囲は coverageMask で表す）
  width: number;
  height: number;
  coverageMask: string; // 1°ごとの '0'/'1'
  gains: number[];
};

export function stitchImages(
  imgs: Img[],
  poses: ShotPose[],
  hfovDeg: number,
  onProgress?: (msg: string) => void,
): StitchOutput {
  if (!imgs.length) throw new Error('写真がありません');
  const g = panoGeometry(imgs[0].width, imgs[0].height, hfovDeg);
  const shots = imgs.map((img, i) => prepare(img, poses[i], hfovDeg));

  onProgress?.('明るさ合わせ');
  const { gains } = computeGains(shots, g);
  shots.forEach((P, i) => (P.gain = gains[i]));

  const { PW, PH } = g;
  const out = new Uint8ClampedArray(PW * PH * 4);
  const BAND = 64;
  const acc = new Float32Array(PW * BAND * 4);
  for (let row0 = 0; row0 < PH; row0 += BAND) {
    const row1 = Math.min(PH, row0 + BAND);
    acc.fill(0);
    for (const P of shots) {
      const k = P.gain;
      warp(P, g, 1, row0, row1, (idx, r, gg, b, w) => {
        const a = idx * 4;
        acc[a] += r * k * w;
        acc[a + 1] += gg * k * w;
        acc[a + 2] += b * k * w;
        acc[a + 3] += w;
      });
    }
    const n = (row1 - row0) * PW;
    const o = row0 * PW * 4;
    for (let t = 0; t < n; t++) {
      const a = t * 4;
      const w = acc[a + 3];
      if (w > 0) {
        out[o + a] = acc[a] / w;
        out[o + a + 1] = acc[a + 1] / w;
        out[o + a + 2] = acc[a + 2] / w;
        out[o + a + 3] = 255;
      }
    }
    onProgress?.(`境目のぼかし ${Math.round((row1 / PH) * 100)}%`);
  }

  // 上下の欠け（傾き補正で生じる隙間）は列ごとに最も近い有効画素で埋める
  const colValid = new Uint8Array(PW);
  for (let c = 0; c < PW; c++) {
    let top = -1, bottom = -1;
    for (let r = 0; r < PH; r++) if (out[(r * PW + c) * 4 + 3]) { top = r; break; }
    if (top < 0) {
      for (let r = 0; r < PH; r++) {
        const i = (r * PW + c) * 4;
        out[i] = out[i + 1] = out[i + 2] = 110;
        out[i + 3] = 255;
      }
      continue;
    }
    colValid[c] = 1;
    for (let r = PH - 1; r >= 0; r--) if (out[(r * PW + c) * 4 + 3]) { bottom = r; break; }
    const ti = (top * PW + c) * 4, bi = (bottom * PW + c) * 4;
    for (let r = 0; r < PH; r++) {
      const i = (r * PW + c) * 4;
      if (out[i + 3]) continue;
      const srcI = r < top ? ti : r > bottom ? bi : -1;
      if (srcI >= 0) {
        out[i] = out[srcI];
        out[i + 1] = out[srcI + 1];
        out[i + 2] = out[srcI + 2];
      }
      out[i + 3] = 255;
    }
  }
  let mask = '';
  for (let d = 0; d < 360; d++) mask += colValid[Math.floor(((d + 0.5) / 360) * PW)] ? '1' : '0';

  return { rgba: out, width: PW, height: PH, coverageMask: mask, gains };
}
