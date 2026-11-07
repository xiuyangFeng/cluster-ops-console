#!/usr/bin/env bash
# 本机打 macOS 安装包：dist/macos/ 下的 .dmg（打开后把 App 拖进「应用程序」）与 .zip，各附 .sha256。
# 与发布流水线（.github/workflows/release.yml 的 release job）同一套步骤：构建 → 验签 → 隔离冒烟 → 打包。
# 构建走 build-macos-app.sh --output（旁路位置）：不碰仓库根的现役 .app，桌面开着也能打。
#
# 用法：npm run package:mac
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Codex Operations Console"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
OUT_DIR="$ROOT_DIR/dist/macos"
APP="$OUT_DIR/${APP_NAME}.app"
BASE="CodexOperationsConsole-${VERSION}-macos"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "只能在 macOS 上打 .app / .dmg（Windows 安装包用 npm run package:windows）" >&2
  exit 2
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
bash "$ROOT_DIR/scripts/build-macos-app.sh" --output "$APP"
codesign --verify --deep --strict "$APP"
node "$ROOT_DIR/scripts/hot-update/smoke.mjs" "$APP" --timeout-ms 90000
node "$ROOT_DIR/scripts/release-scan.mjs" --artifact-dir "$APP/Contents/Resources/app"

cd "$OUT_DIR"
ditto -c -k --keepParent "${APP_NAME}.app" "${BASE}.zip"
DMG_STAGE="$(mktemp -d)"
trap 'rm -rf "$DMG_STAGE"' EXIT
ditto "${APP_NAME}.app" "$DMG_STAGE/${APP_NAME}.app"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$DMG_STAGE" -ov -format UDZO "${BASE}.dmg"
shasum -a 256 "${BASE}.zip" > "${BASE}.zip.sha256"
shasum -a 256 "${BASE}.dmg" > "${BASE}.dmg.sha256"

echo "✓ 完成："
echo "  $OUT_DIR/${BASE}.dmg"
echo "  $OUT_DIR/${BASE}.zip"
