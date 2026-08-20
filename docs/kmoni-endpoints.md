# 上流 API リファレンス (強震モニタ / P2P地震情報)

このアプリが叩く上流エンドポイントの仕様書。**公表仕様ではなく実データで確認した事実**を
一次情報として書いてある (kmoni は仕様が公開されていない)。実装はここに書いた事実を
前提にしている。

- 実測日: **2026-08-13** (kmoni、JST 午前中・平常時) / **2026-08-20** (P2P の追測)
- `pref` や `name` に入る**地名の値域 (全列挙)** は [area-codes.md](area-codes.md)
- 再取得の手順は末尾「再確認したいときは」

---

# 1. 強震モニタ (kmoni)

`http://www.kmoni.bosai.go.jp` — 既定値。`KMONI_BASE_URL` で差し替えられる。

共通事項:

| 観点 | 内容 |
|---|---|
| スキーム | **平文 HTTP のみ** (TLS 無し)。ブラウザから直接叩くと混在コンテンツになるのでサーバー経由に一本化している |
| キャッシュ | どのエンドポイントも `cache-control: public, max-age=10800` を返す。固定 URL のものは実装側で `cache-control: no-cache` を付けて取得する (`server/src/sources/httpClient.ts`) |
| リダイレクト | **追わない**。3xx は「そのデータは無い」として扱う (理由は §1-3) |
| 認証 | なし |

## 1-1. `GET /webservice/server/pros/latest.json` — 基準時刻

```
$ curl -s http://www.kmoni.bosai.go.jp/webservice/server/pros/latest.json
{"security": {...}, "latest_time": "2026/08/13 11:09:55",
 "request_time": "2026/08/13 11:09:56", "result": {"status": "success", "message": ""}}
```

| フィールド | 型 | 値の例 | 意味・実測 |
|---|---|---|---|
| `latest_time` | string | `2026/08/13 11:09:55` | 配信済みデータの最新時刻 (JST)。実測で `request_time` の **1〜2 秒前** |
| `request_time` | string | `2026/08/13 11:09:56` | kmoni 側がリクエストを受けた時刻 (JST)。**分解能は 1 秒** |
| `result.status` | string | `success` | 平常時は常に `success` |
| `result.message` | string | `` (空) | 異常時のみ文言が入る |
| `security` | object | — | 利用条件の記述。実装では読まない |

レスポンスヘッダは `cache-control: public, max-age=10800` / `expires: (1時間後)`。

**注意点 — キャッシュヘッダの罠**: 固定 URL に 3 時間の `max-age` が付いている。
間に透過キャッシュがいると古い時刻を掴まされる。実装では `cache-control: no-cache`
を付けて取得している。

この 2 つの時刻から、端末時計のズレ (`request_time` との差) とデータ生成の遅れ
(`latest_time` との差) を分けて測れる。受け入れ条件「端末時計ズレ時の動作」はこれで
担保している (`server/src/sources/kmoniClock.ts`)。取得間隔は 60 秒。

## 1-2. `GET /webservice/hypo/eew/{YYYYMMDDhhmmss}.json` — 緊急地震速報

パスのタイムスタンプは JST。毎秒ポーリングする。**無償で「予報」レベルまで取れる
唯一の経路** (P2P 556 は警報のみ)。

平常時のレスポンス (実測):

```json
{"result": {"status": "success", "message": "データがありません", "is_auth": true},
 "report_time": "", "region_code": "", "request_time": "20260813111003",
 "region_name": "", "longitude": "", "is_cancel": "", "depth": "",
 "calcintensity": "", "is_final": "", "is_training": "", "latitude": "",
 "origin_time": "", "security": {...}, "magunitude": "", "report_num": "",
 "request_hypo_type": "eew", "report_id": ""}
```

**値はすべて文字列**で来る (数値も真偽値も)。型定義は
`server/src/sources/kmoniEew.ts` の `KmoniEewRaw`。

