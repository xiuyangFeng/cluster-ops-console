import assert from "node:assert/strict";
import test from "node:test";
import { createJobNotificationsController } from "./job-notifications-controller.js";
import { deferred, fakeDocument, fakeElement, fakeTimers, flush } from "./test-support.mjs";

test("免打扰仍更新未读数；解除后不重放，浏览器权限仅由显式动作申请", async () => {
  let permissionCalls = 0;
  const notices = [];
  class Notification {
    static permission = "default";
    static async requestPermission() { permissionCalls += 1; Notification.permission = "granted"; }
    constructor(title) { notices.push(title); }
  }
  const count = fakeElement();
  const timers = fakeTimers();
  let quietUntil = 200;
  let notifications = [{ id: "a", title: "已完成", createdAt: 50, readAt: null }];
  const storage = new Map();
  const controller = createJobNotificationsController({
    doc: fakeDocument({ jobNotificationsCount: count }), BrowserNotification: Notification,
    storage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    now: () => 100, getJson: async () => ({ settings: { quietUntil }, notifications }), postJson: async () => ({}),
    setTimer: timers.setTimeout, clearTimer: timers.clearTimeout,
  });
  controller.bind();
  await controller.start();
  assert.equal(count.textContent, "1");
  assert.equal(permissionCalls, 0);
  await controller.requestBrowserPermission();
  assert.equal(permissionCalls, 1);
  quietUntil = 0;
  await controller.refresh();
  assert.deepEqual(notices, []);
  notifications = [{ id: "b", title: "新的完成", createdAt: 100, readAt: null }, ...notifications];
  await controller.refresh();
  await controller.refresh();
  assert.deepEqual(notices, ["新的完成"]);
  controller.stop();
});

test("桌面壳里前端只更新收件箱，不再重复发送系统通知或 Toast", async () => {
  let shown = 0;
  const timers = fakeTimers();
  const controller = createJobNotificationsController({
    doc: fakeDocument(), nativeDelivery: true, BrowserNotification: class { constructor() { shown += 1; } },
    storage: null, getJson: async () => ({ notifications: [{ id: "a", title: "完成" }] }),
    showToast: () => { shown += 1; }, setTimer: timers.setTimeout, clearTimer: timers.clearTimeout,
  });
  await controller.start();
  assert.equal(shown, 0);
  assert.equal(controller.state().data.notifications.length, 1);
  controller.stop();
});

// ---- v2.62：不属于关注组的失败提醒 + 浮层里的「提醒规则」 ----

// 可供 morphInnerHtml 写入的假正文：记下最后一次渲染的 HTML，事件用 dispatch 送进来。
function fakeBody() {
  let html = "";
  const body = fakeElement({ childNodes: [], ownerDocument: { createElement: () => ({ set innerHTML(value) { html = value; }, content: { childNodes: [] } }) } });
  return { body, html: () => html };
}
const failedNotice = (extra = {}) => ({ id: "f1", serverId: "s1", watchId: null, kind: "failed", title: "2 个作业失败", body: "2 个 KeyError: 'arm'。作业号 12、11。", jobIds: ["12", "11"], createdAt: 90, readAt: null, ...extra });
const serverRules = (rules = {}, suggestions = []) => ({ serverId: "s1", name: "主集群服务器 (myserver)", rules: { failNotify: true, longRunMinutes: null, patterns: [], ...rules }, suggestions });

