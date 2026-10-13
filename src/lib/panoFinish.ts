/**
 * 合成したパノラマの仕上げ（メインスレッド）：人物のぼかし → 配信用の画像（高解像度・低解像度・サムネイル）と
 * 奥行き推定の入力を作る。本番では高解像度・低解像度を Cloudinary が配信するため、デモでは両方をここで作って保存する。
 */
import { canvasToBlob, decodeBlob, releaseCanvas } from './canvasUtil';
import { blurBoxes, closeDetector, detectPersons, type Box } from './personBlur';

export const LOW_RES_WIDTH = 2048; // 360度ビュー用（AR は高解像度）
export const THUMB_WIDTH = 512;
export const DEPTH_INPUT_WIDTH = 2048;

export type FinishResult = {
  full: Blob;
  low: Blob;
  thumb: Blob;
  depthInput: { data: Uint8ClampedArray; width: number; height: number };
  persons: Box[];
  /** 人物検出が動かなかったときの理由（ぼかしなしのまま） */
  detectError: string | null;
};

function scaled(src: HTMLCanvasElement, width: number) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round((src.height * width) / src.width);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export async function finishPanorama(stitched: Blob, onProgress: (msg: string) => void): Promise<FinishResult> {
  const img = await decodeBlob(stitched);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0);
  if ('close' in img) img.close();

  let persons: Box[] = [];
  let detectError: string | null = null;
  try {
    const found = await detectPersons(canvas, onProgress);
    persons = found.persons;
    if (found.all.length) {
      onProgress(`${persons.length}人をぼかしています`);
      blurBoxes(canvas, found.all);
    }
  } catch (e) {
    console.error(e);
    detectError = String((e as Error)?.message ?? e);
  } finally {
    // 次の奥行き推定の前に検出器のメモリを解放する
    closeDetector();
  }

  onProgress('配信用の画像を作成');
  const full = await canvasToBlob(canvas, 'image/jpeg', 0.9);
  const lowCanvas = scaled(canvas, LOW_RES_WIDTH);
  const low = await canvasToBlob(lowCanvas, 'image/jpeg', 0.85);
  const thumbCanvas = scaled(lowCanvas, THUMB_WIDTH);
  const thumb = await canvasToBlob(thumbCanvas, 'image/jpeg', 0.8);
  const depthCanvas = DEPTH_INPUT_WIDTH === LOW_RES_WIDTH ? lowCanvas : scaled(canvas, DEPTH_INPUT_WIDTH);
  const depthInput = {
    data: depthCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, depthCanvas.width, depthCanvas.height).data,
    width: depthCanvas.width,
    height: depthCanvas.height,
  };
  // 4096px の Canvas などはここで解放する（Blob と奥行き推定の入力だけを残す）
  for (const c of [canvas, lowCanvas, thumbCanvas, depthCanvas]) releaseCanvas(c);
  return { full, low, thumb, depthInput, persons, detectError };
}
