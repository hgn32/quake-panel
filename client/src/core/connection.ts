import {
  ENDPOINTS,
  isServerEvent,
  type ClientMessage,
  type DemoScenario,
  type JsonValue,
  type ServerEvent,
} from '@quake-panel/shared';
import { resolveWsUrl } from './urls.js';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface ConnectionOptions {
  /** サーバーからのイベント */
  onEvent: (event: ServerEvent) => void;
  onStateChange: (state: ConnectionState) => void;
  /** アプリ層 ping の間隔。プロキシのアイドル切断より短くする (§4)。 */
  heartbeatMs?: number;
  /** この時間だけ何も受信しなければ、生きていない接続として張り直す */
  stallTimeoutMs?: number;
}

/**
 * サーバーへの WebSocket 接続。
 *
 * キオスクは無人で何日も動き続ける前提なので、切断検知と指数バックオフ再接続は必須 (§4)。
 * 平常時は毎秒フレーム通知が来るためアイドルにはならないが、劣化モード中は
 * 無通信になりうるので ping を明示的に送る。
 */
export class ServerConnection {
  private socket: WebSocket | null = null;
  private heartbeatTimer: number | null = null;
  private stallTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private retryDelay = 1000;
  private closed = false;
  private state: ConnectionState = 'connecting';

  private readonly heartbeatMs: number;
  private readonly stallTimeoutMs: number;

  constructor(private readonly options: ConnectionOptions) {
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 75_000;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
  }

  /** 取りこぼしを疑ったときに現況一括を要求する */
  requestResync(): void {
    this.send({ type: 'resync' });
  }

  /** 設定画面のデモ再生ボタンから、実電文と同形のデモを全端末へ流させる */
  sendDemo(scenario: DemoScenario): void {
    this.send({ type: 'demo', scenario });
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange(state);
  }

  private connect(): void {
    if (this.closed) return;
    this.setState('connecting');
    const socket = new WebSocket(resolveWsUrl(ENDPOINTS.ws));
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retryDelay = 1000;
      this.setState('open');
      this.startHeartbeat();
      this.armStallTimer();
    });

    socket.addEventListener('message', (ev) => {
      this.armStallTimer();
      let parsed: JsonValue;
      try {
        parsed = JSON.parse(String(ev.data)) as JsonValue;
      } catch {
        return;
      }
      // 形が合っていることだけ確かめてから、決まった型として扱う
      if (isServerEvent(parsed)) this.options.onEvent(parsed as ServerEvent);
    });

    socket.addEventListener('close', () => this.scheduleReconnect());
    socket.addEventListener('error', () => socket.close());
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    this.socket = null;
    this.setState('closed');
    if (this.closed) return;
    const delay = this.retryDelay;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    this.retryDelay = Math.min(delay * 2, 30_000);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = window.setInterval(() => {
      this.send({ type: 'ping', time: new Date().toISOString() });
    }, this.heartbeatMs);
  }

  /**
   * TCP は生きているのに何も流れてこない状態 (プロキシが握ったまま等) を検知する。
   * close イベントが来ないため、受信の途絶で判断するしかない。
   */
  private armStallTimer(): void {
    if (this.stallTimer !== null) window.clearTimeout(this.stallTimer);
    this.stallTimer = window.setTimeout(() => {
      this.socket?.close();
    }, this.stallTimeoutMs);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    if (this.stallTimer !== null) window.clearTimeout(this.stallTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.stallTimer = null;
    this.reconnectTimer = null;
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
