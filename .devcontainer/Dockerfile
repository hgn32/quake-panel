# featuresはプロキシ設定できないので自前ビルド
FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bullseye

RUN apt-get update && \
    apt-get install -y awscli docker docker-compose && \
    apt-get clean
    
RUN npm completion >> /home/node/.bashrc
