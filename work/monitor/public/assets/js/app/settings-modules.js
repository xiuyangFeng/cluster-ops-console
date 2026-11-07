// app/settings-modules.js —— 配置浮层里的「监控模块」与「界面面板」两段（v2.47）。
//
// 监控模块：打开配置时读 GET /api/modules；每个开关单独 POST /api/modules { id, enabled }（单项写入，
// 不整表覆盖，避免两个窗口互相踩），请求在飞时禁用该开关，失败回滚并提示。后端立即热载、无需重启。
// 写入串行：回包是处理那一刻的整张模块表，并发时较旧的整表后到会把刚关掉的模块重新勾上；串行后
// 服务端处理顺序 = 发出顺序。整表回显（GET / POST）另按发出序号丢弃过期的一份（打开时的旧 GET）。
// 界面面板：勾选 = 显示；逐项即时 POST /api/ui-prefs { hiddenPanels }，先乐观应用、失败回滚。
// 偏好存个人层配置（不用 localStorage：页面 origin 带端口）。
//
// 列表结构只在内容变化时重建，勾选 / 禁用状态直接改属性：保存后不重建，焦点留在刚点的开关上。
import { escapeHtml } from "../store.js";
import { moduleEnabled, panelGroups, userHiddenPanels } from "./panels.js";

const MODULE_GROUPS = [
  { id: "agent", label: "Agent", empty: "没有配置 Agent。" },
  { id: "data", label: "数据采集", empty: "" },
];

// 纯函数：监控模块列表（开关 + 名称 + 说明 + 采集代价 + 关闭提示）；core 组只列名字、不给开关。
export function buildModulesHtml(modules) {
  const list = Array.isArray(modules) ? modules : [];
  const groups = MODULE_GROUPS.map((group) => {
    const items = list.filter((m) => m?.group === group.id && !m.locked);
    if (!items.length && !group.empty) return "";
    const rows = items.map((m) => `
      <label class="mod-item">
        <span class="mod-text">
          <span class="mod-label">${escapeHtml(m.label || m.id)}</span>
          ${m.description ? `<span class="mod-desc">${escapeHtml(m.description)}</span>` : ""}
          ${m.cost ? `<span class="mod-cost">采集代价 · ${escapeHtml(m.cost)}</span>` : ""}
          ${m.defaultEnabled === false ? '<span class="mod-cost">团队默认关闭，按需打开</span>' : ""}
          ${m.warning ? `<span class="mod-warn">${escapeHtml(m.warning)}</span>` : ""}
        </span>
        <input type="checkbox" role="switch" class="mod-switch" data-module-id="${escapeHtml(m.id)}" aria-label="${escapeHtml(`监控 ${m.label || m.id}`)}"${m.enabled === false ? "" : " checked"}>
      </label>`).join("");
    return `<section class="mod-group"><h3 class="mod-group-title">${escapeHtml(group.label)}</h3>${rows ? `<div class="mod-list">${rows}</div>` : `<p class="mod-empty">${escapeHtml(group.empty)}</p>`}</section>`;
  }).join("");
  const core = list.filter((m) => m?.group === "core" || m?.locked).map((m) => m.label || m.id);
  return groups + (core.length ? `<p class="mod-core">始终开启：${escapeHtml(core.join("、"))}——核心检查，不可关闭</p>` : "");
}

// 纯函数：开关结果提示。
export function moduleToastText(module, enabled) {
  const label = module?.label || module?.id || "该模块";
  const name = module?.group === "agent" ? ` ${label} 监控` : `「${label}」`;
  return enabled ? `已开启${name}，正在重新检查` : `已关闭${name}，相关检查已停止`;
}

// 纯函数：界面面板勾选列表（按视图分组；整页项在组头，锁定项勾选 + 禁用 +「始终显示」）。
export function buildPanelsHtml() {
  const item = (panel, { page = false } = {}) => `
      <label class="pn-item${page ? " pn-page" : ""}">
        <input type="checkbox" data-panel-id="${escapeHtml(panel.id)}" checked${panel.locked ? " disabled" : ""}>
        <span class="pn-label">${escapeHtml(page ? `「${panel.label}」整页` : panel.label)}</span>
        <span class="pn-note" data-panel-note="${escapeHtml(panel.id)}">${panel.locked ? "始终显示" : ""}</span>
      </label>`;
  const groups = panelGroups().map((group) => `
    <section class="pn-group">
      <h3 class="pn-group-title">${escapeHtml(group.label)}</h3>
      <div class="pn-list">${item(group.page, { page: true })}${group.panels.map((panel) => item(panel)).join("")}</div>
    </section>`).join("");
  return `<div class="pn-groups">${groups}</div>
    <div class="pn-actions"><button type="button" class="text-btn" data-panels-reset>恢复默认</button><span class="pn-hint">页头的通道状态、注意力队列与告警横幅始终显示</span></div>`;
}

