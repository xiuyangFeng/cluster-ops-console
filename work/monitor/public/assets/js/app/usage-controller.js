// app/usage-controller.js —— 用量视图的控制器：筛选状态、拉取 /api/usage/*、轮询、交互接线。
//
// 只在用量视图可见且窗口没被隐藏时轮询（15s，后端扫描是 60s 一轮）。会话列表保护阅读位置：
// 开启「跟随最新」、停在顶部、指针不在表格上时才重排，否则只记下「N 个会话有更新」。
// 详情弹窗刷新时保留滚动位置与已展开的轮次。
import { createElementLookup } from "../dom-utils.js";
import { createUsageView } from "../render/usage-view.js";
import { sessionsCsv } from "../render/usage-model.js";

export const USAGE_POLL_MS = 15000;
export const TREND_MODE_STORAGE_KEY = "usageTrendMode";
const PAGE = 40;

export function createUsageController({ doc, win, getJson, postJson, showToast, isViewVisible, isHidden, onVisibilityChange, onSummary = null, storage = typeof localStorage !== "undefined" ? localStorage : null, now = Date.now }) {
  const $ = createElementLookup(doc);
  // 点趋势图里的某一天 → 只看那天（多日范围才有意义；合并图与「分开」的小图同一规则）
  const pickBucket = (index) => {
    if (state.date || state.range === 1) return;
    const date = view.bucketKey(index);
    if (date) changeScope({ date });
  };
  const view = createUsageView({ doc, onPickBucket: pickBucket });
  // 趋势图排布（合并 / 分开）记在本机，下次打开还是上次的选择
  let savedTrendMode = null;
  try {
    savedTrendMode = storage?.getItem(TREND_MODE_STORAGE_KEY) ?? null;
  } catch {}
  const state = {
    range: 1, date: null, agent: "all", project: "all", projectLabel: "", model: "all",
    sessionFilter: "all", search: "", sort: "recent", limit: PAGE,
    follow: true, hovering: false, syncing: false,
    calendarPeriod: "rolling", calendarMetric: "calls",
    trendMode: savedTrendMode === "split" ? "split" : "merged",
    openKey: null, failedOnly: false, expanded: new Set(),
  };
  let summary = null;
  let detail = null;
  let timer = null;
  let inFlight = null;
  let requestSeq = 0;
  let detailSeq = 0; // 会话详情请求序号（与列表的 requestSeq 分开：轮询会同时拉两者）
  let appliedDetailSeq = 0; // 已落地（渲染）的最新详情请求序号
  let loadedQuery = null;
  let loadedAt = 0;
  const held = new Set(); // 暂缓重排期间有更新的会话
  let lastSessionSig = new Map();

  const visible = () => isViewVisible("usage") && !isHidden();

  function queryString() {
    const params = new URLSearchParams({ range: String(state.range), agent: state.agent, project: state.project });
    if (state.date) params.set("date", state.date);
    if (state.model !== "all") params.set("model", state.model);
    return params.toString();
  }

  const listAtTop = () => ($("usageSessionScroll")?.scrollTop ?? 0) <= 4;
  const canReorder = () => state.follow && listAtTop() && !state.hovering;

  function sessionSig(s) {
    return `${s.last}|${s.stats.calls}|${s.stats.total}|${s.status}`;
  }

  function renderAll({ forceSessions = false } = {}) {
    if (!summary) return;
    const changed = new Set();
    const nextSig = new Map();
    for (const s of summary.sessions) {
      const sig = sessionSig(s);
      nextSig.set(s.key, sig);
      if (lastSessionSig.size && lastSessionSig.get(s.key) !== sig) changed.add(s.key);
    }
    lastSessionSig = nextSig;
    const reorder = forceSessions || canReorder();
    view.render(summary, state, { skipSessions: !reorder, highlight: changed });
    if (reorder) held.clear();
    else for (const key of changed) held.add(key);
    view.renderHeld(held.size);
  }

  async function load({ forceSessions = false } = {}) {
    const seq = ++requestSeq;
    const query = queryString();
    try {
      const data = await getJson(`/api/usage/summary?${query}`);
      if (seq !== requestSeq) return; // 筛选已变，丢弃迟到的旧响应
      // 用量模块已关闭（v2.47）：后端回 200 { disabled: true }。不当错误报，只给一行说明；
      // 通常用量页随模块一起隐藏了，这里兜住切换瞬间的那一次请求。
      if (data?.disabled) {
        summary = null;
        view.renderDisabled();
        return;
      }
      summary = data;
      loadedQuery = query;
      loadedAt = now();
      onSummary?.(summary, state);
      renderAll({ forceSessions });
    } catch (err) {
      if (seq === requestSeq && !summary) showToast?.({ type: "error", title: "用量", message: err?.serverMessage || err?.message || "加载失败" });
    }
  }

  // 成功与 404 两个分支走同一道过期校验：弹窗里仍是这个会话，且没有更晚发出的请求已经落地。
  // 只在成功分支核对不够——A 的迟到 404 会把已打开的 B 改成「会话不存在」；只核对会话键也不够——
  // 同一会话轮询时较旧的回包（含 404）可能晚于较新的到达。较新的请求失败（非 404）时较旧的结果仍可用。
  async function loadDetail() {
    if (!state.openKey) return;
    const key = state.openKey;
    const seq = ++detailSeq;
    const stale = () => state.openKey !== key || seq < appliedDetailSeq;
    try {
      const data = await getJson(`/api/usage/session?key=${encodeURIComponent(key)}`);
      if (stale() || data?.disabled) return; // 模块已关闭：保留弹窗里已有的内容
      detail = data;
    } catch (err) {
      if (stale() || err?.status !== 404) return;
      detail = null;
    }
    appliedDetailSeq = seq;
    view.renderDetail(detail, state);
  }

  function refresh(options) {
    if (!inFlight) {
      inFlight = Promise.all([load(options), $("dlgUsageSession")?.open ? loadDetail() : null]).finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!visible()) return;
    // 快速往返不会把下一次轮询不断推迟；始终按最近成功响应的时间计算剩余间隔。
    const age = now() - loadedAt;
    const delay = summary && loadedQuery === queryString() && age >= 0 && age < USAGE_POLL_MS
      ? USAGE_POLL_MS - age : USAGE_POLL_MS;
    timer = setTimeout(async () => {
      if (visible()) await refresh();
      schedule();
    }, delay);
  }

  function changeScope(patch) {
    Object.assign(state, patch, { limit: PAGE });
    const scroll = $("usageSessionScroll");
    if (scroll) scroll.scrollTop = 0;
    held.clear();
    lastSessionSig = new Map();
    if (summary) {
      onSummary?.(summary, state);
      view.render(summary, state, { skipSessions: true });
    }
    load({ forceSessions: true });
  }

  function resetSessionFilters() {
    state.search = "";
    const search = $("usageSearch");
    if (search) search.value = "";
    state.sessionFilter = "all";
    rerenderSessions();
  }

  // 空状态里的动作（顶部说明 + 会话表空态，均由 usage-view.js 渲染、会被就地修补替换）：委托在容器上，
  // 全部复用已有路径——同步 = 「立即同步」，换范围 = 顶部日期分段，清除筛选 = 筛选条的「清除」（保留日期），
  // 清除会话筛选 = 会话工具栏的重置。
  function onEmptyStateClick(event) {
    const target = event.target?.closest?.("[data-usage-sync],[data-usage-jump-range],[data-usage-clear-filter],#usageResetSessions");
    if (!target) return;
    if (target.dataset.usageSync != null) syncNow();
    else if (target.dataset.usageJumpRange) changeScope({ range: Number(target.dataset.usageJumpRange), date: null });
    else if (target.dataset.usageClearFilter != null) changeScope({ agent: "all", project: "all", projectLabel: "", model: "all" });
    else resetSessionFilters();
  }

  function rerenderSessions() {
    if (!summary) return;
    view.renderSessions(summary, state);
    held.clear();
    view.renderHeld(0);
  }

  function openSession(key, { failedOnly = false } = {}) {
    if (state.openKey !== key) state.expanded.clear();
    state.openKey = key;
    state.failedOnly = failedOnly;
    detail = null;
    view.renderDetailLoading();
    const dlg = $("dlgUsageSession");
    if (!dlg.open) dlg.showModal();
    loadDetail();
  }

  async function syncNow() {
    if (state.syncing || !summary?.sources?.length) return;
    state.syncing = true;
    view.render(summary, state, { skipSessions: true });
    try {
      for (const source of summary.sources) await postJson(`/api/probe/${encodeURIComponent(`usage:${source.id}`)}/run`, {});
      await load();
      showToast?.({ type: "success", title: "用量", message: "已同步最新会话日志" });
    } catch (err) {
      showToast?.({ type: "error", title: "用量同步失败", message: err?.serverMessage || err?.message || "请稍后再试" });
    } finally {
      state.syncing = false;
      if (summary) view.render(summary, state, { skipSessions: true });
    }
  }

  function exportCsv() {
    if (!summary) return;
    const rows = summary.sessions;
    const url = URL.createObjectURL(new Blob(["﻿", sessionsCsv(rows)], { type: "text/csv;charset=utf-8" }));
    const anchor = doc.createElement("a");
    anchor.href = url;
    anchor.download = `agent-usage-${state.date ?? summary.today}-${state.date ? "day" : `${state.range}d`}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast?.({ type: "info", title: "导出", message: `已导出 ${rows.length} 个会话（当前筛选范围）` });
  }

  function bind() {
    for (const btn of doc.querySelectorAll("[data-usage-range]")) btn.addEventListener("click", () => changeScope({ range: Number(btn.dataset.usageRange), date: null }));
    $("usageAgentFilter")?.addEventListener("change", (e) => changeScope({ agent: e.target.value }));
    $("usageProjectFilter")?.addEventListener("change", (e) => changeScope({ project: e.target.value, projectLabel: e.target.selectedOptions[0]?.textContent || "" }));
    $("usageClearFilter")?.addEventListener("click", () => changeScope({ date: null, agent: "all", project: "all", projectLabel: "", model: "all" }));
    $("usageInsights")?.addEventListener("click", (e) => {
      const pick = e.target.closest("[data-cost-kind]");
      if (!pick || !["agent", "project", "model"].includes(pick.dataset.costKind)) return;
      const kind = pick.dataset.costKind;
      const value = state[kind] === pick.dataset.costKey ? "all" : pick.dataset.costKey;
      changeScope({ [kind]: value, ...(kind === "project" ? { projectLabel: "" } : {}) });
    });
    $("usageExportBtn")?.addEventListener("click", exportCsv);
    $("usageSyncBtn")?.addEventListener("click", syncNow);
    for (const btn of doc.querySelectorAll("[data-dialog-usage]")) btn.addEventListener("click", () => $(btn.dataset.dialogUsage)?.showModal());

    $("usageProjects")?.addEventListener("click", (e) => {
      const row = e.target.closest("[data-project]");
      if (!row) return;
      const key = row.dataset.project;
      changeScope(state.project === key ? { project: "all", projectLabel: "" } : { project: key, projectLabel: row.querySelector("strong")?.textContent || key });
    });
    $("usageCalendarDays")?.addEventListener("click", (e) => {
      const day = e.target.closest("[data-date]");
      if (day && !day.disabled) changeScope({ date: day.dataset.date });
    });
    $("usageCalendarPeriod")?.addEventListener("change", (e) => { state.calendarPeriod = e.target.value; if (summary) view.render(summary, state, { skipSessions: true }); });
    $("usageCalendarMetric")?.addEventListener("change", (e) => { state.calendarMetric = e.target.value; if (summary) view.render(summary, state, { skipSessions: true }); });
    const jumpToErrors = (e) => {
      if (!e.target.closest("[data-usage-jump='errors']")) return false;
      Object.assign(state, { sessionFilter: "error", sort: "errors", limit: PAGE });
      rerenderSessions();
      $("usageSessionsPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return true;
    };
    $("usageCallsDesc")?.addEventListener("click", jumpToErrors);
    // 星图总览：失败数直达失败会话；点模型彗星按它的 Agent 筛选，再点同一个取消
    $("usageGalaxyStage")?.addEventListener("click", (e) => {
      if (jumpToErrors(e)) return;
      const comet = e.target.closest("[data-usage-pick-agent]");
      if (!comet) return;
      const agent = comet.dataset.usagePickAgent;
      changeScope({ agent: state.agent === agent ? "all" : agent });
    });

    const chart = $("usageTrendChart");
    chart?.addEventListener("pointermove", (e) => {
      const target = e.target.closest("[data-bucket]");
      if (!target) { $("usageTooltip").hidden = true; view.moveCrosshair(null); return; }
      view.renderTooltip(Number(target.dataset.bucket), e.clientX, e.clientY, state);
      view.moveCrosshair(Number(target.dataset.bucket));
    });
    chart?.addEventListener("pointerleave", () => { $("usageTooltip").hidden = true; view.moveCrosshair(null); });
    chart?.addEventListener("click", (e) => {
      const target = e.target.closest("[data-bucket]");
      if (target) pickBucket(Number(target.dataset.bucket));
    });
    for (const btn of doc.querySelectorAll("[data-usage-trend]")) {
      btn.addEventListener("click", () => {
        state.trendMode = btn.dataset.usageTrend === "split" ? "split" : "merged";
        try {
          storage?.setItem(TREND_MODE_STORAGE_KEY, state.trendMode);
        } catch {}
        if (summary) view.renderTrend(summary, state);
      });
    }
    if (chart && typeof win?.ResizeObserver === "function") {
      let frame = 0;
      // 合并图与「分开」的容器同一时刻只有一个可见；谁的尺寸变了（含从隐藏变可见）都重画趋势
      const observer = new win.ResizeObserver(() => {
        win.cancelAnimationFrame(frame);
        frame = win.requestAnimationFrame(() => { if (summary && visible()) view.renderTrend(summary, state); });
      });
      observer.observe(chart);
      const split = $("usageTrendSplit");
      if (split) observer.observe(split);
    }

    $("usageSearch")?.addEventListener("input", (e) => { state.search = e.target.value; state.limit = PAGE; rerenderSessions(); });
    for (const btn of doc.querySelectorAll("[data-usage-filter]")) btn.addEventListener("click", () => { state.sessionFilter = btn.dataset.usageFilter; state.limit = PAGE; rerenderSessions(); });
    for (const btn of doc.querySelectorAll("[data-usage-sort]")) btn.addEventListener("click", () => { state.sort = btn.dataset.usageSort; $("usageSessionScroll").scrollTop = 0; rerenderSessions(); });
    $("usageEmptyState")?.addEventListener("click", onEmptyStateClick);
    $("usageSessionEmpty")?.addEventListener("click", onEmptyStateClick);
    $("usageMoreBtn")?.addEventListener("click", () => { state.limit += PAGE; rerenderSessions(); });
    $("usageSessionRows")?.addEventListener("click", (e) => {
      const failed = e.target.closest("[data-failed]");
      if (failed) { openSession(failed.dataset.failed, { failedOnly: true }); return; }
      const row = e.target.closest("[data-session]");
      if (row) openSession(row.dataset.session);
    });
    const scroll = $("usageSessionScroll");
    scroll?.addEventListener("pointerenter", () => { state.hovering = true; });
    scroll?.addEventListener("pointerleave", () => { state.hovering = false; if (held.size && canReorder()) rerenderSessions(); });
    scroll?.addEventListener("scroll", () => { if (held.size && canReorder()) rerenderSessions(); });
    $("usageHeldBtn")?.addEventListener("click", () => { state.follow = true; $("usageSessionScroll").scrollTop = 0; rerenderSessions(); view.renderLive(summary, state); });
    $("usageFollowBtn")?.addEventListener("click", () => {
      state.follow = !state.follow;
      if (summary) view.renderLive(summary, state);
      if (state.follow) { $("usageSessionScroll").scrollTop = 0; rerenderSessions(); }
    });

    const detailBody = $("usageSessionDetail");
    detailBody?.addEventListener("click", (e) => {
      const mode = e.target.closest("[data-detail-view]");
      if (mode) { state.failedOnly = mode.dataset.detailView === "failed"; view.renderDetail(detail, state); return; }
      // 失败调用的「原文」：原地展开 / 收起（与轮次展开共用 expanded 集合，键 err:<rid>）
      const errToggle = e.target.closest("[data-call-err]");
      if (errToggle) {
        const key = errToggle.dataset.callErr;
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        view.renderDetail(detail, state);
        // 详情整块重绘，把焦点还给同一个按钮（键盘操作不丢位置）
        for (const btn of detailBody.querySelectorAll("[data-call-err]")) if (btn.dataset.callErr === key) { btn.focus(); break; }
        return;
      }
      const turn = e.target.closest("[data-turn]");
      if (!turn) return;
      if (state.expanded.has(turn.dataset.turn)) state.expanded.delete(turn.dataset.turn);
      else state.expanded.add(turn.dataset.turn);
      view.renderDetail(detail, state);
    });
    detailBody?.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-turn]")) { e.preventDefault(); e.target.click(); }
    });
    $("dlgUsageSession")?.addEventListener("close", () => { state.openKey = null; state.failedOnly = false; detail = null; });

    onVisibilityChange?.(() => { if (visible()) { refresh(); schedule(); } else schedule(); });
  }

  // 同一刷新周期内重进复用现有内容；过期则后台刷新，继续遵守会话列表的阅读保护。
  function enter() {
    const age = now() - loadedAt;
    if (!summary || loadedQuery !== queryString() || age < 0 || age >= USAGE_POLL_MS) {
      refresh({ forceSessions: !summary });
    }
    schedule();
  }

  function leave() {
    schedule();
  }

  return { bind, enter, leave, refresh, state };
}