| フィールド | 平常時 | 発表時の値の例 | 実装での扱い (`parseKmoniEew`) |
|---|---|---|---|
| `alertflg` | **キーが存在しない** | `予報` / `警報` | 発表判定の主軸。`予報`/`警報` 以外は未発表 |
| `report_id` | `` | `20260729221936` | 地震の識別子。P2P 556 の `issue.eventId` と一致する (§3) |
| `report_num` | `` | `3` | 報数。数値化できなければ 0 |
| `report_time` | `` | `2026/07/29 22:19:44` | 発表時刻。`YYYY/MM/DD hh:mm:ss` 形式 |
| `origin_time` | `` | `20260729221936` | 発震時刻。**`YYYYMMDDhhmmss` 形式** (`report_time` と書式が違う) |
| `region_name` | `` | `日向灘` | 震央地名 ([area-codes.md](area-codes.md) §6)。空なら `不明` を入れる |
| `region_code` | `` | `288` | 震央地名コード。実装では読まない |
| `latitude` / `longitude` | `` | `32.4` / `130.5` | 数値以外の文字が混ざっていても数値部分だけ拾う |
| `depth` | `` | `10km` | **単位付きで来ることがある**ので数値部分だけ拾う |
| `magunitude` | `` | `4.5` | **この綴りが実際のキー名** (こちらの打ち間違いではない) |
| `calcintensity` | `` | `5弱` | 予測震度。`parseIntensityText` で内部表現へ |
| `is_cancel` | `` | `true` / `false` | **文字列の真偽値**。`true` / `1` を真として扱う |
| `is_final` | `` | `true` / `false` | 同上。最終報かどうか |
| `is_training` | `` | `true` / `false` | 同上。訓練報かどうか |
| `request_time` | `20260813111003` | 同形式 | リクエスト受付時刻 |
| `request_hypo_type` | `eew` | `eew` | 固定 |
| `result.status` | `success` | `success` | 平常時も success |
| `result.message` | `データがありません` | `` | **文言に依存した判定はしない** |
| `result.is_auth` | `true` | `true` | 実装では読まない |

実装に効く発見:

1. **平常時は `alertflg` キーそのものが存在しない**。空文字ですらない。
   したがって発表判定は「`alertflg` が `予報` / `警報` のいずれかであること」で行う。
   `message` の文言 (「データがありません」) に依存する判定は避ける。
2. **真偽値フィールドは文字列**。`is_cancel` は平常時 `""`、発表時は `"true"`/`"false"`。
   実装では文字列と真偽値の両方を受ける。
3. **キャンセル報の実物は観測例が無い** (kmoni の EEW JSON は NIED 非公式で、
   コミュニティの解析サイトも「is_cancel は受信したことがない」と明記している)。
   そのため `is_cancel` が立っていれば `alertflg` の値にかかわらず受け入れる。
4. **未来のタイムスタンプでも 200 が返る** (中身は平常時と同じ空レスポンス)。
   つまり EEW JSON からは端末時計のズレを検知できない。→ 時刻合わせは
   latest.json、追従の微調整は画像の 404 で行う。
5. レスポンスヘッダは latest.json と同じく `max-age=10800`。ただし URL に
   タイムスタンプが入るので実害はない。

## 1-3. 画像

| 用途 | パス | 生成タイミング |
|---|---|---|
| リアルタイム震度 | `/data/map_img/RealTimeImg/jma_s/{YYYYMMDD}/{YYYYMMDDhhmmss}.jma_s.gif` | 常時・毎秒 |
| 最大加速度など他の指標 | 同じ規則で `jma_s` を `acmap_s` 等に差し替え | 常時・毎秒 |
| 予測円 (P/S 波) | `/data/map_img/PSWaveImg/eew/{YYYYMMDD}/{ts}.eew.gif` | **EEW 発表中のみ** |
| 予想震度 | `/data/map_img/EstShindoImg/eew/{YYYYMMDD}/{ts}.eew.gif` | **EEW 発表中のみ** |
| 基図 (白地図) | `/data/map_img/CommonImg/base_map_w.gif` | 常時 |

補助レイヤの URL 規則は kmoni 本体の JS (`MapCtrl.js`) から確認した。

| 観点 | 結果 |
|---|---|
| 更新間隔 | **毎秒**。連続 10 秒ぶんすべて 200 が返り、内容もすべて異なる |
| 画像サイズ | **352 x 400 px**、GIF (透過)、1 枚あたり **約 7.9 KB** |
| 生成の遅れ | `last-modified` はタイムスタンプの **約 1 秒後** |
| 存在しない時刻 (リアルタイム震度) | **404** (`content-length: 146`)。→ 時計ズレの検知に使える |
| 存在しない時刻 (予測円・予想震度) | **302** で `CommonImg/nodata.gif` (807 B) へリダイレクト |
| 基図 | `base_map_w.gif` は 200。`base_map_c.gif` / `base_map_wd.gif` は **404** |

