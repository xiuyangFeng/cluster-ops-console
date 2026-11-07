// 开机自启的启动约定（v2.62）。scripts/launch.mjs 与监控服务两边引用，单独成文件、不带任何依赖。
//
//   AUTOSTART_FLAG     登录时由系统拉起的那一次带这个参数（start.sh / start-console.cmd 把参数原样传给
//                      launch.mjs）：网页模式不弹浏览器，桌面壳照常起。
//   AUTOSTART_ENV      launch.mjs 看到上面的参数后设给它起的进程。监控服务据此知道「这一份就是开机自启拉起来的」：
//                      关掉开关时不能对它执行 launchctl bootout（那等于把正在用的这一份结束掉）。
//   LAUNCHER_PATH_ENV  launch.mjs 启动时的 PATH，原样带给监控服务。写 macOS 的自启文件时用的是它：登录时
//                      start.sh 按同一个 PATH、同样的顺序找 node / git / ssh，结果才和手动启动时一致。
//                      不直接用监控服务自己的 PATH——桌面模式下 Electron 入口往最前面插了一串常见目录
//                      （desktop/context.mjs 的 buildDesktopPathEnv），顺序已经变了。
export const AUTOSTART_FLAG = "--autostart";
export const AUTOSTART_ENV = "CODEX_MONITOR_AUTOSTART";
export const LAUNCHER_PATH_ENV = "CODEX_MONITOR_LAUNCHER_PATH";

// 自启文件里的标记：只有带这一行的文件才是工作台放的，才允许改写或删除（与安装器给桌面图标打标记是同一个做法）。
export const AUTOSTART_MARKER = "cluster-workbench-autostart: managed";
