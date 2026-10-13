import { useCallback, useEffect, useState } from 'react';
import { DebugPanel } from './components/DebugPanel';
import { MockPanel } from './components/MockPanel';
import { checkWebGPU } from './lib/depthClient';
import { isMock, ui } from './lib/store';
import type { CaptureResult } from './lib/types';
import { Capture } from './screens/Capture';
import { Generate, type Draft, type GenerateJob } from './screens/Generate';
import { Home } from './screens/Home';
import { Preview } from './screens/Preview';
import { Viewer } from './screens/Viewer';

// 画面遷移は URL のパスに頼らず、状態で切り替える（GitHub Pages で下層パスが 404 にならないように）
type Screen =
  | { name: 'home' }
  | { name: 'capture' }
  | { name: 'generate'; job: GenerateJob; key: number }
  | { name: 'preview'; draft: Draft }
  | { name: 'view'; id: string };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' });

  useEffect(() => {
    checkWebGPU();
  }, []);

  useEffect(() => {
    ui.set({ currentPanoramaId: screen.name === 'view' ? screen.id : null });
  }, [screen]);

  // デバッグパネルの「再生成」
  useEffect(() => {
    let last = ui.get().regenerateRequest;
    return ui.subscribe(() => {
      const { regenerateRequest, currentPanoramaId } = ui.get();
      if (regenerateRequest === last) return;
      last = regenerateRequest;
      if (currentPanoramaId) setScreen({ name: 'generate', job: { kind: 'regen', id: currentPanoramaId }, key: Date.now() });
    });
  }, []);

  const goHome = useCallback(() => {
    ui.set({ groupIds: [] }); // まとめ表示は閲覧中のみ有効
    setScreen({ name: 'home' });
  }, []);
  const open = useCallback((id: string) => setScreen({ name: 'view', id }), []);
  const onGenerated = useCallback((draft: Draft) => setScreen({ name: 'preview', draft }), []);
  const onCaptured = useCallback(
    (capture: CaptureResult) => setScreen({ name: 'generate', job: { kind: 'new', capture }, key: Date.now() }),
    [],
  );

  return (
    <>
      {screen.name === 'home' && <Home onCapture={() => setScreen({ name: 'capture' })} onOpen={open} />}
      {screen.name === 'capture' && <Capture onFinish={onCaptured} onCancel={goHome} />}
      {screen.name === 'generate' && <Generate key={screen.key} job={screen.job} onDone={onGenerated} onCancel={goHome} />}
      {screen.name === 'preview' && (
        <Preview
          draft={screen.draft}
          onPosted={open}
          onRetake={() => setScreen({ name: 'capture' })}
          onDiscard={() => (screen.draft.kind === 'regen' ? open(screen.draft.shotId) : goHome())}
        />
      )}
      {screen.name === 'view' && <Viewer id={screen.id} onOpen={open} onBack={goHome} />}
      {isMock() && <MockPanel />}
      <DebugPanel />
    </>
  );
}
