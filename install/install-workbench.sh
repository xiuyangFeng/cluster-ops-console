#!/usr/bin/env bash
# 集群运维工作台 · 一步安装器（macOS / Linux）
#
# 用法：把本文件存到「下载」文件夹，打开「终端」，粘贴下面这一行后回车：
#   bash ~/Downloads/install-workbench.sh
#
# 它做的事（可以重复运行，每一步都先看现状再动手）：
#   1. 定安装位置：默认 ~/cluster-workbench。已经装过就只更新；目录里是别的东西就停下，不删任何文件。
#   2. 检查 SSH 客户端与 git（macOS 没有 git 时请系统弹出「命令行开发者工具」的安装窗口）。
#   3. 准备 Node.js：系统里有合格的就用系统的；没有就把官方预编译包下载到 ~/.cluster-workbench/node，
#      先核对 SHA-256 再解压。不需要管理员权限，不改系统的 Node 和 PATH。
#   4. git clone 工作台。必须是真正的 clone：之后的自动更新靠 git pull。
#      远端有稳定版分支（stable）时，新装的这一份跟稳定版；没有就留在默认分支。
#   5. macOS 在桌面放一个启动图标，然后启动工作台（浏览器自动打开）。
#   不执行 npm install——网页模式不需要任何依赖。
#
# 环境变量：
#   CWB_INSTALL_DIR          安装目录（默认 ~/cluster-workbench）
#   CWB_REPO_URL             仓库地址（默认见 DEFAULT_REPO_URL；https / ssh / 本地路径都可以）
#   CWB_INSTALL_NO_LAUNCH=1  装完不启动
#   CWB_DESKTOP_DIR          桌面目录（默认 ~/Desktop）
#   CWB_NODE_DIST_BASE / CWB_NODE_DIST_MIRROR / CWB_NODE_SHA256
#                            Node 的下载源与期望校验值。只给测试和维护者换版本验证用，平时不要设。
#
# 整个流程包在 main() 里、最后一行才调用：文件没传完整时 bash 会报语法错，而不是执行到一半。

# 被 sh / dash 调起时换成 bash 再来（下面用了 bash 的语法；要兼容 macOS 自带的 bash 3.2）。
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -euo pipefail

DEFAULT_REPO_URL="https://github.com/xiuyangFeng/cluster-ops-console.git"
# 稳定版分支：发布方确认过一个版本才推进它。远端有这条分支时，新装的这一份跟它（见 use_stable_branch）。
# 名字与 work/monitor/lib/self-update/channel.mjs、install-workbench.cmd 里的一致。
STABLE_BRANCH="stable"
# 仓库 package.json 的 name：用它认出「这个目录是工作台」，与仓库地址无关（地址以后可能会换）。
PACKAGE_NAME="codex-tunnel-monitor"
LAUNCHER_NAME="集群运维工作台.command"
# 桌面启动图标里的标记行：只有带这一行的文件才是本安装器放的，才允许改写。
LAUNCHER_MARKER="cluster-workbench-installer: managed launcher"

# 私有 Node 的版本与校验值。校验值逐条抄自 https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
# （https://npmmirror.com/mirrors/node/v24.21.0/SHASUMS256.txt 与它逐字节一致）。
# 换版本时这里和 install-workbench.cmd 一起改。
NODE_VERSION="24.21.0"
node_sha256() {
  case "$1" in
    darwin-arm64) echo "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057" ;;
    darwin-x64)   echo "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097" ;;
    linux-x64)    echo "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff" ;;
    linux-arm64)  echo "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5" ;;
    *)            echo "" ;;
  esac
}

# Node 版本闸门：与 package.json engines（>=22.12.0 <27）、start.sh、start-console.cmd 一致。
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=12
NODE_MAX_MAJOR=27

STEP_NO=0
STEP_TOTAL=6
WORK_TMP=""      # 放 git 日志、待写入的启动图标
NODE_STAGE=""    # 私有 Node 的下载与解压暂存目录（与目标同盘，换入时只是改名）
NODE_KIND=""     # system | private
OS_NAME="$(uname -s)"

# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
ok()   { printf '  ✔ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }
step() { STEP_NO=$((STEP_NO + 1)); printf '\n[%d/%d] %s\n' "$STEP_NO" "$STEP_TOTAL" "$1"; }

# die "现象" "下一步"...：第一行是出了什么事，其余每行是该怎么办。
die() {
  local line
  printf '\n✘ %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

cleanup() {
  if [ -n "$NODE_STAGE" ] && [ -d "$NODE_STAGE" ]; then rm -rf "$NODE_STAGE"; fi
  if [ -n "$WORK_TMP" ] && [ -d "$WORK_TMP" ]; then rm -rf "$WORK_TMP"; fi
  return 0
}

# 地址里内嵌的账号口令（https://user:token@host/…）不往屏幕上打。
redact_url() { printf '%s' "$1" | sed -E 's#(://)[^/@]*@#\1#'; }

# 把任意路径写成单引号字符串，供生成的启动图标脚本原样读回。
shell_quote() {
  local value="$1" escaped="'\\''"
  printf "'%s'" "${value//\'/$escaped}"
}

rerun_hint() {
  if [ -f "$0" ]; then echo "重新运行本安装器：bash $0"; else echo "重新运行本安装器。"; fi
}

# ---------------------------------------------------------------------------
# 第 1 步：安装位置
# ---------------------------------------------------------------------------
# → absent | empty | workbench | workbench-archive | other
classify_install_dir() {
  local dir="$1"
  if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then echo "absent"; return 0; fi
  if [ ! -d "$dir" ]; then echo "other"; return 0; fi
  if [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then echo "empty"; return 0; fi
  if [ -f "$dir/scripts/launch.mjs" ] && [ -f "$dir/package.json" ] \
    && grep -qE "\"name\"[[:space:]]*:[[:space:]]*\"$PACKAGE_NAME\"" "$dir/package.json"; then
    if [ -e "$dir/.git" ]; then echo "workbench"; else echo "workbench-archive"; fi
    return 0
  fi
  echo "other"
}

workbench_version() {
  local version
  version="$(sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$INSTALL_DIR/package.json" 2>/dev/null | head -n 1)" || true
  echo "${version:-?}"
}

check_install_dir() {
  step "检查安装位置"
  note "$INSTALL_DIR"
  INSTALL_KIND="$(classify_install_dir "$INSTALL_DIR")"
  case "$INSTALL_KIND" in
    absent) ok "目录还不存在，稍后新建。" ;;
    empty) ok "目录是空的，直接装在里面。" ;;
    workbench) ok "这里已经装过工作台（v$(workbench_version)），这次只更新到最新版本。" ;;
    workbench-archive) ok "这里是已解压的工作台目录（v$(workbench_version)），直接在此位置配置运行环境。" ;;
    *)
      die "这个位置已经有别的东西，不是集群运维工作台：$INSTALL_DIR" \
        "安装器不会删除或覆盖它，什么都没有改动。" \
        "换一个安装目录再运行：CWB_INSTALL_DIR=\"\$HOME/另一个目录\" bash $0" \
        "如果它是上次没装完留下的，自己确认后删掉这个目录，再重新运行。"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# 第 2、3 步：SSH 客户端与 git
# ---------------------------------------------------------------------------
check_ssh() {
  local tool missing=""
  step "检查 SSH 客户端"
  for tool in ssh ssh-keygen ssh-keyscan; do
    if ! command -v "$tool" >/dev/null 2>&1; then missing="$missing $tool"; fi
  done
  if [ -n "$missing" ]; then
    die "缺少 SSH 客户端工具：${missing# }（工作台靠它们连接集群）。" \
      "macOS 自带这些工具；Linux 请先安装：Debian / Ubuntu 用 sudo apt install openssh-client，RHEL / CentOS 用 sudo dnf install openssh-clients。" \
      "装好后$(rerun_hint)"
  fi
  ok "ssh、ssh-keygen、ssh-keyscan 都在。"
}

git_usable() {
  local found
  found="$(command -v git 2>/dev/null)" || return 1
  # macOS 的 /usr/bin/git 只是个占位：没装命令行开发者工具时一运行就弹安装框。先问 xcode-select，免得弹两次。
  if [ "$OS_NAME" = "Darwin" ] && [ "$found" = "/usr/bin/git" ] && ! xcode-select -p >/dev/null 2>&1; then return 1; fi
  git --version >/dev/null 2>&1
}

