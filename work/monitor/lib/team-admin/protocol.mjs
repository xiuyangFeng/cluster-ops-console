// biome-ignore-all lint/suspicious/noTemplateCurlyInString: remote POSIX sh variable expansion
// 团队管理（/public/agent-hub）远端协议纯函数：目录解析、管理员单次 SSH 聚合探测、
// 名册与加密信封原子写入、冒牌文件（粘滞位抢注）核验与清理、成员端心跳与公钥读写。
//
// 硬约束：
//   - 远端命令全部经 wrapSh 包成 POSIX sh，不依赖 jq / python；
//   - 正文（roster.json、assigned/<user>.enc、heartbeats/<me>.json）一律走 ssh 标准输入，不拼进命令行；
//   - 读取 1777 目录（pubkeys/、heartbeats/）下的文件时，强制核对 `stat -c %U` 内核属主等于文件名前缀 <user>，
//     防止其他用户恶意创建同名文件伪造状态或占坑死锁。

import { parseRegistrySurvey, resolvePortRegistryDir } from "../port-registry.mjs";
import { parseListeningPorts, REVERSE_PORT_LISTEN_RANGE } from "../reverse-port.mjs";
import { shellSingleQuote } from "../shell/quote.mjs";
import { wrapSh } from "../shell/wrap-sh.mjs";
import { readSshConfigUser } from "../ssh-config-user.mjs";
import { toPort } from "../validators.mjs";

export const DEFAULT_AGENT_HUB_DIR = "/public/agent-hub";
const SAFE_DIR_RE = /^\/[A-Za-z0-9._/-]+$/;
const SAFE_USER_RE = /^[A-Za-z0-9._-]{1,32}$/;

const OWNER_FN = "owner() { stat -c %U \"$1\" 2>/dev/null || ls -ld \"$1\" 2>/dev/null | awk '{print $3}'; }";

export function isSafeClusterUser(user) {
  if (typeof user !== "string") return false;
  const trimmed = user.trim();
  return SAFE_USER_RE.test(trimmed) && !trimmed.startsWith("-") && trimmed !== "." && trimmed !== "..";
}

export function assertSafeClusterUser(user) {
  const trimmed = typeof user === "string" ? user.trim() : "";
  if (!isSafeClusterUser(trimmed)) {
    throw new Error(`非法的集群用户名: ${JSON.stringify(user)}`);
  }
  return trimmed;
}

