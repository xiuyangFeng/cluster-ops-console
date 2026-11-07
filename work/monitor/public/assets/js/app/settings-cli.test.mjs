import assert from "node:assert/strict";
import test from "node:test";

import { buildCliHtml, buildJobHtml, buildTeamCacheHtml, cacheVersionFor, CLI_JOB_POLL_CLOSED_MS, cliActions, confirmText, createSettingsCli, describeCliState, formatEta } from "./settings-cli.js";
import { fakeDialog, fakeDocument, fakeElement, fakeTimers, flush, spy } from "./test-support.mjs";

const cliState = (patch) => ({ installed: true, version: "0.159.2", kind: "standalone", path: "~/.local/bin/codex", login: "chatgpt", loginDetail: null, label: "Codex", latest: "0.160.1", latestError: null, updateAvailable: true, ...patch });
const OVERVIEW = {
  eligible: true,
  serverId: "server-01",
  clis: {
    codex: cliState(),
    claude: cliState({ installed: false, version: null, kind: null, label: "Claude Code", latest: "2.1.292", updateAvailable: false }),
  },
  job: null,
  busy: null,
};
const NO_CACHE = { serverId: "server-01", dir: "/public/agent-hub/cli-cache", hub: true, isAdmin: false, sshUser: "alice", entries: { codex: [], claude: [] }, best: { codex: null, claude: null }, error: null };
const isCacheUrl = (url) => String(url).startsWith("/api/cli/team-cache");
const notCache = (calls) => calls.filter((c) => !isCacheUrl(c[0]));
const RUNNING = {
  jobId: "cli-1", status: "running", label: "Codex", action: "update", path: "official", phaseText: "集群上运行官方安装器（经隧道下载）",
  progress: { bytes: 50 * 1024 * 1024, total: 160 * 1024 * 1024, percent: 31, speedBps: 114 * 1024, etaSec: 990 },
  warnings: ["检测到 npm 全局安装的 codex：/x"], events: [{ at: 1, text: "已在集群上后台启动官方安装器" }], updatedAt: 10,
};

test("describeCliState / cliActions：版本、安装方式、可更新；未装给安装、可更新给更新、npm 版不给回滚", () => {
  assert.equal(describeCliState(OVERVIEW.clis.codex), "v0.159.2 · 官方独立安装 · 可更新到 0.160.1");
  assert.equal(describeCliState(OVERVIEW.clis.claude), "未安装");
  // 装在只有交互 shell 才看得到的位置：说出装在哪，不说「未安装」；动作仍是「安装」（装官方版到 ~/.local/bin）
  const offPath = cliState({ installed: false, version: null, kind: null, updateAvailable: false, offPath: "~/.nvm/versions/node/v22.11.0/bin/codex" });
  assert.equal(describeCliState(offPath), "已装在 ~/.nvm/versions/node/v22.11.0/bin/codex，但非交互 SSH 的 PATH 里找不到（可在这里安装官方版）");
  assert.deepEqual(cliActions(offPath), ["install"]);
  assert.equal(describeCliState(cliState({ version: "0.160.1", updateAvailable: false })), "v0.160.1 · 官方独立安装 · 已是最新");
  assert.equal(describeCliState(cliState({ installed: null, latest: null, latestError: "ENOTFOUND", updateAvailable: false })), "安装状态未知 · 最新版本暂时查不到");
  assert.deepEqual(cliActions(OVERVIEW.clis.codex), ["update", "rollback"]);
  assert.deepEqual(cliActions(OVERVIEW.clis.claude), ["install"]);
  assert.deepEqual(cliActions(cliState({ kind: "npm", updateAvailable: false })), []);
  assert.deepEqual(cliActions(cliState({ installed: null })), ["install"]);
});

