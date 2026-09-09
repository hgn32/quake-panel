import type { IntensityLevel } from './intensity.js';
import type { KmoniLayer } from './kmoniLayer.js';

/** 震源 */
export interface Hypocenter {
  name: string;
  /** 北緯 (不明時 null) */
  lat: number | null;
  /** 東経 (不明時 null) */
  lon: number | null;
  /** 深さ km (不明時 null) */
  depthKm: number | null;
  /** マグニチュード (不明時 null) */
  magnitude: number | null;
}

/** EEW の種別。kmoni の `alertflg` と P2P の警報有無を統一したもの。 */
export type EewAlertKind = 'forecast' | 'warning';

/** 取得元。両系統から同じ地震を受け取った場合は 'both'。 */
export type EewSource = 'kmoni' | 'p2p' | 'both';

/** 警報対象地域 (P2P 556 由来。kmoni EEW JSON には含まれない) */
export interface EewRegion {
  pref: string;
  name: string;
  /** 予想震度の下限 */
  scaleFrom: IntensityLevel | null;
  /** 予想震度の上限。「〜程度以上」(P2P の 99) と不明 (-1) はどちらも null */
  scaleTo: IntensityLevel | null;
  /** 気象庁が配信した主要動到達予測時刻 (ISO)。自前計算は一切しない (§2(3))。 */
  arrivalTime: string | null;
  /** "既に主要動到達と推定" 等の注記 */
  condition: string | null;
}

/**
 * 緊急地震速報の現況。
 *
 * kmoni EEW JSON と P2P 556 をひとつの地震イベントへ統合したもの。
 * 続報が来るたびに同じ `id` で置き換わる。
 */
export interface EewState {
  /** 地震イベント ID (kmoni report_id / P2P eventId)。続報間で不変。 */
  id: string;
  /** 第何報か。不明時 0。 */
  reportNumber: number;
  /** 最終報 */
  isFinal: boolean;
  /** キャンセル報 (取り消し) */
  isCancel: boolean;
  /** 訓練報。通知・明滅の対象から外す。 */
  isTraining: boolean;
  /** 仮定震源要素 (PLUM 法等) による発表 */
  isAssumption: boolean;
  alert: EewAlertKind;
  hypocenter: Hypocenter;
  /** 予想最大震度 */
  maxIntensity: IntensityLevel | null;
  /** 地震発生時刻 (ISO) */
  originTime: string | null;
  /** 電文発表時刻 (ISO) */
  announcedAt: string | null;
  /** サーバーが受信した時刻 (ISO)。表示側の経過秒計算の基準。 */
  receivedAt: string;
  regions: EewRegion[];
  source: EewSource;
}

/** 震度観測点 (551) */
export interface QuakePoint {
  pref: string;
  addr: string;
  isArea: boolean;
  scale: IntensityLevel | null;
}

/** 地震情報 (P2P 551) */
export interface QuakeInfo {
  id: string;
  /** 発表時刻 (ISO) */
  issuedAt: string | null;
  /** 発震時刻 (ISO) */
  occurredAt: string | null;
  /** 発表種別 (震度速報 / 震源に関する情報 / 震源・震度に関する情報 …) */
  issueType: string;
  hypocenter: Hypocenter;
  maxIntensity: IntensityLevel | null;
  /** 国内津波の有無 (None / Unknown / Checking / NonEffective / Watch / Warning) */
  domesticTsunami: string | null;
  points: QuakePoint[];
  receivedAt: string;
}

export type TsunamiGrade = 'MajorWarning' | 'Warning' | 'Watch' | 'Unknown';

/** 津波予報区 (552) */
export interface TsunamiArea {
  /** 予報区名 (例: 宮崎県) */
  name: string;
  grade: TsunamiGrade;
  /** 直ちに津波来襲と予想される区 */
  immediate: boolean;
  /** 第一波到達予測 (気象庁配信値をそのまま保持) */
  firstHeightCondition: string | null;
  firstHeightArrivalTime: string | null;
  maxHeightDescription: string | null;
  maxHeightValue: number | null;
  /** 利用地に該当する予報区か (表示側が設定に従って印を付ける) */
  isHome: boolean;
}

