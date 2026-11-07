// bootstrap-panel.js —— 离线安装 Agent 面板（原"离线安装向导"；与 npm run setup 配置向导不是一回事）：7 步固定列表、每步独立执行、
// 执行后 2s 轮询 /api/bootstrap/state 直至该步离开 running；复制命令走剪贴板。
// 版本查询串必须与 app.js 的导入一致，否则浏览器会实例化第二份模块（token 状态分裂）。
// 面板位于 dlgBootstrap 浮层内，打开浮层时由 app.js 的 onDialogOpen 钩子拉取。
import { fetchApi, postJson } from "./api.js";
import { copyText } from "./dom-utils.js";

const POLL_MS = 2000;
// 轮询兜底上限：步骤卡在 running（后端重启丢状态）或接口一直失败时不能无限 2s 空转。
// 离线安装最慢的步骤（本机构建）约几分钟，15 分钟足够；到点停下后重开浮层会重新拉取。
const POLL_MAX_MS = 15 * 60 * 1000;
const POLL_MAX_FAILURES = 10;

const STATUS_META = {
  pending: { cls: "bs-chip-pending", label: "待执行" },
  running: { cls: "bs-chip-running", label: "执行中" },
  success: { cls: "bs-chip-success", label: "成功" },
  fail: { cls: "bs-chip-fail", label: "失败" },
};

async function getBootstrapState() {
  const res = await fetchApi("/api/bootstrap/state");
  return res.json();
}

// keyed 渲染：每步一行，行内节点按 data-step 复用增量更新，避免整块 innerHTML 重建。
export function createBootstrapPanel({ listEl } = {}) {
  const rowById = new Map();
  const polling = new Set(); // 正在轮询的 step id

  function ensureRow(step) {
    let row = rowById.get(step.id);
    if (row) return row;
    const el = document.createElement("div");
    el.className = "bs-row";
    el.dataset.step = step.id;
    el.innerHTML = `
      <div class="bs-row-head">
        <span class="bs-chip"></span>
        <span class="bs-name"></span>
        <span class="bs-kind"></span>
        <span class="bs-actions">
          <button class="text-btn bs-run">执行</button>
          <button class="text-btn bs-copy">复制命令</button>
        </span>
      </div>
      <div class="bs-summary"></div>`;
    el.querySelector(".bs-run").addEventListener("click", () => runStep(step.id));
    el.querySelector(".bs-copy").addEventListener("click", () => copyCommand(step.id));
    if (listEl) listEl.appendChild(el);
    row = {
      el,
      chip: el.querySelector(".bs-chip"),
      name: el.querySelector(".bs-name"),
      kind: el.querySelector(".bs-kind"),
      summary: el.querySelector(".bs-summary"),
      runBtn: el.querySelector(".bs-run"),
      command: "",
    };
    rowById.set(step.id, row);
    return row;
  }

  function renderStep(step) {
    const row = ensureRow(step);
    const meta = STATUS_META[step.status] || STATUS_META.pending;
    row.chip.className = `bs-chip ${meta.cls}`;
    row.chip.textContent = meta.label;
    row.name.textContent = step.name || step.id;
    row.kind.textContent = step.kind === "remote" ? "远端" : "本地";
    // W5：平台不支持的步骤（win32 上的本机构建）禁用执行并直接说明原因。
    const summaryText = step.disabled ? (step.disabledReason || "当前平台不支持此步骤") : (step.summary || "");
    row.summary.textContent = summaryText;
    row.summary.style.display = summaryText ? "block" : "none";
    row.runBtn.disabled = step.status === "running" || step.disabled === true;
    row.runBtn.title = step.disabled ? (step.disabledReason || "") : "";
    row.command = step.copyCommand || "";
  }

  function render(state) {
    const steps = (state?.steps) || [];
    for (const step of steps) renderStep(step);
  }

  async function refresh() {
    try {
      render(await getBootstrapState());
    } catch {
      // 拉取失败保留上一帧。
    }
  }

  async function copyCommand(id) {
    const row = rowById.get(id);
    if (!row?.command) return;
    // 剪贴板不可用时 copyText 弹可全选的输入框兜底，此时不显示"已复制"。
    if (!(await copyText(row.command))) return;
    const btn = row.el.querySelector(".bs-copy");
    const prev = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => { btn.textContent = prev; }, 1500);
  }

  function pollUntilDone(id) {
    if (polling.has(id)) return;
    polling.add(id);
    const startedAt = Date.now();
    let failures = 0;
    const stop = () => {
      clearInterval(timer);
      polling.delete(id);
    };
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > POLL_MAX_MS) {
        stop();
        return;
      }
      let state;
      try {
        state = await getBootstrapState();
      } catch {
        failures += 1;
        if (failures >= POLL_MAX_FAILURES) stop();
        return; // 下轮重试
      }
      failures = 0;
      render(state);
      const step = (state.steps || []).find((s) => s.id === id);
      if (step?.status !== "running") stop();
    }, POLL_MS);
  }

  async function runStep(id) {
    try {
      const res = await postJson(`/api/bootstrap/step/${id}/run`, {});
      if (res && res.started === false) return;
    } catch (err) {
      // 非 2xx（404 未知步骤 / 500 后端异常）也要刷新面板并留下痕迹，
      // 静默返回会让"点了执行毫无反应"，用户无从判断。
      console.error(`bootstrap step ${id} 触发失败: ${err?.message}`);
      await refresh();
      return;
    }
    await refresh();
    pollUntilDone(id);
  }

  return { refresh };
}
