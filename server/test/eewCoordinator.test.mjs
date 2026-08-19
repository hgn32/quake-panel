import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EewCoordinator, isSameEvent, kmoniToState, mergeStates } from '../dist/eew/coordinator.js';
import { loadConfig } from '../dist/config.js';

const base = {
  id: 'a',
  reportNumber: 1,
  isFinal: false,
  isCancel: false,
  isTraining: false,
  isAssumption: false,
  alert: 'forecast',
  hypocenter: { name: '日向灘', lat: 32.3, lon: 131.9, depthKm: 30, magnitude: 5.2 },
  maxIntensity: 40,
  originTime: '2026-08-13T02:10:00.000Z',
  announcedAt: '2026-08-13T02:10:05.000Z',
  receivedAt: '2026-08-13T02:10:05.500Z',
  regions: [],
  source: 'kmoni',
};

describe('同一地震の判定', () => {
  it('ID が一致すれば同じ', () => {
    assert.equal(isSameEvent(base, { ...base, announcedAt: '2026-08-13T02:10:07.000Z' }), true);
  });

  it('ID 表記が違っても発震時刻が一致すれば同じ', () => {
    // kmoni の report_id と P2P の eventId は表記が異なる
    const fromP2P = { ...base, id: '20260813111000', source: 'p2p' };
    assert.equal(isSameEvent(base, fromP2P), true);
  });

  it('発震時刻が離れていれば別の地震', () => {
    const other = { ...base, id: 'b', originTime: '2026-08-13T02:12:00.000Z' };
    assert.equal(isSameEvent(base, other), false);
  });
});

describe('kmoni と P2P の合成', () => {
  it('新しい報を土台に、片方にしかない情報を残す', () => {
    const withRegions = {
      ...base,
      id: '20260813111000',
      source: 'p2p',
      alert: 'warning',
      announcedAt: '2026-08-13T02:10:08.000Z',
      reportNumber: 2,
      maxIntensity: 50,
      regions: [{ pref: '宮崎', name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: 50, arrivalTime: null, condition: null }],
    };
    const merged = mergeStates(base, withRegions);
    assert.equal(merged.alert, 'warning');
    assert.equal(merged.reportNumber, 2);
    assert.equal(merged.maxIntensity, 50);
    assert.equal(merged.regions.length, 1);
    assert.equal(merged.source, 'both');
  });

  it('警報は続報の予報で降格しない', () => {
    const warning = { ...base, alert: 'warning', announcedAt: '2026-08-13T02:10:06.000Z' };
    const laterForecast = { ...base, alert: 'forecast', announcedAt: '2026-08-13T02:10:09.000Z' };
    assert.equal(mergeStates(warning, laterForecast).alert, 'warning');
  });

  it('キャンセル報と訓練報のフラグは落とさない', () => {
    const cancelled = { ...base, isCancel: true, announcedAt: '2026-08-13T02:10:20.000Z' };
    const merged = mergeStates(base, cancelled);
    assert.equal(merged.isCancel, true);

    const training = { ...base, isTraining: true };
    assert.equal(mergeStates(training, base).isTraining, true);
  });

  it('新しい報で欠けた値は古い報から補う', () => {
    const partial = {
      ...base,
      announcedAt: '2026-08-13T02:10:09.000Z',
      maxIntensity: null,
      hypocenter: { name: '不明', lat: null, lon: null, depthKm: null, magnitude: null },
    };
    const merged = mergeStates(base, partial);
    assert.equal(merged.maxIntensity, 40);
    assert.equal(merged.hypocenter.name, '日向灘');
    assert.equal(merged.hypocenter.lat, 32.3);
  });
});

