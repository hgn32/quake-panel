# ---- build ----------------------------------------------------------------
# 検討書 §5-3 の方針どおり、ビルド成果物だけを実行イメージへ入れる。
FROM node:22-bookworm-slim AS build
WORKDIR /app

# 依存のインストールはソース変更で無効化されないよう先に済ませる
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY shared/ shared/
COPY server/ server/
COPY client/ client/
RUN npm run build

# 実行に要らない依存を落とす
RUN npm prune --omit=dev

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/public \
    TZ=Asia/Tokyo

COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/package.json package.json
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist/
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist/
COPY --from=build /app/client/dist public/

USER node
EXPOSE 8080

# 上流が落ちていても P2P だけで継続する劣化モードは "生存" 扱い (§4)。
# /healthz はその判断込みで応答する。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
