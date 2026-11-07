// 本地 HTTP CONNECT 代理（127.0.0.1:8888，全部隧道共用）的进程入口。
// 这个路径是对外契约：supervisor 的 spawn 命令行、进程识别签名、pkill/pgrep 模式都认
// `work/local_http_connect_proxy.mjs`，所以入口留在这里，实现拆在 monitor/lib/proxy/：
//   protocol.mjs      与 supervisor 共享的进程间约定（环境变量 / 控制文件 / 标记 / 身份头）
//   handoff.mjs       平滑交接的代理侧：时序常量、释放请求轮询、排空记录自清理
//   address.mjs       地址纯判定（authority / 端口 / 私网字面量 / 白名单条目 / 上游地址），叶子模块
//   target-policy.mjs 目标放行策略与 DNS rebinding 闸门
//   dns-cache.mjs     拨号用 DNS 正缓存
//   upstream.mjs      经上游 HTTP 代理拨号（出网方式 system / manual）
//   system-proxy.mjs  识别系统代理（macOS scutil / Windows 注册表 / 环境变量）
//   policy-reload.mjs 分层配置 → 生效策略（白名单 + 出网方式），2 秒一查的热重载
//   server.mjs        http.Server：转发 / CONNECT / 连接跟踪 / 交接 bind 重试与释放排空
//   headers.mjs       逐跳头剥离 + 跳标记（经外部转发器绕回自己的环路检测）
//   resolver-canary.mjs 本机解析器健康金丝雀（上游模式下解析失败的目标放行还是拒绝）
//   auth.mjs          代理口令：口令文件校验 + Proxy-Authorization 的常数时间判定（默认关）
//   usage.mjs         隧道使用记录：按目标记连接数 / 字节 / 口令情况（口令模式不是关时才记）
// 这里只保留 CLI 主流程；测试直接 import lib/proxy/ 下的实现模块。
// 热更新指纹 = 本文件的静态相对 import 闭包（component-version.mjs），上述模块自动计入——
// 只能用静态相对 import，不要改成拼路径的动态 import。
// 第一个 import：Windows 安装版的子进程不弹命令行窗口（见该文件说明）。
import "./monitor/lib/windows-hide-children.mjs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { resolveRuntimePaths } from "./monitor/lib/runtime-paths.mjs";
import { computeComponentHashes } from "./monitor/lib/component-version.mjs";
import {
  buildProxyHealthHeaders,
  HANDOFF_WAITING_MARKER,
  PROXY_HANDOFF_ENV,
  proxyReleaseRequestPath,
} from "./monitor/lib/proxy/protocol.mjs";
import { HANDOFF_DRAIN_MAX_MS, removeOwnDrainingRecord, watchReleaseRequest } from "./monitor/lib/proxy/handoff.mjs";
import { createPolicyLoader } from "./monitor/lib/proxy/policy-reload.mjs";
import { createProxyServer, createServerErrorHandler } from "./monitor/lib/proxy/server.mjs";
import { PROXY_AUTH_FILE } from "./monitor/lib/proxy/auth.mjs";
import { createUsageRecorder, PROXY_USAGE_FILE } from "./monitor/lib/proxy/usage.mjs";

