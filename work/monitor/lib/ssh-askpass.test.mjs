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

test("password session: Windows 默认仍拒绝；接入引导显式放开时 helper 是纯 ASCII 的 .cmd，路径经环境变量传递", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "askpass-win-"));
  try {
    await assert.rejects(
      createPasswordSshSession({ password: "pw", helperDir: dir, platform: "win32" }),
      (error) => error.code === "password-unsupported",
    );
    const nodePath = "C:\\Users\\张三\\node dir\\node.exe";
    const session = await createPasswordSshSession({ password: "pw-秘密", helperDir: dir, platform: "win32", allowWindows: true, nodePath, ttlMs: 10000 });
    try {
      assert.match(session.env.SSH_ASKPASS, /broker-helper-[0-9a-f]{24}\.cmd$/);
      const body = await fs.readFile(session.env.SSH_ASKPASS, "utf8");
      assert.equal(body, '@echo off\r\n"%CODEX_ASKPASS_NODE%" "%CODEX_ASKPASS_SCRIPT%" %*\r\n');
      // 批处理文件按 OEM 代码页读：里面不能有任何非 ASCII 字符（中文用户名的路径只走环境变量）。
      assert.ok([...body].every((ch) => ch.charCodeAt(0) < 128));
      assert.equal(session.env.CODEX_ASKPASS_NODE, nodePath);
      assert.match(session.env.CODEX_ASKPASS_SCRIPT, /ssh-askpass\.mjs$/);
      assert.equal(session.env.SSH_ASKPASS_REQUIRE, "force");
      assert.ok(!JSON.stringify(session.args).includes("pw-秘密"));
      assert.ok(!body.includes("pw-秘密"));
    } finally {
      await session.dispose();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
