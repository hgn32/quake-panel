#!/bin/sh
# コンテナが初回作成された後、1回のみコンテナ内で実行される

#### claude
# 名前付きボリュームは root 所有で作られるので初回に付け替える。
sudo chown -R node:node ${HOME}/.claude

# settings.json が無く、かつプロキシ環境下のときだけ生成する
if [ ! -f ${HOME}/.claude/settings.json ] && [ -n "${HTTPS_PROXY}" ]; then
  cat > ${HOME}/.claude/settings.json << EOF
{
  "env": {
    "HTTPS_PROXY": "${HTTPS_PROXY}",
    "HTTP_PROXY": "${HTTP_PROXY:-${HTTPS_PROXY}}"
  }
}
EOF
fi
