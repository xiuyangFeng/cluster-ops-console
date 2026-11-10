// 真实 Chromium 验证多节点账号勾选、逐卡详情、存储独立偏好；只使用内存数据，不发 SSH。
import assert from "node:assert/strict";

export async function runResourceAccountsBrowserSmoke({ BrowserWindow, baseUrl }) {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try {
    await win.loadURL(`${baseUrl}/resource-accounts-fixture`);
    const result = await win.webContents.executeJavaScript(`(${(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const until = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error("resource accounts timeout"); };
      document.head.innerHTML = '<meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/assets/css/storage-admin.css">';
      document.body.innerHTML = '<section id="resGpuSection"><div id="resGpuAccounts"></div><div id="resGpuSummary"></div><div id="resGpuList"></div></section><dialog id="dlgGpuCard"><h2 id="dlgGpuCardTitle"></h2><div id="dlgGpuCardBody"></div></dialog><section id="storageAdminPanel"><div id="storageAdminBody"></div></section>';
      const { createGpuConnectionsController } = await import("/assets/js/app/gpu-connections-controller.js");
      const { createGpuCardController } = await import("/assets/js/app/gpu-card-controller.js");
      const { createStorageAdminController } = await import("/assets/js/app/storage-admin-controller.js");
      const saved = new Map();
      const storage = { getItem: (k) => saved.get(k), setItem: (k, v) => saved.set(k, v) };
      const servers = [{ id: "master", name: "主集群", host: "master.example", sshUser: "kai" }, { id: "n4", name: "node04", host: "node04", sshUser: "user01", sshJumpServerId: "master" }];
      const card = (name, user) => ({ index: 0, uuid: name, name, memUsedMb: 500, memTotalMb: 24000, util: 30, users: [{ user, memMb: 500, procs: [{ pid: "42", memMb: 500, cmdline: `${name} train.py`, etimes: 3600 }] }] });
      let status = { activeServerId: "master", activeServer: servers[0], teamAdmin: { isAdmin: true }, layers: { resources: { master: { gpu: [card("master-card", "kai")] }, n4: { gpu: [card("node04-card", "user01")] } } } };
      const gpu = createGpuConnectionsController({ doc: document, storage, trend: false });
      const details = createGpuCardController({ doc: document, getStatus: () => status, openDialog: (id) => document.getElementById(id).showModal() });
      details.bind();
      gpu.render(status, { servers });
      document.querySelector('[data-gpu-connection="n4"]').click();
      assert(document.querySelectorAll(".gpu-connection").length === 2, "GPU 同时显示两个节点账号");
      document.querySelector('[data-gpu-server-id="n4"] [data-gpu-key]').click();
      assert(document.getElementById("dlgGpuCardTitle").textContent.includes("node04-card"), "详情来自所点节点，不随全局视角取错卡");
      document.getElementById("dlgGpuCard").close();
      status = { ...status, activeServerId: "n4", activeServer: servers[1] };
      gpu.render(status, { servers });
      assert(document.querySelectorAll(".gpu-connection").length === 2, "全局视角切换不重置多选");
      const overview = { key: { exists: true }, connections: servers, setup: { id: "s1", label: "", host: "", port: 22 }, targets: servers.map((s) => ({ id: s.id, label: s.name, sshUser: s.sshUser, host: s.host, roots: ["/mnt"], status: { state: "unknown" }, users: [], scans: [], jobs: [] })) };
      let posts = 0;
      const storageCtrl = createStorageAdminController({ doc: document, getJson: async () => overview, postJson: async () => { posts++; }, storage, isViewVisible: () => true, isHidden: () => false });
      storageCtrl.bind(); storageCtrl.onStatus(status);
      await until(() => document.querySelectorAll(".sa-target").length === 2);
      document.querySelector('[data-sa-target-tab="master"]').click();
      assert(document.querySelectorAll(".sa-target").length === 1, "存储取消一个选项只隐藏该组");
      assert(document.querySelectorAll(".gpu-connection").length === 2, "存储偏好与 GPU 独立");
      assert(posts === 0, "勾选和切换只看缓存，不触发扫描");
      storageCtrl.stop?.();
      return { groups: document.querySelectorAll(".gpu-connection").length, storageGroups: document.querySelectorAll(".sa-target").length };
    }).toString()})()`);
    assert.deepEqual(result, { groups: 2, storageGroups: 1 });
  } finally { win.destroy(); }
}
