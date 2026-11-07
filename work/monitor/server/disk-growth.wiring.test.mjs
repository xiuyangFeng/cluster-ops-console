// 磁盘增长归因在 start.mjs 里的装配：fixture 模式（冒烟 / 界面预览用的隔离监控服务）必须整个停用，
// 只有非 fixture 才开始定时测量。这是源码级断言——start.mjs 起的是整个监控服务，没法在单测里执行这一段；
// 服务自身的行为（disable 之后定时不量、按需回 409、一条 SSH 都不发）见 lib/disk-growth/service.test.mjs。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "start.mjs"), "utf8");

test("start.mjs：fixture 模式停用磁盘增长测量，非 fixture 才 start()；退出时 stop()", () => {
  const gate = /if \(fixtureMode\) toolkit\.diskGrowth\?\.disable\("[^"]+"\);\s*else \{\s*toolkit\.diskGrowth\?\.start\(\{/;
  assert.match(source, gate, "start() 必须写在 if (fixtureMode) …disable(…) 的 else 分支里");
  assert.equal(source.match(/diskGrowth\?\.start\(/g).length, 1, "只有这一处发起定时测量");
  assert.equal(source.match(/diskGrowth\?\.disable\(/g).length, 1);
  assert.match(source, /toolkit\.diskGrowth\?\.stop\(\);/, "关停时不再发起新的测量");
  // 定时测量的 SSH 经调度器的全局槽位；整盘用量取状态仓资源层（不另发 SSH）
  const block = source.slice(source.search(gate), source.search(gate) + 500);
  assert.match(block, /acquireSshSlot: \(options\) => scheduler\.acquireSshSlot\(options\)/);
  assert.match(block, /getFilesystem: \(serverId\) => filesystemFromResources\(store\.getLayers\(\)\.resources, serverId\)/);
});
