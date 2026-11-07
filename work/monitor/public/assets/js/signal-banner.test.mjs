import assert from "node:assert/strict";

import { buildSignalBanner, renderSignalBanner } from "./render/signal-banner.js";

// 无信号 / 仅 warn：不出红条（warn 交由日志时间线呈现，避免横幅噪音）
assert.equal(buildSignalBanner([]), null);
assert.equal(buildSignalBanner(undefined), null);
assert.equal(
  buildSignalBanner([{ id: "rate-limited", severity: "warn", title: "请求被限流 (429)", advice: "稍后重试" }]),
  null,
);

// 单条 error：标题 + advice 正文
const one = buildSignalBanner([
  { id: "account-revoked", severity: "error", title: "账号被解绑", advice: "在节点上重新登录 reclaude（reclaude login）后通道自动恢复" },
]);
assert.equal(one.severity, "error");
assert.equal(one.title, "卡顿信号：账号被解绑");
assert.ok(one.body.includes("reclaude login"));

// 多条 error：首条为主 + 计数
const multi = buildSignalBanner([
  { id: "account-revoked", severity: "error", title: "账号被解绑", advice: "重新登录" },
  { id: "gateway-unhealthy", severity: "error", title: "网关不健康", advice: "检查网关" },
  { id: "rate-limited", severity: "warn", title: "限流", advice: "等待" },
]);
assert.equal(multi.title, "卡顿信号：账号被解绑（等 2 项异常）");

// ---- v2.17 根因分诊行（可选字段：老数据无分类字段时不出该行、不报错）----

// 有分类字段：rootCause 行 = "根因：{label} — {advice}"
const triaged = buildSignalBanner([
  {
    id: "gateway-unhealthy", severity: "error", title: "网关不健康", advice: "检查网关进程",
    rootCause: "account", rootCauseLabel: "账号层故障", rootCauseAdvice: "设备已解绑，需在服务器重新登录",
  },
]);
assert.equal(triaged.rootCause, "根因：账号层故障 — 设备已解绑，需在服务器重新登录");

// 只有 label 没有 advice：仅出 label，不带分隔符
const labelOnly = buildSignalBanner([
  { id: "http-5xx", severity: "error", title: "上游 5xx", advice: "稍候", rootCauseLabel: "根因未定位" },
]);
assert.equal(labelOnly.rootCause, "根因：根因未定位");

// 无分类字段（老数据）：rootCause 为 null，其余字段不受影响
assert.equal(multi.rootCause, null);
assert.equal(one.rootCause, null);

// ---- DOM 渲染路径：根因行惰性创建 / 无字段隐藏 / 转义（textContent，禁 innerHTML）----
// plain-node 环境用最小伪 DOM 驱动 renderSignalBanner（memo 包装后的完整渲染入口）。
// 所有节点的 innerHTML setter 一律抛错：若实现改走 innerHTML，测试立即失败。

function makeFakeNode(id) {
  const node = { id: id || "", className: "", textContent: "", style: {}, parentNode: null };
  Object.defineProperty(node, "innerHTML", {
    set() {
      throw new Error("innerHTML 禁用：红条文案必须走 textContent 转义安全路径");
    },
  });
  return node;
}

function makeFakeBannerEl() {
  const nodes = [];
  const textWrap = {
    appendChild(child) {
      child.parentNode = textWrap;
      nodes.push(child);
      return child;
    },
  };
  for (const id of ["signalTitle", "signalBody"]) {
    const node = makeFakeNode(id);
    node.parentNode = textWrap;
    nodes.push(node);
  }
  const el = {
    style: {},
    querySelector(selector) {
      if (typeof selector !== "string" || !selector.startsWith("#")) return null;
      const id = selector.slice(1);
      return nodes.find((node) => node.id === id) || null;
    },
  };
  return el;
}

globalThis.document = {
  createElement(tag) {
    assert.equal(tag, "p");
    return makeFakeNode("");
  },
};

const el = makeFakeBannerEl();
const XSS = '<img src=x onerror=alert(1)>&"账号层故障"';
renderSignalBanner(el, [
  {
    id: "gateway-unhealthy", severity: "error", title: "网关不健康", advice: "检查网关",
    rootCause: "account", rootCauseLabel: XSS, rootCauseAdvice: "advice<script>",
  },
]);
const rootEl = el.querySelector("#signalRootCause");
assert.ok(rootEl, "根因行元素应被惰性创建并挂到 alert-text 容器");
assert.equal(rootEl.className, "signal-root-cause");
// 转义语义：textContent 原样承载特殊字符（渲染层不做 HTML 解析），无任何 HTML 化。
assert.equal(rootEl.textContent, `根因：${XSS} — advice<script>`);
assert.equal(rootEl.style.display, "");
assert.equal(el.querySelector("#signalTitle").textContent, "卡顿信号：网关不健康");

// 同一元素改喂无分类字段的信号：根因行只藏不撤，横幅保持显示（显隐语义不变）。
renderSignalBanner(el, [
  { id: "gateway-unhealthy", severity: "error", title: "网关不健康", advice: "检查网关" },
]);
assert.equal(el.style.display, "");
assert.equal(rootEl.style.display, "none");
assert.equal(rootEl.textContent, "");

// 无 error 信号：整条横幅隐藏（既有语义回归）。
renderSignalBanner(el, []);
assert.equal(el.style.display, "none");

delete globalThis.document;

console.log("signal-banner tests ok");
