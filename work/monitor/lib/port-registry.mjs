// 反向端口登记（设计稿 2026-10-07 §5.A）：集群共享目录里"每个端口一个文件"，文件属主即身份。
//
// 为什么要登记：反向端口绑在登录节点的 127.0.0.1，节点上任何账号都能连。旧分配只看"当前谁在监听"
// （reverse-port.mjs 的 ss -ltn 探测），对方离线时端口看着空闲，分出去就是两人共用一个端口——
// 后上线的那个人的集群流量会从别人的电脑出网。登记目录把"谁拥有哪个端口"变成持久事实：
//   - 目录由管理员建一次：install -d -m 1777（人人可建文件；粘滞位保证谁也删不了别人的）；
//   - 领取 = 在目录里用 set -C（noclobber，底层 O_EXCL）原子创建 <端口号> 文件，失败即已被占；
//   - "我的端口" = 属主是自己的登记文件（stat 属主由内核记录，不可伪造；文件内容只作备注）。
//
// 本模块只有纯函数：远端脚本生成（POSIX sh，一次 SSH 完成，不依赖 jq）与输出解析。
// 真正的 SSH 调用、交互与写个人层在 scripts/setup/port-assignment.mjs。
import { parseListeningPorts, REVERSE_PORT_BASE, REVERSE_PORT_LISTEN_RANGE, REVERSE_PORT_SPAN } from "./reverse-port.mjs";
import { shellSingleQuote } from "./shell/quote.mjs";
// 远端脚本统一经 `sh -c '<脚本>'` 执行（对方登录 shell 可能是 bash / zsh / csh；for 通配无匹配、set -C
// 等语义以 sh 为准），换行按 csh 也能接受的续行写法拼接，见 shell/wrap-sh.mjs。
import { wrapSh } from "./shell/wrap-sh.mjs";
import { toPort } from "./validators.mjs";

export const DEFAULT_PORT_REGISTRY_DIR = "/public/agent-hub/ports";

// 一次领取最多尝试的候选数：领取脚本把候选端口逐个写进 for 列表，上限防止命令串无界增长。
// 候选按升序取前若干个；并发领取时被别人抢先的端口直接跳到下一个，64 个足够覆盖任何现实竞争。
export const MAX_CLAIM_CANDIDATES = 64;

// 登记目录只接受"安全字符的绝对路径"：会被插进远端脚本（虽然单引号包裹，仍按白名单收口）
// 与给管理员复制的命令。拒绝 `..` 段、根目录本身与空段。
const SAFE_DIR_RE = /^\/[A-Za-z0-9._/-]+$/;

export function normalizePortRegistryDir(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!SAFE_DIR_RE.test(trimmed)) return null;
  const segments = trimmed.split("/").slice(1);
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return trimmed;
}

// 团队层 config.json 可用 portRegistry.dir 覆盖默认目录（个人层不在 PERSONAL_FIELDS 里，改不动它）。
// 兼容模式下写坏时回落默认并 warn；portRegistry.required=true 时返回 null，
// 由向导/控制面 fail closed，避免在错误目录里完成一份看似成功的登记。
export function resolvePortRegistryDir(teamConfig, { warn = () => {} } = {}) {
  const raw = teamConfig?.portRegistry?.dir;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PORT_REGISTRY_DIR;
  const dir = normalizePortRegistryDir(raw);
  if (!dir) {
    warn(`portRegistry.dir ${JSON.stringify(raw)} 不是安全的绝对路径，已回落默认 ${DEFAULT_PORT_REGISTRY_DIR}`);
    // 发布配置可以要求登记目录不可用时 fail closed。错误路径若继续回落到
    // 默认目录，团队会以为在自定义目录里登记，实际上可能与另一套部署共用端口表。
    if (teamConfig?.portRegistry?.required === true) return null;
    return DEFAULT_PORT_REGISTRY_DIR;
  }
  return dir;
}

function assertRegistryDir(dir) {
  const normalized = normalizePortRegistryDir(dir);
  if (!normalized) throw new Error(`unsafe port registry dir: ${JSON.stringify(dir)}`);
  return normalized;
}

