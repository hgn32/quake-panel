# プロジェクト共通ルール

## 禁止事項（絶対厳守 / 最優先）

プロジェクト共通の開発ルールを以下の取り込みファイルに定義しています（Claude Code は `@path` 記法でファイル内容を自動インポートします）。

@.claude/instructions/common.instructions.md

## TypeScript ファイル編集時の必須ルール

`.ts` / `.tsx` ファイルを編集する前に、必ず以下を読み込み・遵守すること。

@.claude/instructions/typescript.instructions.md

### この実装での適用

| 規約 | この実装での扱い |
|---|---|
| `for` 禁止 | `forEach` / `filter` / `map` / `Array.from` に置き換える。塊の探索 (flood fill) だけは `while` (スタックが空になるまで回す性質のため) |
| `await` 禁止 | すべて `Promise` の連鎖。逐次実行が要る所は `.then` を鎖にする |
| `any` / `unknown` 禁止 | JSON 由来の値は `JsonValue` (`shared/src/homeLocation.ts`) で受ける。例外は `describeError(error: Error)` に `as Error` で渡す |
| `console.log` 禁止 | サーバーのログは `process.stdout.write` / `process.stderr.write` (`server/src/logger.ts`)。クライアントは何も出さない |
| `!` 禁止 | 使わない。`?? 0` や `null` チェックで処理する |

例外は 1 箇所のみ: 毎秒動く観測点の抽出 (`client/src/core/mapView.ts`) は
`for` を外すと約 2 倍遅くなる (実測 1.1ms → 2.2ms / フレーム、抽出点数 1331 で同条件)
ため `for` を許容している。画素の走査は `Uint32Array` で 1 画素 1 要素にして
配列確保を避ける。理由はコード中のコメントにも書いてあるので消さないこと。

## サブエージェント

- コード実装（計画確定後の実装作業）は [`sonnet-implementer`](.claude/agents/sonnet-implementer.md) サブエージェントを利用すること。

## 編集後の確認コマンド

コード変更後は必ず以下をすべて実行し、エラーがないことを確認すること（再掲・絶対厳守）。
ビルドが通るだけでは不十分で、**テストがパスすることまで確認する**こと。

```bash
npm run build       # shared → client → server の順にビルド
npm test            # ビルド + shared/server の単体テスト (node --test)
npm run typecheck
```