export function normalizeHubBaseDir(dir) {
  if (typeof dir !== "string") return null;
  const trimmed = dir.trim().replace(/\/+$/, "");
  if (!SAFE_DIR_RE.test(trimmed)) return null;
  const segments = trimmed.split("/").slice(1);
  if (segments.length === 0 || segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return trimmed;
}

// 从团队配置的 portRegistry.dir（默认 /public/agent-hub/ports）推导团队管理根目录 /public/agent-hub。
export function resolveAgentHubBaseDir(teamConfig) {
  const explicit = normalizeHubBaseDir(teamConfig?.teamAdmin?.hubDir);
  if (explicit) return explicit;
  const portsDir = resolvePortRegistryDir(teamConfig);
  if (portsDir?.endsWith("/ports")) {
    const parent = normalizeHubBaseDir(portsDir.slice(0, -"/ports".length));
    if (parent) return parent;
  }
  return DEFAULT_AGENT_HUB_DIR;
}

function assertHubBaseDir(baseDir) {
  const normalized = normalizeHubBaseDir(baseDir);
  if (!normalized) throw new Error(`unsafe agent-hub base dir: ${JSON.stringify(baseDir)}`);
  return normalized;
}

// 解析当前生效的集群登录用户名：服务器条目 sshUser → 个人层 sshUser → ~/.ssh/config Host User。
export function resolveEffectiveSshUser(config, server = null, { resolveSshUser = readSshConfigUser } = {}) {
  const srv = server || (config?.servers || []).find((s) => s.id === config?.activeServerId) || config?.servers?.[0] || null;
  const candidates = [
    srv?.sshUser,
    config?.sshUser,
    srv?.host ? resolveSshUser(srv.host) : "",
  ];
  for (const c of candidates) {
    if (typeof c === "string" && isSafeClusterUser(c)) return c.trim();
  }
  return "";
}

// 判断给定集群用户名是否具备团队管理员身份。
export function isAdminUser(config, sshUser) {
  if (!isSafeClusterUser(sshUser)) return false;
  const user = sshUser.trim();
  if (user === "root") return true;
  const list = Array.isArray(config?.adminUsers) ? config.adminUsers : [];
  return list.some((item) => typeof item === "string" && item.trim() === user);
}

// 生成给管理员在 root 下或通过 sudo 执行的一次性赋权命令：
// 将 /var/tmp/codex-tunnel 及全部子目录的属主移交给管理员账号（如 kai）。
// 利用 Linux sticky bit (1777) 机制：目录属主无需 sudo 即可直接删除 ports/ pubkeys/ heartbeats/ 下任何人的闲置或占坑文件。
export function buildHubAdminInitCommand(baseDir = DEFAULT_AGENT_HUB_DIR, adminUser = "") {
  const b = assertHubBaseDir(baseDir);
  const u = isSafeClusterUser(adminUser) ? adminUser.trim() : "admin";
  const prefix = u === "root" ? "" : "sudo ";
  return `${prefix}install -d -o ${u} -m 1777 ${b} ${b}/ports ${b}/pubkeys ${b}/heartbeats && ${prefix}install -d -o ${u} -m 0755 ${b}/admin ${b}/assigned && ${prefix}chown -R ${u} ${b}/admin ${b}/assigned`;
}

// 生成在集群 root 终端一键粘贴执行的完整赋权脚本：
//   1. 初始化共享管理目录并将属主交给管理员账号（如 kai）；
//   2. 安装 root:root 0755 受限辅助脚本 /usr/local/bin/codex-team-admin-helper；
//   3. 写入 /etc/sudoers.d/codex-team-admin（0440），允许 kai 免密执行该辅助脚本以完成强踢僵尸端口与未装客户端成员兜底采集。
export function buildRootGrantScript(baseDir = DEFAULT_AGENT_HUB_DIR, adminUser = "admin") {
  const b = assertHubBaseDir(baseDir);
  const u = isSafeClusterUser(adminUser) ? adminUser.trim() : "admin";
  return [
    `# === 集群运维工作台：为管理员账号 (${u}) 授予团队管理权限 ===`,
    `HUB_DIR=${shellSingleQuote(b)}`,
    `ADMIN_USER=${shellSingleQuote(u)}`,
    "",
    "# 1. 创建团队共享目录并将属主移交给管理员账号",
    'install -d -o "$ADMIN_USER" -m 1777 "$HUB_DIR" "$HUB_DIR/ports" "$HUB_DIR/pubkeys" "$HUB_DIR/heartbeats"',
    'install -d -o "$ADMIN_USER" -m 0755 "$HUB_DIR/admin" "$HUB_DIR/assigned"',
    'chown -R "$ADMIN_USER" "$HUB_DIR/admin" "$HUB_DIR/assigned"',
    'chown "$ADMIN_USER" "$HUB_DIR" "$HUB_DIR/ports" "$HUB_DIR/pubkeys" "$HUB_DIR/heartbeats"',
    "",
    "# 2. 安装受限 Root 辅助脚本（仅 root 可改，防止越权）",
    "cat >/usr/local/bin/codex-team-admin-helper <<'HELPER_EOF'",
    "#!/bin/sh",
    "set -eu",
    "cmd=${1:-}",
    "case \"$cmd\" in",
    "  check) echo HELPER_OK ;;",
    "  init)",
    "    b=${2:?}; u=${3:?}",
    "    install -d -o \"$u\" -m 1777 \"$b\" \"$b/ports\" \"$b/pubkeys\" \"$b/heartbeats\"",
    "    install -d -o \"$u\" -m 0755 \"$b/admin\" \"$b/assigned\"",
    "    chown -R \"$u\" \"$b/admin\" \"$b/assigned\" ;;",
    "  release-port)",
    "    b=${2:?}; p=${3:?}",
    "    case \"$p\" in ''|*[!0-9]*) exit 2 ;; esac",
    "    rm -f \"$b/ports/$p\" ;;",
    "  kill-port)",
    "    p=${2:?}",
    "    case \"$p\" in ''|*[!0-9]*) exit 2 ;; esac",
    `    [ "$p" -ge ${REVERSE_PORT_LISTEN_RANGE.min} ] && [ "$p" -le ${REVERSE_PORT_LISTEN_RANGE.max} ] || exit 2`,
    "    pids=$(ss -ltnp 2>/dev/null | awk -v pat=\":$p$\" '$4 ~ pat { while (match($0, /pid=[0-9]+/)) { print substr($0, RSTART+4, RLENGTH-4); $0=substr($0, RSTART+RLENGTH) } }' | sort -u)",
    "    if [ -z \"$pids\" ]; then echo KILL_PORT=no-listener; exit 0; fi",
    "    killed=0",
    "    for pid in $pids; do",
    "      ppid=$(ps -o ppid= -p \"$pid\" 2>/dev/null | tr -d ' ' || true)",
    "      comm=$(ps -o comm= -p \"$pid\" 2>/dev/null | tr -d ' ' || true)",
    "      if [ -n \"$ppid\" ] && [ \"$ppid\" != \"1\" ] && [ \"$comm\" = \"sshd\" ]; then",
    "        kill -TERM \"$pid\" 2>/dev/null || true",
    "        killed=$((killed + 1))",
    "      fi",
    "    done",
    "    echo \"KILL_PORT=ok:$killed\" ;;",
    "  scan-user)",
    "    u=${2:?}",
    "    case \"$u\" in ''|*[!A-Za-z0-9._-]*) exit 2 ;; esac",
    "    uh=$(getent passwd \"$u\" 2>/dev/null | cut -d: -f6 || true)",
    "    [ -n \"$uh\" ] || uh=\"/home/$u\"",
    "    [ -d \"$uh\" ] || exit 0",
    "    hb=$( (command -v timeout >/dev/null 2>&1 && timeout 2 du -skx \"$uh\" 2>/dev/null || du -sk \"$uh/.codex\" \"$uh/.claude\" 2>/dev/null) | awk '{s+=$1} END {printf \"%.0f\", s*1024}' )",
    "    cx=0; { [ -x \"$uh/.local/bin/codex\" ] || [ -d \"$uh/.codex\" ]; } && cx=1 || true",
    "    cl=0; { [ -x \"$uh/.local/bin/claude\" ] || [ -d \"$uh/.claude\" ]; } && cl=1 || true",
    "    td=$(find \"$uh/.codex/sessions\" \"$uh/.claude/projects\" -type f -mtime -1 2>/dev/null | head -n 30 | xargs grep -Eo '\"(total_tokens|output_tokens)\"[[:space:]]*:[[:space:]]*[0-9]+' 2>/dev/null | awk -F: '{c++; s+=$2} END {printf \"%d\\t%d\", c+0, s+0}' || printf '0\\t0')",
    "    wk=$(find \"$uh/.codex/sessions\" \"$uh/.claude/projects\" -type f -mtime -7 2>/dev/null | head -n 60 | xargs grep -Eo '\"(total_tokens|output_tokens)\"[[:space:]]*:[[:space:]]*[0-9]+' 2>/dev/null | awk -F: '{c++; s+=$2} END {printf \"%d\\t%d\", c+0, s+0}' || printf '0\\t0')",
    "    printf 'ROOTSCAN\\t%s\\t%s\\t%s\\t%s\\t%d\\t%d\\n' \"$u\" \"${hb:-0}\" \"$td\" \"$wk\" \"$cx\" \"$cl\" ;;",
    "  *) exit 2 ;;",
    "esac",
    "HELPER_EOF",
    "chown root:root /usr/local/bin/codex-team-admin-helper",
    "chmod 0755 /usr/local/bin/codex-team-admin-helper",
    "",
    "# 3. 配置 sudoers.d 免密白名单",
    'cat >/etc/sudoers.d/codex-team-admin <<EOF',
    '${ADMIN_USER} ALL=(root) NOPASSWD: /usr/local/bin/codex-team-admin-helper *, /usr/bin/install -d -o ${ADMIN_USER} *, /bin/rm -f ${HUB_DIR}/*, /usr/bin/rm -f ${HUB_DIR}/*, /bin/chown -R ${ADMIN_USER} *',
    "EOF",
    "chmod 0440 /etc/sudoers.d/codex-team-admin",
    'echo "✅ 团队管理员 (${ADMIN_USER}) Root 赋权已完成！"',
  ].join("\n");
}

// 管理员单次 SSH 聚合探测命令：
//   1. 检测 SUDO_READY（是否已安装 codex-team-admin-helper 或具备免密 sudo -n）；
//   2. 若根目录未就绪且具备免密权限，顺手自动初始化并接管子目录；
//   3. 采集目录权限状态、roster.json、ports/*、ss -ltn、pubkeys/*.pub、assigned/*.enc、heartbeats/*.json、who、活跃 Agent 进程；
//   4. 对尚未上报心跳的成员，若具备 Root 赋权，使用 3 分钟缓存兜底采集其家目录占用与 AI 会话用量（ROOTSCAN）。
export function buildAdminSurveyCommand(baseDir = DEFAULT_AGENT_HUB_DIR) {
  const b = assertHubBaseDir(baseDir);
  return wrapSh([
    OWNER_FN,
    `b=${shellSingleQuote(b)}`,
    "me=$(id -un 2>/dev/null)",
    "now=$(date +%s 2>/dev/null)",
    "printf 'ME=%s\\n' \"$me\"",
    "printf 'NOW=%s\\n' \"$now\"",
    "hlp=/usr/local/bin/codex-team-admin-helper",
    "run_root() { if [ \"$(id -u)\" = 0 ]; then \"$@\"; else sudo -n \"$@\"; fi; }",
    "sudo_ok=0",
    "if [ \"$(id -u)\" = 0 ]; then sudo_ok=1",
    "elif command -v sudo >/dev/null 2>&1; then",
    "  if [ -x \"$hlp\" ] && sudo -n \"$hlp\" check >/dev/null 2>&1; then sudo_ok=1",
    "  elif sudo -n true 2>/dev/null; then sudo_ok=1; fi",
    "fi",
    "printf 'SUDO_READY=%d\\n' \"$sudo_ok\"",
    "if [ ! -d \"$b\" ] || [ ! -w \"$b\" ] || [ ! -d \"$b/admin\" ] || [ ! -w \"$b/admin\" ]; then",
    "  if [ \"$sudo_ok\" = \"1\" ]; then",
    "    if [ -x \"$hlp\" ]; then run_root \"$hlp\" init \"$b\" \"$me\" 2>/dev/null || true",
    "    else",
    "      run_root install -d -o \"$me\" -m 1777 \"$b\" \"$b/ports\" \"$b/pubkeys\" \"$b/heartbeats\" 2>/dev/null || true",
    "      run_root install -d -o \"$me\" -m 0755 \"$b/admin\" \"$b/assigned\" 2>/dev/null || true",
    "    fi",
    "  fi",
    "fi",
    "if [ -d \"$b\" ]; then",
    "  if [ -w \"$b\" ] && [ -x \"$b\" ]; then",
    "    mkdir -m 0755 \"$b/admin\" \"$b/assigned\" 2>/dev/null || true",
    "    mkdir -m 1777 \"$b/pubkeys\" \"$b/heartbeats\" \"$b/ports\" 2>/dev/null || true",
    "    chmod 1777 \"$b/pubkeys\" \"$b/heartbeats\" \"$b/ports\" 2>/dev/null || true",
    "    echo HUB_BASE=ok",
    "  else",
    "    echo HUB_BASE=readonly",
    "  fi",
    "  printf 'HUB_OWNER=%s\\n' \"$(owner \"$b\")\"",
    "else",
    "  echo HUB_BASE=absent",
    "fi",
    "for sub in admin assigned ports pubkeys heartbeats; do",
    "  sd=\"$b/$sub\"",
    "  if [ -d \"$sd\" ]; then",
    "    if [ -w \"$sd\" ] && [ -x \"$sd\" ]; then st=ok; else st=readonly; fi",
    "    printf 'DIR\\t%s\\t%s\\t%s\\n' \"$sub\" \"$st\" \"$(owner \"$sd\")\"",
    "  else",
    "    printf 'DIR\\t%s\\tabsent\\t\\n' \"$sub\"",
    "  fi",
    "done",
    "echo ROSTER-BEGIN",
    "[ -f \"$b/admin/roster.json\" ] && head -c 65536 \"$b/admin/roster.json\" 2>/dev/null || true",
    "echo",
    "echo ROSTER-END",
    "echo NOTICE-BEGIN",
    "[ -f \"$b/admin/notice.json\" ] && head -c 8192 \"$b/admin/notice.json\" 2>/dev/null || true",
    "echo",
    "echo NOTICE-END",
    "echo PORTS-BEGIN",
    "if [ -d \"$b/ports\" ]; then",
    "  for f in \"$b/ports\"/*; do",
    "    n=${f##*/}",
    "    case $n in ''|*[!0-9]*) continue;; esac",
    "    [ -e \"$f\" ] || [ -L \"$f\" ] || continue",
    "    if [ -f \"$f\" ] && [ ! -L \"$f\" ]; then k=f; else k=x; fi",
    "    ca=$(sed -n 's/^claimedAt=//p' \"$f\" 2>/dev/null | head -n 1)",
    "    printf 'REG\\t%s\\t%s\\t%s\\t%s\\n' \"$n\" \"$(owner \"$f\")\" \"$k\" \"$ca\"",
    "  done",
    "fi",
    "echo PORTS-END",
    "echo LISTEN-BEGIN",
    "{ command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null; } || true",
    "echo LISTEN-END",
    "echo PUBKEYS-BEGIN",
    "if [ -d \"$b/pubkeys\" ]; then",
    "  for f in \"$b/pubkeys\"/*.pub; do",
    "    [ -e \"$f\" ] || [ -L \"$f\" ] || continue",
    "    n=${f##*/}",
    "    u=${n%.pub}",
    "    case $u in ''|*[!A-Za-z0-9._-]*) continue;; esac",
    "    o=$(owner \"$f\")",
    "    if [ -f \"$f\" ] && [ ! -L \"$f\" ] && [ \"$o\" = \"$u\" ]; then",
    "      pk=$(head -c 256 \"$f\" 2>/dev/null | tr -d '\\r\\n \\t')",
    "      printf 'PUB\\t%s\\t%s\\n' \"$u\" \"$pk\"",
    "    else",
    "      { rm -f \"$f\" 2>/dev/null || sudo -n rm -f \"$f\" 2>/dev/null; } && printf 'SPOOF\\tpubkeys/%s\\t%s\\tcleaned\\n' \"$n\" \"$o\" || printf 'SPOOF\\tpubkeys/%s\\t%s\\tblocked\\n' \"$n\" \"$o\"",
    "    fi",
    "  done",
    "fi",
    "echo PUBKEYS-END",
    "echo ASSIGNED-BEGIN",
    "if [ -d \"$b/assigned\" ]; then",
    "  for f in \"$b/assigned\"/*.enc; do",
    "    [ -f \"$f\" ] && [ ! -L \"$f\" ] || continue",
    "    n=${f##*/}",
    "    u=${n%.enc}",
    "    case $u in ''|*[!A-Za-z0-9._-]*) continue;; esac",
    "    printf 'ENC\\t%s\\t%s\\n' \"$u\" \"$(head -c 16384 \"$f\" 2>/dev/null | tr -d '\\r\\n')\"",
    "  done",
    "fi",
    "echo ASSIGNED-END",
    "echo HEARTBEATS-BEGIN",
    "if [ -d \"$b/heartbeats\" ]; then",
    "  for f in \"$b/heartbeats\"/*.json; do",
    "    [ -e \"$f\" ] || [ -L \"$f\" ] || continue",
    "    n=${f##*/}",
    "    u=${n%.json}",
    "    case $u in ''|*[!A-Za-z0-9._-]*) continue;; esac",
    "    o=$(owner \"$f\")",
    "    if [ -f \"$f\" ] && [ ! -L \"$f\" ] && [ \"$o\" = \"$u\" ]; then",
    "      printf 'HB\\t%s\\t%s\\n' \"$u\" \"$(head -c 8192 \"$f\" 2>/dev/null | tr -d '\\r\\n')\"",
    "    else",
    "      { rm -f \"$f\" 2>/dev/null || sudo -n rm -f \"$f\" 2>/dev/null; } && printf 'SPOOF\\theartbeats/%s\\t%s\\tcleaned\\n' \"$n\" \"$o\" || printf 'SPOOF\\theartbeats/%s\\t%s\\tblocked\\n' \"$n\" \"$o\"",
    "    fi",
    "  done",
    "fi",
    "echo HEARTBEATS-END",
    "echo WHO-BEGIN",
    "who 2>/dev/null | awk '{print $1}' | sort -u | head -n 64 || true",
    "echo WHO-END",
    "echo AGENTS-BEGIN",
    "LC_ALL=C ps -eo user:32=,comm= 2>/dev/null | awk '$2 ~ /^(codex|claude|reclaude|zcode|zcode-server)$/ { c[$1 \"\\t\" $2]++ } END { for (k in c) printf \"%s\\t%d\\n\", k, c[k] }' | head -n 128 || true",
    "echo AGENTS-END",
    "echo ROOTSCAN-BEGIN",
    "if [ \"$sudo_ok\" = \"1\" ] && [ -x \"$hlp\" ] && [ -d \"$b/admin\" ] && [ -w \"$b/admin\" ]; then",
    "  rcache=\"$b/admin/.root-scan.cache\"",
    "  cmtime=$(stat -c %Y \"$rcache\" 2>/dev/null || echo 0)",
    "  if [ -f \"$rcache\" ] && [ $((now - cmtime)) -lt 180 ]; then",
    "    cat \"$rcache\" 2>/dev/null || true",
    "  else",
    "    users=$({ [ -f \"$b/admin/roster.json\" ] && grep -Eo '\"user\"[[:space:]]*:[[:space:]]*\"[A-Za-z0-9._-]+\"' \"$b/admin/roster.json\" 2>/dev/null | sed 's/.*\"\\([A-Za-z0-9._-]*\\)\"$/\\1/'; who 2>/dev/null | awk '{print $1}'; } | sort -u | head -n 32)",
    "    rtmp=\"$b/admin/.root-scan.cache.tmp.$$\"",
    "    : > \"$rtmp\" 2>/dev/null || true",
    "    for u in $users; do",
    "      [ ! -f \"$b/heartbeats/$u.json\" ] || continue",
    "      run_root \"$hlp\" scan-user \"$u\" >> \"$rtmp\" 2>/dev/null || true",
    "    done",
    "    mv -f \"$rtmp\" \"$rcache\" 2>/dev/null || rm -f \"$rtmp\" 2>/dev/null || true",
    "    cat \"$rcache\" 2>/dev/null || true",
    "  fi",
    "fi",
    "echo ROOTSCAN-END",
    "exit 0",
  ]);
}

function safeJsonParse(text, fallback = null) {
  if (typeof text !== "string" || !text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function normalizeRosterObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { v: 1, updatedAt: null, updatedBy: null, members: {} };
  }
  const membersOut = {};
  const rawMembers = raw.members && typeof raw.members === "object" && !Array.isArray(raw.members) ? raw.members : {};
  for (const [key, item] of Object.entries(rawMembers)) {
    if (!isSafeClusterUser(key) || !item || typeof item !== "object") continue;
    const u = key.trim();
    const assignedPort = item.assignedPort != null ? toPort(item.assignedPort) : null;
    membersOut[u] = {
      user: u,
      displayName: typeof item.displayName === "string" ? item.displayName.trim().slice(0, 64) : "",
      note: typeof item.note === "string" ? item.note.trim().slice(0, 160) : "",
      assignedPort,
      enabled: item.enabled !== false,
      addedAt: typeof item.addedAt === "string" ? item.addedAt : null,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
    };
  }
  return {
    v: 1,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : null,
    members: membersOut,
  };
}

export function normalizeNoticeObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 500) : "";
  if (!text) return null;
  const level = ["info", "warn", "error"].includes(raw.level) ? raw.level : "info";
  return {
    v: 1,
    text,
    level,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : null,
  };
}

