import { DEFAULT_KMONI_LAYER, parseKmoniLayer, type KmoniLayer } from '@quake-panel/shared';

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const str = (value: string | undefined, fallback: string): string =>
  value === undefined || value.trim() === '' ? fallback : value.trim();

/** 秒で渡される設定。0.5 秒未満や極端な値は上流に迷惑なので丸める。 */
const sec = (value: string | undefined, fallback: number): number => {
  const n = num(value, fallback);
  return Math.min(Math.max(n, 0.5), 60);
};

/** 整数設定を min〜max に丸める (退避先ディスクを溢れさせないための保険)。 */
const clampInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Math.round(num(value, fallback));
  return Math.min(Math.max(n, min), max);
};

export interface Config {
  port: number;
  host: string;
  /** 静的ファイル (クライアントのビルド成果物) の置き場 */
  staticDir: string;
  kmoni: {
    baseUrl: string;
    /**
     * 既定で取得・表示する指標。端末が別の指標を選んだときだけ、その分も取りに行く。
     * 上流への負荷に直結するのでサーバー設定に置く (§2)。
     */
    layer: KmoniLayer;
    /** 平常時の画像取得間隔 (ms)。実測で kmoni は毎秒更新 (docs/kmoni-endpoints.md)。 */
    idleFrameIntervalMs: number;
    /** EEW 発表中の画像取得間隔 (ms) */
    activeFrameIntervalMs: number;
    /** EEW JSON の取得間隔 (ms) */
    eewIntervalMs: number;
    /** 基準時刻 (latest.json) の再同期間隔 (ms) */
    clockSyncIntervalMs: number;
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
  /**
   * 最終報 (is_final) を受けたあとの保持時間 (ms)。
   *
   * kmoni は最終報のあとも同じ内容を約3.5分返し続ける (2026-09-02 実測: 最終報
   * 08:25:26 → 08:28:00〜08:28:30 の間で「データがありません」に変化)。続報が
   * もう来ない報を通常と同じ 180 秒保持すると、表示終了が発震から 6 分を超える。
   */
  eewFinalRetentionMs: number;
  /** EEW イベントを外部システムへ通知する webhook。URL 未設定なら無効。 */
  eewWebhook: {
    /** POST 先 URL（複数可） */
    urls: string[];
    requestTimeoutMs: number;
  };
  /** 地震イベントのログ (JSONL)。dir が空なら無効。 */
  eventLog: {
    dir: string;
    /** 保持日数。1〜3650 に丸める。 */
    retentionDays: number;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const eewRetentionMs = num(env['EEW_RETENTION_MS'], 180_000);
  return {
    port: num(env['PORT'], 8080),
    host: str(env['HOST'], '0.0.0.0'),
    staticDir: str(env['STATIC_DIR'], 'public'),
    kmoni: {
      baseUrl: str(env['KMONI_BASE_URL'], 'http://www.kmoni.bosai.go.jp'),
      layer: parseKmoniLayer(env['KMONI_LAYER']) ?? DEFAULT_KMONI_LAYER,
      // 秒で受けて ms に直す。上流への負荷を決める値なので、
      // 端末ごとではなくサーバーの設定として持つ (§2)。
      idleFrameIntervalMs: sec(env['KMONI_IDLE_FRAME_INTERVAL_SEC'], 1) * 1000,
      activeFrameIntervalMs: sec(env['KMONI_ACTIVE_FRAME_INTERVAL_SEC'], 1) * 1000,
      eewIntervalMs: num(env['KMONI_EEW_INTERVAL_MS'], 1000),
      clockSyncIntervalMs: num(env['KMONI_CLOCK_SYNC_INTERVAL_MS'], 60_000),
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
    eewRetentionMs,
    // 最終報の保持時間が通常の保持時間より長いと設定ミスで意味が無くなる
    // (最終報だけ長く残ってしまう) ため、通常の保持時間を上限に丸める。
    eewFinalRetentionMs: Math.min(eewRetentionMs, num(env['EEW_FINAL_RETENTION_MS'], 60_000)),
    eewWebhook: {
      urls: str(env['EEW_WEBHOOK_URL'], '')
        .split(',')
        .map((u) => u.trim())
        .filter((u) => u !== ''),
      requestTimeoutMs: num(env['EEW_WEBHOOK_TIMEOUT_MS'], 5000),
    },
    eventLog: {
      // `str()` は空文字列を既定値へ戻してしまうため使わない。ここは
      // 「明示的な空文字列 = 無効」を区別する必要がある (未設定時だけ既定を使う)。
      dir: env['EVENT_LOG_DIR'] === undefined ? 'data/logs' : env['EVENT_LOG_DIR'].trim(),
      retentionDays: clampInt(env['EVENT_LOG_RETENTION_DAYS'], 30, 1, 3650),
    },
    logLevel: (str(env['LOG_LEVEL'], 'info') as Config['logLevel']),
  };
}
