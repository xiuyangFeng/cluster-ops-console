// 真实 Chromium 中验证「查看我的目录占用」：入口显隐、展开只读、手动扫描 / 续扫、子目录查看、
// 深浅主题与 1028px / 520px 两种宽度下不横向溢出。只使用隔离 DOM 与注入的内存 API，零 SSH。
// baseUrl 必须是隔离的本机测试服务；使用一个不存在的静态页建立同源环境，不加载 app.js。
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function runDirUsageBrowserSmoke({ BrowserWindow, baseUrl, screenshotDir = null }) {
  const win = new BrowserWindow({ show: false, width: 1028, height: 1100, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const shot = async (name) => {
    if (!screenshotDir) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
    await writeFile(path.join(screenshotDir, name), (await win.webContents.capturePage()).toPNG());
  };
  const overflow = () => win.webContents.executeJavaScript(
    '[document.documentElement.scrollWidth - innerWidth, ...[...document.querySelectorAll(".du-row, .du-files li, .du-head")].map((el) => el.scrollWidth - el.clientWidth)].reduce((a, b) => Math.max(a, b), 0)',
  );
  try {
    await win.loadURL(`${baseUrl}/dir-usage-ui-fixture`);
    const result = await win.webContents.executeJavaScript(`(${(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const until = async (predicate) => {
        for (let i = 0; i < 80; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("目录占用界面状态更新超时");
      };
      const NOW = Date.now();
      const GiB = 2 ** 30;
      document.head.innerHTML = `<meta charset="utf-8">${["/styles.css", "/assets/css/tiles.css"].map((href) => `<link rel="stylesheet" href="${href}">`).join("")}`;
      const tile = (name) => `<section class="res-tile" data-level="ok"><div class="res-tile-body"><div class="res-tile-title">${name}</div><div class="res-tile-figure"><span class="res-tile-value">85</span><span class="res-tile-unit">%</span></div><p class="res-tile-note">${name === "磁盘" ? "共享卷 /public（$HOME 所在）· 个人配额未知" : ""}</p></div></section>`;
      document.body.innerHTML = '<main style="padding:16px"><article class="panel panel-servers" id="resourcesPanel"><div class="panel-header flex-header"><div class="header-left-side"><h2>资源与负载</h2><span class="badge">myserver</span></div></div>' +
        `<div class="res-body"><div class="res-tiles">${tile("CPU")}${tile("内存")}${tile("磁盘")}</div>` +
        '<section class="res-dirusage" id="resDirUsage" aria-label="我的目录占用" hidden><div class="du-bar"><button type="button" class="text-btn du-toggle" id="resDirUsageToggle" aria-expanded="false" aria-controls="resDirUsageBody">查看我的目录占用</button><span class="du-hint">磁盘是共享卷用量；这里按需扫描 $HOME 下你自己的目录</span></div><div class="du-body" id="resDirUsageBody" hidden></div></section>' +
        "</div></article></main>";
      const { createDirUsageController } = await import("/assets/js/app/dir-usage-controller.js");
      const longName = "lab-docs-engineering_backup_20261002_with_a_really_long_directory_name_for_overflow";
      const partial = {
        root: "", label: "~", parent: null, home: "/public/newhome/cy", startedAt: NOW - 90000, updatedAt: NOW - 30000, runs: 2, complete: false, stop: "time",
        lastRun: { at: NOW - 30000, sec: 8.0, entries: 4304, stop: "time" },
        scanned: { entries: 20001, dirsDone: 2980, pendingDirs: 255, rootPartial: false, denied: 2, errors: 0, otherFs: 0, otherFsNames: [], dropped: 0, hardlinks: 0 },
        totals: { blocks: 4.6 * GiB, size: 4.3 * GiB, files: 16810, dirs: 2990 },
        rootFiles: { blocks: 0.62 * GiB, size: 0.62 * GiB, files: 61 },
        children: [
          { name: ".claude", rel: ".claude", blocks: 2.0 * GiB, size: 1.9 * GiB, files: 9120, dirs: 860, partial: false,
            sub: [{ name: "projects", rel: ".claude/projects", blocks: 1.2 * GiB, size: 1.1 * GiB, files: 3100, dirs: 210 }, { name: "todos", rel: ".claude/todos", blocks: 0.3 * GiB, size: 0.3 * GiB, files: 4000, dirs: 0 }],
            subRest: { blocks: 0.5 * GiB, size: 0.5 * GiB, dirs: 17 } },
          { name: ".npm", rel: ".npm", blocks: 1.3 * GiB, size: 1.2 * GiB, files: 4304, dirs: 1358, partial: true, sub: [{ name: "_cacache", rel: ".npm/_cacache", blocks: 1.3 * GiB, size: 1.2 * GiB, files: 4300, dirs: 1350 }], subRest: { blocks: 0, size: 0, dirs: 0 } },
          { name: ".vscode-server", rel: ".vscode-server", blocks: 1.0 * GiB, size: 0.9 * GiB, files: 3200, dirs: 700, partial: true, sub: [], subRest: { blocks: 0, size: 0, dirs: 0 } },
          { name: longName, rel: longName, blocks: 0.2 * GiB, size: 0.2 * GiB, files: 120, dirs: 8, partial: false, sub: [], subRest: { blocks: 0, size: 0, dirs: 0 } },
          { name: "Digital_twin", rel: "Digital_twin", blocks: 4096, size: 4096, files: 0, dirs: 0, partial: true, sub: [], subRest: { blocks: 0, size: 0, dirs: 0 } },
        ],
        childrenRest: { count: 0, blocks: 0, size: 0, overflow: false },
        topFiles: [
          { path: "codex-cli-linux-offline-0.144.1.tar.gz", rel: "codex-cli-linux-offline-0.144.1.tar.gz", blocks: 254132224, size: 254126489, mtime: 1783652680 },
          { path: `.vscode-server/extensions/openai.chatgpt-26.409.20454/bin/linux-x86_64/${"x".repeat(60)}/codex`, rel: ".vscode-server/x/codex", blocks: 171679744, size: 171671880, mtime: 1775906962 },
        ],
      };
      const calls = [];
      let scans = 0;
      const getJson = async (url) => {
        calls.push(["GET", url]);
        const root = new URL(url, location.href).searchParams.get("root");
        if (root && root !== "") return { eligible: true, serverId: "s1", root, running: false, saved: [{ root: "", updatedAt: NOW, complete: false }], scan: null };
        return { eligible: true, serverId: "s1", root: "", running: false, saved: [], scan: scans ? partial : null };
      };
      const postJson = async (url, body) => {
        calls.push(["POST", url, body]);
        scans += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { eligible: true, serverId: "s1", root: "", running: false, saved: [{ root: "", updatedAt: NOW, complete: false }], scan: partial };
      };
      const config = { servers: [{ id: "s1", source: "team" }, { id: "me", source: "personal" }] };
      const toasts = [];
      const ctrl = createDirUsageController({ doc: document, getJson, postJson, showToast: (t) => toasts.push(t), getConfig: () => config });
      ctrl.bind();
      const section = document.getElementById("resDirUsage");
      ctrl.onStatus({ activeServerId: "me" });
      assert(section.hidden, "个人服务器不显示入口");
      ctrl.onStatus({ activeServerId: "s1" });
      assert(!section.hidden, "团队集群显示入口");
      assert(calls.length === 0, "未展开不发任何请求");
      document.getElementById("resDirUsageToggle").click();
      await until(() => document.querySelector('[data-du-scan="start"]'));
      assert(calls.every((c) => c[0] === "GET"), "展开只读本机结果");
      document.querySelector('[data-du-scan="start"]').click();
      await until(() => document.querySelector(".du-busy"));
      assert(document.querySelector('[data-du-scan="start"]').disabled, "扫描中按钮禁用");
      await until(() => document.querySelector(".du-coverage"));
      const coverage = document.querySelector(".du-coverage").textContent;
      assert(coverage.includes("已扫描部分：20,001 个条目，覆盖 2,980 个目录"), "部分扫描写明覆盖范围");
      assert(coverage.includes("不是目录总量，也不是个人配额"), "不冒充总量或配额");
      assert(calls.filter((c) => c[0] === "POST").length === 1, "一次点击一次扫描");
      document.querySelector('details[data-du-rel=".claude"] > summary').click();
      assert(document.querySelector('details[data-du-rel=".claude"]').open, "第一层目录可展开子目录");
      return { ok: true, toasts: toasts.length };
    }).toString()})()`);
    assert.equal(result.ok, true);
    assert.ok((await overflow()) <= 1, "1028px 不应横向溢出");
    await shot("dir-usage-dark-1028.png");
    await win.webContents.executeJavaScript('document.body.setAttribute("data-theme", "light"); true');
    assert.ok((await overflow()) <= 1, "浅色 1028px 不应横向溢出");
    await shot("dir-usage-light-1028.png");
    win.setContentSize(520, 1100);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok((await overflow()) <= 1, "520px 不应横向溢出");
    await shot("dir-usage-light-520.png");
    await win.webContents.executeJavaScript('document.body.removeAttribute("data-theme"); true');
    await shot("dir-usage-dark-520.png");
    // 子目录：只读本机结果，没有扫描过就给出「开始扫描」与「上一级」，不自动扫描。
    const sub = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-du-root="Digital_twin"]').click();
      for (let i = 0; i < 80 && !document.querySelector('.du-root')?.textContent.includes('Digital_twin'); i += 1) await new Promise((r) => setTimeout(r, 20));
      const body = document.getElementById('resDirUsageBody').textContent;
      return { root: document.querySelector('.du-root').textContent, unscanned: body.includes('还没有扫描过'), up: Boolean([...document.querySelectorAll('[data-du-root]')].find((b) => b.textContent === '上一级')) };
    })()`);
    assert.deepEqual(sub, { root: "~/Digital_twin", unscanned: true, up: true });
    assert.ok((await overflow()) <= 1, "子目录视图 520px 不应横向溢出");
    return result;
  } finally { if (!win.isDestroyed()) win.destroy(); }
}
