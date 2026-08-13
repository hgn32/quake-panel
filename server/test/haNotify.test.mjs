import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';
import {
  HomeAssistantNotifier,
  buildEntities,
  eewEventData,
  eewEventKey,
} from '../dist/haNotify.js';
import { Hub } from '../dist/hub.js';

const EEW = {
  id: 'e1',
  reportNumber: 3,
  isFinal: false,
  isCancel: false,
  isTraining: false,
  isAssumption: false,
  alert: 'warning',
  hypocenter: { name: '日向灘', lat: 32.1, lon: 131.9, depthKm: 30, magnitude: 6.4 },
  maxIntensity: 50,
  originTime: '2026-08-13T04:00:00.000Z',
  announcedAt: '2026-08-13T04:00:05.000Z',
  receivedAt: '2026-08-13T04:00:06.000Z',
  regions: [],
  source: 'both',
};

describe('Home Assistant への通知の中身', () => {
  it('続報のたびではなく、意味が変わったときだけ流す', () => {
    assert.equal(eewEventKey(EEW), eewEventKey({ ...EEW, reportNumber: 9 }));
    assert.notEqual(eewEventKey(EEW), eewEventKey({ ...EEW, alert: 'forecast' }));
    assert.notEqual(eewEventKey(EEW), eewEventKey({ ...EEW, isCancel: true }));
    assert.equal(eewEventKey(null), 'none');
  });

  it('自動化で使う値が入っている', () => {
    const data = eewEventData(EEW);
    assert.equal(data.is_warning, true);
    assert.equal(data.max_intensity, '5強');
    assert.equal(data.hypocenter, '日向灘');
    assert.equal(data.report_number, 3);
  });

  it('訓練報とキャンセル報では「発表中」にしない', () => {
    const find = (entities, id) => entities.find((e) => e.entityId === id);
    assert.equal(find(buildEntities(EEW, null, null), 'binary_sensor.quake_panel_eew').state, 'on');
    assert.equal(
      find(buildEntities({ ...EEW, isTraining: true }, null, null), 'binary_sensor.quake_panel_eew')
        .state,
      'off',
    );
    assert.equal(
      find(buildEntities({ ...EEW, isCancel: true }, null, null), 'binary_sensor.quake_panel_eew')
        .state,
      'off',
    );
  });

  it('津波は解除済み・対象なしなら off', () => {
    const areas = [{ name: '宮崎県', grade: 'Warning', immediate: false, firstHeightCondition: null, firstHeightArrivalTime: null, maxHeightDescription: null, maxHeightValue: null, isHome: false }];
    const on = buildEntities(null, { id: 't1', issuedAt: null, cancelled: false, areas, affectsHome: false, receivedAt: '' }, null);
    const off = buildEntities(null, { id: 't1', issuedAt: null, cancelled: true, areas, affectsHome: false, receivedAt: '' }, null);
    const state = (entities) => entities.find((e) => e.entityId === 'binary_sensor.quake_panel_tsunami').state;
    assert.equal(state(on), 'on');
    assert.equal(state(off), 'off');
  });
});

describe('Home Assistant への送信', () => {
  it('設定が無ければ何もしない', () => {
    const config = loadConfig({});
    const notifier = new HomeAssistantNotifier(config, new Hub(config));
    assert.equal(notifier.enabled, false);
  });

  it('EEW でイベントを発火し、センサーを更新する', async () => {
    const received = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const config = loadConfig({
      HA_API_URL: `http://127.0.0.1:${port}/api`,
      SUPERVISOR_TOKEN: 'test-token',
    });
    const hub = new Hub(config);
    const notifier = new HomeAssistantNotifier(config, hub);
    assert.equal(notifier.enabled, true);
    notifier.start();
    hub.publishEew(EEW);
    // 送信は非同期なので落ち着くまで待つ
    await new Promise((r) => setTimeout(r, 300));
    notifier.stop();
    server.close();

    const event = received.find((r) => r.url === '/api/events/quake_panel_eew');
    assert.ok(event, 'イベントが発火されていない');
    assert.equal(event.auth, 'Bearer test-token');
    assert.equal(event.body.is_warning, true);

    // 起動直後にも「発表なし」で入れ直すので、最後の 1 件を見る
    const sensor = received.findLast((r) => r.url === '/api/states/binary_sensor.quake_panel_eew');
    assert.ok(sensor, 'センサーが更新されていない');
    assert.equal(sensor.body.state, 'on');
    const intensity = received.findLast(
      (r) => r.url === '/api/states/sensor.quake_panel_eew_intensity',
    );
    assert.equal(intensity.body.state, '5強');
  });

  it('HA が落ちていてもサーバーは死なない', async () => {
    const config = loadConfig({
      HA_API_URL: 'http://127.0.0.1:9/api',
      SUPERVISOR_TOKEN: 'test-token',
      HA_REQUEST_TIMEOUT_MS: '200',
    });
    const hub = new Hub(config);
    const notifier = new HomeAssistantNotifier(config, hub);
    notifier.start();
    hub.publishEew(EEW);
    await new Promise((r) => setTimeout(r, 400));
    notifier.stop();
    // 例外で落ちなければ良い
    assert.ok(true);
  });
});
