/**
 * 設計書 4章（DB設計・仮案）に合わせたデータ。本番は D1 のテーブル、デモは IndexedDB のストア。
 * 画像は本番では Cloudinary の URL で持つため、デモでも images ストアのキー（local://…）を URL として持つ。
 */

export type ShotKind = 'photo' | 'panorama';

/** 主サービスの shots（パノラマに関わる列のみ ＋ kind を追加） */
export type ShotRecord = {
  id: string; // 投稿ID（UUID）
  user_id: string;
  image_url: string; // パノラマ画像の URL
  latitude: number | null;
  longitude: number | null;
  created_at: string; // 投稿日時（JST の ISO 8601）
  kind: ShotKind;
  tags: string[]; // 主サービスの建造物のタグ（デモでは投稿時に入力）
};

/** パノラマになった場合の情報（shots と1対1） */
export type PanoramaRecord = {
  shot_id: string;
  captured_at: string; // 撮影日時（端末時刻、JST の ISO 8601）。季節・時間帯はここから求める
  heading_start: number; // パノラマ左端の方位（北＝0°、時計回り）
  coverage_deg: number; // 撮影できた範囲（180〜360）
  heading_correction: number | null; // 向きの自動補正値（方式が未定のためデモでは null）
  depth_map_url: string | null; // 推定できなかった場合は null（平面表示）
  /**
   * デモ用に追加：画像の列に対する 1°ごとの撮影済みフラグ（'0'/'1' の 360 文字）。
   * 画像は JPEG で透明を持てないため、未撮影の範囲をこれで表す。
   */
  coverage_mask: string;
};

export type CaptureLogRecord = {
  id: string;
  shot_id: string;
  device_info: string;
  shot_count: number;
  duration_ms: number;
  retry_count: number;
  created_at: string;
  // ---- デモ用に追加（分析用） ----
  stitch_ms: number;
  depth_ms: number;
  hfov_deg: number;
  persons_blurred: number;
};

/** Cloudinary の代わり：1つの URL に対して高解像度・低解像度・サムネイルを持つ */
export type ImageRecord = {
  url: string;
  full: Blob;
  low: Blob | null;
  thumb: Blob | null;
};
export type ImageVariant = 'full' | 'low' | 'thumb';

/** 一覧・閲覧で使う、shots と panoramas を結合したもの */
export type PanoramaPost = { shot: ShotRecord; pano: PanoramaRecord };

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
  shot_id: string;
  shots: Shot[];
};

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
