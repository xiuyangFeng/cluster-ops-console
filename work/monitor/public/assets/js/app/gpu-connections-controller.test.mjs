import assert from "node:assert/strict";
import test from "node:test";
import { createGpuConnectionsController, GPU_SELECTION_KEY } from "./gpu-connections-controller.js";
import { fakeDocument, fakeElement } from "./test-support.mjs";

test("GPU 多选按节点账号分组并独立保存；改变全局查看连接不覆盖勾选", async () => {
  const elements = Object.fromEntries(["resGpuSection", "resGpuAccounts", "resGpuList", "resGpuSummary"].map((id) => [id, fakeElement()]));
  const doc = fakeDocument(elements);
  const items = new Map();
  const storage = { getItem: (key) => items.get(key), setItem: (key, value) => items.set(key, value) };
  const config = { servers: [{ id: "master", host: "master", sshUser: "kai" }, { id: "n4", host: "node04", sshUser: "user01", sshJumpServerId: "master" }] };
  const layers = { resources: { master: { checkedAt: Date.now(), gpu: [] }, n4: { checkedAt: Date.now(), gpu: [] } } };
  const status = { activeServerId: "master", layers };
  const controller = createGpuConnectionsController({ doc, storage, trend: false, paint: (el, html) => { el.innerHTML = html; } });
  controller.render(status, config);
  assert.match(elements.resGpuList.innerHTML, /data-gpu-server-id="master"/);
  assert.doesNotMatch(elements.resGpuList.innerHTML, /data-gpu-server-id="n4"/);
  await elements.resGpuAccounts.dispatch("change", { target: fakeElement({ dataset: { gpuConnection: "n4" }, checked: true }) });
  assert.match(elements.resGpuList.innerHTML, /kai@master/);
  assert.match(elements.resGpuList.innerHTML, /user01@node04/);
  assert.deepEqual(JSON.parse(items.get(GPU_SELECTION_KEY)), ["master", "n4"]);
  controller.render({ ...status, activeServerId: "n4" }, config);
  assert.match(elements.resGpuList.innerHTML, /data-gpu-server-id="master"/);
  await elements.resGpuAccounts.dispatch("change", { target: fakeElement({ dataset: { gpuConnection: "master" }, checked: false }) });
  assert.doesNotMatch(elements.resGpuList.innerHTML, /data-gpu-server-id="master"/);
  assert.match(elements.resGpuList.innerHTML, /data-gpu-server-id="n4"/);
  assert.equal(elements.resGpuAccounts.listenerCount("change"), 1);
});
