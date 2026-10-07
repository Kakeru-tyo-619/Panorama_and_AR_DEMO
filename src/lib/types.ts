export type Panorama = {
  id: string; // UUID
  panoramaBlob: Blob; // 横長パノラマ（JPEG）
  depthMapBlob: Blob | null; // 奥行きマップ（PNG）。本番の depth_map_url に相当
  thumbnailBlob: Blob;
  latitude: number | null;
  longitude: number | null;
  captured_at: string; // ISO 8601
  captured_month: number; // 1〜12
  heading_start: number; // パノラマ左端の方位（デモでは 0 固定）
  coverage_deg: number; // 区画数 × 30
  heading_correction: number | null; // デモでは null
  created_at: string;
  /**
   * デモ用に追加：1°ごとの撮影済みフラグ（'0'/'1' の 360 文字）。
   * panoramaBlob を仕様どおり JPEG にすると透明部分が失われるため、未撮影範囲をこれで保持する。
   */
  coverage_mask: string;
};

export type CaptureLog = {
  panorama_id: string;
  device_info: string;
  shot_count: number;
  duration_ms: number;
  retry_count: number;
  stitch_ms: number; // デモ用に追加
  depth_ms: number; // デモ用に追加
  hfov_deg: number; // 生成に使った横画角
};

export type Shot = {
  blob: Blob;
  heading: number;
  pitch: number;
  roll: number;
  timestamp: number;
};

/** 撮影結果（生成画面へ渡す） */
export type CaptureResult = {
  shots: Shot[];
  shot_count: number;
  duration_ms: number;
  retry_count: number;
  device_info: string;
  latitude: number | null;
  longitude: number | null;
  captured_at: string;
};

/** デモ用：再生成のために元写真を保存しておく */
export type RawShots = {
  panorama_id: string;
  shots: Shot[];
};

export function seasonOf(month: number): string {
  if (month >= 3 && month <= 5) return '春';
  if (month >= 6 && month <= 8) return '夏';
  if (month >= 9 && month <= 11) return '秋';
  return '冬';
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
