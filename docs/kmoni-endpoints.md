# 強震モニタ / P2P地震情報 エンドポイント実測結果

検討書 §7-3「kmoni エンドポイントの実データ確認 (未・開発初手タスク)」の結果。
**実施日: 2026-08-13** (JST 午前中、平常時)。実装はここに書いた事実を前提にしている。

---

## 1. 基準時刻 `/webservice/server/pros/latest.json`

```
$ curl -s http://www.kmoni.bosai.go.jp/webservice/server/pros/latest.json
{"security": {...}, "latest_time": "2026/08/13 11:09:55",
 "request_time": "2026/08/13 11:09:56", "result": {"status": "success", "message": ""}}
```

| 観点 | 結果 |
|---|---|
| `latest_time` | 配信済みデータの最新時刻。実測で `request_time` の **1〜2 秒前** |
| `request_time` | kmoni 側がリクエストを受けた時刻。**分解能は 1 秒** |
| レスポンスヘッダ | `cache-control: public, max-age=10800` / `expires: (1時間後)` |

**注意点 — キャッシュヘッダの罠**: 固定 URL に 3 時間の `max-age` が付いている。
間に透過キャッシュがいると古い時刻を掴まされる。実装では `cache-control: no-cache`
を付けて取得している (`server/src/sources/httpClient.ts`)。

この 2 つの時刻から、端末時計のズレ (`request_time` との差) と
データ生成の遅れ (`latest_time` との差) を分けて測れる。受け入れ条件
「端末時計ズレ時の動作」はこれで担保している (`server/src/sources/kmoniClock.ts`)。

## 2. EEW JSON `/webservice/hypo/eew/{YYYYMMDDhhmmss}.json`

平常時のレスポンス (実測):

```json
{"result": {"status": "success", "message": "データがありません", "is_auth": true},
 "report_time": "", "region_code": "", "request_time": "20260813111003",
 "region_name": "", "longitude": "", "is_cancel": "", "depth": "",
 "calcintensity": "", "is_final": "", "is_training": "", "latitude": "",
 "origin_time": "", "security": {...}, "magunitude": "", "report_num": "",
 "request_hypo_type": "eew", "report_id": ""}
```

実装に効く発見:

1. **平常時は `alertflg` キーそのものが存在しない**。空文字ですらない。
   したがって発表判定は「`alertflg` が `予報` / `警報` のいずれかであること」で行う。
   `message` の文言 (「データがありません」) に依存する判定は避ける。
2. **真偽値フィールドは文字列**。`is_cancel` は平常時 `""`、発表時は `"true"`/`"false"`。
   実装では文字列と真偽値の両方を受ける。
3. **`magunitude`** という綴りが実際のキー名 (こちらの打ち間違いではない)。
4. **未来のタイムスタンプでも 200 が返る** (中身は平常時と同じ空レスポンス)。
   つまり EEW JSON からは端末時計のズレを検知できない。→ 時刻合わせは
   latest.json、追従の微調整は画像の 404 で行う。
5. レスポンスヘッダは latest.json と同じく `max-age=10800`。ただし URL に
   タイムスタンプが入るので実害はない。

## 3. リアルタイム震度画像

`/data/map_img/RealTimeImg/jma_s/{YYYYMMDD}/{YYYYMMDDhhmmss}.jma_s.gif`

| 観点 | 結果 |
|---|---|
| 更新間隔 | **毎秒**。連続 10 秒ぶんすべて 200 が返り、内容もすべて異なる |
| 画像サイズ | **352 x 400 px**、GIF (透過)、1 枚あたり **約 7.9 KB** |
| 生成の遅れ | `last-modified` はタイムスタンプの **約 1 秒後** |
| 存在しない時刻 | **404** (`content-length: 146`)。→ 時計ズレの検知に使える |
| 他のレイヤ | `acmap_s` (最大加速度) なども同じ規則で存在する |

平常時の取得間隔は **1 秒** を既定にした (§7-4 の宿題)。
毎秒でも外部への負荷は 8 KB/s 程度で、サーバー集約なのでクライアント数に依存しない。
落としたい場合は `KMONI_IDLE_FRAME_INTERVAL_MS=2000` で 2 秒に変えられる。

### 補助レイヤ (EEW 発表中のみ生成)

kmoni 本体の JS (`MapCtrl.js`) から URL 規則を確認した。

- 予測円: `/data/map_img/PSWaveImg/eew/{YYYYMMDD}/{ts}.eew.gif`
- 予想震度: `/data/map_img/EstShindoImg/eew/{YYYYMMDD}/{ts}.eew.gif`

実装では EEW 発表中だけ取りに行く。

**注意点 — 存在しない画像の返し方がレイヤによって違う**:
リアルタイム震度は 404 だが、こちらは **302 で `CommonImg/nodata.gif` (807 B) へ
リダイレクト**される。リダイレクトを追ってしまうと中身のないプレースホルダを
「取得成功」と誤認するので、画像取得ではリダイレクトを追わず、3xx は
「その画像は無い」として扱っている (`server/src/sources/httpClient.ts`)。

### 基図

`/data/map_img/CommonImg/base_map_w.gif` (白地図、352x400) は存在する。
`base_map_c.gif` / `base_map_wd.gif` は 404。本アプリは自前の背景地図を敷くので
基図は較正にしか使っていない (§4 参照)。

## 4. 座標系 (投影パラメータ)

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

## 5. 配信画像に焼き込まれた見出し

リアルタイム震度画像の左上には `Realtime Sindo (Surface)` と時刻が黒文字で
描かれている。実測で **y=8..34 / x=6..218** の範囲に収まり、
**この帯 (y<40, x<240) には観測点が 1 点も無い**ことを確認した。

フル HD へ引き伸ばすとこの文字が画面を占領してしまうため、表示側でこの矩形を
描画対象から外す設定を既定 ON にしてある (画像自体は加工しない。設定で戻せる)。

## 6. P2P地震情報 API v2

実データで確認したスキーマ (`server/src/sources/p2pTypes.ts` に反映済み)。

| コード | 用途 | 実装で効く点 |
|---|---|---|
| 551 | 地震情報 | 震源未確定の電文では `depth`/`magnitude`/`latitude` が **-1** (不明) |
| 552 | 津波予報 | `areas[].name` は予報区名。**都道府県名とは限らない** (例: 「有明・八代海」) |
| 554 | EEW 発表検出 | `type` は `Full` / `Chime` |
| 556 | EEW (警報) | `issue.eventId` が地震 ID、`issue.serial` が報数。`scaleTo: -1` は「以上」 |

556 は**警報のみ**で予報は流れない。予報まで拾うには kmoni EEW JSON が必要
(検討書 §3 の判断どおり)。kmoni の `report_id` と P2P の `eventId` は表記が
異なるため、両者の突き合わせは **発震時刻 (±3 秒)** でも行っている。

---

## 再確認したいときは

```bash
./scripts/check-kmoni.sh          # 上記の確認を一通り再実行する
python3 scripts/calibrate-kmoni-map.py --overlay /tmp/overlay.png   # 座標系の再較正
```

kmoni は「コンテンツ・配信形態を予告なく変更/削除しうる」と明記している (§2(4))。
表示が崩れたときはまずこの 2 つを流して、前提が変わっていないか確かめるとよい。
