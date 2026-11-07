// 卡顿信号红条：纯函数构建 + DOM 渲染分离（纯函数部分可被 plain-node 测试）。
// 只有 error 级活跃信号才出横幅；warn 级交由日志时间线呈现，避免横幅噪音。
// 渲染层用签名跳过包装：信号未变时不重写标题/正文/显隐。
//
// v2.17 根因分诊行：信号条目上的 rootCause/rootCauseLabel/rootCauseAdvice 是后端
// onLogSignals 附加的可选字段——老数据/冷却窗口内被覆盖的 active 条目没有这些键，
// 此时不渲染该行、不报错。红条数据来自 app.js 的单一调用点
// renderSignalBanner(el, status.activeSignals ?? status.layers?.signals?.active)，
// SSE 实时与状态轮询两条通路在那里归一，本模块签名与显隐语义不变
// （包括"探针超时轮不清空"——那是 state-store 的回退，前端不感知）。

import { createMemoRender } from "./render-skip.js";

// 分诊为 setup（还没领反向端口）的信号不出红条：集群上的请求超时/连接失败是没有隧道的必然结果，
// 横幅里已有领端口的引导卡，再刷一条"卡顿信号"红条只是重复告警。
export function buildSignalBanner(activeSignals) {
  const errors = (activeSignals || []).filter((s) => s && s.severity === "error" && s.rootCause !== "setup");
  if (!errors.length) return null;
  const first = errors[0];
  const suffix = errors.length > 1 ? `（等 ${errors.length} 项异常）` : "";
  // 根因行文案：label 缺失即整行不出（rootCause 为 null）；advice 缺失时只出 label。
  const rootCause = first.rootCauseLabel
    ? `根因：${first.rootCauseLabel}${first.rootCauseAdvice ? ` — ${first.rootCauseAdvice}` : ""}`
    : null;
  return {
    severity: "error",
    title: `卡顿信号：${first.title}${suffix}`,
    body: first.advice || "",
    rootCause,
  };
}

function renderSignalBannerImpl(el, activeSignals) {
  if (!el) return;
  const banner = buildSignalBanner(activeSignals);
  if (!banner) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  const titleEl = el.querySelector("#signalTitle");
  const bodyEl = el.querySelector("#signalBody");
  if (titleEl) titleEl.textContent = banner.title;
  if (bodyEl) bodyEl.textContent = banner.body;
  // 根因行元素惰性创建（index.html 零结构改动），文案一律 textContent 赋值——
  // rootCauseLabel/advice 源自远端日志派生数据，必须走转义安全路径，禁 innerHTML。
  let rootEl = el.querySelector("#signalRootCause");
  if (banner.rootCause) {
    if (!rootEl) {
      rootEl = document.createElement("p");
      rootEl.id = "signalRootCause";
      rootEl.className = "signal-root-cause";
      (bodyEl?.parentNode || el).appendChild(rootEl);
    }
    rootEl.textContent = banner.rootCause;
    rootEl.style.display = "";
  } else if (rootEl) {
    // 无分类字段（老数据/冷却覆盖）只藏行不撤横幅，显隐语义与既有红条一致。
    rootEl.textContent = "";
    rootEl.style.display = "none";
  }
}

// 签名复用纯函数构建结果：无 error 信号统一为 "hidden"，有则取 title+body+根因行。
export const renderSignalBanner = createMemoRender(
  renderSignalBannerImpl,
  (_el, activeSignals) => {
    const banner = buildSignalBanner(activeSignals);
    return banner ? `${banner.title}|${banner.body}|${banner.rootCause || ""}` : "hidden";
  },
);
