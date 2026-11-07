import { test } from "node:test";
import assert from "node:assert/strict";

import { createSupervisorLog, isSshStderrNoise } from "./log-policy.mjs";

function fakeFileLogger() {
  const entries = [];
  const at = (level) => (message, fields) => entries.push({ level, message, fields });
  return { entries, info: at("info"), warn: at("warn"), error: at("error") };
}

test("createSupervisorLog：stdout 一行（带 nextAction）+ 结构化日志一条，级别按消息推断或显式指定", (t) => {
  const printed = [];
  t.mock.method(console, "log", (line) => printed.push(line));
  const fileLogger = fakeFileLogger();
  let channel = null;
  const log = createSupervisorLog({ getFileLogger: () => fileLogger, getChannelId: () => channel });

  log("ssh tunnel failed quickly, next retry in 2s");
  channel = "server-01"; // 活跃服务器在写日志时现读
  log("hello", { level: "error", event: "x", nextAction: "do it" });
  log("plain");

  assert.match(printed[0], /^\d{4}-\d\d-\d\dT.* ssh tunnel failed quickly, next retry in 2s$/);
  assert.match(printed[1], / hello nextAction=do it$/);
  assert.deepEqual(fileLogger.entries, [
    { level: "warn", message: "ssh tunnel failed quickly, next retry in 2s", fields: {} },
    { level: "error", message: "hello", fields: { channelId: "server-01", event: "x", nextAction: "do it" } },
    { level: "info", message: "plain", fields: { channelId: "server-01" } },
  ]);
});

test("createSupervisorLog：没有结构化日志（被 import 时）只写 stdout；日志器抛错不外泄", (t) => {
  const printed = [];
  t.mock.method(console, "log", (line) => printed.push(line));
  createSupervisorLog()("no file logger");
  assert.equal(printed.length, 1);
  const log = createSupervisorLog({ getFileLogger: () => ({ info: () => { throw new Error("disk"); } }) });
  assert.doesNotThrow(() => log("still fine"));
});

test("isSshStderrNoise：空行与 debugN: 行是噪声", () => {
  assert.equal(isSshStderrNoise(""), true);
  assert.equal(isSshStderrNoise("debug1: Reading configuration data"), true);
  assert.equal(isSshStderrNoise("Permission denied (publickey)."), false);
});
