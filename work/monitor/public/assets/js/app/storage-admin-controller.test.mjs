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
