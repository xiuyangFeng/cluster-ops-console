// Codex agent 适配器：doctor / endpoint 两枚探针 + agentsStatus 合成。
// 探针命令与解析逻辑自 probes.mjs 原样搬入（v1.5.2 语义），归并逻辑自
// state-store.mjs 原样搬入——本文件只是收拢差异点，行为逐字节不变。

import {
  buildCodexAgentStatus,
  isEndpointReachable,
  parseDoctorSummary,
  trimOutput,
} from "../../monitor-core.mjs";
import { parseAgentExpiry } from "../agent-creds.mjs";
import { buildOffPathLocateCommand, normalizeOffPath, OFF_PATH_ADVICE, offPathSummary } from "../cli/detect.mjs";
import { CURL_STDIN_CONFIG_FLAG, curlProxyAuthInput, remoteProxyEnv } from "../egress/remote-proxy-auth.mjs";
import { classifySshFailure } from "../ssh-args.mjs";
import {
  APP_SERVER_BEGIN_MARKER,
  APP_SERVER_END_MARKER,
  APP_SERVER_READ_COMMAND,
  appServerWarning,
  parseAppServerSection,
  summarizeAppServer,
} from "./app-server.mjs";
import { extractMarkerSection } from "./marker-section.mjs";
import { createSteadyInterval, STEADY_ACTIVE_INTERVAL_MS, STEADY_AFTER_OK_STREAK, STEADY_IDLE_INTERVAL_MS } from "./steady-interval.mjs";

const EMPTY_SUMMARY = { ok: 0, fail: 0, warn: 0, notes: 0, raw: "" };

// doctor 自适应节奏常量（导出供测试与文档引用）。口径在 steady-interval.mjs，与 claude-code 探针共用。
export const DOCTOR_ACTIVE_INTERVAL_MS = STEADY_ACTIVE_INTERVAL_MS;
export const DOCTOR_IDLE_INTERVAL_MS = STEADY_IDLE_INTERVAL_MS;
export const DOCTOR_IDLE_AFTER_OK_STREAK = STEADY_AFTER_OK_STREAK;

// 熔断占位输出：与 v1.5.2 低频轮询跳过时写入 globalStateCache 的字符串逐字一致。
const BREAKER_DOCTOR_OUTPUT = "通道异常，已熔断跳过检查";
const BREAKER_ENDPOINT_OUTPUT = "通道异常，已熔断跳过检查";

export const CODEX_NOT_INSTALLED_MARKER = "__CODEX_NOT_INSTALLED__";
export const CODEX_NOT_INSTALLED_TEXT = "codex 未安装（可在 配置 → 命令行工具 安装）";
// 装了，但非交互 SSH 的 PATH 里找不到：`__CODEX_OFF_PATH__=~/<相对路径>` 一行。
export const CODEX_OFF_PATH_MARKER = "__CODEX_OFF_PATH__";
const OFF_PATH_LINE_RE = new RegExp(`^${CODEX_OFF_PATH_MARKER}=(.*)$`, "m");

// PATH 里找不到 codex 之后的那一步：按 CLI 探测同一份候选清单（remote/cli-probe.sh，经 lib/cli/detect.mjs）
// 再找一遍——找到 → 报「装在哪」；没找到 → 才是未安装。
// 评审后续（v2.57）：此前这里只有「未安装」一种结论。把 codex 装在 nvm / npm 自定义前缀等只有交互 shell
// 的 PATH 里才有的位置的人，doctor 根本跑不起来（exit 127），却被归成中性的「未安装」——卡片不黄不红，
// PATH 问题被藏了起来。清单读不出来时退回旧行为（只报未安装）。
function missingCodexCommand() {
  const locate = buildOffPathLocateCommand("codex");
  if (!locate) return `echo ${CODEX_NOT_INSTALLED_MARKER}`;
  return `{ __CODEX_OFF__=$(${locate}); if [ -n "$__CODEX_OFF__" ]; then echo "${CODEX_OFF_PATH_MARKER}=$__CODEX_OFF__"; else echo ${CODEX_NOT_INSTALLED_MARKER}; fi; }`;
}

