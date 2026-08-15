#!/bin/sh
# コンテナが起動するたびにコンテナ内で実行される

#### proxy
# 値の設定はせず、いま効いているプロキシ設定を確認用に表示するだけ。
echo "---- proxy ----"
echo "HTTP_PROXY   : ${HTTP_PROXY:-(未設定)}"
echo "HTTPS_PROXY  : ${HTTPS_PROXY:-(未設定)}"
echo "NO_PROXY     : ${NO_PROXY:-(未設定)}"
echo "CLAUDE_PROXY : ${CLAUDE_PROXY:-(未設定)}"
echo "---------------"
