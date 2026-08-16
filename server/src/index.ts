import { loadConfig } from './config.js';
import { EewCoordinator } from './eew/coordinator.js';
import { createHttpServer } from './http/server.js';
import { Hub } from './hub.js';
import { createLogger, describeError, setLogLevel } from './logger.js';
import { applyGlobalProxy } from './proxy.js';
import { KmoniClock } from './sources/kmoniClock.js';
import { KmoniEewWorker } from './sources/kmoniEew.js';
import { KmoniFrameWorker } from './sources/kmoniFrames.js';
import { P2PClient } from './sources/p2pClient.js';
import { ClientWebSocketServer } from './ws/server.js';

const log = createLogger('main');

function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  // プロキシが指定されているときだけ上流アクセスをプロキシ経由に切り替える。
  // 環境変数が無ければ何もしないので、既定は直接接続のまま。
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

  // 終了処理は `return` より前に定義する。`registerShutdown` は listen 後
  // (= main が return した後) に呼ばれるので、`return` の後ろに置くと
  // `shutdown` が初期化されないまま参照され、SIGTERM/SIGINT で
  // ReferenceError になって停止できなくなる (ポートが掴まれたままになる)。
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
    void wsServer.stop().then(() => {
      httpServer.close(() => process.exit(0));
      // 接続が残っていても一定時間で必ず落とす (コンテナ再起動を待たせない)
      setTimeout(() => process.exit(0), 5000).unref();
    });
  };
  const registerShutdown = (): void => {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason: Error) => {
      log.error(`unhandled rejection: ${describeError(reason)}`);
    });
  };

  // 時刻同期だけは先に済ませる。ここがずれていると最初のフレーム取得が全部 404 になる。
  return clock
    .start()
    .then(() => {
      coordinator.start();
      frames.start();
      kmoniEew.start();
      wsServer.start();
      return p2p.seedHistory();
    })
    .then(() => {
      p2p.start();
      return new Promise<void>((resolvePromise, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => resolvePromise());
      });
    })
    .then(() => {
      log.info(`listening on http://${config.host}:${config.port} (static: ${config.staticDir})`);
      log.info('データ提供: 防災科学技術研究所 強震モニタ / P2P地震情報');
      registerShutdown();
    });
}

main().catch((error: Error) => {
  log.error(`startup failed: ${describeError(error)}`);
  process.exit(1);
});
