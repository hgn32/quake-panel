#!/bin/bash
# リリース前のビルド確認用。テスト → docker build → 起動スモークテストの順に確認する。
# 実イメージはこのディレクトリの Dockerfile 1 本だけで管理する。
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
IMAGE=quake-panel
SMOKE_NAME=quake-panel-buildtest

# プロキシ経由でビルドするときは、呼び出し側が環境変数で指定する。
#   PROXY_URL=http://proxy.example.com:8080 PROXY_NO_PROXY=localhost release/build_image.sh
if [ -z "${PROXY_URL}" ]; then
    echo "ℹ️ PROXY_URL が空のためプロキシ無しでビルドします"
fi

# テスト (時間のかかる docker build の前に実行して早く落とす)。
# ルートの npm test は npm run build を含むので、型エラーもここで落ちる。
cd "${ROOT_DIR}" || exit 1
if [ ! -d node_modules ]; then
    npm ci
    if [ $? -ne 0 ]; then
        echo "🐞Failed npm ci"
        exit 1
    fi
fi
npm test
if [ $? -ne 0 ]; then
    echo "🐞Failed test"
    exit 1
fi
echo "🎉Successfully test"

# コミットハッシュはイメージのタグとして残しつつ、設定画面にも表示できるよう
# build-arg で Dockerfile 側にも渡す (イメージ内には .git が無いため git コマンドは使えない)。
COMMIT_HASH=$(git -C "${ROOT_DIR}" show --format='%H' --no-patch 2>/dev/null | cut -c 1-7)
TAG_ARGS=(-t "${IMAGE}:latest")
if [ -n "${COMMIT_HASH}" ]; then
    TAG_ARGS+=(-t "${IMAGE}:${COMMIT_HASH}")
fi

docker build "${TAG_ARGS[@]}" \
        --no-cache \
        -f "${SCRIPT_DIR}/Dockerfile" \
        --build-arg HTTP_PROXY="${PROXY_URL}" \
        --build-arg HTTPS_PROXY="${PROXY_URL}" \
        --build-arg NO_PROXY="${PROXY_NO_PROXY}" \
        --build-arg COMMIT_HASH="${COMMIT_HASH}" \
        "${ROOT_DIR}"
if [ $? -ne 0 ]; then
    echo "🐞Failed build"
    exit 1
fi
echo "🎉Successfully build"

# 起動スモークテスト。確認するのは「イメージとして起動でき、HTTP が応答し、
# client のビルド成果物が同梱されているか」まで。
# 上流 (kmoni / P2P) への到達性は環境次第で変わるため合否に含めない
# (到達できないと /healthz は劣化判定で 503 になり、イメージ自身の HEALTHCHECK も unhealthy になる)。
# devcontainer からはホスト側 docker を操作しているだけで公開ポートに直接届かないので、
# HTTP はコンテナの中から叩く。
SMOKE_JS='const base="http://127.0.0.1:"+(process.env.PORT||8080);'\
'Promise.all([fetch(base+"/healthz"),fetch(base+"/")])'\
'.then(([h,i])=>{console.log("healthz="+h.status+" index="+i.status);process.exit(i.ok?0:1);})'\
'.catch(()=>process.exit(1));'

docker rm -f "${SMOKE_NAME}" >/dev/null 2>&1
docker run -d --name "${SMOKE_NAME}" "${IMAGE}:latest" >/dev/null
if [ $? -ne 0 ]; then
    echo "🐞Failed run"
    exit 1
fi

SMOKE_RESULT=
for _ in $(seq 1 30); do
    SMOKE_RESULT=$(docker exec "${SMOKE_NAME}" node -e "${SMOKE_JS}" 2>/dev/null)
    if [ $? -eq 0 ]; then
        break
    fi
    SMOKE_RESULT=
    sleep 1
done

if [ -z "${SMOKE_RESULT}" ]; then
    echo "🐞Failed smoke test"
    docker logs --tail 30 "${SMOKE_NAME}"
    docker rm -f "${SMOKE_NAME}" >/dev/null 2>&1
    exit 1
fi
docker rm -f "${SMOKE_NAME}" >/dev/null 2>&1
echo "🎉Successfully smoke test (${SMOKE_RESULT})"
# docker rmi ${IMAGE}:latest
