import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { execFileWithInput, execFileWithTimeout } from "../exec.mjs";
import { AUTHORIZE_REMOTE_COMMAND, buildManualAuthorizeCommand, installPublicKeyWithPassword, KEY_ADDED, KEY_PRESENT, probeKeyLogin } from "./authorize-key.mjs";
import { DEDICATED_KEY_COMMENT, DEDICATED_KEY_NAME, ensureDedicatedKey, parsePublicKeyLine } from "./local-key.mjs";

const posixOnly = { skip: process.platform === "win32" };
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake cluster-workbench";
const exec = (cmd, args, options = {}) => (options.input != null ? execFileWithInput(cmd, args, options) : execFileWithTimeout(cmd, args, options));

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-authorize-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 远端脚本原样交给本机 sh 跑（HOME 指到临时目录）：验证的是真正会发到服务器上的那段字节。
function runRemoteScript(home, input) {
  return spawnSync("sh", ["-c", AUTHORIZE_REMOTE_COMMAND], { input, env: { ...process.env, HOME: home }, encoding: "utf8" });
}

test("装公钥脚本：从零建 ~/.ssh（700）与 authorized_keys（600），重复执行不重复追加", posixOnly, (t) => {
  const home = tmpHome(t);
  const first = runRemoteScript(home, `${KEY}\n`);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(KEY_ADDED));
  const file = path.join(home, ".ssh", "authorized_keys");
  assert.equal(fs.readFileSync(file, "utf8"), `${KEY}\n`);
  assert.equal(fs.statSync(path.join(home, ".ssh")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const second = runRemoteScript(home, `${KEY}\n`);
  assert.equal(second.status, 0);
  assert.match(second.stdout, new RegExp(KEY_PRESENT));
  assert.equal(fs.readFileSync(file, "utf8"), `${KEY}\n`);
});

test("装公钥脚本：旧文件没有结尾换行时先补换行，别人的公钥原样保留；Windows 带来的回车被去掉", posixOnly, (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, ".ssh"));
  const file = path.join(home, ".ssh", "authorized_keys");
  fs.writeFileSync(file, "ssh-rsa AAAAother other@host");
  const res = runRemoteScript(home, `${KEY}\r\n`);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(file, "utf8"), `ssh-rsa AAAAother other@host\n${KEY}\n`);
});

test("装公钥脚本：没收到公钥 → 退出码 12，不建空的 authorized_keys 条目", posixOnly, (t) => {
  const home = tmpHome(t);
  const res = runRemoteScript(home, "");
  assert.equal(res.status, 12);
  assert.equal(fs.existsSync(path.join(home, ".ssh", "authorized_keys")), false);
});

test("专用密钥：真实 ssh-keygen 新建 → 再次调用沿用 → 丢了 .pub 能从私钥推回来，私钥不变", async (t) => {
  const sshDir = path.join(tmpHome(t), ".ssh");
  const first = await ensureDedicatedKey({ sshDir, exec });
  assert.equal(first.created, true);
  assert.equal(path.basename(first.privateKeyPath), DEDICATED_KEY_NAME);
  assert.ok(parsePublicKeyLine(first.publicKey));
  assert.ok(first.publicKey.endsWith(` ${DEDICATED_KEY_COMMENT}`));
  const privateBefore = fs.readFileSync(first.privateKeyPath, "utf8");

  const second = await ensureDedicatedKey({ sshDir, exec });
  assert.equal(second.created, false);
  assert.equal(second.publicKey, first.publicKey);

  fs.rmSync(first.publicKeyPath);
  const third = await ensureDedicatedKey({ sshDir, exec });
  assert.equal(third.created, false);
  // 推回来的公钥主体相同（注释在私钥里，ed25519 会带回来；只比类型 + 主体）。
  assert.equal(third.publicKey.split(" ").slice(0, 2).join(" "), first.publicKey.split(" ").slice(0, 2).join(" "));
  assert.equal(fs.readFileSync(first.privateKeyPath, "utf8"), privateBefore);
});

test("专用密钥：ssh-keygen 失败时报 keygen-failed，不留半成品判断成成功", async (t) => {
  const sshDir = path.join(tmpHome(t), ".ssh");
  await assert.rejects(
    ensureDedicatedKey({ sshDir, exec: async () => ({ code: 1, stdout: "", stderr: "ssh-keygen: boom" }) }),
    (error) => error.code === "keygen-failed" && /boom/.test(error.message),
  );
});

test("parsePublicKeyLine：只认单行 OpenSSH 公钥", () => {
  assert.equal(parsePublicKeyLine(`${KEY}\n`), KEY);
  assert.equal(parsePublicKeyLine("this is not a public key line"), null);
  assert.equal(parsePublicKeyLine("ssh-ed25519 not base64!"), null);
  assert.equal(parsePublicKeyLine(""), null);
});

