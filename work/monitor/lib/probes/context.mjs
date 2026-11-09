import { selectMainServer } from "../config-loader.mjs";
import { execFileWithInput, execFileWithTimeout } from "../exec.mjs";
import { computeConfigRevision } from "../runtime-snapshot.mjs";
import { buildPinnedProbeSshArgs, classifySshFailure } from "../ssh-args.mjs";

// 探针共用的执行底座：exec 注入点、SSH 参数、失败归因、诊断上下文与主机记账键。
// processes / collect / validation / 适配器探针全部经这里发命令，测试只需注入一个
// execFileImpl 即可零真实 SSH 驱动整套探针。
export function createProbeContext({ rootDir, dataDir, getConfig, execFileImpl }) {
  // 共享 exec 封装（lib/exec.mjs）：永不 reject，超时先 SIGTERM 再 SIGKILL，
  // ENOENT 等 'error' 事件正常结算 Promise，stdout/stderr 有累积上限。
  // 旧私有实现缺 child.on("error")，ssh/ps ENOENT 时 Promise 永挂 + 定时器泄漏。
  function execFileCmd(command, args, options = {}) {
    if (execFileImpl) return execFileImpl(command, args, options);
    // input（v2.62）：要带代理口令的探测把它经标准输入交给远端，不进命令行。没给时与以前一样不开标准输入。
    if (options.input != null) return execFileWithInput(command, args, { cwd: rootDir, timeoutMs: options.timeoutMs || 20000, input: options.input });
    return execFileWithTimeout(command, args, { cwd: rootDir, ...options, timeoutMs: options.timeoutMs || 20000 });
  }

  // 采集脚本经 stdin 送达（远端零残留）。走 execFileImpl 同一注入点，测试里
  // 假 ssh 依旧能拿到 (cmd, args, { input, timeoutMs })，零真实 SSH。
  // maxOutputBytes 可选：用量扫描一轮可回传数 MB，其余采集沿用 exec 默认上限。
  function execCollector({ file, args, input, timeoutMs, maxOutputBytes }, server) {
    const limit = maxOutputBytes ? { maxOutputBytes } : {};
    if (execFileImpl) return execFileImpl(file, args, { input, timeoutMs, server, ...limit });
    return execFileWithInput(file, args, { input, timeoutMs, cwd: rootDir, ...limit });
  }

  // 查看视角：未屏蔽条目里 activeServerId → server-01 → 第一条（config-loader 同一条回落链）。
  function getMainServerConfig(config) {
    return selectMainServer(config);
  }

  function sshArgsFor(server, config) {
    return buildPinnedProbeSshArgs(server, config, { dataDir });
  }

  function probeSshFailureReason(code, stderr, stdout) {
    const failure = classifySshFailure(`${stderr || ""}\n${stdout || ""}`);
    if (failure) return `${failure.code}: ${failure.nextAction}`;
    return `ssh exit ${code}`;
  }

  // ---- T02 诊断上下文（A08/A09）----
  // 探针 run 一开始（任何 SSH 发起之前）捕获不可变上下文快照，结果带回同一 context：
  // state-store 据此把"配置热载/切服后迟到"的旧结果挡在当前状态之外（scheduler 的
  // runSeq 只能防同探针迟到，防不了跨上下文）。configRevision 与 runtime-snapshot
  // 同一把尺子，supervisor 快照 / forceRun 防抖缓存共用。
  // 已知窗口：包装器与 run 内部各取一次 config，两次都失败回落 null（无上下文 →
  // state-store 按旧语义处理，行为与升级前一致）。
  function contextFor(pickServerId) {
    return async () => {
      try {
        const config = await getConfig();
        return { serverId: pickServerId(config), configRevision: computeConfigRevision(config) };
      } catch {
        return null;
      }
    };
  }

  // 跟随活跃服务器的探针（agent 诊断 / log-signals）。
  function activeServerProbeContext() {
    return contextFor((config) => getMainServerConfig(config)?.id ?? null);
  }

  // 按 serverId 固定归属的探针（slow 采集 / 验证）：context.serverId 就是该服务器自己，
  // state-store 的迟到防护不会误伤"查看别台时的常规采集"。
  function serverProbeContext(serverId) {
    return contextFor(() => serverId);
  }

  function wrapWithProbeContext(run, buildContext) {
    return async () => {
      const probeContext = await buildContext();
      const result = await run();
      return { ...result, probeContext };
    };
  }

  // T08 hostKey：SSH 探针按实际主机记账（每主机并发上限的基础）。
  // 归一化到 host（-R 目标主机名）；agent/log-signals 跟随活跃服务器。
  // 调度器同步读 hostKey（启动探针时当场记账），所以这里必须同步返回字符串：曾返回 async 函数，
  // 拿到的是 Promise，被字符串化成 "[object Promise]"，活跃服务器的探针全记在这个假主机名下，
  // 每主机并发上限对它们失效。现在返回最近一次读到的主机名，读配置在后台进行（至多每 2 秒一次）；
  // 首次读完之前返回 null（只受全局 SSH 并发上限约束，与查不到主机时一致）。
  const HOST_KEY_REFRESH_MS = 2000;
  let cachedHostKey = null;
  let hostKeyRefreshedAt = -Infinity;
  function refreshHostKey() {
    const now = Date.now();
    if (now - hostKeyRefreshedAt < HOST_KEY_REFRESH_MS) return;
    hostKeyRefreshedAt = now;
    Promise.resolve()
      .then(() => getConfig())
      .then((config) => { cachedHostKey = getMainServerConfig(config)?.host || null; })
      .catch(() => {});
  }
  function activeHostKey() {
    refreshHostKey();
    return () => {
      refreshHostKey();
      return cachedHostKey;
    };
  }

  return {
    execFileCmd,
    execCollector,
    getMainServerConfig,
    sshArgsFor,
    probeSshFailureReason,
    activeServerProbeContext,
    serverProbeContext,
    wrapWithProbeContext,
    activeHostKey,
  };
}
