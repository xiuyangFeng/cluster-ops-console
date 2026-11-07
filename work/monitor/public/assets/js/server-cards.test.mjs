import assert from "node:assert/strict";
import test from "node:test";

import { applyServerFormValues, describeServerImpact, fieldErrorsText, formatServerCard, renderServerCardsHtml, serverFormValues } from "./server-cards.js";

test("describeServerImpact: 删除个人服务器说明不影响其它隧道", () => {
  const text = describeServerImpact({ id: "box", name: "腾讯云", source: "personal", tunnelEnabled: true });
  assert.match(text, /腾讯云/);
  assert.match(text, /其他服务器/);
  assert.match(text, /可恢复/);
});

test("renderServerCardsHtml: 卡片含测试/禁用/删除，不出现密码", () => {
  const html = renderServerCardsHtml({
    servers: [{
      id: "box",
      name: "腾讯云",
      address: "10.0.0.8",
      sshPort: 2222,
      sshUser: "ubuntu",
      source: "personal",
      state: "configured",
      tunnelEnabled: true,
      monitorEnabled: true,
    }],
  });
  assert.match(html, /腾讯云/);
  assert.match(html, /data-server-action="test"/);
  assert.match(html, /data-server-action="delete"/);
  assert.equal(html.includes("data-server-action=\"hostkey\""), false);
  const pending = renderServerCardsHtml({
    servers: [{ id: "box", name: "腾讯云", address: "10.0.0.8", source: "personal", state: "hostkey-required", lastTest: { code: "hostkey" } }],
  });
  assert.match(pending, /确认主机密钥/);
  assert.equal(html.includes("password"), false);
  assert.equal(html.includes("id_ed25519"), false);
});

test("formatServerCard / fieldErrorsText", () => {
  const model = formatServerCard({ id: "box", address: "10.0.0.8", sshPort: 22, sshUser: "ubuntu", source: "personal", state: "auth-failed" });
  assert.equal(model.state, "认证失败");
  assert.equal(model.canEdit, true);
  assert.match(fieldErrorsText({ errors: [{ field: "sshUser", message: "必填" }] }), /sshUser/);
});

test("团队卡隐藏编辑；编辑回填用完整对象", () => {
  const team = formatServerCard({ id: "server-01", name: "主集群", source: "team", remotePort: 7891 });
  assert.equal(team.canEdit, false);
  const html = renderServerCardsHtml({ servers: [{ id: "server-01", name: "主集群", source: "team", state: "configured" }] });
  assert.equal(html.includes("data-server-action=\"edit\""), false);
  const values = serverFormValues({
    id: "box",
    name: "腾讯云",
    address: "10.0.0.8",
    sshPort: 2222,
    sshUser: "ubuntu",
    remotePort: 7893,
    tunnel: false,
    disabled: true,
  });
  assert.deepEqual(values, {
    name: "腾讯云",
    address: "10.0.0.8",
    sshPort: 2222,
    sshUser: "ubuntu",
    remotePort: 7893,
    tunnel: false,
    monitor: false,
  });
  const fields = {};
  const form = {
    elements: {
      name: { set value(v) { fields.name = v; } },
      address: { set value(v) { fields.address = v; } },
      sshPort: { set value(v) { fields.sshPort = v; } },
      sshUser: { set value(v) { fields.sshUser = v; } },
      remotePort: { set value(v) { fields.remotePort = v; } },
      tunnel: { set checked(v) { fields.tunnel = v; } },
      monitor: { set checked(v) { fields.monitor = v; } },
      password: { set value(v) { fields.password = v; } },
    },
  };
  applyServerFormValues(form, values);
  assert.equal(fields.address, "10.0.0.8");
  assert.equal(fields.sshPort, 2222);
  assert.equal(fields.sshUser, "ubuntu");
  assert.equal(fields.remotePort, 7893);
  assert.equal(fields.password, "");
});

test("禁用与删除文案不同；默认新增仅监控", () => {
  const server = { id: "box", source: "personal", tunnel: true };
  assert.doesNotMatch(describeServerImpact(server, "disable"), /删除|7 天/);
  assert.match(describeServerImpact(server), /删除/);
  assert.equal(serverFormValues(null).tunnel, false);
  assert.equal(serverFormValues(null).remotePort, "");
});

import { clockText, connectionTestMessage, initServerRegistryUi, renderLocalResourcesHtml } from "./server-cards.js";

test("测试失败不能呈现成功；本机CPU未知不显示null或0", () => {
  assert.equal(connectionTestMessage({ ok: false, code: "auth", nextAction: "认证失败" }).type, "error");
  const html = renderLocalResourcesHtml({ host: { busyPct: null, memory: { usedBytes: 1048576, totalBytes: 2097152 } }, topProcesses: [{ name: "app", cpuPct: null, rssBytes: 1024 }] });
  assert.match(html, /CPU 未知/);
  assert.match(html, /内存 1 MiB \/ 2 MiB/, "字节走 store.formatBytes（1024 进制）");
  assert.match(html, /RSS 1 KiB/, "小于 1 MiB 不再被取整成 0 MB");
  assert.match(renderLocalResourcesHtml({}), /内存 未知 \/ 未知.*监控进程 RSS 未知/s, "缺字段仍显示「未知」");
  assert.doesNotMatch(html, /null%/);
});

