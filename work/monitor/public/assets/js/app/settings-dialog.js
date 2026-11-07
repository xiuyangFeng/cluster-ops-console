// app/settings-dialog.js —— 配置浮层（#dlgSettings）：服务器登记表单、本机资源、
// 版本详情（/api/build-info）、配置来源摘要、个人配置 JSON 编辑器，以及「出网」一节
// （./settings-egress.js，v2.54）。
//
// 打开浮层时 onOpen 拉取各块数据并启动本机资源定时器，关闭即停；随状态渲染的
// onStatus 只在浮层打开时重算配置来源摘要。
import { buildVersionDetailsHtml } from "../render/diagnostics.js";
import { escapeHtml } from "../store.js";
import { createSettingsEgress } from "./settings-egress.js";
import { createSettingsProxyAuth } from "./settings-proxy-auth.js";

// 设置浮层里的本机资源每 15s 刷新一次：定时器随浮层打开启动、关闭即停，
// 不在整个页面生命周期里常驻唤醒（从没打开过设置也每 15s 醒一次）。
export const LOCAL_RESOURCE_REFRESH_MS = 15000;
const DEFAULT_STORAGE_BUDGET_BYTES = 50 * 1024 * 1024;

// 纯函数：配置来源摘要（团队层/个人层条目数、个人层覆盖字段、本地数据预算、读取失败提示）。
export function buildSettingsConfigHtml(config) {
  const servers = Array.isArray(config.servers) ? config.servers : [];
  const counts = servers.reduce((acc, s) => {
    const source = s?.source === "personal" ? "personal" : "team";
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
  const rows = [
    ["团队层服务器", String(counts.team || 0)],
    ["个人层服务器（含屏蔽）", String(counts.personal || 0)],
    ["个人层覆盖字段", ["activeServerId", "activeAgentId", "sshUser", "portOverrides"].filter((f) => config[f] != null).join("、") || "无"],
    ["本地数据预算", `${Math.round((Number(config.storageBudgetBytes) || DEFAULT_STORAGE_BUDGET_BYTES) / 1024 / 1024)} MB`],
  ];
  return rows.map(([label, value]) => `
    <div class="settings-config-row"><span class="settings-config-label">${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`).join("")
    + '<p class="server-action-note">合并规则：团队 config.json 与个人 config.local.json 分层合并；控制台不会把合并结果写回个人层。</p>'
    + (config._configLoadError
      ? `<p class="server-action-note">个人配置读取失败：${escapeHtml(config._configLoadErrorMessage || "文件损坏或无法解析")}。当前仍使用上一次成功的配置；请在高级 JSON 中修复，或从个人配置旁边 config-backups/ 里最近的备份（或 .bak）恢复，不会静默改回默认服务器。</p>`
      : "");
}

export function createSettingsDialog({
  doc, win, state, getJson, postJson, patchJson, deleteJson, showToast, confirm, isHidden,
  initRegistryUi, getClientVersion, loadServers, refresh, fetchIncidents,
  timers = {},
}) {
  const setIntervalFn = timers.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = timers.clearInterval || ((id) => clearInterval(id));
  const getEl = (id) => doc.getElementById(id);
  const isOpen = () => Boolean(getEl("dlgSettings")?.open);
  const setHint = (text) => {
    const hint = getEl("configSaveHint");
    if (hint) hint.textContent = text;
  };

  // 个人配置 JSON 编辑器的状态：已加载的 revision 用于保存时的乐观并发检查；
  // dirty 时任何自动重载都不得覆盖用户未保存的编辑。
  const personal = { loaded: false, revision: 0, dirty: false, saving: false, loading: false };

  // 「出网」一节：方式 / 白名单写的也是个人层（revision 递增），保存后重读 JSON 编辑器，
  // 免得之后在编辑器里保存撞上版本冲突；编辑器里有未保存的编辑时不覆盖，只提示。
  // 「出网」一节里的「代理口令」（v2.62）：与上面同一份 /api/egress 数据，动作成功后让这一节重读。
  const proxyAuth = createSettingsProxyAuth({ doc, getJson, postJson, showToast, reload: () => egress.load() });
  const egress = createSettingsEgress({
    doc, getJson, postJson, showToast,
    onStatus: (status) => proxyAuth.setStatus(status),
    onSaved: () => {
      personal.loaded = false;
      if (personal.dirty) setHint("出网设置已写入个人配置；已保留你的未保存编辑。保存时会检查版本，避免覆盖新配置。");
      else loadPersonalConfig();
    },
  });

  const registry = initRegistryUi({
    getJson, postJson, patchJson, deleteJson, showToast,
    // W5：win32 后端不支持密码 SSH，表单据此隐藏密码框（/api/status.platform 追加字段）。
    getPlatform: () => state.getStatus()?.platform ?? null,
    onChanged: async () => {
      const incidentsUpdated = fetchIncidents({ force: true });
      await loadServers();
      renderSettingsConfig();
      personal.loaded = false;
      if (personal.dirty) setHint("服务器配置已变化；已保留你的未保存编辑。保存时会检查版本，避免覆盖新配置。");
      else await loadPersonalConfig();
      await Promise.all([refresh({ force: true }), incidentsUpdated]);
    },
  });

  let localResourceRefreshTimer = null;
  function startLocalResourceRefresh() {
    if (localResourceRefreshTimer) return;
    localResourceRefreshTimer = setIntervalFn(() => {
      if (!isOpen()) {
        stopLocalResourceRefresh();
        return;
      }
      if (!isHidden()) Promise.resolve(registry.refreshLocal()).catch(() => {});
    }, LOCAL_RESOURCE_REFRESH_MS);
  }
  function stopLocalResourceRefresh() {
    if (!localResourceRefreshTimer) return;
    clearIntervalFn(localResourceRefreshTimer);
    localResourceRefreshTimer = null;
  }

  // 页面自报版本取自加载时的 status.version（app.js 的 loadedClientVersion），
  // 不写死字面量——写死会在设置页显示一个与安装包无关的版本号。
  async function refreshSettingsVersion() {
    const body = getEl("settingsVersionBody");
    if (!body) return;
    const stateBadge = getEl("settingsVersionState");
    try {
      const info = await getJson("/api/build-info");
      body.innerHTML = buildVersionDetailsHtml(info, { clientBuild: getClientVersion() });
      if (stateBadge) stateBadge.textContent = info?.compatibility?.state || "-";
    } catch {
      body.innerHTML = '<p class="incidents-empty">版本信息读取失败（monitor 未就绪或鉴权失效）。</p>';
    }
  }

  function renderSettingsConfig() {
    const body = getEl("settingsConfigBody");
    const config = state.getConfig();
    if (!body || !config) return;
    body.innerHTML = buildSettingsConfigHtml(config);
  }

  async function loadPersonalConfig() {
    if (personal.loaded || personal.dirty || personal.loading) return;
    const editor = getEl("personalConfigEditor");
    const save = getEl("savePersonalConfigBtn");
    personal.loading = true;
    save.disabled = true;
    editor.disabled = true;
    try {
      const data = await getJson("/api/config/personal");
      // 读取在飞期间用户开始编辑了：不覆盖他的输入（下次保存按旧版本号走，冲突时照常提示）。
      if (!personal.dirty) {
        editor.value = JSON.stringify(data.config, null, 2);
        personal.revision = data.config?.revision ?? 0;
        personal.loaded = true;
      }
      save.disabled = false;
      editor.disabled = false;
    } catch (error) {
      setHint(`读取失败：${error.serverMessage || error.message}；重新打开配置可重试。`);
    } finally {
      personal.loading = false;
    }
  }

  // 个人层在这个浮层之外被改了：切换查看的服务器 / Agent、开关监控模块与界面面板、登录时写白名单、
  // 另一个窗口、命令行向导……都会让版本号 +1，浮层里各节手里的版本号就旧了，下一次保存会撞上
  // 「配置已被修改，请重新加载后保存」。/api/status 带着最新版本号（personalRevision），每轮状态对一下，
  // 落后的那一节自动重读：
  //   服务器登记  提交在飞时不打断（它结束后自己会刷新），其余直接重读；正在填的表单不清空，
  //               被编辑的那台本身没变就把保存基线挪到新版本（见 server-cards.js 的 editSnapshot）。
  //   JSON 编辑器 有未保存的编辑时绝不覆盖，只提示一次；否则静默重读。
  //   出网        重读即可（它自己按版本号丢弃过期响应，输入框里未提交的地址不动）。
  let hintedRevision = null; // 「已保留未保存编辑」每个版本只提示一次，不每轮状态刷一遍
  const syncing = { registry: false, egress: false };
  function syncToRevision(revision) {
    if (!Number.isInteger(revision)) return;
    if (registry.getRevision?.() !== revision && !registry.isBusy?.() && !syncing.registry) {
      syncing.registry = true;
      Promise.resolve(registry.refresh()).catch(() => {}).finally(() => { syncing.registry = false; });
    }
    if (personal.loaded && personal.revision !== revision && !personal.saving && !personal.loading) {
      if (personal.dirty) {
        if (hintedRevision !== revision) {
          hintedRevision = revision;
          setHint("个人配置已在别处更新；已保留你的未保存编辑。保存时会检查版本，避免覆盖新配置。");
        }
      } else {
        personal.loaded = false;
        loadPersonalConfig();
      }
    }
    const egressRevision = egress.getRevision?.();
    if (Number.isInteger(egressRevision) && egressRevision !== revision && !syncing.egress) {
      syncing.egress = true;
      Promise.resolve(egress.load()).catch(() => {}).finally(() => { syncing.egress = false; });
    }
  }

  async function reloadPersonalConfig() {
    if (personal.saving) return;
    if (personal.dirty && !confirm("重新加载会丢弃尚未保存的 JSON 编辑，继续吗？")) return;
    personal.dirty = false;
    personal.loaded = false;
    await loadPersonalConfig();
  }

  async function savePersonalConfig() {
    if (personal.saving) return;
    personal.saving = true;
    const save = getEl("savePersonalConfigBtn");
    if (save) save.disabled = true;
    try {
      const value = JSON.parse(getEl("personalConfigEditor")?.value || "{}");
      if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("配置必须是 JSON 对象");
      const saved = await postJson("/api/config/personal", { ...value, expectedRevision: personal.revision });
      personal.dirty = false;
      personal.loaded = false;
      await loadPersonalConfig();
      await loadServers();
      await registry.refresh();
      await Promise.all([refresh({ force: true }), fetchIncidents({ force: true })]);
      renderSettingsConfig();
      const notice = saved.restartRequired ? "已保存。服务器条目已重新加载；全局代理等启动配置需重启通道后应用。" : "已保存并重新加载，请查看连接状态。";
      setHint(notice);
      showToast({ type: "success", message: notice, title: "配置" });
    } catch (err) {
      setHint(`保存失败：${err.serverMessage || err.message}`);
      showToast({ type: "error", message: err.serverMessage || err.message, title: "配置保存失败" });
    } finally {
      personal.saving = false;
      if (save) save.disabled = false;
    }
  }

  function onOpen() {
    refreshSettingsVersion();
    proxyAuth.onOpen();
    egress.onOpen();
    loadPersonalConfig();
    renderSettingsConfig();
    Promise.resolve(registry.refresh()).catch(() => {});
    Promise.resolve(registry.refreshLocal()).catch(() => {});
    startLocalResourceRefresh();
  }

  // perf：配置来源摘要只在浮层打开时随状态重算，收起期间不必每轮重建。
  // status 缺省时退回 state 里最新的一份（旧调用方不传参）。
  function onStatus(status = state.getStatus()) {
    if (!isOpen()) return;
    renderSettingsConfig();
    syncToRevision(status?.personalRevision);
  }

  getEl("personalConfigEditor")?.addEventListener("input", () => {
    personal.dirty = true;
  });
  getEl("reloadPersonalConfigBtn")?.addEventListener("click", reloadPersonalConfig);
  getEl("savePersonalConfigBtn")?.addEventListener("click", savePersonalConfig);
  doc.getElementById("dlgSettings")?.addEventListener("close", stopLocalResourceRefresh);
  win?.addEventListener("pagehide", stopLocalResourceRefresh, { once: true });

  return { onOpen, onStatus, registry, egress };
}
