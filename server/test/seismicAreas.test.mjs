import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldNotifyEew, shouldNotifyQuake } from '@quake-panel/shared';
import { loadConfig } from '../dist/config.js';
import { SEISMIC_AREAS, seismicAreaOf } from '../dist/data/seismicAreas.js';

/**
 * 細分区域による絞り込み。
 *
 * 選択肢と対応表は気象庁「地震火山関連コード表」シート24 から起こしており、
 * P2P地震情報の電文との対応は実データで確認済み (下のテストは実在の観測点名を使う)。
 */
const point = (pref, addr, scale, isArea = false) => ({ pref, addr, isArea, scale });

const quake = (maxIntensity, points) => ({
  id: 'q1',
  issuedAt: null,
  occurredAt: null,
  issueType: 'DetailScale',
  hypocenter: { name: '日向灘', lat: 32.1, lon: 131.9, depthKm: 30, magnitude: 4.2 },
  maxIntensity,
  domesticTsunami: 'None',
  points,
  receivedAt: '2026-08-16T02:00:00.000Z',
});

const region = (name) => ({
  pref: '',
  name,
  scaleFrom: 40,
  scaleTo: null,
  arrivalTime: null,
  condition: null,
});

const eew = (maxIntensity, regions) => ({
  id: 'e1',
  reportNumber: 2,
  isFinal: false,
  isCancel: false,
  isTraining: false,
  isAssumption: false,
  alert: 'warning',
  hypocenter: { name: '日向灘', lat: 32.1, lon: 131.9, depthKm: 30, magnitude: 6.4 },
  maxIntensity,
  originTime: null,
  announcedAt: null,
  receivedAt: '2026-08-16T02:00:00.000Z',
  regions,
  source: 'both',
});

const filter = (areas, prefectures = []) => ({ minIntensity: 0, prefectures, areas });

describe('細分区域の一覧 (気象庁 AreaForecastLocalE)', () => {
  it('188 区ある', () => {
    assert.equal(SEISMIC_AREAS.length, 188);
  });

  it('重複が無い', () => {
    assert.equal(new Set(SEISMIC_AREAS).size, SEISMIC_AREAS.length);
  });

  it('実在の区域名が入っている (県名を含むものも含まないものも)', () => {
    ['熊本県熊本', '熊本県天草・芦北', '鹿児島県薩摩', '宮崎県南部平野部'].forEach((a) =>
      assert.ok(SEISMIC_AREAS.includes(a), `${a} が無い`),
    );
    // 北海道は県名ではなく地方名。県名だけの部分一致では拾えない区の代表。
    assert.ok(SEISMIC_AREAS.includes('石狩地方北部'));
  });
});

describe('観測点から細分区域を引く', () => {
  it('震度速報 (isArea) の addr はそのまま細分区域', () => {
    assert.equal(seismicAreaOf('福島県中通り', true), '福島県中通り');
  });

  it('震度詳細の addr は実在の観測点名から引ける', () => {
    // いずれも P2P の実データに出た観測点名
    assert.equal(seismicAreaOf('芦北町芦北', false), '熊本県天草・芦北');
    assert.equal(seismicAreaOf('宮古市田老', false), '岩手県沿岸北部');
  });

  it('知らない観測点は null (絞り込みで落とすだけで落ちない)', () => {
    assert.equal(seismicAreaOf('架空市どこか', false), null);
  });
});

describe('地震情報を細分区域で絞る', () => {
  it('指定した区域で揺れた地震だけ流す', () => {
    const f = filter(['熊本県天草・芦北']);
    assert.equal(
      shouldNotifyQuake(quake(10, [point('熊本県', '芦北町芦北', 10)]), f, seismicAreaOf),
      true,
    );
    assert.equal(
      shouldNotifyQuake(quake(10, [point('岩手県', '宮古市田老', 10)]), f, seismicAreaOf),
      false,
    );
  });

  it('震度速報 (区域単位の電文) でも効く', () => {
    const f = filter(['福島県中通り']);
    assert.equal(
      shouldNotifyQuake(quake(30, [point('福島県', '福島県中通り', 30, true)]), f, seismicAreaOf),
      true,
    );
  });

  it('同じ県でも別の区域なら落とす (都道府県より細かい)', () => {
    const f = filter(['熊本県熊本']);
    assert.equal(
      shouldNotifyQuake(quake(10, [point('熊本県', '芦北町芦北', 10)]), f, seismicAreaOf),
      false,
      '熊本県だが天草・芦北なので落ちるはず',
    );
  });

  it('都道府県と併用したときは、どちらかに当たれば流す', () => {
    const f = filter(['熊本県熊本'], ['岩手県']);
    assert.equal(
      shouldNotifyQuake(quake(10, [point('岩手県', '宮古市田老', 10)]), f, seismicAreaOf),
      true,
      '県の条件で通るはず',
    );
  });

  it('震度が入っていない観測点 (無感) は数えない', () => {
    const f = filter(['熊本県天草・芦北']);
    assert.equal(
      shouldNotifyQuake(quake(10, [point('熊本県', '芦北町芦北', null)]), f, seismicAreaOf),
      false,
    );
  });

  it('対応表を渡さなければ細分区域では絞らない', () => {
    const f = filter(['熊本県熊本']);
    assert.equal(shouldNotifyQuake(quake(10, [point('熊本県', '芦北町芦北', 10)]), f), false);
  });
});

describe('緊急地震速報を細分区域で絞る', () => {
  it('予想震度の地域名がそのまま細分区域なので完全一致で効く', () => {
    const f = filter(['熊本県熊本']);
    assert.equal(shouldNotifyEew(eew(40, [region('熊本県熊本')]), f), true);
    assert.equal(shouldNotifyEew(eew(40, [region('熊本県球磨')]), f), false);
  });

  it('複数地域のうち 1 つでも当たれば流す', () => {
    const f = filter(['鹿児島県薩摩']);
    assert.equal(
      shouldNotifyEew(eew(40, [region('熊本県熊本'), region('鹿児島県薩摩')]), f),
      true,
    );
  });

  it('地域がまだ来ていない第一報は落とさない', () => {
    assert.equal(shouldNotifyEew(eew(40, []), filter(['熊本県熊本'])), true);
  });
});

describe('HA_NOTIFY_AREAS', () => {
  it('既定は空', () => {
    assert.deepEqual(loadConfig({}).homeAssistant.filter.areas, []);
  });

  it('カンマ・読点で区切って読む', () => {
    assert.deepEqual(
      loadConfig({ HA_NOTIFY_AREAS: '熊本県熊本, 鹿児島県薩摩' }).homeAssistant.filter.areas,
      ['熊本県熊本', '鹿児島県薩摩'],
    );
  });

  it('設定できる値はすべて一覧に含まれる形で書ける', () => {
    const areas = loadConfig({ HA_NOTIFY_AREAS: SEISMIC_AREAS.slice(0, 5).join(',') })
      .homeAssistant.filter.areas;
    areas.forEach((a) => assert.ok(SEISMIC_AREAS.includes(a)));
  });
});
