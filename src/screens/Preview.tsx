import { useEffect, useMemo, useState } from 'react';
import { clearStage } from '../lib/crashMarker';
import { createPost, DailyLimitError, imageUrl, updatePost, type PostBundle } from '../lib/db';
import { loadPanoAssets, type PanoAssets } from '../lib/panoAssets';
import { session } from '../lib/session';
import { settings, useStore } from '../lib/store';
import { classify, formatJst, toJstIso } from '../lib/time';
import { uuid } from '../lib/types';
import type { Draft } from './Generate';
import { VerifySaveButton } from '../verify/VerifySaveButton';
import { Viewer360 } from './Viewer360';

const MIN_COVERAGE = 180; // 設計書：coverage_deg は 180〜360

type Props = { draft: Draft; onPosted: (id: string) => void; onRetake: () => void; onDiscard: () => void };

/** 仕上がりを確認して投稿する（ここで初めて保存する） */
export function Preview({ draft, onPosted, onRetake, onDiscard }: Props) {
  const { user } = useStore(session);
  const [assets, setAssets] = useState<PanoAssets | null>(null);
  const [tags, setTags] = useState(draft.existing?.post.shot.tags.join(', ') ?? '');
  const [ackNoBlur, setAckNoBlur] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const flatUrl = useMemo(() => URL.createObjectURL(draft.images.low), [draft]);

  useEffect(() => () => URL.revokeObjectURL(flatUrl), [flatUrl]);
  // 画面を離れた（投稿・破棄・撮り直し）なら途中終了ではない
  useEffect(() => clearStage, []);
  useEffect(() => {
    let alive = true;
    loadPanoAssets({ panorama: draft.images.low, depthMap: draft.depthBlob, coverageMask: draft.coverageMask })
      .then((a) => {
        if (!alive) return;
        setAssets(a);
        // 3D 表示が始まって少し経っても落ちなければ、生成は最後まで終わったとみなす
        setTimeout(clearStage, 3000);
      })
      .catch((e) => setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [draft]);

  const capturedAt = toJstIso(new Date(draft.capture.captured_at));
  const cls = classify(capturedAt);
  const tooNarrow = draft.coverageDeg < MIN_COVERAGE;
  const needsAck = !!draft.images.detectError && !ackNoBlur;
  const canPost = !busy && !tooNarrow && !needsAck && (!!user || draft.kind === 'regen');

  const post = async () => {
    setBusy(true);
    setError('');
    try {
      const id = draft.shotId;
      const ex = draft.existing;
      const now = toJstIso();
      const panoUrl = imageUrl(id, 'panorama');
      const depthUrl = draft.depthBlob ? imageUrl(id, 'depth') : null;
      const bundle: PostBundle = {
        shot: {
          id,
          user_id: ex?.post.shot.user_id ?? user!.user_id,
          image_url: panoUrl,
          latitude: draft.capture.latitude,
          longitude: draft.capture.longitude,
          created_at: ex?.post.shot.created_at ?? now,
          kind: 'panorama',
          tags: tags.split(/[,、\s]+/).map((t) => t.trim()).filter(Boolean),
        },
        pano: {
          shot_id: id,
          captured_at: capturedAt,
          heading_start: draft.headingStart,
          coverage_deg: draft.coverageDeg,
          heading_correction: ex?.post.pano.heading_correction ?? null,
          depth_map_url: depthUrl,
          coverage_mask: draft.coverageMask,
        },
        log: {
          id: ex?.log?.id ?? uuid(),
          shot_id: id,
          device_info: draft.capture.device_info,
          shot_count: draft.capture.shot_count,
          duration_ms: draft.capture.duration_ms,
          retry_count: draft.capture.retry_count,
          created_at: ex?.log?.created_at ?? now,
          stitch_ms: draft.stitchMs,
          depth_ms: draft.depthMs,
          hfov_deg: draft.hfov,
          persons_blurred: draft.images.persons.length,
        },
        image: { url: panoUrl, full: draft.images.full, low: draft.images.low, thumb: draft.images.thumb },
        depth: draft.depthBlob && depthUrl ? { url: depthUrl, full: draft.depthBlob, low: null, thumb: null } : null,
        raw: { shot_id: id, shots: draft.shots },
      };
      if (draft.kind === 'regen') await updatePost(bundle);
      else await createPost(bundle, !settings.get().ignoreDailyLimit);
      onPosted(id);
    } catch (e) {
      setError(e instanceof DailyLimitError ? e.message : `保存できませんでした: ${(e as Error).message ?? e}`);
      setBusy(false);
    }
  };

  const W = draft.width, H = draft.height;
  return (
    <div className="screen preview">
      <h2>仕上がりの確認</h2>
      <div className="preview-3d">
        {assets ? <Viewer360 assets={assets} headingStart={draft.headingStart} /> : <p className="muted center">読み込み中…</p>}
      </div>

      <div className="flat-wrap">
        <img src={flatUrl} alt="合成したパノラマ" />
        {draft.images.persons.map((b, i) => (
          <div
            key={i}
            className="person-box"
            style={{ left: `${(b.x / W) * 100}%`, top: `${(b.y / H) * 100}%`, width: `${(b.w / W) * 100}%`, height: `${(b.h / H) * 100}%` }}
          />
        ))}
      </div>

      <dl className="facts">
        <dt>撮影日時</dt>
        <dd>{formatJst(capturedAt)}（{cls.season}・{cls.month}月・{cls.timeOfDay}）</dd>
        <dt>撮影範囲</dt>
        <dd>
          {draft.coverageDeg}°{draft.coverageDeg >= 360 ? '（完全版）' : ''} ／ 左端の方位 {draft.headingStart}°
          {tooNarrow && <div className="warn">撮影範囲が {MIN_COVERAGE}° 未満のため投稿できません。撮り直してください</div>}
        </dd>
        <dt>人物のぼかし</dt>
        <dd>
          {draft.images.detectError ? (
            <span className="warn">人物検出が動きませんでした（ぼかしなし）：{draft.images.detectError}</span>
          ) : draft.images.persons.length ? (
            `${draft.images.persons.length}人をぼかしました（上の画像の枠）`
          ) : (
            '人物は検出されませんでした'
          )}
        </dd>
        <dt>奥行き</dt>
        <dd>{draft.depthBlob ? 'あり（立体表示）' : <span className="warn">なし（平面で表示）{draft.depthError ? `：${draft.depthError}` : ''}</span>}</dd>
        <dt>位置</dt>
        <dd>{draft.capture.latitude != null ? `${draft.capture.latitude.toFixed(5)}, ${draft.capture.longitude?.toFixed(5)}` : '取得なし（近くのパノラマの候補にはタグでのみ出ます）'}</dd>
      </dl>

      <label className="field">
        <span>建造物のタグ（カンマ区切り。主サービスのタグの代わり）</span>
        <input type="text" value={tags} placeholder="例：東京タワー, 芝公園" onChange={(e) => setTags(e.target.value)} />
      </label>

      {draft.images.detectError && (
        <label className="chk plain">
          <input type="checkbox" checked={ackNoBlur} onChange={(e) => setAckNoBlur(e.target.checked)} />
          人物がぼかされていないことを確認したうえで投稿する
        </label>
      )}
      {!user && draft.kind === 'new' && <p className="warn">投稿にはログインが必要です。ホームでログインしてください</p>}
      {error && <p className="warn">{error}</p>}

      <button className="primary big" disabled={!canPost} onClick={post}>
        {busy ? '保存中…' : draft.kind === 'regen' ? '上書き保存' : '投稿する'}
      </button>
      <VerifySaveButton draft={draft} />
      <div className="row-actions">
        {draft.kind === 'new' && <button className="ghost" disabled={busy} onClick={onRetake}>撮り直す</button>}
        <button
          className="ghost"
          disabled={busy}
          onClick={() => {
            if (confirm(draft.kind === 'regen' ? '再生成した結果を破棄しますか？' : '撮影したパノラマを破棄しますか？')) onDiscard();
          }}
        >
          破棄する
        </button>
      </div>
    </div>
  );
}
