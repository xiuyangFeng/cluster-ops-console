// motion.js —— 图表与数字的入场动效（设计稿 §2）。
//
// 规则：
//   - 每块只在「骨架退场」或「第一次进入它所在的页」时播一次；定时刷新、切回来、窗口缩放都不重播。
//   - 只动 transform / opacity / clip-path（圆环例外：沿弧长 dasharray，一次性、个位数个小 SVG）；没有常驻循环。
//   - 只给视口里的元素播，且每类封顶 maxAnimated 个（perf）：服务器页有上百根计量条，全播时每根都要升成
//     合成层，启动那一帧的分层（Layerize）实测 600ms+；视口外的看不见，直接显示终态。
//   - 系统减弱动画 = 全部不播；窗口隐藏（省电闸）= 不播。动画期间可点击、可悬停，悬停读的是真值。
//   - 切换范围（24 小时 → 7 天 等）：图表 200ms 淡入，不重画入场。
//   - 时长从严（v2.82）：最长一项连错峰也在 0.75 秒内到位——内容已经画好了，入场拖到一秒多会被读成「还在加载」。
// 用 Web Animations API（element.animate）驱动、fill 不保留：动画结束后元素回到自己的样式，
// 不和渲染器写的 transform / style 打架。依赖全部可注入，Node 可测。

import { invalidateMorphCache } from "./dom-utils.js";

const EASE_OUT = "cubic-bezier(0.22, 0.8, 0.24, 1)";

// 入场规格：选择器 → 关键帧 + 时长 + 错峰。测试据此检查只动允许的属性。
export const ENTRANCE = Object.freeze([
  // 折线 / 面积 / 在线条：从左向右揭开，像被画出来
  { name: "reveal", selector: ".res-spark svg, .res-gpu-trend svg, .cu-resp svg, .cu-bar, .us-chart svg, .us-split svg, .sa-split-tall",
    keyframes: () => [{ clipPath: "inset(0 100% 0 0)", opacity: 0.4 }, { clipPath: "inset(0 0% 0 0)", opacity: 1 }],
    duration: 450, delay: 0, step: 35, maxSteps: 6, maxAnimated: 12 },
  // 计量条 / 进度条：从起点长出（终点取元素当前的 transform）。横条（渲染器用 scaleX）从左长，
  // 竖条（概览服务器卡的 GPU 柱，scaleY）从底长——按元素的布局宽高判断朝向，不看 transform（满条时两者一样）。
  { name: "grow", selector: ".res-meter-fill, .res-tile-meter-fill, .bar-progress, .cl-slot-fill, .us-context-fill, .us-seg, .sa-meter-fill, .sa-cold-fill, .sa-rbar-fill",
    keyframes: (end, vertical = false) => (vertical
      ? [{ transform: "scaleY(0)", transformOrigin: "center bottom" }, { transform: end, transformOrigin: "center bottom" }]
      : [{ transform: "scaleX(0)", transformOrigin: "left center" }, { transform: end, transformOrigin: "left center" }]),
    duration: 400, delay: 60, step: 12, maxSteps: 12, maxAnimated: 24 },
  // 圆环：沿弧长画出（pathLength=100 的 dasharray）
  { name: "arc", selector: ".cl-ring-outer, .cl-ring-inner",
    keyframes: (end) => [{ strokeDasharray: "0 100" }, { strokeDasharray: end }],
    duration: 450, delay: 60, step: 20, maxSteps: 12, maxAnimated: 12 },
  // 日历格 / 柱：按位置依次浮现
  { name: "rise", selector: ".us-days > *",
    keyframes: () => [{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }],
    duration: 240, delay: 40, step: 6, maxSteps: 40, maxAnimated: 70, fill: "backwards" },
  // 存储管理的卡片与树图块：淡入并轻微上浮 / 放大，按位置错峰（块多时封顶，视口外直接终态）
  { name: "pop", selector: ".sa-kpi, .sa-tm-tile",
    keyframes: () => [{ opacity: 0, transform: "translateY(4px) scale(0.985)" }, { opacity: 1, transform: "none" }],
    duration: 300, delay: 30, step: 18, maxSteps: 20, maxAnimated: 48, fill: "backwards" },
]);
// 大数字：从 0 数到当前值
export const COUNT_SELECTOR = ".res-tile-value, .cl-kpi-value, .us-figure > span:first-child, .bf-value, .sa-hero-value";
export const COUNT_MS = 420;
export const CROSSFADE_MS = 200;
// 切换范围 / 日期的控件 → 淡入它所在面板里的图
const RANGE_CONTROLS = "[data-res-range], [data-usage-range], [data-stability-window], [data-usage-trend], [data-brief-day]";
const CROSSFADE_TARGETS = ".res-spark svg, .cu-track, .us-chart, .us-split, .us-days, .bf-body";

// 纯函数：「12.5%」「1,316」「3.18」→ { prefix, value, decimals, grouped, suffix }；没有数字返回 null。
export function parseFigure(text) {
  const m = /^(\s*)([\d,]*\.?\d+)(.*)$/s.exec(String(text ?? ""));
  if (!m) return null;
  const raw = m[2];
  const value = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return { prefix: m[1], value, decimals: (raw.split(".")[1] || "").length, grouped: raw.includes(","), suffix: m[3] };
}

