/** 検証デモの URL パラメーター。落ちたときに原因を絞れるよう、軽量化の項目を個別に切り替えられる */
export type VerifyParams = {
  stage: 0 | 1 | 2;
  msaa: boolean;
  dpr: number;
  mipmap: boolean;
  meshX: number;
  meshY: number;
  depth: boolean;
  ds: number; // 奥行きの強さ（本編の既定と同じ 0.6）
  cam: 'back' | 'front';
  model: 'selfie' | 'deeplab';
  delegate: 'gpu' | 'cpu';
  segHz: number; // 切り抜きの目標回数/秒
  mix: number; // 前回のマスクを混ぜる割合（0〜0.95）
  inv: boolean; // selfie モデルでマスクが逆に出た場合の反転
};

export function isIPhone() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

const num = (v: string | null, d: number, lo: number, hi: number) => {
  const n = v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function parseParams(search: string): VerifyParams {
  const q = new URLSearchParams(search);
  const [mx, my] = (q.get('mesh') ?? '256x64').split('x').map(Number);
  const meshOk = Number.isFinite(mx) && Number.isFinite(my) && mx >= 8 && my >= 4;
  const dprMax = Math.min(window.devicePixelRatio || 1, 3);
  const dprDefault = isIPhone() ? Math.min(1.5, dprMax) : Math.min(2, dprMax);
  return {
    stage: ([0, 1, 2].includes(Number(q.get('stage'))) ? Number(q.get('stage')) : 0) as 0 | 1 | 2,
    msaa: q.get('msaa') === '1',
    dpr: Math.min(num(q.get('dpr'), dprDefault, 0.5, 3), dprMax),
    mipmap: q.get('mipmap') === '1',
    meshX: meshOk ? Math.round(mx) : 256,
    meshY: meshOk ? Math.round(my) : 64,
    depth: q.get('depth') !== '0',
    ds: num(q.get('ds'), 0.6, 0, 0.95),
    cam: q.get('cam') === 'front' ? 'front' : 'back',
    model: q.get('model') === 'deeplab' ? 'deeplab' : 'selfie',
    delegate: q.get('delegate') === 'cpu' ? 'cpu' : 'gpu',
    segHz: num(q.get('hz'), 20, 1, 60),
    mix: num(q.get('mix'), 0.4, 0, 0.95),
    inv: q.get('inv') === '1',
  };
}

/** 現在の URL に変更を重ねた、検証ページの URL（mode=verify は常に付ける） */
export function verifyUrl(changes: Record<string, string | null>) {
  const u = new URL(location.href);
  u.searchParams.set('mode', 'verify');
  for (const [k, v] of Object.entries(changes)) {
    if (v == null) u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  return u.toString();
}

export function describeParams(p: VerifyParams): string {
  return [
    `stage=${p.stage}`,
    `msaa=${p.msaa ? 1 : 0}`,
    `dpr=${p.dpr}`,
    `mipmap=${p.mipmap ? 1 : 0}`,
    `mesh=${p.meshX}x${p.meshY}`,
    `depth=${p.depth ? 1 : 0}`,
    ...(p.stage >= 1 ? [`cam=${p.cam}`] : []),
    ...(p.stage >= 2 ? [`model=${p.model}`, `delegate=${p.delegate}`, `hz=${p.segHz}`, `mix=${p.mix}`] : []),
  ].join(' ');
}
