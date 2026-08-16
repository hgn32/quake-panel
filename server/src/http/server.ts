import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ENDPOINTS, parseKmoniLayer } from '@quake-panel/shared';
import type { Config } from '../config.js';
import type { Hub } from '../hub.js';
import { createLogger, describeError } from '../logger.js';
import type { FrameLayer, KmoniFrameWorker } from '../sources/kmoniFrames.js';
import { resolveStaticRoot, serveStatic } from './static.js';

const log = createLogger('http');

/** EEW 発表中の補助レイヤ。観測画像は指標を含む別のルートで扱う。 */
const FRAME_ROUTES: Array<{ prefix: string; layer: FrameLayer }> = [
  { prefix: '/kmoni/pswave/', layer: 'psWave' },
  { prefix: '/kmoni/estshindo/', layer: 'estShindo' },
];

/** `/kmoni/frame/{指標}/{時刻}.gif` */
const FRAME_PATTERN = /^\/kmoni\/frame\/([a-z]+)\/(\d{14})\.gif$/;

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
  // `config.staticDir` はリポジトリルートからの相対パス。cwd (dev/prod で異なる)
  // に左右されないよう、このモジュール自身の位置を起点に解決する (static.ts 参照)。
  const staticRoot = resolveStaticRoot(import.meta.url, config.staticDir);

  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      log.error(`request failed: ${describeError(error)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      if (!res.writableEnded) res.end('internal error');
    });
  });

  function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const path = url.split('?')[0] ?? '/';

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return Promise.resolve();
    }

    if (path === '/healthz') {
      const health = hub.getHealth();
      // 劣化モードでも P2P が生きていればサービスとしては継続している。
      sendJson(res, health.p2p.ok || !health.degraded ? 200 : 503, health);
      return Promise.resolve();
    }

    if (path === '/api/state') {
      sendJson(res, 200, hub.getSnapshot());
      return Promise.resolve();
    }

    // 直接アクセス用。サーバーが既定で取っている指標の最新画像を返す。
    if (path === ENDPOINTS.latestFrame) {
      sendImage(res, frames.getLatest(frames.defaultLayer), 'no-store');
      return Promise.resolve();
    }
    if (path === '/kmoni/pswave/latest.gif' || path === '/kmoni/estshindo/latest.gif') {
      sendImage(res, frames.getLatest(path.includes('pswave') ? 'psWave' : 'estShindo'), 'no-store');
      return Promise.resolve();
    }

    // 観測画像。端末が選んだ指標をここで受ける。既定以外は普段取っていないので、
    // 初回だけ取りに行き、以後しばらくは毎秒の取得対象へ加える (kmoniFrames 側)。
    const frameMatch = FRAME_PATTERN.exec(path);
    if (frameMatch) {
      const layer = parseKmoniLayer(frameMatch[1]);
      const timestamp = frameMatch[2];
      if (!layer || !timestamp) {
        res.writeHead(404, { 'cache-control': 'no-store' }).end();
        return Promise.resolve();
      }
      return frames.requestImage(layer, timestamp).then((image) => {
        sendImage(res, image, 'immutable');
      });
    }

    const auxRoute = FRAME_ROUTES.find((route) => path.startsWith(route.prefix));
    if (auxRoute) {
      const timestamp = path.slice(auxRoute.prefix.length).replace(/\.gif$/, '');
      if (/^\d{14}$/.test(timestamp)) {
        sendImage(res, frames.getImage(auxRoute.layer, timestamp), 'immutable');
        return Promise.resolve();
      }
    }

    const isAppPath = !path.startsWith('/api/') && !path.startsWith('/kmoni/');
    return serveStatic(staticRoot, path, res)
      .then((served) => {
        if (served) return true;
        // SPA ではないが、キオスクの URL 直打ちに備えて index.html へ寄せる
        if (!isAppPath) return false;
        return serveStatic(staticRoot, '/index.html', res);
      })
      .then((served) => {
        if (!served) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
        }
      });
  }
}

/** 返すのは現況・死活・座標のいずれかで、どれもただのオブジェクト */
function sendJson(res: ServerResponse, status: number, payload: object): void {
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
