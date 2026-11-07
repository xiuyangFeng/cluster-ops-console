import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { isPackagedApp, isPackagedWindowsApp, resolveRuntimePaths } from "./runtime-paths.mjs";

// resolveRuntimePaths 用 node:path 的原生实现（随宿主平台切换分隔符与盘符），而 platform
// 参数只决定数据根的选址策略。断言因此必须同样经 path.resolve/join 构造期望值，否则在
// Windows 上会把 "D:\\override\\app" 和 "/override/app" 比出假失败。POSIX 下两者等价，
// 断言强度不变。
const abs = (value) => path.resolve(value);
const under = (base, ...segments) => path.join(abs(base), ...segments);

test("explicit environment overrides control app, data, and config roots", () => {
  const paths = resolveRuntimePaths({
    appRoot: "/source/app",
    dataRoot: "/ignored/data",
    env: {
      CODEX_MONITOR_APP_ROOT: "/override/app",
      CODEX_MONITOR_DATA_DIR: "/override/data",
      CODEX_MONITOR_CONFIG_PATH: "/override/config/custom.json",
      CODEX_MONITOR_LOCAL_CONFIG_PATH: "/override/config/personal.json",
    },
    platform: "linux",
    homeDir: "/home/test",
  });

  assert.deepEqual(paths, {
    appRoot: abs("/override/app"),
    dataRoot: abs("/override/data"),
    configPath: abs("/override/config/custom.json"),
    localConfigPath: abs("/override/config/personal.json"),
    runtimeDir: under("/override/data", "runtime"),
    logsDir: under("/override/data", "runtime", "logs"),
    metricsPath: under("/override/data", "runtime", "metrics.json"),
  });
});

// isPackagedMacApp 只在 platform === "darwin" 时成立，且靠 ".app/Contents/Resources/"
// 这个正斜杠子串判定。Windows 宿主上 path.resolve 会把 appRoot 变成反斜杠形式，子串匹配
// 不上——但那条分支在 Windows 生产里本就永远走不到（platform 必不为 darwin）。
test("packaged macOS app defaults mutable data to Application Support", { skip: process.platform === "win32" }, () => {
  const appRoot = "/Applications/Codex Tunnel Operations Console.app/Contents/Resources/app";
  const paths = resolveRuntimePaths({
    appRoot,
    env: {},
    platform: "darwin",
    homeDir: "/Users/test",
  });

  assert.equal(paths.dataRoot, under("/Users/test", "Library", "Application Support", "codex-tunnel-monitor"));
  assert.equal(paths.configPath, under(appRoot, "config.json"));
  assert.equal(paths.localConfigPath, path.join(paths.dataRoot, "config.local.json"));
});

test("source mode preserves the repository data layout", () => {
  const paths = resolveRuntimePaths({
    appRoot: "/checkout/ops-console",
    env: {},
    platform: "darwin",
    homeDir: "/Users/test",
  });

  assert.equal(paths.dataRoot, under("/checkout/ops-console", "work"));
  assert.equal(paths.configPath, under("/checkout/ops-console", "config.json"));
  assert.equal(paths.localConfigPath, under("/checkout/ops-console", "config.local.json"));
  assert.equal(paths.runtimeDir, under("/checkout/ops-console", "work", "runtime"));
});

test("all derived paths use an explicit data root", () => {
  const paths = resolveRuntimePaths({
    appRoot: "/checkout/ops-console",
    dataRoot: "/var/lib/ops-console",
    env: {},
    platform: "linux",
    homeDir: "/home/test",
  });

  assert.deepEqual(paths, {
    appRoot: abs("/checkout/ops-console"),
    dataRoot: abs("/var/lib/ops-console"),
    configPath: under("/checkout/ops-console", "config.json"),
    localConfigPath: under("/var/lib/ops-console", "config.local.json"),
    runtimeDir: under("/var/lib/ops-console", "runtime"),
    logsDir: under("/var/lib/ops-console", "runtime", "logs"),
    metricsPath: under("/var/lib/ops-console", "runtime", "metrics.json"),
  });
});

test("Windows 安装版（<安装目录>\\resources\\app）认作打包：数据落 %APPDATA%，个人层跟着数据根", () => {
  const appRoot = "C:\\Users\\t\\AppData\\Local\\Programs\\Codex Operations Console\\resources\\app";
  const appData = "C:\\Users\\t\\AppData\\Roaming";
  assert.equal(isPackagedWindowsApp(appRoot, "win32"), true);
  assert.equal(isPackagedWindowsApp(appRoot.replace("resources\\app", "Resources\\App"), "win32"), true, "大小写不敏感");
  assert.equal(isPackagedApp(appRoot, "win32"), true);
  assert.equal(isPackagedWindowsApp(appRoot, "darwin"), false, "只在 Windows 上成立");
  assert.equal(isPackagedWindowsApp("C:\\src\\codex-tunnel-monitor", "win32"), false, "源码 checkout 不是");
  assert.equal(isPackagedWindowsApp("C:\\src\\resources", "win32"), false);

  const paths = resolveRuntimePaths({ appRoot, env: { APPDATA: appData }, platform: "win32", homeDir: "C:\\Users\\t" });
  assert.equal(paths.dataRoot, path.resolve(path.join(appData, "codex-tunnel-monitor")));
  assert.equal(paths.localConfigPath, path.join(paths.dataRoot, "config.local.json"));
  assert.equal(paths.configPath, path.resolve(path.join(appRoot, "config.json")), "团队层仍随安装包");

  // 没有 APPDATA（极少见）：按系统默认位置 <家目录>\AppData\Roaming。
  const fallback = resolveRuntimePaths({ appRoot, env: {}, platform: "win32", homeDir: "C:\\Users\\t" });
  assert.equal(fallback.dataRoot, path.resolve(path.join("C:\\Users\\t", "AppData", "Roaming", "codex-tunnel-monitor")));
});

test("Windows 源码运行仍是仓库布局", () => {
  const paths = resolveRuntimePaths({ appRoot: "/checkout/ops-console", env: { APPDATA: "/appdata" }, platform: "win32", homeDir: "/home/t" });
  assert.equal(paths.dataRoot, under("/checkout/ops-console", "work"));
});
