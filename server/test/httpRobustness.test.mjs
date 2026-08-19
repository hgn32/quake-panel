import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';
import { createHttpServer } from '../dist/http/server.js';
import { Hub } from '../dist/hub.js';
import { KmoniClock } from '../dist/sources/kmoniClock.js';
import { KmoniFrameWorker } from '../dist/sources/kmoniFrames.js';

/**
 * `decodeURIComponent` は不正な %-エンコード (`/%zz` など) を渡されると
 * 同期的に `URIError` を投げる。これを `handle(req, res).catch(...)` という
 * Promise チェーンだけで受けようとすると、同期 throw は `.catch` に乗る前に
 * 素通しされて uncaughtException になり、プロセスごと落ちる (実機で再現確認済み)。
 *
 * ここでは実際に HTTP サーバーを起動し、不正なパスへ実際にリクエストを送って
 * 「400 が返る」「その後もプロセスが生きていて次のリクエストに応答できる」
 * ことの両方を確かめる。
 */

const get = (port, path) =>
  new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });

/** テストの間だけ、上流に一切出ない最小構成の HTTP サーバーを起動する。 */
const withServer = (run) => {
  const config = loadConfig({ STATIC_DIR: 'public' });
  const hub = new Hub(config);
  const clock = new KmoniClock(config, hub);
  const frames = new KmoniFrameWorker(config, hub, clock);
  const httpServer = createHttpServer(config, hub, frames);

  return new Promise((resolvePromise) => httpServer.listen(0, '127.0.0.1', resolvePromise)).then(() => {
    const port = httpServer.address().port;
    return run(port).finally(() => new Promise((resolvePromise) => httpServer.close(resolvePromise)));
  });
};

describe('不正な %-エンコード URL', () => {
  it('/%zz を投げても 400 が返り、プロセスは落ちない', () =>
    withServer((port) =>
      get(port, '/%zz').then(({ status }) => {
        assert.equal(status, 400, `不正な URL に 400 以外が返った: ${status}`);
      }),
    ));

  it('不正な URL を送った直後でも、次の正常なリクエストに普通に応答する', () =>
    withServer((port) =>
      get(port, '/%zz')
        .then(({ status }) => assert.equal(status, 400))
        .then(() => get(port, '/healthz'))
        .then(({ status, body }) => {
          assert.ok(status === 200 || status === 503, `/healthz が応答しなかった: ${status}`);
          assert.doesNotThrow(() => JSON.parse(body));
        }),
    ));
});
