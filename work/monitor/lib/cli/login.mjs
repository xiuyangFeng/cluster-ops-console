// 集群 CLI 登录服务（v2.57 第 2 期 P-E，/api/cli/:id/login* 的业务层）：四种登录方式的任务管理。
//
//   账号授权（伪终端会话）：Codex `ssh -L 1455 -tt … codex login`；Claude `ssh -tt … claude auth login`
//     或 `claude setup-token`。逐块解析输出拿授权链接（只认官方域名）交给前端打开；Claude 的授权码由
//     submitCode 写回伪终端。看到成功提示后核对登录状态再结束。
//   API / 中转站：login-api.mjs 的几次短 SSH。
//
// 约束：
//   - 同一时刻每台服务器只跑一个任务（task-lock.mjs 的 createCliTaskLock；装配处注入与安装业务层同一实例）。
//   - 账号会话有两道超时：拿不到授权链接（默认 120 秒）、整体（默认 10 分钟）。取消 / 超时 / 服务关闭都会
//     杀掉本机 ssh（连带 -L 转发），再按记下的远端 pid 清理集群上的 codex login / claude；远端另有
//     timeout 硬上限兜底（本机进程意外死掉时）。
//   - key / 令牌 / 授权码不进任务视图、不进日志；输出尾巴先脱敏再留存；本机不落盘。
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import { noProxyExtraFor } from "../cluster-env.mjs";
import { parseAllowlistEntry } from "../proxy/address.mjs";
import { classifySshFailure, SSH_NO_MUX_ARGS } from "../ssh-args.mjs";
import { LoginError, normalizeApiLoginRequest, resetCodexDefaultProvider, runApiLogin, storeClaudeOauthToken, verifyLoginStatus } from "./login-api.mjs";
import {
  buildAccountSshOptions,
  buildClaudeAccountCommand,
  buildCodexAccountCommand,
  buildInspectCommand,
  buildRemoteKillCommand,
  CODEX_CALLBACK_PORT,
  CODEX_CONFIG_FILE,
  describeRelay,
  isLocalForwardFailure,
  isLoginMethod,
  LOGIN_CLIS,
  normalizeAuthCode,
  outputTail,
  parseInspectOutput,
  scanLoginOutput,
} from "./login-flows.mjs";
import { busyMessage, createCliTaskLock } from "./task-lock.mjs";

export const DEFAULT_LOGIN_TIMEOUTS = Object.freeze({
  // 启动后多久还没拿到授权链接就放弃。集群上 claude 是约 250MB 的单文件、放在 NFS 上，冷读一遍就可能
  // 超过一分钟（v2.57 终审：60 秒偏紧），放宽到 120 秒。
  urlMs: 120_000,
  totalMs: 10 * 60_000, // 账号会话整体上限
  exitGraceMs: 5_000, // 看到成功提示后等 CLI 自己退出的时间
  killGraceMs: 2_000, // SIGTERM 之后补 SIGKILL
  cleanupMs: 15_000, // 远端清理命令的超时
  keepFinishedMs: 10 * 60_000, // 结束的任务保留多久供轮询
});

const OUTPUT_LIMIT = 64 * 1024;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timeout"]);

const errorOf = (code, message, status = 400) => new LoginError(code, message, { status });

