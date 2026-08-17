import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { applyGlobalProxy } from '../dist/proxy.js';
import { loadConfig } from '../dist/config.js';
import { WebhookNotifier } from '../dist/notify/webhookNotifier.js';

/**
 * EEW イベントを外部システムへ POST する webhook。
 *
 * 通知先はローカルネットワークを想定しているので、`applyGlobalProxy` で
 * グローバル dispatcher をプロキシに差し替えても影響を受けず、常に
 * 直接接続で届かなければならない (proxy.ts のコメント参照)。
 */

const EEW = {
  id: 'e1',
  reportNumber: 2,
  isFinal: false,
  isCancel: false,
  isTraining: false,
  isAssumption: false,
  alert: 'warning',
  hypocenter: { name: '日向灘', lat: 32.1, lon: 131.9, depthKm: 30, magnitude: 6.4 },
  maxIntensity: 50,
  originTime: null,
  announcedAt: null,
  receivedAt: '2026-08-16T01:00:00.000Z',
  regions: [],
  source: 'both',
};

/** JSON を受け取って記録するだけの受信サーバー。 */
const startReceiver = () => {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)).then(() => ({
    server,
    received,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }));
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeConfig = (urls) => loadConfig({ EEW_WEBHOOK_URL: urls.join(',') });

describe('WebhookNotifier', () => {
  it('handle() で正しい JSON (type/kind/sentAt/eew) が POST される', () =>
    startReceiver().then(({ received, url, close }) => {
      const notifier = new WebhookNotifier(makeConfig([url]));
      notifier.handle({ kind: 'new', eew: EEW });
      return wait(200)
        .then(() => {
          assert.equal(received.length, 1);
          const [{ headers, body }] = received;
          assert.equal(headers['content-type'], 'application/json');
          assert.equal(body.type, 'eew');
          assert.equal(body.kind, 'new');
          assert.ok(typeof body.sentAt === 'string' && !Number.isNaN(Date.parse(body.sentAt)));
          assert.deepEqual(body.eew, EEW);
        })
        .then(() => notifier.stop())
        .then(() => close());
    }));

  it('複数イベントを連続で handle() しても到着順が保たれる (直列化)', () =>
    startReceiver().then(({ received, url, close }) => {
      const notifier = new WebhookNotifier(makeConfig([url]));
      ['new', 'update', 'update', 'cancel'].forEach((kind) => notifier.handle({ kind, eew: EEW }));
      return wait(300)
        .then(() => {
          assert.deepEqual(
            received.map((r) => r.body.kind),
            ['new', 'update', 'update', 'cancel'],
          );
        })
        .then(() => notifier.stop())
        .then(() => close());
    }));

  it('送信先が落ちていても例外が外に漏れない', () => {
    // 127.0.0.1 の未使用ポートへの接続は即座に拒否される想定
    const notifier = new WebhookNotifier(makeConfig(['http://127.0.0.1:1/hook']));
    assert.doesNotThrow(() => notifier.handle({ kind: 'new', eew: EEW }));
    return wait(200).then(() => notifier.stop());
  });

  it('到達不能なプロキシを適用していても、ローカル受信サーバーへ直接届く', () =>
    startReceiver().then(({ received, url, close }) => {
      // node --test はファイルごとに別プロセスなので、ここでのグローバル汚染は
      // 他のテストファイルに影響しない。
      applyGlobalProxy({ UPSTREAM_API_PROXY_URL: 'http://127.0.0.1:1/' });
      const notifier = new WebhookNotifier(makeConfig([url]));
      notifier.handle({ kind: 'new', eew: EEW });
      return wait(200)
        .then(() => {
          assert.equal(received.length, 1, 'プロキシに阻まれず直接届いているはず');
        })
        .then(() => notifier.stop())
        .then(() => close());
    }));
});