**注意点 — 存在しない画像の返し方がレイヤによって違う**: リダイレクトを追ってしまうと
中身のないプレースホルダを「取得成功」と誤認する。画像取得ではリダイレクトを追わず、
3xx は「その画像は無い」として扱っている (`server/src/sources/httpClient.ts`)。

平常時の取得間隔は **1 秒** を既定にした。毎秒でも外部への負荷は 8 KB/s 程度で、
サーバー集約なのでクライアント数に依存しない。落としたい場合は
`KMONI_IDLE_FRAME_INTERVAL_SEC=2` で 2 秒に変えられる。

基図は自前の背景地図を敷くので較正 (§1-4) にしか使っていない。

## 1-4. 座標系 (投影パラメータ)

kmoni は投影パラメータを公開していないため、基図と観測点配置から較正した。
手順とスクリプトは `scripts/calibrate-kmoni-map.py`、結果は
`shared/src/kmoniGeo.ts` に入っている。

```
投影: 正距円筒 (回転なし、円錐投影ではない)
  x = (経度 - 128.6169) * 20.2976
  y = (46.2239 - 緯度) * 24.5262
  → 経度 128.6169〜145.9588 / 緯度 29.9148〜46.2239
  sy/sx = 1.208 → 標準緯度およそ 34.1°N
南西諸島インセット: 同縮尺の平行移動 (dx=+124.585, dy=-345.334)
```

較正の精度は島嶼 15 点の対応で **残差 RMS 経度方向 0.72px / 緯度方向 0.49px**。
基図に重ねた目視確認でも北海道から九州まで一致する。

較正でつまずいた点を 1 つ記録しておく。基図の陰影は**山地にしか付いておらず、
平野部は海と同じ白**である。陸地ポリゴンと灰色部分を単純に比較すると平野の分だけ
縮尺が小さい方に引っ張られ、誤った値 (px/度 が 25% 小さい) に収束する。
リアルタイム震度画像の観測点は平野にも分布しているので、これを併用すると解消する。

## 1-5. 配信画像に焼き込まれた見出し

リアルタイム震度画像の左上には `Realtime Sindo (Surface)` と時刻が黒文字で
描かれている。実測で **y=8..34 / x=6..218** の範囲に収まり、
**この帯 (y<40, x<240) には観測点が 1 点も無い**ことを確認した。

フル HD へ引き伸ばすとこの文字が画面を占領してしまうため、表示側でこの矩形を
描画対象から外す設定を既定 ON にしてある (画像自体は加工しない。設定で戻せる)。

---

# 2. P2P地震情報 JSON API v2

`https://api.p2pquake.net/v2` / `wss://api.p2pquake.net/v2/ws` — 既定値。
`P2P_HISTORY_URL` / `P2P_WS_URL` で差し替えられる。

公式スキーマ (OpenAPI 定義) が一次資料:
<https://raw.githubusercontent.com/p2pquake/epsp-specifications/master/json-api-v2.yaml>
受信側の型定義は `server/src/sources/p2pTypes.ts` (実データで確認した形に合わせてある)。

共通事項 (公式スキーマの記述):

| 観点 | 内容 |
|---|---|
| WebSocket の同時接続数 | **IP あたり 2 本まで** (2026年6月〜)。サーバーが 1 本だけ張り、クライアントへは自前 WS でファンアウトする |
| 遅延 | WebSocket 約 **70ms**、JSON API 約 **1000ms** (高負荷時はさらに遅延) |
| 欠落リスク | サーバー・受信プログラムは冗長化されておらず、障害時は配信されない。復旧後の再配信も無い |
| 品質 | 「内容や配信品質は無保証。緊急地震速報（警報）としての利活用は非推奨」と明記されている |

全電文に共通のフィールド:

| フィールド | 型 | 意味 | 実装 |
|---|---|---|---|
| `id` | string | 情報を一意に識別する ID | そのまま使う (無ければコードと時刻から合成) |
| `code` | number | 情報種別 (551/552/554/556 …) | 振り分けに使う |
| `time` | string | 受信日時 `2006/01/02 15:04:05.999` | JST として解釈 |
| `timestamp.convert` / `.register` | string | P2P 内部の処理時刻 | 読まない |
| `user_agent` / `ver` | string | 生成元・スキーマ版 | 読まない |
| `created_at` | string | `/jma/*` 系のみ付く | 読まない |

