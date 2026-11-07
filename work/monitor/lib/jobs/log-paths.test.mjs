import assert from "node:assert/strict";
import { test } from "node:test";

import { expandLogTemplate, isUsableLogPath, resolveRegisteredLogs } from "./log-paths.mjs";

test("模板展开：与远端同一规则（%j %A %a %x %u %%，补零宽度，反斜杠整串不展开）", () => {
  const info = { raw: "18782", arr: "18781", task: "3", name: "train", user: "kai" };
  assert.equal(expandLogTemplate("/w/%x_%j.out", info), "/w/train_18782.out");
  assert.equal(expandLogTemplate("/w/slurm_%A_%4a.out", info), "/w/slurm_18781_0003.out");
  assert.equal(expandLogTemplate("/w/%u/%%j.log", info), "/w/kai/%j.log");
  assert.equal(expandLogTemplate("/w/lit\\eral_%j.log", info), "/w/literal_%j.log");
  assert.equal(expandLogTemplate("/w/o_%j.log", { arr: "1", task: "2" }), "/w/o_%j.log", "不知道实际编号时 %j 原样保留，不猜");
  assert.equal(expandLogTemplate("/w/o_%a.log", { raw: "5" }), "/w/o_4294967294.log", "非数组作业的 %a 是 NO_VAL");
  assert.equal(expandLogTemplate("", info), null);
});

test("路径可用性：绝对路径、无未展开的 %、无控制字符、不超长", () => {
  assert.equal(isUsableLogPath("/a/b.log"), true);
  for (const bad of ["a/b.log", "/a/%N.log", "/a/b\n.log", `/${"x".repeat(1100)}`, null, 5]) assert.equal(isUsableLogPath(bad), false, String(bad));
});

test("登记条目解析：相对路径按 WorkDir、没有 StdErr 与 StdOut 同一文件", () => {
  const reg = { workDir: "/public/w", stdout: "logs/xp_%j.log", stderr: null, name: "xp", user: "kai" };
  assert.deepEqual(resolveRegisteredLogs("18765", reg), { stdout: "/public/w/logs/xp_18765.log", stderr: "/public/w/logs/xp_18765.log", sameFile: true, reason: null });
  const split = resolveRegisteredLogs("18765", { ...reg, stdout: "/o/%j.out", stderr: "/o/%j.err" });
  assert.deepEqual([split.stdout, split.stderr, split.sameFile], ["/o/18765.out", "/o/18765.err", false]);
});

test("数组子作业：知道实际编号才展开 %j；%A_%a 不需要实际编号", () => {
  const reg = { workDir: "/w", stdout: "/w/slurm_%A_%a.out", stderr: "/w/xp_%j.err", user: "kai" };
  const without = resolveRegisteredLogs("18781_2", reg);
  assert.equal(without.stdout, "/w/slurm_18781_2.out");
  assert.equal(without.stderr, null);
  assert.match(without.reason, /实际作业号/);
  const withRaw = resolveRegisteredLogs("18781_2", reg, { rawId: "18784" });
  assert.equal(withRaw.stderr, "/w/xp_18784.err");
  assert.equal(resolveRegisteredLogs("18781_2", reg, { rawId: "../x" }).stderr, null, "实际编号也要过白名单");
});

test("没有登记 / 相对路径缺 WorkDir / 无法展开的占位符：不给路径并说明", () => {
  assert.match(resolveRegisteredLogs("1", null).reason, /没有登记/);
  assert.deepEqual(resolveRegisteredLogs("1", { stdout: "o.log", workDir: null }).stdout, null);
  assert.match(resolveRegisteredLogs("1", { stdout: "/w/%N.log" }).reason, /无法展开/);
});
