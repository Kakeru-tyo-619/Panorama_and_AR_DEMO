import { useEffect, useState } from 'react';
import type { Draft } from '../screens/Generate';
import { buildPack, shareOrDownload } from './exportPack';

/** 仕上がり確認画面に置く「検証用に保存」ボタン（人物合成モードの検証デモ用） */
export function VerifySaveButton({ draft }: { draft: Draft }) {
  const [files, setFiles] = useState<File[] | null>(null);
  const [msg, setMsg] = useState('');

  // 共有シートはボタンを押した直後でないと開けないため、ファイルは先に作っておく
  useEffect(() => {
    let alive = true;
    setFiles(null);
    buildPack({
      full: draft.images.full,
      depth: draft.depthBlob,
      width: draft.width,
      height: draft.height,
      headingStart: draft.headingStart,
      coverageDeg: draft.coverageDeg,
      coverageMask: draft.coverageMask,
      capturedAt: draft.capture.captured_at,
    })
      .then((f) => alive && setFiles(f))
      .catch((e) => alive && setMsg(`検証用ファイルを作れません: ${(e as Error).message ?? e}`));
    return () => {
      alive = false;
    };
  }, [draft]);

  const save = () => {
    if (!files) return;
    setMsg('');
    shareOrDownload(files)
      .then((r) => setMsg(r === 'shared' ? '共有しました' : r === 'downloaded' ? `${files.length}個のファイルを保存しました` : ''))
      .catch((e) => setMsg(`保存できませんでした: ${(e as Error).message ?? e}`));
  };

  return (
    <div>
      <button className="ghost" disabled={!files} onClick={save}>検証用に保存</button>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
