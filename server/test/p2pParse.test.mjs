import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEew, parseQuake, parseTsunami } from '../dist/sources/p2pParse.js';

const NOW = new Date('2026-08-13T02:00:00.000Z');

/** 以下は 2026-08-13 に https://api.p2pquake.net/v2/history から取得した実データ */

const QUAKE_551 = {
  code: 551,
  earthquake: {
    domesticTsunami: 'None',
    hypocenter: { depth: 10, latitude: 32.7, longitude: 130.7, magnitude: 2.4, name: '熊本県熊本地方' },
    maxScale: 10,
    time: '2026/08/13 10:35:00',
  },
  id: '6a7d200de88ee598246bf1c2',
  issue: { correct: 'None', source: '気象庁', time: '2026/08/13 10:38:21', type: 'DetailScale' },
  points: [{ addr: '宇城市豊野町', isArea: false, pref: '熊本県', scale: 10 }],
  time: '2026/08/13 10:38:21.762',
};

const TSUNAMI_552 = {
  areas: [
    {
      firstHeight: { condition: '津波到達中と推測' },
      grade: 'Watch',
      immediate: true,
      maxHeight: { description: '１ｍ', value: 1 },
      name: '宮崎県',
    },
    { grade: 'Watch', immediate: false, name: '有明・八代海' },
  ],
  cancelled: false,
  code: 552,
  id: '6a685a4be88ee598246beeda',
  issue: { source: '気象庁', time: '2026/07/28 16:29:13', type: 'Focus' },
  time: '2026/07/28 16:29:15.106',
};

const EEW_556 = {
  areas: [
    { arrivalTime: '2026/07/29 22:19:44', kindCode: '19', name: '熊本県熊本', pref: '熊本', scaleFrom: 45, scaleTo: 45 },
    { arrivalTime: '2026/07/29 22:19:43', kindCode: '19', name: '熊本県球磨', pref: '熊本', scaleFrom: 40, scaleTo: 40 },
  ],
  cancelled: false,
  code: 556,
  earthquake: {
    arrivalTime: '2026/07/29 22:19:39',
    condition: '',
    hypocenter: {
      depth: 10,
      latitude: 32.4,
      longitude: 130.5,
      magnitude: 4.5,
      name: '熊本県天草・芦北地方',
      reduceName: '熊本県',
    },
    originTime: '2026/07/29 22:19:36',
  },
  id: '6a69fdf1e88ee598246bf002',
  issue: { eventId: '20260729221939', serial: '1', time: '2026/07/29 22:19:44' },
  time: '2026/07/29 22:19:45.168',
};

describe('P2P 551 (地震情報)', () => {
  it('震源と観測点を取り出す', () => {
    const quake = parseQuake(QUAKE_551, NOW);
    assert.equal(quake.hypocenter.name, '熊本県熊本地方');
    assert.equal(quake.maxIntensity, 10);
    assert.equal(quake.issueType, 'DetailScale');
    assert.equal(quake.occurredAt, '2026-08-13T01:35:00.000Z');
    assert.equal(quake.points.length, 1);
    assert.equal(quake.points[0].scale, 10);
  });

  it('震度速報のように震源未確定の電文でも壊れない', () => {
    const prompt = parseQuake(
      {
        code: 551,
        id: 'x',
        earthquake: {
          hypocenter: { depth: -1, latitude: -1, longitude: -1, magnitude: -1, name: '' },
          maxScale: 30,
          time: '2026/08/13 08:56:00',
        },
        issue: { type: 'ScalePrompt', time: '2026/08/13 08:58:00' },
        points: [],
      },
      NOW,
    );
    // -1 は「不明」を意味するので、そのまま表示に流さない
    assert.equal(prompt.hypocenter.depthKm, null);
    assert.equal(prompt.hypocenter.magnitude, null);
    assert.equal(prompt.hypocenter.lat, null);
    assert.equal(prompt.hypocenter.name, '不明');
    assert.equal(prompt.maxIntensity, 30);
  });

  it('未知の震度コードは null にする', () => {
    const quake = parseQuake(
      { code: 551, id: 'y', earthquake: { maxScale: -1 }, points: [{ scale: 99 }] },
      NOW,
    );
    assert.equal(quake.maxIntensity, null);
    assert.equal(quake.points[0].scale, null);
  });
});

describe('P2P 552 (津波予報)', () => {
  it('利用地の予報区を判定する', () => {
    const tsunami = parseTsunami(TSUNAMI_552, NOW);
    assert.equal(tsunami.cancelled, false);
    // 利用地の印は表示側が付ける (shared/tsunami.ts)
    assert.equal(tsunami.affectsHome, false);
    assert.equal(tsunami.areas[0].isHome, false);
    assert.equal(tsunami.areas[0].immediate, true);
    assert.equal(tsunami.areas[0].maxHeightValue, 1);
    assert.equal(tsunami.areas[0].firstHeightCondition, '津波到達中と推測');
    // 予報区名は必ずしも都道府県名ではない
    assert.equal(tsunami.areas[1].name, '有明・八代海');
    assert.equal(tsunami.areas[1].isHome, false);
  });

  it('解除電文を解除として扱う', () => {
    const tsunami = parseTsunami({ code: 552, id: 'z', cancelled: true, areas: [] }, NOW);
    assert.equal(tsunami.cancelled, true);
    assert.equal(tsunami.affectsHome, false);
  });
});

describe('P2P 556 (緊急地震速報 警報)', () => {
  it('警報として読み、最大予想震度を地域から求める', () => {
    const eew = parseEew(EEW_556, NOW);
    assert.equal(eew.alert, 'warning');
    assert.equal(eew.id, '20260729221939');
    assert.equal(eew.reportNumber, 1);
    assert.equal(eew.maxIntensity, 45);
    assert.equal(eew.regions.length, 2);
    // 到達予測時刻は気象庁の配信値をそのまま保持する (自前計算はしない)
    assert.equal(eew.regions[0].arrivalTime, '2026-07-29T13:19:44.000Z');
    assert.equal(eew.originTime, '2026-07-29T13:19:36.000Z');
    assert.equal(eew.source, 'p2p');
    assert.equal(eew.isCancel, false);
  });

  it('scaleTo が -1 のときは上限なしとして扱う', () => {
    const eew = parseEew(
      { ...EEW_556, areas: [{ name: 'X', pref: 'Y', scaleFrom: 55, scaleTo: -1 }] },
      NOW,
    );
    assert.equal(eew.regions[0].scaleFrom, 55);
    assert.equal(eew.regions[0].scaleTo, null);
    assert.equal(eew.maxIntensity, 55);
  });

  it('訓練報とキャンセル報を見分ける', () => {
    assert.equal(parseEew({ ...EEW_556, test: true }, NOW).isTraining, true);
    assert.equal(parseEew({ ...EEW_556, cancelled: true }, NOW).isCancel, true);
  });
});
