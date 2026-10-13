import { decodeBlob } from './canvasUtil';
import { getImageBlob } from './db';
import type { PanoramaRecord } from './types';

export type DepthData = { data: Uint8Array; width: number; height: number };

export type PanoAssets = {
  width: number;
  height: number;
  /** 360度ビュー用：未撮影の範囲に斜線と「未撮影」を描いたもの */
  viewCanvas: HTMLCanvasElement;
  /** AR 用：未撮影の範囲を透明にしたもの */
  arCanvas: HTMLCanvasElement;
  depth: DepthData | null;
  skyColor: [number, number, number];
  groundColor: [number, number, number];
};

/** coverage_mask から未撮影の範囲（度）を取り出す */
export function uncoveredRuns(mask: string): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let d = 0; d <= 360; d++) {
    const off = d < 360 && mask[d] !== '1';
    if (off && start < 0) start = d;
    if (!off && start >= 0) {
      runs.push([start, d]);
      start = -1;
    }
  }
  return runs;
}

function avgColor(ctx: CanvasRenderingContext2D, y: number, h: number, w: number): [number, number, number] {
  const d = ctx.getImageData(0, y, w, h).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) {
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    n++;
  }
  return [r / n / 255, g / n / 255, b / n / 255];
}

export type PanoSource = { panorama: Blob; depthMap: Blob | null; coverageMask: string };

/** 保存済みの投稿から読み込む。AR は高解像度、360度ビューは低解像度を使う（本番の Cloudinary の配信に合わせる） */
export async function loadStoredAssets(imageUrl: string, pano: PanoramaRecord, variant: 'full' | 'low'): Promise<PanoAssets> {
  const [panorama, depthMap] = await Promise.all([
    getImageBlob(imageUrl, variant),
    pano.depth_map_url ? getImageBlob(pano.depth_map_url) : Promise.resolve(null),
  ]);
  if (!panorama) throw new Error('パノラマ画像が見つかりません');
  return loadPanoAssets({ panorama, depthMap, coverageMask: pano.coverage_mask });
}

export async function loadPanoAssets(p: PanoSource): Promise<PanoAssets> {
  const img = await decodeBlob(p.panorama);
  const W = img.width, H = img.height;
  const runs = uncoveredRuns(p.coverageMask);

  const viewCanvas = document.createElement('canvas');
  viewCanvas.width = W;
  viewCanvas.height = H;
  const vctx = viewCanvas.getContext('2d', { willReadFrequently: true })!;
  vctx.drawImage(img, 0, 0);
  // 上下の空・地面の色（グラデーション用）。未撮影部分を描く前に取る
  const skyColor = avgColor(vctx, Math.round(H * 0.02), Math.max(1, Math.round(H * 0.04)), W);
  const groundColor = avgColor(vctx, Math.round(H * 0.94), Math.max(1, Math.round(H * 0.04)), W);

  for (const [a, b] of runs) {
    const x0 = (a / 360) * W, x1 = (b / 360) * W;
    vctx.save();
    vctx.beginPath();
    vctx.rect(x0, 0, x1 - x0, H);
    vctx.clip();
    vctx.fillStyle = '#3a3f4b';
    vctx.fillRect(x0, 0, x1 - x0, H);
    vctx.strokeStyle = '#555c6b';
    vctx.lineWidth = 14;
    for (let x = x0 - H; x < x1; x += 48) {
      vctx.beginPath();
      vctx.moveTo(x, H);
      vctx.lineTo(x + H, 0);
      vctx.stroke();
    }
    vctx.fillStyle = '#e8ecf3';
    vctx.font = `bold ${Math.round(H * 0.06)}px sans-serif`;
    vctx.textAlign = 'center';
    vctx.textBaseline = 'middle';
    const step = Math.max(1, Math.round((x1 - x0) / 500));
    for (let k = 0; k < step; k++) vctx.fillText('未撮影', x0 + ((k + 0.5) * (x1 - x0)) / step, H / 2);
    vctx.restore();
  }

  const arCanvas = document.createElement('canvas');
  arCanvas.width = W;
  arCanvas.height = H;
  const actx = arCanvas.getContext('2d')!;
  actx.drawImage(img, 0, 0);
  for (const [a, b] of runs) actx.clearRect((a / 360) * W, 0, ((b - a) / 360) * W, H);
  if ('close' in img) img.close();

  let depth: DepthData | null = null;
  if (p.depthMap) {
    const dimg = await decodeBlob(p.depthMap);
    const c = document.createElement('canvas');
    c.width = dimg.width;
    c.height = dimg.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(dimg, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const g = new Uint8Array(c.width * c.height);
    for (let i = 0; i < g.length; i++) g[i] = d[i * 4];
    depth = { data: g, width: c.width, height: c.height };
  }

  return { width: W, height: H, viewCanvas, arCanvas, depth, skyColor, groundColor };
}

/** 奥行きを (cols×rows) の格子に縮小し、軽くぼかす（メッシュの尖りを防ぐ） */
export function depthGrid(depth: DepthData, cols: number, rows: number): Float32Array {
  const out = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // 周辺の平均（面積平均）
      const x0 = Math.floor((c / cols) * depth.width), x1 = Math.max(x0 + 1, Math.floor(((c + 1) / cols) * depth.width));
      const y0 = Math.floor((r / rows) * depth.height), y1 = Math.max(y0 + 1, Math.floor(((r + 1) / rows) * depth.height));
      let s = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += depth.data[y * depth.width + (x % depth.width)]; n++; }
      out[r * cols + c] = s / n / 255;
    }
  }
  // 3×3 の平均で軽くぼかす（横方向は 0°/360° で折り返す）
  const blurred = new Float32Array(out.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const rr = r + dy;
        if (rr < 0 || rr >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) { s += out[rr * cols + ((c + dx + cols) % cols)]; n++; }
      }
      blurred[r * cols + c] = s / n;
    }
  }
  return blurred;
}