// 解析管理员聚合探测输出。
export function parseAdminSurveyOutput(text) {
  const lines = String(text || "").split(/\r?\n/);
  let me = "";
  let nowSec = null;
  let sudoReady = false;
  let hubBase = "unknown";
  let hubOwner = "";
  const dirs = {};
  const rosterLines = [];
  const noticeLines = [];
  const ports = [];
  const listenLines = [];
  const pubkeys = {};
  const assigned = {};
  const heartbeats = {};
  const spoofs = [];
  const sshUsers = new Set();
  const agentProcs = {};
  const rootScans = {};

  let section = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith("-BEGIN")) {
      section = trimmed.slice(0, -"-BEGIN".length);
      continue;
    }
    if (trimmed.endsWith("-END") && section && trimmed === `${section}-END`) {
      section = "";
      continue;
    }
    if (!section) {
      let m = /^ME=([A-Za-z0-9._-]+)$/.exec(trimmed);
      if (m) {
        me = m[1];
        continue;
      }
      m = /^NOW=(\d+)$/.exec(trimmed);
      if (m) {
        nowSec = Number(m[1]);
        continue;
      }
      m = /^SUDO_READY=([01])$/.exec(trimmed);
      if (m) {
        sudoReady = m[1] === "1";
        continue;
      }
      m = /^HUB_BASE=(ok|absent|readonly)$/.exec(trimmed);
      if (m) {
        hubBase = m[1];
        continue;
      }
      m = /^HUB_OWNER=(.*)$/.exec(trimmed);
      if (m) {
        hubOwner = m[1].trim();
        continue;
      }
      if (line.startsWith("DIR\t")) {
        const [, name = "", state = "absent", owner = ""] = line.split("\t");
        if (name) dirs[name] = { state, owner: owner.trim() };
      }
      continue;
    }

    if (section === "ROSTER") {
      if (trimmed) rosterLines.push(line);
      continue;
    }
    if (section === "NOTICE") {
      if (trimmed) noticeLines.push(line);
      continue;
    }
    if (section === "PORTS") {
      if (line.startsWith("REG\t")) {
        const [, portText = "", owner = "", kind = "f", claimedAt = ""] = line.split("\t");
        const port = /^\d+$/.test(portText) ? toPort(portText) : null;
        if (port !== null) {
          ports.push({ port, owner: owner.trim(), regular: kind.trim() === "f", claimedAt: claimedAt.trim() || null });
        }
      }
      continue;
    }
    if (section === "LISTEN") {
      listenLines.push(line);
      continue;
    }
    if (section === "PUBKEYS") {
      if (line.startsWith("PUB\t")) {
        const [, u = "", pk = ""] = line.split("\t");
        if (isSafeClusterUser(u) && pk.trim()) pubkeys[u.trim()] = pk.trim();
      } else if (line.startsWith("SPOOF\t")) {
        const [, file = "", owner = "", action = ""] = line.split("\t");
        spoofs.push({ file, owner, action });
      }
      continue;
    }
    if (section === "ASSIGNED") {
      if (line.startsWith("ENC\t")) {
        const parts = line.split("\t");
        const u = parts[1] || "";
        const rawJson = parts.slice(2).join("\t");
        const parsed = safeJsonParse(rawJson);
        if (isSafeClusterUser(u) && parsed && typeof parsed === "object") {
          assigned[u.trim()] = parsed;
        }
      }
      continue;
    }
    if (section === "HEARTBEATS") {
      if (line.startsWith("HB\t")) {
        const parts = line.split("\t");
        const u = parts[1] || "";
        const rawJson = parts.slice(2).join("\t");
        const parsed = safeJsonParse(rawJson);
        if (isSafeClusterUser(u) && parsed && typeof parsed === "object") {
          heartbeats[u.trim()] = parsed;
        }
      } else if (line.startsWith("SPOOF\t")) {
        const [, file = "", owner = "", action = ""] = line.split("\t");
        spoofs.push({ file, owner, action });
      }
      continue;
    }
    if (section === "WHO") {
      if (isSafeClusterUser(trimmed)) sshUsers.add(trimmed);
      continue;
    }
    if (section === "AGENTS") {
      const [u = "", comm = "", countText = "0"] = line.split("\t");
      const count = Number.parseInt(countText, 10);
      if (isSafeClusterUser(u) && comm && Number.isFinite(count) && count > 0) {
        const userKey = u.trim();
        if (!agentProcs[userKey]) agentProcs[userKey] = {};
        agentProcs[userKey][comm.trim()] = (agentProcs[userKey][comm.trim()] || 0) + count;
      }
      continue;
    }
    if (section === "ROOTSCAN") {
      if (line.startsWith("ROOTSCAN\t")) {
        const [, u = "", homeBytes = "0", todayCalls = "0", todayTokens = "0", weekCalls = "0", weekTokens = "0", cx = "0", cl = "0"] = line.split("\t");
        if (isSafeClusterUser(u)) {
          rootScans[u.trim()] = {
            homeDirBytes: Number(homeBytes) || 0,
            todayCalls: Number(todayCalls) || 0,
            todayTokens: Number(todayTokens) || 0,
            weekCalls: Number(weekCalls) || 0,
            weekTokens: Number(weekTokens) || 0,
            codexInstalled: cx.trim() === "1",
            claudeInstalled: cl.trim() === "1",
          };
        }
      }
    }
  }

  ports.sort((a, b) => a.port - b.port);
  const roster = normalizeRosterObject(safeJsonParse(rosterLines.join("\n")));
  const notice = normalizeNoticeObject(safeJsonParse(noticeLines.join("\n")));
  const listening = parseListeningPorts(listenLines.join("\n"), REVERSE_PORT_LISTEN_RANGE);

  return {
    me,
    nowSec,
    sudoReady,
    hubBase,
    hubOwner,
    dirs,
    roster,
    notice,
    ports,
    listening,
    pubkeys,
    assigned,
    heartbeats,
    spoofs,
    sshUsers: [...sshUsers],
    agentProcs,
    rootScans,
  };
}

