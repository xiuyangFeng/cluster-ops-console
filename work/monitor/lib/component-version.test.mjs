import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeComponentHashes, diffComponents, listImportClosure } from "./component-version.mjs";

// 迷你应用根：supervisor → monitor-core + lib/shared + lib/agents/x；proxy → lib/shared；
// lib/monitor-only 不被任何数据面入口 import。
async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cv-"));
  await mkdir(path.join(root, "work/monitor/lib/agents"), { recursive: true });
  await writeFile(path.join(root, "work/monitor/channel-supervisor.mjs"),
    'import { a } from "./monitor-core.mjs";\nimport "./lib/agents/x.mjs";\nexport { b } from "./lib/shared.mjs?v=1";\nconst fs = await import("node:fs");\n');
  await writeFile(path.join(root, "work/monitor/monitor-core.mjs"), "export const a = 1;");
  await writeFile(path.join(root, "work/monitor/lib/shared.mjs"), "export const b = 2;");
  await writeFile(path.join(root, "work/monitor/lib/agents/x.mjs"), "x");
  await writeFile(path.join(root, "work/monitor/lib/monitor-only.mjs"), "m");
  await writeFile(path.join(root, "work/monitor/lib/x.test.mjs"), "t1");
  await writeFile(path.join(root, "work/local_http_connect_proxy.mjs"),
    '// see "./monitor/lib/does-not-exist.mjs"\nimport { b } from "./monitor/lib/shared.mjs";\n');
  return root;
}

test("listImportClosure: 沿相对 import / re-export / 副作用 import 递归，剥查询串，忽略内置与不存在的路径", async () => {
  const root = await makeRoot();
  assert.deepEqual(await listImportClosure(root, "work/monitor/channel-supervisor.mjs"), [
    "work/monitor/channel-supervisor.mjs",
    "work/monitor/lib/agents/x.mjs",
    "work/monitor/lib/shared.mjs",
    "work/monitor/monitor-core.mjs",
  ]);
  assert.deepEqual(await listImportClosure(root, "work/local_http_connect_proxy.mjs"), [
    "work/local_http_connect_proxy.mjs",
    "work/monitor/lib/shared.mjs",
  ]);
});

test("computeComponentHashes: 稳定、12 位、测试文件与控制面专属模块不影响指纹", async () => {
  const root = await makeRoot();
  const a = await computeComponentHashes(root);
  assert.match(a.supervisor, /^[0-9a-f]{12}$/);
  assert.match(a.proxy, /^[0-9a-f]{12}$/);
  await writeFile(path.join(root, "work/monitor/lib/x.test.mjs"), "t2");
  await writeFile(path.join(root, "work/monitor/lib/monitor-only.mjs"), "m2");
  assert.deepEqual(await computeComponentHashes(root), a);
});

test("computeComponentHashes: 只改 supervisor 依赖时 proxy 指纹不变；共享依赖两者都变", async () => {
  const root = await makeRoot();
  const a = await computeComponentHashes(root);
  await writeFile(path.join(root, "work/monitor/lib/agents/x.mjs"), "x2");
  const b = await computeComponentHashes(root);
  assert.notEqual(b.supervisor, a.supervisor);
  assert.equal(b.proxy, a.proxy);
  await writeFile(path.join(root, "work/monitor/monitor-core.mjs"), "export const a = 3;");
  const c = await computeComponentHashes(root);
  assert.notEqual(c.supervisor, b.supervisor);
  assert.equal(c.proxy, b.proxy);
  await writeFile(path.join(root, "work/monitor/lib/shared.mjs"), "export const b = 4;");
  const d = await computeComponentHashes(root);
  assert.notEqual(d.supervisor, c.supervisor);
  assert.notEqual(d.proxy, c.proxy);
});

test("computeComponentHashes: 真实仓库的数据面闭包覆盖代理间接依赖（ssh-args / host-key-policy / stat-cache）", async () => {
  const appRoot = path.resolve(import.meta.dirname, "../../..");
  const proxy = await listImportClosure(appRoot, "work/local_http_connect_proxy.mjs");
  for (const file of ["work/monitor/lib/ssh-args.mjs", "work/monitor/lib/host-key-policy.mjs", "work/monitor/lib/stat-cache.mjs"]) {
    assert.ok(proxy.includes(file), `代理指纹缺 ${file}`);
  }
  const supervisor = await listImportClosure(appRoot, "work/monitor/channel-supervisor.mjs");
  assert.ok(supervisor.includes("work/monitor/monitor-core.mjs"));
  assert.ok(!supervisor.includes("work/monitor/lib/http-router.mjs"), "控制面路由不属于 supervisor");
});

test("computeComponentHashes: 读盘失败的组件为空串", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cv-empty-"));
  assert.deepEqual(await computeComponentHashes(root), { supervisor: "", proxy: "" });
});

test("diffComponents: 相同不交接，不同或未知需要交接", () => {
  assert.deepEqual(diffComponents({ supervisor: "a", proxy: "b" }, { supervisor: "a", proxy: "b" }), []);
  assert.deepEqual(diffComponents({ supervisor: "a", proxy: "b" }, { supervisor: "c", proxy: "b" }), ["supervisor"]);
  assert.deepEqual(diffComponents({ supervisor: "", proxy: "b" }, { supervisor: "a", proxy: "b" }), ["supervisor"]);
  assert.deepEqual(diffComponents({}, {}), ["supervisor", "proxy"]);
});
