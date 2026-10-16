/**
 * 人物の切り抜き（MediaPipe Tasks Vision の ImageSegmenter、VIDEO モード）。
 * モデルはパラメーターで切り替える：
 *  - selfie：selfie_segmenter（軽い。自撮りの距離向け）
 *  - deeplab：deeplab_v3（21 クラスの汎用分割。person = 15。離れた人向け）
 */
import { ImageSegmenter } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

const BASE = 'https://storage.googleapis.com/mediapipe-models/image_segmenter';
const MODELS = {
  selfie: `${BASE}/selfie_segmenter/float16/latest/selfie_segmenter.tflite`,
  deeplab: `${BASE}/deeplab_v3/float32/1/deeplab_v3.tflite`,
} as const;
const DEEPLAB_PERSON = 15;

export type MaskFrame = { width: number; height: number; maskCount: number };

export class PersonSegmenter {
  private constructor(
    private seg: ImageSegmenter,
    readonly model: keyof typeof MODELS,
    readonly delegate: 'GPU' | 'CPU',
    private invert: boolean,
  ) {}

  /** GPU で作れなければ CPU に落とす（実際に使った方は delegate に入る） */
  static async create(model: keyof typeof MODELS, delegate: 'gpu' | 'cpu', invert: boolean) {
    const make = (d: 'GPU' | 'CPU') =>
      ImageSegmenter.createFromOptions(
        { wasmLoaderPath, wasmBinaryPath },
        {
          baseOptions: { modelAssetPath: MODELS[model], delegate: d },
          runningMode: 'VIDEO',
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        },
      );
    if (delegate === 'cpu') return new PersonSegmenter(await make('CPU'), model, 'CPU', invert);
    try {
      return new PersonSegmenter(await make('GPU'), model, 'GPU', invert);
    } catch (e) {
      console.warn('GPU delegate failed; falling back to CPU', e);
      return new PersonSegmenter(await make('CPU'), model, 'CPU', invert);
    }
  }

  /**
   * 1 コマを切り抜く。人物の確率（0〜1）を、前回の値と混ぜながら out（上下反転済みの 0〜255）に書き込む。
   * 画像の大きさが変わったときは prev / out を作り直して返す。
   */
  segment(
    frame: HTMLCanvasElement,
    timestampMs: number,
    mix: number,
    state: { prev: Float32Array | null; out: Uint8Array | null },
  ): MaskFrame | null {
    let result: MaskFrame | null = null;
    this.seg.segmentForVideo(frame, timestampMs, (r) => {
      const masks = r.confidenceMasks;
      if (!masks || !masks.length) return;
      // selfie は 1 枚（人物の確率）または 2 枚（背景, 人物）で返る機種があるため、枚数で判断する
      const idx = this.model === 'deeplab' ? Math.min(DEEPLAB_PERSON, masks.length - 1) : masks.length === 1 ? 0 : 1;
      const m = masks[idx];
      const w = m.width, h = m.height;
      const src = m.getAsFloat32Array();
      if (!state.prev || state.prev.length !== w * h) {
        state.prev = new Float32Array(w * h);
        state.out = new Uint8Array(w * h);
      }
      const prev = state.prev, out = state.out!;
      for (let y = 0; y < h; y++) {
        const dy = (h - 1 - y) * w; // WebGL のテクスチャは下の行が先頭
        for (let x = 0; x < w; x++) {
          let v = src[y * w + x];
          if (this.invert) v = 1 - v;
          const f = prev[dy + x] * mix + v * (1 - mix);
          prev[dy + x] = f;
          out[dy + x] = f < 0 ? 0 : f > 1 ? 255 : (f * 255) | 0;
        }
      }
      result = { width: w, height: h, maskCount: masks.length };
    });
    return result;
  }

  close() {
    this.seg.close();
  }
}