check_git() {
  step "检查 git"
  if git_usable; then
    ok "$(git --version)"
    return 0
  fi
  if [ "$INSTALL_KIND" = "workbench-archive" ]; then
    ok "当前使用已解压的工作台压缩包，无需安装 git 即可直接运行。"
    return 0
  fi
  if [ "$OS_NAME" = "Darwin" ]; then
    xcode-select --install >/dev/null 2>&1 || true
    die "这台 Mac 还没有 git（它包含在苹果的「命令行开发者工具」里）。" \
      "已经请系统弹出安装窗口：点「安装」，等它装完（几分钟到十几分钟，取决于网络）。" \
      "没看到窗口的话，在终端执行：xcode-select --install" \
      "装完后$(rerun_hint)"
  fi
  die "没有找到 git。" \
    "请先安装：Debian / Ubuntu 用 sudo apt install git，RHEL / CentOS 用 sudo dnf install git。" \
    "装好后$(rerun_hint)"
}

# ---------------------------------------------------------------------------
# 第 4 步：Node.js
# ---------------------------------------------------------------------------
# $1 = node 可执行文件（名字或路径）；版本在闸门范围内返回 0。
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

# → darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64；认不出来时输出空。
detect_node_platform() {
  local os arch
  case "$OS_NAME" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) echo ""; return 0 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) echo ""; return 0 ;;
  esac
  # 在 Rosetta 下打开的终端会把 Apple 芯片报成 x86_64：按真实芯片选包。
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then arch="arm64"; fi
  echo "$os-$arch"
}

sha256_of() {
  local out
  if command -v shasum >/dev/null 2>&1; then out="$(shasum -a 256 "$1")" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then out="$(sha256sum "$1")" || return 1
  elif command -v openssl >/dev/null 2>&1; then out="$(openssl dgst -sha256 -r "$1")" || return 1
  else return 127
  fi
  printf '%s\n' "${out%% *}" | tr 'A-F' 'a-f'
}

# $1 = 地址，$2 = 保存到。速度长时间低于 10 KB/s 就放弃，让调用方换下一个源。
download() {
  local progress="-sS"
  if command -v curl >/dev/null 2>&1; then
    if [ -t 2 ]; then progress="--progress-bar"; fi
    curl -fL "$progress" --connect-timeout 15 --retry 1 --speed-limit 10240 --speed-time 30 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=30 --tries=2 -O "$2" "$1"
  else
    return 127
  fi
}

install_private_node() {
  local platform expected file base url actual verified=""
  platform="$(detect_node_platform)"
  expected="$(node_sha256 "$platform")"
  if [ -z "$platform" ] || [ -z "$expected" ]; then
    die "这台电脑（$OS_NAME $(uname -m)）没有对应的 Node.js 预编译包。" \
      "请自己安装 Node.js 22.12 及以上、低于 27 的版本（推荐 24），然后$(rerun_hint)"
  fi
  expected="${CWB_NODE_SHA256:-$expected}"
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    die "没有 curl 也没有 wget，无法下载 Node.js。" "请先安装 curl，然后$(rerun_hint)"
  fi
  file="node-v$NODE_VERSION-$platform.tar.gz"
  mkdir -p "$PRIVATE_ROOT"
  NODE_STAGE="$(mktemp -d "$PRIVATE_ROOT/node-staging.XXXXXX")"
  # 先官方站，再国内镜像。哪个源都一样安全：文件要和上面写死的 SHA-256 对上才会解压。
  for base in "$NODE_DIST_BASE" "$NODE_DIST_MIRROR"; do
    url="${base%/}/v$NODE_VERSION/$file"
    note "正在下载（约 55 MB）：$url"
    if ! download "$url" "$NODE_STAGE/$file"; then
      warn "这个地址没有下载下来。"
      rm -f "$NODE_STAGE/$file"
      continue
    fi
    actual="$(sha256_of "$NODE_STAGE/$file")" \
      || die "这台电脑上没有可用的 SHA-256 工具（shasum / sha256sum / openssl），无法核对下载的文件。" "什么都没有安装。"
    if [ "$actual" = "$expected" ]; then
      verified="yes"
      break
    fi
    warn "下载到的文件校验值不对，已丢弃（期望 ${expected}，实际 ${actual}）。"
    rm -f "$NODE_STAGE/$file"
  done
  if [ -z "$verified" ]; then
    die "Node.js 没有下载成功，什么都没有安装。" \
      "官方站和国内镜像两个地址都试过了：要么连不上，要么文件校验不通过。" \
      "检查网络后$(rerun_hint)" \
      "也可以自己安装 Node.js 22.12 及以上、低于 27 的版本（推荐 24）后再运行。"
  fi
  ok "校验通过（SHA-256 与安装器里记录的一致）。"
  mkdir "$NODE_STAGE/unpacked"
  if ! tar -xzf "$NODE_STAGE/$file" -C "$NODE_STAGE/unpacked" --strip-components=1; then
    die "解压 Node.js 失败。" "多半是磁盘空间不够：清理后$(rerun_hint)"
  fi
  if ! node_supported "$NODE_STAGE/unpacked/bin/node"; then
    die "下载的 Node.js 在这台电脑上运行不起来。" \
      "请自己安装 Node.js 22.12 及以上、低于 27 的版本（推荐 24），然后$(rerun_hint)"
  fi
  # 原来那份（坏了，或版本不合适）挪进暂存目录，随它一起清掉；新的一份改名换入。
  if [ -e "$PRIVATE_NODE_DIR" ] || [ -L "$PRIVATE_NODE_DIR" ]; then mv "$PRIVATE_NODE_DIR" "$NODE_STAGE/replaced"; fi
  mv "$NODE_STAGE/unpacked" "$PRIVATE_NODE_DIR"
  rm -rf "$NODE_STAGE"
  NODE_STAGE=""
  NODE_KIND="private"
  ok "私有 Node.js $("$PRIVATE_NODE" --version) 已就绪：$PRIVATE_NODE_DIR"
}

