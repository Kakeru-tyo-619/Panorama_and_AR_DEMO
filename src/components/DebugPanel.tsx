import { useState } from 'react';
import { orientation, sourceLabel } from '../lib/sensors';
import { metrics, settings, ui, useStore } from '../lib/store';

export function DebugPanel() {
  const [open, setOpen] = useState(false);
  const o = useStore(orientation);
  const s = useStore(settings);
  const m = useStore(metrics);
  const u = useStore(ui);
  const [hfovInput, setHfovInput] = useState(String(s.hfov));

  if (!open)
    return (
      <button className="dbg-toggle" onClick={() => setOpen(true)}>
        DBG
      </button>
    );

  const applyHfov = () => {
    const v = Number(hfovInput);
    if (v >= 20 && v <= 120) settings.set({ hfov: v });
    else setHfovInput(String(s.hfov));
  };
  const num = (v: number | null, unit = '') => (v == null ? '—' : `${v.toLocaleString()}${unit}`);
  const raw = [o.raw.alpha, o.raw.beta, o.raw.gamma].map((v) => (v == null ? '—' : v.toFixed(0))).join(' / ');

  return (
    <div className="dbg">
      <div className="dbg-head">
        <b>デバッグ</b>
        <button onClick={() => setOpen(false)}>×</button>
      </div>
      <table>
        <tbody>
          <tr><th>方位</th><td>{o.heading.toFixed(1)}°</td></tr>
          <tr><th>pitch / roll</th><td>{o.pitch.toFixed(1)}° / {o.roll.toFixed(1)}°</td></tr>
          <tr><th>回転速度</th><td>{o.speed.toFixed(1)} °/s</td></tr>
          <tr><th>センサー</th><td>{o.started ? (o.updatedAt ? sourceLabel(o.source) : '待機中') : '停止中'}</td></tr>
          <tr><th>raw α/β/γ</th><td>{raw}{o.raw.compass != null ? ` (compass ${o.raw.compass.toFixed(0)})` : ''}</td></tr>
          <tr><th>合成</th><td>{num(m.stitchMs, ' ms')}</td></tr>
          <tr><th>奥行き推定</th><td>{num(m.depthMs, ' ms')}</td></tr>
          <tr><th>表示 FPS</th><td>{num(m.fps)}</td></tr>
          <tr><th>WebGPU</th><td>{m.webgpu === 'checking' ? '確認中' : m.webgpu === 'yes' ? '使える' : '使えない'}</td></tr>
          <tr><th>推定モデル</th><td>{m.modelStatus}{m.depthBackend ? ` / ${m.depthBackend}` : ''}</td></tr>
        </tbody>
      </table>
      <div className="dbg-row">
        <label>横画角 hFOV</label>
        <input type="number" inputMode="decimal" value={hfovInput} onChange={(e) => setHfovInput(e.target.value)} onBlur={applyHfov} />
        <span>°</span>
        <button
          disabled={!u.currentPanoramaId}
          onClick={() => {
            applyHfov();
            ui.set({ regenerateRequest: u.regenerateRequest + 1 });
            setOpen(false);
          }}
        >
          再生成
        </button>
      </div>
      {!u.currentPanoramaId && <div className="dbg-note">再生成は閲覧画面で使えます</div>}
      <Range label="奥行きの強さ" min={0} max={0.9} step={0.01} value={s.depthStrength} onChange={(v) => settings.set({ depthStrength: v })} />
      <Range label="視差の量 (m)" min={0} max={1} step={0.01} value={s.parallax} onChange={(v) => settings.set({ parallax: v })} />
      <Range label="AR しきい値" min={0} max={1} step={0.01} value={s.arThreshold} onChange={(v) => settings.set({ arThreshold: v })} />
      <Range label="AR 境目のぼかし" min={0} max={0.3} step={0.01} value={s.arSoftness} onChange={(v) => settings.set({ arSoftness: v })} />
      <Range label="撮影の速度上限 (°/s)" min={5} max={90} step={1} value={s.speedThreshold} onChange={(v) => settings.set({ speedThreshold: v })} />
      <label className="chk">
        <input type="checkbox" checked={s.ignoreDailyLimit} onChange={(e) => settings.set({ ignoreDailyLimit: e.target.checked })} />
        1日1件の投稿制限を無視する（検証用）
      </label>
    </div>
  );
}

function Range(p: { label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="dbg-range">
      <span>{p.label}</span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
      <span className="val">{p.value}</span>
    </label>
  );
}
