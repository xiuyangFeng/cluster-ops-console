import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectMainServer } from "./config-loader.mjs";
import { archLabel } from "./platform.mjs";
import { tunnelProxyEnv } from "./proxy-config.mjs";
import { shellSingleQuote } from "./shell/quote.mjs";
import { buildPinnedProbeSshArgs, classifySshFailure } from "./ssh-args.mjs";

// Bootstrap 离线安装向导：把 scripts/build-reclaude-offline.sh 手工链路拆成 7 个显式步骤。
// 命令模板全部固定在代码内，仅插值 config 的活跃 server（host/remotePort）与 agents；
// 本地调用一律 execFile 参数数组（无 shell 字符串拼接），远端需要管道时管道串作为
// ssh 的单个参数传入。状态存内存，monitor-server 重启即归零（向导语义，不持久化）。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// work/monitor/lib -> 仓库根：scripts/ 与 dist/ 都位于根。
const ROOT_DIR = path.resolve(__dirname, "../../..");

// build-reclaude-offline.sh 的实际产物（默认 VERSION=latest / LINUX_ARCH=amd64）：
//   dist/reclaude-linux-offline-latest-amd64.tar.gz
// 解包目录 reclaude-offline-latest-amd64/ 内含 install_reclaude_offline.sh，
// 该脚本把 reclaude/claude-codewing 装入 $HOME/.local/bin。
const TARBALL = "reclaude-linux-offline-latest-amd64.tar.gz";
const PKG_DIR = "reclaude-offline-latest-amd64";
const INSTALL_SH = "install_reclaude_offline.sh";
const REL_TARBALL = `dist/${TARBALL}`;
// 远端 reclaude/codex 位于 ~/.local/bin，探针一致地前置 PATH。
const REMOTE_PATH = 'PATH="$HOME/.local/bin:$PATH"';

const LOCAL_TIMEOUT = 300000; // 构建：5 分钟
const REMOTE_TIMEOUT = 30000; // 其余：30 秒
const MAX_BUFFER = 4 * 1024 * 1024;

// copyCommand 专用：远端 payload 用单引号包裹，防止本地粘贴时 $HOME/$PATH 被本地 shell 展开、
// `&&`/`;` 在本地断行、以及 payload 内的双引号提前闭合外层引号。payload 内保证无单引号
// （下方各 payload 及 bootstrap.test.mjs 守卫）。执行路径不受影响——execFile 以 payload 作为
// 单个 ssh 参数传入，无 shell 解析。
function sq(payload) {
  return `'${payload}'`;
}

function resolveConfig(config) {
  return typeof config === "function" ? config() : config;
}

// 截断到 max 字节（UTF-8 安全），日志与 summary 都用。
function truncate(str, max = 256) {
  const s = str == null ? "" : String(str);
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  return `${buf.subarray(0, max).toString("utf8")}…`;
}

function firstLine(text) {
  return String(text || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
}

function joinLines(text) {
  return String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).join(" / ");
}

// W5：失败摘要不再是截断的 stderr——SSH 类失败先过 classifySshFailure 归因，
// 摘要写成"原因：下一步"，原始输出仍在运维日志里。归因不出来时 code 为 null，回落原文。
const FAILURE_LABELS = {
  auth: "SSH 认证失败",
  dns: "主机名解析失败",
  refused: "SSH 连接被拒绝（可能不在白名单网络）",
  timeout: "SSH 连接超时（可能不在白名单网络）",
  "remote-port": "远端端口被占用",
  "rate-limit": "SSH 尝试过多",
  hostkey: "主机密钥未确认或已变化",
};

export function describeBootstrapFailure(text) {
  const raw = String(text || "");
  const classified = classifySshFailure(raw);
  if (!classified) return { code: null, summary: truncate(raw, 256) };
  const label = FAILURE_LABELS[classified.code] || classified.code;
  return { code: classified.code, summary: truncate(`${label}：${classified.nextAction}`, 256) };
}

// 构建离线包依赖 bash + scripts/build-reclaude-offline.sh，Windows 上跑不了。
const BUILD_UNSUPPORTED_REASON = "Windows 不支持在本机构建离线包：请在 Mac/Linux 上执行此步构建后，把 dist/ 下的离线包拷到本机同一路径，再继续「上传离线包」。";

