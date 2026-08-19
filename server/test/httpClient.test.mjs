import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { fetchBinary, fetchJson, HttpError } from '../dist/sources/httpClient.js';

/**
 * 上流 HTTP アクセス (server/src/sources/httpClient.ts) のタイムアウト・後始末。
 *
 * 上流には一切接続せず、ローカルの http サーバーで再現する。
 */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ヘッダは返すが本文を送らずに放置するサーバー (本文が止まる上流の再現)。 */
const startStalledServer = () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // 意図的に res.end() を呼ばない (本文が来ないまま接続だけ残る)。
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)).then(() => ({
    server,
    url: `http://127.0.0.1:${server.address().port}/`,
    // テスト自体が長時間ハングしないよう、時間切れになったら強制的に接続を切る安全弁。
    forceClose: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  }));
};

const startNotFoundServer = () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)).then(() => ({
    hits: () => hits,
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }));
};

describe('【回帰】httpClient のタイムアウトが本文読み取りにも効く', () => {
  it('fetchJson: ヘッダは届くが本文が止まるサーバーに対して timeoutMs で中断される', () =>
    startStalledServer().then(({ url, forceClose }) => {
      const start = Date.now();
      // timeoutMs (300ms) で中断されなければ、2 秒後の安全弁 (forceClose) で
      // 強制的に接続が切られる。前者で切れれば elapsed は 300ms 前後、
      // 後者でしか切れない (=修正前の挙動) 場合は 2000ms 前後になる。
      const watchdog = wait(2000).then(forceClose);
      const attempt = fetchJson(url, { timeoutMs: 300 }).then(
        () => Promise.reject(new Error('本文が来ないのに解決してしまった')),
        (error) => {
          const elapsed = Date.now() - start;
          assert.ok(
            elapsed < 1500,
            `本文読み取りが timeoutMs で中断されていない (${elapsed}ms 経過、安全弁で切られた可能性)`,
          );
          assert.ok(error instanceof Error);
        },
      );
      return Promise.all([attempt, watchdog]).then(() => forceClose());
    }));

  it('fetchBinary: ヘッダは届くが本文が止まるサーバーに対して timeoutMs で中断される', () =>
    startStalledServer().then(({ url, forceClose }) => {
      const start = Date.now();
      const watchdog = wait(2000).then(forceClose);
      const attempt = fetchBinary(url, { timeoutMs: 300 }).then(
        () => Promise.reject(new Error('本文が来ないのに解決してしまった')),
        (error) => {
          const elapsed = Date.now() - start;
          assert.ok(
            elapsed < 1500,
            `本文読み取りが timeoutMs で中断されていない (${elapsed}ms 経過、安全弁で切られた可能性)`,
          );
          assert.ok(error instanceof Error);
        },
      );
      return Promise.all([attempt, watchdog]).then(() => forceClose());
    }));
});

describe('エラー・404 応答の body 消費', () => {
  it('fetchJson: !ok な応答は HttpError で reject し、例外にならず後始末される', () =>
    startNotFoundServer().then(({ url, close }) =>
      fetchJson(url, { timeoutMs: 2000 })
        .then(
          () => assert.fail('reject されるはず'),
          (error) => {
            assert.ok(error instanceof HttpError);
            assert.equal(error.status, 404);
          },
        )
        .then(() => close()),
    ));

  it('fetchBinary: 404 は例外にならず null を返す', () =>
    startNotFoundServer().then(({ hits, url, close }) =>
      fetchBinary(url, { timeoutMs: 2000 })
        .then((result) => {
          assert.equal(result, null);
          assert.equal(hits(), 1);
        })
        .then(() => close()),
    ));

  it('fetchBinary: 404 を連続で取得しても資源が枯渇せず短時間で終わる (body 読み捨ての確認)', () => {
    const COUNT = 20;
    return startNotFoundServer().then(({ hits, url, close }) => {
      const start = Date.now();
      const requests = Array.from({ length: COUNT }, () => fetchBinary(url, { timeoutMs: 2000 }));
      return Promise.all(requests)
        .then((results) => {
          assert.equal(results.every((r) => r === null), true);
          assert.equal(hits(), COUNT);
          assert.ok(Date.now() - start < 5000, '404 の連続取得が想定より長くかかっている (body 未消費で詰まっている疑い)');
        })
        .then(() => close());
    });
  });
});
