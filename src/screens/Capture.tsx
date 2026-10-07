import { useEffect, useRef, useState } from 'react';
import { angleDiff, focalFromHfov, wrap360 } from '../lib/angles';
import { CAMERA_CONSTRAINTS, MOCK_CAMERA_HFOV, openMockCamera, openRealCamera, type CameraSource } from '../lib/camera';
import { orientation, requestOrientationPermission, sourceLabel, startSensors } from '../lib/sensors';
import { isMock, settings, useStore } from '../lib/store';
import type { CaptureResult, Shot } from '../lib/types';

const SECTORS = 12;
const SECTOR_DEG = 360 / SECTORS;
const WINDOW_DEG = 5; // 区画の中心 ±5°
const MAX_TILT = 10; // 前後の傾き ±10°
const MIN_SECTORS_TO_FINISH = 6;

type Props = { onFinish: (r: CaptureResult) => void; onCancel: () => void };

export function Capture({ onFinish, onCancel }: Props) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running'>('idle');
  const [error, setError] = useState('');
  const [cam, setCam] = useState<CameraSource | null>(null);
  const [captured, setCaptured] = useState<boolean[]>(() => Array(SECTORS).fill(false));
  const [retry, setRetry] = useState(0);
  const [warning, setWarning] = useState<string>('');
  const [flash, setFlash] = useState(false);
  const [noSensor, setNoSensor] = useState(false);
  const o = useStore(orientation);
  const s = useStore(settings);
  const camHostRef = useRef<HTMLDivElement>(null);

  const run = useRef({
    shots: [] as Shot[],
    captured: Array(SECTORS).fill(false) as boolean[],
    pending: false,
    warnedSector: -1,
    retry: 0,
    startedAt: 0,
    capturedAt: '',
    lat: null as number | null,
    lon: null as number | null,
    finished: false,
  });

  const start = async () => {
    setError('');
    setPhase('starting');
    // iOS ではユーザー操作の中で要求しないと許可されないため、await より前にまとめて要求する
    const permP = requestOrientationPermission();
    const camP = isMock() ? null : navigator.mediaDevices?.getUserMedia(CAMERA_CONSTRAINTS);
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        run.current.lat = p.coords.latitude;
        run.current.lon = p.coords.longitude;
      },
      () => undefined,
      { timeout: 10000, maximumAge: 60000 },
    );
    try {
      if (!isMock() && !navigator.mediaDevices) throw new Error('この環境ではカメラを使えません（HTTPS で開いてください）');
      const perm = await permP;
      if (perm === 'denied') throw new Error('方位センサーの使用が許可されませんでした。設定から許可して再読み込みしてください');
      const source = camP ? await openRealCamera(await camP) : openMockCamera();
      run.current.startedAt = performance.now();
      run.current.capturedAt = new Date().toISOString();
      setCam(source);
      setPhase('running');
    } catch (e) {
      camP?.then((st) => st.getTracks().forEach((t) => t.stop())).catch(() => undefined);
      setError((e as Error).message || String(e));
      setPhase('idle');
    }
  };

  // カメラ映像の表示と停止
  useEffect(() => {
    if (!cam) return;
    cam.el.className = 'cam-bg';
    camHostRef.current!.appendChild(cam.el);
    return () => {
      cam.stop();
      cam.el.remove();
    };
  }, [cam]);

  // センサーを開始し、取得できない場合は理由を出す
  useEffect(() => {
    if (phase !== 'running') return;
    const stop = startSensors();
    const t = setTimeout(() => {
      if (orientation.get().updatedAt === 0) setNoSensor(true);
    }, 2500);
    return () => {
      clearTimeout(t);
      stop();
    };
  }, [phase]);

  const finish = () => {
    const r = run.current;
    if (r.finished) return;
    r.finished = true;
    onFinish({
      shots: r.shots,
      shot_count: r.shots.length,
      duration_ms: Math.round(performance.now() - r.startedAt),
      retry_count: r.retry,
      device_info: navigator.userAgent,
      latitude: r.lat,
      longitude: r.lon,
      captured_at: r.capturedAt,
    });
  };

  // 自動撮影の判定（センサーの値が更新されるたび）
  useEffect(() => {
    if (phase !== 'running' || !cam) return;
    return orientation.subscribe(() => {
      const r = run.current;
      const cur = orientation.get();
      if (r.finished || cur.updatedAt === 0) return;
      setNoSensor(false);
      const sector = Math.round(wrap360(cur.heading) / SECTOR_DEG) % SECTORS;
      const inWindow = Math.abs(angleDiff(cur.heading, sector * SECTOR_DEG)) <= WINDOW_DEG;
      if (!inWindow) {
        r.warnedSector = -1;
        return;
      }
      if (r.captured[sector] || r.pending) return;
      const tiltOk = Math.abs(cur.pitch) <= MAX_TILT;
      const speedOk = cur.speed <= settings.get().speedThreshold;
      if (tiltOk && speedOk) {
        r.pending = true;
        const pose = { heading: cur.heading, pitch: cur.pitch, roll: cur.roll, timestamp: Date.now() };
        cam
          .grab()
          .then((blob) => {
            r.shots.push({ blob, ...pose });
            r.captured[sector] = true;
            setCaptured([...r.captured]);
            setWarning('');
            setFlash(true);
            setTimeout(() => setFlash(false), 150);
            navigator.vibrate?.(30);
            if (r.captured.every(Boolean)) finish();
          })
          .finally(() => (r.pending = false));
      } else if (r.warnedSector !== sector) {
        // この区画に入ってから最初の失敗だけを数える
        r.warnedSector = sector;
        r.retry++;
        setRetry(r.retry);
        setWarning(!tiltOk ? (cur.pitch > 0 ? '上を向きすぎています' : '下を向きすぎています') : '回すのが速すぎます。ゆっくり回してください');
      }
    });
  }, [phase, cam]);

  useEffect(() => {
    if (!warning) return;
    const t = setTimeout(() => setWarning(''), 1800);
    return () => clearTimeout(t);
  }, [warning, retry]);

  const count = captured.filter(Boolean).length;

  // 次に向けるべき区画（最も近い未撮影の区画）
  let next: { dir: number; deg: number } | null = null;
  for (let i = 0; i < SECTORS; i++) {
    if (captured[i]) continue;
    const d = angleDiff(i * SECTOR_DEG, o.heading);
    if (!next || Math.abs(d) < Math.abs(next.deg)) next = { dir: Math.sign(d), deg: d };
  }

  // 水平線：画面上の位置（縦の画素/度は表示中の映像の画角から概算）
  const hfov = isMock() ? MOCK_CAMERA_HFOV : s.hfov;
  const vw = cam?.width() || 1080, vh = cam?.height() || 1920;
  const pxPerDeg = (() => {
    const W = window.innerWidth, H = window.innerHeight;
    const scale = Math.max(W / vw, H / vh);
    return (focalFromHfov(vw, hfov) * scale * Math.PI) / 180;
  })();

  if (phase !== 'running') {
    return (
      <div className="screen capture-intro">
        <h2>撮影</h2>
        <ol className="howto">
          <li>スマホを縦に持ち、その場でゆっくり一周します</li>
          <li>30°ごとに12枚、条件がそろうと自動で撮影されます</li>
          <li>スマホは垂直に（前後の傾き ±{MAX_TILT}° 以内）</li>
        </ol>
        {isMock() && <p className="hint">モックモード：合成カメラとモックセンサーで撮影します（下の「モックセンサー」パネルで操作）</p>}
        <button className="primary big" disabled={phase === 'starting'} onClick={start}>
          {phase === 'starting' ? '準備中…' : '撮影開始'}
        </button>
        {error && <p className="warn">{error}</p>}
        {isMock() && <MockFileCapture onFinish={onFinish} />}
        <button className="ghost" onClick={onCancel}>戻る</button>
      </div>
    );
  }

  return (
    <div className="capture">
      <div className="cam-host" ref={camHostRef} />
      {flash && <div className="flash" />}

      {/* 方位バー：撮影済みの区画を塗る */}
      <div className="heading-bar">
        {captured.map((c, i) => (
          <div key={i} className={`cell ${c ? 'done' : ''}`} style={{ left: `${((i * SECTOR_DEG - SECTOR_DEG / 2 + 360) % 360) / 3.6}%` }}>
            <span>{i * SECTOR_DEG}°</span>
          </div>
        ))}
        <div className="cell wrap" style={{ left: 0, width: `${SECTOR_DEG / 2 / 3.6}%` }} data-done={captured[0]} />
        <div className="marker" style={{ left: `${o.heading / 3.6}%` }} />
      </div>
      <div className="status-line">
        {count}/{SECTORS} 枚 ・ 方位 {o.heading.toFixed(0)}° ・ やり直し {retry}
      </div>

      {/* 水平線（実際の水平の位置）と画面中央の基準線 */}
      <div className="center-ref" />
      <div
        className={`horizon ${Math.abs(o.pitch) <= MAX_TILT ? 'ok' : 'bad'}`}
        style={{ transform: `translateY(${o.pitch * pxPerDeg}px) rotate(${-o.roll}deg)` }}
      />

      {next && (
        <div className="next-arrow">
          {Math.abs(next.deg) <= WINDOW_DEG ? (
            <span className="hold">そのまま</span>
          ) : (
            <>
              <span className="arrow">{next.dir > 0 ? '→' : '←'}</span>
              <span>{Math.abs(next.deg).toFixed(0)}°</span>
            </>
          )}
        </div>
      )}

      {warning && <div className="toast">{warning}</div>}
      {noSensor && (
        <div className="toast warn persistent">
          方位センサーの値が取得できません。この端末・ブラウザでは方位が使えないため撮影できません（HTTPS で開いているか、センサーへのアクセスが許可されているか確認してください）
        </div>
      )}
      {o.source === 'relative' && <div className="toast persistent small">北基準の方位が取れないため相対方位で撮影します（AR の位置合わせはずれます）</div>}

      <div className="capture-actions">
        <button className="ghost" onClick={onCancel}>中止</button>
        <span className="src">{sourceLabel(o.source)}</span>
        <button className="primary" disabled={count < MIN_SECTORS_TO_FINISH} onClick={finish}>ここで終了</button>
      </div>
    </div>
  );
}

