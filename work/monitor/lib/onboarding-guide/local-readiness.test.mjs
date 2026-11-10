import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { localReadiness } from "./local-readiness.mjs";
import { DEDICATED_KEY_NAME } from "./local-key.mjs";

const homeDir = path.resolve("fresh-computer-home");
const key = path.join(homeDir, ".ssh", DEDICATED_KEY_NAME);
const inspect = (files = [], extra = {}) => localReadiness({ homeDir, fs: { existsSync: (p) => files.includes(p) }, ...extra });

test("全新电脑没有密钥；只有私钥可补齐公钥；已有密钥不等于服务器已授权", () => {
  assert.equal(inspect().keyState, "create");
  assert.equal(inspect([key]).keyState, "recover-public");
  const ready = inspect([key, `${key}.pub`]);
  assert.equal(ready.keyState, "ready");
  assert.equal(ready.authorized, undefined);
  assert.equal(ready.networkReachable, undefined);
});

test("迁移配置中的密钥丢失时提示重新接入，不因用户名与端口齐全误判就绪", () => {
  const config = { sshIdentityFile: "~/.ssh/old-computer", sshUser: "alice" };
  assert.equal(inspect([], { config }).needsLocalSetup, true);
  assert.equal(inspect([path.join(homeDir, ".ssh", "old-computer")], { config }).needsLocalSetup, false);
  assert.equal(inspect([], { config, server: { authRef: "mem:password" } }).needsLocalSetup, false);
  assert.equal(inspect([key], { config, server: { sshIdentityFile: key } }).needsLocalSetup, false);
  assert.equal(inspect([], { config: {} }).needsLocalSetup, false, "使用默认密钥或 agent 的既有用户不被强制重配");
});
