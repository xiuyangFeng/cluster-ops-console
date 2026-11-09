// 打包闭包守卫：.app 只收录白名单文件（build-macos-app.sh 第 3 步：根目录的 electron-main.mjs /
// preload.js / package.json / config.json、work/monitor/ 整棵（去掉测试）、work/local_http_connect_proxy.mjs）。
// 拆模块时若把运行时代码放到白名单之外（例如仓库根的新目录或 scripts/），`node --check` 与
// 源码模式测试都发现不了，打包后才在 import 时崩溃——这里按四个运行入口的静态 import 闭包提前拦下。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listImportClosure } from "../work/monitor/lib/component-version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = [
  "electron-bootstrap.mjs",
  "electron-main.mjs",
  "work/monitor/monitor-server.mjs",
  "work/monitor/channel-supervisor.mjs",
  "work/local_http_connect_proxy.mjs",
];
const ROOT_FILES = new Set(["electron-bootstrap.mjs", "electron-main.mjs", "preload.js", "package.json", "config.json"]);

function isBundled(rel) {
  if (ROOT_FILES.has(rel) || rel === "work/local_http_connect_proxy.mjs") return true;
  return rel.startsWith("work/monitor/") && !rel.endsWith(".test.mjs") && !rel.includes("/runtime/");
}

for (const entry of ENTRIES) {
  test(`打包闭包：${entry} 的静态依赖全部落在 .app 白名单内`, async () => {
    const closure = await listImportClosure(ROOT, entry);
    assert.ok(closure.length > 1, `${entry} 闭包解析异常`);
    const outside = closure.filter((rel) => !isBundled(rel));
    assert.deepEqual(outside, [], `这些文件不会被打进 .app：${outside.join(", ")}`);
  });
}