// v1.5.2 runDoctor。
// doctor 带隧道代理运行（v2.35.1）：与用户交互式终端里的 codex 同一联网环境。此前不带代理，
// reachability 直连外网恒失败，Codex 卡片与注意力队列常年挂着一条并不影响使用的「Doctor 1 项失败」。
// best-effort 追加读取 ~/.codex/auth.json（凭证过期呈现用），用 exit 码透传保住
// codex doctor 自身退出码：附加读取失败/文件不存在都不影响 level 判定。
// 代理口令（v2.62）不是关时，口令经标准输入的第一行交给远端 shell，由它拼进环境变量——命令文本里只有变量名
// （集群上别人用 ps 看得到命令行）。口令是关时 proxyEnv.prelude 为空、prefix 就是原来那串，整条命令逐字不变。
async function runDoctorProbe(ctx) {
  const config = await ctx.getConfig();
  const main = ctx.getMainServerConfig(config);
  const proxyEnv = remoteProxyEnv(main.remotePort, { credential: ctx.getProxyCredential?.() ?? null });
  const command = [
    `${proxyEnv.prelude}PATH="$HOME/.local/bin:$PATH" ${proxyEnv.prefix}codex doctor --summary --ascii`,
    "__CODEX_DOCTOR_EXIT__=$?",
    // v2.57 安装态：codex 没装是中性事实（组里有人只用 Claude），不能当 doctor 失败立案。
    // 先判可执行文件在不在 doctor 用的那份 PATH 里（~/.local/bin 是官方独立安装的入口，非交互 PATH 不含它）；
    // 不在 → 再分清是「装在别处」还是「真没装」（missingCodexCommand）。
    `test -x "$HOME/.local/bin/codex" || command -v codex >/dev/null 2>&1 || ${missingCodexCommand()}`,
    "echo __CODEX_AUTH_BEGIN__",
    // B3：真实 auth.json ~4.4KB，旧的 head -c 2048 会把 JSON 拦腰截断成非法片段，
    // 使 parseAgentExpiry 恒返回 unknown。16384 足够覆盖真实体量且仍是安全上限。
    "cat ~/.codex/auth.json 2>/dev/null | head -c 16384 || true",
    "echo __CODEX_AUTH_END__",
    // v2.85：顺带读桌面端常驻 app-server 的代理端口（同一次 SSH，不新增探针）。
    // 它把启动时的 HTTPS_PROXY 定住了；换过隧道端口后仍走旧端口 → 桌面端发消息没有回复。
    `echo ${APP_SERVER_BEGIN_MARKER}`,
    APP_SERVER_READ_COMMAND,
    `echo ${APP_SERVER_END_MARKER}`,
    'exit "$__CODEX_DOCTOR_EXIT__"',
  ].join("; ");
  const { stdout, stderr, code } = await ctx.execFileCmd(
    "ssh",
    [...ctx.sshArgsFor(main, config), command],
    { timeoutMs: 35000, server: main, ...(proxyEnv.input !== null ? { input: proxyEnv.input } : {}) },
  );
  const markerIdx = stdout.indexOf("__CODEX_AUTH_BEGIN__");
  // doctorOutput 只保留 auth 标记之前的内容：summary 解析/展示 output 都不掺入凭证原文。
  const beforeAuth = markerIdx === -1 ? stdout : stdout.slice(0, markerIdx);
  const appServer = summarizeAppServer(
    parseAppServerSection(extractMarkerSection(stdout, APP_SERVER_BEGIN_MARKER, APP_SERVER_END_MARKER)),
    main.remotePort,
  );
  const appServerWarn = appServerWarning(appServer);
  const offPath = normalizeOffPath(OFF_PATH_LINE_RE.exec(beforeAuth)?.[1]);
  if (offPath) {
    // 装了但 doctor 跑不起来：不是中性事实，也不是 codex 自身的故障——如实说「装在哪、为什么看不到、怎么办」，
    // 记 warn（卡片转黄、进注意力队列）。端点探针照常跑：这个人是在用 codex 的。凭证过期照常解析。
    const authRaw = extractMarkerSection(stdout, "__CODEX_AUTH_BEGIN__", "__CODEX_AUTH_END__") ?? "";
    const reason = offPathSummary("codex", offPath);
    return {
      level: "warn",
      reason,
      data: {
        ok: false,
        offPath,
        code,
        summary: { ...EMPTY_SUMMARY },
        output: `${reason}，Doctor 无法运行。\n${OFF_PATH_ADVICE}`,
        expiry: parseAgentExpiry({ kind: "codex", raw: authRaw, now: Date.now() }),
        appServer,
      },
    };
  }
  if (beforeAuth.includes(CODEX_NOT_INSTALLED_MARKER)) {
    // 未安装：探针本身成功（level ok），不产生告警事实；状态合成为中性的 not-installed。
    return {
      level: "ok",
      reason: CODEX_NOT_INSTALLED_TEXT,
      data: { ok: false, notInstalled: true, code, summary: { ...EMPTY_SUMMARY }, output: CODEX_NOT_INSTALLED_TEXT, expiry: null, appServer },
    };
  }
  const doctorOutput = beforeAuth;
  // 凭证文件原文（可能含敏感内容）单独取出，绝不混入面向前端展示的 output 字段。
  const authRaw = extractMarkerSection(stdout, "__CODEX_AUTH_BEGIN__", "__CODEX_AUTH_END__") ?? "";
  const summary = parseDoctorSummary(doctorOutput);
  const ok = code === 0;
  // warn 是建议级（rollout 文件缺失/可更新等），不影响使用，不再把探针层级压成
  // warn——否则链路节点/清单常年黄色。warn 明细在 summary.warnItems 里供前端展示。
  // v2.85 例外：app-server 代理端口漂移会让桌面端完全收不到回复，是真正的告警；
  // 这一轮记 warn，也让 doctor 的自适应节奏回到 90 秒，端口一换就能尽快发现。
  const level = !ok || summary.fail > 0 ? "error" : appServerWarn ? "warn" : "ok";
  // 凭证过期是只读附加信息：解析不出时 parseAgentExpiry 自身降级为 level:"unknown"，
  // 不改变上面已经算出的 doctor level/reason。
  const expiry = parseAgentExpiry({ kind: "codex", raw: authRaw, now: Date.now() });
  const baseReason = ok
    ? summary.raw || "doctor 通过"
    : (classifySshFailure(`${stderr || ""}\n${stdout || ""}`)
      ? ctx.probeSshFailureReason(code, stderr, stdout)
      : `doctor 退出码 ${code}`);
  return {
    level,
    reason: ok && appServerWarn ? appServerWarn.replace(/^降级：/, "") : baseReason,
    data: {
      ok,
      code,
      summary,
      output: trimOutput([doctorOutput || stderr, ok && appServerWarn ? `[app-server] ${appServerWarn}` : ""].filter(Boolean).join("\n\n")),
      expiry,
      appServer,
    },
  };
}

