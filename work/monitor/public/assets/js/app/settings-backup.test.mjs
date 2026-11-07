import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildBackupInfoHtml,
  buildImportPreviewHtml,
  buildImportResultHtml,
  createSettingsBackup,
  formatStamp,
  IMPORT_FILE_MAX_BYTES,
  SSH_KEYS_NOTE,
} from "./settings-backup.js";
import { fakeDocument, fakeElement, spy } from "./test-support.mjs";

const CHANGES = [
  { id: "personal.egress", section: "personal", field: "egress", label: "出网方式", kind: "changed", ports: false, before: '{"mode":"direct"}', after: '{"mode":"system"}', note: "", available: true, reason: "" },
  { id: "servers.server-old", section: "personal", field: "servers", label: "服务器 old", kind: "removed", ports: false, before: "{}", after: "（没有）", note: "导出文件里没有这一条；不勾就留在这台电脑上。", available: true, reason: "" },
  { id: "servers.server-tunnel", section: "personal", field: "servers", label: "服务器 隧道机", kind: "removed", ports: true, before: '{"remotePort":7894}', after: "（没有）", note: "勾上会把它从这台电脑删掉，它的隧道随即断开。", available: true, reason: "" },
  { id: "personal.sshUser", section: "personal", field: "sshUser", label: "集群用户名", kind: "added", ports: false, before: "（没有）", after: "amy", note: "", available: true, reason: "" },
  { id: "portOverrides.server-01", section: "personal", field: "portOverrides", label: "server-01 的隧道端口（portOverrides）", kind: "changed", ports: true, before: '{"remotePort":7899}', after: '{"remotePort":7893}', note: "", available: true, reason: "" },
  { id: "jobAlerts.server-x", section: "jobAlerts", field: "jobAlerts", label: "server-x 的作业提醒规则", kind: "changed", ports: false, before: "{}", after: "{}", note: "", available: false, reason: "这台电脑上还没有这台服务器" },
];
const PREVIEW = {
  meta: { exportedAt: "2026-10-14T01:05:07.000Z", appVersion: "2.64.0", formatVersion: 1 },
  revision: 7,
  changes: CHANGES,
  defaultSelected: ["personal.egress", "personal.sshUser"],
};

test("说明区：导出包含 / 不包含什么、写前备份在哪（北京时间的备份时刻）", () => {
  const html = buildBackupInfoHtml({ includesJobAlerts: true, excluded: ["代理口令", "SSH 私钥与 ~/.ssh 下的任何文件"], backups: { dir: "/data/config-backups", keep: 5, count: 2, latest: { stamp: "20261014-090507" } } });
  assert.match(html, /各服务器的作业提醒规则/);
  assert.match(html, /<li>代理口令<\/li>/);
  assert.match(html, /最近 5 份，现有 2 份，最近一份 2026-10-14 09:05:07/);
  assert.match(html, /<code>\/data\/config-backups<\/code>/);
  assert.equal(formatStamp("20261014-090507-2"), "2026-10-14 09:05:07");
  assert.match(buildBackupInfoHtml(null), /打开后读取/);
  assert.match(SSH_KEYS_NOTE, /~\/\.ssh 下的密钥.*要另外拷过去/);
});

test("预览：普通改动、端口（默认不勾、带后果说明）、暂时导入不了的分组；按勾选数显示按钮", () => {
  const html = buildImportPreviewHtml(PREVIEW, new Set(PREVIEW.defaultSelected), { fileName: "cfg.json" });
  assert.match(html, /cfg\.json（v2\.64\.0，导出于 2026-10-14 09:05（北京时间））/);
  const groups = [...html.matchAll(/<p class="bk-group-title">([^<]+)<\/p>/g)].map((m) => m[1]);
  assert.deepEqual(groups, ["将改动的配置", "端口（默认不导入）", "本机有、文件里没有（默认保留）", "暂时导入不了"]);
  assert.match(html, /data-bk-change="personal\.egress" checked/);
  assert.match(html, /data-bk-change="servers\.server-old">/, "删除默认不勾");
  assert.match(html, /data-bk-change="servers\.server-tunnel">/, "删除带隧道的服务器默认不勾");
  assert.match(html, /默认留在这台电脑上，勾上才删除/);
  const removalGroup = html.slice(html.indexOf("本机有、文件里没有"), html.indexOf("暂时导入不了"));
  assert.ok(removalGroup.includes("servers.server-tunnel") && removalGroup.includes("servers.server-old"), "删除都在这一组（带隧道的不进端口组）");
  assert.match(removalGroup, /<li class="bk-change is-ports">/, "带隧道的删除仍按端口改动着色");
  assert.match(html, /data-bk-change="portOverrides\.server-01">/, "端口默认不勾");
  assert.match(html, /data-bk-change="jobAlerts\.server-x" disabled/);
  assert.match(html, /这台电脑上还没有这台服务器/);
  assert.match(html, /<span class="bk-kind" data-kind="removed">删除<\/span>/);
  assert.match(html, /<p class="bk-warn">这些会改这台电脑的隧道端口/, "端口一组开头说明后果");
  assert.match(html, /<div class="bk-values"><code>\{\}<\/code><\/div>/, "删除只写原值");
  assert.match(html, /导入所选（2 项）/);
  assert.match(buildImportPreviewHtml(PREVIEW, new Set()), /data-bk-apply disabled/);
  assert.match(buildImportPreviewHtml({ changes: [] }, new Set()), /没有要改的/);
  // 文件里的内容只当文本显示。
  const evil = buildImportPreviewHtml({ changes: [{ ...CHANGES[0], label: "<img src=x onerror=alert(1)>", after: "<script>" }] }, new Set());
  assert.doesNotMatch(evil, /<img|<script>/);
});

