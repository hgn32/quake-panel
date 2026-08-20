# EEW イベント (`onEewEvent`) の仕様

`onEewEvent` は「EEW の状態が動いた」ことを 1 箇所へ通知する内部コールバックで、
唯一の実装上の受け手が **webhook 送信** (`EEW_WEBHOOK_URL`) である。
つまり**この文書は webhook が「いつ」飛ぶかの規定**でもある。

- 飛ぶ JSON の形と `kind` の意味、送信の性質 (直列化・リトライなし・プロキシ非経由) は
  README の「サーバー → 外部 (EEW webhook 通知)」節 ([../README.md](../README.md)) が一次資料。
  ここでは重複させず、**発火条件と状態遷移**だけを規定する。
- 実装: `server/src/eew/coordinator.ts` (実電文) / `server/src/demo/runner.ts` (デモ再生) /
  `server/src/notify/webhookNotifier.ts` (送信) / 配線は `server/src/index.ts`
- 型: `EewEvent { kind: 'new' | 'update' | 'cancel' | 'expired'; eew: EewState }`

---

## 1. 全体の流れ

```
kmoni EEW JSON (毎秒)  ─┐
                        ├─▶ EewCoordinator.accept()
P2P 556 (WebSocket)   ─┘        │
                                │ 1. 同一地震か判定 (§3)
                                │ 2. 同一なら合成、別なら新しい方を採用 (§4)
                                │ 3. kind を決める (§2)
                                │ 4. 意味のある変化があるか判定 (§5)
                                ▼
                        onEewEvent({kind, eew}) ──▶ WebhookNotifier.handle()
                                ▲
   1 秒周期の sweep ────────────┘  保持期限切れ → kind: 'expired' (§6)

デモ再生 (DemoRunner) ──────────▶ onEewEvent  (同じ経路。§8)
```

`onEewEvent` は**同期呼び出し**で、送信は fire-and-forget。webhook の成否は
コーディネータ側へ返らず、パネル本体の動作にも影響しない。

## 2. `kind` の決まり方

`accept()` が 1 通処理するごとに、次の順で 1 つだけ決まる。

| 順位 | 条件 | `kind` |
|---|---|---|
| 1 | 今回の状態が `isCancel: true` で、**直前の状態が `isCancel: false` または状態が無かった** | `cancel` |
| 2 | 直前の状態が無い、または直前と**別の地震** (§3) | `new` |
| 3 | 上記以外 (同じ地震の続報) | `update` |
| — | 保持期限切れ (§6) | `expired` |

判定の細かい帰結:

- **`cancel` は取消の立ち上がり 1 回だけ**。同じ地震でキャンセル報が続けて来ても
  2 通目以降は `update` になり、内容が変わっていなければ §5 で抑止されて飛ばない。
- **キャンセル報がその地震の第一報だった場合は `new` ではなく `cancel`** になる
  (順位 1 が先に立つ)。
- `new` の直前に別の地震が表示中だった場合、その古い地震の `expired` は**飛ばない**。
  上書きされて消えるため。受け側は `new` を受けたら前の地震の表示を畳むこと。

## 3. 同一地震の判定 (`isSameEvent`)

| 条件 | 判定 |
|---|---|
| `id` が一致 | 同じ地震 |
| 両方に `originTime` があり、差が **±3 秒以内** (`SAME_EVENT_TOLERANCE_MS`) | 同じ地震 |
| 上記以外 | 別の地震 |

発震時刻でも突き合わせるのは、kmoni の `report_id` と P2P の `issue.eventId` が
**同じ地震でも表記が違いうる**ため (実測では一致したが、保証は無い。
[kmoni-endpoints.md](kmoni-endpoints.md) §3)。

## 4. 2 電文の合成 (`mergeStates`)

同一地震と判定されたら、**新しい報 (`announcedAt ?? receivedAt` が新しい方) を土台**に、
片方にしか無い情報を残す。`eew` に載って飛ぶのはこの合成結果。

| フィールド | 合成規則 |
|---|---|
| `alert` | どちらかが `warning` なら `warning`。**警報は降格しない** (kmoni の予報続報で警報表示が消えるのを防ぐ) |
| `isCancel` / `isTraining` | どちらかが true なら true (OR) |
| `reportNumber` | 大きい方 |
| `maxIntensity` / `originTime` | 新しい方を優先し、無ければ古い方 |
| `regions` | 新しい方が空配列なら古い方を残す (P2P だけが持つ地域別予想震度を落とさない) |
| `hypocenter.name` | 新しい方が `不明` なら古い方 |
| `hypocenter.lat` / `lon` / `depthKm` / `magnitude` | 新しい方が `null` なら古い方 |
| `source` | 両者が同じならその値、違えば **`both`** |

別の地震が届いたときは合成せず、**新しい方を採用して古い電文は無視**する
(`pickNewer`)。すでに表示中のものより古い電文は捨てられ、通知も飛ばない。

## 5. `update` の抑止 (これが最重要)

kmoni EEW JSON は**毎秒ポーリング**なので、発表中は同一内容の報が秒間隔で届く。
そのまま流すと同じ JSON を毎秒 POST し続けることになるため、
**直前の状態と比べて次のいずれかが変わっていなければ通知しない**
(`hasMeaningfulChange`)。

