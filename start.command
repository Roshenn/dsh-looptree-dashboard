#!/bin/bash
# 双击启动闭环轮转面板（macOS）。首次如提示无法运行：chmod +x start.command
cd "$(dirname "$0")" || exit 1
PORT=${PORT:-4173}
echo "启动在 http://127.0.0.1:$PORT/"
(sleep 1 && open "http://127.0.0.1:$PORT/") &
node serve.mjs