test("结果：导入了几项、备份名、跳过的条目与原因", () => {
  const html = buildImportResultHtml({ applied: ["personal.egress"], skipped: [{ id: "jobAlerts.server-x", reason: "服务器不在作业采集范围" }], backup: { name: "config.local.20261014-090507.json" } }, CHANGES);
  assert.match(html, /已导入 1 项；导入前的配置已备份为 <code>config\.local\.20261014-090507\.json<\/code>/);
  assert.match(html, /<li>server-x 的作业提醒规则：服务器不在作业采集范围<\/li>/);
});

function harness({ electronAPI = null, preview = PREVIEW, applyResult = { success: true, applied: ["personal.egress"], skipped: [], backup: { name: "b.json" } } } = {}) {
  const panel = fakeElement();
  panel.querySelector = (selector) => (selector === "[data-bk-apply]" ? panel.applyButton : null);
  panel.applyButton = fakeElement({ tag: "button" });
  const elements = {
    backupInfo: fakeElement(),
    backupImportPanel: panel,
    backupExportBtn: fakeElement({ tag: "button" }),
    backupImportBtn: fakeElement({ tag: "button" }),
    backupImportFile: fakeElement({ tag: "input" }),
    backupSshNote: fakeElement(),
  };
  const doc = fakeDocument(elements);
  const getJson = spy(async (path) => {
    if (path === "/api/config/transfer") return { excluded: ["代理口令"], backups: { dir: "/d/config-backups", keep: 5, count: 0, latest: null } };
    if (path === "/api/config/export") return { filename: "cluster-workbench-config-20261014-0905.json", document: { format: "cluster-workbench-config", formatVersion: 1 } };
    throw new Error(`unexpected ${path}`);
  });
  const postJson = spy(async (path) => (path === "/api/config/import/preview" ? preview : applyResult));
  const toasts = [];
  const downloads = [];
  const onImported = spy(async () => {});
  const ui = createSettingsBackup({
    doc, getJson, postJson, showToast: (t) => toasts.push(t), electronAPI, onImported,
    download: (name, content) => downloads.push([name, content]),
  });
  return { ui, elements, panel, getJson, postJson, toasts, downloads, onImported };
}

const file = (text, name = "cfg.json") => ({ name, size: Buffer.byteLength(text), text: async () => text });

test("导出：网页里走浏览器下载（带缩进的 JSON）；桌面窗口里交给保存对话框", async () => {
  const web = harness();
  assert.equal(web.elements.backupSshNote.textContent, SSH_KEYS_NOTE);
  await web.ui.onOpen();
  assert.match(web.elements.backupInfo.innerHTML, /代理口令/);
  await web.elements.backupExportBtn.dispatch("click");
  assert.equal(web.downloads.length, 1);
  assert.equal(web.downloads[0][0], "cluster-workbench-config-20261014-0905.json");
  assert.equal(JSON.parse(web.downloads[0][1]).format, "cluster-workbench-config");
  assert.match(web.downloads[0][1], /\n {2}"format"/);
  assert.equal(web.toasts[0].type, "success");

  const saveExportFile = spy(async (name) => ({ saved: true, name }));
  const desktop = harness({ electronAPI: { saveExportFile } });
  await desktop.elements.backupExportBtn.dispatch("click");
  assert.equal(desktop.downloads.length, 0);
  assert.equal(saveExportFile.calls[0][0], "cluster-workbench-config-20261014-0905.json");
  assert.match(desktop.toasts[0].message, /已保存为 cluster-workbench-config-20261014-0905\.json/);
  const canceled = harness({ electronAPI: { saveExportFile: async () => ({ saved: false, canceled: true }) } });
  await canceled.elements.backupExportBtn.dispatch("click");
  assert.deepEqual(canceled.toasts, [], "取消另存为不提示");
});

