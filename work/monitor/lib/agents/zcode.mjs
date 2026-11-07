// Zcode agent 适配器：zcode-status 单探针（一次 SSH 采集安装态 / 组件版本清单 /
// setting.json 代理配置 / zcode-server 进程）+ agentsStatus 合成。
//
// 只有配置 agents[] 里存在 kind:"zcode" 条目（且未被个人层 disabledModules 关闭）时
// 才注册探针、合成状态——默认配置（normalizeAgentConfig 只物化 codex / claude-codewing）
// 下行为零变化。门控由注册表 agentAdapterEnabled 统一判定。
//
// 远端事实（2026-09 对 myserver 只读侦察）：
// - zcode 没有 PATH 上的 CLI；安装体现为 ~/.zcode/server/zcode-server.cjs
//   （bundle）+ 自带 node。应用版本不落盘（ZCODE_VERSION 是桌面端拉起时传的
//   环境变量），服务端可采集的版本事实是 .asset-components/glm.json 清单
//   （内置 agent provider 版本，如 0.13.3）。
// - zcode-server 由 sshd 随桌面端会话按需拉起、不常驻——健康稳态下 ps 里
//   没有进程。因此进程存活只作信息展示，绝不参与降级判定（否则默认态即误报，
//   参见 v2.12 全红误报教训）。
// - 最有价值的探测项是配置漂移：~/.zcode/v2/setting.json 的 httpProxy 必须
//   指向反向隧道（http://127.0.0.1:<remotePort>），该字段丢失/漂移会让远程
//   会话 MODEL_TLS_VALIDATION_FAILED。期望值经 proxy-config.mjs 的
//   zcodeProxySettingsPatch 在本地推导比对——remotePort 不插值进远端命令串。

import { trimOutput } from "../../monitor-core.mjs";
import { isManagedProxyUrl, parseManagedProxyUrl } from "../cluster-env.mjs";
import { zcodeProxySettingsPatch } from "../proxy-config.mjs";
import { extractMarkerSection } from "./marker-section.mjs";

export const ZCODE_PROBE_ID = "zcode-status";

// 熔断占位输出：风格与 codex/reclaude 的占位文案一致。
const BREAKER_ZCODE_OUTPUT = "通道异常，已熔断跳过 zcode 检查";

// 远端命令是 100% 静态字符串：期望代理值在本地比对，无任何 JS 侧插值。
// 拼接风格沿用 codex/reclaude（`;` 连接、test && echo || echo 标记对），
// 不额外包括号（远端登录 shell 为 bash 时 ((...)) 会按算术表达式解析——v2.12 教训）。
// ps 段：管道内 grep 自身与承载本命令的 bash -c 行都含 "grep"，由 grep -v grep 剔除。
const REMOTE_COMMAND = [
  "echo __ZCODE_INSTALL_BEGIN__",
  "test -f ~/.zcode/server/zcode-server.cjs && echo __ZCODE_SERVER_PRESENT__ || echo __ZCODE_SERVER_ABSENT__",
  "echo __ZCODE_INSTALL_END__",
  "echo __ZCODE_MANIFEST_BEGIN__",
  "cat ~/.zcode/server/.asset-components/glm.json 2>/dev/null | head -c 2048 || true",
  "echo __ZCODE_MANIFEST_END__",
  "echo __ZCODE_SETTING_STATE_BEGIN__",
  "test -f ~/.zcode/v2/setting.json && echo __ZCODE_SETTING_PRESENT__ || echo __ZCODE_SETTING_ABSENT__",
  "echo __ZCODE_SETTING_STATE_END__",
  "echo __ZCODE_SETTING_BEGIN__",
  "cat ~/.zcode/v2/setting.json 2>/dev/null | head -c 16384 || true",
  "echo __ZCODE_SETTING_END__",
  "echo __ZCODE_PS_BEGIN__",
  "ps ax -o args= 2>/dev/null | grep zcode-server | grep -v grep | head -3 || true",
  "echo __ZCODE_PS_END__",
].join("; ");

function section(text, name) {
  return extractMarkerSection(text, `__ZCODE_${name}_BEGIN__`, `__ZCODE_${name}_END__`);
}

// 标记分段解析。installed / settingPresent 三值：true / false / null（标记缺失
// = SSH 未到达远端，调用方不得据此伪造「未安装」结论）。
export function parseZcodeSections(text = "") {
  const install = section(text, "INSTALL");
  const settingState = section(text, "SETTING_STATE");
  return {
    installed: install == null ? null : install.includes("__ZCODE_SERVER_PRESENT__"),
    manifestRaw: section(text, "MANIFEST") ?? "",
    settingPresent: settingState == null ? null : settingState.includes("__ZCODE_SETTING_PRESENT__"),
    settingRaw: section(text, "SETTING") ?? "",
    psRaw: section(text, "PS") ?? "",
  };
}

