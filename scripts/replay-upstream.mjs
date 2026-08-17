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
 *   node scripts/replay-upstream.mjs [--port 8090]
 *
 * ブラウザで `http://127.0.0.1:8090/` を開くと操作ページが表示され、ボタンで
 * 任意のシナリオを何度でも発火できる (`POST /trigger?scenario=...`)。
 * トリガされるまでは常に平常応答 (発表なし) を返す。
 *
 * 別ターミナルで:
 *
 *   KMONI_BASE_URL=http://127.0.0.1:8090 \
 *   P2P_WS_URL=ws://127.0.0.1:8090/ \
 *   P2P_HISTORY_URL=http://127.0.0.1:8090/v2/history \
 *   npm start
 *
 * シナリオ (`scenario`, 発火すると T0 = 発火時刻 + 1 秒 で開始):
 *   - forecast: T0 から 20 秒間、kmoni EEW JSON が「予報」を返す。
 *     震央は日向灘 (M5.0 / 深さ30km / calcintensity 4)。
 *   - warning : forecast と同じ流れで、T0+8 秒に alertflg が「警報」へ格上げ
 *     (calcintensity 5弱)。格上げと同時に P2P へ 556 (警報) を 1 通送る。
 *   - cancel  : warning と同じ流れで、T0+14 秒に kmoni がキャンセル報
 *     (is_cancel true) を返す。同時に P2P へも cancelled true の 556 を送る。
 *     音・明滅が即座に止まることの確認用。
 *   - tsunami : EEW は流さず、T0 に 552 (津波予報。宮崎県 Warning など) を送り、
 *     T0+40 秒に cancelled true (解除) を送る。
 *
 * 再トリガすると、進行中だったシナリオの未発火タイマーはすべて破棄され、
 * 新しいシナリオ (新しい T0 由来の report_id) で上書きされる。
 *
 * `--scenario` を指定した場合は互換のため、起動 3 秒後に 1 回だけ自動でその
 * シナリオを発火する (従来挙動)。指定しなければ自動発火はせず、操作ページの
 * ボタン待ちになる。
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