prepare_node() {
  local system_version=""
  step "准备 Node.js"
  if command -v node >/dev/null 2>&1; then
    if node_supported node; then
      NODE_KIND="system"
      ok "系统已有 Node.js $(node --version)，直接使用。"
      return 0
    fi
    system_version="$(node --version 2>/dev/null || true)"
  fi
  if [ -x "$PRIVATE_NODE" ] && node_supported "$PRIVATE_NODE"; then
    NODE_KIND="private"
    ok "上次装好的私有 Node.js $("$PRIVATE_NODE" --version) 还在，直接使用：$PRIVATE_NODE_DIR"
    return 0
  fi
  if [ -n "$system_version" ]; then
    note "系统的 Node.js $system_version 不在支持范围内（需要 22.12 及以上、低于 27）。"
  else
    note "系统里没有 Node.js。"
  fi
  note "下载一份只给工作台用的 Node.js v${NODE_VERSION}，放在 ${PRIVATE_NODE_DIR}。"
  note "不需要管理员权限，不改系统的 Node 和 PATH。"
  install_private_node
}

# ---------------------------------------------------------------------------
# 第 5 步：下载（git clone）或更新（git pull --ff-only）工作台
# ---------------------------------------------------------------------------
is_github_url() {
  case "$REPO_URL" in *github.com[:/]*) return 0 ;; *) return 1 ;; esac
}

is_ssh_url() {
  case "$REPO_URL" in ssh://*|git@*) return 0 ;; *) return 1 ;; esac
}

