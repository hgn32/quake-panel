# quake-panel — 常時表示型 地震速報パネル

強震モニタ (リアルタイム震度マップ) を常時表示しつつ、緊急地震速報・地震情報・
津波予報を受けたら**音と画面明滅**で気づかせるための自宅用パネル。

- 表示端末: Raspberry Pi 4 + フル HD モニター (Chromium キオスク)
- サーバー: N150 ミニ PC 上の Docker コンテナ 1 つ
- データ源: 強震モニタ (防災科学技術研究所) / P2P地震情報 — **いずれも無償**

設計の経緯と判断は `docs/技術検討書.md`、上流エンドポイントの実測結果は
`docs/kmoni-endpoints.md`、未了の作業と割り切りは `docs/残課題.md` にある。
以下の説明で「§」はこの検討書の節番号を指す。

<!-- 画面イメージ: 平常時は日本全体のリアルタイム震度マップ + 右側に地震情報履歴、
     EEW 受信時は予想最大震度の大型表示と赤い明滅に切り替わる -->

---

## 使う前に必ず読むこと (利用条件)

強震モニタのコンテンツは**複製・転載・改変・送信・再配布が禁止**されている
(§2)。本システムはサーバーが取得した画像をクライアントへ中継するため、
**利用範囲を私的使用に収めることが成立条件**になる。具体的には:

1. **リバースプロキシで入場制限をかける** — Basic 認証必須。
   設定例は `deploy/nginx/quake-panel.conf`。不特定多数がアクセスできる状態に
   しない。インターネットへ素で公開しない。
2. **クレジットを表示する** — 画面左下に常時表示している。消さないこと。
3. **サービス化・配信への転用をしない** — 第三者への配信、通知サービス、
   SNS への自動投稿などに使わない。

実装上も次の線を引いてある。**この 3 つは意図的な制約なので外さないこと**。

- 画像の**色から震度値を復元しない** (§2(2)、検討書の Phase 4 は除外済み)。
  利用地付近の実測震度は、気象庁発表の値 (P2P 551) を履歴パネルに出している。
  観測点の描画では見やすさのために大きさ (3x3 px → 2x2 px) と明るさ (暗い色を
  白へ寄せる) を調整しているが、これは画面表示のための調整で、色から値を
  読み取る処理ではない。配信された画像を保存・再配布することもしない。
- **独自の到達予測・震度予測を計算しない** (§2(3) 気象業務法)。
  到達予測時刻は気象庁が配信した値をそのまま表示する。予測円と予想震度は
  kmoni の配信画像をそのまま重ねているだけで、半径計算はしていない。
  EEW パネルの「発震から N 秒」は経過時間であって予測ではない。
- **kmoni EEW JSON の内容を外部へ配信しない** (§2(2))。

P2P地震情報は無料・登録不要・商用可だが、**WebSocket 接続は IP あたり 2 本**まで。
本構成はサーバーが 1 本だけ張り、クライアントへはファンアウトする (§4)。
上流 WS をプロキシで素通しする構成は制限に即抵触するので採っていない。

---

## 構成

```
[N150 サーバー / Docker コンテナ]
  取得系   P2P WebSocket ×1 (551/552/554/556)
           kmoni EEW JSON  毎秒ポーリング
           kmoni 震度画像  毎秒ポーリング (EEW 中は予測円・予想震度も)
  配信系   静的ファイル / 自前 WebSocket / /kmoni/*.gif
  死活監視 kmoni 疎通断 → P2P 情報のみの劣化モードへ

[リバースプロキシ] https 終端 + Basic 認証

[Pi4 + フル HD] Chromium キオスク — 通信相手はこのコンテナだけ
```

**通信境界**: クライアントは外部 (kmoni / P2P) と一切通信しない。
これにより (a) 外部への負荷がクライアント数に依存せず一定、(b) kmoni が全て
http である混在コンテンツ問題が消える、(c) P2P の接続本数制限に触れない。

### ディレクトリ