/** 津波予報 (P2P 552) */
export interface TsunamiInfo {
  id: string;
  issuedAt: string | null;
  /** 解除 */
  cancelled: boolean;
  areas: TsunamiArea[];
  /** 利用地に関わる予報区が含まれるか */
  affectsHome: boolean;
  receivedAt: string;
}

/** 緊急地震速報発表検出 (P2P 554)。詳細不明の第一報として鳴動判断に使う。 */
export interface EewDetection {
  id: string;
  /** Full: 通常, Chime: チャイムのみ */
  kind: string;
  detectedAt: string | null;
  receivedAt: string;
}

/** kmoni 画像フレームの通知 */
export interface FrameNotice {
  /** kmoni のタイムスタンプ (JST, YYYYMMDDhhmmss) */
  timestamp: string;
  /** 上記を ISO8601 に直したもの */
  isoTime: string;
  /** 取得できた補助レイヤ */
  layers: {
    realtime: boolean;
    /** EEW 発表中のみ配信される予測円 */
    psWave: boolean;
  };
  /** kmoni の表示時刻とサーバー現在時刻の差 (ms) */
  latencyMs: number;
}

/**
 * クライアントが送る描画状況の記録 (サーバーのイベントログにそのまま残す)。
 *
 * 「ベクタ描画が効いているのか」「どのビルドが動いているのか」を、画面を見た推測
 * ではなくログで確定できるようにするためのもの (`client/src/core/mapView.ts` の
 * `renderStatus()` が実際に通った経路を控え、`client/src/app.ts` が送信する)。
 */
export interface ClientRenderLog {
  /** 画面のビルド (コミットハッシュ)。開発版なら空文字列 */
  commit: string;
  /** 画面のビルド日時 (JST) */
  builtAt: string;
  /** 表示中の EEW の識別子。無ければ空文字列 */
  eewId: string;
  /** 予測円の描き方: vector=自前描画 / image=画像フォールバック / none=画像が無い */
  waveMode: 'vector' | 'image' | 'none';
  /** 測れた半径 (配信画像のピクセル)。測れなければ null */
  waveRadiusP: number | null;
  waveRadiusS: number | null;
  /** 観測点の描き方: stations=観測点表 / extract=塊抽出 */
  pointMode: 'stations' | 'extract';
  /** 表示中の指標 (jma/acmap/vcmap/dcmap) */
  layer: string;
  /** 明滅の強さ (none/forecast/warning/tsunami) */
  flash: string;
  /** 地図の拡大率 */
  zoom: number;
}

export interface SourceStatus {
  ok: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

/**
 * 取得系の死活。
 * `degraded` が true のとき、クライアントは「強震モニタ停止中 / 地震情報のみ」表示に切り替える。
 */
export interface HealthState {
  kmoniImage: SourceStatus;
  kmoniEew: SourceStatus;
  p2p: SourceStatus;
  degraded: boolean;
  /** kmoni 基準時刻とサーバー時計の差 (ms)。正ならサーバーが進んでいる。 */
  clockOffsetMs: number;
  serverStartedAt: string;
}

/** 接続直後にサーバーが送る現況一括 */
export interface StateSnapshot {
  serverTime: string;
  health: HealthState;
  frame: FrameNotice | null;
  eew: EewState | null;
  quakes: QuakeInfo[];
  tsunami: TsunamiInfo | null;
  /**
   * サーバーが既定で取得している強震モニタの指標 (KMONI_LAYER)。
   * 端末が何も選んでいなければこれを表示する。
   */
  kmoniLayer: KmoniLayer;
  /**
   * 利用地や表示の設定はサーバーが持たない。
   * 端末ごとに localStorage / URL で決める (§3)。
   */
}
