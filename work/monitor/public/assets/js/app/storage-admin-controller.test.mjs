import assert from "node:assert/strict";
import test from "node:test";
import { createStorageAdminController } from "./storage-admin-controller.js";

test("未配置节点入口预填独立账号、地址与非默认端口，保留扫描范围为空且不发起扫描", async () => {
  const listeners = {}, posts = [];
  const fields = { roots: { focus() { this.focused = true; } } };
  const details = { open: false };
  const form = { closest: () => details, querySelector: () => fields.roots };
  const body = { innerHTML: "", addEventListener: (event, fn) => { listeners[event] = fn; }, querySelector: () => form, querySelectorAll: () => [] };
  const controller = createStorageAdminController({
    doc: { hidden: false, getElementById: (id) => id === "storageAdminBody" ? body : id === "storageAdminPanel" ? {} : null, addEventListener() {} },
    getJson: async () => ({ setup: { id: "master" }, targets: [], connections: [
      { id: "node04", name: "node04", host: "203.0.113.4", port: 2222, sshUser: "root" },
    ] }),
    postJson: async (...args) => posts.push(args), storage: null,
  });
  controller.bind();
  controller.onStatus({ activeServerId: "master", teamAdmin: { isAdmin: true, sshUser: "root" } });
  await new Promise((resolve) => setImmediate(resolve));
  const button = { dataset: { saConfigure: "node04" } };
  listeners.click({ target: { closest: (selector) => selector === "[data-sa-configure]" ? button : null }, preventDefault() {} });
  assert.match(body.innerHTML, /value="node04-storage"/);
  assert.match(body.innerHTML, /value="node04" selected/);
  assert.match(body.innerHTML, /value="2222"/);
  assert.match(body.innerHTML, /name="roots" value=""/);
  assert.equal(details.open, true);
  assert.equal(fields.roots.focused, true);
  assert.deepEqual(posts, []);
});

test("管理入口跟随当前服务器与角色：root 所在服务器改变时重读，普通用户不再读取", async () => {
  let reads = 0;
  const controller = createStorageAdminController({
    doc: { getElementById: () => null, hidden: false },
    getJson: async () => { reads += 1; return { targets: [] }; },
    postJson: async () => {},
    storage: null,
  });
  const root = { activeServerId: "s1", teamAdmin: { isAdmin: true, sshUser: "root" } };
  controller.onStatus(root);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  controller.onStatus(root);
  assert.equal(reads, 1);
  controller.onStatus({ ...root, activeServerId: "s2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  controller.onStatus({ activeServerId: "s3", teamAdmin: { isAdmin: false, sshUser: "lin" } });
  controller.enter("storage");
  assert.equal(reads, 2);
});

test("无扫描时可见存储页也定时重读本机活动；不触发 SSH 动作，停止后清理计时器", async () => {
  let reads = 0, scheduled = null, cleared = 0;
  const posts = [];
  const controller = createStorageAdminController({ doc: { getElementById: () => null, hidden: false },
    getJson: async () => { reads++; return { targets: [] }; }, postJson: async (...args) => posts.push(args), storage: null,
    setTimer: (fn, ms) => { scheduled = { fn, ms }; return 1; }, clearTimer: () => { cleared++; } });
  controller.onStatus({ activeServerId: "master", teamAdmin: { isAdmin: true } });
  await new Promise((r) => setImmediate(r));
  assert.equal(scheduled.ms, 30_000);
  scheduled.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2);
  assert.deepEqual(posts, []);
  controller.stop();
  assert.ok(cleared > 0);
  controller.enter("storage");
  assert.equal(reads, 2);
});

test("可视化磁盘卡片定位、全部刷新与冷存储目录保存", async () => {
  const listeners = {};
  const posts = [];
  let refreshAllClick = null;
  const scrolled = [];
  const refreshAllBtn = { disabled: false, textContent: "全部刷新", addEventListener: (ev, fn) => { if (ev === "click") refreshAllClick = fn; } };
  const anchorEl = { dataset: { saAnchor: "disk:master:/data" }, classList: { contains: () => true }, scrollIntoView: (o) => scrolled.push(o) };
  const form = {
    querySelector: (sel) => {
      const vals = {
        '[name="id"]': "master", '[name="label"]': "master", '[name="connectionId"]': "",
        '[name="host"]': "203.0.113.10", '[name="port"]': "22",
        '[name="roots"]': "/public /data/user_data", '[name="additionalRoots"]': "",
        '[name="coldMounts"]': "/data",
      };
      return sel in vals ? { value: vals[sel] } : null;
    },
  };
  const body = {
    innerHTML: "",
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    querySelector: (sel) => sel === "[data-sa-target-form]" ? form : null,
    querySelectorAll: (sel) => sel === "[data-sa-anchor]" ? [anchorEl] : [],
  };
  const controller = createStorageAdminController({
    doc: {
      hidden: false,
      getElementById: (id) => id === "storageAdminBody" ? body : id === "storageAdminRefreshAll" ? refreshAllBtn : id === "storageAdminPanel" ? {} : null,
      addEventListener() {},
    },
    getJson: async () => ({
      setup: { id: "master" },
      targets: [
        { id: "master", label: "master", host: "203.0.113.10", roots: ["/public", "/data/user_data"], coldMounts: ["/data"], status: { state: "ok" } },
        { id: "node04", label: "node04", host: "203.0.113.11", roots: ["/mnt"], status: { state: "ok" } },
      ],
    }),
    postJson: async (url, payload) => {
      posts.push([url, payload]);
      if (url === "/api/storage-admin/targets") return { saved: true, target: payload, scopeChanged: false };
      return { id: payload?.targetId, status: { state: "ok" } };
    },
    storage: null,
  });
  controller.bind();
  controller.onStatus({ activeServerId: "master", teamAdmin: { isAdmin: true, sshUser: "lin" } });
  await new Promise((r) => setImmediate(r));

  // 点击磁盘可视化卡片定位并展开
  const focusBtn = { dataset: { saFocusDisk: "disk:master:/data" } };
  listeners.click({ target: { closest: (sel) => sel === "[data-sa-focus-disk]" ? focusBtn : null }, preventDefault() {} });
  assert.equal(scrolled.length, 1);

  // 保存含 coldMounts 的配置
  const saveBtn = { closest: (sel) => sel === "[data-sa-target-form]" ? form : null };
  listeners.click({ target: { closest: (sel) => sel === "[data-sa-save-target]" ? saveBtn : null }, preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posts[0][0], "/api/storage-admin/targets");
  assert.deepEqual(posts[0][1].coldMounts, ["/data"]);

  // 全部刷新并发触发所有节点刷新
  assert.equal(typeof refreshAllClick, "function");
  refreshAllClick();
  await new Promise((r) => setImmediate(r));
  const refreshed = posts.filter(([u]) => u === "/api/storage-admin/refresh").map(([, p]) => p.targetId);
  assert.deepEqual(refreshed.sort(), ["master", "node04"]);
});