## 2-1. `GET /v2/history` — 履歴

| パラメータ | 値 | 実装での使用 |
|---|---|---|
| `codes` | 551 / 552 / 554 / 555 / 556 / 561 / 9611 | 起動時のシードで 551 と 552 |
| `limit` | 1〜100 (既定 10) | 地震情報は `quakeHistorySize`、津波は 1 |
| `offset` | 0 以上 | 使わない |
| `order` | 1 (古い順) / -1 (既定・新しい順) | 使わない |

**保持期間 (2026-08-20 実測)**:

| 観点 | 結果 |
|---|---|
| 551 | 415 件取得できた (最古 2026-08-01。`offset` を進めると尽きる) |
| 552 / 554 / 556 | **すべて空配列**。直近 1 週間に該当電文が無いため |
| 未知のクエリ | **400** `{"error":"extra keys found"}` |

公式スキーマに「`offset` パラメタは利用可能ですが、1 週間以上古い情報は取得できない
場合があります」と明記されている。したがって**起動時の津波シード
(`codes=552&limit=1`) は平常時ほぼ空で返る**。異常ではないので空を失敗として扱わない
(`server/src/sources/p2pClient.ts` の `seedHistory`)。

## 2-2. `GET /v2/jma/quake` / `GET /v2/jma/tsunami` — 気象庁発表の履歴

実装では使っていない (調査用)。`/history` と違い `since_date` / `until_date`
(`yyyyMMdd`)、`quake_type`、`min_scale` などで絞れるので、**過去の電文を掘るときは
こちら**。`/history` にこれらを付けると 400 になる。

## 2-3. `wss://api.p2pquake.net/v2/ws` — 常時接続

接続すると電文が JSON で 1 件ずつ流れてくる (形は `/history` の要素と同じ)。
実装は 1 本だけ張り、切断時は指数バックオフで張り直す
(`server/src/sources/p2pClient.ts`)。

## 2-4. 電文 551 — 地震情報

```json
{"code":551,"id":"6a866f98e88ee598246bf22d","time":"2026/08/20 12:08:08.078",
 "issue":{"source":"気象庁","time":"2026/08/20 12:08:07","type":"DetailScale","correct":"None"},
 "earthquake":{"time":"2026/08/20 12:04:00","maxScale":10,
   "domesticTsunami":"None","foreignTsunami":"Unknown",
   "hypocenter":{"name":"熊本県熊本地方","latitude":32.4,"longitude":130.6,"depth":0,"magnitude":2.9}},
 "points":[{"pref":"熊本県","addr":"八代市平山新町","isArea":false,"scale":10}],
 "comments":{"freeFormComment":""}}
```

| フィールド | 型 | 値域 | 不明値 | 実装 |
|---|---|---|---|---|
| `issue.source` | string | `気象庁` など | — | そのまま |
| `issue.time` | string | 発表日時 | — | `issuedAt` |
| `issue.type` | string | `ScalePrompt` (震度速報) / `Destination` (震源に関する情報) / `ScaleAndDestination` / `DetailScale` (各地の震度) / `Foreign` (遠地地震) / `Other` | — | `issueType`。不明なら `Unknown` |
| `issue.correct` | string | `None` / `Unknown` / `ScaleOnly` / `DestinationOnly` / `ScaleAndDestination` | — | 読まない |
| `earthquake.time` | string | 発生日時 | — | `occurredAt` |
| `earthquake.hypocenter.name` | string | 震央地名 ([area-codes.md](area-codes.md) §6) | 空 | 空なら `不明` |
| `earthquake.hypocenter.latitude` / `longitude` | number | 度 | **-200** | 範囲外は `null` |
| `earthquake.hypocenter.depth` | number | km。**0 は「ごく浅い」で有効値** | **-1** | -1 のみ `null` |
| `earthquake.hypocenter.magnitude` | number | M | **-1** | 同上 |
| `earthquake.maxScale` | number | 10/20/30/40/45/**46**/50/55/60/70 | **-1** | 既知の値以外は `null` |
| `earthquake.domesticTsunami` | string | `None` / `Unknown` / `Checking` / `NonEffective` / `Watch` / `Warning` | — | そのまま表示 |
| `earthquake.foreignTsunami` | string | `None` / `Unknown` / `Checking` / `NonEffectiveNearby` / `WarningNearby` / `WarningPacific(Wide)` / `WarningIndian(Wide)` / `Potential` | — | 読まない |
| `points[].pref` | string | 都道府県 47 ([area-codes.md](area-codes.md) §2) | — | **利用地の県との照合に使う** |
| `points[].addr` | string | `isArea: true` なら細分区域 188、`false` なら観測点名 | — | 表示のみ |
| `points[].isArea` | boolean | 区域名かどうか | — | 表示のみ |
| `points[].scale` | number | 10〜70 (`46` = 震度5弱以上と推定されるが震度情報未入手) | — | 既知の値以外は `null` |
| `comments.freeFormComment` | string | 自由付加文 (無い場合は空文字列) | — | 読まない |

