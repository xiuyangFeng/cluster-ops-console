// 真实 Chromium 中验证用量页「失败调用原文」：KPI 的无状态码归类一行、会话详情里失败调用原地展开原文、
// 旧记录的口径说明、原文按纯文本显示。零 SSH：摘要 / 详情由真实后端聚合函数从合成快照算出，经注入的
// getJson 交给真实 usage-controller；DOM 取自真实 index.html 的用量视图与详情弹窗，样式为真实 CSS。
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { buildSessionDetail, buildUsageSummary, sessionKeyOf } from "../../work/monitor/lib/usage/model.mjs";
import { dayKeyOf, secondsOfDay } from "../../work/monitor/lib/usage/time.mjs";

function fixture(nowSec) {
  const base = { serverId: "fixture-server", agent: "claude", sid: "cl-fixture", model: "claude-opus-5-5", turnId: null, sidechain: false, errorText: null, errorDropped: false };
  const ok = (rid, t) => ({ ...base, rid, t, ok: true, code: null, inFresh: 3, cacheWrite: 800, cacheRead: 42000, output: 600, prompt: 42803 });
  const fail = (rid, t, patch) => ({ ...base, rid, t, ok: false, code: null, model: null, inFresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, prompt: 0, ...patch });
  // 这些调用要落在「今天」（北京时间，用量页默认只看今天）且不晚于此刻。平时是一小时前起的一段；
  // 零点后的一小时里那样放会算成昨天的（KPI 成了「无失败」，这一步在每天 00:00–01:00 之间必挂），
  // 所以把整段时间轴等比压进零点到此刻之间，先后顺序不变。
  const span = Math.min(3600, secondsOfDay(nowSec));
  const t0 = nowSec - span;
  const at = (offset) => t0 + offset * (span / 3600);
  const calls = [
    ok("req_1", at(0)), ok("req_2", at(60)),
    fail("err:a1", at(90), { errorText: "API Error: The response stopped arriving. The response above may be incomplete." }),
    ok("req_3", at(200)),
    fail("err:a2", at(260), { errorText: "API Error: Connection lost mid-response. The response above may be incomplete." }),
    fail("err:a3", at(300), { code: 502, errorText: "API Error: 502 Cannot reach the reclaude gateway. Check your network and try again. <img src=x onerror=alert(1)>" }),
    fail("err:old", at(320), {}),
    fail("err:a4", at(400), { errorText: "API Error: The response stopped arriving. The response above may be incomplete." }),
    ok("req_4", at(500)),
  ].map((c) => ({ ...c, day: dayKeyOf(c.t) }));
  const snapshot = {
    calls,
    turns: [{ serverId: "fixture-server", agent: "claude", sid: "cl-fixture", tid: "u1", t0, t1: at(520) }],
    compacts: [],
    sessions: [{ serverId: "fixture-server", agent: "claude", sid: "cl-fixture", cwd: "/home/fixture/Digital_twin/GNN", window: null, firstT: t0, lastT: at(500) }],
  };
  const homes = { "fixture-server": "/home/fixture" };
  const key = sessionKeyOf({ serverId: "fixture-server", agent: "claude", sid: "cl-fixture" });
  const summary = { ...buildUsageSummary(snapshot, { nowSec, homes }), sources: [{ id: "fixture-server", name: "Isolated Fixture", lastScanAt: nowSec * 1000, lastOkAt: nowSec * 1000, complete: true }] };
  return { summary, detail: buildSessionDetail(snapshot, key, { nowSec, homes }), key };
}

