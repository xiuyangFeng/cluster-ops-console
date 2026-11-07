#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==========================================="
echo "  集群运维工作台 (Codex Operations Console) 配置向导"
echo "==========================================="
echo

# 1. 检测 Node.js 是否安装
if ! command -v node &> /dev/null; then
  echo "✘ 未检测到 Node.js，本系统依赖 Node.js 环境运行。"
  echo "请根据您的系统安装 Node.js (需要 v22.12+，推荐 24):"
  echo "  - macOS: brew install node"
  echo "  - Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y nodejs npm"
  echo "  - CentOS/RHEL: sudo dnf install -y nodejs"
  echo
  exit 1
fi

# 1b. 版本闸门与 scripts/launch.mjs / 向导共用 isNodeVersionSupported()
if ! node --input-type=module -e "import { isNodeVersionSupported, nodeVersionHint } from './work/monitor/lib/platform.mjs'; if (!isNodeVersionSupported(process.version)) { console.error('✘ 当前 Node.js ' + process.version + ' 不受支持。'); console.error('  ' + nodeVersionHint()); process.exit(1); }"; then
  exit 1
fi

# 2. 检测 npm 是否安装
if ! command -v npm &> /dev/null; then
  echo "✘ 未检测到 npm 包管理器。"
  echo "请安装 npm 后重试。"
  echo
  exit 1
fi

echo "✔ 环境检测通过：Node.js ($(node -v)) 与 npm ($(npm -v)) 已就绪。"
echo "正在拉起交互式配置引导向导，请稍候..."
echo

node scripts/setup-wizard.mjs
