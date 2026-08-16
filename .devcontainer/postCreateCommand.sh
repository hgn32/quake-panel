#!/bin/sh
# コンテナが初回作成された後、1回のみコンテナ内で実行される

#### claude
# 名前付きボリュームは root 所有で作られるので初回に付け替える。
sudo chown -R node:node ${HOME}/.claude

# settings.json が無く、かつプロキシ環境下のときだけ生成する
if [ ! -f ${HOME}/.claude/settings.json ] && [ -n "${CLAUDE_PROXY}" ]; then
  cat > ${HOME}/.claude/settings.json << EOF
{
  "env": {
    "HTTPS_PROXY": "${CLAUDE_PROXY}",
    "HTTP_PROXY": "${CLAUDE_PROXY}"
  }
}
EOF
fi

# CLI の初回ウィザード（ログイン画面）をスキップするフラグを立てる。
# ~/.claude.json はマウント外（コンテナローカル）のため再ビルドで消えるが、
# 認証情報はマウント済みの ~/.claude/.credentials.json に残っているので、
# このフラグさえあれば再ログインを求められない。
node -e '
const fs = require("fs");
const p = process.env.HOME + "/.claude.json";
const d = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
d.hasCompletedOnboarding = true;
fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
'
