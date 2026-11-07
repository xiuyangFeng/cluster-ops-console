// app/settings-access.js —— 配置浮层「接入引导」那一行下面的接入管理（v2.62）：这个账号在集群登记目录里
// 名下的端口、释放闲置端口，以及「撤销接入」（命令行 npm run setup:undo 的界面版）。不新增面板、不另开浮层：
// 预览、确认与逐步结果都在这一块里就地展开。
//
// 读：打开配置时 GET /api/onboarding/access。本机已知的部分立刻返回；端口登记要 SSH 去读，后端在后台读、
//     回 registry.pending，这里隔一秒再取。没接入过（available=false）时整块不显示。
// 写：释放 → 行内确认 → POST …/release-port；
//     撤销 → POST …/undo/preview（只读预览）→ 勾选是否同时释放端口 →「确认撤销」→ POST …/undo/run。
//     撤销在后台逐步执行，这里每秒取一次进度（关掉配置浮层也接着取，结束时提示一次），
//     做完后列出没有自动处理的内容。
// 文案由后端给（步骤标题、明细、后果说明、收尾清单），这里只负责排版。
// 骨架在 index.html（#settingsAccess），这里只重写它的内容；按钮与勾选都走事件委托。
import { escapeHtml } from "../store.js";

export const ACCESS_POLL_MS = 1000;
// 读接口不等 SSH（端口登记在后台读），正常立刻返回。时限仍比读请求默认的 10 秒给得宽：这一次没读到，
// 整块就不出现，要等下次打开配置才再读——机器很忙、控制面一时回得慢时，不该为此让入口消失。
const READ_TIMEOUT_MS = 30000;

const STEP_STATUS_TEXT = { pending: "等待", running: "进行中", ok: "完成", skipped: "无需处理", failed: "没有成功", "not-run": "没有执行" };
// 「闲置」是推断出来的：登记在名下、这台电脑没在用、此刻没人监听。它也可能是同一个账号的另一台电脑配着的
// （那台现在没连上）——登记文件里不记是哪台电脑领的，这里分不出来，释放之前说一声。
const OTHER_COMPUTER_NOTE = "如果你的另一台电脑还配着这个端口（只是现在没连上），先别释放。";

// 纯函数：一行登记端口的状态说明。
export function describePort(row) {
  if (row.current) return "这台电脑在用";
  if (row.listening) return "正在被监听，可能是你另一台电脑在用";
  return "闲置";
}

// 纯函数：端口登记这一段。confirmPort = 正在问「确认释放？」的端口；releasing = 请求已发出的端口。
export function buildPortsHtml(view, { confirmPort = null, releasing = null, locked = false } = {}) {
  const registry = view?.registry;
  if (!registry) return "";
  const notes = [];
  if (registry.error) {
    // 有动作在做（预览、撤销、释放）时「重试」和别的入口一样先按住。
    notes.push(`<p class="acc-note">${escapeHtml(`读不到集群上的端口登记：${registry.error.message || "原因未知"}。`)}<button type="button" class="text-btn" data-acc-retry${registry.pending || locked ? " disabled" : ""}>重试</button></p>`);
  } else if (registry.checkedAt == null) {
    // 第一次还没读回来：只在确实在读的时候占一行。
    if (registry.pending) notes.push('<p class="acc-note">正在读取集群上的端口登记…</p>');
  } else if (view.port != null && registry.state !== "ok") {
    notes.push(`<p class="acc-note">${escapeHtml(`集群上没有可用的端口登记目录，这台电脑在用的端口 ${view.port} 没有登记。`)}</p>`);
  } else if (registry.current && registry.current.owner !== "me") {
    const whose = registry.current.owner === "other" ? `登记在 ${registry.current.name || "别人"} 名下` : "没有登记";
    notes.push(`<p class="acc-note">${escapeHtml(`这台电脑在用的端口 ${registry.current.port} ${whose}。`)}</p>`);
  }
  const rows = (registry.ports || []).map((row) => {
    const port = escapeHtml(String(row.port));
    let tail = "";
    if (confirmPort === row.port) {
      // base：团队最早的生产端口（7891），放掉之后工作台不会再把它分给任何人。
      const consequence = row.base
        ? `${row.port} 是团队最早的生产端口：释放后登记会删除，工作台不会再把它分给任何人（包括你）。`
        : `释放后端口 ${row.port} 的登记会删除，别人可以领用它。这台电脑不受影响。`;
      tail = `<div class="acc-confirm">
        <p>${escapeHtml(`${consequence}${OTHER_COMPUTER_NOTE}`)}</p>
        <div class="acc-actions">
          <button type="button" class="btn btn-secondary" data-acc-release-go="${port}"${releasing ? " disabled" : ""}>${releasing === row.port ? "正在释放…" : "确认释放"}</button>
          <button type="button" class="text-btn" data-acc-release-cancel${releasing ? " disabled" : ""}>取消</button>
        </div>
      </div>`;
    } else if (row.releasable) {
      tail = `<div class="acc-actions"><button type="button" class="text-btn" data-acc-release="${port}"${locked ? " disabled" : ""}>释放</button></div>`;
    }
    return `<li class="acc-row">
      <div class="acc-row-text"><strong class="acc-port">${port}</strong><small class="acc-state">${escapeHtml(describePort(row))}</small></div>
      ${tail}
    </li>`;
  }).join("");
  if (!rows && !notes.length) return "";
  const hint = rows
    ? `<p class="acc-hint">${escapeHtml(`${registry.me ? `登记在 ${registry.me} 名下。` : ""}闲置的端口可以释放给别人用；在用的随「撤销接入」一起释放。`)}</p>`
    : "";
  return `<div class="acc-ports">
    <p class="acc-title">端口登记</p>
    ${rows ? `<ul class="acc-list">${rows}</ul>` : ""}${hint}${notes.join("")}
  </div>`;
}