test("formatEta / confirmText：剩余时间人话；确认文案说清走哪条路、多大、可回滚", () => {
  assert.equal(formatEta(30), "不到 1 分钟");
  assert.equal(formatEta(990), "约 17 分钟");
  assert.equal(formatEta(3900), "约 1 小时 5 分");
  assert.equal(formatEta(null), "");
  assert.match(confirmText("claude", "install", OVERVIEW.clis.claude), /安装 2\.1\.292（约 250MB.*自动改为本机下载.*可回滚/);
  assert.match(confirmText("codex", "rollback", OVERVIEW.clis.codex), /切回上一个保留的版本.*自动更新/);
});

test("buildJobHtml：进度条 / 字节 / 速度 / 剩余时间 / 提醒；失败显示原因与回退说明", () => {
  const html = buildJobHtml(RUNNING);
  assert.match(html, /aria-valuenow="31"><span style="transform:scaleX\(0\.31\)"><\/span>/);
  assert.match(html, /50 MiB \/ 160 MiB · 114 KiB\/s · 剩余约 17 分钟/);
  assert.doesNotMatch(html, /cli-job-path/, "首选路径的阶段文字已说明走法");
  assert.match(buildJobHtml({ ...RUNNING, path: "fallback", phaseText: "上传到集群" }), /上传到集群<small class="cli-job-path">本机下载后上传<\/small>/);
  assert.match(html, /class="is-warn">检测到 npm 全局安装/);
  const failed = buildJobHtml({ ...RUNNING, status: "failed", progress: null, fellBack: true, fallbackReason: "官方安装器退出码 22", error: "上传到集群失败" });
  assert.match(failed, /Codex 更新失败/);
  assert.match(failed, /首选路径没走通：官方安装器退出码 22/);
  assert.match(failed, /class="is-error">上传到集群失败/);
  assert.doesNotMatch(failed, /cli-progress/);
  assert.doesNotMatch(buildJobHtml({ ...RUNNING, label: "<b>" }), /<b>/);
});

test("buildCliHtml：行内确认带「直接用本机下载」；任务进行中或别的任务占用时按钮全禁用；非团队集群不显示", () => {
  const confirm = buildCliHtml(OVERVIEW, { confirm: { id: "claude", action: "install" } });
  assert.match(confirm, /data-cli-go="claude" data-cli-mode="auto">确认安装<\/button>/);
  assert.match(confirm, /data-cli-mode="local"/);
  assert.doesNotMatch(buildCliHtml(OVERVIEW, { confirm: { id: "codex", action: "rollback" } }), /data-cli-mode="local"/, "回滚没有本机下载选项");
  const running = buildCliHtml(OVERVIEW, { job: RUNNING });
  assert.ok((running.match(/data-cli-action="[a-z]+" data-cli-id="[a-z]+" disabled/g) || []).length === 3);
  assert.match(buildCliHtml({ ...OVERVIEW, busy: { kind: "login", cli: "codex" } }), /正在进行登录/);
  // 「撤销接入」（配置 → 接入引导下面）执行期间也占着这把任务锁
  assert.match(buildCliHtml({ ...OVERVIEW, busy: { kind: "undo", cli: null } }), /这台服务器上正在进行撤销接入，结束后才能再操作。/);
  assert.match(buildCliHtml({ ...OVERVIEW, busy: { kind: "rollback", cli: "codex" } }), /正在进行回滚/);
  assert.match(buildCliHtml({ ...OVERVIEW, busy: { kind: "install", cli: "codex" } }), /正在进行安装/);
  assert.match(buildCliHtml({ eligible: false }), /只支持团队集群/);
  assert.match(buildCliHtml(null, { error: "HTTP 503" }), /读取失败：HTTP 503/);
});

