// team-admin-controller.js —— 「团队管理」视图与成员/配置下发弹窗控制器。
// 页面：顶部团队星图（render/team-galaxy.js）+ 按轨道分组的成员名单（列表 / 卡片，使用者自己切，记在本机）。
// 星图 ↔ 名单双向联动：悬停行星高亮对应行，悬停行点亮对应行星；点行星展开对应成员的详情。
import { morphInnerHtml } from "../dom-utils.js";
import { formatClock } from "../store.js";
import {
  buildAssignPickerHtml,
  buildAssignPresetBarHtml,
  buildBatchOnboardPlan,
  buildHubBannerHtml,
  buildMemberDiagnosticCardText,
  buildRowMenuHtml,
  buildTeamListHtml,
  buildTeamReadoutHtml,
  buildTeamReportCsv,
  buildTeamSkySubHtml,
  collectIdleRegisteredPorts,
  createTeamMatcher,
  extractOverviewConfigTemplates,
  filterTeamMembers,
  normalizeTeamSort,
  recommendNextPort,
  teamFilterCounts,
  teamSortHint,
} from "../render/team-admin-view.js";
import { createTeamGalaxy } from "../render/team-galaxy.js";
import { toMs } from "../render/team-galaxy-model.js";

export const TEAM_ADMIN_POLL_MS = 25000;
export const TEAM_LAYOUT_STORAGE_KEY = "team-admin-layout";
export const TEAM_SORT_STORAGE_KEY = "team-admin-sort";
// 页头两个按需出现的批量按钮（一键纳管 / 回收闲置端口）上次显示时的文案（带个数）：sidebar-boot.js 在解析到按钮时
// 照此先把它们画出来，不等团队模块与数据到了再插进页头——按钮一多页头折成两行，会把星图和名单整体挤下 31px。
// 值是 [[按钮 id, 文案], …] 的 JSON；键名必须与 sidebar-boot.js 一致（sidebar.test.mjs 校验）。
export const TEAM_HEAD_EXTRAS_KEY = "consoleTeamHeadExtras";
export const TEAM_ASSIGN_PRESETS_KEY = "team-admin-assign-presets";
const ASSIGN_PRESETS_MAX = 12;
// 与后端 service.mjs 的单次批量上限（TEAM_BATCH_MEMBER_MAX）保持一致：批量纳管与批量下发
// 都在这里先截断，绝不把「服务端只处理了 32 人」包装成「已处理全部」。
export const TEAM_BATCH_MAX = 32;
// 上一次拿到的团队概览（按服务器）：下次打开 / 重启后先用它把星图与名单画出来，再静默刷新。
// 真实环境里 /api/team/overview 背后是一次集群 ssh 采集（几百毫秒到几秒），没有旧数据时整页只能干等。
export const TEAM_OVERVIEW_CACHE_PREFIX = "team-admin-overview:";
const OVERVIEW_CACHE_VERSION = 1;
const OVERVIEW_CACHE_MAX_CHARS = 512 * 1024;

export function readCachedOverview(storage, serverId) {
  if (!serverId) return null;
  try {
    const raw = storage?.getItem?.(TEAM_OVERVIEW_CACHE_PREFIX + serverId);
    if (!raw) return null;
    const box = JSON.parse(raw);
    if (box?.v !== OVERVIEW_CACHE_VERSION || !Array.isArray(box.overview?.members)) return null;
    return box.overview;
  } catch {
    return null;
  }
}

export function readLatestCachedOverview(storage) {
  if (!storage) return null;
  try {
    let best = null;
    const len = Number(storage.length) || 0;
    for (let i = 0; i < len; i++) {
      const k = storage.key?.(i);
      if (typeof k !== "string" || !k.startsWith(TEAM_OVERVIEW_CACHE_PREFIX)) continue;
      const sid = k.slice(TEAM_OVERVIEW_CACHE_PREFIX.length);
      if (!sid) continue;
      const raw = storage.getItem(k);
      if (!raw) continue;
      const box = JSON.parse(raw);
      if (box?.v !== OVERVIEW_CACHE_VERSION || !Array.isArray(box.overview?.members)) continue;
      const savedAt = Number(box.savedAt) || 0;
      if (!best || savedAt >= best.savedAt) {
        best = { serverId: sid, savedAt, overview: box.overview };
      }
    }
    return best;
  } catch {
    return null;
  }
}

export function writeCachedOverview(storage, serverId, overview) {
  if (!serverId || !overview) return false;
  try {
    const raw = JSON.stringify({ v: OVERVIEW_CACHE_VERSION, savedAt: Date.now(), overview });
    if (raw.length > OVERVIEW_CACHE_MAX_CHARS) return false;
    storage?.setItem?.(TEAM_OVERVIEW_CACHE_PREFIX + serverId, raw);
    return true;
  } catch {
    return false;
  }
}

export function normalizeTeamLayout(raw) {
  return raw === "cards" ? "cards" : "list";
}

export function readAssignPresets(storage) {
  try {
    const raw = storage?.getItem?.(TEAM_ASSIGN_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && typeof p.name === "string" && p.name.trim())
      .slice(0, ASSIGN_PRESETS_MAX)
      .map((p) => ({
        name: p.name.trim(),
        codex: p.codex
          ? {
              enabled: Boolean(p.codex.enabled),
              providerId: String(p.codex.providerId || "relay").trim(),
              baseUrl: String(p.codex.baseUrl || "").trim(),
              model: String(p.codex.model || "").trim(),
            }
          : { enabled: false, providerId: "relay", baseUrl: "", model: "" },
        claude: p.claude
          ? {
              enabled: Boolean(p.claude.enabled),
              baseUrl: String(p.claude.baseUrl || "").trim(),
              model: String(p.claude.model || "").trim(),
            }
          : { enabled: false, baseUrl: "", model: "" },
      }));
  } catch {
    return [];
  }
}