# $1 = git 的输出（已固定为英文）。按报错归因，说清现象和下一步。
explain_git_failure() {
  local log="$1"
  if grep -qiE 'Authentication failed|could not read Username|terminal prompts disabled|Invalid username or (password|token)|Repository not found|returned error: 40[134]|HTTP 40[134]|Permission denied \(publickey' "$log"; then
    say ""
    say "✘ 没有权限下载工作台仓库（它是私有仓库）。"
    if is_ssh_url; then
      note "这个地址走 SSH：确认这台电脑的 SSH 公钥已经加到你在代码托管网站的账号里，并且账号有这个仓库的权限。"
    elif is_github_url; then
      note "1) 确认维护者已经把你的 GitHub 账号加为仓库协作者，并且你接受了邀请"
      note "   （邀请邮件里点「Accept invitation」，或打开 https://github.com/notifications）。"
      if command -v gh >/dev/null 2>&1; then
        note "2) 这台电脑装了 gh。另开一个终端窗口，依次执行："
        note "     gh auth login       # 选 GitHub.com → HTTPS → 用浏览器登录"
        note "     gh auth setup-git   # 让 git 使用这次登录"
      else
        note "2) git 问 Username 时填 GitHub 用户名；问 Password 时粘贴 personal access token"
        note "   （不是登录密码；粘贴时屏幕上不显示）。令牌在 GitHub 网页生成：右上角头像 → Settings →"
        note "   Developer settings → Personal access tokens → Tokens (classic) → Generate new token，勾选 repo。"
      fi
    else
      note "请确认你有权限访问：$(redact_url "$REPO_URL")"
    fi
    return 0
  fi
  if grep -qiE "Could not resolve host|Failed to connect|Couldn't connect|Connection (refused|reset|timed out)|unable to access|Network is unreachable|Operation timed out|SSL|TLS|early EOF|RPC failed" "$log"; then
    say ""
    say "✘ 连不上仓库所在的服务器。"
    note "检查网络；靠代理上网的话，确认代理软件开着、终端也走代理，然后重试。"
    return 0
  fi
  say ""
  say "✘ 下载工作台没有成功，git 的报错见上面几行。"
  note "仓库地址：$(redact_url "$REPO_URL")"
}

# 新装的这一份默认进稳定版：git clone 已经把远端的分支都取下来了，这里只看本地记下的 origin/stable——
# 有就切过去（不再联网，本地建一条跟着它的同名分支），没有就什么都不做，和以前一样留在默认分支。
# 没切成不算安装失败：留在默认分支照常可用，之后可以用 npm run update -- --channel stable 再切。
use_stable_branch() {
  local current
  current="$(git -C "$INSTALL_DIR" symbolic-ref --short -q HEAD 2>/dev/null || true)"
  if [ "$current" = "$STABLE_BRANCH" ]; then return 0; fi
  if ! git -C "$INSTALL_DIR" rev-parse --verify -q "refs/remotes/origin/$STABLE_BRANCH" >/dev/null 2>&1; then return 0; fi
  if git -C "$INSTALL_DIR" checkout -q -b "$STABLE_BRANCH" --track "origin/$STABLE_BRANCH" >/dev/null 2>&1; then
    note "远端有稳定版分支，这一份跟稳定版（${STABLE_BRANCH}）：发布方确认过的版本才会收到。"
  else
    warn "没能切到稳定版分支（${STABLE_BRANCH}），这一份留在默认分支上：发布方每次推送都会收到。"
    note "之后想换到稳定版，在安装目录里执行：npm run update -- --channel $STABLE_BRANCH"
  fi
}

clone_workbench() {
  local log="$WORK_TMP/git.log" rc answer
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if is_github_url && ! is_ssh_url && [ -t 0 ]; then
    note "仓库是私有的。如果下面出现 Username / Password 提问：Username 填 GitHub 用户名，"
    note "Password 粘贴 personal access token（不是登录密码）。不清楚就连按两次回车，会给出详细步骤。"
  fi
  while :; do
    note "正在下载：$(redact_url "$REPO_URL")"
    # LC_ALL=C：让 git 的报错固定是英文，explain_git_failure 才认得出。
    set +e
    if [ -t 2 ]; then
      LC_ALL=C LANG=C git clone --progress "$REPO_URL" "$INSTALL_DIR" 2>&1 | tee "$log"
      rc=${PIPESTATUS[0]}
    else
      LC_ALL=C LANG=C git clone "$REPO_URL" "$INSTALL_DIR" >"$log" 2>&1
      rc=$?
      sed 's/^/    /' "$log"
    fi
    set -e
    if [ "$rc" -eq 0 ]; then break; fi
    explain_git_failure "$log"
    # 有人守着终端时原地重试（前面几步不重做）；无人值守时直接退出，重新运行也只会从这一步真正干活。
    if [ -t 0 ] && [ -t 1 ]; then
      printf '\n  处理好之后按回车重试（前面几步不会重做）；输入 q 再回车则退出：'
      read -r answer || answer="q"
      case "$answer" in q|Q) exit 1 ;; esac
    else
      exit 1
    fi
  done
  use_stable_branch
  if [ "$(classify_install_dir "$INSTALL_DIR")" != "workbench" ]; then
    die "下载下来的内容不像集群运维工作台（没有 scripts/launch.mjs，或 package.json 的 name 不是 ${PACKAGE_NAME}）。" \
      "请确认仓库地址是否正确：$(redact_url "$REPO_URL")" \
      "刚下载的目录还在，没有删除：$INSTALL_DIR"
  fi
  ok "已下载到 ${INSTALL_DIR}（v$(workbench_version)）。"
}

