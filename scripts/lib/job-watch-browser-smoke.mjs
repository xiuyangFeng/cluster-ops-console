// 真实 Chromium 中验证作业关注/进度/资源复盘/通知交互。只使用隔离 DOM 与注入的内存 API，零 SSH。
// baseUrl 必须是隔离的本机测试服务；使用一个不存在的静态页建立同源环境，不加载 app.js。
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function runJobWatchBrowserSmoke({ BrowserWindow, baseUrl, screenshotDir = null }) {
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  try {
    await win.loadURL(`${baseUrl}/job-watch-ui-fixture`);
    const result = await win.webContents.executeJavaScript(`(${(async () => {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const until = async (predicate) => {
        for (let i = 0; i < 60; i += 1) {
          if (predicate()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error("作业界面状态更新超时");
      };
      const NOW = Date.now();
      document.documentElement.dataset.theme = "dark";
      document.head.innerHTML = `<meta charset="utf-8">${["/styles.css", "/assets/css/tiles.css", "/assets/css/cluster.css", "/assets/css/dialogs.css", "/assets/css/jobs-watch.css"].map((href) => `<link rel="stylesheet" href="${href}">`).join("")}`;
      document.body.innerHTML = '<main style="padding:24px"><button id="jobNotificationsBtn" class="btn btn-secondary">作业提醒 <span id="jobNotificationsCount" hidden></span></button>' +
        '<section id="clusterPanel" class="panel panel-cluster"><div class="panel-header"><h2>集群节点与队列</h2></div><div class="cl-body">' +
        '<div class="cl-section"><div id="clusterQueueMode"><button data-cl-mode="queue">当前队列</button><button data-cl-mode="history">我的历史</button></div>' +
        '<div id="clusterFilters"></div><div id="clusterQueueView"><div id="clusterMine"></div><table class="cl-jobs"><tbody id="clusterJobsBody"></tbody></table></div>' +
        '<div id="clusterHistoryFilters"></div><div id="clusterHistory"><div id="clusterHistorySummary"></div><div id="clusterHistoryCauses"></div><table class="cl-jobs cl-jobs-history"><tbody id="clusterHistoryBody"></tbody></table><p id="clusterHistoryNote"></p></div></div></div></section>' +
        '<dialog id="jobNotificationsDialog" class="hud-dialog dialog-wide"><header class="dialog-header"><h2>作业提醒</h2></header><div id="jobNotificationsBody" class="dialog-body"></div></dialog></main>';
      const { initClusterPanel, renderClusterPanel, resetClusterPanelState, focusClusterJob, refreshClusterWatches } = await import('/assets/js/render/cluster-panel.js');
      const { createJobNotificationsController } = await import('/assets/js/app/job-notifications-controller.js');
      let notificationRequests = 0;
      let quietUntil = 0;
      const navigated = [];
      const writes = [];
      const toastEvents = [];
      let watches = [];
      // v2.62：提醒不一定属于关注组——失败提醒的 watchId 为 null、kind 为 failed，点开去「我的历史」；
      // 默认规则下的头一条带 intro（浮层顶部说明它是默认开启的）。
      let notifications = [
        { id: "notice-1", serverId: "s", watchId: "w", kind: "ended", title: "实验组已结束", body: "3 个完成", jobIds: ["1"], createdAt: NOW, readAt: null },
        { id: "notice-failed", serverId: "s", watchId: null, kind: "failed", title: "作业失败：finished", body: "退出码 1，原因待查。作业号 12。详情见「我的历史」。", jobIds: ["12"], createdAt: NOW - 1000, readAt: null, intro: true },
      ];
      const resources = [{ jobId: "12", name: "finished", state: "COMPLETED", allocCpus: 8, requestedMemoryBytes: 8 * 1024 ** 3, maxRssBytes: 2 * 1024 ** 3, totalCpuSeconds: 300, elapsedSeconds: 60, cpuEfficiency: 0.625, timeLimitSeconds: 240 * 60, requestedGpus: 1, gpuUtilPeak: 96, gpuMemoryPeakBytes: 10 * 1024 ** 3,
        assessments: [{ resource: "内存", kind: "over", text: "申请可能过量" }], sbatch: "#SBATCH --mem=3072M", adviceNote: "用于同规模小样本试跑，保留 GPU 型号与卡数。" }];
      // v2.62 提醒规则：按服务器的视图带 rules / suggestions，全局收件箱把各台的规则列在 servers 里。
      let rules = { failNotify: true, longRunMinutes: null, patterns: [] };
      const suggestions = () => [{ prefix: "solo", pattern: "solo*", count: 3 }].filter((item) => !rules.patterns.includes(item.pattern));
      const payload = () => ({ serverId: "s", watches, resources, settings: { quietUntil, silenceMinutes: 30, limitMinutes: 30 }, notifications, rules, suggestions: suggestions(),
        servers: [{ serverId: "s", name: "演示集群服务器 (demo)", rules, suggestions: suggestions() }] });
      // failInboxRead：让全局收件箱的下一次读取失败（模拟一次 30 秒轮询失败）。
      let failInboxRead = false;
      const getJson = async (url) => {
        if (url === "/api/jobs/watch" && failInboxRead) throw new Error("HTTP 503");
        if (url.startsWith("/api/jobs/watch")) return structuredClone(payload());
        if (url.startsWith("/api/jobs/diagnoses")) return { items: [], groups: [] };
        return { state: "ok", checkedAt: NOW, summary: { ended: 1, completed: 1, failed: 0 }, rows: [{ kind: "job", id: "12", name: "finished", outcome: "completed", state: "COMPLETED", endAt: NOW, elapsedSec: 60 }] };
      };
      const postJson = async (_url, body) => {
        writes.push(body);
        if (body.action === "watch") watches = [{ id: "watch-1", label: body.label, jobIds: body.jobIds, muted: false, jobs: body.jobIds.map((id) => ({ id, name: "train", state: "RUNNING", outcome: "running", progress: { status: "stalled", step: 100, epoch: 2, lastLogAt: NOW - 3600000, detail: "连续两轮 Step 100 未变化；日志 60 分钟无更新，仅提示疑似停滞。", tail: "epoch=2 step=100 loss=0.2\n<img src=x onerror=alert(1)>" } })) }];
        if (body.action === "mute") watches[0].muted = body.muted;
        if (body.action === "unwatch") {
          // 自动组的移除 = 停用产生它的那条规则。
          const gone = watches.find((w) => w.id === body.watchId);
          if (gone?.auto) rules = { ...rules, patterns: rules.patterns.filter((p) => `name:${p}` !== gone.auto.rule) };
          watches = gone?.auto ? watches.filter((w) => w !== gone) : [];
        }
        if (body.action === "rules") {
          // 与后端同样的合并：开关 / 阈值直接覆盖，名字规则只加 / 只删一条；存过规则后提醒上的 intro 标记摘掉。
          const { action: _action, addPattern, removePattern, ...patch } = body;
          rules = { ...rules, ...patch, patterns: [...rules.patterns.filter((p) => p !== removePattern), ...(addPattern && !rules.patterns.includes(addPattern) ? [addPattern] : [])] };
          notifications = notifications.map(({ intro: _intro, ...rest }) => rest);
          watches = watches.filter((w) => !w.auto || rules.patterns.some((p) => `name:${p}` === w.auto.rule));
          for (const pattern of rules.patterns) {
            if (!watches.some((w) => w.auto?.rule === `name:${pattern}`)) watches = [...watches, { id: `auto-${pattern}`, label: pattern, auto: { rule: `name:${pattern}` }, jobIds: ["4"], muted: false, jobs: [{ id: "4", name: "solo_run", state: "RUNNING", outcome: "running", progress: { status: "ok", step: 7, epoch: 1, lastLogAt: NOW - 60000, detail: "仅根据日志更新判断活动；安静不等于训练停止。", tail: "epoch=1 step=7" } }] }];
          }
        }
        if (body.action === "settings" && body.quietUntil !== undefined) quietUntil = body.quietUntil || 0;
        if (body.action === "ack") notifications = notifications.map((n) => ({ ...n, readAt: NOW }));
        return structuredClone(payload());
      };
      resetClusterPanelState();
      initClusterPanel({ getJson, postJson, isVisible: () => true, showToast: (item) => toastEvents.push(item) });
      await until(() => getComputedStyle(document.getElementById("clusterJobWatch")).display === "flex");
      const jobs = [1, 2, 3].map((id) => ({ id: String(id), name: "experiment", user: "me", state: "RUNNING", elapsedSec: 100, timeLimitSec: 1000, cpus: 8, nodeList: "node01" }));
      // 第 4 个作业单独成行：之后由提醒规则 solo* 自动关注。
      jobs.push({ id: "5", name: "waiting_gpu", user: "me", state: "PENDING", reason: "QOSMaxGRESPerUser", startAt: NOW + 3600000, cpus: 8, gpus: 1 });
      jobs.push({ id: "6", name: "waiting_priority", user: "me", state: "PENDING", reason: "Priority", startAt: NOW + 3600000, cpus: 8, gpus: 1 });
      jobs.push({ id: "4", name: "solo_run", user: "me", state: "RUNNING", elapsedSec: 100, timeLimitSec: 1000, cpus: 8, nodeList: "node01" });
      renderClusterPanel({ level: "ok", checkedAt: NOW, slurm: { state: "ok", user: "me", checkedAt: NOW, jobs, nodes: [] } }, { id: "s" }, NOW);
      await until(() => document.querySelector('[data-job-watch="1,2,3"]'));
      assert(document.querySelector('[data-confidence="medium"]'), "新鲜回填预计开始标中等可信度");
      const quotaRow = [...document.querySelectorAll('.cl-job-num')].find(el => el.textContent === "5").closest('tr').nextElementSibling;
      quotaRow.querySelector('summary').click();
      assert(quotaRow.querySelector('details').open && quotaRow.textContent.includes("正在使用的卡数"), "个人 GPU 配额原因展开后提供操作建议");
      assert(quotaRow.querySelector('[data-confidence="low"]'), "有配额阻塞的预计开始标低可信度");
      await new Promise(r => setTimeout(r, 20));
      renderClusterPanel({ level: "ok", checkedAt: NOW + 1000, slurm: { state: "ok", user: "me", checkedAt: NOW + 1000, jobs, nodes: [] } }, { id: "s" }, NOW + 1000);
      assert(document.querySelector('[data-jw-queue="5"]').open, "新一轮采样保留已展开的排队解释");
      document.querySelector('[data-job-watch="1,2,3"]').click();
      await until(() => document.querySelectorAll('[data-watch-job-id]').length === 3);
      assert(writes[0].jobIds.join(",") === "1,2,3", "关注实验组必须发送实际成员");
      assert(document.querySelector('[data-job-watch="1,2,3"]').disabled, "关注后队列按钮应同步");
      assert(document.querySelector('[data-cl-group]').getAttribute("aria-expanded") === "false", "点击关注不能误展开实验组");
      document.querySelector('[data-watch-evidence="1"]').click();
      assert(document.querySelector('.jw-evidence').textContent.includes("Step 100"), "展开后应展示停滞依据");
      assert(!document.querySelector('.jw-evidence img'), "日志 HTML 必须作为原文显示");
      document.querySelector('[data-watch-mute]').click();
      await until(() => document.querySelector('[data-watch-mute]').textContent === "取消静音");
      assert(await focusClusterJob("1"), "通知应能聚焦关注作业");
      document.querySelector('[data-cl-mode="history"]').click();
      await until(() => document.querySelector('[data-job-resource="12"]'));
      document.querySelector('[data-job-resource="12"]').click();
      assert(document.querySelector('.jw-review-row').textContent.includes("62.5%"), "资源复盘展示记账效率");
      assert(document.querySelector('.jw-review-row').textContent.includes("96%（非时间平均）"), "GPU 记账高水位不能误标为平均效率");
      let copiedSbatch = "";
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { copiedSbatch = text; } } });
      document.querySelector('[data-copy-sbatch]').click();
      await until(() => copiedSbatch === "#SBATCH --mem=3072M");
      await until(() => document.querySelector('[data-copy-sbatch]').textContent === "已复制 SBATCH 建议");
      assert(await focusClusterJob("12"), "不在关注列表的作业应回落历史定位");
      assert(document.activeElement.dataset.historyJobId === "12", "历史作业获得定位焦点");
      assert(!(await focusClusterJob("9999")), "历史之外的作业不能伪造定位成功");
      assert(toastEvents.at(-1).title === "作业定位", "不可定位应有可见说明");
      class BrowserNotification {
        static permission = "default";
        static async requestPermission() { notificationRequests += 1; BrowserNotification.permission = "granted"; }
        constructor() { throw new Error("此用例不应主动发送系统通知"); }
      }
      const notices = createJobNotificationsController({ doc: document, getJson, postJson, BrowserNotification, storage: null, showToast: () => {}, onNavigate: (...args) => navigated.push(args) });
      notices.bind();
      await notices.start();
      assert(notificationRequests === 0, "不可自动弹浏览器权限请求");
      document.getElementById("jobNotificationsBtn").click();
      assert(document.getElementById("jobNotificationsDialog").open, "提醒按钮打开收件箱");
      const inbox = document.getElementById("jobNotificationsBody");
      assert(inbox.textContent.includes("这是默认开启的失败提醒，可在提醒规则里关掉"), "头一条默认失败提醒未读时，浮层顶部说明来历");
      // v2.62 提醒规则：默认收起；展开后开关按数据勾上，建议一键加成名字规则，阈值改了即存。
      assert(!document.querySelector(".jw-rules-body"), "提醒规则默认收起");
      assert(document.querySelector(".jw-rules-head").textContent.includes("失败提醒已开"), "收起时标题行写出现状");
      document.querySelector('[data-rules-toggle="s"]').click();
      await until(() => document.querySelector('[data-rule-fail="s"]'));
      assert(document.querySelector('[data-rule-fail="s"]').checked, "失败提醒默认开着，开关按数据勾上");
      document.querySelector('[data-rule-suggest="solo*"]').click();
      await until(() => document.querySelector(".jw-rule-list code")?.textContent === "solo*");
      assert(writes.at(-1).action === "rules" && writes.at(-1).addPattern === "solo*" && writes.at(-1).patterns === undefined, "建议一键加成名字规则，只发要加的那一条");
      assert(!document.querySelector("[data-rule-suggest]"), "加成规则的不再当建议");
      assert(!inbox.textContent.includes("这是默认开启的失败提醒"), "自己存过规则之后，「默认开启」那句当即消失");
      const threshold = document.querySelector('[data-rule-long="s"]');
      threshold.value = "120";
      threshold.dispatchEvent(new Event("change", { bubbles: true }));
      await until(() => writes.at(-1).longRunMinutes === 120);
      await until(() => document.querySelector(".jw-rules-head").textContent.includes("运行超过 120 分钟自动关注"));
      assert(document.querySelector(".jw-rules-body"), "保存后规则一节仍展开着");
      // 上方提示行来去（一次轮询失败）不重建规则表单：正在打的规则与键盘焦点都留着。
      const draft = document.querySelector('.jw-rule-add input[name="pattern"]');
      draft.focus();
      draft.value = "cfa-agi";
      failInboxRead = true;
      await notices.refresh();
      assert(inbox.textContent.includes("提醒暂时无法刷新"), "轮询失败时上方出现提示");
      assert(draft.isConnected && document.activeElement === draft && draft.value === "cfa-agi", "提示出现时，正在打的规则与焦点不丢");
      failInboxRead = false;
      await notices.refresh();
      assert(!inbox.textContent.includes("提醒暂时无法刷新"), "恢复后提示消失");
      assert(draft.isConnected && document.activeElement === draft && draft.value === "cfa-agi", "提示消失时也不丢");
      // 失败提醒开关：拨一下，保存期间不弹回旧值。
      const failSwitch = document.querySelector('[data-rule-fail="s"]');
      failSwitch.click();
      assert(failSwitch.checked === false, "拨到关");
      await until(() => writes.at(-1).failNotify === false);
      await until(() => document.querySelector(".jw-rules-head").textContent.includes("失败提醒已关"));
      assert(document.querySelector('[data-rule-fail="s"]').checked === false, "保存后开关停在关");
      document.querySelector('[data-rule-fail="s"]').click();
      await until(() => document.querySelector(".jw-rules-head").textContent.includes("失败提醒已开"));
      // 规则命中的作业自动进组：关注区带「自动」标记，移除入口是「停用这条规则」。
      await refreshClusterWatches();
      await until(() => document.querySelector('.jw-watch[data-auto="true"]'));
      const autoGroup = document.querySelector('.jw-watch[data-auto="true"]');
      assert(autoGroup.querySelector(".badge")?.textContent === "自动", "自动组带「自动」标记");
      assert(autoGroup.querySelector("[data-watch-remove]").textContent === "停用这条规则", "自动组的移除入口是停用规则");
      assert(autoGroup.querySelector('[data-watch-job-id="4"]'), "规则命中的作业列在自动组里");
      const solo = document.querySelector('[data-job-watch="4"]');
      assert(solo && !solo.disabled && solo.textContent === "关注", "自动关注着的作业在队列里仍可以手动关注");
      document.querySelector('[data-notices-browser]').click();
      await until(() => notificationRequests === 1);
      document.querySelector('[data-notices-quiet]').click();
      await until(() => document.querySelector('[data-notices-quiet]').textContent === "结束免打扰");
      document.querySelector('[data-notice-open]').click();
      await until(() => navigated.length === 1);
      assert(navigated[0].join(",") === "s,1", "提醒点击传递精确服务器与作业");
      await until(() => document.getElementById("jobNotificationsCount").hidden);
      // 失败提醒（没有 watchId）：点开带「我的历史」目标，并能定位到历史里的那一行。
      document.getElementById("jobNotificationsBtn").click();
      assert(!inbox.textContent.includes("这是默认开启的失败提醒"), "存过规则、读过之后都不再说明");
      document.querySelector('[data-notice-open="notice-failed"]').click();
      await until(() => navigated.length === 2);
      assert(navigated[1].join(",") === "s,12,history", "失败提醒点开去我的历史");
      assert(!document.getElementById("jobNotificationsDialog").open, "点开后收件箱收起");
      assert(await focusClusterJob("12", "history"), "失败提醒定位到历史里的作业");
      assert(document.activeElement.dataset.historyJobId === "12", "焦点落在历史行上");
      // 停用规则：自动组随之撤掉。
      document.querySelector('.jw-watch[data-auto="true"] [data-watch-remove]').click();
      await until(() => !document.querySelector('.jw-watch[data-auto="true"]'));
      assert(writes.at(-1).action === "unwatch" && rules.patterns.length === 0, "停用规则后名字规则清空");
      notices.stop();
      // 截图保留关注进度与复盘展开状态；停止后台计时器。
      resetClusterPanelState();
      return { ok: true, interactions: 27, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
    }).toString()})()`);
    assert.equal(result.ok, true);
    assert.equal(result.horizontalOverflow, false, "作业界面不应出现页面级横向滚动");
    if (screenshotDir) {
      const image = await win.webContents.capturePage();
      await writeFile(path.join(screenshotDir, "jobs-watch.png"), image.toPNG());
    }
    win.setSize(520, 900);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth + 1'), true, "窄窗资源复盘不应横向溢出");
    await win.webContents.executeJavaScript('document.body.dataset.theme = "light"; true');
    if (screenshotDir) await writeFile(path.join(screenshotDir, "jobs-watch-light-narrow.png"), (await win.webContents.capturePage()).toPNG());
    return result;
  } finally { if (!win.isDestroyed()) win.destroy(); }
}