// 管理员原子写入 roster.json（正文经 stdin 送达）。
export function buildWriteRosterCommand(baseDir = DEFAULT_AGENT_HUB_DIR) {
  const b = assertHubBaseDir(baseDir);
  return wrapSh([
    `b=${shellSingleQuote(b)}`,
    "mkdir -m 0755 \"$b/admin\" \"$b/assigned\" 2>/dev/null || true",
    "mkdir -m 1777 \"$b/pubkeys\" \"$b/heartbeats\" \"$b/ports\" 2>/dev/null || true",
    "[ -d \"$b/admin\" ] && [ -w \"$b/admin\" ] || { echo WRITE_ROSTER=readonly; exit 0; }",
    "tmp=\"$b/admin/.roster.json.tmp.$$\"",
    "umask 022",
    "if cat > \"$tmp\" && [ -s \"$tmp\" ] && chmod 644 \"$tmp\" && mv -f \"$tmp\" \"$b/admin/roster.json\"; then",
    "  echo WRITE_ROSTER=ok",
    "else",
    "  rm -f \"$tmp\" 2>/dev/null || true",
    "  echo WRITE_ROSTER=failed",
    "fi",
    "exit 0",
  ]);
}

// 管理员原子写入团队置顶公告 admin/notice.json（正文经 stdin 送达）。
export function buildWriteNoticeCommand(baseDir = DEFAULT_AGENT_HUB_DIR) {
  const b = assertHubBaseDir(baseDir);
  return wrapSh([
    `b=${shellSingleQuote(b)}`,
    "mkdir -m 0755 \"$b/admin\" 2>/dev/null || true",
    "[ -d \"$b/admin\" ] && [ -w \"$b/admin\" ] || { echo WRITE_NOTICE=readonly; exit 0; }",
    "tmp=\"$b/admin/.notice.json.tmp.$$\"",
    "umask 022",
    "if cat > \"$tmp\" && [ -s \"$tmp\" ] && chmod 644 \"$tmp\" && mv -f \"$tmp\" \"$b/admin/notice.json\"; then",
    "  echo WRITE_NOTICE=ok",
    "else",
    "  rm -f \"$tmp\" 2>/dev/null || true",
    "  echo WRITE_NOTICE=failed",
    "fi",
    "exit 0",
  ]);
}

