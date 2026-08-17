#!/usr/bin/env node
/**
 * kmoni (強震モニタ) と P2P地震情報の上流を localhost 上で模擬する開発用スクリプト。
 *
 * EEW・津波の実動作 (音・画面明滅・パネル表示) を確かめるのに「実際の地震発生を
 * 待ち構える」必要をなくすのが目的。ここで作る応答はすべて実測データ (kmoni の
 * 実レスポンス、P2P の実電文、docs/kmoni-endpoints.md) と同じ形に、時刻だけを
 * 現在時刻へずらして再生する。**実データを配信するものではなく、開発時の動作確認
 * 専用**。本番の上流には一切アクセスしない。
 *
 * 使い方:
 *
 *   node scripts/replay-upstream.mjs [--port 8090] [--scenario warning]
 *
 * 別ターミナルで:
 *
 *   KMONI_BASE_URL=http://127.0.0.1:8090 \
 *   P2P_WS_URL=ws://127.0.0.1:8090/ \
 *   P2P_HISTORY_URL=http://127.0.0.1:8090/v2/history \
 *   npm start
 *
 * シナリオ (`--scenario`, 既定 forecast):
 *   - forecast: 起動 3 秒後 (T0) から 20 秒間、kmoni EEW JSON が「予報」を返す。
 *     震央は日向灘 (M5.0 / 深さ30km / calcintensity 4)。
 *   - warning : forecast と同じ流れで、T0+8 秒に alertflg が「警報」へ格上げ
 *     (calcintensity 5弱)。格上げと同時に P2P へ 556 (警報) を 1 通送る。
 *   - cancel  : warning と同じ流れで、T0+14 秒に kmoni がキャンセル報
 *     (is_cancel true) を返す。同時に P2P へも cancelled true の 556 を送る。
 *     音・明滅が即座に止まることの確認用。
 *   - tsunami : EEW は流さず、T0 に 552 (津波予報。宮崎県 Warning など) を送り、
 *     T0+40 秒に cancelled true (解除) を送る。
 *
 * 終了は Ctrl-C。シナリオが終わっても平常応答を返し続ける
 * (接続維持の確認ができるように)。
 */
import { createServer } from 'node:http';

import { WebSocketServer } from 'ws';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const pad = (n, len = 2) => String(n).padStart(len, '0');

/** Date → kmoni の URL / report_id に使う "YYYYMMDDhhmmss" (JST) */
function toKmoniTimestamp(date) {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return (
    `${j.getUTCFullYear()}${pad(j.getUTCMonth() + 1)}${pad(j.getUTCDate())}` +
    `${pad(j.getUTCHours())}${pad(j.getUTCMinutes())}${pad(j.getUTCSeconds())}`
  );
}

/** Date → kmoni / P2P の "YYYY/MM/DD hh:mm:ss" (JST) */
function toJstDateTime(date) {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return (
    `${j.getUTCFullYear()}/${pad(j.getUTCMonth() + 1)}/${pad(j.getUTCDate())} ` +
    `${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}:${pad(j.getUTCSeconds())}`
  );
}

/** P2P の `time` フィールドはミリ秒付き */
function toP2PTime(date) {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return `${toJstDateTime(date)}.${pad(j.getUTCMilliseconds(), 3)}`;
}

/**
 * 既知の最小サイズ (43 バイト) の透過 GIF。
 *
 * kmoni の実画像は利用条件で複製・再配布が禁止されているため、
 * リポジトリには同梱しない (実物の代わりにこの 1x1 透過 GIF を返す)。
 */
const TRANSPARENT_GIF = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

const SCENARIOS = ['forecast', 'warning', 'cancel', 'tsunami'];

function parseArgs(argv) {
  const args = { port: 8090, scenario: 'forecast' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--port' && value) args.port = Number(value);
    else if (key === '--scenario' && value) args.scenario = value;
  }
  if (!SCENARIOS.includes(args.scenario)) {
    throw new Error(`unknown --scenario: ${args.scenario} (must be one of ${SCENARIOS.join(', ')})`);
  }
  if (!Number.isFinite(args.port) || args.port <= 0) {
    throw new Error(`invalid --port: ${args.port}`);
  }
  return args;
}