// 组件清单 → 版本文案（如 "glm 0.13.3"）。清单缺失/损坏 → null（前端「—」占位）。
export function parseZcodeManifestVersion(manifestRaw = "") {
  const raw = String(manifestRaw).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (typeof parsed.version !== "string" || !parsed.version) return null;
    const id = typeof parsed.id === "string" && parsed.id ? parsed.id : "zcode";
    return `${id} ${parsed.version}`;
  } catch {
    return null;
  }
}

// 代理配置判定（本地解析侧比对，远端命令不掺入期望值）。state 四态 + 缺字段：
//   ok            httpProxy 指向期望隧道地址
//   drifted       httpProxy 存在但指向别处（最典型：残留旧端口/直连地址）
//   missing-field 文件在但 httpProxy 缺失/空（与 drifted 同级降级，文案区分）
//   file-missing  setting.json 不存在
//   invalid-json  文件在但不是合法 JSON 对象
export function evaluateZcodeProxyConfig({ settingRaw, settingPresent, expected }) {
  if (settingPresent !== true) return { state: "file-missing", expected, actual: null };
  const raw = String(settingRaw ?? "").trim();
  if (!raw) return { state: "missing-field", expected, actual: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "invalid-json", expected, actual: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "invalid-json", expected, actual: null };
  }
  const actualRaw = typeof parsed.httpProxy === "string" ? parsed.httpProxy.trim() : "";
  if (!actualRaw) return { state: "missing-field", expected, actual: null };
  const normalize = (value) => value.replace(/\/+$/, "").toLowerCase();
  // 代理口令（v2.62）打开后，用户会手动把这里改成带口令的地址（工作台不自动改 zcode 的设置）：
  // 指向同一个端口、带的是我们那个用户名，同样算对，不报漂移。
  const expectedPort = parseManagedProxyUrl(normalize(expected))?.port ?? null;
  const ok = normalize(actualRaw) === normalize(expected) || (expectedPort !== null && isManagedProxyUrl(actualRaw.replace(/\/+$/, ""), expectedPort));
  // actual 会进探针输出与接口响应：地址里的口令（不管是谁的）一律打码之后才往外给。
  const actual = maskUrlPassword(actualRaw).slice(0, 120);
  return { state: ok ? "ok" : "drifted", expected, actual };
}

// 代理地址里的口令打码：scheme://用户:口令@主机 → scheme://用户:••••••@主机。
function maskUrlPassword(value) {
  return String(value).replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@:\s]*:)[^@/\s]*@/, "$1••••••@");
}

// zcode-server 进程存活（信息展示用，不参与判级——server 由会话按需拉起）。
export function parseZcodeServerProcess(psRaw = "") {
  const lines = String(psRaw)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("zcode-server"));
  return { running: lines.length > 0, count: lines.length };
}

// 降级根因文案（写入 buildStatus 的 degradedReason）。
function proxyDriftReason(proxyConfig) {
  if (!proxyConfig || proxyConfig.state === "ok") return null;
  if (proxyConfig.state === "file-missing") {
    return "降级：zcode 代理配置缺失（setting.json 不存在），远程会话将 TLS 失败";
  }
  if (proxyConfig.state === "invalid-json") {
    return "降级：zcode 代理配置损坏（setting.json 不是合法 JSON），远程会话将 TLS 失败";
  }
  return `降级：zcode 代理配置漂移（httpProxy 应为 ${proxyConfig.expected}），远程会话将 TLS 失败`;
}

function buildStatus(state) {
  const data = state.last;
  if (!data) {
    return { ok: false, health: "waiting", output: "检测中...", degradedReason: null };
  }
  const proxyConfig = data.proxyConfig || null;
  let health = "ready";
  if (!data.installed) health = "missing";
  else if (proxyConfig && proxyConfig.state !== "ok") health = "degraded";
  return {
    ok: health === "ready",
    health,
    installed: data.installed === true,
    version: data.version || null,
    serverRunning: data.serverRunning === true,
    proxyConfig,
    diagnosticLabel: "Zcode 代理配置",
    endpointLabel: "Zcode 模型代理",
    // 通用端点语义（前端 agentEndpointOk 的 agentsStatus[id].endpoint 回退路径）：
    // zcode 无独立端点探针，「端点可达」= 代理配置指向隧道（模型流量经
    // setting.json httpProxy 走反向隧道，配置对了链路可达性由通道层探针背书）。
    endpoint: {
      ok: data.installed === true ? (proxyConfig ? proxyConfig.state === "ok" : null) : null,
      output: proxyConfig
        ? `httpProxy=${proxyConfig.actual ?? "(未设置)"} 期望 ${proxyConfig.expected}`
        : "",
    },
    output: data.output || "",
    degradedReason: health === "degraded" ? proxyDriftReason(proxyConfig) : null,
  };
}