test("失败提醒（watchId 为 null）：免打扰期间只进收件箱不弹通知，解除后不补发；平时弹出，点开定位到「我的历史」", async () => {
  const shown = [];
  class Notification {
    static permission = "granted";
    constructor(title, options) { this.title = title; this.options = options; shown.push(this); }
    close() {}
  }
  const count = fakeElement();
  const { body, html } = fakeBody();
  const timers = fakeTimers();
  const navigated = [];
  const posts = [];
  let quietUntil = 200;
  let notifications = [failedNotice({ intro: true })];
  const controller = createJobNotificationsController({
    doc: fakeDocument({ jobNotificationsCount: count, jobNotificationsBody: body }), BrowserNotification: Notification, storage: null,
    now: () => 100, getJson: async () => ({ settings: { quietUntil }, notifications, servers: [serverRules()] }),
    postJson: async (url, payload) => { posts.push([url, payload]); notifications = notifications.map((n) => ({ ...n, readAt: 100 })); return { settings: { quietUntil }, notifications, servers: [serverRules()] }; },
    onNavigate: (...args) => navigated.push(args), setTimer: timers.setTimeout, clearTimer: timers.clearTimeout,
  });
  controller.bind();
  await controller.start();
  assert.equal(count.textContent, "1", "免打扰时照样计入未读");
  assert.deepEqual(shown, [], "免打扰期间不弹");
  assert.match(html(), /免打扰中，新的提醒仍记录在这里。/);
  assert.match(html(), /<p class="jw-note">这是默认开启的失败提醒，可在提醒规则里关掉。<\/p>/, "头一条默认失败提醒未读时，浮层顶部说明来历");
  assert.ok(html().indexOf("这是默认开启的失败提醒") < html().indexOf("jw-notices"), "说明在列表上方");
  quietUntil = 0;
  await controller.refresh();
  assert.deepEqual(shown, [], "解除免打扰后不补发");

  notifications = [failedNotice({ id: "f2", title: "作业失败：train_d", jobIds: ["20"], createdAt: 100 }), ...notifications];
  await controller.refresh();
  assert.deepEqual(shown.map((n) => n.title), ["作业失败：train_d"]);
  shown[0].onclick();
  assert.deepEqual(navigated, [["s1", "20", "history"]], "失败提醒点开去我的历史");

  // 收件箱里点「查看作业」：同样带目标，并标为已读；读过之后顶部的说明不再出现。
  await body.dispatch("click", { target: fakeElement({ dataset: { noticeOpen: "f1" } }) });
  assert.deepEqual(navigated[1], ["s1", "12", "history"]);
  await Promise.resolve();
  assert.deepEqual(posts, [["/api/jobs/watch", { action: "ack", notificationId: "f1" }]]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(html(), /这是默认开启的失败提醒/);
  controller.stop();
});

test("关注组的提醒点开不带目标（先找关注列表），与原来一样", async () => {
  const { body } = fakeBody();
  const timers = fakeTimers();
  const navigated = [];
  const controller = createJobNotificationsController({
    doc: fakeDocument({ jobNotificationsBody: body }), nativeDelivery: true, storage: null,
    getJson: async () => ({ notifications: [{ id: "w1", serverId: "s1", watchId: "w", kind: "ended", title: "实验组 全部完成", jobIds: ["7"], createdAt: 1, readAt: 5 }] }),
    postJson: async () => ({}), onNavigate: (...args) => navigated.push(args), setTimer: timers.setTimeout, clearTimer: timers.clearTimeout,
  });
  controller.bind();
  await controller.start();
  await body.dispatch("click", { target: fakeElement({ dataset: { noticeOpen: "w1" } }) });
  assert.deepEqual(navigated, [["s1", "7"]]);
  controller.stop();
});

test("提醒规则：默认收起；展开后改开关 / 阈值 / 名字规则各自保存到那台服务器，回包并进当前数据；失败提示且不改动", async () => {
  const { body, html } = fakeBody();
  const timers = fakeTimers();
  const toasts = [];
  const posts = [];
  let reads = 0;
  let saved = { failNotify: true, longRunMinutes: null, patterns: [] };
  let failNext = false;
  const controller = createJobNotificationsController({
    doc: fakeDocument({ jobNotificationsBody: body }), nativeDelivery: true, storage: null,
    getJson: async () => { reads += 1; return { settings: { quietUntil: 0 }, notifications: [], servers: [serverRules(saved, [{ prefix: "xp_wallgate", pattern: "xp_wallgate*", count: 5 }])] }; },
    postJson: async (url, payload) => {
      posts.push([url, payload]);
      if (failNext) { failNext = false; throw Object.assign(new Error("HTTP 400"), { serverMessage: "名字规则最多 12 条" }); }
      // 与后端同样的合并：开关 / 阈值直接覆盖，名字规则只加 / 只删一条。
      const { action: _action, addPattern, removePattern, ...patch } = payload;
      saved = { ...saved, ...patch, patterns: [...saved.patterns.filter((p) => p !== removePattern), ...(addPattern && !saved.patterns.includes(addPattern) ? [addPattern] : [])] };
      return { serverId: "s1", rules: saved, suggestions: [], watches: [], notifications: [] };
    },
    showToast: (item) => toasts.push(item), setTimer: timers.setTimeout, clearTimer: timers.clearTimeout,
  });
  controller.bind();
  await controller.start();
  assert.match(html(), /data-rules-toggle="s1" aria-expanded="false">提醒规则<\/button><span class="jw-note">失败提醒已开 · 没有自动关注的规则<\/span>/);
  assert.doesNotMatch(html(), /jw-rules-body/);
  assert.ok(html().indexOf("jw-rules") < html().indexOf("还没有作业提醒"), "规则一节在收件箱列表上方");
  assert.match(html(), /我的作业失败时会自动记录在这里/);

  await body.dispatch("click", { target: fakeElement({ dataset: { rulesToggle: "s1" } }) });
  assert.match(html(), /aria-expanded="true"/);
  assert.match(html(), /data-rule-fail="s1"/);
  assert.equal(posts.length, 0, "展开 / 收起不发请求");

  // 关掉失败提醒
  await body.dispatch("change", { target: fakeElement({ dataset: { ruleFail: "s1" }, checked: false }) });
  assert.deepEqual(posts.at(-1), ["/api/jobs/watch?serverId=s1", { action: "rules", failNotify: false }]);
  assert.match(html(), /失败提醒已关/);
  assert.equal(controller.state().data.servers[0].rules.failNotify, false);
  assert.deepEqual(controller.state().data.servers[0].suggestions, [], "建议随回包更新");
  assert.match(html(), /aria-expanded="true"/, "保存后仍展开着");

  // 长作业阈值：填数字、清空、填不合格的
  await body.dispatch("change", { target: fakeElement({ dataset: { ruleLong: "s1" }, value: "120", checkValidity: () => true }) });
  assert.deepEqual(posts.at(-1)[1], { action: "rules", longRunMinutes: 120 });
  await body.dispatch("change", { target: fakeElement({ dataset: { ruleLong: "s1" }, value: "  ", checkValidity: () => true }) });
  assert.deepEqual(posts.at(-1)[1], { action: "rules", longRunMinutes: null });
  let reported = 0;
  const before = posts.length;
  await body.dispatch("change", { target: fakeElement({ dataset: { ruleLong: "s1" }, value: "3", checkValidity: () => false, reportValidity: () => { reported += 1; } }) });
  assert.deepEqual([posts.length, reported], [before, 1], "不合格的值由输入框自己提示，不发请求");

  // 名字规则：表单添加（成功后清空输入框）、重复的不发、建议一键加入、移除
  const input = { value: "  xp_*  " };
  const form = fakeElement({ dataset: { ruleAdd: "s1" }, elements: { pattern: input } });
  const submit = await body.dispatch("submit", { target: form });
  assert.equal(submit.defaultPrevented, true, "不让浏览器真的提交表单");
  assert.deepEqual(posts.at(-1)[1], { action: "rules", addPattern: "xp_*" }, "只发要加的那一条，不发整份列表");
  assert.equal(input.value, "");
  input.value = "xp_*";
  await body.dispatch("submit", { target: form });
  assert.equal(posts.length, before + 1, "已有的规则不重复提交");
  assert.match(toasts.at(-1).message, /已经有这条规则：xp_\*/);
  assert.equal(input.value, "xp_*", "没加成就不清空");
  await body.dispatch("submit", { target: fakeElement({ dataset: { ruleAdd: "s1" }, elements: { pattern: { value: "   " } } }) });
  assert.equal(posts.length, before + 1, "空的不提交");
  await body.dispatch("click", { target: fakeElement({ dataset: { ruleSuggest: "cfa-agiter20*", ruleServer: "s1" } }) });
  assert.deepEqual(posts.at(-1)[1], { action: "rules", addPattern: "cfa-agiter20*" });
  assert.deepEqual(controller.state().data.servers[0].rules.patterns, ["xp_*", "cfa-agiter20*"]);
  await body.dispatch("click", { target: fakeElement({ dataset: { ruleRemove: "xp_*", ruleServer: "s1" } }) });
  await flush();
  assert.deepEqual(posts.at(-1)[1], { action: "rules", removePattern: "xp_*" });
  assert.match(html(), /<code>cfa-agiter20\*<\/code>/);
  assert.doesNotMatch(html(), /<code>xp_\*<\/code>/);

  // 保存失败：提示后端给的原因，数据不动
  failNext = true;
  const kept = structuredClone(controller.state().data.servers[0].rules);
  assert.equal(await controller.addPattern("s1", "one_more_*"), false);
  assert.deepEqual([toasts.at(-1).type, toasts.at(-1).title, toasts.at(-1).message], ["error", "提醒规则", "名字规则最多 12 条"]);
  assert.deepEqual(controller.state().data.servers[0].rules, kept);
  assert.equal(await controller.mutateRules("unknown", { failNotify: true }), false, "不在列表里的服务器不发请求");
  assert.equal(reads, 1, "保存规则不额外读取；收件箱等下一次轮询");
  assert.equal(timers.timeouts.size, 1, "保存后轮询照常排着");
  controller.stop();
});

// ---- 2026-10-12 独立审查：表单不被重建、开关不弹回、「默认开启」那句随保存消失、加 / 删规则只发那一条 ----

// 给 morphInnerHtml 用的最小节点树：把渲染出的规整 HTML（属性值里没有裸的引号）解析成带 childNodes / attributes 的假节点，
// 修补真的跑在这棵树上——这样能断言「修补之后还是不是原来那个节点」。输入框被换成新节点 = 正在打的字和焦点丢了。
const VOID_TAGS = new Set(["input", "br", "hr", "img"]);
const parent = (node) => Object.assign(node, {
  childNodes: [],
  appendChild(child) { child.parentNode?.removeChild(child); child.parentNode = node; node.childNodes.push(child); return child; },
  replaceChild(next, cur) { next.parentNode?.removeChild(next); node.childNodes[node.childNodes.indexOf(cur)] = next; next.parentNode = node; cur.parentNode = null; return cur; },
  removeChild(child) { const i = node.childNodes.indexOf(child); if (i >= 0) node.childNodes.splice(i, 1); child.parentNode = null; return child; },
});
function parseHtml(html) {
  const element = (name, attrText) => {
    const attrs = new Map();
    for (const m of attrText.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs.set(m[1], m[2] ?? "");
    const node = parent({
      nodeType: 1, nodeName: name.toUpperCase(), parentNode: null, value: "", checked: false,
      get attributes() { return [...attrs].map(([n, value]) => ({ name: n, value })); },
      get dataset() { return Object.fromEntries([...attrs].filter(([n]) => n.startsWith("data-")).map(([n, v]) => [n.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase()), v])); },
      hasAttribute: (n) => attrs.has(n), getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
      setAttribute: (n, v) => { attrs.set(n, String(v)); }, removeAttribute: (n) => { attrs.delete(n); },
      remove() { node.parentNode?.removeChild(node); },
      closest(selector) { for (let at = node; at; at = at.parentNode) if (at.hasAttribute?.(selector.slice(1, -1))) return at; return null; },
    });
    return node;
  };
  const root = parent({ nodeType: 11, nodeName: "#document-fragment" });
  const stack = [root];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|[^>"])*)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      const text = { nodeType: 3, nodeName: "#text", nodeValue: m[4], parentNode: null, remove() { text.parentNode?.removeChild(text); } };
      stack.at(-1).appendChild(text);
    } else if (m[1]) stack.pop();
    else {
      const selfClosed = /\/\s*$/.test(m[3]);
      const node = element(m[2], m[3].replace(/\/\s*$/, ""));
      stack.at(-1).appendChild(node);
      if (!selfClosed && !VOID_TAGS.has(m[2].toLowerCase())) stack.push(node);
    }
  }
  assert.equal(stack.length, 1, "测试用的解析器只认标签配对的 HTML");
  return root;
}
const walk = (node, visit) => { for (const child of node.childNodes || []) { visit(child); walk(child, visit); } };
const textOf = (node) => { let out = node.nodeValue ?? ""; walk(node, (n) => { if (n.nodeType === 3) out += n.nodeValue; }); return out; };

