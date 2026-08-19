import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 起動シーケンス (時刻同期・履歴取得) の途中、まだ `listen` していない段階で
 * SIGTERM/SIGINT を受けても、自力で graceful shutdown できることを確かめる。
 *
 * 以前は `registerShutdown()` (シグナルハンドラの登録) を `listen` 成功後
 * (= main の起動シーケンス完了後) に呼んでいた。そのため起動の途中でシグナルを
 * 受けるとハンドラが未登録で、Node の既定動作 (即死) になり graceful shutdown が
 * 一切走らなかった。単体では再現できないので、実際に子プロセスとして起動し、
 * わざと `listen` まで時間がかかる状態を作ってその途中でシグナルを送る。
 *
 * `203.0.113.1` (RFC 5737 の TEST-NET-3。誰にも割り当てられておらず、
 * 到達不能なまま応答が返らない) 宛てにすることで、上流アクセスを
 * 「即座に拒否される」のではなく「こちらの timeoutMs まで確実にハングする」
 * 状態にできる。これで `listen` に到達するまでの猶予を数秒単位で確保できるので、
 * 起動直後にシグナルを送っても「listen より前」であることをタイミングに
 * 依存せず保証できる。
 */

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../dist/index.js');

const BLACKHOLE = '203.0.113.1';

const ENV = {
  ...process.env,
  PORT: '0',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'info',
  KMONI_BASE_URL: `http://${BLACKHOLE}`,
  // clock.start() がここで確実にハングし続けるようにする (即座には失敗させない)
  KMONI_REQUEST_TIMEOUT_MS: '5000',
  P2P_WS_URL: `ws://${BLACKHOLE}:9`,
  // p2p.seedHistory() のタイムアウトは 8000ms 固定 (環境変数なし)。
  // ここも同じ理由でハングさせ、listen までの猶予を作る。
  P2P_HISTORY_URL: `http://${BLACKHOLE}`,
};

// SIGTERM を送るまでの待ち時間。モジュール読み込み・`registerShutdown()` の
// 実行には数十 ms もあれば十分な一方、上の ENV により listen までは
// 5000ms (clock) + 8000ms (p2p history) 前後かかる。この待ち時間なら
// 「ハンドラ登録は既に済んでいるが listen はまだ」を安定して再現できる。
const SEND_SIGNAL_AFTER_MS = 300;
const STOP_TIMEOUT_MS = 10_000;

const runEarlyShutdown = (signal) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));

    const stopTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${signal} を受けても ${STOP_TIMEOUT_MS}ms 以内に終了しなかった: ${output}`));
    }, STOP_TIMEOUT_MS);
    stopTimer.unref();

    child.once('exit', (code, killedBy) => {
      clearTimeout(stopTimer);
      resolvePromise({ code, killedBy, readOutput: () => output });
    });
    child.once('error', (error) => {
      clearTimeout(stopTimer);
      reject(error);
    });

    const sendTimer = setTimeout(() => child.kill(signal), SEND_SIGNAL_AFTER_MS);
    sendTimer.unref();
  });

describe('起動シーケンスの途中で受けたシグナル', () => {
  it('listen する前 (時刻同期・履歴取得の途中) に SIGTERM を送っても、自力で graceful shutdown する', () =>
    runEarlyShutdown('SIGTERM').then(({ code, killedBy, readOutput }) => {
      const output = readOutput();
      assert.equal(
        output.includes('listening on'),
        false,
        `listen まで進んでしまい、このテストの前提 (listen 前) が崩れている: ${output}`,
      );
      assert.equal(output.includes('ReferenceError'), false, `終了処理が例外になっている: ${output}`);
      assert.match(output, /received SIGTERM, shutting down/, `graceful shutdown のログが出ていない: ${output}`);
      assert.equal(killedBy, null, `シグナルで殺された (自力で終了していない): ${killedBy}`);
      assert.equal(code, 0, `終了コードが 0 ではない: ${code}`);
    }));
});
