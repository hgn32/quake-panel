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
    // forecast 側の null (T0+35s) は上書きで止まっているので、warning 側の 1 回だけ
    assert.equal(nullEvents.length, 1);
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
});
