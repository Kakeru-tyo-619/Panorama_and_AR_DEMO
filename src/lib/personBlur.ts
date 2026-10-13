/**
 * 人物検出とぼかし。設計書では主サービスの人物検出（MediaPipe Tasks Vision ObjectDetector / EfficientDet Lite0）を
 * 利用するとしているため、同じ構成で検出する（デモでは主サービスがないのでここで呼ぶ）。
 * パノラマは横に長く人が小さく写るため、2つの大きさの正方形タイルに分けて検出し、0°/360°をまたぐ人も拾えるよう折り返す。
 */
import { ObjectDetector } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';
const TILE_INPUT = 640; // 検出器に渡すタイルの最大辺
const BOX_PAD = 0.15; // ぼかす範囲を検出枠より広げる割合

export type Box = { x: number; y: number; w: number; h: number; score: number };

let detectorP: Promise<ObjectDetector> | null = null;

function getDetector() {
  if (!detectorP) {
    detectorP = ObjectDetector.createFromOptions(
      { wasmLoaderPath, wasmBinaryPath },
      {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        scoreThreshold: 0.3,
        categoryAllowlist: ['person'],
        maxResults: 25,
      },
    ).catch((e) => {
      detectorP = null;
      throw e;
    });
  }
  return detectorP;
}

/** 同じ人とみなすか：IoU が大きい、または小さい方の枠の大半がもう一方に含まれる（タイルの大きさ違いで枠の大きさが変わるため） */
function same(a: Box, b: Box) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const areaA = a.w * a.h, areaB = b.w * b.h;
  return inter / (areaA + areaB - inter) > 0.3 || inter / Math.min(areaA, areaB) > 0.6;
}

/** 重なった検出を1つにまとめる（スコアの高い順に残す）。ぼかしは検出したすべての枠にかける */
function nms(boxes: Box[], W: number): Box[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: Box[] = [];
  for (const b of sorted) {
    const dup = kept.some((k) => same(k, b) || same(k, { ...b, x: b.x - W }) || same(k, { ...b, x: b.x + W }));
    if (!dup) kept.push(b);
  }
  return kept;
}

/**
 * パノラマ（canvas）から人物の枠を探す。x は 0〜W（右端をまたぐ枠は W を超える）。
 * all：ぼかす枠（タイルごとの検出をすべて）、persons：同じ人をまとめたもの（人数の表示用）
 */
export async function detectPersons(
  src: HTMLCanvasElement,
  onProgress?: (msg: string) => void,
): Promise<{ all: Box[]; persons: Box[] }> {
  onProgress?.('人物検出モデルの読み込み');
  const detector = await getDetector();
  const W = src.width, H = src.height;
  const tiles: { x: number; y: number; T: number }[] = [];
  for (const T of [H, Math.round(H / 2)]) {
    const step = Math.round(T * 0.75);
    const ys = T >= H ? [0] : [0, Math.round((H - T) / 2), H - T];
    for (let x = 0; x < W; x += step) for (const y of ys) tiles.push({ x, y, T });
  }
  const tile = document.createElement('canvas');
  const tctx = tile.getContext('2d')!;
  const found: Box[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const { x, y, T } = tiles[i];
    const S = Math.min(T, TILE_INPUT);
    const k = T / S;
    tile.width = tile.height = S;
    // 右端をはみ出す分は左端から折り返して描く
    const w1 = Math.min(T, W - x);
    tctx.drawImage(src, x, y, w1, T, 0, 0, w1 / k, S);
    if (w1 < T) tctx.drawImage(src, 0, y, T - w1, T, w1 / k, 0, (T - w1) / k, S);
    const res = detector.detect(tile);
    for (const d of res.detections) {
      const bb = d.boundingBox;
      if (!bb) continue;
      found.push({ x: x + bb.originX * k, y: y + bb.originY * k, w: bb.width * k, h: bb.height * k, score: d.categories[0]?.score ?? 0 });
    }
    onProgress?.(`人物検出 ${i + 1}/${tiles.length}`);
    await new Promise((r) => setTimeout(r)); // 画面が固まらないよう間を空ける
  }
  return { all: found, persons: nms(found, W) };
}

/** 1つの矩形を縮小→拡大してぼかす（Safari は Canvas の filter に未対応のことがあるため使わない） */
function blurRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  if (w < 1 || h < 1) return;
  const f = Math.max(6, Math.min(w, h) / 8);
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(w / f));
  small.height = Math.max(1, Math.round(h / f));
  const sctx = small.getContext('2d')!;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  ctx.restore();
}

/** 検出枠を少し広げてぼかす。0°/360°をまたぐ枠は両端に分けて処理する */
export function blurBoxes(canvas: HTMLCanvasElement, boxes: Box[]) {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  for (const b of boxes) {
    const px = b.w * BOX_PAD, py = b.h * BOX_PAD;
    const y0 = Math.max(0, Math.floor(b.y - py));
    const y1 = Math.min(H, Math.ceil(b.y + b.h + py));
    const x0 = Math.floor(b.x - px), x1 = Math.ceil(b.x + b.w + px);
    for (const shift of [-W, 0, W]) {
      const a = Math.max(0, x0 + shift), c = Math.min(W, x1 + shift);
      if (c > a) blurRect(ctx, a, y0, c - a, y1 - y0);
    }
  }
}
