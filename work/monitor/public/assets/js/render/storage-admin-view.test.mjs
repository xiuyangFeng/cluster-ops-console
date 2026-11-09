import assert from "node:assert/strict";
import { test } from "node:test";

import { idleState, idleSummary } from "./storage-admin-viz.js";
import { buildBrowserHtml, buildListHtml, buildOverviewHtml, buildSetupHtml, quotaGuideHtml } from "./storage-admin-view.js";

const NOW = Date.UTC(2026, 10, 5, 8, 0);
const target = (over = {}) => ({
  id: "master", label: "master", host: "203.0.113.10", port: 22, roots: ["/public"],
  status: { state: "ok" }, checkedAt: NOW - 60_000,
  info: {
    version: 1, host: "master",
    mounts: [{ mount: "/public", device: "/dev/sda", fs: "ext4", quota: false, size: 100, used: 88, avail: 7, inodes: 300_000_000, iused: 236_000_000 }],
    roots: [{ path: "/public", children: [{ name: "newhome", owner: "root", uid: 0, mount: false }, { name: "<img src=x>", owner: null, uid: 5, mount: false }] }],
    users: [],
  },
  users: [{ mount: "/public", source: null, quota: false, used: 88, size: 100, iused: 236_000_000, rows: [] }],
  running: null, jobs: [], scans: [],
  ...over,
});

test("无存储配置时在页面预填当前服务器，可保存目录范围；预填内容转义", () => {
  const html = buildOverviewHtml({ targets: [], setup: { id: "server-01", label: '<img src=x>', host: "cluster.example.org", port: 2222 } });
  assert.match(html, /配置存储服务器/);
  assert.match(html, /value="cluster.example.org"/);
  assert.match(html, /value="2222"/);
  assert.match(html, /data-sa-save-target/);
  assert.doesNotMatch(html, /<img src=x>/);
});

test("接入步骤：没有密钥时给「生成密钥」，全部就绪后默认收起", () => {
  const html = buildSetupHtml({ key: { exists: false }, targets: [target({ status: { state: "error", message: "专用密钥还没有装到 root@h" } })] });
  assert.match(html, /<details class="sa-setup" open>/);
  assert.match(html, /data-sa-key/);
  assert.ok(!html.includes("data-sa-installer"));
  const ready = buildSetupHtml({ key: { exists: true, identityFile: "/k" }, targets: [target()] });
  assert.match(ready, /<details class="sa-setup">/);
  assert.match(ready, /已全部就绪/);
  const withCmd = buildSetupHtml({ key: { exists: true }, targets: [target({ status: { state: "error" } })] }, {
    installers: { master: { command: "ssh root@h 'sh -s' < '/x.sh'", uninstallCommand: "ssh root@h 'sh -s' < '/u.sh'" } },
  });
  assert.match(withCmd, /data-sa-copy="ssh root@h &#039;sh -s&#039; &lt; &#039;\/x.sh&#039;"/);
  const win = buildSetupHtml({ key: { exists: true }, targets: [target({ status: { state: "error" } })] }, {
    installers: { master: { shell: "cmd", command: 'ssh root@h "sh -s" < "C:\\x.sh"', uninstallCommand: 'ssh root@h "sh -s" < "C:\\u.sh"' } },
  });
  assert.match(win, /命令提示符」（cmd，<b>不是 PowerShell<\/b>）/);
});

test("机器卡片：容量条按占比分级，按用户没有数据时给出开配额的说明，目录名转义", () => {
  const html = buildOverviewHtml({ key: { exists: true }, targets: [target()] }, { now: NOW });
  assert.match(html, /data-level="crit"/);
  assert.match(html, /在 \/public 开启用户配额统计/);
  assert.ok(html.includes("&lt;img src=x&gt;"));
  assert.ok(!html.includes("<img src=x>"));
  assert.match(html, /data-sa-scan="master" data-root="\/public"/);
});

test("机器卡片：扫描进行中显示进度与停止，扫描按钮禁用", () => {
  const job = { id: "20261105-000000-abcdef", root: "/public", state: "running", entries: 50, estTotal: 100, bytes: 1024, startedAt: NOW / 1000 - 600, current: "newhome/kai" };
  const html = buildOverviewHtml({ key: { exists: true }, targets: [target({ running: job })] }, { now: NOW });
  assert.match(html, /正在扫描 \/public/);
  assert.match(html, /约 50%/);
  assert.match(html, /data-sa-stop="master" data-job="20261105-000000-abcdef"/);
  assert.match(html, /data-sa-scan="master" data-root="\/public" disabled/);
});

