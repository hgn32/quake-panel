import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { geolocationErrorMessage, parseHomeLocation } from '../dist/index.js';

describe('利用地の読み取り', () => {
  it('lat / lon を読む (このサーバーの API 形式)', () => {
    assert.deepEqual(parseHomeLocation({ lat: 35.681, lon: 139.767 }), {
      lat: 35.681,
      lon: 139.767,
    });
  });

  it('latitude / longitude を読む (外部 API 形式)', () => {
    // HA の /config は他のキーも大量に返す。必要なものだけ拾えること。
    const config = {
      latitude: 43.062,
      longitude: 141.354,
      location_name: 'Home',
      time_zone: 'Asia/Tokyo',
    };
    assert.deepEqual(parseHomeLocation(config), { lat: 43.062, lon: 141.354 });
  });

  it('位置が未設定の 0,0 は取得できなかった扱いにする', () => {
    // HA で位置を設定していないと 0,0 が返る。地図がギニア湾へ飛ぶのを防ぐ。
    assert.equal(parseHomeLocation({ latitude: 0, longitude: 0 }), null);
  });

  it('範囲外・型違い・欠損は null', () => {
    assert.equal(parseHomeLocation({ lat: 91, lon: 139 }), null);
    assert.equal(parseHomeLocation({ lat: 35, lon: 181 }), null);
    assert.equal(parseHomeLocation({ lat: '35.681', lon: '139.767' }), null);
    assert.equal(parseHomeLocation({ lat: 35.681 }), null);
    assert.equal(parseHomeLocation(null), null);
    assert.equal(parseHomeLocation([35.681, 139.767]), null);
    assert.equal(parseHomeLocation('35.681,139.767'), null);
  });

  it('0 でない片側は通す (経度 0 の地点は実在する)', () => {
    assert.deepEqual(parseHomeLocation({ lat: 51.478, lon: 0 }), { lat: 51.478, lon: 0 });
  });
});

describe('位置情報の失敗理由', () => {
  it('コードごとに理由が変わる', () => {
    const denied = geolocationErrorMessage(1);
    const unavailable = geolocationErrorMessage(2);
    const timeout = geolocationErrorMessage(3);
    assert.match(denied, /許可/);
    assert.match(unavailable, /取得できません/);
    assert.match(timeout, /時間/);
    assert.equal(new Set([denied, unavailable, timeout]).size, 3);
  });

  it('未知のコードでも文言が出る', () => {
    assert.notEqual(geolocationErrorMessage(null), '');
    assert.notEqual(geolocationErrorMessage(99), '');
  });
});
