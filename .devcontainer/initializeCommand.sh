#!/bin/sh
# コンテナ作成時・起動のたびにホストマシン上で実行される

ENV_FILE=.env

# .env の KEY=VALUE を追記 or 更新する。
# sed -i は GNU/BSD で引数の扱いが違うため、拡張子付き (-i.bak) で両対応させる。
set_env() {
  _key=$1
  _value=$2
  if grep -q "^${_key}=" "${ENV_FILE}" 2>/dev/null; then
    sed -i.bak "s|^${_key}=.*|${_key}=${_value}|" "${ENV_FILE}"
    rm -f "${ENV_FILE}.bak"
  else
    echo "${_key}=${_value}" >> "${ENV_FILE}"
  fi
}

# .env から値を取り出す (未定義なら空文字)
get_env() {
  sed -n "s|^$1=||p" "${ENV_FILE}" 2>/dev/null | tail -n 1
}

##set container name
set_env "COMPOSE_PROJECT_NAME" "${USER}_$(basename "$PWD")_devcontainer"

##proxy
# 社内プロキシは用途で 2 台に分かれている。
#   OFFICE_PROXY_HOST       : apt / npm / docker build など一般通信
#   OFFICE_CLAUDE_PROXY_HOST: Claude Code 専用
# 自宅ではどちらも不要なので空にする。
OFFICE_PROXY_HOST=hope.asahi-kasei.co.jp
OFFICE_CLAUDE_PROXY_HOST=keith.asahi-kasei.co.jp
OFFICE_NO_PROXY=127.0.0.1,localhost,prisma-cp.paprisma,github.com,www.dpro.asahi-kasei.co.jp,vpce.amazonaws.com,dev001-atqcs-aidi.cognitiveservices.azure.com

# 名前解決できるかどうかだけで社内/自宅を判定する。
# getent は macOS に無く、nslookup は Windows(Git Bash)/macOS/Linux いずれにもある。
resolves() {
  if command -v getent > /dev/null 2>&1 && getent hosts "$1" > /dev/null 2>&1; then
    return 0
  fi
  if command -v nslookup > /dev/null 2>&1 && nslookup "$1" > /dev/null 2>&1; then
    return 0
  fi
  return 1
}

# PROXY_MODE: auto (既定) | office | home
# 自動判定を誤る場合は .env に PROXY_MODE=home / office と書けば固定できる。
PROXY_MODE=$(get_env PROXY_MODE)
if [ -z "${PROXY_MODE}" ]; then
  PROXY_MODE=auto
  set_env "PROXY_MODE" "auto"
fi

RESOLVED_MODE=${PROXY_MODE}
if [ "${PROXY_MODE}" = "auto" ]; then
  if resolves "${OFFICE_PROXY_HOST}"; then
    RESOLVED_MODE=office
  else
    RESOLVED_MODE=home
  fi
fi

if [ "${RESOLVED_MODE}" = "office" ]; then
  set_env "PROXY_URL" "http://${OFFICE_PROXY_HOST}:3128"
  set_env "CLAUDE_PROXY_URL" "http://${OFFICE_CLAUDE_PROXY_HOST}:3128/"
  set_env "PROXY_NO_PROXY" "${OFFICE_NO_PROXY}"
else
  set_env "PROXY_URL" ""
  set_env "CLAUDE_PROXY_URL" ""
  set_env "PROXY_NO_PROXY" ""
fi

echo "[devcontainer] proxy: ${RESOLVED_MODE} (PROXY_MODE=${PROXY_MODE})"
