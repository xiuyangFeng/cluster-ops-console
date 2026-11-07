// 真实 Chromium 中验证 v2.51「读取前一段」：关注区「进度依据」与「我的历史」失败诊断两个入口。
// 只用隔离 DOM 与注入的内存 API（/api/jobs/log-segment 由页面内假实现应答），零 SSH。
// 覆盖：读第一段 → 继续向前读（阅读位置不跳）→ 切 stderr → 文件身份失效后只给「从当前末尾重新读取」→
// 诊断详情读一段并附取证时保存的末尾；深 / 浅两种主题 × 1028 / 520 两种宽度不横向溢出，可选截图。
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function runLogReadbackBrowserSmoke({ BrowserWindow, baseUrl, screenshotDir = null }) {
  const win = new BrowserWindow({ show: false, width: 1028, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const shot = async (name) => {
    if (!screenshotDir) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
    await writeFile(path.join(screenshotDir, name), (await win.webContents.capturePage()).toPNG());
  };
  const overflow = () => win.webContents.executeJavaScript("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  try {
    await win.loadURL(`${baseUrl}/log-readback-ui-fixture`);
    const result = await win.webContents.executeJavaScript(`(${(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const until = async (predicate, message = "日志读取界面状态更新超时") => {
        for (let i = 0; i < 100; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(message);
      };
      const NOW = Date.now();
      document.head.innerHTML = `<meta charset="utf-8">${["/styles.css", "/assets/css/tiles.css", "/assets/css/cluster.css", "/assets/css/dialogs.css", "/assets/css/jobs-watch.css"].map((href) => `<link rel="stylesheet" href="${href}">`).join("")}`;
      document.body.innerHTML = '<main style="padding:24px"><section id="clusterPanel" class="panel panel-cluster"><div class="panel-header"><h2>集群节点与队列</h2></div><div class="cl-body">' +
        '<div class="cl-section"><div id="clusterQueueMode"><button data-cl-mode="queue">当前队列</button><button data-cl-mode="history">我的历史</button></div>' +
        '<div id="clusterFilters"></div><div id="clusterQueueView"><div id="clusterMine"></div><table class="cl-jobs"><tbody id="clusterJobsBody"></tbody></table></div>' +
        '<div id="clusterHistoryFilters"></div><div id="clusterHistory"><div id="clusterHistorySummary"></div><div id="clusterHistoryCauses"></div><table class="cl-jobs cl-jobs-history"><tbody id="clusterHistoryBody"></tbody></table><p id="clusterHistoryNote"></p></div></div></div></section></main>';
      const { initClusterPanel, renderClusterPanel, resetClusterPanelState } = await import("/assets/js/render/cluster-panel.js");
      const lines = (from, to) => `${Array.from({ length: to - from }, (_, i) => `[${String(from + i).padStart(5, "0")}] epoch=3 step=${(from + i) * 10} loss=${(1 / (from + i + 1)).toFixed(4)} <b>not-html</b>`).join("\n")}\n`;
      const tail = "epoch=3 step=9990 loss=0.0010\nepoch=3 step=10000 loss=0.0009\n";
      const segments = [];
      const progress = { status: "ok", checkedAt: NOW - 60_000, lastLogAt: NOW - 70_000, step: 10000, epoch: 3, detail: "仅根据日志更新判断活动；安静不等于训练停止。", path: "/public/home/kai/exp/logs/xp_18765.log", tail };
      const watches = [{ id: "watch-1", label: "wallgate_main", jobIds: ["18765"], muted: false, jobs: [{ id: "18765", name: "xp_wallgate_main_v52e", state: "RUNNING", outcome: "running", progress }] }];
      const history = {
        state: "ok", serverId: "s", checkedAt: NOW - 30_000, windowHours: 48, summary: { ended: 1, completed: 0, failed: 1, cancelled: 0 },
        rows: [{ kind: "job", id: "18006_0", name: "velocity_phase", outcome: "failed", state: "FAILED", exitCode: 1, endAt: NOW - 3600_000, elapsedSec: 640, nodes: "node05", diagnosis: { category: "python", headline: "KeyError: 'arm'" } }],
      };
      const diagnoses = { items: [{ jobId: "18006_0", serverId: "s", category: "python", headline: "KeyError: 'arm'", state: "FAILED", evidence: ["Traceback (most recent call last):", "KeyError: 'arm'"], hasScript: false, source: "submitline",
        files: [{ path: "/public/home/kai/exp/logs/train_18006_0.log", role: "stdout", size: 5821856, tail: "…" }, { path: "/public/home/kai/exp/logs/train_18006_0.err", role: "stderr", size: 860, tail: "" }, { path: "/public/home/kai/exp/logs/arm_MIR_18006.log", role: "sibling", size: 4096, tail: "" }] }], groups: [] };
      const getJson = async (url) => {
        if (url.startsWith("/api/jobs/watch")) return structuredClone({ serverId: "s", watches, resources: [], settings: { quietUntil: 0, silenceMinutes: 30, limitMinutes: 30 }, notifications: [] });
        if (url.startsWith("/api/jobs/diagnoses")) return structuredClone(diagnoses);
        if (url.startsWith("/api/jobs/log-segment")) {
          const p = new URL(url, location.origin).searchParams;
          segments.push(Object.fromEntries(p));
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (p.get("log") === "stderr" && p.get("from") === "watch") {
            throw Object.assign(new Error("HTTP 409"), { status: 409, code: "rotated", serverMessage: "日志文件已被替换（轮转或重新创建），旧的读取位置已失效" });
          }
          if (p.get("from") === "diagnosis") {
            return { jobId: "18006_0", from: "diagnosis", log: p.get("log"), role: "stdout", path: diagnoses.items[0].files[0].path, start: 5784000, end: 5816000, size: 5821856, dropped: 41, noBreak: false, text: lines(800, 1200), atStart: false,
              next: { before: 5784000, ino: "607892232", size: 5821856, mtimeMs: 1791065169000, sig: `64-${"a".repeat(40)}` }, anchorText: "Traceback (most recent call last):\n  File \"train.py\", line 88\nKeyError: 'arm'\n", anchorCheckedAt: null, continuous: true, notes: [], cached: false };
          }
          const before = Number(p.get("before") || 400000);
          const start = before - 32000;
          const from = Math.floor(start / 80);
          return { jobId: "18765", from: "watch", log: "stdout", role: "stdout", path: progress.path, start, end: before, size: 400064, dropped: 37, noBreak: false, text: lines(from, from + 400), atStart: false,
            next: { before: start, ino: "620835679", size: 400064, mtimeMs: NOW - 70_000, sig: `64-${"b".repeat(40)}` }, anchorText: null, anchorCheckedAt: progress.checkedAt, continuous: true, notes: [], cached: false };
        }
        if (url.startsWith("/api/jobs")) return structuredClone(history);
        return {};
      };
      resetClusterPanelState();
      initClusterPanel({ getJson, postJson: async () => ({}), isVisible: () => true, showToast: () => {} });
      const jobs = [{ id: "18765", name: "xp_wallgate_main_v52e", user: "kai", state: "RUNNING", elapsedSec: 3600, timeLimitSec: 86400, cpus: 8, nodeList: "node04" }];
      renderClusterPanel({ level: "ok", checkedAt: NOW, slurm: { state: "ok", user: "kai", checkedAt: NOW, jobs, nodes: [] } }, { id: "s" }, NOW);
      await until(() => document.querySelector('[data-watch-evidence="18765"]'), "关注列表没有出现");
      document.querySelector('[data-watch-evidence="18765"]').click();
      const readBtn = () => document.querySelector('#clusterJobWatch [data-lr-action="read"]');
      await until(() => readBtn(), "「进度依据」里没有读取前一段");
      assert(readBtn().textContent === "读取前一段", "初始按钮文案");
      readBtn().click();
      await until(() => document.querySelector("#clusterJobWatch .lr-pre"), "第一段没有显示");
      const pre = () => document.querySelector("#clusterJobWatch .lr-pre");
      assert(segments[0].from === "watch" && segments[0].log === "stdout" && !("before" in segments[0]), "第一段不带游标");
      assert(!pre().querySelector("b") && pre().textContent.includes("<b>not-html</b>"), "日志原文按文本显示");
      assert(Math.abs(pre().scrollHeight - pre().clientHeight - pre().scrollTop) <= 2, "第一段滚到底，紧挨下方末尾");
      const evidence = document.querySelector("#clusterJobWatch .jw-evidence");
      const order = [...evidence.children].map((el) => el.className);
      assert(order.indexOf("lr") < order.indexOf("cl-diag-pre"), "读到的更早内容在「进度依据」末尾上方");
      // 用户往上滚到中间再继续读：正在看的那几行不跳。
      pre().scrollTop = 120;
      const bottomBefore = pre().scrollHeight - pre().scrollTop;
      const firstLineAtView = pre().textContent.length;
      readBtn().click();
      await until(() => segments.length === 2 && !document.querySelector("#clusterJobWatch .lr-read[disabled]"), "第二段没有读完");
      assert(segments[1].before === String(400000 - 32000) && segments[1].ino === "620835679", "继续读取带回游标");
      assert(pre().textContent.length > firstLineAtView, "第二段插在前面");
      assert(Math.abs(pre().scrollHeight - pre().scrollTop - bottomBefore) <= 2, "追加时阅读位置不跳");
      assert(readBtn().textContent === "继续向前读取", "已读后按钮文案");
      // 切到 stderr：旧游标失效 → 只给「从当前末尾重新读取」。
      document.querySelector('#clusterJobWatch [data-lr-action="pick"][data-lr-log="stderr"]').click();
      readBtn().click();
      await until(() => document.querySelector('#clusterJobWatch [data-lr-action="restart"]'), "身份失效后没有给出重新读取");
      assert(document.querySelector("#clusterJobWatch .lr .jw-note[data-level=warn]").textContent.includes("已失效"), "明确提示旧位置失效");
      document.querySelector('#clusterJobWatch [data-lr-action="pick"][data-lr-log="stdout"]').click();
      await until(() => pre() && pre().textContent.length > firstLineAtView, "切回 stdout 保留已读内容");
      const watchOverflow = document.documentElement.scrollWidth > innerWidth + 1;

      // 我的历史：失败诊断详情读一段，附取证时保存的末尾。
      document.querySelector('[data-cl-mode="history"]').click();
      await until(() => document.querySelector('[data-cl-diag="18006_0"]'), "历史诊断行没有出现");
      document.querySelector('.cl-diag-line[data-cl-diag="18006_0"]').click();
      const diagRead = () => document.querySelector('#clusterHistoryBody [data-lr-action="read"]');
      await until(() => diagRead(), "诊断详情里没有读取前一段");
      const labels = [...document.querySelectorAll('#clusterHistoryBody [data-lr-action="pick"]')].map((b) => b.textContent);
      assert(labels.join(",") === "stdout,stderr,同号日志 arm_MIR_18006.log", `诊断文件选项：${labels}`);
      diagRead().click();
      await until(() => document.querySelector("#clusterHistoryBody .lr-anchor"), "诊断详情没有显示取证时保存的末尾");
      assert(segments.at(-1).from === "diagnosis" && segments.at(-1).log === "0", "诊断入口按文件序号读取");
      assert(document.querySelector("#clusterHistoryBody .lr-pre").textContent.includes("[00800]"), "诊断段落显示");
      assert(document.querySelector('.cl-diag-line[data-cl-diag="18006_0"]'), "点读取按钮不收起诊断详情");
      return { ok: true, requests: segments.length, watchOverflow, docOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
    }).toString()})()`);
    assert.equal(result.ok, true);
    assert.equal(result.watchOverflow, false, "关注区读取后不应横向溢出");
    assert.equal(result.docOverflow, false, "诊断详情读取后不应横向溢出");
    await win.webContents.executeJavaScript('document.querySelector("#clusterHistoryBody .lr")?.scrollIntoView({ block: "center" }); true');
    await shot("log-readback-dark-1028-history.png");
    await win.webContents.executeJavaScript('document.querySelector(\'[data-cl-mode="queue"]\').click(); document.querySelector("#clusterJobWatch").scrollIntoView(); true');
    await shot("log-readback-dark-1028-watch.png");
    for (const [theme, width] of [["dark", 520], ["light", 520], ["light", 1028]]) {
      await win.webContents.executeJavaScript(`(() => { if (${JSON.stringify(theme)} === "light") document.body.setAttribute("data-theme", "light"); else document.body.removeAttribute("data-theme"); return true; })()`);
      win.setSize(width, 1000);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.ok((await overflow()) <= 1, `关注区 ${theme} ${width}px 不应横向溢出`);
      await shot(`log-readback-${theme}-${width}-watch.png`);
      await win.webContents.executeJavaScript('document.querySelector(\'[data-cl-mode="history"]\').click(); true');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.ok((await overflow()) <= 1, `诊断详情 ${theme} ${width}px 不应横向溢出`);
      await win.webContents.executeJavaScript('document.querySelector("#clusterHistoryBody .lr")?.scrollIntoView({ block: "center" }); true');
      await shot(`log-readback-${theme}-${width}-history.png`);
      await win.webContents.executeJavaScript('document.querySelector(\'[data-cl-mode="queue"]\').click(); document.querySelector("#clusterJobWatch").scrollIntoView(); true');
    }
    await win.webContents.executeJavaScript('(async () => { (await import("/assets/js/render/cluster-panel.js")).resetClusterPanelState(); return true; })()');
    return result;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
