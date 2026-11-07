import assert from "node:assert/strict";
import test from "node:test";

import { collectorPortsFor } from "./collect.mjs";
import { shouldRegisterValidation, validationTimeoutMs, VALIDATION_ITEM_TIMEOUT_MS } from "./validation.mjs";

test("collectorPortsFor: 只带该服务器自己的 remotePort，非法值丢弃", () => {
  assert.deepEqual(collectorPortsFor({ remotePort: 9000 }), [9000]);
  assert.deepEqual(collectorPortsFor({ remotePort: "7893" }), [7893]);
  assert.deepEqual(collectorPortsFor({ remotePort: 70000 }), []);
  assert.deepEqual(collectorPortsFor({ remotePort: "bad" }), []);
  assert.deepEqual(collectorPortsFor(undefined), []);
});

test("validation 注册规则：只注册活跃、启用、建隧道、有档案的团队服务器", () => {
  const base = { id: "s", validationProfile: { remoteProxyTest: "true" } };
  assert.equal(shouldRegisterValidation(base, "s"), true);
  assert.equal(shouldRegisterValidation(base, "other"), false);
  assert.equal(shouldRegisterValidation({ ...base, disabled: true }, "s"), false);
  assert.equal(shouldRegisterValidation({ ...base, tunnel: false }, "s"), false);
  assert.equal(shouldRegisterValidation({ ...base, source: "personal" }, "s"), false);
  assert.equal(shouldRegisterValidation({ id: "s" }, "s"), false);
});

test("validation 超时预算：每项 10s 串行之和 + 5s 余量", () => {
  const profile = { remoteProxyTest: "x", agentVersionCommands: { codex: "codex -V", reclaude: "reclaude -v" }, workspaceSmokeCommand: "ls" };
  assert.equal(validationTimeoutMs(profile), 4 * VALIDATION_ITEM_TIMEOUT_MS + 5000);
  assert.equal(validationTimeoutMs(undefined), 5000);
  assert.equal(validationTimeoutMs({}), 5000);
});

test("validation（v2.57）：设置页关着的 Agent 不跑版本命令（跳过），对不上 Agent 的键照旧执行", async () => {
  const { createValidationProbe, VALIDATION_SKIP_AGENT_DISABLED } = await import("./validation.mjs");
  const commands = [];
  const server = {
    id: "server-01", host: "myserver", remotePort: 7891,
    validationProfile: { agentVersionCommands: { codex: "codex --version", "claude-codewing": "reclaude --version", other: "other --version" } },
  };
  const config = {
    servers: [server],
    agentCatalog: [{ id: "codex", enabled: true }, { id: "claude-codewing", enabled: false }],
  };
  const probe = createValidationProbe({
    getConfig: async () => config,
    sshArgsFor: () => ["myserver"],
    execFileCmd: async (_cmd, args) => {
      commands.push(args.at(-1));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  const result = await probe.runValidationProbe("server-01");
  assert.equal(commands.length, 2);
  assert.ok(!commands.some((c) => c.includes("reclaude")));
  const skipped = result.data.items.find((item) => item.key === "agentVersion:claude-codewing");
  assert.equal(skipped.skipped, VALIDATION_SKIP_AGENT_DISABLED);
  assert.equal(skipped.ok, null);
  assert.equal(result.level, "ok");
  assert.match(result.reason, /跳过 1 项/);
});

test("activeHostKey：同步返回活跃服务器主机名（不再是 Promise → \"[object Promise]\"）", async () => {
  const { createProbeContext } = await import("./context.mjs");
  const ctx = createProbeContext({
    rootDir: "/tmp",
    dataDir: "/tmp",
    getConfig: async () => ({ activeServerId: "s1", servers: [{ id: "s1", host: "myserver", remotePort: 7891, localPort: 8888 }] }),
    execFileImpl: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const hostKey = ctx.activeHostKey();
  const first = hostKey();
  assert.ok(first === null || first === "myserver", "首次读完配置前为 null");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const value = hostKey();
  assert.equal(typeof value, "string");
  assert.equal(value, "myserver");
});
