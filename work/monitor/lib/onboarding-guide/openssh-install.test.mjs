// Windows 上「没有 ssh 命令」→ 页面一键安装系统自带的 OpenSSH 客户端 → 装好后从断点继续。
import assert from "node:assert/strict";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildOpenSshInstallInvocation, createOnboardingGuide, describeOpenSshInstallFailure, OPENSSH_CAPABILITY } from "./service.mjs";

const HOST_LINE = "10.0.0.8 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostHostHostHostHostHostHostHostHostHostHostH";

function makeGuide(t, { platform = "win32", installResult = { code: 0, stdout: "", stderr: "" }, installWorks = true } = {}) {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cwb-openssh-"));
  t.after(() => nodeFs.rmSync(root, { recursive: true, force: true }));
  const teamConfigPath = path.join(root, "config.json");
  nodeFs.writeFileSync(teamConfigPath, JSON.stringify({ servers: [{ id: "server-01", host: "myserver", sshHostName: "10.0.0.8" }] }));
  const world = { sshInstalled: false, calls: [] };
  const fs = { ...nodeFs, existsSync: (p) => (/OpenSSH[\\/]ssh\.exe$/.test(String(p)) ? world.sshInstalled : nodeFs.existsSync(p)) };
  const exec = async (cmd, args) => {
    world.calls.push({ cmd, args });
    if (/powershell\.exe$/i.test(cmd)) {
      if (installWorks) world.sshInstalled = true;
      return installResult;
    }
    if (!world.sshInstalled) return { code: 1, stdout: "", stderr: `spawn ${cmd} ENOENT` };
    if (cmd === "ssh-keygen" && args[0] === "-F") return { code: 1, stdout: "", stderr: "" };
    if (cmd === "ssh-keyscan") return { code: 0, stdout: `${HOST_LINE}\n`, stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected ${cmd}` };
  };
  const guide = createOnboardingGuide({
    platform,
    homeDir: path.join(root, "home"),
    statePath: path.join(root, "runtime", "onboarding-guide.json"),
    helperDir: path.join(root, "runtime", "askpass"),
    teamConfigPath,
    getMergedConfig: () => ({ activeServerId: "server-01", servers: [{ id: "server-01", name: "主集群", host: "myserver", source: "team" }] }),
    exec,
    fs,
    sleep: async () => {},
    log: () => {},
  });
  return { guide, world };
}

const settle = async (guide) => {
  await guide.whenIdle();
  return guide.getState();
};

test("没有 ssh：提示里给一键安装；装好后自动从第一步继续", async (t) => {
  const { guide, world } = makeGuide(t);
  guide.start({ sshUser: "amy" });
  let state = await settle(guide);
  assert.equal(state.phase, "failed");
  assert.equal(state.steps[0].error.code, "ssh-missing");
  assert.match(state.steps[0].error.hint, /安装 OpenSSH 客户端/);
  assert.deepEqual(state.openSsh, { installing: false, error: null });

  state = guide.installOpenSsh();
  assert.deepEqual([state.openSsh.installing, state.busy], [true, true]);
  assert.throws(() => guide.retry(), (e) => e.status === 409 && e.code === "busy", "安装期间不能同时重试");
  state = await settle(guide);
  assert.deepEqual(state.openSsh, { installing: false, error: null });
  assert.equal(state.prompt?.kind, "hostkey", "装好后接着走：扫到指纹等确认");
  const install = world.calls.find((c) => /powershell\.exe$/i.test(c.cmd));
  assert.ok(install.args.at(-1).includes(`Add-WindowsCapability -Online -Name ${OPENSSH_CAPABILITY}`));
  assert.ok(install.args.at(-1).includes("-Verb RunAs"));
});

test("UAC 点了「否」：说明原因，步骤仍停在原处，可以再点", async (t) => {
  const { guide } = makeGuide(t, { installWorks: false, installResult: { code: 1, stdout: "", stderr: "Start-Process : 由于用户取消了操作，该操作已被取消。" } });
  guide.start({ sshUser: "amy" });
  await settle(guide);
  guide.installOpenSsh();
  const state = await settle(guide);
  assert.match(state.openSsh.error, /管理员确认/);
  assert.equal(state.steps[0].error.code, "ssh-missing");
  assert.equal(state.busy, false);
});

test("非 Windows 不提供，也不在状态里出现", async (t) => {
  const { guide } = makeGuide(t, { platform: "darwin" });
  assert.equal(guide.getState().openSsh, null);
  assert.throws(() => guide.installOpenSsh(), (e) => e.status === 400 && e.code === "unsupported");
});

test("安装命令：外层不提权，由 Start-Process -Verb RunAs 起提权的 PowerShell，带回退出码", () => {
  const { file, args } = buildOpenSshInstallInvocation({ SystemRoot: "D:\\Win" });
  assert.equal(file, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(args[3], /Start-Process -FilePath 'D:\\Win\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe' -Verb RunAs -Wait -PassThru/);
  assert.match(args[3], /exit \$p\.ExitCode$/);
  assert.doesNotMatch(args[3], /"/, "不含双引号：Windows 上 spawn 的参数转义不会改动它");
});

test("没装上的原因：取消、超时、其它错误", () => {
  assert.match(describeOpenSshInstallFailure({ stderr: "The operation was canceled by the user." }), /管理员确认/);
  assert.match(describeOpenSshInstallFailure({ timedOut: true, stderr: "" }), /20 分钟/);
  assert.match(describeOpenSshInstallFailure({ stderr: "Add-WindowsCapability : 0x800f0954\nline 2" }), /0x800f0954[\s\S]*手动安装/);
});
