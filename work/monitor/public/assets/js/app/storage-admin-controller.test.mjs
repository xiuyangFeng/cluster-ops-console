import assert from "node:assert/strict";
import test from "node:test";
import { createStorageAdminController } from "./storage-admin-controller.js";

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
