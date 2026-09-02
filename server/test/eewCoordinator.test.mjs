import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import {
  EewCoordinator,
  formatEewLogLine,
  isSameEvent,
  kmoniToState,
  mergeStates,
} from '../dist/eew/coordinator.js';
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

describe('EEW ログの整形', () => {
  it('震度コードを表示ラベルに変換する (震度2)', () => {
    const eew = { ...base, maxIntensity: 20 };
    assert.equal(formatEewLogLine(eew), 'EEW forecast 日向灘 M5.2 最大震度2 (kmoni)');
  });

  it('5弱を表示ラベルに変換する', () => {
    const eew = { ...base, maxIntensity: 45 };
    assert.equal(formatEewLogLine(eew), 'EEW forecast 日向灘 M5.2 最大震度5弱 (kmoni)');
  });

  it('5弱以上 (震度計不明) を表示ラベルに変換する', () => {
    const eew = { ...base, maxIntensity: 46 };
    assert.equal(formatEewLogLine(eew), 'EEW forecast 日向灘 M5.2 最大震度5弱以上 (kmoni)');
  });

  it('震度7を表示ラベルに変換する', () => {
    const eew = { ...base, maxIntensity: 70 };
    assert.equal(formatEewLogLine(eew), 'EEW forecast 日向灘 M5.2 最大震度7 (kmoni)');
  });

  it('震度が不明のときは ? を表示する', () => {
    const eew = { ...base, maxIntensity: null };
    assert.equal(formatEewLogLine(eew), 'EEW forecast 日向灘 M5.2 最大震度? (kmoni)');
  });

  it('マグニチュード不明でも震度ラベル化と併存する', () => {
    const eew = { ...base, maxIntensity: 20, hypocenter: { ...base.hypocenter, magnitude: null } };
    assert.equal(formatEewLogLine(eew), 'EEW forecast 日向灘 M? 最大震度2 (kmoni)');
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

/**
 * 保持期限 (sweep) の確認。
 *
 * kmoni は最終報のあとも同じ内容を約3.5分返し続ける (2026-09-02 実測。
 * docs/kmoni-endpoints.md §1-2)。この性質のもとでも保持期限が延び続けない
 * ことと、最終報は通常より短く消えることを、mock timers で時間を進めて確認する。
 */
describe('保持期限 (sweep)', () => {
  afterEach(() => {
    mock.timers.reset();
  });

  /** hub の publishEew に渡った値をすべて記録するフェイク */
  const makeSweepCoordinator = (config) => {
    const publishes = [];
    const coordinator = new EewCoordinator({
      config,
      hub: { publishEew: (eew) => publishes.push(eew) },
      onActiveChange: () => {},
    });
    return { coordinator, publishes };
  };

  const hyugaReport = (patch = {}) => ({
    id: '20260902082446',
    reportNumber: 1,
    alert: 'forecast',
    isCancel: false,
    isFinal: false,
    isTraining: false,
    hypocenter: { name: '日向灘', lat: 31.9, lon: 131.8, depthKm: 10, magnitude: 3.6 },
    maxIntensity: 20,
    originTime: new Date('2026-09-02T08:24:46.000Z'),
    announcedAt: new Date('2026-09-02T08:24:50.000Z'),
    ...patch,
  });

  it('【回帰】同一内容の報を毎秒受け続けても保持期限は延びない (不具合 C)', () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { coordinator, publishes } = makeSweepCoordinator(loadConfig({}));
    coordinator.start();

    coordinator.acceptKmoni(hyugaReport());
    // kmoni は毎秒ポーリングされ、発表中は同一報が届き続ける。
    Array.from({ length: 170 }).forEach(() => {
      mock.timers.tick(1000);
      coordinator.acceptKmoni(hyugaReport());
    });
    assert.equal(
      publishes.includes(null),
      false,
      '170 秒時点 (既定の保持時間 180 秒未満) なのに expired になっている',
    );

    mock.timers.tick(15_000); // 170s → 185s
    assert.equal(
      publishes[publishes.length - 1],
      null,
      '185 秒時点 (保持時間 180 秒超) なのに expired になっていない',
    );

    coordinator.stop();
  });

  it('最終報は短い保持時間 (既定 60 秒) で表示を終える', () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { coordinator, publishes } = makeSweepCoordinator(loadConfig({}));
    coordinator.start();

    coordinator.acceptKmoni(hyugaReport({ reportNumber: 5, isFinal: true }));
    mock.timers.tick(65_000);
    assert.equal(
      publishes[publishes.length - 1],
      null,
      '最終報は 65 秒経過で expired になっているはず',
    );

    coordinator.stop();
  });

  it('通常報 (最終報でない) は 65 秒ではまだ消えない', () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { coordinator, publishes } = makeSweepCoordinator(loadConfig({}));
    coordinator.start();

    coordinator.acceptKmoni(hyugaReport({ reportNumber: 3, isFinal: false }));
    mock.timers.tick(65_000);
    assert.equal(publishes.includes(null), false, '通常報が 65 秒で消えてしまっている');

    coordinator.stop();
  });
});

describe('EEW_FINAL_RETENTION_MS の丸め', () => {
  it('EEW_RETENTION_MS を超える設定は EEW_RETENTION_MS まで丸められる', () => {
    const config = loadConfig({ EEW_RETENTION_MS: '30000', EEW_FINAL_RETENTION_MS: '90000' });
    assert.equal(config.eewRetentionMs, 30000);
    assert.equal(config.eewFinalRetentionMs, 30000);
  });

  it('EEW_RETENTION_MS 以下の設定はそのまま使われる', () => {
    const config = loadConfig({ EEW_RETENTION_MS: '180000', EEW_FINAL_RETENTION_MS: '45000' });
    assert.equal(config.eewFinalRetentionMs, 45000);
  });
});