// 管理员清除团队置顶公告 admin/notice.json。
export function buildRemoveNoticeCommand(baseDir = DEFAULT_AGENT_HUB_DIR) {
  const b = assertHubBaseDir(baseDir);
  return wrapSh([
    `f=${shellSingleQuote(`${b}/admin/notice.json`)}`,
    "if [ ! -e \"$f\" ] && [ ! -L \"$f\" ]; then echo REMOVE_NOTICE=absent",
    "elif rm -f \"$f\" 2>/dev/null; then echo REMOVE_NOTICE=ok",
    "else echo REMOVE_NOTICE=failed",
    "fi",
    "exit 0",
  ]);
}

// 管理员原子写入加密配置信封 assigned/<user>.enc（正文经 stdin 送达）。
export function buildWriteAssignedCommand(baseDir = DEFAULT_AGENT_HUB_DIR, targetUser) {
  const b = assertHubBaseDir(baseDir);
  const u = assertSafeClusterUser(targetUser);
  return wrapSh([
    `b=${shellSingleQuote(b)}`,
    `u=${shellSingleQuote(u)}`,
    "mkdir -m 0755 \"$b/assigned\" 2>/dev/null || true",
    "[ -d \"$b/assigned\" ] && [ -w \"$b/assigned\" ] || { echo WRITE_ASSIGNED=readonly; exit 0; }",
    "tmp=\"$b/assigned/.$u.enc.tmp.$$\"",
    "umask 022",
    "if cat > \"$tmp\" && [ -s \"$tmp\" ] && chmod 644 \"$tmp\" && mv -f \"$tmp\" \"$b/assigned/$u.enc\"; then",
    "  echo WRITE_ASSIGNED=ok",
    "else",
    "  rm -f \"$tmp\" 2>/dev/null || true",
    "  echo WRITE_ASSIGNED=failed",
    "fi",
    "exit 0",
  ]);
}