test("密码连接的服务器（概览带 fallbackUnavailable）：确认里不给「直接用本机下载」，文案不再承诺自动回退", () => {
  const overview = { ...OVERVIEW, fallbackUnavailable: "这台服务器用密码连接，本机下载后上传只支持密钥登录" };
  const html = buildCliHtml(overview, { confirm: { id: "claude", action: "install" } });
  assert.match(html, /data-cli-go="claude" data-cli-mode="auto">确认安装<\/button>/, "官方路径照常可用");
  assert.doesNotMatch(html, /data-cli-mode="local"/);
  assert.match(html, /这台服务器用密码连接，本机下载后上传只支持密钥登录/);
  assert.doesNotMatch(html, /会自动改为本机下载/);
  assert.match(html, /旧版本保留，可回滚/);
  assert.match(confirmText("codex", "rollback", OVERVIEW.clis.codex, { fallbackUnavailable: overview.fallbackUnavailable }), /切回上一个保留的版本/, "回滚不涉及上传，文案不变");
});

function setup({ getJson, postJson, onCliChanged } = {}) {
  const dlg = fakeDialog();
  dlg.open = true;
  const body = fakeElement();
  const timers = fakeTimers();
  const deps = {
    doc: fakeDocument({ dlgSettings: dlg, settingsCliBody: body }),
    getJson: getJson || spy(async (url) => structuredClone(isCacheUrl(url) ? NO_CACHE : OVERVIEW)),
    postJson: postJson || spy(async () => ({ jobId: "cli-1", job: structuredClone(RUNNING) })),
    ...(onCliChanged ? { onCliChanged } : {}),
    showToast: spy(),
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
    notifiedJobs: new Set(),
  };
  const ctl = createSettingsCli(deps);
  const click = (dataset) => body.dispatch("click", { target: fakeElement({ tag: "button", dataset, parent: body }) });
  return { ctl, deps, body, dlg, timers, click };
}

test("控制器：打开读 /api/cli → 点「更新」先行内确认 → 确认后 POST install（带 serverId / mode）并开始轮询进度", async () => {
  const ctx = setup();
  await ctx.ctl.onOpen();
  assert.deepEqual(notCache(ctx.deps.getJson.calls), [["/api/cli"]]);
  assert.ok(ctx.deps.getJson.calls.some((c) => c[0] === "/api/cli/team-cache"), "团队缓存与概览并行取");
  assert.match(ctx.body.innerHTML, /可更新到 0\.160\.1/);
  await ctx.click({ cliAction: "update", cliId: "codex" });
  assert.match(ctx.body.innerHTML, /确认更新到 0\.160\.1/);
  assert.equal(ctx.deps.postJson.calls.length, 0, "只是展开确认");
  await ctx.click({ cliGo: "codex", cliMode: "auto" });
  assert.deepEqual(ctx.deps.postJson.calls, [["/api/cli/codex/install", { serverId: "server-01", mode: "auto" }]]);
  assert.match(ctx.body.innerHTML, /cli-progress/);
  assert.equal(ctx.timers.timeouts.size, 1, "开始轮询");
});