```
id / reportNumber / isCancel / isFinal / alert / maxIntensity / source
hypocenter.name / hypocenter.lat / hypocenter.lon / hypocenter.depthKm / hypocenter.magnitude
regions.length
```

- 直前の状態が無い場合 (その地震の最初の通知) は**必ず飛ぶ**。
- `new` と `cancel` も同じ判定を通るが、これらは上記のどれかが必ず変わるので実質必ず飛ぶ。
- **`regions` は件数だけ**見ている。件数が同じで中身 (予想震度や到達予測時刻) だけが
  変わった続報は通知されない。地域別の最新値が要るなら WebSocket 側
  (`ServerEvent.eew`) を見ること。
- この判定は `server/src/hub.ts` の `hasEewChanged` (WebSocket 配信の抑止) と
  同じ基準を意図的に複製したもの。**フィールドを増減するときは両方を直すこと。**

## 6. `expired` のタイミング

1 秒周期の `sweep()` が「最後に状態が動いてからの経過時間」を見て判定する。

| 状態 | 保持時間 | 定数 / 環境変数 |
|---|---|---|
| 通常 (発表中) | **180 秒** (既定) | `EEW_RETENTION_MS` |
| キャンセル報を表示中 | **20 秒** (固定) | `CANCEL_RETENTION_MS` |

`expired` は「**表示を終了した**」の意味で、地震や揺れの終了ではない。
飛ぶときの `eew` は**最後に保持していた状態そのまま** (合成結果)。
`expired` の後に同じ地震の続報が届けば、それは `new` として飛ぶ。

## 7. 訓練報・キャンセル報のフィルタ

**していない。** `isTraining: true` (訓練報) も `isCancel: true` (取消) も
そのまま通知する。受け側で判断すること。

| 判別 | 見るフィールド |
|---|---|
| 訓練報 | `eew.isTraining === true` |
| 取消 | `eew.isCancel === true` または `kind === 'cancel'` |
| 仮定震源要素 | `eew.isAssumption === true` (P2P 556 の `condition` に「仮定」を含む) |
| デモ再生 | `eew.id` が `demo-` で始まる (§8) |

## 8. デモ再生から飛ぶイベント

設定画面のデモ再生も**実電文と同じ経路で webhook へ流れる**。外部連携を作るときは
これを実電文と誤認しないこと。**`eew.id` は必ず `demo-` 接頭辞**が付く
(判定関数は `shared/src/protocol.ts` の `isDemoEventId`)。

| シナリオ | 飛ぶ順序 (T0 = 発火 + 1 秒) |
|---|---|
| `forecast` | `new` (T0) → `update` ×10 (2 秒間隔) → `expired` (T0+35 秒) |
| `warning` | 同上。T0+8 秒の報で `alert` が `warning` に上がる |
| `cancel` | `new` → `update` … → **`cancel`** (T0+14 秒) → `update` … → `expired` (T0+25 秒) |
| `tsunami` | **飛ばない** (`EewEvent` は EEW 専用。津波デモは webhook 対象外) |

デモ側の差異:

- **§5 の抑止を通さない**。11 報すべてが `new` / `update` / `cancel` として飛ぶ。
- デモが途中で打ち切られたとき (再トリガでの上書き、実 EEW 受信による中止、
  設定画面の「停止」) も、表示を消すのと同時に `expired` が飛ぶ。
  ただし実イベントに上書きされて publish できない場合は、表示・通知とも行わずに
  追跡だけ破棄する (実イベントの表示を消さないため)。

## 9. 送信側の性質 (要点のみ)

詳細は README の webhook 節。ここで押さえておくべき点だけ:

- **順序は URL ごとに保証**される (前の送信が終わってから次を投げる)。
  ただし**到達は保証されない** (リトライなし、タイムアウト既定 5 秒)。
  `update` を落としても次の報で追いつくが、`cancel` / `expired` を落とすと
  受け側の表示が残るので、受け側でも保持期限を持つこと。
- `EEW_WEBHOOK_URL` が未設定なら `WebhookNotifier` を生成しないため、
  `onEewEvent` は**未設定 (`undefined`)** になり、コーディネータ側は何もしない。
- 終了処理 (`stop()`) 後の `handle()` は何もしない。多重呼び出しも安全。

## 10. テストが固定している範囲

| 何を | どこ |
|---|---|
| `kind` 判定 (`new` / `update` / `cancel`) と `update` 抑止、同一地震判定、合成規則 | `server/test/eewCoordinator.test.mjs` |
| デモの `new → update×10 → expired` と `demo-` 接頭辞 | `server/test/demoRunner.test.mjs` |
| (未カバー) 実電文での `expired` — 保持期限切れの発火は自動テストが無い | — |
| 送信の直列化・失敗時に本体が止まらないこと | `server/test/webhookNotifier.test.mjs` |
| `EEW_WEBHOOK_URL` の解釈 (カンマ区切り・空文字) | `server/test/eewWebhookConfig.test.mjs` |