test("导入：太大 / 不是 JSON 的文件就地拒绝、不发请求；正常文件先预览，勾选改按钮数字，确认后带勾选与版本号写入", async () => {
  const h = harness();
  await h.ui.previewFile({ name: "big.json", size: IMPORT_FILE_MAX_BYTES + 1, text: async () => "{}" });
  assert.match(h.panel.innerHTML, /太大（上限 256 KB）/);
  await h.ui.previewFile(file("not json", "x.txt"));
  assert.match(h.panel.innerHTML, /x\.txt 不是 JSON 文件/);
  assert.equal(h.postJson.calls.length, 0);

  await h.elements.backupImportFile.dispatch("change", { target: { files: [file('{"format":"cluster-workbench-config","formatVersion":1}')] } });
  assert.equal(h.postJson.calls[0][0], "/api/config/import/preview");
  assert.equal(h.panel.hidden, false);
  assert.match(h.panel.innerHTML, /导入所选（2 项）/);

  // 勾上端口那一条：按钮数字跟着变，列表不重画。
  const before = h.panel.innerHTML;
  await h.panel.dispatch("change", { target: { dataset: { bkChange: "portOverrides.server-01" }, checked: true } });
  assert.equal(h.panel.applyButton.textContent, "导入所选（3 项）");
  assert.equal(h.panel.innerHTML, before);
  await h.panel.dispatch("change", { target: { dataset: { bkChange: "personal.sshUser" }, checked: false } });
  assert.equal(h.panel.applyButton.textContent, "导入所选（2 项）");

  await h.panel.dispatch("click", { target: { closest: (sel) => (sel === "[data-bk-apply]" ? {} : null) } });
  const [path, body] = h.postJson.calls[1];
  assert.equal(path, "/api/config/import");
  assert.deepEqual(body.selected.sort(), ["personal.egress", "portOverrides.server-01"]);
  assert.equal(body.revision, 7);
  assert.equal(body.document.format, "cluster-workbench-config");
  assert.match(h.panel.innerHTML, /已导入 1 项；导入前的配置已备份为 <code>b\.json<\/code>/);
  assert.equal(h.onImported.calls.length, 1);
  assert.equal(h.ui.getPending(), null);

  await h.panel.dispatch("click", { target: { closest: (sel) => (sel === "[data-bk-cancel]" ? {} : null) } });
  assert.equal(h.panel.hidden, true);
});

test("导入被拒绝（校验 / 版本冲突）：提示原因与逐字段错误，预览留着可以改勾选再试", async () => {
  const err = Object.assign(new Error("HTTP 400"), { serverMessage: "端口覆盖未通过校验", errors: [{ field: "portOverrides.server-01.remotePort", message: "7891 是团队最早的生产端口" }] });
  const panel = fakeElement();
  const toasts = [];
  const ui = createSettingsBackup({
    doc: fakeDocument({ backupImportPanel: panel }),
    getJson: async () => ({}),
    postJson: async (path) => {
      if (path === "/api/config/import") throw err;
      return PREVIEW;
    },
    showToast: (t) => toasts.push(t),
  });
  await ui.previewFile(file("{}"));
  await ui.applyImport();
  assert.match(toasts.at(-1).message, /没有导入：端口覆盖未通过校验（portOverrides\.server-01\.remotePort：7891 是团队最早的生产端口）/);
  assert.ok(ui.getPending(), "预览还在");
  assert.match(panel.innerHTML, /导入所选（2 项）/);
});

test("接线：app.js 创建并在打开配置时读这一节；index.html 有骨架与 modulepreload", () => {
  const app = readFileSync(new URL("../../../app.js", import.meta.url), "utf8");
  assert.match(app, /createSettingsBackup\(\{/);
  assert.match(app, /dialogs\.onDialogOpen\("dlgSettings", settingsBackup\.onOpen\)/);
  const html = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
  for (const id of ["settingsBackup", "backupExportBtn", "backupImportBtn", "backupImportFile", "backupImportPanel", "backupInfo", "backupSshNote"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<link rel="modulepreload" href="\/assets\/js\/app\/settings-backup\.js" \/>/);
});