// 纯函数：每个勾选框此刻的状态 { checked, disabled, note }。
// hidden：个人偏好里的隐藏项；整页被隐藏时页内面板禁用；用量模块关闭时用量页随模块隐藏、不可勾选。
export function panelCheckStates(status, hidden = userHiddenPanels(status)) {
  const set = new Set(hidden);
  const usageOn = moduleEnabled(status, "usage");
  const states = {};
  for (const group of panelGroups()) {
    const pageOff = set.has(group.page.id) || (group.view === "usage" && !usageOn);
    for (const panel of [group.page, ...group.panels]) {
      if (panel.locked) {
        states[panel.id] = { checked: true, disabled: true, note: "始终显示" };
      } else if (panel.id === "view.usage" && !usageOn) {
        states[panel.id] = { checked: false, disabled: true, note: "用量模块已关闭" };
      } else if (panel !== group.page && pageOff) {
        states[panel.id] = { checked: !set.has(panel.id), disabled: true, note: "整页已隐藏" };
      } else {
        states[panel.id] = { checked: !set.has(panel.id), disabled: false, note: "" };
      }
    }
  }
  return states;
}

// 配置浮层的两段控制器。getStatus：最新 status（hiddenPanels / modules）；
// onModulesChanged() / onPanelsSaved()：保存成功后立即全量刷新 /api/status——关掉一个 Agent 不是级别变化，
// 后端不会为它推 SSE，不能干等；onHiddenPanels(list)：立即按新列表重渲（乐观应用 / 回滚 / 服务器回显）。
export function createSettingsModules({
  doc, getJson, postJson, showToast, getStatus, onModulesChanged = () => {}, onPanelsSaved = () => {}, onHiddenPanels = () => {},
}) {
  const getEl = (id) => doc.getElementById(id);
  let modules = [];
  let modulesSig = null;
  const pendingModules = new Set();
  let moduleWrites = Promise.resolve(); // 模块写入队列（串行）
  let listSeq = 0; // 整表请求的发出序号
  let appliedListSeq = 0; // 已采用的整表序号：更早发出的回包一律丢弃
  let panelsBuilt = false;
  let panelsSaving = false;
  // 正在保存的面板列表：保存期间状态推送带回的旧列表不覆盖勾选（避免闪回）。
  let panelsPending = null;

  // ---- 监控模块 ----
  function syncModuleInputs() {
    const body = getEl("settingsModulesBody");
    for (const input of body?.querySelectorAll("[data-module-id]") || []) {
      const id = input.dataset.moduleId;
      const entry = modules.find((m) => m.id === id);
      if (!entry) continue;
      if (!pendingModules.has(id)) input.checked = entry.enabled !== false;
      input.disabled = pendingModules.has(id);
    }
  }

  function renderModules(next) {
    const body = getEl("settingsModulesBody");
    if (!body) return;
    modules = Array.isArray(next) ? next : [];
    // 结构签名不含 enabled：开关状态变化只改属性，不重建（焦点不丢）。
    const sig = JSON.stringify(modules.map((m) => [m.id, m.group, m.label, m.description, m.cost, m.warning, m.locked]));
    if (sig !== modulesSig) {
      modulesSig = sig;
      body.innerHTML = buildModulesHtml(modules);
    }
    syncModuleInputs();
  }

  // 采用一份整表回显；比已采用的更早发出则丢弃（返回 false）。
  function applyModulesList(list, seq) {
    if (seq < appliedListSeq) return false;
    appliedListSeq = seq;
    renderModules(list);
    return true;
  }

  async function loadModules() {
    const body = getEl("settingsModulesBody");
    const seq = ++listSeq;
    try {
      const data = await getJson("/api/modules");
      applyModulesList(data?.modules, seq);
    } catch (err) {
      if (seq < appliedListSeq) return; // 已有更新的整表，旧读取失败不再盖掉列表
      modulesSig = null;
      if (body) body.innerHTML = `<p class="incidents-empty">模块列表读取失败：${escapeHtml(err?.serverMessage || err?.message || "未知错误")}；重新打开配置可重试。</p>`;
    }
  }

  async function toggleModule(input) {
    const id = input.dataset.moduleId;
    if (!id || pendingModules.has(id)) return;
    const enabled = Boolean(input.checked);
    const entry = modules.find((m) => m.id === id) || { id };
    pendingModules.add(id);
    input.disabled = true;
    const write = moduleWrites.then(async () => {
      const seq = ++listSeq; // 真正发出时才取号：串行队列里的顺序即服务端处理顺序
      return { res: await postJson("/api/modules", { id, enabled }), seq };
    });
    moduleWrites = write.catch(() => {});
    try {
      const { res, seq } = await write;
      pendingModules.delete(id);
      if (!Array.isArray(res?.modules) || !applyModulesList(res.modules, seq)) {
        const current = modules.find((m) => m.id === id);
        if (current) current.enabled = enabled;
        syncModuleInputs();
      }
      input.disabled = false;
      showToast({ type: "success", title: "监控模块", message: moduleToastText(entry, enabled) });
    } catch (err) {
      pendingModules.delete(id);
      input.checked = !enabled;
      input.disabled = false;
      showToast({ type: "error", title: "监控模块", message: `保存失败：${err?.serverMessage || err?.message || "未知错误"}` });
      return;
    }
    // 已保存：全量刷新一次，Agent 状态带、诊断入口、用量页随新配置对齐（刷新失败由刷新循环自己提示）。
    await Promise.resolve(onModulesChanged()).catch(() => {});
  }

  // ---- 界面面板 ----
  function renderPanels() {
    const body = getEl("settingsPanelsBody");
    if (!body) return;
    if (!panelsBuilt) {
      body.innerHTML = buildPanelsHtml();
      panelsBuilt = true;
    }
    const status = getStatus() || {};
    const states = panelCheckStates(status, panelsPending ?? userHiddenPanels(status));
    for (const input of body.querySelectorAll?.("[data-panel-id]") || []) {
      const s = states[input.dataset.panelId];
      if (!s) continue;
      input.checked = s.checked;
      input.disabled = s.disabled || panelsSaving;
    }
    for (const note of body.querySelectorAll?.("[data-panel-note]") || []) {
      const s = states[note.dataset.panelNote];
      if (s && note.textContent !== s.note) note.textContent = s.note;
    }
  }

  async function savePanels(next) {
    if (panelsSaving) return;
    const status = getStatus() || {};
    const before = userHiddenPanels(status);
    panelsSaving = true;
    panelsPending = next;
    onHiddenPanels(next); // 乐观应用：面板立即隐藏 / 显示
    renderPanels();
    try {
      const res = await postJson("/api/ui-prefs", { hiddenPanels: next });
      panelsPending = null;
      onHiddenPanels(Array.isArray(res?.hiddenPanels) ? res.hiddenPanels : next);
      Promise.resolve(onPanelsSaved()).catch(() => {});
    } catch (err) {
      panelsPending = null;
      onHiddenPanels(before);
      showToast({ type: "error", title: "界面面板", message: `保存失败：${err?.serverMessage || err?.message || "未知错误"}` });
    } finally {
      panelsSaving = false;
      renderPanels();
    }
  }

  function togglePanel(input) {
    const id = input.dataset.panelId;
    const current = panelsPending ?? userHiddenPanels(getStatus() || {});
    const next = input.checked ? current.filter((item) => item !== id) : [...new Set([...current, id])];
    return savePanels(next);
  }

  function bind() {
    getEl("settingsModulesBody")?.addEventListener("change", (event) => {
      const input = event.target?.closest?.("[data-module-id]");
      if (input) return toggleModule(input);
    });
    const panels = getEl("settingsPanelsBody");
    panels?.addEventListener("change", (event) => {
      const input = event.target?.closest?.("[data-panel-id]");
      if (input && !input.disabled) return togglePanel(input);
    });
    panels?.addEventListener("click", (event) => {
      if (event.target?.closest?.("[data-panels-reset]")) return savePanels([]);
    });
  }

  function onOpen() {
    loadModules();
    renderPanels();
  }

  // 浮层打开时随状态推送校正面板勾选（另一个窗口改了偏好、模块开关联动用量页）；收起期间不动。
  function onStatus() {
    if (panelsBuilt && getEl("dlgSettings")?.open) renderPanels();
  }

  bind();
  return { onOpen, onStatus, loadModules, toggleModule, togglePanel, savePanels };
}
