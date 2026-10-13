/** 日時は JST で扱う（設計書：captured_at は JST で保存、1日1件は JST 午前0時にリセット） */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

/** JST の ISO 8601（例：2026-10-13T08:30:00+09:00） */
export function toJstIso(d: Date = new Date()): string {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return (
    `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}-${pad(j.getUTCDate())}` +
    `T${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}:${pad(j.getUTCSeconds())}+09:00`
  );
}

export function jstParts(iso: string) {
  const j = new Date(new Date(iso).getTime() + JST_OFFSET_MS);
  return { year: j.getUTCFullYear(), month: j.getUTCMonth() + 1, day: j.getUTCDate(), hour: j.getUTCHours(), minute: j.getUTCMinutes() };
}

/** JST の日付（YYYY-MM-DD）。1日1件の判定に使う */
export function jstDateKey(iso: string): string {
  const p = jstParts(iso);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function formatJst(iso: string): string {
  const p = jstParts(iso);
  return `${p.year}/${p.month}/${p.day} ${pad(p.hour)}:${pad(p.minute)}`;
}

export const SEASONS = ['春', '夏', '秋', '冬'] as const;
export type Season = (typeof SEASONS)[number];

export function seasonOf(month: number): Season {
  if (month >= 3 && month <= 5) return '春';
  if (month >= 6 && month <= 8) return '夏';
  if (month >= 9 && month <= 11) return '秋';
  return '冬';
}

/** 時間帯（区切りは設計書に定めがないため仮） */
export const TIMES_OF_DAY = ['朝', '昼', '夕方', '夜'] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

export function timeOfDayOf(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 10) return '朝';
  if (hour >= 10 && hour < 16) return '昼';
  if (hour >= 16 && hour < 19) return '夕方';
  return '夜';
}

/** 撮影日時から求める分類（保存はしない） */
export function classify(capturedAt: string) {
  const p = jstParts(capturedAt);
  return { month: p.month, season: seasonOf(p.month), timeOfDay: timeOfDayOf(p.hour) };
}
