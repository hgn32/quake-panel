import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';
import { KmoniFrameWorker, isRequestableTimestamp } from '../dist/sources/kmoniFrames.js';

/**
 * kmoni フレーム要求 (server/src/sources/kmoniFrames.ts) のタイムスタンプ検証。
 *
 * `/kmoni/frame/{layer}/{14桁}.gif` は任意の 14 桁を受け付けてしまうと、端末の
 * 時計ズレやスクラブ操作のたびに上流 NIED へ取りに行ってしまう。ここでは
 * isRequestableTimestamp の境界値と、requestImage が範囲外なら実際に上流へ
 * アクセスしないことを確認する (上流には接続しない偽サーバーで検証)。
 */

/** kmoni タイムスタンプ ("YYYYMMDDhhmmss", JST) を Date から作る。shared に依存しないための簡易版。 */
const toKmoniTimestamp = (date) => {
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${j.getUTCFullYear()}${pad(j.getUTCMonth() + 1)}${pad(j.getUTCDate())}` +
    `${pad(j.getUTCHours())}${pad(j.getUTCMinutes())}${pad(j.getUTCSeconds())}`
  );
};

/** アクセス回数を数えるだけの偽 kmoni サーバー (常に 404: まだ生成されていない画像と同じ扱い)。 */
const startCountingServer = () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)).then(() => ({
    hits: () => hits,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }));
};

/** KmoniFrameWorker の依存 (hub / clock) はこの検証に無関係なのでフェイクで代替する。 */
const stubHub = { markFailure() {}, markSuccess() {}, publishFrame() {} };
const stubClock = { latestAvailable: () => new Date(), kmoniNow: () => new Date() };

describe('isRequestableTimestamp', () => {
  it('14桁形式でなければ拒否する', () => {
    assert.equal(isRequestableTimestamp('not-a-timestamp', Date.now()), false);
    assert.equal(isRequestableTimestamp('202608171110', Date.now()), false);
  });

  it('実在しない日時 (13月など) は拒否する', () => {
    assert.equal(isRequestableTimestamp('20261399235959', Date.now()), false);
  });

  it('過去 5 分より古いと拒否する', () => {
    const now = Date.now();
    const old = toKmoniTimestamp(new Date(now - 6 * 60 * 1000));
    assert.equal(isRequestableTimestamp(old, now), false);
  });

  it('未来 15 秒を超えると拒否する', () => {
    const now = Date.now();
    const tooFuture = toKmoniTimestamp(new Date(now + 20 * 1000));
    assert.equal(isRequestableTimestamp(tooFuture, now), false);
  });

  it('直近 (数十秒前) や、ごくわずかな未来は許可する', () => {
    const now = Date.now();
    assert.equal(isRequestableTimestamp(toKmoniTimestamp(new Date(now - 10 * 1000)), now), true);
    assert.equal(isRequestableTimestamp(toKmoniTimestamp(new Date(now + 5 * 1000)), now), true);
  });
});

describe('【回帰】KmoniFrameWorker#requestImage のタイムスタンプ検証', () => {
  it('範囲外のタイムスタンプは上流へ取りに行かず null を返す', () =>
    startCountingServer().then(({ hits, url, close }) => {
      const config = loadConfig({ KMONI_BASE_URL: url });
      const worker = new KmoniFrameWorker(config, stubHub, stubClock);
      const outOfRange = toKmoniTimestamp(new Date(Date.now() - 60 * 60 * 1000)); // 1時間前
      return worker
        .requestImage(config.kmoni.layer, outOfRange)
        .then((image) => {
          assert.equal(image, null);
          assert.equal(hits(), 0, '範囲外のタイムスタンプなのに上流へアクセスしてしまっている');
        })
        .then(() => close());
    }));

  it('不正な形式のタイムスタンプも上流へ取りに行かず null を返す', () =>
    startCountingServer().then(({ hits, url, close }) => {
      const config = loadConfig({ KMONI_BASE_URL: url });
      const worker = new KmoniFrameWorker(config, stubHub, stubClock);
      return worker
        .requestImage(config.kmoni.layer, '99999999999999')
        .then((image) => {
          assert.equal(image, null);
          assert.equal(hits(), 0, '不正なタイムスタンプなのに上流へアクセスしてしまっている');
        })
        .then(() => close());
    }));

  it('範囲内のタイムスタンプは (キャッシュに無ければ) 上流へ取りに行く', () =>
    startCountingServer().then(({ hits, url, close }) => {
      const config = loadConfig({ KMONI_BASE_URL: url });
      const worker = new KmoniFrameWorker(config, stubHub, stubClock);
      const recent = toKmoniTimestamp(new Date(Date.now() - 5 * 1000));
      return worker
        .requestImage(config.kmoni.layer, recent)
        .then((image) => {
          assert.equal(image, null); // 偽サーバーは常に 404 (未生成扱い)
          assert.equal(hits(), 1, '範囲内のタイムスタンプなのに上流へアクセスしていない');
        })
        .then(() => close());
    }));
});
