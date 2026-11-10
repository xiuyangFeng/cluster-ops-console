import assert from "node:assert/strict";
import test from "node:test";

import { createPasswordSshSession } from "./ssh-askpass.mjs";

test("password session: broker token 不进 argv，密码只可读取一次并可 dispose", { skip: process.platform === "win32" }, async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "askpass-broker-"));
  const session = await createPasswordSshSession({ password: "broker-secret", helperDir: dir, nodePath: process.execPath, ttlMs: 10000 });
  try {
    assert.equal(session.args.includes("broker-secret"), false);
    assert.equal(session.env.CODEX_ASKPASS_TOKEN.includes("broker-secret"), false);
    assert.match(session.env.CODEX_ASKPASS_URL, /^http:\/\/127\.0\.0\.1:/);
    const first = await fetch(`${session.env.CODEX_ASKPASS_URL}/password`, { method: "POST", headers: { "x-askpass-token": session.env.CODEX_ASKPASS_TOKEN } });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).password, "broker-secret");
    const second = await fetch(`${session.env.CODEX_ASKPASS_URL}/password`, { method: "POST", headers: { "x-askpass-token": session.env.CODEX_ASKPASS_TOKEN } });
    assert.equal(second.status, 403);
  } finally {
    await session.dispose();
    await assert.rejects(() => fs.access(session.env.SSH_ASKPASS));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("password session: 真实 helper 支持空格路径与多字节密码，磁盘不含密码", { skip: process.platform === "win32" }, async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "askpass with spaces-"));
  const password = "密".repeat(2000);
  const session = await createPasswordSshSession({ password, helperDir: dir });
  try {
    const code = await fs.readFile(session.env.SSH_ASKPASS, "utf8");
    assert.equal(code.includes(password), false);
    const result = await promisify(execFile)(session.env.SSH_ASKPASS, ["test user's password: "], { env: session.env, timeout: 5000 });
    assert.equal(result.stdout, password);
    await assert.rejects(() => promisify(execFile)(session.env.SSH_ASKPASS, ["test user's password: "], { env: session.env, timeout: 5000 }));
  } finally { await session.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("password session: Windows 原生入口不依赖批处理、PATH 或明文凭据文件", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileWithTimeout } = await import("./exec.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "askpass-win-中文 空格-"));
  try {
    await assert.rejects(createPasswordSshSession({ password: "pw", helperDir: dir, platform: "win32" }), (e) => e.code === "password-unsupported");
    const session = await createPasswordSshSession({ password: "pw-秘密", helperDir: dir, platform: "win32", allowWindows: true });
    try {
      assert.equal(session.env.SSH_ASKPASS, process.execPath);
      assert.match(session.env.NODE_OPTIONS, /--import=.*ssh-askpass-helper\.mjs/);
      assert.equal(JSON.stringify(session.env).includes("pw-秘密"), false);
      assert.deepEqual(await fs.readdir(dir), []);
      const result = await execFileWithTimeout(session.env.SSH_ASKPASS, ["user@node04's password:"], { env: { ...session.env, PATH: "" } });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "pw-秘密");
    } finally { await session.dispose(); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

 test("password session: 两跳各有密码，只响应对应账号主机且各消费一次", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "askpass-route-"));
  const session = await createPasswordSshSession({ passwords: [{ user: "kai", host: "master", password: "jump-only" }, { user: "user01", host: "node04", password: "target-only" }], helperDir: dir, platform: "win32", allowWindows: true });
  const ask = (prompt) => fetch(`${session.env.CODEX_ASKPASS_URL}/password`, { method: "POST", body: JSON.stringify({ prompt }), headers: { "x-askpass-token": session.env.CODEX_ASKPASS_TOKEN } });
  try {
    assert.equal((await ask("kai@node04's password:")).status, 403);
    assert.deepEqual(await (await ask("kai@master's password:")).json(), { password: "jump-only" });
    assert.equal((await ask("kai@master's password:")).status, 403);
    assert.deepEqual(await (await ask("user01@node04's password:")).json(), { password: "target-only" });
    assert.equal((await ask("user01@node04's password:")).status, 403);
  } finally { await session.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
});