export async function runUsageErrorBrowserSmoke({ BrowserWindow, baseUrl, screenshotDir = null }) {
  const data = fixture(Date.now() / 1000);
  const win = new BrowserWindow({ show: false, width: 1028, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const shot = async (name) => {
    if (!screenshotDir) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(path.join(screenshotDir, name), (await win.webContents.capturePage()).toPNG());
  };
  const overflow = () => win.webContents.executeJavaScript("document.documentElement.scrollWidth - innerWidth");
  const dialogOverflow = () => win.webContents.executeJavaScript('(() => { const d = document.getElementById("dlgUsageSession"); return d.scrollWidth - d.clientWidth; })()');
  try {
    await win.loadURL(`${baseUrl}/usage-error-ui-fixture`);
    const result = await win.webContents.executeJavaScript(`(${(async (fx) => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const until = async (predicate, what) => {
        for (let i = 0; i < 100; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`等待超时：${what}`);
      };
      const html = await (await fetch("/")).text();
      const page = new DOMParser().parseFromString(html, "text/html");
      document.head.innerHTML = `<meta charset="utf-8">${[...page.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.outerHTML).join("")}`;
      const view = page.getElementById("view-usage");
      view.hidden = false;
      document.body.innerHTML = `<main class="app-main" style="padding:16px">${view.outerHTML}</main>${page.getElementById("dlgUsageSession").outerHTML}`;
      await until(() => [...document.styleSheets].length >= 10, "样式加载");
      const { createUsageController } = await import("/assets/js/app/usage-controller.js");
      const getJson = async (url) => {
        if (url.startsWith("/api/usage/summary")) return structuredClone(fx.summary);
        if (url.startsWith("/api/usage/session")) return structuredClone(fx.detail);
        throw new Error(`unexpected ${url}`);
      };
      const controller = createUsageController({ doc: document, win: window, getJson, postJson: async () => ({}), showToast: () => {}, isViewVisible: () => true, isHidden: () => false, onVisibilityChange: () => {}, storage: null });
      controller.bind();
      controller.enter();
      const desc = () => document.getElementById("usageCallsDesc").textContent;
      await until(() => desc().includes("无状态码"), "KPI 无状态码归类");
      const causes = document.querySelector("#usageCallsDesc .us-cause-line").textContent;
      assert(causes === "无状态码 4：响应中途停止×2 · 连接中途断开×1 · v2.51 前未存原文×1", `归类一行：${causes}`);
      await until(() => document.querySelector("[data-failed]"), "会话行失败按钮");
      document.querySelector("[data-failed]").click();
      await until(() => document.querySelectorAll("[data-call-err]").length === 5, "失败调用列表");
      const labels = [...document.querySelectorAll("#usageSessionDetail tr.is-error .us-errors")].map((n) => n.textContent);
      assert(labels.join(",") === "响应中途停止,失败,502,连接中途断开,响应中途停止", `状态格：${labels}`);
      // 展开 502（含尖括号的原文）与旧记录
      const toggle = (rid) => document.querySelector(`[data-call-err="err:${rid}"]`).click();
      toggle("err:a3");
      toggle("err:old");
      await until(() => document.querySelectorAll("tr.us-err-text").length === 2, "原文展开");
      const bodies = [...document.querySelectorAll("tr.us-err-text")].map((n) => n.textContent);
      assert(bodies.some((t) => t.includes("Cannot reach the reclaude gateway") && t.includes("<img src=x")), "原文按纯文本显示");
      assert(!document.querySelector("tr.us-err-text img"), "原文里的 HTML 不能被解析");
      assert(bodies.some((t) => t.includes("该记录采集于 v2.51 之前，未保存原文")), "旧记录口径说明");
      assert(document.activeElement?.dataset.callErr === "err:err:old", "展开后焦点回到同一按钮");
      assert(document.querySelector('[data-call-err="err:err:old"]').getAttribute("aria-expanded") === "true", "aria-expanded 同步");
      // 切到「全部轮次」展开该轮，同一原文在逐次调用里同样展开（共用展开状态）
      document.querySelector('[data-detail-view="turns"]').click();
      document.querySelector("[data-turn]").click();
      await until(() => document.querySelectorAll(".us-call-table tr.us-err-text").length === 2, "轮次内原文展开");
      return { ok: true };
    }).toString()})(${JSON.stringify(data)})`);
    assert.equal(result.ok, true);
    await win.webContents.executeJavaScript('document.querySelector(\'[data-detail-view="failed"]\').click(); true');
    for (const [width, theme, suffix] of [[1028, "dark", "wide-dark"], [1028, "light", "wide-light"], [520, "dark", "narrow-dark"], [520, "light", "narrow-light"]]) {
      win.setSize(width, 900);
      await win.webContents.executeJavaScript(`document.body.dataset.theme = ${JSON.stringify(theme === "light" ? "light" : "")}; if (!document.body.dataset.theme) delete document.body.dataset.theme; true`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.ok((await overflow()) <= 1, `用量页 ${width}px 不应横向溢出`);
      assert.ok((await dialogOverflow()) <= 2, `会话详情 ${width}px 不应横向溢出`);
      // 截图对准失败调用表（含已展开的两条原文）
      await win.webContents.executeJavaScript('document.querySelector("#usageSessionDetail .us-detail-row").scrollIntoView({ block: "start" }); true');
      await shot(`usage-error-detail-${suffix}.png`);
    }
    // KPI 一行：关掉弹窗看用量页顶部
    await win.webContents.executeJavaScript('document.getElementById("dlgUsageSession").close(); window.scrollTo(0, 0); true');
    for (const [width, theme, suffix] of [[1028, "dark", "wide-dark"], [520, "light", "narrow-light"]]) {
      win.setSize(width, 900);
      await win.webContents.executeJavaScript(`document.body.dataset.theme = ${JSON.stringify(theme === "light" ? "light" : "")}; if (!document.body.dataset.theme) delete document.body.dataset.theme; true`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.ok((await overflow()) <= 1, `用量页 ${width}px 不应横向溢出`);
      await shot(`usage-error-kpi-${suffix}.png`);
    }
    return result;
  } finally { if (!win.isDestroyed()) win.destroy(); }
}
