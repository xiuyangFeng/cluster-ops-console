// 配置导出 / 导入：格式、比对、按勾选写入。全程只在临时目录里（团队配置读仓库里那份，只读）。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfigManager } from "../config-hot-reload.mjs";
import { writePersonalPreferences } from "../modules/preferences-store.mjs";
import { PERSONAL_BACKUP_DIR } from "../personal-config-backup.mjs";
import {
  buildExportDocument,
  buildPersonalPatch,
  defaultSelection,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  ImportDocumentError,
  parseImportDocument,
  planImport,
  scrubSecrets,
} from "./document.mjs";
import { createConfigTransferService } from "./service.mjs";

const REPO_TEAM_CONFIG = path.resolve(import.meta.dirname, "../../../../config.json");
const T0 = Date.UTC(2026, 9, 14, 1, 5, 7); // 北京时间 2026-10-14 09:05:07
const SECRET = "SuperSecretValue123";

const DEFAULT_ALERT = { rules: { failNotify: true, longRunMinutes: null, patterns: [] }, silenceMinutes: 30, limitMinutes: 30 };

function oldMachinePersonal() {
  return {
    _comment: "手写的说明",
    sshUser: "amy",
    sshIdentityFile: "/Users/amy/.ssh/id_ed25519_codextunnel",
    activeServerId: "server-01",
    activeAgentId: "codex",
    portOverrides: { "server-01": { remotePort: 7893, localPort: 8893 } },
    servers: [
      { id: "server-tengxun", name: "腾讯云", host: "tengxunserver", sshUser: "ubuntu", remotePort: 7894, localPort: 8894, tunnel: true, authRef: "vault:server-tengxun", password: SECRET },
      { id: "server-aliyun", name: "阿里云", host: "vpn-aliyun", sshUser: "root", tunnel: false },
    ],
    autoRepair: { enabled: true, observeOnly: false, rules: { "probe-backoff": true } },
    egress: { mode: "manual", url: `http://user:${SECRET}@127.0.0.1:7890` },
    proxyAllowedTargets: ["relay.example.com:9443"],
    noProxyExtra: { "server-01": ["10.0.0.5"] },
    storageBudgetBytes: 52428800,
    disabledModules: ["agent:zcode"],
    enabledModules: [],
    hiddenPanels: ["view.usage"],
    modulePrefsVersion: 2,
    _serverTombstones: [{ id: "old", name: "old", removedAt: 1 }],
    authToken: SECRET,
    revision: 12,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

test("scrubSecrets：去掉像口令 / 令牌的键、URL 里的账号口令、下划线开头的说明键；只留 JSON 原生值", () => {
  assert.deepEqual(scrubSecrets({
    a: 1, password: "x", sshPassword: "x", apiToken: "x", privateKey: "x", identityData: "x", Authorization: "x", _comment: "x",
    nested: [{ url: "https://u:p@host:9443/path", keep: true, secret: "x" }],
    bad: () => {}, inf: Number.POSITIVE_INFINITY,
  }), { a: 1, nested: [{ url: "https://host:9443/path", keep: true }] });
});

test("导出：只有白名单字段与本机偏好；不含任何口令 / 令牌 / 元数据；带格式版本与「不包含」清单", () => {
  const personal = oldMachinePersonal();
  const doc = buildExportDocument({
    personal,
    preferences: { disabledModules: ["agent:zcode"], enabledModules: [], hiddenPanels: ["view.usage"] },
    jobAlerts: { "server-01": { rules: { failNotify: false, longRunMinutes: 60, patterns: ["train_*"] }, silenceMinutes: 45, limitMinutes: 20 }, "../x": {} },
    appVersion: "2.64.0",
    now: T0,
  });
  assert.equal(doc.format, EXPORT_FORMAT);
  assert.equal(doc.formatVersion, EXPORT_FORMAT_VERSION);
  assert.equal(doc.exportedAt, "2026-10-14T01:05:07.000Z");
  assert.deepEqual(Object.keys(doc.personal), ["sshUser", "sshIdentityFile", "activeServerId", "activeAgentId", "servers", "portOverrides", "autoRepair", "storageBudgetBytes", "egress", "proxyAllowedTargets", "noProxyExtra"]);
  assert.equal(doc.personal.servers[0].authRef, "vault:server-tengxun", "只有凭据引用，没有密码");
  assert.equal(doc.personal.egress.url, "http://127.0.0.1:7890");
  assert.deepEqual(doc.preferences, { disabledModules: ["agent:zcode"], enabledModules: [], hiddenPanels: ["view.usage"] });
  assert.deepEqual(Object.keys(doc.jobAlerts), ["server-01"]);
  assert.deepEqual(doc.jobAlerts["server-01"].rules.patterns, ["train_*"]);
  assert.ok(doc.excluded.some((line) => /SSH 私钥/.test(line)));
  assert.match(doc.notice, /~\/\.ssh 下的密钥要另外拷/);
  const text = JSON.stringify(doc);
  for (const banned of [SECRET, "_serverTombstones", "revision", "updatedAt\":\"2026-10-01", "_comment", "authToken"]) assert.equal(text.includes(banned), false, banned);
});

test("导入校验：格式 / 格式版本 / 字段形状不对一律拒绝（400，带 code），更新版本的文件给出处理办法", () => {
  const ok = buildExportDocument({ personal: { sshUser: "amy" }, now: T0 });
  const reject = (raw, code) => assert.throws(() => parseImportDocument(raw), (err) => err instanceof ImportDocumentError && err.status === 400 && err.code === code);
  reject(null, "not-object");
  reject([], "not-object");
  reject({ ...ok, format: "other" }, "bad-format");
  reject({ ...ok, formatVersion: "1" }, "bad-version");
  assert.throws(() => parseImportDocument({ ...ok, formatVersion: 2 }), /更新版本的工作台（格式 2，这里只认到 1）：先把这台的工作台更新到最新/);
  reject({ ...ok, personal: [] }, "bad-shape");
  reject({ ...ok, personal: { servers: [{ id: "../x" }] } }, "bad-servers");
  reject({ ...ok, personal: { servers: [{ id: "a" }, { id: "a" }] } }, "bad-servers");
  reject({ ...ok, personal: { portOverrides: { "server-01": 7893 } } }, "bad-ports");
  reject({ ...ok, preferences: { hiddenPanels: ["bad id!"] } }, "bad-preferences");
  reject({ ...ok, jobAlerts: { "server-01": { rules: { longRunMinutes: 3 } } } }, "bad-job-alerts");
  reject({ ...ok, jobAlerts: { "server-01": { silenceMinutes: 5 } } }, "bad-job-alerts");
  const parsed = parseImportDocument({ ...ok, personal: { sshUser: "amy", password: SECRET, revision: 3 } });
  assert.deepEqual(parsed.personal, { sshUser: "amy" }, "白名单之外与像口令的字段都不收");
  assert.deepEqual(parsed.meta, { exportedAt: "2026-10-14T01:05:07.000Z", appVersion: null, formatVersion: 1 });
});

test("比对：普通字段一项一条；服务器按台、端口单独一条；新的建隧道个人服务器整条算端口改动；本机多出来的服务器算删除", () => {
  const incoming = parseImportDocument(buildExportDocument({
    personal: oldMachinePersonal(),
    preferences: { disabledModules: ["agent:zcode"], enabledModules: [], hiddenPanels: ["view.usage"] },
    jobAlerts: { "server-01": { rules: { failNotify: false, longRunMinutes: null, patterns: [] }, silenceMinutes: 30, limitMinutes: 30 }, "server-tengxun": { ...DEFAULT_ALERT, silenceMinutes: 60 }, "server-x": { ...DEFAULT_ALERT, limitMinutes: 10 } },
    now: T0,
  }));
  // 新电脑：走完接入引导，领到了别的端口，另外自己加了一台个人服务器。
  const current = {
    personal: {
      sshUser: "amy",
      sshIdentityFile: "/Users/amy2/.ssh/id_ed25519_codextunnel",
      activeServerId: "server-01",
      portOverrides: { "server-01": { remotePort: 7899, localPort: 8899 } },
      servers: [
        { id: "server-aliyun", name: "阿里云", host: "vpn-aliyun", sshUser: "admin", tunnel: false, remotePort: 7800, createdAt: "x" },
        { id: "server-mine", name: "我的", host: "mine", sshUser: "me", tunnel: false },
      ],
      revision: 4,
    },
    preferences: { disabledModules: [], enabledModules: [], hiddenPanels: ["view.usage"] },
    jobAlerts: { "server-01": DEFAULT_ALERT },
    jobAlertServerIds: ["server-01"],
    teamServerIds: ["server-01"],
  };
  const changes = planImport(current, incoming);
  const byId = Object.fromEntries(changes.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), [
    "jobAlerts.server-01",
    "jobAlerts.server-tengxun",
    "jobAlerts.server-x",
    "personal.activeAgentId",
    "personal.autoRepair",
    "personal.egress",
    "personal.noProxyExtra",
    "personal.proxyAllowedTargets",
    "personal.sshIdentityFile",
    "personal.storageBudgetBytes",
    "portOverrides.server-01",
    "preferences.disabledModules",
    "servers.server-aliyun",
    "servers.server-aliyun.ports",
    "servers.server-mine",
    "servers.server-tengxun",
  ].sort());
  assert.equal(byId["personal.activeAgentId"].kind, "added");
  assert.match(byId["personal.sshIdentityFile"].note, /要另外拷过来/);
  assert.deepEqual([byId["portOverrides.server-01"].kind, byId["portOverrides.server-01"].ports], ["changed", true]);
  assert.equal(byId["portOverrides.server-01"].note, "", "端口的后果写在这一组开头（PORTS_NOTE），不在每条下面重复");
  assert.deepEqual([byId["servers.server-tengxun"].kind, byId["servers.server-tengxun"].ports], ["added", true], "建隧道的新服务器离不开端口");
  assert.match(byId["servers.server-tengxun"].note, /^建隧道的服务器离不开反向端口：勾上它会连端口一起导入。用密码登录：密码不随导出/);
  assert.deepEqual([byId["servers.server-aliyun"].kind, byId["servers.server-aliyun"].ports], ["changed", false]);
  assert.deepEqual([byId["servers.server-aliyun.ports"].kind, byId["servers.server-aliyun.ports"].ports], ["removed", true]);
  assert.deepEqual([byId["servers.server-mine"].kind, byId["servers.server-mine"].ports], ["removed", false], "没端口、不建隧道的删除不算端口改动");
  assert.equal(byId["jobAlerts.server-01"].available, true);
  assert.equal(byId["jobAlerts.server-01"].after, "失败提醒关；长作业不提醒；名字规则：无；日志静默 30 分钟、临近时限 30 分钟提醒");
  assert.equal(byId["jobAlerts.server-tengxun"].available, true, "随这次导入的服务器一起来");
  assert.match(byId["jobAlerts.server-tengxun"].note, /随这台服务器一起导入后生效/);
  assert.deepEqual([byId["jobAlerts.server-x"].available, byId["jobAlerts.server-x"].reason], [false, "这台电脑上还没有这台服务器"]);

  const selected = defaultSelection(changes);
  assert.equal(selected.some((id) => byId[id].ports), false, "端口相关的默认不勾");
  assert.equal(selected.some((id) => byId[id].kind === "removed"), false, "一切删除默认不勾");
  assert.equal(selected.includes("jobAlerts.server-x"), false, "暂时用不上的默认不勾");

  // 默认勾选：端口全按本机现状。
  const { patch, skipped } = buildPersonalPatch(current, incoming, changes, selected);
  assert.deepEqual(skipped, []);
  assert.deepEqual(Object.keys(patch).sort(), ["activeAgentId", "autoRepair", "egress", "noProxyExtra", "proxyAllowedTargets", "servers", "sshIdentityFile", "storageBudgetBytes"]);
  assert.deepEqual(patch.servers.map((s) => s.id), ["server-aliyun", "server-mine"], "本机多出来的那台默认保留；建隧道的新服务器没勾端口，不导入");
  assert.equal(patch.servers[0].remotePort, 7800, "改了别的字段，端口还是本机的");
  assert.equal(patch.servers[0].sshUser, "root");

  // 勾上端口：新服务器连端口一起来，portOverrides 换成文件里的。
  const all = changes.filter((c) => c.available).map((c) => c.id);
  const full = buildPersonalPatch(current, incoming, changes, all).patch;
  assert.deepEqual(full.portOverrides, { "server-01": { remotePort: 7893, localPort: 8893 } });
  assert.deepEqual(full.servers.map((s) => [s.id, s.remotePort ?? null]), [["server-aliyun", null], ["server-tengxun", 7894]], "全勾（含删除）才删掉本机多出来的那台");

  // 只勾端口、不勾服务器本身：端口没处落，跳过并说明。
  const onlyPorts = buildPersonalPatch({ ...current, personal: { ...current.personal, servers: [] } }, incoming, planImport({ ...current, personal: { ...current.personal, servers: [] } }, incoming), ["servers.server-aliyun.ports"]);
  assert.equal(onlyPorts.skipped[0]?.id, undefined, "本机没有 server-aliyun 时根本不会有单独的端口条目");
});

function machine(t, personal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-transfer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const localConfigPath = path.join(dir, "config.local.json");
  if (personal) fs.writeFileSync(localConfigPath, JSON.stringify(personal, null, 2));
  const manager = createConfigManager({ configPath: REPO_TEAM_CONFIG, localConfigPath, appendLog: () => {} });
  const watch = new Map();
  const changeCalls = [];
  const jobs = {
    getWatchView: async (serverId) => {
      if (!serverId) return { schemaVersion: 1, servers: [...watch.keys()].map((id) => ({ serverId: id, rules: watch.get(id).rules })) };
      const entry = watch.get(serverId) || DEFAULT_ALERT;
      return { serverId, settings: { silenceMinutes: entry.silenceMinutes, limitMinutes: entry.limitMinutes, quietUntil: 0 }, rules: entry.rules };
    },
    changeWatch: async (serverId, body) => {
      changeCalls.push([serverId, body]);
      if (!watch.has(serverId)) throw Object.assign(new Error("服务器不在作业采集范围"), { status: 404 });
      const entry = watch.get(serverId);
      if (body.action === "rules") entry.rules = { failNotify: body.failNotify, longRunMinutes: body.longRunMinutes, patterns: body.patterns };
      else Object.assign(entry, { silenceMinutes: body.silenceMinutes, limitMinutes: body.limitMinutes });
    },
  };
  watch.set("server-01", structuredClone(DEFAULT_ALERT));
  const logs = [];
  let refreshed = 0;
  const service = createConfigTransferService({
    localConfigPath,
    getConfig: () => manager.getConfig(),
    getPersonalConfig: () => manager.getPersonalConfig(),
    savePersonalConfig: (patch) => manager.savePersonalConfig(patch),
    writePreferences: (patch) => writePersonalPreferences({ localConfigPath, patch }),
    refreshConfigIntoKernel: async () => { refreshed += 1; await manager.loadConfig(); },
    jobs,
    appVersion: "2.64.0",
    now: () => T0,
    log: (message, fields) => logs.push({ message, fields }),
  });
  return { dir, localConfigPath, manager, service, watch, changeCalls, logs, read: () => JSON.parse(fs.readFileSync(localConfigPath, "utf8")), refreshes: () => refreshed };
}

test("服务：旧电脑导出 → 新电脑预览 → 按默认勾选导入：端口不动、写前留备份、偏好与作业提醒随之写入", async (t) => {
  const old = machine(t, { ...oldMachinePersonal(), servers: oldMachinePersonal().servers.map(({ password, ...rest }) => rest) });
  old.watch.get("server-01").rules = { failNotify: false, longRunMinutes: 120, patterns: ["train_*"] };
  old.watch.get("server-01").limitMinutes = 15;
  await old.manager.loadConfig({ strict: true });
  const { filename, document } = await old.service.exportDocument();
  assert.equal(filename, "cluster-workbench-config-20261014-0905.json");
  assert.equal(JSON.stringify(document).includes(SECRET), false);
  assert.equal(old.logs.at(-1).fields.event, "config-export");

  const fresh = machine(t, { sshUser: "amy", activeServerId: "server-01", portOverrides: { "server-01": { remotePort: 7899, localPort: 8899 } }, revision: 2 });
  await fresh.manager.loadConfig({ strict: true });
  const preview = await fresh.service.previewImport(JSON.parse(JSON.stringify(document)));
  assert.equal(preview.revision, 2);
  assert.ok(preview.changes.some((c) => c.id === "portOverrides.server-01" && c.ports));
  assert.equal(preview.defaultSelected.includes("portOverrides.server-01"), false);
  assert.match(preview.portsNote, /会改这台电脑的隧道端口/);
  assert.equal(fs.existsSync(path.join(fresh.dir, PERSONAL_BACKUP_DIR)), false, "预览不写任何东西");

  const result = await fresh.service.applyImport(document, { selected: preview.defaultSelected, revision: preview.revision });
  assert.equal(result.success, true);
  assert.match(result.backup.name, /^config\.local\.\d{8}-\d{6}\.json$/);
  const after = fresh.read();
  assert.deepEqual(after.portOverrides, { "server-01": { remotePort: 7899, localPort: 8899 } }, "端口没勾：还是这台自己的");
  assert.deepEqual(after.servers.map((s) => s.id), ["server-aliyun"], "建隧道的腾讯云要端口，没勾就没导入");
  assert.equal(after.sshIdentityFile, "/Users/amy/.ssh/id_ed25519_codextunnel");
  assert.deepEqual(after.egress, { mode: "manual", url: "http://127.0.0.1:7890" });
  assert.deepEqual(after.disabledModules, ["agent:zcode"]);
  assert.deepEqual(after.hiddenPanels, ["view.usage"]);
  assert.equal(after.modulePrefsVersion, 2);
  assert.deepEqual(fresh.watch.get("server-01"), { rules: { failNotify: false, longRunMinutes: 120, patterns: ["train_*"] }, silenceMinutes: 30, limitMinutes: 15 });
  assert.ok(fresh.refreshes() >= 1);
  const backups = fs.readdirSync(path.join(fresh.dir, PERSONAL_BACKUP_DIR));
  assert.deepEqual(backups, [result.backup.name], "导入前的内容留了一份（偏好写入不再重复留）");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh.dir, PERSONAL_BACKUP_DIR, backups[0]), "utf8")).revision, 2);
  assert.equal(fresh.logs.at(-1).fields.event, "config-import");

  // 预览之后别处改过：409，请重新预览。
  await assert.rejects(fresh.service.applyImport(document, { selected: [], revision: 2 }), (err) => err.status === 409 && err.code === "revision-conflict");

  // 再导入一次、这回勾上端口：端口换成文件里的，腾讯云连端口一起来。
  const again = await fresh.service.previewImport(document);
  const withPorts = again.changes.filter((c) => c.available).map((c) => c.id);
  await fresh.service.applyImport(document, { selected: withPorts, revision: again.revision });
  const final = fresh.read();
  assert.deepEqual(final.portOverrides, { "server-01": { remotePort: 7893, localPort: 8893 } });
  assert.deepEqual(final.servers.map((s) => [s.id, s.remotePort ?? null]), [["server-aliyun", null], ["server-tengxun", 7894]]);
  assert.equal(final.servers[1].authRef, "vault:server-tengxun");

  // 什么都不勾：什么都不写，也不留备份。
  const none = await fresh.service.applyImport(document, { selected: [] });
  assert.deepEqual([none.applied, none.backup], [[], null]);
});