// 给管理员复制的建目录命令（root 只在这里出现一次，不进工作台）。
// 默认目录连同上级 /public/agent-hub 一起建成 1777：install -d 只把 -m 用在列出的目录上。
// readonly（目录在、但当前账号写不进去）给 chmod；缺粘滞位同样是 chmod 1777。
export function buildRegistryAdminCommand(dir = DEFAULT_PORT_REGISTRY_DIR, { state = "absent" } = {}) {
  const d = assertRegistryDir(dir);
  if (state === "readonly" || state === "no-sticky") return `sudo chmod 1777 ${d}`;
  if (d === DEFAULT_PORT_REGISTRY_DIR) {
    const parent = d.slice(0, d.lastIndexOf("/"));
    return `sudo install -d -m 1777 ${parent} ${d}`;
  }
  return `sudo install -d -m 1777 ${d}`;
}

// 远端公共片段：属主查询。GNU stat 优先，不支持 -c 时退回 ls -ld 的第三列。
const OWNER_FN = "owner() { stat -c %U \"$1\" 2>/dev/null || ls -ld \"$1\" | awk '{print $3}'; }";

// 一次 SSH 拿齐分配端口要的全部事实：
//   REGISTRY=ok|absent|readonly   目录是否存在、当前账号能否在里面建文件
//   STICKY=1|0                    目录是否带粘滞位（没有 = 别人能删你的登记文件）
//   REG<TAB>端口<TAB>属主<TAB>f|x   每个已登记端口；f = 普通文件，x = 其他（符号链接等，只算占用不算归属）
//   ME=<用户名>                    当前账号（判定"我的端口"）
//   LISTEN-BEGIN … LISTEN-END      原样的 ss -ltn 输出（ss 缺失时为空），本机按反向端口段解析
export function buildRegistrySurveyCommand(dir = DEFAULT_PORT_REGISTRY_DIR) {
  const d = assertRegistryDir(dir);
  return wrapSh([
    OWNER_FN,
    `d=${shellSingleQuote(d)}`,
    "if [ -d \"$d\" ]; then",
    "  if [ -w \"$d\" ] && [ -x \"$d\" ]; then echo REGISTRY=ok; else echo REGISTRY=readonly; fi",
    "  if [ -k \"$d\" ]; then echo STICKY=1; else echo STICKY=0; fi",
    "  for f in \"$d\"/*; do",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是远端 sh 的参数展开（取文件名），不是 JS 模板
    "    n=${f##*/}",
    "    case $n in ''|*[!0-9]*) continue;; esac",
    "    [ -e \"$f\" ] || [ -L \"$f\" ] || continue",
    "    if [ -f \"$f\" ] && [ ! -L \"$f\" ]; then k=f; else k=x; fi",
    "    printf 'REG\\t%s\\t%s\\t%s\\n' \"$n\" \"$(owner \"$f\")\" \"$k\"",
    "  done",
    "else",
    "  echo REGISTRY=absent",
    "fi",
    "printf 'ME=%s\\n' \"$(id -un)\"",
    "echo LISTEN-BEGIN",
    "command -v ss >/dev/null 2>&1 && ss -ltn",
    "echo LISTEN-END",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 远端 sh 参数展开（取父目录）
    "rf=\"${d%/*}/admin/roster.json\"",
    "if [ -f \"$rf\" ] && [ ! -L \"$rf\" ]; then",
    "  echo ROSTER-BEGIN",
    "  head -c 65536 \"$rf\" 2>/dev/null || true",
    "  echo \"\"",
    "  echo ROSTER-END",
    "fi",
    "exit 0",
  ]);
}