describe('onEewEvent の kind 判定', () => {
  /** hub / frames 側は今回の判定に関係ないのでフェイクで代替する。 */
  const makeCoordinator = () => {
    const events = [];
    const coordinator = new EewCoordinator({
      config: loadConfig({}),
      hub: { publishEew() {} },
      onActiveChange: () => {},
      onEewEvent: (event) => events.push(event),
    });
    return { coordinator, events };
  };

  it('第一報は new', () => {
    const { coordinator, events } = makeCoordinator();
    coordinator.acceptKmoni({
      id: '20260817111000',
      reportNumber: 1,
      alert: 'forecast',
      isCancel: false,
      isFinal: false,
      isTraining: false,
      hypocenter: { name: '日向灘', lat: 32.3, lon: 131.9, depthKm: 30, magnitude: 5.2 },
      maxIntensity: 40,
      originTime: new Date('2026-08-17T02:10:00.000Z'),
      announcedAt: new Date('2026-08-17T02:10:05.000Z'),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'new');
  });

  it('同一地震の続報は update', () => {
    const { coordinator, events } = makeCoordinator();
    const report = (reportNumber, announcedAt) => ({
      id: '20260817111000',
      reportNumber,
      alert: 'forecast',
      isCancel: false,
      isFinal: false,
      isTraining: false,
      hypocenter: { name: '日向灘', lat: 32.3, lon: 131.9, depthKm: 30, magnitude: 5.2 },
      maxIntensity: 40,
      originTime: new Date('2026-08-17T02:10:00.000Z'),
      announcedAt: new Date(announcedAt),
    });
    coordinator.acceptKmoni(report(1, '2026-08-17T02:10:05.000Z'));
    coordinator.acceptKmoni(report(2, '2026-08-17T02:10:08.000Z'));
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'new');
    assert.equal(events[1].kind, 'update');
  });

  it('【回帰】同一内容の続報を繰り返し accept しても update は 1 回だけ (毎秒ポーリングでの webhook 連投を防ぐ)', () => {
    const { coordinator, events } = makeCoordinator();
    const report = (reportNumber, announcedAt) => ({
      id: '20260817111000',
      reportNumber,
      alert: 'forecast',
      isCancel: false,
      isFinal: false,
      isTraining: false,
      hypocenter: { name: '日向灘', lat: 32.3, lon: 131.9, depthKm: 30, magnitude: 5.2 },
      maxIntensity: 40,
      originTime: new Date('2026-08-17T02:10:00.000Z'),
      announcedAt: new Date(announcedAt),
    });
    // kmoni EEW は毎秒ポーリングされ、発表中は同一報 (report_num 不変) が何度も届く。
    coordinator.acceptKmoni(report(2, '2026-08-17T02:10:08.000Z'));
    coordinator.acceptKmoni(report(2, '2026-08-17T02:10:08.000Z'));
    coordinator.acceptKmoni(report(2, '2026-08-17T02:10:08.000Z'));
    assert.equal(events.length, 1, '同一内容なのに update が複数回発火している');
    assert.equal(events[0].kind, 'new');

    // 内容 (震度) が変われば、同一報番号のままでも update を発火する。
    const changed = { ...report(2, '2026-08-17T02:10:08.000Z'), maxIntensity: 45 };
    coordinator.acceptKmoni(changed);
    assert.equal(events.length, 2, '内容が変わったのに update が発火していない');
    assert.equal(events[1].kind, 'update');

    // 変化後、再び同一内容で連投しても増えない。
    coordinator.acceptKmoni(changed);
    coordinator.acceptKmoni(changed);
    assert.equal(events.length, 2, '変化後の同一内容でまた update が増えている');
  });

  it('キャンセル報は cancel', () => {
    const { coordinator, events } = makeCoordinator();
    const report = (isCancel, announcedAt) => ({
      id: '20260817111000',
      reportNumber: 1,
      alert: 'forecast',
      isCancel,
      isFinal: false,
      isTraining: false,
      hypocenter: { name: '日向灘', lat: 32.3, lon: 131.9, depthKm: 30, magnitude: 5.2 },
      maxIntensity: 40,
      originTime: new Date('2026-08-17T02:10:00.000Z'),
      announcedAt: new Date(announcedAt),
    });
    coordinator.acceptKmoni(report(false, '2026-08-17T02:10:05.000Z'));
    coordinator.acceptKmoni(report(true, '2026-08-17T02:10:08.000Z'));
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'new');
    assert.equal(events[1].kind, 'cancel');
  });
});

describe('kmoni レポートの変換', () => {
  it('EewState へ落とし込む', () => {
    const state = kmoniToState({
      id: '20260813111000',
      reportNumber: 3,
      alert: 'warning',
      isCancel: false,
      isFinal: true,
      isTraining: false,
      hypocenter: { name: '日向灘', lat: 32.3, lon: 131.9, depthKm: 30, magnitude: 5.2 },
      maxIntensity: 45,
      originTime: new Date('2026-08-13T02:10:00.000Z'),
      announcedAt: new Date('2026-08-13T02:10:05.000Z'),
    });
    assert.equal(state.source, 'kmoni');
    assert.equal(state.alert, 'warning');
    assert.equal(state.isFinal, true);
    assert.equal(state.originTime, '2026-08-13T02:10:00.000Z');
    // kmoni EEW JSON は地域別の予想震度を持たない
    assert.deepEqual(state.regions, []);
  });
});
