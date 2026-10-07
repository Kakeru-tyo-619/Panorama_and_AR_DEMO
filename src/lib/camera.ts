import { DEG, focalFromHfov } from './angles';
import { orientation } from './sensors';

export interface CameraSource {
  el: HTMLVideoElement | HTMLCanvasElement;
  width(): number;
  height(): number;
  grab(): Promise<Blob>;
  stop(): void;
}

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: false,
};

function canvasToBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality),
  );
}

export async function openRealCamera(stream: MediaStream): Promise<CameraSource> {
  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;
  await new Promise<void>((resolve) => {
    if (video.readyState >= 1) resolve();
    else video.onloadedmetadata = () => resolve();
  });
  await video.play().catch(() => undefined);
  const grabCanvas = document.createElement('canvas');
  return {
    el: video,
    width: () => video.videoWidth,
    height: () => video.videoHeight,
    async grab() {
      grabCanvas.width = video.videoWidth;
      grabCanvas.height = video.videoHeight;
      grabCanvas.getContext('2d')!.drawImage(video, 0, 0);
      return canvasToBlob(grabCanvas, 'image/jpeg', 0.9);
    },
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      video.pause();
      video.srcObject = null;
    },
  };
}

// ---------------------------------------------------------------------------
// モック用の合成カメラ：手続き的に作った360°の風景を、モックの方位・傾きで透視投影して表示する
// ---------------------------------------------------------------------------