// 请求往返耗时：curl 用 -w 在全部输出之后补一行 `rtt=<秒>`（失败时是等到放弃为止的时间），
// 远端 sed 留前 14 行外加这一行。这里把它从原文里拆出来：标记行不进展示用的输出，
// 也不参与可达性判定。没有标记（SSH 没连上、curl 没跑起来）时 latencyMs 为 null。
const RTT_LINE_RE = /^rtt=([\d.,]+)[ \t]*$/m;

export function splitEndpointRtt(stdout = "") {
  const text = String(stdout ?? "");
  const match = RTT_LINE_RE.exec(text);
  if (!match) return { latencyMs: null, output: text };
  const seconds = Number.parseFloat(match[1].replace(",", "."));
  return {
    latencyMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
    output: text.replace(/^rtt=[^\r\n]*(?:\r?\n|$)/m, ""),
  };
}

// 端点探测的远端命令。不带口令时与一直以来的那条逐字相同（代理地址在环境变量里）。带口令（v2.62）时
// 改成 `-x 地址 -K -`：口令作为一行 curl 配置经标准输入送达，不进命令行；-x 在命令行上，对方 ~/.curlrc 里
// 写的代理地址也盖不过它。→ { command, input }
export function buildEndpointInvocation(remotePort, credential = null) {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是远端 sed 的 `15,$` 地址加花括号命令块，不是 JS 模板
  const tail = "-I --connect-timeout 10 -w 'rtt=%{time_total}\\n' https://chatgpt.com/backend-api/codex/responses 2>&1 | sed -n -e '1,14p' -e '15,${/^rtt=/p;}'";
  const input = curlProxyAuthInput(credential);
  if (input === null) return { command: `HTTP_PROXY=http://127.0.0.1:${remotePort} HTTPS_PROXY=http://127.0.0.1:${remotePort} curl ${tail}`, input: null };
  return { command: `curl -x http://127.0.0.1:${remotePort} ${CURL_STDIN_CONFIG_FLAG} ${tail}`, input };
}

