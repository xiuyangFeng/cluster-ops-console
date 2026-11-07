// 真实 Chromium 中验证「我的历史」按需回查（v2.51）：查询框、「更早…」、组内「再显示 N 个」、迟到请求不覆盖新查询。
// 只用隔离 DOM（从真实 index.html 摘出 #clusterPanel）与注入的内存 API，零 SSH；不加载 app.js。
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function runJobHistoryLookupBrowserSmoke({ BrowserWindow, baseUrl, screenshotDir = null }) {
  const win = new BrowserWindow({ show: false, width: 1028, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const shot = async (name) => {
    if (!screenshotDir) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
    await writeFile(path.join(screenshotDir, name), (await win.webContents.capturePage()).toPNG());
  };
  const overflow = () => win.webContents.executeJavaScript("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  try {
    await win.loadURL(`${baseUrl}/job-history-lookup-ui-fixture`);
    const result = await win.webContents.executeJavaScript(`(${(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const until = async (predicate, message = "回查界面状态更新超时") => {
        for (let i = 0; i < 100; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(message);
      };
      const NOW = Date.now();
      const HOUR = 3_600_000;
      const html = await (await fetch("/")).text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      document.head.innerHTML = `<meta charset="utf-8">${["/styles.css", "/assets/css/tiles.css", "/assets/css/cluster.css", "/assets/css/usage.css", "/assets/css/jobs-watch.css"].map((href) => `<link rel="stylesheet" href="${href}">`).join("")}`;
      const panel = doc.getElementById("clusterPanel");
      assert(panel?.querySelector("#clusterHistoryLookup"), "index.html 里应有查询框");
      document.body.innerHTML = `<main style="padding:16px">${panel.outerHTML}</main>`;
      await new Promise((resolve) => setTimeout(resolve, 200));

      const child = (id, name, endAt) => ({ kind: "job", outcome: "completed", id: String(id), name, state: "COMPLETED", exitCode: 0, signal: 0, cancelledBy: null, endAt, elapsedSec: 2280, nodes: "node03", partition: "CPU", diagnosis: null });
      const groupOf = (prefix, count, base, endAt) => ({
        kind: "group", outcome: "completed", key: `COMPLETED|${prefix}`, state: "COMPLETED", label: `${prefix}-*`, count,
        stages: [{ name: "cfd1", count }], firstEndAt: endAt - 6 * HOUR, lastEndAt: endAt, elapsedMinSec: 1800, elapsedMaxSec: 3700,
        nodeLists: ["node01", "node02", "node03"], partitions: ["CPU"], exits: [{ exitCode: 0, signal: 0, count }],
        children: Array.from({ length: Math.min(12, count) }, (_, i) => child(base - i, `${prefix}-35607b-cfd1`, endAt - i * 60_000)), more: Math.max(0, count - 12),
      });
      const failed = (id, name, endAt) => ({ kind: "job", outcome: "failed", id: String(id), name, state: "FAILED", exitCode: 1, signal: 0, cancelledBy: null, endAt, elapsedSec: 640, nodes: "node05", partition: "CPU", diagnosis: { category: "python", headline: "KeyError: 'arm'" } });
      const liveSnapshot = `live-${NOW - 60_000}`;
      const live = {
        schemaVersion: 1, serverId: "s", windowHours: 48, state: "ok", reason: null, user: "kai", checkedAt: NOW - 60_000, total: 602, kept: 602, truncated: false,
        summary: { ended: 602, completed: 601, failed: 1, cancelled: 0, other: 0, running: 0, pending: 0 },
        rows: [failed(18537, "arm_train", NOW - 2 * HOUR), groupOf("cfdauto-agiter20", 601, 18400, NOW - HOUR)], rowsOmitted: 0, snapshotId: liveSnapshot,
      };
      const dayResult = (from, endBefore) => {
        const end = Date.parse(`${from}T20:00:00+08:00`);
        return {
          schemaVersion: 1, serverId: "s", windowHours: null, state: "ok", reason: null, user: "kai", checkedAt: NOW, total: 41, kept: 41, truncated: false,
          summary: { ended: 41, completed: 38, failed: 2, cancelled: 1, other: 0, running: 0, pending: 0 },
          rows: [failed(17004, "xp_train", Number.isFinite(endBefore) ? endBefore - HOUR : end), failed(17003, "xp_train_b", end - HOUR), { ...child(17002, "scr3_eval", end - 2 * HOUR), outcome: "cancelled", state: "CANCELLED", cancelledBy: "1006" }, groupOf("cfa-sweep", 38, 16990, end - 3 * HOUR)],
          rowsOmitted: 0, snapshotId: `q${from.replaceAll("-", "")}`, query: { kind: "range", from, to: from, endBefore: endBefore ?? null },
          coverage: { kind: "range", from, to: from, endBefore: endBefore ?? null, keptFrom: null, rowsTotal: 50, tzKnown: true }, source: "ssh", fetchedAt: NOW, cached: false,
        };
      };
      const calls = [];
      const getJson = async (url) => {
        calls.push(url);
        const u = new URL(url, location.href);
        if (u.pathname === "/api/jobs") return structuredClone(live);
        if (u.pathname === "/api/jobs/diagnoses") return { items: [], groups: [] };
        if (u.pathname === "/api/jobs/group") {
          const limit = Number(u.searchParams.get("limit"));
          const total = u.searchParams.get("snapshot") === liveSnapshot ? 601 : 38;
          const n = Math.min(limit, total);
          return { snapshotId: u.searchParams.get("snapshot"), key: u.searchParams.get("key"), total, children: Array.from({ length: n }, (_, i) => child(18400 - i, "cfdauto-agiter20-35607b-cfd1", NOW - HOUR - i * 60_000)), more: total - n };
        }
        if (u.pathname === "/api/jobs/lookup") {
          if (u.searchParams.get("job")) {
            return { ...dayResult("2026-09-09"), summary: { ended: 3, completed: 3, failed: 0, cancelled: 0, other: 0, running: 0, pending: 0 }, rows: [child("13207_2", "v6_geom_full", NOW - 600 * HOUR), child("13207_1", "v6_geom_full", NOW - 600 * HOUR), child("13207_0", "v6_geom_full", NOW - 600 * HOUR)], snapshotId: "qjob13207", query: { kind: "job", job: "13207" }, source: "ssh" };
          }
          const from = u.searchParams.get("from");
          const endBefore = u.searchParams.get("endBefore");
          if (u.searchParams.get("to") !== from) {
            // 慢查询：用来验证迟到结果不覆盖后发的新查询
            await new Promise((resolve) => { window.__releaseSlow = resolve; });
            return { ...dayResult(from), snapshotId: "qslowrange" };
          }
          return dayResult(from, endBefore ? Number(endBefore) : undefined);
        }
        throw new Error(`unexpected ${url}`);
      };
      const { initClusterPanel, renderClusterPanel, resetClusterPanelState } = await import("/assets/js/render/cluster-panel.js");
      resetClusterPanelState();
      initClusterPanel({ getJson, isVisible: () => true, showToast: () => {} });
      const layer = { level: "ok", checkedAt: NOW, slurm: { state: "ok", user: "kai", checkedAt: NOW, jobs: [], nodes: [{ name: "node01", state: "idle", stateRaw: "idle", flags: [], partitions: ["CPU"], cpus: { alloc: 0, idle: 192, other: 0, total: 192 }, load: 1, memTotalMb: 350000, memFreeMb: 300000, memAllocMb: 0, gpus: null }] } };
      renderClusterPanel(layer, { id: "s" }, NOW);
      document.querySelector('[data-cl-mode="history"]').click();
      const body = () => document.getElementById("clusterHistoryBody");
      await until(() => body().querySelector('[data-cl-hist-group="COMPLETED|cfdauto-agiter20"]'), "48 小时历史没有渲染");
      assert(document.querySelector("#clusterHistorySummary .cl-mine-label").textContent === "近 48 小时", "默认视图仍是近 48 小时");

      // 组内加载更多：游标绑定 live 快照，0 SSH 的本机分页
      body().querySelector('[data-cl-hist-group="COMPLETED|cfdauto-agiter20"]').click();
      await until(() => body().querySelector("[data-cl-group-more]"));
      assert(body().querySelector("[data-cl-group-more]").textContent === "再显示 100 个", "组内加载按钮文案");
      body().querySelector("[data-cl-group-more]").click();
      await until(() => body().querySelectorAll('tr.cl-group-child[data-parent="COMPLETED|cfdauto-agiter20"][data-history-job-id]').length === 112, "组内没有加载到 112 条");
      assert(calls.some((c) => c.includes(`/api/jobs/group?serverId=s&snapshot=${liveSnapshot}&key=COMPLETED%7Ccfdauto-agiter20&limit=112`)), "分页请求带快照标识");
      body().querySelector('[data-cl-hist-group="COMPLETED|cfdauto-agiter20"]').click();

      // 更早…：先补 48 小时之前的那段，再往前一天
      document.querySelector("[data-cl-lookup-earlier]").click();
      await until(() => body().querySelectorAll("tr.cl-hist-seg").length === 1 && !body().querySelector("tr.cl-hist-seg").textContent.includes("正在查询"));
      assert(/endBefore=\d+$/.test(calls.find((c) => c.startsWith("/api/jobs/lookup"))), "第一段带 endBefore");
      document.querySelector("[data-cl-lookup-earlier]").click();
      await until(() => body().querySelectorAll("tr.cl-hist-seg").length === 2 && ![...body().querySelectorAll("tr.cl-hist-seg")].some((tr) => tr.textContent.includes("正在查询")));
      const segText = body().querySelectorAll("tr.cl-hist-seg")[1].textContent;
      assert(segText.includes("41 个已结束 · 2 失败 / 超时 · 1 取消"), `段头合计：${segText}`);
      assert(document.getElementById("clusterHistoryMore").textContent.includes("已往前加载到"), "表下写明覆盖范围");
      assert(!document.getElementById("clusterHistoryLookupReset").hidden, "有回查内容时显示「回到近 48 小时」");
      // 段内组可展开（key 带段前缀，不与 48 小时的同名组串）
      const segGroup = [...body().querySelectorAll("[data-cl-hist-group]")].find((tr) => tr.dataset.clHistGroup.endsWith("|COMPLETED|cfa-sweep"));
      segGroup.click();
      await until(() => body().querySelectorAll(`tr[data-parent="${segGroup.dataset.clHistGroup}"][data-history-job-id]`).length === 12);
      const wideState = { rows: body().querySelectorAll("tr").length };
      return { ok: true, wideState };
    }).toString()})()`);
    assert.equal(result.ok, true);
    assert.ok((await overflow()) <= 1, "宽窗不应横向溢出");
    await win.webContents.executeJavaScript('document.getElementById("clusterHistory").scrollIntoView({ block: "start" }); true');
    await shot("history-lookup-dark-wide.png");
    await win.webContents.executeJavaScript('document.body.dataset.theme = "light"; true');
    await shot("history-lookup-light-wide.png");

    // 查询框：认不出 → 提示不发请求；慢的日期查询被后发的作业号查询取代，迟到结果不覆盖
    const query = await win.webContents.executeJavaScript(`(${(async () => {
      const until = async (predicate, message) => {
        for (let i = 0; i < 100; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(message);
      };
      const input = document.getElementById("clusterHistoryQuery");
      const form = document.getElementById("clusterHistoryLookup");
      const submit = (text) => { input.value = text; form.requestSubmit(); };
      submit("abc");
      const hint = document.getElementById("clusterHistoryLookupHint").textContent;
      submit("09-28~10-01");
      await new Promise((resolve) => setTimeout(resolve, 50));
      submit("13207");
      await until(() => document.querySelector("#clusterHistorySummary .cl-mine-label")?.textContent === "作业 13207", "作业号查询结果没有显示");
      return { hint, label: document.querySelector("#clusterHistorySummary .cl-mine-label").textContent, rows: [...document.querySelectorAll("#clusterHistoryBody [data-history-job-id]")].map((tr) => tr.dataset.historyJobId) };
    }).toString()})()`);
    assert.match(query.hint, /认不出/);
    assert.deepEqual(query.rows, ["13207_2", "13207_1", "13207_0"]);
    // 放出慢查询的应答：不得覆盖作业号查询
    const after = await win.webContents.executeJavaScript(`(async () => {
      window.__releaseSlow?.();
      await new Promise((r) => setTimeout(r, 150));
      return { released: typeof window.__releaseSlow === "function", label: document.querySelector("#clusterHistorySummary .cl-mine-label").textContent, rows: document.querySelectorAll("#clusterHistoryBody [data-history-job-id]").length };
    })()`);
    assert.equal(after.released, true, "慢查询确实在途过");
    assert.equal(after.rows, 3);
    assert.equal(after.label, "作业 13207");
    await win.webContents.executeJavaScript('document.body.dataset.theme = ""; document.getElementById("clusterHistory").scrollIntoView({ block: "start" }); true');
    await shot("history-lookup-query-dark-wide.png");

    win.setSize(520, 900);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok((await overflow()) <= 1, "窄窗（520）查询结果不应横向溢出");
    await win.webContents.executeJavaScript('document.getElementById("clusterHistory").scrollIntoView({ block: "start" }); true');
    await shot("history-lookup-query-dark-narrow.png");
    // 回到近 48 小时：恢复默认视图，并看窄窗下的段头 / 加载更多
    const back = await win.webContents.executeJavaScript(`(${(async () => {
      document.getElementById("clusterHistoryLookupReset").click();
      for (let i = 0; i < 50 && document.querySelector("#clusterHistorySummary .cl-mine-label")?.textContent !== "近 48 小时"; i += 1) await new Promise((r) => setTimeout(r, 20));
      document.querySelector("[data-cl-lookup-earlier]").click();
      for (let i = 0; i < 100 && !document.querySelector("#clusterHistoryBody tr.cl-hist-seg .cl-hist-seg-text")?.textContent.includes("已结束"); i += 1) await new Promise((r) => setTimeout(r, 20));
      document.querySelector('[data-cl-hist-group="COMPLETED|cfdauto-agiter20"]').click();
      await new Promise((r) => setTimeout(r, 50));
      document.getElementById("clusterHistory").scrollIntoView({ block: "start" });
      return { label: document.querySelector("#clusterHistorySummary .cl-mine-label").textContent, segs: document.querySelectorAll("#clusterHistoryBody tr.cl-hist-seg").length };
    }).toString()})()`);
    assert.deepEqual(back, { label: "近 48 小时", segs: 1 });
    assert.ok((await overflow()) <= 1, "窄窗（520）段头与加载更多不应横向溢出");
    await shot("history-lookup-dark-narrow.png");
    await win.webContents.executeJavaScript('document.body.dataset.theme = "light"; true');
    await shot("history-lookup-light-narrow.png");
    await win.webContents.executeJavaScript('import("/assets/js/render/cluster-panel.js").then((m) => { m.resetClusterPanelState(); return true; })');
    return result;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