test("probeKeyLogin：BatchMode + 只用这把密钥 + 严格主机密钥；按 ssh 的报错归因", async () => {
  const calls = [];
  const fake = (result) => async (cmd, args) => {
    calls.push([cmd, args]);
    return result;
  };
  const base = { hostName: "10.0.0.8", port: 2222, user: "amy", privateKeyPath: "/k/id" };
  assert.deepEqual(await probeKeyLogin({ ...base, exec: fake({ code: 0, stdout: "CWB_LOGIN_OK\n", stderr: "" }) }), { ok: true, code: "ok", detail: "" });
  const args = calls[0][1];
  assert.equal(calls[0][0], "ssh");
  for (const expected of ["BatchMode=yes", "IdentitiesOnly=yes", "StrictHostKeyChecking=yes"]) assert.ok(args.includes(expected), expected);
  assert.deepEqual(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2), ["-i", "/k/id"]);
  assert.deepEqual(args.slice(-6), ["-p", "2222", "-l", "amy", "10.0.0.8", "echo CWB_LOGIN_OK"]);

  const denied = await probeKeyLogin({ ...base, exec: fake({ code: 255, stdout: "", stderr: "amy@10.0.0.8: Permission denied (publickey,password)." }) });
  assert.equal(denied.code, "auth");
  assert.equal((await probeKeyLogin({ ...base, exec: fake({ code: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.8 port 2222: Connection refused" }) })).code, "refused");
  assert.equal((await probeKeyLogin({ ...base, exec: fake({ code: 1, stdout: "", stderr: "", timedOut: true }) })).code, "timeout");
});

test("probeKeyLogin：用户名 / 地址里的注入形态直接拒绝，不会拼进 ssh 参数", async () => {
  const never = async () => { throw new Error("不该执行"); };
  await assert.rejects(probeKeyLogin({ exec: never, hostName: "-oProxyCommand=evil", port: 22, user: "amy", privateKeyPath: "/k" }));
  await assert.rejects(probeKeyLogin({ exec: never, hostName: "10.0.0.8", port: 22, user: "amy; rm -rf ~", privateKeyPath: "/k" }));
});

function fakeSession(log) {
  return async (options) => {
    log.push({ created: { ...options, password: "<redacted>" }, password: options.password });
    return { args: ["-o", "BatchMode=no"], env: { SSH_ASKPASS: "/helper" }, dispose: async () => { log.push("disposed"); } };
  };
}

test("installPublicKeyWithPassword：公钥走标准输入、密码不进参数；成功与各类失败的归因；会话总被 dispose", async () => {
  const base = { publicKey: KEY, hostName: "10.0.0.8", port: 22, user: "amy", helperDir: "/tmp/h", password: "s3cret pass" };
  const run = async (result) => {
    const log = [];
    const calls = [];
    const outcome = await installPublicKeyWithPassword({
      ...base,
      createSession: fakeSession(log),
      exec: async (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return result;
      },
    });
    return { outcome, log, calls };
  };

  const ok = await run({ code: 0, stdout: `${KEY_ADDED}\n`, stderr: "" });
  assert.deepEqual(ok.outcome, { ok: true, code: "ok", detail: "", already: false });
  assert.equal(ok.calls[0].options.input, `${KEY}\n`);
  assert.equal(ok.calls[0].options.env.SSH_ASKPASS, "/helper");
  assert.ok(!JSON.stringify(ok.calls[0].args).includes("s3cret"), "密码不能出现在 ssh 参数里");
  assert.equal(ok.calls[0].args.at(-1), AUTHORIZE_REMOTE_COMMAND);
  assert.equal(ok.log.at(-1), "disposed");
  assert.equal(ok.log[0].created.allowWindows, true);

  assert.equal((await run({ code: 0, stdout: `${KEY_PRESENT}\n`, stderr: "" })).outcome.already, true);
  const wrong = await run({ code: 255, stdout: "", stderr: "Permission denied, please try again.\namy@10.0.0.8: Permission denied (publickey,password)." });
  assert.equal(wrong.outcome.code, "wrong-password");
  assert.equal(wrong.log.at(-1), "disposed");
  assert.equal((await run({ code: 13, stdout: "", stderr: "" })).outcome.code, "remote-write");
  assert.equal((await run({ code: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.8 port 22: Operation timed out" })).outcome.code, "timeout");
  assert.equal((await run({ code: 255, stdout: "", stderr: "Host key verification failed." })).outcome.code, "hostkey");
  // ssh 根本没来要密码（旧版 OpenSSH for Windows 不认 SSH_ASKPASS）：归为通道问题，界面退到手动命令。
  assert.equal((await run({ code: 255, stdout: "", stderr: "read_passphrase: can't open /dev/tty" })).outcome.code, "channel");
});

test("installPublicKeyWithPassword：密码会话建不起来 → channel，不执行 ssh", async () => {
  let executed = false;
  const outcome = await installPublicKeyWithPassword({
    publicKey: KEY, hostName: "h", port: 22, user: "amy", helperDir: "/tmp/h", password: "x",
    createSession: async () => { throw Object.assign(new Error("no"), { code: "password-unsupported" }); },
    exec: async () => { executed = true; return { code: 0 }; },
  });
  assert.equal(outcome.code, "channel");
  assert.equal(executed, false);
});

test("buildManualAuthorizeCommand：macOS 用 cat、Windows 用 type，公钥路径带引号", () => {
  const mac = buildManualAuthorizeCommand({ publicKeyPath: "/Users/a b/.ssh/k.pub", hostName: "1.2.3.4", port: 22, user: "amy", platform: "darwin" });
  assert.equal(mac, `cat "/Users/a b/.ssh/k.pub" | ssh -p 22 amy@1.2.3.4 "umask 077; mkdir -p ~/.ssh; tr -d '\\r' >> ~/.ssh/authorized_keys"`);
  const win = buildManualAuthorizeCommand({ publicKeyPath: "C:\\Users\\a\\.ssh\\k.pub", hostName: "1.2.3.4", port: 2200, user: "amy", platform: "win32" });
  assert.ok(win.startsWith('type "C:\\Users\\a\\.ssh\\k.pub" | ssh -p 2200 amy@1.2.3.4 '));
});
