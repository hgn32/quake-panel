import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_SIDE_WIDTH, SIDE_SIZE_LIMITS, clampSideSize } from '../dist/index.js';

describe('地図と地震情報の境目', () => {
  it('範囲内ならそのまま (小数は丸める)', () => {
    assert.equal(clampSideSize(500, 1920, 'width'), 500);
    assert.equal(clampSideSize(500.4, 1920, 'width'), 500);
    assert.equal(clampSideSize(300, 900, 'height'), 300);
  });

  it('狭くしすぎるとパネルが読めなくなるので下限で止める', () => {
    assert.equal(clampSideSize(10, 1920, 'width'), SIDE_SIZE_LIMITS.width.min);
    assert.equal(clampSideSize(-500, 1920, 'width'), SIDE_SIZE_LIMITS.width.min);
    assert.equal(clampSideSize(0, 900, 'height'), SIDE_SIZE_LIMITS.height.min);
  });

  it('地図が潰れるほど広げられない (画面に対する割合で止める)', () => {
    assert.equal(clampSideSize(5000, 1000, 'width'), 600);
    assert.equal(clampSideSize(5000, 800, 'height'), 560);
  });

  it('画面が下限より小さいときは上限を優先する (はみ出させない)', () => {
    // 幅 300px の画面では下限 260px も入らない。0.6 倍の 180px に収める。
    assert.equal(clampSideSize(260, 300, 'width'), 180);
  });

  it('既定値は画面が普通の広さなら変わらない', () => {
    assert.equal(clampSideSize(DEFAULT_SIDE_WIDTH, 1920, 'width'), DEFAULT_SIDE_WIDTH);
  });

  it('壊れた値でも落ちない', () => {
    assert.equal(clampSideSize(Number.NaN, 1920, 'width'), SIDE_SIZE_LIMITS.width.min);
    assert.equal(clampSideSize(400, 0, 'width'), SIDE_SIZE_LIMITS.width.min);
    assert.equal(clampSideSize(400, Number.POSITIVE_INFINITY, 'width'), SIDE_SIZE_LIMITS.width.min);
  });
});