// v1.5.2 checkEndpoint（v2.45 起多带一个请求往返耗时，命令仍是只读的一次 HEAD）。
async function runEndpointProbe(ctx) {
  const config = await ctx.getConfig();
  const main = ctx.getMainServerConfig(config);
  const { command, input } = buildEndpointInvocation(main.remotePort, ctx.getProxyCredential?.() ?? null);
  const { stdout, stderr, code } = await ctx.execFileCmd(
    "ssh",
    [...ctx.sshArgsFor(main, config), command],
    { timeoutMs: 15000, server: main, ...(input !== null ? { input } : {}) },
  );
  const { latencyMs, output } = splitEndpointRtt(stdout);
  const ok = isEndpointReachable(output);
  return {
    level: ok ? "ok" : "error",
    reason: ok ? "端点可达" : `端点探测未通过 (${ctx.probeSshFailureReason(code, stderr, output)})`,
    data: { ok, code, latencyMs, output: trimOutput(output) },
  };
}

// 降级根因文案（前端 degradedReasonText 直接展示，严重优先：
// fail > 端点 > app-server 代理端口漂移 > warn）。非降级/推不出返回 null，前端回落到层级 reason。
function degradedReason(detail) {
  const summary = detail?.summary || {};
  if ((Number(summary.fail) || 0) > 0) return `降级：Doctor 报 ${summary.fail} 项失败`;
  if (detail?.endpoint && detail.endpoint.ok === false) return "降级：端点探测未通过";
  const appServer = appServerWarning(detail?.appServer);
  if (appServer) return appServer;
  if ((Number(summary.warn) || 0) > 0) return `降级：Doctor 报 ${summary.warn} 项警告`;
  return null;
}

function buildStatus(state) {
  const entry = buildCodexAgentStatus(state.doctor, state.endpoint);
  const appServer = state.doctor?.appServer || null;
  const detail = { ...entry, appServer };
  // v2.57：未安装是中性状态（灰色「未安装」）——不计入整体健康、不立案；端点检测同时暂停。
  if (state.doctor?.notInstalled === true) {
    return { ...entry, ok: false, health: "not-installed", installed: false, appServer, degradedReason: null };
  }
  // 装了但非交互 SSH 的 PATH 里找不到：黄色，根因行直接说出来（offPath 供前端详情给处理建议）。
  // installed 保持 entry 里的 false——对工作台而言它不可用（就绪度仍归到「未安装或找不到」）。
  if (state.doctor?.offPath) {
    return {
      ...entry,
      ok: false,
      health: "degraded",
      offPath: state.doctor.offPath,
      appServer,
      degradedReason: `降级：已安装在 ${state.doctor.offPath}，但非交互 SSH 的 PATH 里找不到`,
    };
  }
  // v2.85：桌面端常驻 app-server 仍走旧代理端口——doctor 也许全绿、端点也通，但桌面端发消息
  // 会一直没有回复。单独判 degraded，让卡片转黄、进注意力队列；根因优先于普通 doctor warn。
  const appServerWarn = appServerWarning(appServer);
  return {
    ...entry,
    ok: appServerWarn ? false : entry.ok,
    appServer,
    health: appServerWarn ? "degraded" : entry.health,
    degradedReason: entry.health === "degraded" || appServerWarn ? degradedReason(detail) : null,
  };
}

