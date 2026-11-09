import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { createIncidentStore } from "../work/monitor/lib/incidents/store.mjs";
import { createDiagnosesStore } from "../work/monitor/lib/jobs/diagnoses-store.mjs";
import { spawnFixtureMonitor } from "./lib/fixture-monitor.mjs";
import { runDaemonsBrowserSmoke } from "./lib/daemons-browser-smoke.mjs";
import { runDirUsageBrowserSmoke } from "./lib/dir-usage-browser-smoke.mjs";
import { runJobWatchBrowserSmoke } from "./lib/job-watch-browser-smoke.mjs";
import { runReportDraftSmoke } from "./lib/report-draft-browser-smoke.mjs";
import { runUsageErrorBrowserSmoke } from "./lib/usage-error-browser-smoke.mjs";
import { runLogReadbackBrowserSmoke } from "./lib/log-readback-browser-smoke.mjs";
import { runSubrunBrowserSmoke } from "./lib/subrun-browser-smoke.mjs";
import { runJobHistoryLookupBrowserSmoke } from "./lib/job-history-lookup-browser-smoke.mjs";
import { assertViewportWidth, sizedWindowClass } from "./lib/smoke-window.mjs";
import { runRootAdminBrowserSmoke } from "./lib/root-admin-browser-smoke.mjs";

// 所有冒烟窗口（含子冒烟自己开的）都经它创建：屏幕比请求的窗口小（CI 的 macos runner）时也拿到请求的尺寸。
const SmokeWindow = sizedWindowClass(BrowserWindow);
const SMOKE_WIDTH = 1100;
const rootDir = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(tmpdir(), "codex-monitor-browser-smoke-"));
app.setPath("userData", dataDir);
// cleanup 销毁最后窗口时仍等待后端退出，避免 Electron 提前以 0 退出吞掉失败。
app.on("window-all-closed", () => {});
console.log(`Browser smoke fixture: dataDir=${dataDir}`);
await writeFile(path.join(dataDir, "config.json"), JSON.stringify({
  activeServerId: "fixture-server", activeAgentId: "codex",
  servers: [{ id: "fixture-server", name: "Isolated Fixture", host: "fixture.invalid", localPort: 18888, remotePort: 17891 }],
  agents: [{ id: "codex", name: "Codex" }],
}), "utf8");
// 独立个人配置和事件快照覆盖真实启动迁移、删除、恢复；绝不读写用户数据。
const incidentServerId = "fixture-incident";
const incidentServer = {
  id: incidentServerId, name: "Incident Fixture", host: "incident-fixture.invalid",
  sshUser: "fixture", sshPort: 22, localPort: 18888, remotePort: 17894, tunnel: false,
};
const fixtureNow = Date.now();
const deletedFixtures = [
  { id: "fixture-removed", ageDays: 1 },
  { id: "fixture-expired", ageDays: 8 },
];
await writeFile(path.join(dataDir, "config.local.json"), JSON.stringify({
  schemaVersion: 1, revision: 0, servers: [incidentServer],
  _serverTombstones: deletedFixtures.map(({ id, ageDays }) => ({
    id, name: id, removedAt: fixtureNow - ageDays * 24 * 60 * 60 * 1000,
    snapshot: { ...incidentServer, id, name: id, host: `${id}.invalid` },
  })),
}), "utf8");
// openGate: {} 关掉打开门槛：v2.42 起隧道 / 通道 / Agent 的失败要先当候选（持续 120s 等）才转正，
// 夹具只想直接造出「已打开 / 已恢复」的事件，不模拟候选期。
const fixtureIncidents = createIncidentStore({ openGate: {} });
const observeFixture = (serverId, component = "tunnel", reasonCode = "TUNNEL_DOWN") =>
  fixtureIncidents.observe({ serverId, component, reasonCode, severity: "error", at: fixtureNow });
const openFixture = observeFixture(incidentServerId);
observeFixture(incidentServerId);
fixtureIncidents.acknowledge(openFixture.incidentId);
fixtureIncidents.snooze(openFixture.incidentId, 60 * 60 * 1000);
const closedFixture = observeFixture(incidentServerId, "filesystem", "FS_SLOW");
fixtureIncidents.reportSuccess({ serverId: incidentServerId, component: "filesystem" });
fixtureIncidents.reportSuccess({ serverId: incidentServerId, component: "filesystem" });
const unaffectedFixture = observeFixture("fixture-server", "filesystem", "FS_SLOW");
for (const { id } of deletedFixtures) observeFixture(id);
await mkdir(path.join(dataDir, "runtime"), { recursive: true });
await writeFile(path.join(dataDir, "runtime/incidents.json"), fixtureIncidents.serializeForSave(), "utf8");
// 报告经真实只读 API 汇集这些本地诊断；其它作业列表继续使用已有 UI 夹具。
const reportDiagnoses = createDiagnosesStore({ filePath: path.join(dataDir, "runtime/job-diagnoses.json") });
await reportDiagnoses.putMany([{ jobId: "18537", serverId: "fixture-server", name: "arm_train", state: "FAILED", exitCode: 1,
  endedAt: fixtureNow - 3_600_000, category: "python", headline: "KeyError: 'arm'", evidence: ["KeyError: 'arm'", "token=report-fixture-secret"],
  files: [{ path: "/home/fixture/train.log", tail: "KeyError: 'arm'" }], script: "#!/bin/sh\nexport API_KEY=report-fixture-secret\npython train.py\n", source: "registry" }]);

