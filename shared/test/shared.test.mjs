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
  unprojectFromPixel,
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

  it('壊れた文字列を震度として受理しない (Number.parseInt の先頭数字読みの回帰)', () => {
    // 旧実装は Number.parseInt が先頭の数字だけ読んで残りを無視するため、
    // '1e2' が 10 (震度1)、'7km' が 70 (震度7) に化けていた。
    assert.equal(parseIntensityText('1e2'), null);
    assert.equal(parseIntensityText('7km'), null);
    assert.equal(parseIntensityText('40'), null);
    assert.equal(parseIntensityText('7.0'), null);
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

  it('1〜2 桁のミリ秒は小数部として解釈する (絶対値として足さない)', () => {
    // 旧実装は Number(ms) をそのまま足していたため、'.5' が 5ms、'.76' が
    // 76ms になっていた (正しくは小数部として 500ms, 760ms)。
    assert.equal(parseJstDateTime('2026/08/13 10:38:21.5').toISOString(), '2026-08-13T01:38:21.500Z');
    assert.equal(parseJstDateTime('2026/08/13 10:38:21.76').toISOString(), '2026-08-13T01:38:21.760Z');
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

  it('実在しない日付・範囲外の時刻はロールオーバーさせず null にする', () => {
    // 旧実装は d <= 31 / h <= 23 のような桁数だけの範囲チェックだったため、
    // 2月30日のような存在しない日付や、25時のような範囲外の時刻を
    // Date.UTC がそのまま翌日・翌月へロールオーバーさせて通過させていた。
    assert.equal(fromKmoniTimestamp('20260230120000'), null); // 2026年は平年で2/29も無い
    assert.equal(parseJstDateTime('2026/02/30 12:00:00'), null);
    assert.equal(parseJstDateTime('2026/08/13 25:00:00'), null);
    assert.equal(parseJstDateTime('2026/08/13 12:60:00'), null);
    assert.equal(parseJstDateTime('2026/08/13 12:00:60'), null);
    assert.equal(parseJstDateTime('2026/13/01 00:00:00'), null);
    // 閏年の2/29は実在するので通る
    assert.equal(parseJstDateTime('2028/02/29 00:00:00').toISOString(), '2028-02-28T15:00:00.000Z');
  });

  it('プロセスの TZ 設定に影響されない', () => {
    // サーバーを UTC で動かしても JST 表示になること
    assert.equal(formatJstClock('2026-08-13T02:09:55.000Z'), '11:09:55');
  });
});

describe('ピクセルから緯度経度へ戻す', () => {
  it('本土は往復して同じ座標になる', () => {
    for (const [lat, lon] of [
      [35.681, 139.767],
      [43.068, 141.351],
      [33.59, 130.42],
    ]) {
      const px = projectToPixel(lat, lon);
      const back = unprojectFromPixel(px.x, px.y);
      assert.ok(Math.abs(back.lat - lat) < 1e-9);
      assert.ok(Math.abs(back.lon - lon) < 1e-9);
    }
  });

  it('南西諸島はインセットとして戻す', () => {
    const naha = projectToPixel(26.21, 127.68);
    const back = unprojectFromPixel(naha.x, naha.y, { inset: true });
    assert.ok(Math.abs(back.lat - 26.21) < 1e-9);
    assert.ok(Math.abs(back.lon - 127.68) < 1e-9);
    // インセットと知らずに戻すと日本海の上になる (だから呼び出し側が判断する)
    const wrong = unprojectFromPixel(naha.x, naha.y);
    assert.ok(wrong.lat > 35);
  });
});
