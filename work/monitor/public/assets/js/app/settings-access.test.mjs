import assert from "node:assert/strict";
import test from "node:test";

import { ACCESS_POLL_MS, buildAccessHtml, buildJobHtml, buildPortsHtml, buildPreviewHtml, createSettingsAccess, describePort } from "./settings-access.js";
import { deferred, fakeDialog, fakeDocument, fakeElement, fakeTimers, flush, spy } from "./test-support.mjs";

const row = (port, patch = {}) => ({ port, current: false, listening: false, releasable: false, ...patch });
const REGISTRY = {
  state: "ok", dir: "/public/agent-hub/ports", me: "amy", error: null, checkedAt: 1, pending: false,
  ports: [row(7892, { current: true, listening: true }), row(7893, { listening: true }), row(7895, { releasable: true })],
  current: { port: 7892, owner: "me", name: "amy" },
};
const VIEW = { available: true, reason: null, simulated: false, server: { id: "server-01", name: "主集群", host: "myserver" }, port: 7892, registry: REGISTRY, busy: null, undo: null };
const view = (patch = {}) => ({ ...structuredClone(VIEW), ...patch });
const withRegistry = (patch) => view({ registry: { ...structuredClone(REGISTRY), ...patch } });

const PREVIEW = {
  previewId: "p1", serverId: "server-01", host: "myserver", port: 7892, nothingToUndo: false, notes: [],
  steps: [
    { id: "strip-source-blocks", title: "删除 shell 启动文件里引入代理配置的那几行", effect: "change", items: ["~/.bashrc", "~/.bash_profile"], note: "" },
    { id: "restore-strays", title: "恢复接入时被注释掉的旧代理设置", effect: "none", items: [], note: "没有发现，这一步不会改动任何东西" },
  ],
  release: { port: 7892, available: true, owner: "me", note: "登记在你名下。释放后别人可以领走它，这台电脑上的隧道随之停止。" },
  consequences: {
    keep: "撤销后，集群上新开的终端回到接入之前的样子；已经在运行的不受影响。端口 7892 的登记和这台电脑上的隧道保留。",
    release: "撤销后这台电脑不再为集群上的 codex / claude 提供出网，已经在运行的会断网。",
  },
};

const step = (id, status, patch = {}) => ({ id, title: `步骤 ${id}`, status, detail: "", manual: "", ...patch });
const JOB = { id: "j1", serverId: "server-01", host: "myserver", port: 7892, releasePort: true, status: "running", summary: "", leftovers: [], steps: [step("strip-source-blocks", "ok"), step("remove-env", "running"), step("release-port", "pending")] };
const DONE = { ...JOB, status: "ok", summary: "集群上的代理配置已撤销。端口 7892 已从这台电脑的配置里拿掉，隧道会在几秒内停止。", leftovers: ["集群上的公钥：ssh myserver 'grep -n \"\" ~/.ssh/authorized_keys'", "本机：config.local.json"], steps: [step("strip-source-blocks", "ok"), step("remove-env", "ok"), step("release-port", "ok", { detail: "登记已删除" })] };
const FAILED = {
  ...JOB, status: "failed", summary: "停在「步骤 remove-env」这一步，后面的没有执行。",
  steps: [step("strip-source-blocks", "ok"), step("remove-env", "failed", { detail: "连接服务器超时", manual: "sh -c 'rm -f ~/.config/cluster-workbench/env.sh'" }), step("release-port", "not-run")],
};

// ---- 纯函数 ----

test("describePort：这台电脑在用的 / 正在被监听的 / 闲置的", () => {
  assert.equal(describePort(row(7892, { current: true, listening: true })), "这台电脑在用");
  assert.equal(describePort(row(7892, { current: true })), "这台电脑在用");
  assert.equal(describePort(row(7893, { listening: true })), "正在被监听，可能是你另一台电脑在用");
  assert.equal(describePort(row(7895)), "闲置");
});

test("buildPortsHtml：一行一个端口；只有闲置的才有「释放」；说明登记在谁名下", () => {
  const html = buildPortsHtml(VIEW);
  assert.equal((html.match(/class="acc-row"/g) || []).length, 3);
  assert.deepEqual([...html.matchAll(/data-acc-release="(\d+)"/g)].map((m) => m[1]), ["7895"], "在用的、被监听的都没有释放按钮");
  assert.match(html, /<strong class="acc-port">7892<\/strong><small class="acc-state">这台电脑在用<\/small>/);
  assert.match(html, /登记在 amy 名下。闲置的端口可以释放给别人用；在用的随「撤销接入」一起释放。/);
  assert.match(html, /<p class="acc-title">端口登记<\/p>/);
  assert.doesNotMatch(html, /acc-note/);
  // 有动作在做时释放按钮按住
  assert.match(buildPortsHtml(VIEW, { locked: true }), /data-acc-release="7895" disabled/);
});