// 纯函数：撤销的预览与确认。release = 「同时释放端口」有没有勾上；submitting = 「确认撤销」已点、还没回话。
export function buildPreviewHtml(preview, { release = false, submitting = false } = {}) {
  const steps = (preview.steps || []).map((step) => {
    const detail = step.effect === "none" ? step.note : (step.items || []).join("；");
    return `<li class="acc-plan-item${step.effect === "none" ? " is-none" : ""}">
      <span class="acc-plan-title">${escapeHtml(step.title || "")}</span>
      ${detail ? `<span class="acc-plan-detail">${escapeHtml(detail)}</span>` : ""}
    </li>`;
  }).join("");
  const notes = (preview.notes || []).map((note) => `<p class="acc-note">${escapeHtml(note)}</p>`).join("");
  if (preview.nothingToUndo) {
    return `<div class="acc-panel">
      <p class="acc-panel-title">撤销接入</p>
      <p class="acc-lead">${escapeHtml(`${preview.host} 上没有发现工作台写下的配置，没有需要撤销的内容。`)}</p>
      ${notes}
      <div class="acc-actions"><button type="button" class="text-btn" data-acc-undo-cancel>关闭</button></div>
    </div>`;
  }
  const option = preview.release;
  const canRelease = option?.available === true;
  const willRelease = canRelease && release;
  const releaseBlock = option
    ? `<div class="acc-release">
        ${canRelease ? `<label class="acc-check"><input type="checkbox" data-acc-release-toggle${release ? " checked" : ""}${submitting ? " disabled" : ""}>${escapeHtml(`同时释放端口 ${option.port}`)}</label>` : ""}
        ${option.note ? `<p class="acc-hint">${escapeHtml(option.note)}</p>` : ""}
      </div>`
    : "";
  const consequence = willRelease ? preview.consequences?.release : preview.consequences?.keep;
  return `<div class="acc-panel">
    <p class="acc-panel-title">撤销接入</p>
    <p class="acc-lead">${escapeHtml(`会在 ${preview.host} 上做下面这些事。你自己的文件（启动文件、settings.json）改之前先留一份备份：`)}</p>
    <ul class="acc-plan">${steps}</ul>
    ${notes}${releaseBlock}
    ${consequence ? `<p class="acc-consequence">${escapeHtml(consequence)}</p>` : ""}
    <div class="acc-actions">
      <button type="button" class="btn btn-danger" data-acc-undo-go${submitting ? " disabled" : ""}>${submitting ? "正在开始…" : willRelease ? "确认撤销并释放端口" : "确认撤销"}</button>
      <button type="button" class="text-btn" data-acc-undo-cancel${submitting ? " disabled" : ""}>取消</button>
    </div>
  </div>`;
}

