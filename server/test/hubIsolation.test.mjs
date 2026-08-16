import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { loadConfig } from '../dist/config.js';
import { HomeAssistantNotifier } from '../dist/haNotify.js';
import { Hub } from '../dist/hub.js';

/**
 * Hub は同じイベントオブジェクトを全リスナー (WebSocket 配信 / HA 通知) へ渡す。
 * どちらかが中身を書き換えると、もう片方が壊れた値を見る。
 *
 * ここでは配信前に**深く凍結**して publish する。ES モジュールは strict mode
 * なので、凍結したオブジェクトへの代入は黙って無視されずに TypeError になる。
 * つまり「誰も書き換えていない」ことを実行で証明できる。
 */
const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

const point = (pref, scale) => ({ pref, addr: `${pref}某所`, isArea: false, scale });

const QUAKE = deepFreeze({
  id: 'q1',
  issuedAt: null,
  occurredAt: '2026-08-16T01:00:00.000Z',
  issueType: 'DetailScale',
  hypocenter: { name: '日向灘', lat: 32.1, lon: 131.9, depthKm: 30, magnitude: 4.2 },
  maxIntensity: 30,
  domesticTsunami: 'None',
  points: [point('宮崎県', 30), point('鹿児島県', 20)],
  receivedAt: '2026-08-16T01:00:01.000Z',
});

const EEW = deepFreeze({
  id: 'e1',
  reportNumber: 2,
  isFinal: false,
  isCancel: false,
  isTraining: false,
  isAssumption: false,
  alert: 'warning',
  hypocenter: { name: '日向灘', lat: 32.1, lon: 131.9, depthKm: 30, magnitude: 6.4 },
  maxIntensity: 50,
  originTime: null,
  announcedAt: null,
  receivedAt: '2026-08-16T01:00:00.000Z',
  regions: [
    { pref: '宮崎県', name: '宮崎県南部平野部', scaleFrom: 40, scaleTo: null, arrivalTime: null, condition: null },
  ],
  source: 'both',
});

const TSUNAMI = deepFreeze({
  id: 't1',
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
  receivedAt: '2026-08-16T01:00:00.000Z',
});

/** 偽の HA を立てて、実際に通知を走らせた状態で検証する */
const withNotifier = (env, body) => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
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
      const seen = [];
      // WebSocket 配信と同じ立場のリスナー。実際の配信は JSON 化するので、
      // 受け取った直後の姿を控えておいて後で突き合わせる。
      hub.on('event', (event) => seen.push({ event, snapshot: JSON.stringify(event) }));
      body(hub);
      return new Promise((resolve) => setTimeout(resolve, 300)).then(() => {
        notifier.stop();
        server.close();
        return seen;
      });
    });
};

describe('Hub のイベントは配信系と HA 通知で共有されても壊れない', () => {
  it('絞り込みを通す設定でも、配信側が受け取った中身が変わらない', () =>
    withNotifier({ HA_NOTIFY_MIN_INTENSITY: '震度2以上', HA_NOTIFY_PREFECTURES: '宮崎県' }, (hub) => {
      hub.publishQuake(QUAKE);
      hub.publishEew(EEW);
      hub.publishTsunami(TSUNAMI);
    }).then((seen) => {
      assert.equal(seen.length, 3, '3 件とも配信側へ届く');
      seen.forEach(({ event, snapshot }) => {
        assert.equal(JSON.stringify(event), snapshot, `${event.type} が後から書き換わっている`);
      });
    }));

  it('絞り込みで落とす設定でも、配信側へは元のまま届く (画面は絞られない)', () =>
    withNotifier({ HA_NOTIFY_MIN_INTENSITY: '震度5弱以上', HA_NOTIFY_PREFECTURES: '北海道' }, (hub) => {
      hub.publishQuake(QUAKE);
      hub.publishTsunami(TSUNAMI);
    }).then((seen) => {
      assert.equal(seen.length, 2, 'HA で落としても配信は止まらない');
      const quake = seen.find((s) => s.event.type === 'quake');
      assert.equal(quake.event.quake.maxIntensity, 30);
      assert.equal(quake.event.quake.points.length, 2);
      const tsunami = seen.find((s) => s.event.type === 'tsunami');
      assert.equal(tsunami.event.tsunami.areas[0].name, '東北地方太平洋沿岸');
      // 画面用の印は付けられていない (印を付けるのは各端末の仕事)
      assert.equal(tsunami.event.tsunami.areas[0].isHome, false);
      assert.equal(tsunami.event.tsunami.affectsHome, false);
    }));

  it('津波の判定 (applyHomeAreas) が元のオブジェクトを書き換えない', () =>
    withNotifier({ HA_NOTIFY_PREFECTURES: '宮城県' }, (hub) => {
      hub.publishTsunami(TSUNAMI);
    }).then((seen) => {
      // 宮城県は東北地方太平洋沿岸に含まれるので HA 側では該当と判定される。
      // それでも配信された値の isHome / affectsHome は false のまま。
      const tsunami = seen.find((s) => s.event.type === 'tsunami');
      assert.equal(tsunami.event.tsunami.areas[0].isHome, false);
      assert.equal(tsunami.event.tsunami.affectsHome, false);
      assert.equal(TSUNAMI.areas[0].isHome, false);
    }));
});
