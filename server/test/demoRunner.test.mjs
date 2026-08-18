import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { loadConfig } from '../dist/config.js';
import { DemoRunner } from '../dist/demo/runner.js';
import { Hub } from '../dist/hub.js';

/**
 * デモ再生 (server/src/demo/runner.ts) の確認。
 *
 * タイマーは node:test の mock timers で進める。DemoRunner は Date.now() で
 * T0 を決めるため、mock.timers.enable() の既定 (Date も含めて偽の時計にする) を使う。
 */

/** Hub の 'event' を記録するだけの疑似購読者。ClientWebSocketServer と同じ立場。 */
const attachRecorder = (hub) => {
  const events = [];
  hub.on('event', (event) => events.push(event));
  return events;
};

const makeHub = () => new Hub(loadConfig({}));

/** 実際の (demo- でない) EEW の最小フィクスチャ */
const REAL_EEW = {
  id: '20260817111005',
  reportNumber: 1,
  isFinal: false,
  isCancel: false,
  isTraining: false,
  isAssumption: false,
  alert: 'forecast',
  hypocenter: { name: '種子島近海', lat: 30.5, lon: 131.0, depthKm: 20, magnitude: 4.5 },
  maxIntensity: 30,
  originTime: '2026-08-17T02:10:00.000Z',
  announcedAt: '2026-08-17T02:10:05.000Z',
  receivedAt: '2026-08-17T02:10:05.500Z',
  regions: [],
  source: 'kmoni',
};

