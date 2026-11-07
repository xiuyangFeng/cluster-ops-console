// app/brief-controller.js：只拉简报与归档日期；隧道稳定性由 tunnel-stability-controller 负责（v2.46 起）。
import assert from "node:assert/strict";
import test from "node:test";
import { createBriefController } from "./brief-controller.js";

const fakeDoc = { getElementById: () => null, querySelectorAll: () => [] };
// final: true —— 定稿简报不启动「停留 5 秒记为已看」的定时器，测试进程不被它拖住
const BRIEF = { final: true };
const DAYS = { today: "2026-10-03", days: [] };

function controller(responses, extra = {}) {
  const calls = [];
  const ctl = createBriefController({
    doc: fakeDoc,
    getJson: async (url) => {
      calls.push(url);
      const body = responses[url.split("?")[0]];
      if (body instanceof Error) throw body;
      return body;
    },
    isViewVisible: () => false, // 不可见：refresh 之后不排下一轮轮询
    isHidden: () => false,
    storage: null,
    ...extra,
  });
  return { ctl, calls };
}

test("refresh: 只拉简报与归档日期，不再顺带拉隧道稳定性", async () => {
  const { ctl, calls } = controller({ "/api/brief": BRIEF, "/api/brief/days": DAYS });
  await ctl.refresh();
  assert.deepEqual(calls, ["/api/brief", "/api/brief/days"]);
});

test("refresh: 简报拉取失败也不抛", async () => {
  const { ctl } = controller({ "/api/brief": new Error("boom"), "/api/brief/days": DAYS });
  await assert.doesNotReject(() => ctl.refresh());
});

// ---- 这一天没有简报 / 取不到（空状态） ----

// 只认 #briefBody 的假文档；morphInnerHtml 经 ownerDocument 的 <template> 解析，这里记下写入的 HTML。
function briefDom() {
  const listeners = [];
  const body = {
    childNodes: [],
    html: "",
    querySelector: () => null,
    addEventListener: (_type, fn) => listeners.push(fn),
    click: (target) => { for (const fn of listeners) fn({ target }); },
  };
  body.ownerDocument = {
    createElement: () => {
      const tpl = { content: { childNodes: [] } };
      Object.defineProperty(tpl, "innerHTML", { set: (value) => { body.html = value; } });
      return tpl;
    },
  };
  const doc = { getElementById: (id) => (id === "briefBody" ? body : null), querySelectorAll: () => [] };
  return { doc, body };
}

test("归档里没有这一天（404）：说明为什么没有、写真实保留天数；「回到今天」走 selectDay(null)", async () => {
  const { doc, body } = briefDom();
  const missing = Object.assign(new Error("no brief for this day"), { status: 404 });
  const days = { today: "2026-10-03", days: ["2026-10-03", "2026-09-20"], retentionDays: 31 };
  const calls = [];
  const ctl = createBriefController({
    doc,
    getJson: async (url) => {
      calls.push(url);
      if (url === "/api/brief/days") return days;
      if (url.startsWith("/api/brief?day=")) throw missing;
      return BRIEF;
    },
    isViewVisible: () => false,
    isHidden: () => false,
    storage: null,
  });
  ctl.bind();
  ctl.selectDay("2026-09-20");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(body.html, /<p class="empty-state-title">9 月 20 日没有简报<\/p>/);
  assert.match(body.html, /第二天由运行中的工作台定稿归档/);
  assert.match(body.html, /归档保留最近 31 天。/);
  assert.match(body.html, /data-brief-back="">回到今天<\/button>/);

  const back = { closest: (selector) => (selector === "[data-brief-back]" ? back : null) };
  body.click(back);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((url) => url.startsWith("/api/brief?") || url === "/api/brief").at(-1), "/api/brief", "回到今天：不带 day 参数重新拉取");
});

test("简报一直取不到（非 404）：红色「暂时取不到」+ 原有的具体原因", async () => {
  const { doc, body } = briefDom();
  const ctl = createBriefController({
    doc,
    getJson: async (url) => {
      if (url === "/api/brief/days") return DAYS;
      throw Object.assign(new Error("boom"), { status: 503, serverMessage: "brief unavailable" });
    },
    isViewVisible: () => false,
    isHidden: () => false,
    storage: null,
  });
  await ctl.refresh();
  assert.match(body.html, /data-tone="error"/);
  assert.match(body.html, /<p class="empty-state-title">暂时取不到简报<\/p>/);
  assert.match(body.html, /简报加载失败：brief unavailable；每分钟会自动重试。/);
});
