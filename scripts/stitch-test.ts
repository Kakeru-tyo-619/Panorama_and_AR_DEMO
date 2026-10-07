// 合成画像で stitchImages の幾何と明るさ合わせを検証する
import { cameraToWorld, DEG, focalFromHfov } from '../src/lib/angles';
import { stitchImages } from '../src/lib/stitchCore';

// 方位 az(rad) と円筒高さ h の関数としての模様（滑らかな縞）
function scene(az: number, h: number): [number, number, number] {
  const a = az / (2 * Math.PI);
  return [
    128 + 100 * Math.sin(a * 2 * Math.PI * 24),
    128 + 100 * Math.sin(h * 20),
    128 + 60 * Math.sin(a * 2 * Math.PI * 7 + h * 6),
  ];
}

const W = 360, H = 640, HFOV = 65;
const f = focalFromHfov(W, HFOV);
const poses = Array.from({ length: 12 }, (_, i) => ({
  heading: i * 30 + (i % 2 ? 2.5 : -2.5),
  pitch: [4, -6, 8, 0, -3, 9, 2, -8, 5, -1, 7, -4][i],
  roll: [5, -7, 3, 0, 8, -4, -2, 6, -6, 2, 4, -3][i],
}));
const exposure = poses.map((_, i) => 1 + 0.18 * Math.sin(i * 0.9));
const imgs = poses.map((p, k) => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = cameraToWorld([(x + 0.5 - W / 2) / f, -(y + 0.5 - H / 2) / f, 1], p.heading * DEG, p.pitch * DEG, p.roll * DEG);
      let az = Math.atan2(v[0], v[2]);
      if (az < 0) az += 2 * Math.PI;
      const c = scene(az, v[1] / Math.hypot(v[0], v[2]));
      const i = (y * W + x) * 4;
      data[i] = c[0] * exposure[k];
      data[i + 1] = c[1] * exposure[k];
      data[i + 2] = c[2] * exposure[k];
      data[i + 3] = 255;
    }
  return { data, width: W, height: H };
});

const t0 = performance.now();
const out = stitchImages(imgs, poses, HFOV);
console.log(`stitch ${Math.round(performance.now() - t0)} ms, ${out.width}x${out.height}, gains ${out.gains.map((g) => g.toFixed(3)).join(',')}`);
console.log('expected gains ~ 1/exposure (scaled):', exposure.map((e) => (1 / e).toFixed(3)).join(','));

// 中央 60% の行で、真の模様との差を測る（明るさ合わせ後なので全体の係数を合わせてから）
const s = out.width / (2 * Math.PI);
let err = 0, n = 0, sumOut = 0, sumGt = 0;
const rows: [number, number] = [Math.round(out.height * 0.2), Math.round(out.height * 0.8)];
for (let y = rows[0]; y < rows[1]; y += 2)
  for (let x = 0; x < out.width; x += 2) {
    const gt = scene((x + 0.5) / s, (out.height / 2 - (y + 0.5)) / s);
    const i = (y * out.width + x) * 4;
    sumOut += out.rgba[i + 1];
    sumGt += gt[1];
  }
const k = sumGt / sumOut;
for (let y = rows[0]; y < rows[1]; y += 2)
  for (let x = 0; x < out.width; x += 2) {
    const gt = scene((x + 0.5) / s, (out.height / 2 - (y + 0.5)) / s);
    const i = (y * out.width + x) * 4;
    err += Math.abs(out.rgba[i] * k - gt[0]) + Math.abs(out.rgba[i + 1] * k - gt[1]) + Math.abs(out.rgba[i + 2] * k - gt[2]);
    n += 3;
  }
console.log(`mean abs error vs ground truth: ${(err / n).toFixed(2)} (0-255), coverage ${out.coverageMask.split('').filter((c) => c === '1').length}°`);
