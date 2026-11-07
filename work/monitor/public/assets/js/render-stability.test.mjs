// 渲染稳定性（fix/render-stability）：就地修补 morphChildren 的节点复用语义、进度条 scaleX、
// 以及几处"整块 innerHTML 重建 / 定时器漏停"的接线守护。纯 Node，无真实 DOM。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { morphChildren } from "./dom-utils.js";
import { progressScale, updateProgressBar } from "./render/load-panel.js";

const jsDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(jsDir, "../..");
// 统一成 LF：Windows 检出若是 CRLF，按 "\n" 锚定的函数体正则会整体失配。
const read = (rel) => readFileSync(resolve(publicDir, rel), "utf8").replace(/\r\n/g, "\n");

// ---- 假节点：只实现 morphChildren 用到的 DOM 接口，并记录写入次数 ----
class FakeNode {
  constructor(nodeType, nodeName, { attrs = {}, value = null, children = [] } = {}) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
    this.writes = 0;
    this._attrs = { ...attrs };
    this._value = value;
    for (const child of children) this.appendChild(child);
  }
  get nodeValue() { return this._value; }
  set nodeValue(v) { this._value = v; this.writes += 1; }
  get attributes() { return Object.entries(this._attrs).map(([name, value]) => ({ name, value })); }
  hasAttribute(name) { return Object.hasOwn(this._attrs, name); }
  getAttribute(name) { return this.hasAttribute(name) ? this._attrs[name] : null; }
  setAttribute(name, value) { this._attrs[name] = String(value); this.writes += 1; }
  removeAttribute(name) { delete this._attrs[name]; this.writes += 1; }
  appendChild(child) {
    child.remove();
    this.childNodes.push(child);
    child.parentNode = this;
  }
  replaceChild(next, cur) {
    next.remove();
    this.childNodes[this.childNodes.indexOf(cur)] = next;
    next.parentNode = this;
    cur.parentNode = null;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
}
const el = (name, attrs = {}, ...children) => new FakeNode(1, name.toUpperCase(), { attrs, children });
const text = (value) => new FakeNode(3, "#text", { value });
const frag = (...children) => new FakeNode(11, "#document-fragment", { children });

test("morphChildren: 结构不变只改文本 → 元素原样保留（焦点/动画不丢），只写变化的文本节点", () => {
  const button = el("button", { class: "agent-drawer-toggle", "aria-expanded": "false" }, text("详情"));
  const chip = text("检查 · 5 秒前");
  const root = frag(el("span", { class: "chip" }, chip), button);
  morphChildren(root, frag(el("span", { class: "chip" }, text("检查 · 12 秒前")), el("button", { class: "agent-drawer-toggle", "aria-expanded": "false" }, text("详情"))));
  assert.equal(root.childNodes[1], button, "按钮节点必须是同一个对象");
  assert.equal(root.childNodes[0].childNodes[0], chip);
  assert.equal(chip.nodeValue, "检查 · 12 秒前");
  assert.equal(chip.writes, 1);
  assert.equal(button.writes, 0, "未变化的按钮零写入");
  assert.equal(button.childNodes[0].writes, 0);
});

test("morphChildren: 数据完全不变时零写入", () => {
  const build = () => frag(el("div", { class: "a", "data-x": "1" }, text("hello")), text(" "), el("b", {}, text("x")));
  const root = build();
  morphChildren(root, build());
  const count = (n) => n.writes + n.childNodes.reduce((sum, c) => sum + count(c), 0);
  assert.equal(count(root), 0);
});

test("morphChildren: 属性增/改/删同步到现有元素", () => {
  const node = el("button", { class: "chain-node state-ok", "aria-pressed": "true", disabled: "" });
  const root = frag(node);
  morphChildren(root, frag(el("button", { class: "chain-node state-error", "aria-pressed": "true", title: "t" })));
  assert.equal(root.childNodes[0], node);
  assert.equal(node.getAttribute("class"), "chain-node state-error");
  assert.equal(node.getAttribute("title"), "t");
  assert.equal(node.hasAttribute("disabled"), false);
  assert.equal(node.getAttribute("aria-pressed"), "true");
});