test("控制器：轮询到结束 → toast + 重读概览；关掉浮层后放慢接着盯，结束照样提示", async () => {
  const done = { ...RUNNING, status: "succeeded", installedVersion: "0.160.1", progress: null, updatedAt: 20 };
  let n = 0;
  const getJson = spy(async (url) => {
    if (url === "/api/cli") return { ...structuredClone(OVERVIEW), job: n++ === 0 ? structuredClone(RUNNING) : done };
    return done;
  });
  const ctx = setup({ getJson });
  await ctx.ctl.onOpen();
  assert.equal(ctx.timers.timeouts.size, 1, "后端记着的进行中任务：打开即接着轮询");
  ctx.timers.runTimeouts();
  await flush();
  await flush();
  assert.deepEqual(notCache(getJson.calls).map((c) => c[0]), ["/api/cli", "/api/cli/jobs/cli-1", "/api/cli"]);
  assert.ok(getJson.calls.some((c) => c[0] === "/api/cli/team-cache?force=1"), "任务结束后强制重读团队缓存");
  assert.match(ctx.deps.showToast.calls[0][0].message, /Codex 0\.160\.1 已就绪/);
  assert.match(ctx.body.innerHTML, /0\.160\.1 已就绪/);
  assert.equal(ctx.timers.timeouts.size, 0, "结束后不再轮询");

  // 另一个任务：装到一半把浮层关了。
  const running2 = { ...structuredClone(RUNNING), jobId: "cli-2" };
  const done2 = { ...running2, status: "failed", error: "下载中断", progress: null, updatedAt: 30 };
  let finished = false;
  const changed = spy();
  const again = setup({
    onCliChanged: changed,
    getJson: spy(async (url) => (url === "/api/cli" ? { ...structuredClone(OVERVIEW), job: structuredClone(finished ? done2 : running2) } : structuredClone(finished ? done2 : running2))),
  });
  await again.ctl.onOpen();
  assert.equal(again.timers.timeouts.size, 1);
  again.dlg.close();
  await flush();
  assert.equal(again.timers.timeouts.size, 1, "任务还在跑：关掉浮层不停表");
  assert.deepEqual([...again.timers.timeouts.values()].map((t) => t.ms), [CLI_JOB_POLL_CLOSED_MS], "换成慢速");
  again.timers.runTimeouts();
  await flush();
  assert.equal(again.deps.showToast.calls.length, 0, "还没结束");
  assert.equal(again.timers.timeouts.size, 1);
  finished = true;
  again.timers.runTimeouts();
  await flush();
  await flush();
  assert.equal(again.deps.showToast.calls.length, 1, "浮层关着也要告诉人结果");
  assert.deepEqual([again.deps.showToast.calls[0][0].type, again.deps.showToast.calls[0][0].message], ["error", "下载中断"]);
  assert.equal(changed.calls.length, 1, "Agent 卡片随之刷新");
  assert.equal(again.timers.timeouts.size, 0, "结束后停表");

  // 没有任务时关掉浮层：停表。
  const idle = setup();
  await idle.ctl.onOpen();
  idle.dlg.close();
  await flush();
  assert.equal(idle.timers.timeouts.size, 0);
});

test("控制器：两次轮询之间任务结束、由重读概览先看到 → 同样提示一次（刷新页面后回来不会漏掉结果）", async () => {
  const running3 = { ...structuredClone(RUNNING), jobId: "cli-3" };
  const done3 = { ...running3, status: "succeeded", installedVersion: "0.160.1", progress: null, updatedAt: 40 };
  let finished = false;
  const ctx = setup({ getJson: spy(async (url) => (url === "/api/cli" ? { ...structuredClone(OVERVIEW), job: structuredClone(finished ? done3 : running3) } : structuredClone(running3))) });
  await ctx.ctl.onOpen();
  finished = true;
  await ctx.ctl.load();
  await ctx.ctl.load();
  assert.equal(ctx.deps.showToast.calls.length, 1);
  assert.match(ctx.deps.showToast.calls[0][0].message, /已就绪/);
});

test("控制器：回滚确认后 POST rollback，按结果提示；提交失败给错误 toast", async () => {
  const postJson = spy(async (url) => (url.endsWith("/rollback") ? { ok: true, to: "0.158.0-x86_64-unknown-linux-musl" } : Promise.reject(Object.assign(new Error("HTTP 409"), { serverMessage: "这台服务器上正在进行登录" }))));
  const ctx = setup({ postJson });
  await ctx.ctl.onOpen();
  await ctx.click({ cliAction: "rollback", cliId: "codex" });
  await ctx.click({ cliGo: "codex", cliMode: "auto" });
  assert.deepEqual(postJson.calls[0], ["/api/cli/codex/rollback", { serverId: "server-01" }]);
  assert.match(ctx.deps.showToast.calls[0][0].message, /已切回 0\.158\.0/);
  await ctx.click({ cliAction: "install", cliId: "claude" });
  await ctx.click({ cliGo: "claude", cliMode: "local" });
  assert.deepEqual(postJson.calls[1], ["/api/cli/claude/install", { serverId: "server-01", mode: "local" }]);
  assert.equal(ctx.deps.showToast.calls[1][0].type, "error");
  assert.match(ctx.deps.showToast.calls[1][0].message, /正在进行登录/);
});