/** モック：画像ファイルを選び、選んだ順に方位を割り当てて撮影済みとして扱う */
function MockFileCapture({ onFinish }: { onFinish: (r: CaptureResult) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [startDeg, setStartDeg] = useState(0);
  const [step, setStep] = useState(30);
  return (
    <div className="mock-files">
      <h3>画像ファイルから撮影済みにする（モック）</h3>
      <input type="file" accept="image/*" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
      <div className="row">
        <label>開始方位 <input type="number" value={startDeg} onChange={(e) => setStartDeg(Number(e.target.value))} />°</label>
        <label>間隔 <input type="number" value={step} onChange={(e) => setStep(Number(e.target.value))} />°</label>
      </div>
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f, i) => (
            <li key={i}>{wrap360(startDeg + i * step).toFixed(0)}° … {f.name}</li>
          ))}
        </ul>
      )}
      <button
        className="primary"
        disabled={files.length < 2}
        onClick={() =>
          onFinish({
            shots: files.map((f, i) => ({ blob: f, heading: wrap360(startDeg + i * step), pitch: 0, roll: 0, timestamp: Date.now() })),
            shot_count: files.length,
            duration_ms: 0,
            retry_count: 0,
            device_info: navigator.userAgent + ' (mock-files)',
            latitude: null,
            longitude: null,
            captured_at: new Date().toISOString(),
          })
        }
      >
        この画像で生成
      </button>
    </div>
  );
}
