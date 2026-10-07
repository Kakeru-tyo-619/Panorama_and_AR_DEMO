import { useEffect, useState } from 'react';
import { deletePanorama, listPanoramas } from '../lib/db';
import { isMock } from '../lib/store';
import { type Panorama, seasonOf } from '../lib/types';

type Item = Omit<Panorama, 'panoramaBlob' | 'depthMapBlob'> & { thumbUrl: string; hasDepth: boolean };

export function Home({ onCapture, onOpen }: { onCapture: () => void; onOpen: (id: string) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let urls: string[] = [];
    let alive = true;
    listPanoramas()
      .then((list) => {
        if (!alive) return;
        const its = list.map(({ panoramaBlob: _p, depthMapBlob, ...p }) => {
          const thumbUrl = URL.createObjectURL(p.thumbnailBlob);
          urls.push(thumbUrl);
          return { ...p, thumbUrl, hasDepth: !!depthMapBlob };
        });
        setItems(its);
      })
      .catch(() => setItems([]));
    return () => {
      alive = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
      urls = [];
    };
  }, [reload]);

  const remove = async (id: string) => {
    if (!confirm('このパノラマを削除しますか？')) return;
    await deletePanorama(id);
    setReload((r) => r + 1);
  };

  return (
    <div className="screen home">
      <header>
        <h1>NPLMAP Panorama <small>デモ</small></h1>
        {isMock() && <span className="badge">モックモード</span>}
      </header>
      {!window.isSecureContext && <p className="warn">HTTPS で開いていないため、カメラと方位センサーが使えません。</p>}
      <button className="primary big" onClick={onCapture}>撮影する</button>
      <h2>保存済みパノラマ</h2>
      {items === null && <p className="muted">読み込み中…</p>}
      {items?.length === 0 && <p className="muted">まだありません。「撮影する」から始めてください。</p>}
      <ul className="pano-list">
        {items?.map((p) => (
          <li key={p.id}>
            <button className="pano-card" onClick={() => onOpen(p.id)}>
              <img src={p.thumbUrl} alt="" />
              <div className="meta">
                <div>{new Date(p.captured_at).toLocaleString('ja-JP')}</div>
                <div className="tags">
                  <span className="tag">{seasonOf(p.captured_month)}</span>
                  <span className="tag">撮影範囲 {p.coverage_deg}°</span>
                  <span className="tag">{p.hasDepth ? '奥行きあり' : '奥行きなし'}</span>
                </div>
              </div>
            </button>
            <button className="del" aria-label="削除" onClick={() => remove(p.id)}>削除</button>
          </li>
        ))}
      </ul>
      <p className="muted small">
        {isMock() ? <a href="?">モックモードを終了</a> : <a href="?mock=1">PC 用モックモードで開く</a>}
      </p>
    </div>
  );
}