| 場所 | 内容 |
|---|---|
| `shared/` | サーバーとクライアントで共有する型・座標変換・震度階級・時刻処理 |
| `server/` | 取得ワーカー、EEW 統合、HTTP/WebSocket 配信 |
| `client/` | 描画コア (フレームワーク非依存) と UI シェル (素の TypeScript) |
| `scripts/` | 上流の実測確認、座標系の較正、背景地図の生成 |
| `deploy/` | nginx 設定例、Pi4 キオスク起動スクリプト |
| `docs/` | 技術検討書、エンドポイント実測結果 |

`client/src/core/` は UI に依存しない描画コアで、`client/src/ui/` を
Preact や React に差し替えても手を入れずに済むようにしてある (§5)。

---

## 動かす

### Docker (本番)

```bash
docker compose up -d --build
curl -s localhost:8080/healthz | jq
```

その後 nginx を `deploy/nginx/quake-panel.conf` を参考に設定する。
Basic 認証のファイルを作るのを忘れないこと:

```bash
sudo htpasswd -c /etc/nginx/quake-panel.htpasswd <ユーザー名>
```

Pi4 側は `deploy/kiosk/` を参照。

### Home Assistant アドオン

自分で nginx を立てる代わりに、Home Assistant のアドオンとして動かすこともできる。
アドオン定義は [hgn32/ha-addons](https://github.com/hgn32/ha-addons) の
`quake-panel/` にあり、このリポジトリの特定のコミットを固定してビルドする。

Ingress 経由で開くと HA のログイン (入場制限) がそのまま利用条件 §2(1) の
要件を満たすので、Basic 認証の設定は要らない。Pi4 のキオスクからは認証なしで
開きたいので、アドオンは LAN 向けに直接ポートも開ける
(インターネットへ素で公開しないこと、という条件は変わらない)。

### 開発

```bash
npm install
npm run build          # shared → client → server の順にビルド
npm start              # サーバー単体 (STATIC_DIR で client/dist を指す)

# 画面をいじるとき: サーバーとフロントを別々に立てる
npm run dev            # サーバー (watch)
npm run dev:client     # Vite 開発サーバー (5173, API は 8080 へ中継)

npm test               # ビルドしてから単体テスト
npm run typecheck
```

上流を叩かずに EEW 表示を確認したいときは、kmoni をモックした HTTP サーバーを
立てて `KMONI_BASE_URL` をそちらへ向ければよい (P2P 側は接続したままでよい)。

---

## 設定

### サーバー (環境変数)

| 変数 | 既定 | 説明 |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 待ち受け |
| `STATIC_DIR` | `public` | クライアントのビルド成果物の場所 |
| `HA_API_URL` | (空) | Home Assistant のコア API (アドオンでは `http://supervisor/core/api`)。EEW 等の通知と、自宅位置の取得に使う |
| `SUPERVISOR_TOKEN` | (空) | 上記の認証トークン。Supervisor がアドオンへ自動で渡す |
| `HA_NOTIFY` | `true` | `false` で HA への通知を止める。**自宅位置の取得 (`/api/home-location`) は止まらない** |
| `KMONI_IDLE_FRAME_INTERVAL_SEC` | `1` | 平常時の画像取得間隔 (秒)。負荷を抑えたいなら `2` |
| `KMONI_ACTIVE_FRAME_INTERVAL_SEC` | `1` | EEW 発表中の画像取得間隔 (秒) |
| `KMONI_EEW_INTERVAL_MS` | `1000` | EEW JSON のポーリング間隔 |
| `KMONI_DEGRADE_AFTER_FAILURES` | `5` | 連続失敗が何回で劣化モードに落ちるか |
| `EEW_RETENTION_MS` | `180000` | 続報が途切れてから EEW 表示を消すまで |
| `WS_HEARTBEAT_MS` | `30000` | クライアント WS の ping 間隔 |
| `QUAKE_HISTORY_SIZE` | `12` | 保持する地震情報の件数 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### 端末ごとの設定 (画面右上の「設定」)

`localStorage` (キー `quake-panel.settings.v1`) にその端末のブラウザが保存する。
変えた瞬間に保存され、再読み込みしても残る。サーバーの挙動は変わらず、
別の端末にも影響しない。

- **EEW の通知範囲**: 「予報から通知」/「警報のみ通知」(§1 の端末別切替)。
  サーバーは常に予報も警報も配信し、鳴らすかどうかは端末側で決める。
- 音量 / テスト (実際の警報と同じ音と画面明滅を数秒出す)
- **利用地**: 決め方は 4 つ。地図の中心と、津波予報区の自動判定に使う (地名は入力しない)
  - 緯度経度を直接入れる
  - 「地図から選ぶ」でクリックして決める。クリックしただけでは確定せず、
    地図上の帯で「決定」するまで保存されない
  - 「現在地を取得」でその端末の位置情報を使う。**セキュアコンテキスト
    (HTTPS または localhost) でしかブラウザの位置情報 API が存在しない**ため、
    素の HTTP で開いているときはボタン自体を出さない。
    許可ダイアログを閉じられるとブラウザから応答が来ないことがあるので、
    30 秒で自前で打ち切って理由を出す (`client/src/core/homeLocation.ts`)
  - 「HA の自宅位置を使う」で Home Assistant に設定されている自宅の緯度経度を使う。
    HTTP でも使えるので、キオスク端末ではこちらが唯一の自動取得手段になる。
    HA 側が未設定 (`0,0`) のときは「設定されていません」と出す
- **強調する津波予報区**: 既定は利用地の都道府県から自動で決める。
  予報区名は県名と一致しないもの (「東京湾内湾」「有明・八代海」等) があるため、
  県ごとの補助表を持っている (`shared/src/tsunami.ts`)。手動で県を選ぶこともできる
- **表示位置を固定**: 常時表示の端末で誤って動かさないためのキオスク向け設定
- 観測点の発光表示 (重い端末では切る)
- 履歴の表示件数

地図の拡大縮小・スクロールは設定画面ではなく**地図の上**で行う
(右上の ＋ / − / 日本全体 / 利用地)。ホイールとドラッグでも動き、
動かした位置はその端末に保存される。

サーバーは利用地も表示も持たない。上の設定はすべてその端末のブラウザだけの話で、
他の端末には影響しない。

### URL で指定する

キオスク端末のように「その端末の設定を触らずに決め打ちしたい」場合は、
URL のクエリパラメータで上書きできる。**強さは URL > 端末の保存値 > 既定値**で、
URL で指定した値は保存されない (パラメータを外すと元の設定に戻る)。
URL で指定されている項目は設定画面でも編集できないようにしてある。

| パラメータ | 例 | 説明 |
|---|---|---|
| `lat` / `lon` | `?lat=35.681&lon=139.767` | 利用地。両方揃っているときだけ効く |
| `tsunami` | `?tsunami=東京都,千葉県` | 強調する津波予報区 (カンマ区切り) |

---

## Home Assistant との連携

`HA_API_URL` と `SUPERVISOR_TOKEN` があるとき (= HA のアドオンとして動いているとき)、
コア API を使って次の 2 つを行う。

| 用途 | 向き | `HA_NOTIFY=false` のとき |
|---|---|---|
| 緊急地震速報などの通知 (イベント / センサー) | パネル → HA | 止まる |
| 自宅の緯度経度の取得 (`GET /api/home-location`) | HA → パネル | **止まらない** |

自宅位置は利用地を決めるときの補助にだけ使う。取得できなければ 204 を返すだけで、
パネルの表示は何も変わらない。

### 通知

緊急地震速報などを Home Assistant へ流す。**画面を見ていなくても HA 側で気づける**
ようにするためで、「EEW が出たらダッシュボードを地震パネルに切り替える」
といった自動化に使える。

### イベント

続報のたびではなく、**意味が変わったときだけ**発火する
(同じ地震で震度や警報種別が変わらない続報では出さない)。

| イベント | いつ | 主なデータ |
|---|---|---|
| `quake_panel_eew` | 緊急地震速報の受信・格上げ・取消 | `is_warning` / `max_intensity` / `hypocenter` / `report_number` / `is_cancel` / `is_training` |
| `quake_panel_tsunami` | 津波予報の発表・解除 | `active` / `areas` / `grades` |
| `quake_panel_quake` | 地震情報 (551) の受信 | `max_intensity` / `hypocenter` / `magnitude` / `occurred_at` |

### エンティティ

| エンティティ | 内容 |
|---|---|
| `binary_sensor.quake_panel_eew` | 緊急地震速報の発表中 (訓練報・取消では `off`) |
| `sensor.quake_panel_eew_intensity` | 予想最大震度 (`5強` など) |
| `binary_sensor.quake_panel_tsunami` | 津波予報の発表中 |
| `sensor.quake_panel_last_quake` | 最新の地震情報の最大震度 |

States API で作る状態は HA を再起動すると消えるため、60 秒ごとに入れ直している
(`HA_STATE_REFRESH_MS`)。通知が失敗してもパネルの表示は止めない。

### 自動化の例

```yaml
automation:
  - alias: 緊急地震速報でダッシュボードを切り替える
    triggers:
      - trigger: event
        event_type: quake_panel_eew
    conditions:
      - condition: template
        value_template: "{{ trigger.event.data.is_warning and not trigger.event.data.is_training }}"
    actions:
      - action: browser_mod.navigate
        data:
          path: /lovelace/quake
```

---

## 接続先とプロトコル

### サーバー → 外部 (上流)

**外部と通信するのはサーバーだけ**。ファイアウォールや送信許可リストを設定する
場合はこの一覧が対象になる。**稼働中**の宛先ホストは 2 つ
(`www.kmoni.bosai.go.jp` と `api.p2pquake.net`) のみ。
ビルド時・保守時には別の宛先が要る (後述)。

| 宛先 | プロトコル | 頻度 | 用途 |
|---|---|---|---|
| `http://www.kmoni.bosai.go.jp/webservice/server/pros/latest.json` | HTTP/1.1 GET | 60 秒ごと | 基準時刻。端末時計のズレと配信遅れの補正 |
| `http://www.kmoni.bosai.go.jp/webservice/hypo/eew/{YYYYMMDDhhmmss}.json` | HTTP/1.1 GET | **毎秒** | 緊急地震速報 (予報・警報)。無償で予報まで取れる唯一の経路 |
| `http://www.kmoni.bosai.go.jp/data/map_img/RealTimeImg/jma_s/{YYYYMMDD}/{ts}.jma_s.gif` | HTTP/1.1 GET | **毎秒** | リアルタイム震度画像 (352×400 GIF、約 7.9KB) |
| `http://www.kmoni.bosai.go.jp/data/map_img/PSWaveImg/eew/{YYYYMMDD}/{ts}.eew.gif` | HTTP/1.1 GET | EEW 発表中のみ毎秒 | P/S 波の予測円 |
| `http://www.kmoni.bosai.go.jp/data/map_img/EstShindoImg/eew/{YYYYMMDD}/{ts}.eew.gif` | HTTP/1.1 GET | EEW 発表中のみ毎秒 | 予想震度 |
| `wss://api.p2pquake.net/v2/ws` | **WebSocket over TLS** | 常時接続 **1 本** | 551 地震情報 / 552 津波予報 / 554 EEW 発表検出 / 556 EEW (警報) |
| `https://api.p2pquake.net/v2/history?codes=551&limit=12` | HTTPS GET | 起動時 1 回 | 地震情報の履歴シード (起動直後に画面が空にならないように) |
| `https://api.p2pquake.net/v2/history?codes=552&limit=1` | HTTPS GET | 起動時 1 回 | 津波予報の現況シード |

宛先は環境変数で差し替えられる (`KMONI_BASE_URL` / `P2P_WS_URL` / `P2P_HISTORY_URL`)。
検証時に上流をモックへ向けるときはここを変える。

注意点:

- **kmoni はすべて平文 HTTP (TLS 無し)**。ブラウザから直接叩くと混在コンテンツに
  なるため、サーバー経由に一本化してある。
- **P2P の WebSocket は IP あたり 2 本まで** (2026年6月〜)。サーバーが 1 本だけ張り、
  クライアントへは自前 WebSocket でファンアウトする。上流 WS をプロキシで
  素通しする構成は、全クライアントがサーバー IP 発になるため即座に制限へ抵触する。
- **外部への通信量はクライアント数に依存しない**。平常時でおよそ 8.5KB/s
  (画像 7.9KB + EEW JSON 0.5KB 前後) ≒ 1 日 700MB 程度。
  抑えたい場合は `KMONI_IDLE_FRAME_INTERVAL_MS=2000` で半分になる。

### クライアント → サーバー

クライアント (Pi4 の Chromium) が話す相手は**このコンテナだけ**。
リバースプロキシで https/wss を終端し、プロキシ↔コンテナ間は平文で構わない。

表の**パスはサーバーから見たもの**で、公開 URL がこの通りとは限らない。
Home Assistant の Ingress のように前置きパスの下へ置かれる場合、Supervisor は
前置きを剥がしてから中継するのでサーバー側は何も変わらず、ずれるのは
ブラウザ側の相対解決だけになる。そのため、
**サーバーは `X-Ingress-Path` があれば `index.html` へ `<base href>` を差し込み**
(`server/src/http/indexHtml.ts`)、**クライアントは全ての要求を
`document.baseURI` 基準で組み立てる** (`client/src/core/urls.ts`)。
素で `/` 直下に置いたときは `<base>` が入らず、従来どおりの絶対パスになる。

| パス | プロトコル | 用途 |
|---|---|---|
| `GET /` | HTTP(S) | パネル本体 (HTML / JS / CSS) |
| `GET /assets/japan-map.json` | HTTP(S) | 自前の背景地図。起動時 1 回のみ (約 134KB) |
| `GET /ws` | **WebSocket** (`ws://` / `wss://`) | イベント配信。新フレーム通知・EEW・地震情報・津波・死活 |
| `GET /kmoni/latest.gif` | HTTP(S) | 最新のリアルタイム震度画像 (`no-store`) |
| `GET /kmoni/frame/{ts}.gif` | HTTP(S) | タイムスタンプ指定。内容不変なのでキャッシュ可 |
| `GET /kmoni/pswave/{ts}.gif` | HTTP(S) | 予測円 (EEW 発表中のみ) |
| `GET /kmoni/estshindo/{ts}.gif` | HTTP(S) | 予想震度 (EEW 発表中のみ) |
| `GET /api/state` | HTTP(S) | 現況一括 (JSON)。デバッグ用 |
| `GET /healthz` | HTTP(S) | 死活。劣化モードでも P2P が生きていれば 200 |

画像は WebSocket にバイナリを流さず HTTP で取りに行く方式にしている
(キャッシュ制御とデバッグが単純になるため)。流れは
**「WS で新フレームのタイムスタンプを通知 → クライアントが HTTP で取得」**。

### WebSocket プロトコルの中身

型定義は `shared/src/protocol.ts` にあり、サーバーとクライアントで共有している。

| 向き | メッセージ | 意味 |
|---|---|---|
| S→C | `hello` | 接続直後の現況一括 (以後の差分の基準) |
| S→C | `frame` | kmoni の新フレームが取れた。タイムスタンプと遅延を通知 |
| S→C | `eew` | EEW の新規・続報。`null` は表示終了 |
| S→C | `eewDetection` | 緊急地震速報の発表検出 (詳細不明の第一報) |
| S→C | `quake` | 地震情報 (震度速報・震源情報など) |
| S→C | `tsunami` | 津波予報 |
| S→C | `health` | 取得系の死活変化 (劣化モードの出入り) |
| S→C | `pong` | アプリ層 ping への応答 |
| C→S | `ping` | アプリ層ハートビート (20 秒ごと) |
| C→S | `resync` | 取りこぼし時などに現況一括を要求 |

切断対策は 3 段構えにしてある。プロキシのアイドルタイムアウト対策として
サーバーから 30 秒ごとに WebSocket の ping フレームを送り (`WS_HEARTBEAT_MS`)、
クライアントからも 20 秒ごとにアプリ層 ping を送る。さらに、TCP は生きているのに
何も流れてこない状態を検知するため、クライアント側で 75 秒受信が途切れたら
自分から張り直す (劣化モード中はフレーム通知が止まって無通信になりうるため)。
再接続は指数バックオフ (1 秒 → 最大 30 秒)。

### ビルド時・保守時にだけ使う外部接続

**稼働中は不要**。イメージを作るときと、保守スクリプトを手で流したときにだけ発生する。
稼働中だけを絞った送信許可リストを組むなら、ビルドは別の経路で行うか、
ビルド時だけ一時的に開ける必要がある。

| 宛先 | いつ | 用途 |
|---|---|---|
| Docker レジストリ (`registry-1.docker.io` ほか) | `docker compose build` | ベースイメージ `node:22-bookworm-slim` の取得 |
| `https://registry.npmjs.org` | `docker compose build` / `npm install` | 依存パッケージの取得 |
| `https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson` | `scripts/build-basemap.mjs` 実行時 | 背景地図の元データ (行政区域) |
| `http://www.kmoni.bosai.go.jp/data/map_img/CommonImg/base_map_w.gif` | `scripts/calibrate-kmoni-map.py` 実行時 | 座標系の較正に使う基図 |

背景地図 (`client/public/assets/japan-map.json`) は生成済みのものをリポジトリに
コミットしてあるので、**ビルドのたびに GeoJSON を取りに行くことはない**。
`scripts/` は Docker イメージにも含めていない (`.dockerignore`)。

実行時の依存パッケージは `ws` (WebSocket) の 1 つだけで、クライアント側は
外部依存ゼロ。Web フォントや CDN の類も一切参照していないので、
**ブラウザが自オリジン以外へ出ていくことはない**。

> 補足: Pi4 の OS や Chromium 自体が行う通信 (パッケージ更新、ブラウザの
> コンポーネント更新など) はこのアプリの管轄外。ネットワークを厳しく絞る場合は
> そちらも別途確認すること。

---

## 座標系について

kmoni は配信画像の投影パラメータを公開していない。本リポジトリでは公開されている
基図と観測点配置から較正した値を `shared/src/kmoniGeo.ts` に持っている。
再較正が必要になったら:

```bash
pip install pillow numpy scipy
python3 scripts/calibrate-kmoni-map.py --overlay /tmp/overlay.png
```

背景地図 (`client/public/assets/japan-map.json`) は、この座標系へ投影済みの
都道府県ポリゴン。生成し直すには:

```bash
npm run build -w @quake-panel/shared
node scripts/build-basemap.mjs
```

出典: 「国土数値情報(行政区域データ)」(国土交通省) を加工して作成。

---

## 受け入れ条件と確認方法

検討書 §6 に挙がっている項目と、その確認手順。

| 条件 | 確認方法 | 状態 |
|---|---|---|
| kmoni 疎通断時の劣化モード | `KMONI_BASE_URL` を到達しないホストに向けて起動。地震情報履歴が出続け、画面上部に劣化モードの案内が出ること | 実装済み |
| EEW キャンセル報・訓練報の処理 | キャンセル報で明滅と音が即座に止まり「取り消されました」と表示。訓練報では鳴らさない | 実装済み・単体テストあり |
| 端末時計ズレ時の動作 | サーバーの時計を数十秒ずらして起動。`latest.json` 基準で補正され、画像が取得できること | 実装済み |
| 72 時間ソークでメモリ増加なし | サーバー・Pi4 双方で RSS を定期記録 | **要実施** |
| Pi4 フル HD の平常時 CPU 使用率 | 実機で測って仕様化する | **要実施** |

最後の 2 つは実機 (Pi4 と N150) が要るので、このリポジトリ側では未実施。
サーバー側は画像をリングバッファ (既定 30 フレーム × 3 レイヤ) に置くだけ、
クライアント側は `ImageBitmap` を差し替え時に必ず `close()` する作りにしてある。

実機投入までにやること、実データ待ちの確認、意図的な割り切りは
**`docs/残課題.md`** にまとめてある。Docker ビルドと nginx 設定は未検証なので、
N150 で最初に確認すること。