// ---- v2.57 后续：取消安装 / 更新任务 ----

const CANCELLED = {
  ...RUNNING, status: "cancelled", cancelling: false, cancellable: false, progress: null, phaseText: "已取消", updatedAt: 30,
  events: [{ at: 2, text: "已取消：集群上的官方安装器已停止。集群上现有的安装没有动。" }],
};

test("buildJobHtml：进行中给「取消」；确认态两步式；临界阶段禁用并说明；取消中不再给按钮；已取消用中性呈现", () => {
  assert.match(buildJobHtml(RUNNING), /<button type="button" class="text-btn" data-cli-job-cancel>取消<\/button>/);
  const confirming = buildJobHtml(RUNNING, { cancelConfirm: true });
  assert.match(confirming, /取消这次更新？.*集群上现有的版本不受影响/);
  assert.match(confirming, /data-cli-job-cancel-go>确认取消<\/button>/);
  assert.match(confirming, /data-cli-job-cancel-no>继续更新<\/button>/);
  assert.doesNotMatch(confirming, /data-cli-job-cancel>/, "确认态下不再有第一步的按钮");

  // 落盘 / 切软链：不可取消，按钮禁用并说明；哪怕正开着确认也收回去。
  const critical = { ...RUNNING, phase: "activate", phaseText: "集群上解包、冒烟并切换", cancellable: false };
  assert.match(buildJobHtml(critical), /data-cli-job-cancel disabled title="[^"]*不能中途取消[^"]*">取消<\/button>/);
  assert.doesNotMatch(buildJobHtml(critical, { cancelConfirm: true }), /data-cli-job-cancel-go/);

  for (const html of [buildJobHtml({ ...RUNNING, cancelling: true, phaseText: "正在取消" }), buildJobHtml(RUNNING, { cancelPending: true })]) {
    assert.match(html, /Codex：正在取消/);
    assert.doesNotMatch(html, /data-cli-job-cancel|cli-progress/);
  }

  const cancelled = buildJobHtml(CANCELLED);
  assert.match(cancelled, /class="cli-job is-cancelled"/);
  assert.match(cancelled, /Codex 更新已取消/);
  assert.match(cancelled, /<li>已取消：集群上的官方安装器已停止。集群上现有的安装没有动。<\/li>/);
  assert.doesNotMatch(cancelled, /cli-progress|data-cli-job-cancel|is-error|失败/);
  assert.match(buildJobHtml({ ...CANCELLED, action: "install", warnings: ["没能连上集群清理半截上传文件"] }), /Codex 安装已取消[\s\S]*class="is-warn">没能连上集群清理半截上传文件/);
  // 成功 / 失败的任务不给取消。
  assert.doesNotMatch(buildJobHtml({ ...RUNNING, status: "failed", error: "x" }), /data-cli-job-cancel/);
});