// 纯函数：一次撤销的进度 / 结果。
export function buildJobHtml(job) {
  const running = job.status === "running";
  const title = running ? "正在撤销接入…" : job.status === "ok" ? "已撤销接入" : "撤销没有做完";
  const steps = (job.steps || []).map((step) => {
    const manual = step.manual
      ? `<details class="acc-manual"><summary>可以在服务器上手动执行的命令</summary><pre class="ob-code"><code>${escapeHtml(step.manual)}</code></pre><div class="acc-actions"><button type="button" class="text-btn" data-acc-copy="${escapeHtml(step.id)}">复制</button></div></details>`
      : "";
    return `<li class="acc-step is-${escapeHtml(step.status)}">
      <span class="acc-step-title">${escapeHtml(step.title || "")}</span>
      <span class="acc-step-state">${escapeHtml(STEP_STATUS_TEXT[step.status] || "")}</span>
      ${step.detail ? `<span class="acc-step-detail">${escapeHtml(step.detail)}</span>` : ""}${manual}
    </li>`;
  }).join("");
  const leftovers = !running && job.leftovers?.length
    ? `<details class="acc-leftovers"><summary>没有自动处理的内容（${job.leftovers.length} 项），按需自查</summary><ul class="acc-leftover-list">${job.leftovers.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></details>`
    : "";
  return `<div class="acc-panel is-${escapeHtml(job.status)}" aria-live="polite">
    <p class="acc-panel-title">${title}</p>
    <ul class="acc-steps">${steps}</ul>
    ${!running && job.summary ? `<p class="acc-summary">${escapeHtml(job.summary)}</p>` : ""}
    ${leftovers}
    ${running ? "" : '<div class="acc-actions"><button type="button" class="btn btn-secondary" data-acc-job-close>知道了</button></div>'}
  </div>`;
}

// 纯函数：整块内容。没接入过 / 还没读到 → ""（调用方把整块藏起来）。
// ui: { confirmPort, releasing, flow: null | { stage: "previewing" } | { stage: "confirm", preview, release, submitting }, jobId }
export function buildAccessHtml(view, ui = {}) {
  const job = view?.undo && (view.undo.status === "running" || view.undo.id === ui.jobId) ? view.undo : null;
  // 撤销并释放端口之后，这台电脑可能就算"没接入"了（没有端口，个人配置里也没记集群账号——命令行向导接入的
  // 就是这样）：端口表与入口不再显示，但这一次撤销的逐步结果和收尾清单照样留着，点「知道了」才收起。
  if (!view?.available) return job ? buildJobHtml(job) : "";
  const flow = ui.flow || null;
  // 有动作在做（或正在走撤销流程）时，别的入口先按住。
  const locked = Boolean(view.busy || flow || job?.status === "running" || ui.releasing);
  const ports = buildPortsHtml(view, { confirmPort: ui.confirmPort ?? null, releasing: ui.releasing ?? null, locked });
  let undo;
  if (job) undo = buildJobHtml(job);
  else if (flow?.stage === "confirm") undo = buildPreviewHtml(flow.preview, { release: flow.release === true, submitting: flow.submitting === true });
  else {
    const previewing = flow?.stage === "previewing";
    undo = `<div class="acc-entry">
      <button type="button" class="btn btn-secondary" data-acc-undo${locked ? " disabled" : ""}>${previewing ? "正在查看集群上的配置…" : "撤销接入…"}</button>
      <small class="acc-hint">删除工作台在集群上写下的代理配置。先列出会改什么，确认后才执行。</small>
    </div>`;
  }
  return `${ports}${undo}`;
}

