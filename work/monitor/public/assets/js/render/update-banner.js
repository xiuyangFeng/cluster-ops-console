// 热更新横幅：已安装未生效的新版本 → "重启界面（隧道不中断）"；重启后若后台组件（数据面）
// 仍是旧版 → "平滑升级（隧道不中断）"。纯函数构建模型 + DOM 渲染分离（纯函数可被 plain-node 测试）。
// v2.59 起多一条：源码安装（git clone）发现 GitHub 上有更高的版本 → "有新版本 · 更新"，点了才更新
// （后端自检目标版本 → 快进合并），随后自动走上面那条「重启界面」。三条的先后：已安装待重启 > 有新版本 > 后台组件。
//
// 数据来源：
//   - GET /api/self-update（v2.59；旧后端 404、fixture 模式 503 → 当作没有）；POST /api/self-update/apply；
//     网页模式的重启走 POST /api/self-update/restart（监控服务由 launch.mjs 重新拉起），回来后刷新页面。
//   - GET /api/build-info 的 compatibility.reasons 含 "restart-monitor"（磁盘构建 ≠ 运行中的 monitor）；
//     桌面端另有主进程自检（electronAPI.getBundleUpdate），两者任一命中即出"重启界面"。
//   - GET /api/build-info 的 dataPlane.pending（新后端才有；缺失即不出第二条）。
//   - POST /api/data-plane/upgrade {components:[id]}；接口 404（旧后端）→ 提示后隐藏该横幅。

import { escapeHtml } from "../store.js";

export const PROXY_UPGRADE_NOTE = "切换代理时监听端口有亚秒级交接；已建立的连接在旧进程上自然排空，不会被强行断开。";
export const LEGACY_HANDOFF_MESSAGE = "当前后台组件版本较旧，不支持无缝交接：请在方便时重启一次通道（会短暂断开），之后的升级都不中断";
// 升级成功后 build-info 的快照有 ~5s 缓存（新 supervisor 指纹尚未写进快照）：这段时间内
// 不再出数据面横幅，免得"刚升级完又冒出来"的闪烁。
export const DATA_PLANE_SUPPRESS_MS = 10_000;

const PENDING_KINDS = {
  supervisor: { id: "supervisor", kind: "supervisor", label: "平滑升级守护进程", note: "" },
  proxy: { id: "proxy", kind: "proxy", label: "升级本地代理", note: PROXY_UPGRADE_NOTE },
};

// dataPlane.pending 是后端 component-version.diffComponents 给出的 ["supervisor", "proxy"]
// 有序子集：守护进程天然排第一（最常用、零中断），代理单独提供并附说明；认不出的 id 丢弃。
export function normalizeDataPlanePending(dataPlane) {
  const list = Array.isArray(dataPlane?.pending) ? dataPlane.pending : [];
  return list.filter((id) => Object.hasOwn(PENDING_KINDS, id)).map((id) => PENDING_KINDS[id]);
}

function versionLabel(build) {
  if (!build) return "";
  if (build.version) return `v${String(build.version).replace(/^v/, "")}`;
  return build.gitCommit ? `commit ${String(build.gitCommit).slice(0, 8)}` : "";
}

// 该组件能否无缝交接。字段缺失（更旧的后端）按支持处理，只有明确 false 才判定不支持：
// 守护进程看 handoffSupported（旧 supervisor 没有交接退出）；代理看 proxyHandoffSupported
// （supervisor 不会做代理交接，或运行中的代理是没有身份头的旧版本）。
function handoffCapable(kind, dataPlane) {
  return kind === "supervisor" ? dataPlane?.handoffSupported !== false : dataPlane?.proxyHandoffSupported !== false;
}

// 快照不可用 / 过期或通道已停止：此时 pending 只是"运行值未知"，不是真有旧代码在跑。
function dataPlaneUnknown(dataPlane) {
  return dataPlane?.snapshotAvailable === false || dataPlane?.channelRunning === false;
}

