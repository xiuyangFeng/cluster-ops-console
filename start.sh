#!/usr/bin/env bash
# 集群运维工作台 (Codex Operations Console) 启动脚本（macOS / Linux）。
# 网页模式零 npm 依赖，只要有 Node.js 即可启动；node_modules 只有 macOS 桌面窗口（Electron）才需要，
# 缺失时 scripts/launch.mjs 会自动回退网页模式并提示 npm install / npm run electron:install。
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Node 版本闸门：与 package.json engines（>=22.12.0 <27）、lib/platform.mjs 的 isNodeVersionSupported 一致；
# 改范围时这里和 install/ 下两个安装器一起改（scripts/installer.test.mjs 守着这几处不走样）。
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=12
NODE_MAX_MAJOR=27

# $1 = node 可执行文件（名字或路径）；版本在范围内返回 0。
node_supported() {
  local version major rest minor
  version="$("$1" --version 2>/dev/null)" || return 1
  version="${version#v}"
  major="${version%%.*}"
  rest="${version#*.}"
  minor="${rest%%.*}"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) return 1 ;; esac
  if [ "$major" -gt "$NODE_MIN_MAJOR" ] && [ "$major" -lt "$NODE_MAX_MAJOR" ]; then return 0; fi
  [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]
}

# 先用系统的 Node；没有、或版本不在范围内时，退到安装器（install/install-workbench.sh）放在
# ~/.cluster-workbench/node 的私有 Node——它不进 PATH，只有这里会用到。
PRIVATE_NODE="${HOME:-}/.cluster-workbench/node/bin/node"
if command -v node >/dev/null 2>&1 && node_supported node; then
  NODE_BIN="node"
elif [ -x "$PRIVATE_NODE" ] && node_supported "$PRIVATE_NODE"; then
  NODE_BIN="$PRIVATE_NODE"
elif command -v node >/dev/null 2>&1; then
  # 系统 Node 版本不合适、也没有私有 Node：照旧交给 launch.mjs 报出版本要求，这里只补一句出路。
  echo "ℹ 系统的 Node.js 版本不在支持范围内。可以运行安装器 install/install-workbench.sh：它会装一份只给工作台用的 Node.js，不改系统环境。"
  NODE_BIN="node"
else
  echo "✘ 未检测到 Node.js（需要 v22.12+，推荐 24），请先安装后重试。"
  echo "  也可以运行安装器 install/install-workbench.sh：它会装一份只给工作台用的 Node.js，不改系统环境。"
  exit 1
fi
if [ ! -d "node_modules" ] && [ "$(uname -s)" = "Darwin" ]; then
  echo "ℹ 未安装依赖：本次以网页模式启动。需要 macOS 桌面窗口时先运行 npm install。"
fi
exec "$NODE_BIN" scripts/launch.mjs "$@"
