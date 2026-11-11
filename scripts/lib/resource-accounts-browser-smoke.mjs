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
      const servers = [{ id: "master", name: "主集群", host: "master.example", port: 22, sshUser: "kai" }, { id: "n4", name: "node04", host: "node04", port: 2204, sshUser: "user01", sshJumpServerId: "master" }];
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
      let posts = 0, reads = 0, savedTarget = null;
      const storageCtrl = createStorageAdminController({ doc: document, getJson: async () => { reads++; return overview; }, postJson: async (url, payload) => {
        assert(url === "/api/storage-admin/targets", "编辑目录不应自动生成密钥、安装或扫描");
        posts++;
        if (posts === 1) throw new Error("模拟保存失败，重试应保留填写内容");
        savedTarget = payload;
        overview.targets = overview.targets.map((t) => t.id === payload.id ? { ...t, ...payload, status: { state: "outdated", code: "roots-update" } } : t);
        return { saved: true, target: payload, scopeChanged: true };
      }, storage, isViewVisible: () => true, isHidden: () => false });
      storageCtrl.bind(); storageCtrl.onStatus(status);
      await until(() => document.querySelectorAll(".sa-target").length === 2);
      document.querySelector('[data-sa-target-tab="master"]').click();
      assert(document.querySelectorAll(".sa-target").length === 1, "存储取消一个选项只隐藏该组");
      assert(document.querySelectorAll(".gpu-connection").length === 2, "存储偏好与 GPU 独立");
      assert(posts === 0, "勾选和切换只看缓存，不触发扫描");
      document.querySelector('[data-sa-configure="n4"]').click();
      const form = document.querySelector('[data-sa-target-form]');
      assert(form.querySelector('[name="connectionId"]').value === "n4", "未配置节点可直接绑定已有账号");
      assert(form.querySelector('[name="host"]').value === "node04", "带入节点地址");
      assert(form.querySelector('[name="port"]').value === "2204", "保留非默认 SSH 端口");
      assert(form.querySelector('[name="roots"]').value === "", "扫描目录由管理员选择");
      assert(form.closest("details").open, "点击后展开配置表单");
      assert(posts === 0, "配置入口不自动保存或扫描");
      document.querySelector('[data-sa-edit-target="n4"]').click();
      const editor = () => document.querySelector('[data-sa-target-form]');
      assert(editor().querySelector('[name="roots"]').value === "/mnt", "管理目录保留原有范围");
      assert(editor().querySelector('[name="id"]').readOnly, "管理目录不会意外更换节点标识");
      const extra = editor().querySelector('[name="additionalRoots"]');
      extra.value = "/data /mnt"; extra.dispatchEvent(new Event("input", { bubbles: true }));
      extra.focus(); extra.setSelectionRange(3, 3);
      const before = reads; storageCtrl.enter("storage");
      await until(() => reads > before);
      await new Promise((r) => setTimeout(r, 20));
      assert(editor().querySelector('[name="additionalRoots"]').value === "/data /mnt", "重读概览不会清掉未保存目录");
      assert(document.activeElement.name === 'additionalRoots' && document.activeElement.selectionStart === 3, '活动轮询保留正在编辑的焦点与光标');
      document.querySelector('[data-sa-save-target]').click();
      await until(() => posts === 1 && !document.querySelector('[data-sa-save-target]').disabled);
      assert(editor().querySelector('[name="additionalRoots"]').value === "/data /mnt", "保存失败保留追加输入");
      document.querySelector('[data-sa-save-target]').click();
      await until(() => posts === 2 && document.querySelector('[data-sa-guide-stage="scope"]'));
      assert(savedTarget.id === "n4" && savedTarget.roots.join(" ") === "/mnt /data", "同一节点追加目录并去重，不丢掉原目录");
      assert(document.querySelector('[data-sa-installer="n4"]').textContent.includes("目录授权"), "保存后引导更新服务器授权");
      const sampleAt = Date.now();
      const n4 = overview.targets.find((t) => t.id === 'n4');
      n4.status = { state: 'ok' };
      n4.info = { roots: [{ path: '/mnt', children: [] }, { path: '/data', children: [] }], mounts: [{ mount: '/mnt', fs: 'ext4', size: 8 * 1024 ** 3, used: 4 * 1024 ** 3, avail: 4 * 1024 ** 3 }] };
      n4.users = [{ mount: '/mnt', source: 'inode', used: 4 * 1024 ** 3, size: 8 * 1024 ** 3, rows: [{ uid: 1029, name: 'active-student', account: 'user', bytes: 2 * 1024 ** 3, files: 42, share: 0.5,
        lastLogin: sampleAt / 1000 - 44 * 86400, lastWrite: sampleAt / 1000 - 400 * 86400,
        activity: { active: true, sshOnline: true, runningJobs: 2, checkedAt: sampleAt, expiresAt: sampleAt + 150000, lastObservedAt: sampleAt } }] }];
      storageCtrl.enter('storage');
      await until(() => document.querySelector('.sa-activity')?.textContent.includes('2 项作业运行中'));
      assert(document.querySelector('.sa-ranked').textContent.includes('44 天前'), '旧系统记录仍按来源展示');
      assert(!document.querySelector('[data-idle="true"]'), '有近期活动的用户不标为疑似不活跃');
      storageCtrl.stop?.();
      return { groups: document.querySelectorAll(".gpu-connection").length, storageGroups: document.querySelectorAll(".sa-target").length };
    }).toString()})()`);
    assert.deepEqual(result, { groups: 2, storageGroups: 1 });
    win.setSize(520, 820);
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 100 && window.innerWidth > 520; i++) await new Promise((r) => setTimeout(r, 20));
      document.querySelector('[data-sa-edit-target="n4"]').click();
      const form = document.querySelector('[data-sa-target-form]');
      if (!form.closest('details').open || !form.querySelector('[name="additionalRoots"]')) throw new Error('窄窗口目录编辑未展开');
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 2) throw new Error('目录编辑在窄窗口横向溢出');
    })()`);
  } finally { win.destroy(); }
}
