import { HOME_LOCATION } from '@quake-panel/shared';

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
};

const str = (value: string | undefined, fallback: string): string =>
  value === undefined || value.trim() === '' ? fallback : value.trim();

export interface Config {
  port: number;
  host: string;
  /** 静的ファイル (クライアントのビルド成果物) の置き場 */
  staticDir: string;
  kmoni: {
    baseUrl: string;
    /** 平常時の画像取得間隔 (ms)。実測で kmoni は毎秒更新 (docs/kmoni-endpoints.md)。 */
    idleFrameIntervalMs: number;
    /** EEW 発表中の画像取得間隔 (ms) */
    activeFrameIntervalMs: number;
    /** EEW JSON の取得間隔 (ms) */
    eewIntervalMs: number;
    /** 基準時刻 (latest.json) の再同期間隔 (ms) */
    clockSyncIntervalMs: number;
    /** kmoni の表示時刻は現在時刻より数秒遅れる。取得を何秒遅らせるか。 */
    frameLagSeconds: number;
    requestTimeoutMs: number;
    /** 連続失敗が何回続いたら劣化モードに落とすか */
    degradeAfterFailures: number;
    /** 保持するフレーム数 (履歴再生用ではなく取りこぼし救済用) */
    frameCacheSize: number;
  };
  p2p: {
    /** WebSocket は IP あたり 2 本まで。サーバー集約なので 1 本で足りる (§2)。 */
    wsUrl: string;
    /** 起動時に履歴を取りに行く JSON API */
    historyUrl: string;
    reconnectMinMs: number;
    reconnectMaxMs: number;
  };
  /** クライアント WS のハートビート間隔 (ms)。リバースプロキシのアイドル切断対策 (§4)。 */
  wsHeartbeatMs: number;
  /** 保持する地震情報の件数 */
  quakeHistorySize: number;
  /** EEW を「表示終了」とみなすまでの時間 (ms) */
  eewRetentionMs: number;
  home: { name: string; lat: number; lon: number };
  /** 津波予報で強調する予報区名 */
  tsunamiHomeAreas: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env['PORT'], 8080),
    host: str(env['HOST'], '0.0.0.0'),
    staticDir: str(env['STATIC_DIR'], 'public'),
    kmoni: {
      baseUrl: str(env['KMONI_BASE_URL'], 'http://www.kmoni.bosai.go.jp'),
      idleFrameIntervalMs: num(env['KMONI_IDLE_FRAME_INTERVAL_MS'], 1000),
      activeFrameIntervalMs: num(env['KMONI_ACTIVE_FRAME_INTERVAL_MS'], 1000),
      eewIntervalMs: num(env['KMONI_EEW_INTERVAL_MS'], 1000),
      clockSyncIntervalMs: num(env['KMONI_CLOCK_SYNC_INTERVAL_MS'], 60_000),
      frameLagSeconds: num(env['KMONI_FRAME_LAG_SECONDS'], 2),
      requestTimeoutMs: num(env['KMONI_REQUEST_TIMEOUT_MS'], 4000),
      degradeAfterFailures: num(env['KMONI_DEGRADE_AFTER_FAILURES'], 5),
      frameCacheSize: num(env['KMONI_FRAME_CACHE_SIZE'], 30),
    },
    p2p: {
      wsUrl: str(env['P2P_WS_URL'], 'wss://api.p2pquake.net/v2/ws'),
      historyUrl: str(env['P2P_HISTORY_URL'], 'https://api.p2pquake.net/v2/history'),
      reconnectMinMs: num(env['P2P_RECONNECT_MIN_MS'], 1000),
      reconnectMaxMs: num(env['P2P_RECONNECT_MAX_MS'], 60_000),
    },
    wsHeartbeatMs: num(env['WS_HEARTBEAT_MS'], 30_000),
    quakeHistorySize: num(env['QUAKE_HISTORY_SIZE'], 12),
    eewRetentionMs: num(env['EEW_RETENTION_MS'], 180_000),
    home: {
      name: str(env['HOME_NAME'], HOME_LOCATION.name),
      lat: num(env['HOME_LAT'], HOME_LOCATION.lat),
      lon: num(env['HOME_LON'], HOME_LOCATION.lon),
    },
    tsunamiHomeAreas: str(env['TSUNAMI_HOME_AREAS'], '宮崎県')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel: (str(env['LOG_LEVEL'], 'info') as Config['logLevel']),
  };
}

export const IS_DEV = bool(process.env['DEV'], false);
