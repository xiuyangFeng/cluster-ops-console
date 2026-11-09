import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { isSafeRoot, resolveIdentityFile, resolveTargets } from "./config.mjs";
import { buildInstallCommand, buildInstallScript, buildUninstallScript, KEY_COMMENT, parsePublicKey, scriptVersion } from "./install.mjs";
import { buildScanView, buildUsersView, mergeListWithScan, pickMounts } from "./model.mjs";
import { buildRootSshArgs, parseInfo, parseJobReply, parseList, parseQuota, parseScanResult } from "./protocol.mjs";
import { classifySshFailure, createStorageAdminService, REMOTE_SCRIPT_FILE } from "./service.mjs";
import { createStorageAdminStore } from "./store.mjs";

const SOURCE = readFileSync(REMOTE_SCRIPT_FILE, "utf8");
const PUB = `ssh-ed25519 ${"A".repeat(68)} someone@mac`;
// 服务器端脚本只跑在 Linux 上（fork / setsid / O_DIRECT）：Windows 的 CI 不跑它。
const hasPython = process.platform !== "win32" && spawnSync("python3", ["--version"]).status === 0;

function sandbox() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sa-")));
  const root = path.join(base, "root");
  mkdirSync(path.join(root, "alice", "big", "deeper"), { recursive: true });
  mkdirSync(path.join(root, "bob"), { recursive: true });
  writeFileSync(path.join(root, "alice", "big", "deeper", "f.bin"), Buffer.alloc(70 * 1024 * 1024, 1));
  writeFileSync(path.join(root, "bob", "x"), Buffer.alloc(3 * 1024 * 1024, 1));
  symlinkSync("/etc", path.join(root, "bob", "link"));
  mkdirSync(path.join(base, "state"));
  writeFileSync(path.join(base, "conf.json"), JSON.stringify({ roots: [root] }));
  const run = (command, args = null, { original = null } = {}) => {
    const env = { ...process.env, CODEX_STORAGE_ADMIN_CONF: path.join(base, "conf.json"), CODEX_STORAGE_ADMIN_STATE: path.join(base, "state") };
    if (original != null) env.SSH_ORIGINAL_COMMAND = original;
    const r = spawnSync("python3", [REMOTE_SCRIPT_FILE, ...(original == null ? [command] : [])], { input: args ? JSON.stringify(args) : "", env, encoding: "utf8" });
    return r.stdout;
  };
  return { base, root, run, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("远端脚本：子命令白名单，SSH_ORIGINAL_COMMAND 里只认第一个词", { skip: !hasPython }, () => {
  const s = sandbox();
  try {
    assert.equal(JSON.parse(s.run(null, null, { original: "rm -rf /" })).code, "bad-command");
    assert.equal(JSON.parse(s.run(null, null, { original: "scan-list; id" })).code, "bad-command");
    assert.equal(JSON.parse(s.run(null, null, { original: "scan-list" })).k, "jobs");
  } finally {
    s.cleanup();
  }
});

test("远端脚本：list 拒绝允许范围外 / 符号链接 / 不规整的路径", { skip: !hasPython }, () => {
  const s = sandbox();
  try {
    const ok = parseList(s.run("list", { path: path.join(s.root, "bob") }), { path: path.join(s.root, "bob") });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.list.entries.map((e) => [e.name, e.kind]).sort(), [["link", "l"], ["x", "f"]]);
    assert.equal(JSON.parse(s.run("list", { path: "/etc" })).code, "outside-roots");
    assert.equal(JSON.parse(s.run("list", { path: path.join(s.root, "bob", "link") })).code, "symlink");
    assert.equal(JSON.parse(s.run("list", { path: `${s.root}/bob/../alice` })).code, "bad-path");
    assert.equal(JSON.parse(s.run("list", { path: `${s.root}/` })).code, "bad-path");
  } finally {
    s.cleanup();
  }
});

