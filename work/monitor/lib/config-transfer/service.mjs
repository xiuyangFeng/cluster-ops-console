// 配置导出 / 导入的业务层（v2.64）：配置页「备份与迁移」一节背后的三个动作。格式与比对在 document.mjs。
//
//   exportDocument()          读现状 → 导出文件（不含任何令牌 / 口令 / 私钥，见 document.mjs 文件头）
//   previewImport(raw)        校验导出文件 → 与本机现状比对，列出将改动的条目（端口相关的单独标出、默认不勾）
//   applyImport(raw, opts)    按用户勾选的条目写入：先留一份个人配置备份（personal-config-backup.mjs），再
//                              个人层（经 savePersonalConfig：与设置页同一套校验、revision 核对、写前 .bak）→
//                              模块与面板偏好（writePersonalPreferences）→ 作业提醒规则（作业关注服务，与界面改规则同一条路）。
//                              服务端按文件重新比对一遍，不信任界面送来的改动内容，只认勾选的 id。
//
// 不碰：端口登记（集群上的）、隧道进程、钥匙串、~/.ssh。端口改动写进个人配置后由配置热载照常生效。
import * as nodeFs from "node:fs";

import { corruptStamp as beijingStamp } from "../corrupt-archive.mjs";
import { explicitModulePreferences, normalizePreferenceIds } from "../modules/catalog.mjs";
import { backupPersonalConfig, listPersonalBackups, PERSONAL_BACKUP_KEEP, personalBackupDir } from "../personal-config-backup.mjs";
import { statusError } from "../status-error.mjs";
import {
  buildExportDocument,
  buildPersonalPatch,
  buildPreferencesPatch,
  defaultSelection,
  EXPORT_EXCLUDED,
  EXPORT_NOTICE,
  EXPORT_PERSONAL_FIELDS,
  EXPORT_PREFERENCE_FIELDS,
  parseImportDocument,
  pickJobAlertChanges,
  planImport,
  PORTS_NOTE,
} from "./document.mjs";

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function createConfigTransferService({
  localConfigPath,
  getConfig,
  getPersonalConfig,
  savePersonalConfig,
  writePreferences,
  refreshConfigIntoKernel = async () => {},
  // 作业关注服务（toolkit.jobs 的 getWatchView / changeWatch）；没有（模块未装配）时作业提醒不进导出、导入跳过。
  jobs = null,
  appVersion = null,
  now = Date.now,
  log = () => {},
  fs,
} = {}) {
  const fsOption = fs ? { fs } : {};

  function readPersonal() {
    let personal;
    try {
      personal = getPersonalConfig();
    } catch {
      throw statusError("个人配置读不出来：先在「高级：个人配置 JSON」里修好（或从备份恢复）再导出 / 导入", 409, { code: "personal-unreadable" });
    }
    return isPlainObject(personal) ? personal : {};
  }

  // 作业提醒：{ serverId: { rules, silenceMinutes, limitMinutes } } 与现在管得到的服务器；模块关着 / 没装配 → 空。
  async function readJobAlerts() {
    if (!jobs?.getWatchView) return { alerts: {}, serverIds: [], enabled: false };
    const view = await jobs.getWatchView(null).catch(() => null);
    if (!view || view.disabled) return { alerts: {}, serverIds: [], enabled: false };
    const alerts = {};
    const serverIds = [];
    for (const server of Array.isArray(view.servers) ? view.servers : []) {
      if (typeof server?.serverId !== "string") continue;
      serverIds.push(server.serverId);
      const detail = await jobs.getWatchView(server.serverId).catch(() => null);
      alerts[server.serverId] = {
        rules: server.rules,
        silenceMinutes: detail?.settings?.silenceMinutes,
        limitMinutes: detail?.settings?.limitMinutes,
      };
    }
    return { alerts, serverIds, enabled: true };
  }

  async function readCurrent() {
    const personal = readPersonal();
    const merged = (await getConfig()) || {};
    const explicit = explicitModulePreferences(merged);
    const preferences = { ...explicit, hiddenPanels: normalizePreferenceIds(merged.hiddenPanels) };
    const teamServerIds = (Array.isArray(merged.servers) ? merged.servers : []).filter((s) => s && s.source !== "personal").map((s) => s.id);
    const jobsState = await readJobAlerts();
    return {
      personal,
      preferences,
      jobAlerts: jobsState.alerts,
      jobAlertServerIds: jobsState.serverIds,
      jobsEnabled: jobsState.enabled,
      teamServerIds,
      revision: personal.revision ?? 0,
    };
  }

  const io = fs || nodeFs;
  // 个人配置的原文（比对备份用）；读不到 → null。
  function readRaw() {
    try { return io.readFileSync(localConfigPath); } catch { return null; }
  }
  // 最新一份备份正好是导入前的内容 → 就是这次导入的备份（新留的，或内容相同、按规则没重复留的那一份）。
  function matchingBackup(preImport) {
    if (!preImport) return null;
    const newest = listPersonalBackups(localConfigPath, fsOption)[0];
    if (!newest) return null;
    try {
      return Buffer.compare(Buffer.from(io.readFileSync(newest.path)), Buffer.from(preImport)) === 0 ? newest : null;
    } catch {
      return null;
    }
  }

  function backupSummary() {
    const backups = listPersonalBackups(localConfigPath, fsOption);
    return {
      dir: personalBackupDir(localConfigPath),
      keep: PERSONAL_BACKUP_KEEP,
      count: backups.length,
      latest: backups[0] ? { name: backups[0].name, stamp: backups[0].stamp } : null,
    };
  }

  // 「备份与迁移」一节打开时读：导出包含 / 不包含什么、写前备份在哪。
  function describe() {
    return {
      personalFields: [...EXPORT_PERSONAL_FIELDS],
      preferenceFields: [...EXPORT_PREFERENCE_FIELDS],
      includesJobAlerts: Boolean(jobs?.getWatchView),
      excluded: [...EXPORT_EXCLUDED],
      notice: EXPORT_NOTICE,
      backups: backupSummary(),
    };
  }

  async function exportDocument() {
    const current = await readCurrent();
    const at = now();
    const document = buildExportDocument({ personal: current.personal, preferences: current.preferences, jobAlerts: current.jobAlerts, appVersion, now: at });
    const stamp = beijingStamp(at).slice(0, 13); // 北京时间 YYYYMMDD-HHMM
    log("exported configuration", { event: "config-export", fields: Object.keys(document.personal).length, jobAlerts: Object.keys(document.jobAlerts).length });
    return { filename: `cluster-workbench-config-${stamp}.json`, document };
  }

  async function previewImport(raw) {
    const incoming = parseImportDocument(raw);
    const current = await readCurrent();
    const changes = planImport(current, incoming);
    return {
      meta: incoming.meta,
      revision: current.revision,
      changes,
      defaultSelected: defaultSelection(changes),
      portsNote: PORTS_NOTE,
      backups: backupSummary(),
    };
  }

  // selected：要导入的改动 id；revision：预览时的个人配置版本号（期间别处改过就 409，请重新预览）。
  async function applyImport(raw, { selected = [], revision = null } = {}) {
    if (!Array.isArray(selected) || selected.some((id) => typeof id !== "string") || selected.length > 500) {
      throw statusError("selected 应为改动 id 的列表", 400, { code: "bad-selection" });
    }
    const incoming = parseImportDocument(raw);
    const current = await readCurrent();
    if (revision != null && String(current.revision) !== String(revision)) {
      throw statusError("个人配置在预览之后被改过了：请重新选择文件预览一次再导入", 409, { code: "revision-conflict" });
    }
    const changes = planImport(current, incoming);
    const known = new Set(changes.map((change) => change.id));
    const unknown = selected.filter((id) => !known.has(id));
    const personal = buildPersonalPatch(current, incoming, changes, selected);
    const preferences = buildPreferencesPatch(incoming, changes, selected);
    const jobAlerts = pickJobAlertChanges(incoming, changes, selected);
    const unavailable = changes.filter((change) => !change.available && selected.includes(change.id)).map((change) => ({ id: change.id, reason: change.reason || "现在用不上" }));
    const skipped = [...personal.skipped, ...unavailable, ...unknown.map((id) => ({ id, reason: "这一项已经和本机一样了（或文件里没有）" }))];
    const applied = [];
    if (!Object.keys(personal.patch).length && !Object.keys(preferences.patch).length && !jobAlerts.length) {
      return { success: true, applied, skipped, backup: null, backups: backupSummary() };
    }

    // 导入前的个人配置留一份备份。个人层有改动时由 savePersonalConfig 留（personal-config-write 在校验通过、真正写盘
    // 之前备份——被配置加载器拒绝的导入什么都不写、也不留备份）；只改偏好时在这里显式留。作业提醒不在个人配置里，不备份。
    const preImport = readRaw();
    if (Object.keys(personal.patch).length) {
      await savePersonalConfig({ ...personal.patch, expectedRevision: current.revision });
      applied.push(...personal.applied);
    } else if (Object.keys(preferences.patch).length) {
      backupPersonalConfig(localConfigPath, { ...fsOption, now, log });
    }
    const backup = matchingBackup(preImport);
    if (Object.keys(preferences.patch).length) {
      // 没勾的模块开关按现状（已物化的显式选择）一并写回：写偏好会打上新版本号，旧偏好的「默认开」要先落成显式的，
      // 否则只导入面板显隐就会让靠旧语义开着的 Agent 悄悄被关（同 config-hot-reload 的 setHiddenPanels）。
      await writePreferences({ disabledModules: current.preferences.disabledModules, enabledModules: current.preferences.enabledModules, ...preferences.patch });
      applied.push(...preferences.applied);
    }
    // 配置热载（探针增删、状态仓）后再写作业提醒：随这次导入新加的服务器这时才在作业采集范围里。
    await refreshConfigIntoKernel();
    for (const change of jobAlerts) {
      try {
        const { rules, silenceMinutes, limitMinutes } = change.value;
        await jobs.changeWatch(change.serverId, { action: "rules", failNotify: rules.failNotify, longRunMinutes: rules.longRunMinutes, patterns: rules.patterns });
        await jobs.changeWatch(change.serverId, { action: "settings", silenceMinutes, limitMinutes });
        applied.push(change.id);
      } catch (error) {
        skipped.push({ id: change.id, reason: error?.message || "写入失败" });
      }
    }
    log(`imported configuration: ${applied.length} change(s), ${skipped.length} skipped`, { event: "config-import", applied: applied.length, skipped: skipped.length, backup: backup?.name || null });
    return { success: true, applied, skipped, backup: backup ? { name: backup.name } : null, backups: backupSummary() };
  }

  return { describe, exportDocument, previewImport, applyImport };
}
