import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_HA_NOTIFY_FILTER,
  parseMinIntensity,
  parsePrefectureList,
  shouldNotifyEew,
  shouldNotifyQuake,
  shouldNotifyTsunami,
} from '../dist/index.js';

const point = (pref, scale) => ({ pref, addr: `${pref}某所`, isArea: false, scale });

const quake = (maxIntensity, points) => ({
  id: 'q1',
  issuedAt: null,
  occurredAt: null,
  issueType: 'DetailScale',
  hypocenter: { name: '日向灘', lat: 32.1, lon: 131.9, depthKm: 30, magnitude: 4.2 },
  maxIntensity,
  domesticTsunami: 'None',
  points,
  receivedAt: '2026-08-15T10:00:00.000Z',
});

const region = (name, pref) => ({
  pref,
  name,
  scaleFrom: 40,
  scaleTo: null,
  arrivalTime: null,
  condition: null,
});

const eew = (maxIntensity, regions, extra = {}) => ({
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
  receivedAt: '2026-08-15T10:00:00.000Z',
  regions,
  source: 'both',
  ...extra,
});

describe('HA へ通知する地震情報の絞り込み', () => {
  it('既定では何も落とさない', () => {
    assert.equal(shouldNotifyQuake(quake(10, []), DEFAULT_HA_NOTIFY_FILTER), true);
    assert.equal(shouldNotifyQuake(quake(null, []), DEFAULT_HA_NOTIFY_FILTER), true);
  });

  it('最大震度のしきい値で落とす', () => {
    const filter = { minIntensity: 30, prefectures: [], areas: [] };
    assert.equal(shouldNotifyQuake(quake(20, []), filter), false);
    assert.equal(shouldNotifyQuake(quake(30, []), filter), true);
    assert.equal(shouldNotifyQuake(quake(50, []), filter), true);
  });

  it('しきい値があるとき、震度不明の電文は落とす', () => {
    const filter = { minIntensity: 10, prefectures: [], areas: [] };
    assert.equal(shouldNotifyQuake(quake(null, []), filter), false);
  });

  it('都道府県で落とす (指定県で震度が観測された地震だけ流す)', () => {
    const filter = { minIntensity: 0, prefectures: ['宮崎県'], areas: [] };
    assert.equal(shouldNotifyQuake(quake(30, [point('宮崎県', 30)]), filter), true);
    assert.equal(shouldNotifyQuake(quake(30, [point('高知県', 30)]), filter), false);
    // 観測点はあるが震度が入っていない (無感) 場合は流さない
    assert.equal(shouldNotifyQuake(quake(30, [point('宮崎県', null)]), filter), false);
  });

  it('県名の表記ゆれ (宮崎 / 宮崎県) を拾う', () => {
    const filter = { minIntensity: 0, prefectures: ['宮崎'], areas: [] };
    assert.equal(shouldNotifyQuake(quake(30, [point('宮崎県', 30)]), filter), true);
  });

  it('震度と地域の両方を満たすときだけ流す', () => {
    const filter = { minIntensity: 40, prefectures: ['宮崎県'], areas: [] };
    assert.equal(shouldNotifyQuake(quake(40, [point('宮崎県', 40)]), filter), true);
    assert.equal(shouldNotifyQuake(quake(30, [point('宮崎県', 30)]), filter), false);
    assert.equal(shouldNotifyQuake(quake(40, [point('高知県', 40)]), filter), false);
  });
});

describe('HA へ通知する緊急地震速報の絞り込み', () => {
  it('既定では何も落とさない', () => {
    assert.equal(shouldNotifyEew(eew(30, []), DEFAULT_HA_NOTIFY_FILTER), true);
  });

  it('予想最大震度のしきい値で落とす', () => {
    const filter = { minIntensity: 45, prefectures: [], areas: [] };
    assert.equal(shouldNotifyEew(eew(40, []), filter), false);
    assert.equal(shouldNotifyEew(eew(50, []), filter), true);
    assert.equal(shouldNotifyEew(eew(null, []), filter), false);
  });

  it('取消報と「発表なし」は絞り込みに関わらず流す (解除を伝えないと自動化が戻らない)', () => {
    const filter = { minIntensity: 55, prefectures: ['宮崎県'], areas: [] };
    assert.equal(shouldNotifyEew(null, filter), true);
    assert.equal(shouldNotifyEew(eew(10, [], { isCancel: true }), filter), true);
  });

  it('予想震度の地域で落とす', () => {
    const filter = { minIntensity: 0, prefectures: ['宮崎県'], areas: [] };
    assert.equal(shouldNotifyEew(eew(40, [region('宮崎県南部平野部', '宮崎県')]), filter), true);
    assert.equal(shouldNotifyEew(eew(40, [region('高知県中部', '高知県')]), filter), false);
  });

  it('地域がまだ来ていない第一報は、地域では落とさない', () => {
    const filter = { minIntensity: 0, prefectures: ['宮崎県'], areas: [] };
    assert.equal(shouldNotifyEew(eew(40, []), filter), true);
  });
});

