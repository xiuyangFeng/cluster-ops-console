// 接入引导的整条流程：用一个"假世界"（临时家目录 + 假 ssh / ssh-keyscan + 假服务）把步骤编排从头走到尾。
// 密码通道用的是真实的 askpass 会话（假 ssh 像真的一样去本机通道取密码）；集群侧脚本在 POSIX 上
// 用本机 sh 在临时"远端家目录"里真跑。全程不碰真实的 ~/.ssh、个人配置与集群。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CLUSTER_ENV_PATH, STRAY_SCAN_DONE } from "../cluster-env.mjs";
import { KEY_ADDED } from "./authorize-key.mjs";
import { DEDICATED_KEY_NAME } from "./local-key.mjs";
import { createOnboardingGuide, fingerprintOfKeyLine, GUIDE_STEPS } from "./service.mjs";
import { createGuideStore, emptyGuideState, reviveGuideState } from "./store.mjs";

const posix = process.platform !== "win32";
const HOST_BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIHostHostHostHostHostHostHostHostHostHostHostH";
const HOST_LINE = `10.0.0.8 ssh-ed25519 ${HOST_BLOB}`;
const HOST_FP = fingerprintOfKeyLine(HOST_LINE).sha256;
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIUserUserUserUserUserUserUserUserUserUserUserU cluster-workbench";