震度速報 (`ScalePrompt`) では震源が未確定で、`depth`/`magnitude`/`latitude` などが
不明値で来る。**深さ 0 (ごく浅い) と -1 (不明) を取り違えないこと。**

## 2-5. 電文 552 — 津波予報

```json
{"code":552,"id":"6a685a4be88ee598246beeda","time":"2026/07/28 16:29:15.106",
 "cancelled":false,"issue":{"source":"気象庁","time":"2026/07/28 16:29:13","type":"Focus"},
 "areas":[{"grade":"Watch","immediate":true,"name":"宮崎県",
   "firstHeight":{"condition":"津波到達中と推測"},"maxHeight":{"description":"１ｍ","value":1}}]}
```

| フィールド | 型 | 値域 | 実装 |
|---|---|---|---|
| `cancelled` | boolean | `true` なら**解除**で `areas` は空配列 | 解除表示 |
| `issue.type` | string | 現在は `Focus` のみ | 読まない |
| `areas[].name` | string | 津波予報区 98 ([area-codes.md](area-codes.md) §5)。**都道府県名とは限らない** (例: 有明・八代海) | 利用地の県から展開した予報区名と**完全一致**で照合 |
| `areas[].grade` | string | `MajorWarning` (大津波警報) / `Warning` (津波警報) / `Watch` (津波注意報) / `Unknown` | 未知の値は `Unknown` |
| `areas[].immediate` | boolean | ただちに来襲すると予想されるか | 表示 |
| `areas[].firstHeight.condition` | string | `ただちに津波来襲と予測` / `津波到達中と推測` / `第１波の到達を確認` | 表示 |
| `areas[].firstHeight.arrivalTime` | string | 第1波の到達予想時刻 (2023-11-01 提供開始) | 表示 |
| `areas[].maxHeight.description` | string | `巨大` / `高い` / `１０ｍ超` / `１０ｍ` / `５ｍ` / `３ｍ` / `１ｍ` / `０．２ｍ未満` | 表示 |
| `areas[].maxHeight.value` | number | 数値表現。`巨大`/`高い` では設定されない。`０．２ｍ未満` は `0.2` | -1 は `null` |

## 2-6. 電文 554 — 緊急地震速報 発表検出

| フィールド | 型 | 値域 | 実装 |
|---|---|---|---|
| `type` | string | `Full` (チャイム＋音声) / `Chime` (チャイムのみ・未実装) | 「発表された」ことだけを表示 |

詳細を含まない第一報。震源も震度も入らない。

## 2-7. 電文 556 — 緊急地震速報 (警報)

**警報のみ**で予報は流れない。予報まで拾うには kmoni EEW JSON (§1-2) が必要。

```json
{"code":556,"cancelled":false,
 "issue":{"time":"2026/07/29 22:19:39","eventId":"20260729221936","serial":"1"},
 "earthquake":{"originTime":"2026/07/29 22:19:36","arrivalTime":"2026/07/29 22:19:39","condition":"",
   "hypocenter":{"name":"熊本県天草・芦北地方","reduceName":"熊本県",
     "latitude":32.4,"longitude":130.5,"depth":10.0,"magnitude":4.5}},
 "areas":[{"pref":"熊本","name":"熊本県熊本","scaleFrom":45,"scaleTo":45,
   "kindCode":"19","arrivalTime":"2026/07/29 22:19:44"}]}
```