/** 平常時 (発表なし) の EEW JSON。docs/kmoni-endpoints.md の実測どおり alertflg キー自体が無い。 */
function quietEewBody(now) {
  return {
    result: { status: 'success', message: 'データがありません', is_auth: true },
    report_time: '',
    region_code: '',
    request_time: toKmoniTimestamp(now),
    region_name: '',
    longitude: '',
    is_cancel: '',
    depth: '',
    calcintensity: '',
    is_final: '',
    is_training: '',
    latitude: '',
    origin_time: '',
    magunitude: '',
    report_num: '',
    request_hypo_type: 'eew',
    report_id: '',
  };
}

/**
 * シナリオのタイムラインに沿って、いま (`now`) kmoni が返すべき EEW の状態を求める。
 * 発表なしなら null。
 */
function eewState(scenario, nowMs, t0) {
  if (scenario === 'tsunami') return null;

  const windowStart = t0;
  const windowEnd = t0 + 20_000;
  if (nowMs < windowStart || nowMs >= windowEnd) return null;

  const elapsedSec = (nowMs - windowStart) / 1000;
  const reportNum = Math.floor(elapsedSec / 2) + 1;
  const isFinal = nowMs >= windowEnd - 1000;

  const upgraded = scenario !== 'forecast' && nowMs >= windowStart + 8_000;
  const cancelled = scenario === 'cancel' && nowMs >= windowStart + 14_000;

  return {
    alertflg: upgraded ? '警報' : '予報',
    calcintensity: upgraded ? '5弱' : '4',
    isCancel: cancelled,
    isFinal,
    reportNum,
    regionName: '日向灘',
    latitude: '32.2',
    longitude: '132.0',
    depth: '30km',
    magunitude: '5.0',
  };
}

function eewBody(scenario, now, t0, reportId, originTime) {
  const state = eewState(scenario, now.getTime(), t0);
  if (!state) return quietEewBody(now);
  return {
    result: { status: 'success', message: '', is_auth: true },
    report_time: toJstDateTime(now),
    region_code: '',
    request_time: toKmoniTimestamp(now),
    region_name: state.regionName,
    longitude: state.longitude,
    is_cancel: state.isCancel,
    depth: state.depth,
    calcintensity: state.calcintensity,
    is_final: state.isFinal,
    is_training: false,
    latitude: state.latitude,
    origin_time: toKmoniTimestamp(originTime),
    security: {
      realm: '/kyoshin_monitor/static/jsondata/eew_est/',
      hash: 'b61e4d95a8c42e004665825c098a6de4',
    },
    magunitude: state.magunitude,
    report_num: String(state.reportNum),
    report_id: reportId,
    alertflg: state.alertflg,
  };
}

/** T0+8 秒に送る P2P 556 (警報)。日向灘の EEW から見て 宮崎県 が対象という想定。 */
function eew556Warning(now, t0, reportId, originTime, cancelled) {
  const arrival = new Date(now.getTime() + 3_000);
  return {
    code: 556,
    id: `replay-eew-${reportId}`,
    test: false,
    cancelled,
    issue: { eventId: reportId, serial: cancelled ? '2' : '1', time: toJstDateTime(now) },
    earthquake: {
      originTime: toJstDateTime(originTime),
      arrivalTime: toJstDateTime(arrival),
      condition: '',
      hypocenter: {
        name: '日向灘',
        latitude: 32.2,
        longitude: 132.0,
        depth: 30,
        magnitude: 5.0,
        reduceName: '宮崎県',
      },
    },
    areas: [
      { pref: '宮崎', name: '宮崎県南部平野部', scaleFrom: 45, scaleTo: 45, kindCode: '19', arrivalTime: toJstDateTime(arrival) },
      { pref: '宮崎', name: '宮崎県北部平野部', scaleFrom: 40, scaleTo: 40, kindCode: '19', arrivalTime: toJstDateTime(arrival) },
    ],
    time: toP2PTime(now),
  };
}

