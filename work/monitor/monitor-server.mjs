// v2 monitor-server 入口（控制面）。组装根在 server/start.mjs，各装配簇在 server/*.mjs：
//   runtime-env（环境/路径/版本）· kernel（日志器/存储/注册表）· telemetry（时间线/指标监听）
//   credential-runtime（vault + SSH 执行器）· bridge-ingest · snapshot-poller · build-info-service
//   storage-maintenance · runners（通道 + 执行器互斥）· config-refresh · incident-sync
//   auto-repair(-runner) · signal-sink · status-extras · services · hot-start · http-server · lifecycle
// 本文件只保留 isMain 守卫。
// 第一个 import：Windows 安装版的子进程不弹命令行窗口（见该文件说明）。
import "./lib/windows-hide-children.mjs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// isMain 守卫：本文件是生产入口脚本（scripts/launch.mjs / launchd 以
// `node work/monitor/monitor-server.mjs` 方式启动）。被 import 时绝不能触发服务器
// 监听、进程注册表/状态存储创建等副作用——判据与 channel-supervisor.mjs /
// local_http_connect_proxy.mjs 已有的 isMain 惯例一致：只有被直接执行的入口文件与本模块相同
// 时才为 true；被 import 时 process.argv[1] 指向调用方文件，恒为 false。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// 冷启动（perf）：先打开 V8 编译缓存再加载服务端模块图（约 150 个模块），之后每次启动省掉大部分
// 编译时间；缓存在系统临时目录、按 Node 版本与源码哈希自动失效，不支持的运行时（旧 Node）静默跳过。
// 服务端模块因此改为动态 import——静态 import 会先于这里执行。
if (isMain) {
  try {
    module.enableCompileCache?.();
  } catch {}
  const { startMonitorServer } = await import("./server/start.mjs");
  await startMonitorServer({ env: process.env });
}