export const SELF_UPDATE_CHANGED_EVENT = "self-update:changed";
export const SELF_UPDATE_BODY = "更新只重启界面：守护进程、本地代理与 SSH 隧道保持运行，集群上的工作不中断。更新前会先自检新版本，没通过就不动现在的版本。";

// GET /api/self-update 的载荷 → 「有新版本」横幅模型；没有可提示的 → null。
// 能一键更新才给按钮；不能时把原因（本地有改动 / 要先 npm install 等）写在正文里，不给点不了的按钮。
export function buildSelfUpdateModel(selfUpdate) {
  if (selfUpdate?.available !== true || !selfUpdate.remoteVersion) return null;
  const remote = `v${String(selfUpdate.remoteVersion).replace(/^v/, "")}`;
  const local = selfUpdate.localVersion ? `（当前 v${String(selfUpdate.localVersion).replace(/^v/, "")}）` : "";
  const blockers = Array.isArray(selfUpdate.blockers) ? selfUpdate.blockers : [];
  const canApply = selfUpdate.canApply === true;
  // 安装包版本：不能原地更新，给发布页的「去下载」（只认 GitHub 的 https 地址）。
  const releaseUrl = !canApply && /^https:\/\/github\.com\/[^\s"'<>]+$/.test(String(selfUpdate.releaseUrl || "")) ? selfUpdate.releaseUrl : null;
  if (releaseUrl) {
    return {
      kind: "available",
      key: `release|${selfUpdate.remoteVersion}`,
      title: `有新版本 ${remote}${local}`,
      body: String(blockers[0]?.message || "下载新的安装包覆盖安装即可，配置与数据保留。").slice(0, 400),
      actions: [{ id: "open-release", label: "去下载", url: releaseUrl }],
    };
  }
  return {
    kind: "available",
    key: `available|${selfUpdate.remoteVersion}|${canApply ? "ok" : blockers.map((b) => b?.code || "").join(",")}`,
    title: `有新版本 ${remote}${local}`,
    body: canApply ? SELF_UPDATE_BODY : String(blockers[0]?.message || "现在不能自动更新，稍后再试").slice(0, 400),
    actions: canApply ? [{ id: "self-update", label: "更新（隧道不中断）", toVersion: String(selfUpdate.remoteVersion) }] : [],
  };
}

// info：/api/build-info 响应（可为 null）；desktopUpdate：主进程检测到的已安装更新（可为 null）。
// suppressDataPlane：刚升级成功的短暂窗口内不出数据面横幅。selfUpdate：/api/self-update 的载荷（可为 null）。
// 返回 null（不显示）或 { kind: "control" | "available" | "data", key, title, body, actions:[...] }。
export function buildUpdateBannerModel(info, { desktop = false, desktopUpdate = null, dataPlaneUnsupported = false, suppressDataPlane = false, selfUpdate = null } = {}) {
  const reasons = Array.isArray(info?.compatibility?.reasons) ? info.compatibility.reasons : [];
  const bundle = info?.bundleOnDisk && !info.bundleOnDisk.unknown ? info.bundleOnDisk : null;
  if (reasons.includes("restart-monitor") || desktopUpdate) {
    const target = desktopUpdate || bundle;
    const version = versionLabel(target);
    const key = `control|${target?.version || ""}|${target?.gitCommit || ""}`;
    // 网页模式：监控服务是 launch.mjs 起的（它会把服务重新拉起来）才给按钮，否则只能说明。
    const respawn = !desktop && selfUpdate?.respawn === true;
    return {
      kind: "control",
      key,
      title: `新版本${version ? ` ${version}` : ""} 已安装`,
      body: desktop
        ? "重启界面即可生效：只重启控制台窗口与监控服务，守护进程、本地代理与 SSH 隧道保持运行，集群上的工作不中断。"
        : respawn
          ? "重启监控服务即可生效：只重启这个页面背后的监控服务，守护进程、本地代理与 SSH 隧道保持运行，集群上的工作不中断。"
          : "重启控制台即可生效（网页模式请在桌面应用托盘菜单选择「重启界面」，或重启监控服务）。",
      actions: desktop
        ? [{ id: "restart-ui", label: "重启界面（隧道不中断）" }]
        : respawn ? [{ id: "restart-server", label: "重启监控服务（隧道不中断）" }] : [],
    };
  }
  const available = buildSelfUpdateModel(selfUpdate);
  if (available) return available;
  if (dataPlaneUnsupported || suppressDataPlane) return null;
  const dataPlane = info?.dataPlane;
  if (dataPlaneUnknown(dataPlane)) return null;
  const pending = normalizeDataPlanePending(dataPlane);
  if (!pending.length) return null;
  const capable = pending.filter((p) => handoffCapable(p.kind, dataPlane));
  const legacy = pending.filter((p) => !handoffCapable(p.kind, dataPlane));
  const parts = [];
  if (capable.some((p) => p.kind === "supervisor")) parts.push("守护进程可零中断平滑升级：新进程接管现有隧道，不重建连接。");
  if (capable.some((p) => p.kind === "proxy")) parts.push(`本地代理单独升级：${PROXY_UPGRADE_NOTE}`);
  if (legacy.length) parts.push(`${LEGACY_HANDOFF_MESSAGE}。`);
  return {
    kind: "data",
    key: `data|${pending.map((p) => `${p.id}${handoffCapable(p.kind, dataPlane) ? "" : "!"}`).join(",")}|${dataPlane?.bundle ? JSON.stringify(dataPlane.bundle).slice(0, 256) : ""}`,
    title: capable.length ? "后台组件有更新：平滑升级（隧道不中断）" : "后台组件有更新",
    body: parts.join(" "),
    actions: capable.map((p) => ({ id: "upgrade", component: p.id, kind: p.kind, label: p.label, note: p.note })),
  };
}

// POST /api/data-plane/upgrade 的业务结果（HTTP 200 也可能 ok:false）→ 提示文案。
export function describeUpgradeResult(result, label) {
  // noop：后端发现运行中的组件已是新包代码，什么都没动（见 lib/data-plane-upgrade.mjs 的幂等说明）。
  if (result && result.ok === true && result.noop === true) return { ok: true, message: `无需升级：${label}——后台组件已是新版本` };
  if (result && result.ok === true) return { ok: true, message: `已完成：${label}（隧道不中断）` };
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const failed = steps.find((step) => step && typeof step === "object" && step.ok === false);
  const detail = failed ? `${failed.name}：${failed.detail || "失败"}` : (result?.error || "未返回结果");
  return { ok: false, message: `未完成：${label}——${String(detail).slice(0, 300)}` };
}

export function buildUpdateBannerHtml(model) {
  if (!model) return "";
  const buttons = model.actions.map((a, i) => `<button type="button" class="btn btn-secondary update-banner-btn" data-index="${i}"${a.note ? ` title="${escapeHtml(a.note)}"` : ""}>${escapeHtml(a.label)}</button>`).join("");
  return `
    <div class="alert-text">
      <h3>${escapeHtml(model.title)}</h3>
      <p>${escapeHtml(model.body)}</p>
    </div>
    <div class="update-banner-actions">${buttons}<button type="button" class="btn update-banner-dismiss" data-dismiss="1">稍后</button></div>`;
}

const RESTART_REFUSED = {
  "already-restarting": "界面正在重启",
  quitting: "应用正在退出",
  "quit-prompt-open": "退出确认框正开着，请先关闭它",
  "not-ready": "应用尚未启动完成，请稍后再试",
  "data-plane-upgrading": "后台组件升级中，请稍候",
};

// 网页模式的重启：监控服务退出后由 launch.mjs 重新拉起，这边等它换了一个进程（startedAt 变了）再回来。
// → true（新服务已就绪）| false（等不到）。
export async function waitForServerRestart({ getJson, before, timeoutMs = 60_000, intervalMs = 1000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    try {
      const info = await getJson("/api/build-info");
      const startedAt = info?.monitorRunning?.startedAt;
      if (Number.isFinite(startedAt) && startedAt !== before) return true;
    } catch {
      // 服务正在重启：连不上是预期的，接着等
    }
  }
  return false;
}

export function initUpdateBanner({ root, getJson, postJson, electronAPI = null, toast = () => {}, intervalMs = 60_000, now = Date.now, reload = () => window.location.reload() } = {}) {
  if (!root || typeof getJson !== "function") return { refresh: async () => {} };
  let dismissedKey = "";
  let dataPlaneUnsupported = false;
  let suppressDataPlaneUntil = 0;
  let current = null;
  let busy = false;
  let selfUpdateUnsupported = false;
  const desktop = Boolean(electronAPI && typeof electronAPI.restartControlPlane === "function");

  function render(model) {
    current = model;
    if (!model || model.key === dismissedKey) {
      root.style.display = "none";
      root.innerHTML = "";
      return;
    }
    root.innerHTML = buildUpdateBannerHtml(model);
    root.style.display = "";
  }

  async function refresh() {
    if (busy) return;
    let info = null;
    try {
      info = await getJson("/api/build-info");
    } catch {}
    let desktopUpdate = null;
    try {
      if (electronAPI && typeof electronAPI.getBundleUpdate === "function") desktopUpdate = await electronAPI.getBundleUpdate();
    } catch {}
    // 自更新现状：旧后端没有这个接口（404）、fixture 模式不装配（503）→ 当作没有，不再问。
    let selfUpdate = null;
    if (!selfUpdateUnsupported) {
      try {
        selfUpdate = await getJson("/api/self-update");
      } catch (err) {
        if (err?.status === 404 || err?.status === 503) selfUpdateUnsupported = true;
      }
    }
    if (busy) return;
    render(buildUpdateBannerModel(info, { desktop, desktopUpdate, dataPlaneUnsupported, suppressDataPlane: now() < suppressDataPlaneUntil, selfUpdate }));
  }

  const setBody = (text) => {
    const p = root.querySelector(".alert-text p");
    if (p) p.textContent = text;
  };
  const lockButtons = () => root.querySelectorAll("button").forEach((b) => { b.disabled = true; });

  // 桌面壳：主进程重启界面（成功时窗口随即销毁）。→ true 表示已经在重启。
  async function restartDesktop(title) {
    try {
      const result = await electronAPI.restartControlPlane();
      if (result && result.ok === false) {
        toast({ type: "warn", title, message: RESTART_REFUSED[result.reason] || String(result.reason || "未执行") });
        return false;
      }
      return true;
    } catch (err) {
      toast({ type: "error", title, message: err?.message || "请求失败" });
      return false;
    }
  }

  // 网页模式：让监控服务重启并等它回来，回来后刷新页面加载新界面。→ true 表示页面即将刷新。
  async function restartServer(title) {
    let before = null;
    try {
      before = (await getJson("/api/build-info"))?.monitorRunning?.startedAt ?? null;
    } catch {}
    try {
      await postJson("/api/self-update/restart", {});
    } catch (err) {
      toast({ type: "error", title, message: err?.serverMessage || err?.message || "请求失败" });
      return false;
    }
    setBody("正在重启监控服务…页面会在它回来后自动刷新，隧道保持连接。");
    if (await waitForServerRestart({ getJson, before })) {
      reload();
      return true;
    }
    toast({ type: "error", title, message: "监控服务一分钟内没有回来：请看启动它的终端窗口，必要时重新运行 npm run start" });
    return false;
  }

  async function runAction(action) {
    if (action.id === "open-release") {
      // 桌面壳把 window.open 交给系统浏览器（desktop/windows.mjs）；网页模式开新标签页。
      window.open(action.url, "_blank", "noopener");
      return;
    }
    if (action.id === "self-update") {
      busy = true;
      lockButtons();
      setBody("正在更新：先自检新版本，再切换过去，通常十几秒…");
      let result = null;
      try {
        result = await postJson("/api/self-update/apply", {});
      } catch (err) {
        busy = false;
        toast({ type: "error", title: "更新", message: err?.serverMessage || err?.message || "请求失败" });
        refresh();
        return;
      }
      const version = result?.toVersion ? ` v${result.toVersion}` : "";
      if (desktop) {
        setBody(`已更新到${version}，正在重启界面…窗口将在几秒后重新打开，隧道保持连接。`);
        if (await restartDesktop("更新")) return;
      } else if (result?.respawn) {
        if (await restartServer("更新")) return;
      } else {
        toast({ type: "success", title: "更新", message: `已更新到${version}：重启工作台后生效` });
      }
      busy = false;
      refresh();
      return;
    }
    if (action.id === "restart-server") {
      busy = true;
      lockButtons();
      if (await restartServer("重启监控服务")) return;
      busy = false;
      refresh();
      return;
    }
    if (action.id === "restart-ui") {
      busy = true;
      root.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      try {
        const result = await electronAPI.restartControlPlane();
        if (result && result.ok === false) {
          busy = false;
          toast({ type: "warn", title: "重启界面", message: RESTART_REFUSED[result.reason] || String(result.reason || "未执行") });
          render(current);
          return;
        }
        const p = root.querySelector(".alert-text p");
        if (p) p.textContent = "正在重启界面…窗口将在几秒后重新打开，隧道保持连接。";
      } catch (err) {
        busy = false;
        toast({ type: "error", title: "重启界面", message: err?.message || "请求失败" });
        render(current);
      }
      return;
    }
    if (action.id === "upgrade") {
      busy = true;
      root.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      // 横幅最长是 60s 前的判断（甚至是热更新交接进行中拿到的）：动手前现查一次，组件已不在 pending
      // 就只刷新横幅，不再发一次多余的交接（v2.56.0 热更新后多出来的那次 supervisor 交接即由此而来）。
      let latest = null;
      try {
        latest = await getJson("/api/build-info");
      } catch {}
      if (latest && !dataPlaneUnknown(latest.dataPlane) && !normalizeDataPlanePending(latest.dataPlane).some((p) => p.id === action.component)) {
        busy = false;
        toast({ type: "info", title: "平滑升级", message: `无需升级：${action.label}——后台组件已是新版本` });
        refresh();
        return;
      }
      if (action.kind === "proxy" && typeof window !== "undefined" && typeof window.confirm === "function"
        && !window.confirm(`升级本地代理？\n${PROXY_UPGRADE_NOTE}`)) {
        busy = false;
        render(current);
        return;
      }
      try {
        const result = await postJson("/api/data-plane/upgrade", { components: [action.component] });
        const outcome = describeUpgradeResult(result, action.label);
        if (outcome.ok) {
          suppressDataPlaneUntil = now() + DATA_PLANE_SUPPRESS_MS;
          toast({ type: "success", title: "平滑升级", message: outcome.message });
          setTimeout(() => { refresh(); }, DATA_PLANE_SUPPRESS_MS + 500);
        } else {
          toast({ type: "error", title: "平滑升级", message: outcome.message });
        }
      } catch (err) {
        if (err?.status === 404) {
          dataPlaneUnsupported = true;
          toast({ type: "info", title: "平滑升级", message: "当前监控服务不支持后台组件平滑升级（接口不存在），请先重启界面加载新版本。" });
        } else {
          toast({ type: "error", title: "平滑升级", message: err?.serverMessage || err?.message || "请求失败" });
        }
      } finally {
        busy = false;
      }
      refresh();
    }
  }

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (!target || !current || busy) return;
    if (target.dataset.dismiss) {
      dismissedKey = current.key;
      render(current);
      return;
    }
    const action = current.actions[Number(target.dataset.index)];
    if (action) runAction(action);
  });

  refresh();
  const timer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    refresh();
  }, intervalMs);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
    // 更新日志弹窗里手动「检查更新」之后：横幅立刻跟上。
    document.addEventListener(SELF_UPDATE_CHANGED_EVENT, () => { refresh(); });
  }
  return { refresh, stop: () => clearInterval(timer) };
}