export const MOCK_CAMERA_HFOV = 65;
const SW = 2048;
const H_RANGE = 1.3; // tan(仰角) の範囲
const SH = Math.round((SW * 2 * H_RANGE) / (2 * Math.PI));
let scene: Uint8ClampedArray | null = null;

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function buildScene(): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = SW;
  c.height = SH;
  const g = c.getContext('2d')!;
  const rowOf = (h: number) => ((H_RANGE - h) / (2 * H_RANGE)) * SH;
  const colOf = (deg: number) => (deg / 360) * SW;
  const horizon = rowOf(0);
  // 空
  const sky = g.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#2a5fa8');
  sky.addColorStop(1, '#bcd7ee');
  g.fillStyle = sky;
  g.fillRect(0, 0, SW, horizon);
  // 雲
  const rand = rng(7);
  g.fillStyle = 'rgba(255,255,255,0.75)';
  for (let i = 0; i < 18; i++) {
    const x = rand() * SW, y = rowOf(0.3 + rand() * 0.6);
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      g.ellipse(x + k * 22 - 44, y + Math.sin(k) * 6, 40, 16, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  // 太陽
  g.fillStyle = '#fff6c8';
  g.beginPath();
  g.arc(colOf(120), rowOf(0.47), 26, 0, Math.PI * 2);
  g.fill();
  // 地面
  const ground = g.createLinearGradient(0, horizon, 0, SH);
  ground.addColorStop(0, '#7d9b5a');
  ground.addColorStop(1, '#4a3a28');
  g.fillStyle = ground;
  g.fillRect(0, horizon, SW, SH - horizon);
  // 遠くの山
  g.fillStyle = '#6f84a0';
  for (let x = 0; x < SW; x++) {
    const a = (x / SW) * Math.PI * 2;
    const h = 0.07 + 0.05 * Math.sin(3 * a + 1) + 0.03 * Math.sin(7 * a + 2) + 0.015 * Math.sin(17 * a);
    g.fillRect(x, rowOf(h), 1, horizon - rowOf(h) + 1);
  }
  // 中景の建物（0°/360°をまたいでも描けるよう3回描く）
  const drawWrapped = (fn: (dx: number) => void) => [-SW, 0, SW].forEach(fn);
  const colors = ['#c9b79c', '#9aa5b1', '#d9cfc1', '#a0705a', '#e2e2d0', '#8c9a8a', '#b48a6a'];
  for (let i = 0; i < 16; i++) {
    const x = rand() * SW, w = 40 + rand() * 90, h = 0.1 + rand() * 0.25;
    const col = colors[i % colors.length];
    drawWrapped((dx) => {
      g.fillStyle = col;
      g.fillRect(x + dx, rowOf(h), w, rowOf(-0.03) - rowOf(h));
      g.fillStyle = 'rgba(40,60,90,0.55)';
      for (let wy = rowOf(h) + 8; wy < rowOf(0.0) - 10; wy += 16)
        for (let wx = x + 6; wx < x + w - 10; wx += 14) g.fillRect(wx + dx, wy, 7, 9);
    });
  }
  // 道路
  g.fillStyle = '#555';
  g.fillRect(0, rowOf(-0.12), SW, rowOf(-0.2) - rowOf(-0.12));
  g.fillStyle = '#eee';
  for (let x = 0; x < SW; x += 60) g.fillRect(x, rowOf(-0.16) - 2, 30, 4);
  // 近景の木
  for (const deg of [40, 155, 230, 310]) {
    drawWrapped((dx) => {
      const x = colOf(deg) + dx;
      g.fillStyle = '#4b3621';
      g.fillRect(x - 12, rowOf(0.35), 24, SH);
      g.fillStyle = '#2f5d2a';
      g.beginPath();
      g.arc(x, rowOf(0.5), 70, 0, Math.PI * 2);
      g.fill();
    });
  }
  // 方位ラベル
  g.font = 'bold 56px sans-serif';
  g.textAlign = 'center';
  g.lineWidth = 6;
  g.strokeStyle = '#000';
  g.fillStyle = '#fff';
  for (const [label, deg] of [['N', 0], ['E', 90], ['S', 180], ['W', 270], ['N', 360]] as const) {
    g.strokeText(label, colOf(deg), rowOf(0.8));
    g.fillText(label, colOf(deg), rowOf(0.8));
  }
  g.font = 'bold 24px sans-serif';
  for (let deg = 30; deg < 360; deg += 30) {
    if (deg % 90 === 0) continue;
    g.strokeText(`${deg}°`, colOf(deg), rowOf(0.8));
    g.fillText(`${deg}°`, colOf(deg), rowOf(0.8));
  }
  return g.getImageData(0, 0, SW, SH).data;
}

export function openMockCamera(): CameraSource {
  const W = 360, H = 640;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  if (!scene) scene = buildScene();
  const src = scene;
  const f = focalFromHfov(W, MOCK_CAMERA_HFOV);
  let lastKey = '';
  let raf = 0;

  const draw = () => {
    const o = orientation.get();
    const key = `${o.heading.toFixed(2)},${o.pitch.toFixed(2)},${o.roll.toFixed(2)}`;
    if (key !== lastKey) {
      lastKey = key;
      const hy = o.heading * DEG, p = o.pitch * DEG, r = o.roll * DEG;
      const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p);
      const cy = Math.cos(hy), sy = Math.sin(hy);
      // 自動露出の再現：向きによって明るさを変える（明るさ合わせの確認用）
      const exposure = 1 + 0.18 * Math.sin(hy + 0.5);
      const d = img.data;
      for (let y = 0; y < H; y++) {
        const Y = -(y + 0.5 - H / 2) / f;
        for (let x = 0; x < W; x++) {
          const X = (x + 0.5 - W / 2) / f;
          // cameraToWorld（インライン）
          const x1 = X * cr + Y * sr;
          const y1 = -X * sr + Y * cr;
          const y2 = y1 * cp + sp;
          const z2 = -y1 * sp + cp;
          const wx = x1 * cy + z2 * sy;
          const wz = -x1 * sy + z2 * cy;
          let az = Math.atan2(wx, wz);
          if (az < 0) az += Math.PI * 2;
          const h = y2 / Math.hypot(wx, wz);
          const sx = Math.min(SW - 1, Math.floor((az / (Math.PI * 2)) * SW));
          const syy = Math.max(0, Math.min(SH - 1, Math.floor(((H_RANGE - h) / (2 * H_RANGE)) * SH)));
          const si = (syy * SW + sx) * 4;
          const di = (y * W + x) * 4;
          d[di] = src[si] * exposure;
          d[di + 1] = src[si + 1] * exposure;
          d[di + 2] = src[si + 2] * exposure;
          d[di + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }
  };
  const render = () => {
    draw();
    raf = requestAnimationFrame(render);
  };
  render();

  return {
    el: canvas,
    width: () => W,
    height: () => H,
    grab: () => {
      draw(); // 最新の向きで描いてから保存（実機の video と同じく「今のフレーム」を撮る）
      return canvasToBlob(canvas, 'image/jpeg', 0.9);
    },
    stop: () => cancelAnimationFrame(raf),
  };
}