export const codexAdapter = {
  kind: "codex",
  agentId: "codex",
  probeIds: ["doctor", "endpoint"],
  moduleHint: {
    description: "Codex Doctor 自检与 ChatGPT Codex API 端点检测",
    cost: "每 90 秒两次 SSH（稳态 doctor 降到 5 分钟）",
  },

  // 探针定义（间隔与规格 3.2 表格一致）；layer/usesSsh/熔断门控由注册方统一补齐。
  probeSpecs(ctx) {
    // v2.16 doctor 自适应降频：远端跑完整 `codex doctor` 是全站最重的探针（SSH +
    // CLI 全量自检），而 myserver 常年高负载。健康稳态（连续 ≥3 轮 ok）退到 5 分钟，
    // 任何非 ok（error/超时/熔断 skipped）立即回 90 秒快节奏；通道恢复 ok 时由
    // monitor-server 的 STATUS_CHANGED 监听 forceRun("doctor") 插队一次，不必等窗口。
    // 规则本体在 steady-interval.mjs（claude-code 探针同一套）；每次 probeSpecs() 一份独立的连击计数。
    // 最近一轮 doctor 判定 codex 未安装：端点探针随之暂停（ChatGPT 端点对只用 Claude 的人没有意义，
    // 不该因它告警）；装上后下一轮 doctor 即恢复。
    let codexNotInstalled = false;
    return [
      {
        id: "doctor",
        intervalMs: createSteadyInterval(),
        timeoutMs: 40000,
        run: async () => {
          const result = await runDoctorProbe(ctx);
          codexNotInstalled = result?.data?.notInstalled === true;
          return result;
        },
      },
      {
        id: "endpoint",
        intervalMs: 90000,
        timeoutMs: 20000,
        run: () => (codexNotInstalled
          ? { level: "ok", reason: "codex 未安装，跳过端点检测", data: { ok: null, notInstalled: true, code: 0, latencyMs: null, output: CODEX_NOT_INSTALLED_TEXT } }
          : runEndpointProbe(ctx)),
      },
    ];
  },

  createInitialState() {
    return {
      doctor: { ok: false, summary: { ...EMPTY_SUMMARY }, output: "检测中..." },
      endpoint: { ok: false, output: "检测中..." },
      doctorSkipped: false,
      endpointSkipped: false,
    };
  },

  onProbeResult({ id, result, state, helpers }) {
    const data = result.data || null;
    const patch = {};
    if (id === "doctor") {
      if (result.level === "skipped") {
        state.doctorSkipped = true;
        state.doctor = { ok: false, summary: { ...EMPTY_SUMMARY }, output: BREAKER_DOCTOR_OUTPUT };
      } else {
        state.doctorSkipped = false;
        state.doctor = data || { ok: false, code: -1, summary: { ...EMPTY_SUMMARY }, output: result.reason || "" };
        patch.expiry = state.doctor.expiry || null;
      }
      patch.status = buildStatus(state);
    } else if (id === "endpoint") {
      if (result.level === "skipped") {
        state.endpointSkipped = true;
        state.endpoint = { ok: false, output: BREAKER_ENDPOINT_OUTPUT };
      } else {
        state.endpointSkipped = false;
        state.endpoint = data || { ok: false, code: -1, output: result.reason || "" };
      }
      patch.status = buildStatus(state);
      // 未安装时端点没测：不往数据链路的「Agent 端点」一段写任何结论。
      if (state.endpoint?.notInstalled === true) return patch;
      const previous = helpers.getBridgeStage("agent-endpoint");
      helpers.ingestBridgeStage({
        ...previous,
        stage: "agent-endpoint",
        ok: result.level === "ok" && state.endpoint.ok !== false,
        durationMs: Number(state.endpoint.latencyMs ?? result.durationMs) || 0,
        consecutiveFailures: result.level === "ok" ? 0 : previous.consecutiveFailures + 1,
        lastSuccessAt: result.level === "ok" ? (result.checkedAt ?? helpers.now()) : previous.lastSuccessAt,
      });
    }
    return patch;
  },

  buildStatus,

  isSkipped(state) {
    return state.doctorSkipped || state.endpointSkipped;
  },

  legacyFields(state) {
    return { doctor: state.doctor, endpoint: state.endpoint };
  },

  // B2 参与全局健康聚合：endpoint 只降 degraded 不判 down（见 classifyHealth 注释）。
  healthInputs(state) {
    return { endpoint: state.endpoint, doctor: state.doctor.summary };
  },
};
