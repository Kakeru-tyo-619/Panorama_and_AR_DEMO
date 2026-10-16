/**
 * 段階 A-1：生成したパノラマと奥行きマップを、検証デモ用のファイル（画像2枚＋情報 json）にして保存・共有する。
 * 画像は再圧縮せず、生成されたままの Blob をそのまま書き出す。
 */
import { decodeBlob } from '../lib/canvasUtil';
import type { VerifyMeta } from './verifyDb';

export type PackInput = {
  full: Blob;
  depth: Blob | null;
  width: number;
  height: number;
  headingStart: number;
  coverageDeg: number;
  coverageMask: string;
  capturedAt: string;
};

const PANO_JPEG_QUALITY = 0.9; // panoFinish.ts の full の書き出し品質と同じ

const p2 = (n: number) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

export async function buildPack(i: PackInput): Promise<File[]> {
  const st = stamp();
  const panoName = `pano_${st}.jpg`;
  const depthName = `depth_${st}.png`;
  let depthMeta: VerifyMeta['depth'] = null;
  if (i.depth) {
    const img = await decodeBlob(i.depth); // 1024px 程度の小さな画像
    depthMeta = {
      file: depthName,
      width: img.width,
      height: img.height,
      encoding: 'png-8bit-gray',
      channel: 'R',
      range: [0, 255],
      near_is_high: true,
      note: '255＝近い、0＝遠い（未撮影の列も0）。タイルごとに2〜98%点で0〜1に正規化した相対値で、メートルではない',
    };
    if ('close' in img) img.close();
  }
  const meta: VerifyMeta = {
    version: 1,
    created_at: new Date().toISOString(),
    panorama: { file: panoName, width: i.width, height: i.height, format: 'jpeg', quality: PANO_JPEG_QUALITY },
    depth: depthMeta,
    heading_start: i.headingStart,
    coverage_deg: i.coverageDeg,
    coverage_mask: i.coverageMask,
    captured_at: i.capturedAt,
  };
  const files = [new File([i.full], panoName, { type: 'image/jpeg' })];
  if (i.depth) files.push(new File([i.depth], depthName, { type: 'image/png' }));
  files.push(new File([JSON.stringify(meta, null, 2)], `info_${st}.json`, { type: 'application/json' }));
  return files;
}

export function isMobileDevice() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function canShareFiles(files: File[]) {
  try {
    return isMobileDevice() && typeof navigator.share === 'function' && !!navigator.canShare?.({ files });
  } catch {
    return false;
  }
}

/** PC などでのダウンロード。複数ファイルは少し間を空けて順に落とす */
export async function downloadFiles(files: File[]) {
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** 共有シートが使えれば共有、使えなければダウンロード。共有は呼び出しの同期的な位置で行うこと（ユーザー操作の有効期限のため） */
export async function shareOrDownload(files: File[]): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (canShareFiles(files)) {
    try {
      await navigator.share({ files, title: '検証用パノラマ' });
      return 'shared';
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return 'cancelled';
      // 共有に失敗したらダウンロードにする
    }
  }
  await downloadFiles(files);
  return 'downloaded';
}
