import assert from "node:assert/strict";
import test from "node:test";
import { createSshRuntimeExecutor, SSH_CONNECT_TIMEOUT_SEC, withConnectTimeout } from "./ssh-runtime.mjs";
import { createChannelToolkit } from "./probes.mjs";

function fixture(overrides = {}) {
  const server = { id: "personal-1", host: "192.0.2.8", sshUser: "reader", sshPort: 2222, tunnel: false, authRef: "mem:fixture" };
  const config = { activeServerId: server.id, servers: [server] };
  const calls = [];
  let disposed = 0;
  const execute = createSshRuntimeExecutor({
    getConfig: async () => config,
    credentialVault: { get: async (ref) => { assert.equal(ref, server.authRef); return "fixture password"; } },
    createSession: async ({ password }) => {
      assert.equal(password, "fixture password");
      return { args: ["-o", "BatchMode=no"], env: { BROKER: "fixture" }, dispose: async () => { disposed++; } };
    },
    execFileImpl: async (cmd, args, options) => { calls.push({ cmd, args, options }); return { code: 255, stdout: "", stderr: "Connection refused" }; },
    ...overrides,
  });
  return { server, config, calls, execute, disposed: () => disposed };
}

test("normal monitor-only collection uses password session, preserves stdin and disposes on SSH failure", async () => {
  const f = fixture();
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: async () => f.config, execFileImpl: f.execute });
  let spec;
  toolkit.registerLoadProbes({ scheduler: { registerProbe: (s) => { spec = s; } }, servers: f.config.servers, getShouldBeRunning: () => true });
  const result = await spec.run();
  assert.equal(result.level, "error");
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.deepEqual(call.args.slice(0, 2), ["-o", "BatchMode=no"]);
  assert.ok(call.args.includes("2222"));
  assert.ok(call.args.includes("reader"));
  assert.ok(call.options.input.length > 100);
  assert.deepEqual(call.options.env, { BROKER: "fixture" });
  assert.equal(JSON.stringify(call).includes("fixture password"), false);
  assert.equal(f.disposed(), 1);
});

test("expired or inaccessible vault never falls back to key SSH or exposes vault exception text", async () => {
  for (const get of [async () => null, async () => { throw new Error("sensitive fixture response"); }]) {
    const f = fixture({ credentialVault: { get } });
    const result = await f.execute("ssh", [f.server.host, "true"], { server: f.server });
    assert.equal(result.code, 255);
    assert.match(result.stderr, /auth-required/);
    assert.equal(result.stderr.includes("sensitive fixture"), false);
    assert.equal(f.calls.length, 0);
  }
});

test("removed, disabled or edited endpoint rejects captured SSH invocation before credential lookup", async () => {
  for (const change of [(c) => { c.servers = []; }, (c) => { c.servers[0].disabled = true; }, (c) => { c.servers[0].host = "192.0.2.9"; }]) {
    const f = fixture({ credentialVault: { get: async () => { assert.fail("vault lookup forbidden"); } } });
    const snapshot = { ...f.server };
    change(f.config);
    const result = await f.execute("ssh", [snapshot.host, "true"], { server: snapshot });
    assert.match(result.stderr, /config-changed/);
    assert.equal(f.calls.length, 0);
  }
});

test("endpoint edited during vault await cannot receive old password", async () => {
  let release;
  const f = fixture({ credentialVault: { get: () => new Promise((resolve) => { release = resolve; }) } });
  const pending = f.execute("ssh", [f.server.host, "true"], { server: { ...f.server } });
  await Promise.resolve();
  f.config.servers = [{ ...f.server, sshUser: "another-user" }];
  release("fixture password");
  assert.match((await pending).stderr, /config-changed/);
  assert.equal(f.calls.length, 0);
});

test("key-only SSH and local commands do not open a password broker", async () => {
  const f = fixture({ createSession: async () => { assert.fail("unexpected broker"); } });
  delete f.server.authRef;
  await f.execute("ssh", [f.server.host, "true"], { server: f.server });
  await f.execute("ps", ["-ef"]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].options.env, undefined);
});

