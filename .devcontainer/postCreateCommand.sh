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


# claude のオンボーディング（テーマ／ログイン方法の選択）を抑止する。
# .claude/ は名前付きボリュームでイメージ側では管理できないためここで設定する。
CLAUDE_JSON="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/.claude.json"
if [ ! -f "${CLAUDE_JSON}" ]; then
  echo '{"hasCompletedOnboarding":true}' > "${CLAUDE_JSON}"
elif [ "$(jq -r '.hasCompletedOnboarding // false' "${CLAUDE_JSON}")" != "true" ]; then
  # 既存キー（oauthAccount など）は保持したまま該当キーのみ追加する
  if jq '.hasCompletedOnboarding = true' "${CLAUDE_JSON}" > "${CLAUDE_JSON}.tmp"; then
    mv "${CLAUDE_JSON}.tmp" "${CLAUDE_JSON}"
  else
    rm -f "${CLAUDE_JSON}.tmp"
    echo "claude: ${CLAUDE_JSON} の更新に失敗しました（JSON 不正の可能性）"
  fi
fi
