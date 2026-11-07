#!/usr/bin/env bash
set -euo pipefail

# 构建 macOS .app：从 Electron 运行时拷壳 -> 注入源码 -> 版本化 Info.plist ->
# 生成 build-info.json -> node --check 冒烟 -> 输出校验和。
# 旧包在构建前 ditto 备份到 dist/backup/<version>-<时间戳>/（仅保留最近 2 份）。
#
# 用法:
#   scripts/build-macos-app.sh                       # 实构建
#   scripts/build-macos-app.sh --dry-run             # 仅打印计划动作，跳过 ditto/rsync 等重操作
#   scripts/build-macos-app.sh --rollback            # 列出 dist/backup/ 候选并冷回滚到最近一份（桌面须已退出；
#                                                    # 桌面在跑时用 npm run app:update -- --rollback 热回滚）
#   scripts/build-macos-app.sh --rollback 2.0.0-20260702083503  # 回滚到指定备份
#   scripts/build-macos-app.sh --rollback --dry-run  # 仅打印回滚计划动作，不改文件系统
#   scripts/build-macos-app.sh --validate-bundle PATH # 仅校验指定 staging 资源目录
#   scripts/build-macos-app.sh --output "dist/staging/<id>/Codex Operations Console.app"
#                                                    # 构建到旁路 staging 位置（热更新用）：不拒绝运行中的
#                                                    # 桌面、不备份/修剪，绝不碰现役 .app

DRY_RUN=0
ROLLBACK=0
ROLLBACK_TARGET=""
VALIDATE_BUNDLE_PATH=""
EXPECT_VALIDATE_BUNDLE_PATH=0
OUTPUT_APP_DIR=""
EXPECT_OUTPUT=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --rollback) ROLLBACK=1 ;;
    --validate-bundle) EXPECT_VALIDATE_BUNDLE_PATH=1 ;;
    --output) EXPECT_OUTPUT=1 ;;
    --*) echo "Unknown argument: $arg" >&2; exit 2 ;;
    *)
      if [ "$EXPECT_OUTPUT" = 1 ]; then
        OUTPUT_APP_DIR="$arg"; EXPECT_OUTPUT=0
      elif [ "$EXPECT_VALIDATE_BUNDLE_PATH" = 1 ]; then
        VALIDATE_BUNDLE_PATH="$arg"
        EXPECT_VALIDATE_BUNDLE_PATH=0
      elif [ -n "$VALIDATE_BUNDLE_PATH" ]; then
        echo "Unexpected extra argument: $arg" >&2; exit 2
      elif [ -n "$ROLLBACK_TARGET" ]; then
        echo "Unexpected extra argument: $arg" >&2; exit 2
      else
        ROLLBACK_TARGET="$arg"
      fi
      ;;
  esac
done
if [ "$EXPECT_VALIDATE_BUNDLE_PATH" = 1 ]; then
  echo "--validate-bundle requires a path" >&2
  exit 2
fi
if [ "$EXPECT_OUTPUT" = 1 ]; then echo "--output requires a path ending in .app" >&2; exit 2; fi
if [ -n "$OUTPUT_APP_DIR" ] && [ "$ROLLBACK" = 1 ]; then echo "--output cannot be combined with --rollback" >&2; exit 2; fi
if [ -n "$ROLLBACK_TARGET" ] && [ "$ROLLBACK" = 0 ]; then
  echo "A backup id was given without --rollback: $ROLLBACK_TARGET" >&2
  exit 2
fi
# 备份 id 只能是 dist/backup/ 下的一级目录名（与 hot-update 的 isSafeBackupId 同一字符集），防 ../ 越界。
case "$ROLLBACK_TARGET" in
  .|..|*[!A-Za-z0-9._-]*) echo "Invalid backup id: $ROLLBACK_TARGET" >&2; exit 2 ;;
