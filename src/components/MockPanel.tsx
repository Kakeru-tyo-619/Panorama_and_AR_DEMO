import { useEffect, useState } from 'react';
import { mockOrientation, setMockOrientation } from '../lib/sensors';
import { useStore } from '../lib/store';

type Pose = { heading: number; pitch: number; roll: number };

/** PC 用：方位と傾きをスライダーとキー操作で変える（←→ 方位 / ↑↓ 前後 / Q E 左右、Shift で大きく） */
export function MockPanel() {
  const m = useStore(mockOrientation);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLInputElement | null;
      if (t?.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox') return;
      const k = e.shiftKey ? 10 : 2;
      const cur = mockOrientation.get();
      const next: Pose = { heading: cur.heading, pitch: cur.pitch, roll: cur.roll };
      if (e.key === 'ArrowRight') next.heading += k;
      else if (e.key === 'ArrowLeft') next.heading -= k;
      else if (e.key === 'ArrowUp') next.pitch = Math.min(60, next.pitch + k);
      else if (e.key === 'ArrowDown') next.pitch = Math.max(-60, next.pitch - k);
      else if (e.key === 'e' || e.key === 'E') next.roll = Math.min(60, next.roll + k);
      else if (e.key === 'q' || e.key === 'Q') next.roll = Math.max(-60, next.roll - k);
      else return;
      e.preventDefault();
      setMockOrientation(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 自動回転（一周撮影の確認用）
  useEffect(() => {
    if (!m.autoRotate) return;
    let raf = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const cur = mockOrientation.get();
      setMockOrientation({ heading: cur.heading + (cur.rotateSpeed * (now - last)) / 1000, pitch: cur.pitch, roll: cur.roll });
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [m.autoRotate]);

  if (!open)
    return (
      <button className="mock-toggle" onClick={() => setOpen(true)}>
        モック
      </button>
    );
  const set = (patch: Partial<Pose>) => setMockOrientation({ heading: m.heading, pitch: m.pitch, roll: m.roll, ...patch });
  return (
    <div className="mock-panel">
      <div className="dbg-head">
        <b>モックセンサー</b>
        <button onClick={() => setOpen(false)}>×</button>
      </div>
      <label className="dbg-range">
        <span>方位</span>
        <input type="range" min={0} max={359.9} step={0.1} value={m.heading} onChange={(e) => set({ heading: Number(e.target.value) })} />
        <span className="val">{m.heading.toFixed(0)}°</span>
      </label>
      <label className="dbg-range">
        <span>前後 pitch</span>
        <input type="range" min={-40} max={40} step={0.5} value={m.pitch} onChange={(e) => set({ pitch: Number(e.target.value) })} />
        <span className="val">{m.pitch.toFixed(0)}°</span>
      </label>
      <label className="dbg-range">
        <span>左右 roll</span>
        <input type="range" min={-40} max={40} step={0.5} value={m.roll} onChange={(e) => set({ roll: Number(e.target.value) })} />
        <span className="val">{m.roll.toFixed(0)}°</span>
      </label>
      <label className="dbg-range">
        <span>回転の速さ</span>
        <input type="range" min={5} max={60} step={1} value={m.rotateSpeed} onChange={(e) => mockOrientation.set({ rotateSpeed: Number(e.target.value) })} />
        <span className="val">{m.rotateSpeed}°/s</span>
      </label>
      <div className="dbg-row">
        <label className="chk">
          <input type="checkbox" checked={m.autoRotate} onChange={(e) => mockOrientation.set({ autoRotate: e.target.checked })} /> 自動で回す
        </label>
        <button onClick={() => set({ pitch: 0, roll: 0 })}>傾きリセット</button>
      </div>
      <div className="dbg-note">キー：←→ 方位 / ↑↓ 前後 / Q E 左右（Shift で大きく）</div>
    </div>
  );
}