test("按用户：有数据时按占用列出，来源写清楚", () => {
  const t = target({ users: [{ mount: "/public", source: "quota", at: NOW / 1000, used: 93, size: 100, rows: [{ uid: 1006, name: "kai", bytes: 50, files: 3, share: 0.5 }] }] });
  const html = buildOverviewHtml({ key: { exists: true }, targets: [t] }, { now: NOW });
  assert.match(html, /来源：repquota/);
  assert.match(html, /<td class="sa-name"><span class="sa-swatch" data-kind="user" data-slot="1"><\/span>kai<\/td>/);
  assert.match(html, /class="sa-split" role="img" aria-label="\/public 容量构成：kai 50 B/);
  assert.match(quotaGuideHtml("/public", t), /quotacheck -cum \/public/);
});

test("浏览：可深入的目录是按钮，「其余」行与面包屑", () => {
  const view = {
    job: { id: "j", root: "/public", endedAt: NOW / 1000, partial: false }, rel: "newhome", path: "/public/newhome", parent: "",
    crumbs: [{ rel: "", name: "/public" }, { rel: "newhome", name: "newhome" }],
    node: { blocks: 1000, files: 10, dirs: 3, owner: "root" },
    children: [{ rel: "newhome/kai", name: "kai", blocks: 600, share: 0.6, files: 5, owner: "kai", deeper: true }, { rel: "newhome/z", name: "z", blocks: 100, share: 0.1, files: 1, owner: "z", deeper: false }],
    hiddenChildren: 0, rest: 300, top: [], owners: null, threshold: 64 * 1024 * 1024,
  };
  const html = buildBrowserHtml(view, { now: NOW });
  assert.match(html, /data-sa-rel="newhome\/kai">kai\/<\/button>/);
  assert.ok(!html.includes('data-sa-rel="newhome/z"'));
  assert.match(html, /data-sa-rel="">\/public<\/button>/);
  assert.match(html, /其余（小于 64/);
  assert.match(html, /data-sa-list-here="\/public\/newhome"/);
  // 矩形树图：可深入的目录是按钮，不能深入的是可聚焦的 div，「其余」单独一块
  assert.match(html, /<button type="button" class="sa-tm-tile" data-tone="4"[^>]*data-sa-rel="newhome\/kai"/);
  assert.match(html, /<div class="sa-tm-tile" data-tone="3"[^>]*data-tip-name="z\/"/);
  assert.match(html, /<div class="sa-tm-tile" data-tone="rest"/);
});

test("即时列目录：没扫描过的目录显示「未扫描」，独立磁盘同样可以点进去", () => {
  const html = buildListHtml({ path: "/mnt", truncated: false, entries: [
    { name: "data1", kind: "d", mount: true, blocks: 4096, treeBlocks: null },
    { name: "x", kind: "d", mount: false, blocks: 4096, treeBlocks: null },
    { name: "f", kind: "f", mount: false, blocks: 2048, size: 2000 },
  ] });
  assert.match(html, /独立磁盘/);
  assert.match(html, /data-sa-list-here="\/mnt\/data1"/);
  assert.match(html, /data-sa-list-here="\/mnt\/x"/);
  assert.match(html, /未扫描/);
});

test("容量按 df 口径（已用 ÷（已用 + 可用））；排序长条单一颜色；小盘不提示开配额", () => {
  const html = buildOverviewHtml({ key: { exists: true }, targets: [target()] }, { now: NOW });
  assert.match(html, /data-level="crit">93%</);
  const small = target({ users: [{ mount: "/mnt/sda2", source: "scan", at: 1, used: 10, size: 20, iused: 200_000, rows: [{ uid: 1, name: "zxl", bytes: 9, files: 1, share: 0.99 }] }] });
  const s = buildOverviewHtml({ key: { exists: true }, targets: [small] }, { now: NOW });
  assert.match(s, /<td class="sa-barcell"><span class="sa-rbar"><span class="sa-rbar-fill" style="width:100.00%">/);
  assert.ok(!s.includes("在 /mnt/sda2 开启用户配额统计"));
  const empty = target({ users: [{ mount: "/mnt/sda2", source: null, quota: false, used: 10, size: 20, iused: 200_000, rows: [] }] });
  assert.match(buildOverviewHtml({ key: { exists: true }, targets: [empty] }, { now: NOW }), /整盘扫描一次即可/);
});

test("按用户统计：能读 inode 表的盘给出按钮与预计时长，并且不再推荐开配额", () => {
  const t = target({ users: [{ mount: "/public", source: null, quota: false, used: 88, size: 100, iused: 236_000_000, rows: [],
    inodeScan: { ok: true, fs: { inodes: 732_516_352, inodeSize: 256 } } }] });
  const html = buildOverviewHtml({ key: { exists: true }, targets: [t] }, { now: NOW });
  assert.match(html, /data-sa-usage="master" data-mount="\/public"/);
  assert.match(html, /最多约 \d+ 分钟/);
  assert.ok(!html.includes("开启用户配额统计"));
  const running = target({ running: { id: "20261106-000000-abcdef", kind: "inode", root: "/public", entries: 10, estTotal: 100, startedAt: NOW / 1000 - 60, current: "第 3 / 10 组" },
    users: t.users });
  const r = buildOverviewHtml({ key: { exists: true }, targets: [running] }, { now: NOW });
  assert.match(r, /正在按用户统计 \/public（读 inode 表）/);
  assert.match(r, /data-sa-usage="master" data-mount="\/public" disabled/);
  const done = target({ users: [{ ...t.users[0], source: "inode", at: NOW / 1000, rows: [{ uid: 1, name: "kai", bytes: 5, files: 1, share: 0.1 }] }] });
  assert.match(buildOverviewHtml({ key: { exists: true }, targets: [done] }, { now: NOW }), /来源：读 inode 表按属主统计全盘/);
});

const DAY = 86400;
const NOW_S = NOW / 1000;
const GIB = 1024 ** 3;
const row = (over) => ({ uid: 1, name: "a", bytes: 100 * GIB, files: 1, share: 0.1, account: "user", lastLogin: NOW_S - 10 * DAY, lastWrite: NOW_S - 10 * DAY, ...over });

test("不活跃判定：登录与数据都超过时长才算；系统账号不判定；任一时间未知不下结论", () => {
  const old = NOW_S - 200 * DAY;
  assert.equal(idleState(row({ lastLogin: old, lastWrite: old }), { now: NOW, months: 6 }).idle, true);
  assert.equal(idleState(row({ lastLogin: old }), { now: NOW, months: 6 }).idle, false); // 数据近期还在改
  assert.equal(idleState(row({ lastWrite: old }), { now: NOW, months: 6 }).idle, false); // 最近还登录过
  assert.equal(idleState(row({ lastLogin: 0, lastWrite: old }), { now: NOW, months: 6 }).idle, true); // 从没登录
  assert.equal(idleState(row({ account: "none", lastLogin: null, lastWrite: old }), { now: NOW, months: 6 }).idle, true); // 已无账号
  assert.equal(idleState(row({ account: "system", lastLogin: null, lastWrite: old }), { now: NOW, months: 6 }).idle, false);
  assert.equal(idleState(row({ lastLogin: old, lastWrite: null }), { now: NOW, months: 6 }).idle, false); // 修改时间未知
  assert.equal(idleState(row({ lastLogin: NOW_S - 120 * DAY, lastWrite: NOW_S - 120 * DAY }), { now: NOW, months: 3 }).idle, true);
  assert.equal(idleState(row({ lastLogin: NOW_S - 120 * DAY, lastWrite: NOW_S - 120 * DAY }), { now: NOW, months: 6 }).idle, false);
  const s = idleSummary({ used: 1000 * GIB, rows: [row({ bytes: 300 * GIB, lastLogin: old, lastWrite: old }), row({ uid: 2, bytes: 700 * GIB })] }, { now: NOW, months: 6 });
  assert.deepEqual([s.count, s.bytes, s.share, s.writeKnown], [1, 300 * GIB, 0.3, true]);
  // 占用不到 1 GiB：不标、不计入合计
  assert.equal(idleState(row({ bytes: GIB - 1, lastLogin: old, lastWrite: old }), { now: NOW, months: 6 }).idle, false);
  assert.equal(idleState(row({ bytes: GIB, lastLogin: old, lastWrite: old }), { now: NOW, months: 6 }).idle, true);
  const tiny = idleSummary({ used: 1000 * GIB, rows: [row({ bytes: 1024, lastLogin: old, lastWrite: old })] }, { now: NOW, months: 6 });
  assert.equal(tiny.count, 0);
});

const usersTarget = (rows, extra = {}) => target({ users: [{ mount: "/public", source: "inode", at: NOW_S, used: 1000, size: 2000, iused: 5, rows, inodeScan: { ok: true, fs: {} } }], ...extra });

test("按用户：不活跃的行加紫色标记与标签，时长切换与「只看不活跃」，默认只列前 5 项可展开", () => {
  const old = NOW_S - 400 * DAY;
  const rows = Array.from({ length: 8 }, (_, i) => row({ uid: 100 + i, name: `u${i}`, bytes: (1000 - i * 10) * GIB, share: 0.1, ...(i === 1 ? { lastLogin: old, lastWrite: old } : {}) }));
  const html = buildOverviewHtml({ key: { exists: true }, targets: [usersTarget(rows)] }, { now: NOW, activity: { months: 6, only: false } });
  assert.equal((html.match(/data-idle="true"/g) || []).length, 1);
  assert.match(html, /<span class="sa-idle-tag">不活跃<\/span>/);
  assert.match(html, /data-sa-idle-months="6" aria-pressed="true"/);
  assert.match(html, /不活跃 1 位，共占/);
  assert.equal((html.match(/<td class="sa-rank">/g) || []).length, 5);
  assert.match(html, /data-sa-fold="users:master:\/public" aria-expanded="false">展开全部（8 项）/);
  const open = buildOverviewHtml({ key: { exists: true }, targets: [usersTarget(rows)] }, { now: NOW, activity: { months: 6, only: false }, fold: { open: new Set(["users:master:/public"]) } });
  assert.equal((open.match(/<td class="sa-rank">/g) || []).length, 8);
  const only = buildOverviewHtml({ key: { exists: true }, targets: [usersTarget(rows)] }, { now: NOW, activity: { months: 6, only: true } });
  assert.equal((only.match(/<td class="sa-rank">/g) || []).length, 1);
  assert.match(only, /<td class="sa-rank">2<\/td>/); // 保留原排名
  const unknown = buildOverviewHtml({ key: { exists: true }, targets: [usersTarget(rows.map((r) => ({ ...r, lastWrite: null })))] }, { now: NOW });
  assert.match(unknown, /重新「按用户统计」一次/);
});

test("多台机器：标签页一次只展开一台，标签带最满那块盘的占用", () => {
  const a = target();
  const b = target({ id: "node04", label: "node04", host: "n4", info: { ...target().info, mounts: [{ mount: "/mnt/data1", size: 100, used: 30, avail: 70, inodes: 1, iused: 1 }] }, users: [] });
  const html = buildOverviewHtml({ key: { exists: true }, targets: [a, b] }, { now: NOW, selected: "node04" });
  assert.match(html, /data-sa-target-tab="master" aria-selected="false"/);
  assert.match(html, /data-sa-target-tab="node04" aria-selected="true"/);
  assert.match(html, /<span class="sa-tab-pct" data-level="crit">93%<\/span>/);
  assert.equal((html.match(/<section class="sa-target">/g) || []).length, 1);
  assert.match(html, /\/mnt\/data1/);
});

test("一台机器多块盘：只展开已用最多那块的「按用户」，其余收成一行可展开", () => {
  const mk = (mount, used) => ({ mount, source: "scan", at: NOW_S, used, size: 2000, iused: 5, rows: [row({ name: `top-${mount}`, bytes: used })] });
  const t = target({ users: [mk("/mnt/a", 100), mk("/mnt/b", 900)] });
  const html = buildOverviewHtml({ key: { exists: true }, targets: [t] }, { now: NOW });
  assert.match(html, /data-sa-fold="ublock:master:\/mnt\/a" aria-expanded="false">展开/);
  assert.match(html, /最多 top-\/mnt\/a/);
  assert.equal((html.match(/<table class="sa-table sa-ranked">/g) || []).length, 1);
  const open = buildOverviewHtml({ key: { exists: true }, targets: [t] }, { now: NOW, fold: { open: new Set(["ublock:master:/mnt/a"]) } });
  assert.equal((open.match(/<table class="sa-table sa-ranked">/g) || []).length, 2);
  assert.match(open, /data-sa-fold="ublock:master:\/mnt\/a" aria-expanded="true">收起/);
});