esac

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Codex Operations Console"
LIVE_APP_DIR="$ROOT_DIR/${APP_NAME}.app"
APP_DIR="$LIVE_APP_DIR"
# STAGING_BUILD=1：--output 指向现役 .app 以外的位置。整条构建只写 staging 目录，
# 运行中的桌面/后台进程与现役 .app 完全不受影响（换包由 scripts/hot-update.mjs 原子 rename 完成）。
STAGING_BUILD=0
if [ -n "$OUTPUT_APP_DIR" ]; then
  case "$OUTPUT_APP_DIR" in
    *.app) ;;
    *) echo "--output must end in .app: $OUTPUT_APP_DIR" >&2; exit 2 ;;
  esac
  case "$OUTPUT_APP_DIR" in
    /*) ;;
    *) OUTPUT_APP_DIR="$PWD/$OUTPUT_APP_DIR" ;;
  esac
  OUTPUT_PARENT="$(dirname -- "$OUTPUT_APP_DIR")"
  if [ -d "$OUTPUT_PARENT" ]; then
    OUTPUT_APP_DIR="$(cd -- "$OUTPUT_PARENT" && pwd -P)/$(basename -- "$OUTPUT_APP_DIR")"
  fi
  LIVE_APP_REAL="$(cd -- "$ROOT_DIR" && pwd -P)/${APP_NAME}.app"
  if [ "$OUTPUT_APP_DIR" != "$LIVE_APP_DIR" ] && [ "$OUTPUT_APP_DIR" != "$LIVE_APP_REAL" ]; then
    STAGING_BUILD=1
    APP_DIR="$OUTPUT_APP_DIR"
  fi
fi
ELECTRON_APP="$ROOT_DIR/node_modules/electron/dist/Electron.app"
APP_RESOURCES="$APP_DIR/Contents/Resources/app"
DIST_DIR="$ROOT_DIR/dist"
BACKUP_ROOT="$DIST_DIR/backup"
MAX_APP_SIZE_MB="${MAX_APP_SIZE_MB:-350}"
case "$MAX_APP_SIZE_MB" in
  ''|*[!0-9]*)
    echo "MAX_APP_SIZE_MB must be a positive integer" >&2
    exit 2
    ;;
esac
if [ "$MAX_APP_SIZE_MB" -le 0 ]; then
  echo "MAX_APP_SIZE_MB must be a positive integer" >&2
  exit 2
fi
# 350 MB 是不可上调的硬上限；环境变量只允许选择更严格的下限。
if [ "$MAX_APP_SIZE_MB" -gt 350 ]; then
  MAX_APP_SIZE_MB=350
fi

VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
GIT_COMMIT="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date +%Y%m%d%H%M%S)"

# 仅保留最近 2 份备份，其余删除（按 mtime 倒序，第 3 份起为旧备份）。
# 构建与回滚两条路径共用同一 keep-2 修剪逻辑。
# 热更新换包后，旧 supervisor/proxy 可能仍在执行某份备份里的二进制（同卷 rename 不改 inode），
# 删掉它就等于删掉正在运行的数据面。与 scripts/hot-update/bundle.mjs 的 pruneBackups 同一判定：
# lsof 列出 "Codex" 开头进程的 txt 映射，命中某份备份目录（或其真实路径）就保留它；
# lsof 查询失败则整次不修剪（宁可多留不可误删）。
prune_backups() {
  local busy="" lsof_code=0 old dir real line in_use
  busy="$(lsof -a -d txt -c Codex -Fn 2>/dev/null)" || lsof_code=$?
  if [ "$lsof_code" != 0 ] && { [ "$lsof_code" != 1 ] || [ -n "$busy" ]; }; then
    echo "WARNING: lsof query failed (exit=$lsof_code); skipping backup pruning so no running binary is deleted." >&2
    return 0
  fi
  ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | tail -n +3 | while IFS= read -r old; do
    dir="${old%/}"
    real="$(cd -- "$dir" && pwd -P)" || real="$dir"
    in_use=0
    while IFS= read -r line; do
      [ "${line#n}" != "$line" ] || continue
      case "${line#n}" in
        "$dir"|"$dir"/*|"$real"|"$real"/*) in_use=1 ;;
      esac
    done <<< "$busy"
    if [ "$in_use" = 1 ]; then
      echo "Keeping backup still in use by a running process: $old"
      continue
    fi
    echo "Pruning old backup: $old"
    rm -rf "$old"
  done
}

# 校验应用资源目录的运行时白名单。参数化路径便于对临时 staging 目录复用，
# 不需要为了检查路径规则而修改真实 .app。
validate_app_bundle() {
  local app_resources="$1"
  local required

  # Required: electron-main.mjs
  # Required: preload.js
  # Required: package.json
  # Required: config.json
  # Required: work/monitor/monitor-server.mjs
  # Required: work/monitor/remote/collect.sh
  # Required: work/monitor/remote/usage-scan.py
  # Required: work/local_http_connect_proxy.mjs
  for required in \
    "electron-main.mjs" \
    "preload.js" \
    "package.json" \
    "config.json" \
    "work/monitor/monitor-server.mjs" \
    "work/monitor/remote/collect.sh" \
    "work/monitor/remote/usage-scan.py" \
    "work/local_http_connect_proxy.mjs"; do
    if [ ! -f "$app_resources/$required" ]; then
      echo "Required bundle path missing: $required" >&2
      return 1
    fi
  done

  # Forbidden: work/codex-cli-offline-build
  # Forbidden: work/runtime
  # Forbidden: work/monitor/runtime
  for forbidden in \
    "$app_resources/work/codex-cli-offline-build" \
    "$app_resources/work/runtime" \
    "$app_resources/work/monitor/runtime"; do
    if [ -e "$forbidden" ]; then
      echo "Forbidden bundle path found: ${forbidden#"$app_resources/"}" >&2
      return 1
    fi
  done

  # Forbidden: *.test.mjs
  # Forbidden: *.log
  # Forbidden: *.pid
  local forbidden_file
  forbidden_file="$(find "$app_resources" -type f \( \
    -name '*.test.mjs' -o -name '*.log' -o -name '*.pid' \
  \) -print -quit)"
  if [ -n "$forbidden_file" ]; then
    echo "Forbidden bundle path found: ${forbidden_file#"$app_resources/"}" >&2
    return 1
  fi
}

if [ -n "$VALIDATE_BUNDLE_PATH" ]; then
  validate_app_bundle "$VALIDATE_BUNDLE_PATH"
  echo "Bundle path validation passed: $VALIDATE_BUNDLE_PATH"
  exit 0
fi

# --rollback：把 dist/backup/ 中的某份备份恢复为现役 .app（冷回滚：要求桌面未在运行）。
# 与 scripts/hot-update/bundle.mjs 的 swapIn 同一套"先旁路、再 rename"的原子替换：
#   1) ditto 备份 → dist/staging/rollback-<时间戳>/（旁路；失败只清 staging，现役 .app 不动）；
#   2) rename 现役 .app → dist/backup/<当前版本>-<时间戳>（这就是安全备份，省一次整包拷贝）；
#   3) rename staged → 现役路径；失败立刻把第 2 步换回去，现役位置绝不出现空窗。
# 旧实现是"先 rm -rf 现役 .app 再 ditto"，且早于失败恢复 trap 与运行中桌面保护：ditto 中途失败
# （磁盘满 / 权限 / 被拔盘）会让现役 .app 直接消失（评审 #8，隔离故障注入已复现）。
# 桌面在跑、又不想断隧道时，用 `npm run app:update -- --rollback [id]`：同样的原子换包 + 控制面热重启。
do_rollback() {
  echo "Rollback mode dry_run=$DRY_RUN target=${ROLLBACK_TARGET:-<latest>}"

  # 无备份目录或目录为空 -> 报错退出（dry-run 亦然）。sed -n '1p' 读尽输入，pipefail 安全。
  # 末尾 || true：无匹配时 glob 让 ls 非零退出，避免 set -e 在赋值处提前终止而吞掉报错。
  local first
  first="$(ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | sed -n '1p')" || true
  if [ -z "$first" ]; then
    echo "No backups found under $BACKUP_ROOT" >&2
    exit 1
  fi

  echo "Available backups (newest first):"
  ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null | while IFS= read -r d; do
    echo "  - $(basename "$d")"
  done

  # 解析回滚目标：显式指定则校验存在，否则取最近一份。
  local target_dir
  if [ -n "$ROLLBACK_TARGET" ]; then
    target_dir="$BACKUP_ROOT/$ROLLBACK_TARGET"
    if [ ! -d "$target_dir" ]; then
      echo "Backup not found: $ROLLBACK_TARGET (looked in $BACKUP_ROOT)" >&2
      exit 1
    fi
  else
    target_dir="${first%/}"
  fi
  echo "Selected backup: $(basename "$target_dir")"

  local safety_dir="$BACKUP_ROOT/${VERSION}-${STAMP}"
  local suffix=1
  while [ -e "$safety_dir" ]; do safety_dir="$BACKUP_ROOT/${VERSION}-${STAMP}-${suffix}"; suffix=$((suffix + 1)); done
  local staging_root="$DIST_DIR/staging/rollback-${STAMP}"
  local staged_app="$staging_root/${APP_NAME}.app"
  local restored_info="$target_dir/Contents/Resources/app/build-info.json"

  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] Would refuse if the packaged desktop is running (use npm run app:update -- --rollback for a hot rollback)"
    echo "[dry-run] Would ditto $target_dir -> $staged_app (staging; live app untouched)"
    if [ -d "$APP_DIR" ]; then
      echo "[dry-run] Would rename current app -> $safety_dir (safety backup), then rename the staged app -> $APP_DIR (restore; renamed back on failure)"
    else
      echo "[dry-run] No current app at $APP_DIR to safety-backup; would rename the staged app -> $APP_DIR"
    fi
    echo "[dry-run] Would prune backups keeping the newest 2"
    if [ -f "$restored_info" ]; then
      echo "[dry-run] Restored build-info.json would be:"
      cat "$restored_info"
    else
      echo "[dry-run] (selected backup has no build-info.json)"
    fi
    echo "[dry-run] Would prompt: restart '$APP_NAME' to load the rolled-back build."
    echo "[dry-run] Done (no filesystem changes)."
    exit 0
  fi

  # 运行中桌面保护（与实构建同一判定）：rename 不改 inode，在跑的桌面会继续从安全备份目录执行旧代码，
  # 却以为自己就是现役包；冷回滚要求先退出，否则改走热回滚。
  local running_pids
  running_pids="$(pgrep -f "$APP_DIR/Contents/MacOS/$APP_NAME" || true)"
  if [ -n "$running_pids" ]; then
    echo "Packaged desktop is still running (PID(s): $(echo "$running_pids" | tr '\n' ' '))." >&2
    echo "Quit it first, or roll back without dropping tunnels: npm run app:update -- --rollback $(basename "$target_dir")" >&2
    exit 1
  fi

  # 1) 旁路 staging：失败只清 staging，现役 .app 一个字节都没动。
  echo "Staging $(basename "$target_dir") -> $staged_app"
  rm -rf "$staging_root"
  mkdir -p "$staging_root"
  if ! ditto "$target_dir" "$staged_app"; then
    rm -rf "$staging_root"
    echo "Rollback aborted: copying the backup into staging failed; the live app was not touched." >&2
    exit 1
  fi
  touch "$staged_app"

  # 2) + 3) 原子替换。两次 rename 之间只有 echo/touch（都不会让 set -e 中途退出）。
  local had_live=0
  if [ -d "$APP_DIR" ]; then
    mkdir -p "$BACKUP_ROOT"
    if ! mv "$APP_DIR" "$safety_dir"; then
      rm -rf "$staging_root"
      echo "Rollback aborted: could not move the current app aside; the live app was not touched." >&2
      exit 1
    fi
    had_live=1
    # rename 保留原 mtime：touch 一下让安全备份按 mtime 排最新，不被随后的 keep-2 修剪掉。
    touch "$safety_dir" 2>/dev/null || true
    echo "Safety backup of current app -> $safety_dir"
  else
    echo "No current app at $APP_DIR; skipping safety backup."
  fi
  echo "Restoring $(basename "$target_dir") -> $APP_DIR"
  if ! mv "$staged_app" "$APP_DIR"; then
    if [ "$had_live" = 1 ]; then
      if mv "$safety_dir" "$APP_DIR"; then
        echo "Rollback failed: could not move the restored app into place; the previous app is back at $APP_DIR." >&2
      else
        echo "Rollback failed and putting the previous app back also failed. It is intact at ${safety_dir}; restore it manually:" >&2
        echo "  mv \"$safety_dir\" \"$APP_DIR\"" >&2
      fi
    else
      echo "Rollback failed: could not move the restored app into place (there was no previous app)." >&2
    fi
    rm -rf "$staging_root"
    exit 1
  fi
  rmdir "$staging_root" 2>/dev/null || true
  touch "$APP_DIR"

  # 先恢复再修剪：即使 keep-2 修剪掉了这份备份，app 也已落地。
  prune_backups

  local build_info="$APP_DIR/Contents/Resources/app/build-info.json"
  if [ -f "$build_info" ]; then
    echo "Rolled back to build-info.json:"
    cat "$build_info"
  else
    echo "Warning: no build-info.json found in restored app." >&2
  fi

  echo "Rollback complete. Please restart '$APP_NAME' to load the restored build."
  exit 0
}

if [ "$ROLLBACK" = 1 ]; then
  do_rollback
fi

# ---------------------------------------------------------------------------
# 失败回滚：本脚本是"先删现役 .app、再装新包"的破坏性序列（旧包已 ditto 到 $BACKUP_DIR）。
# set -e 下任何一步失败都会立即退出，而 $APP_DIR 此时要么不存在、要么是半成品——用户原本
# 能用的桌面应用就没了，而备份躺在 dist/backup 里不会自动恢复。最容易踩到的是第 4~7 步：
# 新增文件混进包触发白名单校验失败、体积超过 MAX_APP_SIZE_MB、或 node --check 失败。
# 因此注册 EXIT trap：只在"确已替换现役 app"且"成品尚未标记完成"时把备份换回去，
# 并刻意保留原始退出码（trap 内 return 而不 exit，已用最小脚本验证 bash 语义）。
# ---------------------------------------------------------------------------
BUILD_COMMITTED=0    # 新包已校验通过且签名完成
LIVE_APP_REPLACED=0  # 已 rm -rf 掉现役 .app
RESTORE_DIR=""       # 从哪个备份恢复

restore_on_failure() {
  local code=$?
  if [ "$code" -eq 0 ] || [ "$BUILD_COMMITTED" = 1 ] || [ "$LIVE_APP_REPLACED" != 1 ]; then
    return 0
  fi
  if [ "$STAGING_BUILD" = 1 ]; then
    echo "Staging build failed (exit=$code); the live app was never touched. Partial output left at $APP_DIR" >&2
    return 0
  fi
  echo "" >&2
  # 变量后紧跟全角标点时必须用 ${...}：bash 会把多字节字符的字节并进变量名，set -u 下直接报 unbound variable。
  echo "构建失败（exit=${code}）：现役应用已被替换，正在把备份换回 $APP_DIR" >&2
  if [ -n "$RESTORE_DIR" ] && [ -d "$RESTORE_DIR" ]; then
    rm -rf "$APP_DIR" || true
    if ditto "$RESTORE_DIR" "$APP_DIR"; then
      echo "已从 $RESTORE_DIR 恢复原有应用（版本是旧的，但可用）。" >&2
    else
      echo "恢复失败！原应用仍完整保存在 ${RESTORE_DIR}，请手工执行：" >&2
      echo "  rm -rf \"$APP_DIR\" && ditto \"$RESTORE_DIR\" \"$APP_DIR\"" >&2
    fi
  else
    echo "构建前没有可回滚的已安装应用；$APP_DIR 当前缺失或为半成品。" >&2
  fi
  return 0
}
trap restore_on_failure EXIT

# A running copy may keep writing mutable data through its old appRoot after the
# bundle is replaced. Refuse a real rebuild until maintainers stop that stale
# desktop process; otherwise work/runtime can be recreated after validation.
if [ "$DRY_RUN" = 0 ] && [ "$STAGING_BUILD" = 0 ]; then
  RUNNING_DESKTOP_PIDS="$(pgrep -f "$APP_DIR/Contents/MacOS/$APP_NAME" || true)"
  if [ -n "$RUNNING_DESKTOP_PIDS" ]; then
    echo "Packaged desktop is still running (PID(s): $(echo "$RUNNING_DESKTOP_PIDS" | tr '\n' ' '))." >&2
    echo "Stop the stale desktop process before rebuild, then rerun this script." >&2
    exit 1
  fi
fi

echo "Building '$APP_NAME' version=$VERSION commit=$GIT_COMMIT dry_run=$DRY_RUN"
if [ "$STAGING_BUILD" = 1 ]; then
  echo "Staging build -> $APP_DIR (live app is never touched; no running-desktop refusal, no backup/prune)"
fi

if [ "$DRY_RUN" = 0 ] && [ ! -d "$ELECTRON_APP" ]; then
  echo "Electron runtime not found at $ELECTRON_APP" >&2
  exit 1
fi

# 1) 构建前备份已存在的旧 .app（staging 构建跳过：现役 .app 不动，备份在热更新换包时产生）
if [ "$STAGING_BUILD" = 1 ]; then
  echo "Staging build: skipping backup/prune of the live app."
  if [ "$DRY_RUN" = 0 ]; then
    mkdir -p "$(dirname -- "$APP_DIR")"
  fi
elif [ -d "$APP_DIR" ]; then
  BACKUP_DIR="$BACKUP_ROOT/${VERSION}-${STAMP}"
  echo "Backing up existing app -> $BACKUP_DIR"
  if [ "$DRY_RUN" = 0 ]; then
    mkdir -p "$BACKUP_ROOT"
    ditto "$APP_DIR" "$BACKUP_DIR"
    # 备份成功后才登记为回滚源：ditto 中途失败时 $BACKUP_DIR 是半截的，
    # 拿它去恢复只会把半截包换到现役位置。
    RESTORE_DIR="$BACKUP_DIR"
    prune_backups
  fi
else
  echo "No existing app to back up."
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] Would ditto Electron.app -> $APP_DIR and rename MacOS/Electron -> MacOS/$APP_NAME"
  echo "[dry-run] Would copy only electron-main.mjs, preload.js, package.json, config.json, work/monitor/, and work/local_http_connect_proxy.mjs into $APP_RESOURCES"
  echo "[dry-run] Would validate required/forbidden bundle paths and enforce MAX_APP_SIZE_MB=$MAX_APP_SIZE_MB using du -sm"
  echo "[dry-run] Would replace Contents/Resources/electron.icns with scripts/assets/app-icon.icns"
  echo "[dry-run] Would rewrite Info.plist (CFBundleShortVersionString/CFBundleVersion = $VERSION)"
  echo "[dry-run] Would write $APP_RESOURCES/build-info.json {version,gitCommit,builtAt,components}"
  echo "[dry-run] Would node --check electron-main.mjs and work/monitor/monitor-server.mjs"
  echo "[dry-run] Would emit $DIST_DIR/checksums-${VERSION}.txt"
  echo "[dry-run] Done (no filesystem changes beyond backup skipped)."
  exit 0
fi

# 2) 从 Electron 运行时拷出应用外壳
LIVE_APP_REPLACED=1
rm -rf "$APP_DIR"
ditto "$ELECTRON_APP" "$APP_DIR"
mv "$APP_DIR/Contents/MacOS/Electron" "$APP_DIR/Contents/MacOS/$APP_NAME"
# 应用图标：替换 Electron 默认图标（Info.plist 的 CFBundleIconFile 仍指向 electron.icns，只换内容）。
# 母版 scripts/assets/app-icon.svg，改后用 `npx electron scripts/build-app-icon.mjs` 重新生成。
cp "$ROOT_DIR/scripts/assets/app-icon.icns" "$APP_DIR/Contents/Resources/electron.icns"

# 3) 仅注入运行所需白名单；monitor 内继续排除测试、运行状态、日志与 PID。
rm -rf "$APP_RESOURCES"
mkdir -p "$APP_RESOURCES"
rsync -a \
  "$ROOT_DIR/electron-main.mjs" \
  "$ROOT_DIR/preload.js" \
  "$ROOT_DIR/package.json" \
  "$ROOT_DIR/config.json" \
  "$APP_RESOURCES/"
mkdir -p "$APP_RESOURCES/work/monitor"
rsync -a \
  --exclude ".DS_Store" \
  --exclude ".codex-operations-console.log" \
  --exclude ".codex-operations-console.pid" \
  --exclude "*.log" \
  --exclude "*.pid" \
  --exclude "*.test.mjs" \
  --exclude "runtime/" \
  "$ROOT_DIR/work/monitor/" \
  "$APP_RESOURCES/work/monitor/"
rsync -a \
  "$ROOT_DIR/work/local_http_connect_proxy.mjs" \
  "$APP_RESOURCES/work/"

# 4) 版本化 Info.plist
PLIST="$APP_DIR/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string "$APP_NAME" "$PLIST"
plutil -replace CFBundleExecutable -string "$APP_NAME" "$PLIST"
plutil -replace CFBundleName -string "$APP_NAME" "$PLIST"
plutil -replace CFBundleIdentifier -string "com.xiuyang.codex-operations-console" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$VERSION" "$PLIST"
plutil -replace LSApplicationCategoryType -string "public.app-category.developer-tools" "$PLIST"
plutil -replace NSHumanReadableCopyright -string "Local operations console" "$PLIST"

# 5) 构建元信息。components = 数据面组件指纹（supervisor/proxy），按 staged 资源目录计算；
#    热更新据此判断运行中的 supervisor/proxy 是否需要平滑交接。计算失败写空串（= 未知，
#    调用方保守地视为需要交接）。
COMPONENTS_JSON="$(cd "$ROOT_DIR" && COMPONENTS_APP_ROOT="$APP_RESOURCES" node --input-type=module -e '
  import { computeComponentHashes } from "./work/monitor/lib/component-version.mjs";
  process.stdout.write(JSON.stringify(await computeComponentHashes(process.env.COMPONENTS_APP_ROOT)));
' 2>/dev/null)" || COMPONENTS_JSON=""
if [ -z "$COMPONENTS_JSON" ]; then
  echo "WARNING: failed to compute component hashes; writing empty (unknown) fingerprints." >&2
  COMPONENTS_JSON='{"supervisor":"","proxy":""}'
fi
cat > "$APP_RESOURCES/build-info.json" <<EOF
{
  "version": "$VERSION",
  "gitCommit": "$GIT_COMMIT",
  "builtAt": "$BUILT_AT",
  "components": $COMPONENTS_JSON
}
EOF

# 6) 白名单与应用表观体积门禁。
validate_app_bundle "$APP_RESOURCES"
APP_SIZE_MB="$(du -sm "$APP_DIR" | awk '{print $1}')"
if [ "$APP_SIZE_MB" -gt "$MAX_APP_SIZE_MB" ]; then
  echo "App size ${APP_SIZE_MB} MB exceeds MAX_APP_SIZE_MB=${MAX_APP_SIZE_MB}" >&2
  exit 1
fi
echo "Bundle validation passed (${APP_SIZE_MB} MB <= ${MAX_APP_SIZE_MB} MB)."

# 7) 冒烟：语法校验 app 内两个入口（.mjs 由扩展名走 ESM 解析，--check 不解析 import）
node --check "$APP_RESOURCES/electron-main.mjs"
node --check "$APP_RESOURCES/work/monitor/monitor-server.mjs"
echo "Smoke check passed for entry files."

# 7.5) ad-hoc 代码签名：重打包（ditto 原壳 + 改名主二进制 + rsync 注入源码）会破坏 Electron
#      原签名的封装（_CodeSignature 失配/缺失）。Apple Silicon 强制要求有效签名，否则
#      Gatekeeper/XProtect 会把"签名无效/已吊销"的代码判为已损坏/恶意软件并拒绝执行甚至移入废纸篓。
#      这里对成品整体重签为本地 ad-hoc 签名（覆盖内部 Electron Framework/Helpers）。
#      注意：ad-hoc ≠ Apple 公证；从 Finder 双击首启若仍被拦，需在"系统设置>隐私与安全性"手动放行，
#      或改用 start-codex-desktop.command 开发模式启动。无 Developer ID 账号时这是最优解。
if [ "$DRY_RUN" = 0 ]; then
  xattr -cr "$APP_DIR" 2>/dev/null || true
  codesign --force --deep --sign - --timestamp=none "$APP_DIR"
  # 验签失败必须让构建失败（非 0 退出、不标记 BUILD_COMMITTED）：签名无效的包在 Apple Silicon 上
  # 根本起不来，只打警告会让 CI / 手工构建把坏包当成功交付。失败时 EXIT trap 照常把备份换回现役位置
  # （旁路 staging 构建则只报告，现役 .app 从未被动过）。
  if ! VERIFY_ERR="$(codesign --verify --deep --strict "$APP_DIR" 2>&1)"; then
    echo "ERROR: ad-hoc code signature verification failed; refusing to mark this build as successful." >&2
    [ -z "$VERIFY_ERR" ] || printf '%s\n' "$VERIFY_ERR" >&2
    exit 1
  fi
  echo "Ad-hoc code signature applied and verified."
else
  echo "[dry-run] Would xattr -cr and codesign --force --deep --sign - \$APP_DIR"
fi

# 到这里 $APP_DIR 已是"白名单校验通过 + node --check 通过 + 已重签且验签通过"的成品，可以认为替换成功。
# 之后只剩校验和这类旁路产物：它们失败不该触发回滚——那会把一个好应用换成旧版本。
BUILD_COMMITTED=1

# 8) 校验和：build-info 与 app 内所有 .mjs/.js 运行文件的 SHA-256
mkdir -p "$DIST_DIR"
CHECKSUMS="$DIST_DIR/checksums-${VERSION}.txt"
( cd "$APP_RESOURCES" && { printf './build-info.json\0'; find . \( -name '*.mjs' -o -name '*.js' \) -type f -print0; } \
    | sort -zu | xargs -0 shasum -a 256 ) > "$CHECKSUMS"
echo "Wrote $(wc -l < "$CHECKSUMS" | tr -d ' ') checksums to $CHECKSUMS"

touch "$APP_DIR"
echo "Built $APP_DIR (v$VERSION, commit $GIT_COMMIT)"