test("password broker disposed when executor throws", async () => {
  const f = fixture({ execFileImpl: async () => { throw new Error("spawn failed"); } });
  assert.equal((await f.execute("ssh", [f.server.host, "true"], { server: f.server })).code, 255);
  assert.equal(f.disposed(), 1);
});

test("in-place endpoint mutation during vault lookup is rejected", async () => {
  let release;
  const f = fixture({ credentialVault: { get: () => new Promise((resolve) => { release = resolve; }) } });
  const pending = f.execute("ssh", [f.server.host, "true"], { server: { ...f.server } });
  await Promise.resolve();
  f.config.servers[0].host = "192.0.2.99";
  release("fixture password");
  assert.match((await pending).stderr, /config-changed/);
  assert.equal(f.calls.length, 0);
});

test("target changed while broker starts is rejected and broker is disposed", async () => {
  let created;
  let disposeCount = 0;
  const f = fixture({ createSession: () => new Promise((resolve) => { created = resolve; }) });
  const pending = f.execute("ssh", [f.server.host, "true"], { server: { ...f.server } });
  while (!created) await Promise.resolve();
  f.config.servers[0].sshUser = "changed";
  created({ args: [], env: {}, dispose: async () => { disposeCount++; } });
  assert.match((await pending).stderr, /config-changed/);
  assert.equal(f.calls.length, 0);
  assert.equal(disposeCount, 1);
});

test("bootstrap scp uses the same password session and captured server identity", async () => {
  const f = fixture();
  await f.execute("scp", ["-P", "2222", "archive.tar.gz", `${f.server.host}:/tmp/`], { server: { ...f.server } });
  assert.equal(f.calls[0].cmd, "scp");
  assert.equal(f.calls[0].args[1], "BatchMode=no");
  assert.equal(f.disposed(), 1);
});

test("ssh / scp 统一带 10 秒连接超时：放在调用方参数最前、会话参数之后；调用方自己给了就不动", async () => {
  const f = fixture();
  await f.execute("ssh", [f.server.host, "true"], { server: f.server });
  assert.deepEqual(f.calls[0].args, ["-o", "BatchMode=no", "-o", "ConnectTimeout=10", f.server.host, "true"]);
  await f.execute("scp", ["-P", "2222", "a.tgz", `${f.server.host}:/tmp/`], { server: f.server });
  assert.deepEqual(f.calls[1].args.slice(2, 4), ["-o", "ConnectTimeout=10"]);
  for (const own of [["-o", "ConnectTimeout=8"], ["-oConnectTimeout=8"], ["-o", "connecttimeout 8"]]) {
    const g = fixture();
    delete g.server.authRef;
    await g.execute("ssh", [...own, g.server.host, "true"], { server: g.server });
    assert.deepEqual(g.calls[0].args, [...own, g.server.host, "true"]);
  }
  assert.deepEqual(withConnectTimeout(["host"]), ["-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SEC}`, "host"]);
});

test("onSshResult：只在真实发出 ssh 之后回调（带执行时的服务器条目与结果）；本地命令、scp、合成的失败都不回调；回调抛错不影响结果", async () => {
  const seen = [];
  const f = fixture({ onSshResult: (event) => { seen.push(event); throw new Error("observer bug"); } });
  const result = await f.execute("ssh", [f.server.host, "true"], { server: f.server });
  assert.equal(result.code, 255);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].server.host, f.server.host);
  assert.equal(seen[0].result, result);
  await f.execute("ps", ["-ef"]);
  await f.execute("scp", ["a", `${f.server.host}:/tmp/`], { server: f.server });
  assert.equal(seen.length, 1);

  const gone = fixture({ onSshResult: (event) => seen.push(event), credentialVault: { get: async () => null } });
  assert.match((await gone.execute("ssh", [gone.server.host, "true"], { server: gone.server })).stderr, /auth-required/);
  assert.equal(seen.length, 1);
});