test("远端脚本：后台整树扫描 → 结果含各层目录、属主合计与最大文件", { skip: !hasPython }, async () => {
  const s = sandbox();
  try {
    const started = parseJobReply(s.run("scan-start", { root: s.root }));
    assert.equal(started.ok, true);
    const job = started.job.id;
    let result;
    for (let i = 0; i < 50; i += 1) {
      result = parseScanResult(s.run("scan-result", { job }), { job });
      if (result.ok && result.result) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(result.job.state, "done");
    const rels = result.result.records.map((r) => r[0]);
    // 第一层全留；更深处只留 ≥ 64MB 的（alice/big、alice/big/deeper）
    assert.deepEqual(rels, ["alice", "alice/big", "alice/big/deeper", "bob"]);
    assert.ok(result.result.rootTotals[0] >= 73 * 1024 * 1024);
    assert.equal(result.result.top[0][0], "alice/big/deeper/f.bin");
    assert.equal(result.result.owners[0][0], process.getuid());
    // 已有任务在跑时不允许再开：这里已跑完，可以再开
    assert.equal(parseJobReply(s.run("scan-start", { root: path.join(s.root, "bob") })).ok, true);
    assert.equal(JSON.parse(s.run("scan-start", { root: "/etc" })).code, "outside-roots");
  } finally {
    s.cleanup();
  }
});

test("安装脚本：受限密钥行、可重复执行、拒绝坏输入，sh 语法正确", () => {
  const body = buildInstallScript({ publicKey: PUB, roots: ["/public"], source: SOURCE });
  assert.match(body, /restrict,command=\\"\$PY \/usr\/local\/lib\/codex-storage-admin\/storage-admin.py\\" ssh-ed25519 A+ codex-storage-admin/);
  assert.ok(!body.includes("someone@mac"));
  assert.match(body, new RegExp(`grep -v -F '${"A".repeat(68)}'`));
  assert.match(body, /'\{"roots":\["\/public"\]\}'/);
  assert.equal(spawnSync("sh", ["-n"], { input: body }).status, 0);
  assert.equal(spawnSync("sh", ["-n"], { input: buildUninstallScript(PUB) }).status, 0);
  assert.throws(() => buildInstallScript({ publicKey: "nope", roots: ["/public"], source: SOURCE }));
  assert.throws(() => buildInstallScript({ publicKey: PUB, roots: ["/pub lic"], source: SOURCE }));
  assert.throws(() => buildInstallScript({ publicKey: PUB, roots: ["/"], source: SOURCE }));
  assert.throws(() => buildInstallScript({ publicKey: PUB, roots: ["/public"], source: "x\nCODEX_STORAGE_ADMIN_PY_EOF\n" }));
  assert.equal(parsePublicKey(`${PUB}\n`), `ssh-ed25519 ${"A".repeat(68)}`);
  assert.equal(parsePublicKey(`ssh-ed25519 ${"A".repeat(68)}; rm -rf /`), null);
  assert.equal(scriptVersion(SOURCE), 3);
  assert.equal(KEY_COMMENT, "codex-storage-admin");
  assert.equal(buildInstallCommand({ host: "h.example", port: 22 }, "/a b/it's.sh", { platform: "darwin" }), "ssh root@h.example 'sh -s' < '/a b/it'\\''s.sh'");
  assert.equal(buildInstallCommand({ host: "h", port: 2222 }, "/x.sh", { platform: "darwin" }), "ssh -p 2222 root@h 'sh -s' < '/x.sh'");
  // Windows：给 cmd 的写法（双引号、< 重定向）
  assert.equal(
    buildInstallCommand({ host: "203.0.113.10", port: 22 }, "C:\\Users\\张三\\AppData\\Roaming\\codex-tunnel-monitor\\runtime\\storage-admin\\install-master.sh", { platform: "win32" }),
    'ssh root@203.0.113.10 "sh -s" < "C:\\Users\\张三\\AppData\\Roaming\\codex-tunnel-monitor\\runtime\\storage-admin\\install-master.sh"',
  );
});

test("配置：targets 逐条校验，坏条目丢弃；密钥路径展开 ~", () => {
  const targets = resolveTargets({ storageAdmin: { targets: [
    { id: "master", host: "203.0.113.10", roots: ["/public"] },
    { id: "bad host", host: "x", roots: ["/a"] },
    { id: "evil", host: "-oProxyCommand=x", roots: ["/a"] },
    { id: "noroot", host: "h", roots: ["/", "relative", "/a/../b"] },
    { id: "master", host: "dup", roots: ["/x"] },
    { id: "n4", label: "node04", host: "n4.local", port: 2200, roots: ["/mnt", "/mnt"] },
  ] } });
  assert.deepEqual(targets, [
    { id: "master", label: "master", host: "203.0.113.10", port: 22, roots: ["/public"] },
    { id: "n4", label: "node04", host: "n4.local", port: 2200, roots: ["/mnt"] },
  ]);
  assert.equal(isSafeRoot("/mnt/data1"), true);
  assert.equal(isSafeRoot("/mnt/$(id)"), false);
  assert.equal(resolveIdentityFile({}, { homeDir: "/Users/x" }), path.join("/Users/x", ".ssh", "id_ed25519_storage_admin"));
  assert.equal(resolveIdentityFile({ storageAdmin: { identityFile: "~/.ssh/k" } }, { homeDir: "/Users/x" }), path.join("/Users/x", ".ssh/k"));
});

test("SSH 参数：固定 root、禁用转发与复用、子命令白名单", () => {
  const args = buildRootSshArgs({ host: "h", port: 22 }, "/k", "info", { platform: "darwin" });
  assert.deepEqual(args.slice(-4), ["-l", "root", "h", "info"]);
  assert.ok(args.includes("BatchMode=yes") && args.includes("StrictHostKeyChecking=yes") && args.includes("ControlPath=none"));
  assert.throws(() => buildRootSshArgs({ host: "h" }, "/k", "sh"));
  // Windows 自带的 OpenSSH 不支持连接复用：不传 ControlMaster / ControlPath
  const win = buildRootSshArgs({ host: "h", port: 22 }, "C:\\k", "info", { platform: "win32" });
  assert.ok(!win.some((a) => /^Control(Master|Path)=/.test(a)));
  assert.deepEqual(win.slice(-4), ["-l", "root", "h", "info"]);
});

test("输出解析：远端输出当不可信数据", () => {
  assert.equal(parseInfo("").code, "no-output");
  assert.equal(parseInfo("{bad").code, "bad-output");
  assert.equal(parseInfo(JSON.stringify({ k: "err", code: "<script>" })).code, "remote-error");
  const info = parseInfo(JSON.stringify({
    k: "info", v: 1, host: "master", roots: [{ path: "/public", children: [{ name: "../x" }, { name: "newhome", uid: 0, owner: "root" }] }, { path: "rel" }],
    mounts: [{ mount: "/public", fs: "ext4", size: 10, used: 9, quota: true }, { mount: "bad" }],
    users: [{ name: "kai", uid: 1006, home: "/public/newhome/kai" }, { name: "", uid: 1 }], repquota: true, jobs: [{ id: "x" }],
  }));
  assert.equal(info.ok, true);
  assert.deepEqual(info.info.roots.map((r) => [r.path, r.children.map((c) => c.name)]), [["/public", ["newhome"]]]);
  assert.equal(info.info.mounts.length, 1);
  assert.equal(info.info.users.length, 1);
  assert.equal(info.info.jobs.length, 0);
  const q = parseQuota(JSON.stringify({ k: "quota", mount: "/public", rows: [[1006, "kai", 2048, 3], ["x", 1, 2, 3]] }), { mount: "/public" });
  assert.deepEqual(q.quota.rows, [{ uid: 1006, name: "kai", bytes: 2048, files: 3 }]);
  assert.equal(parseQuota(JSON.stringify({ k: "quota", mount: "/other", rows: [] }), { mount: "/public" }).ok, false);
  const r = parseScanResult(JSON.stringify({
    k: "result", id: "20261105-000000-abcdef", root: "/public", state: "done", bytes: 100,
    records: [["a", 50, 50, 1, 0, 1006, 1], ["../etc", 1, 1, 1, 1, 0, 1], ["/abs", 1, 1, 1, 1, 0, 1]],
    owners: [[1006, 100, 1]], top: [["a/f", 50, 50, 1006, 1]], names: { 1006: "kai", x: "bad" }, rootTotals: [100, 90, 2, 1],
  }), { job: "20261105-000000-abcdef" });
  assert.deepEqual(r.result.records.map((x) => x[0]), ["a"]);
  assert.deepEqual(r.result.names, { 1006: "kai" });
  assert.equal(parseScanResult(JSON.stringify({ k: "result", id: "20261105-000000-abcdef", root: "/public", state: "done" }), { job: "other-job-id" }).ok, false);
});

const ENTRY = {
  job: { id: "20261105-000000-abcdef", root: "/public", state: "done", bytes: 1000, threshold: 64, endedAt: 5 },
  result: {
    rootTotals: [1000, 900, 10, 5],
    records: [["newhome", 900, 800, 8, 4, 0, 1], ["newhome/kai", 600, 500, 5, 2, 1006, 1], ["newhome/kai/data", 400, 400, 3, 0, 1006, 1], ["newhome/lin", 200, 200, 2, 0, 1010, 1], ["apps", 50, 50, 1, 0, 0, 1]],
    owners: [[1006, 600, 5], [1010, 200, 2]],
    ownersOver: [0, 0],
    top: [["newhome/kai/data/big.bin", 300, 300, 1006, 1], ["apps/x", 40, 40, 0, 1]],
    names: { 0: "root", 1006: "kai", 1010: "lin" },
  },
};

test("视图：逐层浏览，子目录按占用排序，差额记为「其余」，面包屑与最大文件按层过滤", () => {
  const top = buildScanView(ENTRY, "");
  assert.deepEqual(top.children.map((c) => [c.name, c.deeper]), [["newhome", true], ["apps", false]]);
  assert.equal(top.rest, 50);
  assert.equal(top.owners[0].name, "kai");
  const home = buildScanView(ENTRY, "newhome");
  assert.deepEqual(home.children.map((c) => [c.name, c.owner]), [["kai", "kai"], ["lin", "lin"]]);
  assert.equal(home.rest, 100);
  assert.deepEqual(home.crumbs.map((c) => c.name), ["/public", "newhome"]);
  assert.equal(home.path, "/public/newhome");
  assert.deepEqual(home.top.map((t) => t.name), ["kai/data/big.bin"]);
  assert.equal(buildScanView(ENTRY, "newhome/none"), null);
  assert.equal(buildScanView(ENTRY, "../x"), null);
});

test("按用户：有配额用 repquota，没有就用扫描根正好是挂载点的最近一次完整扫描", () => {
  const info = { mounts: [{ mount: "/public", used: 1000, size: 2000, quota: false }, { mount: "/mnt/data1", used: 10, size: 20, quota: true }], users: [{ uid: 1006, name: "kai" }] };
  const views = buildUsersView({
    info,
    quota: { "/mnt/data1": { at: 1, rows: [{ uid: 1006, name: null, bytes: 4, files: 1 }, { uid: 7, name: "x", bytes: 6, files: 1 }] } },
    scans: [{ job: ENTRY.job, owners: [{ uid: 1006, name: "kai", bytes: 600, files: 5, share: 0.6 }] }],
  });
  assert.equal(views[0].source, "scan");
  assert.equal(views[0].rows[0].share, 0.6);
  assert.equal(views[1].source, "quota");
  assert.deepEqual(views[1].rows.map((r) => r.name), ["x", "kai"]);
  assert.equal(buildUsersView({ info }).every((v) => v.source === null), true);
});

test("即时列目录与扫描结果合并：有整树大小的目录按它排序", () => {
  const merged = mergeListWithScan({ path: "/public/newhome", entries: [
    { name: "lin", kind: "d", blocks: 4096 }, { name: "kai", kind: "d", blocks: 4096 }, { name: "note.txt", kind: "f", blocks: 100 },
  ] }, ENTRY, "newhome");
  assert.deepEqual(merged.entries.map((e) => [e.name, e.treeBlocks]), [["kai", 600], ["lin", 200], ["note.txt", null]]);
});

test("SSH 失败分类：给出能照着做的话", () => {
  const t = { host: "h", port: 22 };
  assert.equal(classifySshFailure({ code: 255, stderr: "root@h: Permission denied (publickey,password)." }, t).code, "auth");
  assert.equal(classifySshFailure({ code: 255, stderr: "Host key verification failed." }, t).code, "host-key");
  assert.equal(classifySshFailure({ code: 255, stderr: "ssh: connect to host h port 22: Connection refused" }, t).code, "unreachable");
  assert.equal(classifySshFailure({ timedOut: true }, t).code, "timeout");
});

function fakeService({ admin = true, replies = {}, dir = null } = {}) {
  const calls = [];
  const timers = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, command: args.at(-1), input: opts.input });
    const reply = replies[args.at(-1)];
    return typeof reply === "function" ? reply(opts) : reply ?? { code: 255, stdout: "", stderr: "Permission denied (publickey)." };
  };
  const svc = createStorageAdminService({
    getConfig: async () => ({ storageAdmin: { targets: [{ id: "master", host: "h", roots: ["/public"] }] } }),
    isAdmin: () => admin,
    store: createStorageAdminStore({ dir }),
    exec,
    dir: dir ?? os.tmpdir(),
    homeDir: "/Users/x",
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  return { svc, calls, timers };
}

test("服务：非管理员一律 403，不发任何 SSH", async () => {
  const { svc, calls } = fakeService({ admin: false });
  await assert.rejects(svc.overview(), (e) => e.status === 403);
  await assert.rejects(svc.refresh("master"), (e) => e.status === 403);
  await assert.rejects(svc.startScan("master", "/public"), (e) => e.status === 403);
  assert.equal(calls.length, 0);
});

test("服务：密钥没装上 → 记下可照做的错误；越界路径不发 SSH", async () => {
  const { svc, calls } = fakeService();
  const view = await svc.refresh("master");
  assert.equal(view.status.state, "error");
  assert.equal(view.status.code, "auth");
  await assert.rejects(svc.startScan("master", "/etc"), (e) => e.status === 400);
  await assert.rejects(svc.startScan("master", "/public/../etc"), (e) => e.status === 400);
  await assert.rejects(svc.list("master", "/publicity"), (e) => e.status === 400);
  assert.equal(calls.length, 1);
});

test("服务：开始扫描 → 轮询到结束 → 取回结果存本机 → 可逐层浏览", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sa-svc-"));
  try {
    const job = { id: "20261105-000000-abcdef", root: "/public", state: "running", bytes: 0 };
    const { svc, calls, timers } = fakeService({
      dir,
      replies: {
        "scan-start": { code: 0, stdout: JSON.stringify({ k: "started", job }) },
        "scan-status": { code: 0, stdout: JSON.stringify({ k: "status", job: { ...job, state: "done", bytes: 1000 } }) },
        "scan-result": { code: 0, stdout: JSON.stringify({ k: "result", ...ENTRY.job, ...ENTRY.result }) },
      },
    });
    const started = await svc.startScan("master", "/public");
    assert.equal(started.running.id, job.id);
    assert.equal(timers.length, 1);
    await timers[0].fn();
    // 轮询是异步链：等它跑完
    for (let i = 0; i < 20 && !calls.some((c) => c.command === "scan-result"); i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 30));
    const ov = await svc.overview();
    assert.equal(ov.targets[0].running, null);
    assert.deepEqual(ov.targets[0].scans.map((s) => s.id), [job.id]);
    const view = await svc.scanView("master", job.id, "newhome");
    assert.deepEqual(view.children.map((c) => c.name), ["kai", "lin"]);
    assert.deepEqual(JSON.parse(calls.find((c) => c.command === "scan-start").input), { root: "/public" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("挂载点：根下有独立磁盘时不带出根所在的系统盘；根本身不是挂载点也没有子挂载时显示所在的盘", () => {
  const m = (mount) => ({ mount });
  assert.deepEqual(pickMounts([m("/"), m("/mnt/data1"), m("/mnt/data2")], ["/mnt"]).map((x) => x.mount), ["/mnt/data1", "/mnt/data2"]);
  assert.deepEqual(pickMounts([m("/"), m("/public")], ["/public"]).map((x) => x.mount), ["/public"]);
  assert.deepEqual(pickMounts([m("/"), m("/home")], ["/srv/data"]).map((x) => x.mount), ["/"]);
});

const FIXTURES = path.join(path.dirname(REMOTE_SCRIPT_FILE), "..", "lib", "storage-admin", "fixtures");

test("读 inode 表：小 ext4 镜像（meta_bg、1K 块、uid_high）按 uid 合计与 debugfs 逐 inode 的 i_blocks 完全一致", { skip: !hasPython }, () => {
  // 镜像由集群上 mke2fs -d 生成（fixtures/ 里的 .img.gz），期望值是 debugfs 逐个 inode 的 User / Blockcount 合计。
  const dir = mkdtempSync(path.join(os.tmpdir(), "sa-ext-"));
  try {
    const img = path.join(dir, "fixture.img");
    writeFileSync(img, gunzipSync(readFileSync(path.join(FIXTURES, "ext4-meta-bg.img.gz"))));
    const r = spawnSync("python3", [REMOTE_SCRIPT_FILE, "--test-inode-usage", img], { encoding: "utf8", env: { ...process.env } });
    const out = JSON.parse(r.stdout);
    const expect = JSON.parse(readFileSync(path.join(FIXTURES, "ext4-meta-bg.expect.json"), "utf8"));
    // owners：{ uid: [占用, inode 数, 最新修改时间] }；前两项与 debugfs 真值一致，修改时间是镜像生成时刻（> 0，不在未来）。
    assert.deepEqual(Object.fromEntries(Object.entries(out.owners).map(([k, v]) => [k, v.slice(0, 2)])), expect);
    for (const v of Object.values(out.owners)) assert.ok(v[2] > 1.7e9 && v[2] <= Date.now() / 1000 + 86400);
    assert.ok(out.fs.features.includes("meta_bg"));
    assert.equal(out.stats.partial, false);
    // 不是 ext 的文件 → 拒绝而不是乱读
    writeFileSync(img, Buffer.alloc(8192));
    const bad = spawnSync("python3", [REMOTE_SCRIPT_FILE, "--test-inode-usage", img], { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /not-ext/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("远端脚本：usage-start 只认允许范围内的 ext 挂载点", { skip: !hasPython }, () => {
  const s = sandbox();
  try {
    // 允许范围外的挂载点（沙箱根所在的那块盘在 Linux 上是允许的，不能拿 / 当反例）
    assert.equal(JSON.parse(s.run("usage-start", { mount: "/proc" })).code, "bad-mount");
    assert.equal(JSON.parse(s.run("usage-start", { mount: 5 })).code, "bad-mount");
    // 自测入口只在非 root 且直接调用时可用；经 SSH（SSH_ORIGINAL_COMMAND）不认
    assert.equal(JSON.parse(s.run(null, null, { original: "--test-inode-usage /etc/passwd" })).code, "bad-command");
  } finally {
    s.cleanup();
  }
});

test("协议：info 里的 inodeScan 与任务 kind 当不可信数据解析", () => {
  const info = parseInfo(JSON.stringify({ k: "info", v: 2, host: "m", roots: [], users: [], mounts: [
    { mount: "/public", fs: "ext4", inodeScan: { ok: true, fs: { blockSize: 4096, inodeSize: 256, inodes: 10, features: ["64bit", "<x>"] } } },
    { mount: "/data", fs: "nfs4", inodeScan: { ok: false, code: "<script>", detail: "x" } },
  ], jobs: [{ id: "20261106-000000-abcdef", root: "/public", kind: "inode", state: "running" }, { id: "20261106-000000-abcdee", root: "/public", kind: "rm -rf" }] }));
  assert.deepEqual(info.info.mounts[0].inodeScan.fs.features, ["64bit"]);
  assert.equal(info.info.mounts[1].inodeScan.code, "probe-failed");
  assert.deepEqual(info.info.jobs.map((j) => j.kind), ["inode", "tree"]);
});

test("按用户：最近一次读 inode 表的统计标为 inode 来源，并带出能否统计", () => {
  const info = { mounts: [{ mount: "/public", used: 100, size: 200, iused: 5, quota: false, inodeScan: { ok: true, fs: {} } }], users: [] };
  const v = buildUsersView({ info, scans: [{ job: { id: "j", root: "/public", kind: "inode", state: "done", endedAt: 9 }, owners: [{ uid: 1, name: "a", bytes: 60, files: 2, share: 0.6 }] }] });
  assert.equal(v[0].source, "inode");
  assert.equal(v[0].inodeScan.ok, true);
});

test("服务：按用户统计只在这块盘能读 inode 表时发 usage-start", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sa-svc-"));
  try {
    const job = { id: "20261106-000000-abcdef", kind: "inode", root: "/public", state: "running" };
    const mounts = [{ mount: "/public", fs: "ext4", size: 10, used: 5, avail: 5, inodeScan: { ok: true, fs: { inodes: 10, inodeSize: 256 } } }];
    const { svc, calls } = fakeService({
      dir,
      replies: {
        info: { code: 0, stdout: JSON.stringify({ k: "info", v: 2, host: "m", roots: [{ path: "/public", children: [] }], mounts, users: [], jobs: [] }) },
        "usage-start": { code: 0, stdout: JSON.stringify({ k: "started", job }) },
      },
    });
    await assert.rejects(svc.startUsage("master", "/public"), (e) => e.status === 400); // 还没刷新过
    await svc.refresh("master");
    const view = await svc.startUsage("master", "/public");
    assert.equal(view.running.kind, "inode");
    assert.deepEqual(JSON.parse(calls.find((c) => c.command === "usage-start").input), { mount: "/public" });
    await assert.rejects(svc.startUsage("master", "/etc"), (e) => e.status === 400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("远端脚本：info 附带每个账号的 SSH 最后登录（按 uid 读 lastlog 定长记录，0 = 从没登录）", { skip: !hasPython }, () => {
  const s = sandbox();
  try {
    const me = process.getuid();
    const lastlog = path.join(s.base, "lastlog");
    const buf = Buffer.alloc((me + 2) * 292);
    buf.writeInt32LE(1790000000, me * 292);
    writeFileSync(lastlog, buf);
    const env = { CODEX_STORAGE_ADMIN_LASTLOG: lastlog };
    const r = spawnSync("python3", [REMOTE_SCRIPT_FILE, "info"], {
      encoding: "utf8", env: { ...process.env, CODEX_STORAGE_ADMIN_CONF: path.join(s.base, "conf.json"), CODEX_STORAGE_ADMIN_STATE: path.join(s.base, "state"), ...env },
    });
    const info = parseInfo(r.stdout);
    assert.equal(info.ok, true);
    const mine = info.info.users.find((u) => u.uid === me);
    // macOS 上本机账号 uid 常 < 1000（不在列表里）；在列表里时登录时间要读对
    if (mine) assert.equal(mine.lastLogin, 1790000000);
    for (const u of info.info.users) assert.ok(u.lastLogin === 0 || u.lastLogin === null || Number.isInteger(u.lastLogin));
  } finally {
    s.cleanup();
  }
});

test("协议与模型：owners 第 4 项是最新修改时间，按用户行带账号类型与最后登录", () => {
  const r = parseScanResult(JSON.stringify({
    k: "result", id: "20261106-000000-abcdef", root: "/public", state: "done", kind: "inode", bytes: 10,
    records: [], top: [], owners: [[1006, 6, 1, 1790000000], [5, 4, 1]], names: {}, rootTotals: [10, 0, 2, 0],
  }), { job: "20261106-000000-abcdef" });
  assert.deepEqual(r.result.owners, [[1006, 6, 1, 1790000000], [5, 4, 1, null]]);
  const info = { mounts: [{ mount: "/public", used: 10, size: 20 }], users: [{ uid: 1006, name: "kai", lastLogin: 1780000000 }, { uid: 1005, name: "lin", lastLogin: 0 }] };
  const v = buildUsersView({ info, scans: [{ job: { id: "j", root: "/public", kind: "inode", state: "done", endedAt: 1 }, owners: [
    { uid: 1006, bytes: 5, files: 1, lastWrite: 1790000000 }, { uid: 1005, bytes: 3, files: 1, lastWrite: 1700000000 },
    { uid: 100006, bytes: 1, files: 1, lastWrite: 1700000000 }, { uid: 0, bytes: 1, files: 1, lastWrite: 1700000000 },
  ] }] });
  const by = Object.fromEntries(v[0].rows.map((x) => [x.uid, x]));
  assert.equal(by[1006].account, "user");
  assert.equal(by[1006].lastLogin, 1780000000);
  assert.equal(by[1005].lastLogin, 0);
  assert.equal(by[100006].account, "none");
  assert.equal(by[0].account, "system");
});

// 把安装 / 卸载脚本里改 authorized_keys 的那段拿出来，对一个临时文件真的跑一遍（不需要 root）。
function runAkBlock(script, ak) {
  const lines = script.split("\n");
  const start = lines.findIndex((l) => l.startsWith("AK=/root/.ssh/authorized_keys"));
  const endInstall = lines.findIndex((l, i) => i > start && l === 'mv -f "$AK.codex-new" "$AK"');
  const block = endInstall > 0 ? lines.slice(start, endInstall + 1) : lines.slice(start).filter((l) => !/rm -rf|rm -f \/etc/.test(l));
  const sh = ["set -eu", "PY=/usr/bin/python3", ...block.map((l) => l.replace("AK=/root/.ssh/authorized_keys", `AK='${ak}'`))].join("\n");
  const r = spawnSync("sh", ["-c", sh], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(ak, "utf8");
}

test("authorized_keys：两台电脑各装各的互不踢掉；重装只替换自己那一行；卸载只删自己", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sa-ak-"));
  try {
    const ak = path.join(dir, "authorized_keys");
    writeFileSync(ak, "ssh-ed25519 OTHERKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx admin@laptop\n");
    const mac = `ssh-ed25519 ${"M".repeat(68)} mac`;
    const winKey = `ssh-ed25519 ${"W".repeat(68)} win`;
    runAkBlock(buildInstallScript({ publicKey: mac, roots: ["/public"], source: SOURCE }), ak);
    let text = runAkBlock(buildInstallScript({ publicKey: winKey, roots: ["/public"], source: SOURCE }), ak);
    assert.equal(text.split("\n").filter((l) => l.endsWith(" codex-storage-admin")).length, 2);
    assert.match(text, /OTHERKEY/);
    // Mac 重装：仍然只有各一行
    text = runAkBlock(buildInstallScript({ publicKey: mac, roots: ["/public"], source: SOURCE }), ak);
    assert.equal(text.split("\n").filter((l) => l.includes("M".repeat(68))).length, 1);
    assert.equal(text.split("\n").filter((l) => l.endsWith(" codex-storage-admin")).length, 2);
    assert.match(text, /restrict,command="\/usr\/bin\/python3 \/usr\/local\/lib\/codex-storage-admin\/storage-admin.py" ssh-ed25519 W+ codex-storage-admin/);
    // Windows 卸载：只删它自己
    text = runAkBlock(buildUninstallScript(winKey), ak);
    assert.ok(!text.includes("W".repeat(68)));
    assert.ok(text.includes("M".repeat(68)));
    assert.match(text, /OTHERKEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("存储配置：root 不依赖管理员名单，可在页面保存；普通账号被拒绝且不写入", async () => {
  const { isAdminUser, resolveEffectiveSshUser } = await import("../team-admin/protocol.mjs");
  let user = "root";
  let config = { activeServerId: "s1", adminUsers: [], servers: [{ id: "s1", name: "当前集群", host: "myserver", sshHostName: "cluster.example.org", sshPort: 2222 }], storageAdmin: { identityFile: "~/.ssh/special" } };
  const writes = [];
  const svc = createStorageAdminService({
    getConfig: async () => ({ ...config, sshUser: user }),
    isAdmin: (c) => isAdminUser(c, resolveEffectiveSshUser(c)),
    store: createStorageAdminStore({ dir: null }),
    exec: () => { throw new Error("保存配置不应发 SSH"); },
    dir: os.tmpdir(),
    savePersonalConfig: async (patch) => { writes.push(patch); config = { ...config, ...patch }; },
  });
  const view = await svc.overview();
  assert.deepEqual(view.setup, { id: "s1", label: "当前集群", host: "cluster.example.org", port: 2222 });
  const target = { ...view.setup, roots: ["/public", "/mnt"] };
  assert.equal((await svc.configureTarget(target)).saved, true);
  assert.equal(writes[0].storageAdmin.identityFile, "~/.ssh/special");
  assert.deepEqual(writes[0].storageAdmin.targets, [target]);
  await assert.rejects(svc.configureTarget({ ...target, roots: ["/"] }), (e) => e.status === 400);
  await assert.rejects(svc.configureTarget({ ...target, host: "-oProxyCommand=x" }), (e) => e.status === 400);
  user = "lin";
  await assert.rejects(svc.configureTarget(target), (e) => e.status === 403);
  await assert.rejects(svc.overview(), (e) => e.status === 403);
  assert.equal(writes.length, 1);
});