// 浮层正文：事件走 fakeElement，子树是上面的假节点；find / all 在当前子树里找。
function domBody() {
  const body = parent(fakeElement({ nodeType: 1, nodeName: "DIV", ownerDocument: { createElement: () => ({ content: null, set innerHTML(value) { this.content = parseHtml(value); } }) } }));
  const all = (test) => { const out = []; walk(body, (n) => { if (n.nodeType === 1 && test(n)) out.push(n); }); return out; };
  body.querySelectorAll = (selector) => all((n) => n.hasAttribute(selector.slice(1, -1)));
  return { body, all, find: (test) => all(test)[0] ?? null, shown: () => all((n) => n.nodeName === "P" && !n.hasAttribute("hidden") && n.parentNode === body).map(textOf) };
}

test("审查 9：上方提示行来去（一次轮询失败、免打扰开始 / 到期、「默认开启」那句）不重建规则表单——正在打的规则、改到一半的阈值还在原来那个输入框里", async () => {
  const { body, find, shown } = domBody();
  const timers = fakeTimers();
  let quietUntil = 0;
  let failing = false;
  let notifications = [];
  const doc = fakeDocument({ jobNotificationsBody: body });
  const controller = createJobNotificationsController({
    doc, nativeDelivery: true, storage: null, now: () => 100,
    getJson: async () => { if (failing) throw new Error("HTTP 503"); return { settings: { quietUntil }, notifications, servers: [serverRules({ patterns: ["xp_*"] })] }; },
    postJson: async () => ({}), setTimer: timers.setTimeout, clearTimer: timers.clearTimeout,
  });
  controller.bind();
  await controller.start();
  await body.dispatch("click", { target: fakeElement({ dataset: { rulesToggle: "s1" } }) });
  const pattern = () => find((n) => n.getAttribute("name") === "pattern");
  const long = () => find((n) => n.hasAttribute("data-rule-long"));
  const fail = () => find((n) => n.hasAttribute("data-rule-fail"));
  const [input, threshold, toggle] = [pattern(), long(), fail()];
  assert.ok(input && threshold && toggle, "展开后三样控件都在");
  assert.deepEqual(shown(), [], "平时上方没有提示行");
  // 用户正在打一条规则；阈值改到一半、焦点还在它上面。
  input.value = "cfa-agi";
  threshold.value = "24";
  doc.activeElement = threshold;
  const intact = (when) => {
    // 用 === 比身份（assert.equal 失败时会把整棵假节点树打出来）。
    assert.ok(pattern() === input, `${when}：名字规则的输入框还是原来的节点`);
    assert.ok(long() === threshold, `${when}：阈值输入框还是原来的节点`);
    assert.ok(fail() === toggle, `${when}：开关还是原来的节点`);
    assert.deepEqual([input.value, threshold.value], ["cfa-agi", "24"], `${when}：打到一半的内容还在`);
  };
  failing = true;
  await controller.refresh();
  assert.deepEqual(shown(), ["提醒暂时无法刷新；稍后会自动重试。"]);
  intact("一次轮询失败");
  failing = false;
  quietUntil = 200;
  await controller.refresh();
  assert.deepEqual(shown(), ["免打扰中，新的提醒仍记录在这里。"]);
  intact("恢复、开始免打扰");
  quietUntil = 0;
  notifications = [failedNotice({ intro: true })];
  await controller.refresh();
  assert.deepEqual(shown(), ["这是默认开启的失败提醒，可在提醒规则里关掉。"]);
  intact("免打扰到期、来了头一条失败提醒");
  notifications = [failedNotice({ intro: true, readAt: 99 })];
  await controller.refresh();
  assert.deepEqual(shown(), []);
  intact("那条提醒读过之后");
  controller.stop();
});