export function createCliLoginService({
  getConfig,
  getPersonalConfig,
  savePersonalConfig,
  refreshConfigIntoKernel = async () => {},
  // (server, config, command, { timeoutMs, input }) → { code, stdout, stderr }
  runRemote,
  // (server, config, { sshOptions, command }) → ChildProcess（stdin/stdout/stderr 均为管道）
  spawnSsh,
  // (port, host) → "free" | "busy" | "unavailable"
  checkLocalPort,
  taskLock = createCliTaskLock(),
  acquireSshSlot = null,
  onLoginChanged = () => {},
  // (serverId) → 重写集群 env.sh 时要带上的代理口令 { user, password } | null（集群上原来不带就是 null）。
  getEnvCredential = async () => null,
  log = () => {},
  timeouts: timeoutOverrides = {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  newId = randomUUID,
}) {
  const timeouts = { ...DEFAULT_LOGIN_TIMEOUTS, ...timeoutOverrides };
  const jobs = new Map(); // jobId → job（内部对象，view() 出去的才是公开形状）

  // ---- 任务视图 ----
  function view(job) {
    if (!job) return null;
    return {
      jobId: job.jobId,
      serverId: job.serverId,
      cli: job.cli,
      method: job.method,
      state: job.state,
      phase: job.phase,
      phaseText: job.phaseText,
      url: job.url,
      needsCode: job.state === "running" && job.phase === "waiting-code",
      warnings: [...job.warnings],
      notes: [...job.notes],
      message: job.message,
      error: job.error,
      status: job.status,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
    };
  }

  function touch(job, patch) {
    Object.assign(job, patch, { updatedAt: now() });
  }

  function setPhase(job, phase, phaseText) {
    if (TERMINAL.has(job.state)) return;
    touch(job, { phase, phaseText });
    log(`cli-login ${job.cli}/${job.method} ${job.serverId}: ${phase}`);
  }

  function prune() {
    const cutoff = now() - timeouts.keepFinishedMs;
    for (const [id, job] of jobs) {
      if (TERMINAL.has(job.state) && job.finishedAt != null && job.finishedAt < cutoff) jobs.delete(id);
    }
  }

  // ---- 服务器与依赖 ----
  async function resolveServer(serverId) {
    const config = await getConfig();
    const servers = Array.isArray(config?.servers) ? config.servers.filter((s) => s && s.disabled !== true) : [];
    const wanted = serverId || config?.activeServerId;
    const server = (wanted ? servers.find((s) => s.id === wanted) : null) ?? (serverId ? null : servers.find((s) => s.id === "server-01") ?? servers[0]);
    if (!server) throw errorOf("no-server", serverId ? `没有找到服务器 ${serverId}` : "还没有可用的服务器", 404);
    const port = Number(server.remotePort);
    return { config, server, port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : null };
  }

  async function remote(ctx, command, { input, timeoutMs } = {}) {
    const release = acquireSshSlot ? await acquireSshSlot({ hostKey: ctx.server.host }) : () => {};
    try {
      return await runRemote(ctx.server, ctx.config, command, { timeoutMs, ...(input != null ? { input } : {}) });
    } finally {
      release();
    }
  }

  function apiDeps(ctx, job) {
    return {
      port: ctx.port,
      runRemote: (command, opts) => remote(ctx, command, opts),
      getEnvCredential: () => getEnvCredential(ctx.server.id),
      getNoProxyExtra: () => noProxyExtraFor(getPersonalConfig() || {}, ctx.server.id),
      saveNoProxyExtra: async (list) => {
        const personal = getPersonalConfig() || {};
        const map = personal.noProxyExtra && typeof personal.noProxyExtra === "object" && !Array.isArray(personal.noProxyExtra) ? personal.noProxyExtra : {};
        await savePersonalConfig({ noProxyExtra: { ...map, [ctx.server.id]: list }, expectedRevision: personal.revision ?? 0 }, job.operationContext);
        await refreshConfigIntoKernel();
      },
      addAllowlistEntry: async (entry) => {
        const personal = getPersonalConfig() || {};
        const current = (Array.isArray(personal.proxyAllowedTargets) ? personal.proxyAllowedTargets : [])
          .map((raw) => parseAllowlistEntry(raw).entry)
          .filter(Boolean);
        if (current.includes(entry)) return { added: false };
        await savePersonalConfig({ proxyAllowedTargets: [...current, entry], expectedRevision: personal.revision ?? 0 }, job.operationContext);
        await refreshConfigIntoKernel();
        return { added: true };
      },
      sleep,
      phase: (name, text) => setPhase(job, name, text),
    };
  }

  // ---- 任务收尾 ----
  function finish(job, state, patch = {}) {
    if (TERMINAL.has(job.state)) return;
    touch(job, { state, finishedAt: now(), ...patch });
    log(`cli-login ${job.cli}/${job.method} ${job.serverId}: ${state}${job.error?.code ? ` (${job.error.code})` : ""}`);
    if (state === "succeeded") {
      try {
        onLoginChanged({ serverId: job.serverId, cli: job.cli });
      } catch {}
    }
    prune();
  }

  // ---- API / 中转站 ----
  async function runApiJob(job, ctx, request) {
    try {
      const result = await runApiLogin(request, apiDeps(ctx, job));
      finish(job, "succeeded", { message: result.message, status: result.status, notes: result.notes, warnings: [...job.warnings, ...result.warnings], phase: "done", phaseText: null });
    } catch (err) {
      finish(job, "failed", { error: errorView(err), phase: "done", phaseText: null });
    } finally {
      job.release();
    }
  }

  function errorView(err) {
    if (err instanceof LoginError) return { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) };
    // 非预期异常：message 可能来自底层（不含 key——key 从不拼进任何字符串），仍过一遍长度限制。
    return { code: "internal", message: `登录出错：${String(err?.message || err).slice(0, 300)}` };
  }

  // ---- 账号授权：伪终端会话 ----
  async function runAccountJob(job, ctx) {
    const variant = job.method === "setup-token" ? "setup-token" : "account";
    const session = {
      child: null,
      output: "",
      submitOffset: 0,
      pid: null,
      exited: false,
      success: false,
      token: null,
      codeSubmitted: false,
      secrets: [],
      timers: [],
      cleanupStarted: false,
    };
    job.session = session;
    const addTimer = (ms, fn) => {
      const t = setTimer(fn, ms);
      session.timers.push(t);
      return t;
    };
    const clearTimers = () => {
      for (const t of session.timers) clearTimer(t);
      session.timers = [];
    };

    let settleDone;
    const done = new Promise((resolve) => {
      settleDone = resolve;
    });

    // 结束会话：杀本机 ssh（连带端口转发），必要时清理远端进程，然后释放锁。
    const endSession = async (state, patch = {}, { remoteCleanup = true } = {}) => {
      if (session.cleanupStarted) return;
      session.cleanupStarted = true;
      clearTimers();
      finish(job, state, { ...patch, phase: "done", phaseText: null });
      await killChild();
      if (remoteCleanup && session.pid) {
        try {
          await remote(ctx, buildRemoteKillCommand(session.pid, job.cli), { timeoutMs: timeouts.cleanupMs });
        } catch {}
      }
      job.release();
      settleDone();
    };
    job.abort = (state, patch) => endSession(state, patch);

    const killChild = () => new Promise((resolve) => {
      const child = session.child;
      if (!child || session.exited) return resolve();
      const onExit = () => resolve();
      child.once("close", onExit);
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimer(() => {
        if (!session.exited) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
        resolve();
      }, timeouts.killGraceMs);
    });

    try {
      if (ctx.server.authRef) {
        throw errorOf("password-server", "这台服务器用密码连接；账号授权需要能长时间保持的 SSH 会话，请先改用密钥登录（npm run setup）", 409);
      }
      if (!ctx.port) {
        // 没有端口时，集群上的 CLI 只能靠已写好的 env.sh 出网；先确认它在。
        const res = await remote(ctx, buildInspectCommand({ cli: job.cli, port: null, file: CODEX_CONFIG_FILE }), { timeoutMs: 20000 });
        const parsed = res?.code === 0 ? parseInspectOutput(res.stdout) : null;
        if (!parsed?.envPresent) throw errorOf("no-port", "这台服务器还没领到反向端口，集群上的 CLI 没法出网完成登录；先在设置里领取端口", 409);
      }
      let forwardV6 = false;
      if (job.cli === "codex") {
        setPhase(job, "preparing", `检查本机 ${CODEX_CALLBACK_PORT} 端口`);
        const v4 = await checkLocalPort(CODEX_CALLBACK_PORT, "127.0.0.1");
        if (v4 === "busy") throw errorOf("local-port-busy", `本机 ${CODEX_CALLBACK_PORT} 端口被占用（多半是本机的 Codex 正在登录，或上一次登录没退出）。关掉它后再试。`, 409);
        const v6 = await checkLocalPort(CODEX_CALLBACK_PORT, "::1");
        if (v6 === "busy") throw errorOf("local-port-busy", `本机 [::1]:${CODEX_CALLBACK_PORT} 端口被占用，关掉占用它的程序后再试。`, 409);
        forwardV6 = v6 === "free";
      }
      setPhase(job, "connecting", "连接集群，启动登录（集群上首次启动要从共享盘读入 CLI，可能要等一两分钟）");
      const command = job.cli === "codex"
        ? buildCodexAccountCommand({ port: ctx.port })
        : buildClaudeAccountCommand({ port: ctx.port, variant });
      const child = spawnSsh(ctx.server, ctx.config, { sshOptions: buildAccountSshOptions({ cli: job.cli, forwardV6 }), command });
      session.child = child;
    } catch (err) {
      finish(job, "failed", { error: errorView(err), phase: "done", phaseText: null });
      job.release();
      return;
    }

    const child = session.child;
    child.stdin?.on?.("error", () => {});
    const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
    const onData = (index) => (chunk) => {
      const text = decoders[index].write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      session.output += text;
      if (session.output.length > OUTPUT_LIMIT) {
        const drop = session.output.length - OUTPUT_LIMIT;
        session.output = session.output.slice(drop);
        session.submitOffset = Math.max(0, session.submitOffset - drop);
      }
      onOutput();
    };
    child.stdout?.on("data", onData(0));
    child.stderr?.on("data", onData(1));
    child.on("error", (err) => {
      session.exited = true;
      endSession("failed", { error: { code: "spawn-failed", message: `启动 ssh 失败：${String(err?.message || err).slice(0, 200)}` } }, { remoteCleanup: false });
    });
    child.on("close", (code) => {
      session.exited = true;
      onExit(code);
    });

    addTimer(timeouts.urlMs, () => {
      if (!job.url && !session.cleanupStarted) {
        endSession("failed", { error: { code: "no-url", message: `等了 ${Math.round(timeouts.urlMs / 1000)} 秒没拿到授权链接。集群上首次启动 CLI 较慢，可以再试一次（读过一遍之后会快很多）。${tailHint()}` } });
      }
    });
    addTimer(timeouts.totalMs, () => {
      if (!session.cleanupStarted) endSession("timeout", { error: { code: "timeout", message: `登录超时（${Math.round(timeouts.totalMs / 60000)} 分钟），已结束集群上的登录进程。` } });
    });

    function tailHint() {
      const tail = outputTail(session.output, { secrets: session.secrets, maxChars: 400 });
      return tail ? `最近输出：${tail}` : "";
    }

    function onOutput() {
      if (session.cleanupStarted) return;
      const scan = scanLoginOutput(job.cli, { full: session.output, recent: session.output.slice(session.submitOffset), variant });
      if (scan.pid && !session.pid) session.pid = scan.pid;
      if (scan.portBusy) {
        endSession("failed", { error: { code: "remote-port-busy", message: `集群上的 ${CODEX_CALLBACK_PORT} 端口正被占用——多半有同事正在登录 Codex。为了不打断对方，这次没有启动；过几分钟再试。` } }, { remoteCleanup: false });
        return;
      }
      if (scan.url && !job.url) {
        touch(job, { url: scan.url });
        if (job.cli === "codex") setPhase(job, "waiting-browser", "在浏览器里完成授权，回调经本机 1455 转发回集群");
        else setPhase(job, "waiting-code", "在浏览器里完成授权，把页面上显示的授权码粘贴回来");
      }
      if (scan.token && !session.token) {
        session.token = scan.token;
        session.secrets.push(scan.token);
      }
      if (scan.success && !session.success) {
        session.success = true;
        setPhase(job, "verifying", "授权完成，核对登录状态");
        addTimer(timeouts.exitGraceMs, () => {
          if (!session.exited) killChild();
        });
        return;
      }
      if (scan.failure && job.cli === "claude" && job.phase === "verifying") {
        // 授权码不对：Claude 可能继续提示输入，回到等码状态让用户重贴。
        session.submitOffset = session.output.length;
        touch(job, { error: { code: "bad-code", message: "授权码没有通过，请重新复制页面上的授权码再提交。" } });
        setPhase(job, "waiting-code", "授权码没有通过，请重新粘贴");
      }
    }

    async function onExit(code) {
      if (session.cleanupStarted) return;
      if (session.success) {
        clearTimers();
        try {
          if (session.token) {
            setPhase(job, "writing", "保存长期令牌到集群 keys/claude-oauth.env（600）");
            await storeClaudeOauthToken(session.token, { runRemote: (command, opts) => remote(ctx, command, opts) });
            session.token = null;
          }
          const deps = { port: ctx.port, runRemote: (command, opts) => remote(ctx, command, opts) };
          const notes = [];
          if (job.cli === "codex") {
            const res = await remote(ctx, buildInspectCommand({ cli: "codex", port: ctx.port, file: CODEX_CONFIG_FILE }), { timeoutMs: 20000 });
            const parsed = res?.code === 0 ? parseInspectOutput(res.stdout) : null;
            const reset = parsed ? await resetCodexDefaultProvider(deps, parsed.file) : null;
            if (reset) notes.push(reset);
          }
          const status = await verifyLoginStatus(deps, job.cli);
          const label = LOGIN_CLIS[job.cli].label;
          const message = variant === "setup-token"
            ? "已生成长期令牌并保存到集群（经 env.sh 引入为 CLAUDE_CODE_OAUTH_TOKEN）；新开的终端生效"
            : `${label} 已用账号登录`;
          session.cleanupStarted = true;
          finish(job, "succeeded", { message, status, notes, phase: "done", phaseText: null });
        } catch (err) {
          session.cleanupStarted = true;
          finish(job, "failed", { error: errorView(err), phase: "done", phaseText: null });
        } finally {
          session.token = null;
          job.release();
          settleDone();
        }
        return;
      }
      // 没看到成功就退出了：按输出归因。
      const output = session.output;
      const scan = scanLoginOutput(job.cli, { full: output, variant });
      let error;
      if (scan.noCli) error = { code: "no-cli", message: `集群上没有找到 ${job.cli === "claude" ? "claude" : "codex"}，请先安装。` };
      else if (job.cli === "codex" && isLocalForwardFailure(output)) error = { code: "local-port-busy", message: `本机 ${CODEX_CALLBACK_PORT} 端口被占用，端口转发没建起来。关掉占用它的程序后再试。` };
      else {
        const ssh = classifySshFailure(output);
        if (ssh && !job.url) error = { code: `ssh-${ssh.code}`, message: `SSH 连不上服务器：${ssh.nextAction}` };
        else {
          const hint = job.cli === "claude" && variant === "account" ? "如果浏览器授权一直走不通，可以改用「长期令牌」（claude setup-token）。" : "";
          // 真机（Claude Code 2.1.29x）：授权码不对时 CLI 报一句 Login failed 就退出，不会再问第二次——
          // 说成「登录进程退出了」用户不知道该做什么，直接讲清楚是授权码没过、要重新发起。
          if (job.cli === "claude" && session.codeSubmitted && scan.failure) {
            error = { code: "bad-code", message: `授权码没有通过，这次登录已经结束（Claude Code 报错后直接退出，不会再问一次）。请重新发起登录，在新打开的授权页面完成授权后，把页面上显示的整串授权码完整粘贴回来——每个授权码只能用一次。${hint}${tailHint()}` };
          } else {
            error = { code: "exited", message: `登录进程退出了（退出码 ${code ?? "未知"}），没有看到成功提示。${hint}${tailHint()}` };
          }
        }
      }
      // 进程已自己退出：远端不用再清理。
      endSession("failed", { error }, { remoteCleanup: false });
    }

    await done;
  }

  // ---- 公开方法 ----
  async function start(cli, body = {}, operationContext) {
    if (!LOGIN_CLIS[cli]) throw errorOf("bad-cli", `不支持的 CLI: ${cli}`, 404);
    const method = typeof body?.method === "string" ? body.method : "";
    if (!isLoginMethod(cli, method)) throw errorOf("bad-method", `${LOGIN_CLIS[cli].label} 不支持登录方式「${method}」`);
    const isApi = method === "api" || method === "relay";
    // 先校验输入（不发 SSH），再占锁。
    let request = isApi ? normalizeApiLoginRequest(cli, method, body) : null;
    const ctx = await resolveServer(typeof body?.serverId === "string" ? body.serverId : null);
    const jobId = newId();
    const release = taskLock.tryAcquire(ctx.server.id, { kind: "login", jobId, cli, method, now });
    if (!release) {
      request = null;
      const holder = taskLock.current(ctx.server.id);
      const err = errorOf("busy", busyMessage(holder), 409);
      err.jobId = holder?.jobId;
      err.busy = holder;
      throw err;
    }
    const startedAt = now();
    const job = {
      jobId,
      serverId: ctx.server.id,
      cli,
      method,
      state: "running",
      phase: "preparing",
      phaseText: "准备中",
      url: null,
      warnings: [],
      notes: [],
      message: null,
      error: null,
      status: null,
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      operationContext,
      release,
      abort: null,
      session: null,
    };
    if (request?.relay?.warnings?.includes("plaintext-http")) job.warnings.push("中转站是 http:// 明文地址：API key 不加密传输");
    jobs.set(jobId, job);
    log(`cli-login ${cli}/${method} ${ctx.server.id}: started`);
    job.promise = isApi ? runApiJob(job, ctx, request) : runAccountJob(job, ctx);
    request = null;
    return view(job);
  }

  function get(jobId) {
    prune();
    return view(jobs.get(jobId) || null);
  }

  // 某台服务器上正在进行的登录任务（没有则最近一个）。
  function current(serverId) {
    let latest = null;
    for (const job of jobs.values()) {
      if (serverId && job.serverId !== serverId) continue;
      if (job.state === "running") return view(job);
      if (!latest || job.startedAt > latest.startedAt) latest = job;
    }
    return view(latest);
  }

  function submitCode(jobId, rawCode) {
    const job = jobs.get(jobId);
    if (!job) throw errorOf("not-found", "登录任务不存在或已过期", 404);
    if (job.cli !== "claude" || !job.session) throw errorOf("bad-state", "这个登录方式不需要授权码", 409);
    if (job.state !== "running" || !["waiting-code", "waiting-browser"].includes(job.phase)) throw errorOf("bad-state", "现在不需要输入授权码", 409);
    const code = normalizeAuthCode(rawCode);
    if (!code) throw errorOf("bad-code", "授权码格式不对：请完整复制页面上显示的那一串（不含空格）");
    const session = job.session;
    session.secrets.push(code);
    session.codeSubmitted = true;
    session.submitOffset = session.output.length;
    try {
      session.child.stdin.write(`${code}\r`);
    } catch {
      throw errorOf("bad-state", "登录进程已经结束", 409);
    }
    touch(job, { error: null });
    setPhase(job, "verifying", "已提交授权码，等待确认");
    return view(job);
  }

  async function cancel(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw errorOf("not-found", "登录任务不存在或已过期", 404);
    if (TERMINAL.has(job.state)) return view(job);
    if (typeof job.abort === "function") {
      await job.abort("cancelled", { error: { code: "cancelled", message: "已取消，集群上的登录进程已结束" } });
    } else {
      // API 任务是几次短 SSH，不中途打断（写到一半更糟）：等它自己结束。
      throw errorOf("bad-state", "这个任务正在写入，几秒内就会结束，不能中途取消", 409);
    }
    return view(job);
  }

  function relayCheck(baseUrl) {
    return describeRelay(baseUrl);
  }

  // 服务关闭：结束所有账号会话（杀 ssh；远端由 timeout 硬上限兜底，关闭路径不再发 SSH）。
  function dispose() {
    for (const job of jobs.values()) {
      if (job.state === "running" && job.session?.child && !job.session.exited) {
        try {
          job.session.child.kill("SIGKILL");
        } catch {}
      }
    }
  }

  return { start, get, current, submitCode, cancel, relayCheck, dispose };
}

