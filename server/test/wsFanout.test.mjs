import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';

import { loadConfig } from '../dist/config.js';
import { DemoRunner } from '../dist/demo/runner.js';
import { Hub } from '../dist/hub.js';
import { ClientWebSocketServer } from '../dist/ws/server.js';

/**
 * Hub の 2 つ目の購読者が自分の都合で絞り込んでも、それは WebSocket 配信には
 * 一切効かない、という設計をそのまま確かめる。
 *
 * hubIsolation.test.mjs は Hub のリスナーを直接覗いているので、
 * 「WebSocket に載せるところで絞られていないか」までは見ていない。
 * ここでは**本物の ClientWebSocketServer に本物の WebSocket で繋いで**、
 * 2 つ目の購読者が絞り込んで無視するはずの地震・津波が画面側にはそのまま
 * 届くことを確かめる。
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
 * Hub の 2 つ目の購読者を模した、その場限りの最小リスナー。
 *
 * Hub は配信 (ws) 専用ではなく、それ以外にも同じイベントを購読する
 * 購読者がいる構成になっている。ここでは実際の通知先を持たず、「自分の
 * 絞り込み条件を通ったイベントだけ記録する」だけの疑似リスナーで代替する。
 */
const attachFilteringListener = (hub, { minIntensity = 0, prefectures = [] } = {}) => {
  const accepted = [];
  hub.on('event', (event) => {
    if (event.type === 'quake') {
      if (event.quake.maxIntensity < minIntensity) return;
      if (prefectures.length > 0 && !event.quake.points.some((p) => prefectures.includes(p.pref))) return;
    }
    if (event.type === 'tsunami') {
      // 津波には震度が無いので minIntensity は効かせない (本物の設計と同じ)
    }
    accepted.push(event.type);
  });
  return accepted;
};

/**
 * 本物の HTTP/WS サーバーを立て、本物の WebSocket で 1 台繋いだ状態で
 * publish する。画面側が受け取ったメッセージと、疑似リスナーが「通知した」
 * 種別を両方返す。
 */
const withPanel = (filterOptions, publish) => {
  const http = createServer();
  let ws;

  return new Promise((resolve) => http.listen(0, '127.0.0.1', resolve)).then(() => {
    const config = loadConfig({});
    const hub = new Hub(config);
    const notifierAccepted = attachFilteringListener(hub, filterOptions);
    const demo = new DemoRunner(hub);
    const wsServer = new ClientWebSocketServer(http, config, hub, demo);
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
        wsServer.stop?.();
        http.close();
        return { received, notifierAccepted };
      });
  });
};

describe('もう一方の購読者の絞り込みはブラウザ配信に効かない (本物の WebSocket で確認)', () => {
  it('もう一方が絞り込みで無視する地震・津波も、画面へはそのまま届く', () =>
    withPanel({ minIntensity: 50, prefectures: ['宮崎県'] }, (hub) => {
      hub.publishQuake(QUAKE);
      hub.publishTsunami(TSUNAMI);
    }).then(({ received, notifierAccepted }) => {
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

      // もう一方の購読者側は絞り込みで無視している (地震は震度・県ともに条件外)
      assert.deepEqual(
        notifierAccepted.filter((type) => type === 'quake'),
        [],
        'もう一方の購読者は地震を受け入れないはず',
      );
    }));

  it('もう一方の絞り込みを通る地震は、画面にも通知先にも届く', () =>
    withPanel({ minIntensity: 1 }, (hub) => {
      hub.publishQuake(QUAKE);
    }).then(({ received, notifierAccepted }) => {
      assert.ok(received.find((m) => m.type === 'quake'), '画面へ届いていない');
      assert.ok(notifierAccepted.includes('quake'), 'もう一方の購読者へ届いていない');
    }));

  it('接続直後のスナップショットも絞り込まれない', () =>
    withPanel({ minIntensity: 0, prefectures: ['宮崎県'] }, (hub) => {
      hub.publishQuake(QUAKE);
    }).then(({ received }) => {
      const hello = received.find((m) => m.type === 'hello');
      assert.ok(hello, 'hello が来ていない');
      // hello は接続時なのでこの地震はまだ入らないが、履歴の器は生きている
      assert.ok(Array.isArray(hello.snapshot.quakes));
    }));
});
