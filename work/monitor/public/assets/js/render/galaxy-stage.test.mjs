// galaxy-stage.test.mjs —— 星空版画布与动效（全局星空 / 日志星表 / 事件舞台）挂载与数据联动单元测试
import assert from "node:assert/strict";
import test from "node:test";
import { createGalaxyStageController } from "./galaxy-stage.js";

function createMockNode(id = "", tagName = "DIV") {
  const children = [];
  const attrs = new Map();
  let html = "";
  let text = "";
  const node = {
    id,
    tagName,
    hidden: false,
    open: false,
    dataset: {},
    style: {},
    classList: {
      _set: new Set(),
      add(...cls) { for (const c of cls) this._set.add(c); },
      remove(...cls) { for (const c of cls) this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    get innerHTML() { return html; },
    set innerHTML(val) {
      html = String(val);
      text = html.replace(/<[^>]+>/g, " ");
    },
    get textContent() { return text; },
    set textContent(val) {
      text = String(val);
      html = text;
    },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.get(k) ?? null; },
    appendChild(child) { children.push(child); return child; },
    prepend(child) { children.unshift(child); return child; },
    insertBefore(child) { children.unshift(child); return child; },
    addEventListener() {},
    querySelector(sel) {
      if (sel.startsWith("#")) {
        const targetId = sel.slice(1);
        for (const c of children) {
          if (c.id === targetId) return c;
        }
        if (html.includes(`id="${targetId}"`)) {
          return this._subNodes?.get(targetId) || null;
        }
      }
      if (sel === ".dialog-body") return this._dialogBody || null;
      return null;
    },
    _children: children,
  };
  return node;
}

function createMockDoc() {
  const nodes = new Map();
  const ensure = (id) => {
    if (!nodes.has(id)) nodes.set(id, createMockNode(id));
    return nodes.get(id);
  };

  const usageStage = ensure("usageGalaxyStage");
  const eventsStage = ensure("eventsGalaxyStage");
  const chainPanel = ensure("chainPanel");
  const briefPanel = ensure("briefPanel");
  const dlgEndpoint = ensure("dlgEndpoint");
  const endpointContent = ensure("endpointContent");
  dlgEndpoint._dialogBody = endpointContent;
  const timelinePanel = ensure("timelinePanel");
  const dlgLogs = ensure("dlgLogs");
  const dlgBody = createMockNode("dlgLogsBody");
  dlgLogs._dialogBody = dlgBody;

  const doc = {
    hidden: false,
    body: createMockNode("body", "BODY"),
    createElement(tag) {
      const el = createMockNode("", tag.toUpperCase());
      Object.defineProperty(el, "id", {
        get() { return this._id || ""; },
        set(v) {
          this._id = v;
          if (v) nodes.set(v, el);
        },
      });
      return el;
    },
    getElementById(id) {
      if (nodes.has(id)) return nodes.get(id);
      // 动态子元素按需惰性创建供写入读数验证
      if (id.startsWith("gx")) {
        const sub = createMockNode(id);
        nodes.set(id, sub);
        return sub;
      }
      return null;
    },
    addEventListener() {},
    _nodes: nodes,
    usageStage,
    eventsStage,
    chainPanel,
    briefPanel,
    dlgEndpoint,
    endpointContent,
    timelinePanel,
    dlgLogs,
    dlgBody,
  };
  return doc;
}

test("galaxy-stage：不再挂载用量 / 端点 / 时间线舞台（v2.80 起由真实数据的星图替代），只挂日志哈佛光谱星表", () => {
  const doc = createMockDoc();
  const ctl = createGalaxyStageController({ doc, win: {} });
  ctl.init("starry");

  // 旧版的「虫洞星网」「火流星卷轴」画的是写死的端口与延迟，「环轨卫星」会拿虚构模型补位——全部移除
  assert.equal(doc.endpointContent.querySelector("#gxWormholeStage"), null, "端点弹窗不再挂虫洞星网");
  assert.equal(doc.timelinePanel.querySelector("#gxTimelineStage"), null, "时间线弹窗不再挂火流星卷轴");
  assert.equal(doc.usageStage.innerHTML, "", "用量页的星图总览由 usage-view 渲染，这里不写");
  assert.equal(typeof ctl.updateUsage, "undefined", "控制器不再接收用量数据");

  // 日志哈佛光谱星表与 2.00 MB 星环容量守护
  const logsBar = doc.getElementById("gxLogsCatalogBar");
  assert.ok(logsBar, "在 #dlgLogs 中挂载 #gxLogsCatalogBar");
  assert.match(logsBar.innerHTML, /HARVARD SPECTRAL CATALOG/);
  assert.match(logsBar.innerHTML, /2\.00 MB/);

  ctl.updateStatus({ activeServerId: "srv-main", storage: { logsBytes: 1.35 * 1024 * 1024 } });
  assert.equal(
    doc.getElementById("gxLogsCapValue").textContent,
    "1.35 MB / 2.00 MB 上限",
    "日志星环容量仪实时反映 NDJSON 日志占用与 2.00 MB 上限",
  );
});

test("galaxy-stage v5.0：事件页星空舞台严格锁死在 108px 超紧凑微缩高度，防止 Canvas 无限拉长引发卡顿", () => {
  const doc = createMockDoc();
  const viewEvents = doc.createElement("section");
  viewEvents.id = "view-events";
  viewEvents.hidden = false;
  viewEvents.offsetParent = {};

  let rafCallback = null;
  const win = {
    devicePixelRatio: 2,
    requestAnimationFrame(cb) {
      rafCallback = cb;
      return 1;
    },
    cancelAnimationFrame() {},
  };

  const ctl = createGalaxyStageController({ doc, win });
  ctl.init("starry");

  const eventsCanvas = doc.getElementById("gxEventsCanvas");
  // 模拟极端情况下父容器返回异常巨大的高度（如 2400px）
  eventsCanvas.parentElement = {
    getBoundingClientRect: () => ({ width: 520, height: 2400 }),
  };
  eventsCanvas.getContext = () => ({
    save() {},
    restore() {},
    scale() {},
    clearRect() {},
    drawImage() {},
    beginPath() {},
    arc() {},
    ellipse() {},
    fill() {},
    stroke() {},
    setLineDash() {},
    translate() {},
    rotate() {},
    moveTo() {},
    lineTo() {},
    fillRect() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createConicGradient: () => ({ addColorStop() {} }),
  });

  ctl.updateEvents({ incidents: [] });
  if (rafCallback) rafCallback(100);

  // 装饰性星空画布的 DPR 上限已从 1.5 降到 1.25（降低后台像素），宽度仍按父容器实测而不是被拉长
  assert.equal(eventsCanvas.height, 108 * 1.25, "事件页 Canvas 物理像素高度严格锁死在 108px * dpr(1.25) = 135，绝不被撑高");
  assert.equal(eventsCanvas.width, 520 * 1.25, "事件页 Canvas 宽度按父容器实测宽度换算，不随异常高度膨胀");
});

test("galaxy-stage v5.0：全局深空背景画布 DPR 上限 1.0，切回经典版时清零物理像素释放显存", () => {
  const doc = createMockDoc();
  const win = {
    devicePixelRatio: 2,
    innerWidth: 1028,
    innerHeight: 800,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  };
  const ctl = createGalaxyStageController({ doc, win });
  ctl.init("starry");

  const globalSky = doc.getElementById("galaxyGlobalSkyCanvas");
  assert.ok(globalSky, "星空版会挂载全局深空背景画布");
  assert.equal(globalSky.width, 1028, "全局深空背景画布 DPR 上限 1.0：1028 CSS px 宽 → 1028 物理 px");
  assert.equal(globalSky.height, 800, "全局深空背景画布 DPR 上限 1.0：800 CSS px 高 → 800 物理 px");

  ctl.applySkin("classic", "starry");
  assert.equal(globalSky.width, 0, "切回经典版时把全局深空背景画布物理宽度清零，释放显存");
  assert.equal(globalSky.height, 0, "切回经典版时把全局深空背景画布物理高度清零，释放显存");
});

