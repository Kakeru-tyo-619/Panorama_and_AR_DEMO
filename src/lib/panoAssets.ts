import { decodeBlob, releaseCanvas } from './canvasUtil';
import { getImageBlob } from './db';
import type { PanoramaRecord } from './types';

export type DepthData = { data: Uint8Array; width: number; height: number };

export type PanoAssets = {
  width: number;
  height: number;
  /**
   * パノラマ画像（JPEG のまま）。表示に使う Canvas は 3D 表示を作るときに preparePanoCanvas で用途の分だけ作り、
   * GPU に送ったら捨てる（大きな Canvas を常に2枚持たないようにするため）
   */
  panorama: Blob;
  coverageMask: string;
  depth: DepthData | null;
  skyColor: [number, number, number];
  groundColor: [number, number, number];
};

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

/** 画像の読み込みに失敗したとき、どの画像か・大きさ・形式をエラー文に入れる（原因の切り分け用） */
async function decodeLabeled(blob: Blob, label: string) {
  try {
    return await decodeBlob(blob);
  } catch (e) {
    throw new Error(`${label}を読み込めません（${blob.size.toLocaleString()} バイト, ${blob.type || '形式不明'}）: ${(e as Error)?.message ?? e}`);
  }
}

export async function loadPanoAssets(p: PanoSource): Promise<PanoAssets> {
  const img = await decodeLabeled(p.panorama, 'パノラマ画像');
  const W = img.width, H = img.height;
  // 上下の空・地面の色（グラデーション用）は縮小した画像から求める
  const sw = Math.min(512, W), sh = Math.max(1, Math.round((H * sw) / W));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(img, 0, 0, sw, sh);
  if ('close' in img) img.close();
  const skyColor = avgColor(sctx, Math.round(sh * 0.02), Math.max(1, Math.round(sh * 0.04)), sw);
  const groundColor = avgColor(sctx, Math.round(sh * 0.94), Math.max(1, Math.round(sh * 0.04)), sw);
  releaseCanvas(small);

  let depth: DepthData | null = null;
  // 奥行きマップだけが読めない場合は、エラーで止めずに平面で表示する
  const dimg = p.depthMap ? await decodeLabeled(p.depthMap, '奥行きマップ').catch((e) => (console.warn(e), null)) : null;
  if (dimg) {
    const c = document.createElement('canvas');
    c.width = dimg.width;
    c.height = dimg.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(dimg, 0, 0);
    if ('close' in dimg) dimg.close();
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const g = new Uint8Array(c.width * c.height);
    for (let i = 0; i < g.length; i++) g[i] = d[i * 4];
    depth = { data: g, width: c.width, height: c.height };
    releaseCanvas(c);
  }

  return { width: W, height: H, panorama: p.panorama, coverageMask: p.coverageMask, depth, skyColor, groundColor };
}

/**
 * 表示に使う画像を用途の分だけ作る。
 * - view（360度ビュー）：未撮影の範囲に斜線と「未撮影」を描く
 * - ar（AR）：未撮影の範囲を透明にする
 * 呼び出し側は GPU に送ったら releaseCanvas で捨てる。
 */
export async function preparePanoCanvas(a: PanoAssets, purpose: 'view' | 'ar'): Promise<HTMLCanvasElement> {
  const img = await decodeLabeled(a.panorama, 'パノラマ画像');
  const W = img.width, H = img.height;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  if ('close' in img) img.close();
  const runs = uncoveredRuns(a.coverageMask);
  if (purpose === 'ar') {
    for (const [s, e] of runs) ctx.clearRect((s / 360) * W, 0, ((e - s) / 360) * W, H);
    return canvas;
  }
  for (const [s, e] of runs) {
    const x0 = (s / 360) * W, x1 = (e / 360) * W;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, H);
    ctx.clip();
    ctx.fillStyle = '#3a3f4b';
    ctx.fillRect(x0, 0, x1 - x0, H);
    ctx.strokeStyle = '#555c6b';
    ctx.lineWidth = 14;
    for (let x = x0 - H; x < x1; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, H);
      ctx.lineTo(x + H, 0);
      ctx.stroke();
    }
    ctx.fillStyle = '#e8ecf3';
    ctx.font = `bold ${Math.round(H * 0.06)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const step = Math.max(1, Math.round((x1 - x0) / 500));
    for (let k = 0; k < step; k++) ctx.fillText('未撮影', x0 + ((k + 0.5) * (x1 - x0)) / step, H / 2);
    ctx.restore();
  }
  return canvas;
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
