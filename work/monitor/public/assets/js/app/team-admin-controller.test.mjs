import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAssignCliPayload,
  createTeamAdminController,
  normalizeTeamLayout,
  TEAM_LAYOUT_STORAGE_KEY,
} from "./team-admin-controller.js";
import { fakeDocument, fakeElement, spy } from "./test-support.mjs";

test("buildAssignCliPayload：Base URL 留空 = 官方直连，填了 = 中转站；Codex 带 providerId", () => {
  assert.deepEqual(buildAssignCliPayload("codex", { apiKey: " sk-1 " }), { mode: "official", apiKey: "sk-1" });
  assert.deepEqual(buildAssignCliPayload("codex", { apiKey: "sk-1", baseUrl: "https://r.example/v1", provider: "team" }), {
    mode: "relay", apiKey: "sk-1", baseUrl: "https://r.example/v1", providerId: "team", providerName: "team",
  });
  assert.equal(buildAssignCliPayload("codex", { apiKey: "k", baseUrl: "https://r" }).providerId, "team-relay", "没填名称用默认");
  assert.deepEqual(buildAssignCliPayload("claude", { apiKey: "k", baseUrl: "https://r" }), { mode: "relay", apiKey: "k", baseUrl: "https://r" });
});

test("normalizeTeamLayout：只认 list / cards", () => {
  assert.equal(normalizeTeamLayout("cards"), "cards");
  assert.equal(normalizeTeamLayout("list"), "list");
  assert.equal(normalizeTeamLayout(null), "list");
  assert.equal(normalizeTeamLayout("grid"), "list");
});

function memoryStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

function setup({ storage = memoryStorage() } = {}) {
  const els = {
    teamAdminList: fakeElement(),
    teamAdminKpis: fakeElement(),
    teamSkySub: fakeElement(),
    teamSky: fakeElement(),
    teamAdminLayoutToggle: fakeElement(),
    teamAssignForm: fakeElement({ tag: "form" }),
    tmAssignUser: fakeElement({ tag: "input" }),
    tmAssignCodexEnabled: fakeElement({ tag: "input" }),
    tmAssignClaudeEnabled: fakeElement({ tag: "input" }),
    tmAssignCodexProvider: fakeElement({ tag: "input" }),
    tmAssignCodexBaseUrl: fakeElement({ tag: "input" }),
    tmAssignCodexApiKey: fakeElement({ tag: "input" }),
  };
  const doc = fakeDocument(els);
  const writes = [];
  const galaxyCalls = { update: [], active: [] };
  const overview = {
    serverName: "主集群",
    checkedAt: 1_800_000_000_000,
    kpis: { totalMembers: 1 },
    members: [{ user: "alice", onlineState: "tunnel-online", inRoster: true, assignment: { state: "none" }, usage: {}, compute: {} }],
  };
  const getJson = spy(async () => overview);
  const postJson = spy(async () => ({ delivered: true }));
  const ctl = createTeamAdminController({
    doc,
    getJson,
    postJson,
    showToast: () => {},
    isViewVisible: () => true,
    storage,
    writeHtml: (el, html) => writes.push({ el, html }),
    setTimer: () => 0,
    clearTimer: () => {},
    createGalaxy: () => ({
      update: (members, opts) => galaxyCalls.update.push({ members, opts }),
      setActive: (v) => galaxyCalls.active.push(v),
      setFocus: () => {},
    }),
  });
  return { ctl, els, writes, galaxyCalls, getJson, postJson, storage, overview };
}

test("控制器：管理员可见时拉概览，写名单与读数带，把成员和筛选交给星图", async () => {
  const { ctl, els, writes, galaxyCalls, getJson } = setup();
  ctl.bind();
  ctl.onStatus({ teamAdmin: { isAdmin: true }, activeServerId: "s1" });
  await new Promise((r) => setImmediate(r));
  assert.equal(getJson.calls.length, 1);
  assert.match(getJson.calls[0][0], /\/api\/team\/overview\?serverId=s1/);
  const listWrites = writes.filter((w) => w.el === els.teamAdminList);
  assert.ok(listWrites.at(-1).html.includes('data-tm-member="alice"'));
  assert.ok(writes.some((w) => w.el === els.teamAdminKpis && w.html.includes("团队成员")));
  const last = galaxyCalls.update.at(-1);
  assert.equal(last.members.length, 1);
  assert.equal(last.opts.clusterName, "主集群");
  assert.equal(last.opts.matches(last.members[0]), true);
  assert.equal(galaxyCalls.active.at(-1), true);
});

