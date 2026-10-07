import type { CaptureLog, Panorama, RawShots } from './types';

const DB_NAME = 'nplmap-panorama-demo';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('panoramas')) db.createObjectStore('panoramas', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('capture_logs'))
          db.createObjectStore('capture_logs', { keyPath: 'panorama_id' });
        if (!db.objectStoreNames.contains('raw_shots')) db.createObjectStore('raw_shots', { keyPath: 'panorama_id' });
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

async function store(name: string, mode: IDBTransactionMode) {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function putPanorama(p: Panorama) {
  await wrap((await store('panoramas', 'readwrite')).put(p));
}
export async function getPanorama(id: string): Promise<Panorama | undefined> {
  return wrap((await store('panoramas', 'readonly')).get(id));
}
export async function listPanoramas(): Promise<Panorama[]> {
  const all: Panorama[] = await wrap((await store('panoramas', 'readonly')).getAll());
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
export async function putLog(l: CaptureLog) {
  await wrap((await store('capture_logs', 'readwrite')).put(l));
}
export async function getLog(id: string): Promise<CaptureLog | undefined> {
  return wrap((await store('capture_logs', 'readonly')).get(id));
}
export async function putRawShots(r: RawShots) {
  await wrap((await store('raw_shots', 'readwrite')).put(r));
}
export async function getRawShots(id: string): Promise<RawShots | undefined> {
  return wrap((await store('raw_shots', 'readonly')).get(id));
}
export async function deletePanorama(id: string) {
  const db = await open();
  const tx = db.transaction(['panoramas', 'capture_logs', 'raw_shots'], 'readwrite');
  tx.objectStore('panoramas').delete(id);
  tx.objectStore('capture_logs').delete(id);
  tx.objectStore('raw_shots').delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
