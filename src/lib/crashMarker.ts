/**
 * 処理中の段階を端末に記録しておく。iOS Safari はメモリ不足になるとエラーを出さずにタブを再読み込みするため、
 * 再読み込み後のホーム画面で「どの段階で落ちたか」を表示できるようにする（原因の切り分け用）。
 */
const KEY = 'nplmap-running-stage';

export type RunningStage = { stage: string; detail?: string; at: string };

export function markStage(stage: string, detail?: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ stage, detail, at: new Date().toISOString() } satisfies RunningStage));
  } catch {
    /* 記録できなくても処理は続ける */
  }
}

export function clearStage() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** 前回の処理が最後まで終わらずにページが読み直された場合、その段階を返す（1回読んだら消す） */
export function takeInterruptedStage(): RunningStage | null {
  try {
    const v = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    return v ? (JSON.parse(v) as RunningStage) : null;
  } catch {
    return null;
  }
}
