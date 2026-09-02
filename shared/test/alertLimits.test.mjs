import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { remainingFlashMs } from '../dist/index.js';

describe('remainingFlashMs (明滅の残り時間)', () => {
  it('上限 0 は「止めない」なので null', () => {
    assert.equal(remainingFlashMs('2026-09-02T08:24:46.000Z', Date.now(), 0), null);
  });

  it('発表時刻が取れないときは上限いっぱい光らせる', () => {
    assert.equal(remainingFlashMs(null, Date.now(), 60), 60000);
  });

  it('パースできない文字列も上限いっぱい光らせる', () => {
    assert.equal(remainingFlashMs('not-a-date', Date.now(), 60), 60000);
  });

  it('発表から 10 秒後・上限 60 秒なら残り 50 秒', () => {
    const startedAt = '2026-09-02T08:24:46.000Z';
    const now = Date.parse(startedAt) + 10_000;
    assert.equal(remainingFlashMs(startedAt, now, 60), 50000);
  });

  it('【回帰】発表から 5 分後に開いた画面 (上限 60 秒) は残り 0 (光り直さない)', () => {
    // 「その画面が受け取った時刻」から数えていた旧実装では、発表から数分後に
    // ページを開いた画面が最初から光り直してしまっていた (不具合 D)。
    const startedAt = '2026-09-02T08:24:46.000Z';
    const now = Date.parse(startedAt) + 5 * 60 * 1000;
    assert.equal(remainingFlashMs(startedAt, now, 60), 0);
  });

  it('端末時計が発表より前でも上限いっぱい (負にならない)', () => {
    const startedAt = '2026-09-02T08:24:46.000Z';
    const now = Date.parse(startedAt) - 10_000;
    assert.equal(remainingFlashMs(startedAt, now, 60), 60000);
  });
});
