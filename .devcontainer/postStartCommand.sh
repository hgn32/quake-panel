#!/bin/sh
# コンテナ起動のたびにコンテナ内で実行される
#
# Claude Code だけ別のプロキシ (keith) を使うため、コンテナの HTTP(S)_PROXY とは別に
# ~/.claude/settings.json の env で上書きする。
# ~/.claude は名前付きボリュームで永続するので、初回のみ実行される postCreateCommand で
# 書くと社内/自宅の切り替えに追従できない。そのため毎起動でここから更新する。

SETTINGS="${HOME}/.claude/settings.json"

mkdir -p "${HOME}/.claude"

node -e "$(
  cat << 'JS'
const fs = require("fs");
const file = process.argv[1];
const proxy = process.argv[2] || "";

let settings = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (raw.length > 0) {
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      // 壊れた設定を握りつぶして上書きすると手で入れた設定を失うので、何もせず抜ける
      console.error("[devcontainer] " + file + " が JSON として読めないため、プロキシ設定を更新しませんでした");
      process.exit(0);
    }
  }
}

const env = settings.env || {};
if (proxy) {
  env.HTTP_PROXY = proxy;
  env.HTTPS_PROXY = proxy;
} else {
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
}

if (Object.keys(env).length > 0) {
  settings.env = env;
} else {
  delete settings.env;
}

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
console.log("[devcontainer] claude proxy: " + (proxy || "(なし)"));
JS
)" "${SETTINGS}" "${CLAUDE_PROXY_URL:-}"