| フィールド | 型 | 値域 | 実装 |
|---|---|---|---|
| `test` | boolean | テスト電文か | 訓練報として扱う |
| `cancelled` | boolean | 取消。**true のとき `earthquake` は設定されない** | 表示を消す |
| `issue.eventId` | string | 地震の識別情報 | 地震 ID。kmoni の `report_id` と一致 (§3) |
| `issue.serial` | string | 情報番号 (報数) | 数値化できなければ 0 |
| `issue.time` | string | 発表時刻 | `announcedAt` |
| `earthquake.originTime` | string | 地震発生時刻 | 突き合わせに使う (§3) |
| `earthquake.arrivalTime` | string | 地震発現時刻 | 表示 |
| `earthquake.condition` | string | 仮定震源要素の場合 `仮定震源要素` | 「仮定」を含むかで判定 |
| `earthquake.hypocenter.name` | string | 震央地名 | 空なら `不明` |
| `earthquake.hypocenter.reduceName` | string | **短縮用震央地名** ([area-codes.md](area-codes.md) §4)。`熊本県` のように県名形で来ることがあるが府県予報区とは別の表 | 読まない |
| `earthquake.hypocenter.latitude` / `longitude` | number | 度 | **-200** は不明 → `null` |
| `earthquake.hypocenter.depth` | number | km (小数が付くが整数部のみ有効) | **-1** は不明 |
| `earthquake.hypocenter.magnitude` | number | M | **-1** は不明 |
| `areas[].pref` | string | **緊急地震速報／府県予報区 56 区** ([area-codes.md](area-codes.md) §3)。`熊本` のように**接尾辞なし** | **警報対象かどうかの照合に使う**。県名でない 11 区は県へ寄せる |
| `areas[].name` | string | 細分区域 188 ([area-codes.md](area-codes.md) §2)。`熊本県熊本` のように県名を含む | 表示のみ |
| `areas[].scaleFrom` | number | -1 (不明) / 0 / 10〜70 | 既知の震度以外は `null` |
| `areas[].scaleTo` | number | **-1 = 不明、99 = 「〜程度以上」**、他は 10〜70 | どちらも上限なし (`null`) |
| `areas[].kindCode` | string | `10` (未到達と予測) / `11` (既に到達と予測) / `19` (PLUM法・到達予想なし) | 読まない |
| `areas[].arrivalTime` | string | 主要動の到達予測時刻 | **気象庁の値をそのまま表示** (自前計算はしない) |

556 には**最終報フラグが無い**。続報の打ち切りは保持期間で判断している。

---

# 3. 両系統の突き合わせ

kmoni の `report_id` と P2P の `issue.eventId` は**同一地震で完全一致する**ことを
実電文で確認した (2026-07-29 の警報級 EEW、2026-08-17 検証)。突き合わせは
**ID 一致 → 発震時刻 (±3 秒)** の順で行っている (`server/src/eew/coordinator.ts`)。

kmoni 側は予報から取れるが非公式、P2P 側は警報のみだが電文由来という非対称があるので、
どちらか一方でも来たら表示し、両方来たら P2P を優先する。

---

# 4. 実装で読んでいないフィールド

上流は返すが使っていないもの。将来使うときの棚卸し用。

- 551: `issue.correct`、`earthquake.foreignTsunami`、`comments.freeFormComment`
- 556: `areas[].kindCode`、`hypocenter.reduceName`
- 共通: `timestamp`、`user_agent`、`ver`、`created_at`
- kmoni: `region_code`、`result.is_auth`、`security`

---

## 再確認したいときは

```bash
./scripts/check-kmoni.sh          # kmoni 側の確認を一通り再実行する
python3 scripts/calibrate-kmoni-map.py --overlay /tmp/overlay.png   # 座標系の再較正

# P2P 側 (実データの形と保持期間)
curl -s 'https://api.p2pquake.net/v2/history?codes=551&limit=3'
curl -s 'https://api.p2pquake.net/v2/jma/tsunami?limit=20'
```

kmoni は「コンテンツ・配信形態を予告なく変更/削除しうる」と明記している
([利用条件](https://www.kyoshin.bosai.go.jp/ja/about_kmoni/))。
表示が崩れたときはまずこれらを流して、前提が変わっていないか確かめるとよい。
地名の表記が変わった疑いがあるときは [area-codes.md](area-codes.md) §7 の手順で
コード表を取り直す。
