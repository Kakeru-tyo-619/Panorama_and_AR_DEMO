import { metrics } from './store';

export type DepthEvent =
  | { type: 'model'; progress: number; loaded: number; total: number }
  | { type: 'ready'; backend: string }
  | { type: 'tile'; index: number; total: number }
  | { type: 'log'; message: string };

let seq = 0;

export function estimateDepth(
  input: { data: Uint8ClampedArray; width: number; height: number },
  coverageMask: string,
  onEvent: (e: DepthEvent) => void,
): Promise<{ blob: Blob; backend: string }> {
  const id = ++seq;
  // 1回ごとに Worker を作り、終わったら終了する。モデル（ONNX Runtime・WebGPU）のメモリを確実に解放して、
  // 直後に開く 3D 表示（WebGL）とメモリを取り合わないようにする（iOS Safari はメモリ不足でタブごと再読み込みされる）。
  // 2回目以降のモデルはブラウザのキャッシュから読むので、作り直しても数秒で済む。
  const w = new Worker(new URL('../workers/depth.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'model') {
        metrics.set({ modelStatus: `読み込み中 ${Math.round(m.progress)}%` });
        onEvent(m);
      } else if (m.type === 'ready') {
        metrics.set({ modelStatus: `準備完了`, depthBackend: m.backend });
        onEvent(m);
      } else if (m.type === 'tile' || m.type === 'log') {
        if (m.type === 'log') console.warn(m.message);
        onEvent(m);
      } else if (m.id === id && m.type === 'done') {
        cleanup();
        resolve({ blob: m.blob, backend: m.backend });
      } else if (m.id === id && m.type === 'error') {
        cleanup();
        metrics.set({ modelStatus: `エラー: ${m.message}` });
        reject(new Error(m.message));
      }
    };
    const onErr = (e: ErrorEvent) => {
      console.error('depth worker error', e.message, e.filename, e.lineno, e.error);
      cleanup();
      metrics.set({ modelStatus: `Worker エラー` });
      reject(new Error(e.message || 'depth worker error'));
    };
    const cleanup = () => {
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      w.terminate();
      metrics.set({ modelStatus: '解放済み（次回はキャッシュから読み込み）' });
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ id, input, coverageMask, tiles: 8, overlap: 0.2, outWidth: 1024 }, [input.data.buffer]);
  });
}

export async function checkWebGPU() {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    metrics.set({ webgpu: adapter ? 'yes' : 'no' });
  } catch {
    metrics.set({ webgpu: 'no' });
  }
}
