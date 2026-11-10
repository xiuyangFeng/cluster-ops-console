// app/settings-backup.js —— 配置浮层「备份与迁移」一节（v2.64）：导出个人配置与本机偏好、换电脑时导入。
//
// 读：打开配置时 GET /api/config/transfer（导出不包含什么、个人配置写前备份在哪）。
// 导出：GET /api/config/export → 桌面窗口里经 electronAPI.saveExportFile 弹系统保存对话框；网页里走浏览器下载。
// 导入：选文件（本地读，不上传到别处）→ POST /api/config/import/preview → 就地列出将改动的条目（新增 / 修改 / 删除），
//       端口相关的单独一组、默认不勾并说明后果；本机有、文件里没有的（删除）单独一组、默认不勾；
//       暂时用不上的列出原因、不能勾 →「导入所选」→ POST /api/config/import
//       （写前自动备份）→ 列出结果与跳过的条目。
// 骨架在 index.html（#settingsBackup），这里只填动态部分；按钮与勾选走事件委托。界面与接口里没有任何口令 / 令牌。
import { clockOf, dayKeyOf } from "../render/usage-model.js";
import { escapeHtml } from "../store.js";

// 与后端 lib/config-transfer/document.mjs 的 IMPORT_MAX_BYTES 一致：选了更大的文件就地拒绝，不发请求。
export const IMPORT_FILE_MAX_BYTES = 256 * 1024;
export const KIND_TEXT = { added: "新增", changed: "修改", removed: "删除" };
const SSH_KEYS_SHORT = "新电脑导入配置后，运行接入引导生成本机密钥并登记公钥，无需拷贝旧电脑的私钥。";
export const SSH_KEYS_NOTE = "新电脑导入配置后，点「换电脑 / 重新检测接入」，使用自己的集群账号接入：本机密钥与公钥授权会自动准备，无需拷贝旧电脑的私钥。用密码登录的其他服务器，在「服务器管理」里重新填写密码。";

const errText = (err) => err?.serverMessage || err?.message || "未知错误";

// 纯函数：说明区——导出不包含什么、写前备份在哪。
export function buildBackupInfoHtml(info) {
  if (!info) return '<p class="eg-note">打开后读取…</p>';
  const excluded = (info.excluded || []).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const backups = info.backups || {};
  const latest = backups.latest ? `，最近一份 ${escapeHtml(formatStamp(backups.latest.stamp))}` : "";
  return `<p class="eg-note">导出：个人配置（服务器、端口、出网、自动修复、数据预算等）、监控模块开关、界面面板显隐${info.includesJobAlerts ? "、各服务器的作业提醒规则" : ""}。</p>`
    + `<p class="eg-note">不包含：</p><ul class="bk-excluded">${excluded}</ul>`
    + `<p class="eg-note">每次保存个人配置前自动留备份（最近 ${Number(backups.keep) || 5} 份，现有 ${Number(backups.count) || 0} 份${latest}）：<code>${escapeHtml(backups.dir || "")}</code></p>`;
}

// 20261014-090507 → 2026-10-14 09:05:07（北京时间）
export function formatStamp(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(stamp || ""));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : String(stamp || "");
}

// 新增只写新值、删除只写原值，修改写「原值 → 新值」。
function valuesHtml(change) {
  if (change.kind === "added") return `<code>${escapeHtml(change.after)}</code>`;
  if (change.kind === "removed") return `<code>${escapeHtml(change.before)}</code>`;
  return `<code>${escapeHtml(change.before)}</code><span aria-hidden="true">→</span><code>${escapeHtml(change.after)}</code>`;
}

// 「删除」一组的说明：导入是补齐与覆盖，这些默认留在本机。
export const REMOVALS_NOTE = "导入是补齐与覆盖：这些默认留在这台电脑上，勾上才删除。删带隧道的服务器会让它的隧道断开。";

// 端口一组的说明：后端给（preview.portsNote），旧后端没给时用这一句。
export const PORTS_NOTE_FALLBACK = "这些会改这台电脑的隧道端口。端口在集群上按人登记，同一个账号换电脑、要沿用原来的端口才勾；拿不准就别勾，导入后在「服务器管理」里重新领取。";

function changeRow(change, checked) {
  const disabled = !change.available;
  const note = disabled ? change.reason : change.note;
  return `<li class="bk-change${change.ports ? " is-ports" : ""}${disabled ? " is-unavailable" : ""}">`
    + `<label class="bk-change-head"><input type="checkbox" data-bk-change="${escapeHtml(change.id)}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}>`
    + `<span class="bk-kind" data-kind="${escapeHtml(change.kind)}">${escapeHtml(KIND_TEXT[change.kind] || change.kind)}</span>`
    + `<span class="bk-label">${escapeHtml(change.label)}</span></label>`
    + `<div class="bk-values">${valuesHtml(change)}</div>`
    + (note ? `<p class="bk-change-note">${escapeHtml(note)}</p>` : "")
    + "</li>";
}

