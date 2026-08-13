import WebSocket from 'ws';
import type { Config } from '../config.js';
import type { Hub } from '../hub.js';
import { createLogger, describeError } from '../logger.js';
import { fetchJson } from './httpClient.js';
import { parseEew, parseEewDetection, parseQuake, parseTsunami } from './p2pParse.js';
import { P2P_CODES, type P2PEew, type P2PEewDetection, type P2PQuake, type P2PTsunami } from './p2pTypes.js';

const log = createLogger('p2p');

/**
 * P2P地震情報への常時接続。
 *
 * 2026年6月以降 WebSocket は IP あたり 2 本までに制限されている (§2)。
 * サーバーがここで 1 本だけ張り、パースして自前 WS へファンアウトする。
 * リバースプロキシで上流 WS を素通しする構成は制限に即抵触するため採らない。
 */
export class P2PClient {
  private socket: WebSocket | null = null;
  private reconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly hub: Hub,
    private readonly onEew: (eew: ReturnType<typeof parseEew>) => void,
  ) {
    this.reconnectDelay = config.p2p.reconnectMinMs;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  /** 起動直後に画面が空にならないよう、直近の地震情報と津波予報を取り込む。 */
  async seedHistory(): Promise<void> {
    const now = new Date();
    try {
      const quakes = await fetchJson<P2PQuake[]>(
        `${this.config.p2p.historyUrl}?codes=551&limit=${this.config.quakeHistorySize}`,
        { timeoutMs: 8000 },
      );
      this.hub.seedQuakes(quakes.map((q) => parseQuake(q, now)));
      log.info(`seeded ${quakes.length} quake records`);
    } catch (error) {
      log.warn(`quake history seed failed: ${describeError(error)}`);
    }
    try {
      const tsunami = await fetchJson<P2PTsunami[]>(`${this.config.p2p.historyUrl}?codes=552&limit=1`, {
        timeoutMs: 8000,
      });
      const latest = tsunami[0];
      if (latest) this.hub.seedTsunami(parseTsunami(latest, now));
    } catch (error) {
      log.warn(`tsunami history seed failed: ${describeError(error)}`);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    log.info(`connecting to ${this.config.p2p.wsUrl}`);
    const socket = new WebSocket(this.config.p2p.wsUrl, {
      handshakeTimeout: 10_000,
      headers: { 'user-agent': 'quake-panel/0.1 (private household display)' },
    });
    this.socket = socket;

    socket.on('open', () => {
      log.info('connected');
      this.reconnectDelay = this.config.p2p.reconnectMinMs;
      this.hub.markSuccess('p2p');
    });

    socket.on('message', (data) => {
      try {
        this.handle(String(data));
      } catch (error) {
        log.warn(`message handling failed: ${describeError(error)}`);
      }
    });

    socket.on('error', (error) => {
      log.warn(`socket error: ${describeError(error)}`);
      this.hub.markFailure('p2p', describeError(error));
    });

    socket.on('close', (code, reason) => {
      if (this.socket === socket) this.socket = null;
      this.hub.markFailure('p2p', `closed (${code}) ${reason.toString().slice(0, 80)}`);
      if (this.stopped) return;
      log.warn(`disconnected (${code}); retrying in ${this.reconnectDelay}ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectTimer.unref?.();
      // 指数バックオフ。上限は設定値 (既定 60 秒)。
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.config.p2p.reconnectMaxMs);
    });
  }

  private handle(text: string): void {
    const msg = JSON.parse(text) as { code?: number };
    const now = new Date();
    this.hub.markSuccess('p2p');
    switch (msg.code) {
      case P2P_CODES.quake:
        this.hub.publishQuake(parseQuake(msg as P2PQuake, now));
        break;
      case P2P_CODES.tsunami:
        this.hub.publishTsunami(parseTsunami(msg as P2PTsunami, now));
        break;
      case P2P_CODES.eewDetection:
        this.hub.publishEewDetection(parseEewDetection(msg as P2PEewDetection, now));
        break;
      case P2P_CODES.eew:
        this.onEew(parseEew(msg as P2PEew, now));
        break;
      default:
        // 他コード (地震感知情報など) は本アプリでは使わない
        break;
    }
  }
}
