import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { findAreaAtPixel, pointInRing, projectToPixel } from '../dist/index.js';

/** 実際に配信している背景地図で確かめる (座標変換込みで壊れていないこと) */
const basemap = JSON.parse(
  readFileSync(new URL('../../client/public/assets/japan-map.json', import.meta.url), 'utf8'),
);

const prefectureAt = (lat, lon) => {
  const p = projectToPixel(lat, lon);
  return findAreaAtPixel(basemap.prefectures, p.x, p.y);
};

describe('多角形の内外判定', () => {
  it('単純な四角', () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    assert.equal(pointInRing(square, 5, 5), true);
    assert.equal(pointInRing(square, 15, 5), false);
    assert.equal(pointInRing(square, 5, -1), false);
  });

  it('点が足りない環は常に外', () => {
    assert.equal(pointInRing([0, 0, 1, 1], 0, 0), false);
    assert.equal(pointInRing([], 0, 0), false);
  });
});

describe('座標から都道府県を引く', () => {
  it('主要都市がその都道府県になる', () => {
    assert.equal(prefectureAt(35.681, 139.767), '東京都'); // 東京駅
    assert.equal(prefectureAt(34.702, 135.495), '大阪府'); // 大阪駅
    assert.equal(prefectureAt(43.068, 141.351), '北海道'); // 札幌駅
    assert.equal(prefectureAt(33.59, 130.42), '福岡県'); // 博多駅
  });

  it('インセットへ寄せられる南西諸島でも引ける', () => {
    // 那覇は素の投影だと画像の外に出るが、インセット適用後の座標で判定する
    assert.equal(prefectureAt(26.21, 127.68), '沖縄県');
  });

  it('海上は null (利用地の県が分からないときは強調しない)', () => {
    assert.equal(prefectureAt(39.0, 137.0), null); // 日本海の沖合
    assert.equal(prefectureAt(34.0, 140.5), null); // 房総半島の沖合
  });
});
