import { createRoot } from 'react-dom/client';
import './styles.css';

// ?mode=verify は人物合成モードの検証デモ。パスではなく URL のパラメーターで切り替える（GitHub Pages の 404 を避けるため）。
// 本編の重いライブラリを読み込まないよう、どちらも動的に読み込む。
const root = createRoot(document.getElementById('root')!);
if (new URLSearchParams(location.search).get('mode') === 'verify') {
  import('./verify/VerifyApp').then(({ VerifyApp }) => root.render(<VerifyApp />));
} else {
  import('./App').then(({ App }) => root.render(<App />));
}
