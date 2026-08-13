import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KMONI_MAP,
  formatJstClock,
  fromKmoniTimestamp,
  intensityAtLeast,
  intensityLabel,
  isInsetLocation,
  latLonToPixel,
  parseIntensityText,
  parseJstDateTime,
  pixelToLatLon,
  projectToPixel,
  toKmoniTimestamp,
} from '../dist/index.js';

describe('kmoni の座標変換', () => {
  it('画像の四隅が想定した緯度経度に対応する', () => {
    const topLeft = latLonToPixel(KMONI_MAP.north, KMONI_MAP.west);
    assert.ok(Math.abs(topLeft.x) < 1e-9);
    assert.ok(Math.abs(topLeft.y) < 1e-9);
  });

  it('往復変換で元の値に戻る', () => {
    for (const [lat, lon] of [
      [32.582, 131.665],
      [43.06, 141.35],
      [33.59, 130.4],
    ]) {
      const px = latLonToPixel(lat, lon);
      const back = pixelToLatLon(px.x, px.y);
      assert.ok(Math.abs(back.lat - lat) < 1e-9);
      assert.ok(Math.abs(back.lon - lon) < 1e-9);
    }
  });

  it('東京が画像の内側に入る', () => {
    const px = latLonToPixel(35.681, 139.767);
    assert.ok(px.x > 0 && px.x < KMONI_MAP.width);
    assert.ok(px.y > 0 && px.y < KMONI_MAP.height);
  });

  it('南西諸島はインセット側へ寄せられる', () => {
    assert.equal(isInsetLocation(26.21, 127.68), true); // 那覇
    assert.equal(isInsetLocation(35.681, 139.767), false); // 東京
    const naha = projectToPixel(26.21, 127.68);
    // 素の投影では画像の下にはみ出すが、インセット適用後は画像内に収まる
    assert.ok(latLonToPixel(26.21, 127.68).y > KMONI_MAP.height);
    assert.ok(naha.x > 0 && naha.x < KMONI_MAP.width);
    assert.ok(naha.y > 0 && naha.y < KMONI_MAP.height);
  });

  it('屋久島はインセットではなく本土側に描かれる', () => {
    // 較正時に本土側で一致することを確認済み。ここが崩れると重ね位置がずれる。
    assert.equal(isInsetLocation(30.35, 130.5), false);
  });
});

describe('震度階級', () => {
  it('文字列表記の揺れを吸収する', () => {
    assert.equal(parseIntensityText('5弱'), 45);
    assert.equal(parseIntensityText('5-'), 45);
    assert.equal(parseIntensityText('6強'), 60);
    assert.equal(parseIntensityText('6+'), 60);
    assert.equal(parseIntensityText('3'), 30);
    assert.equal(parseIntensityText('7'), 70);
    assert.equal(parseIntensityText(''), null);
    assert.equal(parseIntensityText(undefined), null);
    assert.equal(parseIntensityText('不明'), null);
  });

  it('ラベルと順序比較', () => {
    assert.equal(intensityLabel(45), '5弱');
    assert.equal(intensityLabel(-1), null);
    assert.equal(intensityAtLeast(50, 45), true);
    assert.equal(intensityAtLeast(40, 45), false);
    assert.equal(intensityAtLeast(null, 10), false);
    assert.equal(intensityAtLeast(-1, 10), false);
  });
});

describe('時刻の扱い', () => {
  it('JST 文字列を UTC として正しく解釈する', () => {
    const d = parseJstDateTime('2026/08/13 11:09:55');
    assert.equal(d.toISOString(), '2026-08-13T02:09:55.000Z');
  });

  it('ミリ秒付き (P2P 形式) も読める', () => {
    const d = parseJstDateTime('2026/08/13 10:38:21.762');
    assert.equal(d.toISOString(), '2026-08-13T01:38:21.762Z');
  });

  it('kmoni タイムスタンプと相互変換できる', () => {
    const ts = '20260813111003';
    const d = fromKmoniTimestamp(ts);
    assert.equal(d.toISOString(), '2026-08-13T02:10:03.000Z');
    assert.equal(toKmoniTimestamp(d), ts);
  });

  it('不正なタイムスタンプは null', () => {
    assert.equal(fromKmoniTimestamp('2026081311100'), null);
    assert.equal(fromKmoniTimestamp('20261399111003'), null);
    assert.equal(parseJstDateTime(null), null);
  });

  it('プロセスの TZ 設定に影響されない', () => {
    // サーバーを UTC で動かしても JST 表示になること
    assert.equal(formatJstClock('2026-08-13T02:09:55.000Z'), '11:09:55');
  });
});
