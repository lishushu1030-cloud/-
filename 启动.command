#!/bin/zsh
# ============================================================
#  双击这个文件即可启动本地服务（首次双击若被系统拦下，
#  右键 → 打开 → 仍要打开 就行）
#  等价于在终端里执行： node server.js
# ============================================================

cd "$(dirname "$0")" || exit 1

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  NODE_BIN="/Users/tuolajijizhang/.workbuddy/binaries/node/versions/22.22.2-3/bin/node"
fi

if [ ! -x "$NODE_BIN" ]; then
  echo "没有找到 node。请先安装 Node.js 18 以上版本：https://nodejs.org"
  echo "按回车键关闭…"
  read -r _
  exit 1
fi

echo "正在启动本地服务…"
"$NODE_BIN" server.js

echo ""
echo "服务已停止。按回车键关闭窗口…"
read -r _
