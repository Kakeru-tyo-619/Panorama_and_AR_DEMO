// cameraPoseFromEuler の確認：既知の姿勢を回転行列で作り、W3C の Euler 角に分解してから戻す
(globalThis as any).location = { search: '' }; (globalThis as any).localStorage = { getItem: () => null, setItem() {} };
import { cameraToWorld, DEG } from '../src/lib/angles';
const { cameraPoseFromEuler } = await import('../src/lib/sensors');

// カメラ姿勢 → 端末の回転行列（列 = 端末の x, y, z 軸を世界 ENU で表したもの）→ ZXY Euler
function eulerFromPose(heading: number, pitch: number, roll: number) {
  // camera 座標(x右,y上,z前) を世界(x東,y上,z北)へ。端末軸：x=右, y=上, z=画面の法線(=カメラの逆)
  const toENU = (v: number[]) => [v[0], v[2], v[1]]; // (東, 北, 上)
  const dx = toENU(cameraToWorld([1, 0, 0], heading * DEG, pitch * DEG, roll * DEG));
  const dy = toENU(cameraToWorld([0, 1, 0], heading * DEG, pitch * DEG, roll * DEG));
  const dz = toENU(cameraToWorld([0, 0, -1], heading * DEG, pitch * DEG, roll * DEG));
  // R = [dx dy dz]（列）。W3C ZXY: R21 = sin(beta), R20 = -cos(beta) sin(gamma), R22 = cos(beta) cos(gamma),
  // R01 = -sin(alpha) cos(beta), R11 = cos(alpha) cos(beta)
  const beta = Math.asin(dy[2]);
  const gamma = Math.atan2(-dx[2], dz[2]);
  const alpha = Math.atan2(-dy[0], dy[1]);
  return [alpha / DEG, beta / DEG, gamma / DEG];
}

let worst = 0;
for (const [h, p, r] of [[0, 0, 0], [90, 1, 0], [200, 8, 0], [45, -7, 6], [300, 3, -9], [10, 0, 12], [180, -10, -5]]) {
  const [a, b, g] = eulerFromPose(h, p, r);
  const got = cameraPoseFromEuler(a, b, g);
  const dh = Math.abs(((got.heading - h + 540) % 360) - 180);
  const e = Math.max(dh, Math.abs(got.pitch - p), Math.abs(got.roll - r));
  worst = Math.max(worst, e);
  console.log(`pose h=${h} p=${p} r=${r} -> euler a=${a.toFixed(1)} b=${b.toFixed(1)} g=${g.toFixed(1)} -> h=${got.heading.toFixed(2)} p=${got.pitch.toFixed(2)} r=${got.roll.toFixed(2)}`);
}
console.log('worst error (deg):', worst.toFixed(4));
