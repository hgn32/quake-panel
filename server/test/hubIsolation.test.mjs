import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';
import { Hub } from '../dist/hub.js';

/**
 * Hub は同じイベントオブジェクトを全リスナー (WebSocket 配信 / その他の購読者) へ渡す。
 * どちらかが中身を書き換えると、もう片方が壊れた値を見る。
 *
 * ここでは配信前に**深く凍結**して publish する。ES モジュールは strict mode
 * なので、凍結したオブジェクトへの代入は黙って無視されずに TypeError になる。
 * つまり「誰も書き換えていない」ことを実行で証明できる。
 */
const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const point = (pref, scale) => ({ pref, addr: `${pref}某所`, isArea: false, scale });

const QUAKE = deepFreeze({
  id: 'q1',
  issuedAt: null,
  occurredAt: '2026-08-16T01:00:00.000Z',
  issueType: 'DetailScale',
  hypocenter: { name: '日向灘', lat: 32.1, lon: 131.9, depthKm: 30, magnitude: 4.2 },
  maxIntensity: 30,
  domesticTsunami: 'None',
  points: [point('宮崎県', 30), point('鹿児島県', 20)],
  receivedAt: '2026-08-16T01:00:01.000Z',
});

const EEW = deepFreeze({
  id: 'e1',
  reportNumber: 2,
  isFinal: false,
  isCancel: false,
  isTraining: false,
  isAssumption: false,
  alert: 'warning',
  hypocenter: { name: '日向灘', lat: 32.1, lon: 131.9, depthKm: 30, magnitude: 6.4 },
  maxIntensity: 50,
  originTime: null,
  announcedAt: null,
  receivedAt: '2026-08-16T01:00:00.000Z',
  regions: [
    { pref: '宮崎県', name: '宮崎県南部平野部', scaleFrom: 40, scaleTo: null, arrivalTime: null, condition: null },
  ],
  source: 'both',
});

const TSUNAMI = deepFreeze({
  id: 't1',
  issuedAt: null,
  cancelled: false,
  areas: [
    {
      name: '東北地方太平洋沿岸',
      grade: 'Watch',
      immediate: false,
      firstHeightCondition: null,
      firstHeightArrivalTime: null,
      maxHeightDescription: null,
      maxHeightValue: null,
      isHome: false,
    },
  ],
  affectsHome: false,
  receivedAt: '2026-08-16T01:00:00.000Z',
});

/**
 * Hub の 2 つ目の購読者を模した、その場限りの最小リスナー。
 *
 * Hub は配信 (ws) 以外にも同じイベントを購読する購読者がいる構成を
 * 想定しており、ここで検証したいのは「Hub が複数リスナーへ同じイベントを
 * 配ってもどちらも壊れない・絞り込みは購読者ごとに独立している」ことだけなので、
 * 本物の通知先を持たない疑似的な絞り込みリスナーで代替する。
 */
const attachFilteringListener = (hub, { minIntensity = 0, prefectures = [] } = {}) => {
  const accepted = [];
  hub.on('event', (event) => {
    if (event.type === 'quake') {
      if (event.quake.maxIntensity < minIntensity) return;
      if (prefectures.length > 0 && !event.quake.points.some((p) => prefectures.includes(p.pref))) return;
    }
    if (event.type === 'tsunami' && prefectures.length > 0) {
      // 疑似リスナー自身の判定に使うだけで、配信側の値には影響しない。
      applyHomeAreasLike(event.tsunami, prefectures);
    }
    accepted.push(event);
  });
  return accepted;
};

/** `applyHomeAreas` 相当の簡易ロジック (疑似リスナーの中でだけ使う)。元のオブジェクトは書き換えない。 */
const applyHomeAreasLike = (tsunami, prefectures) => ({
  ...tsunami,
  affectsHome: tsunami.areas.some((area) => prefectures.some((pref) => area.name.includes(pref))),
});

/** WebSocket 配信と同じ立場のリスナーを立てた状態で publish する */
const withListeners = (env, filterOptions, body) => {
  const config = loadConfig(env);
  const hub = new Hub(config);
  attachFilteringListener(hub, filterOptions);
  const seen = [];
  // WebSocket 配信と同じ立場のリスナー。実際の配信は JSON 化するので、
  // 受け取った直後の姿を控えておいて後で突き合わせる。
  hub.on('event', (event) => seen.push({ event, snapshot: JSON.stringify(event) }));
  body(hub);
  return Promise.resolve(seen);
};

describe('Hub のイベントは複数のリスナーで共有されても壊れない', () => {
  it('もう一方のリスナーが受け取る設定でも、配信側が受け取った中身が変わらない', () =>
    withListeners({}, { minIntensity: 20, prefectures: ['宮崎県'] }, (hub) => {
      hub.publishQuake(QUAKE);
      hub.publishEew(EEW);
      hub.publishTsunami(TSUNAMI);
    }).then((seen) => {
      assert.equal(seen.length, 3, '3 件とも配信側へ届く');
      seen.forEach(({ event, snapshot }) => {
        assert.equal(JSON.stringify(event), snapshot, `${event.type} が後から書き換わっている`);
      });
    }));

  it('もう一方のリスナーが絞り込みで落とす設定でも、配信側へは元のまま届く (画面は絞られない)', () =>
    withListeners({}, { minIntensity: 50, prefectures: ['北海道'] }, (hub) => {
      hub.publishQuake(QUAKE);
      hub.publishTsunami(TSUNAMI);
    }).then((seen) => {
      assert.equal(seen.length, 2, '他のリスナーが落としても配信は止まらない');
      const quake = seen.find((s) => s.event.type === 'quake');
      assert.equal(quake.event.quake.maxIntensity, 30);
      assert.equal(quake.event.quake.points.length, 2);
      const tsunami = seen.find((s) => s.event.type === 'tsunami');
      assert.equal(tsunami.event.tsunami.areas[0].name, '東北地方太平洋沿岸');
      // 画面用の印は付けられていない (印を付けるのは各端末の仕事)
      assert.equal(tsunami.event.tsunami.areas[0].isHome, false);
      assert.equal(tsunami.event.tsunami.affectsHome, false);
    }));

  it('もう一方のリスナーの判定処理 (applyHomeAreasLike 相当) が元のオブジェクトを書き換えない', () =>
    withListeners({}, { prefectures: ['宮城県'] }, (hub) => {
      hub.publishTsunami(TSUNAMI);
    }).then((seen) => {
      // 宮城県は東北地方太平洋沿岸に含まれるので、もう一方のリスナー側では該当と判定される。
      // それでも配信された値の isHome / affectsHome は false のまま。
      const tsunami = seen.find((s) => s.event.type === 'tsunami');
      assert.equal(tsunami.event.tsunami.areas[0].isHome, false);
      assert.equal(tsunami.event.tsunami.affectsHome, false);
      assert.equal(TSUNAMI.areas[0].isHome, false);
    }));
});
