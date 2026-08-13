#!/usr/bin/env bash
# Raspberry Pi 4 でフル HD キオスク表示する起動スクリプト。
# 表示先はリバースプロキシの URL (Basic 認証あり)。
set -euo pipefail

URL="${QUAKE_PANEL_URL:-https://quake.example.lan/}"
PROFILE="${QUAKE_PANEL_PROFILE:-$HOME/.config/quake-panel-kiosk}"

# 常時表示が目的なので画面を消させない
xset s off || true
xset -dpms || true
xset s noblank || true

# 前回異常終了時の復元バーを出させない (無人運用で画面が崩れるため)
if [ -f "$PROFILE/Default/Preferences" ]; then
  sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' \
    "$PROFILE/Default/Preferences" || true
fi

exec chromium-browser \
  --kiosk \
  --user-data-dir="$PROFILE" \
  --app="$URL" \
  --start-fullscreen \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI,Translate \
  --check-for-update-interval=31536000 \
  --autoplay-policy=no-user-gesture-required \
  --enable-features=VaapiVideoDecoder \
  --password-store=basic
