# プロジェクト共通ルール

## 禁止事項（絶対厳守 / 最優先）

プロジェクト共通の開発ルールを以下の取り込みファイルに定義しています（Claude Code は `@path` 記法でファイル内容を自動インポートします）。

@.claude/instructions/common.instructions.md

## TypeScript ファイル編集時の必須ルール

`.ts` / `.tsx` ファイルを編集する前に、必ず以下を読み込み・遵守すること。

@.claude/instructions/typescript.instructions.md

## サブエージェント

- コード実装（計画確定後の実装作業）は [`sonnet-implementer`](.claude/agents/sonnet-implementer.md) サブエージェントを利用すること。

## 編集後の確認コマンド

コード変更後は必ず以下をすべて実行し、エラーがないことを確認すること（再掲・絶対厳守）。
ビルドが通るだけでは不十分で、**テストがパスすることまで確認する**こと。
