# featuresはプロキシ設定できないので自前ビルド
FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bullseye

RUN apt-get update && \
    apt-get install -y awscli docker docker-compose tmux && \
    apt-get clean

ARG CLAUDE_PROXY
USER node
RUN set -eu; \
    p="${CLAUDE_PROXY:-${https_proxy:-}}"; \
    export http_proxy="$p" https_proxy="$p" HTTP_PROXY="$p" HTTPS_PROXY="$p"; \
    curl -fsSL https://claude.ai/install.sh | bash
USER root
ENV PATH="/home/node/.local/bin:${PATH}"


RUN npm completion >> /home/node/.bashrc