async function runZcodeStatusProbe(ctx) {
  const config = await ctx.getConfig();
  const main = ctx.getMainServerConfig(config);
  // 期望代理值只在本地推导（proxy-config.mjs 是引导写入与漂移检测的同一事实源）。
  // remotePort 已经 normalizeAgentConfig 收口为合法整数（没领端口时 probes/register.mjs 统一跳过
  // Agent 探针，走不到这里），但仍不进入远端命令串。
  const expected = zcodeProxySettingsPatch(main.remotePort).httpProxy;
  const { stdout, stderr, code } = await ctx.execFileCmd(
    "ssh",
    [...ctx.sshArgsFor(main, config), REMOTE_COMMAND],
    { timeoutMs: 25000, server: main },
  );
  const sections = parseZcodeSections(stdout || stderr);
  if (sections.installed === null) {
    // 标记全缺 = SSH 未到达远端（熔断门控下罕见）。data 置空让 onProbeResult
    // 保留上一轮事实，不把通道故障伪造成「未安装」。
    return {
      level: "error",
      reason: `zcode 探测未完成 (${ctx.probeSshFailureReason(code, stderr, stdout)})`,
      data: null,
    };
  }
  const version = parseZcodeManifestVersion(sections.manifestRaw);
  const proxyConfig = sections.installed
    ? evaluateZcodeProxyConfig({
        settingRaw: sections.settingRaw,
        settingPresent: sections.settingPresent,
        expected,
      })
    : null;
  const proc = parseZcodeServerProcess(sections.psRaw);
  const ok = sections.installed === true && proxyConfig !== null && proxyConfig.state === "ok";
  const level = !sections.installed ? "error" : (proxyConfig.state !== "ok" ? "warn" : "ok");
  const reason = !sections.installed
    ? "zcode 未安装（~/.zcode/server 缺失）"
    : proxyConfig.state !== "ok"
      ? `zcode 代理配置异常（${proxyConfig.state}，httpProxy 应为 ${expected}）`
      : `zcode 就绪（${version || "版本未知"}${proc.running ? "，server 运行中" : "，server 未拉起（会话按需启动）"}）`;
  // output 只透出蒸馏后的事实行（setting.json 原文不整体回显到前端）。
  const output = trimOutput([
    "$ test -f ~/.zcode/server/zcode-server.cjs",
    sections.installed ? "server bundle: present" : "server bundle: absent",
    "$ cat ~/.zcode/server/.asset-components/glm.json",
    version ? `manifest version: ${version}` : "manifest: 缺失或不可解析",
    "$ cat ~/.zcode/v2/setting.json  # httpProxy 漂移检测（本地比对）",
    proxyConfig
      ? `httpProxy: ${proxyConfig.actual ?? "(未设置)"} → 期望 ${expected}（${proxyConfig.state}）`
      : "(未安装，跳过)",
    "$ ps ax -o args= | grep zcode-server",
    proc.running
      ? `zcode-server 进程 ×${proc.count}`
      : "zcode-server 未在运行（由 sshd 随会话按需拉起，非故障）",
  ].join("\n"));
  return {
    level,
    reason,
    data: {
      ok,
      installed: sections.installed,
      version,
      proxyConfig,
      serverRunning: proc.running,
      processCount: proc.count,
      output,
    },
  };
}

export const zcodeAdapter = {
  kind: "zcode",
  agentId: "zcode",
  probeIds: [ZCODE_PROBE_ID],

  moduleHint: {
    description: "Zcode 安装态、代理配置漂移与进程检测",
    cost: "每 90 秒一次 SSH",
  },

  probeSpecs(ctx) {
    return [
      { id: ZCODE_PROBE_ID, intervalMs: 90000, timeoutMs: 30000, run: () => runZcodeStatusProbe(ctx) },
    ];
  },

  createInitialState() {
    return { last: null, skipped: false };
  },

  onProbeResult({ id, result, state, helpers }) {
    if (id !== ZCODE_PROBE_ID) return {};
    if (result.level === "skipped") {
      state.skipped = true;
      // 熔断轮只换占位输出，不改写既有事实（层级 skipped 由 isSkipped 决定）。
      return { status: { ...helpers.getPreviousStatus(), output: BREAKER_ZCODE_OUTPUT } };
    }
    state.skipped = false;
    // SSH 未到达远端（data 空）：保留上一轮事实，探针 error 已在 reason 里可见。
    if (!result.data) return {};
    state.last = result.data;
    return { status: buildStatus(state) };
  },

  buildStatus,

  isSkipped(state) {
    return state.skipped;
  },

  // 无 v1.5.2 旧字段；代理配置漂移不拖累全局健康聚合（绝不触发 down/全局 restart）。
  legacyFields() {
    return {};
  },

  healthInputs() {
    return {};
  },
};
