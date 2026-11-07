import { escapeHtml, formatBytes, formatClock } from "./store.js";

// ISO 时间串 / 毫秒 → 界面上的时刻：当天只写「18:29:06」，跨天带上「10-02 18:29」。
// 解析不了时原样返回（不把坏值吞掉）。此前这些位置直接显示 2026-10-03T10:29:06.667Z 这样的 UTC 原文。
export function clockText(value, nowMs = Date.now()) {
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return String(value ?? "");
  const d = new Date(ms);
  if (d.toDateString() === new Date(nowMs).toDateString()) return formatClock(ms, { locale: "zh-CN", hour12: false });
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const SERVER_STATE_LABELS = {
  configured: "已配置",
  testing: "测试中",
  online: "在线",
  offline: "离线",
  "auth-failed": "认证失败",
  "auth-required": "需重新录入密码",
  "hostkey-required": "需确认主机密钥",
  disabled: "已禁用",
  removed: "已删除",
};

export function describeServerImpact(server, action = "delete") {
  const name = server?.name || server?.id || "该服务器";
  if (action === "disable") return `将禁用「${name}」，停止调度它的监控探针，已有隧道等待守护进程撤销。配置保留，可再次启用。`;
  if (server?.source === "team") {
    return `将屏蔽团队服务器「${name}」。不会删除团队配置，也不会停止其他服务器的隧道。`;
  }
  if (server?.tunnelEnabled !== false && server?.tunnel !== false) {
    return `将先禁用「${name}」并停止它的监控探针与反向隧道，再删除本机条目。相关事件会从概览和事件列表移除，与服务器一起保留，7 天内可恢复，过期后清除。其他服务器的视角和隧道不受影响。`;
  }
  return `将先禁用「${name}」并停止它的监控探针，再删除本机条目。该机当前未建隧道。相关事件会从概览和事件列表移除，与服务器一起保留，7 天内可恢复，过期后清除。其他服务器不受影响。`;
}

export function formatServerCard(server) {
  return {
    id: server.id,
    title: server.name || server.address || server.host || server.id,
    meta: `${server.address || server.host || "-"}${server.sshPort && server.sshPort !== 22 ? `:${server.sshPort}` : ""} · ${server.sshUser || "未填用户"} · ${server.source === "team" ? "团队" : "个人"}`,
    state: SERVER_STATE_LABELS[server.state] || server.state || "已配置",
    stateKey: server.state || "configured",
    tunnel: server.tunnelEnabled !== false && server.tunnel !== false,
    monitor: server.monitorEnabled !== false && server.disabled !== true,
    canDelete: server.source !== "team",
    canEdit: server.source !== "team",
    lastTest: server.lastTest?.code ? `${server.lastTest.ok ? "测试成功" : server.lastTest.code}${server.lastTest.checkedAt ? ` · ${clockText(server.lastTest.checkedAt)}` : ""}` : "",
  };
}

export function serverFormValues(server) {
  return {
    name: server?.name || "",
    address: server?.address || server?.host || "",
    sshPort: server?.sshPort || 22,
    sshUser: server?.sshUser || "",
    remotePort: server?.remotePort ?? "",
    tunnel: server ? server.tunnel !== false : false,
    monitor: server?.monitorEnabled !== false && server?.disabled !== true,
  };
}

export function applyServerFormValues(form, values) {
  if (!form?.elements) return values;
  if (form.elements.name) form.elements.name.value = values.name;
  if (form.elements.address) form.elements.address.value = values.address;
  if (form.elements.sshPort) form.elements.sshPort.value = values.sshPort;
  if (form.elements.sshUser) form.elements.sshUser.value = values.sshUser;
  if (form.elements.remotePort) form.elements.remotePort.value = values.remotePort;
  if (form.elements.tunnel) form.elements.tunnel.checked = values.tunnel;
  if (form.elements.monitor) form.elements.monitor.checked = values.monitor;
  if (form.elements.password) form.elements.password.value = "";
  return values;
}

// W5：Windows 上密码 SSH 不受支持（ssh-askpass 会以 password-unsupported 拒绝），
// 与其让用户填完再报错，不如直接隐藏密码框并说明改用密钥。platform 取自 /api/status.platform。
export function passwordFieldPolicy(platform) {
  if (platform === "win32") {
    return { enabled: false, hint: "Windows 版暂不支持密码登录 SSH，请改用密钥或 ssh-agent。" };
  }
  return { enabled: true, hint: "" };
}

// 与后端 server-registry.PORT_UNCHECKED_WARNING 同文案（后端没带 warning 时的兜底）。
const PORT_UNCHECKED_WARNING = "未核对服务器上的端口占用，请手动填写反向端口";

// W5：反向端口建议值（/api/servers 的 suggestedPorts 追加字段）。只在"新增 + 勾选建隧道 +
// 用户还没填"时预填，绝不覆盖用户输入或编辑中的既有端口。
// 后端标了 checked=false（没核对服务器上的端口占用）→ 不预填，只作参考提示。
export function suggestedRemotePort(payload, { currentValue = "", editing = false, tunnel = false } = {}) {
  if (editing || !tunnel || String(currentValue || "").trim() !== "") return null;
  if (payload?.suggestedPorts?.checked === false) return null;
  const port = Number(payload?.suggestedPorts?.remotePort);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

// 未核对远端占用的参考值：以 placeholder + title 呈现（不是 value），并带上警告。
export function remotePortReferenceHint(payload) {
  const sp = payload?.suggestedPorts;
  if (sp?.checked !== false) return null;
  const port = Number(sp.remotePort);
  const ref = Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  const warning = sp.warning || PORT_UNCHECKED_WARNING;
  return {
    placeholder: ref ? `参考 ${ref}（未核对服务器占用）` : "请手填",
    title: `${warning}${ref ? `。${ref} 只避开了本机配置里的端口，未检查服务器上正在监听的端口` : ""}`,
  };
}

// W5：端口被占 → "重新分配端口…"的确认文案（预览即确认层，取消无副作用）。
export function describePortReassign(suggestion, serverName = "") {
  const name = serverName || suggestion?.serverId || "该服务器";
  const from = suggestion?.current?.remotePort ?? "?";
  const to = suggestion?.suggested?.remotePort ?? "?";
  const basis = suggestion?.probed
    ? `已通过 SSH 检查服务器上正在监听的端口（${(suggestion.listening || []).length} 个占用已避开）`
    : `未能探测服务器上的监听端口（${suggestion?.probeError || "未知原因"}），仅按本机配置避开已分配端口`;
  // v2.54 终审：登记目录可用时确认后会在集群上原子登记；不可用时明说"未登记"的风险。
  const registry = suggestion?.registered === true
    ? "\n确认后会在集群端口登记目录里登记这个端口（被人抢先时自动顺延到下一个空闲端口）。"
    : suggestion?.registered === false
      ? `\n未登记：服务器上没有可用的端口登记目录，只能按当前监听分配，对方离线时可能撞端口${suggestion.adminCommand ? `（请管理员执行 ${suggestion.adminCommand}）` : ""}。`
      : "";
  // 团队服务器有受管 env.sh，后端在端口变更后自动改过去（lib/cluster-env-sync.mjs）；个人服务器没有，照旧提醒手改。
  const clusterSide = suggestion?.source === "team"
    ? `集群上的代理配置（env.sh）会自动改到 ${to}，只对新开的终端生效：已经在运行的 codex / claude 和作业里还是旧端口 ${from}，隧道一换它们就连不上外网，需要重开终端或重启。`
    : `服务器上已按旧端口 ${from} 配置的代理变量需要改成 ${to}。`;
  return `为「${name}」重新分配反向端口：${from} → ${to}。\n${basis}。${registry}\n将写入个人配置，并只重启这一条隧道（其它连接与本机代理端口不受影响）。${clusterSide}确定继续？`;
}

// 后端不给自动建议（探测失败）时的说明：明确告知未核对占用与出路。
export function describePortReassignBlocked(suggestion, serverName = "") {
  const name = serverName || suggestion?.serverId || "该服务器";
  const warning = suggestion?.warning || PORT_UNCHECKED_WARNING;
  const reasons = {
    "password-auth": "密码认证的服务器不支持后台探测",
    fixture: "fixture 模式不探测",
  };
  const code = suggestion?.probeError || "unknown";
  const why = reasons[code] || `探测失败（${code}）`;
  return `「${name}」无法自动建议新端口：${why}。${warning}（在「设置 → 服务器」编辑该服务器填写反向端口）。`;
}

export function renderServerCardsHtml(payload) {
  const servers = Array.isArray(payload?.servers) ? payload.servers : [];
  const tombstones = Array.isArray(payload?.tombstones) ? payload.tombstones : [];
  if (!servers.length && !tombstones.length) {
    return '<p class="server-registry-empty">还没有个人服务器。填写地址、SSH 端口和用户名后即可测试连接。</p>';
  }
  const cards = servers.map((server) => {
    const model = formatServerCard(server);
    return `<article class="server-registry-card" data-server-id="${escapeHtml(model.id)}">
      <div class="server-registry-head">
        <strong>${escapeHtml(model.title)}</strong>
        <span class="server-registry-state" data-state="${escapeHtml(model.stateKey)}">${escapeHtml(model.state)}</span>
      </div>
      <p class="server-registry-meta">${escapeHtml(model.meta)}</p>
      <p class="server-registry-flags">${model.monitor ? "监控开" : "仅保留配置"} · ${model.tunnel ? "建隧道" : "只监控"}</p>
      ${model.lastTest ? `<p class="server-registry-test">${escapeHtml(model.lastTest)}</p>` : ""}
      <div class="server-registry-actions">
        <button type="button" class="text-btn" data-server-action="test">测试连接</button>
        ${model.canEdit ? '<button type="button" class="text-btn" data-server-action="edit">编辑</button>' : ""}
        <button type="button" class="text-btn" data-server-action="${model.monitor ? "disable" : "enable"}">${model.monitor ? "禁用" : "启用"}</button>
        ${model.stateKey === "hostkey-required" || server.lastTest?.code === "hostkey" ? '<button type="button" class="text-btn" data-server-action="hostkey">确认主机密钥</button>' : ""}
        ${model.canDelete ? '<button type="button" class="text-btn" data-server-action="delete">删除</button>' : ""}
      </div>
    </article>`;
  }).join("");
  const undone = tombstones.map((item) => `<div class="server-registry-tombstone" data-server-id="${escapeHtml(item.id)}"><span>已删除 ${escapeHtml(item.name || item.id)}，服务器及相关事件 7 天内可恢复</span><button type="button" class="text-btn" data-server-action="restore">撤销删除</button></div>`).join("");
  return cards + undone;
}

export function fieldErrorsText(error) {
  if (!error?.errors?.length) return error?.serverMessage || error?.message || "操作失败";
  return error.errors.map((item) => `${item.field}: ${item.message}`).join("；");
}

export function connectionTestMessage(result) {
  return result?.ok === true
    ? { type: "success", message: "SSH 连接测试成功", title: "服务器" }
    : { type: "error", message: result?.nextAction || `连接测试失败（${result?.code || "unknown"}）`, title: "服务器" };
}

export function renderLocalResourcesHtml(data = {}) {
  const pct = value => Number.isFinite(value) ? `${value}%` : "未知";
  const bytes = value => Number.isFinite(value) ? formatBytes(value) : "未知";
  const memory = data.host?.memory || {};
  const rows = (data.topProcesses || []).map(proc => `<li>${escapeHtml(proc.name)} · CPU ${pct(proc.cpuPct)} · RSS ${bytes(proc.rssBytes)}</li>`).join("");
  const sampledAt = data.observedAt || data.checkedAt;
  return `<p>本机 CPU ${pct(data.host?.busyPct)} · 内存 ${bytes(memory.usedBytes)} / ${bytes(memory.totalBytes)}（总量减空闲）</p><p>监控进程 RSS ${bytes(data.self?.rss)} · ${sampledAt ? `采样于 ${escapeHtml(clockText(sampledAt))}` : "等待采样"}</p><ul>${rows || "<li>暂无进程样本</li>"}</ul>`;
}

export function initServerRegistryUi({ getJson, postJson, patchJson, deleteJson, showToast, confirm: confirmFn, getPlatform = () => null, onChanged = async () => {} } = {}) {
  const list = document.getElementById("serverRegistryList");
  const form = document.getElementById("serverRegistryForm");
  const hint = document.getElementById("serverRegistryHint");
  const localBox = document.getElementById("localResourceBox");
  const cancel = document.getElementById("serverRegistryCancelBtn");
  if (!list || !form) return { refresh() {}, refreshLocal() {}, confirmHostKey: async () => {}, applyPlatform() {}, getRevision: () => null, isBusy: () => false };
  let revision = 0, editRevision = null, editingId = "", busy = false, localInFlight = false;
  // 开始编辑那一刻这台服务器的表单取值：个人层在别处被改（版本号 +1）后重读列表时，
  // 这台本身没变就把编辑基线挪到新版本——否则一次无关的改动（切换查看的服务器、开关监控模块）
  // 就会让正在填的表单保存时撞上「配置已被修改」。它自己被改过则保持旧基线，保存时照常报冲突。
  let editSnapshot = "";
  let currentPayload = { servers: [], tombstones: [] };

  function setHint(text) { if (hint) hint.textContent = text || ""; }
  function setBusy(value) {
    busy = value;
    for (const button of [...form.querySelectorAll("button"), ...list.querySelectorAll("button")]) button.disabled = value;
  }
  function syncTunnelField() {
    if (form.elements.remotePort) {
      form.elements.remotePort.required = form.elements.tunnel.checked;
      form.elements.remotePort.disabled = !form.elements.tunnel.checked;
      const suggested = suggestedRemotePort(currentPayload, {
        currentValue: form.elements.remotePort.value,
        editing: Boolean(editingId),
        tunnel: form.elements.tunnel.checked,
      });
      if (suggested) {
        form.elements.remotePort.value = String(suggested);
        form.elements.remotePort.title = `已按本机配置预填空闲端口 ${suggested}（本地转发端口 = 远端 + 1000），可手动修改`;
      } else if (!editingId) {
        const ref = remotePortReferenceHint(currentPayload);
        form.elements.remotePort.placeholder = ref?.placeholder || "";
        form.elements.remotePort.title = ref?.title || "";
      }
    }
  }
  // 密码框按后端平台显隐（win32 不支持密码 SSH）。平台信息随 /api/status 到达，可重复调用。
  function applyPlatform(platform = getPlatform()) {
    const input = form.elements.password;
    if (!input) return;
    const label = typeof input.closest === "function" ? input.closest("label") : null;
    const policy = passwordFieldPolicy(platform);
    input.disabled = !policy.enabled;
    if (label) label.hidden = !policy.enabled;
    let note = typeof form.querySelector === "function" ? form.querySelector(".server-registry-password-note") : null;
    if (!policy.enabled) {
      input.value = "";
      if (!note && label && typeof document !== "undefined") {
        note = document.createElement("p");
        note.className = "server-action-note server-registry-password-note";
        label?.after(note);
      }
      if (note) note.textContent = policy.hint;
    } else if (note) note.remove();
  }
  function resetForm() {
    form.reset(); editingId = ""; editRevision = null; editSnapshot = "";
    applyServerFormValues(form, serverFormValues(null));
    syncTunnelField();
    if (cancel) cancel.hidden = true;
  }
  function fail(error, title = "服务器操作失败") {
    setHint(fieldErrorsText(error));
    showToast?.({ type: "error", message: fieldErrorsText(error), title });
  }
  // 版本冲突（409 revision-conflict）：手里的列表已经旧了。自动重读一次，让用户对着最新内容再点——
  // 不替用户重试（删除 / 禁用这类动作必须基于他看到的那一版），只是省掉手动重新打开配置这一步。
  async function failOrReload(error, title) {
    if (error?.code !== "revision-conflict") return fail(error, title);
    await refresh().catch(() => {});
    const text = "配置刚在别处改过，已载入最新内容；请确认后再操作一次。";
    setHint(text);
    showToast?.({ type: "info", message: text, title: "服务器" });
  }
  async function refresh() {
    const data = await getJson("/api/servers");
    revision = data.revision ?? 0;
    currentPayload = data;
    if (editingId && editRevision !== revision) {
      const fresh = (data.servers || []).find(item => item.id === editingId);
      if (fresh && JSON.stringify(serverFormValues(fresh)) === editSnapshot) editRevision = revision;
    }
    list.innerHTML = renderServerCardsHtml(data);
    // 列表对应的个人层版本号，留在 DOM 上：排查「配置已被修改」与浏览器冒烟都靠它确认列表已经跟上。
    if (list.dataset) list.dataset.revision = String(revision);
    if (busy) for (const button of list.querySelectorAll("button")) button.disabled = true;
    syncTunnelField();
    applyPlatform();
    return data;
  }
  async function changed() { await refresh(); await onChanged(); }
  async function refreshLocal() {
    if (!localBox || localInFlight) return;
    localInFlight = true;
    try { localBox.innerHTML = renderLocalResourcesHtml(await getJson("/api/local/resources?limit=8")); }
    catch (error) { localBox.textContent = fieldErrorsText(error); }
    finally { localInFlight = false; }
  }
  async function confirmHostKey(id) {
    const endpoint = `/api/servers/${encodeURIComponent(id)}/hostkey`;
    const preview = await postJson(endpoint, {});
    if (!preview.ok) throw new Error(preview.nextAction || "主机密钥预览失败");
    const fingerprints = (preview.fingerprints || []).map(item => item.sha256 || item.raw).filter(Boolean);
    if (!fingerprints.length) throw new Error("未获得主机密钥指纹，请重试");
    const ask = confirmFn || globalThis.confirm;
    if (typeof ask !== "function" || !ask(`请与服务器管理员提供的主机密钥指纹核对：\n${fingerprints.join("\n")}`)) return;
    await postJson(endpoint, { confirm: true, linesHash: preview.linesHash });
    setHint("已保存主机密钥，请测试连接。");
  }
  function fillForm(id) {
    const server = (currentPayload.servers || []).find(item => item.id === id);
    if (!server || server.source === "team") throw new Error("团队服务器请使用禁用或启用管理");
    editingId = id; editRevision = revision; editSnapshot = JSON.stringify(serverFormValues(server));
    applyServerFormValues(form, serverFormValues(server)); syncTunnelField();
    if (cancel) cancel.hidden = false;
    setHint(`正在编辑 ${id}。保存时会校验版本，取消编辑可恢复新增模式。`);
  }
  list.addEventListener("click", async event => {
    const button = event.target.closest("[data-server-action]");
    const id = button?.closest("[data-server-id]")?.dataset.serverId;
    if (!id || busy) return;
    const action = button.dataset.serverAction;
    setBusy(true);
    try {
      // 使用用户当前看到的版本；不能预先重新读取并悄悄覆盖并发变更。
      const expectedRevision = revision;
      if (action === "edit") { fillForm(id); return; }
      if (["delete", "disable"].includes(action)) {
        const ask = confirmFn || globalThis.confirm;
        const server = (currentPayload.servers || []).find(item => item.id === id) || { id };
        if (typeof ask !== "function" || !ask(describeServerImpact(server, action))) return;
      }
      const path = `/api/servers/${encodeURIComponent(id)}`;
      if (action === "test") {
        const result = await postJson(`${path}/test`);
        const notice = connectionTestMessage(result); setHint(notice.message); showToast?.(notice);
        await refresh();
      } else if (action === "hostkey") { await confirmHostKey(id); await refresh(); }
      else {
        if (action === "delete") {
          await deleteJson(path, { expectedRevision });
          if (editingId === id) resetForm();
        }
        else if (["disable", "enable", "restore"].includes(action)) await postJson(`${path}/${action}`, { expectedRevision });
        else return;
        await changed();
        const notice = action === "delete"
          ? "服务器及相关事件已移出监控，7 天内可一并恢复；隧道等待守护进程撤销。"
          : action === "restore"
            ? "服务器及保留的相关事件已恢复，服务器保持禁用，启用后重新监控。"
            : "配置已保存；探针已重新调度，隧道由守护进程按新配置更新，请查看连接状态。";
        setHint(notice);
        showToast?.({ type: "success", message: notice, title: "服务器" });
      }
    } catch (error) { await failOrReload(error); }
    finally { setBusy(false); }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    const data = Object.fromEntries(new FormData(form).entries());
    let password = passwordFieldPolicy(getPlatform()).enabled ? String(data.password || "") : "";
    delete data.password;
    if (form.elements.password) form.elements.password.value = "";
    const body = {
      name: data.name, address: data.address, sshPort: data.sshPort || 22, sshUser: data.sshUser,
      ...(data.remotePort ? { remotePort: data.remotePort } : {}),
      tunnel: data.tunnel === "on", monitorEnabled: data.monitor === "on",
      expectedRevision: editingId ? editRevision : revision,
    };
    setBusy(true);
    let configSaved = false;
    try {
      const saved = editingId ? await patchJson(`/api/servers/${encodeURIComponent(editingId)}`, body) : await postJson("/api/servers", body);
      editingId = saved.id || editingId;
      editRevision = saved.revision;
      configSaved = true;
      if (cancel) cancel.hidden = false;
      if (password) await postJson(`/api/servers/${encodeURIComponent(editingId)}/credentials`, { password, expectedRevision: saved.revision });
      password = "";
      await changed();
      resetForm();
      setHint("服务器已保存，探针按新配置调度。新主机请核对主机密钥并测试连接。");
      showToast?.({ type: "success", message: "服务器已保存，请查看连接状态", title: "服务器" });
    } catch (error) {
      if (configSaved) {
        await changed().catch(() => {});
        setHint(`服务器已保存，凭据或界面刷新失败：${fieldErrorsText(error)}。仍在编辑此服务器，可重新录入密码后保存。`);
        showToast?.({ type: "error", message: "服务器已保存，后续步骤失败；请重试当前服务器", title: "保存未完成" });
      } else await failOrReload(error, "保存失败");
    } finally { password = ""; setBusy(false); }
  });
  form.elements.tunnel?.addEventListener("change", syncTunnelField);
  cancel?.addEventListener("click", () => { if (!busy) { resetForm(); setHint("已取消编辑，可以添加新服务器。"); } });
  syncTunnelField();
  applyPlatform();
  return {
    refresh, refreshLocal, applyPlatform, confirmHostKey: async (id) => { await confirmHostKey(id); await refresh(); },
    // 配置浮层据此判断列表是否落后于个人层的最新版本，以及此刻能不能重读（提交在飞时由提交自己刷新）。
    getRevision: () => revision, isBusy: () => busy,
  };
}