test("服务：被配置加载器拒绝的导入整体不写（端口撞团队基准端口）；作业提醒写不进去的跳过并说明", async (t) => {
  const doc = buildExportDocument({ personal: { portOverrides: { "server-01": { remotePort: 7891, localPort: 8888 } } }, jobAlerts: { "server-01": { ...DEFAULT_ALERT, limitMinutes: 10 } }, now: T0 });
  const box = machine(t, { sshUser: "amy", portOverrides: { "server-01": { remotePort: 7899, localPort: 8899 } }, revision: 1 });
  await box.manager.loadConfig({ strict: true });
  const before = fs.readFileSync(box.localConfigPath, "utf8");
  await assert.rejects(box.service.applyImport(doc, { selected: ["portOverrides.server-01"] }), (err) => err.name === "ConfigValidationError");
  assert.equal(fs.readFileSync(box.localConfigPath, "utf8"), before);
  assert.equal(fs.existsSync(path.join(box.dir, PERSONAL_BACKUP_DIR)), false, "被拒绝的导入不留备份");

  // 预览时还管得到 server-01，写的时候（比如刚把作业模块关了）写不进去：这一条跳过并说明，其余照常。
  const preview = await box.service.previewImport(doc);
  assert.equal(preview.changes.find((c) => c.id === "jobAlerts.server-01").available, true);
  box.watch.clear();
  const result = await box.service.applyImport(doc, { selected: ["jobAlerts.server-01"], revision: preview.revision });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, [{ id: "jobAlerts.server-01", reason: "这台电脑上还没有这台服务器" }], "写之前按现状重新比对：已经管不到就跳过并说明");

  // 预览时就管不到：列出来但不能勾，说明原因；硬塞进 selected 也不会写。
  const later = await box.service.previewImport(doc);
  const alert = later.changes.find((c) => c.id === "jobAlerts.server-01");
  assert.deepEqual([alert.available, alert.reason], [false, "这台电脑上还没有这台服务器"]);
  assert.equal(later.defaultSelected.includes("jobAlerts.server-01"), false);
  const forced = await box.service.applyImport(doc, { selected: ["jobAlerts.server-01"] });
  assert.deepEqual(forced.applied, []);

  // 比对时管得到、真正写时作业服务拒绝（并发关了模块）：这一条跳过并带上服务给的原因。
  box.watch.set("server-01", structuredClone(DEFAULT_ALERT));
  const racing = await box.service.previewImport(doc);
  assert.ok(racing.changes.find((c) => c.id === "jobAlerts.server-01").available);
  const failing = createConfigTransferService({
    localConfigPath: box.localConfigPath,
    getConfig: () => box.manager.getConfig(),
    getPersonalConfig: () => box.manager.getPersonalConfig(),
    savePersonalConfig: (patch) => box.manager.savePersonalConfig(patch),
    writePreferences: () => {},
    jobs: { getWatchView: async (id) => (id ? { settings: DEFAULT_ALERT, rules: DEFAULT_ALERT.rules } : { servers: [{ serverId: "server-01", rules: DEFAULT_ALERT.rules }] }), changeWatch: async () => { throw new Error("我的 Slurm 作业模块已关闭"); } },
    now: () => T0,
  });
  const raced = await failing.applyImport(doc, { selected: ["jobAlerts.server-01"] });
  assert.deepEqual(raced.skipped, [{ id: "jobAlerts.server-01", reason: "我的 Slurm 作业模块已关闭" }]);

  // 作业模块整个关着：说明里直说。
  const closed = createConfigTransferService({
    localConfigPath: box.localConfigPath,
    getConfig: () => box.manager.getConfig(),
    getPersonalConfig: () => box.manager.getPersonalConfig(),
    jobs: { getWatchView: async () => ({ disabled: true }), changeWatch: async () => {} },
    now: () => T0,
  });
  const closedPreview = await closed.previewImport(doc);
  assert.equal(closedPreview.changes.find((c) => c.id === "jobAlerts.server-01").reason, "「我的 Slurm 作业」模块关着");
});

