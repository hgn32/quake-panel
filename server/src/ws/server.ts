import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { ENDPOINTS, PROTOCOL_VERSION, type ClientMessage, type ServerEvent } from '@quake-panel/shared';
import type { Config } from '../config.js';
import type { Hub } from '../hub.js';
import { createLogger, describeError } from '../logger.js';

const log = createLogger('ws');

interface Client {
  socket: WebSocket;
  alive: boolean;
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
  ) {
    this.wss = new WebSocketServer({ server, path: ENDPOINTS.ws });

    this.wss.on('connection', (socket, req) => {
      const client: Client = { socket, alive: true };
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
          }
        } catch (error) {
          log.debug(`bad client message: ${describeError(error)}`);
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
      for (const client of this.clients) {
        if (!client.alive) {
          // pong が返らないまま次の周期に入った接続は死んだものとして畳む
          log.debug('terminating unresponsive client');
          client.socket.terminate();
          this.clients.delete(client);
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch (error) {
          log.debug(`ping failed: ${describeError(error)}`);
        }
      }
    }, this.config.wsHeartbeatMs);
    this.heartbeat.unref?.();
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients) client.socket.close(1001, 'server shutting down');
    this.clients.clear();
    await new Promise<void>((resolvePromise) => this.wss.close(() => resolvePromise()));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private broadcast(event: ServerEvent): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.socket.readyState !== client.socket.OPEN) continue;
      // 送信キューが詰まっている相手 (回線が細い/固まっている) には積み増さない
      if (client.socket.bufferedAmount > 1_000_000) {
        log.warn('dropping event for a backlogged client');
        continue;
      }
      client.socket.send(payload);
    }
  }
}

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}
