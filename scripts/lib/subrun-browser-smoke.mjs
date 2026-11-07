// 真实 Chromium 中验证编排型作业的子任务进度（关注区「进度依据」）与排队行的预计开始时间（v2.51）。
// 只使用隔离 DOM 与注入的内存 API，零 SSH；深色 / 浅色 × 1028 / 520 宽各截一张，并检查页面级横向溢出。
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function runSubrunBrowserSmoke({ BrowserWindow, baseUrl, screenshotDir = null }) {
  const win = new BrowserWindow({ show: false, width: 1028, height: 1100, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try {
    await win.loadURL(`${baseUrl}/subrun-ui-fixture`);
    const result = await win.webContents.executeJavaScript(`(${(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const until = async (predicate) => {
        for (let i = 0; i < 80; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("子任务界面状态更新超时");
      };
      const NOW = Date.now();
      document.head.innerHTML = `<meta charset="utf-8">${["/styles.css", "/assets/css/tiles.css", "/assets/css/cluster.css", "/assets/css/dialogs.css", "/assets/css/jobs-watch.css"].map((href) => `<link rel="stylesheet" href="${href}">`).join("")}`;
      document.body.innerHTML = '<main style="padding:16px">' +
        '<section id="clusterPanel" class="panel panel-cluster"><div class="panel-header"><h2>集群节点与队列</h2></div><div class="cl-body">' +
        '<div class="cl-section"><div id="clusterQueueMode"><button data-cl-mode="queue">当前队列</button><button data-cl-mode="history">我的历史</button></div>' +
        '<div id="clusterFilters"></div><div id="clusterQueueView"><div id="clusterMine"></div><table class="cl-jobs"><tbody id="clusterJobsBody"></tbody></table></div>' +
        '<div id="clusterHistoryFilters"></div><div id="clusterHistory"><div id="clusterHistorySummary"></div><div id="clusterHistoryCauses"></div><table class="cl-jobs cl-jobs-history"><tbody id="clusterHistoryBody"></tbody></table><p id="clusterHistoryNote"></p></div></div></div></section></main>';
      const { initClusterPanel, renderClusterPanel, resetClusterPanelState } = await import("/assets/js/render/cluster-panel.js");
      const run = (name, phase, extra = {}) => ({ run: name, phase, attempt: 1, launchAt: NOW - 42 * 60000, status: "running", ambiguous: false, ...extra });
      const textLog = (epoch, hist, eta = true) => ({ format: "text", missing: false, lastLogAt: NOW - 50000, epoch, total: 400, metrics: [["loss", hist.at(-1)], ["norm_mae", 0.2256], ["norm_rmse", 0.3364], ["lr", 0.000631]], best: true, primary: "loss", history: hist, restarted: false, lastLine: "", eta: eta ? { endLo: NOW + 3.4 * 3600000, endHi: NOW + 3.6 * 3600000, points: 6, secPerEpoch: 55.5 } : null, etaNote: eta ? null : "最近几个 epoch 速度波动较大，不估算" });
      const subruns = {
        launched: 46, ended: 44, failed: 1, orphanEnds: 0, runningCount: 3, ambiguous: 0, finalized: false, finalNote: null, catchingUp: false, checkedAt: NOW,
        gaps: [],
        running: [
          run("VFG_f0_s1234", "train", { log: textLog(380, [0.181, 0.176, 0.171, 0.168, 0.165, 0.162, 0.16, 0.158, 0.1572]) }),
          run("X5G_f3_s1234_with_a_rather_long_run_label", "train", { log: textLog(177, [0.16, 0.158, 0.155, 0.1519], false) }),
          run("VFB_f4_s1234", "eval_last", { launchAt: NOW - 90000, log: { format: "unknown", missing: false, lastLogAt: NOW - 16000, epoch: null, metrics: [], history: [], lastLine: "[test] cases=50  R2_casemean=0.8209  R2_field_raw=0.8401  NRMSE_field=0.0369  <b>MAE</b>=0.2140", eta: null, etaNote: null } }),
        ],
        failedRuns: [{ run: "PFG_f1_s1234", phase: "eval_best", attempt: 1, code: 1, endAt: NOW - 25 * 60000, status: "failed", orphan: false }],
        recent: [{ run: "VFB_f3_s1234", phase: "eval_last", endAt: NOW - 4 * 60000, status: "ok" }, { run: "VFB_f2_s1234", phase: "eval_last", endAt: NOW - 7 * 60000, status: "ok" }],
        unended: [],
      };
      const watches = [{ id: "w1", label: "wallgate_vol", jobIds: ["18764", "18779"], muted: false, jobs: [
        { id: "18764", name: "xp_wallgate_vol_v52e_20261006", state: "RUNNING", outcome: "running", progress: { status: "ok", lastLogAt: NOW - 16000, detail: "根据 stdout 与正在跑的子任务日志是否更新判断活动；安静不等于训练停止。", path: "/exp/wallgate_vol/logs/xp_18764.log", tail: "2026-10-06T14:16:05+0800 LAUNCH VFG_f0_s1234 train GPU-0" }, subruns },
        { id: "18779", name: "xp_cycle_next", state: "PENDING", outcome: "pending", progress: null, subruns: null },
      ] }];
      const getJson = async (url) => {
        if (url.startsWith("/api/jobs/watch")) return { serverId: "s", watches: structuredClone(watches), resources: [], settings: { quietUntil: 0, silenceMinutes: 30, limitMinutes: 30 }, notifications: [] };
        if (url.startsWith("/api/jobs/diagnoses")) return { items: [], groups: [] };
        return { state: "ok", checkedAt: NOW, summary: { ended: 0 }, rows: [] };
      };
      resetClusterPanelState();
      initClusterPanel({ getJson, postJson: async () => ({}), isVisible: () => true, showToast: () => {} });
      const startAt = NOW + 13.7 * 3600000;
      const jobs = [
        { id: "18764", name: "xp_wallgate_vol_v52e_20261006", user: "me", state: "RUNNING", elapsedSec: 22000, timeLimitSec: 86400, cpus: 16, gpus: 1, nodeList: "master" },
        { id: "18779", name: "xp_cycle_next", user: "me", state: "PENDING", reason: "Resources", startAt, waitSec: 1800, cpus: 16, gpus: 1 },
        { id: "18790", name: "someone_else", user: "other", state: "PENDING", reason: "Priority", startAt, waitSec: 600, cpus: 8 },
      ];
      renderClusterPanel({ level: "ok", checkedAt: NOW, slurm: { state: "ok", user: "me", checkedAt: NOW - 20000, jobs, nodes: [] } }, { id: "s" }, NOW);
      await until(() => document.querySelector('[data-watch-evidence="18764"]'));
      const sum = document.querySelector('[data-watch-job-id="18764"] .jw-subrun-sum');
      assert(sum && sum.textContent === "子任务 已启动 46 · 已结束 44 · 失败 1 · 正在跑 3", "作业行带子任务摘要");
      document.querySelector('[data-watch-evidence="18764"]').click();
      await until(() => document.querySelector(".jw-subruns"));
      const box = document.querySelector(".jw-subruns");
      assert(box.closest(".jw-evidence"), "子任务并入进度依据，不新开面板");
      assert(box.querySelectorAll('[data-status="running"]').length === 3, "并行子任务逐个列出");
      assert(box.querySelector(".jw-spark"), "有内联走势");
      assert(!box.querySelector("b"), "远端原文转义");
      assert(/总子任务数未知/.test(box.textContent), "写明口径");
      const rows = [...document.querySelectorAll("#clusterJobsBody tr")];
      const mine = rows.find((tr) => tr.textContent.includes("18779"));
      const other = rows.find((tr) => tr.textContent.includes("18790"));
      // 预计开始时间在作业行下方「原因与建议」行的摘要里（始终可见），带可信度
      const mineHelp = mine.nextElementSibling;
      assert(mineHelp?.classList.contains("jw-queue-row"), "本人排队作业下方有原因与建议行");
      assert(/预计 (明天 )?\d{2}:\d{2} 开始 · \d{2}:\d{2} 估算 · 中等可信度/.test(mineHelp.querySelector("summary").textContent), "本人排队作业显示预计开始时间与可信度");
      assert(!other.textContent.includes("预计") && !other.nextElementSibling?.classList.contains("jw-queue-row"), "他人作业不显示");
      document.getElementById("clusterPanel").scrollIntoView();
      return { ok: true };
    }).toString()})()`);
    assert.equal(result.ok, true);
    const shots = [];
    for (const [width, theme] of [[1028, "dark"], [1028, "light"], [520, "dark"], [520, "light"]]) {
      win.setSize(width, 1100);
      await win.webContents.executeJavaScript(`${theme === "light" ? 'document.body.setAttribute("data-theme", "light")' : 'document.body.removeAttribute("data-theme")'}; true`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const overflow = await win.webContents.executeJavaScript("document.documentElement.scrollWidth > innerWidth + 1");
      assert.equal(overflow, false, `${width}px ${theme} 不应出现页面级横向滚动`);
      if (screenshotDir) {
        const file = `subruns-${theme}-${width}.png`;
        await writeFile(path.join(screenshotDir, file), (await win.webContents.capturePage()).toPNG());
        shots.push(file);
      }
    }
    await win.webContents.executeJavaScript('import("/assets/js/render/cluster-panel.js").then((m) => m.resetClusterPanelState()); true');
    return { ...result, shots };
  } finally { if (!win.isDestroyed()) win.destroy(); }
}