export function formatFigure(fig, v) {
  const s = v.toFixed(fig.decimals);
  let body = s;
  if (fig.grouped) {
    const dot = s.indexOf(".");
    const intPart = (dot >= 0 ? s.slice(0, dot) : s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    body = dot >= 0 ? `${intPart}${s.slice(dot)}` : intPart;
  }
  return `${fig.prefix}${body}${fig.suffix}`;
}

export function createMotion({
  doc,
  matchMedia = typeof window !== "undefined" && typeof window.matchMedia === "function" ? (q) => window.matchMedia(q) : null,
  raf = (fn) => requestAnimationFrame(fn),
  now = () => performance.now(),
  getStyle = (el) => getComputedStyle(el),
  // 元素是否落在视口里（含上下各半屏余量）；量不了的一律当作在视口里。
  inView = (el) => {
    if (typeof el.getBoundingClientRect !== "function" || typeof window === "undefined") return true;
    const r = el.getBoundingClientRect();
    const margin = window.innerHeight / 2;
    return r.bottom >= -margin && r.top <= window.innerHeight + margin && (r.width > 0 || r.height > 0);
  },
}) {
  const played = new WeakSet();
  const allowed = () => !matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    && !doc.hidden && !doc.body?.hasAttribute?.("data-console-hidden");

  function countUp(el) {
    const node = [...(el.childNodes || [])].find((n) => n.nodeType === 3 && /\d/.test(n.data));
    if (!node) return false;
    const fig = parseFigure(node.data);
    if (!fig || fig.value === 0) return false;
    const original = node.data;
    const t0 = now();
    let last = formatFigure(fig, 0);
    node.data = last;
    invalidateMorphCache(el);
    const step = () => {
      if (node.data !== last) return; // 数到一半被真实数据改写：立即让位
      const p = Math.min(1, (now() - t0) / COUNT_MS);
      const next = p < 1 ? formatFigure(fig, fig.value * (1 - (1 - p) ** 3)) : original;
      if (next !== last) {
        last = next;
        node.data = next;
      }
      if (p < 1) raf(step);
    };
    raf(step);
    return true;
  }

  function collectEntrance(root, { force = false }, toAnimate, countEls) {
    if (!root || (!force && played.has(root))) return false;
    played.add(root);
    for (const spec of ENTRANCE) {
      let i = 0;
      for (const el of root.querySelectorAll(spec.selector)) {
        if (i >= spec.maxAnimated) break;
        if (typeof el.animate !== "function" || !inView(el)) continue;
        let end = null;
        let vertical = false;
        if (spec.name === "grow") {
          const t = getStyle(el).transform;
          end = t && t !== "none" ? t : "none";
          vertical = (el.offsetHeight || 0) > (el.offsetWidth || 0);
        } else if (spec.name === "arc") {
          end = el.style?.strokeDasharray || getStyle(el).strokeDasharray;
          if (!end || end === "none") continue;
        }
        toAnimate.push({
          el,
          keyframes: spec.keyframes(end, vertical),
          options: {
            duration: spec.duration,
            delay: spec.delay + Math.min(i, spec.maxSteps) * spec.step,
            easing: EASE_OUT,
            fill: spec.fill || "none",
          },
        });
        i += 1;
      }
    }
    for (const el of root.querySelectorAll(COUNT_SELECTOR)) countEls.push(el);
    return true;
  }

  function flushEntrance(toAnimate, countEls) {
    for (const item of toAnimate) item.el.animate(item.keyframes, item.options);
    for (const el of countEls) countUp(el);
  }

  // 同一轮里就绪的几块一起播：先把所有块的几何与样式都读完，再统一启动动画（逐块「读 → 写」会让每块都强制重排一次）。
  function playEntrances(roots) {
    if (!allowed()) return 0;
    const toAnimate = [];
    const countEls = [];
    let count = 0;
    for (const root of roots) if (collectEntrance(root, { force: false }, toAnimate, countEls)) count += 1;
    flushEntrance(toAnimate, countEls);
    return count;
  }

  // root 里的图表与数字播一次入场。force：设计稿 / 测试用的重放。
  function playEntrance(root, { force = false } = {}) {
    if (!root || (!force && played.has(root))) return false;
    if (!allowed()) return false;
    const toAnimate = [];
    const countEls = [];
    collectEntrance(root, { force }, toAnimate, countEls);
    flushEntrance(toAnimate, countEls);
    return true;
  }

  // 第一次进入某页：页里已就绪（不在骨架中）的块补播入场。先批量纯读收集所有面板的几何与样式，再统一启动动画，避免跨面板强制重排。
  function playView(section) {
    if (!section || !allowed()) return;
    const toAnimate = [];
    const countEls = [];
    for (const root of section.querySelectorAll(".panel, .us-metrics")) {
      if (root.dataset?.skeleton === "loading") continue;
      if (root.parentElement?.closest?.(".panel")) continue; // 只认最外层面板
      collectEntrance(root, { force: false }, toAnimate, countEls);
    }
    flushEntrance(toAnimate, countEls);
  }

  // 切换范围 / 日期：等渲染器画完新图（两帧）后淡入，不重播入场。
  function bindCrossfade(root = doc) {
    root.addEventListener("click", (e) => {
      const control = e.target.closest?.(RANGE_CONTROLS);
      const scope = control?.closest?.(".panel, .us-view");
      if (!scope || !allowed()) return;
      raf(() => raf(() => {
        for (const el of scope.querySelectorAll(CROSSFADE_TARGETS)) {
          if (typeof el.animate === "function") el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: CROSSFADE_MS, easing: "ease" });
        }
      }));
    });
  }

  return { playEntrance, playEntrances, playView, bindCrossfade, countUp, hasPlayed: (root) => played.has(root) };
}