update_workbench() {
  local log="$WORK_TMP/git.log" rc=0 before after origin
  origin="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  before="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  note "正在更新：$(redact_url "${origin:-（没有 origin）}")"
  LC_ALL=C LANG=C git -C "$INSTALL_DIR" pull --ff-only >"$log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    sed 's/^/    /' "$log"
    warn "没能更新到最新版本，继续使用现有的这一份（v$(workbench_version)）。"
    note "常见原因：网络不通、GitHub 登录过期、安装目录里有自己改过的文件。"
    note "之后可以在工作台页面左上角点版本号 →「检查更新」，那里会说明具体原因。"
  else
    after="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
    if [ "$before" = "$after" ]; then
      ok "已经是最新版本（v$(workbench_version)）。"
    else
      ok "已更新到最新版本（v$(workbench_version)）。"
      note "如果工作台此刻正开着：关掉它的窗口再重新打开，新版本才会生效。"
    fi
  fi
  if [ -n "${CWB_REPO_URL:-}" ] && [ -n "$origin" ] && [ "$origin" != "$CWB_REPO_URL" ]; then
    warn "这份安装的更新来源是 $(redact_url "$origin")，和 CWB_REPO_URL 不一样；没有改动它。"
    note "要换来源请自己执行：git -C $(shell_quote "$INSTALL_DIR") remote set-url origin <新地址>"
  fi
}

fetch_workbench() {
  if [ "$INSTALL_KIND" = "workbench" ]; then
    step "更新工作台"
    update_workbench
  elif [ "$INSTALL_KIND" = "workbench-archive" ]; then
    step "准备已解压的工作台"
    ok "已就绪：${INSTALL_DIR}（v$(workbench_version)，压缩包解压模式，无需联网克隆仓库）。"
  else
    step "下载工作台"
    clone_workbench
  fi
}

# ---------------------------------------------------------------------------
# 第 6 步：桌面启动图标（macOS）
# ---------------------------------------------------------------------------
create_launcher() {
  local launcher="$DESKTOP_DIR/$LAUNCHER_NAME"
  step "创建桌面启动图标"
  if [ "$OS_NAME" != "Darwin" ]; then
    note "Linux 上不放桌面图标。启动命令：bash $INSTALL_DIR/start.sh"
    return 0
  fi
  if [ ! -d "$DESKTOP_DIR" ]; then
    warn "没有找到桌面目录 ${DESKTOP_DIR}，没有放图标。启动命令：bash $INSTALL_DIR/start.sh"
    return 0
  fi
  if { [ -e "$launcher" ] || [ -L "$launcher" ]; } && ! grep -qF "$LAUNCHER_MARKER" "$launcher" 2>/dev/null; then
    warn "桌面上已有一个「${LAUNCHER_NAME}」，不是本安装器放的，没有覆盖它。"
    note "启动命令：bash $INSTALL_DIR/start.sh"
    return 0
  fi
  {
    printf '#!/bin/bash\n'
    printf '# %s（由 install-workbench.sh 生成；重新运行安装器会改写本文件）\n' "$LAUNCHER_MARKER"
    printf '# 双击启动集群运维工作台：浏览器会自动打开。关掉这个终端窗口，工作台就停了。\n'
    printf 'START_SCRIPT=%s\n' "$(shell_quote "$INSTALL_DIR/start.sh")"
    cat <<'LAUNCHER'
if [ ! -f "$START_SCRIPT" ]; then
  echo "✘ 找不到 ${START_SCRIPT}：安装目录被移动或删除了。"
  echo "  重新运行一次安装器（install-workbench.sh）就能恢复。"
  exit 1
fi
exec /bin/bash "$START_SCRIPT" "$@"
LAUNCHER
  } >"$WORK_TMP/launcher"
  chmod 755 "$WORK_TMP/launcher"
  # macOS 第一次会问「终端」能不能访问桌面文件夹；点了「不允许」时这里写不进去，不算安装失败。
  if ! mv -f "$WORK_TMP/launcher" "$launcher" 2>/dev/null; then
    warn "没能把图标放到桌面（多半是系统没有允许「终端」访问桌面文件夹）。"
    note "启动命令：bash $INSTALL_DIR/start.sh"
    return 0
  fi
  LAUNCHER_PATH="$launcher"
  ok "桌面上的「${LAUNCHER_NAME%.command}」：以后双击它启动。"
}