test("控制器：列表 / 卡片切换记在本机，下次打开沿用", async () => {
  const storage = memoryStorage({ [TEAM_LAYOUT_STORAGE_KEY]: "cards" });
  const { ctl, els, writes } = setup({ storage });
  ctl.bind();
  ctl.onStatus({ teamAdmin: { isAdmin: true }, activeServerId: "s1" });
  await new Promise((r) => setImmediate(r));
  assert.ok(writes.filter((w) => w.el === els.teamAdminList).at(-1).html.includes('class="tm-cards"'), "读到上次的卡片排布");
  const btn = fakeElement({ tag: "button", dataset: { tmLayout: "list" }, parent: els.teamAdminLayoutToggle });
  await els.teamAdminLayoutToggle.dispatch("click", { target: btn });
  assert.equal(storage.map.get(TEAM_LAYOUT_STORAGE_KEY), "list");
  assert.ok(!writes.filter((w) => w.el === els.teamAdminList).at(-1).html.includes('class="tm-cards"'));
});

test("控制器：下发配置的请求体带 mode（修复 v2.68 缺字段被服务端拒收）", async () => {
  const { ctl, els, postJson } = setup();
  ctl.bind();
  ctl.onStatus({ teamAdmin: { isAdmin: true }, activeServerId: "s1" });
  await new Promise((r) => setImmediate(r));
  els.tmAssignUser.value = "alice";
  els.tmAssignCodexEnabled.checked = true;
  els.tmAssignClaudeEnabled.checked = false;
  els.tmAssignCodexProvider.value = "team";
  els.tmAssignCodexBaseUrl.value = "https://relay.example/v1";
  els.tmAssignCodexApiKey.value = "sk-secret";
  await els.teamAssignForm.dispatch("submit");
  const call = postJson.calls.find((c) => c[0] === "/api/team/assign");
  assert.ok(call, "发出了下发请求");
  assert.deepEqual(call[1].codex, { mode: "relay", apiKey: "sk-secret", baseUrl: "https://relay.example/v1", providerId: "team", providerName: "team" });
  assert.equal(call[1].claude, undefined);
  assert.equal(els.tmAssignCodexApiKey.value, "", "提交后清空密码框");
});

test("控制器：本机有上一份概览时先画出来，接口回来后替换并更新缓存", async () => {
  const { readCachedOverview, writeCachedOverview, TEAM_OVERVIEW_CACHE_PREFIX } = await import("./team-admin-controller.js");
  const storage = memoryStorage();
  const old = { checkedAt: 1, kpis: {}, members: [{ user: "olduser", onlineState: "offline", inRoster: true, assignment: { state: "none" }, usage: {}, compute: {} }] };
  assert.equal(writeCachedOverview(storage, "s1", old), true);
  assert.equal(readCachedOverview(storage, "s1").members[0].user, "olduser");
  assert.equal(readCachedOverview(storage, "s2"), null, "按服务器分开存");
  storage.map.set(`${TEAM_OVERVIEW_CACHE_PREFIX}bad`, "{not json");
  assert.equal(readCachedOverview(storage, "bad"), null, "坏数据不抛");

  const { ctl, els, writes } = setup({ storage });
  ctl.bind();
  ctl.onStatus({ teamAdmin: { isAdmin: true }, activeServerId: "s1" });
  const firstList = writes.find((w) => w.el === els.teamAdminList);
  assert.ok(firstList.html.includes('data-tm-chip="olduser"') || firstList.html.includes('data-tm-member="olduser"'), "接口还没回来就先渲染了缓存里的成员");
  await new Promise((r) => setImmediate(r));
  assert.ok(writes.filter((w) => w.el === els.teamAdminList).at(-1).html.includes('data-tm-member="alice"'), "接口回来后换成新数据");
  assert.equal(readCachedOverview(storage, "s1").members[0].user, "alice", "新数据写回缓存");
});

