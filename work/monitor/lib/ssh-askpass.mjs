import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellSingleQuote } from "./shell/quote.mjs";
import { assertVaultPassword } from "./vault-ipc.mjs";
import { replyToAskpass } from "./ssh-askpass-helper.mjs";

const ASKPASS_SCRIPT = fileURLToPath(import.meta.url);

function clearAskpassSecret(filePath) {
  if (!filePath) return;
  try { unlinkSync(filePath); } catch {}
}

// SSH 密码只留在此进程内存中；磁盘上的 helper 不含凭据。每次连接使用独立、
// 最多读取一次且有超时的本机通道，退出/异常统一 dispose，不把密码放进 argv/env。
//
// Windows 显式启用时以原生 node/Electron + --import 应答，绕开批处理的代码页和启动限制。
export async function createPasswordSshSession({
  password, passwords = null, helperDir, env = process.env, platform = process.platform,
  nodePath = process.execPath, ttlMs = 60000, allowWindows = false,
} = {}) {
  let secret = passwords ? null : assertVaultPassword(password);
  let credentials = passwords?.map((item) => ({ ...item, password: assertVaultPassword(item.password) })) || [];
  const windows = platform === "win32";
  if (windows && !allowWindows) {
    throw Object.assign(new Error("Windows 密码接入需要原生 SSH askpass 程序；请使用 SSH 密钥"), { code: "password-unsupported" });
  }
  if (!helperDir) throw new Error("密码连接需要 helperDir");
  mkdirSync(helperDir, { recursive: true, mode: 0o700 });
  chmodSync(helperDir, 0o700);
  const helper = windows ? null : join(helperDir, `broker-helper-${randomBytes(12).toString("hex")}`);
  if (helper) writeFileSync(helper, `#!/bin/sh\nexec ${shellSingleQuote(nodePath)} ${shellSingleQuote(ASKPASS_SCRIPT)} "$@"\n`, { mode: 0o700, flag: "wx" });
  const token = randomBytes(32).toString("hex");
  const tokenBytes = Buffer.from(token);
  const server = createServer(async (req, res) => {
    const received = Buffer.from(String(req.headers["x-askpass-token"] || ""));
    const authorized = received.length === tokenBytes.length && timingSafeEqual(received, tokenBytes);
    if (req.method !== "POST" || req.url !== "/password" || req.headers.origin || !authorized || (secret === null && !credentials.length)) {
      res.writeHead(403, { "cache-control": "no-store" });
      return res.end();
    }
    let value = secret;
    if (credentials.length) {
      try {
        let body = "";
        for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error("body too large"); }
        const prompt = String(JSON.parse(body).prompt || "").trim();
        const index = credentials.findIndex((item) => prompt === `${item.user}@${item.host}'s password:`);
        if (index < 0) throw new Error("unexpected password prompt");
        value = credentials.splice(index, 1)[0].password;
      } catch { res.writeHead(403); return res.end(); }
    } else secret = null;
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
    credentials = [];
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
        ...sessionEnv, ELECTRON_RUN_AS_NODE: "1", DISPLAY: env.DISPLAY || ":0", SSH_ASKPASS: windows ? nodePath : helper, SSH_ASKPASS_REQUIRE: "force", CODEX_ASKPASS_URL: `http://127.0.0.1:${server.address().port}`, CODEX_ASKPASS_TOKEN: token,
        ...(windows ? { NODE_OPTIONS: `${sessionEnv.NODE_OPTIONS || ""} --import=${JSON.stringify(new URL("./ssh-askpass-helper.mjs", import.meta.url).href)}`.trim(), CODEX_ASKPASS_NATIVE_ENTRY: "1" } : {}),
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function runWithPasswordSsh({ password, helperDir, args, options = {}, execFileImpl } = {}) {
  const session = await createPasswordSshSession({ password, helperDir, env: options.env || process.env, allowWindows: true });
  try {
    return await execFileImpl("ssh", [...session.args, ...args], { ...options, env: session.env });
  } finally {
    await session.dispose();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exitCode = await replyToAskpass(process.argv.slice(2).join(" "));
}
