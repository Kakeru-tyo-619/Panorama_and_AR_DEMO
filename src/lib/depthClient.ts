import { metrics } from './store';

export type DepthEvent =
  | { type: 'model'; progress: number; loaded: number; total: number }
  | { type: 'ready'; backend: string }
  | { type: 'tile'; index: number; total: number }
  | { type: 'log'; message: string };

let worker: Worker | null = null;
let seq = 0;

function getWorker() {
  if (!worker) worker = new Worker(new URL('../workers/depth.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

export function estimateDepth(
  input: { data: Uint8ClampedArray; width: number; height: number },
  coverageMask: string,
  onEvent: (e: DepthEvent) => void,
): Promise<{ blob: Blob; backend: string }> {
  const id = ++seq;
  const w = getWorker();
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
      worker?.terminate();
      worker = null;
      metrics.set({ modelStatus: `Worker エラー` });
      reject(new Error(e.message || 'depth worker error'));
    };
    const cleanup = () => {
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
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