test("时间戳显示为本机时刻而不是 UTC 原文：当天只写时分秒，跨天带日期，坏值原样返回", () => {
  const now = new Date(2026, 9, 3, 18, 40, 0).getTime();
  const sameDay = new Date(2026, 9, 3, 18, 29, 6).toISOString();
  const otherDay = new Date(2026, 9, 2, 9, 5, 0).toISOString();
  assert.equal(clockText(sameDay, now), "18:29:06");
  assert.equal(clockText(otherDay, now), "10-02 09:05");
  assert.equal(clockText(new Date(2026, 9, 3, 7, 1, 2).getTime(), now), "07:01:02", "毫秒数同样接受");
  assert.equal(clockText("not-a-date", now), "not-a-date");
  const html = renderLocalResourcesHtml({ observedAt: new Date().toISOString() });
  assert.match(html, /采样于 \d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(html, /\d{4}-\d{2}-\d{2}T/, "不再出现 ISO 原文");
  assert.match(renderLocalResourcesHtml({}), /等待采样/);
  const card = formatServerCard({ id: "box", lastTest: { ok: true, code: "ok", checkedAt: new Date().toISOString() } });
  assert.match(card.lastTest, /^测试成功 · \d{2}:\d{2}:\d{2}$/);
});

function uiHarness(t, overrides = {}) {
  const handlers = {};
  const element = id => ({ innerHTML: "", textContent: "", hidden: false, disabled: false, querySelectorAll: () => [], addEventListener: (name, fn) => { handlers[`${id}:${name}`] = fn; } });
  const form = element("form");
  form.elements = Object.fromEntries(["name", "address", "sshPort", "sshUser", "remotePort", "password", "monitor", "tunnel"].map(name => [name, { value: "", checked: false, addEventListener() {} }]));
  form.elements.address.value = "box.invalid";
  form.elements.sshUser.value = "me";
  form.elements.monitor.checked = true;
  form.reset = () => { for (const field of Object.values(form.elements)) { field.value = ""; field.checked = false; } };
  const nodes = { serverRegistryList: element("list"), serverRegistryForm: form, serverRegistryHint: element("hint"), serverRegistryCancelBtn: element("cancel") };
  const previousDocument = globalThis.document, previousFormData = globalThis.FormData;
  globalThis.document = { getElementById: id => nodes[id] };
  globalThis.FormData = class { constructor(target) { this.target = target; } entries() { return Object.entries(this.target.elements).flatMap(([name, field]) => ["monitor", "tunnel"].includes(name) ? (field.checked ? [[name, "on"]] : []) : (field.disabled ? [] : [[name, field.value]]))[Symbol.iterator](); } };
  t.after(() => { globalThis.document = previousDocument; globalThis.FormData = previousFormData; });
  let payload = { revision: 1, servers: [{ id: "box", address: "box.invalid", sshUser: "me", source: "personal", tunnel: false }] };
  const notices = [], calls = [];
  const ui = initServerRegistryUi({
    getJson: async () => payload,
    postJson: async (...args) => { calls.push(args); return { id: "box", revision: 2 }; },
    patchJson: async (...args) => { calls.push(args); return { id: "box", revision: 2 }; },
    deleteJson: async (...args) => { calls.push(args); return { revision: 2 }; },
    showToast: message => notices.push(message), confirm: () => true, ...overrides,
  });
  const click = action => handlers["list:click"]({ target: { closest: () => ({ dataset: { serverAction: action }, closest: () => ({ dataset: { serverId: "box" } }) }) } });
  const submit = () => handlers["form:submit"]({ preventDefault() {} });
  return { ui, form, nodes, notices, calls, click, submit, setPayload: value => { payload = value; } };
}

test("编辑版本冻结，后台刷新不覆盖expectedRevision", async t => {
  const h = uiHarness(t);
  await h.ui.refresh(); await h.click("edit");
  h.setPayload({ revision: 9, servers: [] }); await h.ui.refresh();
  await h.submit();
  assert.equal(h.calls[0][1].expectedRevision, 1);
});

test("别处改了个人层（版本号 +1）但被编辑的这台没变：重读后保存基线跟到新版本，不撞「配置已被修改」", async t => {
  const h = uiHarness(t);
  const box = { id: "box", address: "box.invalid", sshUser: "me", source: "personal", tunnel: false };
  await h.ui.refresh(); await h.click("edit");
  // 例如切换了查看的服务器 / 开关了一个监控模块：servers 条目原样，只是 revision 变了。
  h.setPayload({ revision: 2, servers: [{ ...box, lastTest: { ok: true } }] }); await h.ui.refresh();
  assert.equal(h.ui.getRevision(), 2);
  await h.submit();
  assert.equal(h.calls[0][1].expectedRevision, 2, "运行态字段（lastTest 等）变化不算这台被改");
});

test("被编辑的这台在别处被改过：重读后保存基线不动，保存时照常报冲突（不悄悄覆盖）", async t => {
  const h = uiHarness(t);
  await h.ui.refresh(); await h.click("edit");
  h.setPayload({ revision: 2, servers: [{ id: "box", address: "box.invalid", sshUser: "someone-else", source: "personal", tunnel: false }] });
  await h.ui.refresh();
  await h.submit();
  assert.equal(h.calls[0][1].expectedRevision, 1);
});

test("版本冲突（revision-conflict）：自动重读列表并提示再操作一次，不当成失败、也不替用户重试", async t => {
  let reads = 0, payload = { revision: 1, servers: [{ id: "box", address: "box.invalid", sshUser: "me", source: "personal", tunnel: false }] };
  const posts = [];
  const h = uiHarness(t, {
    getJson: async () => { reads += 1; return payload; },
    postJson: async (url, body) => {
      posts.push([url, body]);
      if (body?.expectedRevision === 1) throw Object.assign(new Error("配置已被修改，请重新加载后保存"), { status: 409, code: "revision-conflict" });
      return { id: "box", revision: 3 };
    },
  });
  await h.ui.refresh();
  payload = { ...payload, revision: 2 }; // 个人层在别处被改，界面还拿着 1
  const before = reads;
  await h.click("disable");
  assert.equal(posts.length, 1, "冲突后不自动重发");
  assert.equal(reads, before + 1, "自动重读一次");
  assert.equal(h.ui.getRevision(), 2);
  assert.match(h.nodes.serverRegistryHint.textContent, /已载入最新内容；请确认后再操作一次/);
  assert.equal(h.notices.at(-1).type, "info");
  await h.click("disable");
  assert.equal(posts[1][1].expectedRevision, 2, "再点一次用的是最新版本");
  assert.equal(h.ui.isBusy(), false);
});

test("其它 409（不是版本冲突）仍按失败提示，不触发重读", async t => {
  let reads = 0;
  const h = uiHarness(t, {
    getJson: async () => { reads += 1; return { revision: 1, servers: [{ id: "box", address: "box.invalid", sshUser: "me", source: "personal", tunnel: false }] }; },
    postJson: async () => { throw Object.assign(new Error("端口已被占用"), { status: 409, code: "port-taken", serverMessage: "端口已被占用" }); },
  });
  await h.ui.refresh();
  const before = reads;
  await h.click("enable");
  assert.equal(reads, before);
  assert.equal(h.notices.at(-1).type, "error");
});

test("服务器已保存但凭据失败后重试仍PATCH同id，密码立即清空", async t => {
  const calls = [];
  let failCredential = true;
  const h = uiHarness(t, {
    postJson: async (url, body) => {
      calls.push(["POST", url, body]);
      assert.equal(h.form.elements.password.value, "");
      if (url.endsWith("credentials") && failCredential) throw new Error("vault unavailable");
      return { id: "box", revision: 2 };
    },
    patchJson: async (url, body) => { calls.push(["PATCH", url, body]); return { id: "box", revision: 3 }; },
  });
  await h.ui.refresh(); h.form.elements.password.value = "once"; await h.submit();
  failCredential = false; h.form.elements.password.value = "again"; await h.submit();
  assert.equal(calls.filter(([method, url]) => method === "POST" && url === "/api/servers").length, 1);
  assert.equal(calls.some(([method]) => method === "PATCH"), true);
});

test("进行中的连接测试不重复提交且ok:false toast为error", async t => {
  let resolve, calls = 0;
  const pending = new Promise(r => { resolve = r; });
  const h = uiHarness(t, { postJson: async () => { calls++; return pending; } });
  await h.ui.refresh(); const first = h.click("test"); const duplicate = h.click("test");
  resolve({ ok: false, code: "auth" }); await Promise.all([first, duplicate]);
  assert.equal(calls, 1);
  assert.equal(h.notices[0].type, "error");
});

test("删除正在编辑的服务器会退出编辑，避免后续保存向已删除id发PATCH", async t => {
  let refreshed = 0;
  const h = uiHarness(t, { onChanged: async () => { refreshed++; } });
  await h.ui.refresh();
  await h.click("edit");
  await h.click("delete");
  assert.equal(refreshed, 1);
  assert.equal(h.nodes.serverRegistryCancelBtn.hidden, true);
  assert.match(h.nodes.serverRegistryHint.textContent, /相关事件.*7 天/);
  h.form.elements.address.value = "new.invalid";
  h.form.elements.sshUser.value = "me";
  await h.submit();
  assert.equal(h.calls[1][0], "/api/servers");
});
