import {
  DEFAULT_FLASH_SECONDS,
  DEFAULT_SOUND_SECONDS,
  DEFAULT_QUAKE_FILTER,
  DEFAULT_SIDE_WIDTH,
  HOME_LOCATION,
  KMONI_MAP,
  clampFlashSeconds,
  clampSoundSeconds,
  parseKmoniLayer,
  type KmoniLayer,
  type QuakeFilter,
} from '@quake-panel/shared';
import { ZOOM_RANGE, fullMapView, type MapViewState } from './core/mapView.js';

/**
 * 端末ごとの設定。
 *
 * サーバーが持つのは上流への取得間隔とログレベルだけで、
 * 利用地・表示・鳴らし方はすべてここ (その端末のブラウザ) が持つ。
 * 「予報まで通知するか / 警報だけか」の切り替えも端末側 (§3)。
 */
export interface Settings {
  /** 予報 (警報未満) でも音と明滅を出すか */
  notifyForecast: boolean;
  volume: number;
  /** 観測点の発光表現 (重い端末では切る) */
  glow: boolean;
  /** 履歴に表示する件数 */
  historyCount: number;
  /** 利用地。地図の中心と、履歴で自分の県を前に出すのに使う */
  home: { lat: number; lon: number };
  /** 津波予報で強調する予報区を利用地から決めるか、自分で選ぶか */
  tsunamiMode: 'auto' | 'manual';
  /** tsunamiMode が manual のときに使う予報区 */
  tsunamiAreas: string[];
  /** 地図の表示位置。スクロール・拡大でそのまま更新される */
  view: MapViewState;
  /** 地震情報パネルの幅 (横並びのとき)。境目のドラッグで更新される */
  sideWidth: number;
  /** 地震情報パネルの高さ (縦並びのとき)。0 は「まだ動かしていない」 */
  sideHeight: number;
  /** 操作で地図を動かさない (キオスク運用向け) */
  locked: boolean;
  /** 表示する強震モニタの指標。null はサーバーの既定に従う */
  layer: KmoniLayer | null;
  /** 音を鳴らす上限 (秒)。0 ならパターンどおり鳴らし切る */
  soundSeconds: number;
  /** 明滅を続ける上限 (秒)。0 なら止めない */
  flashSeconds: number;
  /** 地震情報の絞り込み */
  quakeFilter: QuakeFilter;
}

/** URL で上書きできる設定。ここに無いものは端末の設定が常に勝つ。 */
export type UrlKey = 'home' | 'tsunamiAreas';

const STORAGE_KEY = 'quake-panel.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  notifyForecast: true,
  volume: 0.7,
  glow: true,
  historyCount: 6,
  home: { lat: HOME_LOCATION.lat, lon: HOME_LOCATION.lon },
  tsunamiMode: 'auto',
  tsunamiAreas: [],
  view: fullMapView(),
  sideWidth: DEFAULT_SIDE_WIDTH,
  sideHeight: 0,
  locked: false,
  layer: null,
  soundSeconds: DEFAULT_SOUND_SECONDS,
  flashSeconds: DEFAULT_FLASH_SECONDS,
  quakeFilter: { ...DEFAULT_QUAKE_FILTER },
};

/**
 * 設定の持ち主。
 *
 * 強さは **URL > その端末の保存値 > 既定値**。URL で指定された値は保存しない
 * (パラメータを外したら元の設定に戻ってほしいため)。そのため「保存されている値」と
 * 「いま効いている値」を分けて持つ。
 */
export class SettingsStore {
  private stored: Settings;
  private readonly overrides: Partial<Settings>;
  /** URL で固定されている項目。UI はこれを見て編集を止める。 */
  readonly urlKeys: ReadonlySet<UrlKey>;

  constructor(search: string = location.search, storage: Storage | null = safeStorage()) {
    this.stored = readStored(storage);
    const { overrides, keys } = readUrlOverrides(search);
    this.overrides = overrides;
    this.urlKeys = keys;
  }

  /** いま効いている設定 */
  get current(): Settings {
    return { ...this.stored, ...this.overrides };
  }

  /** URL で固定されている項目は無視して更新する */
  update(patch: Partial<Settings>): Settings {
    const accepted: Partial<Settings> = {};
    for (const [key, value] of Object.entries(patch) as Array<[keyof Settings, unknown]>) {
      if (this.urlKeys.has(key as UrlKey)) continue;
      (accepted as Record<string, unknown>)[key] = value;
    }
    this.stored = { ...this.stored, ...accepted };
    save(this.stored);
    return this.current;
  }

  isFixedByUrl(key: UrlKey): boolean {
    return this.urlKeys.has(key);
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // プライベートモード等。保存はできないが表示は続ける。
    return null;
  }
}

