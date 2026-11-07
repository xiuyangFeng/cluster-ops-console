import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellSingleQuote } from "./shell/quote.mjs";
import { assertVaultPassword } from "./vault-ipc.mjs";

const ASKPASS_SCRIPT = fileURLToPath(import.meta.url);

function clearAskpassSecret(filePath) {
  if (!filePath) return;
  try { unlinkSync(filePath); } catch {}
}

// SSH 密码只留在此进程内存中；磁盘上的 helper 不含凭据。每次连接使用独立、
// 最多读取一次且有超时的本机通道，退出/异常统一 dispose，不把密码放进 argv/env。
//
// Windows：日常采集与隧道仍不支持密码（抛 password-unsupported，行为不变）。只有 App 内接入引导
// "用一次密码装公钥"那一步显式传 allowWindows:true——helper 是一个纯 ASCII 的 .cmd，node 与脚本路径
// 经环境变量交给它（路径可能含中文用户名，写进批处理文件会被 OEM 代码页读坏）。OpenSSH for Windows
// 8.1 起才认 SSH_ASKPASS；更旧的版本这里会失败，引导页据此退到"在终端里输一次密码"。
export async function createPasswordSshSession({
  password, helperDir, env = process.env, platform = process.platform,
  nodePath = process.execPath, ttlMs = 60000, allowWindows = false,
} = {}) {
  let secret = assertVaultPassword(password);
  const windows = platform === "win32";
  if (windows && !allowWindows) {
    throw Object.assign(new Error("Windows 密码接入需要原生 SSH askpass 程序；请使用 SSH 密钥"), { code: "password-unsupported" });
  }
  if (!helperDir) throw new Error("密码连接需要 helperDir");
  mkdirSync(helperDir, { recursive: true, mode: 0o700 });
  chmodSync(helperDir, 0o700);
  const helper = join(helperDir, `broker-helper-${randomBytes(12).toString("hex")}${windows ? ".cmd" : ""}`);
  const helperBody = windows
    ? '@echo off\r\n"%CODEX_ASKPASS_NODE%" "%CODEX_ASKPASS_SCRIPT%" %*\r\n'
    : `#!/bin/sh\nexec ${shellSingleQuote(nodePath)} ${shellSingleQuote(ASKPASS_SCRIPT)} "$@"\n`;
  writeFileSync(helper, helperBody, { mode: 0o700, flag: "wx" });
  const token = randomBytes(32).toString("hex");
  const tokenBytes = Buffer.from(token);
  const server = createServer((req, res) => {
    const received = Buffer.from(String(req.headers["x-askpass-token"] || ""));
    const authorized = received.length === tokenBytes.length && timingSafeEqual(received, tokenBytes);
    if (req.method !== "POST" || req.url !== "/password" || req.headers.origin || !authorized || secret === null) {
      res.writeHead(403, { "cache-control": "no-store" });
      return res.end();
    }
    const value = secret;
    secret = null;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ password: value }));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  let timer;
  let closed = false;
  async function dispose() {
    if (closed) return;
    closed = true;
    secret = null;
    clearTimeout(timer);
    clearAskpassSecret(helper);
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    timer = setTimeout(() => { void dispose(); }, Math.min(Math.max(ttlMs, 1000), 120000));
    timer.unref();
    server.unref();
    const sessionEnv = { ...env };
    delete sessionEnv.SSH_ASKPASS_SECRET_FILE;
    return {
      args: ["-o", "BatchMode=no", "-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=password", "-o", "PasswordAuthentication=yes", "-o", "KbdInteractiveAuthentication=no", "-o", "PubkeyAuthentication=no", "-o", "ControlMaster=no", "-o", "ControlPath=none"],
      env: {
        ...sessionEnv, ELECTRON_RUN_AS_NODE: "1", DISPLAY: env.DISPLAY || ":0", SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: "force", CODEX_ASKPASS_URL: `http://127.0.0.1:${server.address().port}`, CODEX_ASKPASS_TOKEN: token,
        ...(windows ? { CODEX_ASKPASS_NODE: nodePath, CODEX_ASKPASS_SCRIPT: ASKPASS_SCRIPT } : {}),
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function runWithPasswordSsh({ password, helperDir, args, options = {}, execFileImpl } = {}) {
  const session = await createPasswordSshSession({ password, helperDir, env: options.env || process.env });
  try {
    return await execFileImpl("ssh", [...session.args, ...args], { ...options, env: session.env });
  } finally {
    await session.dispose();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  if (process.env.CODEX_ASKPASS_URL) {
    try {
      if (!/password[:?]?\s*$/i.test(process.argv.slice(2).join(" "))) process.exit(1);
      const url = new URL(process.env.CODEX_ASKPASS_URL);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) process.exit(1);
      const result = await fetch(`${url.origin}/password`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "x-askpass-token": process.env.CODEX_ASKPASS_TOKEN || "" } });
      if (!result.ok) process.exit(1);
      const { password } = await result.json();
      process.stdout.write(assertVaultPassword(password));
    } catch { process.exit(1); }
  } else {
    process.exit(1);
  }
}
