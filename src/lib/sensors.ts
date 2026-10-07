import { DEG, angleDiff, circularMean, wrap360 } from './angles';
import { createStore, isMock } from './store';

export type SensorSource = 'ios-compass' | 'android-absolute' | 'relative' | 'mock' | 'none';

export type OrientationState = {
  started: boolean;
  source: SensorSource;
  heading: number; // 背面カメラの向く方位。北=0 時計回り（度）
  pitch: number; // 上向きが正（度）。縦持ちで正面を向いた状態が 0
  roll: number; // 画面右端が下がる向きが正（度）
  speed: number; // 回転速度（度/秒）
  raw: { alpha: number | null; beta: number | null; gamma: number | null; compass: number | null };
  updatedAt: number;
};

export const orientation = createStore<OrientationState>({
  started: false,
  source: isMock() ? 'mock' : 'none',
  heading: 0,
  pitch: 0,
  roll: 0,
  speed: 0,
  raw: { alpha: null, beta: null, gamma: null, compass: null },
  updatedAt: 0,
});

/**
 * DeviceOrientation の Euler 角（W3C: R = Rz(alpha)·Rx(beta)·Ry(gamma)）から
 * 背面カメラの方位・仰角・ロールを求める。
 * 縦持ちでは beta≈90 付近で Euler 角が特異になり gamma をそのままロールに使えないため、
 * 回転行列から背面方向ベクトル等を作って計算する（gamma≈0 のとき方位は 360 - alpha と一致）。
 */
export function cameraPoseFromEuler(alpha: number, beta: number, gamma: number) {
  const ca = Math.cos(alpha * DEG), sa = Math.sin(alpha * DEG);
  const cb = Math.cos(beta * DEG), sb = Math.sin(beta * DEG);
  const cg = Math.cos(gamma * DEG), sg = Math.sin(gamma * DEG);
  // 背面カメラ方向 d = -R·(0,0,1)  （世界座標 x=東, y=北, z=上）
  const dx = -(ca * sg + sa * sb * cg);
  const dy = -(sa * sg - ca * sb * cg);
  const dz = -cb * cg;
  // 端末の右 r = R·(1,0,0) の z 成分, 端末の上 u = R·(0,1,0) の z 成分
  const rz = -cb * sg;
  const uz = sb;
  return {
    heading: wrap360(Math.atan2(dx, dy) / DEG),
    pitch: Math.asin(Math.max(-1, Math.min(1, dz))) / DEG,
    roll: Math.atan2(-rz, uz) / DEG,
  };
}

const WINDOW = 5;
let buf: { h: number; p: number; r: number }[] = [];
const SPEED_WINDOW_MS = 100;
let hist: { h: number; p: number; r: number; t: number }[] = [];
let refCount = 0;
let gotAbsolute = false;
let listeners: (() => void) | null = null;

function push(h: number, p: number, r: number, source: SensorSource, raw: OrientationState['raw']) {
  buf.push({ h, p, r });
  if (buf.length > WINDOW) buf.shift();
  const sh = circularMean(buf.map((b) => b.h));
  const sp = buf.reduce((a, b) => a + b.p, 0) / buf.length;
  const sr = circularMean(buf.map((b) => b.r));
  const roll = sr > 180 ? sr - 360 : sr;
  const now = performance.now();
  // 回転速度：約100ms前の値との差から求める（イベント間隔のばらつきに強くする）
  hist.push({ h: sh, p: sp, r: roll, t: now });
  while (hist.length > 2 && now - hist[1].t >= SPEED_WINDOW_MS) hist.shift();
  const ref = hist[0];
  const dt = (now - ref.t) / 1000;
  const speed = dt > 0.02 ? Math.hypot(angleDiff(sh, ref.h), sp - ref.p, angleDiff(roll, ref.r)) / dt : orientation.get().speed;
  orientation.set({ heading: sh, pitch: sp, roll, speed, source, raw, updatedAt: now });
}

type IOSOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

function onOrientation(e: DeviceOrientationEvent, absoluteEvent: boolean) {
  const ev = e as IOSOrientationEvent;
  if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
  const raw = { alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma, compass: ev.webkitCompassHeading ?? null };
  const pose = cameraPoseFromEuler(ev.alpha, ev.beta, ev.gamma);
  if (typeof ev.webkitCompassHeading === 'number' && !Number.isNaN(ev.webkitCompassHeading)) {
    // iOS: 方位は webkitCompassHeading（磁北基準）。傾きは beta/gamma から求める
    push(ev.webkitCompassHeading, pose.pitch, pose.roll, 'ios-compass', raw);
    return;
  }
  if (absoluteEvent || ev.absolute) {
    gotAbsolute = true;
    push(pose.heading, pose.pitch, pose.roll, 'android-absolute', raw);
    return;
  }
  if (!gotAbsolute) {
    // 絶対方位が得られない端末：相対方位（北基準ではない）
    push(pose.heading, pose.pitch, pose.roll, 'relative', raw);
  }
}

const absHandler = (e: Event) => onOrientation(e as DeviceOrientationEvent, true);
const relHandler = (e: Event) => onOrientation(e as DeviceOrientationEvent, false);

/** iOS ではユーザー操作のハンドラ内で同期的に呼ぶこと */
export function requestOrientationPermission(): Promise<'granted' | 'denied' | 'not-required'> {
  if (isMock()) return Promise.resolve('not-required');
  const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } })
    .DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    return DOE.requestPermission()
      .then((r) => (r === 'granted' ? 'granted' : 'denied') as 'granted' | 'denied')
      .catch(() => 'denied' as const);
  }
  return Promise.resolve('not-required');
}

export function startSensors(): () => void {
  refCount++;
  if (refCount === 1) {
    buf = [];
    hist = [];
    gotAbsolute = false;
    if (isMock()) {
      orientation.set({ started: true, source: 'mock' });
      setMockOrientation(mockState);
      // 実機のセンサーと同じく一定間隔で値を流す（回転速度が 0 に戻るように）
      const id = setInterval(() => setMockOrientation(mockState), 50);
      listeners = () => clearInterval(id);
    } else {
      orientation.set({ started: true });
      window.addEventListener('deviceorientationabsolute', absHandler);
      window.addEventListener('deviceorientation', relHandler);
      listeners = () => {
        window.removeEventListener('deviceorientationabsolute', absHandler);
        window.removeEventListener('deviceorientation', relHandler);
      };
    }
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    refCount--;
    if (refCount === 0) {
      listeners?.();
      listeners = null;
      orientation.set({ started: false });
    }
  };
}

// ---- モック（PC 確認用） ----
let mockState = { heading: 0, pitch: 0, roll: 0 };
export const mockOrientation = createStore({ ...mockState, autoRotate: false, rotateSpeed: 15 });

export function setMockOrientation(v: { heading: number; pitch: number; roll: number }) {
  mockState = { heading: wrap360(v.heading), pitch: v.pitch, roll: v.roll };
  mockOrientation.set(mockState);
  if (orientation.get().started && isMock()) {
    push(mockState.heading, mockState.pitch, mockState.roll, 'mock', {
      alpha: null,
      beta: null,
      gamma: null,
      compass: null,
    });
  }
}

export function sourceLabel(s: SensorSource): string {
  switch (s) {
    case 'ios-compass':
      return 'iOS compass (webkitCompassHeading)';
    case 'android-absolute':
      return 'Android absolute (deviceorientationabsolute)';
    case 'relative':
      return '相対方位のみ（北基準でない）';
    case 'mock':
      return 'モック';
    default:
      return '取得不可';
  }
}