# ---------------------------------------------------------------------------
# 收尾与启动
# ---------------------------------------------------------------------------
finish() {
  local npm_command="npm install"
  if [ "$NODE_KIND" = "private" ]; then npm_command="PATH=\"$PRIVATE_NODE_DIR/bin:\$PATH\" npm install"; fi
  say ""
  say "安装完成。"
  note "安装目录：$INSTALL_DIR"
  if [ -n "$LAUNCHER_PATH" ]; then
    note "以后启动：双击桌面上的「${LAUNCHER_NAME%.command}」（或在终端执行 bash $INSTALL_DIR/start.sh）。"
  else
    note "以后启动：在终端执行 bash $INSTALL_DIR/start.sh"
  fi
  note "以后更新：有新版本时工作台页面顶部会提示，点「更新」即可。"
  if [ "$OS_NAME" = "Darwin" ]; then
    note "可选：想要独立的桌面窗口而不是浏览器标签页，之后在安装目录里执行一次 $npm_command"
  fi
  if [ "${CWB_INSTALL_NO_LAUNCH:-}" = "1" ]; then
    note "这次没有启动工作台（设置了 CWB_INSTALL_NO_LAUNCH=1）。"
    return 0
  fi
  say ""
  say "正在启动工作台，浏览器会自动打开；打开后按页面引导填写集群用户名和密码即可。"
  say "（这个终端窗口就是工作台本身：关掉它，工作台就停了。）"
  say ""
  cleanup
  exec bash "$INSTALL_DIR/start.sh"
}

resolve_default_install_dir() {
  local self_dir parent_root kind
  if [ -n "${CWB_INSTALL_DIR:-}" ]; then echo "$CWB_INSTALL_DIR"; return 0; fi
  if [ -f "$0" ]; then
    self_dir="$(cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)"
    if [ -n "$self_dir" ] && [ "$(basename -- "$self_dir")" = "install" ]; then
      parent_root="$(dirname -- "$self_dir")"
      kind="$(classify_install_dir "$parent_root")"
      if [ "$kind" = "workbench-archive" ] || [ "$kind" = "workbench" ]; then
        echo "$parent_root"
        return 0
      fi
    fi
  fi
  echo "$HOME/cluster-workbench"
}

main() {
  if [ -z "${HOME:-}" ]; then die "没有 HOME 环境变量，无法确定安装位置。" "请在自己账号的终端里运行本安装器。"; fi
  INSTALL_DIR="$(resolve_default_install_dir)"
  case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;; esac
  INSTALL_DIR="${INSTALL_DIR%/}"
  if [ -z "$INSTALL_DIR" ]; then die "安装目录不能是根目录 /。" "换一个目录：CWB_INSTALL_DIR=\"\$HOME/cluster-workbench\" bash $0"; fi
  INSTALL_KIND=""
  REPO_URL="${CWB_REPO_URL:-$DEFAULT_REPO_URL}"
  PRIVATE_ROOT="$HOME/.cluster-workbench"
  PRIVATE_NODE_DIR="$PRIVATE_ROOT/node"
  PRIVATE_NODE="$PRIVATE_NODE_DIR/bin/node"
  DESKTOP_DIR="${CWB_DESKTOP_DIR:-$HOME/Desktop}"
  NODE_DIST_BASE="${CWB_NODE_DIST_BASE:-https://nodejs.org/dist}"
  NODE_DIST_MIRROR="${CWB_NODE_DIST_MIRROR:-https://npmmirror.com/mirrors/node}"
  LAUNCHER_PATH=""

  say "集群运维工作台 · 安装器"
  trap cleanup EXIT
  WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/cwb-install.XXXXXX")"

  check_install_dir
  check_ssh
  check_git
  prepare_node
  fetch_workbench
  create_launcher
  finish
}

main "$@"
