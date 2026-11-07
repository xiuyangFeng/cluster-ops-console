// 热更新两组修复合并后的三处衔接：显式退出停排空旧代理、CLI 的 ps 走 UTF-8 区域、横幅认识升级中拒绝码。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("hot-update 的真实 run 以 UTF-8 区域执行 ps/pgrep", () => {
  const src = read("scripts/hot-update.mjs");
  assert.match(src, /import \{ utf8LocaleEnv \} from "\.\.\/work\/monitor\/lib\/process-registry\.mjs"/);
  assert.match(src, /execFile\(cmd, args, \{[^}]*env: utf8LocaleEnv\(\)/);
});

test("更新横幅认识 data-plane-upgrading 拒绝码", async () => {
  const src = read("work/monitor/public/assets/js/render/update-banner.js");
  assert.match(src, /"data-plane-upgrading": "后台组件升级中，请稍候"/);
});
