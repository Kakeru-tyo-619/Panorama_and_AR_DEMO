import { useEffect, useRef, useState } from 'react';
import { clearStage, markStage } from '../lib/crashMarker';
import { getLog, getPost, getRawShots } from '../lib/db';
import { estimateDepth } from '../lib/depthClient';
import { finishPanorama, type FinishResult } from '../lib/panoFinish';
import { stitch } from '../lib/stitchClient';
import { metrics, settings } from '../lib/store';
import type { CaptureLogRecord, CaptureResult, PanoramaPost, Shot } from '../lib/types';
import { uuid } from '../lib/types';

export type GenerateJob = { kind: 'new'; capture: CaptureResult } | { kind: 'regen'; id: string };

/** 生成した結果（まだ保存していない）。仕上がり確認画面で投稿すると保存される */
export type Draft = {
  kind: 'new' | 'regen';
  shotId: string;
  shots: Shot[];
  capture: Pick<CaptureResult, 'shot_count' | 'duration_ms' | 'retry_count' | 'device_info' | 'latitude' | 'longitude' | 'captured_at'>;
  /** 再生成のときの元の投稿 */
  existing: { post: PanoramaPost; log: CaptureLogRecord | undefined } | null;
  headingStart: number;
  coverageMask: string;
  coverageDeg: number;
  width: number;
  height: number;
  images: Pick<FinishResult, 'full' | 'low' | 'thumb' | 'persons' | 'detectError'>;
  depthBlob: Blob | null;
  depthError: string | null;
  stitchMs: number;
  depthMs: number;
  hfov: number;
};

type StageState = { label: string; detail?: string; state: 'wait' | 'run' | 'done' | 'error'; ms?: number };

export function Generate({ job, onDone, onCancel }: { job: GenerateJob; onDone: (d: Draft) => void; onCancel: () => void }) {
  const [stages, setStages] = useState<StageState[]>([
    { label: 'パノラマ合成中', state: 'wait' },
    { label: '人物検出・ぼかし', state: 'wait' },
    { label: '奥行き推定中', state: 'wait' },
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
      let shotId: string;
      let shots: Shot[];
      let capture: Draft['capture'];
      let existing: Draft['existing'] = null;
      if (job.kind === 'new') {
        shotId = uuid();
        shots = job.capture.shots;
        capture = job.capture;
      } else {
        shotId = job.id;
        const [post, log, raw] = await Promise.all([getPost(shotId), getLog(shotId), getRawShots(shotId)]);
        if (!post || !raw) throw new Error('再生成に必要な元写真が見つかりません');
        shots = raw.shots;
        existing = { post, log };
        capture = {
          shot_count: log?.shot_count ?? shots.length,
          duration_ms: log?.duration_ms ?? 0,
          retry_count: log?.retry_count ?? 0,
          device_info: log?.device_info ?? '',
          latitude: post.shot.latitude,
          longitude: post.shot.longitude,
          captured_at: post.pano.captured_at,
        };
      }

      // 1) パノラマ合成（傾き補正 / 境目のぼかし / 明るさ補正）
      markStage('パノラマ合成');
      update(0, { state: 'run', detail: `横画角 ${hfov}°` });
      const t1 = performance.now();
      const st = await stitch({ shots: shots.map(({ blob, heading, pitch, roll }) => ({ blob, heading, pitch, roll })), hfov }, (msg) =>
        update(0, { detail: msg }),
      );
      const stitchMs = Math.round(performance.now() - t1);
      metrics.set({ stitchMs });
      update(0, { state: 'done', ms: stitchMs, detail: `${st.width}×${st.height}px（${st.where === 'worker' ? 'Worker' : 'メインスレッド'}）` });

      // 2) 人物検出・ぼかし → 配信用の画像
      markStage('人物検出・ぼかし');
      update(1, { state: 'run', detail: '準備中' });
      const t2 = performance.now();
      const fin = await finishPanorama(st.panoramaBlob, (msg) => update(1, { detail: msg }));
      update(1, {
        state: fin.detectError ? 'error' : 'done',
        ms: Math.round(performance.now() - t2),
        detail: fin.detectError ? `人物検出に失敗（ぼかしなし）: ${fin.detectError}` : `${fin.persons.length}人を検出してぼかしました`,
      });

      // 3) 奥行き推定（投稿時に1回。失敗しても奥行きなしで続ける）
      markStage('奥行き推定', 'モデル読み込み');
      update(2, { state: 'run', detail: 'モデル読み込み中' });
      const t3 = performance.now();
      let depthBlob: Blob | null = null;
      let depthError: string | null = null;
      try {
        const res = await estimateDepth(fin.depthInput, st.coverageMask, (e) => {
          if (e.type === 'model') {
            setModelPct(e.progress);
            update(2, { detail: `モデル読み込み中 ${Math.round(e.progress)}%（初回は数十MBをダウンロード）` });
          } else if (e.type === 'ready') {
            setModelPct(null);
            update(2, { detail: `モデル準備完了：${e.backend}` });
          } else if (e.type === 'tile') {
            markStage('奥行き推定', `${e.index + 1}/${e.total} 枚目のタイル`);
            update(2, { detail: `${e.index + 1}/${e.total} 枚目のタイル` });
          }
        });
        depthBlob = res.blob;
        update(2, { state: 'done', ms: Math.round(performance.now() - t3), detail: res.backend });
      } catch (e) {
        depthError = (e as Error).message;
        update(2, { state: 'error', ms: Math.round(performance.now() - t3), detail: `失敗（平面で表示します）: ${depthError}` });
      }
      const depthMs = Math.round(performance.now() - t3);
      metrics.set({ depthMs });
      // 仕上がり確認画面（3D 表示の準備）に移る。表示が始まったら Preview 側で記録を消す
      markStage('仕上がり確認画面の表示');

      onDone({
        kind: job.kind,
        shotId,
        shots,
        capture,
        existing,
        headingStart: st.headingStart,
        coverageMask: st.coverageMask,
        coverageDeg: [...st.coverageMask].filter((c) => c === '1').length,
        width: st.width,
        height: st.height,
        images: { full: fin.full, low: fin.low, thumb: fin.thumb, persons: fin.persons, detectError: fin.detectError },
        depthBlob,
        depthError,
        stitchMs,
        depthMs,
        hfov,
      });
    })().catch((e) => {
      clearStage();
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
              {i === 2 && modelPct != null && (
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