// 纯函数：预览——将改动的条目（端口一组、默认不勾）与确认按钮。selected：Set（勾着的 id）。
export function buildImportPreviewHtml(preview, selected, { fileName = "", busy = false } = {}) {
  const changes = preview?.changes || [];
  const meta = preview?.meta || {};
  const exportedSec = meta.exportedAt ? Date.parse(meta.exportedAt) / 1000 : Number.NaN;
  const from = [meta.appVersion ? `v${meta.appVersion}` : "", Number.isFinite(exportedSec) ? `导出于 ${dayKeyOf(exportedSec)} ${clockOf(exportedSec)}（北京时间）` : ""].filter(Boolean).join("，");
  const head = `<p class="eg-note">${escapeHtml(fileName || "导入文件")}${from ? `（${escapeHtml(from)}）` : ""}</p>`;
  if (!changes.length) {
    return `${head}<p class="bk-empty">和这台电脑现在的配置一样，没有要改的。</p><div class="eg-actions"><button type="button" class="text-btn" data-bk-cancel>关闭</button></div>`;
  }
  const normal = changes.filter((c) => !c.ports && c.available && c.kind !== "removed");
  const ports = changes.filter((c) => c.ports && c.available && c.kind !== "removed");
  const removals = changes.filter((c) => c.available && c.kind === "removed");
  const unavailable = changes.filter((c) => !c.available);
  const group = (title, list, extra = "") => (list.length
    ? `<div class="bk-group"><p class="bk-group-title">${escapeHtml(title)}</p>${extra}<ul class="bk-changes">${list.map((c) => changeRow(c, selected.has(c.id))).join("")}</ul></div>`
    : "");
  const count = changes.filter((c) => c.available && selected.has(c.id)).length;
  return head
    + group("将改动的配置", normal)
    + group("端口（默认不导入）", ports, `<p class="bk-warn">${escapeHtml(preview.portsNote || PORTS_NOTE_FALLBACK)}</p>`)
    + group("本机有、文件里没有（默认保留）", removals, `<p class="bk-warn">${escapeHtml(REMOVALS_NOTE)}</p>`)
    + group("暂时导入不了", unavailable)
    + `<p class="eg-note">导入前会自动备份这台电脑现在的个人配置。</p>`
    + `<div class="eg-actions"><button type="button" class="btn btn-primary" data-bk-apply${count && !busy ? "" : " disabled"}>${busy ? "正在导入…" : `导入所选（${count} 项）`}</button><button type="button" class="text-btn" data-bk-cancel${busy ? " disabled" : ""}>取消</button></div>`;
}

// 纯函数：导入结果。
export function buildImportResultHtml(result, changes = []) {
  const labelOf = (id) => changes.find((c) => c.id === id)?.label || id;
  const applied = result?.applied || [];
  const skipped = result?.skipped || [];
  const lines = [`<p class="bk-done">已导入 ${applied.length} 项${result?.backup?.name ? `；导入前的配置已备份为 <code>${escapeHtml(result.backup.name)}</code>` : ""}。</p>`];
  if (skipped.length) {
    lines.push(`<p class="eg-note">没有导入的：</p><ul class="bk-excluded">${skipped.map((item) => `<li>${escapeHtml(labelOf(item.id))}：${escapeHtml(item.reason)}</li>`).join("")}</ul>`);
  }
  lines.push(`<p class="eg-note">${escapeHtml(SSH_KEYS_SHORT)}</p><div class="eg-actions"><button type="button" class="btn btn-secondary" data-onboarding-open data-onboarding-recheck>换电脑 / 重新检测接入</button><button type="button" class="text-btn" data-bk-cancel>关闭</button></div>`);
  return lines.join("");
}

// 浏览器下载（网页模式；桌面壳太旧、没有保存对话框接口时也走这里）。
function browserDownload(doc, filename, content) {
  const win = doc.defaultView || globalThis;
  const url = win.URL.createObjectURL(new win.Blob([content], { type: "application/json;charset=utf-8" }));
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
}

