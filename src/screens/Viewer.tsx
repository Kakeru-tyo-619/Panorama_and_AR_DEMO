import { useEffect, useState } from 'react';
import { getLog, getPanorama } from '../lib/db';
import { loadPanoAssets, type PanoAssets } from '../lib/panoAssets';
import type { CaptureLog, Panorama } from '../lib/types';
import { seasonOf } from '../lib/types';
import { ArView } from './ArView';
import { Viewer360 } from './Viewer360';

export function Viewer({ id, onBack }: { id: string; onBack: () => void }) {
  const [tab, setTab] = useState<'360' | 'ar'>('360');
  const [data, setData] = useState<{ p: Panorama; log: CaptureLog | undefined; assets: PanoAssets } | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    (async () => {
      const p = await getPanorama(id);
      if (!p) throw new Error('パノラマが見つかりません');
      const [log, assets] = await Promise.all([getLog(id), loadPanoAssets(p)]);
      if (alive) setData({ p, log, assets });
    })().catch((e) => setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <div className="viewer">
      <div className="viewer-top">
        <button className="ghost" onClick={onBack}>← 戻る</button>
        <div className="seg">
          <button className={tab === '360' ? 'on' : ''} onClick={() => setTab('360')}>立体360度</button>
          <button className={tab === 'ar' ? 'on' : ''} onClick={() => setTab('ar')}>AR</button>
        </div>
        <button className="ghost" onClick={() => setInfo((v) => !v)}>情報</button>
      </div>
      {info && data && (
        <div className="info-pop">
          <div>撮影日時：{new Date(data.p.captured_at).toLocaleString('ja-JP')}（{seasonOf(data.p.captured_month)}）</div>
          <div>撮影範囲：{data.p.coverage_deg}° ／ 位置：{data.p.latitude != null ? `${data.p.latitude.toFixed(5)}, ${data.p.longitude?.toFixed(5)}` : '取得なし'}</div>
          {data.log && (
            <>
              <div>枚数 {data.log.shot_count} ／ 撮影 {(data.log.duration_ms / 1000).toFixed(1)} 秒 ／ やり直し {data.log.retry_count}</div>
              <div>合成 {data.log.stitch_ms} ms ／ 奥行き {data.log.depth_ms} ms ／ hFOV {data.log.hfov_deg}°</div>
            </>
          )}
          <div>サイズ：{data.assets.width}×{data.assets.height}px</div>
        </div>
      )}
      <div className="viewer-body">
        {error && <p className="warn">{error}</p>}
        {!data && !error && <p className="muted center">読み込み中…</p>}
        {data && tab === '360' && <Viewer360 assets={data.assets} headingStart={data.p.heading_start} />}
        {data && tab === 'ar' && <ArView assets={data.assets} panorama={data.p} hfov={data.log?.hfov_deg ?? 65} />}
      </div>
    </div>
  );
}
