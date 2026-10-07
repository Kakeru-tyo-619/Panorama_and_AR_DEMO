import { useEffect, useRef, useState } from 'react';
import { getLog, getPanorama, getRawShots, putLog, putPanorama, putRawShots } from '../lib/db';
import { estimateDepth } from '../lib/depthClient';
import { stitch } from '../lib/stitchClient';
import { metrics, settings } from '../lib/store';
import { type CaptureResult, type Panorama, type Shot, uuid } from '../lib/types';

export type GenerateJob = { kind: 'new'; capture: CaptureResult } | { kind: 'regen'; id: string };

type StageState = { label: string; detail?: string; state: 'wait' | 'run' | 'done' | 'error'; ms?: number };

export function Generate({ job, onDone, onCancel }: { job: GenerateJob; onDone: (id: string) => void; onCancel: () => void }) {
  const [stages, setStages] = useState<StageState[]>([
    { label: 'パノラマ合成中', state: 'wait' },
    { label: '奥行き推定中', state: 'wait' },
    { label: '保存', state: 'wait' },
  ]);
  const [modelPct, setModelPct] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(false);

  const update = (i: number, patch: Partial<StageState>) =>
    setStages((s) => s.map((st, k) => (k === i ? { ...st, ...patch } : st)));

  useEffect(() => {
    const t0 = performance.now();
    const id = setInterval(() => setElapsed(performance.now() - t0), 200);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const hfov = settings.get().hfov;
      let id: string;
      let shots: Shot[];
      let base: Omit<Panorama, 'panoramaBlob' | 'depthMapBlob' | 'thumbnailBlob' | 'coverage_mask'>;
      let logBase: { device_info: string; shot_count: number; duration_ms: number; retry_count: number };
      if (job.kind === 'new') {
        const c = job.capture;
        id = uuid();
        shots = c.shots;
        const d = new Date(c.captured_at);
        base = {
          id,
          latitude: c.latitude,
          longitude: c.longitude,
          captured_at: c.captured_at,
          captured_month: d.getMonth() + 1,
          heading_start: 0,
          coverage_deg: c.shot_count * 30,
          heading_correction: null,
          created_at: new Date().toISOString(),
        };
        logBase = { device_info: c.device_info, shot_count: c.shot_count, duration_ms: c.duration_ms, retry_count: c.retry_count };
      } else {
        id = job.id;
        const [p, log, raw] = await Promise.all([getPanorama(id), getLog(id), getRawShots(id)]);
        if (!p || !log || !raw) throw new Error('再生成に必要な元写真が見つかりません');
        shots = raw.shots;
        const { panoramaBlob: _a, depthMapBlob: _b, thumbnailBlob: _c, coverage_mask: _d, ...rest } = p;
        base = rest;
        logBase = log;
      }

      // 1) パノラマ合成
      update(0, { state: 'run', detail: `横画角 ${hfov}°` });
      const t1 = performance.now();
      const st = await stitch({ shots: shots.map(({ blob, heading, pitch, roll }) => ({ blob, heading, pitch, roll })), hfov }, (msg) =>
        update(0, { detail: msg }),
      );
      const stitchMs = Math.round(performance.now() - t1);
      metrics.set({ stitchMs });
      update(0, { state: 'done', ms: stitchMs, detail: `${st.width}×${st.height}px（${st.where === 'worker' ? 'Worker' : 'メインスレッド'}）` });

      // 2) 奥行き推定（失敗しても奥行きなしで保存する）
      update(1, { state: 'run', detail: 'モデル読み込み中' });
      const t2 = performance.now();
      let depthBlob: Blob | null = null;
      let depthMs = 0;
      try {
        const res = await estimateDepth(st.depthInput, st.coverageMask, (e) => {
          if (e.type === 'model') {
            setModelPct(e.progress);
            update(1, { detail: `モデル読み込み中 ${Math.round(e.progress)}%（初回は数十MBをダウンロード）` });
          } else if (e.type === 'ready') {
            setModelPct(null);
            update(1, { detail: `モデル準備完了：${e.backend}` });
          } else if (e.type === 'tile') {
            update(1, { detail: `${e.index + 1}/${e.total} 枚目のタイル` });
          }
        });
        depthBlob = res.blob;
        depthMs = Math.round(performance.now() - t2);
        metrics.set({ depthMs });
        update(1, { state: 'done', ms: depthMs, detail: res.backend });
      } catch (e) {
        depthMs = Math.round(performance.now() - t2);
        update(1, { state: 'error', ms: depthMs, detail: `失敗（奥行きなしで保存します）: ${(e as Error).message}` });
      }

      // 3) 保存
      update(2, { state: 'run' });
      await putPanorama({
        ...base,
        panoramaBlob: st.panoramaBlob,
        depthMapBlob: depthBlob,
        thumbnailBlob: st.thumbnailBlob,
        coverage_mask: st.coverageMask,
      });
      await putLog({ panorama_id: id, ...logBase, stitch_ms: stitchMs, depth_ms: depthMs, hfov_deg: hfov });
      if (job.kind === 'new') await putRawShots({ panorama_id: id, shots });
      update(2, { state: 'done' });
      setTimeout(() => onDone(id), 600);
    })().catch((e) => {
      console.error(e);
      setError(String((e as Error).message ?? e));
      setStages((s) => s.map((st) => (st.state === 'run' ? { ...st, state: 'error' } : st)));
    });
  }, [job, onDone]);

  return (
    <div className="screen generate">
      <h2>{job.kind === 'regen' ? '再生成' : 'パノラマ生成'}</h2>
      <ul className="stages">
        {stages.map((s, i) => (
          <li key={i} className={s.state}>
            <span className="icon">{s.state === 'done' ? '✓' : s.state === 'run' ? <span className="spinner" /> : s.state === 'error' ? '!' : '・'}</span>
            <div>
              <div className="label">
                {s.label}
                {s.ms != null && <span className="ms"> {s.ms.toLocaleString()} ms</span>}
              </div>
              {s.detail && <div className="detail">{s.detail}</div>}
              {i === 1 && modelPct != null && (
                <div className="progress">
                  <div style={{ width: `${modelPct}%` }} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="elapsed">経過 {(elapsed / 1000).toFixed(1)} 秒</p>
      {error && (
        <>
          <p className="warn">エラー: {error}</p>
          <button className="ghost" onClick={onCancel}>ホームへ戻る</button>
        </>
      )}
    </div>
  );
}