test("控制器：点「取消」先确认一次（可反悔）→ 确认后 POST /api/cli/jobs/:id/cancel → 显示已取消、提示一次、重读概览、按钮恢复可用", async () => {
  let cancelled = false;
  const getJson = spy(async (url) => (url === "/api/cli"
    ? { ...structuredClone(OVERVIEW), job: structuredClone(cancelled ? CANCELLED : RUNNING) }
    : structuredClone(cancelled ? CANCELLED : RUNNING)));
  const postJson = spy(async () => {
    cancelled = true;
    return { job: structuredClone(CANCELLED) };
  });
  const onCliChanged = spy();
  const ctx = setup({ getJson, postJson, onCliChanged });
  await ctx.ctl.onOpen();
  assert.match(ctx.body.innerHTML, /data-cli-job-cancel>取消</);

  await ctx.click({ cliJobCancel: "" });
  assert.match(ctx.body.innerHTML, /确认取消/);
  assert.equal(postJson.calls.length, 0, "只是展开确认");
  await ctx.click({ cliJobCancelNo: "" });
  assert.doesNotMatch(ctx.body.innerHTML, /确认取消/);
  assert.equal(postJson.calls.length, 0, "反悔：什么都没发");

  await ctx.click({ cliJobCancel: "" });
  await ctx.click({ cliJobCancelGo: "" });
  assert.deepEqual(postJson.calls, [["/api/cli/jobs/cli-1/cancel", {}]]);
  assert.match(ctx.body.innerHTML, /Codex 更新已取消/);
  assert.deepEqual(ctx.deps.showToast.calls.map((c) => [c[0].type, c[0].message]), [["info", "Codex 更新已取消。"]]);
  assert.equal(onCliChanged.calls.length, 1, "通知 Agent 卡片重读");
  assert.equal(getJson.calls.at(-1)[0], "/api/cli", "重读概览");
  assert.equal(ctx.timers.timeouts.size, 0, "任务结束，不再轮询");
  assert.match(ctx.body.innerHTML, /data-cli-action="update" data-cli-id="codex">/, "动作按钮恢复可用，可以马上再装");
});

test("控制器：取消被拒（临界阶段 409）→ 提示原因，任务照常显示并继续轮询", async () => {
  const getJson = spy(async (url) => (url === "/api/cli" ? { ...structuredClone(OVERVIEW), job: structuredClone(RUNNING) } : structuredClone(RUNNING)));
  const postJson = spy(async () => Promise.reject(Object.assign(new Error("HTTP 409"), { serverMessage: "集群上正在解包、冒烟并切换版本（已经在改正式目录），这一步不能中途取消" })));
  const ctx = setup({ getJson, postJson });
  await ctx.ctl.onOpen();
  await ctx.click({ cliJobCancel: "" });
  await ctx.click({ cliJobCancelGo: "" });
  assert.deepEqual(ctx.deps.showToast.calls.map((c) => [c[0].type, c[0].title]), [["warn", "没有取消"]]);
  assert.match(ctx.deps.showToast.calls[0][0].message, /不能中途取消/);
  assert.equal(ctx.ctl.getState().job.status, "running");
  assert.match(ctx.body.innerHTML, /cli-progress/);
  assert.equal(ctx.timers.timeouts.size, 1, "继续轮询");
});