/** T0 に送る P2P 552 (津波予報)。 */
function tsunami552Warning(now, id) {
  return {
    code: 552,
    id,
    cancelled: false,
    issue: { source: '気象庁', time: toJstDateTime(now), type: 'Focus' },
    areas: [
      {
        grade: 'Warning',
        immediate: true,
        name: '宮崎県',
        firstHeight: { condition: '第1波到達と推測' },
        maxHeight: { description: '3m', value: 3 },
      },
      { grade: 'Watch', immediate: false, name: '大分県瀬戸内海沿岸' },
    ],
    time: toP2PTime(now),
  };
}

/** T0+40 秒に送る解除電文。 */
function tsunami552Cancel(now, id) {
  return {
    code: 552,
    id: `${id}-cancel`,
    cancelled: true,
    issue: { source: '気象庁', time: toJstDateTime(now), type: 'Focus' },
    areas: [],
    time: toP2PTime(now),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const t0 = startedAt + 3_000;
  const t0Date = new Date(t0);
  const reportId = toKmoniTimestamp(t0Date);
  const originTime = new Date(t0 - 5_000);

  process.stdout.write(
    `[replay-upstream] scenario=${args.scenario} port=${args.port} ` +
      `T0=${toJstDateTime(t0Date)} (JST) reportId=${reportId}\n`,
  );

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const now = new Date();

    if (url.pathname === '/webservice/server/pros/latest.json') {
      const latest = new Date(now.getTime() - 1_000);
      sendJson(res, {
        security: { realm: '/webservice/server/pros/', hash: 'replay' },
        latest_time: toJstDateTime(latest),
        request_time: toJstDateTime(now),
        result: { status: 'success', message: '' },
      });
      return;
    }

    if (/^\/webservice\/hypo\/eew\/\d{14}\.json$/.test(url.pathname)) {
      sendJson(res, eewBody(args.scenario, now, t0, reportId, originTime));
      return;
    }

    if (url.pathname.startsWith('/data/map_img/')) {
      res.writeHead(200, {
        'content-type': 'image/gif',
        'content-length': String(TRANSPARENT_GIF.length),
      });
      res.end(TRANSPARENT_GIF);
      return;
    }

    if (url.pathname === '/v2/history') {
      sendJson(res, []);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    process.stdout.write('[replay-upstream] P2P WebSocket クライアントが接続しました\n');
    socket.on('close', () => {
      process.stdout.write('[replay-upstream] P2P WebSocket クライアントが切断しました\n');
    });
  });

  const broadcast = (message) => {
    const text = JSON.stringify(message);
    process.stdout.write(`[replay-upstream] ${toJstDateTime(new Date())} send P2P code=${message.code} cancelled=${Boolean(message.cancelled)}\n`);
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(text);
    });
  };

  const at = (delayFromNowMs, fn) => {
    const timer = setTimeout(fn, Math.max(0, delayFromNowMs));
    timer.unref?.();
  };

  if (args.scenario === 'warning' || args.scenario === 'cancel') {
    at(t0 + 8_000 - startedAt, () => {
      broadcast(eew556Warning(new Date(), t0, reportId, originTime, false));
    });
  }
  if (args.scenario === 'cancel') {
    at(t0 + 14_000 - startedAt, () => {
      broadcast(eew556Warning(new Date(), t0, reportId, originTime, true));
    });
  }
  if (args.scenario === 'tsunami') {
    const tsunamiId = `replay-tsunami-${reportId}`;
    at(t0 - startedAt, () => {
      broadcast(tsunami552Warning(new Date(), tsunamiId));
    });
    at(t0 + 40_000 - startedAt, () => {
      broadcast(tsunami552Cancel(new Date(), tsunamiId));
    });
  }

  server.listen(args.port, () => {
    process.stdout.write(`[replay-upstream] listening on http://127.0.0.1:${args.port}\n`);
  });
}

function sendJson(res, body) {
  const text = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-cache',
  });
  res.end(text);
}

main();
