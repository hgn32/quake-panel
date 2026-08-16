import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * SIGTERM / SIGINT でサーバーが自分で終了できることを、実際に起動して確かめる。
 *
 * 終了処理 (`shutdown`) は `main()` の `return` より後ろに置くと、listen 後に
 * 呼ばれる `registerShutdown()` から見て未初期化 (TDZ) になり、シグナルを受けた
 * 瞬間に ReferenceError になる。プロセスが落ちないのでポートが掴まれたままになり、
 * 次の起動が EADDRINUSE で失敗する = 「起動しない」に化ける。
 * 単体では捕まえられないので、子プロセスとして起動して実際にシグナルを送る。
 */

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '../dist/index.js');

// 上流 (kmoni / P2P地震情報) へは出ない。到達しないローカルポートへ向けて即座に
// 失敗させ、劣化モードのまま listen まで進ませる。
const ENV = {
  ...process.env,
  PORT: '0',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'info',
  KMONI_BASE_URL: 'http://127.0.0.1:9',
  KMONI_REQUEST_TIMEOUT_MS: '500',
  P2P_WS_URL: 'ws://127.0.0.1:9',
  P2P_HISTORY_URL: 'http://127.0.0.1:9',
};

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;

/** listen のログが出るまで待つ。出力は終了後の検査用に貯めておく。 */
const startServer = () =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let started = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`起動が ${START_TIMEOUT_MS}ms 以内に終わらなかった: ${output}`));
    }, START_TIMEOUT_MS);
    timer.unref();

    const onChunk = (chunk) => {
      output += String(chunk);
      if (started || !output.includes('listening on')) return;
      started = true;
      clearTimeout(timer);
      resolvePromise({ child, readOutput: () => output });
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (started) return;
      clearTimeout(timer);
      reject(new Error(`listen する前に終了した (code=${code}): ${output}`));
    });
  });

/** シグナルを送り、自力で終了するのを待つ。落ちなければ SIGKILL で始末して失敗させる。 */
const stopServer = (child, signal) =>
  new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${signal} を受けても ${STOP_TIMEOUT_MS}ms 以内に終了しなかった`));
    }, STOP_TIMEOUT_MS);
    timer.unref();

    child.once('exit', (code, killedBy) => {
      clearTimeout(timer);
      resolvePromise({ code, killedBy });
    });
    child.kill(signal);
  });

describe('シグナルでの停止', () => {
  it('SIGTERM で自分から終了する (ReferenceError で残らない)', () => {
    return startServer().then(({ child, readOutput }) =>
      stopServer(child, 'SIGTERM').then(({ code, killedBy }) => {
        const output = readOutput();
        assert.equal(
          output.includes('ReferenceError'),
          false,
          `終了処理が例外になっている: ${output}`,
        );
        assert.match(output, /received SIGTERM, shutting down/);
        assert.equal(killedBy, null, `シグナルで殺された (自力で終了していない): ${killedBy}`);
        assert.equal(code, 0, `終了コードが 0 ではない: ${code}`);
      }),
    );
  });

  it('SIGINT (Ctrl+C) でも同じように終了する', () => {
    return startServer().then(({ child, readOutput }) =>
      stopServer(child, 'SIGINT').then(({ code }) => {
        const output = readOutput();
        assert.equal(
          output.includes('ReferenceError'),
          false,
          `終了処理が例外になっている: ${output}`,
        );
        assert.match(output, /received SIGINT, shutting down/);
        assert.equal(code, 0, `終了コードが 0 ではない: ${code}`);
      }),
    );
  });
});
