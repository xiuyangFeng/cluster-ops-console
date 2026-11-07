// 代理入口与 lib/proxy/ 的接线守卫：拆出去的模块全部落在代理的热更新指纹闭包里
// （否则改了它们热更新会误判"代理没变"而不交接）；protocol.mjs 保持叶子模块，
// supervisor import 它时不会把代理实现拖进 supervisor 的指纹。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listImportClosure } from "../component-version.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "../../../..");
const ENTRY = "work/local_http_connect_proxy.mjs";

test("lib/proxy/ 的运行时模块全部在代理指纹闭包内", async () => {
  const closure = await listImportClosure(APP_ROOT, ENTRY);
  const modules = (await readdir(HERE))
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .map((name) => `work/monitor/lib/proxy/${name}`);
  assert.ok(modules.length >= 5);
  const outside = modules.filter((rel) => !closure.includes(rel));
  assert.deepEqual(outside, [], `这些模块不计入代理指纹：${outside.join(", ")}`);
});

test("protocol.mjs 是叶子模块（只依赖 node: 内置）", async () => {
  assert.deepEqual(await listImportClosure(APP_ROOT, "work/monitor/lib/proxy/protocol.mjs"), [
    "work/monitor/lib/proxy/protocol.mjs",
  ]);
});

// config-loader（supervisor 闭包）为个人层白名单 / 出网地址做写入校验要用 address.mjs：它必须保持叶子，
// supervisor 也不能经此把代理实现（策略 / 上游拨号 / 热重载 / server）拖进自己的指纹——否则每次改代理
// 都会连带 supervisor 交接。
test("address.mjs 是叶子模块；supervisor 闭包只含 lib/proxy/ 的 protocol.mjs 与 address.mjs", async () => {
  assert.deepEqual(await listImportClosure(APP_ROOT, "work/monitor/lib/proxy/address.mjs"), [
    "work/monitor/lib/proxy/address.mjs",
  ]);
  const supervisor = await listImportClosure(APP_ROOT, "work/monitor/channel-supervisor.mjs");
  assert.deepEqual(supervisor.filter((rel) => rel.startsWith("work/monitor/lib/proxy/")), [
    "work/monitor/lib/proxy/address.mjs",
    "work/monitor/lib/proxy/protocol.mjs",
  ]);
});