// CLI 入口：supervisor 以 `node work/local_http_connect_proxy.mjs` 启动，契约不变。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // 纵深兜底：即便校验逻辑本身有遗漏，一条畸形请求也不该拖垮整个常驻代理进程
  // ——记录并继续存活，而不是让 supervisor 再去重建一条隧道。
  process.on("uncaughtException", (err) => {
    console.error(`[proxy] uncaughtException (ignored, process stays up): ${(err?.stack) || err}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[proxy] unhandledRejection (ignored, process stays up): ${reason}`);
  });
  // 热更新交接后 supervisor 换人：旧 supervisor 退出，stdout/stderr 管道的读端随之关闭。
  // 写断管（EPIPE）不能把代理带走——日志丢了事小，集群出网断了事大。
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let paths = null;
  try {
    paths = resolveRuntimePaths({ appRoot: sourceRoot, env: process.env, homeDir: os.homedir() });
  } catch (err) {
    console.error(`[proxy-config] 解析运行目录失败: ${err.message}`);
  }

  // Supervisor 只会传入经过配置校验的端口，但入口也会被人工直接执行；
  // 畸形 PORT 不得一路变成 NaN/小数交给 server.listen（会同步抛异常、留下
  // 无法自愈的僵尸通道）。保留 PORT=0 供冒烟测试使用。
  const rawPort = process.env.PORT;
  const parsedPort = rawPort == null || rawPort === "" || (typeof rawPort === "string" && rawPort.trim() === "") ? 8888 : Number(rawPort);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 8888;
  if (rawPort != null && rawPort !== "" && port === 8888 && parsedPort !== 8888) {
    console.error(`[proxy-config] PORT=${JSON.stringify(rawPort)} 非法，回落到 8888`);
  }

  // 策略（白名单 + 出网方式）来自分层配置（团队 config.json + 个人 config.local.json，白名单取并集），
  // 启动时加载一次，之后每 2 秒查文件戳热重载（policy-reload.mjs）。任何一步读不出来都只告警：
  // 首次失败回落内置默认（空白名单 + 直连），之后失败保留上一份生效策略——绝不阻断代理启动
  // （这是集群侧全部出网流量的生命线，起不来比少几条白名单严重得多）。
  // 代理口令与使用记录（v2.62）都在运行目录里：口令文件由控制面写、这里只读（同一个 2 秒轮询热重载）；
  // 使用记录由这里写、控制面只读。口令默认关——关着的时候记录器什么都不做。运行目录解析不出来时两样都没有。
  const usage = paths ? createUsageRecorder({ filePath: path.join(paths.runtimeDir, PROXY_USAGE_FILE) }) : null;
  const policyLoader = createPolicyLoader({
    configPath: paths?.configPath,
    localConfigPath: paths?.localConfigPath,
    selfPort: port || null,
    authPath: paths ? path.join(paths.runtimeDir, PROXY_AUTH_FILE) : null,
    onAuthChange: (auth) => usage?.setAuthMode(auth.mode),
    log: (line) => console.error(line),
  });
  try {
    await policyLoader.load();
  } catch (err) {
    console.error(`[proxy-config] 加载代理策略异常，按内置默认运行: ${err?.message || err}`);
  }

  // 组件指纹：启动时算一次并冻结，经 /proxy-health 响应头发布，supervisor 读回后写进运行快照。
  let component = "";
  try {
    component = (await computeComponentHashes(sourceRoot)).proxy || "";
  } catch {}

  const handoffMode = process.env[PROXY_HANDOFF_ENV] === "1";
  // 可变对象：释放监听装上之后才补上 handoff 头（createProxyServer 每次响应现读）。
  const healthHeaders = buildProxyHealthHeaders({ component, handoff: false });
  const proxy = createProxyServer({
    port,
    getPolicy: policyLoader.getPolicy,
    healthHeaders,
    usage,
  });
  policyLoader.start();
  const onFatal = (err) => {
    console.error(`Proxy server error: ${err.message}`);
    if (err.code === "EADDRINUSE") {
      console.error(`Address 127.0.0.1:${port} is already in use.`);
      process.exit(2);
    } else {
      process.exit(1);
    }
  };
  // 监听起来之后的 accept 失败（EMFILE 等）只限频告警、不退出；其余错误仍走 onFatal。
  const onServerError = createServerErrorHandler({ onFatal });

  let releaseWatcher = null;
  let releasing = false;
  async function releaseAndDrain(trigger) {
    if (releasing) return;
    releasing = true;
    if (releaseWatcher) releaseWatcher.stop();
    policyLoader.stop(); // 排空期只服务存量连接，不再跟配置变化
    usage?.release(); // 放掉监听之前写最后一次使用记录；之后这份文件归新代理写
    console.log(`[handoff] release requested (${trigger}); listener closed, draining ${proxy.activeConnections()} connection(s)`);
    const result = await proxy.release({ maxDrainMs: HANDOFF_DRAIN_MAX_MS });
    console.log(`[handoff] ${result.drained ? "all connections drained" : `drain window elapsed with ${result.remaining} connection(s) left`}, exiting`);
    if (paths) removeOwnDrainingRecord({ runtimeDir: paths.runtimeDir });
    process.exit(0);
  }
  function armReleaseTriggers() {
    usage?.start(); // 端口到手之后才读回 / 开始写使用记录（交接时旧代理此刻已写完它的最后一次）
    if (paths) {
      releaseWatcher = watchReleaseRequest({
        file: proxyReleaseRequestPath(paths.runtimeDir, process.pid),
        onRelease: () => releaseAndDrain("control-file"),
      });
      Object.assign(healthHeaders, buildProxyHealthHeaders({ component, handoff: true }));
    }
    if (process.platform !== "win32") process.on("SIGUSR2", () => releaseAndDrain("SIGUSR2"));
  }

  if (handoffMode) {
    proxy.listenWithHandoffRetry({ onWaiting: () => console.log(`${HANDOFF_WAITING_MARKER} 127.0.0.1:${port}`) })
      .then(() => {
        proxy.server.on("error", onServerError);
        armReleaseTriggers();
      })
      .catch(onFatal);
  } else {
    proxy.server.on("error", onServerError);
    proxy.listen(armReleaseTriggers);
  }
}
