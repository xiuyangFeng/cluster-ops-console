import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSshRuntimeExecutor } from "./ssh-runtime.mjs";
import { createJumpConfig, resolveSshRoute } from "./ssh-route.mjs";
import { validateServerInput } from "./servers/validate.mjs";
import { validatePersonalServersForWrite, mergeConfig } from "./config-loader.mjs";

const master = { id: "master", host: "master.example", sshUser: "kai", sshIdentityFile: "/keys/master key", sshPort: 2222, tunnel: false };
const node = { id: "n4-user01", host: "node04", sshUser: "user01", sshIdentityFile: "/keys/node key", sshPort: 22, sshJumpServerId: "master", tunnel: false };
test("节点账号与单级路由写入、重新加载和表单校验一致", () => {
  const input = validateServerInput(node);
  assert.equal(input.sshJumpServerId, "master");
  const validated = validatePersonalServersForWrite([master, input]);
  assert.equal(validated.ok, true);
  const merged = mergeConfig({ servers: [] }, { servers: validated.value });
  assert.equal(merged.servers[1].sshJumpServerId, "master");
  assert.deepEqual(resolveSshRoute(merged.servers[1], merged).map((s) => s.sshUser), ["kai", "user01"]);
  assert.throws(() => validateServerInput({ ...node, tunnel: true, remotePort: 7898 }));
  for (const servers of [[node], [{ ...master, disabled: true }, node], [{ ...master, sshJumpServerId: node.id }, node]]) assert.throws(() => resolveSshRoute(node, { servers }));
});

test("两跳密钥/密码四种组合使用独立身份，临时配置与 argv/env 都不含密码", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ssh-route-"));
  try {
    for (const jumpPassword of [false, true]) for (const targetPassword of [false, true]) {
      const jump = { ...master, ...(jumpPassword ? { authRef: "mem:jump" } : {}) };
      const target = { ...node, ...(targetPassword ? { authRef: "mem:target" } : {}) };
      const config = { servers: [jump, target] };
      let sessionInput, executed = false, disposed = false;
      const execute = createSshRuntimeExecutor({ getConfig: async () => config, helperDir: dir,
        credentialVault: { get: async (ref) => ref === "mem:jump" ? "secret-jump" : "secret-target" },
        createSession: async (input) => { sessionInput = input; return { args: ["-o", "BatchMode=no"], env: { BROKER: "only-token" }, dispose: async () => { disposed = true; } }; },
        execFileImpl: async (_command, args, options) => {
          executed = true;
          const file = args[args.indexOf("-F") + 1];
          const body = readFileSync(file, "utf8");
          assert.match(body, /HostName master\.example\n {2}Port 2222/);
          assert.match(body, /User kai/);
          assert.match(body, /User user01/);
          assert.match(body, /IdentityFile "\/keys\/master key"/);
          assert.match(body, /IdentityFile "\/keys\/node key"/);
          assert.equal(/secret-jump|secret-target/.test(body + JSON.stringify([args, options])), false);
          return { code: 0, stdout: "ok" };
        } });
      const result = await execute("ssh", ["-l", "user01", "node04", "true"], { server: target });
      assert.equal(result.code, 0);
      assert(executed);
      assert.deepEqual(readdirSync(dir), []);
      if (jumpPassword || targetPassword) {
        assert(disposed);
        assert.equal(sessionInput.passwords.length, Number(jumpPassword) + Number(targetPassword));
        assert.deepEqual(sessionInput.passwords.map((p) => p.user), [...(jumpPassword ? ["kai"] : []), ...(targetPassword ? ["user01"] : [])]);
      } else assert.equal(sessionInput, undefined);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("跳板在取密码期间被编辑时不发送旧凭据；账号在采集期间变化则丢弃旧结果", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ssh-route-race-"));
  try {
    const config = { servers: [{ ...master, authRef: "mem:jump" }, node] };
    let sent = false;
    const execute = createSshRuntimeExecutor({ getConfig: async () => config, helperDir: dir,
      credentialVault: { get: async () => { config.servers[0] = { ...master, host: "changed.example" }; return "secret"; } },
      execFileImpl: async () => { sent = true; return { code: 0 }; } });
    assert.match((await execute("ssh", [node.host, "true"], { server: node })).stderr, /config-changed/);
    assert.equal(sent, false);
    const direct = { ...node, sshJumpServerId: "" };
    config.servers = [direct];
    const changed = createSshRuntimeExecutor({ getConfig: async () => config, execFileImpl: async () => { config.servers = [{ ...direct, sshUser: "other" }]; return { code: 0, stdout: "private old account" }; } });
    const result = await changed("ssh", [direct.host, "true"], { server: direct });
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /config-changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SSH 配置拒绝身份文件的换行注入，并且两跳都强制核对主机密钥", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ssh-route-policy-"));
  try {
    assert.throws(() => createJumpConfig([{ ...master, sshIdentityFile: "key\nProxyCommand evil" }, node], { helperDir: dir }));
    const route = createJumpConfig([master, node], { helperDir: dir });
    try { assert.equal((readFileSync(route.args[1], "utf8").match(/StrictHostKeyChecking yes/g) || []).length, 2); } finally { route.dispose(); }
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
