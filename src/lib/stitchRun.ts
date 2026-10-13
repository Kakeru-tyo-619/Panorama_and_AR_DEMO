import { focalFromHfov } from './angles';
import { canvasToBlob, ctx2d, decodeBlob, makeCanvas } from './canvasUtil';
import { alignToCoverage, PANO_WIDTH, stitchImages, type Img } from './stitchCore';

export type StitchInput = { shots: { blob: Blob; heading: number; pitch: number; roll: number }[]; hfov: number };

export type StitchResult = {
  /** 合成したパノラマ（人物のぼかし前。仕上げで JPEG に書き直すため高画質で出す） */
  panoramaBlob: Blob;
  /** 画像の列に対する 1°ごとの撮影済みフラグ */
  coverageMask: string;
  /** パノラマ左端の方位 */
  headingStart: number;
  width: number;
  height: number;
  ms: number;
};

export async function runStitch(input: StitchInput, onProgress: (msg: string) => void): Promise<StitchResult> {
  const t0 = performance.now();
  const imgs: Img[] = [];
  for (let i = 0; i < input.shots.length; i++) {
    onProgress(`写真の読み込み ${i + 1}/${input.shots.length}`);
    const bmp = await decodeBlob(input.shots[i].blob);
    const W = bmp.width, H = bmp.height;
    // パノラマ上での1枚の幅（画素）より大きい写真は縮小してメモリを節約する
    const f = focalFromHfov(W, input.hfov);
    const panoPx = 2 * Math.atan(W / 2 / f) * (PANO_WIDTH / (2 * Math.PI));
    const k = Math.min(1, (panoPx * 1.1) / W);
    const w = Math.round(W * k), h = Math.round(H * k);
    const c = makeCanvas(w, h);
    const ctx = ctx2d(c);
    ctx.drawImage(bmp, 0, 0, w, h);
    if ('close' in bmp) bmp.close();
    imgs.push({ data: ctx.getImageData(0, 0, w, h).data, width: w, height: h });
  }
  onProgress('円筒への投影と配置');
  const out = alignToCoverage(
    stitchImages(
      imgs,
      input.shots.map((s) => ({ heading: s.heading, pitch: s.pitch, roll: s.roll })),
      input.hfov,
      onProgress,
    ),
  );
  imgs.length = 0;

  onProgress('画像の書き出し');
  const full = makeCanvas(out.width, out.height);
  ctx2d(full).putImageData(new ImageData(out.rgba as Uint8ClampedArray<ArrayBuffer>, out.width, out.height), 0, 0);
  const panoramaBlob = await canvasToBlob(full, 'image/jpeg', 0.95);

  return {
    panoramaBlob,
    coverageMask: out.coverageMask,
    headingStart: out.headingStart,
    width: out.width,
    height: out.height,
    ms: Math.round(performance.now() - t0),
  };
}