// 纯函数：解析 survey 输出。registry 缺失（SSH 失败 / 输出被截断）记为 "unknown"——
// 调用方不得把 unknown 当成 absent 回落旧分配：目录可能存在，只是这次没读到。
export function parseRegistrySurvey(text) {
  const lines = String(text || "").split(/\r?\n/);
  let registry = "unknown";
  let sticky = null;
  let me = "";
  const entries = [];
  const listenLines = [];
  const rosterLines = [];
  let inListen = false;
  let inRoster = false;
  for (const line of lines) {
    if (inListen) {
      if (line.trim() === "LISTEN-END") inListen = false;
      else listenLines.push(line);
      continue;
    }
    if (inRoster) {
      if (line.trim() === "ROSTER-END") inRoster = false;
      else rosterLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "LISTEN-BEGIN") {
      inListen = true;
      continue;
    }
    if (trimmed === "ROSTER-BEGIN") {
      inRoster = true;
      continue;
    }
    let m = /^REGISTRY=(ok|absent|readonly)$/.exec(trimmed);
    if (m) {
      registry = m[1];
      continue;
    }
    m = /^STICKY=([01])$/.exec(trimmed);
    if (m) {
      sticky = m[1] === "1";
      continue;
    }
    m = /^ME=([\w.-]+)$/.exec(trimmed);
    if (m) {
      me = m[1];
      continue;
    }
    if (line.startsWith("REG\t")) {
      const [, portText, owner = "", kind = "f"] = line.split("\t");
      const port = /^\d+$/.test(portText || "") ? toPort(portText) : null;
      if (port === null) continue;
      entries.push({ port, owner: owner.trim(), regular: kind.trim() === "f" });
    }
  }
  entries.sort((a, b) => a.port - b.port);
  const out = {
    registry,
    sticky,
    me,
    entries,
    listening: parseListeningPorts(listenLines.join("\n"), REVERSE_PORT_LISTEN_RANGE),
  };
  if (rosterLines.length > 0) {
    try {
      const parsed = JSON.parse(rosterLines.join("\n").trim());
      if (parsed && typeof parsed.members === "object" && !Array.isArray(parsed.members)) {
        let rosterAssignedPort = null;
        const rosterOtherPorts = [];
        for (const [user, info] of Object.entries(parsed.members)) {
          const p = toPort(info?.assignedPort);
          if (p === null) continue;
          if (me && user === me) rosterAssignedPort = p;
          else rosterOtherPorts.push(p);
        }
        out.rosterAssignedPort = rosterAssignedPort;
        out.rosterOtherPorts = rosterOtherPorts;
      }
    } catch {}
  }
  return out;
}

// 属主是自己、且是普通文件的登记端口（升序）。me 为空（没读到用户名）时一律视为没有。
export function ownRegisteredPorts(survey) {
  const me = survey?.me;
  if (!me) return [];
  return (survey.entries || []).filter((e) => e.regular && e.owner === me).map((e) => e.port);
}

// 某个端口的登记属主（没登记返回 null）。
export function registeredOwnerOf(survey, port) {
  return (survey?.entries || []).find((e) => e.port === port)?.owner ?? null;
}

// 纯函数：领取候选。区间沿用 reverse-port.mjs 的 (BASE, BASE+SPAN]，即 7892–8891——
// 团队基准端口 7891 本身永远不是候选（只能由它的主人手动登记）。
// 排除 已登记 ∪ 正在监听 ∪ 保留（团队配置里写死的 remotePort 等）三者并集，升序取前 limit 个。
export function pickClaimCandidates({
  registered = [],
  listening = [],
  reserved = [],
  base = REVERSE_PORT_BASE,
  span = REVERSE_PORT_SPAN,
  limit = MAX_CLAIM_CANDIDATES,
} = {}) {
  const taken = new Set();
  for (const p of [...(registered || []), ...(listening || []), ...(reserved || [])]) {
    const port = toPort(typeof p === "object" && p !== null ? p.port : p);
    if (port !== null) taken.add(port);
  }
  const out = [];
  for (let p = base + 1; p <= base + span && out.length < limit; p++) {
    if (!taken.has(p)) out.push(p);
  }
  return out;
}

