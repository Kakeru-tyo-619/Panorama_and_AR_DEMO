import { useSyncExternalStore } from 'react';

export type Store<T> = {
  get: () => T;
  set: (patch: Partial<T>) => void;
  subscribe: (fn: () => void) => () => void;
};

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      subs.forEach((f) => f());
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

// ---- 調整値（デバッグパネルで変更） ----
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('nplmap-settings') || '{}');
  } catch {
    return {};
  }
}

export const settings = createStore({
  hfov: 65,
  depthStrength: 0.6,
  arThreshold: 0.35,
  arSoftness: 0.06,
  arOpacity: 0.8,
  speedThreshold: 25,
  parallax: 0.3,
  nearbyRadiusM: 300, // まとめ表示の候補を探す半径（設計書では未定）
  ignoreDailyLimit: false, // 検証用：1日1件の制限を無視する
  ...loadSettings(),
});
settings.subscribe(() => {
  try {
    localStorage.setItem('nplmap-settings', JSON.stringify(settings.get()));
  } catch {
    /* ignore */
  }
});

// ---- 計測値（デバッグパネルで表示） ----
export const metrics = createStore({
  stitchMs: null as number | null,
  depthMs: null as number | null,
  fps: null as number | null,
  webgpu: 'checking' as 'checking' | 'yes' | 'no',
  depthBackend: '' as string,
  modelStatus: '未読み込み',
});

// ---- 画面間の連携 ----
export const ui = createStore({
  currentPanoramaId: null as string | null,
  regenerateRequest: 0,
  /** まとめ表示で選んだパノラマ（保存せず、閲覧中のみ有効） */
  groupIds: [] as string[],
});

export function isMock(): boolean {
  return new URLSearchParams(location.search).get('mock') === '1';
}
