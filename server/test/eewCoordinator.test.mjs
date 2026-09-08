import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import {
  EewCoordinator,
  formatEewLogLine,
  isSameEvent,
  isStaleRepeat,
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

describe('焼き直し電文の判定 (isStaleRepeat)', () => {
  it('別の地震なら焼き直しではない', () => {
    const other = { ...base, id: 'b', originTime: '2026-08-13T02:12:00.000Z' };
    assert.equal(isStaleRepeat(base, other), false);
  });

  it('同じ地震で報数が同じなら焼き直し', () => {
    assert.equal(isStaleRepeat(base, { ...base }), true);
  });

  it('同じ地震で報数が減っていても (来ないはずだが) 焼き直し扱い', () => {
    const expired = { ...base, reportNumber: 3 };
    const incoming = { ...base, reportNumber: 2 };
    assert.equal(isStaleRepeat(expired, incoming), true);
  });

  it('報数が増えた続報は焼き直しではない', () => {
    const expired = { ...base, reportNumber: 3 };
    const incoming = { ...base, reportNumber: 4 };
    assert.equal(isStaleRepeat(expired, incoming), false);
  });

  it('キャンセルの立ち上がりは報数が同じでも焼き直しではない', () => {
    const expired = { ...base, reportNumber: 3, isCancel: false };
    const incoming = { ...base, reportNumber: 3, isCancel: true };
    assert.equal(isStaleRepeat(expired, incoming), false);
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

  /** hub の publishEew に渡った値と onEewEvent のイベントをすべて記録するフェイク */
  const makeSweepCoordinator = (config) => {
    const publishes = [];
    const events = [];
    const coordinator = new EewCoordinator({
      config,
      hub: { publishEew: (eew) => publishes.push(eew) },
      onActiveChange: () => {},
      onEewEvent: (event) => events.push(event),
    });
    return { coordinator, publishes, events };
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

  it('【回帰】最終報で表示終了したあと、同じ電文を受け続けても new が再発火しない (1 回の地震で通知が何度も飛んでいた不具合)', () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { coordinator, publishes, events } = makeSweepCoordinator(loadConfig({}));
    coordinator.start();

    const finalReport = hyugaReport({ reportNumber: 4, isFinal: true });
    coordinator.acceptKmoni(finalReport);
    mock.timers.tick(65_000); // 最終報の保持時間 (既定 60 秒) を超えて expired になる
    assert.equal(publishes[publishes.length - 1], null, '65 秒経過しても expired になっていない');
    assert.equal(
      events.filter((e) => e.kind === 'new').length,
      1,
      '最初の発表で new が 1 回発火しているはず',
    );

    // kmoni は最終報のあとも約3.5分は同じ電文を返し続ける (2026-09-02 実測)。
    // ここではその再受信を模して、同一内容の報を複数回 (60 秒間隔を想定して sweep を挟みつつ) accept する。
    Array.from({ length: 3 }).forEach(() => {
      coordinator.acceptKmoni(finalReport);
      mock.timers.tick(60_000);
    });

    assert.equal(
      events.filter((e) => e.kind === 'new').length,
      1,
      '焼き直しの電文で new が再発火している (通知が何度も飛ぶ不具合の再発)',
    );
    assert.equal(
      publishes.filter((p) => p !== null).length,
      1,
      '焼き直しの電文で publishEew (表示の復活) が再び呼ばれている',
    );

    coordinator.stop();
  });

  it('表示終了後でも報数が増えた続報は受け付ける (new が飛ぶ)', () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { coordinator, events } = makeSweepCoordinator(loadConfig({}));
    coordinator.start();

    coordinator.acceptKmoni(hyugaReport({ reportNumber: 4, isFinal: true }));
    mock.timers.tick(65_000); // expired になる

    coordinator.acceptKmoni(hyugaReport({ reportNumber: 5, isFinal: true }));
    assert.equal(
      events[events.length - 1].kind,
      'new',
      '表示終了後に届いた報数の増えた続報は new として受け付けるはず',
    );

    coordinator.stop();
  });

  it('表示終了後に届いたキャンセル報は受け付ける (cancel が飛ぶ)', () => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { coordinator, events } = makeSweepCoordinator(loadConfig({}));
    coordinator.start();

    coordinator.acceptKmoni(hyugaReport({ reportNumber: 4, isFinal: true }));
    mock.timers.tick(65_000); // expired になる

    coordinator.acceptKmoni(hyugaReport({ reportNumber: 4, isFinal: true, isCancel: true }));
    assert.equal(
      events[events.length - 1].kind,
      'cancel',
      '表示終了後に届いたキャンセル報は cancel として受け付けるはず',
    );

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