test("服务：个人配置读不出来时导出 / 导入都停下并说明（409），不碰文件", async (t) => {
  const box = machine(t);
  fs.writeFileSync(box.localConfigPath, "{ broken");
  await assert.rejects(box.service.exportDocument(), (err) => err.status === 409 && err.code === "personal-unreadable");
  await assert.rejects(box.service.previewImport(buildExportDocument({ now: T0 })), (err) => err.status === 409);
  assert.equal(fs.readFileSync(box.localConfigPath, "utf8"), "{ broken");
  const described = box.service.describe();
  assert.equal(described.backups.count, 0);
  assert.ok(described.excluded.length >= 4);
});

test("服务：只导入偏好也先留个人配置备份；只导入面板显隐时，没勾的模块开关按现状（含旧偏好的物化）写回", async (t) => {
  // 旧偏好（没有 modulePrefsVersion）：团队默认关的 reclaude 靠旧语义开着，只导入面板显隐不能把它悄悄关掉。
  const box = machine(t, { activeServerId: "server-01", disabledModules: ["agent:zcode"], revision: 5 });
  await box.manager.loadConfig({ strict: true });
  const enabledBefore = (await box.manager.getConfig()).agentCatalog.filter((a) => a.enabled).map((a) => a.id).sort();
  const doc = buildExportDocument({ preferences: { disabledModules: ["agent:zcode"], enabledModules: [], hiddenPanels: ["overview.brief"] }, now: T0 });
  const preview = await box.service.previewImport(doc);
  assert.deepEqual(preview.changes.map((c) => c.id), ["preferences.enabledModules", "preferences.hiddenPanels"]);
  const result = await box.service.applyImport(doc, { selected: ["preferences.hiddenPanels"], revision: preview.revision });
  assert.deepEqual(result.applied, ["preferences.hiddenPanels"]);
  assert.ok(result.backup, "只改偏好也留了备份");
  const saved = box.read();
  assert.deepEqual(saved.hiddenPanels, ["overview.brief"]);
  assert.equal(saved.modulePrefsVersion, 2);
  await box.manager.loadConfig({ strict: true });
  const enabledAfter = (await box.manager.getConfig()).agentCatalog.filter((a) => a.enabled).map((a) => a.id).sort();
  assert.deepEqual(enabledAfter, enabledBefore, "Agent 开关一个没变");
});

