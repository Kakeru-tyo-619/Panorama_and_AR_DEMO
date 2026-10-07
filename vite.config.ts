import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// GitHub Pages の公開パス。ワークフローでは VITE_BASE=/<リポジトリ名>/ を渡す。
// ローカルでは既定値を使う（リポジトリ名を変えたらここも合わせる）。
const base = process.env.VITE_BASE ?? '/-Panorama_and_AR_DEMO/';

export default defineConfig(({ mode }) => ({
  base,
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { target: 'es2020', chunkSizeWarningLimit: 4000 },
}));