// 按顺序尝试原子领取候选端口，首个成功即输出 `CLAIMED <端口>` 退出；全部被占输出 `EXHAUSTED`。
// 目录不存在 / 不可写时只输出 REGISTRY=absent|readonly（调用方据此回落旧分配）。
// 每个候选：已存在（含符号链接）直接跳过 → 子 shell 里 umask 022 + set -C 写入（O_EXCL，
// 并发的两个人至多一个成功）→ 复核"是普通文件、不是链接、属主是我"才算领到。复核挡住的是
// noclobber 对非普通文件（如指向 /dev/null 的链接）放行写入的边角：那种情况下文件并不归我。
export function buildClaimCommand(dir = DEFAULT_PORT_REGISTRY_DIR, candidates = []) {
  const d = assertRegistryDir(dir);
  const ports = [];
  for (const c of candidates || []) {
    const port = toPort(c);
    if (port !== null && !ports.includes(port)) ports.push(port);
    if (ports.length >= MAX_CLAIM_CANDIDATES) break;
  }
  if (ports.length === 0) throw new Error("buildClaimCommand: 没有可尝试的候选端口");
  return wrapSh([
    OWNER_FN,
    `d=${shellSingleQuote(d)}`,
    "[ -d \"$d\" ] || { echo REGISTRY=absent; exit 0; }",
    "[ -w \"$d\" ] && [ -x \"$d\" ] || { echo REGISTRY=readonly; exit 0; }",
    "me=$(id -un)",
    "now=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    `for p in ${ports.join(" ")}; do`,
    "  f=\"$d/$p\"",
    "  if [ -e \"$f\" ] || [ -L \"$f\" ]; then continue; fi",
    "  if ( umask 022; set -C; printf 'user=%s\\nclaimedAt=%s\\n' \"$me\" \"$now\" > \"$f\" ) 2>/dev/null; then",
    "    if [ -f \"$f\" ] && [ ! -L \"$f\" ] && [ \"$(owner \"$f\")\" = \"$me\" ]; then",
    "      chmod 644 \"$f\" 2>/dev/null",
    "      echo \"CLAIMED $p\"",
    "      exit 0",
    "    fi",
    "  fi",
    "done",
    "echo EXHAUSTED",
    "exit 0",
  ]);
}

// 纯函数：领取结果。status ∈ claimed | exhausted | absent | readonly | unknown（SSH 失败 / 输出异常）。
export function parseClaimResult(text) {
  const out = String(text || "");
  const claimed = /^CLAIMED (\d+)\s*$/m.exec(out);
  if (claimed) {
    const port = toPort(claimed[1]);
    if (port !== null) return { status: "claimed", port };
  }
  if (/^EXHAUSTED\s*$/m.test(out)) return { status: "exhausted" };
  const registry = /^REGISTRY=(absent|readonly)\s*$/m.exec(out);
  if (registry) return { status: registry[1] };
  return { status: "unknown" };
}

// 释放：只删"普通文件且属主是我"的那个端口文件（粘滞位目录里本来也删不了别人的，这里先判一道给出明确结论）。
// 输出 RELEASE=ok | absent | not-owner | failed。
export function buildReleaseCommand(dir = DEFAULT_PORT_REGISTRY_DIR, port) {
  const d = assertRegistryDir(dir);
  const p = toPort(port);
  if (p === null) throw new Error(`buildReleaseCommand: 非法端口 ${JSON.stringify(port)}`);
  return wrapSh([
    OWNER_FN,
    `f=${shellSingleQuote(`${d}/${p}`)}`,
    "me=$(id -un)",
    "if [ ! -e \"$f\" ] && [ ! -L \"$f\" ]; then echo RELEASE=absent",
    "elif [ -f \"$f\" ] && [ ! -L \"$f\" ] && [ \"$(owner \"$f\")\" = \"$me\" ]; then",
    "  if rm -f \"$f\"; then echo RELEASE=ok; else echo RELEASE=failed; fi",
    "else echo RELEASE=not-owner",
    "fi",
    "exit 0",
  ]);
}

export function parseReleaseResult(text) {
  const m = /^RELEASE=(ok|absent|not-owner|failed)\s*$/m.exec(String(text || ""));
  return { status: m ? m[1] : "unknown" };
}