test("buildPortsHtml：行内确认写明后果；请求发出后按钮按住", () => {
  const confirm = buildPortsHtml(VIEW, { confirmPort: 7895 });
  assert.match(confirm, /<p>释放后端口 7895 的登记会删除，别人可以领用它。这台电脑不受影响。如果你的另一台电脑还配着这个端口（只是现在没连上），先别释放。<\/p>/);
  assert.match(confirm, /data-acc-release-go="7895">确认释放<\/button>/);
  assert.match(confirm, /data-acc-release-cancel>取消<\/button>/);
  assert.doesNotMatch(confirm, /data-acc-release="7895"/, "确认展开时不再有那枚「释放」");
  // 团队最早的生产端口放掉就拿不回来：确认里换一句说法
  const base = buildPortsHtml(withRegistry({ ports: [row(7891, { releasable: true, base: true })], current: null }), { confirmPort: 7891 });
  assert.match(base, /<p>7891 是团队最早的生产端口：释放后登记会删除，工作台不会再把它分给任何人（包括你）。如果你的另一台电脑还配着这个端口（只是现在没连上），先别释放。<\/p>/);
  assert.doesNotMatch(base, /别人可以领用它/);
  const sending = buildPortsHtml(VIEW, { confirmPort: 7895, releasing: 7895 });
  assert.match(sending, /data-acc-release-go="7895" disabled>正在释放…<\/button>/);
  assert.match(sending, /data-acc-release-cancel disabled/);
});

test("buildPortsHtml：没读到 / 正在读 / 登记目录没建 / 在用的端口不在自己名下，各说各的；没有内容时整段不出", () => {
  const failed = buildPortsHtml(withRegistry({ state: "unknown", ports: [], current: null, me: "", error: { code: "timeout", message: "连接服务器超时，当前网络可能不在集群的 SSH 白名单内" } }));
  assert.match(failed, /读不到集群上的端口登记：连接服务器超时，当前网络可能不在集群的 SSH 白名单内。<button type="button" class="text-btn" data-acc-retry>重试<\/button>/);
  assert.doesNotMatch(failed, /acc-list/);
  assert.match(buildPortsHtml(withRegistry({ state: "unknown", ports: [], current: null, error: { message: "x" }, pending: true })), /data-acc-retry disabled/, "正在重读时重试按钮按住");
  assert.match(buildPortsHtml(withRegistry({ state: "unknown", ports: [], current: null, error: { message: "x" } }), { locked: true }), /data-acc-retry disabled/, "有动作在做时也按住");

  const loading = buildPortsHtml(withRegistry({ state: "unknown", ports: [], current: null, me: "", checkedAt: null, pending: true }));
  assert.match(loading, /正在读取集群上的端口登记…/);
  assert.equal(buildPortsHtml(withRegistry({ state: "unknown", ports: [], current: null, me: "", checkedAt: null, pending: false })), "", "还没开始读：不占地方");

  const absent = buildPortsHtml(withRegistry({ state: "absent", ports: [], current: { port: 7892, owner: "none", name: "" } }));
  assert.match(absent, /集群上没有可用的端口登记目录，这台电脑在用的端口 7892 没有登记。/);

  const other = buildPortsHtml(withRegistry({ ports: [row(7895, { releasable: true })], current: { port: 7892, owner: "other", name: "simple" } }));
  assert.match(other, /这台电脑在用的端口 7892 登记在 simple 名下。/);
  assert.match(buildPortsHtml(withRegistry({ ports: [], current: { port: 7892, owner: "none", name: "" } })), /这台电脑在用的端口 7892 没有登记。/);

  // 登记目录在、名下一个端口都没有、这台电脑也没有端口：没什么可说的
  assert.equal(buildPortsHtml(view({ port: null, registry: { ...structuredClone(REGISTRY), ports: [], current: null } })), "");
  assert.equal(buildPortsHtml(view({ registry: null })), "");
});

test("buildPreviewHtml：逐条列出会改什么；不会改动的标出来；后果说明与按钮上的字随勾选变", () => {
  const keep = buildPreviewHtml(PREVIEW);
  assert.match(keep, /会在 myserver 上做下面这些事。你自己的文件（启动文件、settings\.json）改之前先留一份备份：/);
  assert.match(keep, /<span class="acc-plan-title">删除 shell 启动文件里引入代理配置的那几行<\/span>\s*<span class="acc-plan-detail">~\/\.bashrc；~\/\.bash_profile<\/span>/);
  assert.match(keep, /class="acc-plan-item is-none">\s*<span class="acc-plan-title">恢复接入时被注释掉的旧代理设置<\/span>\s*<span class="acc-plan-detail">没有发现，这一步不会改动任何东西<\/span>/);
  assert.match(keep, /<input type="checkbox" data-acc-release-toggle>同时释放端口 7892<\/label>/, "默认不勾");
  assert.match(keep, /登记在你名下。释放后别人可以领走它/);
  assert.match(keep, /<p class="acc-consequence">撤销后，集群上新开的终端回到接入之前的样子/);
  assert.match(keep, /class="btn btn-danger" data-acc-undo-go>确认撤销<\/button>/);
  assert.doesNotMatch(keep, /会断网/);

  const release = buildPreviewHtml(PREVIEW, { release: true });
  assert.match(release, /data-acc-release-toggle checked>/);
  assert.match(release, /<p class="acc-consequence">撤销后这台电脑不再为集群上的 codex \/ claude 提供出网，已经在运行的会断网。<\/p>/);
  assert.match(release, /data-acc-undo-go>确认撤销并释放端口<\/button>/);

  const sending = buildPreviewHtml(PREVIEW, { release: true, submitting: true });
  assert.match(sending, /data-acc-undo-go disabled>正在开始…/);
  assert.match(sending, /data-acc-release-toggle checked disabled>/);
  assert.match(sending, /data-acc-undo-cancel disabled/);
});