test("控制器：取消接口返回时收尾还没做完（cancelling）→ 显示正在取消并接着轮询；轮询与取消接口先后看到结束也只提示一次", async () => {
  // 一：接口先返回「正在取消」，轮询再看到已取消。
  let done = false;
  const getJson = spy(async (url) => (url === "/api/cli"
    ? { ...structuredClone(OVERVIEW), job: structuredClone(done ? CANCELLED : RUNNING) }
    : structuredClone(done ? CANCELLED : { ...RUNNING, cancelling: true, phaseText: "正在取消", updatedAt: 20 })));
  const ctx = setup({ getJson, postJson: spy(async () => ({ job: { ...structuredClone(RUNNING), cancelling: true, phaseText: "正在取消", updatedAt: 20 } })) });
  await ctx.ctl.onOpen();
  await ctx.click({ cliJobCancel: "" });
  await ctx.click({ cliJobCancelGo: "" });
  assert.match(ctx.body.innerHTML, /Codex：正在取消/);
  assert.doesNotMatch(ctx.body.innerHTML, /data-cli-job-cancel/);
  assert.equal(ctx.deps.showToast.calls.length, 0);
  assert.equal(ctx.timers.timeouts.size, 1);
  done = true;
  ctx.timers.runTimeouts();
  await flush();
  await flush();
  assert.match(ctx.body.innerHTML, /Codex 更新已取消/);
  assert.equal(ctx.deps.showToast.calls.length, 1);

  // 二：取消接口还在等收尾，轮询先看到已取消；接口随后返回同一个结束状态。
  let finished = false;
  let reply;
  const getJson2 = spy(async (url) => (url === "/api/cli"
    ? { ...structuredClone(OVERVIEW), job: structuredClone(finished ? CANCELLED : RUNNING) }
    : structuredClone(finished ? CANCELLED : RUNNING)));
  const postJson2 = spy(() => new Promise((resolve) => {
    reply = resolve;
  }));
  const race = setup({ getJson: getJson2, postJson: postJson2 });
  await race.ctl.onOpen();
  await race.click({ cliJobCancel: "" });
  const clicking = race.click({ cliJobCancelGo: "" });
  await flush();
  assert.match(race.body.innerHTML, /Codex：正在取消/, "请求在途：立刻显示正在取消");
  finished = true;
  await race.ctl.poll();
  assert.equal(race.deps.showToast.calls.length, 1);
  reply({ job: structuredClone(CANCELLED) });
  await clicking;
  await flush();
  assert.equal(race.deps.showToast.calls.length, 1, "同一个任务的结束只提示一次");
  assert.match(race.body.innerHTML, /Codex 更新已取消/);
});

test("openFor（Agent 卡片直达）：打开配置浮层、展开本节并直接进入同一个确认；动作已不适用时不弹过时确认", async () => {
  const dlg = fakeDialog();
  const body = fakeElement();
  const section = fakeElement({ tag: "details" });
  let overview = structuredClone(OVERVIEW);
  const getJson = spy(async () => structuredClone(overview));
  const onCliChanged = spy();
  const doc = fakeDocument({ dlgSettings: dlg, settingsCliBody: body, settingsCli: section });
  let ctl = null;
  // 与 app.js 一样：openDialog 打开浮层并触发 onOpen 钩子（load）。
  const openDialog = spy((id) => {
    doc.getElementById(id).showModal();
    ctl.onOpen();
  });
  ctl = createSettingsCli({ doc, getJson, postJson: spy(), showToast: spy(), openDialog, onCliChanged });
  await ctl.openFor({ cli: "codex", action: "update" });
  await flush();
  assert.deepEqual(openDialog.calls, [["dlgSettings"]]);
  assert.equal(section.open, true, "展开「命令行工具」一节");
  assert.match(body.innerHTML, /确认更新到 0\.160\.1/, "直接是更新确认，和设置页里点「更新」同一个");

  // 浮层已开着：原地刷新，不再 showModal；Claude 没装 → 安装确认
  await ctl.openFor({ cli: "claude", action: "install" });
  await flush();
  assert.equal(openDialog.calls.length, 1);
  assert.match(body.innerHTML, /data-cli-go="claude" data-cli-mode="auto">确认安装</);

  // 现状已不需要更新（别处刚更新完）：不显示过时的确认
  overview = { ...structuredClone(OVERVIEW), clis: { ...structuredClone(OVERVIEW.clis), codex: cliState({ version: "0.160.1", updateAvailable: false }) } };
  await ctl.openFor({ cli: "codex", action: "update" });
  await flush();
  assert.doesNotMatch(body.innerHTML, /确认更新/);
  assert.equal(ctl.getState().confirm, null);
  assert.equal(ctl.openFor({ cli: "reclaude" }), null, "未知 CLI 忽略");
});

