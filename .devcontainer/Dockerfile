# featuresはプロキシ設定できないので自前ビルド
FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bullseye

RUN apt-get update && \
    apt-get install -y awscli docker docker-compose tmux && \
    apt-get clean

# Claude CLI（プロキシは CLAUDE_PROXY があれば優先。install.sh 内部の curl にも効かせるため環境変数で渡す）
ARG CLAUDE_PROXY
USER node
RUN HTTP_PROXY="${CLAUDE_PROXY:-${HTTP_PROXY}}" HTTPS_PROXY="${CLAUDE_PROXY:-${HTTPS_PROXY}}" \
    curl -fsSL https://claude.ai/install.sh | bash
USER root
ENV PATH="/home/node/.local/bin:${PATH}"

RUN npm completion >> /home/node/.bashrc