test("buildPreviewHtml：不能释放时不给勾选（说明原因，后果按保留的说）；没有端口时没有这一段；没什么可撤销时不给确认", () => {
  const blocked = buildPreviewHtml({ ...PREVIEW, release: { port: 7892, available: false, owner: "unknown", note: "端口 7892 写在团队配置里，不是这台电脑的个人配置领的，不能在这里释放。" } }, { release: true });
  assert.doesNotMatch(blocked, /data-acc-release-toggle/);
  assert.match(blocked, /写在团队配置里/);
  assert.match(blocked, /data-acc-undo-go>确认撤销<\/button>/, "勾选状态残留也不会变成释放");
  assert.doesNotMatch(blocked, /会断网/);

  const noPort = buildPreviewHtml({ ...PREVIEW, port: null, release: null, consequences: { keep: "撤销后，集群上新开的终端回到接入之前的样子。", release: null }, notes: ["这台电脑没有配置反向端口，~/.claude/settings.json 里的代理设置无从比对，不会自动删除，请自行检查。"] });
  assert.doesNotMatch(noPort, /acc-release/);
  assert.match(noPort, /<p class="acc-note">这台电脑没有配置反向端口/);

  const nothing = buildPreviewHtml({ ...PREVIEW, nothingToUndo: true, release: null });
  assert.match(nothing, /myserver 上没有发现工作台写下的配置，没有需要撤销的内容。/);
  assert.doesNotMatch(nothing, /data-acc-undo-go/);
  assert.match(nothing, /data-acc-undo-cancel>关闭<\/button>/);
});