function readStored(storage: Storage | null): Settings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings> & {
      // 旧形式 (表示範囲の 2 択 + 倍率) からの移行用
      mapMode?: string;
      zoom?: number;
    };
    return {
      notifyForecast: parsed.notifyForecast ?? DEFAULT_SETTINGS.notifyForecast,
      volume: clamp(parsed.volume ?? DEFAULT_SETTINGS.volume, 0, 1),
      glow: parsed.glow ?? DEFAULT_SETTINGS.glow,
      historyCount: clamp(parsed.historyCount ?? DEFAULT_SETTINGS.historyCount, 3, 12),
      home: readHome(parsed.home) ?? { ...DEFAULT_SETTINGS.home },
      tsunamiMode: parsed.tsunamiMode === 'manual' ? 'manual' : 'auto',
      tsunamiAreas: readAreas(parsed.tsunamiAreas) ?? [...DEFAULT_SETTINGS.tsunamiAreas],
      view: readView(parsed.view, parsed.zoom),
      // 画面に収まるかは表示時に判断するので、ここでは負の値だけ弾く
      sideWidth: readSize(parsed.sideWidth, DEFAULT_SETTINGS.sideWidth),
      sideHeight: readSize(parsed.sideHeight, DEFAULT_SETTINGS.sideHeight),
      locked: parsed.locked ?? DEFAULT_SETTINGS.locked,
      layer: parseKmoniLayer(parsed.layer),
      soundSeconds: clampSoundSeconds(parsed.soundSeconds ?? DEFAULT_SETTINGS.soundSeconds),
      flashSeconds: clampFlashSeconds(parsed.flashSeconds ?? DEFAULT_SETTINGS.flashSeconds),
      quakeFilter: readFilter(parsed.quakeFilter),
    };
  } catch {
    // 壊れた値が入っていても起動を止めない
    return { ...DEFAULT_SETTINGS };
  }
}

function save(settings: Settings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 保存できなくても表示は続ける
  }
}

/**
 * URL からの上書き。
 * `?lat=35.68&lon=139.76&tsunami=東京都,千葉県` のように指定する。
 */
export function readUrlOverrides(search: string): {
  overrides: Partial<Settings>;
  keys: Set<UrlKey>;
} {
  const overrides: Partial<Settings> = {};
  const keys = new Set<UrlKey>();
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return { overrides, keys };
  }

  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (params.has('lat') && params.has('lon') && isLat(lat) && isLon(lon)) {
    overrides.home = { lat, lon };
    keys.add('home');
  }

  const tsunami = params.get('tsunami');
  if (tsunami !== null) {
    const areas = readAreas(tsunami.split(','));
    if (areas) {
      // URL で予報区を指定したなら、利用地からの自動決定より優先する
      overrides.tsunamiAreas = areas;
      overrides.tsunamiMode = 'manual';
      keys.add('tsunamiAreas');
    }
  }
  return { overrides, keys };
}

function readHome(value: unknown): { lat: number; lon: number } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { lat, lon } = value as { lat?: unknown; lon?: unknown };
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!isLat(lat) || !isLon(lon)) return null;
  return { lat, lon };
}

function readFilter(value: Partial<QuakeFilter> | undefined): QuakeFilter {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_QUAKE_FILTER };
  return {
    minIntensity:
      typeof value.minIntensity === 'number' && Number.isFinite(value.minIntensity)
        ? value.minIntensity
        : DEFAULT_QUAKE_FILTER.minIntensity,
    homePrefectureOnly: value.homePrefectureOnly === true,
  };
}

function readSize(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : fallback;
}

function readAreas(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const areas = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return areas.length > 0 ? areas : null;
}

function readView(value: unknown, legacyZoom: number | undefined): MapViewState {
  const fallback = fullMapView();
  if (typeof value !== 'object' || value === null) {
    // 旧形式には表示位置が無い。倍率だけ引き継いで中央に置く。
    return { ...fallback, zoom: clamp(legacyZoom ?? 1, ZOOM_RANGE.min, ZOOM_RANGE.max) };
  }
  const { centerX, centerY, zoom } = value as Record<string, unknown>;
  return {
    centerX: clampNumber(centerX, 0, KMONI_MAP.width, fallback.centerX),
    centerY: clampNumber(centerY, 0, KMONI_MAP.height, fallback.centerY),
    zoom: clampNumber(zoom, ZOOM_RANGE.min, ZOOM_RANGE.max, fallback.zoom),
  };
}

const isLat = (value: number): boolean => Number.isFinite(value) && value >= -90 && value <= 90;
const isLon = (value: number): boolean => Number.isFinite(value) && value >= -180 && value <= 180;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, min), max)
    : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min;
}