describe('設定値の解釈', () => {
  it('しきい値はラベルでも整数コードでも受ける', () => {
    assert.equal(parseMinIntensity('震度3以上'), 30);
    assert.equal(parseMinIntensity('震度5弱以上'), 45);
    assert.equal(parseMinIntensity('すべて'), 0);
    assert.equal(parseMinIntensity('45'), 45);
    assert.equal(parseMinIntensity('0'), 0);
  });

  it('解釈できない値は null (呼び出し側で既定へ落とす)', () => {
    assert.equal(parseMinIntensity(''), null);
    assert.equal(parseMinIntensity(undefined), null);
    assert.equal(parseMinIntensity('震度8以上'), null);
    assert.equal(parseMinIntensity('つよいやつ'), null);
  });

  it('県の一覧はカンマ・読点で区切る', () => {
    assert.deepEqual(parsePrefectureList('宮崎県, 鹿児島県'), ['宮崎県', '鹿児島県']);
    assert.deepEqual(parsePrefectureList('宮崎県、鹿児島県'), ['宮崎県', '鹿児島県']);
    assert.deepEqual(parsePrefectureList(''), []);
    assert.deepEqual(parsePrefectureList(' , '), []);
  });
});

const tsunamiArea = (name) => ({
  name,
  grade: 'Watch',
  immediate: false,
  firstHeightCondition: null,
  firstHeightArrivalTime: null,
  maxHeightDescription: null,
  maxHeightValue: null,
  isHome: false,
});

const tsunami = (names, extra = {}) => ({
  id: 't1',
  issuedAt: null,
  cancelled: false,
  areas: names.map(tsunamiArea),
  affectsHome: false,
  receivedAt: '2026-08-15T10:00:00.000Z',
  ...extra,
});

describe('HA へ通知する津波予報の絞り込み', () => {
  it('既定 (全国) では何も落とさない', () => {
    assert.equal(shouldNotifyTsunami(tsunami(['北海道太平洋沿岸東部']), DEFAULT_HA_NOTIFY_FILTER), true);
  });

  it('対象の県に関わる予報区だけ流す', () => {
    const filter = { minIntensity: 0, prefectures: ['宮崎県'], areas: [] };
    assert.equal(shouldNotifyTsunami(tsunami(['宮崎県']), filter), true);
    assert.equal(shouldNotifyTsunami(tsunami(['北海道太平洋沿岸東部']), filter), false);
  });

  it('画面と同じで、県名を含まない広域の予報区も拾う', () => {
    // 津波警報の第一報で使われる。県名だけの部分一致では落ちてしまう区。
    const miyagi = { minIntensity: 0, prefectures: ['宮城県'], areas: [] };
    assert.equal(shouldNotifyTsunami(tsunami(['東北地方太平洋沿岸']), miyagi), true);
    const kagawa = { minIntensity: 0, prefectures: ['香川県'], areas: [] };
    assert.equal(shouldNotifyTsunami(tsunami(['瀬戸内海沿岸']), kagawa), true);
    const kumamoto = { minIntensity: 0, prefectures: ['熊本県'], areas: [] };
    assert.equal(shouldNotifyTsunami(tsunami(['有明・八代海']), kumamoto), true);
    // 無関係な県は拾わない
    assert.equal(shouldNotifyTsunami(tsunami(['東北地方太平洋沿岸']), kagawa), false);
  });

  it('複数県を指定するとどれかに関われば流す', () => {
    const filter = { minIntensity: 0, prefectures: ['宮崎県', '新潟県'], areas: [] };
    assert.equal(shouldNotifyTsunami(tsunami(['佐渡']), filter), true);
  });

  it('震度のしきい値は津波には効かない (遠地地震でも津波は来る)', () => {
    const filter = { minIntensity: 55, prefectures: ['宮崎県'], areas: [] };
    assert.equal(shouldNotifyTsunami(tsunami(['宮崎県']), filter), true);
  });

  it('解除・対象なし・発表なしは絞り込みに関わらず流す', () => {
    const filter = { minIntensity: 0, prefectures: ['宮崎県'], areas: [] };
    assert.equal(shouldNotifyTsunami(null, filter), true);
    assert.equal(shouldNotifyTsunami(tsunami(['北海道太平洋沿岸東部'], { cancelled: true }), filter), true);
    assert.equal(shouldNotifyTsunami(tsunami([]), filter), true);
  });
});