// 管理员删除某成员的下发配置信封。
export function buildRemoveAssignedCommand(baseDir = DEFAULT_AGENT_HUB_DIR, targetUser) {
  const b = assertHubBaseDir(baseDir);
  const u = assertSafeClusterUser(targetUser);
  return wrapSh([
    `f=${shellSingleQuote(`${b}/assigned/${u}.enc`)}`,
    "if [ ! -e \"$f\" ] && [ ! -L \"$f\" ]; then echo REMOVE_ASSIGNED=absent",
    "elif rm -f \"$f\" 2>/dev/null; then echo REMOVE_ASSIGNED=ok",
    "else echo REMOVE_ASSIGNED=failed",
    "fi",
    "exit 0",
  ]);
}

// 管理员释放指定登记端口（优先普通 rm，若属主为 kai 目录则直接成功，否则尝试 helper / sudo -n）。
export function buildAdminReleasePortCommand(baseDir = DEFAULT_AGENT_HUB_DIR, port) {
  const b = assertHubBaseDir(baseDir);
  const p = toPort(port);
  if (p === null) throw new Error(`buildAdminReleasePortCommand: 非法端口 ${JSON.stringify(port)}`);
  return wrapSh([
    `b=${shellSingleQuote(b)}`,
    `p=${p}`,
    "f=\"$b/ports/$p\"",
    "hlp=/usr/local/bin/codex-team-admin-helper",
    "if [ ! -e \"$f\" ] && [ ! -L \"$f\" ]; then echo RELEASE=absent",
    "elif rm -f \"$f\" 2>/dev/null || { [ -x \"$hlp\" ] && sudo -n \"$hlp\" release-port \"$b\" \"$p\" 2>/dev/null; } || sudo -n rm -f \"$f\" 2>/dev/null; then echo RELEASE=ok",
    "else echo RELEASE=need-sudo",
    "fi",
    "exit 0",
  ]);
}

