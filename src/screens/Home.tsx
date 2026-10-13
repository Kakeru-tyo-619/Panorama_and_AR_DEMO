import { useEffect, useMemo, useState } from 'react';
import { Thumb } from '../components/Thumb';
import { takeInterruptedStage } from '../lib/crashMarker';
import { deletePost, hasPostedToday, listPosts } from '../lib/db';
import { login, logout, session, userName } from '../lib/session';
import { isMock, settings, useStore } from '../lib/store';
import { classify, formatJst, SEASONS, TIMES_OF_DAY, toJstIso } from '../lib/time';
import type { PanoramaPost } from '../lib/types';

const ALL = 'すべて';

export function Home({ onCapture, onOpen }: { onCapture: () => void; onOpen: (id: string) => void }) {
  const { user } = useStore(session);
  const { ignoreDailyLimit } = useStore(settings);
  const [items, setItems] = useState<PanoramaPost[] | null>(null);
  const [reload, setReload] = useState(0);
  const [postedToday, setPostedToday] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [name, setName] = useState('');
  const [loginError, setLoginError] = useState('');
  const [season, setSeason] = useState<string>(ALL);
  const [month, setMonth] = useState<number | 0>(0);
  const [tod, setTod] = useState<string>(ALL);

  useEffect(() => {
    listPosts()
      .then(setItems)
      .catch(() => setItems([]));
  }, [reload]);

  useEffect(() => {
    if (!user) return setPostedToday(false);
    hasPostedToday(user.user_id, toJstIso())
      .then(setPostedToday)
      .catch(() => setPostedToday(false));
  }, [user, reload]);

  const filtered = useMemo(
    () =>
      (items ?? []).filter((p) => {
        const c = classify(p.pano.captured_at);
        return (season === ALL || c.season === season) && (!month || c.month === month) && (tod === ALL || c.timeOfDay === tod);
      }),
    [items, season, month, tod],
  );

  const remove = async (id: string) => {
    if (!confirm('このパノラマを削除しますか？')) return;
    await deletePost(id);
    setReload((r) => r + 1);
  };

  const doLogin = () => {
    try {
      login(name);
      setShowLogin(false);
      setLoginError('');
    } catch (e) {
      setLoginError((e as Error).message);
    }
  };

  const [interrupted, setInterrupted] = useState(takeInterruptedStage);

  const blocked = postedToday && !ignoreDailyLimit;
  const startCapture = () => {
    if (!user) return setShowLogin(true);
    if (!blocked) onCapture();
  };

  return (
    <div className="screen home">
      <header>
        <h1>Irisona AR &amp; Panorama <small>デモ</small></h1>
        {isMock() && <span className="badge">モックモード</span>}
      </header>
      {interrupted && (
        <div className="interrupted warn">
          <p>
            前回は「{interrupted.stage}{interrupted.detail ? `（${interrupted.detail}）` : ''}」の途中でページが読み直されました
            （{new Date(interrupted.at).toLocaleTimeString('ja-JP')}）。メモリ不足でブラウザが処理を止めた可能性があります。
          </p>
          <button className="ghost small" onClick={() => setInterrupted(null)}>閉じる</button>
        </div>
      )}
      <div className="account">
        {user ? (
          <>
            <span>{user.name} でログイン中</span>
            <button className="ghost small" onClick={logout}>ログアウト</button>
          </>
        ) : (
          <>
            <span className="muted">閲覧はログインなしで使えます。撮影・投稿はログインが必要です</span>
            <button className="ghost small" onClick={() => setShowLogin((v) => !v)}>ログイン</button>
          </>
        )}
      </div>
      {showLogin && !user && (
        <div className="login-box">
          <p className="muted small">デモ用の仮ログインです（本番は主サービスの認証を使います）。名前ごとに端末内でユーザーを作ります。</p>
          <div className="row">
            <input type="text" value={name} placeholder="名前" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doLogin()} />
            <button className="primary" onClick={doLogin}>ログイン</button>
          </div>
          {loginError && <p className="warn">{loginError}</p>}
        </div>
      )}
      {!window.isSecureContext && <p className="warn">HTTPS で開いていないため、カメラと方位センサーが使えません。</p>}
      <button className="primary big" disabled={!!user && blocked} onClick={startCapture}>
        {user ? '撮影する' : 'ログインして撮影する'}
      </button>
      {user && postedToday && (
        <p className={blocked ? 'warn small' : 'muted small'}>
          {blocked
            ? '今日はすでにパノラマ/ARを投稿しています（1日1件・JST 午前0時にリセット）'
            : '今日は投稿済みですが、デバッグ設定で1日1件の制限を無視しています'}
        </p>
      )}

      <h2>パノラマ</h2>
      <div className="filters">
        <Chips label="季節" options={[ALL, ...SEASONS]} value={season} onChange={setSeason} />
        <Chips label="時間帯" options={[ALL, ...TIMES_OF_DAY]} value={tod} onChange={setTod} />
        <label className="month">
          月
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            <option value={0}>{ALL}</option>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={i + 1}>{i + 1}月</option>
            ))}
          </select>
        </label>
      </div>
      {items === null && <p className="muted">読み込み中…</p>}
      {items?.length === 0 && <p className="muted">まだありません。「撮影する」から始めてください。</p>}
      {items && items.length > 0 && filtered.length === 0 && <p className="muted">条件に合うパノラマはありません。</p>}
      <ul className="pano-list">
        {filtered.map((p) => {
          const c = classify(p.pano.captured_at);
          const mine = user?.user_id === p.shot.user_id;
          return (
            <li key={p.shot.id}>
              <button className="pano-card" onClick={() => onOpen(p.shot.id)}>
                <Thumb url={p.shot.image_url} />
                <div className="meta">
                  <div>{formatJst(p.pano.captured_at)} ・ {userName(p.shot.user_id)}</div>
                  <div className="tags">
                    <span className="tag">{c.season}</span>
                    <span className="tag">{c.month}月</span>
                    <span className="tag">{c.timeOfDay}</span>
                    <span className="tag">撮影範囲 {p.pano.coverage_deg}°</span>
                    <span className="tag">{p.pano.depth_map_url ? '奥行きあり' : '奥行きなし'}</span>
                    {p.shot.tags.map((t) => (
                      <span key={t} className="tag accent">{t}</span>
                    ))}
                  </div>
                </div>
              </button>
              {mine && (
                <button className="del" aria-label="削除" onClick={() => remove(p.shot.id)}>削除</button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        {isMock() ? <a href="?">モックモードを終了</a> : <a href="?mock=1">PC 用モックモードで開く</a>}
      </p>
    </div>
  );
}

function Chips({ label, options, value, onChange }: { label: string; options: readonly string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      <span className="chips-label">{label}</span>
      {options.map((o) => (
        <button key={o} className={o === value ? 'on' : ''} onClick={() => onChange(o)}>{o}</button>
      ))}
    </div>
  );
}