/** Date → "hh:mm:ss" (JST)。ログ出力用。 */
function toJstTime(date) {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return `${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}:${pad(j.getUTCSeconds())}`;
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

const SCENARIO_LABELS = {
  forecast: '予報',
  warning: '警報',
  cancel: 'キャンセル報',
  tsunami: '津波予報',
};

function parseArgs(argv) {
  const args = { port: 8090, scenario: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--port' && value) args.port = Number(value);
    else if (key === '--scenario' && value) args.scenario = value;
  }
  if (args.scenario !== null && !SCENARIOS.includes(args.scenario)) {
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

/** 操作ページ (依存なしの単一 HTML)。 */
function controlPageHtml() {
  const buttons = [
    { scenario: 'forecast', label: '予報 (日向灘 M5.0)' },
    { scenario: 'warning', label: '警報へ格上げ (予報→8秒後に警報+P2P 556)' },
    { scenario: 'cancel', label: 'キャンセル報 (警報→14秒後に取消)' },
    { scenario: 'tsunami', label: '津波予報 (宮崎県 警報→40秒後に解除)' },
  ];
  const buttonsHtml = buttons
    .map((b) => `<button data-scenario="${b.scenario}">${b.label}</button>`)
    .join('\n      ');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>replay-upstream 操作ページ</title>
<style>
  body {
    background: #14171c;
    color: #e6e6e6;
    font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif;
    padding: 24px;
    max-width: 640px;
    margin: 0 auto;
  }
  h1 { font-size: 18px; }
  p.note { color: #9aa4b2; font-size: 13px; }
  .buttons {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 16px 0;
  }
  button {
    background: #2a2f3a;
    color: #e6e6e6;
    border: 1px solid #444c5c;
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 14px;
    cursor: pointer;
    text-align: left;
  }
  button:hover { background: #3a4152; }
  #status {
    background: #1d2129;
    border: 1px solid #333a46;
    border-radius: 6px;
    padding: 12px 14px;
    font-size: 14px;
    white-space: pre-wrap;
  }
</style>
</head>
<body>
  <h1>replay-upstream 操作ページ</h1>
  <p class="note">パネル本体は別のポートで開いてください (例 http://localhost:8080)。このページは kmoni / P2P の模擬サーバーを操作するだけです。</p>
  <div class="buttons">
      ${buttonsHtml}
  </div>
  <div id="status">状態を取得中...</div>
<script>
  document.querySelectorAll('button[data-scenario]').forEach((btn) => {
    btn.addEventListener('click', () => {
      fetch('/trigger?scenario=' + encodeURIComponent(btn.dataset.scenario), { method: 'POST' });
    });
  });

  const statusEl = document.getElementById('status');
  function refresh() {
    fetch('/status')
      .then((res) => res.json())
      .then((data) => {
        statusEl.textContent = data.phase;
      })
      .catch(() => {
        statusEl.textContent = '状態の取得に失敗しました';
      });
  }
  refresh();
  setInterval(refresh, 1000);
</script>
</body>
</html>
`;
}

function sendJson(res, body) {
  const text = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-cache',
  });
  res.end(text);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(html);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  /** いまアームされているシナリオの状態。トリガされるまでは scenario === null (平常応答)。 */
  const state = {
    scenario: null,
    t0: null,
    reportId: null,
    originTime: null,
    timers: [],
  };

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
      const body =
        state.scenario === null
          ? quietEewBody(now)
          : eewBody(state.scenario, now, state.t0, state.reportId, state.originTime);
      sendJson(res, body);
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

    if (url.pathname === '/status') {
      if (state.scenario === null || state.t0 === null) {
        sendJson(res, { scenario: null, t0: null, now: now.toISOString(), phase: '待機中' });
        return;
      }
      const elapsedSec = Math.round((now.getTime() - state.t0) / 1000);
      const label = SCENARIO_LABELS[state.scenario] ?? state.scenario;
      const phase = `${label} 再生中 (T0${elapsedSec >= 0 ? '+' : ''}${elapsedSec} 秒)`;
      sendJson(res, {
        scenario: state.scenario,
        t0: new Date(state.t0).toISOString(),
        now: now.toISOString(),
        phase,
      });
      return;
    }

    if (url.pathname === '/trigger') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed (use POST)');
        return;
      }
      const scenario = url.searchParams.get('scenario');
      if (scenario === null || !SCENARIOS.includes(scenario)) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`invalid scenario: ${String(scenario)} (must be one of ${SCENARIOS.join(', ')})`);
        return;
      }
      triggerScenario(scenario);
      sendJson(res, { ok: true, scenario, t0: new Date(state.t0).toISOString() });
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      sendHtml(res, controlPageHtml());
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

  /**
   * シナリオを発火する。既にアーム中のシナリオがあれば、その未発火タイマーを
   * すべて破棄してから新しい T0 (発火時刻 + 1 秒) で張り直す。
   */
  function triggerScenario(scenario) {
    state.timers.forEach((timer) => clearTimeout(timer));
    state.timers = [];

    const triggeredAt = Date.now();
    const t0 = triggeredAt + 1_000;
    const t0Date = new Date(t0);
    const reportId = toKmoniTimestamp(t0Date);
    const originTime = new Date(t0 - 5_000);

    state.scenario = scenario;
    state.t0 = t0;
    state.reportId = reportId;
    state.originTime = originTime;

    process.stdout.write(`[${toJstTime(new Date())}] trigger: ${scenario} (T0=${toJstDateTime(t0Date)})\n`);

    const at = (delayFromNowMs, fn) => {
      const timer = setTimeout(fn, Math.max(0, delayFromNowMs));
      timer.unref?.();
      state.timers.push(timer);
    };

    if (scenario === 'warning' || scenario === 'cancel') {
      at(t0 + 8_000 - triggeredAt, () => {
        broadcast(eew556Warning(new Date(), t0, reportId, originTime, false));
      });
    }
    if (scenario === 'cancel') {
      at(t0 + 14_000 - triggeredAt, () => {
        broadcast(eew556Warning(new Date(), t0, reportId, originTime, true));
      });
    }
    if (scenario === 'tsunami') {
      const tsunamiId = `replay-tsunami-${reportId}`;
      at(t0 - triggeredAt, () => {
        broadcast(tsunami552Warning(new Date(), tsunamiId));
      });
      at(t0 + 40_000 - triggeredAt, () => {
        broadcast(tsunami552Cancel(new Date(), tsunamiId));
      });
    }
  }

  if (args.scenario !== null) {
    const timer = setTimeout(() => triggerScenario(args.scenario), 3_000);
    timer.unref?.();
    process.stdout.write(`[replay-upstream] --scenario=${args.scenario} を起動 3 秒後に自動発火します\n`);
  }

  server.listen(args.port, () => {
    process.stdout.write(`[replay-upstream] listening on http://127.0.0.1:${args.port}\n`);
  });
}

main();
