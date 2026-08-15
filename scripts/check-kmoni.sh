#!/usr/bin/env bash
# 上流エンドポイントの前提が変わっていないか確かめる。
# 結果の解釈は docs/kmoni-endpoints.md を参照。
#
#   ./scripts/check-kmoni.sh
set -uo pipefail

BASE="${KMONI_BASE_URL:-http://www.kmoni.bosai.go.jp}"
P2P="${P2P_HISTORY_URL:-https://api.p2pquake.net/v2/history}"

jst() { TZ=Asia/Tokyo date -d "${1:-now}" "+$2"; }
hr() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

hr "(a) 基準時刻 latest.json"
curl -sS -H 'cache-control: no-cache' "$BASE/webservice/server/pros/latest.json"
echo
echo "--- レスポンスヘッダ (cache-control に注意) ---"
curl -sSI "$BASE/webservice/server/pros/latest.json" | grep -iE '^(HTTP|cache-control|expires|content-type)' || true

TS=$(jst '3 seconds ago' '%Y%m%d%H%M%S')
DATE=$(jst '3 seconds ago' '%Y%m%d')

hr "(b) EEW JSON (平常時は alertflg キーが無いのが正常)"
curl -sS "$BASE/webservice/hypo/eew/${TS}.json"
echo

hr "(c) リアルタイム震度画像 ${TS}"
curl -sSI "$BASE/data/map_img/RealTimeImg/jma_s/${DATE}/${TS}.jma_s.gif" \
  | grep -iE '^(HTTP|content-type|content-length|last-modified)' || true

hr "(d) 更新間隔の確認 (直近 6 秒ぶんが毎秒存在し、内容が異なるか)"
prev=""
for i in $(seq 8 -1 3); do
  t=$(jst "$i seconds ago" '%Y%m%d%H%M%S')
  d=$(jst "$i seconds ago" '%Y%m%d')
  body=$(curl -sS "$BASE/data/map_img/RealTimeImg/jma_s/${d}/${t}.jma_s.gif" | md5sum | cut -c1-8)
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/data/map_img/RealTimeImg/jma_s/${d}/${t}.jma_s.gif")
  same=""
  [ "$body" = "$prev" ] && same="  <-- 前秒と同一"
  echo "  $t  HTTP $code  md5=$body$same"
  prev="$body"
done

hr "(e) 存在しない時刻の挙動 (画像は 404 / JSON は 200 が期待値)"
FUT=$(jst '+60 seconds' '%Y%m%d%H%M%S')
FUTD=$(jst '+60 seconds' '%Y%m%d')
printf '  未来の画像: HTTP %s\n' \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/data/map_img/RealTimeImg/jma_s/${FUTD}/${FUT}.jma_s.gif")"
printf '  未来の JSON: HTTP %s\n' \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/webservice/hypo/eew/${FUT}.json")"

hr "(f) EEW 発表中のみ生成されるレイヤ"
echo "  平常時は 302 -> nodata.gif が正常 (404 ではない点に注意)"
for layer in "PSWaveImg" "EstShindoImg"; do
  out=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' \
    "$BASE/data/map_img/${layer}/eew/${DATE}/${TS}.eew.gif")
  printf '  %-14s HTTP %s\n' "$layer" "$out"
done

hr "(g) 基図 (座標系の較正に使用)"
curl -sSI "$BASE/data/map_img/CommonImg/base_map_w.gif" \
  | grep -iE '^(HTTP|content-length)' || true

hr "(h) P2P地震情報 API"
for code in 551 552 554 556; do
  n=$(curl -sS "$P2P?codes=${code}&limit=1" | head -c 400)
  printf '  code=%s -> %s\n' "$code" "${n:0:180}"
done

hr "確認は以上"
echo "期待値からずれていた場合は docs/kmoni-endpoints.md を更新すること。"