test("团队缓存：首次安装有缓存就用、更新只在缓存正好是最新版时用；确认文案说清集群内拷贝", () => {
  const cache = { ...NO_CACHE, best: { codex: "0.160.1", claude: "2.1.290" } };
  assert.equal(cacheVersionFor("claude", "install", OVERVIEW.clis.claude, cache), "2.1.290");
  assert.equal(cacheVersionFor("codex", "update", OVERVIEW.clis.codex, cache), "0.160.1");
  assert.equal(cacheVersionFor("codex", "update", OVERVIEW.clis.codex, { ...cache, best: { codex: "0.159.9" } }), null);
  assert.equal(cacheVersionFor("codex", "rollback", OVERVIEW.clis.codex, cache), null);
  assert.equal(cacheVersionFor("claude", "install", OVERVIEW.clis.claude, NO_CACHE), null);
  const text = confirmText("claude", "install", OVERVIEW.clis.claude, { cacheVersion: "2.1.290" });
  assert.match(text, /团队缓存里有 Claude Code 2\.1\.290（最新版是 2\.1\.292，装好后可以再点更新）：将在集群内直接拷贝/);
  assert.match(buildCliHtml(OVERVIEW, { confirm: { id: "claude", action: "install" }, teamCache: cache }), /团队缓存里有 Claude Code 2\.1\.290/);
});

test("团队缓存一行：有缓存 / 没缓存 / 管理员发布按钮（已是最新的禁用）/ 共享目录还没建", () => {
  assert.equal(buildTeamCacheHtml(null, OVERVIEW), "");
  assert.equal(buildTeamCacheHtml({ ...NO_CACHE, serverId: "other" }, OVERVIEW), "", "别的服务器的结果不显示");
  assert.match(buildTeamCacheHtml(NO_CACHE, OVERVIEW), /还没有安装包.*请管理员先把安装包发布/s);
  const cache = { ...NO_CACHE, best: { codex: "0.160.1", claude: null } };
  assert.match(buildTeamCacheHtml(cache, OVERVIEW), /团队缓存里有 Codex 0\.160\.1：安装时直接在集群内拷贝/);
  assert.doesNotMatch(buildTeamCacheHtml(cache, OVERVIEW), /data-cli-action="publish"/, "非管理员没有发布按钮");
  const admin = buildTeamCacheHtml({ ...cache, isAdmin: true }, OVERVIEW);
  assert.match(admin, /data-cli-action="publish" data-cli-id="codex" disabled>Codex 已是最新/);
  assert.match(admin, /data-cli-action="publish" data-cli-id="claude">发布 Claude Code 2\.1\.292/);
  assert.match(buildTeamCacheHtml({ ...NO_CACHE, isAdmin: true, hub: false }, OVERVIEW), /还没有团队共享目录/);
  assert.match(confirmText("claude", "publish", OVERVIEW.clis.claude, { cacheDir: "/public/agent-hub/cli-cache" }), /上传到集群团队缓存 \/public\/agent-hub\/cli-cache/);
});

test("控制器：管理员点「发布」→ 行内确认（没有本机下载选项）→ POST publish；发布任务的结束提示", async () => {
  const getJson = spy(async (url) => structuredClone(isCacheUrl(url) ? { ...NO_CACHE, isAdmin: true } : OVERVIEW));
  const ctx = setup({ getJson });
  await ctx.ctl.onOpen();
  await flush();
  assert.match(ctx.body.innerHTML, /data-cli-action="publish" data-cli-id="claude"/);
  await ctx.click({ cliAction: "publish", cliId: "claude" });
  assert.match(ctx.body.innerHTML, /确认发布到团队缓存/);
  assert.doesNotMatch(ctx.body.innerHTML, /data-cli-mode="local"/);
  await ctx.click({ cliGo: "claude", cliMode: "auto" });
  assert.deepEqual(ctx.deps.postJson.calls, [["/api/cli/claude/publish", { serverId: "server-01" }]]);
  const html = buildJobHtml({ ...RUNNING, action: "publish", status: "succeeded", installedVersion: "2.1.292", label: "Claude Code", path: "publish" });
  assert.match(html, /Claude Code 2\.1\.292 已在团队缓存/);
});
