// app/brief-controller.js —— 概览「今日简报」：拉取 /api/brief、/api/brief/days；日期切换（今天 / 昨天 / 更早归档）；
// 点击跳转；只在概览可见且窗口没被隐藏时轮询（60s，后端简报本身缓存 60s）。
// 链路面板底部的「隧道稳定性」另由 app/tunnel-stability-controller.js 负责。
//
// 「上次查看」：本机记录（localStorage）。页面加载时读出上一次的时刻用于本次标「新」与表头说明；
// 今天的简报在可见状态下停留满 5 秒才记为已看（只扫一眼切走不算）。
import { createBriefView, previousDay } from "../render/brief-view.js";

export const BRIEF_POLL_MS = 60000;
export const BRIEF_LAST_VIEWED_KEY = "briefLastViewedAt";
const VIEWED_AFTER_MS = 5000;

export function createBriefController({ doc, getJson, isViewVisible, isHidden, onVisibilityChange, onNavigate, now = () => Date.now(), storage = typeof localStorage !== "undefined" ? localStorage : null }) {
  const view = createBriefView({ doc });
  let lastViewedAt = null;
  try {
    const raw = Number(storage?.getItem(BRIEF_LAST_VIEWED_KEY));
    if (Number.isFinite(raw) && raw > 0) lastViewedAt = raw;
  } catch {}
  let selected = null; // null = 今天
  let daysInfo = { today: "", days: [] };
  let brief = null;
  let timer = null;
  let viewedTimer = null;
  let seq = 0;

  const visible = () => isViewVisible("overview") && !isHidden();

  function markViewedSoon() {
    clearTimeout(viewedTimer);
    if (selected || !brief || brief.final) return;
    viewedTimer = setTimeout(() => {
      if (!visible()) return;
      try {
        storage?.setItem(BRIEF_LAST_VIEWED_KEY, String(now()));
      } catch {}
    }, VIEWED_AFTER_MS);
  }

  async function refresh() {
    const mySeq = ++seq;
    const day = selected;
    const [briefRes, daysRes] = await Promise.allSettled([
      getJson(day ? `/api/brief?day=${encodeURIComponent(day)}` : "/api/brief"),
      getJson("/api/brief/days"),
    ]);
    if (mySeq !== seq) return; // 期间切了日期，丢弃迟到的旧响应
    if (daysRes.status === "fulfilled") daysInfo = daysRes.value;
    view.renderDays(daysInfo, selected || daysInfo.today);
    // 这一天没有简报（404 或空响应）：说明为什么没有，并给「回到今天」。
    const missing = { day: day || daysInfo.today, today: daysInfo.today, retentionDays: daysInfo.retentionDays ?? null };
    if (briefRes.status === "fulfilled") {
      brief = briefRes.value;
      view.renderBrief(brief, { nowMs: now(), lastViewedAt, ...missing });
      markViewedSoon();
    } else if (!brief) {
      const err = briefRes.reason;
      if (err?.status === 404) view.renderBrief(null, { nowMs: now(), lastViewedAt, ...missing });
      else view.renderError(`简报加载失败：${err?.serverMessage || err?.message || "未知错误"}`);
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!visible()) return;
    timer = setTimeout(async () => {
      if (visible()) await refresh().catch(() => {});
      schedule();
    }, BRIEF_POLL_MS);
  }

  function selectDay(day) {
    selected = day && day !== daysInfo.today ? day : null;
    brief = null;
    refresh().catch(() => {});
  }

  function bind() {
    for (const btn of doc.querySelectorAll("[data-brief-day]")) {
      btn.addEventListener("click", () => {
        if (btn.dataset.briefDay === "today") selectDay(null);
        else if (daysInfo.today) selectDay(previousDay(daysInfo.today));
      });
    }
    doc.getElementById("briefArchiveSelect")?.addEventListener("change", (e) => {
      if (e.target.value) selectDay(e.target.value);
    });
    // 指标格与留意项的跳转（事件委托：正文经 morphInnerHtml 修补，按钮节点可能被替换）。
    // 「这一天没有简报」里的「回到今天」：与日期分段里的「今天」同一条路（selectDay(null)）。
    doc.getElementById("briefBody")?.addEventListener("click", (e) => {
      if (e.target.closest?.("[data-brief-back]")) {
        selectDay(null);
        return;
      }
      const target = e.target.closest?.("[data-brief-goto]");
      if (target?.dataset.briefGoto) onNavigate?.(target.dataset.briefGoto);
    });
    onVisibilityChange?.(() => { if (visible()) { refresh().catch(() => {}); schedule(); } else schedule(); });
  }

  function enter() {
    refresh().catch(() => {});
    schedule();
  }

  function leave() {
    clearTimeout(viewedTimer);
    schedule();
  }

  return { bind, enter, leave, refresh, selectDay };
}
