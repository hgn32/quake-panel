#!/bin/sh
# コンテナが初回作成された後、1回のみコンテナ内で実行される

#### npmのサジェスト設定
npm completion >> ~/.bashrc

#### claude
# 名前付きボリュームは root 所有で作られるので初回に付け替える。
# プロキシ設定は起動のたびに切り替わりうるので postStartCommand.sh 側で行う。
sudo chown -R node:node ${HOME}/.claude