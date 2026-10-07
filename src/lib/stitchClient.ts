import { canUseOffscreen2D } from './canvasUtil';
import { runStitch, type StitchInput, type StitchResult } from './stitchRun';

function viaWorker(input: StitchInput, onProgress: (msg: string) => void): Promise<StitchResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../workers/stitch.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.msg);
      else if (m.type === 'done') {
        w.terminate();
        resolve(m.res);
      } else if (m.type === 'error') {
        w.terminate();
        reject(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'worker error'));
    };
    w.postMessage(input);
  });
}

/** Web Worker（OffscreenCanvas）で合成する。使えない端末ではメインスレッドで行う */
export async function stitch(
  input: StitchInput,
  onProgress: (msg: string) => void,
): Promise<StitchResult & { where: 'worker' | 'main' }> {
  if (canUseOffscreen2D()) {
    try {
      return { ...(await viaWorker(input, onProgress)), where: 'worker' };
    } catch (e) {
      console.warn('stitch worker failed, falling back to main thread', e);
    }
  }
  return { ...(await runStitch(input, onProgress)), where: 'main' };
}
