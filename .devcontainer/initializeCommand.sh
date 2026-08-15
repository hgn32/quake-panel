#!/bin/sh
# コンテナ作成時・起動のたびにホストマシン上で実行される

##set container name
KEY="COMPOSE_PROJECT_NAME"
VALUE="${USER}_$(basename $PWD)_devcontainer"
if grep -q "^${KEY}=" .env 2>/dev/null; then
  sed -i "s|^${KEY}=.*|${KEY}=${VALUE}|" .env
else
  echo "${KEY}=${VALUE}" >> .env
fi