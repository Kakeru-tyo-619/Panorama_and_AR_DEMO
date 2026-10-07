import { runStitch, type StitchInput } from '../lib/stitchRun';

self.onmessage = async (e: MessageEvent<StitchInput>) => {
  try {
    const res = await runStitch(e.data, (msg) => self.postMessage({ type: 'progress', msg }));
    (self as unknown as Worker).postMessage({ type: 'done', res }, [res.depthInput.data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
