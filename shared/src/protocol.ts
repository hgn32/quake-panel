import type { JsonValue } from './homeLocation.js';
import type { KmoniLayer } from './kmoniLayer.js';
import type {
  EewDetection,
  EewState,
  FrameNotice,
  HealthState,
  QuakeInfo,
  StateSnapshot,
  TsunamiInfo,
} from './models.js';

/**
 * サーバー ↔ クライアント間の WebSocket プロトコル。
 *
 * サーバーは上流 (kmoni / P2P) を終端してから正規化イベントを配るだけで、
 * 上流の生ストリームを素通しすることはない (§4 通信境界)。
 */
export const PROTOCOL_VERSION = 1;

export type ServerEvent =
  /** 接続直後の現況一括。以後の差分イベントの基準になる。 */
  | { type: 'hello'; protocolVersion: number; snapshot: StateSnapshot }
  /** kmoni の新フレームが取得できた。クライアントは HTTP で画像を取りに行く。 */
  | { type: 'frame'; frame: FrameNotice }
  /** EEW の新規/続報。null は「表示中の EEW を消す」を意味する。 */
  | { type: 'eew'; eew: EewState | null }
  /** 緊急地震速報の発表検出 (詳細不明の第一報) */
  | { type: 'eewDetection'; detection: EewDetection }
  /** 地震情報 (震度速報・震源情報など) */
  | { type: 'quake'; quake: QuakeInfo }
  /** 津波予報 */
  | { type: 'tsunami'; tsunami: TsunamiInfo }
  /** 取得系の死活変化 */
  | { type: 'health'; health: HealthState }
  /** アプリケーション層のハートビート応答 */
  | { type: 'pong'; time: string };

/**
 * 本番パネルの設定画面から発火できるデモ再生のシナリオ。
 * HTTP エンドポイントは作らず、この WebSocket メッセージだけが入口になる。
 */
export type DemoScenario = 'forecast' | 'warning' | 'cancel' | 'tsunami';

export type ClientMessage =
  | { type: 'ping'; time?: string }
  /** 取りこぼし時などに現況一括を要求する */
  | { type: 'resync' }
  /** デモ再生の発火。実電文と同形のイベントを通常配信経路で全端末に流す。 */
  | { type: 'demo'; scenario: DemoScenario };

/** デモ再生の id に必ず付く接頭辞。実電文の id には出現しない前提。 */
const DEMO_ID_PREFIX = 'demo-';

/**
 * この id がデモ再生由来かどうか。
 * サーバー (demo/runner.ts) とクライアント (誤認防止バナー・パネルの「デモ」表記) の
 * 両方から参照するので、判定ロジックをここに一本化する。
 */
export function isDemoEventId(id: string): boolean {
  return id.startsWith(DEMO_ID_PREFIX);
}

/**
 * サーバーからの通知として扱ってよいか。
 *
 * 型述語 (`value is ServerEvent`) にはできない。ServerEvent は JSON の形より
 * 狭いので TS が「絞り込み先が引数の型に収まらない」と拒否する。
 * ここでは形だけ確かめ、呼び出し側で ServerEvent として扱う。
 */
export function isServerEvent(value: JsonValue): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value['type'] === 'string'
  );
}

/** WebSocket 以外のエンドポイント。クライアントはこの定数だけを見る。 */
export const ENDPOINTS = {
  ws: '/ws',
  state: '/api/state',
  health: '/healthz',
  /** 最新の観測画像 (サーバーの既定指標) */
  latestFrame: '/kmoni/latest.gif',
  /** タイムスタンプと指標を指定した観測画像 */
  frame: (layer: KmoniLayer, timestamp: string) => `/kmoni/frame/${layer}/${timestamp}.gif`,
  /** EEW 発表中の予測円 */
  psWave: (timestamp: string) => `/kmoni/pswave/${timestamp}.gif`,
  /** EEW 発表中の予想震度 */
  estShindo: (timestamp: string) => `/kmoni/estshindo/${timestamp}.gif`,
} as const;

export type { EewDetection, EewState, FrameNotice, HealthState, QuakeInfo, StateSnapshot, TsunamiInfo };
