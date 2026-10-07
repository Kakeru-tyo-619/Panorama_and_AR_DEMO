export const DEG = Math.PI / 180;

export function wrap360(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

/** a - b を -180〜180 の範囲で返す */
export function angleDiff(a: number, b: number): number {
  let d = wrap360(a - b);
  if (d > 180) d -= 360;
  return d;
}

/** 角度（度）の円周平均。0°/360°の境目でも壊れないよう sin/cos で平均する */
export function circularMean(values: number[]): number {
  let s = 0;
  let c = 0;
  for (const v of values) {
    s += Math.sin(v * DEG);
    c += Math.cos(v * DEG);
  }
  return wrap360(Math.atan2(s, c) / DEG);
}

/**
 * カメラ座標 <-> 世界座標の回転。
 * 世界座標: x=東, y=上, z=北。カメラ座標: x=右, y=上, z=前。
 * heading: 北=0 時計回り, pitch: 上向きが正, roll: 画面右端が下がる向き（時計回り）が正。すべてラジアン。
 */
export type Vec3 = [number, number, number];

export function worldToCamera(v: Vec3, heading: number, pitch: number, roll: number): Vec3 {
  const cy = Math.cos(heading), sy = Math.sin(heading);
  let x = v[0] * cy - v[2] * sy;
  let z = v[0] * sy + v[2] * cy;
  let y = v[1];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = y * cp - z * sp;
  z = y * sp + z * cp;
  y = y2;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const x2 = x * cr - y * sr;
  y = x * sr + y * cr;
  x = x2;
  return [x, y, z];
}

export function cameraToWorld(v: Vec3, heading: number, pitch: number, roll: number): Vec3 {
  const cr = Math.cos(roll), sr = Math.sin(roll);
  let x = v[0] * cr + v[1] * sr;
  let y = -v[0] * sr + v[1] * cr;
  let z = v[2];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = y * cp + z * sp;
  z = -y * sp + z * cp;
  y = y2;
  const cy = Math.cos(heading), sy = Math.sin(heading);
  const x2 = x * cy + z * sy;
  z = -x * sy + z * cy;
  x = x2;
  return [x, y, z];
}

/** 横画角(度)と画像幅(px)から焦点距離(px) */
export function focalFromHfov(width: number, hfovDeg: number): number {
  return width / 2 / Math.tan((hfovDeg * DEG) / 2);
}
