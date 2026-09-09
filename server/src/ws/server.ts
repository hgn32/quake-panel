import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ENDPOINTS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ClientRenderLog,
  type ServerEvent,
} from '@quake-panel/shared';
import type { Config } from '../config.js';
import type { DemoRunner } from '../demo/runner.js';
import type { Hub } from '../hub.js';
import { createLogger, describeError } from '../logger.js';
import type { EventLog } from '../notify/eventLog.js';

const log = createLogger('ws');

/** clientLog の濫用対策 (キオスク用途なので単純なカウンタで十分)。 */
const CLIENT_LOG_LIMIT_PER_WINDOW = 30;
const CLIENT_LOG_WINDOW_MS = 60_000;

interface Client {
  socket: WebSocket;
  alive: boolean;
  /** clientLog のレート制限。ウィンドウ内の残り送信可能数。 */
  logBudget: number;
  logBudgetResetAt: number;
}

/**
 * クライアントへのファンアウト。
 *
 * 上流 P2P の WS を素通しするのではなく、サーバーで終端した正規化イベントを配る (§4)。
 * リバースプロキシのアイドル切断対策として ping/pong を必ず回す。劣化モード中は
 * 毎秒のフレーム通知が止まって無通信になりうるため、これは省略できない。
 */
export class ClientWebSocketServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    server: Server,
    private readonly config: Config,
    private readonly hub: Hub,
    private readonly demo: DemoRunner,
    /** クライアントの描画ログを記録する。未設定 (テストなど) なら何もしない。 */
    private readonly eventLog?: EventLog,
  ) {
    this.wss = new WebSocketServer({ server, path: ENDPOINTS.ws });

    // 'error' を放置すると Node の既定動作で未処理 'error' としてプロセスごと
    // 落ちる。ログするだけにして、他のクライアントへの配信は続ける。
    this.wss.on('error', (error) => log.error(`server error: ${describeError(error)}`));

    this.wss.on('connection', (socket, req) => {
      const client: Client = {
        socket,
        alive: true,
        logBudget: CLIENT_LOG_LIMIT_PER_WINDOW,
        logBudgetResetAt: Date.now() + CLIENT_LOG_WINDOW_MS,
      };
      this.clients.add(client);
      log.info(`client connected (${this.clients.size} total) from ${req.socket.remoteAddress}`);

      send(socket, { type: 'hello', protocolVersion: PROTOCOL_VERSION, snapshot: hub.getSnapshot() });

      socket.on('pong', () => {
        client.alive = true;
      });

      socket.on('message', (data) => {
        client.alive = true;
        try {
          const msg = JSON.parse(String(data)) as ClientMessage;
          if (msg.type === 'ping') {
            send(socket, { type: 'pong', time: new Date().toISOString() });
          } else if (msg.type === 'resync') {
            send(socket, {
              type: 'hello',
              protocolVersion: PROTOCOL_VERSION,
              snapshot: hub.getSnapshot(),
            });
          } else if (msg.type === 'demo') {
            // 不正な scenario (未知の文字列) は trigger 内部で検証して無視する
            this.demo.trigger(msg.scenario);
          } else if (msg.type === 'demo-stop') {
            this.demo.stop();
          } else if (msg.type === 'clientLog') {
            this.acceptClientLog(client, msg.log);
          }
        } catch (error) {
          log.debug(`bad client message: ${describeError(error as Error)}`);
        }
      });

      socket.on('error', (error) => log.debug(`client error: ${describeError(error)}`));

      socket.on('close', () => {
        this.clients.delete(client);
        log.info(`client disconnected (${this.clients.size} remaining)`);
      });
    });

    hub.on('event', (event) => this.broadcast(event));
  }

  start(): void {
    this.heartbeat = setInterval(() => {
      // pong が返らないまま次の周期に入った接続は死んだものとして畳む
      [...this.clients]
        .filter((client) => !client.alive)
        .forEach((client) => {
          log.debug('terminating unresponsive client');
          client.socket.terminate();
          this.clients.delete(client);
        });
      this.clients.forEach((client) => {
        client.alive = false;
        try {
          client.socket.ping();
        } catch (error) {
          log.debug(`ping failed: ${describeError(error as Error)}`);
        }
      });
    }, this.config.wsHeartbeatMs);
    this.heartbeat.unref?.();
  }

  stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.clients.forEach((client) => client.socket.close(1001, 'server shutting down'));
    this.clients.clear();
    return new Promise<void>((resolvePromise) => this.wss.close(() => resolvePromise()));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * クライアントからの描画ログ (`clientLog`) を記録する。
   *
   * キオスク用途なので厳密なトークンバケットは要らず、1 分あたり 30 件を
   * 超えた分は単純に捨てる (濫用対策)。
   */
  private acceptClientLog(client: Client, entry: ClientRenderLog): void {
    const now = Date.now();
    if (now >= client.logBudgetResetAt) {
      client.logBudget = CLIENT_LOG_LIMIT_PER_WINDOW;
      client.logBudgetResetAt = now + CLIENT_LOG_WINDOW_MS;
    }
    if (client.logBudget <= 0) return;
    client.logBudget -= 1;
    this.eventLog?.write('clientRender', {
      commit: entry.commit,
      builtAt: entry.builtAt,
      eewId: entry.eewId,
      waveMode: entry.waveMode,
      waveRadiusP: entry.waveRadiusP,
      waveRadiusS: entry.waveRadiusS,
      pointMode: entry.pointMode,
      layer: entry.layer,
      flash: entry.flash,
      zoom: entry.zoom,
    });
  }

  private broadcast(event: ServerEvent): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(event);
    this.clients.forEach((client) => {
      if (client.socket.readyState !== client.socket.OPEN) return;
      // 送信キューが詰まっている相手 (回線が細い/固まっている) には積み増さない
      if (client.socket.bufferedAmount > 1_000_000) {
        log.warn('dropping event for a backlogged client');
        return;
      }
      client.socket.send(payload);
    });
  }
}

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}