test("控制器：支持多维排序、自动推荐端口、一键批量纳管自动发现、自由多选配置下发与导出 CSV 报表", async () => {
  const { TEAM_SORT_STORAGE_KEY } = await import("./team-admin-controller.js");
  const storage = memoryStorage();
  const els = {
    teamAdminList: fakeElement(),
    teamAdminKpis: fakeElement(),
    teamSkySub: fakeElement(),
    teamSky: fakeElement(),
    teamAdminSortSelect: fakeElement({ tag: "select" }),
    teamAdminBatchOnboardBtn: fakeElement({ tag: "button" }),
    teamAdminBatchAssignBtn: fakeElement({ tag: "button" }),
    teamAdminExportBtn: fakeElement({ tag: "button" }),
    teamAdminAddMemberBtn: fakeElement({ tag: "button" }),
    tmRecommendPortBtn: fakeElement({ tag: "button" }),
    tmMemberUser: fakeElement({ tag: "input" }),
    tmMemberAssignedPort: fakeElement({ tag: "input" }),
    tmAssignUserPicker: fakeElement(),
    teamAssignForm: fakeElement({ tag: "form" }),
    tmAssignUser: fakeElement({ tag: "input" }),
    tmAssignPubkeyHint: fakeElement(),
    tmAssignCodexEnabled: fakeElement({ tag: "input" }),
    tmAssignClaudeEnabled: fakeElement({ tag: "input" }),
    tmAssignCodexProvider: fakeElement({ tag: "input" }),
    tmAssignCodexBaseUrl: fakeElement({ tag: "input" }),
    tmAssignCodexApiKey: fakeElement({ tag: "input" }),
  };
  const doc = fakeDocument(els);
  const writes = [];
  const csvDownloads = [];
  const overview = {
    serverName: "主集群",
    checkedAt: 1_800_000_000_000,
    kpis: { totalMembers: 3 },
    members: [
      { user: "kai", isSelf: true, onlineState: "tunnel-online", inRoster: true, assignedPort: 7891, activePort: 7891, assignment: { state: "applied" }, usage: { todayTokens: 100 }, compute: {} },
      { user: "alice", onlineState: "tunnel-online", inRoster: false, activePort: 7895, assignment: { state: "none" }, usage: { todayTokens: 9000 }, compute: {} },
      { user: "bob", onlineState: "ssh-only", inRoster: false, activePort: null, assignment: { state: "none" }, usage: { todayTokens: 500 }, compute: {} },
    ],
  };
  const getJson = spy(async () => overview);
  const postJson = spy(async () => ({ delivered: true, deliveredCount: 2, overview }));
  const ctl = createTeamAdminController({
    doc,
    getJson,
    postJson,
    showToast: () => {},
    isViewVisible: () => true,
    storage,
    writeHtml: (el, html) => writes.push({ el, html }),
    downloadCsv: (filename, csvText) => {
      csvDownloads.push({ filename, csvText });
      return true;
    },
    setTimer: () => 0,
    clearTimer: () => {},
    createGalaxy: () => ({ update: () => {}, setActive: () => {}, setFocus: () => {} }),
  });

  ctl.bind();
  ctl.onStatus({ teamAdmin: { isAdmin: true }, activeServerId: "s1" });
  await new Promise((r) => setImmediate(r));

  // 1. 排序切换：按 tokens 排序时 alice 排在 kai 前面
  els.teamAdminSortSelect.value = "tokens";
  await els.teamAdminSortSelect.dispatch("change", { target: els.teamAdminSortSelect });
  assert.equal(storage.map.get(TEAM_SORT_STORAGE_KEY), "tokens");
  const sortedHtml = writes.filter((w) => w.el === els.teamAdminList).at(-1).html;
  assert.ok(sortedHtml.indexOf('data-tm-member="alice"') < sortedHtml.indexOf('data-tm-member="kai"'));

  // 2. 添加成员弹窗自动填入推荐空闲端口（避开 7891, 7895 -> 7892）
  await els.teamAdminAddMemberBtn.dispatch("click");
  assert.equal(els.tmMemberAssignedPort.value, "7892");

  // 3. 一键批量纳管自动发现成员（alice + bob）
  assert.equal(els.teamAdminBatchOnboardBtn.hidden, false);
  assert.match(els.teamAdminBatchOnboardBtn.textContent, /一键纳管自动发现 \(2\)/);
  await els.teamAdminBatchOnboardBtn.dispatch("click");
  const onboardCall = postJson.calls.find((c) => c[0] === "/api/team/member");
  assert.ok(onboardCall);
  assert.deepEqual(onboardCall[1].members, [
    { user: "alice", displayName: "", assignedPort: 7895, note: "自动发现纳管", enabled: true },
    { user: "bob", displayName: "", assignedPort: 7892, note: "自动发现纳管", enabled: true },
  ]);

  // 4. 自由多选批量下发配置：默认预选未托管成员 alice, bob，再通过 picker 勾上 kai
  await els.teamAdminBatchAssignBtn.dispatch("click");
  assert.equal(els.tmAssignUser.value, "alice, bob");
  const pickCyBtn = fakeElement({ tag: "button", dataset: { tmPickUser: "kai" }, parent: els.tmAssignUserPicker });
  await els.tmAssignUserPicker.dispatch("click", { target: pickCyBtn });
  assert.equal(els.tmAssignUser.value, "alice, bob, kai");

  // 5. 导出 CSV 报表
  await els.teamAdminExportBtn.dispatch("click");
  assert.equal(csvDownloads.length, 1);
  assert.match(csvDownloads[0].filename, /^team-report-主集群-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(csvDownloads[0].csvText.includes("alice"));
});

test("控制器：批量纳管与批量下发都在 32 人处截断，并如实报数（不透支服务端上限）", async () => {
  const { TEAM_BATCH_MAX } = await import("./team-admin-controller.js");
  assert.equal(TEAM_BATCH_MAX, 32, "前端上限必须与服务端 TEAM_BATCH_MEMBER_MAX 一致");
  const members = Array.from({ length: 40 }, (_, i) => ({
    user: `u${i}`,
    onlineState: "tunnel-online",
    inRoster: false,
    activePort: null,
    registeredPorts: [],
    assignment: { state: "none" },
    usage: { todayTokens: 100 - i, todayCalls: 1 },
    compute: {},
  }));
  const overview = { serverName: "主集群", checkedAt: 1, kpis: { totalMembers: 40 }, members };
  const els = {
    teamAdminList: fakeElement(),
    teamAdminKpis: fakeElement(),
    teamSkySub: fakeElement(),
    teamSky: fakeElement(),
    teamAdminSortSelect: fakeElement({ tag: "select" }),
    teamAdminBatchOnboardBtn: fakeElement({ tag: "button" }),
    teamAdminBatchAssignBtn: fakeElement({ tag: "button" }),
    teamAdminExportBtn: fakeElement({ tag: "button" }),
    tmAssignUserPicker: fakeElement(),
    tmAssignUser: fakeElement({ tag: "input" }),
    tmAssignPubkeyHint: fakeElement(),
  };
  const doc = fakeDocument(els);
  const toasts = [];
  const postJson = spy(async () => ({ delivered: true, sealedCount: 30, pendingCount: 2, overview }));
  const ctl = createTeamAdminController({
    doc,
    getJson: async () => overview,
    postJson,
    showToast: (t) => toasts.push(t),
    isViewVisible: () => true,
    storage: memoryStorage(),
    writeHtml: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    createGalaxy: () => ({ update: () => {}, setActive: () => {}, setFocus: () => {} }),
  });
  ctl.bind();
  ctl.onStatus({ teamAdmin: { isAdmin: true }, activeServerId: "s1" });
  await new Promise((r) => setImmediate(r));

  // 按钮文案报的是"还剩多少位待纳管"，不是"本次提交多少位"
  assert.match(els.teamAdminBatchOnboardBtn.textContent, /一键纳管自动发现 \(40\)/);

  await els.teamAdminBatchOnboardBtn.dispatch("click");
  const onboard = postJson.calls.find((c) => c[0] === "/api/team/member");
  assert.ok(onboard, "应发出批量纳管请求");
  assert.equal(onboard[1].members.length, TEAM_BATCH_MAX, "单次最多提交 32 位，绝不能把 40 位发给只认 32 位的服务端");
  const onboardToast = toasts.at(-1);
  assert.match(onboardToast.message, /已将 32 位/, `完成提示必须说真实写入数：${onboardToast.message}`);
  assert.match(onboardToast.message, /剩余 8 位/, "必须告知还有剩余成员，不能宣称全部完成");

  // 批量下发：默认预选未托管成员时也要截断到 32
  await els.teamAdminBatchAssignBtn.dispatch("click");
  assert.equal(els.tmAssignUser.value.split(",").length, TEAM_BATCH_MAX, "预选名单同样封顶 32 人");
  assert.match(els.tmAssignPubkeyHint.textContent, /已达单次上限 32 人/);

  // 「全选」不得突破上限
  const allBtn = fakeElement({ tag: "button", dataset: { tmPickBatch: "all" }, parent: els.tmAssignUserPicker });
  await els.tmAssignUserPicker.dispatch("click", { target: allBtn });
  assert.equal(els.tmAssignUser.value.split(",").length, TEAM_BATCH_MAX, "全选 40 人必须被截断为 32 人");
});

test("控制器：支持一键批量回收闲置端口、复制成员诊断卡、配置预设保存填充及星图 KPI 与节点跳转联动", async () => {
  const { readAssignPresets } = await import("./team-admin-controller.js");
  const storage = memoryStorage();
  const els = {
    teamAdminList: fakeElement(),
    teamAdminKpis: fakeElement(),
    teamSkySub: fakeElement(),
    teamSky: fakeElement(),
    teamAdminSearchInput: fakeElement({ tag: "input" }),
    teamAdminSortSelect: fakeElement({ tag: "select" }),
    teamAdminBatchReleasePortsBtn: fakeElement({ tag: "button" }),
    teamAdminBatchAssignBtn: fakeElement({ tag: "button" }),
    tmAssignPresetBar: fakeElement(),
    tmAssignUserPicker: fakeElement(),
    tmAssignUser: fakeElement({ tag: "input" }),
    tmAssignCodexEnabled: fakeElement({ tag: "input" }),
    tmAssignClaudeEnabled: fakeElement({ tag: "input" }),
    tmAssignCodexProvider: fakeElement({ tag: "input" }),
    tmAssignCodexBaseUrl: fakeElement({ tag: "input" }),
    tmAssignCodexModel: fakeElement({ tag: "input" }),
    tmAssignCodexApiKey: fakeElement({ tag: "input" }),
  };
  const doc = fakeDocument(els);
  const copied = [];
  const toasts = [];
  const overview = {
    serverName: "主集群",
    checkedAt: 1_800_000_000_000,
    kpis: { totalMembers: 2 },
    members: [
      {
        user: "kai",
        displayName: "CY",
        isSelf: true,
        onlineState: "tunnel-online",
        tunnelOnline: true,
        inRoster: true,
        assignedPort: 7891,
        activePort: 7891,
        registeredPorts: [7891, 7899],
        assignment: { state: "applied", summary: { codex: { mode: "relay", providerId: "relay-a", baseUrl: "https://a.example/v1" } } },
        usage: { todayTokens: 500, todayCalls: 3 },
        compute: { gpuCount: 2, nodes: ["g01"] },
      },
      {
        user: "bob",
        onlineState: "offline",
        tunnelOnline: false,
        inRoster: true,
        registeredPorts: [7902],
        assignment: { state: "none" },
        usage: { todayTokens: 0 },
        compute: { gpuCount: 0, nodes: [] },
      },
    ],
  };
  const postJson = spy(async () => ({ released: true, overview }));
  const ctl = createTeamAdminController({
    doc,
    getJson: async () => overview,
    postJson,
    showToast: (t) => toasts.push(t),
    copyText: (t) => copied.push(t),
    isViewVisible: () => true,
    storage,
    writeHtml: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    createGalaxy: () => ({ update: () => {}, setActive: () => {}, setFocus: () => {} }),
  });

  ctl.bind();
  ctl.onStatus({ teamAdmin: { isAdmin: true }, activeServerId: "s1" });
  await new Promise((r) => setImmediate(r));

  // 1. 闲置端口检测与一键批量回收（7899 与 7902 共 2 个闲置端口）
  assert.equal(els.teamAdminBatchReleasePortsBtn.hidden, false);
  assert.equal(els.teamAdminBatchReleasePortsBtn.textContent, "回收闲置端口 (2)");
  await els.teamAdminBatchReleasePortsBtn.dispatch("click");
  const releaseCalls = postJson.calls.filter((c) => c[0] === "/api/team/release-port");
  assert.equal(releaseCalls.length, 2);
  assert.deepEqual(
    releaseCalls.map((c) => ({ user: c[1].user, port: c[1].port })),
    [
      { user: "kai", port: 7899 },
      { user: "bob", port: 7902 },
    ]
  );

  // 2. 复制成员诊断卡
  const diagBtn = fakeElement({ tag: "button", dataset: { tmCopyDiag: "kai" }, parent: els.teamAdminList });
  await els.teamAdminList.dispatch("click", { target: diagBtn });
  assert.equal(copied.length, 1);
  assert.match(copied[0], /团队成员状态诊断卡 · CY \(kai\)/);

  // 3. 点击节点胶囊按节点过滤，再次点击取消
  const nodeBtn = fakeElement({ tag: "button", dataset: { tmFilterNode: "g01" }, parent: els.teamAdminList });
  await els.teamAdminList.dispatch("click", { target: nodeBtn });
  assert.equal(els.teamAdminSearchInput.value, "g01");
  await els.teamAdminList.dispatch("click", { target: nodeBtn });
  assert.equal(els.teamAdminSearchInput.value, "");

  // 4. 点击星图底部 KPI 读数带切换排序
  const gpuKpi = fakeElement({ tag: "div", dataset: { tmKpiAction: "gpu" }, parent: els.teamSky });
  await els.teamSky.dispatch("click", { target: gpuKpi });
  assert.equal(els.teamAdminSortSelect.value, "gpu");

  // 5. 配置预设保存（不落明文 Key）与一键填充
  els.tmAssignCodexEnabled.checked = true;
  els.tmAssignClaudeEnabled.checked = false;
  els.tmAssignCodexProvider.value = "my-relay";
  els.tmAssignCodexBaseUrl.value = "https://my.relay/v1";
  els.tmAssignCodexModel.value = "gpt-5.3-codex";
  els.tmAssignCodexApiKey.value = "sk-do-not-save";
  const savePresetBtn = fakeElement({ tag: "button", dataset: { tmSavePreset: "" }, parent: els.tmAssignPresetBar });
  await els.tmAssignPresetBar.dispatch("click", { target: savePresetBtn });
  const saved = readAssignPresets(storage);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].codex.providerId, "my-relay");
  assert.equal(saved[0].codex.baseUrl, "https://my.relay/v1");
  assert.equal("apiKey" in saved[0].codex, false, "预设绝不保存明文 API Key");

  // 清空输入框后点击预设一键恢复
  els.tmAssignCodexProvider.value = "";
  els.tmAssignCodexBaseUrl.value = "";
  const applyPresetBtn = fakeElement({ tag: "button", dataset: { tmApplyPreset: "0" }, parent: els.tmAssignPresetBar });
  await els.tmAssignPresetBar.dispatch("click", { target: applyPresetBtn });
  assert.equal(els.tmAssignCodexProvider.value, "my-relay");
  assert.equal(els.tmAssignCodexBaseUrl.value, "https://my.relay/v1");
});