test("复审 P2：本机建了隧道、带反向端口的服务器不在导入文件里——列为删除、算端口改动、默认不勾；不勾就原样保留", () => {
  const current = {
    personal: { revision: 3, servers: [
      { id: "aliyun", name: "阿里云", host: "1.2.3.4", sshUser: "me", remotePort: 31234, localPort: 7890 },
      { id: "watch-only", name: "只监控", host: "5.6.7.8", sshUser: "me", tunnel: false },
      { id: "main", disabled: true }, // 团队服务器的屏蔽条目
    ] },
    preferences: {}, jobAlerts: {}, jobAlertServerIds: [], teamServerIds: ["main"],
  };
  const incoming = parseImportDocument({ format: EXPORT_FORMAT, formatVersion: 1, personal: { servers: [], sshUser: "me" } });
  const changes = planImport(current, incoming);
  const byId = Object.fromEntries(changes.map((c) => [c.id, c]));
  assert.deepEqual([byId["servers.aliyun"].kind, byId["servers.aliyun"].ports], ["removed", true]);
  assert.match(byId["servers.aliyun"].note, /隧道随即断开/);
  assert.deepEqual([byId["servers.watch-only"].kind, byId["servers.watch-only"].ports], ["removed", false]);
  assert.match(byId["servers.watch-only"].note, /不勾就留在这台电脑上/);
  assert.deepEqual([byId["servers.main"].kind, byId["servers.main"].ports], ["removed", true], "团队服务器的个人条目默认建隧道");
  const selected = defaultSelection(changes);
  assert.deepEqual(selected, ["personal.sshUser"]);
  const { patch } = buildPersonalPatch(current, incoming, changes, selected);
  assert.deepEqual(patch, { sshUser: "me" }, "一路点导入：servers 一个字都不动");
  // 用户明确勾了才删。
  const removed = buildPersonalPatch(current, incoming, changes, [...selected, "servers.aliyun"]).patch;
  assert.deepEqual(removed.servers.map((s) => s.id), ["watch-only", "main"]);
});