// 管理员强行终止集群上占用指定反向隧道端口（20000..39999）的卡死/僵尸 sshd 会话子进程。
export function buildAdminKillPortCommand(baseDir = DEFAULT_AGENT_HUB_DIR, port) {
  assertHubBaseDir(baseDir);
  const p = toPort(port);
  if (p === null || p < REVERSE_PORT_LISTEN_RANGE.min || p > REVERSE_PORT_LISTEN_RANGE.max) {
    throw new Error(`buildAdminKillPortCommand: 端口必须在 ${REVERSE_PORT_LISTEN_RANGE.min}..${REVERSE_PORT_LISTEN_RANGE.max} 范围内`);
  }
  return wrapSh([
    `p=${p}`,
    "hlp=/usr/local/bin/codex-team-admin-helper",
    "if [ -x \"$hlp\" ] && command -v sudo >/dev/null 2>&1 && sudo -n \"$hlp\" check >/dev/null 2>&1; then",
    "  sudo -n \"$hlp\" kill-port \"$p\" 2>/dev/null || echo KILL_PORT=failed",
    "  exit 0",
    "fi",
    "pids=$({ ss -ltnp 2>/dev/null; command -v sudo >/dev/null 2>&1 && sudo -n ss -ltnp 2>/dev/null; } | awk -v pat=\":$p$\" '$4 ~ pat { while (match($0, /pid=[0-9]+/)) { print substr($0, RSTART+4, RLENGTH-4); $0=substr($0, RSTART+RLENGTH) } }' | sort -u)",
    "if [ -z \"$pids\" ]; then",
    "  if ss -ltn 2>/dev/null | awk -v pat=\":$p$\" '$4 ~ pat { found=1 } END { exit !found }'; then",
    "    echo KILL_PORT=need-sudo",
    "  else",
    "    echo KILL_PORT=no-listener",
    "  fi",
    "  exit 0",
    "fi",
    "killed=0",
    "for pid in $pids; do",
    "  ppid=$(ps -o ppid= -p \"$pid\" 2>/dev/null | tr -d ' ' || true)",
    "  comm=$(ps -o comm= -p \"$pid\" 2>/dev/null | tr -d ' ' || true)",
    "  if [ -n \"$ppid\" ] && [ \"$ppid\" != \"1\" ] && [ \"$comm\" = \"sshd\" ]; then",
    "    if kill -TERM \"$pid\" 2>/dev/null || sudo -n kill -TERM \"$pid\" 2>/dev/null; then",
    "      killed=$((killed + 1))",
    "    fi",
    "  fi",
    "done",
    "if [ \"$killed\" -gt 0 ]; then echo \"KILL_PORT=ok:$killed\"; else echo KILL_PORT=need-sudo; fi",
    "exit 0",
  ]);
}

// 成员端单次只读探测命令：读取本人的 box.key、pubkeys/<me>.pub、admin/roster.json、admin/notice.json 与 assigned/<me>.enc。
export function buildMemberSyncReadCommand(baseDir = DEFAULT_AGENT_HUB_DIR) {
  const b = assertHubBaseDir(baseDir);
  return wrapSh([
    OWNER_FN,
    `b=${shellSingleQuote(b)}`,
    "me=$(id -un 2>/dev/null)",
    "printf 'ME=%s\\n' \"$me\"",
    "if [ -d \"$b\" ]; then echo HUB=present; else echo HUB=absent; exit 0; fi",
    "kf=\"$HOME/.config/cluster-workbench/box.key\"",
    "if [ -f \"$kf\" ] && [ ! -L \"$kf\" ]; then",
    "  printf 'BOX_KEY=%s\\n' \"$(head -c 256 \"$kf\" 2>/dev/null | tr -d '\\r\\n \\t')\"",
    "fi",
    "pf=\"$b/pubkeys/$me.pub\"",
    "if [ -f \"$pf\" ] && [ ! -L \"$pf\" ] && [ \"$(owner \"$pf\")\" = \"$me\" ]; then",
    "  printf 'PUB_KEY=%s\\n' \"$(head -c 256 \"$pf\" 2>/dev/null | tr -d '\\r\\n \\t')\"",
    "elif [ -e \"$pf\" ] || [ -L \"$pf\" ]; then",
    "  echo PUB_KEY=spoofed",
    "fi",
    "echo ROSTER-BEGIN",
    "[ -f \"$b/admin/roster.json\" ] && head -c 65536 \"$b/admin/roster.json\" 2>/dev/null || true",
    "echo",
    "echo ROSTER-END",
    "echo NOTICE-BEGIN",
    "[ -f \"$b/admin/notice.json\" ] && head -c 8192 \"$b/admin/notice.json\" 2>/dev/null || true",
    "echo",
    "echo NOTICE-END",
    "echo ASSIGNED-BEGIN",
    "[ -f \"$b/assigned/$me.enc\" ] && head -c 16384 \"$b/assigned/$me.enc\" 2>/dev/null | tr -d '\\r\\n' || true",
    "echo",
    "echo ASSIGNED-END",
    "exit 0",
  ]);
}

