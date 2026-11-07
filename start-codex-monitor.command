#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==========================================="
echo "  集群运维工作台 (Codex Operations Console) — 网页版"
echo "==========================================="
echo

exec node scripts/launch.mjs --web
