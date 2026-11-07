#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==========================================="
echo "  集群运维工作台 (Codex Operations Console) — 桌面版"
echo "==========================================="
echo

if [ ! -d "node_modules" ]; then
  echo "首次运行，正在为您安装 Electron 依赖包，请稍候..."
  npm install
  echo "依赖包安装完成！"
  echo
fi

echo "正在拉起控制台（经 scripts/launch.mjs，含 AUTH_TOKEN）..."
exec npm start