test("审查 11：失败提醒开关在自己的保存进行中不弹回旧值，没存成才退回去；存过规则后「默认开启」那句当即消失，不等下一次轮询", async () => {
  const { body, find, shown } = domBody();
  const timers = fakeTimers();
  const toasts = [];
  const posts = [];
  let reads = 0;
  let pending = null;
  const controller = createJobNotificationsController({
    doc: fakeDocument({ jobNotificationsBody: body }), nativeDelivery: true, storage: null, now: () => 100,
    getJson: async () => { reads += 1; return { settings: { quietUntil: 0 }, notifications: [failedNotice({ intro: true })], servers: [serverRules()] }; },
    postJson: (_url, payload) => { posts.push(payload); pending = deferred(); return pending.promise; },
    showToast: (item) => toasts.push(item), setTimer: timers.setTimeout, clearTimer: timers.clearTimeout,
  });
  controller.bind();
  await controller.start();
  await body.dispatch("click", { target: fakeElement({ dataset: { rulesToggle: "s1" } }) });
  const toggle = find((n) => n.hasAttribute("data-rule-fail"));
  const summary = () => textOf(find((n) => n.getAttribute("class") === "jw-rules-head"));
  assert.equal(toggle.checked, true, "渲染后开关按数据设好");
  assert.deepEqual(shown(), ["这是默认开启的失败提醒，可在提醒规则里关掉。"]);

  // 用户点了一下：浏览器先把开关拨过去，再发 change。保存还在路上。
  toggle.checked = false;
  await body.dispatch("change", { target: toggle });
  await flush();
  assert.deepEqual(posts, [{ action: "rules", failNotify: false }]);
  assert.equal(toggle.checked, false, "保存在途：开关停在用户拨到的位置，不弹回去");
  assert.match(summary(), /失败提醒已关/, "标题行同步");
  pending.resolve({ serverId: "s1", rules: { failNotify: false, longRunMinutes: null, patterns: [] }, suggestions: [] });
  await flush();
  assert.equal(toggle.checked, false);
  assert.deepEqual(shown(), [], "自己存过规则了，「默认开启」那句当即拿掉");
  assert.equal(controller.state().data.notifications[0].intro, undefined);
  assert.equal(reads, 1, "没有为此多读一次");

  // 再拨回去，这次没存成：提示原因，开关退回到关。
  toggle.checked = true;
  await body.dispatch("change", { target: toggle });
  await flush();
  assert.equal(toggle.checked, true);
  pending.reject(Object.assign(new Error("HTTP 500"), { serverMessage: "写入失败" }));
  await flush();
  assert.equal(toasts.at(-1).message, "写入失败");
  assert.equal(toggle.checked, false, "没存成：退回原来的值");
  assert.match(summary(), /失败提醒已关/);
  assert.equal(controller.state().data.servers[0].rules.failNotify, false);
  controller.stop();
});

