
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

/** 秒で渡される設定。0.5 秒未満や極端な値は上流に迷惑なので丸める。 */
const sec = (value: string | undefined, fallback: number): number => {
  const n = num(value, fallback);
  return Math.min(Math.max(n, 0.5), 60);
};

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
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env['PORT'], 8080),
    host: str(env['HOST'], '0.0.0.0'),
    staticDir: str(env['STATIC_DIR'], 'public'),
    kmoni: {
      baseUrl: str(env['KMONI_BASE_URL'], 'http://www.kmoni.bosai.go.jp'),
      // 秒で受けて ms に直す。上流への負荷を決める値なので、
      // 端末ごとではなくサーバーの設定として持つ (§2)。
      idleFrameIntervalMs: sec(env['KMONI_IDLE_FRAME_INTERVAL_SEC'], 1) * 1000,
      activeFrameIntervalMs: sec(env['KMONI_ACTIVE_FRAME_INTERVAL_SEC'], 1) * 1000,
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
    logLevel: (str(env['LOG_LEVEL'], 'info') as Config['logLevel']),
  };
}

export const IS_DEV = bool(process.env['DEV'], false);
