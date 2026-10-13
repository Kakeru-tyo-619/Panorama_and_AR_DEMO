/**
 * 端末内の保存先（IndexedDB）。本番の D1（shots / panoramas / capture_logs）と Cloudinary（images）の代わり。
 * 画像は数MBあるため、sessionStorage / localStorage ではなく IndexedDB に置く。
 */
import { jstDateKey } from './time';
import type { CaptureLogRecord, ImageRecord, ImageVariant, PanoramaPost, PanoramaRecord, RawShots, ShotRecord } from './types';

const DB_NAME = 'irisona-ar-panorama';
const VERSION = 1;
const STORES = ['shots', 'panoramas', 'capture_logs', 'images', 'raw_shots'] as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const shots = db.createObjectStore('shots', { keyPath: 'id' });
        shots.createIndex('user_id', 'user_id');
        db.createObjectStore('panoramas', { keyPath: 'shot_id' });
        db.createObjectStore('capture_logs', { keyPath: 'id' }).createIndex('shot_id', 'shot_id', { unique: true });
        db.createObjectStore('images', { keyPath: 'url' });
        db.createObjectStore('raw_shots', { keyPath: 'shot_id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction, aborted: () => Error | null): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(aborted() ?? tx.error ?? new Error('保存を中止しました'));
  });
}

async function store(name: (typeof STORES)[number], mode: IDBTransactionMode) {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

/** 画像の URL（Cloudinary の URL の代わり） */
export const imageUrl = (shotId: string, kind: 'panorama' | 'depth') => `local://images/${shotId}/${kind}`;

export class DailyLimitError extends Error {}

export type PostBundle = {
  shot: ShotRecord;
  pano: PanoramaRecord;
  log: CaptureLogRecord;
  image: ImageRecord;
  depth: ImageRecord | null;
  raw: RawShots | null;
};

function isSameDayPanorama(s: ShotRecord, createdAt: string) {
  return s.kind === 'panorama' && jstDateKey(s.created_at) === jstDateKey(createdAt);
}

/**
 * 投稿を登録する。パノラマ/ARの投稿は 1日1件（JST 午前0時にリセット、写真とは別に数える）。
 * 確認と書き込みを1つのトランザクションで行い、同時に2件登録されないようにする。
 */
export async function createPost(b: PostBundle, enforceDailyLimit: boolean) {
  const db = await open();
  const tx = db.transaction([...STORES], 'readwrite');
  let failure: Error | null = null;
  const done = txDone(tx, () => failure);
  const writeAll = () => {
    tx.objectStore('shots').put(b.shot);
    tx.objectStore('panoramas').put(b.pano);
    tx.objectStore('capture_logs').put(b.log);
    tx.objectStore('images').put(b.image);
    if (b.depth) tx.objectStore('images').put(b.depth);
    if (b.raw) tx.objectStore('raw_shots').put(b.raw);
  };
  if (!enforceDailyLimit) writeAll();
  else {
    const req = tx.objectStore('shots').index('user_id').getAll(b.shot.user_id);
    req.onsuccess = () => {
      if ((req.result as ShotRecord[]).some((s) => isSameDayPanorama(s, b.shot.created_at))) {
        failure = new DailyLimitError('パノラマ/ARの投稿は1日1件までです（JST 午前0時にリセットされます）');
        tx.abort();
      } else writeAll();
    };
  }
  await done;
}

/** 再生成した画像で上書きする（投稿数には数えない） */
export async function updatePost(b: Omit<PostBundle, 'raw'>) {
  const db = await open();
  const tx = db.transaction([...STORES], 'readwrite');
  const done = txDone(tx, () => null);
  tx.objectStore('shots').put(b.shot);
  tx.objectStore('panoramas').put(b.pano);
  tx.objectStore('capture_logs').put(b.log);
  tx.objectStore('images').put(b.image);
  if (b.depth) tx.objectStore('images').put(b.depth);
  else tx.objectStore('images').delete(imageUrl(b.shot.id, 'depth'));
  await done;
}

export async function hasPostedToday(userId: string, now: string): Promise<boolean> {
  const all: ShotRecord[] = await wrap((await store('shots', 'readonly')).index('user_id').getAll(userId));
  return all.some((s) => isSameDayPanorama(s, now));
}

export async function listPosts(): Promise<PanoramaPost[]> {
  const db = await open();
  const tx = db.transaction(['shots', 'panoramas'], 'readonly');
  const [shots, panos] = await Promise.all([
    wrap(tx.objectStore('shots').getAll() as IDBRequest<ShotRecord[]>),
    wrap(tx.objectStore('panoramas').getAll() as IDBRequest<PanoramaRecord[]>),
  ]);
  const byId = new Map(panos.map((p) => [p.shot_id, p]));
  return shots
    .filter((s) => s.kind === 'panorama' && byId.has(s.id))
    .map((shot) => ({ shot, pano: byId.get(shot.id)! }))
    .sort((a, b) => b.shot.created_at.localeCompare(a.shot.created_at));
}

export async function getPost(id: string): Promise<PanoramaPost | undefined> {
  const db = await open();
  const tx = db.transaction(['shots', 'panoramas'], 'readonly');
  const [shot, pano] = await Promise.all([
    wrap(tx.objectStore('shots').get(id) as IDBRequest<ShotRecord | undefined>),
    wrap(tx.objectStore('panoramas').get(id) as IDBRequest<PanoramaRecord | undefined>),
  ]);
  return shot && pano ? { shot, pano } : undefined;
}

/** Cloudinary の変換 URL の代わり：AR は高解像度、それ以外は低解像度を返す */
export async function getImageBlob(url: string, variant: ImageVariant = 'full'): Promise<Blob | null> {
  const rec: ImageRecord | undefined = await wrap((await store('images', 'readonly')).get(url));
  if (!rec) return null;
  return rec[variant] ?? rec.full;
}

export async function getLog(shotId: string): Promise<CaptureLogRecord | undefined> {
  return wrap((await store('capture_logs', 'readonly')).index('shot_id').get(shotId));
}

export async function getRawShots(shotId: string): Promise<RawShots | undefined> {
  return wrap((await store('raw_shots', 'readonly')).get(shotId));
}

export async function deletePost(id: string) {
  const db = await open();
  const tx = db.transaction([...STORES], 'readwrite');
  const done = txDone(tx, () => null);
  tx.objectStore('shots').delete(id);
  tx.objectStore('panoramas').delete(id);
  tx.objectStore('images').delete(imageUrl(id, 'panorama'));
  tx.objectStore('images').delete(imageUrl(id, 'depth'));
  tx.objectStore('raw_shots').delete(id);
  const logReq = tx.objectStore('capture_logs').index('shot_id').getKey(id);
  logReq.onsuccess = () => {
    if (logReq.result != null) tx.objectStore('capture_logs').delete(logReq.result);
  };
  await done;
}
