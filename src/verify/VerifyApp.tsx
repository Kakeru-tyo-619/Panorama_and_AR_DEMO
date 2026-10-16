import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestOrientationPermission } from '../lib/sensors';
import { describeParams, parseParams, verifyUrl } from './params';
import { clearHistory, inspectPreviousRun } from './runLog';
import { startRun, type Runner } from './runner';
import { clearVerifyData, loadVerifyData, saveVerifyData, type VerifyData, type VerifyMeta } from './verifyDb';

const box: React.CSSProperties = { padding: 12, margin: '12px 0', border: '1px solid #8886', borderRadius: 8 };

/** ファイル選択で選ばれたものを、パノラマ・奥行きマップ・情報ファイルに振り分ける */
async function readFiles(list: FileList): Promise<VerifyData> {
  const files = Array.from(list);
  const json = files.find((f) => f.name.toLowerCase().endsWith('.json'));
  const images = files.filter((f) => /\.(jpe?g|png)$/i.test(f.name) || f.type.startsWith('image/'));
  const depth = images.find((f) => /depth/i.test(f.name)) ?? null;
  const pano = images.find((f) => f !== depth) ?? null;
  if (!json) throw new Error('情報ファイル（info_….json）が選ばれていません');
  if (!pano) throw new Error('パノラマ画像（pano_….jpg）が選ばれていません');
  const meta = JSON.parse(await json.text()) as VerifyMeta;
  if (typeof meta.coverage_mask !== 'string' || typeof meta.heading_start !== 'number') throw new Error('情報ファイルの形式が違います');
  return { pano, depth, meta, savedAt: Date.now() };
}

export function VerifyApp() {
  const params = useMemo(() => parseParams(location.search), []);
  const prev = useMemo(() => inspectPreviousRun(), []);
  const [data, setData] = useState<VerifyData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const hostRef = useRef<HTMLDivElement>(null);
  const runner = useRef<Runner | null>(null);

  useEffect(() => {
    loadVerifyData()
      .then(setData)
      .catch((e) => console.warn('IndexedDB read failed', e))
      .finally(() => setLoaded(true));
  }, []);

  const onFiles = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setMsg('');
    try {
      const d = await readFiles(list);
      setData(d);
      // ページが読み直されても続けられるよう保存する。保存できなくても、このまま動かせる
      saveVerifyData(d).catch((e) => setMsg(`端末への保存はできませんでした（このページを開いている間は使えます）: ${(e as Error).message ?? e}`));
    } catch (e) {
      setMsg(`読み込めません: ${(e as Error).message ?? e}`);
    }
  };

  const clear = async () => {
    setData(null);
    try {
      await clearVerifyData();
    } catch (e) {
      setMsg(`消せませんでした: ${(e as Error).message ?? e}`);
    }
  };

  const stop = useCallback(() => {
    runner.current?.stop();
    runner.current = null;
    setRunning(false);
  }, []);
  useEffect(() => () => runner.current?.stop(), []);

  const start = () => {
    if (!data) return;
    setError('');
    // iOS では方位センサーの許可を、ボタン操作の中で最初に要求する
    const permP = requestOrientationPermission();
    setRunning(true);
    requestAnimationFrame(async () => {
      try {
        const perm = await permP;
        runner.current = await startRun(hostRef.current!, data, params, perm === 'granted' ? 'gyro' : 'drag', {
          onExit: stop,
          onError: setError,
        });
      } catch (e) {
        console.error(e);
        setError(`開始できません: ${(e as Error).message ?? e}`);
        // 途中まで確保した資源を確実に手放すため、読み直して最初の画面に戻る
        setTimeout(() => (location.href = verifyUrl({})), 4000);
      }
    });
  };

  if (running) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
        {error && (
          <p style={{ position: 'absolute', top: 60, left: 12, right: 12, margin: 0, padding: 8, background: '#900c', color: '#fff', borderRadius: 6 }}>{error}</p>
        )}
      </div>
    );
  }

  const m = data?.meta;
  const stageLink = (s: number) => (
    <a key={s} href={verifyUrl({ stage: String(s) })} style={{ marginRight: 10, fontWeight: s === params.stage ? 700 : 400 }}>
      段階 {s}
    </a>
  );

  return (
    <div className="screen" style={{ padding: 16, maxWidth: 640, margin: '0 auto' }}>
      <h2>人物合成モード 検証デモ</h2>
      <p className="muted">保存済みのパノラマ・奥行きマップを読み込み、3D 表示・カメラ・人物の切り抜きを同時に動かして、iPhone で落ちないかを確かめます。</p>

      {prev.crashed && prev.run && (
        <div style={{ ...box, borderColor: '#d33', background: '#d331' }}>
          前回は<b>段階 {prev.run.stage}・{Math.round(prev.run.elapsedMs / 1000)} 秒</b>で読み直されました。
          <div className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>{prev.run.config}</div>
        </div>
      )}
      {!prev.crashed && prev.run && (
        <p className="muted" style={{ fontSize: 12 }}>前回は正常に終了しました（段階 {prev.run.stage}・{Math.round(prev.run.elapsedMs / 1000)} 秒）。</p>
      )}

      <div style={box}>
        <b>データ</b>
        {!loaded ? (
          <p className="muted">確認中…</p>
        ) : m && data ? (
          <p style={{ fontSize: 13 }}>
            パノラマ {m.panorama.width}×{m.panorama.height}px（{(data.pano.size / 1048576).toFixed(1)}MB） ／{' '}
            奥行き {m.depth && data.depth ? `${m.depth.width}×${m.depth.height}（${m.depth.encoding}）` : 'なし（平面表示）'} ／ 左端の方位 {m.heading_start}° ／ 範囲 {m.coverage_deg}°
            <br />
            <span className="muted">{m.panorama.file}</span>
          </p>
        ) : (
          <p className="muted">データがありません。下のボタンで、保存したファイルを選んでください。</p>
        )}
        <input type="file" multiple accept="image/jpeg,image/png,application/json,.json,.jpg,.jpeg,.png" onChange={(e) => onFiles(e.target.files)} />
        <p className="muted" style={{ fontSize: 12 }}>パノラマ画像・奥行きマップ・情報ファイルの 3 つをまとめて選びます。</p>
        {data && <button className="ghost" onClick={clear}>データを消す</button>}
        {msg && <p className="warn">{msg}</p>}
      </div>

      <div style={box}>
        <b>段階</b>
        <p>
          {[0, 1, 2].map(stageLink)}
        </p>
        <p className="muted" style={{ fontSize: 12 }}>0：パノラマだけ ／ 1：カメラ映像＋仮マスク（楕円） ／ 2：人物の切り抜き</p>
        <p style={{ fontSize: 12, wordBreak: 'break-all' }}>{describeParams(params)}</p>
      </div>

      <button className="primary big" disabled={!data} onClick={start}>開始（段階 {params.stage}）</button>

      {prev.history.length > 0 && (
        <div style={box}>
          <b>読み直された記録</b>
          <ul style={{ fontSize: 12, paddingLeft: 18 }}>
            {prev.history.map((h) => (
              <li key={h.id}>
                {new Date(h.startedAt).toLocaleString()} 段階 {h.stage}・{Math.round(h.elapsedMs / 1000)} 秒　{h.config}
              </li>
            ))}
          </ul>
          <button className="ghost" onClick={() => { clearHistory(); location.reload(); }}>記録を消す</button>
        </div>
      )}
    </div>
  );
}
