import { useCallback, useEffect, useState } from 'react';
import { DebugPanel } from './components/DebugPanel';
import { MockPanel } from './components/MockPanel';
import { markStage } from './lib/crashMarker';
import { deleteDraft, getDraft, saveDraft } from './lib/db';
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
  | { name: 'loading' }
  | { name: 'home' }
  | { name: 'capture' }
  | { name: 'generate'; job: GenerateJob; key: number }
  | { name: 'preview'; draft: Draft }
  | { name: 'view'; id: string };

/**
 * 生成が終わったら、結果を下書きとして保存してからページを読み直し、仕上がり確認画面を開く。
 * iOS Safari では人物検出（MediaPipe）と奥行き推定（ONNX Runtime）の WASM メモリが解放されないまま
 * 3D 表示を開くとメモリ不足でタブが落ちるため、読み直してメモリをまっさらにする。
 * 万一落ちても、下書きが残るのでホームから再開できる。
 */
const OPEN_DRAFT_KEY = 'nplmap-open-draft';

function takeDraftToOpen(): string | null {
  try {
    const id = sessionStorage.getItem(OPEN_DRAFT_KEY);
    sessionStorage.removeItem(OPEN_DRAFT_KEY);
    return id;
  } catch {
    return null;
  }
}

export function App() {
  const [draftToOpen] = useState(takeDraftToOpen);
  const [screen, setScreen] = useState<Screen>(draftToOpen ? { name: 'loading' } : { name: 'home' });

  useEffect(() => {
    checkWebGPU();
  }, []);

  useEffect(() => {
    if (!draftToOpen) return;
    getDraft(draftToOpen)
      .then((draft) => setScreen(draft ? { name: 'preview', draft } : { name: 'home' }))
      .catch(() => setScreen({ name: 'home' }));
  }, [draftToOpen]);

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

  const openDraft = useCallback((draft: Draft) => setScreen({ name: 'preview', draft }), []);
  const onGenerated = useCallback(async (draft: Draft) => {
    try {
      markStage('下書きの保存');
      await saveDraft(draft);
      sessionStorage.setItem(OPEN_DRAFT_KEY, draft.shotId);
      markStage('仕上がり確認画面の表示');
      location.reload();
    } catch (e) {
      // 保存できない環境では、読み直さずにそのまま開く
      console.warn('draft save failed; opening preview without reload', e);
      setScreen({ name: 'preview', draft });
    }
  }, []);
  /** 投稿・破棄・撮り直しで下書きを消してから次の画面へ */
  const closeDraft = (draft: Draft, next: () => void) => {
    deleteDraft(draft.shotId).catch(() => undefined);
    next();
  };
  const onCaptured = useCallback(
    (capture: CaptureResult) => setScreen({ name: 'generate', job: { kind: 'new', capture }, key: Date.now() }),
    [],
  );

  return (
    <>
      {screen.name === 'loading' && <p className="muted center">読み込み中…</p>}
      {screen.name === 'home' && <Home onCapture={() => setScreen({ name: 'capture' })} onOpen={open} onOpenDraft={openDraft} />}
      {screen.name === 'capture' && <Capture onFinish={onCaptured} onCancel={goHome} />}
      {screen.name === 'generate' && <Generate key={screen.key} job={screen.job} onDone={onGenerated} onCancel={goHome} />}
      {screen.name === 'preview' && (
        <Preview
          draft={screen.draft}
          onPosted={(id) => closeDraft(screen.draft, () => open(id))}
          onRetake={() => closeDraft(screen.draft, () => setScreen({ name: 'capture' }))}
          onDiscard={() => closeDraft(screen.draft, () => (screen.draft.kind === 'regen' ? open(screen.draft.shotId) : goHome()))}
        />
      )}
      {screen.name === 'view' && <Viewer id={screen.id} onOpen={open} onBack={goHome} />}
      {isMock() && <MockPanel />}
      <DebugPanel />
    </>
  );
}
