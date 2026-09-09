import { tsunamiGradeRank, type TsunamiArea } from '@quake-panel/shared';
import { loadConfig } from './config.js';
import { DemoRunner } from './demo/runner.js';
import { EewCoordinator } from './eew/coordinator.js';
import { createHttpServer } from './http/server.js';
import { Hub } from './hub.js';
import { createLogger, describeError, setLogLevel } from './logger.js';
import { EventLog } from './notify/eventLog.js';
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
  // 地震イベントの事実記録 (JSONL)。dir が空なら EventLog 自身が何もしなくなる。
  const eventLog = new EventLog(config);
  const clock = new KmoniClock(config, hub);
  const frames = new KmoniFrameWorker(config, hub, clock, eventLog);
  // URL が設定されているときだけ生成する。生成しなければ既存動作への影響はゼロ。
  const webhookNotifier =
    config.eewWebhook.urls.length > 0 ? new WebhookNotifier(config, eventLog) : null;
  if (webhookNotifier) log.info(`eew webhook to ${config.eewWebhook.urls.join(', ')}`);
  const coordinator = new EewCoordinator({
    config,
    hub,
    onActiveChange: (active) => frames.setEewActive(active),
    onEewEvent: (event) => webhookNotifier?.handle(event),
    onLog: (data) => eventLog.write('eew', data),
  });
  const kmoniEew = new KmoniEewWorker(
    config,
    hub,
    clock,
    (report) => coordinator.acceptKmoni(report),
    eventLog,
    () => frames.isEewActive(),
  );
  const p2p = new P2PClient(config, hub, (eew) => coordinator.acceptP2P(eew));

  // 地震情報・EEW 発表検出・津波は抑止なく配信されるので、Hub の配信経路をそのまま
  // 記録に使う (EEW だけは webhook 抑止・焼き直し破棄も追いたいので coordinator.onLog
  // で別に配線している。上のコメント参照)。
  hub.on('event', (event) => {
    if (event.type === 'quake') {
      eventLog.write('quake', {
        id: event.quake.id,
        occurredAt: event.quake.occurredAt,
        hypocenter: { ...event.quake.hypocenter },
        maxIntensity: event.quake.maxIntensity,
      });
    } else if (event.type === 'eewDetection') {
      eventLog.write('eewDetection', { id: event.detection.id, kind: event.detection.kind });
    } else if (event.type === 'tsunami') {
      eventLog.write('tsunami', {
        id: event.tsunami.id,
        cancelled: event.tsunami.cancelled,
        areaCount: event.tsunami.areas.length,
        maxGrade: maxTsunamiGrade(event.tsunami.areas),
      });
    }
  });

  // 実際の地震発生を待たずに動作確認するためのデモ再生。発火は設定画面のボタンのみ
  // (専用の HTTP エンドポイントは作らない)。Hub の通常配信経路にそのまま乗せるので、
  // 詳しい理由は demo/runner.ts のコメントを参照。
  // デモの EEW も実電文と同様に webhook へ流す (id が demo- 接頭辞なので受信側で区別できる)。
  const demo = new DemoRunner(hub, (event) => webhookNotifier?.handle(event));

  const httpServer = createHttpServer(config, hub, frames);
  const wsServer = new ClientWebSocketServer(httpServer, config, hub, demo, eventLog);

  // 終了処理の定義とハンドラ登録は、起動シーケンス (時刻同期・履歴取得。
  // 合わせて最長十数秒かかりうる) に入る前、各コンポーネントの生成が
  // 終わった直後にここで済ませる。以前は `registerShutdown` を起動シーケンス
  // 完了後 (listen 成功後) に呼んでいたが、それだと起動の途中で SIGTERM/SIGINT
  // を受けたときにハンドラが未登録のままで、既定動作 (即死) になって
  // graceful shutdown が一切走らなかった。ここで参照する各コンポーネントは
  // すべてこの時点で生成済みなので、まだ `start()` していない状態で `stop()`
  // を呼んでも例外にはならない (調査済み)。listen 前に `httpServer.close()`
  // を呼んでもコールバックは呼ばれる (`ERR_SERVER_NOT_RUNNING` が引数に
  // 渡ってくるだけ) ので、終了処理はどの段階でシグナルを受けても完走する。
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    // 接続が残っていても一定時間で必ず落とす (コンテナ再起動を待たせない)。
    // `wss.close()` 等のコールバックが何らかの理由で返らなくても、この
    // フォールバックだけは各 stop() 呼び出しより前に必ず仕込んでおく。
    setTimeout(() => process.exit(0), 5000).unref();
    clock.stop();
    frames.stop();
    kmoniEew.stop();
    coordinator.stop();
    webhookNotifier?.stop();
    eventLog.stop();
    p2p.stop();
    void wsServer.stop().then(() => {
      httpServer.close(() => process.exit(0));
    });
  };
  const registerShutdown = (): void => {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason: Error) => {
      log.error(`unhandled rejection: ${describeError(reason)}`);
    });
  };
  registerShutdown();

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
    });
}

/** 津波予報区の中で最も重いグレード。区が無ければ null。 */
function maxTsunamiGrade(areas: TsunamiArea[]): TsunamiArea['grade'] | null {
  return areas.reduce<TsunamiArea['grade'] | null>(
    (worst, area) =>
      worst === null || tsunamiGradeRank(area.grade) > tsunamiGradeRank(worst) ? area.grade : worst,
    null,
  );
}

main().catch((error: Error) => {
  log.error(`startup failed: ${describeError(error)}`);
  process.exit(1);
});