describe('デモ再生 (DemoRunner)', () => {
  afterEach(() => {
    mock.timers.reset();
  });

  it('forecast: 第1報 → 続報 → 最終報 → null の順で流れる', () => {
    mock.timers.enable();
    const hub = makeHub();
    const events = attachRecorder(hub);
    const runner = new DemoRunner(hub);

    runner.trigger('forecast');
    mock.timers.tick(36_000);

    const eewEvents = events.filter((e) => e.type === 'eew');
    // 第1報〜第11報 (T0, T0+2s, ..., T0+20s) + 表示終了の null
    assert.equal(eewEvents.length, 12);

    const reports = eewEvents.slice(0, 11);
    assert.deepEqual(
      reports.map((e) => e.eew.reportNumber),
      Array.from({ length: 11 }, (_, i) => i + 1),
    );
    reports.forEach((e) => {
      assert.equal(e.eew.id.startsWith('demo-'), true, 'id が demo- で始まっていない');
      assert.equal(e.eew.alert, 'forecast');
      assert.equal(e.eew.maxIntensity, 40);
      assert.equal(e.eew.hypocenter.name, '日向灘');
    });
    assert.equal(reports[10].eew.isFinal, true, '最終報が isFinal になっていない');
    assert.equal(
      reports.slice(0, 10).every((e) => e.eew.isFinal === false),
      true,
      '最終報より前が isFinal になっている',
    );
    assert.equal(eewEvents[11].eew, null, '最後に eew:null が来ていない');
  });

  it('warning: T0+8s に警報へ格上げされ、地域が付く', () => {
    mock.timers.enable();
    const hub = makeHub();
    const events = attachRecorder(hub);
    const runner = new DemoRunner(hub);

    runner.trigger('warning');
    mock.timers.tick(36_000);

    const reports = events.filter((e) => e.type === 'eew' && e.eew !== null).map((e) => e.eew);
    // offset 0,2,4,6 (T0+0〜6s) はまだ予報、offset 8 (T0+8s = 第5報) から警報
    const beforeUpgrade = reports.filter((r) => r.reportNumber <= 4);
    const afterUpgrade = reports.filter((r) => r.reportNumber >= 5);

    assert.equal(beforeUpgrade.length, 4);
    beforeUpgrade.forEach((r) => {
      assert.equal(r.alert, 'forecast');
      assert.equal(r.source, 'kmoni');
      assert.deepEqual(r.regions, []);
    });

    assert.equal(afterUpgrade.length, 7);
    afterUpgrade.forEach((r) => {
      assert.equal(r.alert, 'warning');
      assert.equal(r.maxIntensity, 45);
      assert.equal(r.source, 'both');
      assert.equal(r.regions.length, 2);
      assert.deepEqual(
        r.regions.map((region) => region.name),
        ['宮崎県南部平野部', '宮崎県北部平野部'],
      );
    });
  });

  it('進行中に実際の EEW を受けたら、以降のデモ配信が止まる', () => {
    mock.timers.enable();
    const hub = makeHub();
    const events = attachRecorder(hub);
    const runner = new DemoRunner(hub);

    runner.trigger('forecast');
    // T0(+1s)、T0+2s の 2 報だけ進める
    mock.timers.tick(3_000);
    const demoCountBeforeReal = events.filter(
      (e) => e.type === 'eew' && e.eew && e.eew.id.startsWith('demo-'),
    ).length;
    assert.equal(demoCountBeforeReal, 2);

    // 実際の EEW (id が demo- でない) が届く
    hub.publishEew(REAL_EEW);

    // 残っていたはずのデモの続報・null 分をすべて進めても増えない
    mock.timers.tick(60_000);

    const demoCountAfterReal = events.filter(
      (e) => e.type === 'eew' && e.eew && e.eew.id.startsWith('demo-'),
    ).length;
    assert.equal(demoCountAfterReal, demoCountBeforeReal, '実イベント受信後もデモが配信され続けている');

    const realCount = events.filter((e) => e.type === 'eew' && e.eew && e.eew.id === REAL_EEW.id).length;
    assert.equal(realCount, 1, '実イベント自体は届いているはず');
  });

  it('再トリガで前のデモが上書きされる', () => {
    mock.timers.enable();
    const hub = makeHub();
    const events = attachRecorder(hub);
    const runner = new DemoRunner(hub);

    runner.trigger('forecast');
    mock.timers.tick(3_000); // forecast の第1・2報まで進める

    runner.trigger('warning'); // 上書き
    mock.timers.tick(40_000);

    const eewEvents = events.filter((e) => e.type === 'eew' && e.eew !== null);
    // 上書き前後で id (T0 が違う) が変わるので、シナリオではなく id で数える
    const ids = [...new Set(eewEvents.map((e) => e.eew.id))];
    assert.equal(ids.length, 2, '前のデモと新しいデモで id が 2 種類になっているはず');
    const [oldId, newId] = ids;

    const oldReports = eewEvents.filter((e) => e.eew.id === oldId);
    const newReports = eewEvents.filter((e) => e.eew.id === newId);

    // 前のデモ (forecast) は上書き前の 2 報だけ (続きの第3報以降は発火しない)
    assert.equal(oldReports.length, 2);
    // 新しいデモ (warning) は全 11 報が最後まで流れる
    assert.equal(newReports.length, 11);

    const nullEvents = events.filter((e) => e.type === 'eew' && e.eew === null);
    // 上書き時に前のデモ (forecast) の表示終了 null がその場で 1 回配信され (残留防止)、
    // さらに warning 側の表示終了 null が最後に 1 回配信されるので、合計 2 回。
    assert.equal(nullEvents.length, 2);
  });

  it('不正なシナリオは無視する', () => {
    mock.timers.enable();
    const hub = makeHub();
    const events = attachRecorder(hub);
    const runner = new DemoRunner(hub);

    runner.trigger('unknown-scenario');
    mock.timers.tick(60_000);

    assert.equal(events.length, 0);
  });

  it('forecast: onEewEvent が new → update×10 → expired の順で流れ、id は demo- で始まる', () => {
    mock.timers.enable();
    const hub = makeHub();
    const eewEvents = [];
    const runner = new DemoRunner(hub, (event) => eewEvents.push(event));

    runner.trigger('forecast');
    mock.timers.tick(36_000);

    assert.deepEqual(
      eewEvents.map((e) => e.kind),
      ['new', ...Array.from({ length: 10 }, () => 'update'), 'expired'],
    );
    eewEvents.forEach((e) => {
      assert.equal(e.eew.id.startsWith('demo-'), true, 'id が demo- で始まっていない');
    });
  });

  it('cancel: 初めて取消になった報でだけ cancel が 1 回発火し、以降は update になる', () => {
    mock.timers.enable();
    const hub = makeHub();
    const eewEvents = [];
    const runner = new DemoRunner(hub, (event) => eewEvents.push(event));

    runner.trigger('cancel');
    mock.timers.tick(30_000);

    const cancelEvents = eewEvents.filter((e) => e.kind === 'cancel');
    assert.equal(cancelEvents.length, 1, 'cancel はちょうど 1 回のはず');
    // offset 14s = 第8報 (index 7, reportNumber 8) で初めて取消になる
    assert.equal(cancelEvents[0].eew.reportNumber, 8);
    assert.equal(cancelEvents[0].eew.isCancel, true);

    const afterCancelIndex = eewEvents.indexOf(cancelEvents[0]);
    const afterCancel = eewEvents.slice(afterCancelIndex + 1).filter((e) => e.kind !== 'expired');
    afterCancel.forEach((e) => {
      assert.equal(e.kind, 'update', 'cancel より後の続報は update のはず');
    });
  });

  it('コールバック未指定でも例外なく動く', () => {
    mock.timers.enable();
    const hub = makeHub();
    const events = attachRecorder(hub);
    const runner = new DemoRunner(hub);

    runner.trigger('forecast');
    assert.doesNotThrow(() => mock.timers.tick(36_000));

    assert.equal(events.filter((e) => e.type === 'eew').length, 12);
  });

  it('stop(): EEW デモ進行中に止めると、その場で null が配信され expired が飛ぶ', () => {
    mock.timers.enable();
    const hub = makeHub();
    const events = attachRecorder(hub);
    const eewEvents = [];
    const runner = new DemoRunner(hub, (event) => eewEvents.push(event));

    runner.trigger('forecast');
    mock.timers.tick(3_000); // 第1・2報まで進める

    runner.stop();

    const nullEvents = events.filter((e) => e.type === 'eew' && e.eew === null);
    assert.equal(nullEvents.length, 1, 'stop() で null が配信されていない');
    assert.equal(
      eewEvents.filter((e) => e.kind === 'expired').length,
      1,
      'stop() で expired が 1 回飛んでいない',
    );

    // 以降タイマーを進めても、止めたデモの続きは配信されない
    const countBefore = events.filter((e) => e.type === 'eew').length;
    mock.timers.tick(60_000);
    assert.equal(events.filter((e) => e.type === 'eew').length, countBefore);
  });

  it('stop(): 津波デモ進行中 (解除前) に止めると、その場で解除報が配信される', () => {
    mock.timers.enable();
    const hub = makeHub();
    const events = attachRecorder(hub);
    const runner = new DemoRunner(hub);

    runner.trigger('tsunami');
    mock.timers.tick(2_000); // 第1報 (T0+1s) だけ配信させ、T0+40s の解除より前で止める

    runner.stop();

    const tsunamiEvents = events.filter((e) => e.type === 'tsunami');
    assert.equal(tsunamiEvents.length, 2, '第1報 + stop() による解除報の 2 件のはず');
    const cancelled = tsunamiEvents[1].tsunami;
    assert.equal(cancelled.cancelled, true);
    assert.deepEqual(cancelled.areas, []);

    // 以降タイマーを進めても (本来の T0+40s の解除タイマーは cancelTimers 済み)、追加配信は無い
    mock.timers.tick(60_000);
    assert.equal(events.filter((e) => e.type === 'tsunami').length, 2);
  });

  it('【回帰】津波デモ進行中に trigger で上書きすると、解除報が配信されてから新シナリオが始まる', () => {
    mock.timers.enable();
    const hub = makeHub();
    const events = attachRecorder(hub);
    const runner = new DemoRunner(hub);

    runner.trigger('tsunami');
    mock.timers.tick(2_000); // 第1報のみ配信させる (解除前)

    runner.trigger('forecast'); // 別デモで上書き

    const tsunamiEvents = events.filter((e) => e.type === 'tsunami');
    // 上書きの時点で、津波デモの解除報がその場で飛んでいなければならない
    // (修正前は cancelTimers() だけだったため、この解除報が飛ばず残留していた)
    assert.equal(tsunamiEvents.length, 2, '上書き時に津波の解除報が配信されていない (残留バグ)');
    assert.equal(tsunamiEvents[1].tsunami.cancelled, true);

    mock.timers.tick(36_000);
    const eewEvents = events.filter((e) => e.type === 'eew');
    // forecast の第1報〜第11報 + 表示終了の null が流れる
    assert.equal(eewEvents.length, 12, '上書き後の forecast デモが最後まで流れていない');
  });

  it('【回帰】津波デモ進行中に実 EEW を受けると、デモ津波の解除報が配信され、実 EEW の表示は消されない', () => {
    mock.timers.enable();
    const hub = makeHub();
    const events = attachRecorder(hub);
    const runner = new DemoRunner(hub);

    runner.trigger('tsunami');
    mock.timers.tick(2_000); // 第1報のみ配信させる (解除前)

    hub.publishEew(REAL_EEW); // 実 EEW (demo- でない id) の受信

    const tsunamiEvents = events.filter((e) => e.type === 'tsunami');
    // 実 EEW 受信をきっかけに、デモ津波の解除報がその場で飛んでいなければならない
    assert.equal(tsunamiEvents.length, 2, '実 EEW 受信時に津波の解除報が配信されていない (残留バグ)');
    assert.equal(tsunamiEvents[1].tsunami.cancelled, true);

    // 実 EEW 自体は届いており、null で消されてもいない
    const eewEvents = events.filter((e) => e.type === 'eew');
    assert.equal(eewEvents.length, 1, '実 EEW 以外の eew イベントが配信されている');
    assert.equal(eewEvents[0].eew && eewEvents[0].eew.id, REAL_EEW.id);
  });

  it('stop(): 何も進行していない状態で呼んでも例外にならず、何も配信されない', () => {
    mock.timers.enable();
    const hub = makeHub();
    const events = attachRecorder(hub);
    const runner = new DemoRunner(hub);

    assert.doesNotThrow(() => runner.stop());
    assert.equal(events.length, 0);
  });
});
