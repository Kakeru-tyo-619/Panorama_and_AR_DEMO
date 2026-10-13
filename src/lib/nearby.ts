/**
 * まとめ表示の候補（設計書 4.1）。保存時に地点を決めず、閲覧時に候補を出して閲覧者が選ぶ。
 * 候補：開いているパノラマから半径○m以内（距離は未定のため設定値）、または建造物のタグが同じもの。
 */
import type { PanoramaPost } from './types';

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export type Candidate = { post: PanoramaPost; distance: number | null; sharedTags: string[] };

export function findCandidates(current: PanoramaPost, all: PanoramaPost[], radiusM: number): Candidate[] {
  const c = current.shot;
  const out: Candidate[] = [];
  for (const p of all) {
    if (p.shot.id === c.id) continue;
    const s = p.shot;
    const distance =
      c.latitude != null && c.longitude != null && s.latitude != null && s.longitude != null
        ? distanceM(c.latitude, c.longitude, s.latitude, s.longitude)
        : null;
    const sharedTags = s.tags.filter((t) => c.tags.includes(t));
    if ((distance != null && distance <= radiusM) || sharedTags.length) out.push({ post: p, distance, sharedTags });
  }
  return out.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
}

export function formatDistance(m: number | null): string {
  if (m == null) return '距離不明';
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}
