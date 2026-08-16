import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';

import { loadConfig } from '../dist/config.js';
import { HomeAssistantNotifier } from '../dist/haNotify.js';
import { Hub } from '../dist/hub.js';
import { ClientWebSocketServer } from '../dist/ws/server.js';

/**
 * アドオンの絞り込み (HA_NOTIFY_*) は HA への通知だけに効き、
 * ブラウザへの配信には一切効かない、という設計をそのまま確かめる。
 *
 * hubIsolation.test.mjs は Hub のリスナーを直接覗いているので、
 * 「WebSocket に載せるところで絞られていないか」までは見ていない。
 * ここでは**本物の ClientWebSocketServer に本物の WebSocket で繋いで**、
 * 絞り込みで落ちるはずの地震・津波が画面側にはそのまま届くことを確かめる。
 */
const point = (pref, scale) => ({ pref, addr: `${pref}某所`, isArea: false, scale });

const QUAKE = {
  id: 'q-hokkaido',
  issuedAt: null,
  occurredAt: '2026-08-16T02:00:00.000Z',
  issueType: 'DetailScale',
  hypocenter: { name: '浦河沖', lat: 42.0, lon: 142.5, depthKm: 50, magnitude: 4.0 },
  maxIntensity: 20,
  domesticTsunami: 'None',
  points: [point('北海道', 20)],
  receivedAt: '2026-08-16T02:00:01.000Z',
};

const TSUNAMI = {
  id: 't-tohoku',
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
  receivedAt: '2026-08-16T02:00:00.000Z',
};

/**
 * 偽の HA・本物の HTTP/WS サーバーを立て、本物の WebSocket で 1 台繋いだ状態で
 * publish する。画面側が受け取ったメッセージと、HA へ飛んだ URL を両方返す。
 */
const withPanel = (env, publish) => {
  const haCalls = [];
  const ha = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      haCalls.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  const http = createServer();
  let ws;
  let notifier;

  return new Promise((resolve) => ha.listen(0, '127.0.0.1', resolve))
    .then(() => new Promise((resolve) => http.listen(0, '127.0.0.1', resolve)))
    .then(() => {
      const config = loadConfig({
        HA_API_URL: `http://127.0.0.1:${ha.address().port}/api`,
        SUPERVISOR_TOKEN: 'test-token',
        ...env,
      });
      const hub = new Hub(config);
      notifier = new HomeAssistantNotifier(config, hub);
      notifier.start();
      const wsServer = new ClientWebSocketServer(http, config, hub);
      wsServer.start();

      const received = [];
      ws = new WebSocket(`ws://127.0.0.1:${http.address().port}/ws`);
      ws.on('message', (data) => received.push(JSON.parse(String(data))));

      return new Promise((resolve) => ws.on('open', resolve))
        .then(() => new Promise((resolve) => setTimeout(resolve, 100)))
        .then(() => {
          publish(hub);
          return new Promise((resolve) => setTimeout(resolve, 400));
        })
        .then(() => {
          ws.close();
          notifier.stop();
          wsServer.stop?.();
          http.close();
          ha.close();
          return { received, haCalls };
        });
    });
};

describe('アドオンの絞り込みはブラウザ配信に効かない (本物の WebSocket で確認)', () => {
  it('絞り込みで落ちる地震・津波も、画面へはそのまま届く', () =>
    withPanel(
      { HA_NOTIFY_MIN_INTENSITY: '震度5弱以上', HA_NOTIFY_PREFECTURES: '宮崎県' },
      (hub) => {
        hub.publishQuake(QUAKE);
        hub.publishTsunami(TSUNAMI);
      },
    ).then(({ received, haCalls }) => {
      const quake = received.find((m) => m.type === 'quake');
      assert.ok(quake, '地震情報が WebSocket に届いていない');
      // 震度も観測点も削られていない
      assert.equal(quake.quake.maxIntensity, 20);
      assert.deepEqual(quake.quake.points.map((p) => p.pref), ['北海道']);

      const tsunami = received.find((m) => m.type === 'tsunami');
      assert.ok(tsunami, '津波予報が WebSocket に届いていない');
      assert.equal(tsunami.tsunami.areas[0].name, '東北地方太平洋沿岸');
      // 印を付けるのは各端末の仕事なので、配信時点では付いていない
      assert.equal(tsunami.tsunami.areas[0].isHome, false);
      assert.equal(tsunami.tsunami.affectsHome, false);

      // HA 側へはイベントが飛んでいない (絞り込みで落ちている)
      assert.deepEqual(
        haCalls.filter((url) => url.startsWith('/api/events/')),
        [],
        'HA へは通知されないはず',
      );
    }));

  it('絞り込みを通る地震は、画面にも HA にも届く', () =>
    withPanel({ HA_NOTIFY_MIN_INTENSITY: '震度1以上' }, (hub) => {
      hub.publishQuake(QUAKE);
    }).then(({ received, haCalls }) => {
      assert.ok(received.find((m) => m.type === 'quake'), '画面へ届いていない');
      assert.ok(
        haCalls.some((url) => url === '/api/events/quake_panel_quake'),
        'HA へ届いていない',
      );
    }));

  it('接続直後のスナップショットも絞り込まれない', () =>
    withPanel({ HA_NOTIFY_PREFECTURES: '宮崎県' }, (hub) => {
      hub.publishQuake(QUAKE);
    }).then(({ received }) => {
      const hello = received.find((m) => m.type === 'hello');
      assert.ok(hello, 'hello が来ていない');
      // hello は接続時なのでこの地震はまだ入らないが、履歴の器は生きている
      assert.ok(Array.isArray(hello.snapshot.quakes));
    }));
});
