// 真实 Chromium 中验证服务器页「远端守护进程」面板：个人服务器隐藏、状态行、只有未运行才给「启动」、
// 行内确认后才 POST、进行中禁用、结果重绘；深浅主题与 1028px / 520px 两种宽度下不横向溢出。
// 只使用隔离 DOM 与注入的内存 API，零 SSH；baseUrl 必须是隔离的本机测试服务（不存在的静态页建立同源环境，不加载 app.js）。
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function runDaemonsBrowserSmoke({ BrowserWindow, baseUrl, screenshotDir = null }) {
  const win = new BrowserWindow({ show: false, width: 1028, height: 700, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const shot = async (name) => {
    if (!screenshotDir) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
    await writeFile(path.join(screenshotDir, name), (await win.webContents.capturePage()).toPNG());
  };
  const overflow = () => win.webContents.executeJavaScript(
    '[document.documentElement.scrollWidth - innerWidth, ...[...document.querySelectorAll(".dm-row, .dm-act, .panel-daemons .panel-header")].map((el) => el.scrollWidth - el.clientWidth)].reduce((a, b) => Math.max(a, b), 0)',
  );
  try {
    await win.loadURL(`${baseUrl}/daemons-ui-fixture`);
    const result = await win.webContents.executeJavaScript(`(${(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const until = async (predicate) => {
        for (let i = 0; i < 100; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("远端守护进程界面状态更新超时");
      };
      document.head.innerHTML = `<meta charset="utf-8">${["/styles.css", "/assets/css/tiles.css", "/assets/css/daemons.css"].map((href) => `<link rel="stylesheet" href="${href}">`).join("")}`;
      document.body.innerHTML = '<main style="padding:16px"><article class="panel panel-daemons" id="daemonsPanel" aria-label="远端守护进程" hidden>' +
        '<div class="panel-header flex-header"><div class="header-left-side"><h2>远端守护进程</h2><span class="badge" id="daemonsServer">-</span></div>' +
        '<button type="button" class="btn btn-secondary dm-refresh" id="daemonsRefreshBtn" title="立即重新检查（只读）">刷新</button></div>' +
        '<div class="dm-body" id="daemonsBody" aria-live="polite"></div></article></main>';
      const { createDaemonsController } = await import("/assets/js/app/daemons-controller.js");
      const row = (id, state, extra = {}) => ({ id, label: id === "paseo" ? "Paseo" : "T3 Code", port: id === "paseo" ? 6767 : 3773, description: "", state, installed: state !== "missing", version: null, note: "", ...extra });
      let t3 = "stopped";
      const view = () => ({
        eligible: true, serverId: "s1", serverName: "主集群（myserver）", checkedAt: Date.now(), reachable: true, error: null, starting: null,
        daemons: [row("paseo", "running", { version: "0.10.3" }), row("t3code", t3, t3 === "stopped" ? { note: "将使用 ~/.t3/runtime/versions/0.0.45-zh.1" } : { version: "0.0.45-zh.1" })],
      });
      const calls = [];
      const getJson = async (url) => { calls.push(["GET", url]); return view(); };
      const postJson = async (url, body) => {
        calls.push(["POST", url, body]);
        await new Promise((resolve) => setTimeout(resolve, 80));
        t3 = "running";
        return { daemon: body.daemon, result: "started", ok: true, detail: "", error: null, status: view() };
      };
      const config = { servers: [{ id: "s1", name: "主集群（myserver）", source: "team" }, { id: "me", source: "personal" }] };
      const toasts = [];
      const ctrl = createDaemonsController({
        doc: document, getJson, postJson, showToast: (t) => toasts.push(t), getConfig: () => config,
        isViewVisible: (v) => v === "servers", isHidden: () => false, onVisibilityChange: () => {},
      });
      ctrl.bind();
      const panel = document.getElementById("daemonsPanel");
      ctrl.onStatus({ activeServerId: "me" });
      assert(panel.hidden, "个人服务器不显示");
      assert(calls.length === 0, "个人服务器不发请求");
      ctrl.onStatus({ activeServerId: "s1" });
      assert(!panel.hidden, "团队集群显示");
      await until(() => document.querySelector(".dm-row"));
      assert(document.querySelectorAll(".dm-row").length === 2, "两个守护进程各一行");
      assert(!document.querySelector('[data-dm-start="paseo"]'), "运行中的不给启动按钮");
      assert(document.querySelector('.dm-row[data-state="running"] .dm-sub').textContent === "运行中 · v0.10.3", "状态与版本");
      document.querySelector('[data-dm-start="t3code"]').click();
      await until(() => document.querySelector('[data-dm-confirm="t3code"]'));
      assert(calls.every((c) => c[0] === "GET"), "点「启动」只进入确认");
      assert(document.querySelector(".dm-confirm-text").textContent === "在 主集群（myserver） 上启动 T3 Code？", "确认文案");
      return { ok: true };
    }).toString()})()`);
    assert.equal(result.ok, true);
    assert.ok((await overflow()) <= 1, "1028px 确认态不应横向溢出");
    await shot("daemons-confirm-dark-1028.png");
    await win.webContents.executeJavaScript('document.body.setAttribute("data-theme", "light"); true');
    await shot("daemons-confirm-light-1028.png");
    win.setContentSize(520, 700);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok((await overflow()) <= 1, "520px 确认态不应横向溢出");
    await shot("daemons-confirm-light-520.png");
    await win.webContents.executeJavaScript('document.body.removeAttribute("data-theme"); true');
    await shot("daemons-confirm-dark-520.png");
    const after = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-dm-confirm="t3code"]').click();
      const busy = Boolean(document.querySelector('.dm-busy')) && document.getElementById('daemonsRefreshBtn').disabled;
      for (let i = 0; i < 100 && document.querySelector('.dm-busy'); i += 1) await new Promise((r) => setTimeout(r, 20));
      return {
        busy,
        states: [...document.querySelectorAll('.dm-row')].map((el) => el.dataset.state).join(','),
        startButtons: document.querySelectorAll('[data-dm-start]').length,
        refreshEnabled: !document.getElementById('daemonsRefreshBtn').disabled,
      };
    })()`);
    assert.deepEqual(after, { busy: true, states: "running,running", startButtons: 0, refreshEnabled: true });
    assert.ok((await overflow()) <= 1, "520px 启动后不应横向溢出");
    await shot("daemons-running-dark-520.png");
    return result;
  } finally { if (!win.isDestroyed()) win.destroy(); }
}