// 步骤定义表：kind "remote" 的步骤需先占用 ssh 槽位。commands 顺序执行、全部成功才算成功。
function buildDefs(selectedServer, parsed = {}, dataDir) {
  const server = selectedServer ? { ...selectedServer } : { host: "unconfigured.invalid" };
  const host = server.host;
  const sshArgs = buildPinnedProbeSshArgs(server, parsed, { dataDir });
  const sshOptions = sshArgs.slice(0, -1);
  const scpOptions = [];
  for (let i = 0; i < sshOptions.length; i += 1) {
    const option = sshOptions[i];
    if (option === "-p") scpOptions.push("-P", sshOptions[++i]);
    else if (option === "-l") scpOptions.push("-o", `User=${sshOptions[++i]}`);
    else scpOptions.push(option);
  }
  const quoteArg = (value) => /^[\w@./:=%~+-]+$/.test(String(value)) ? String(value) : shellSingleQuote(value);
  const sshCopy = sshArgs.map(quoteArg).join(" ");
  const scpCopy = scpOptions.map(quoteArg).join(" ");
  const remoteInstall = `tar -xzf /tmp/${TARBALL} -C /tmp && bash /tmp/${PKG_DIR}/${INSTALL_SH}`;
  const pathCheck = `${REMOTE_PATH} command -v reclaude && ${REMOTE_PATH} command -v codex`;
  const versionVerify = `${REMOTE_PATH} reclaude version; ${REMOTE_PATH} codex --version`;
  // 与 doctor 探针同理：带隧道代理诊断，否则 reachability 直连外网恒报失败（未配置端口时不带）。
  const proxyEnv = Number.isInteger(server.remotePort) ? tunnelProxyEnv(server.remotePort) : "";
  const loginVerify = `${REMOTE_PATH} ${proxyEnv}codex doctor --summary --ascii`;

  return [
    {
      id: "detect-arch",
      name: "检测架构",
      kind: "remote",
      commands: [
        { cmd: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(archLabel())})`], options: { timeout: REMOTE_TIMEOUT, maxBuffer: MAX_BUFFER } },
        { cmd: "ssh", args: [...sshArgs, "uname -m"], options: { timeout: REMOTE_TIMEOUT, maxBuffer: MAX_BUFFER } },
      ],
      copyCommand: `echo "本地架构=${archLabel()}" && ssh ${sshCopy} ${sq("uname -m")}`,
      summarize: (r) => `本地 ${firstLine(r[0].stdout) || "?"} / 远端 ${firstLine(r[1].stdout) || "?"}`,
    },
    {
      id: "build-tarball",
      name: "构建离线包",
      kind: "local",
      commands: [
        {
          cmd: "bash",
          args: ["scripts/build-reclaude-offline.sh"],
          options: { cwd: ROOT_DIR, timeout: LOCAL_TIMEOUT, maxBuffer: MAX_BUFFER },
        },
      ],
      copyCommand: "bash scripts/build-reclaude-offline.sh",
      summarize: (r) => {
        const created = String(r[0].stdout || "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("Created"))
          .join("；");
        return created || "构建完成";
      },
    },
    {
      id: "upload",
      name: "上传离线包",
      kind: "remote",
      commands: [
        {
          cmd: "scp",
          args: [...scpOptions, REL_TARBALL, `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:/tmp/`],
          options: { cwd: ROOT_DIR, timeout: REMOTE_TIMEOUT, maxBuffer: MAX_BUFFER },
        },
      ],
      copyCommand: `scp ${scpCopy} ${REL_TARBALL} ${quoteArg(`${host}:/tmp/`)}`,
      summarize: () => `已上传 ${TARBALL} 到 ${host}:/tmp/`,
    },
    {
      id: "remote-install",
      name: "远端安装",
      kind: "remote",
      commands: [
        { cmd: "ssh", args: [...sshArgs, remoteInstall], options: { timeout: REMOTE_TIMEOUT, maxBuffer: MAX_BUFFER } },
      ],
      copyCommand: `ssh ${sshCopy} ${sq(remoteInstall)}`,
      summarize: (r) => joinLines(r[0].stdout).slice(0, 200) || "安装完成",
    },
    {
      id: "path-check",
      name: "校验命令路径",
      kind: "remote",
      commands: [
        { cmd: "ssh", args: [...sshArgs, pathCheck], options: { timeout: REMOTE_TIMEOUT, maxBuffer: MAX_BUFFER } },
      ],
      copyCommand: `ssh ${sshCopy} ${sq(pathCheck)}`,
      summarize: (r) => joinLines(r[0].stdout) || "路径已就绪",
    },
    {
      id: "version-verify",
      name: "校验版本",
      kind: "remote",
      commands: [
        { cmd: "ssh", args: [...sshArgs, versionVerify], options: { timeout: REMOTE_TIMEOUT, maxBuffer: MAX_BUFFER } },
      ],
      copyCommand: `ssh ${sshCopy} ${sq(versionVerify)}`,
      summarize: (r) => joinLines(r[0].stdout) || "版本已就绪",
    },
    {
      id: "login-verify",
      name: "校验登录/诊断",
      kind: "remote",
      commands: [
        { cmd: "ssh", args: [...sshArgs, loginVerify], options: { timeout: REMOTE_TIMEOUT, maxBuffer: MAX_BUFFER } },
      ],
      copyCommand: `ssh ${sshCopy} ${sq(loginVerify)}`,
      summarize: (r) => joinLines(r[0].stdout) || "诊断通过",
    },
  ].map((def) => ({ ...def, server: selectedServer ? server : null, commands: def.commands.map((command) => ({ ...command, options: { ...command.options, ...(["ssh", "scp"].includes(command.cmd) ? { server } : {}) } })) }));
}

export function createBootstrapRunner({ config, dataDir, execFileImpl, logger, acquireSshSlot, platform = process.platform }) {
  // 平台门控（追加字段 disabled/disabledReason）：目前只有 build-tarball 依赖 bash。
  const disabledReasonOf = (id) => (platform === "win32" && id === "build-tarball" ? BUILD_UNSUPPORTED_REASON : "");
  const log = logger || { info() {}, warn() {}, error() {} };
  // 持久（内存）状态：仅 status/summary/finishedAt；名称/命令按当前活跃 server 动态生成
  // （活跃 server 与探针 / 状态仓同一条回落链：config-loader.selectMainServer）。
  const state = new Map(); // id -> { status, summary, finishedAt }
  for (const def of buildDefs(selectMainServer(resolveConfig(config)), resolveConfig(config), dataDir)) {
    state.set(def.id, { status: "pending", summary: "", finishedAt: null });
  }

  function currentDefs() {
    const parsed = resolveConfig(config);
    return buildDefs(selectMainServer(parsed), parsed, dataDir);
  }

  function getState() {
    const defs = currentDefs();
    return {
      steps: defs.map((def) => {
        const s = state.get(def.id) || { status: "pending", summary: "", finishedAt: null };
        return {
          id: def.id,
          name: def.name,
          kind: def.kind,
          status: s.status,
          summary: s.summary,
          copyCommand: def.copyCommand,
          finishedAt: s.finishedAt,
          disabled: Boolean(disabledReasonOf(def.id)),
          disabledReason: disabledReasonOf(def.id),
          failureCode: s.failureCode ?? null,
        };
      }),
    };
  }

  async function execute(def, entry, context) {
    const fields = { ...(context || {}), step: def.id };
    log.info(`bootstrap ${def.id} 开始`, fields);
    let release = () => {};
    try {
      if (def.kind === "remote") {
        if (!def.server) throw new Error("请先配置并启用服务器");
        release = await acquireSshSlot({ hostKey: def.server.host });
      }
      const results = [];
      for (const c of def.commands) {
        const r = (await execFileImpl(c.cmd, c.args, c.options || {})) || {};
        results.push(r);
        log.info(`$ ${c.cmd} ${(c.args || []).join(" ")}`, fields);
        const out = truncate(`${r.stdout || ""}${r.stderr || ""}`, 512).trim();
        if (out) log.info(out, fields);
      }
      entry.summary = truncate(def.summarize(results), 256);
      entry.status = "success";
      log.info(`bootstrap ${def.id} 成功: ${entry.summary}`, fields);
    } catch (err) {
      const msg = (err && (err.stderr || err.message)) || String(err);
      const described = describeBootstrapFailure(msg);
      entry.summary = described.summary;
      entry.failureCode = described.code;
      entry.status = "fail";
      log.error(`bootstrap ${def.id} 失败: ${truncate(msg, 256)}`, { ...fields, ...(described.code ? { reason: described.code } : {}) });
    } finally {
      release();
      entry.finishedAt = Date.now();
    }
  }

  async function runStep(id, context) {
    const def = currentDefs().find((d) => d.id === id);
    if (!def) return { started: false, reason: "unknown step" };
    if (disabledReasonOf(id)) return { started: false, reason: "unsupported-platform" };
    const entry = state.get(id);
    if (entry.status === "running") return { started: false, reason: "already running" };
    // 同步置 running（在首个 await 之前），使并发 runStep 与 getState 立即可见。
    entry.status = "running";
    entry.summary = "";
    entry.failureCode = null;
    entry.finishedAt = null;
    await execute(def, entry, context);
    return { started: true };
  }

  return { getState, runStep };
}
