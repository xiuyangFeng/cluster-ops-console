// team-galaxy.js —— 「团队管理」页顶部的团队星图（主控）。
// 分层：背景 canvas（team-galaxy-backdrop.js，一次画好）→ 连线、闪烁星与天象 canvas
//（team-galaxy-fx.js）→ 轨道 / 恒星 / 行星 SVG（本文件，与连线逐帧同步）→ HUD / 图例 / 信息卡 / 读数带（HTML）。
// 流畅或静止（render/engagement.js）：人在用（窗口在前台、最近有操作）时满帧（封顶约 60fps）；不在用时公转平滑减速、停稳后
// 整个循环停在这一帧。页面不可见、星图滚出视口、窗口隐藏（body[data-console-hidden]）、用户手动暂停或系统要求减弱动效时同样停掉；
// 行星、卫星与连线在同一帧同步更新 transform（消除跨帧跳步与连线脱节），信息卡宽高在展开时测量缓存（零每帧强制同步回流），
// 视差由单元素 translate3d 指数阻尼驱动（不触发整棵子树 CSS 变量重算）；持续掉帧 3 秒自动降级特效。
// 数据刷新时只有结构签名变了才重建；同一批人留在原位，有人换轨道就平滑飘过去。
import { buildPlanetTipHtml } from "./team-admin-view.js";
import {
  assignOrbits,
  buildConstellations,
  evenPhases,
  galaxySignature,
  hueIndexOf,
  maxTodayTokens,
  memberTone,
  ORBIT_NAMES,
  orbitGeometry,
  PLANET_HUES,
  planetRadius,
  relatedUsers,
  strHash,
} from "./team-galaxy-model.js";
import { engagementOf, SMOOTH_FRAME_MS } from "./engagement.js";
import { drawDeepSky, drawPaperChart, makeTwinkles } from "./team-galaxy-backdrop.js";
import { configCtrl, createGalaxyFx, hexToRgb } from "./team-galaxy-fx.js";

const NS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const STAR_R = 15;
const PARALLAX_PAD = 14;
// 行星名字标签的字号跟随远近缩放的档位数（每 1/50 一档 = 字号变化 2%，约 0.2px，看不出跳变）
const LABEL_SCALE_STEPS = 50;
const ORBIT_BASE = [-0.35, 0.9, 2.2];
const LAYERS = ["tunnel", "node", "config"];
const HIDDEN_LAYERS_KEY = "team-galaxy-hidden-layers";
const PAUSED_STORAGE_KEY = "team-galaxy-paused";

const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
const easeOutBack = (k) => 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2;

// 星图循环是否允许持续运行（纯函数，Node 可测）：系统减弱动效 / 手动暂停 / 页面不可见 /
// 窗口隐藏时一律不跑 rAF，只留 rebuild() 画好的那一帧静态画面。
export function galaxyMotionAllowed({
  active = false,
  inView = false,
  reduced = false,
  userPaused = false,
  hidden = false,
  consoleHidden = false,
  hasGeometry = false,
} = {}) {
  return Boolean(hasGeometry && active && inView && !reduced && !userPaused && !hidden && !consoleHidden);
}

function wave(key) {
  const h = strHash(key);
  return { omega: TAU / (4.2 + (h % 9) * 0.45), ph: (h % 628) / 100 };
}

const NOOP = {
  update() {},
  setActive() {},
  setFocus() {},
  setPaused() {},
  isPaused: () => false,
  relayout() {},
  destroy() {},
  stats: () => null,
};

