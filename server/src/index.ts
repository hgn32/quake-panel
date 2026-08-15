import { loadConfig } from './config.js';
import { EewCoordinator } from './eew/coordinator.js';
import { createHttpServer } from './http/server.js';
import { Hub } from './hub.js';
import { HomeAssistantNotifier } from './haNotify.js';
import { createLogger, describeError, setLogLevel } from './logger.js';
import { applyGlobalProxy } from './proxy.js';
import { KmoniClock } from './sources/kmoniClock.js';
import { KmoniEewWorker } from './sources/kmoniEew.js';
import { KmoniFrameWorker } from './sources/kmoniFrames.js';
import { P2PClient } from './sources/p2pClient.js';
import { ClientWebSocketServer } from './ws/server.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // 社内プロキシ配下のときだけ上流アクセスをプロキシ経由に切り替える。
  // 環境変数が無ければ何もしないので、アドオン本番は直接接続のまま。
  const proxyUrl = applyGlobalProxy();
  if (proxyUrl !== null) log.info(`upstream via proxy ${proxyUrl}`);

  const hub = new Hub(config);
  const clock = new KmoniClock(config, hub);
  const frames = new KmoniFrameWorker(config, hub, clock);
  const coordinator = new EewCoordinator({
    config,
    hub,
    onActiveChange: (active) => frames.setEewActive(active),
  });
  const kmoniEew = new KmoniEewWorker(config, hub, clock, (report) => coordinator.acceptKmoni(report));
  const p2p = new P2PClient(config, hub, (eew) => coordinator.acceptP2P(eew));

  const httpServer = createHttpServer(config, hub, frames);
  const wsServer = new ClientWebSocketServer(httpServer, config, hub);
  // Home Assistant のアドオンとして動いているときだけ有効になる
  const haNotifier = new HomeAssistantNotifier(config, hub);

  // 時刻同期だけは先に済ませる。ここがずれていると最初のフレーム取得が全部 404 になる。
  await clock.start();
  coordinator.start();
  frames.start();
  kmoniEew.start();
  wsServer.start();
  await p2p.seedHistory();
  p2p.start();
  haNotifier.start();

  await new Promise<void>((resolvePromise, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => resolvePromise());
  });
  log.info(`listening on http://${config.host}:${config.port} (static: ${config.staticDir})`);
  log.info('データ提供: 防災科学技術研究所 強震モニタ / P2P地震情報');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    clock.stop();
    frames.stop();
    kmoniEew.stop();
    coordinator.stop();
    p2p.stop();
    haNotifier.stop();
    void wsServer.stop().then(() => {
      httpServer.close(() => process.exit(0));
      // 接続が残っていても一定時間で必ず落とす (コンテナ再起動を待たせない)
      setTimeout(() => process.exit(0), 5000).unref();
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandled rejection: ${describeError(reason)}`);
  });
}

main().catch((error) => {
  log.error(`startup failed: ${describeError(error)}`);
  process.exit(1);
});
