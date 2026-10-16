/**
 * 落ちたことの記録。iPhone はメモリ不足になるとエラーを出さずにページを読み直すため、
 * 数秒ごとに段階・設定・経過時間・最後の計測値を localStorage に書き、正常終了したときだけ印を付ける。
 * 次に開いたとき、印がなければ「前回は○段階・○秒で読み直されました」と表示する。
 */
const KEY = 'verify-run-v1';
const HIST = 'verify-history-v1';

export type RunRecord = {
  id: string;
  stage: number;
  config: string;
  startedAt: number; // epoch ms
  lastBeat: number;
  elapsedMs: number;
  metrics: unknown;
  clean: boolean;
  ua: string;
};

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 記録できなくても検証は続ける */
  }
}

/** ページを開いたとき、前回の記録を読む。正常終了の印がなければ、履歴に「読み直された」として残す */
export function inspectPreviousRun(): { run: RunRecord | null; crashed: boolean; history: RunRecord[] } {
  const run = read<RunRecord>(KEY);
  const history = read<RunRecord[]>(HIST) ?? [];
  const crashed = !!run && !run.clean;
  if (crashed && run && !history.some((h) => h.id === run.id)) {
    history.unshift(run);
    write(HIST, history.slice(0, 10));
  }
  return { run, crashed, history: history.slice(0, 10) };
}

export function clearHistory() {
  try {
    localStorage.removeItem(HIST);
  } catch {
    /* ignore */
  }
}

export class RunLogger {
  private rec: RunRecord;
  private timer = 0;
  private onHide = () => this.finish();

  constructor(stage: number, config: string, private snapshot: () => unknown) {
    this.rec = {
      id: `${Date.now()}`,
      stage,
      config,
      startedAt: Date.now(),
      lastBeat: Date.now(),
      elapsedMs: 0,
      metrics: null,
      clean: false,
      ua: navigator.userAgent,
    };
    this.beat();
    this.timer = window.setInterval(() => this.beat(), 3000);
    window.addEventListener('pagehide', this.onHide);
  }

  private beat() {
    this.rec.lastBeat = Date.now();
    this.rec.elapsedMs = this.rec.lastBeat - this.rec.startedAt;
    this.rec.metrics = this.snapshot();
    write(KEY, this.rec);
  }

  /** 正常終了の印を付ける（終了ボタン・pagehide） */
  finish() {
    window.clearInterval(this.timer);
    window.removeEventListener('pagehide', this.onHide);
    this.rec.clean = true;
    this.beat();
  }
}