// 账号会话的 ssh 参数：探针的钉扎参数（known_hosts / 身份 / 端口 / 主机）去掉连接复用，前置会话选项。
// 必须不复用：经 ControlMaster 复用时 -L 转发挂在常驻 master 上，杀掉本次 ssh 后 1455 仍被 master
// 占着、ControlPersist 期间一直在——取消 / 超时就清理不干净。BatchMode：绝不在伪终端里卡在密码提示。
const CONTROL_OPTION = /^Control(?:Master|Path|Persist)=/i;
export function buildLoginSshArgs(pinnedArgs, sshOptions, command) {
  const rest = [];
  for (let i = 0; i < pinnedArgs.length; i += 1) {
    if (pinnedArgs[i] === "-o" && CONTROL_OPTION.test(String(pinnedArgs[i + 1] ?? ""))) {
      i += 1;
      continue;
    }
    rest.push(pinnedArgs[i]);
  }
  return [...SSH_NO_MUX_ARGS, "-o", "BatchMode=yes", ...sshOptions, ...rest, command];
}

// 生产用：本机端口能否被 ssh -L 绑定。listen 成功即关 → "free"；EADDRINUSE/EACCES → "busy"；
// 本机没有这个地址族（IPv6 关了）→ "unavailable"。
export async function checkLocalPortDefault(port, host) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err) => {
      if (err?.code === "EADDRINUSE" || err?.code === "EACCES") resolve("busy");
      else resolve("unavailable");
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve("free"));
    });
  });
}