export function writeAssignPresets(storage, presets) {
  try {
    const clean = (Array.isArray(presets) ? presets : []).slice(0, ASSIGN_PRESETS_MAX).map((p) => ({
      name: String(p?.name || "").trim(),
      codex: {
        enabled: Boolean(p?.codex?.enabled),
        providerId: String(p?.codex?.providerId || "relay").trim(),
        baseUrl: String(p?.codex?.baseUrl || "").trim(),
        model: String(p?.codex?.model || "").trim(),
      },
      claude: {
        enabled: Boolean(p?.claude?.enabled),
        baseUrl: String(p?.claude?.baseUrl || "").trim(),
        model: String(p?.claude?.model || "").trim(),
      },
    }));
    storage?.setItem?.(TEAM_ASSIGN_PRESETS_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

// 「下发配置」弹窗 → /api/team/assign 的请求体：Base URL 留空 = 官方直连（mode=official），
// 填了 = 中转站（mode=relay，Provider 名称作为 providerId）。模型字段服务端暂不使用，不发送。
export function buildAssignCliPayload(cli, { baseUrl = "", apiKey = "", provider = "" } = {}) {
  const url = String(baseUrl || "").trim();
  const key = String(apiKey || "").trim();
  if (!url) return { mode: "official", apiKey: key };
  const out = { mode: "relay", apiKey: key, baseUrl: url };
  if (cli === "codex") {
    const id = String(provider || "").trim() || "team-relay";
    out.providerId = id;
    out.providerName = id;
  }
  return out;
}

const defaultWrite = (el, html) => {
  if (el?.ownerDocument) morphInnerHtml(el, html);
  else if (el) el.innerHTML = html;
};

const defaultDownloadCsv = (doc, filename, csvText) => {
  try {
    if (typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && doc?.createElement) {
      const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      doc.body?.appendChild?.(a);
      a.click?.();
      a.remove?.();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }
  } catch {}
  return false;
};

export function createTeamAdminController({
  doc,
  getJson,
  postJson,
  showToast,
  confirm = () => true,
  copyText = (t) => globalThis.navigator?.clipboard?.writeText?.(t),
  downloadCsv = (filename, csvText) => defaultDownloadCsv(doc, filename, csvText),
  openDialog = (id) => doc?.getElementById?.(id)?.showModal?.(),
  closeDialog = (id) => doc?.getElementById?.(id)?.close?.(),
  isViewVisible,
  isHidden = () => false,
  onVisibilityChange,
  writeHtml = defaultWrite,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  storage = typeof localStorage !== "undefined" ? localStorage : null,
  createGalaxy = createTeamGalaxy,
  reduceMotion = () => Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches),
}) {
  let serverId = null;
  let isAdmin = false;
  let overview = null;
  let filter = "all";
  let query = "";
  let sort = "default";
  let loading = false;
  let busy = false;
  let error = "";
  let timer = null;
  let seq = 0;
  let layout = "list";
  try {
    layout = normalizeTeamLayout(storage?.getItem?.(TEAM_LAYOUT_STORAGE_KEY));
    sort = normalizeTeamSort(storage?.getItem?.(TEAM_SORT_STORAGE_KEY));
  } catch {}
  let openUser = null;
  const detailUsers = new Set(); // 渲染了详情的行：展开中的 + 刚收起、动画还没放完的
  const assignPickedUsers = new Set();
  let offlineOpen = false;
  let clockCache = { at: null, text: "" };
  let cachedAt = null; // 最近写进本机缓存的那份概览的 checkedAt（同一份不重复写）
  let warmedOnly = false;
  let lastRefreshAt = 0;
  let galaxy = null;
  let menuUser = null;

  let lastBannerHtml = null;
  let lastKpisHtml = null;
  let lastListHtml = null;
  let lastSubHtml = null;

  const $ = (id) => doc?.getElementById?.(id) || null;
  const visible = () => Boolean(isAdmin && serverId && isViewVisible?.("team") && !isHidden());

  function render({ syncGalaxy = true } = {}) {
    const serverBadge = $("teamAdminServerBadge");
    if (serverBadge) {
      const label = overview?.serverName || serverId || "—";
      if (serverBadge.textContent !== label) serverBadge.textContent = label;
    }
    const updatedBadge = $("teamAdminUpdatedBadge");
    if (updatedBadge) {
      const checkedAt = toMs(overview?.checkedAt);
      if (checkedAt && clockCache.at !== checkedAt) clockCache = { at: checkedAt, text: `更新于 ${formatClock(checkedAt, { locale: "zh-CN", hour12: false })}` };
      const txt = loading ? "正在同步…" : checkedAt ? clockCache.text : "未检查";
      if (updatedBadge.textContent !== txt) updatedBadge.textContent = txt;
    }

    const refreshBtn = $("teamAdminRefreshBtn");
    if (refreshBtn) refreshBtn.disabled = loading || busy;
    const syncBtn = $("teamAdminSyncBtn");
    if (syncBtn) syncBtn.disabled = loading || busy;
    const addBtn = $("teamAdminAddMemberBtn");
    if (addBtn) addBtn.disabled = busy;
    const noticeBtn = $("teamAdminNoticeBtn");
    if (noticeBtn) {
      noticeBtn.disabled = busy;
      const nLabel = overview?.notice?.text ? "编辑公告" : "发布公告";
      if (noticeBtn.textContent !== nLabel) noticeBtn.textContent = nLabel;
    }
    const rootGuideBtn = $("teamAdminRootGuideBtn");
    if (rootGuideBtn) {
      const sudoReady = Boolean(overview?.hub?.sudoReady);
      const label = sudoReady ? "Root 赋权已就绪" : "配置 Root 赋权";
      if (rootGuideBtn.textContent !== label) rootGuideBtn.textContent = label;
    }
    const batchOnboardBtn = $("teamAdminBatchOnboardBtn");
    if (batchOnboardBtn) {
      const plan = buildBatchOnboardPlan(overview);
      batchOnboardBtn.hidden = plan.length === 0;
      batchOnboardBtn.disabled = busy || loading;
      if (plan.length > 0) {
        const bLabel = `一键纳管自动发现 (${plan.length})`;
        if (batchOnboardBtn.textContent !== bLabel) batchOnboardBtn.textContent = bLabel;
      }
    }
    const batchReleaseBtn = $("teamAdminBatchReleasePortsBtn");
    if (batchReleaseBtn) {
      const idlePorts = collectIdleRegisteredPorts(overview);
      batchReleaseBtn.hidden = idlePorts.length === 0;
      batchReleaseBtn.disabled = busy || loading;
      if (idlePorts.length > 0) {
        const rLabel = `回收闲置端口 (${idlePorts.length})`;
        if (batchReleaseBtn.textContent !== rLabel) batchReleaseBtn.textContent = rLabel;
      }
    }
    // 有了概览（缓存或新数据）才知道该不该显示：记下来供下次启动首帧照样画出
    if (overview) rememberHeadExtras([batchReleaseBtn, batchOnboardBtn].filter((b) => b && !b.hidden).map((b) => [b.id, b.textContent]));
    const batchAssignBtn = $("teamAdminBatchAssignBtn");
    if (batchAssignBtn) {
      batchAssignBtn.disabled = busy || !Array.isArray(overview?.members) || overview.members.length === 0;
    }
    const exportBtn = $("teamAdminExportBtn");
    if (exportBtn) {
      exportBtn.disabled = !Array.isArray(overview?.members) || overview.members.length === 0;
    }
    const sortSelect = $("teamAdminSortSelect");
    if (sortSelect && sortSelect.value !== sort) {
      sortSelect.value = sort;
    }
    // 排序控件的读屏说明跟着当前选项走（aria-describedby 指向这句），切排序后读屏能听到「现在按什么排」。
    const sortHelp = $("teamAdminSortHelp");
    if (sortHelp) {
      const hint = teamSortHint(sort);
      if (sortHelp.textContent !== hint) sortHelp.textContent = hint;
    }

    const rootStatusBadge = $("teamRootGuideStatusBadge");
    if (rootStatusBadge) {
      const sudoReady = Boolean(overview?.hub?.sudoReady);
      rootStatusBadge.textContent = sudoReady ? "✓ 免密赋权已就绪" : "⏳ 尚未配置免密赋权";
      rootStatusBadge.className = `pill ${sudoReady ? "pill-ok" : "pill-warn"}`;
    }
    const scriptBox = $("tmRootGrantScriptBox");
    if (scriptBox && overview?.hub?.rootGrantScript) {
      if (scriptBox.textContent !== overview.hub.rootGrantScript) {
        scriptBox.textContent = overview.hub.rootGrantScript;
      }
    }

    const bannerEl = $("teamAdminBanner");
    if (bannerEl) {
      const bHtml = buildHubBannerHtml(overview?.hub, {
        notice: overview?.notice || null,
        configGroups: overview?.configGroups || null,
      });
      if (bHtml !== lastBannerHtml) {
        lastBannerHtml = bHtml;
        writeHtml(bannerEl, bHtml);
        bannerEl.hidden = !bHtml;
      }
    }

    const kpisEl = $("teamAdminKpis");
    if (kpisEl) {
      const kHtml = buildTeamReadoutHtml(overview?.kpis);
      if (kHtml !== lastKpisHtml) {
        lastKpisHtml = kHtml;
        writeHtml(kpisEl, kHtml);
      }
    }
    const subEl = $("teamSkySub");
    if (subEl) {
      const sHtml = buildTeamSkySubHtml(overview, { loading, error });
      if (sHtml !== lastSubHtml) {
        lastSubHtml = sHtml;
        writeHtml(subEl, sHtml);
      }
    }

    const members = Array.isArray(overview?.members) ? overview.members : [];
    const counts = teamFilterCounts(members);
    const pillsRoot = $("teamAdminFilterPills");
    if (pillsRoot) {
      const btns = pillsRoot.querySelectorAll?.("[data-tm-filter]") || [];
      for (const btn of btns) {
        const key = btn.dataset?.tmFilter;
        const active = key === filter;
        btn.classList?.toggle?.("is-active", active);
        btn.setAttribute?.("aria-pressed", String(active));
        const n = btn.querySelector?.(".tm-filter-n");
        const txt = overview ? String(counts[key] ?? "") : "";
        if (n && n.textContent !== txt) n.textContent = txt;
      }
    }
    const layoutRoot = $("teamAdminLayoutToggle");
    if (layoutRoot) {
      for (const btn of layoutRoot.querySelectorAll?.("[data-tm-layout]") || []) {
        btn.setAttribute?.("aria-pressed", String(btn.dataset?.tmLayout === layout));
      }
    }
    const countEl = $("teamAdminCount");
    if (countEl) {
      const shown = filterTeamMembers(members, { filter, query }).length;
      const txt = !overview ? "" : shown === members.length ? `共 ${members.length} 人` : `显示 ${shown} / ${members.length} 人`;
      if (countEl.textContent !== txt) countEl.textContent = txt;
    }

    const listEl = $("teamAdminList");
    if (listEl) {
      const lHtml = buildTeamListHtml(overview, { filter, query, sort, layout, open: openUser, details: detailUsers, offlineOpen, loading, error, busy });
      if (lHtml !== lastListHtml) {
        lastListHtml = lHtml;
        writeHtml(listEl, lHtml);
      }
    }

    const g = ensureGalaxy();
    if (g) {
      if (overview && syncGalaxy) {
        const matches = createTeamMatcher({ filter, query });
        g.update(members, { matches, clusterName: overview.serverName || serverId || "" });
      }
      g.setActive(visible());
    }
  }

  function ensureGalaxy() {
    if (galaxy) return galaxy;
    const skyEl = $("teamSky");
    if (!skyEl || typeof createGalaxy !== "function") return null;
    galaxy = createGalaxy({
      root: skyEl,
      storage,
      onPlanetClick: (user) => locateMember(user),
      onFocusChange: (user, from) => {
        const listEl = $("teamAdminList");
        if (!listEl?.querySelectorAll) return;
        for (const el of listEl.querySelectorAll(".is-linked")) el.classList.remove("is-linked");
        if (user && from === "sky") listItem(user)?.classList.add("is-linked");
      },
    });
    return galaxy;
  }

  function listItem(user) {
    const listEl = $("teamAdminList");
    if (!listEl?.querySelectorAll || !user) return null;
    for (const el of listEl.querySelectorAll("[data-tm-member], [data-tm-chip]")) {
      if ((el.dataset.tmMember || el.dataset.tmChip) === user) return el;
    }
    return null;
  }

  // 点行星 / 点离线胶囊：清掉挡住它的筛选，离线组展开，展开这一行并滚到眼前闪一下。
  function locateMember(user) {
    const member = overview?.members?.find((m) => m.user === user);
    if (!member) return;
    if (!filterTeamMembers([member], { filter, query }).length) {
      filter = "all";
      query = "";
      const search = $("teamAdminSearchInput");
      if (search) search.value = "";
    }
    if (member.onlineState !== "tunnel-online" && member.onlineState !== "ssh-only") offlineOpen = true;
    setOpen(user);
    const el = listItem(user);
    if (!el) return;
    el.scrollIntoView?.({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" });
    el.classList.remove("is-flash");
    void el.offsetWidth;
    el.classList.add("is-flash");
  }

  // 展开：详情和 is-open 同一次写入（外层 grid 0fr→1fr 照样有过渡）；收起：先去掉 is-open 放完动画，再删详情
  function setOpen(user) {
    const prev = openUser;
    openUser = user;
    if (user) detailUsers.add(user);
    if (prev && prev !== user) {
      setTimer(() => {
        if (openUser !== prev && detailUsers.delete(prev)) render({ syncGalaxy: false });
      }, 360);
    }
    render({ syncGalaxy: false });
  }
  function toggleOpen(user) {
    setOpen(openUser === user ? null : user);
  }

  function setLayout(next) {
    layout = normalizeTeamLayout(next);
    try {
      storage?.setItem?.(TEAM_LAYOUT_STORAGE_KEY, layout);
    } catch {}
    render();
  }

  function setSort(next) {
    sort = normalizeTeamSort(next);
    try {
      storage?.setItem?.(TEAM_SORT_STORAGE_KEY, sort);
    } catch {}
    render();
  }

  /* —— 行尾「···」菜单 —— */
  function closeMenu() {
    const menu = $("teamRowMenu");
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    menuUser = null;
  }
  function openMenu(btn, user) {
    const menu = $("teamRowMenu");
    const member = overview?.members?.find((m) => m.user === user);
    if (!menu || !member) return;
    if (menuUser === user && !menu.hidden) {
      closeMenu();
      return;
    }
    const quick = btn.parentElement?.querySelector?.(".tm-act-quick");
    const folded = !quick || quick.offsetParent === null;
    menu.innerHTML = buildRowMenuHtml(member, { folded, busy });
    menu.hidden = false;
    menuUser = user;
    const r = btn.getBoundingClientRect();
    const win = doc.defaultView;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left = Math.max(8, Math.min((win?.innerWidth || 1200) - w - 8, r.right - w));
    const below = r.bottom + 6 + h <= (win?.innerHeight || 900);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(below ? r.bottom + 6 : r.top - 6 - h)}px`;
    menu.querySelector?.("button")?.focus?.();
  }

  // 名单、详情、菜单里的动作按钮共用一个分发：返回 true 表示处理了
  function dispatchAction(target) {
    const editBtn = target?.closest?.("[data-tm-edit]");
    if (editBtn) {
      openMemberDialog(editBtn.dataset.tmEdit);
      return true;
    }
    const assignBtn = target?.closest?.("[data-tm-assign]");
    if (assignBtn) {
      openAssignDialog(assignBtn.dataset.tmAssign);
      return true;
    }
    const assignGroupBtn = target?.closest?.("[data-tm-assign-group]");
    if (assignGroupBtn) {
      openAssignDialog(assignGroupBtn.dataset.tmAssignGroup);
      return true;
    }
    const removeBtn = target?.closest?.("[data-tm-remove]");
    if (removeBtn) {
      removeMember(removeBtn.dataset.tmRemove);
      return true;
    }
    const releaseBtn = target?.closest?.("[data-tm-release-port]");
    if (releaseBtn) {
      releasePort(releaseBtn.dataset.tmReleaseUser, releaseBtn.dataset.tmReleasePort);
      return true;
    }
    const killBtn = target?.closest?.("[data-tm-kill-port]");
    if (killBtn) {
      killPort(killBtn.dataset.tmKillUser, killBtn.dataset.tmKillPort);
      return true;
    }
    const copyDiagBtn = target?.closest?.("[data-tm-copy-diag]");
    if (copyDiagBtn) {
      copyMemberDiagnosticCard(copyDiagBtn.dataset.tmCopyDiag);
      return true;
    }
    return false;
  }

  async function copyMemberDiagnosticCard(user) {
    const member = overview?.members?.find((m) => m.user === user);
    if (!member) return;
    const text = buildMemberDiagnosticCardText(member, {
      serverName: overview?.serverName || serverId || "",
    });
    if (!text) return;
    await Promise.resolve(copyText(text)).catch(() => {});
    showToast?.({
      type: "success",
      title: "已复制成员诊断卡",
      message: `已将 ${member.displayName || member.user} 的链路、配置、用量与算力诊断信息复制到剪贴板。`,
    });
  }

  async function refresh({ fresh = false } = {}) {
    if (!isAdmin || !serverId) return;
    const target = serverId;
    const ticket = ++seq;
    lastRefreshAt = Date.now();
    loading = true;
    render();
    try {
      const qs = new URLSearchParams({ serverId: target });
      if (fresh) qs.set("fresh", "1");
      const next = await getJson(`/api/team/overview?${qs}`);
      if (ticket !== seq || target !== serverId) return;
      overview = next;
      error = "";
      if (next?.checkedAt !== cachedAt) {
        cachedAt = next?.checkedAt;
        writeCachedOverview(storage, target, next);
      }
    } catch (err) {
      if (ticket !== seq || target !== serverId) return;
      error = err?.serverMessage || err?.message || "读取团队管理视图失败，稍后自动重试";
    } finally {
      if (ticket === seq) {
        loading = false;
        render();
      }
    }
  }

  function schedule() {
    if (timer != null) clearTimer(timer);
    timer = null;
    if (!visible()) return;
    timer = setTimer(async () => {
      timer = null;
      if (visible()) await refresh();
      schedule();
    }, TEAM_ADMIN_POLL_MS);
  }

  function openRootGuideDialog() {
    render();
    openDialog?.("dlgTeamRootGuide");
  }

  function openNoticeDialog() {
    const notice = overview?.notice || null;
    const titleInput = $("tmNoticeTitle");
    if (titleInput) titleInput.value = notice?.title || "团队公告";
    const textInput = $("tmNoticeText");
    if (textInput) textInput.value = notice?.text || "";
    const levelSelect = $("tmNoticeLevel");
    if (levelSelect) levelSelect.value = notice?.level || "info";
    const clearBtn = $("tmNoticeClearBtn");
    if (clearBtn) clearBtn.hidden = !notice?.text;
    openDialog?.("dlgTeamNotice");
  }

  async function submitNoticeForm(event) {
    event?.preventDefault?.();
    if (busy || !serverId) return;
    const title = String($("tmNoticeTitle")?.value || "团队公告").trim();
    const text = String($("tmNoticeText")?.value || "").trim();
    const level = String($("tmNoticeLevel")?.value || "info").trim();
    if (!text) {
      showToast?.({ type: "warn", title: "团队公告", message: "请填写公告内容，或点击「清除公告」。" });
      return;
    }
    busy = true;
    render();
    try {
      const res = await postJson("/api/team/notice", { serverId, title, text, level });
      if (res?.overview) {
        seq += 1;
        overview = res.overview;
      }
      closeDialog?.("dlgTeamNotice");
      showToast?.({ type: "success", title: "公告已发布", message: "团队置顶公告已写入集群共享目录。" });
    } catch (err) {
      showToast?.({ type: "warn", title: "发布公告失败", message: err?.serverMessage || err?.message || "请稍后重试" });
    } finally {
      busy = false;
      render();
    }
  }

  async function clearNotice() {
    if (busy || !serverId) return;
    busy = true;
    render();
    try {
      const res = await postJson("/api/team/notice", { serverId, clear: true });
      if (res?.overview) {
        seq += 1;
        overview = res.overview;
      }
      closeDialog?.("dlgTeamNotice");
      showToast?.({ type: "info", title: "已清除公告", message: "团队置顶公告已移除。" });
    } catch (err) {
      showToast?.({ type: "warn", title: "清除公告失败", message: err?.serverMessage || err?.message || "请稍后重试" });
    } finally {
      busy = false;
      render();
    }
  }

  function fillRecommendedPort() {
    const portInput = $("tmMemberAssignedPort");
    if (!portInput) return null;
    const targetUser = String($("tmMemberUser")?.value || "").trim();
    const rec = recommendNextPort(overview, { forUser: targetUser });
    if (rec) portInput.value = String(rec);
    return rec;
  }

  function openMemberDialog(user = null) {
    const existing = user ? overview?.members?.find((m) => m.user === user) || null : null;
    const titleEl = $("teamMemberDialogTitle");
    if (titleEl) titleEl.textContent = existing?.inRoster ? `编辑团队成员 · ${existing.user}` : "添加 / 纳管团队成员";
    const userInput = $("tmMemberUser");
    if (userInput) {
      userInput.value = existing?.user || user || "";
      userInput.readOnly = Boolean(existing?.inRoster);
    }
    const nameInput = $("tmMemberDisplayName");
    if (nameInput) nameInput.value = existing?.displayName && existing.displayName !== existing.user ? existing.displayName : "";
    const portInput = $("tmMemberAssignedPort");
    if (portInput) {
      if (existing?.assignedPort) {
        portInput.value = String(existing.assignedPort);
      } else {
        const rec = recommendNextPort(overview, { forUser: existing?.user || user || "" });
        portInput.value = rec ? String(rec) : (existing?.activePort ? String(existing.activePort) : "");
      }
    }
    const noteInput = $("tmMemberNote");
    if (noteInput) noteInput.value = existing?.note || "";
    const enabledInput = $("tmMemberEnabled");
    if (enabledInput) enabledInput.checked = existing?.enabled !== false;
    openDialog?.("dlgTeamMember");
  }

  function syncAssignPickerUi() {
    const users = [...assignPickedUsers];
    const isBatch = users.length > 1;
    const userInput = $("tmAssignUser");
    if (userInput) userInput.value = isBatch ? users.join(", ") : (users[0] || "");
    const pickerEl = $("tmAssignUserPicker");
    if (pickerEl) {
      const members = Array.isArray(overview?.members) ? overview.members : [];
      if (members.length > 0) {
        writeHtml(pickerEl, buildAssignPickerHtml(members, users));
        pickerEl.hidden = false;
      } else {
        pickerEl.hidden = true;
      }
    }
    const hintEl = $("tmAssignPubkeyHint");
    if (hintEl) {
      if (!users.length) {
        hintEl.textContent = "请在上方点击选择至少 1 位要下发配置的目标成员。";
      } else if (isBatch) {
        const capNote = users.length >= TEAM_BATCH_MAX ? `（已达单次上限 ${TEAM_BATCH_MAX} 人，其余请分批下发）` : "";
        hintEl.textContent = `📦 批量整组下发给 ${users.length} 位成员（${users.join("、")}）${capNote}：已上报公钥的成员将立即端到端加密投递，未上报公钥的成员将安全暂存待上线投递。`;
      } else {
        const member = overview?.members?.find((m) => m.user === users[0]) || null;
        hintEl.textContent = member?.hasPubKey
          ? `✓ ${users[0]} 的本机 X25519 公钥已就绪，保存后将使用端到端加密信封投递到集群，仅其本人私钥可解开。`
          : `⏳ ${users[0]} 尚未上报公钥。保存后密钥将安全暂存在管理员本机（0600），待其启动工作台上报公钥后自动加密投递。`;
      }
    }
    const clearBtn = $("tmAssignClearBtn");
    if (clearBtn) {
      const singleMember = users.length === 1 ? overview?.members?.find((m) => m.user === users[0]) : null;
      clearBtn.hidden = isBatch || !singleMember?.assignment || singleMember.assignment.state === "none";
    }
    syncAssignPresetBarUi();
  }

  function syncAssignPresetBarUi() {
    const barEl = $("tmAssignPresetBar");
    if (!barEl) return;
    const presets = readAssignPresets(storage);
    const activeTemplates = extractOverviewConfigTemplates(overview);
    writeHtml(barEl, buildAssignPresetBarHtml({ presets, activeTemplates }));
  }

  function applyAssignTemplateToForm(tpl, label = "配置方案") {
    if (!tpl) return;
    if (tpl.codex) {
      const codexCheck = $("tmAssignCodexEnabled");
      if (codexCheck) codexCheck.checked = Boolean(tpl.codex.enabled);
      if (tpl.codex.enabled) {
        const codexProvider = $("tmAssignCodexProvider");
        if (codexProvider) codexProvider.value = tpl.codex.providerId || "relay";
        const codexUrl = $("tmAssignCodexBaseUrl");
        if (codexUrl) codexUrl.value = tpl.codex.baseUrl || "";
        const codexModel = $("tmAssignCodexModel");
        if (codexModel) codexModel.value = tpl.codex.model || "";
      }
    }
    if (tpl.claude) {
      const claudeCheck = $("tmAssignClaudeEnabled");
      if (claudeCheck) claudeCheck.checked = Boolean(tpl.claude.enabled);
      if (tpl.claude.enabled) {
        const claudeUrl = $("tmAssignClaudeBaseUrl");
        if (claudeUrl) claudeUrl.value = tpl.claude.baseUrl || "";
        const claudeModel = $("tmAssignClaudeModel");
        if (claudeModel) claudeModel.value = tpl.claude.model || "";
      }
    }
    showToast?.({
      type: "info",
      title: "已填入配置方案",
      message: `已带入「${label}」的 Provider、Base URL 与模型设置，请填写要分配的 API Key。`,
    });
  }

  function saveCurrentFormAsPreset() {
    const codexEnabled = Boolean($("tmAssignCodexEnabled")?.checked);
    const claudeEnabled = Boolean($("tmAssignClaudeEnabled")?.checked);
    if (!codexEnabled && !claudeEnabled) {
      showToast?.({ type: "warn", title: "保存预设", message: "请至少勾选 Codex 或 Claude Code 一项后再保存预设。" });
      return;
    }
    const providerId = String($("tmAssignCodexProvider")?.value || "relay").trim() || "relay";
    const codexBaseUrl = String($("tmAssignCodexBaseUrl")?.value || "").trim();
    const codexModel = String($("tmAssignCodexModel")?.value || "").trim();
    const claudeBaseUrl = String($("tmAssignClaudeBaseUrl")?.value || "").trim();
    const claudeModel = String($("tmAssignClaudeModel")?.value || "").trim();
    const nameParts = [];
    if (codexEnabled) nameParts.push(`Codex:${providerId}${codexBaseUrl ? "" : "(官方)"}`);
    if (claudeEnabled) nameParts.push(`Claude:${claudeBaseUrl ? "中转" : "官方"}`);
    const name = nameParts.join(" + ") || "常用预设";
    const presets = readAssignPresets(storage).filter((p) => p.name !== name);
    presets.unshift({
      name,
      codex: { enabled: codexEnabled, providerId, baseUrl: codexBaseUrl, model: codexModel },
      claude: { enabled: claudeEnabled, baseUrl: claudeBaseUrl, model: claudeModel },
    });
    writeAssignPresets(storage, presets);
    syncAssignPresetBarUi();
    showToast?.({
      type: "success",
      title: "预设已保存",
      message: `已将「${name}」（不含明文密钥）保存到本机预设栏，下次可一键填充。`,
    });
  }

  function openAssignDialog(user, { batch = false } = {}) {
    const members = Array.isArray(overview?.members) ? overview.members : [];
    let users = [];
    if (batch || user === "*") {
      const unmanaged = members.filter((m) => !m.assignment || m.assignment.state === "none").map((m) => m.user);
      const rosterUsers = members.filter((m) => m.inRoster !== false).map((m) => m.user);
      users = unmanaged.length ? unmanaged : (rosterUsers.length ? rosterUsers : members.map((m) => m.user));
    } else if (user) {
      users = String(user)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (!users.length && !batch) return;
    assignPickedUsers.clear();
    for (const u of users) {
      if (assignPickedUsers.size >= TEAM_BATCH_MAX) break;
      assignPickedUsers.add(u);
    }
    syncAssignPickerUi();

    const member = users.length ? members.find((m) => m.user === users[0]) || null : null;
    const codexSummary = member?.assignment?.summary?.codex || null;
    const claudeSummary = member?.assignment?.summary?.claude || null;

    const codexCheck = $("tmAssignCodexEnabled");
    if (codexCheck) codexCheck.checked = Boolean(codexSummary || !claudeSummary);
    const codexProvider = $("tmAssignCodexProvider");
    if (codexProvider) codexProvider.value = codexSummary?.providerId || codexSummary?.providerName || "team-relay";
    const codexUrl = $("tmAssignCodexBaseUrl");
    if (codexUrl) codexUrl.value = codexSummary?.baseUrl || "";
    const codexKey = $("tmAssignCodexApiKey");
    if (codexKey) {
      codexKey.value = "";
      codexKey.placeholder = codexSummary?.keyMask ? `当前已配 ${codexSummary.keyMask}（重新下发请填写）` : "sk-...";
    }
    const codexModel = $("tmAssignCodexModel");
    if (codexModel) codexModel.value = codexSummary?.model || "";

    const claudeCheck = $("tmAssignClaudeEnabled");
    if (claudeCheck) claudeCheck.checked = Boolean(claudeSummary);
    const claudeUrl = $("tmAssignClaudeBaseUrl");
    if (claudeUrl) claudeUrl.value = claudeSummary?.baseUrl || "";
    const claudeKey = $("tmAssignClaudeApiKey");
    if (claudeKey) {
      claudeKey.value = "";
      claudeKey.placeholder = claudeSummary?.keyMask ? `当前已配 ${claudeSummary.keyMask}（重新下发请填写）` : "sk-ant-...";
    }
    const claudeModel = $("tmAssignClaudeModel");
    if (claudeModel) claudeModel.value = claudeSummary?.model || "";

    openDialog?.("dlgTeamAssign");
  }

  async function batchOnboardDiscovered() {
    if (busy || !serverId) return;
    const plan = buildBatchOnboardPlan(overview);
    if (!plan.length) {
      showToast?.({ type: "info", title: "批量纳管", message: "当前没有待纳管的「自动发现」成员。" });
      return;
    }
    // 服务端单次最多收 TEAM_BATCH_MAX 位（超出会 400 而不是静默截断）。这里先自己分批，
    // 并且**只报真实提交的人数**——旧的「已将 N 位纳入名册」在 N>32 时是假话。
    const todo = plan.slice(0, TEAM_BATCH_MAX);
    const remaining = plan.length - todo.length;
    const noPort = todo.filter((p) => !p.assignedPort).length;
    const summary = todo.map((p) => `${p.user} (${p.assignedPort ? `:${p.assignedPort}` : "端口待定"})`).join("、");
    const tail = [
      noPort ? `其中 ${noPort} 位因端口段已满未预分配端口（仍会纳入名册）。` : "",
      remaining ? `本次先纳管 ${todo.length} 位，还有 ${remaining} 位待纳管，可再次点击本按钮。` : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (!confirm(`确认将以下 ${todo.length} 位「自动发现」成员纳入团队名册并预分配专属端口吗？\n\n${summary}${tail ? `\n\n${tail}` : ""}`)) return;
    busy = true;
    render();
    try {
      const res = await postJson("/api/team/member", { serverId, members: todo });
      const nextOverview = res?.overview || (res?.members ? res : null);
      if (nextOverview) {
        seq += 1;
        overview = nextOverview;
      }
      showToast?.({
        type: "success",
        title: "批量纳管完成",
        message: `已将 ${todo.length} 位自动发现成员纳入团队名册${
          todo.length - noPort > 0 ? `（${todo.length - noPort} 位已分配专属端口）` : ""
        }${remaining ? `，剩余 ${remaining} 位请再次点击「一键纳管自动发现」。` : "。"}`,
      });
    } catch (err) {
      showToast?.({ type: "warn", title: "批量纳管失败", message: err?.serverMessage || err?.message || "请稍后重试" });
    } finally {
      busy = false;
      render();
    }
  }

  async function exportTeamCsv() {
    if (!Array.isArray(overview?.members) || !overview.members.length) {
      showToast?.({ type: "warn", title: "导出报表", message: "当前暂无可导出的团队成员数据。" });
      return;
    }
    const csv = buildTeamReportCsv(overview);
    const dateTag = new Date().toISOString().slice(0, 10);
    const safeServer = String(overview?.serverName || serverId || "cluster").replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, "-");
    const filename = `team-report-${safeServer}-${dateTag}.csv`;
    const downloaded = downloadCsv(filename, csv);
    if (downloaded) {
      showToast?.({
        type: "success",
        title: "已导出 CSV 报表",
        message: `共导出 ${overview.members.length} 位团队成员的状态、用量与算力明细（${filename}）。`,
      });
    } else {
      await Promise.resolve(copyText(csv)).catch(() => {});
      showToast?.({
        type: "info",
        title: "CSV 报表已复制到剪贴板",
        message: `共 ${overview.members.length} 位成员数据，可直接粘贴至表格软件保存。`,
      });
    }
  }

  async function submitMemberForm(event) {
    event?.preventDefault?.();
    if (busy || !serverId) return;
    const user = String($("tmMemberUser")?.value || "").trim();
    const displayName = String($("tmMemberDisplayName")?.value || "").trim();
    const portRaw = String($("tmMemberAssignedPort")?.value || "").trim();
    const assignedPort = portRaw ? Number(portRaw) : null;
    const note = String($("tmMemberNote")?.value || "").trim();
    const enabled = $("tmMemberEnabled") ? Boolean($("tmMemberEnabled").checked) : true;
    if (!user) {
      showToast?.({ type: "warn", title: "团队成员", message: "请填写集群 SSH 用户名。" });
      return;
    }
    busy = true;
    render();
    try {
      const res = await postJson("/api/team/member", {
        serverId,
        user,
        displayName,
        assignedPort,
        note,
        enabled,
      });
      const nextOverview = res?.overview || (res?.members ? res : null);
      if (nextOverview) {
        seq += 1;
        overview = nextOverview;
      }
      closeDialog?.("dlgTeamMember");
      showToast?.({ type: "success", title: "团队名册已更新", message: `已保存成员 ${user} 的名册与端口预分配。` });
    } catch (err) {
      showToast?.({ type: "warn", title: "保存成员失败", message: err?.serverMessage || err?.message || "请检查输入后重试" });
    } finally {
      busy = false;
      render();
    }
  }

  async function submitAssignForm(event) {
    event?.preventDefault?.();
    if (busy || !serverId) return;
    const userRaw = String($("tmAssignUser")?.value || "").trim();
    const users = userRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!users.length) {
      showToast?.({ type: "warn", title: "配置下发", message: "请至少选择一位目标成员。" });
      return;
    }
    const user = users.length === 1 ? users[0] : users.join(",");
    const codexEnabled = Boolean($("tmAssignCodexEnabled")?.checked);
    const claudeEnabled = Boolean($("tmAssignClaudeEnabled")?.checked);
    if (!codexEnabled && !claudeEnabled) {
      showToast?.({ type: "warn", title: "配置下发", message: "请至少勾选 Codex 或 Claude Code 一项，或点击「解除托管」。" });
      return;
    }

    const payload = { serverId, user, ...(users.length > 1 ? { users } : {}) };
    if (codexEnabled) {
      const apiKey = String($("tmAssignCodexApiKey")?.value || "").trim();
      const baseUrl = String($("tmAssignCodexBaseUrl")?.value || "").trim();
      if (!apiKey) {
        showToast?.({ type: "warn", title: "Codex 配置", message: "请填写要下发给该成员的 Codex API Key。" });
        return;
      }
      payload.codex = buildAssignCliPayload("codex", {
        baseUrl,
        apiKey,
        provider: String($("tmAssignCodexProvider")?.value || "").trim(),
      });
    }
    if (claudeEnabled) {
      const apiKey = String($("tmAssignClaudeApiKey")?.value || "").trim();
      const baseUrl = String($("tmAssignClaudeBaseUrl")?.value || "").trim();
      if (!apiKey) {
        showToast?.({ type: "warn", title: "Claude 配置", message: "请填写要下发给该成员的 Claude API Key。" });
        return;
      }
      payload.claude = buildAssignCliPayload("claude", { baseUrl, apiKey });
    }

    busy = true;
    render();
    try {
      const res = await postJson("/api/team/assign", payload);
      // 立即清空密码框，不在 DOM 中残留明文 Key
      if ($("tmAssignCodexApiKey")) $("tmAssignCodexApiKey").value = "";
      if ($("tmAssignClaudeApiKey")) $("tmAssignClaudeApiKey").value = "";
      if (res?.overview) {
        seq += 1;
        overview = res.overview;
      }
      closeDialog?.("dlgTeamAssign");
      const msg =
        users.length > 1
          ? `已向 ${users.length} 位成员批量下发 AI 配置（${Number(res?.sealedCount ?? users.length)} 人已投递，${Number(res?.pendingCount || 0)} 人暂存待上线）。`
          : res?.delivered
            ? `已使用 ${users[0]} 的公钥加密投递到集群，其工作台将在 1 分钟内自动解密写入。`
            : `成员 ${users[0]} 尚未上报公钥，已加密暂存于管理员本机，待其上线后自动投递。`;
      showToast?.({ type: "success", title: "AI 配置已下发", message: msg });
    } catch (err) {
      showToast?.({ type: "warn", title: "下发配置失败", message: err?.serverMessage || err?.message || "请检查输入后重试" });
    } finally {
      busy = false;
      render();
    }
  }

  async function clearAssignment() {
    if (busy || !serverId) return;
    const user = String($("tmAssignUser")?.value || "").trim();
    if (!user) return;
    if (!confirm(`确认解除对成员 ${user} 的统一 AI 配置托管吗？集群上的加密信封与本机待发记录将被移除。`)) return;
    busy = true;
    render();
    try {
      const res = await postJson("/api/team/assign", { serverId, user, clear: true });
      if (res?.overview) {
        seq += 1;
        overview = res.overview;
      }
      closeDialog?.("dlgTeamAssign");
      showToast?.({ type: "info", title: "已解除托管", message: `已移除 ${user} 的统一 AI 配置信封。` });
    } catch (err) {
      showToast?.({ type: "warn", title: "解除托管失败", message: err?.serverMessage || err?.message || "请稍后重试" });
    } finally {
      busy = false;
      render();
    }
  }

  async function removeMember(user) {
    if (busy || !serverId || !user) return;
    if (!confirm(`确认将 ${user} 从团队名册中移出吗？（若其仍在集群活跃，仍会以「自动发现」展示）`)) return;
    busy = true;
    render();
    try {
      const res = await postJson("/api/team/member/remove", { serverId, user });
      const nextOverview = res?.overview || (res?.members ? res : null);
      if (nextOverview) {
        seq += 1;
        overview = nextOverview;
      }
      showToast?.({ type: "info", title: "已移出名册", message: `${user} 已从团队名册移出。` });
    } catch (err) {
      showToast?.({ type: "warn", title: "移出失败", message: err?.serverMessage || err?.message || "请稍后重试" });
    } finally {
      busy = false;
      render();
    }
  }

  async function batchReleaseIdlePorts() {
    if (busy || !serverId) return;
    const idlePorts = collectIdleRegisteredPorts(overview);
    if (!idlePorts.length) {
      showToast?.({ type: "info", title: "回收闲置端口", message: "当前没有已登记但未监听的闲置端口。" });
      return;
    }
    const summary = idlePorts.map((it) => `${it.user}(:${it.port})`).join("、");
    if (!confirm(`确认批量释放以下 ${idlePorts.length} 个已登记但当前未建立隧道监听的闲置端口吗？\n\n${summary}`)) return;
    busy = true;
    render();
    let releasedCount = 0;
    let needRootCount = 0;
    let lastOverview = null;
    try {
      for (const item of idlePorts) {
        const res = await postJson("/api/team/release-port", { serverId, user: item.user, port: item.port });
        if (res?.overview) lastOverview = res.overview;
        if (res?.released) releasedCount += 1;
        else if (res?.sudoCommand) needRootCount += 1;
      }
      if (lastOverview) {
        seq += 1;
        overview = lastOverview;
      }
      if (needRootCount > 0) {
        showToast?.({
          type: "warn",
          title: "部分闲置端口需 Root 赋权",
          message: `已释放 ${releasedCount} 个端口；另有 ${needRootCount} 个端口因集群 sticky 目录保护需先完成「配置 Root 赋权」。`,
          duration: 6500,
        });
      } else {
        showToast?.({
          type: "success",
          title: "闲置端口回收完成",
          message: `已批量清理 ${releasedCount} 个闲置端口登记记录。`,
        });
      }
    } catch (err) {
      showToast?.({ type: "warn", title: "批量回收端口失败", message: err?.serverMessage || err?.message || "请稍后重试" });
    } finally {
      busy = false;
      render();
    }
  }

  async function releasePort(user, port) {
    if (busy || !serverId || !user || !port) return;
    if (!confirm(`确认释放成员 ${user} 登记的端口 :${port} 吗？`)) return;
    busy = true;
    render();
    try {
      const res = await postJson("/api/team/release-port", { serverId, user, port: Number(port) });
      if (res?.overview) {
        seq += 1;
        overview = res.overview;
      }
      if (res?.released) {
        showToast?.({ type: "success", title: "端口已释放", message: `已清理 ${user} 的端口 :${port} 登记记录。` });
      } else if (res?.sudoCommand) {
        await Promise.resolve(copyText(res.sudoCommand)).catch(() => {});
        showToast?.({
          type: "warn",
          title: "需配置 Root 赋权或本人权限",
          message: `集群 sticky 目录保护阻止直接删除他人文件。点击顶部「🔑 Root 赋权指南」可配置永久免密清理，或直接粘贴已复制的命令：${res.sudoCommand}`,
          duration: 7000,
        });
      }
    } catch (err) {
      showToast?.({ type: "warn", title: "释放端口失败", message: err?.serverMessage || err?.message || "请稍后重试" });
    } finally {
      busy = false;
      render();
    }
  }

  async function killPort(user, port) {
    if (busy || !serverId || !port) return;
    if (!confirm(`确认强踢集群上监听端口 :${port} (${user || "未知用户"}) 的反向隧道会话进程吗？`)) return;
    busy = true;
    render();
    try {
      const res = await postJson("/api/team/kill-port", { serverId, port: Number(port) });
      if (res?.overview) {
        seq += 1;
        overview = res.overview;
      }
      if (res?.killed) {
        showToast?.({ type: "success", title: "已强踢端口进程", message: `已终止监听 :${port} 的隧道进程并清理登记记录。` });
      } else if (res?.status === "not-listening") {
        showToast?.({ type: "info", title: "端口已空闲", message: `端口 :${port} 当前无活跃监听进程，已顺带清理残留登记。` });
      } else {
        openRootGuideDialog();
        showToast?.({
          type: "warn",
          title: "需先完成一次 Root 赋权",
          message: "跨用户强踢端口需要集群免密辅助脚本权限，已为您打开赋权指南弹窗。",
          duration: 6500,
        });
      }
    } catch (err) {
      showToast?.({ type: "warn", title: "强踢端口失败", message: err?.serverMessage || err?.message || "请稍后重试" });
    } finally {
      busy = false;
      render();
    }
  }

  async function syncNow() {
    if (busy || loading || !serverId) return;
    busy = true;
    render();
    try {
      await postJson("/api/team/sync-now", { serverId });
      await refresh({ fresh: true });
      showToast?.({ type: "success", title: "团队同步完成", message: "已完成心跳上报、加密信封检查与全员状态刷新。" });
    } catch (err) {
      showToast?.({ type: "warn", title: "同步失败", message: err?.serverMessage || err?.message || "请稍后重试" });
    } finally {
      busy = false;
      render();
    }
  }

  let savedHeadExtras;
  function rememberHeadExtras(pairs) {
    const value = pairs.length ? JSON.stringify(pairs) : "";
    if (value === savedHeadExtras) return;
    savedHeadExtras = value;
    try {
      if (value) storage?.setItem?.(TEAM_HEAD_EXTRAS_KEY, value);
      else storage?.removeItem?.(TEAM_HEAD_EXTRAS_KEY);
    } catch {}
  }

  function warmFromCache() {
    if (overview || serverId) return false;
    const hit = readLatestCachedOverview(storage);
    if (!hit) return false;
    isAdmin = true;
    serverId = hit.serverId;
    overview = hit.overview;
    cachedAt = overview?.checkedAt ?? null;
    warmedOnly = true;
    render();
    return true;
  }

  function onStatus(status) {
    const nextAdmin = Boolean(status?.teamAdmin?.isAdmin);
    const nextServerId = status?.activeServerId || null;
    const changed = nextAdmin !== isAdmin || nextServerId !== serverId;
    const wasWarmedOnly = warmedOnly;
    warmedOnly = false;
    isAdmin = nextAdmin;
    serverId = nextServerId;
    if (changed) {
      seq += 1;
      // 先拿本机缓存的上一份顶上（显示「正在同步…」），新数据到了再替换
      overview = isAdmin ? readCachedOverview(storage, serverId) : null;
      cachedAt = overview?.checkedAt ?? null;
      error = "";
      loading = false;
      lastBannerHtml = null;
      lastKpisHtml = null;
      lastListHtml = null;
      lastSubHtml = null;
      openUser = null;
      detailUsers.clear();
      render();
      if (visible()) refresh();
      schedule();
    } else if (wasWarmedOnly) {
      if (visible()) refresh();
      schedule();
    }
  }

  function bind() {
    $("teamAdminRefreshBtn")?.addEventListener("click", () => {
      if (!loading && !busy) refresh({ fresh: true });
    });
    $("teamAdminSyncBtn")?.addEventListener("click", () => {
      syncNow();
    });
    $("teamAdminAddMemberBtn")?.addEventListener("click", () => {
      openMemberDialog(null);
    });
    $("teamAdminBatchOnboardBtn")?.addEventListener("click", () => {
      batchOnboardDiscovered();
    });
    $("teamAdminBatchReleasePortsBtn")?.addEventListener("click", () => {
      batchReleaseIdlePorts();
    });
    $("teamAdminBatchAssignBtn")?.addEventListener("click", () => {
      openAssignDialog("*", { batch: true });
    });
    $("tmAssignPresetBar")?.addEventListener("click", (e) => {
      const saveBtn = e.target?.closest?.("[data-tm-save-preset]");
      if (saveBtn) {
        saveCurrentFormAsPreset();
        return;
      }
      const delBtn = e.target?.closest?.("[data-tm-delete-preset]");
      if (delBtn) {
        const idx = Number(delBtn.dataset.tmDeletePreset);
        const presets = readAssignPresets(storage);
        if (Number.isInteger(idx) && idx >= 0 && idx < presets.length) {
          const removed = presets.splice(idx, 1)[0];
          writeAssignPresets(storage, presets);
          syncAssignPresetBarUi();
          showToast?.({ type: "info", title: "已删除预设", message: `预设「${removed.name}」已移除。` });
        }
        return;
      }
      const presetBtn = e.target?.closest?.("[data-tm-apply-preset]");
      if (presetBtn) {
        const idx = Number(presetBtn.dataset.tmApplyPreset);
        const presets = readAssignPresets(storage);
        if (Number.isInteger(idx) && presets[idx]) {
          applyAssignTemplateToForm(presets[idx], presets[idx].name);
        }
        return;
      }
      const activeTplBtn = e.target?.closest?.("[data-tm-apply-active-tpl]");
      if (activeTplBtn) {
        const idx = Number(activeTplBtn.dataset.tmApplyActiveTpl);
        const activeTemplates = extractOverviewConfigTemplates(overview);
        if (Number.isInteger(idx) && activeTemplates[idx]) {
          applyAssignTemplateToForm(activeTemplates[idx], activeTemplates[idx].label);
        }
      }
    });
    $("teamAdminExportBtn")?.addEventListener("click", () => {
      exportTeamCsv();
    });
    $("tmRecommendPortBtn")?.addEventListener("click", () => {
      const rec = fillRecommendedPort();
      if (rec) {
        showToast?.({ type: "info", title: "已推荐空闲端口", message: `已自动填入不冲突的专属端口 :${rec}。` });
      }
    });
    $("teamAdminNoticeBtn")?.addEventListener("click", () => {
      openNoticeDialog();
    });
    $("teamAdminRootGuideBtn")?.addEventListener("click", () => {
      openRootGuideDialog();
    });
    $("tmCopyRootScriptBtn")?.addEventListener("click", () => {
      const script = overview?.hub?.rootGrantScript || $("tmRootGrantScriptBox")?.textContent || "";
      if (!script) return;
      Promise.resolve(copyText(script))
        .then(() => showToast?.({ type: "success", title: "赋权脚本已复制", message: "请使用 root 账号登录集群终端粘贴执行。" }))
        .catch(() => {});
    });
    $("tmVerifyRootGrantBtn")?.addEventListener("click", async () => {
      await refresh({ fresh: true });
      if (overview?.hub?.sudoReady) {
        showToast?.({ type: "success", title: "Root 赋权已生效", message: "免密强踢异常端口与全员真实用量兜底采集均已就绪！" });
      } else {
        showToast?.({ type: "warn", title: "尚未检测到赋权", message: "请确认已在当前集群以 root 身份完整粘贴并执行了上方脚本。" });
      }
    });
    $("teamAdminSearchInput")?.addEventListener("input", (e) => {
      query = e.target?.value || "";
      render();
    });
    $("teamAdminSortSelect")?.addEventListener("change", (e) => {
      setSort(e.target?.value || "default");
    });
    $("teamAdminFilterPills")?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-tm-filter]");
      if (!btn) return;
      filter = btn.dataset.tmFilter || "all";
      render();
    });
    $("teamAdminLayoutToggle")?.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-tm-layout]");
      if (btn) setLayout(btn.dataset.tmLayout);
    });
    $("tmAssignUserPicker")?.addEventListener("click", (e) => {
      const pickBtn = e.target?.closest?.("[data-tm-pick-user]");
      if (pickBtn) {
        const u = pickBtn.dataset.tmPickUser;
        if (!u) return;
        if (assignPickedUsers.has(u)) {
          assignPickedUsers.delete(u);
        } else if (assignPickedUsers.size >= TEAM_BATCH_MAX) {
          // 后端 assignAiConfig 对 users 只取前 32 个，多选超限会被静默丢掉——在 UI 层就说清楚。
          showToast?.({
            type: "warn",
            title: "配置下发",
            message: `单次最多选择 ${TEAM_BATCH_MAX} 位成员，请先取消部分勾选再继续。`,
          });
          return;
        } else {
          assignPickedUsers.add(u);
        }
        syncAssignPickerUi();
        return;
      }
      const batchBtn = e.target?.closest?.("[data-tm-pick-batch]");
      if (batchBtn) {
        const mode = batchBtn.dataset.tmPickBatch;
        const members = Array.isArray(overview?.members) ? overview.members : [];
        assignPickedUsers.clear();
        const wanted = (m) => {
          if (!m?.user) return false;
          if (mode === "roster") return m.inRoster !== false;
          if (mode === "unmanaged") return !m.assignment || m.assignment.state === "none";
          if (mode === "all") return true;
          return false;
        };
        for (const m of members) {
          if (assignPickedUsers.size >= TEAM_BATCH_MAX) break;
          if (wanted(m)) assignPickedUsers.add(m.user);
        }
        if (mode !== "none" && members.filter(wanted).length > TEAM_BATCH_MAX) {
          showToast?.({
            type: "warn",
            title: "配置下发",
            message: `单次最多 ${TEAM_BATCH_MAX} 位，已选前 ${TEAM_BATCH_MAX} 位；其余请分批下发。`,
          });
        }
        syncAssignPickerUi();
      }
    });
    $("teamSky")?.addEventListener("click", (e) => {
      if (e.target?.closest?.("[data-tm-goto-attention]")) {
        filter = "attention";
        render();
        $("teamAdminList")?.scrollIntoView?.({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
        return;
      }
      const kpiCell = e.target?.closest?.("[data-tm-kpi-action]");
      if (kpiCell) {
        const act = kpiCell.dataset.tmKpiAction;
        if (act === "roster") {
          filter = filter === "roster" ? "all" : "roster";
          render();
          $("teamAdminList")?.scrollIntoView?.({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
        } else if (act === "online") {
          filter = filter === "online" ? "all" : "online";
          render();
          $("teamAdminList")?.scrollIntoView?.({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
        } else if (act === "tokens") {
          setSort(sort === "tokens" ? "week" : "tokens");
          $("teamAdminList")?.scrollIntoView?.({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
        } else if (act === "gpu") {
          setSort(sort === "gpu" ? "default" : "gpu");
          $("teamAdminList")?.scrollIntoView?.({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
        } else if (act === "config") {
          openAssignDialog("*", { batch: true });
        }
      }
    });
    $("teamAdminBanner")?.addEventListener("click", (e) => {
      const copyBtn = e.target?.closest?.("[data-tm-copy-cmd]");
      if (copyBtn) {
        const cmd = copyBtn.dataset.tmCopyCmd;
        if (cmd) {
          Promise.resolve(copyText(cmd))
            .then(() => showToast?.({ type: "success", title: "已复制命令", message: "可在集群终端粘贴执行。" }))
            .catch(() => {});
        }
        return;
      }
      const assignGroupBtn = e.target?.closest?.("[data-tm-assign-group]");
      if (assignGroupBtn) {
        openAssignDialog(assignGroupBtn.dataset.tmAssignGroup);
        return;
      }
      if (e.target?.closest?.("[data-tm-edit-notice]")) {
        openNoticeDialog();
        return;
      }
      if (e.target?.closest?.("[data-tm-clear-notice]")) {
        clearNotice();
        return;
      }
      if (e.target?.closest?.("[data-tm-open-root-guide]")) {
        openRootGuideDialog();
        return;
      }
      if (e.target?.closest?.("[data-tm-sync-now]")) {
        syncNow();
      }
    });
    const listEl = $("teamAdminList");
    listEl?.addEventListener("click", (e) => {
      const t = e.target;
      const menuBtn = t?.closest?.("[data-tm-menu]");
      if (menuBtn) {
        e.stopPropagation();
        openMenu(menuBtn, menuBtn.dataset.tmMenu);
        return;
      }
      if (dispatchAction(t)) return;
      const filterNodeBtn = t?.closest?.("[data-tm-filter-node]");
      if (filterNodeBtn) {
        e.stopPropagation?.();
        const nd = filterNodeBtn.dataset.tmFilterNode || "";
        if (nd) {
          query = query.trim().toLowerCase() === nd.toLowerCase() ? "" : nd;
          const search = $("teamAdminSearchInput");
          if (search) search.value = query;
          render();
          showToast?.({
            type: "info",
            title: query ? `已按节点 ${nd} 过滤` : "已清除节点过滤",
            message: query ? `正在显示计算节点 ${nd} 上的团队成员（再次点击可取消）。` : "已恢复显示全部成员。",
          });
        }
        return;
      }
      const locateUserBtn = t?.closest?.("[data-tm-locate-user]");
      if (locateUserBtn) {
        e.stopPropagation?.();
        const targetUser = locateUserBtn.dataset.tmLocateUser || "";
        if (targetUser) locateMember(targetUser);
        return;
      }
      if (t?.closest?.("[data-tm-toggle-offline]")) {
        offlineOpen = !offlineOpen;
        render();
        return;
      }
      const chip = t?.closest?.("[data-tm-chip]");
      if (chip) {
        locateMember(chip.dataset.tmChip);
        return;
      }
      if (t?.closest?.(".tm-detail-wrap, a, input, select, textarea")) return;
      const toggle = t?.closest?.("[data-tm-toggle]");
      if (toggle) toggleOpen(toggle.dataset.tmToggle);
    });
    // 悬停名单 → 点亮星图里的行星（以及它的星座）
    let hoverUser = null;
    listEl?.addEventListener("pointerover", (e) => {
      const it = e.target?.closest?.("[data-tm-member], [data-tm-chip]");
      const user = it ? it.dataset.tmMember || it.dataset.tmChip : null;
      if (user === hoverUser) return;
      hoverUser = user;
      galaxy?.setFocus(user, "list");
    });
    listEl?.addEventListener("pointerleave", () => {
      hoverUser = null;
      galaxy?.setFocus(null, "list");
    });
    const menu = $("teamRowMenu");
    menu?.addEventListener("click", (e) => {
      if (dispatchAction(e.target)) closeMenu();
    });
    doc?.addEventListener?.("click", (e) => {
      if (!e.target?.closest?.("#teamRowMenu, [data-tm-menu]")) closeMenu();
    });
    doc?.addEventListener?.("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });
    doc?.defaultView?.addEventListener?.("scroll", closeMenu, { passive: true, capture: true });
    doc?.defaultView?.addEventListener?.("resize", closeMenu, { passive: true });
    $("teamMemberForm")?.addEventListener("submit", submitMemberForm);
    $("teamAssignForm")?.addEventListener("submit", submitAssignForm);
    $("tmAssignClearBtn")?.addEventListener("click", clearAssignment);
    $("teamNoticeForm")?.addEventListener("submit", submitNoticeForm);
    $("tmNoticeClearBtn")?.addEventListener("click", clearNotice);

    onVisibilityChange?.(() => {
      if (visible()) refresh();
      galaxy?.setActive(visible());
      schedule();
    });
  }

  function enter() {
    if (visible() && !loading && (!overview || Date.now() - lastRefreshAt > 15000)) refresh();
    ensureGalaxy()?.setActive(visible());
    schedule();
  }

  function leave() {
    closeMenu();
    galaxy?.setActive(false);
    schedule();
  }

  return {
    bind,
    enter,
    leave,
    onStatus,
    refresh,
    warmFromCache,
    openAddMember: () => openMemberDialog(null),
    openBatchAssign: () => openAssignDialog("*", { batch: true }),
    openNotice: () => openNoticeDialog(),
    openRootGuide: () => openRootGuideDialog(),
    syncNow,
    exportCsv: () => exportTeamCsv(),
  };
}