let server;
let win;
let cleaned = false;
async function waitFor(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(typeof message === "function" ? await message() : message);
}
async function startRealServer() {
  server = spawnFixtureMonitor({
    command: process.execPath,
    script: path.join(rootDir, "work/monitor/monitor-server.mjs"),
    cwd: rootDir,
    port: 0,
    // 真实 token（非空）以验证 C3 加固后的安全路径：前端经同源 /api/session 取 token 后写操作应放行。
    authToken: "smoke-fixture-token",
    dataDir,
    configPath: path.join(dataDir, "config.json"),
    localConfigPath: path.join(dataDir, "config.local.json"),
  });
  const { child } = server;
  await waitFor(() => /Codex tunnel monitor: http:\/\/127\.0\.0\.1:\d+/.test(server.output()), () => `real monitor server failed to bind (exit=${child.exitCode}, signal=${child.signalCode}): ${server.output()}`);
  const port = server.output().match(/127\.0\.0\.1:(\d+)/)[1];
  assert.notEqual(port, "8877");
  return `http://127.0.0.1:${port}`;
}
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (win && !win.isDestroyed()) win.destroy();
  if (server) await server.stop({ graceMs: 1500 });
  await rm(dataDir, { recursive: true, force: true });
}
async function runSmoke() {
  let baseUrl = await startRealServer();
  const packageVersion = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8")).version;
  const pageErrors = [];
  win = new SmokeWindow({ show: Boolean(process.env.BROWSER_SMOKE_SCREENSHOTS), width: SMOKE_WIDTH, height: 820, webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on("console-message", (_event, detailsOrLevel, oldMessage) => {
    const details = typeof detailsOrLevel === "object"
      ? detailsOrLevel
      : { level: detailsOrLevel, message: oldMessage };
    if (details.level >= 3) pageErrors.push(details.message);
  });
  // 这些步骤验证可见工作台的自动同步；隐藏窗口按产品设计会跳过全量刷新。
  // showInactive 保持真实可见性语义，同时不抢用户焦点。
  win.showInactive();
  await win.loadURL(baseUrl);
  await waitFor(() => win.webContents.executeJavaScript(
    `document.getElementById("versionBadge")?.textContent === "v${packageVersion}" && document.getElementById("serverSelect")?.options.length > 0`,
  ), "real UI did not finish bootstrap");
  // 下面「三张服务器卡排成一行」等布局断言以 1100px 的视口为前提（内容区 938px；1024px 时只有 862px，放不下）。
  await assertViewportWidth(win, SMOKE_WIDTH, "main smoke window");
  await win.webContents.executeJavaScript('document.getElementById("startBtn").click()');
  // 动作在飞时控制按钮全部禁用，结束后恢复。看「停止」按钮：启动成功后「启动」按钮会变成
  // 「已在运行」并保持禁用（v2.45），不能再用它判断动作是否结束。
  await waitFor(() => win.webContents.executeJavaScript('document.getElementById("stopBtn")?.disabled === false'), "real start action did not complete");
  // T04a：停止是全局动作，UI 会弹影响范围确认（window.confirm）。smoke 用自动接受
  // 覆盖确认闸，继续走真实的 /api/stop 路径；取消侧的"无副作用"由文案与 action()
  // 逻辑保证（confirm 返回 false 时直接 return，不发任何请求）。
  await win.webContents.executeJavaScript('window.confirm = () => true; document.getElementById("stopBtn").click()');
  // T02：有 summary（schemaVersion 1）时总体标题按 transport 状态显示——手动停止
  // 的 transport 文案是「已停止」（§9.3 状态文案：已连接/连接中断/已停止/待验证）。
  await waitFor(() => win.webContents.executeJavaScript('document.getElementById("overall")?.textContent === "\u5df2\u505c\u6b62"'), "real monitor-server SSE was not consumed");
  // 主视图切换 + 主页面无横向溢出；团队页按权限隐藏，但导航节点始终存在。
  assert.deepEqual(
    await win.webContents.executeJavaScript('[...document.querySelectorAll(".view-tab")].map((b) => b.dataset.view)'),
    ["overview", "servers", "events", "usage", "team", "storage"],
    "主导航包含四个日常视图与按权限显示的团队管理、存储管理，配置从顶部打开",
  );
  // 夹具不是管理员：存储管理整页与服务器页磁盘卡片里的入口都不出现。
  assert.equal(
    await win.webContents.executeJavaScript('document.getElementById("tab-storage").hidden && document.getElementById("view-storage").hidden && document.getElementById("resDiskStorage").hidden && !document.getElementById("resDiskTile").dataset.saEntry'),
    true,
    "非管理员看不到存储管理",
  );
  // 用量视图：fixture 环境没有用量数据，应能切进去并给出空状态 / 无可统计服务器的提示，且无横向溢出。
  await win.webContents.executeJavaScript('document.getElementById("tab-usage").click()');
  await waitFor(() => win.webContents.executeJavaScript('!document.getElementById("view-usage").hidden && document.getElementById("usageRangeCaption").textContent !== "—"'), "usage view did not load /api/usage/summary");
  assert.equal(
    await win.webContents.executeJavaScript('(() => { const ok = !document.getElementById("usageEmptyState").hidden && document.documentElement.scrollWidth <= window.innerWidth; document.getElementById("tab-overview").click(); return ok; })()'),
    true,
    "用量视图在没有数据时应显示空状态提示，且不出现横向溢出",
  );
  assert.equal(
    await win.webContents.executeJavaScript('(() => { document.getElementById("tab-events").click(); const visible = document.getElementById("view-events").classList.contains("active") && !document.getElementById("view-events").hidden && document.getElementById("view-overview").hidden; document.getElementById("tab-overview").click(); return visible; })()'),
    true,
    "事件视图切换应生效",
  );

  // 键盘 / 读屏：侧栏当前页带 aria-current，⌘K 是标准 combobox，Esc 关闭后焦点回到打开者。
  await win.webContents.executeJavaScript('document.getElementById("tab-servers").click(); true');
  await waitFor(() => win.webContents.executeJavaScript('document.getElementById("view-servers").classList.contains("active")'), "servers view did not open");
  assert.deepEqual(
    await win.webContents.executeJavaScript('(() => ({ current: document.querySelector(".view-tab[aria-current=page]")?.dataset.view, selected: document.querySelector(".view-tab[aria-selected=true]")?.dataset.view }))()'),
    { current: "servers", selected: "servers" },
    "当前页的 aria-current 与 aria-selected 必须一致",
  );
  await win.webContents.executeJavaScript('document.getElementById("tab-overview").click(); true');
  await waitFor(() => win.webContents.executeJavaScript('document.getElementById("view-overview").classList.contains("active")'), "overview view did not return");

  await win.webContents.executeJavaScript('document.getElementById("tab-overview").focus(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); true');
  await waitFor(() => win.webContents.executeJavaScript('document.getElementById("dlgCommandPalette").open'), "command palette did not open from Ctrl+K");
  const paletteA11y = await win.webContents.executeJavaScript(`(() => {
    const input = document.getElementById("cmdInput");
    const list = document.getElementById("cmdList");
    const activeId = input.getAttribute("aria-activedescendant");
    const active = activeId ? document.getElementById(activeId) : null;
    const roles = { list: list.getAttribute("role"), active: active?.getAttribute("role") };
    const expanded = input.getAttribute("aria-expanded");
    const combo = input.getAttribute("role");
    const hasPopup = input.getAttribute("aria-haspopup");
    const controls = input.getAttribute("aria-controls");
    const options = list.querySelectorAll('[role="option"]').length;
    return { combo, hasPopup, controls, expanded, activeId, roles, options };
  })()`);
  assert.equal(paletteA11y.combo, "combobox");
  assert.equal(paletteA11y.hasPopup, "listbox");
  assert.equal(paletteA11y.controls, "cmdList");
  assert.equal(paletteA11y.expanded, "true");
  assert.equal(paletteA11y.roles.list, "listbox");
  assert.equal(paletteA11y.roles.active, "option");
  assert.ok(paletteA11y.options > 1 && paletteA11y.activeId, `命令项与活动项应存在: ${JSON.stringify(paletteA11y)}`);
  await win.webContents.executeJavaScript('document.getElementById("cmdInput").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); true');
  assert.equal(
    await win.webContents.executeJavaScript('document.getElementById("cmdInput").getAttribute("aria-activedescendant")'),
    "cmd-opt-1",
    "ArrowDown 应把活动项移到第二项",
  );
  await win.webContents.executeJavaScript('document.getElementById("cmdInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
  await waitFor(() => win.webContents.executeJavaScript('!document.getElementById("dlgCommandPalette").open'), "command palette did not close on Escape");
  assert.equal(await win.webContents.executeJavaScript('document.activeElement?.id'), "tab-overview", "关闭命令面板后焦点回到打开前的元素");

  // toast 容器是礼貌 live region（不是逐条 role=alert 打断朗读）。
  await win.webContents.executeJavaScript('import("/assets/js/toast.js").then((m) => { m.showToast({ type: "success", title: "键盘可达性", message: "toast 播报检查" }); return true; })');
  const toastA11y = await win.webContents.executeJavaScript(`(() => {
    const host = document.getElementById("toastContainer");
    return { role: host?.getAttribute("role"), live: host?.getAttribute("aria-live"), items: document.querySelectorAll("#toastContainer .toast-item").length };
  })()`);
  assert.equal(toastA11y.role, "status");
  assert.equal(toastA11y.live, "polite");
  assert.ok(toastA11y.items >= 1, `toast item 应已插入: ${JSON.stringify(toastA11y)}`);
  console.log("browser-smoke: keyboard/a11y paths ok");

  // 从概览服务器卡切换查看视角（不经下拉框）：统一渲染入口须把 #serverSelect 同步到最新 activeServerId，再切回来。
  // 这一段在打开配置浮层之前做；浮层开着时个人层被改（版本号变化）的自动重读在下面单独验证。
  for (const target of [incidentServerId, "fixture-server"]) {
    const card = `#serverBriefsContainer .server-brief-card[data-id="${target}"]`;
    await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('${card}'))`), `overview card ${target} missing`);
    await win.webContents.executeJavaScript(`document.querySelector('${card}').click(); true`);
    await waitFor(() => win.webContents.executeJavaScript(`document.getElementById("serverSelect").value === "${target}"`),
      async () => `server select did not follow card switch to ${target}: ${await win.webContents.executeJavaScript('document.getElementById("serverSelect").value')}`);
  }
  assert.equal(await win.webContents.executeJavaScript('document.getElementById("dlgSettings").open'), false);
  console.log("browser-smoke: opening settings");
  await win.webContents.executeJavaScript('document.getElementById("configBtn").click()');
  await waitFor(() => win.webContents.executeJavaScript('document.getElementById("dlgSettings").open && !document.getElementById("savePersonalConfigBtn").disabled'), "configuration dialog did not load");
  assert.deepEqual(await win.webContents.executeJavaScript('JSON.parse(document.getElementById("personalConfigEditor").value).servers.map(server => server.id)'), [incidentServerId], "editor must load only the personal layer, not merged team servers");
  assert.equal(await win.webContents.executeJavaScript('Boolean(document.getElementById("serverRegistryForm") && document.getElementById("serverRegistryList"))'), true, "server registry form must exist");
  console.log("browser-smoke: settings loaded");
  const pageEval = (code) => win.webContents.executeJavaScript(code);
  const authHeaders = { "x-auth-token": "smoke-fixture-token" };
  const listServers = () => fetch(`${baseUrl}/api/servers`, { headers: authHeaders }).then((res) => res.json());
  const listIncidents = (state = "open") => fetch(`${baseUrl}/api/incidents?state=${state}&limit=200`, { headers: authHeaders }).then((res) => res.json());
  async function assertBriefLayout(count, { stacked = false } = {}) {
    await waitFor(() => pageEval(`document.querySelectorAll('#serverBriefsContainer .server-brief-card').length === ${count}`), `overview should have ${count} current server cards`);
    const layout = await pageEval(`(() => {
      const container = document.getElementById('serverBriefsContainer');
      const bounds = container.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: bounds.width,
        empty: Boolean(container.querySelector('.server-briefs-empty')),
        cards: [...container.querySelectorAll('.server-brief-card')].map(card => {
          const r = card.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, width: r.width };
        }) };
    })()`);
    assert.ok(layout.width > 0, "overview layout must be visible when measured");
    assert.equal(layout.empty, count === 0, "zero servers should replace stale cards with the empty state");
    if (!count) return;
    assert.ok(Math.abs(layout.cards[0].left - layout.left) <= 2, "first card must start at the available left edge");
    assert.ok(Math.abs(layout.cards.at(-1).right - layout.right) <= 2, `${count} cards must fill available width without an unused fixed column: ${JSON.stringify(layout)}`);
    for (const card of layout.cards) {
      assert.ok(card.left >= layout.left - 2 && card.right <= layout.right + 2, "cards must stay within the overview panel");
      assert.ok(Math.abs(card.width - layout.cards[0].width) <= 2, "server cards should share available width evenly");
      if (stacked) assert.ok(Math.abs(card.width - layout.width) <= 2, "narrow screens should give each card the full row");
      else assert.ok(Math.abs(card.top - layout.cards[0].top) <= 2, "wide screens should keep 1–3 cards on one row");
    }
  }
  async function assertIncidentVisibility(present) {
    const open = await listIncidents();
    const closed = await listIncidents("resolved");
    assert.equal(open.incidents.some(item => item.incidentId === openFixture.incidentId), present, "open event must follow server deletion/restoration");
    assert.equal(closed.incidents.some(item => item.incidentId === closedFixture.incidentId), present, "resolved history must follow server deletion/restoration");
    assert.ok(open.incidents.some(item => item.incidentId === unaffectedFixture.incidentId), "another server's event must remain intact");
    assert.equal(open.total, present ? 2 : 1, "event counts must exclude removed servers");
    // 概览只列待处理事件：openFixture 已确认 + 稍后提醒，只体现在「另有 N 条已确认或稍后提醒」计数里；
    // 待处理徽标恒为另一台服务器那 1 条（unaffectedFixture）。
    await waitFor(() => pageEval(`(() => {
      const row = document.querySelector('#incidentList [data-incident-id="${openFixture.incidentId}"]');
      const summary = document.getElementById('overviewIncidentSummary');
      return Boolean(row) === ${present} && summary.textContent.includes('1 条已确认或稍后提醒') === ${present}
        && document.getElementById('overviewIncidentBadge').textContent === '待处理 1';
    })()`), `event list and overview attention should ${present ? "restore" : "remove"} the server together`);
    if (present) {
      const restored = open.incidents.find(item => item.incidentId === openFixture.incidentId);
      assert.equal(restored.occurrences, 2, "restoring must preserve the original occurrence history");
      assert.deepEqual(restored.attention, openFixture.attention, "restoring must preserve acknowledgement and snooze preferences");
    }
  }
  // 事件页「已恢复」：默认按类型汇总（/api/incidents/summary，名字用界面用语），点行首按钮展开这一类的
  // 逐条记录，分段控件切到逐条卡片。看完切回「未解决」与概览——后面的断言都看未解决列表。
  async function assertResolvedSummary() {
    await pageEval(`(() => {
      document.getElementById('tab-events').click();
      const filter = document.getElementById('incidentStateFilter');
      filter.value = 'resolved';
      filter.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const firstRow = `document.querySelector('#incidentSummary tr.ev-row')`;
    await waitFor(() => pageEval(`!document.getElementById('incidentSummary').hidden && ${firstRow}?.children[1].textContent === '${incidentServer.name}'`),
      async () => `resolved incidents should be summarized by type with display names: ${await pageEval(`document.getElementById('incidentSummary').textContent.slice(0, 300)`)}`);
    assert.deepEqual(await pageEval(`(() => {
      const row = ${firstRow};
      return {
        listHidden: document.getElementById('incidentList').hidden,
        modeHidden: document.getElementById('incidentResolvedMode').hidden,
        badge: document.getElementById('incidentListBadge').textContent,
        rows: document.querySelectorAll('#incidentSummary tr.ev-row').length,
        title: row.querySelector('.ev-title').textContent,
        count: row.querySelector('.ev-num').textContent,
        days: row.querySelectorAll('.ev-strip i').length,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    })()`), { listHidden: true, modeHidden: false, badge: "近 14 天 1 次 · 1 类", rows: 1, title: "磁盘 · 读写缓慢", count: "1", days: 14, overflow: false },
    "the resolved fixture should show as one type row counted from the persisted day counters");
    await pageEval(`document.querySelector('#incidentSummary .ev-toggle').click()`);
    await waitFor(() => pageEval(`document.querySelector('#incidentSummary .ev-toggle').getAttribute('aria-expanded') === 'true' && document.querySelectorAll('#incidentSummary tr.ev-child:not([hidden]) .ev-children li').length === 1`),
      "expanding a type row should list its recent resolved incidents");
    await pageEval(`document.getElementById('incidentModeEach').click()`);
    await waitFor(() => pageEval(`document.getElementById('incidentSummary').hidden && !document.getElementById('incidentList').hidden
      && Boolean(document.querySelector('#incidentList [data-incident-id="${closedFixture.incidentId}"]')) && document.getElementById('incidentListBadge').textContent === '已恢复 1'`),
      "switching to the per-incident mode should show resolved cards");
    await pageEval(`(() => {
      const filter = document.getElementById('incidentStateFilter');
      filter.value = 'open';
      filter.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('tab-overview').click();
    })()`);
    await waitFor(() => pageEval(`document.getElementById('incidentResolvedMode').hidden && Boolean(document.querySelector('#incidentList [data-incident-id="${openFixture.incidentId}"]'))`),
      "returning to the open filter should restore the open incident cards");
  }
  const pageSnapshot = async () => ({
    ...(await pageEval(`({
      hint: document.getElementById("serverRegistryHint")?.textContent || "",
      list: document.getElementById("serverRegistryList")?.textContent || "",
    })`)),
    api: await listServers(),
  });
  // 真实鼠标事件按坐标命中，量坐标与派发之间布局若有位移，点击就会落空或落到相邻行的
  // 另一个按钮上。CI（macos-latest）上"撤销删除"间歇等不到恢复，本地复现出的机制：配置浮层
  // 在 top layer 里按 absolute 定位、随文档滚动，旧的 block:"center" 会顺带把文档滚 ~26px，
  // 随后页面高度变化（SSE 渲染）把滚动钳回或做滚动锚定，浮层整体位移，点击落到行间空白。所以：
  //   - 只用 block:"nearest" 滚动（浮层内目标只滚浮层正文，不再滚文档）；
  //   - 在 document 捕获阶段核对命中：没命中目标就吞掉这次点击（不触发任何业务动作），
  //     重新量坐标再点；连续 3 次都没命中则报出实际命中的元素，而不是让后续 waitFor 白等到超时。
  async function clickSelector(selector) {
    for (let attempt = 1; ; attempt += 1) {
      await waitFor(() => pageEval(`Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`), `click target not ready: ${selector}`);
      await pageEval("window.confirm = () => true; true");
      const point = await pageEval(`(() => {
        const selector = ${JSON.stringify(selector)};
        const el = document.querySelector(selector);
        if (!el) return null;
        el.scrollIntoView({ block: "nearest" });
        window.__smokeClickGuard?.dispose();
        const guard = { result: "pending" };
        const onClick = (event) => {
          guard.dispose();
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest(selector)) { guard.result = "hit"; return; }
          guard.result = target ? target.outerHTML.replace(/\\s+/g, " ").slice(0, 200) : String(event.target);
          event.preventDefault();
          event.stopImmediatePropagation();
        };
        guard.dispose = () => document.removeEventListener("click", onClick, true);
        document.addEventListener("click", onClick, true);
        window.__smokeClickGuard = guard;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      assert.ok(point, `missing click target ${selector}`);
      win.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
      let outcome = "pending";
      await waitFor(async () => {
        outcome = await pageEval("window.__smokeClickGuard?.result ?? 'pending'");
        return outcome !== "pending";
      }, "", 2000).catch(() => {});
      await pageEval("window.__smokeClickGuard?.dispose(); true");
      if (outcome === "hit") return;
      if (attempt >= 3) throw new Error(`click on ${selector} missed its target ${attempt} times; last hit: ${outcome}`);
      console.log(`browser-smoke: click on ${selector} missed (${outcome}), re-measuring`);
    }
  }
  await assertBriefLayout(2);
  await assertIncidentVisibility(true);
  await assertResolvedSummary();
  const initialIncidents = await listIncidents();
  for (const { id } of deletedFixtures) {
    assert.equal(initialIncidents.incidents.some(item => item.serverId === id), false, "startup must remove preexisting deleted-server incidents");
    assert.equal(await pageEval(`document.getElementById('overviewIncidentSummary').textContent.includes('${id}')`), false);
  }
  const initialServers = await listServers();
  assert.ok(initialServers.tombstones.some(item => item.id === "fixture-removed"), "one-day-old deleted server remains recoverable");
  assert.equal(initialServers.tombstones.some(item => item.id === "fixture-expired"), false, "expired server must not have a restore action");
  // v2.57：配置浮层开着时，个人层在浮层之外被改——这里模拟另一个窗口把查看的服务器切走再切回来
  // （每次切换版本号 +1）。浮层须按 /api/status 带的 personalRevision 自动重读服务器登记与 JSON 编辑器，
  // 下面的新增 / 编辑 / 删除才不会撞上「配置已被修改，请重新加载后保存」。
  const revisionBeforeSwitch = initialServers.revision;
  for (const target of [incidentServerId, "fixture-server"]) {
    const switched = await fetch(`${baseUrl}/api/config/active`, {
      method: "POST", headers: { ...authHeaders, "content-type": "application/json" }, body: JSON.stringify({ activeServerId: target }),
    });
    assert.equal(switched.status, 200, `switching the viewed server to ${target} from outside the dialog failed`);
  }
  const revisionAfterSwitch = (await listServers()).revision;
  assert.ok(revisionAfterSwitch > revisionBeforeSwitch, "switching the viewed server must bump the personal config revision");
  await waitFor(
    () => pageEval(`document.getElementById("serverRegistryList").dataset.revision === "${revisionAfterSwitch}" && JSON.parse(document.getElementById("personalConfigEditor").value).revision === ${revisionAfterSwitch}`),
    async () => `open settings dialog did not resync to revision ${revisionAfterSwitch}: ${JSON.stringify(await pageEval('({ list: document.getElementById("serverRegistryList").dataset.revision, editor: JSON.parse(document.getElementById("personalConfigEditor").value).revision, hint: document.getElementById("serverRegistryHint").textContent })'))}`,
  );
  // 用 waitFor 而不是立刻断言：浮层自己去拉的 /api/servers 可能比带着最终 activeServerId 的那一轮状态先到
  // （两次切换之间恰好有一轮全量刷新时），下拉框要等下一轮状态渲染才跟上。
  await waitFor(() => pageEval('document.getElementById("serverSelect").value === "fixture-server"'), "viewed server is back on the fixture server before the registry steps");
  console.log("browser-smoke: settings dialog resynced after an outside server switch");
  console.log("browser-smoke: filling server registry form");
  await pageEval(`(() => {
    window.confirm = () => true;
    const form = document.getElementById("serverRegistryForm");
    form.elements.name.value = "fixture-box";
    form.elements.address.value = "fixture-box.invalid";
    form.elements.sshPort.value = "22";
    form.elements.sshUser.value = "fixture";
    form.elements.remotePort.value = "7895";
    return true;
  })()`);
  console.log("browser-smoke: form fields set, clicking save");
  await clickSelector("#serverRegistrySaveBtn");
  await waitFor(async () => {
    const data = await listServers();
    return data.servers.some((s) => s.address === "fixture-box.invalid" || s.name === "fixture-box");
  }, "form submit did not persist fixture-box via /api/servers");
  const afterAdd = await listServers();
  const added = afterAdd.servers.find((s) => s.address === "fixture-box.invalid" || s.name === "fixture-box");
  assert.ok(added?.id, "form submit must persist the new server");
  assert.equal(added.tunnelEnabled, false, "new server defaults to monitoring without a reverse tunnel");
  assert.ok(afterAdd.servers.some((s) => s.id === "fixture-server"), "adding one server must keep the other");
  assert.equal(JSON.stringify(afterAdd).includes("authRef"), false, "server list must not expose authRef");
  await assertBriefLayout(3);
  assert.equal(
    await pageEval('!document.querySelector(\'[data-server-id="fixture-server"] [data-server-action="edit"]\')'),
    true,
    "team server card must hide edit",
  );
  const addedId = added.id;
  await clickSelector(`[data-server-id="${addedId}"] [data-server-action="edit"]`);
  await waitFor(() => pageEval(`document.getElementById("serverRegistryForm")?.elements.address.value === "fixture-box.invalid" && document.getElementById("serverRegistryForm")?.elements.sshUser.value === "fixture" && document.getElementById("serverRegistryForm")?.elements.tunnel.checked === false`), "edit did not refill the form from /api/servers");
  await pageEval('document.getElementById("serverRegistryForm").elements.name.value = "fixture-box-renamed"');
  await clickSelector("#serverRegistrySaveBtn");
  await waitFor(async () => {
    const data = await listServers();
    return data.servers.some((s) => s.id === addedId && s.name === "fixture-box-renamed" && (s.address === "fixture-box.invalid" || s.host === "fixture-box.invalid"));
  }, async () => `edit save did not persist: ${JSON.stringify(await pageSnapshot())}`);
  await waitFor(
    () => pageEval('document.getElementById("serverRegistryList")?.textContent.includes("fixture-box")'),
    async () => `server registry add did not render a card: ${JSON.stringify(await pageSnapshot())}`,
  );
  await clickSelector(`[data-server-id="${addedId}"] [data-server-action="test"]`);
  await waitFor(async () => {
    const data = await listServers();
    const row = data.servers.find((s) => s.id === addedId);
    return Boolean(row?.lastTest?.code);
  }, "test connection did not record lastTest");
  await waitFor(
    () => pageEval(`Boolean(document.querySelector('[data-server-id="${addedId}"] .server-registry-test'))`),
    async () => `server registry test did not render a result: ${JSON.stringify(await pageSnapshot())}`,
  );
  await clickSelector(`[data-server-id="${addedId}"] [data-server-action="disable"]`);
  await waitFor(async () => {
    const data = await listServers();
    const row = data.servers.find((s) => s.id === addedId);
    return row?.disabled === true || row?.state === "disabled";
  }, "disable did not persist");
  await waitFor(
    () => pageEval(`Boolean(document.querySelector('[data-server-id="${addedId}"] [data-server-action="enable"]'))`),
    async () => `server registry disable did not flip the button: ${JSON.stringify(await pageSnapshot())}`,
  );
  await assertBriefLayout(2);
  await clickSelector(`[data-server-id="${addedId}"] [data-server-action="delete"]`);
  await waitFor(async () => {
    const data = await listServers();
    return !data.servers.some((s) => s.id === addedId && s.state !== "removed");
  }, "delete did not persist");
  await waitFor(
    () => pageEval(`!document.querySelector('[data-server-id="${addedId}"] [data-server-action="delete"]')`),
    async () => `server registry delete did not remove the live card: ${JSON.stringify(await pageSnapshot())}`,
  );
  const afterDelete = await listServers();
  assert.equal(afterDelete.servers.some((s) => s.id === addedId && s.state !== "removed"), false, "deleted personal server must leave the live list");
  assert.ok(afterDelete.servers.some((s) => s.id === "fixture-server"), "deleting one server must keep the other");
  console.log(`browser-smoke: server registry UI add/test/disable/delete ok id=${addedId}`);
  // 日志 API 的内存窗口随后端重启更新，因此在重启前验证这一轮 start/stop 的操作 ID。
  const logs = await fetch(`${baseUrl}/api/logs?source=ops`, { headers: authHeaders }).then((res) => res.json());
  await access(path.join(dataDir, "runtime/logs/ops.ndjson"));
  const operationIds = logs.entries.filter((entry) => /requested \(fixture\)|requested/.test(entry.message)).map((entry) => entry.operationId).filter(Boolean);
  assert(operationIds.some((id) => /^[0-9a-f-]{36}$/i.test(id)), "AsyncLocalStorage operation ID was not persisted by real server");
  await clickSelector(`[data-server-id="${incidentServerId}"] [data-server-action="delete"]`);
  await waitFor(async () => !(await listServers()).servers.some(server => server.id === incidentServerId), "incident fixture deletion did not persist");
  await assertBriefLayout(1);
  await assertIncidentVisibility(false);
  const persistedDeleted = JSON.parse(await readFile(path.join(dataDir, "runtime/incidents.json"), "utf8"));
  const archived = persistedDeleted.removedServers.find(item => item.serverId === incidentServerId);
  assert.ok(archived?.active.some(item => item.incidentId === openFixture.incidentId), "delete response must already persist recoverable open events");
  assert.ok(archived?.closed.some(item => item.incidentId === closedFixture.incidentId), "delete response must already persist resolved history");
  assert.equal(persistedDeleted.removedServers.some(item => item.serverId === "fixture-expired"), false, "expired history must not survive migration");

  // 重启隔离后端后仍保持删除态，再通过真实恢复按钮验证同一事件身份和提醒偏好。
  await win.loadURL("about:blank");
  server.child.kill("SIGTERM");
  await waitFor(() => server.child.exitCode != null || server.child.signalCode != null, "fixture monitor did not stop for restart");
  baseUrl = await startRealServer();
  await win.loadURL(baseUrl);
  await waitFor(() => pageEval(`document.getElementById('versionBadge')?.textContent === 'v${packageVersion}' && document.getElementById('serverSelect')?.options.length > 0`), "restarted UI did not bootstrap");
  await assertBriefLayout(1);
  await assertIncidentVisibility(false);
  await pageEval('document.getElementById("configBtn").click()');
  await waitFor(() => pageEval('document.getElementById("dlgSettings").open && !document.getElementById("savePersonalConfigBtn").disabled'), async () => `settings did not load after fixture restart: ${JSON.stringify({ ...(await pageEval('({open: document.getElementById("dlgSettings").open, disabled: document.getElementById("savePersonalConfigBtn").disabled, text: document.getElementById("dlgSettings").textContent.slice(-2000)})')), errors: pageErrors })}`);
  await clickSelector(`.server-registry-tombstone[data-server-id="${incidentServerId}"] [data-server-action="restore"]`);
  await waitFor(async () => (await listServers()).servers.some(server => server.id === incidentServerId && server.disabled), async () => `restoration must return the server disabled: ${JSON.stringify({ ...(await pageSnapshot()), errors: pageErrors })}`);
  await assertIncidentVisibility(true);
  await assertBriefLayout(1);
  await clickSelector(`[data-server-id="${incidentServerId}"] [data-server-action="enable"]`);
  await assertBriefLayout(2);
  win.setSize(520, 820);
  await waitFor(() => pageEval("window.innerWidth <= 520"), "narrow window resize did not apply");
  await assertBriefLayout(2, { stacked: true });
  win.setSize(1100, 820);
  await waitFor(() => pageEval("window.innerWidth >= 1000"), "wide window resize did not apply");
  await assertBriefLayout(2);
  await clickSelector(`[data-server-id="${incidentServerId}"] [data-server-action="disable"]`);
  await assertBriefLayout(1);
  await clickSelector('[data-server-id="fixture-server"] [data-server-action="disable"]');
  await assertBriefLayout(0);
  await clickSelector('[data-server-id="fixture-server"] [data-server-action="enable"]');
  await assertBriefLayout(1);
  console.log("browser-smoke: server cards 0/1/2/3 + narrow layout; deleted-event migration/delete/restart/restore + attention history ok");
  if (process.env.BROWSER_SMOKE_SCREENSHOTS) await new Promise(resolve => setTimeout(resolve, 200));
  if (process.env.BROWSER_SMOKE_SCREENSHOTS) await writeFile(path.join(process.env.BROWSER_SMOKE_SCREENSHOTS, "console-config.png"), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('dlgSettings').close();
    document.getElementById('tab-servers').click();
  })()`);
  await waitFor(() => pageEval('!document.getElementById("view-servers").hidden'), "servers view did not open");
  if (process.env.BROWSER_SMOKE_SCREENSHOTS) await new Promise(resolve => setTimeout(resolve, 200));
  if (process.env.BROWSER_SMOKE_SCREENSHOTS) await writeFile(path.join(process.env.BROWSER_SMOKE_SCREENSHOTS, "console-servers.png"), (await win.webContents.capturePage()).toPNG());
  await checkResourcesPanel(pageEval);
  await checkTunnelResponse(pageEval);
  await checkJobDiagnosis(pageEval);
  await runJobWatchBrowserSmoke({ BrowserWindow: SmokeWindow, baseUrl, screenshotDir: process.env.BROWSER_SMOKE_SCREENSHOTS });
  await runUsageErrorBrowserSmoke({ BrowserWindow: SmokeWindow, baseUrl, screenshotDir: process.env.BROWSER_SMOKE_SCREENSHOTS });
  await runDirUsageBrowserSmoke({ BrowserWindow: SmokeWindow, baseUrl, screenshotDir: process.env.BROWSER_SMOKE_SCREENSHOTS });
  await runDaemonsBrowserSmoke({ BrowserWindow: SmokeWindow, baseUrl, screenshotDir: process.env.BROWSER_SMOKE_SCREENSHOTS });
  await runLogReadbackBrowserSmoke({ BrowserWindow: SmokeWindow, baseUrl, screenshotDir: process.env.BROWSER_SMOKE_SCREENSHOTS });
  await runSubrunBrowserSmoke({ BrowserWindow: SmokeWindow, baseUrl, screenshotDir: process.env.BROWSER_SMOKE_SCREENSHOTS });
  await runJobHistoryLookupBrowserSmoke({ BrowserWindow: SmokeWindow, baseUrl, screenshotDir: process.env.BROWSER_SMOKE_SCREENSHOTS });
  await runRootAdminBrowserSmoke({ win, baseUrl, waitFor, screenshotDir: process.env.BROWSER_SMOKE_SCREENSHOTS });
  assert.equal(await win.webContents.executeJavaScript('document.getElementById("dlgSettings").scrollWidth <= document.getElementById("dlgSettings").clientWidth + 2'), true);
  const overflow = await win.webContents.executeJavaScript('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  assert.ok(overflow <= 2, `主页面不得横向溢出（超出 ${overflow}px）`);
  assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  console.log(`Browser smoke passed: real-monitor-server port=${new URL(baseUrl).port} sse=consumed operationId=${operationIds.at(-1)}`);
}

// 资源与负载面板：夹具后端不连真集群、没有资源样本，这里在页面里改写 fetch，给
// /api/status 注入一台 8 卡 GPU 机器的资源层、给 /api/metrics 注入 30 分钟历史、给 /api/metrics/range
// 注入 7 天 / 30 天的降采样结果，再走真实的「切换查看服务器」路径
// （resetCharts → getStatus → render → seedFromMetrics）渲染，随后切一遍趋势范围（checkTrendRanges）。
// 截图模式下另存浅色 / 深色 / 520px 窄屏三张面板截图。
function fakeResourceFixture(now) {
  const GiB = 1024 ** 3;
  const TiB = 1024 ** 4;
  const gpu = [
    [0, 81000, 97], [1, 78643, 100], [2, 40960, 52], [3, 65536, 88],
    [4, 300, 0], [5, 512, 2], [6, 20480, 31], [7, 71680, 76],
  ].map(([index, memUsedMb, util]) => ({ index, name: "NVIDIA A100-SXM4-80GB", memUsedMb, memTotalMb: 81920, util }));
  const usage = {
    schemaVersion: 1,
    checkedAt: now - 12_000,
    cpu: { busyPct: 42.3, load1: 24.31, logicalCores: 64, loadNormalizedPct: 38, quality: "ok" },
    memory: { usedBytes: 362 * GiB, totalBytes: 503 * GiB },
    filesystem: { device: "nas01:/export/home", mountpoint: "/home", usedBytes: 1.64 * TiB, totalBytes: 1.8 * TiB, availBytes: 165 * GiB, usedPct: 91, inodeUsedPct: 34, source: "df-P" },
    quota: { state: "unknown" },
  };
  const output = [
    "gpu-node-07",
    " 14:20:01 up 23 days,  4:10,  3 users,  load average: 24.31, 22.80, 21.95",
    "               total        used        free      shared  buff/cache   available",
    "Mem:           503Gi       362Gi        12Gi       2.1Gi       129Gi       131Gi",
    "nas01:/export/home  1.8T  1.7T  165G  91% /home",
    "nproc: 64",
  ].join("\n");
  const samples = Array.from({ length: 30 }, (_, i) => ({
    ts: now - (30 - i) * 60_000,
    serverId: "fixture-server",
    kind: "resource",
    cpu: 38,
    ram: Math.round(69 + 3 * Math.sin(i / 5)),
    disk: 90 + (i > 20 ? 1 : 0),
    cpuBusyPct: Math.round((40 + 14 * Math.sin(i / 3) + (i % 4) * 2) * 10) / 10,
    loadNormalizedPct: 38,
    metricSchemaVersion: 1,
  }));
  // 长范围（/api/metrics/range 的形状）：磁盘每天涨 1 个点，到现在是 91% → 走势一句话应是「约 9 天写满」。
  const DAY = 86_400_000;
  const rangeFixture = (range, days, stepMs) => {
    const count = Math.floor((days * DAY) / stepMs) + 1;
    return {
      range,
      stepMs,
      since: now - days * DAY,
      generatedAt: now,
      samples: Array.from({ length: count }, (_, i) => ({
        ts: now - days * DAY + i * stepMs,
        cpuBusyPct: Math.round((30 + 20 * Math.sin(i / 9)) * 10) / 10,
        loadNormalizedPct: 30,
        cpu: 30,
        ram: Math.round(62 + 8 * Math.sin(i / 14)),
        disk: Math.round((91 - days + (days * i) / (count - 1)) * 10) / 10,
      })),
      extremes: { cpu: { min: 4, max: 88 }, ram: { min: 54, max: 75 }, disk: { min: 91 - days, max: 91 } },
    };
  };
  const ranges = { "7d": rangeFixture("7d", 7, 3_600_000), "30d": rangeFixture("30d", 30, 3 * 3_600_000) };
  return { output, samples, ranges, layer: { level: "ok", reason: "负载已更新", checkedAt: now - 12_000, output, gpu, usage } };
}

// 截图走 CDP 视口仿真：临时把视口撑到能装下整块面板（窗口本身不动），等曲线 d 过渡与
// 环形仪表过渡走完再截。captureBeyondViewport 会在截图瞬间改视口尺寸、触发
// ResizeObserver 重绘，截到的是过渡中途的曲线。
async function capturePanel(file, { width, theme }) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach("1.3");
  await dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width, height: 3200, deviceScaleFactor: 0, mobile: false });
  try {
    await win.webContents.executeJavaScript(`(() => {
      if (${JSON.stringify(theme)} === "light") document.body.setAttribute("data-theme", "light");
      else document.body.removeAttribute("data-theme");
      document.querySelectorAll(".toast-item").forEach((el) => el.remove());
      window.scrollTo(0, 0);
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await win.webContents.executeJavaScript("window.__resourcesSmokeRender ? window.__resourcesSmokeRender() : true");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const rect = await win.webContents.executeJavaScript(`(() => {
      const r = document.querySelector(".panel-servers").getBoundingClientRect();
      return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
    })()`);
    const { data } = await dbg.sendCommand("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
    await writeFile(path.join(process.env.BROWSER_SMOKE_SCREENSHOTS, file), Buffer.from(data, "base64"));
  } finally {
    await dbg.sendCommand("Emulation.clearDeviceMetricsOverride");
  }
}

async function checkResourcesPanel(pageEval) {
  const fixture = fakeResourceFixture(Date.now());
  await pageEval(`(() => {
    const FIXTURE = ${JSON.stringify(fixture)};
    const original = window.fetch;
    const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (url.pathname === "/api/metrics") return json({ samples: FIXTURE.samples });
      if (url.pathname === "/api/metrics/range") return json({ serverId: url.searchParams.get("serverId"), ...FIXTURE.ranges[url.searchParams.get("range")] });
      if (url.pathname !== "/api/status") return original(input, options);
      const status = await (await original(input, options)).json();
      const layers = status.layers || {};
      status.remoteLoad = { ok: true, output: FIXTURE.output };
      status.layers = { ...layers, resources: { ...(layers.resources || {}), [status.activeServerId]: FIXTURE.layer } };
      return json(status);
    };
    document.getElementById("serverSelect").dispatchEvent(new Event("change"));
    return true;
  })()`);
  await waitFor(() => pageEval(`(() => {
    const value = (id) => document.querySelector("#" + id + " .res-tile-value")?.textContent;
    return value("resCpuBody") === "42" && value("resMemoryBody") === "72" && value("resDiskBody") === "91"
      && document.getElementById("resDiskTile").dataset.level === "critical"
      && document.getElementById("resMemoryTile").dataset.level === "warn"
      && document.getElementById("resFreshness").textContent.startsWith("采样于")
      && document.getElementById("hostBadge").textContent === "gpu-node-07"
      && (document.getElementById("cpuTrendLine").getAttribute("d") || "").startsWith("M");
  })()`), async () => `resources panel did not render injected data: ${await pageEval('document.querySelector(".panel-servers").innerText')}`);
  await checkTrendRanges(pageEval);
  // app.js 目前只把 usage 传给 renderRemoteLoad（整层透传是集成 follow-up），它的下一轮渲染
  // 会把 GPU 区收起。这里以同一份数据带整层重渲（截图与窄屏断言前各调一次），覆盖 GPU 区；
  // 接线补上后两边签名相同，本调用被 memo 跳过。
  await pageEval(`(() => {
    const FIXTURE = ${JSON.stringify(fixture)};
    window.__resourcesSmokeRender = () => import("/assets/js/render/load-panel.js").then((m) => {
      m.renderRemoteLoad({ ok: true, output: FIXTURE.output }, { id: "fixture-server", host: "fixture.invalid" }, FIXTURE.layer.checkedAt, FIXTURE.layer.usage, FIXTURE.layer);
      document.querySelectorAll(".toast-item").forEach((el) => el.remove());
      return true;
    });
    return window.__resourcesSmokeRender();
  })()`);
  await waitFor(() => pageEval(`window.__resourcesSmokeRender().then(() => !document.getElementById("resGpuSection").hidden
    && document.querySelectorAll("#resGpuList .res-gpu-row").length === 8
    && document.getElementById("resGpuSummary").textContent.includes("8 卡 · A100-SXM4-80GB"))`), "GPU section did not render 8 rows");
  const originalTheme = await pageEval('document.body.getAttribute("data-theme")');
  if (process.env.BROWSER_SMOKE_SCREENSHOTS) {
    await capturePanel("resources-light.png", { width: 1100, theme: "light" });
    await capturePanel("resources-dark.png", { width: 1100, theme: "dark" });
    await capturePanel("resources-narrow-light.png", { width: 520, theme: "light" });
    await capturePanel("resources-narrow-dark.png", { width: 520, theme: "dark" });
  }
  win.setSize(520, 820);
  await waitFor(() => pageEval("window.innerWidth <= 520"), "narrow window resize did not apply");
  const narrow = await pageEval(`window.__resourcesSmokeRender().then(() => {
    const panel = document.querySelector(".panel-servers").getBoundingClientRect();
    const tiles = [...document.querySelectorAll(".res-tile")].map((el) => el.getBoundingClientRect());
    const gpus = [...document.querySelectorAll(".res-gpu-row")].map((el) => el.getBoundingClientRect());
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stacked: tiles.every((r) => Math.abs(r.width - tiles[0].width) <= 2 && r.right <= panel.right + 1),
      singleColumn: new Set(tiles.map((r) => Math.round(r.left))).size === 1,
      gpuInside: gpus.length === 8 && gpus.every((r) => r.left >= panel.left - 1 && r.right <= panel.right + 1),
      // 页头 Agent 胶囊：整条落在页头条内，每枚胶囊的可见子项（状态点 / 名称 / 详情箭头）不顶出胶囊边框
      pillsInside: (() => {
        const bar = document.getElementById("pagebar").getBoundingClientRect();
        const pills = [...document.querySelectorAll(".pagebar-agents .agent-pill")];
        return pills.length > 0 && pills.every((pill) => {
          const box = pill.getBoundingClientRect();
          const kids = [...pill.children].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
          return box.right <= bar.right + 1 && kids.every((r) => r.left >= box.left - 1 && r.right <= box.right + 1);
        });
      })(),
    };
  })`);
  assert.ok(narrow.overflow <= 2, `资源面板窄屏不得横向溢出（超出 ${narrow.overflow}px）`);
  assert.ok(narrow.stacked && narrow.singleColumn && narrow.gpuInside, `资源面板窄屏应单列堆叠、GPU 卡不出界: ${JSON.stringify(narrow)}`);
  assert.ok(narrow.pillsInside, `窄窗页头 Agent 胶囊应收进页头条、内容不顶出胶囊: ${JSON.stringify(narrow)}`);
  await pageEval(`(() => {
    const theme = ${JSON.stringify(originalTheme)};
    if (theme) document.body.setAttribute("data-theme", theme); else document.body.removeAttribute("data-theme");
    return true;
  })()`);
  win.setSize(1100, 820);
  await waitFor(() => pageEval("window.innerWidth >= 1000"), "wide window resize did not apply");
}

// 资源趋势的范围切换（30 分钟 / 24 小时 / 7 天 / 30 天）：默认 24 小时；切换后按下态、趋势线的说明、
// 明细行里的范围高低值跟着变，选择记进 localStorage；磁盘卡的走势一句话恒按近 7 天算。
// 数据是 checkResourcesPanel 注入的 /api/metrics（近 30 分钟）与 /api/metrics/range。
async function checkTrendRanges(pageEval) {
  const state = () => pageEval(`(() => {
    const text = (selector) => document.querySelector(selector)?.textContent || "";
    return {
      pressed: [...document.querySelectorAll("[data-res-range]")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.resRange).join(","),
      stored: localStorage.getItem("resTrendRange"),
      cpuNote: text('#resCpuBody li[data-kind="range"]'),
      diskNote: text('#resDiskBody li[data-kind="range"]'),
      outlook: text('#resDiskBody li[data-kind="outlook"]'),
      note: text("#resDiskBody .res-tile-note"),
      diskTitle: document.querySelector("#resDiskTile .res-spark").title,
      cpuAria: document.getElementById("cpuTrendSvg").getAttribute("aria-label"),
      drawn: ["cpu", "ram", "disk"].every((type) => (document.getElementById(type + "TrendLine").getAttribute("d") || "").startsWith("M")),
    };
  })()`);
  const settled = async (label, expected) => {
    let last = null;
    await waitFor(async () => {
      last = await state();
      return Object.entries(expected).every(([key, want]) => (want instanceof RegExp ? want.test(last[key]) : last[key] === want));
    }, () => `资源趋势「${label}」未就绪: ${JSON.stringify(last)}`);
  };
  const outlook = "近 7 天每天约涨 1.0%，按这个速度约 9 天写满";
  await settled("默认 24 小时", {
    pressed: "h24", cpuNote: /^24 小时内 \d+–\d+%$/, diskNote: "24 小时内 90–91%", outlook,
    note: "共享卷 /home（$HOME 所在）· 个人配额未知",
    diskTitle: "最近 24 小时磁盘 · 每点为 5 分钟均值 · 纵轴 80–100%", cpuAria: "最近 24 小时 CPU 趋势", drawn: true,
  });
  await pageEval('document.querySelector(\'[data-res-range="d7"]\').click()');
  await settled("7 天", {
    pressed: "d7", stored: "d7", cpuNote: "7 天内 4–88%", diskNote: "7 天内 84–91%", outlook,
    diskTitle: "最近 7 天磁盘 · 每点为 1 小时均值 · 纵轴 70–100%", cpuAria: "最近 7 天 CPU 趋势", drawn: true,
  });
  await pageEval('document.querySelector(\'[data-res-range="d30"]\').click()');
  await settled("30 天", {
    pressed: "d30", stored: "d30", diskNote: "30 天内 61–91%", outlook,
    diskTitle: "最近 30 天磁盘 · 每点为 3 小时均值 · 纵轴 50–100%", cpuAria: "最近 30 天 CPU 趋势", drawn: true,
  });
  await pageEval('document.querySelector(\'[data-res-range="m30"]\').click()');
  await settled("30 分钟", {
    pressed: "m30", stored: "m30", cpuNote: /^30 分钟内 \d+–\d+%$/, outlook,
    diskTitle: "最近 30 分钟磁盘 · 纵轴 80–100%", cpuAria: "最近 30 分钟 CPU 趋势", drawn: true,
  });
  // 回到默认档（后面的截图与窄屏断言都按默认状态）
  await pageEval('document.querySelector(\'[data-res-range="h24"]\').click()');
  await settled("回到 24 小时", { pressed: "h24", stored: "h24", diskNote: "24 小时内 90–91%", drawn: true });
}

// 概览「隧道稳定性」（链路面板底部）：夹具后端没有隧道账本与采集耗时，这里直接用视图模块按给定数据渲染
//（与 __resourcesSmokeRender 同一思路），在真实浏览器里验证：SVG 经 morphInnerHtml 落进 #chainUptime、
// SSH 响应线与在线条同宽且紧跟其下、在时间轴之上，断档处另起一段，悬停气泡，展开的断线清单，以及不横向溢出。
// 结束时切回服务器页（调用方之后的断言按服务器页做）。
async function checkTunnelResponse(pageEval) {
  await pageEval('document.getElementById("tab-overview").click()');
  await waitFor(() => pageEval('!document.getElementById("view-overview").hidden'), "overview view did not open");
  await new Promise((resolve) => setTimeout(resolve, 800)); // 让控制器进入概览时的第一轮拉取先落地，免得覆盖下面的渲染
  const result = await pageEval(`(async () => {
    const now = Date.now();
    const DAY = 86400000;
    const { createTunnelStabilityView } = await import("/assets/js/render/tunnel-stability-view.js");
    const stats = { since: now - DAY, generatedAt: now, servers: { "fixture-server": {
      serverId: "fixture-server", name: "Isolated Fixture", host: "fixture.invalid", state: "up", since: now - 3540000, lastDrop: null, daily: [],
      windows: { "24h": { drops: 1, availability: 0.9993, downMs: 60000, recoveries: 1, meanRecoveryMs: 60000, longestUpMs: DAY / 2, causes: { "remote-closed": 1 } } },
      timeline: { start: now - DAY, end: now, segments: [
        { from: now - DAY, to: now - 3600000, state: "up" },
        { from: now - 3600000, to: now - 3540000, state: "down", cause: "remote-closed", at: now - 3600000 },
        { from: now - 3540000, to: now, state: "up" },
      ] },
    } }, recentDrops: [{ serverId: "fixture-server", at: now - 3600000, cause: "remote-closed", uptimeMs: DAY / 2, recoveredAt: now - 3540000, downMs: 60000 }] };
    // 每分钟一条采集耗时；一小时前有 12 分钟没采到（线在那里断开）
    const samples = [];
    for (let m = 24 * 60; m > 0; m -= 1) if (m > 67 || m < 56) samples.push({ ts: now - m * 60000, ms: 180 + (m % 7) * 15 });
    createTunnelStabilityView({ doc: document }).render(stats, { windowKey: "24h", nowMs: now, responses: new Map([["fixture-server", samples]]), dropsOpen: true });
    const root = document.getElementById("chainUptime");
    const row = root.querySelector('.cu-row[data-server="fixture-server"]');
    const box = row?.querySelector(".ts-resp");
    if (!box) return { missing: root.innerHTML.slice(0, 300) };
    const rect = (el) => el.getBoundingClientRect();
    const bar = rect(row.querySelector(".cu-bar"));
    const strip = rect(box);
    const axis = rect(root.querySelector(".cu-axis"));
    box.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: strip.left + strip.width * 0.5, clientY: strip.top + 5 }));
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
    const bubble = box.querySelector(".trend-value-bubble");
    return {
      hidden: root.hidden,
      summary: row.querySelector(".cu-summary").textContent,
      title: box.title,
      subpaths: [...box.querySelectorAll("path")].map((p) => ((p.getAttribute("d") || "").match(/M/g) || []).length),
      svg: box.querySelector("svg").namespaceURI,
      aligned: Math.abs(bar.left - strip.left) <= 1 && Math.abs(bar.width - strip.width) <= 1,
      ordered: bar.bottom <= strip.top && strip.bottom <= axis.top + 1,
      height: Math.round(strip.height),
      bubble: bubble.classList.contains("visible") ? bubble.textContent : "",
      drops: root.querySelectorAll("#stabilityDrops tr[data-key]").length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelOverflow: root.scrollWidth - root.clientWidth,
    };
  })()`);
  assert.equal(result.missing, undefined, `概览隧道稳定性没有渲染 SSH 响应线: ${result.missing}`);
  assert.equal(result.hidden, false);
  assert.equal(result.summary, "1 次断线 · 99.93%");
  assert.match(result.title, /^SSH 响应 · 中位 \d+ms · 最慢 270ms（每 5 分钟取最慢的一次 · 纵轴 0–\d+ms）$/);
  assert.deepEqual(result.subpaths, [2, 2], "面积与折线各一条 path，断档处各断成两段");
  assert.equal(result.svg, "http://www.w3.org/2000/svg");
  assert.ok(result.aligned && result.ordered && result.height === 14, `SSH 响应线应与在线条同宽、紧跟其下、在时间轴之上: ${JSON.stringify(result)}`);
  assert.match(result.bubble, /^\d+ms · \d+\.\d+ \d\d:\d\d$/, "悬停气泡：耗时在前、北京时间在后");
  assert.equal(result.drops, 1, "展开的断线清单有那一次断线");
  assert.ok(result.overflow <= 2 && result.panelOverflow <= 2, `隧道稳定性不得横向溢出: ${JSON.stringify(result)}`);
  await pageEval('document.getElementById("tab-servers").click()');
  await waitFor(() => pageEval('!document.getElementById("view-servers").hidden'), "servers view did not reopen");
}

// 「我的历史」里的失败作业诊断（v2.49）：夹具后端没有 Slurm 与作业记录，这里在页面里再包一层 fetch，
// 给 /api/status 的资源层补上 slurm 段（认得出当前用户 → 出现「我的历史」），并应答 /api/jobs、
// /api/jobs/diagnoses 与提交脚本接口，走真实的面板接线验证：原因行与单行省略、点行展开（证据保留空白、
// 不执行日志里的 HTML）、脚本按需读取且只读一次、重新拉历史后展开状态还在、同因筛选与「显示全部」、
// 键盘收起，以及宽 / 窄两种布局都不横向溢出。结束时还原 fetch 并切回当前队列。
async function checkJobDiagnosis(pageEval) {
  const now = Date.now();
  const failed = (id, name, diagnosis, extra = {}) => ({
    kind: "job", outcome: "failed", id, name, state: "FAILED", exitCode: 1, signal: 0, cancelledBy: null,
    endAt: now - 3_600_000, elapsedSec: 640, nodes: "node05", partition: "CPU", diagnosis, ...extra,
  });
  const longHeadline = `FileNotFoundError: [Errno 2] No such file or directory: '/home/kai/work/cfd_auto_trial_${"x".repeat(160)}/case.json'`;
  const fixture = {
    slurm: {
      schemaVersion: 1, state: "ok", reason: null, version: "23.11.8", user: "kai", checkedAt: now - 10_000, remoteNow: now - 10_000, defaultPartition: "CPU",
      nodes: [{ name: "node05", state: "idle", stateRaw: "idle", flags: [], partitions: ["CPU"], cpus: { alloc: 0, idle: 192, other: 0, total: 192 }, load: 1.2, memTotalMb: 350000, memFreeMb: 300000, memAllocMb: 0, gpus: null, reason: null }],
      jobs: [], jobsTotal: 0, jobsTruncated: false, counts: { running: 0, pending: 0, other: 0 },
    },
    jobs: {
      schemaVersion: 1, serverId: "fixture-server", windowHours: 48, state: "ok", reason: null, user: "kai", checkedAt: now - 60_000,
      total: 4, kept: 4, truncated: false, summary: { ended: 4, completed: 1, failed: 3, cancelled: 0, other: 0, running: 0, pending: 0 },
      rows: [
        failed("18537", "arm_train", { category: "python", headline: "KeyError: 'arm'" }),
        failed("18536", "arm_train_b", { category: "python", headline: "KeyError: 'arm'" }),
        failed("18400", "cfd_trial", { category: "missing-file", headline: longHeadline }, { state: "TIMEOUT" }),
        { kind: "job", outcome: "completed", id: "18300", name: "ok_job", state: "COMPLETED", exitCode: 0, signal: 0, cancelledBy: null, endAt: now - 7_200_000, elapsedSec: 60, nodes: "node05", partition: "CPU" },
      ],
      rowsOmitted: 0,
    },
    diagnoses: {
      items: [
        { jobId: "18537", serverId: "fixture-server", name: "arm_train", state: "FAILED", exitCode: 1, endedAtMs: now - 3_600_000, category: "python", headline: "KeyError: 'arm'",
          evidence: ["Traceback (most recent call last):", "    cfg['arm']  # <img src=x onerror=window.__diagXss=1>", "KeyError: 'arm'"],
          files: [{ path: "/home/kai/logs/arm_train_18537.log", tail: "" }], hasScript: true, source: "registry" },
        { jobId: "18536", serverId: "fixture-server", name: "arm_train_b", state: "FAILED", exitCode: 1, endedAtMs: now - 3_600_000, category: "python", headline: "KeyError: 'arm'", evidence: ["KeyError: 'arm'"], files: [], hasScript: false, source: "default" },
      ],
      groups: [{ key: "python|KeyError: 'arm'", category: "python", headline: "KeyError: 'arm'", count: 2, jobIds: ["18537", "18536"] }],
    },
    script: "#!/bin/bash\n#SBATCH -o logs/%x_%j.out\n    python train.py --arm left\n",
  };
  await pageEval(`(() => {
    const FIXTURE = ${JSON.stringify(fixture)};
    const previous = window.fetch;
    const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    window.__diagSmoke = { jobs: 0, diagnoses: 0, scripts: 0 };
    window.__diagSmokeRestore = () => { window.fetch = previous; };
    window.fetch = async (input, options) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (url.pathname === "/api/jobs") { window.__diagSmoke.jobs += 1; return json(FIXTURE.jobs); }
      if (url.pathname === "/api/jobs/diagnoses") { window.__diagSmoke.diagnoses += 1; return json(FIXTURE.diagnoses); }
      if (url.pathname === "/api/jobs/diagnoses/script") { window.__diagSmoke.scripts += 1; return json({ jobId: url.searchParams.get("jobId"), script: FIXTURE.script }); }
      if (url.pathname !== "/api/status") return previous(input, options);
      const status = await (await previous(input, options)).json();
      const resources = status.layers?.resources || {};
      status.layers = { ...(status.layers || {}), resources: { ...resources, [status.activeServerId]: { ...(resources[status.activeServerId] || { level: "ok" }), slurm: FIXTURE.slurm } } };
      return json(status);
    };
    document.getElementById("serverSelect").dispatchEvent(new Event("change"));
    return true;
  })()`);
  await waitFor(() => pageEval('!document.getElementById("clusterPanel").hidden && !document.getElementById("clusterQueueMode").hidden'), "cluster panel did not offer 我的历史");
  await pageEval('document.querySelector(\'[data-cl-mode="history"]\').click()');
  await waitFor(() => pageEval('document.querySelectorAll("#clusterHistoryBody tr.cl-diag").length === 3'), async () => `history did not render diagnosis rows: ${await pageEval('document.getElementById("clusterHistory").innerText')}`);

  const state = () => pageEval(`(() => {
    const body = document.getElementById("clusterHistoryBody");
    const wrap = document.querySelector("#clusterHistory .cl-table-wrap");
    const long = [...body.querySelectorAll(".cl-diag-headline")].find((el) => el.textContent.startsWith("FileNotFoundError"));
    return {
      causes: document.getElementById("clusterHistoryCauses").hidden ? "" : document.getElementById("clusterHistoryCauses").textContent,
      lines: [...body.querySelectorAll("tr.cl-diag")].map((tr) => [...tr.querySelectorAll(".cl-diag-line > *")].map((el) => el.textContent).join(" ")),
      jobRows: [...body.querySelectorAll("tr:not(.cl-diag)")].map((tr) => tr.querySelector(".cl-job-num")?.textContent || ""),
      open: [...body.querySelectorAll("tr[data-cl-diag]")].filter((tr) => tr.getAttribute("aria-expanded") === "true").map((tr) => tr.dataset.clDiag),
      evidence: body.querySelector(".cl-diag-evidence")?.textContent || "",
      evidenceWhiteSpace: body.querySelector(".cl-diag-evidence") ? getComputedStyle(body.querySelector(".cl-diag-evidence")).whiteSpace : "",
      script: body.querySelector(".cl-diag-script")?.textContent || "",
      scriptButton: body.querySelector("[data-cl-diag-script]")?.textContent || "",
      paths: [...body.querySelectorAll(".cl-diag-path")].map((el) => el.textContent),
      ellipsis: long ? long.scrollWidth > long.clientWidth && getComputedStyle(long).textOverflow === "ellipsis" : null,
      injected: body.querySelectorAll("img").length + (window.__diagXss ? 1 : 0),
      pressedChips: [...document.querySelectorAll("#clusterHistoryFilters [aria-pressed=true]")].map((b) => b.dataset.clHistFilter),
      calls: { ...window.__diagSmoke },
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      wrapOverflow: wrap.scrollWidth - wrap.clientWidth,
    };
  })()`);
  const settle = async (label, check) => {
    let last = null;
    await waitFor(async () => {
      last = await state();
      return check(last);
    }, () => `job diagnosis「${label}」未就绪: ${JSON.stringify(last)}`);
    return last;
  };

  const initial = await settle("原因行", (s) => s.lines.length === 3 && s.causes !== "");
  assert.equal(initial.causes, "2 个失败同因：KeyError: 'arm'");
  assert.deepEqual(initial.lines, ["▸ 程序报错 KeyError: 'arm'", "▸ 程序报错 KeyError: 'arm'", `找不到文件 ${longHeadline}`]);
  assert.equal(initial.ellipsis, true, "长 headline 单行省略");
  assert.equal(initial.calls.diagnoses, 1, "诊断整份拉一次，不按行拉");
  assert.ok(initial.overflow <= 2 && initial.wrapOverflow <= 2, `原因行不得撑出横向滚动: ${JSON.stringify(initial)}`);

  await pageEval('document.querySelector(\'#clusterHistoryBody tr[data-cl-diag="18537"]\').click()');
  const opened = await settle("展开", (s) => s.open.join() === "18537" && s.evidence !== "");
  assert.equal(opened.evidence, "Traceback (most recent call last):\n    cfg['arm']  # <img src=x onerror=window.__diagXss=1>\nKeyError: 'arm'");
  assert.equal(opened.evidenceWhiteSpace, "pre-wrap");
  assert.equal(opened.injected, 0, "日志里的 HTML 只当文字显示");
  assert.deepEqual(opened.paths, ["/home/kai/logs/arm_train_18537.log"]);
  assert.equal(opened.scriptButton, "查看提交脚本");
  assert.equal(opened.calls.scripts, 0, "不点不读脚本");

  // 真报告 API → 预览 → 可选脚本：按钮必须保留显示数据的服务器归属。
  await pageEval('document.querySelector(\'[data-job-report="18537"]\').click()');
  await waitFor(() => pageEval('document.getElementById("reportDialog").open && !document.getElementById("reportDownloadBtn").disabled'), "report preview did not load from real API");
  const report = await pageEval('document.getElementById("reportPreview").value');
  assert.match(report, /KeyError: 'arm'/);
  assert.ok(!report.includes("report-fixture-secret"), "default report must redact evidence credentials");
  assert.ok(!report.includes("python train.py"), "script must be explicitly selected");
  await pageEval('document.getElementById("reportIncludeScript").click()');
  await waitFor(() => pageEval('document.getElementById("reportPreview").value.includes("python train.py")'), "optional saved script did not load");
  assert.equal(await pageEval('document.getElementById("reportPreview").value.includes("report-fixture-secret")'), false);
  const reportLayout = await pageEval('({width:document.getElementById("reportPreview").clientWidth,height:document.getElementById("reportPreview").clientHeight,dialogWidth:document.getElementById("reportDialog").clientWidth})');
  assert.ok(reportLayout.width > reportLayout.dialogWidth * 0.8 && reportLayout.height > 200, `报告预览应铺满弹层且可以阅读: ${JSON.stringify(reportLayout)}`);
  if (process.env.BROWSER_SMOKE_SCREENSHOTS) {
    await writeFile(path.join(process.env.BROWSER_SMOKE_SCREENSHOTS, "report-preview.png"), (await win.webContents.capturePage()).toPNG());
  }
  await runReportDraftSmoke({ win, pageEval, waitFor, screenshotDir: process.env.BROWSER_SMOKE_SCREENSHOTS });
  await pageEval('document.getElementById("reportDialog").close()');

  await pageEval('document.querySelector("[data-cl-diag-script]").click()');
  await settle("读脚本", (s) => s.script === fixture.script && s.scriptButton === "收起脚本");
  await pageEval('document.querySelector("[data-cl-diag-script]").click()');
  await settle("收起脚本", (s) => s.script === "" && s.scriptButton === "查看提交脚本");
  await pageEval('document.querySelector("[data-cl-diag-script]").click()');
  const cached = await settle("再展开脚本", (s) => s.script === fixture.script);
  assert.equal(cached.calls.scripts, 1, "脚本按作业号缓存，只读一次");

  // 重新拉一次历史（切到当前队列再切回来）：展开的诊断与脚本都还在
  await pageEval('document.querySelector(\'[data-cl-mode="queue"]\').click(); document.querySelector(\'[data-cl-mode="history"]\').click(); true');
  const reloaded = await settle("重新拉历史", (s) => s.calls.jobs >= 2 && s.calls.diagnoses >= 2 && s.lines.length === 3);
  assert.deepEqual([reloaded.open, reloaded.script === fixture.script], [["18537"], true], "重绘后展开状态保持");

  await pageEval('document.querySelector("[data-cl-diag-cause]").click()');
  const filtered = await settle("同因筛选", (s) => s.jobRows.length === 2);
  assert.deepEqual([filtered.jobRows, filtered.pressedChips], [["18537", "18536"], []]);
  await pageEval('document.querySelector("[data-cl-diag-cause-clear]").click()');
  await settle("显示全部", (s) => s.jobRows.length === 4 && s.pressedChips.join() === "all");

  // 键盘：聚焦作业行按 Enter 收起
  await pageEval(`(() => {
    const row = document.querySelector('#clusterHistoryBody tr[data-cl-diag="18537"]');
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  })()`);
  await settle("键盘收起", (s) => s.open.length === 0 && s.evidence === "");

  // 窄屏：展开着也不横向溢出
  await pageEval('document.querySelector(\'#clusterHistoryBody tr[data-cl-diag="18537"]\').click()');
  if (process.env.BROWSER_SMOKE_SCREENSHOTS) {
    await pageEval('document.getElementById("clusterHistory").scrollIntoView(); true');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(path.join(process.env.BROWSER_SMOKE_SCREENSHOTS, "job-diagnosis-wide.png"), (await win.webContents.capturePage()).toPNG());
  }
  win.setSize(520, 820);
  await waitFor(() => pageEval("window.innerWidth <= 520"), "narrow window resize did not apply");
  const narrow = await settle("窄屏", (s) => s.open.join() === "18537" && s.evidence !== "");
  assert.ok(narrow.overflow <= 2 && narrow.wrapOverflow <= 2, `诊断展开后窄屏不得横向溢出: ${JSON.stringify(narrow)}`);
  if (process.env.BROWSER_SMOKE_SCREENSHOTS) {
    await pageEval('document.getElementById("clusterHistory").scrollIntoView(); true');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(path.join(process.env.BROWSER_SMOKE_SCREENSHOTS, "job-diagnosis-narrow.png"), (await win.webContents.capturePage()).toPNG());
  }
  win.setSize(1100, 820);
  await waitFor(() => pageEval("window.innerWidth >= 1000"), "wide window resize did not apply");
  await pageEval('window.__diagSmokeRestore(); document.querySelector(\'[data-cl-mode="queue"]\').click(); true');
}

let finishing = false;
const timeoutMs = Math.max(100, Number(process.env.BROWSER_SMOKE_TIMEOUT_MS) || 40_000);
async function finish(code, error) {
  if (finishing) return; finishing = true;
  if (error) console.error(error.stack || error);
  await cleanup(); app.exit(code);
}
Promise.race([
  app.whenReady().then(runSmoke),
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Browser smoke hard timeout after ${timeoutMs}ms`)), timeoutMs)),
]).then(() => finish(0), (error) => finish(1, error));
