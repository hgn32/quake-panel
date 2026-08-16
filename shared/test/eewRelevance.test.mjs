import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eewRelevance, haversineKm, prefMatches } from '../dist/index.js';

// 利用地: 延岡 (宮崎県)
const NOBEOKA = { lat: 32.582, lon: 131.665 };
const SAPPORO = { lat: 43.06, lon: 141.35 };
const HYUGANADA = { lat: 32.2, lon: 132.0 };
const TAIWAN = { lat: 23.5, lon: 121.5 };
const TOKYO = { lat: 35.681, lon: 139.767 };
const OSAKA = { lat: 34.702, lon: 135.495 };

const region = (pref, overrides = {}) => ({
  pref,
  name: `${pref}地方`,
  scaleFrom: null,
  scaleTo: null,
  arrivalTime: null,
  condition: null,
  ...overrides,
});

const makeEew = (overrides = {}) => ({
  id: 'e1',
  reportNumber: 1,
  isFinal: false,
  isCancel: false,
  isTraining: false,
  isAssumption: false,
  alert: 'warning',
  hypocenter: { name: '', lat: null, lon: null, depthKm: null, magnitude: null },
  maxIntensity: null,
  originTime: null,
  announcedAt: null,
  receivedAt: '2026-08-13T10:00:00.000Z',
  regions: [],
  source: 'p2p',
  ...overrides,
});

describe('eewRelevance', () => {
  it('警報 + regions の pref が接尾辞なし (実電文形式) でも一致すれば warning', () => {
    const eew = makeEew({
      alert: 'warning',
      regions: [region('宮崎')],
      hypocenter: { name: '', lat: HYUGANADA.lat, lon: HYUGANADA.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(eew, '宮崎県', NOBEOKA, 300), 'warning');
  });

  it('regions の pref が県名形式 (接尾辞あり) でも一致する', () => {
    const eew = makeEew({
      alert: 'warning',
      regions: [region('宮崎県')],
      hypocenter: { name: '', lat: HYUGANADA.lat, lon: HYUGANADA.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(eew, '宮崎県', NOBEOKA, 300), 'warning');
  });

  it('警報だが regions は北海道のみ・震央も遠ければ none', () => {
    const eew = makeEew({
      alert: 'warning',
      regions: [region('北海道')],
      hypocenter: { name: '', lat: SAPPORO.lat, lon: SAPPORO.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(eew, '宮崎県', NOBEOKA, 300), 'none');
  });

  it('警報・regions は北海道のみでも、震央が近ければ forecast (対象県外でも近ければ知らせる)', () => {
    const eew = makeEew({
      alert: 'warning',
      regions: [region('北海道')],
      hypocenter: { name: '', lat: HYUGANADA.lat, lon: HYUGANADA.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(eew, '宮崎県', NOBEOKA, 300), 'forecast');
  });

  it('予報 (alert=forecast) は regions を見ず、距離だけで判定する', () => {
    const near = makeEew({
      alert: 'forecast',
      regions: [],
      hypocenter: { name: '', lat: HYUGANADA.lat, lon: HYUGANADA.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(near, '宮崎県', NOBEOKA, 300), 'forecast');

    const far = makeEew({
      alert: 'forecast',
      regions: [],
      hypocenter: { name: '', lat: TAIWAN.lat, lon: TAIWAN.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(far, '宮崎県', NOBEOKA, 500), 'none');
  });

  it('震央不明 (lat/lon が null) なら forecast (判定できないものは鳴らす側に倒す)', () => {
    const eew = makeEew({ alert: 'forecast', regions: [] });
    assert.equal(eewRelevance(eew, '宮崎県', NOBEOKA, 300), 'forecast');
  });

  it('homePrefecture が null なら県照合をスキップする (震央が遠ければ none)', () => {
    const eew = makeEew({
      alert: 'warning',
      regions: [region('宮崎')],
      hypocenter: { name: '', lat: SAPPORO.lat, lon: SAPPORO.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(eew, null, NOBEOKA, 300), 'none');
  });

  it('regions の pref が府県予報区 (北海道道央) でも道内なら warning', () => {
    const eew = makeEew({
      alert: 'warning',
      regions: [region('北海道道央')],
      hypocenter: { name: '', lat: SAPPORO.lat, lon: SAPPORO.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(eew, '北海道', SAPPORO, 300), 'warning');
  });

  it('regions の pref が府県予報区 (奄美(群島)) でも鹿児島県なら warning', () => {
    const KAGOSHIMA = { lat: 31.596, lon: 130.558 };
    const eew = makeEew({
      alert: 'warning',
      regions: [region('奄美(群島)')],
      hypocenter: { name: '', lat: KAGOSHIMA.lat, lon: KAGOSHIMA.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(eew, '鹿児島県', KAGOSHIMA, 300), 'warning');
  });

  it('regions の pref が府県予報区 (伊豆諸島) でも東京都なら warning', () => {
    const eew = makeEew({
      alert: 'warning',
      regions: [region('伊豆諸島')],
      hypocenter: { name: '', lat: TOKYO.lat, lon: TOKYO.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(eew, '東京都', TOKYO, 300), 'warning');
  });

  it('regions の pref が府県予報区 (八重山) でも沖縄県なら warning', () => {
    const OKINAWA = { lat: 26.212, lon: 127.681 };
    const eew = makeEew({
      alert: 'warning',
      regions: [region('八重山')],
      hypocenter: { name: '', lat: OKINAWA.lat, lon: OKINAWA.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(eew, '沖縄県', OKINAWA, 300), 'warning');
  });

  it('府県予報区の対応付けが他県に誤爆しない (北海道道東・青森県・震央遠方は none)', () => {
    const AOMORI = { lat: 40.824, lon: 140.74 };
    const eew = makeEew({
      alert: 'warning',
      regions: [region('北海道道東')],
      hypocenter: { name: '', lat: TAIWAN.lat, lon: TAIWAN.lon, depthKm: null, magnitude: null },
    });
    assert.equal(eewRelevance(eew, '青森県', AOMORI, 300), 'none');
  });

  it('haversineKm: 東京-大阪はおよそ 390〜410km', () => {
    const km = haversineKm(TOKYO, OSAKA);
    assert.ok(km > 390 && km < 410, `想定範囲外: ${km}km`);
  });

  it('prefMatches: 接尾辞の有無を吸収しつつ、部分一致はしない', () => {
    assert.equal(prefMatches('宮崎', '宮崎県'), true);
    assert.equal(prefMatches('京都', '東京都'), false);
    assert.equal(prefMatches('京都府', '京都'), true);
    assert.equal(prefMatches('北海道', '北海道'), true);
    assert.equal(prefMatches('', '宮崎県'), false);
  });
});
