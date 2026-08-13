import type { ViewMode } from './core/mapView.js';

/**
 * 端末ごとの設定。
 *
 * 「予報まで通知するか / 警報だけか」の切り替えは端末側で持つ (§3)。
 * サーバーは常に予報も警報も配信し、鳴らすかどうかはここで決める。
 */
export interface Settings {
  /** 予報 (警報未満) でも音と明滅を出すか */
  notifyForecast: boolean;
  volume: number;
  /** 観測点の発光表現 (重い端末では切る) */
  glow: boolean;
  /** 配信画像に焼き込まれた見出し帯を表示しない */
  hideCaption: boolean;
  mapMode: ViewMode;
  /** 表示範囲をさらに拡大する倍率 (1 = そのまま) */
  zoom: number;
  /** 履歴に表示する件数 */
  historyCount: number;
}

/** 拡大の下限・上限。1 未満は letterbox が増えるだけなので許さない。 */
export const ZOOM_RANGE = { min: 1, max: 4, step: 0.1 } as const;

const STORAGE_KEY = 'quake-panel.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  notifyForecast: true,
  volume: 0.7,
  glow: true,
  hideCaption: true,
  mapMode: 'japan',
  zoom: 1,
  historyCount: 6,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      notifyForecast: parsed.notifyForecast ?? DEFAULT_SETTINGS.notifyForecast,
      volume: clamp(parsed.volume ?? DEFAULT_SETTINGS.volume, 0, 1),
      glow: parsed.glow ?? DEFAULT_SETTINGS.glow,
      hideCaption: parsed.hideCaption ?? DEFAULT_SETTINGS.hideCaption,
      mapMode: parsed.mapMode === 'home' ? 'home' : 'japan',
      zoom: clamp(parsed.zoom ?? DEFAULT_SETTINGS.zoom, ZOOM_RANGE.min, ZOOM_RANGE.max),
      historyCount: clamp(parsed.historyCount ?? DEFAULT_SETTINGS.historyCount, 3, 12),
    };
  } catch {
    // 壊れた値が入っていても起動を止めない
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // プライベートモード等で保存できなくても表示は続ける
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min;
}