test("morphChildren: 标签变化整节点替换；多出的追加、少掉的移除", () => {
  const keep = el("li", {}, text("1"));
  const swapped = el("span", {}, text("x"));
  const extra = el("li", {}, text("3"));
  const root = frag(keep, swapped, extra);
  morphChildren(root, frag(el("li", {}, text("1")), el("p", {}, text("x"))));
  assert.equal(root.childNodes.length, 2);
  assert.equal(root.childNodes[0], keep);
  assert.equal(root.childNodes[1].nodeName, "P");
  assert.equal(extra.parentNode, null);

  const grow = frag(el("li", {}, text("1")));
  morphChildren(grow, frag(el("li", {}, text("1")), el("li", {}, text("2")), el("li", {}, text("3"))));
  assert.deepEqual(grow.childNodes.map((n) => n.childNodes[0].nodeValue), ["1", "2", "3"]);
});

test("progressScale/updateProgressBar: 以 scaleX 表达进度并钳到 0–100；条本体恒 width:100%", () => {
  assert.equal(progressScale(42), "scaleX(0.42)");
  assert.equal(progressScale(0), "scaleX(0)");
  assert.equal(progressScale(150), "scaleX(1)");
  assert.equal(progressScale(-5), "scaleX(0)");
  assert.equal(progressScale(Number.NaN), "scaleX(0)");
  const bar = { style: {}, className: "" };
  updateProgressBar(bar, 57, "green");
  assert.equal(bar.style.width, "100%");
  assert.equal(bar.style.transform, "scaleX(0.57)");
});

// ---- 接线守护：这些区域曾经每轮整块 innerHTML 重建 / 定时器不收尾 ----