test("审查附带（保存规则）：加 / 删名字规则只发那一条——界面手里的列表可能是 30 秒前的，整份发回去会盖掉别处刚做的改动", async () => {
  const { body } = fakeBody();
  const timers = fakeTimers();
  const posts = [];
  // 这个窗口读到的是 ["a_*"]；之后别处（另一个窗口、服务器页的「停用这条规则」）把它改成了 ["b_*"]。
  let server = ["b_*"];
  const controller = createJobNotificationsController({
    doc: fakeDocument({ jobNotificationsBody: body }), nativeDelivery: true, storage: null,
    getJson: async () => ({ settings: { quietUntil: 0 }, notifications: [], servers: [serverRules({ patterns: ["a_*"] })] }),
    postJson: async (_url, payload) => {
      posts.push(payload);
      if (payload.patterns) server = payload.patterns;
      if (payload.addPattern && !server.includes(payload.addPattern)) server = [...server, payload.addPattern];
      if (payload.removePattern) server = server.filter((p) => p !== payload.removePattern);
      return { serverId: "s1", rules: { failNotify: true, longRunMinutes: null, patterns: server }, suggestions: [] };
    },
    setTimer: timers.setTimeout, clearTimer: timers.clearTimeout,
  });
  controller.bind();
  await controller.start();
  assert.equal(await controller.addPattern("s1", "c_*"), true);
  assert.deepEqual(posts.at(-1), { action: "rules", addPattern: "c_*" });
  assert.deepEqual(controller.state().data.servers[0].rules.patterns, ["b_*", "c_*"], "别处删掉的 a_* 没被带回来，别处加的 b_* 也没丢");
  await body.dispatch("click", { target: fakeElement({ dataset: { ruleRemove: "c_*", ruleServer: "s1" } }) });
  await flush();
  assert.deepEqual(posts.at(-1), { action: "rules", removePattern: "c_*" });
  assert.deepEqual(server, ["b_*"]);
  controller.stop();
});
