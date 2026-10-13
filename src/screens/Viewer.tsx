import { useEffect, useMemo, useRef, useState } from 'react';
import { Thumb } from '../components/Thumb';
import { getLog, getPost, listPosts } from '../lib/db';
import { findCandidates, formatDistance } from '../lib/nearby';
import { loadStoredAssets, type PanoAssets } from '../lib/panoAssets';
import { userName } from '../lib/session';
import { settings, ui, useStore } from '../lib/store';
import { classify, formatJst } from '../lib/time';
import type { CaptureLogRecord, PanoramaPost } from '../lib/types';
import { ArView } from './ArView';
import { Viewer360 } from './Viewer360';

type Loaded = { post: PanoramaPost; log: CaptureLogRecord | undefined; assets: PanoAssets; variant: 'full' | 'low' };

const label = (p: PanoramaPost) => {
  const c = classify(p.pano.captured_at);
  return `${c.season} ${c.month}月 ${c.timeOfDay}`;
};

export function Viewer({ id, onOpen, onBack }: { id: string; onOpen: (id: string) => void; onBack: () => void }) {
  const [tab, setTab] = useState<'360' | 'ar'>('360');
  const [cur, setCur] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [panel, setPanel] = useState<'none' | 'info' | 'nearby'>('none');
  const [all, setAll] = useState<PanoramaPost[]>([]);
  const { groupIds } = useStore(ui);
  const { nearbyRadiusM } = useStore(settings);
  // 見ている方位（北基準）。季節・時間を切り替えても同じ方向を見たままにする
  const view = useRef({ heading: Number.NaN, pitch: 0 });

  useEffect(() => {
    listPosts().then(setAll).catch(() => undefined);
  }, []);

  // 360度ビューは低解像度、AR は高解像度を読む
  const variant = tab === 'ar' ? 'full' : 'low';
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    (async () => {
      const post = await getPost(id);
      if (!post) throw new Error('パノラマが見つかりません');
      const [log, assets] = await Promise.all([getLog(id), loadStoredAssets(post.shot.image_url, post.pano, variant)]);
      if (!alive) return;
      if (Number.isNaN(view.current.heading)) view.current = { heading: post.pano.heading_start, pitch: 0 };
      setCur({ post, log, assets, variant });
      setLoading(false);
    })().catch((e) => {
      if (!alive) return;
      setError(String(e.message ?? e));
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [id, variant]);

  const current = all.find((p) => p.shot.id === id) ?? cur?.post ?? null;
  const candidates = useMemo(() => (current ? findCandidates(current, all, nearbyRadiusM) : []), [current, all, nearbyRadiusM]);
  // まとめ表示：開いているパノラマ＋選んだ候補（保存しない）
  const group = useMemo(() => {
    const ids = new Set([id, ...groupIds]);
    return all
      .filter((p) => ids.has(p.shot.id))
      .sort((a, b) => {
        const ca = classify(a.pano.captured_at), cb = classify(b.pano.captured_at);
        return ca.month - cb.month || a.pano.captured_at.localeCompare(b.pano.captured_at);
      });
  }, [all, groupIds, id]);

  // 開いているパノラマも一緒に入れておき、切り替えた先からも戻れるようにする
  const toggleGroup = (gid: string) =>
    ui.set({
      groupIds: groupIds.includes(gid) ? groupIds.filter((g) => g !== gid) : [...new Set([...groupIds, id, gid])],
    });

  const p = cur?.post;
  return (
    <div className={`viewer${group.length > 1 ? ' has-group' : ''}`}>
      <div className="viewer-top">
        <button className="ghost" onClick={onBack}>← 戻る</button>
        <div className="seg">
          <button className={tab === '360' ? 'on' : ''} onClick={() => setTab('360')}>立体360度</button>
          <button className={tab === 'ar' ? 'on' : ''} onClick={() => setTab('ar')}>AR</button>
        </div>
        <div className="seg">
          <button className={panel === 'nearby' ? 'on' : ''} onClick={() => setPanel((v) => (v === 'nearby' ? 'none' : 'nearby'))}>
            近く{candidates.length ? ` ${candidates.length}` : ''}
          </button>
          <button className={panel === 'info' ? 'on' : ''} onClick={() => setPanel((v) => (v === 'info' ? 'none' : 'info'))}>情報</button>
        </div>
      </div>

      {group.length > 1 && (
        <div className="group-bar" role="tablist" aria-label="季節・時間の切り替え">
          {group.map((g) => (
            <button key={g.shot.id} className={g.shot.id === id ? 'on' : ''} onClick={() => onOpen(g.shot.id)}>
              <span>{label(g)}</span>
              <small>{formatJst(g.pano.captured_at)}</small>
            </button>
          ))}
        </div>
      )}

      {panel === 'info' && cur && p && (
        <div className="info-pop">
          <div>撮影日時：{formatJst(p.pano.captured_at)}（{label(p)}）</div>
          <div>投稿者：{userName(p.shot.user_id)} ／ 投稿：{formatJst(p.shot.created_at)}</div>
          <div>
            撮影範囲：{p.pano.coverage_deg}°{p.pano.coverage_deg >= 360 ? '（完全版）' : ''} ／ 左端の方位 {p.pano.heading_start}° ／ 補正{' '}
            {p.pano.heading_correction ?? '未設定'}
          </div>
          <div>位置：{p.shot.latitude != null ? `${p.shot.latitude.toFixed(5)}, ${p.shot.longitude?.toFixed(5)}` : '取得なし'}</div>
          <div>タグ：{p.shot.tags.length ? p.shot.tags.join('、') : 'なし'}</div>
          {cur.log && (
            <>
              <div>枚数 {cur.log.shot_count} ／ 撮影 {(cur.log.duration_ms / 1000).toFixed(1)} 秒 ／ やり直し {cur.log.retry_count} ／ ぼかし {cur.log.persons_blurred}人</div>
              <div>合成 {cur.log.stitch_ms} ms ／ 奥行き {cur.log.depth_ms} ms ／ hFOV {cur.log.hfov_deg}°</div>
            </>
          )}
          <div>表示中の画像：{cur.assets.width}×{cur.assets.height}px（{cur.variant === 'full' ? '高解像度' : '低解像度'}）／ 奥行き {cur.assets.depth ? 'あり' : 'なし'}</div>
        </div>
      )}

      {panel === 'nearby' && current && (
        <div className="info-pop nearby">
          <div className="nearby-head">
            <b>近くのパノラマ</b>
            <label className="radius">
              半径
              <input type="range" min={50} max={2000} step={50} value={nearbyRadiusM} onChange={(e) => settings.set({ nearbyRadiusM: Number(e.target.value) })} />
              {nearbyRadiusM}m
            </label>
          </div>
          <p className="muted small">同じ場所だと思うものを選ぶと、上のバーで季節・時間を切り替えられます（この閲覧中だけ有効）。</p>
          {candidates.length === 0 && <p className="muted">候補はありません（半径内に位置情報があるもの、またはタグが同じものを表示します）</p>}
          <ul className="cand-list">
            {candidates.map((c) => (
              <li key={c.post.shot.id}>
                <label>
                  <input type="checkbox" checked={groupIds.includes(c.post.shot.id)} onChange={() => toggleGroup(c.post.shot.id)} />
                  <Thumb url={c.post.shot.image_url} className="cand-thumb" />
                  <span className="cand-meta">
                    <span>{label(c.post)}</span>
                    <span className="muted small">
                      {formatDistance(c.distance)} ・ {formatJst(c.post.pano.captured_at)}
                      {c.sharedTags.length ? ` ・ タグ：${c.sharedTags.join('、')}` : ''}
                    </span>
                  </span>
                </label>
                <button className="ghost small" onClick={() => onOpen(c.post.shot.id)}>開く</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="viewer-body">
        {error && <p className="warn center pad">{error}</p>}
        {!cur && !error && <p className="muted center pad">読み込み中…</p>}
        {cur && tab === '360' && cur.variant === 'low' && (
          <Viewer360 assets={cur.assets} headingStart={cur.post.pano.heading_start} headingCorrection={cur.post.pano.heading_correction} view={view} />
        )}
        {cur && tab === 'ar' && cur.variant === 'full' && <ArView assets={cur.assets} panorama={cur.post.pano} hfov={cur.log?.hfov_deg ?? 65} />}
        {loading && cur && <div className="loading-chip">読み込み中…</div>}
      </div>
    </div>
  );
}