test("Agent 状态带、链路条、runbook 条目走就地修补，不再整块 innerHTML 重建", () => {
  const overview = read("assets/js/render/overview.js");
  assert.match(overview, /morphInnerHtml\(pill,/, "状态带的每一栏");
  assert.match(overview, /morphInnerHtml\(drawer,/, "状态带下方的详情");
  assert.doesNotMatch(overview, /(?:pill|drawer)\.innerHTML\s*=/);
  const chain = read("assets/js/render/chain.js");
  assert.match(chain, /morphInnerHtml\(track, chainTrackHtml\(road, nowMs\)\)/);
  assert.match(chain, /morphInnerHtml\(detail, chainDetailHtml\(data\)\)/, "节点详情也就地修补");
  assert.doesNotMatch(chain, /track\.innerHTML\s*=/);
  const runbook = read("assets/js/render/repair-runbook.js");
  const renderItem = runbook.match(/function renderItem\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(renderItem, /morphInnerHtml\(el, html\)/);
  assert.doesNotMatch(renderItem, /innerHTML\s*=/);
  // 每秒变化的耗时行对读屏隐藏（#repairRunbook 是 aria-live + aria-atomic）
  assert.match(runbook, /class="runbook-meta" aria-hidden="true"/);
});

test("单隧道重启：超时与收尾都停掉 2s 结果轮询", () => {
  const runbook = read("assets/js/render/repair-runbook.js");
  const settle = runbook.match(/function settle\(ok\) \{[\s\S]*?\n\}/)[0];
  assert.match(settle, /stopScopedPolling\(\)/);
  const timeoutBranch = runbook.match(/if \(machine\.checkTimeout\(\)\) \{[\s\S]*?return;\n\s*\}/)[0];
  assert.match(timeoutBranch, /stopScopedPolling\(\)/);
});

// 定时器实现在 app/settings-dialog.js（行为测试见 app/settings-dialog.test.mjs），这里守接线。
test("设置页本机资源定时器随浮层启停；离线安装面板不在启动时预取", () => {
  const app = read("app.js");
  const settings = read("assets/js/app/settings-dialog.js");
  assert.doesNotMatch(settings, /const localResourceRefreshTimer = setInterval/);
  assert.match(settings, /function onOpen\(\) \{[\s\S]*?startLocalResourceRefresh\(\);/);
  assert.match(settings, /getElementById\("dlgSettings"\)\?\.addEventListener\("close", stopLocalResourceRefresh\)/);
  assert.match(app, /onDialogOpen\("dlgSettings", settings\.onOpen\)/);
  const bootstrapBody = app.match(/async function bootstrap\(\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(bootstrapBody, /bootstrapPanel\.refresh\(\)/);
  assert.match(app, /onDialogOpen\("dlgBootstrap", \(\) => bootstrapPanel\.refresh\(\)\)/, "离线安装面板只在打开浮层时拉取");
});

test("离线安装步骤轮询有时长与连续失败上限", () => {
  const src = read("assets/js/bootstrap-panel.js");
  assert.match(src, /POLL_MAX_MS/);
  assert.match(src, /POLL_MAX_FAILURES/);
});

test("样式：加载骨架的光带只走 transform 且在减弱动画守卫内；不再有全屏转圈遮罩；进度条过渡走 transform；死代码 .card 已删", () => {
  // 骨架与进度条是 styles.css 里的共用原语
  const css = read("styles.css");
  assert.doesNotMatch(css, /page-loading-overlay|loading-spinner/, "切换查看视角不再盖全屏遮罩（app/skeleton.js 让相关面板回到骨架）");
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\) \{\s*\.skeleton::after \{[^}]*animation: skShimmer/);
  assert.match(css, /@keyframes skShimmer \{\s*to \{ transform: translateX\(100%\); \}\s*\}/);
  assert.match(css, /\.bar-progress \{[^}]*transition: transform/);
  // 任何一个链接的样式表（styles.css + assets/css 各区块文件）都不得回到 width 过渡、复活 .card
  const html = read("index.html");
  const all = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)"/g)].map((m) => read(m[1])).join("\n");
  assert.ok(all.includes(css), "styles.css 应在 index.html 的样式表链接里");
  // 唯一例外：侧栏开合（shell.css .sidebar）。固定定位、用户点一下才发生一次 240ms，回流只限侧栏自己的子树；
  // 内容区的位移另走 transform（app/sidebar.js 的 FLIP）。其余一律不许回到 width 过渡。
  const sidebarRule = all.match(/^\.sidebar \{[^}]*\}/m);
  assert.ok(sidebarRule && /transition: width 240ms/.test(sidebarRule[0]), "侧栏开合的宽度过渡在 .sidebar 规则里");
  assert.doesNotMatch(all.replace(sidebarRule[0], ""), /transition: width/);
  assert.doesNotMatch(all, /^\.card \{/m);
  const island = read("island.css");
  assert.match(island, /\.res-bar \{[^}]*transition: transform/);
});

test("样式：用量页活跃彗头空闲不跑常驻动画，只在悬停/聚焦时由独立伪元素层播放 transform+opacity", () => {
  // 回归：v2.78 前用量页呼吸圆点挂常驻 2.4s 无限动画，无头 Chrome 实测空闲 6s 触发
  // RecalcStyleCount 194 / 46.6ms（去掉动画后同一时段 0 次）。v2.80 的星图总览沿用同一约定。
  const css = read("assets/css/observatory.css");
  // 每条带 animation 的最内层规则（选择器里不含 { } @），其选择器的每一段都必须是悬停 / 聚焦态
  const animated = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{[^{}]*animation:/g)].flatMap((m) => m[1].split(",").map((part) => part.trim()));
  assert.ok(animated.length > 0);
  for (const sel of animated) assert.match(sel, /:hover|:focus-visible/, `常驻动画：${sel}`);
  assert.match(css, /\.ob-comet\.is-live:hover \.ob-comet-tail::after/, "指针悬停时闪烁");
  assert.match(css, /\.ob-comet\.is-live:focus-visible \.ob-comet-tail::after/, "键盘聚焦时闪烁");
  const layer = css.match(/\.ob-comet-tail::after \{[^}]*\}/)[0];
  assert.match(layer, /position: absolute/, "闪烁的是独立绝对定位的伪元素");
  assert.match(css, /animation: obTwinkle[^;]*;\s*will-change: transform, opacity;/);
  const keyframes = css.match(/@keyframes obTwinkle \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(keyframes, /filter|box-shadow|background|color/, "关键帧只许动 transform/opacity");
});
