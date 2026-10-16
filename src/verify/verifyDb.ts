/**
 * 検証デモ専用の保存先（IndexedDB）。本編のデモ版（irisona-ar-panorama）とは別のデータベースにする。
 * iPhone がページを読み直しても、ファイルを選び直さずに同じデータで再開するために使う。
 * iOS Safari では Blob を IndexedDB に入れると読めなくなることがあるため、ArrayBuffer で持つ。
 */
export type VerifyMeta = {
  version: 1;
  created_at: string;
  panorama: { file: string; width: number; height: number; format: 'jpeg'; quality: number };
  depth: null | {
    file: string;
    width: number;
    height: number;
    encoding: 'png-8bit-gray';
    channel: 'R';
    range: [number, number];
    near_is_high: true;
    note: string;
  };
  heading_start: number;
  coverage_deg: number;
  coverage_mask: string;
  captured_at: string;
};

export type VerifyData = { pano: Blob; depth: Blob | null; meta: VerifyMeta; savedAt: number };

type Stored = { panoBuf: ArrayBuffer; panoType: string; depthBuf: ArrayBuffer | null; depthType: string; meta: VerifyMeta; savedAt: number };

const DB_NAME = 'irisona-verify';
const STORE = 'data';
const KEY = 'current';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveVerifyData(d: VerifyData): Promise<void> {
  const stored: Stored = {
    panoBuf: await d.pano.arrayBuffer(),
    panoType: d.pano.type,
    depthBuf: d.depth ? await d.depth.arrayBuffer() : null,
    depthType: d.depth?.type ?? '',
    meta: d.meta,
    savedAt: d.savedAt,
  };
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('保存を中止しました'));
    });
    tx.objectStore(STORE).put(stored, KEY);
    await done;
  } finally {
    db.close();
  }
}

export async function loadVerifyData(): Promise<VerifyData | null> {
  const db = await open();
  try {
    const s = await wrap<Stored | undefined>(db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY));
    if (!s) return null;
    return {
      pano: new Blob([s.panoBuf], { type: s.panoType }),
      depth: s.depthBuf ? new Blob([s.depthBuf], { type: s.depthType }) : null,
      meta: s.meta,
      savedAt: s.savedAt,
    };
  } finally {
    db.close();
  }
}

export async function clearVerifyData(): Promise<void> {
  const db = await open();
  try {
    await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY));
  } finally {
    db.close();
  }
}
