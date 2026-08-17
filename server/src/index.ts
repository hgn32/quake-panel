import { loadConfig } from './config.js';
import { DemoRunner } from './demo/runner.js';
import { EewCoordinator } from './eew/coordinator.js';
import { createHttpServer } from './http/server.js';
import { Hub } from './hub.js';
import { createLogger, describeError, setLogLevel } from './logger.js';
import { WebhookNotifier } from './notify/webhookNotifier.js';
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
  // URL が設定されているときだけ生成する。生成しなければ既存動作への影響はゼロ。
  const webhookNotifier =
    config.eewWebhook.urls.length > 0 ? new WebhookNotifier(config) : null;
  if (webhookNotifier) log.info(`eew webhook to ${config.eewWebhook.urls.join(', ')}`);
  const coordinator = new EewCoordinator({
    config,
    hub,
    onActiveChange: (active) => frames.setEewActive(active),
    onEewEvent: (event) => webhookNotifier?.handle(event),
  });
  const kmoniEew = new KmoniEewWorker(config, hub, clock, (report) => coordinator.acceptKmoni(report));
  const p2p = new P2PClient(config, hub, (eew) => coordinator.acceptP2P(eew));

  // 実際の地震発生を待たずに動作確認するためのデモ再生。発火は設定画面のボタンのみ
  // (専用の HTTP エンドポイントは作らない)。Hub の通常配信経路にそのまま乗せるので、
  // 詳しい理由は demo/runner.ts のコメントを参照。
  // デモの EEW も実電文と同様に webhook へ流す (id が demo- 接頭辞なので受信側で区別できる)。
  const demo = new DemoRunner(hub, (event) => webhookNotifier?.handle(event));

  const httpServer = createHttpServer(config, hub, frames);
  const wsServer = new ClientWebSocketServer(httpServer, config, hub, demo);

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
    webhookNotifier?.stop();
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