export function createTeamGalaxy({
  root,
  onPlanetClick = () => {},
  onFocusChange = () => {},
  storage = typeof localStorage !== "undefined" ? localStorage : null,
  now = () => Date.now(),
} = {}) {
  const doc = root?.ownerDocument;
  const win = doc?.defaultView;
  if (!root || !win || typeof win.requestAnimationFrame !== "function") return NOOP;

  const els = {
    backdrop: root.querySelector(".tm-sky-backdrop"),
    links: root.querySelector(".tm-sky-links"),
    svg: root.querySelector(".tm-sky-svg"),
    tip: root.querySelector(".tm-sky-tip"),
  };
  if (!els.backdrop || !els.links || !els.svg) return NOOP;

  const fx = createGalaxyFx({ doc });
  const engagement = engagementOf(win, doc);
  // 数据刷新时有人换轨道 / 新来浮现：即使没人在用，也把这段过渡跑完再停（不然新行星停在透明的第一帧）
  const clock = () => win.performance?.now?.() ?? Date.now();
  let settleUntil = 0;
  const settling = () => clock() < settleUntil;
  const reduceMq = typeof win.matchMedia === "function" ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const themeOf = () => (doc.body?.getAttribute("data-theme") === "light" ? "light" : "dark");

  let members = [];
  let matches = () => true;
  let W = 0;
  let H = 0;
  let geo = null;
  let theme = themeOf();
  let builtFor = "";
  let signature = null;
  let firstBuild = true;
  const planets = new Map();
  let lines = [];
  let groups = { node: [], config: [] };
  let allGroups = []; // groups.node + groups.config，建图时拼一次（place 每帧要用）
  let orbitEls = [];
  let corona = null;
  let gFront = null;
  let focus = null;
  let focusFrom = null;
  let focusT0 = 0;
  let focusLines = new Set();
  let layerFocus = null;
  const hidden = new Set(readHiddenLayers());
  let userPaused = readPausedState();
  let active = false;
  let inView = true;
  let reduced = Boolean(reduceMq?.matches);
  const sim = { t: 0, real: 0, scale: 1, target: 1, last: 0, raf: 0, running: false, frame: 0 };
  const quality = { level: 2, ema: 24, slowSince: 0 };
  const scene = { W: 0, H: 0, cx: 0, cy: 0, starR: STAR_R, theme, planets, lines, focus: null, focusT0: 0, focusLines, hidden, layerFocus: null, quality: 2, reduced, twinkles: [], parX: 0, parY: 0 };
  const parallax = { x: 0, y: 0 };
  const tipSize = { w: 248, h: 148 };
  let lastBackdropX = -999;
  let lastBackdropY = -999;

  function readHiddenLayers() {
    try {
      const raw = JSON.parse(storage?.getItem?.(HIDDEN_LAYERS_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter((k) => LAYERS.includes(k)) : [];
    } catch {
      return [];
    }
  }
  function saveHiddenLayers() {
    try {
      storage?.setItem?.(HIDDEN_LAYERS_KEY, JSON.stringify([...hidden]));
    } catch {}
  }
  function readPausedState() {
    try {
      return storage?.getItem?.(PAUSED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }
  function savePausedState() {
    try {
      if (userPaused) storage?.setItem?.(PAUSED_STORAGE_KEY, "1");
      else storage?.removeItem?.(PAUSED_STORAGE_KEY);
    } catch {}
  }
  function syncMotionToggleUi() {
    const btn = root.querySelector?.("[data-tm-toggle-motion]");
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(userPaused));
    btn.title = userPaused ? "恢复星轨与彗星动态效果" : "暂停星轨公转与彗星动画（定格观察星座拓扑）";
    const label = btn.querySelector?.("[data-tm-motion-label]") || btn;
    const text = userPaused ? "▶ 恢复星轨" : "⏸ 暂停星轨";
    if (label.textContent !== text) label.textContent = text;
  }

  const S = (tag, attrs, parent) => {
    const e = doc.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };

  /* —— 尺寸、背景与整体重建 —— */

  // 尺寸只从 ResizeObserver 拿（布局之后、绘制之前回调）：不在点击 / 激活时调 getBoundingClientRect——
  // 那会逼浏览器当场给整个刚显示出来的团队页做一次同步布局（v2.70 实测切页时单这一下 ~30ms），
  // 随后名单写入又要再布局一遍。
  const size = { w: 0, h: 0 };
  function layout({ force = false } = {}) {
    const w = size.w;
    const h = size.h;
    if (w < 40 || h < 40) return false; // 视图隐藏时量不到，等可见再画
    theme = themeOf();
    const key = `${w}x${h}:${theme}`;
    if (!force && key === builtFor) return true;
    builtFor = key;
    W = w;
    H = h;
    geo = orbitGeometry(W, H, { paper: theme === "light" });
    drawBackdrop();
    scene.twinkles = makeTwinkles(W, theme);
    fx.resize(els.links, W, H);
    rebuild();
    return true;
  }

  function drawBackdrop() {
    const c = els.backdrop;
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    const pad = theme === "light" ? 0 : PARALLAX_PAD; // 纸面不做视差：图框要钉在纸上（余量写在 team-admin.css）
    c.width = Math.round((W + pad * 2) * dpr);
    c.height = Math.round((H + pad * 2) * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (theme === "light") drawPaperChart(ctx, W, H, geo.cx, geo.cy);
    else drawDeepSky(ctx, W + pad * 2, H + pad * 2, geo.cx + pad, geo.cy + pad);
  }

  function buildSvgFrame() {
    const svg = els.svg;
    svg.textContent = "";
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const pal = PLANET_HUES[theme];
    const defs = S("defs", null, svg);
    const rg = (id, stops, extra) => {
      const g = S("radialGradient", { id, ...(extra || {}) }, defs);
      for (const [o, c, a] of stops) S("stop", { offset: o, "stop-color": c, "stop-opacity": a ?? 1 }, g);
    };
    rg("tmStarCore", [[0, "var(--tm-star-c0)"], [0.45, "var(--tm-star-c1)"], [0.8, "var(--tm-star-c2)"], [1, "var(--tm-star-c3)"]]);
    rg("tmStarCorona", [[0, "#ffe2aa", 0.55], [0.16, "#ffcc80", 0.22], [0.45, "#ffaa5a", 0.06], [1, "#ffaa5a", 0]]);
    for (const [id, x2, y2, a] of [["tmFlareH", 1, 0, 0.8], ["tmFlareV", 0, 1, 0.6]]) {
      const lf = S("linearGradient", { id, x1: 0, y1: 0, x2, y2 }, defs);
      S("stop", { offset: 0, "stop-color": "#fff1d6", "stop-opacity": 0 }, lf);
      S("stop", { offset: 0.5, "stop-color": "#fff1d6", "stop-opacity": a }, lf);
      S("stop", { offset: 1, "stop-color": "#fff1d6", "stop-opacity": 0 }, lf);
    }
    pal.forEach(([hi, base, lo], i) => {
      rg(`tmBody${i}`, [[0, hi], [0.5, base], [1, lo]], { cx: "0.36", cy: "0.32", r: "0.78", fx: "0.32", fy: "0.28" });
      rg(`tmGlow${i}`, [[0, base, 0.42], [0.42, base, 0.12], [1, base, 0]]);
    });
    // 受光：明暗交界（渐变焦点与本体高光同在 -129°，整组朝恒星旋转）
    rg("tmShade", [[0, "#02040e", 0], [0.42, "#02040e", 0], [1, "#02040e", 0.66]], { cx: "0.32", cy: "0.28", r: "0.95" });
    const pat = S("pattern", { id: "tmHatch", width: 2.6, height: 2.6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(40)" }, defs);
    S("line", { x1: 0, y1: 0, x2: 0, y2: 2.6, stroke: "#2a2620", "stroke-width": 0.55 }, pat);

    const { cx, cy } = geo;
    const gOrbit = S("g", { class: "tm-orbits" }, svg);
    orbitEls = geo.orbits.map((o, i) => {
      const el = S("ellipse", { class: `tm-orbit${i === 2 ? " is-outer" : ""}`, cx, cy, rx: o.rx, ry: o.ry }, gOrbit);
      S("text", { class: "tm-orbit-label", x: cx + o.rx + 8, y: cy + 3.5 }, gOrbit).textContent = ORBIT_NAMES[i];
      return el;
    });
    const labels = S("g", { class: "tm-sky-labels" }, svg);
    const star = S("g", { class: "tm-star", transform: `translate(${cx},${cy})` }, svg);
    corona = S("circle", { class: "tm-star-corona", r: 86 }, star);
    S("rect", { class: "tm-star-flare", x: -74, y: -0.6, width: 148, height: 1.2, fill: "url(#tmFlareH)" }, star);
    S("rect", { class: "tm-star-flare", x: -0.6, y: -40, width: 1.2, height: 80, fill: "url(#tmFlareV)" }, star);
    const rays = S("g", { class: "tm-star-rays" }, star);
    for (let k = 0; k < 32; k += 1) {
      const t = (k / 32) * TAU;
      const r0 = STAR_R + 4;
      const r1 = r0 + (k % 2 ? 6 : 13);
      S("line", { x1: Math.cos(t) * r0, y1: Math.sin(t) * r0, x2: Math.cos(t) * r1, y2: Math.sin(t) * r1 }, rays);
    }
    S("circle", { class: "tm-star-halo", r: STAR_R + 6 }, star);
    S("circle", { class: "tm-star-core", r: STAR_R }, star);
    S("circle", { class: "tm-star-engrave", r: STAR_R, "stroke-width": 1 }, star);
    S("circle", { class: "tm-star-engrave", r: STAR_R - 5, "stroke-width": 0.5 }, star);
    const label = S("text", { class: "tm-star-label", y: STAR_R + 22 }, star);
    label.textContent = root.dataset.clusterName || "集群";
    gFront = S("g", null, svg);
    return labels;
  }

  function rebuild() {
    if (!geo) return;
    const prev = new Map();
    for (const [user, p] of planets) prev.set(user, { x: p.x, y: p.y, oi: p.oi, phase: p.phase, slot: p.slotKey });
    const labelsG = buildSvgFrame();
    planets.clear();
    lines = [];
    scene.lines = lines;

    const crowded = members.length > 24;
    const crowdedOuter = members.filter((m) => m.onlineState !== "tunnel-online" && m.onlineState !== "ssh-only").length > 10;
    const maxTok = maxTodayTokens(members);
    const orbits = assignOrbits(members);
    const pal = PLANET_HUES[theme];
    let order = 0;
    orbits.forEach((list, oi) => {
      const slotKey = list.map((m) => m.user).join(",");
      const phases = evenPhases(list.length, ORBIT_BASE[oi]);
      list.forEach((m, j) => {
        const old = prev.get(m.user);
        // 同一轨道、同一批人：沿用原相位（数据刷新、换主题、改窗宽都不跳）
        const phase = old && old.oi === oi && old.slot === slotKey ? old.phase : phases[j];
        const p = buildPlanet(m, oi, phase, maxTok, crowded, crowdedOuter && oi === 2, pal);
        p.slotKey = slotKey;
        if (!reduced && !userPaused) {
          // 换了轨道或同轨道人数变了：从原位置平滑飘到新槽位；新来的浮现；第一次点亮时逐颗浮现
          if (old && (old.oi !== oi || old.slot !== slotKey)) p.tw = { t0: sim.real, dur: 1.2, x: old.x, y: old.y };
          else if (!old) {
            p.appear = sim.real + (firstBuild ? order * 0.032 : 0);
            if (p.appear > sim.real) p.g.style.opacity = "0";
          }
        }
        if (p.tw || p.appear != null) settleUntil = clock() + 1600;
        order += 1;
        planets.set(m.user, p);
      });
    });
    firstBuild = false;
    buildLines(labelsG);
    applyFilter({ redraw: false });
    updateLegendCounts();
    syncMotionToggleUi();
    place(true);
    fx.draw(syncScene(0), 0, sim.real);
    if (focus) {
      const f = focus;
      const from = focusFrom;
      focus = null;
      setFocus(planets.has(f) ? f : null, from);
    }
  }

  function buildPlanet(m, oi, phase, maxTok, crowded, labelHidden, pal) {
    const r = planetRadius(m, maxTok, crowded);
    const hi = hueIndexOf(m.user);
    const tone = memberTone(m);
    const g = S("g", { class: `tm-planet${oi === 2 ? " is-offline" : ""}${labelHidden ? " is-label-hidden" : ""}`, "data-user": m.user });
    // 位移写在 g 上，远近缩放写在 body 上，名字标签不进缩放组（perf）：SVG 文字的字号跟着祖先的缩放走，
    // 缩放逐帧在变时每个标签每帧都要重新排版、重新塑形。标签另按 LABEL_SCALE_STEPS 档位跟随缩放（见 place）。
    const body = S("g", { class: "tm-pl-body" }, g);
    S("circle", { class: "tm-pl-glow", r: r * 2.6, fill: `url(#tmGlow${hi})` }, body);
    if (m.isSelf) S("ellipse", { class: "tm-pl-selfring", rx: r * 1.95, ry: r * 0.52, transform: "rotate(-16)" }, body);
    const attn = tone ? S("circle", { class: `tm-pl-attn is-${tone}`, r: r + 4.2 }, body) : null;
    // 「需关注」环的呼吸写在各环自己的 style 上：写在整张 SVG 的 CSS 变量上会让整棵星图逐帧重算样式
    if (attn && sim.attnOp != null) attn.style.opacity = sim.attnOp;
    const core = S("g", { class: "tm-pl-core" }, body);
    S("circle", { r, fill: `url(#tmBody${hi})` }, core);
    S("circle", { class: "tm-pl-shade", r, fill: "url(#tmShade)" }, core);
    const a0 = -Math.PI / 4;
    const a1 = a0 + Math.PI;
    S("path", {
      class: "tm-pl-hatch",
      d: `M${Math.cos(a0) * r},${Math.sin(a0) * r} A${r},${r} 0 0 1 ${Math.cos(a1) * r},${Math.sin(a1) * r} A${r * 0.42},${r} -45 0 0 ${Math.cos(a0) * r},${Math.sin(a0) * r}Z`,
      fill: "url(#tmHatch)",
    }, core);
    S("circle", { class: "tm-pl-stroke", r }, core);
    const moons = [];
    const moonOps = [];
    for (let k = 0; k < Math.min(8, Number(m.compute?.gpuCount) || 0); k += 1) {
      moons.push(S("circle", { class: "tm-pl-moon", r: 1.55 }, body));
      moonOps.push(-1);
    }
    // 点击 / 悬停热区跟着缩放；它是透明的，放在标签下面不影响绘制，事件照样冒泡到 g
    S("circle", { class: "tm-pl-hit", r: Math.max(r + 9, 15) }, body);
    const labelG = S("g", { class: "tm-pl-labelpos" }, g);
    const label = S("text", { class: "tm-pl-label", y: r + 14 }, labelG);
    label.textContent = m.displayName && m.displayName !== m.user ? m.displayName : m.user;
    if (m.isSelf) S("tspan", { class: "tm-pl-self", dx: 4 }, label).textContent = "我";
    g.addEventListener("pointerenter", () => setFocus(m.user, "sky"));
    g.addEventListener("pointerleave", (e) => {
      if (focusFrom !== "sky" || focus !== m.user) return;
      // 重建时浏览器可能补发一次"离开"：指针其实还在行星上就不算
      const p = planets.get(m.user);
      const rect = root.getBoundingClientRect();
      if (p && Number.isFinite(e.clientX) && Math.hypot(e.clientX - rect.left - p.x, e.clientY - rect.top - p.y) <= Math.max(p.r + 9, 15) * p.s) return;
      setFocus(null, "sky");
    });
    g.addEventListener("click", () => onPlanetClick(m.user));
    gFront.appendChild(g);
    return {
      m, g, body, labelG, core, attn, moons, moonOps, oi, phase, r,
      hue: hexToRgb(pal[hi][1]),
      moonSpeed: 0.55 + (hi % 4) * 0.12,
      x: 0, y: 0, domX: -999, domY: -999, domS: -1, domLabelY: "", domLabelS: -1, domRot: -999, s: 1, links: [], tw: null, appear: null,
    };
  }

  function buildLines(labelsG) {
    for (const p of planets.values()) {
      if (p.oi === 0) {
        const calls = Number(p.m.usage?.todayCalls) || 0;
        const rate = 0.22 + Math.log10(1 + calls) * 0.38; // 每秒发出的彗星数：调用越多越密
        const L = { kind: "tunnel", a: p, parts: [], acc: 0, rate, muted: false, ...wave(`t${p.m.user}`) };
        const n0 = Math.round(rate * 3);
        for (let k = 0; k < n0; k += 1) L.parts.push({ s: (k + 0.3) / n0, v: 0.8 + (strHash(p.m.user + k) % 40) / 100 });
        lines.push(L);
        p.links.push(L);
      } else if (p.oi === 1) {
        const L = { kind: "ssh", a: p, muted: false, ...wave(`s${p.m.user}`) };
        lines.push(L);
        p.links.push(L);
      }
    }
    groups = buildConstellations(members);
    allGroups = groups.node.concat(groups.config);
    const angleOf = (u) => {
      const p = planets.get(u);
      return (((p.phase + geo.orbits[p.oi].speed * sim.t) % TAU) + TAU) % TAU;
    };
    for (const grp of allGroups) {
      grp.users = grp.users.filter((u) => planets.has(u)).sort((a, b) => angleOf(a) - angleOf(b)); // 绕恒星连成环状星座
      grp.segs = [];
      for (let i = 0; i < grp.users.length - 1; i += 1) {
        const a = planets.get(grp.users[i]);
        const b = planets.get(grp.users[i + 1]);
        const key = `${grp.kind}${grp.key}${i}`;
        const h = strHash(key);
        const L = { kind: grp.kind, a, b, grp, idx: i, muted: false, off: (h % 1000) / 160, period: 4.4 + (h % 7) * 0.4, ...wave(key) };
        lines.push(L);
        a.links.push(L);
        b.links.push(L);
        grp.segs.push(L);
      }
      const lab = S("text", { class: `tm-ln-label is-${grp.kind}`, "text-anchor": "middle" }, labelsG);
      lab.textContent = grp.label;
      lab.style.display = hidden.has(grp.kind) ? "none" : "";
      grp.labelEl = lab;
      grp.lx = "";
      grp.ly = "";
    }
  }

  /* —— 每帧摆位（行星、GPU 卫星与 Canvas 连线在同一帧 100% 同步更新 transform，彻底消除跳帧与端点撕裂） —— */

  function place(force) {
    if (!geo) return;
    const { cx, cy } = geo;
    const motionOff = reduced || userPaused;
    let anyTween = false;
    for (const p of planets.values()) {
      const waitingAppear = p.appear != null && sim.real < p.appear;
      if (waitingAppear && !force) {
        anyTween = true;
        continue;
      }
      const o = geo.orbits[p.oi];
      const th = p.phase + o.speed * sim.t;
      const sn = Math.sin(th);
      let x = cx + o.rx * Math.cos(th);
      let y = cy + o.ry * sn;
      let s = 0.84 + 0.24 * ((sn + 1) / 2);
      let op = null;
      let pTween = false;
      if (p.tw) {
        const k = (sim.real - p.tw.t0) / p.tw.dur;
        if (k >= 1 || motionOff) p.tw = null;
        else {
          pTween = true;
          const e = easeInOut(Math.max(0, k));
          x = p.tw.x + (x - p.tw.x) * e;
          y = p.tw.y + (y - p.tw.y) * e;
        }
      }
      if (p.appear != null) {
        const k = (sim.real - p.appear) / 0.65;
        if (k >= 1 || motionOff) {
          p.appear = null;
          op = "";
          pTween = true;
        } else if (k >= 0) {
          pTween = true;
          s *= 0.25 + 0.75 * easeOutBack(k);
          op = k.toFixed(2);
        } else {
          s *= 0.25;
          op = "0";
        }
      }
      p.x = x;
      p.y = y;
      p.s = s;
      if (pTween) anyTween = true;

      if (force || pTween || Math.abs(x - p.domX) >= 0.004 || Math.abs(y - p.domY) >= 0.004) {
        p.domX = x;
        p.domY = y;
        p.g.setAttribute("transform", `translate(${x.toFixed(2)},${y.toFixed(2)})`);
      }
      if (force || pTween || Math.abs(s - p.domS) >= 0.0005) {
        p.domS = s;
        p.body.setAttribute("transform", `scale(${s.toFixed(3)})`);
        // 标签：位置精确跟着缩放（基线仍在 (r+14)·s），字号按档位跟——档位变了才重排文字
        const ls = Math.round(s * LABEL_SCALE_STEPS) / LABEL_SCALE_STEPS;
        const ly = ((p.r + 14) * (s - ls)).toFixed(2);
        if (force || ls !== p.domLabelS || ly !== p.domLabelY) {
          p.domLabelS = ls;
          p.domLabelY = ly;
          p.labelG.setAttribute("transform", `translate(0,${ly}) scale(${ls})`);
        }
      }
      const rot = Math.atan2(cy - y, cx - x) * 57.2958 + 129;
      if (force || Math.abs(rot - p.domRot) >= 0.2) {
        p.domRot = rot;
        p.core.setAttribute("transform", `rotate(${rot.toFixed(1)})`);
      }
      if (op !== null) p.g.style.opacity = op;

      if (p.moons.length) {
        const nm = p.moons.length;
        for (let k = 0; k < nm; k += 1) {
          const ph = sim.real * p.moonSpeed + (k / nm) * TAU;
          const mr = p.r + 5.2 + (k % 2) * 2.2;
          const cosP = Math.cos(ph);
          const sinP = Math.sin(ph);
          const mx = mr * cosP;
          const my = mr * 0.36 * sinP - mr * 0.12 * cosP;
          const moon = p.moons[k];
          moon.setAttribute("transform", `translate(${mx.toFixed(2)},${my.toFixed(2)})`);
          // 卫星绕到行星背面时按遮挡边缘平滑过渡，避免瞬时切 0 造成视觉闪烁
          let nextOp = 1;
          if (sinP < 0) {
            const absMx = Math.abs(mx);
            const innerR = p.r * 0.78;
            const outerR = p.r * 1.08;
            if (absMx <= innerR) nextOp = 0;
            else if (absMx < outerR) nextOp = Number((((absMx - innerR) / (outerR - innerR)) * 0.58).toFixed(2));
            else nextOp = 0.58;
          }
          if (p.moonOps[k] !== nextOp) {
            p.moonOps[k] = nextOp;
            moon.setAttribute("opacity", nextOp);
          }
        }
      }
    }

    if (!motionOff) {
      const b = 0.5 + 0.5 * Math.sin((sim.real / 7) * TAU); // 恒星光晕 7 秒一呼吸
      if (theme !== "light") {
        const cs = (1 + 0.07 * b).toFixed(3);
        if (sim.coronaScale !== cs) {
          sim.coronaScale = cs;
          corona?.setAttribute("transform", `scale(${cs})`);
        }
      }
      const co = (0.9 + 0.1 * b).toFixed(2);
      if (sim.coronaOp !== co) {
        sim.coronaOp = co;
        corona?.setAttribute("opacity", co);
      }
      const pa = (0.35 + 0.65 * (0.5 + 0.5 * Math.sin((sim.real / 2.6) * TAU))).toFixed(2); // 需关注环 2.6 秒一脉动
      if (sim.attnOp !== pa) {
        sim.attnOp = pa;
        for (const q of planets.values()) if (q.attn) q.attn.style.opacity = pa;
      }
    }

    for (const grp of allGroups) {
      const s0 = grp.segs?.[0];
      if (!s0 || !grp.labelEl) continue;
      let x;
      let y;
      if (grp.kind === "config") {
        const [qx, qy] = configCtrl(geo, s0);
        x = 0.25 * s0.a.x + 0.5 * qx + 0.25 * s0.b.x;
        y = 0.25 * s0.a.y + 0.5 * qy + 0.25 * s0.b.y;
      } else {
        x = (s0.a.x + s0.b.x) / 2;
        y = (s0.a.y + s0.b.y) / 2;
      }
      const od = Math.hypot(x - cx, y - cy) || 1;
      const lx = (x + ((x - cx) / od) * 12).toFixed(1);
      const ly = (y + ((y - cy) / od) * 12 + 3).toFixed(1);
      if (grp.lx !== lx || grp.ly !== ly) {
        grp.lx = lx;
        grp.ly = ly;
        grp.labelEl.setAttribute("transform", `translate(${lx},${ly})`);
      }
    }
    sim.anyTween = anyTween;
    if (focus) positionTip();
  }

  function syncScene(dt = 0) {
    scene.W = W;
    scene.H = H;
    scene.cx = geo?.cx || 0;
    scene.cy = geo?.cy || 0;
    scene.theme = theme;
    scene.focus = focus;
    scene.focusT0 = focusT0;
    scene.focusLines = focusLines;
    scene.layerFocus = layerFocus;
    scene.quality = quality.level;
    scene.reduced = reduced || userPaused;
    // 远景背景与近景闪烁星共用同一指数阻尼曲线追随指针视差，直接写 backdrop.style.transform（不触发整树 CSS 变量重算）
    const k = dt > 0 ? 1 - Math.exp(-dt * 8.5) : 0.16;
    scene.parX += (parallax.x - scene.parX) * k;
    scene.parY += (parallax.y - scene.parY) * k;
    if (Math.abs(parallax.x - scene.parX) < 0.01) scene.parX = parallax.x;
    if (Math.abs(parallax.y - scene.parY) < 0.01) scene.parY = parallax.y;
    if (
      theme !== "light" &&
      (Math.abs(scene.parX - lastBackdropX) >= 0.02 || Math.abs(scene.parY - lastBackdropY) >= 0.02)
    ) {
      lastBackdropX = scene.parX;
      lastBackdropY = scene.parY;
      els.backdrop.style.transform = `translate3d(${scene.parX.toFixed(2)}px, ${scene.parY.toFixed(2)}px, 0)`;
    }
    return scene;
  }

  /* —— 循环与省电 —— */

  function adaptQuality(elapsed, ts) {
    quality.ema += (elapsed - quality.ema) * 0.08;
    if (quality.ema > 58 && quality.level > 0) {
      if (!quality.slowSince) quality.slowSince = ts;
      else if (ts - quality.slowSince > 3000) {
        quality.level -= 1;
        quality.slowSince = 0;
        quality.ema = 28;
        root.dataset.quality = String(quality.level);
      }
    } else quality.slowSince = 0;
  }

  function tick(ts) {
    sim.raf = win.requestAnimationFrame(tick);
    if (!sim.last) sim.last = ts;
    const elapsed = ts - sim.last;
    const targetMs = SMOOTH_FRAME_MS;
    if (elapsed < targetMs) return;
    adaptQuality(elapsed, ts);
    const dt = Math.min(0.08, elapsed / 1000);
    // 对齐 VSync 节拍余数，避免 60Hz/120Hz 下因为 0.2ms 时间戳抖动发生偶发跳帧
    sim.last = ts - (elapsed % targetMs) * 0.25;
    const scaleStep = 1 - Math.exp(-dt * 7.5);
    const engaged = engagement.engaged();
    // 悬停时公转平滑停下；没人在用时同样减速到停，停稳后整个循环停在这一帧（再有操作时从这里平滑起步）
    sim.scale += ((engaged ? sim.target : 0) - sim.scale) * scaleStep;
    sim.t += dt * sim.scale;
    sim.real += dt;
    sim.frame += 1;
    place(false);
    fx.draw(syncScene(dt), dt, sim.real);
    if (!engaged && sim.scale < 0.01 && !sim.anyTween && !settling()) {
      sim.running = false;
      win.cancelAnimationFrame(sim.raf);
      root.dataset.motion = "still";
    }
  }

  function shouldRun() {
    return galaxyMotionAllowed({
      active,
      inView,
      reduced,
      userPaused,
      hidden: doc.hidden,
      consoleHidden: doc.body?.hasAttribute?.("data-console-hidden"),
      hasGeometry: Boolean(geo),
    });
  }
  function syncLoop() {
    const run = shouldRun();
    if (run && (engagement.engaged() || settling()) && !sim.running) {
      sim.running = true;
      sim.last = 0;
      sim.raf = win.requestAnimationFrame(tick);
    } else if (!run && sim.running) {
      sim.running = false;
      win.cancelAnimationFrame(sim.raf);
    }
    // 能跑但没人在用、循环还开着：交给 tick 减速到停稳再停。
    // 运行状态写在属性上：排查"动画是否真的停了"时在开发者工具里一眼可见（still = 没人在用、停在这一帧）
    const flag = sim.running ? "running" : run ? "still" : "paused";
    if (root.dataset.motion !== flag) root.dataset.motion = flag;
    // 减弱动效单独标出来：截图 / 冒烟不用去猜系统设置（reduce / no-preference）
    const reduceFlag = reduced ? "reduce" : "no-preference";
    if (root.dataset.reducedMotion !== reduceFlag) root.dataset.reducedMotion = reduceFlag;
  }
  function redraw() {
    if (sim.running || !geo) return;
    place(true);
    fx.draw(syncScene(0), 0, sim.real);
  }
  function setPaused(nextPaused) {
    const next = Boolean(nextPaused);
    if (next === userPaused) return userPaused;
    userPaused = next;
    savePausedState();
    syncMotionToggleUi();
    syncLoop();
    redraw();
    return userPaused;
  }

  /* —— 聚焦（星图 ↔ 名单双向） —— */

  function setFocus(user, from = "sky") {
    const next = user && planets.has(user) ? user : null;
    if (next === focus) {
      if (next) focusFrom = from;
      return;
    }
    focus = next;
    focusFrom = next ? from : null;
    for (const n of root.querySelectorAll(".is-focus")) n.classList.remove("is-focus");
    focusLines = new Set();
    if (!next) {
      root.classList.remove("is-focusing");
      sim.target = 1;
      hideTip();
      onFocusChange(null, from);
      redraw();
      return;
    }
    const p = planets.get(next);
    root.classList.add("is-focusing");
    sim.target = from === "sky" ? 0 : 0.25;
    focusT0 = sim.real;
    const related = relatedUsers(next, groups);
    for (const L of p.links) {
      if (L.grp) {
        for (const s of L.grp.segs) focusLines.add(s);
        L.grp.labelEl?.classList.add("is-focus");
      } else focusLines.add(L);
    }
    for (const u of related) planets.get(u)?.g.classList.add("is-focus");
    orbitEls[p.oi]?.classList.add("is-focus");
    showTip(p);
    onFocusChange(next, from);
    redraw();
  }

  function showTip(p) {
    if (!els.tip) return;
    els.tip.innerHTML = buildPlanetTipHtml(p.m, { now: now() });
    els.tip.classList.add("is-on");
    // 仅在内容更新时测量一次宽高并缓存，避免在每帧 place() 中读 offsetWidth/offsetHeight 触发强制同步回流
    tipSize.w = els.tip.offsetWidth || 248;
    tipSize.h = els.tip.offsetHeight || 148;
    positionTip();
  }
  function positionTip() {
    const p = planets.get(focus);
    if (!p || !els.tip) return;
    const w = tipSize.w;
    const h = tipSize.h;
    // 往远离恒星的一侧弹，不挡住中心；那一侧放不下再换边
    const right = p.x + p.r + 18;
    const left = p.x - p.r - 18 - w;
    let x = p.x >= (geo?.cx || 0) ? right : left;
    if (x + w > W - 12) x = left;
    if (x < 8) x = right;
    const y = Math.max(12, Math.min(H - h - 12, p.y - h / 2));
    els.tip.style.transform = `translate3d(${Math.round(Math.max(8, x))}px, ${Math.round(y)}px, 0)`;
  }
  function hideTip() {
    els.tip?.classList.remove("is-on");
  }

  /* —— 筛选与图层 —— */

  function applyFilter({ redraw: doRedraw = true } = {}) {
    let changed = false;
    for (const p of planets.values()) {
      const m = !matches(p.m);
      if (p.muted !== m) {
        p.muted = m;
        p.g.classList.toggle("is-muted", m);
        changed = true;
      }
    }
    for (const L of lines) {
      const m = Boolean(L.a.muted || L.b?.muted);
      if (L.muted !== m) {
        L.muted = m;
        changed = true;
      }
    }
    if (doRedraw && changed) redraw();
  }

  function updateLegendCounts() {
    const counts = { tunnel: planets.size ? [...planets.values()].filter((p) => p.oi === 0).length : 0, node: `${groups.node.length} 组`, config: `${groups.config.length} 组` };
    for (const el of root.querySelectorAll("[data-tm-layer-count]")) el.textContent = String(counts[el.dataset.tmLayerCount] ?? "");
    for (const chip of root.querySelectorAll("[data-tm-layer]")) chip.setAttribute("aria-pressed", String(!hidden.has(chip.dataset.tmLayer)));
  }

  function onLegendClick(e) {
    const motionBtn = e.target.closest?.("[data-tm-toggle-motion]");
    if (motionBtn) {
      setPaused(!userPaused);
      return;
    }
    const chip = e.target.closest?.("[data-tm-layer]");
    if (!chip) return;
    const k = chip.dataset.tmLayer;
    if (hidden.has(k)) hidden.delete(k);
    else hidden.add(k);
    saveHiddenLayers();
    for (const grp of allGroups) if (grp.labelEl) grp.labelEl.style.display = hidden.has(grp.kind) ? "none" : "";
    updateLegendCounts();
    redraw();
  }
  function onLegendOver(e) {
    const chip = e.target.closest?.("[data-tm-layer]");
    const k = chip && !hidden.has(chip.dataset.tmLayer) ? chip.dataset.tmLayer : null;
    if (k === layerFocus) return;
    layerFocus = k;
    if (k) root.dataset.layerFocus = k;
    else delete root.dataset.layerFocus;
    redraw();
  }

  /* —— 视差：只记目标偏移，由主循环统一指数缓动驱动 backdrop 与闪烁星 —— */
  function onPointerMove(e) {
    if (theme === "light" || reduced || userPaused) return;
    const w = W || size.w || 1;
    const h = H || size.h || 1;
    const ox = typeof e.offsetX === "number" && e.target === root ? e.offsetX : null;
    let nx;
    let ny;
    if (ox !== null && typeof e.offsetY === "number") {
      nx = ox / w - 0.5;
      ny = e.offsetY / h - 0.5;
    } else {
      const r = root.getBoundingClientRect();
      nx = (e.clientX - r.left) / Math.max(1, r.width) - 0.5;
      ny = (e.clientY - r.top) / Math.max(1, r.height) - 0.5;
    }
    parallax.x = -Math.max(-0.5, Math.min(0.5, nx)) * 12;
    parallax.y = -Math.max(-0.5, Math.min(0.5, ny)) * 8;
  }
  function onPointerLeave() {
    parallax.x = 0;
    parallax.y = 0;
  }

  /* —— 观察者 —— */
  const legend = root.querySelector(".tm-sky-legend");
  legend?.addEventListener("click", onLegendClick);
  legend?.addEventListener("pointerover", onLegendOver);
  legend?.addEventListener("pointerleave", onLegendOver);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerleave", onPointerLeave);
  syncMotionToggleUi();

  let resizeTimer = 0;
  let firstBuildQueued = false;
  const ro = typeof win.ResizeObserver === "function"
    ? new win.ResizeObserver(([entry]) => {
        const box = entry?.contentRect;
        size.w = Math.round(box?.width || 0);
        size.h = Math.round(box?.height || 0);
        win.clearTimeout(resizeTimer);
        // 第一次拿到尺寸（刚切进来）：让这一帧先把名单、读数带和星空底色画出来，下一帧再建星图
        //（行星本来就有逐颗浮现的入场，晚一帧看不出来；名单不必陪着等建图）。之后的改窗宽去抖。
        if (!geo) {
          if (!firstBuildQueued) {
            firstBuildQueued = true;
            win.requestAnimationFrame(() => {
              firstBuildQueued = false;
              if (!geo && layout()) syncLoop();
            });
          }
          return;
        }
        resizeTimer = win.setTimeout(() => {
          if (layout()) syncLoop();
        }, 120);
      })
    : null;
  ro?.observe(root);
  const io = typeof win.IntersectionObserver === "function"
    ? new win.IntersectionObserver(([entry]) => {
        inView = Boolean(entry?.isIntersecting);
        syncLoop();
      })
    : null;
  io?.observe(root);
  const mo = typeof win.MutationObserver === "function" && doc.body
    ? new win.MutationObserver(() => {
        if (themeOf() !== theme) layout({ force: true });
        syncLoop();
      })
    : null;
  mo?.observe(doc.body, { attributes: true, attributeFilter: ["data-theme", "data-console-hidden"] });
  const onReduce = () => {
    reduced = Boolean(reduceMq?.matches);
    syncLoop();
    redraw();
  };
  reduceMq?.addEventListener?.("change", onReduce);
  const onVis = () => syncLoop();
  doc.addEventListener("visibilitychange", onVis);
  const offEngagement = engagement.subscribe(() => syncLoop());

  return {
    // members：overview.members；matches(m)：当前筛选 / 搜索是否命中（没命中的行星变暗）
    update(nextMembers, { matches: nextMatches, clusterName } = {}) {
      members = Array.isArray(nextMembers) ? nextMembers.filter((m) => m && typeof m.user === "string") : [];
      if (typeof nextMatches === "function") matches = nextMatches;
      if (clusterName && root.dataset.clusterName !== clusterName) {
        root.dataset.clusterName = clusterName;
        signature = null;
      }
      const sig = galaxySignature(members);
      if (!geo && !layout()) {
        signature = null;
        return;
      }
      if (sig !== signature) {
        signature = sig;
        rebuild();
      } else {
        const byUser = new Map(members.map((m) => [m.user, m]));
        for (const p of planets.values()) p.m = byUser.get(p.m.user) || p.m;
        applyFilter();
        if (focus) showTip(planets.get(focus));
      }
      syncLoop();
    },
    setActive(next) {
      active = Boolean(next);
      if (active && !geo) layout();
      syncLoop();
    },
    setFocus,
    setPaused,
    isPaused: () => userPaused,
    relayout: () => layout({ force: true }),
    destroy() {
      active = false;
      syncLoop();
      ro?.disconnect();
      io?.disconnect();
      mo?.disconnect();
      reduceMq?.removeEventListener?.("change", onReduce);
      doc.removeEventListener("visibilitychange", onVis);
      offEngagement();
    },
    stats: () => ({ running: sim.running, paused: userPaused, quality: quality.level, planets: planets.size, lines: lines.length, ...fx.stats() }),
  };
}
