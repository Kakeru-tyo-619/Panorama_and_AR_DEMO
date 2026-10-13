/** Worker では OffscreenCanvas、メインスレッドでは（無ければ）通常の Canvas を使う */
export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
export type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(c: AnyCanvas): Ctx2D {
  const ctx = c.getContext('2d', { willReadFrequently: true }) as Ctx2D | null;
  if (!ctx) throw new Error('Canvas 2D を作成できません');
  return ctx;
}

/**
 * Canvas のメモリをすぐに解放する。iOS Safari は Canvas のメモリを GC まで解放せず、
 * 合計の上限を超えるとタブごと再読み込みされるため、使い終わった大きな Canvas は 0×0 にしておく。
 */
export function releaseCanvas(c: AnyCanvas | null | undefined) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

export function canvasToBlob(c: AnyCanvas, type: string, quality?: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    (c as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality),
  );
}

export function canUseOffscreen2D(): boolean {
  try {
    return typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d');
  } catch {
    return false;
  }
}

export async function decodeBlob(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