// electronAPI：桌面窗口里的 window.electronAPI（浏览器里为 null）。onImported：导入写完后让页面其余部分重读。
export function createSettingsBackup({ doc, getJson, postJson, showToast, electronAPI = null, onImported = async () => {}, download = null }) {
  const getEl = (id) => doc.getElementById(id);
  const save = download || ((filename, content) => browserDownload(doc, filename, content));
  let info = null;
  let pending = null; // { document, preview, fileName, selected: Set }
  let busy = false;

  function renderInfo() {
    const box = getEl("backupInfo");
    if (box) box.innerHTML = buildBackupInfoHtml(info);
  }

  function renderPanel(html) {
    const panel = getEl("backupImportPanel");
    if (!panel) return;
    panel.hidden = !html;
    panel.innerHTML = html || "";
  }

  function renderPreview() {
    if (!pending) return renderPanel("");
    renderPanel(buildImportPreviewHtml(pending.preview, pending.selected, { fileName: pending.fileName, busy }));
  }

  async function load() {
    try {
      info = await getJson("/api/config/transfer");
    } catch (err) {
      info = null;
      const box = getEl("backupInfo");
      if (box) {
        box.innerHTML = `<p class="eg-note">${escapeHtml(err?.status === 404 ? "运行中的监控服务还是旧版本，没有这一项；重启界面后再打开。" : `读取失败：${errText(err)}`)}</p>`;
      }
      return;
    }
    renderInfo();
  }

  async function exportConfig() {
    const button = getEl("backupExportBtn");
    if (button) button.disabled = true;
    try {
      const { filename, document } = await getJson("/api/config/export");
      const content = `${JSON.stringify(document, null, 2)}\n`;
      if (typeof electronAPI?.saveExportFile === "function") {
        const result = await electronAPI.saveExportFile(filename, content);
        if (result?.saved) showToast({ type: "success", title: "导出配置", message: `已保存为 ${result.name}。${SSH_KEYS_SHORT}`, duration: 9000 });
        else if (result?.error) showToast({ type: "error", title: "导出配置", message: result.error });
      } else {
        save(filename, content);
        showToast({ type: "success", title: "导出配置", message: `已下载 ${filename}。${SSH_KEYS_SHORT}`, duration: 9000 });
      }
    } catch (err) {
      showToast({ type: "error", title: "导出配置", message: `导出失败：${errText(err)}` });
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function previewFile(file) {
    if (!file) return;
    if (file.size > IMPORT_FILE_MAX_BYTES) {
      renderPanel(`<p class="bk-warn">${escapeHtml(`${file.name} 太大（上限 256 KB），不像是工作台导出的配置文件。`)}</p>`);
      return;
    }
    let document;
    try {
      document = JSON.parse(await file.text());
    } catch {
      renderPanel(`<p class="bk-warn">${escapeHtml(`${file.name} 不是 JSON 文件。`)}</p>`);
      return;
    }
    renderPanel('<p class="eg-note">正在比对…</p>');
    try {
      const preview = await postJson("/api/config/import/preview", { document });
      pending = { document, preview, fileName: file.name, selected: new Set(preview.defaultSelected || []) };
      renderPreview();
    } catch (err) {
      pending = null;
      renderPanel(`<p class="bk-warn">${escapeHtml(errText(err))}</p>`);
    }
  }

  async function applyImport() {
    if (!pending || busy) return;
    busy = true;
    renderPreview();
    const changes = pending.preview.changes || [];
    try {
      const result = await postJson("/api/config/import", {
        document: pending.document,
        selected: [...pending.selected],
        revision: pending.preview.revision,
      });
      pending = null;
      busy = false;
      renderPanel(buildImportResultHtml(result, changes));
      showToast({ type: "success", title: "导入配置", message: `已导入 ${result.applied?.length || 0} 项${result.skipped?.length ? `，${result.skipped.length} 项没有导入` : ""}。` });
      await load();
      await onImported(result);
    } catch (err) {
      busy = false;
      renderPreview();
      const fields = Array.isArray(err?.errors) ? err.errors.map((e) => `${e.field}：${e.message}`).join("；") : "";
      showToast({ type: "error", title: "导入配置", message: `没有导入：${errText(err)}${fields ? `（${fields}）` : ""}`, duration: 10000 });
    }
  }

  function reset() {
    pending = null;
    busy = false;
    renderPanel("");
    const input = getEl("backupImportFile");
    if (input) input.value = "";
  }

  function onClick(event) {
    const target = event.target;
    if (target?.closest?.("[data-bk-apply]")) return applyImport();
    if (target?.closest?.("[data-bk-cancel]")) return reset();
    return undefined;
  }

  function onChange(event) {
    const id = event.target?.dataset?.bkChange;
    if (!id || !pending) return;
    if (event.target.checked) pending.selected.add(id);
    else pending.selected.delete(id);
    // 只改按钮上的数字，不重画列表（勾选框不丢焦点）。
    const button = getEl("backupImportPanel")?.querySelector?.("[data-bk-apply]");
    if (button) {
      const count = (pending.preview.changes || []).filter((c) => c.available && pending.selected.has(c.id)).length;
      button.textContent = `导入所选（${count} 项）`;
      button.disabled = count === 0;
    }
  }

  getEl("backupExportBtn")?.addEventListener("click", exportConfig);
  getEl("backupImportBtn")?.addEventListener("click", () => getEl("backupImportFile")?.click());
  getEl("backupImportFile")?.addEventListener("change", (event) => previewFile(event.target?.files?.[0]));
  getEl("backupImportPanel")?.addEventListener("click", onClick);
  getEl("backupImportPanel")?.addEventListener("change", onChange);
  const note = getEl("backupSshNote");
  if (note) note.textContent = SSH_KEYS_NOTE;

  return { onOpen: load, load, exportConfig, previewFile, applyImport, reset, getPending: () => pending };
}
