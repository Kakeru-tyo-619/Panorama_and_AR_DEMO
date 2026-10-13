import { runStitch, type StitchInput } from '../lib/stitchRun';

self.onmessage = async (e: MessageEvent<StitchInput>) => {
  try {
    const res = await runStitch(e.data, (msg) => self.postMessage({ type: 'progress', msg }));
    self.postMessage({ type: 'done', res });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};
