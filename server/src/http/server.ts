import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { Config } from '../config.js';
import type { Hub } from '../hub.js';
import { createLogger, describeError } from '../logger.js';
import type { FrameLayer, KmoniFrameWorker } from '../sources/kmoniFrames.js';
import { serveStatic } from './static.js';

const log = createLogger('http');

const FRAME_ROUTES: Array<{ prefix: string; layer: FrameLayer }> = [
  { prefix: '/kmoni/frame/', layer: 'realtime' },
  { prefix: '/kmoni/pswave/', layer: 'psWave' },
  { prefix: '/kmoni/estshindo/', layer: 'estShindo' },
];

const LATEST_ROUTES: Record<string, FrameLayer> = {
  '/kmoni/latest.gif': 'realtime',
  '/kmoni/pswave/latest.gif': 'psWave',
  '/kmoni/estshindo/latest.gif': 'estShindo',
};

/**
 * クライアント向けの HTTP。
 *
 * kmoni へはクライアントから直接行かせず、必ずここを通す (§4)。
 * これで混在コンテンツ問題が消え、外部への負荷もクライアント数に依存しなくなる。
 */
export function createHttpServer(
  config: Config,
  hub: Hub,
  frames: KmoniFrameWorker,
): Server {
  const staticRoot = resolve(config.staticDir);

  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      log.error(`request failed: ${describeError(error)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      if (!res.writableEnded) res.end('internal error');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }

    if (path === '/healthz') {
      const health = hub.getHealth();
      // 劣化モードでも P2P が生きていればサービスとしては継続している。
      sendJson(res, health.p2p.ok || !health.degraded ? 200 : 503, health);
      return;
    }

    if (path === '/api/state') {
      sendJson(res, 200, hub.getSnapshot());
      return;
    }

    const latestLayer = LATEST_ROUTES[path];
    if (latestLayer) {
      sendImage(res, frames.getLatest(latestLayer), 'no-store');
      return;
    }

    for (const route of FRAME_ROUTES) {
      if (!path.startsWith(route.prefix)) continue;
      const timestamp = path.slice(route.prefix.length).replace(/\.gif$/, '');
      if (!/^\d{14}$/.test(timestamp)) break;
      sendImage(res, frames.getImage(route.layer, timestamp), 'immutable');
      return;
    }

    if (await serveStatic(staticRoot, path, res)) return;

    // SPA ではないが、キオスクの URL 直打ちに備えて index.html へ寄せる
    if (!path.startsWith('/api/') && !path.startsWith('/kmoni/')) {
      if (await serveStatic(staticRoot, '/index.html', res)) return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendImage(
  res: ServerResponse,
  image: { body: Buffer; contentType: string; timestamp: string } | null,
  // タイムスタンプ付き URL の中身は二度と変わらない。latest.gif は毎秒変わる。
  cache: 'immutable' | 'no-store',
): void {
  if (!image) {
    res.writeHead(404, { 'cache-control': 'no-store' }).end();
    return;
  }
  res.writeHead(200, {
    'content-type': image.contentType,
    'content-length': image.body.length,
    'cache-control': cache === 'immutable' ? 'public, max-age=3600, immutable' : 'no-store',
    'x-kmoni-timestamp': image.timestamp,
  });
  res.end(image.body);
}