export function createSettingsAccess({
  doc, getJson, postJson, showToast, copyText = async () => false,
  // 撤销 / 释放之后让背后的工作台跟上（个人配置、隧道状态都可能变了）。
  refresh = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  bodyId = "settingsAccess", dialogId = "dlgSettings",
}) {
  const $ = (id) => doc.getElementById(id);
  const isOpen = () => Boolean($(dialogId)?.open);
  let view = null;
  let confirmPort = null;
  let releasing = null;
  let flow = null;
  // 这个页面发起（或接手）的那次撤销：只显示它的结果，点「知道了」收起。
  let jobId = null;
  let announcedJobId = null;
  let timer = null;
  let lastHtml = null;
  // 每次发请求 +1：先发后到的旧「读」响应不采用（只管 view 用哪一份）。
  // 流程走到哪一步不看它，看 flow 还是不是发请求时的那一个——中途插进来一次读（轮询、重试），
  // 预览 / 撤销的回话照样要接住，否则按钮会一直停在「正在…」上。
  let seq = 0;

  const errText = (err) => err?.serverMessage || err?.message || "未知错误";
  const jobRunning = () => view?.undo?.status === "running";

  function render() {
    const body = $(bodyId);
    if (!body) return;
    const html = buildAccessHtml(view, { confirmPort, releasing, flow, jobId });
    // 内容没变就不动：轮询期间不打断正在展开的折叠块与键盘焦点。
    if (html !== lastHtml) {
      body.innerHTML = html;
      lastHtml = html;
    }
    body.hidden = html === "";
  }

  function stopPolling() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  // 撤销在跑：关不关浮层都接着取（结束要提示）。只是在等端口登记读回来：浮层开着才取。
  function schedulePoll() {
    stopPolling();
    if (jobRunning() || (isOpen() && (view?.registry?.pending || view?.busy))) timer = setTimer(poll, ACCESS_POLL_MS);
  }

  function announce(job) {
    if (announcedJobId === job.id) return;
    announcedJobId = job.id;
    if (job.status === "ok") showToast({ type: "success", title: "撤销接入", message: job.summary || "已撤销。" });
    else showToast({ type: "error", title: "撤销没有做完", message: job.summary || "有一步没有成功。" });
    Promise.resolve(refresh({ force: true })).catch(() => {});
  }

  function adopt(next) {
    const wasRunning = jobRunning();
    view = next;
    const job = next?.undo;
    // 页面刷新后接手还在跑的那一次。
    if (job?.status === "running") {
      jobId = job.id;
      flow = null;
    } else if (job && job.id === jobId && wasRunning) {
      announce(job);
    }
    // 登记表变了：正在问的那个端口已经不能放了就收起确认。
    if (confirmPort != null && !next?.registry?.ports?.some((row) => row.port === confirmPort && row.releasable)) confirmPort = null;
    render();
    schedulePoll();
  }

  async function load({ fresh = false } = {}) {
    stopPolling();
    const mine = ++seq;
    try {
      const next = await getJson(`/api/onboarding/access${fresh ? "?fresh=1" : ""}`, { timeoutMs: READ_TIMEOUT_MS });
      if (mine === seq) adopt(next);
    } catch {
      // 读不到不占地方：保留手里的内容，下次打开配置再读。撤销在跑时下一拍再试。
      if (mine === seq) schedulePoll();
    }
  }

  function poll() {
    timer = null;
    return load();
  }

  async function release(port) {
    if (releasing != null) return;
    releasing = port;
    stopPolling();
    const mine = ++seq;
    render();
    try {
      const res = await postJson("/api/onboarding/access/release-port", { port, serverId: view?.server?.id });
      releasing = null;
      confirmPort = null;
      // clearedStaleConfig：个人配置里还留着这个端口的旧记录（没在生效），后端顺手清掉了。
      const stale = res?.clearedStaleConfig ? "个人配置里它留下的旧记录也清掉了。" : "";
      showToast({ type: "success", title: "端口登记", message: `${res?.result === "absent" ? `端口 ${port} 的登记已经不在了。` : `端口 ${port} 已释放。`}${stale}` });
      if (mine === seq && res?.access) adopt(res.access);
      else render();
    } catch (err) {
      releasing = null;
      confirmPort = null;
      showToast({ type: "error", title: "没有释放", message: errText(err) });
      render();
      // 登记可能与页面上的不一样了（已被别处释放、正在被监听……）：重读一遍。
      load({ fresh: true });
    }
  }

  async function startPreview() {
    if (flow || jobRunning()) return;
    const mine = { stage: "previewing" };
    flow = mine;
    confirmPort = null;
    stopPolling();
    seq += 1;
    render();
    try {
      const res = await postJson("/api/onboarding/access/undo/preview", { serverId: view?.server?.id });
      // 等的时候流程被收起了（关了浮层）：这次预览不采用。
      if (flow !== mine) return;
      // 默认不释放端口：只是暂时不用的话，下次接入沿用同一个。
      flow = { stage: "confirm", preview: res.preview, release: false, submitting: false };
      if (res.access) view = res.access;
      render();
    } catch (err) {
      if (flow !== mine) return;
      flow = null;
      showToast({ type: "error", title: "撤销接入", message: errText(err) });
      render();
      schedulePoll();
    }
  }

  async function runUndo() {
    if (flow?.stage !== "confirm" || flow.submitting) return;
    const { preview, release: wantRelease } = flow;
    const mine = { ...flow, submitting: true };
    flow = mine;
    seq += 1;
    render();
    try {
      const res = await postJson("/api/onboarding/access/undo/run", {
        serverId: preview.serverId,
        previewId: preview.previewId,
        releasePort: preview.release?.available === true && wantRelease === true,
      });
      // 等的时候轮询已经看到撤销在跑、接手了（adopt 里收起了流程）：不必再接一遍。
      if (flow !== mine) return;
      flow = null;
      jobId = res?.access?.undo?.id ?? null;
      adopt(res.access);
    } catch (err) {
      if (flow !== mine) return;
      // 预览过期 / 配置变了 / 别的任务占着：收起确认，照后端给的原因提示，想继续就重新预览。
      flow = null;
      showToast({ type: "error", title: "没有开始撤销", message: errText(err) });
      render();
      load();
    }
  }

  async function copyManual(stepId) {
    const text = view?.undo?.steps?.find((step) => step.id === stepId)?.manual;
    if (text && await copyText(text)) showToast({ type: "info", title: "撤销接入", message: "已复制，粘贴到服务器上的终端里运行" });
  }

  function onClick(event) {
    const hit = (selector) => {
      const el = event.target?.closest?.(selector);
      return el && !el.disabled ? el : null;
    };
    const releaseBtn = hit("[data-acc-release]");
    if (releaseBtn) {
      confirmPort = Number(releaseBtn.dataset.accRelease);
      return render();
    }
    if (hit("[data-acc-release-cancel]")) {
      confirmPort = null;
      return render();
    }
    const releaseGo = hit("[data-acc-release-go]");
    if (releaseGo) return release(Number(releaseGo.dataset.accReleaseGo));
    if (hit("[data-acc-retry]")) return load({ fresh: true });
    if (hit("[data-acc-undo]")) return startPreview();
    if (hit("[data-acc-undo-cancel]")) {
      flow = null;
      render();
      return schedulePoll();
    }
    if (hit("[data-acc-undo-go]")) return runUndo();
    if (hit("[data-acc-job-close]")) {
      jobId = null;
      return render();
    }
    const copyBtn = hit("[data-acc-copy]");
    if (copyBtn) return copyManual(copyBtn.dataset.accCopy);
    return undefined;
  }

  // 勾 / 不勾「同时释放端口」：后果说明与按钮上的字跟着变。重画后把焦点还给勾选框。
  function onChange(event) {
    const toggle = event.target?.closest?.("[data-acc-release-toggle]");
    if (!toggle || flow?.stage !== "confirm" || flow.submitting) return;
    flow = { ...flow, release: toggle.checked === true };
    render();
    $(bodyId)?.querySelector?.("[data-acc-release-toggle]")?.focus?.();
  }

  function bind() {
    const body = $(bodyId);
    body?.addEventListener("click", onClick);
    body?.addEventListener("change", onChange);
    $(dialogId)?.addEventListener("close", () => {
      // 没点确认的东西关掉就收起（预览还在路上的话，回来了也不采用）；撤销在跑则接着盯到结束。
      confirmPort = null;
      if (flow && !flow.submitting) {
        flow = null;
        seq += 1;
      }
      render();
      schedulePoll();
    });
  }

  function onOpen() {
    return load();
  }

  bind();
  return { onOpen, load, poll, getState: () => ({ view, confirmPort, releasing, flow, jobId, polling: timer !== null }) };
}
