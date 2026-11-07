// 网页模式下「请把我重新拉起来」的约定（v2.59，自更新）：monitor-server 以这个退出码结束，
// scripts/launch.mjs 看到它就再起一份（数据面——守护进程、本地代理、SSH 隧道——是分离的进程，不受影响，
// 新进程按热启动接管）。launch.mjs 起监控服务时带上 RESPAWN_ENV=1，服务据此知道有没有人会把它拉起来。
// 单独成文件、不带任何依赖：scripts/ 与 work/monitor/ 两边都要引用。
export const RESTART_EXIT_CODE = 75;
export const RESPAWN_ENV = "CODEX_MONITOR_RESPAWN";
// launch.mjs 把自己跑在哪个 Node 上（process.versions.node）经这个环境变量带给监控服务。桌面模式下监控服务
// 跑在 Electron 自带的 Node 上，而「Node 版本不合适就拒绝启动」的那道闸在 launch.mjs、看的是系统的 Node：
// 自更新预检目标版本的 engines.node 时要对的是后者（见 service.mjs 的 planUpdate）。
export const LAUNCHER_NODE_ENV = "CODEX_MONITOR_LAUNCHER_NODE";
