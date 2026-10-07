/**
 * 奥行き推定 Worker（transformers.js / depth-anything-v2-small）
 * WebGPU が使えれば WebGPU、使えなければシングルスレッドの WASM。
 * GitHub Pages では COOP/COEP ヘッダーを付けられず SharedArrayBuffer が使えないため numThreads=1 にする。
 */
import { env, pipeline, RawImage } from '@huggingface/transformers';

env.allowLocalModels = false; // モデルは実行時に Hugging Face から取得（Cache API に保存され2回目以降は再利用）
env.useBrowserCache = true;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}

const MODEL = 'onnx-community/depth-anything-v2-small';

export type DepthRequest = {
  id: number;
  input: { data: Uint8ClampedArray; width: number; height: number };
  coverageMask: string;
  tiles: number;
  overlap: number; // 各タイルの両端の重なり（コア幅に対する比率）
  outWidth: number;
};

type Pipe = (img: RawImage) => Promise<{ predicted_depth: { dims: number[]; data: Float32Array } }>;

let pipeState: Promise<{ pipe: Pipe; backend: string }> | null = null;

function post(msg: unknown, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(msg, transfer);
}

async function loadPipe(forceFp32 = false): Promise<{ pipe: Pipe; backend: string }> {
  const progress_callback = (p: { status: string; progress?: number; loaded?: number; total?: number }) => {
    if (p.status === 'progress_total')
      post({ type: 'model', progress: p.progress ?? 0, loaded: p.loaded ?? 0, total: p.total ?? 0 });
  };
  const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } };
  let adapter = null;
  try {
    adapter = (await nav.gpu?.requestAdapter()) ?? null;
  } catch {
    adapter = null;
  }
  if (adapter) {
    const dtype = !forceFp32 && adapter.features.has('shader-f16') ? 'fp16' : 'fp32';
    try {
      const pipe = await pipeline('depth-estimation', MODEL, { device: 'webgpu', dtype, progress_callback });
      return { pipe: pipe as unknown as Pipe, backend: `webgpu (${dtype})` };
    } catch (e) {
      post({ type: 'log', message: `WebGPU での読み込みに失敗。WASM に切り替えます: ${e}` });
    }
  }
  const pipe = await pipeline('depth-estimation', MODEL, { device: 'wasm', dtype: 'q8', progress_callback });
  return { pipe: pipe as unknown as Pipe, backend: 'wasm (q8, 1 thread)' };
}

function percentile(sorted: Float32Array, q: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

async function run(req: DepthRequest) {
  if (!pipeState) pipeState = loadPipe();
  let { pipe, backend } = await pipeState;
  post({ type: 'ready', backend });

  const { data, width: IW, height: IH } = req.input;
  const valid = (x: number) => req.coverageMask[Math.floor((((x % IW) + IW) % IW) / IW * 360)] === '1';
  const N = req.tiles;
  const core = IW / N;
  const margin = core * req.overlap;
  const tileW = Math.round(core + 2 * margin);
  const OW = req.outWidth;
  const OH = Math.round((IH * OW) / IW);
  const acc = new Float32Array(OW * OH);
  const wsum = new Float32Array(OW * OH);

  for (let k = 0; k < N; k++) {
    post({ type: 'tile', index: k, total: N });
    const start = Math.round(k * core - margin);
    let anyValid = false;
    for (let t = 0; t < tileW; t += 4) if (valid(start + t)) { anyValid = true; break; }
    if (!anyValid) continue;

    // タイルを切り出す（0°/360°をまたぐ場合は折り返す）
    const rgb = new Uint8ClampedArray(tileW * IH * 3);
    for (let y = 0; y < IH; y++) {
      for (let t = 0; t < tileW; t++) {
        const sx = (((start + t) % IW) + IW) % IW;
        const si = (y * IW + sx) * 4, di = (y * tileW + t) * 3;
        rgb[di] = data[si];
        rgb[di + 1] = data[si + 1];
        rgb[di + 2] = data[si + 2];
      }
    }
    let out = await pipe(new RawImage(rgb, tileW, IH, 3));
    let pd = out.predicted_depth;
    if (backend.includes('fp16') && !Array.from(pd.data.subarray(0, 2000)).every(Number.isFinite)) {
      // fp16 で数値が壊れる端末向けに fp32 で読み直す
      pipeState = loadPipe(true);
      ({ pipe, backend } = await pipeState);
      post({ type: 'ready', backend });
      out = await pipe(new RawImage(rgb, tileW, IH, 3));
      pd = out.predicted_depth;
    }
    const [dh, dw] = pd.dims.slice(-2);
    const dd = pd.data;

    // タイルごとに尺度が違うため、2%・98% 分位点で 0〜1 に正規化する（未撮影の列は除外）
    const samples: number[] = [];
    for (let y = 0; y < dh; y += 3)
      for (let x = 0; x < dw; x += 3) if (valid(start + (x * tileW) / dw)) samples.push(dd[y * dw + x]);
    if (samples.length < 10) continue;
    const sorted = Float32Array.from(samples).sort();
    const lo = percentile(sorted, 0.02);
    const hi = percentile(sorted, 0.98);
    const range = Math.max(1e-6, hi - lo);

    // 出力へ線形の重みで混ぜる（重なり幅 2×margin で 1→0）
    const ox0 = Math.ceil(((start + 0.5) * OW) / IW - 0.5);
    const ox1 = Math.floor(((start + tileW - 0.5) * OW) / IW - 0.5);
    for (let ox = ox0; ox <= ox1; ox++) {
      const ix = ((ox + 0.5) * IW) / OW - 0.5;
      const t = ix - start;
      const w = Math.min(1, Math.max(0, Math.min(t + 0.5, tileW - t - 0.5) / (2 * margin)));
      if (w <= 0) continue;
      const tx = Math.min(dw - 1, Math.max(0, ((t + 0.5) * dw) / tileW - 0.5));
      const x0 = tx | 0, x1 = Math.min(dw - 1, x0 + 1), ax = tx - x0;
      const oxw = ((ox % OW) + OW) % OW;
      for (let oy = 0; oy < OH; oy++) {
        const ty = Math.min(dh - 1, Math.max(0, ((oy + 0.5) * dh) / OH - 0.5));
        const y0 = ty | 0, y1 = Math.min(dh - 1, y0 + 1), ay = ty - y0;
        const v =
          dd[y0 * dw + x0] * (1 - ax) * (1 - ay) +
          dd[y0 * dw + x1] * ax * (1 - ay) +
          dd[y1 * dw + x0] * (1 - ax) * ay +
          dd[y1 * dw + x1] * ax * ay;
        const n = Math.min(1, Math.max(0, (v - lo) / range));
        acc[oy * OW + oxw] += n * w;
        wsum[oy * OW + oxw] += w;
      }
    }
  }

  // 白黒画像（近いほど白）。未撮影の列は 0（遠い扱い）
  const rgba = new Uint8ClampedArray(OW * OH * 4);
  for (let y = 0; y < OH; y++) {
    for (let x = 0; x < OW; x++) {
      const i = y * OW + x;
      const ok = wsum[i] > 0 && valid(((x + 0.5) * IW) / OW);
      const v = ok ? Math.round((acc[i] / wsum[i]) * 255) : 0;
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(OW, OH);
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, OW, OH), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  post({ type: 'done', id: req.id, blob, backend });
}

self.onmessage = async (e: MessageEvent<DepthRequest>) => {
  try {
    await run(e.data);
  } catch (err) {
    pipeState = null;
    post({ type: 'error', id: e.data.id, message: String((err as Error)?.message ?? err) });
  }
};