function createWorld(t, { team = {}, password = "correct horse", sshConfig = null, authorized = false, aliasLogin = false, fixtureMode = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-guide-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const remoteHome = path.join(root, "remote");
  fs.mkdirSync(homeDir);
  fs.mkdirSync(remoteHome);
  const sshDir = path.join(homeDir, ".ssh");
  if (sshConfig != null) {
    fs.mkdirSync(sshDir, { recursive: true });
    fs.writeFileSync(path.join(sshDir, "config"), sshConfig);
  }
  const teamConfigPath = path.join(root, "config.json");
  fs.writeFileSync(teamConfigPath, JSON.stringify({ servers: [{ id: "server-01", host: "myserver", sshHostName: "10.0.0.8", sshPort: 22, ...team }] }));

  const world = {
    root, homeDir, remoteHome, sshDir,
    statePath: path.join(root, "runtime", "onboarding-guide.json"),
    merged: { activeServerId: "server-01", servers: [{ id: "server-01", name: "主集群", host: "myserver", sshPort: 22, localPort: 8888, source: "team" }] },
    personal: {},
    authorized,
    aliasLogin,
    tunnelUp: false,
    shouldBeRunning: false,
    calls: [],
    passwordsSeen: [],
    egress: { results: [{ target: "api.openai.com", ok: true }], full: { ok: true, message: "全链路通（HTTP 401，300ms）" }, suggestion: null },
    egressModes: [],
    scanOutput: `${HOST_LINE}\n`,
    askpassWorks: true,
    registry: { registered: true },
  };

  // 假 ssh 家族。ssh-keygen 生成 / 推导密钥时直接写文件；带 askpass 的 ssh 像真的一样去本机通道取密码。
  world.exec = async (cmd, args, options = {}) => {
    world.calls.push({ cmd, args });
    if (cmd === "ssh-keygen" && args[0] === "-F") {
      // 读不出 known_hosts（权限 / 是个目录）时真的 ssh-keygen -F 也只是报「没找到」。
      let known = false;
      try { known = fs.readFileSync(path.join(sshDir, "known_hosts"), "utf8").includes(args[1]); } catch {}
      return known ? { code: 0, stdout: `# Host ${args[1]} found\n${HOST_LINE}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (cmd === "ssh-keyscan") return { code: 0, stdout: world.scanOutput, stderr: "" };
    if (cmd === "ssh-keygen" && args.includes("-t")) {
      const file = args[args.indexOf("-f") + 1];
      fs.writeFileSync(file, "PRIVATE", { mode: 0o600 });
      fs.writeFileSync(`${file}.pub`, `${PUBLIC_KEY}\n`);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "ssh-keygen" && args[0] === "-y") return { code: 0, stdout: `${PUBLIC_KEY}\n`, stderr: "" };
    if (cmd === "ssh" && args.includes("BatchMode=yes") && args.at(-2) === "myserver") {
      return world.aliasLogin ? { code: 0, stdout: "CWB_LOGIN_OK\n", stderr: "" } : { code: 255, stdout: "", stderr: "Permission denied (publickey,password)." };
    }
    if (cmd === "ssh" && args.includes("BatchMode=yes")) {
      return world.authorized ? { code: 0, stdout: "CWB_LOGIN_OK\n", stderr: "" } : { code: 255, stdout: "", stderr: "amy@10.0.0.8: Permission denied (publickey,password)." };
    }
    if (cmd === "ssh" && args.includes("BatchMode=no")) {
      if (!world.askpassWorks) return { code: 255, stdout: "", stderr: "read_passphrase: can't open /dev/tty: No such device" };
      const res = await fetch(`${options.env.CODEX_ASKPASS_URL}/password`, { method: "POST", headers: { "x-askpass-token": options.env.CODEX_ASKPASS_TOKEN } });
      const supplied = res.ok ? (await res.json()).password : null;
      world.passwordsSeen.push(supplied);
      if (supplied !== password) return { code: 255, stdout: "", stderr: "Permission denied, please try again." };
      assert.equal(options.input, `${PUBLIC_KEY}\n`);
      world.authorized = true;
      return { code: 0, stdout: `${KEY_ADDED}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
  };

  const server = () => world.merged.servers[0];
  world.guide = () => createOnboardingGuide({
    fixtureMode,
    homeDir,
    statePath: world.statePath,
    helperDir: path.join(root, "runtime", "askpass"),
    teamConfigPath,
    getMergedConfig: () => world.merged,
    getPersonalConfig: () => world.personal,
    savePersonalConfig: async (patch) => {
      Object.assign(world.personal, patch);
      Object.assign(world.merged, patch);
      return world.personal;
    },
    serverRegistry: {
      enable: async () => { server().disabled = false; },
      testConnection: async () => (world.authorized || world.aliasLogin ? { ok: true, code: "ok" } : { ok: false, code: "auth", nextAction: "检查 ssh 用户名与密钥" }),
      suggestPort: async () => ({ probed: true, suggested: { remotePort: 7892 }, registry: "ok" }),
      claimPort: async (_id, { remotePort }) => {
        server().remotePort = remotePort;
        return world.registry.registered
          ? { remotePort, registered: true, mode: "claimed" }
          : { remotePort, registered: false, mode: "legacy", warning: "未登记", adminCommand: "sudo install -d -m 1777 /public/agent-hub/ports" };
      },
    },
    exec: world.exec,
    runRemote: async (_server, _config, command, options = {}) => {
      world.calls.push({ cmd: "remote", args: [command] });
      if (!posix) return { code: 0, stdout: `${STRAY_SCAN_DONE}\n`, stderr: "" };
      const res = spawnSync("sh", ["-c", command], { env: { ...process.env, HOME: remoteHome }, encoding: "utf8", input: options.input });
      return { code: res.status, stdout: res.stdout, stderr: res.stderr };
    },
    getStatus: () => ({ localProxyUp: true, tunnelUp: world.tunnelUp, remotePortOpen: world.tunnelUp }),
    getShouldBeRunning: () => world.shouldBeRunning,
    startChannel: async () => {
      world.shouldBeRunning = true;
      world.tunnelUp = true;
    },
    egressService: {
      runSelfTest: async () => (typeof world.egress === "function" ? world.egress() : world.egress),
      setMode: async ({ mode }) => { world.egressModes.push(mode); },
    },
    sleep: async () => {},
    log: () => {},
  });
  return world;
}

const statusOf = (state) => Object.fromEntries(state.steps.map((step) => [step.id, step.status]));
const ALL_DONE = Object.fromEntries(GUIDE_STEPS.map((step) => [step.id, "done"]));

async function settle(guide) {
  await guide.whenIdle();
  return guide.getState();
}

test("全新的同事：填用户名和密码 → 确认指纹 → 其余自动走完；密码不落盘、不出现在状态里", async (t) => {
  const world = createWorld(t);
  const guide = world.guide();
  assert.equal(guide.getState().phase, "idle");
  assert.deepEqual(guide.getState().form, { sshUser: "", hostName: "10.0.0.8", hostNameLocked: true, sshPort: 22 });

  guide.start({ sshUser: "amy", password: "correct horse" });
  let state = await settle(guide);
  assert.equal(state.phase, "waiting");
  assert.equal(state.prompt.kind, "hostkey");
  assert.deepEqual(state.prompt.fingerprints, [{ type: "ssh-ed25519", sha256: HOST_FP }]);
  assert.equal(fs.existsSync(path.join(world.sshDir, "known_hosts")), false, "没确认之前不写 known_hosts");

  guide.answer({ kind: "hostkey", accept: true, linesHash: state.prompt.linesHash });
  state = await settle(guide);
  assert.equal(state.phase, "done", JSON.stringify(state.steps.filter((s) => s.status === "failed")));
  assert.deepEqual(statusOf(state), ALL_DONE);
  assert.deepEqual(state.result, { sshUser: "amy", remotePort: 7892, registered: true, warnings: [] });

  // 本机落地：known_hosts、专用密钥、~/.ssh/config 的受管段、个人层身份。
  assert.equal(fs.readFileSync(path.join(world.sshDir, "known_hosts"), "utf8"), `${HOST_LINE}\n`);
  assert.ok(fs.existsSync(path.join(world.sshDir, DEDICATED_KEY_NAME)));
  const sshConfig = fs.readFileSync(path.join(world.sshDir, "config"), "utf8");
  assert.match(sshConfig, /Host myserver\n {2}HostName 10\.0\.0\.8\n {2}User amy\n {2}Port 22\n {2}StrictHostKeyChecking yes\n {2}IdentityFile ~\/\.ssh\/id_ed25519_codextunnel/);
  assert.deepEqual(world.personal, { activeServerId: "server-01", sshUser: "amy", sshIdentityFile: path.join(world.sshDir, DEDICATED_KEY_NAME) });
  assert.equal(world.shouldBeRunning, true, "隧道一步会把连接启动起来");
  if (posix) assert.match(fs.readFileSync(path.join(world.remoteHome, CLUSTER_ENV_PATH), "utf8"), /127\.0\.0\.1:7892/);

  // 密码只经 askpass 通道走了一次：不在任何命令参数里，不在进度文件里，不在对外状态里。
  assert.deepEqual(world.passwordsSeen, ["correct horse"]);
  assert.ok(!JSON.stringify(world.calls).includes("correct horse"));
  assert.ok(!fs.readFileSync(world.statePath, "utf8").includes("correct horse"));
  assert.ok(!JSON.stringify(state).includes("correct horse"));
  if (posix) assert.equal(fs.statSync(world.statePath).mode & 0o777, 0o600);
});

test("没在表单里填密码：走到装公钥时再问；密码错了留在这一步重新问，对了继续", async (t) => {
  const world = createWorld(t);
  const guide = world.guide();
  guide.start({ sshUser: "amy" });
  let state = await settle(guide);
  guide.answer({ kind: "hostkey", accept: true, linesHash: state.prompt.linesHash });
  state = await settle(guide);
  assert.equal(state.prompt.kind, "password");
  assert.equal(state.prompt.error, null);
  assert.match(state.prompt.manualCommand, /\| ssh -p 22 amy@10\.0\.0\.8 /);
  assert.equal(statusOf(state).authorize, "waiting");

  guide.answer({ kind: "password", password: "nope" });
  state = await settle(guide);
  assert.equal(state.prompt.kind, "password");
  assert.equal(state.prompt.error, "wrong-password");
  assert.equal(state.prompt.attempts, 1);

  guide.answer({ kind: "password", password: "correct horse" });
  state = await settle(guide);
  assert.equal(state.phase, "done");
  assert.deepEqual(world.passwordsSeen, ["nope", "correct horse"]);
});

test("密码通道走不通（旧版 Windows ssh）：给出手动命令；用户在终端里装好后点「我已完成」继续", async (t) => {
  const world = createWorld(t);
  world.askpassWorks = false;
  const guide = world.guide();
  guide.start({ sshUser: "amy", password: "correct horse" });
  let state = await settle(guide);
  guide.answer({ kind: "hostkey", accept: true, linesHash: state.prompt.linesHash });
  state = await settle(guide);
  assert.equal(state.prompt.error, "channel");
  assert.ok(state.prompt.manualCommand);

  guide.answer({ kind: "password", manualDone: true });
  state = await settle(guide);
  assert.equal(state.prompt.error, "still-missing", "还没装好就点完成：如实说还登不上");

  world.authorized = true; // 用户在自己的终端里跑完了那行命令
  guide.answer({ kind: "password", manualDone: true });
  state = await settle(guide);
  assert.equal(state.phase, "done");
});

test("团队配置登记了指纹：对得上自动通过、不用人确认；对不上直接停下", async (t) => {
  const ok = createWorld(t, { team: { sshHostKeyFingerprints: [HOST_FP] }, authorized: true });
  const guide = ok.guide();
  guide.start({ sshUser: "amy" });
  const state = await settle(guide);
  assert.equal(state.phase, "done");
  assert.equal(state.steps[0].detail, "指纹与团队配置一致，已保存");

  const bad = createWorld(t, { team: { sshHostKeyFingerprints: ["SHA256:somethingElseEntirely"] }, authorized: true });
  const guide2 = bad.guide();
  guide2.start({ sshUser: "amy" });
  const failedState = await settle(guide2);
  assert.equal(failedState.phase, "failed");
  assert.equal(failedState.steps[0].error.code, "hostkey-mismatch");
  assert.equal(fs.existsSync(path.join(bad.sshDir, "known_hosts")), false);
  assert.equal(statusOf(failedState).key, "pending", "指纹没过，后面的步骤一步都不做");
});

test("拒绝指纹：停在第一步，重试会重新扫描", async (t) => {
  const world = createWorld(t, { authorized: true });
  const guide = world.guide();
  guide.start({ sshUser: "amy" });
  let state = await settle(guide);
  state = guide.answer({ kind: "hostkey", accept: false });
  assert.equal(state.phase, "failed");
  assert.equal(state.steps[0].error.code, "hostkey-declined");
  guide.retry();
  state = await settle(guide);
  assert.equal(state.prompt.kind, "hostkey");
});

test("known_hosts 读不出（这里是个目录）：第一步失败、一个字节都不写；修好后重试直接写入，不用再确认一遍", { skip: !posix }, async (t) => {
  const world = createWorld(t, { authorized: true });
  const knownHosts = path.join(world.sshDir, "known_hosts");
  fs.mkdirSync(knownHosts, { recursive: true });
  const guide = world.guide();
  guide.start({ sshUser: "amy" });
  let state = await settle(guide);
  guide.answer({ kind: "hostkey", accept: true, linesHash: state.prompt.linesHash });
  state = await settle(guide);
  assert.equal(state.phase, "failed");
  assert.equal(state.steps[0].error.code, "known-hosts");
  assert.match(state.steps[0].error.message, /没能把指纹写进 ~\/\.ssh\/known_hosts（EISDIR）/);
  assert.match(state.steps[0].error.hint, /不会改动它/);
  assert.deepEqual(fs.readdirSync(knownHosts), [], "原来的东西原样留着");

  fs.rmdirSync(knownHosts);
  guide.retry();
  state = await settle(guide);
  assert.notEqual(state.prompt?.kind, "hostkey", "已经确认过的指纹不再问");
  assert.equal(fs.readFileSync(knownHosts, "utf8"), `${HOST_LINE}\n`);
});

test("连不上服务器（不在白名单网络）：第一步失败并说明原因；网络恢复后重试从这一步继续", async (t) => {
  const world = createWorld(t, { authorized: true });
  world.scanOutput = "";
  const guide = world.guide();
  guide.start({ sshUser: "amy" });
  let state = await settle(guide);
  assert.equal(state.phase, "failed");
  assert.equal(state.steps[0].error.code, "unreachable");
  assert.match(state.steps[0].error.hint, /白名单/);

  world.scanOutput = `${HOST_LINE}\n`;
  guide.retry();
  state = await settle(guide);
  assert.equal(state.prompt.kind, "hostkey");
});

test("老用户已经能用别名免密登录：前三步跳过，不要密码，不改写他的 ~/.ssh/config", async (t) => {
  const own = "Host myserver\n  HostName 10.0.0.8\n  User amy\n  ProxyJump bastion\n";
  const world = createWorld(t, { sshConfig: own, aliasLogin: true });
  const guide = world.guide();
  assert.equal(guide.getState().form.sshUser, "amy", "用户名从 ssh config 预填");
  guide.start({ sshUser: "amy" });
  const state = await settle(guide);
  assert.equal(state.phase, "done");
  assert.deepEqual(statusOf(state), { ...ALL_DONE, hostkey: "skipped", key: "skipped", authorize: "skipped" });
  assert.equal(fs.readFileSync(path.join(world.sshDir, "config"), "utf8"), own);
  assert.deepEqual(world.personal, { activeServerId: "server-01", sshUser: "amy" });
  assert.equal(fs.existsSync(path.join(world.sshDir, DEDICATED_KEY_NAME)), false);
});

test("已有手写的同名 Host 段但登不上：先给他看，覆盖前备份；选保留则原样不动", async (t) => {
  const own = "Host other\n  HostName 1.1.1.1\n\nHost myserver\n  HostName old.example\n  User someoneelse\n";
  const world = createWorld(t, { sshConfig: own, authorized: true });
  const guide = world.guide();
  guide.start({ sshUser: "amy" });
  let state = await settle(guide);
  guide.answer({ kind: "hostkey", accept: true, linesHash: state.prompt.linesHash });
  state = await settle(guide);
  assert.equal(state.prompt.kind, "ssh-config");
  assert.match(state.prompt.existing, /User someoneelse/);
  assert.match(state.prompt.proposed, /^Host myserver\n {2}HostName 10\.0\.0\.8\n {2}User amy/, "只给 Host 段本身，不带受管标记注释");
  assert.equal(fs.readFileSync(path.join(world.sshDir, "config"), "utf8"), own, "回答之前不动文件");

  guide.answer({ kind: "ssh-config", action: "overwrite" });
  state = await settle(guide);
  assert.equal(state.phase, "done");
  const next = fs.readFileSync(path.join(world.sshDir, "config"), "utf8");
  assert.match(next, /Host other\n {2}HostName 1\.1\.1\.1/);
  assert.match(next, /User amy/);
  assert.ok(!next.includes("someoneelse"));
  const backups = fs.readdirSync(world.sshDir).filter((name) => name.startsWith("config.bak."));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(world.sshDir, backups[0]), "utf8"), own);
});

test("集群没启用端口登记：照常分配，但结果里带一条提醒和给管理员的命令", async (t) => {
  const world = createWorld(t, { authorized: true, team: { sshHostKeyFingerprints: [HOST_FP] } });
  world.registry.registered = false;
  const guide = world.guide();
  guide.start({ sshUser: "amy" });
  const state = await settle(guide);
  assert.equal(state.phase, "done");
  assert.equal(state.result.registered, false);
  assert.equal(state.result.warnings[0].code, "port-unregistered");
  assert.match(state.result.warnings[0].command, /install -d -m 1777/);
});

test("出网不通但系统代理可用：问一句，同意后切到系统代理并重测；不同意则带提醒继续", async (t) => {
  const blocked = { results: [{ target: "api.openai.com", ok: false, message: "TLS 握手超时" }], full: { ok: false, message: "本机代理连不上外网" }, suggestion: { kind: "use-system", action: "use-system", text: "直连不通，但系统代理 127.0.0.1:7890 能连上——建议把出网方式改为「系统代理」。" } };
  const world = createWorld(t, { authorized: true, team: { sshHostKeyFingerprints: [HOST_FP] } });
  const working = world.egress;
  world.egress = blocked;
  const guide = world.guide();
  guide.start({ sshUser: "amy" });
  let state = await settle(guide);
  assert.equal(state.prompt.kind, "egress");
  assert.deepEqual(state.prompt.failures, [{ target: "api.openai.com", message: "TLS 握手超时" }]);

  // 切过去之后自测就通了
  world.egress = () => (world.egressModes.includes("system") ? working : blocked);
  guide.answer({ kind: "egress", action: "use-system" });
  state = await settle(guide);
  assert.deepEqual(world.egressModes, ["system"]);
  assert.equal(state.phase, "done");
  assert.equal(statusOf(state).egress, "done");

  const world2 = createWorld(t, { authorized: true, team: { sshHostKeyFingerprints: [HOST_FP] } });
  world2.egress = blocked;
  const guide2 = world2.guide();
  guide2.start({ sshUser: "amy" });
  state = await settle(guide2);
  guide2.answer({ kind: "egress", action: "skip" });
  state = await settle(guide2);
  assert.equal(state.phase, "done", "出网不通不拦后面的步骤");
  assert.equal(statusOf(state).egress, "warn");
  assert.equal(statusOf(state).clusterEnv, "done");
  assert.deepEqual(world2.egressModes, []);

  // 走完之后可以单独重跑出网自测这一步
  world2.egress = working;
  guide2.retry({ step: "egress" });
  state = await settle(guide2);
  assert.equal(state.phase, "done");
  assert.equal(statusOf(state).egress, "done");
});

test("集群上有散落的旧代理导出：列出来问；同意后注释掉（留备份），拒绝则保留", { skip: !posix }, async (t) => {
  const world = createWorld(t, { authorized: true, team: { sshHostKeyFingerprints: [HOST_FP] } });
  const bashrc = path.join(world.remoteHome, ".bashrc");
  fs.writeFileSync(bashrc, "export PATH=/public/slurm/bin:$PATH\nexport https_proxy=socks5h://127.0.0.1:1080\n");
  const guide = world.guide();
  guide.start({ sshUser: "amy" });
  let state = await settle(guide);
  assert.equal(state.prompt.kind, "strays");
  assert.deepEqual(state.prompt.items, [{ file: ".bashrc", line: 2, text: "export https_proxy=socks5h://127.0.0.1:1080" }]);

  guide.answer({ kind: "strays", action: "comment" });
  state = await settle(guide);
  assert.equal(state.phase, "done");
  const after = fs.readFileSync(bashrc, "utf8");
  assert.match(after, /^export PATH=\/public\/slurm\/bin:\$PATH$/m, "紧挨着的 PATH 行不能动");
  assert.match(after, /^# \[cluster-workbench 已停用\] export https_proxy=socks5h/m);
  assert.match(state.steps.at(-1).detail, /旧的代理设置已注释/);
});

test("中途关掉工作台：重开后停在「已暂停」，点继续从没做完的那一步接着走，已完成的不重做", async (t) => {
  const world = createWorld(t);
  let guide = world.guide();
  guide.start({ sshUser: "amy" });
  let state = await settle(guide);
  guide.answer({ kind: "hostkey", accept: true, linesHash: state.prompt.linesHash });
  state = await settle(guide);
  assert.equal(state.prompt.kind, "password");

  guide = world.guide(); // 进程重启：内存里的密码、提问都没了，进度从文件读回
  state = guide.getState();
  assert.equal(state.phase, "paused");
  assert.equal(state.prompt, null);
  assert.equal(state.form.sshUser, "amy");
  assert.deepEqual([statusOf(state).hostkey, statusOf(state).key, statusOf(state).authorize], ["done", "done", "pending"]);

  const scansBefore = world.calls.filter((c) => c.cmd === "ssh-keyscan").length;
  guide.retry();
  state = await settle(guide);
  assert.equal(state.prompt.kind, "password");
  assert.equal(world.calls.filter((c) => c.cmd === "ssh-keyscan").length, scansBefore, "指纹那一步已完成，不重扫");
  guide.answer({ kind: "password", password: "correct horse" });
  assert.equal((await settle(guide)).phase, "done");
});

test("表单与并发的边界：用户名校验、缺地址、执行中拒绝重复操作、答非所问", async (t) => {
  const world = createWorld(t, { team: { sshHostName: "REPLACE_WITH_HOST" } });
  const guide = world.guide();
  assert.equal(guide.getState().form.hostNameLocked, false);
  assert.throws(() => guide.start({ sshUser: "" }), (e) => e.status === 400 && e.field === "sshUser");
  assert.throws(() => guide.start({ sshUser: "amy; rm -rf ~" }), (e) => e.field === "sshUser");
  assert.throws(() => guide.start({ sshUser: "amy" }), (e) => e.field === "hostName");
  assert.throws(() => guide.start({ sshUser: "amy", hostName: "-oProxyCommand=x" }), (e) => e.field === "hostName");
  assert.throws(() => guide.start({ sshUser: "amy", hostName: "10.0.0.8", password: "a\nb" }), (e) => e.field === "password");
  assert.throws(() => guide.retry(), (e) => e.code === "not-started");
  assert.throws(() => guide.answer({ kind: "password", password: "x" }), (e) => e.code === "no-prompt");

  guide.start({ sshUser: "amy", hostName: "10.0.0.8" });
  assert.throws(() => guide.start({ sshUser: "amy", hostName: "10.0.0.8" }), (e) => e.status === 409 && e.code === "busy");
  const state = await settle(guide);
  assert.equal(state.prompt.kind, "hostkey");
  assert.throws(() => guide.answer({ kind: "password", password: "x" }), (e) => e.code === "prompt-mismatch");
  assert.throws(() => guide.answer({ kind: "hostkey", accept: true, linesHash: "stale" }), (e) => e.code === "hostkey-stale");
});

test("团队配置的 host 本身就是地址（没有别名、没预烤 sshHostName）：默认连它，仍可在表单里改", async (t) => {
  const world = createWorld(t, { team: { sshHostName: "" } });
  world.merged.servers[0].host = "cluster.example.edu";
  const guide = world.guide();
  assert.deepEqual(guide.getState().form, { sshUser: "", hostName: "cluster.example.edu", hostNameLocked: false, sshPort: 22 });
  // 表单里填的地址与端口生效（没预烤时不被团队配置的默认端口盖掉）
  guide.start({ sshUser: "amy", hostName: "10.9.9.9", sshPort: 2200 });
  const state = await guide.whenIdle().then(() => guide.getState());
  assert.deepEqual(state.form, { sshUser: "amy", hostName: "10.9.9.9", hostNameLocked: false, sshPort: 2200 });
  assert.deepEqual(world.calls.find((c) => c.cmd === "ssh-keyscan").args, ["-T", "5", "-p", "2200", "10.9.9.9"]);
});

test("「稍后再说」会记住；「重新运行引导」清掉进度但不删已写下的东西", async (t) => {
  const world = createWorld(t, { authorized: true, team: { sshHostKeyFingerprints: [HOST_FP] } });
  let guide = world.guide();
  assert.deepEqual(guide.getBrief(), { phase: "idle", dismissed: false, busy: false });
  guide.setDismissed(true);
  guide = world.guide();
  assert.equal(guide.getBrief().dismissed, true);

  guide.start({ sshUser: "amy" });
  assert.equal((await settle(guide)).phase, "done");
  assert.equal(guide.getBrief().dismissed, false, "真的开始之后就不算「稍后」了");
  const state = guide.reset();
  assert.equal(state.phase, "idle");
  assert.equal(fs.existsSync(world.statePath), false);
  assert.ok(fs.existsSync(path.join(world.sshDir, "config")), "已写下的连接配置还在");
});

test("fixture 模式：不执行任何命令、不写任何文件，照样能把整个界面流程演一遍", async (t) => {
  const world = createWorld(t, { fixtureMode: true });
  const guide = world.guide();
  assert.equal(guide.getState().simulated, true);
  guide.start({ sshUser: "amy" });
  let state = await settle(guide);
  assert.equal(state.prompt.kind, "hostkey");
  guide.answer({ kind: "hostkey", accept: true, linesHash: state.prompt.linesHash });
  state = await settle(guide);
  assert.equal(state.prompt.kind, "password");
  guide.answer({ kind: "password", password: "wrong" });
  state = await settle(guide);
  assert.equal(state.prompt.error, "wrong-password");
  guide.answer({ kind: "password", password: "anything" });
  state = await settle(guide);
  assert.equal(state.phase, "done");
  assert.deepEqual(statusOf(state), ALL_DONE);
  assert.equal(world.calls.length, 0);
  assert.equal(fs.existsSync(world.sshDir), false);
  assert.equal(fs.existsSync(world.statePath), false);
  assert.deepEqual(world.personal, {});
});

test("进度文件：认不出的版本 / 坏内容按没开始处理；正在跑的步骤读回后是待执行", () => {
  const ids = GUIDE_STEPS.map((s) => s.id);
  assert.deepEqual(reviveGuideState(null, ids), emptyGuideState(ids));
  assert.deepEqual(reviveGuideState({ version: 99, phase: "done" }, ids), emptyGuideState(ids));
  const revived = reviveGuideState({
    version: 1, phase: "running", form: { sshUser: "amy", password: "leak" },
    steps: { hostkey: { status: "done", detail: "ok" }, key: { status: "running", detail: "…" }, bogus: { status: "done" } },
    result: { remotePort: 7892, warnings: [{ code: "x", text: "y", extra: "z" }] },
  }, ids);
  assert.equal(revived.phase, "paused");
  assert.equal(revived.steps.hostkey.status, "done");
  assert.deepEqual(revived.steps.key, { status: "pending", detail: "", error: null });
  assert.equal(revived.steps.bogus, undefined);
  assert.deepEqual(revived.form, { sshUser: "amy", hostName: "", sshPort: null });
  assert.deepEqual(revived.result.warnings, [{ code: "x", text: "y", command: "" }]);

  const store = createGuideStore({ filePath: path.join(os.tmpdir(), `cwb-guide-missing-${process.pid}.json`), stepIds: ids });
  assert.equal(store.load().phase, "idle");
});