test("buildJobHtml：进行中逐步显示；做完给总结与没有自动处理的内容；没做成标出停在哪、哪些没有执行", () => {
  const running = buildJobHtml(JOB);
  assert.match(running, /<p class="acc-panel-title">正在撤销接入…<\/p>/);
  assert.deepEqual([...running.matchAll(/class="acc-step is-([a-z-]+)"/g)].map((m) => m[1]), ["ok", "running", "pending"]);
  assert.deepEqual([...running.matchAll(/class="acc-step-state">([^<]*)</g)].map((m) => m[1]), ["完成", "进行中", "等待"]);
  assert.doesNotMatch(running, /data-acc-job-close|acc-leftovers|acc-summary/);

  const done = buildJobHtml(DONE);
  assert.match(done, /已撤销接入/);
  assert.match(done, /<span class="acc-step-detail">登记已删除<\/span>/);
  assert.match(done, /<p class="acc-summary">集群上的代理配置已撤销。端口 7892 已从这台电脑的配置里拿掉，隧道会在几秒内停止。<\/p>/);
  assert.match(done, /<summary>没有自动处理的内容（2 项），按需自查<\/summary>/);
  assert.match(done, /<li>集群上的公钥：ssh myserver &#039;grep -n &quot;&quot; ~\/\.ssh\/authorized_keys&#039;<\/li>/);
  assert.match(done, /data-acc-job-close>知道了<\/button>/);

  const failed = buildJobHtml(FAILED);
  assert.match(failed, /class="acc-panel is-failed"/);
  assert.match(failed, /撤销没有做完/);
  assert.deepEqual([...failed.matchAll(/class="acc-step-state">([^<]*)</g)].map((m) => m[1]), ["完成", "没有成功", "没有执行"]);
  assert.match(failed, /<span class="acc-step-detail">连接服务器超时<\/span>/);
  assert.match(failed, /可以在服务器上手动执行的命令<\/summary><pre class="ob-code"><code>sh -c &#039;rm -f ~\/\.config\/cluster-workbench\/env\.sh&#039;<\/code><\/pre>/);
  assert.match(failed, /data-acc-copy="remove-env">复制<\/button>/);
  assert.match(failed, /停在「步骤 remove-env」这一步，后面的没有执行。/);
  assert.doesNotMatch(failed, /acc-leftovers/);
});

test("buildAccessHtml：没接入过整块不出；平时是端口表 + 「撤销接入…」；流程中换成预览 / 进度，别的入口按住", () => {
  assert.equal(buildAccessHtml(null), "");
  assert.equal(buildAccessHtml({ available: false, reason: "not-connected" }), "");

  const idle = buildAccessHtml(VIEW);
  assert.match(idle, /data-acc-undo>撤销接入…<\/button>/);
  assert.match(idle, /删除工作台在集群上写下的代理配置。先列出会改什么，确认后才执行。/);
  assert.match(idle, /data-acc-release="7895">释放/);

  const previewing = buildAccessHtml(VIEW, { flow: { stage: "previewing" } });
  assert.match(previewing, /data-acc-undo disabled>正在查看集群上的配置…<\/button>/);
  assert.match(previewing, /data-acc-release="7895" disabled/);

  const confirming = buildAccessHtml(VIEW, { flow: { stage: "confirm", preview: PREVIEW, release: true } });
  assert.match(confirming, /确认撤销并释放端口/);
  assert.doesNotMatch(confirming, /data-acc-undo>/);

  // 进行中的撤销谁打开都看得到；已结束的只给发起它的这个页面看，「知道了」之后收起
  assert.match(buildAccessHtml(view({ undo: JOB, busy: { kind: "undo" } })), /正在撤销接入…/);
  assert.match(buildAccessHtml(view({ undo: DONE }), { jobId: "j1" }), /已撤销接入/);
  assert.match(buildAccessHtml(view({ undo: DONE })), /data-acc-undo>撤销接入…/);
  // 别处有动作在做（另一个窗口在释放端口）
  assert.match(buildAccessHtml(view({ busy: { kind: "release", port: 7895 } })), /data-acc-undo disabled/);

  // 撤销并释放端口之后这台电脑算"没接入"了（没有端口、个人配置里也没记账号）：这一次的结果照样留着，
  // 只是没有端口表和入口；点过「知道了」（jobId 清掉）才整块收起
  const gone = { available: false, reason: "not-connected", server: null, port: null, registry: null, busy: null };
  const result = buildAccessHtml({ ...gone, undo: DONE }, { jobId: "j1" });
  assert.match(result, /已撤销接入/);
  assert.match(result, /没有自动处理的内容（2 项），按需自查/);
  assert.match(result, /data-acc-job-close>知道了<\/button>/);
  assert.doesNotMatch(result, /data-acc-undo>|acc-list|端口登记/);
  assert.match(buildAccessHtml({ ...gone, undo: JOB }), /正在撤销接入…/, "最后一步刚做完、还没收尾的那一拍");
  assert.equal(buildAccessHtml({ ...gone, undo: DONE }), "");
  assert.equal(buildAccessHtml({ ...gone, undo: DONE }, { jobId: "other" }), "");
});

test("来自后端的文字一律转义", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const ports = buildPortsHtml(withRegistry({ me: evil, error: null, current: { port: 7892, owner: "other", name: evil }, ports: [row(7895, { releasable: true })] }));
  const preview = buildPreviewHtml({ ...PREVIEW, host: evil, notes: [evil], steps: [{ id: "x", title: evil, effect: "change", items: [evil], note: "" }], release: { port: 7892, available: true, note: evil }, consequences: { keep: evil, release: evil } });
  const job = buildJobHtml({ ...FAILED, summary: evil, leftovers: [evil], status: "ok", steps: [step(evil, "failed", { title: evil, detail: evil, manual: evil })] });
  for (const html of [ports, preview, job]) assert.doesNotMatch(html, /<img/);
});

// ---- 控制器 ----

function setup({ getJson, postJson } = {}) {
  const dlg = fakeDialog();
  dlg.open = true;
  const body = fakeElement();
  body.hidden = true;
  const timers = fakeTimers();
  const deps = {
    doc: fakeDocument({ dlgSettings: dlg, settingsAccess: body }),
    getJson: getJson || spy(async () => structuredClone(VIEW)),
    postJson: postJson || spy(async () => ({})),
    showToast: spy(),
    copyText: spy(async () => true),
    refresh: spy(async () => {}),
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  };
  const ctl = createSettingsAccess(deps);
  const click = (dataset) => body.dispatch("click", { target: fakeElement({ tag: "button", dataset, parent: body }) });
  const toggle = (checked) => body.dispatch("change", { target: fakeElement({ tag: "input", dataset: { accReleaseToggle: "" }, checked, parent: body }) });
  return { ctl, deps, body, dlg, timers, click, toggle };
}

test("控制器：打开配置读一次；没接入过整块藏着；接入过就显示端口表", async () => {
  const hidden = setup({ getJson: spy(async () => ({ available: false, reason: "not-connected", registry: null, undo: null })) });
  await hidden.ctl.onOpen();
  assert.deepEqual(hidden.deps.getJson.calls, [["/api/onboarding/access", { timeoutMs: 30000 }]]);
  assert.equal(hidden.body.hidden, true);
  assert.equal(hidden.body.innerHTML, "");
  assert.equal(hidden.timers.timeouts.size, 0);

  const shown = setup();
  await shown.ctl.onOpen();
  assert.equal(shown.body.hidden, false);
  assert.match(shown.body.innerHTML, /7895/);
  assert.equal(shown.timers.timeouts.size, 0, "读到了就不再轮询");
});

test("控制器：端口登记还在后台读（pending）→ 一秒后再取，读到为止；浮层关了就不取了", async () => {
  const pending = withRegistry({ state: "unknown", ports: [], current: null, me: "", checkedAt: null, pending: true });
  let n = 0;
  const getJson = spy(async () => (n++ === 0 ? pending : structuredClone(VIEW)));
  const ctx = setup({ getJson });
  await ctx.ctl.onOpen();
  assert.match(ctx.body.innerHTML, /正在读取集群上的端口登记…/);
  assert.deepEqual([...ctx.timers.timeouts.values()].map((timer) => timer.ms), [ACCESS_POLL_MS]);
  ctx.timers.runTimeouts();
  await flush();
  assert.equal(getJson.calls.length, 2);
  assert.match(ctx.body.innerHTML, /data-acc-release="7895"/);
  assert.equal(ctx.timers.timeouts.size, 0);

  const closed = setup({ getJson: spy(async () => pending) });
  await closed.ctl.onOpen();
  assert.equal(closed.timers.timeouts.size, 1);
  closed.dlg.close();
  await flush();
  assert.equal(closed.timers.timeouts.size, 0, "只是在等登记读回来：关掉浮层就停");
});

test("控制器：读失败不占地方、不弹提示（下次打开再读）；内容没变不重写 DOM", async () => {
  const failing = setup({ getJson: spy(async () => { throw new Error("HTTP 503"); }) });
  await failing.ctl.onOpen();
  assert.equal(failing.body.hidden, true);
  assert.equal(failing.deps.showToast.calls.length, 0);

  const ctx = setup();
  await ctx.ctl.onOpen();
  let writes = 0;
  let html = ctx.body.innerHTML;
  Object.defineProperty(ctx.body, "innerHTML", { get: () => html, set: (value) => { html = value; writes += 1; } });
  await ctx.ctl.load();
  assert.equal(writes, 0);
});

test("控制器：释放是两步——先行内确认，确认后才 POST；成功提示并采用返回的登记表", async () => {
  const after = withRegistry({ ports: [REGISTRY.ports[0], REGISTRY.ports[1]] });
  const postJson = spy(async () => ({ port: 7895, result: "ok", access: after }));
  const ctx = setup({ postJson });
  await ctx.ctl.onOpen();
  await ctx.click({ accRelease: "7895" });
  assert.match(ctx.body.innerHTML, /确认释放/);
  assert.equal(postJson.calls.length, 0, "只是展开确认");
  await ctx.click({ accReleaseCancel: "" });
  assert.doesNotMatch(ctx.body.innerHTML, /确认释放/);
  await ctx.click({ accRelease: "7895" });
  await ctx.click({ accReleaseGo: "7895" });
  assert.deepEqual(postJson.calls, [["/api/onboarding/access/release-port", { port: 7895, serverId: "server-01" }]]);
  assert.deepEqual([ctx.deps.showToast.calls[0][0].type, ctx.deps.showToast.calls[0][0].message], ["success", "端口 7895 已释放。"]);
  assert.doesNotMatch(ctx.body.innerHTML, /7895/);
  assert.equal(ctx.deps.getJson.calls.length, 1, "不必再读一遍");

  // 后端顺手清掉了个人配置里的旧记录：提示里说一声
  const cleared = setup({ postJson: spy(async () => ({ port: 7895, result: "ok", clearedStaleConfig: true, access: after })) });
  await cleared.ctl.onOpen();
  await cleared.click({ accRelease: "7895" });
  await cleared.click({ accReleaseGo: "7895" });
  assert.equal(cleared.deps.showToast.calls[0][0].message, "端口 7895 已释放。个人配置里它留下的旧记录也清掉了。");
});

test("控制器：释放被拒（在用 / 被监听 / 网络断了）→ 照后端给的原因提示，并重读登记", async () => {
  const postJson = spy(async () => Promise.reject(Object.assign(new Error("HTTP 409"), { status: 409, serverMessage: "端口 7895 正在被监听，可能是你另一台电脑的隧道在用；先停掉那条隧道再释放" })));
  const ctx = setup({ postJson });
  await ctx.ctl.onOpen();
  await ctx.click({ accRelease: "7895" });
  await ctx.click({ accReleaseGo: "7895" });
  await flush();
  assert.deepEqual([ctx.deps.showToast.calls[0][0].type, ctx.deps.showToast.calls[0][0].title], ["error", "没有释放"]);
  assert.match(ctx.deps.showToast.calls[0][0].message, /正在被监听/);
  assert.deepEqual(ctx.deps.getJson.calls.at(-1), ["/api/onboarding/access?fresh=1", { timeoutMs: 30000 }]);
  assert.doesNotMatch(ctx.body.innerHTML, /确认释放/);
});

test("控制器：撤销——先预览（只读）→ 勾选是否释放端口 → 确认后才执行 → 每秒取进度 → 结束提示一次并让工作台刷新", async () => {
  const running = view({ undo: structuredClone(JOB), busy: { kind: "undo" } });
  const finished = view({ port: null, undo: structuredClone(DONE), registry: { ...structuredClone(REGISTRY), ports: [], current: null } });
  let done = false;
  const getJson = spy(async () => structuredClone(done ? finished : (getJson.calls.length > 1 ? running : VIEW)));
  const postJson = spy(async (url) => (url.endsWith("/preview") ? { preview: structuredClone(PREVIEW), access: structuredClone(VIEW) } : { access: structuredClone(running) }));
  const ctx = setup({ getJson, postJson });
  await ctx.ctl.onOpen();

  await ctx.click({ accUndo: "" });
  assert.deepEqual(postJson.calls, [["/api/onboarding/access/undo/preview", { serverId: "server-01" }]]);
  assert.match(ctx.body.innerHTML, /会在 myserver 上做下面这些事/);
  assert.match(ctx.body.innerHTML, /data-acc-undo-go>确认撤销<\/button>/, "默认不释放端口");
  assert.equal(ctx.timers.timeouts.size, 0);

  await ctx.toggle(true);
  assert.match(ctx.body.innerHTML, /确认撤销并释放端口/);
  assert.match(ctx.body.innerHTML, /会断网/);
  await ctx.toggle(false);
  assert.match(ctx.body.innerHTML, /data-acc-undo-go>确认撤销<\/button>/);
  await ctx.toggle(true);
  assert.equal(postJson.calls.length, 1, "勾选不发请求");

  await ctx.click({ accUndoGo: "" });
  assert.deepEqual(postJson.calls[1], ["/api/onboarding/access/undo/run", { serverId: "server-01", previewId: "p1", releasePort: true }]);
  assert.match(ctx.body.innerHTML, /正在撤销接入…/);
  assert.equal(ctx.ctl.getState().jobId, "j1");
  assert.deepEqual([...ctx.timers.timeouts.values()].map((timer) => timer.ms), [ACCESS_POLL_MS]);

  ctx.timers.runTimeouts();
  await flush();
  assert.equal(ctx.deps.showToast.calls.length, 0, "还没结束");
  assert.equal(ctx.timers.timeouts.size, 1);
  done = true;
  ctx.timers.runTimeouts();
  await flush();
  assert.match(ctx.body.innerHTML, /已撤销接入/);
  assert.match(ctx.body.innerHTML, /没有自动处理的内容（2 项）/);
  assert.deepEqual([ctx.deps.showToast.calls.length, ctx.deps.showToast.calls[0][0].type, ctx.deps.showToast.calls[0][0].title], [1, "success", "撤销接入"]);
  assert.deepEqual(ctx.deps.refresh.calls, [[{ force: true }]], "首页跟着变（未领取端口）");
  assert.equal(ctx.timers.timeouts.size, 0, "结束后停表");

  // 结果留在那里，直到点「知道了」
  await ctx.ctl.load();
  assert.match(ctx.body.innerHTML, /已撤销接入/);
  assert.equal(ctx.deps.showToast.calls.length, 1, "不重复提示");
  await ctx.click({ accJobClose: "" });
  assert.doesNotMatch(ctx.body.innerHTML, /已撤销接入/);
  assert.match(ctx.body.innerHTML, /data-acc-undo>撤销接入…/);
});

test("控制器：撤销并释放之后这台电脑不再算接入（后端回 available=false）→ 结果与收尾清单照样显示，点「知道了」才整块收起", async () => {
  // 命令行向导接入的电脑：个人配置里只有端口、没有记集群账号。端口一拿掉，后端就按"没接入"回话。
  const running = view({ undo: structuredClone(JOB), busy: { kind: "undo" } });
  const gone = { available: false, reason: "not-connected", simulated: false, server: null, port: null, registry: null, busy: null };
  let phase = "idle";
  const getJson = spy(async () => structuredClone(phase === "idle" ? VIEW : phase === "last-step" ? { ...gone, undo: JOB } : { ...gone, undo: DONE }));
  const postJson = spy(async (url) => (url.endsWith("/preview") ? { preview: structuredClone(PREVIEW), access: structuredClone(VIEW) } : { access: structuredClone(running) }));
  const ctx = setup({ getJson, postJson });
  await ctx.ctl.onOpen();
  await ctx.click({ accUndo: "" });
  await ctx.toggle(true);
  await ctx.click({ accUndoGo: "" });
  assert.match(ctx.body.innerHTML, /正在撤销接入…/);

  // 端口已经从配置里拿掉、撤销还差收尾的那一拍：进度留着，接着取
  phase = "last-step";
  ctx.timers.runTimeouts();
  await flush();
  assert.equal(ctx.body.hidden, false);
  assert.match(ctx.body.innerHTML, /正在撤销接入…/);
  assert.equal(ctx.timers.timeouts.size, 1);

  phase = "done";
  ctx.timers.runTimeouts();
  await flush();
  assert.equal(ctx.body.hidden, false, "结果不能跟着端口一起消失");
  assert.match(ctx.body.innerHTML, /已撤销接入/);
  assert.match(ctx.body.innerHTML, /集群上的代理配置已撤销。端口 7892 已从这台电脑的配置里拿掉/);
  assert.match(ctx.body.innerHTML, /没有自动处理的内容（2 项）/);
  assert.doesNotMatch(ctx.body.innerHTML, /data-acc-undo>|端口登记/);
  assert.deepEqual([ctx.deps.showToast.calls.length, ctx.deps.showToast.calls[0][0].type], [1, "success"]);
  assert.deepEqual(ctx.deps.refresh.calls, [[{ force: true }]]);
  assert.equal(ctx.timers.timeouts.size, 0);

  await ctx.click({ accJobClose: "" });
  assert.equal(ctx.body.hidden, true);
  assert.equal(ctx.body.innerHTML, "");
  // 之后再打开配置：没接入，整块不显示
  await ctx.ctl.onOpen();
  assert.equal(ctx.body.hidden, true);
});

test("控制器：不能释放端口的预览，就算勾选状态是真的也只按保留提交", async () => {
  const preview = { ...structuredClone(PREVIEW), release: { port: 7892, available: false, owner: "unknown", note: "写在团队配置里" } };
  const postJson = spy(async (url) => (url.endsWith("/preview") ? { preview, access: structuredClone(VIEW) } : { access: view({ undo: structuredClone(JOB) }) }));
  const ctx = setup({ postJson });
  await ctx.ctl.onOpen();
  await ctx.click({ accUndo: "" });
  await ctx.toggle(true);
  await ctx.click({ accUndoGo: "" });
  assert.equal(postJson.calls[1][1].releasePort, false);
});

test("控制器：预览没成 / 没能开始 → 照后端给的原因提示，回到平时的样子", async () => {
  const previewFails = setup({ postJson: spy(async () => Promise.reject(Object.assign(new Error("HTTP 502"), { status: 502, serverMessage: "读不到集群上现在的配置（连接服务器超时），没有做任何改动" }))) });
  await previewFails.ctl.onOpen();
  await previewFails.click({ accUndo: "" });
  assert.deepEqual([previewFails.deps.showToast.calls[0][0].type, previewFails.deps.showToast.calls[0][0].title], ["error", "撤销接入"]);
  assert.match(previewFails.deps.showToast.calls[0][0].message, /没有做任何改动/);
  assert.match(previewFails.body.innerHTML, /data-acc-undo>撤销接入…/);

  const runFails = setup({
    postJson: spy(async (url) => (url.endsWith("/preview")
      ? { preview: structuredClone(PREVIEW), access: structuredClone(VIEW) }
      : Promise.reject(Object.assign(new Error("HTTP 409"), { status: 409, serverMessage: "这台服务器上正在进行 codex 的安装 / 更新，请等它结束再试" })))),
  });
  await runFails.ctl.onOpen();
  await runFails.click({ accUndo: "" });
  await runFails.click({ accUndoGo: "" });
  await flush();
  assert.deepEqual([runFails.deps.showToast.calls[0][0].type, runFails.deps.showToast.calls[0][0].title], ["error", "没有开始撤销"]);
  assert.match(runFails.deps.showToast.calls[0][0].message, /正在进行 codex 的安装/);
  assert.match(runFails.body.innerHTML, /data-acc-undo>撤销接入…/, "确认收起，想继续就重新预览");
  assert.equal(runFails.ctl.getState().jobId, null);
});

test("控制器：预览期间按钮按住，连点不会发第二次；取消预览什么都不发", async () => {
  const gate = deferred();
  const postJson = spy(async () => {
    await gate.promise;
    return { preview: structuredClone(PREVIEW), access: structuredClone(VIEW) };
  });
  const ctx = setup({ postJson });
  await ctx.ctl.onOpen();
  const first = ctx.click({ accUndo: "" });
  await flush();
  assert.match(ctx.body.innerHTML, /data-acc-undo disabled>正在查看集群上的配置…/);
  await ctx.click({ accUndo: "" });
  assert.equal(postJson.calls.length, 1);
  gate.resolve();
  await first;
  await ctx.click({ accUndoCancel: "" });
  assert.match(ctx.body.innerHTML, /data-acc-undo>撤销接入…/);
  assert.equal(postJson.calls.length, 1);

  // 预览还在路上就把浮层关了：回来的预览不采用，重新打开时不会凭空冒出一个确认框
  const late = deferred();
  const closing = setup({ postJson: spy(async () => { await late.promise; return { preview: structuredClone(PREVIEW), access: structuredClone(VIEW) }; }) });
  await closing.ctl.onOpen();
  const pending = closing.click({ accUndo: "" });
  await flush();
  closing.dlg.close();
  late.resolve();
  await pending;
  assert.equal(closing.ctl.getState().flow, null);
  assert.match(closing.body.innerHTML, /data-acc-undo>撤销接入…/);
});

test("控制器：预览 / 确认的回话还没到时插进来一次读（重试、轮询）→ 流程照常往下走，不会停在「正在…」上", async () => {
  const FAILED_READ = withRegistry({ state: "unknown", ports: [], current: null, me: "", error: { code: "timeout", message: "连接服务器超时" } });
  // 预览成功
  const gate = deferred();
  const ok = setup({
    getJson: spy(async () => structuredClone(FAILED_READ)),
    postJson: spy(async () => {
      await gate.promise;
      return { preview: structuredClone(PREVIEW), access: structuredClone(VIEW) };
    }),
  });
  await ok.ctl.onOpen();
  const previewing = ok.click({ accUndo: "" });
  await flush();
  assert.match(ok.body.innerHTML, /data-acc-retry disabled/, "预览期间「重试」按住");
  await ok.click({ accRetry: "" });
  assert.equal(ok.deps.getJson.calls.length, 2, "这次读照样发出去了（真实页面里按钮按住，这里直接模拟点到）");
  gate.resolve();
  await previewing;
  assert.equal(ok.ctl.getState().flow.stage, "confirm");
  assert.match(ok.body.innerHTML, /data-acc-undo-go>确认撤销<\/button>/);

  // 预览没成：照样提示并回到平时的样子
  const failGate = deferred();
  const bad = setup({
    getJson: spy(async () => structuredClone(FAILED_READ)),
    postJson: spy(async () => {
      await failGate.promise;
      throw Object.assign(new Error("HTTP 502"), { serverMessage: "读不到集群上现在的配置（连接服务器超时），没有做任何改动" });
    }),
  });
  await bad.ctl.onOpen();
  const failing = bad.click({ accUndo: "" });
  await flush();
  await bad.ctl.load({ fresh: true });
  failGate.resolve();
  await failing;
  assert.equal(bad.ctl.getState().flow, null);
  assert.deepEqual(bad.deps.showToast.calls.map(([toast]) => toast.message), ["读不到集群上现在的配置（连接服务器超时），没有做任何改动"]);
  assert.match(bad.body.innerHTML, /data-acc-undo>撤销接入…/);
  await bad.click({ accUndo: "" });
  assert.equal(bad.deps.postJson.calls.length, 2, "可以重新预览");

  // 确认之后、回话之前插进来一次读，而这次确认被后端拒了：收起确认并提示，不会停在「正在开始…」
  const runGate = deferred();
  const rejected = setup({
    postJson: spy(async (url) => {
      if (url.endsWith("/preview")) return { preview: structuredClone(PREVIEW), access: structuredClone(VIEW) };
      await runGate.promise;
      throw Object.assign(new Error("HTTP 409"), { serverMessage: "这台服务器上正在进行 codex 的安装 / 更新，结束后才能再操作" });
    }),
  });
  await rejected.ctl.onOpen();
  await rejected.click({ accUndo: "" });
  const submitting = rejected.click({ accUndoGo: "" });
  await flush();
  assert.match(rejected.body.innerHTML, /正在开始…/);
  await rejected.ctl.load();
  runGate.resolve();
  await submitting;
  await flush();
  assert.equal(rejected.ctl.getState().flow, null);
  assert.equal(rejected.deps.showToast.calls.at(-1)[0].title, "没有开始撤销");
  assert.match(rejected.body.innerHTML, /data-acc-undo>撤销接入…/);

  // 确认之后轮询先一步看到撤销在跑：接手它，确认的回话到了不重复处理
  const lateGate = deferred();
  const running = view({ undo: structuredClone(JOB), busy: { kind: "undo" } });
  let started = false;
  const adopted = setup({
    getJson: spy(async () => structuredClone(started ? running : VIEW)),
    postJson: spy(async (url) => {
      if (url.endsWith("/preview")) return { preview: structuredClone(PREVIEW), access: structuredClone(VIEW) };
      started = true;
      await lateGate.promise;
      return { access: structuredClone(running) };
    }),
  });
  await adopted.ctl.onOpen();
  await adopted.click({ accUndo: "" });
  const going = adopted.click({ accUndoGo: "" });
  await flush();
  await adopted.ctl.load();
  assert.deepEqual([adopted.ctl.getState().flow, adopted.ctl.getState().jobId], [null, "j1"]);
  lateGate.resolve();
  await going;
  assert.match(adopted.body.innerHTML, /正在撤销接入…/);
  assert.equal(adopted.ctl.getState().jobId, "j1");
});

test("控制器：关掉浮层——没点确认的收起；撤销在跑则接着盯到结束并提示", async () => {
  const ctx = setup({ postJson: spy(async () => ({ preview: structuredClone(PREVIEW), access: structuredClone(VIEW) })) });
  await ctx.ctl.onOpen();
  await ctx.click({ accRelease: "7895" });
  ctx.dlg.close();
  await flush();
  assert.equal(ctx.ctl.getState().confirmPort, null);
  ctx.dlg.open = true;
  await ctx.click({ accUndo: "" });
  assert.equal(ctx.ctl.getState().flow.stage, "confirm");
  ctx.dlg.close();
  await flush();
  assert.equal(ctx.ctl.getState().flow, null, "没确认的预览关掉就作废");

  const running = view({ undo: structuredClone(JOB), busy: { kind: "undo" } });
  const failed = view({ undo: structuredClone(FAILED) });
  let finished = false;
  const bg = setup({
    getJson: spy(async () => structuredClone(finished ? failed : running)),
  });
  await bg.ctl.onOpen();
  assert.equal(bg.ctl.getState().jobId, "j1", "打开时撤销正在跑（刷新过页面）：接手它");
  assert.match(bg.body.innerHTML, /正在撤销接入…/);
  bg.dlg.close();
  await flush();
  assert.equal(bg.timers.timeouts.size, 1, "关掉浮层不停表");
  finished = true;
  bg.timers.runTimeouts();
  await flush();
  assert.deepEqual([bg.deps.showToast.calls.length, bg.deps.showToast.calls[0][0].type, bg.deps.showToast.calls[0][0].title], [1, "error", "撤销没有做完"]);
  assert.match(bg.deps.showToast.calls[0][0].message, /停在「步骤 remove-env」/);
  assert.equal(bg.timers.timeouts.size, 0);
});

test("控制器：复制手动命令；先发后到的旧响应不采用", async () => {
  let finished = false;
  const ctx = setup({ getJson: spy(async () => view({ undo: structuredClone(finished ? FAILED : JOB) })) });
  await ctx.ctl.onOpen();
  finished = true;
  ctx.timers.runTimeouts();
  await flush();
  assert.match(ctx.body.innerHTML, /data-acc-copy="remove-env"/);
  await ctx.click({ accCopy: "remove-env" });
  assert.deepEqual(ctx.deps.copyText.calls, [["sh -c 'rm -f ~/.config/cluster-workbench/env.sh'"]]);
  assert.match(ctx.deps.showToast.calls.at(-1)[0].message, /已复制/);

  const slow = deferred();
  let n = 0;
  const getJson = spy(async () => {
    n += 1;
    if (n === 1) {
      await slow.promise;
      return view({ port: 1111 });
    }
    return structuredClone(VIEW);
  });
  const race = setup({ getJson });
  const first = race.ctl.load();
  await race.ctl.load();
  slow.resolve();
  await first;
  assert.equal(race.ctl.getState().view.port, 7892, "后发的那次算数");
});
