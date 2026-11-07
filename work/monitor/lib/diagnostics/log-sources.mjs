// 工作台自身故障日志的来源名（v2.64）：runtime/logs/<来源>.ndjson，一律经 lib/logger.mjs 的 createLogger 写（2 MB 轮转、只留一份 .1）。
// 一个文件只有一个写入方——logger 的轮转按本进程记的大小判断，两个进程追加同一份会让文件超过 2 MB、互相盖掉分卷。
//   desktop   只由 Electron 主进程写（electron-main.mjs 建）：未捕获异常、窗口界面进程退出 / 无响应、子进程退出
//             （desktop/crash-watch.mjs），拉起监控服务的失败、异常退出与「停止自动重启」（desktop/monitor-process.mjs），
//             窗口等不到后端（desktop/windows.mjs）。
//   launcher  只由启动器 scripts/launch.mjs 写：启动失败、桌面壳起不来、异常退出与「停止自动拉起」。
//   renderer  只由监控服务写（lib/diagnostics/service.mjs）：页面脚本的未捕获异常与未处理 rejection。
// 开机自启时这些进程的标准输出被丢弃，只有这里看得见。无依赖：Electron 入口、启动器与监控服务都引它。
export const DESKTOP_LOG_SOURCE = "desktop";
export const LAUNCHER_LOG_SOURCE = "launcher";
export const RENDERER_LOG_SOURCE = "renderer";
