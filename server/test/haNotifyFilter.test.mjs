import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';
import { HomeAssistantNotifier, describeFilter } from '../dist/haNotify.js';
import { Hub } from '../dist/hub.js';

const point = (pref, scale) => ({ pref, addr: `${pref}某所`, isArea: false, scale });

const quake = (id, maxIntensity, points) => ({
  id,
  issuedAt: null,
  occurredAt: null,
  issueType: 'DetailScale',
  hypocenter: { name: '日向灘', lat: 32.1, lon: 131.9, depthKm: 30, magnitude: 4.2 },
  maxIntensity,
  domesticTsunami: 'None',
  points,
  receivedAt: '2026-08-15T10:00:00.000Z',
});

const eew = (maxIntensity, regions, extra = {}) => ({
  id: 'e1',
  reportNumber: 2,
  isFinal: false,
  isCancel: false,
  isTraining: false,
  isAssumption: false,
  alert: 'warning',
  hypocenter: { name: '台湾付近', lat: 24.0, lon: 122.0, depthKm: 30, magnitude: 6.4 },
  maxIntensity,
  originTime: null,
  announcedAt: null,
  receivedAt: '2026-08-15T10:00:00.000Z',
  regions,
  source: 'both',
  ...extra,
});

/** 送信先の HA を立てて、届いたリクエストを記録する */
const withFakeHa = (env, body) => {
  const received = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    .then(() => {
      const config = loadConfig({
        HA_API_URL: `http://127.0.0.1:${server.address().port}/api`,
        SUPERVISOR_TOKEN: 'test-token',
        ...env,
      });
      const hub = new Hub(config);
      const notifier = new HomeAssistantNotifier(config, hub);
      notifier.start();
      body(hub);
      // 送信は非同期なので落ち着くまで待つ
      return new Promise((resolve) => setTimeout(resolve, 300)).then(() => {
        notifier.stop();
        server.close();
        return received;
      });
    });
};

const events = (received, type) => received.filter((r) => r.url === `/api/events/${type}`);
const lastState = (received, entityId) =>
  received.findLast((r) => r.url === `/api/states/${entityId}`);

describe('HA_NOTIFY_MIN_INTENSITY / HA_NOTIFY_PREFECTURES', () => {
  it('既定は絞り込みなし', () => {
    const filter = loadConfig({}).homeAssistant.filter;
    assert.equal(filter.minIntensity, 0);
    assert.deepEqual(filter.prefectures, []);
  });

  it('環境変数を読む (ラベル・整数コードのどちらでも)', () => {
    assert.equal(
      loadConfig({ HA_NOTIFY_MIN_INTENSITY: '震度4以上' }).homeAssistant.filter.minIntensity,
      40,
    );
    assert.equal(loadConfig({ HA_NOTIFY_MIN_INTENSITY: '45' }).homeAssistant.filter.minIntensity, 45);
    assert.deepEqual(
      loadConfig({ HA_NOTIFY_PREFECTURES: '宮崎県, 鹿児島県' }).homeAssistant.filter.prefectures,
      ['宮崎県', '鹿児島県'],
    );
  });

  it('解釈できない値でも起動を止めず、絞り込みなしに落とす', () => {
    assert.equal(
      loadConfig({ HA_NOTIFY_MIN_INTENSITY: 'つよいやつ' }).homeAssistant.filter.minIntensity,
      0,
    );
  });

  it('ログに出す説明で何が届かないか分かる', () => {
    assert.equal(
      describeFilter({ minIntensity: 45, prefectures: ['宮崎県'], areas: [] }),
      '通知条件: 震度5弱以上 / 宮崎県',
    );
    assert.equal(
      describeFilter({ minIntensity: 0, prefectures: [], areas: [] }),
      '通知条件: 震度の条件なし / 全国',
    );
    // 細分区域も同じ行に出す (ログタブだけで何が届かないか分かるように)
    assert.equal(
      describeFilter({ minIntensity: 0, prefectures: ['宮崎県'], areas: ['熊本県熊本'] }),
      '通知条件: 震度の条件なし / 宮崎県・熊本県熊本',
    );
  });
});

describe('絞り込みが実際に送信を止める', () => {
  it('しきい値未満の地震情報はイベントもセンサーも動かさない', () =>
    withFakeHa({ HA_NOTIFY_MIN_INTENSITY: '震度4以上' }, (hub) => {
      hub.publishQuake(quake('q1', 20, [point('宮崎県', 20)]));
    }).then((received) => {
      assert.equal(events(received, 'quake_panel_quake').length, 0);
      // 起動直後の入れ直しぶんは残るが、中身は「地震なし」のまま
      assert.equal(lastState(received, 'sensor.quake_panel_last_quake').body.state, 'unknown');
    }));

  it('しきい値を満たす地震情報は流す', () =>
    withFakeHa({ HA_NOTIFY_MIN_INTENSITY: '震度4以上' }, (hub) => {
      hub.publishQuake(quake('q2', 40, [point('宮崎県', 40)]));
    }).then((received) => {
      assert.equal(events(received, 'quake_panel_quake').length, 1);
      assert.equal(lastState(received, 'sensor.quake_panel_last_quake').body.state, '4');
    }));

  it('対象外の県の地震情報は流さない', () =>
    withFakeHa({ HA_NOTIFY_PREFECTURES: '宮崎県' }, (hub) => {
      hub.publishQuake(quake('q3', 30, [point('高知県', 30)]));
    }).then((received) => {
      assert.equal(events(received, 'quake_panel_quake').length, 0);
    }));

  it('対象外の緊急地震速報 (台湾付近など) は「発表中」にしない', () =>
    withFakeHa({ HA_NOTIFY_PREFECTURES: '宮崎県' }, (hub) => {
      hub.publishEew(eew(40, [{ pref: '沖縄県', name: '沖縄本島地方', scaleFrom: 40, scaleTo: null, arrivalTime: null, condition: null }]));
    }).then((received) => {
      assert.equal(events(received, 'quake_panel_eew').length, 0);
      assert.equal(lastState(received, 'binary_sensor.quake_panel_eew').body.state, 'off');
    }));

  it('一度流した地震の続報は、下方修正で条件を外れても流し続ける (解除を伝えるため)', () =>
    withFakeHa({ HA_NOTIFY_MIN_INTENSITY: '震度4以上' }, (hub) => {
      hub.publishEew(eew(50, []));
      hub.publishEew(eew(20, [], { reportNumber: 5 }));
      hub.publishEew(eew(20, [], { reportNumber: 6, isCancel: true }));
    }).then((received) => {
      // 第一報 (5強) / 下方修正 (2) / 取消 の 3 件
      assert.equal(events(received, 'quake_panel_eew').length, 3);
      assert.equal(lastState(received, 'binary_sensor.quake_panel_eew').body.state, 'off');
    }));
});
