import { useEffect, useState } from 'react';
import { getImageBlob } from '../lib/db';

/** 保存済みの画像 URL のサムネイルを表示する */
export function Thumb({ url, className }: { url: string; className?: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    let objectUrl = '';
    getImageBlob(url, 'thumb').then((b) => {
      if (!alive || !b) return;
      objectUrl = URL.createObjectURL(b);
      setSrc(objectUrl);
    });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);
  return src ? <img className={className} src={src} alt="" /> : <div className={`${className ?? ''} thumb-empty`} />;
}