export function parseMemberSyncReadOutput(text) {
  const lines = String(text || "").split(/\r?\n/);
  let me = "";
  let hub = "unknown";
  let boxKey = "";
  let pubKey = "";
  const rosterLines = [];
  const noticeLines = [];
  const assignedLines = [];
  let section = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "ROSTER-BEGIN") {
      section = "ROSTER";
      continue;
    }
    if (trimmed === "ROSTER-END") {
      section = "";
      continue;
    }
    if (trimmed === "NOTICE-BEGIN") {
      section = "NOTICE";
      continue;
    }
    if (trimmed === "NOTICE-END") {
      section = "";
      continue;
    }
    if (trimmed === "ASSIGNED-BEGIN") {
      section = "ASSIGNED";
      continue;
    }
    if (trimmed === "ASSIGNED-END") {
      section = "";
      continue;
    }
    if (!section) {
      let m = /^ME=([A-Za-z0-9._-]+)$/.exec(trimmed);
      if (m) {
        me = m[1];
        continue;
      }
      m = /^HUB=(present|absent)$/.exec(trimmed);
      if (m) {
        hub = m[1];
        continue;
      }
      m = /^BOX_KEY=([A-Za-z0-9_-]+)$/.exec(trimmed);
      if (m) {
        boxKey = m[1];
        continue;
      }
      m = /^PUB_KEY=(.+)$/.exec(trimmed);
      if (m) {
        pubKey = m[1].trim();
      }
      continue;
    }
    if (section === "ROSTER" && trimmed) rosterLines.push(line);
    if (section === "NOTICE" && trimmed) noticeLines.push(line);
    if (section === "ASSIGNED" && trimmed) assignedLines.push(trimmed);
  }

  return {
    me,
    hub,
    boxKey,
    pubKey,
    roster: normalizeRosterObject(safeJsonParse(rosterLines.join("\n"))),
    notice: normalizeNoticeObject(safeJsonParse(noticeLines.join("\n"))),
    assignedEnvelope: safeJsonParse(assignedLines.join("")),
  };
}

// 成员端原子写入命令：将 box.key（0600，按需）、pubkeys/<me>.pub（0644，按需）与 heartbeats/<me>.json（0644）写到集群。
// 心跳正文通过标准输入送达；密钥串已通过严格 base64url 校验。
export function buildMemberSyncWriteCommand(baseDir = DEFAULT_AGENT_HUB_DIR, { privateKey = null, publicKey = null } = {}) {
  const b = assertHubBaseDir(baseDir);
  if (privateKey !== null && !/^[A-Za-z0-9_-]{40,160}$/.test(privateKey)) {
    throw new Error("buildMemberSyncWriteCommand: 非法的 privateKey 格式");
  }
  if (publicKey !== null && !/^[A-Za-z0-9_-]{40,128}$/.test(publicKey)) {
    throw new Error("buildMemberSyncWriteCommand: 非法的 publicKey 格式");
  }
  const steps = [
    OWNER_FN,
    `b=${shellSingleQuote(b)}`,
    "me=$(id -un 2>/dev/null)",
    "[ -n \"$me\" ] || { echo SYNC_WRITE=no-user; exit 0; }",
  ];
  if (privateKey) {
    steps.push(
      "mkdir -p -m 0700 \"$HOME/.config/cluster-workbench\" 2>/dev/null || true",
      "ktmp=\"$HOME/.config/cluster-workbench/.box.key.tmp.$$\"",
      `if ( umask 077; printf '%s\\n' ${shellSingleQuote(privateKey)} > "$ktmp" ) && chmod 600 "$ktmp" && mv -f "$ktmp" "$HOME/.config/cluster-workbench/box.key"; then`,
      "  echo BOX_KEY_WRITE=ok",
      "else",
      "  rm -f \"$ktmp\" 2>/dev/null || true",
      "  echo BOX_KEY_WRITE=failed",
      "fi",
    );
  }
  if (publicKey) {
    steps.push(
      "if [ -d \"$b/pubkeys\" ] && [ -w \"$b/pubkeys\" ]; then",
      "  pf=\"$b/pubkeys/$me.pub\"",
      "  ptmp=\"$b/pubkeys/.$me.pub.tmp.$$\"",
      "  if [ ! -e \"$pf\" ] || [ \"$(owner \"$pf\")\" = \"$me\" ]; then",
      `    if ( umask 022; printf '%s\\n' ${shellSingleQuote(publicKey)} > "$ptmp" ) && chmod 644 "$ptmp" && mv -f "$ptmp" "$pf"; then`,
      "      echo PUB_KEY_WRITE=ok",
      "    else",
      "      rm -f \"$ptmp\" 2>/dev/null || true",
      "      echo PUB_KEY_WRITE=failed",
      "    fi",
      "  else",
      "    echo PUB_KEY_WRITE=spoofed",
      "  fi",
      "fi",
    );
  }
  steps.push(
    "if [ -d \"$b/heartbeats\" ] && [ -w \"$b/heartbeats\" ]; then",
    "  hf=\"$b/heartbeats/$me.json\"",
    "  htmp=\"$b/heartbeats/.$me.json.tmp.$$\"",
    "  if [ ! -e \"$hf\" ] || [ \"$(owner \"$hf\")\" = \"$me\" ]; then",
    "    if ( umask 022; head -c 8192 > \"$htmp\" ) && [ -s \"$htmp\" ] && chmod 644 \"$htmp\" && mv -f \"$htmp\" \"$hf\"; then",
    "      echo HB_WRITE=ok",
    "    else",
    "      rm -f \"$htmp\" 2>/dev/null || true",
    "      echo HB_WRITE=failed",
    "    fi",
    "  else",
    "    cat >/dev/null",
    "    echo HB_WRITE=spoofed",
    "  fi",
    "else",
    "  cat >/dev/null",
    "  echo HB_WRITE=skipped",
    "fi",
    "exit 0",
  );
  return wrapSh(steps);
}

// 适配 parseRegistrySurvey：保持与旧端口登记调查结构兼容。
export { parseRegistrySurvey };
