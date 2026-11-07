// app/settings-cli.js —— 配置浮层「命令行工具」一节（v2.57 第 2 期）：集群上 Codex / Claude Code 的
// 安装、更新与回滚的唯一操作处。不新增面板；Agent 卡片上的「可更新到 x」chip 与详情里的「安装…」
// 经 openFor({ cli, action }) 打开配置浮层、展开本节并直接进入同一个确认（render/overview.js 的 [data-cli-manage]）。
//
// 读：打开配置时 GET /api/cli（已装版本来自 cli:<serverId> 探针，最新版来自本机查 npm）。
// 写：每个动作先行内确认（同远端守护进程面板的两步式），确认后 POST /api/cli/:id/install 或 /rollback，
//     带 serverId（切服瞬间后端 409）。安装在后台跑：浮层开着时每 2 秒 GET /api/cli/jobs/:jobId
//     显示阶段 / 进度 / 速度 / 剩余时间；关掉浮层就停表，下次打开从 /api/cli 的 job 接着显示。
//     进行中的任务可以取消（同样两步式）：POST /api/cli/jobs/:jobId/cancel，后端结束集群上的安装任务 /
//     停下载 / 清半截上传后回话，任务变成「已取消」、锁释放，可以马上再装或去登录；落盘 / 切软链期间
//     （job.cancellable=false）按钮禁用。密码连接的服务器（概览带 fallbackUnavailable）不给「直接用本机下载」。
// 团队缓存（v2.89）：与概览并行 GET /api/cli/team-cache，列出集群共享目录里已有的安装包——有的话安装直接在集群内
//     拷贝（几秒、不走外网）；管理员（isAdmin）多一个「发布到团队缓存」（同样两步式确认，进度显示在同一个任务块里）。
// 骨架在 index.html（#settingsCli），这里只重写 #settingsCliBody；按钮都走事件委托。
import { escapeHtml, formatBytes } from "../store.js";

export const CLI_JOB_POLL_MS = 2000;
// 浮层关着时任务还在跑：接着轮询但放慢。停表的话，装完 / 装失败都没有任何提示，Agent 卡片也要等到
// 下一次 5 分钟一轮的 /api/cli 才变（一次安装要几分钟，中途关掉浮层去做别的很常见）。
export const CLI_JOB_POLL_CLOSED_MS = 5000;
// 结束提示每个任务只发一次。同一套界面有两个宿主（配置浮层、接入引导最后一页），各有一份控制器，
// 可能同时盯着同一个任务，所以缺省共用这一份记录（单测各传各的）。
const sharedNotifiedJobs = new Set();
const CLI_ORDER = ["codex", "claude"];
// 官方产物大约多大（确认框里提醒慢隧道要等多久；以 2026-10 的版本为准，只是量级）。
const APPROX_SIZE = { codex: "约 160MB", claude: "约 250MB" };
const KIND_TEXT = { standalone: "官方独立安装", native: "官方原生安装", npm: "npm 全局安装", unknown: "安装方式未知" };
const PATH_TEXT = { official: "集群经隧道运行官方安装器", fallback: "本机下载后上传", cache: "团队缓存（集群内拷贝）", publish: "已写入团队缓存" };
// 占着这台服务器任务锁的是谁（后端 lib/cli/task-lock.mjs 的 kind）；「撤销接入」在配置 → 接入引导下面。
const BUSY_KIND_TEXT = { login: "登录", rollback: "回滚", undo: "撤销接入", publish: "发布到团队缓存", smoke: "测试对话" };

// 纯函数：秒 → "约 3 分钟" / "约 1 小时 5 分"。
export function formatEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec < 60) return "不到 1 分钟";
  const min = Math.round(sec / 60);
  if (min < 60) return `约 ${min} 分钟`;
  return `约 ${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

// 纯函数：一行状态文字（已装版本 / 安装方式 / 最新版）。
export function describeCliState(cli) {
  if (!cli) return "—";
  let text;
  if (cli.installed === true) text = `${cli.version ? `v${cli.version}` : "已安装（版本未知）"}${cli.kind && KIND_TEXT[cli.kind] ? ` · ${KIND_TEXT[cli.kind]}` : ""}`;
  // 装在只有交互 shell 才看得到的位置（后端给 offPath）：说出来，不说「未安装」；这一行的「安装」会装官方版到 ~/.local/bin。
  else if (cli.installed === false) text = typeof cli.offPath === "string" && cli.offPath ? `已装在 ${cli.offPath}，但非交互 SSH 的 PATH 里找不到（可在这里安装官方版）` : "未安装";
  else text = "安装状态未知";
  if (cli.updateAvailable) text += ` · 可更新到 ${cli.latest}`;
  else if (cli.installed === true && cli.latest && cli.version === cli.latest) text += " · 已是最新";
  else if (!cli.latest && cli.latestError) text += " · 最新版本暂时查不到";
  return text;
}

// 纯函数：这一行有哪些动作。installed 未知时也给「安装」（预检会看清现状，已装就是更新）。
export function cliActions(cli) {
  if (!cli) return [];
  const out = [];
  if (cli.installed !== true) out.push("install");
  else if (cli.updateAvailable) out.push("update");
  if (cli.installed === true && cli.kind !== "npm") out.push("rollback");
  return out;
}

// 纯函数：这次安装 / 更新会不会用上团队缓存（与后端 lib/cli/team-cache.mjs 的 chooseCacheEntry 同口径的近似：
// 首次安装有缓存就用；更新只在缓存正好是最新版时用）。→ 缓存版本号 | null。
export function cacheVersionFor(id, action, cli, teamCache) {
  const best = teamCache?.best?.[id] || null;
  if (!best || (action !== "install" && action !== "update")) return null;
  if (action === "install") return cli?.installed === true ? null : best;
  return cli?.latest && best === cli.latest && cli.version !== best ? best : null;
}

// 纯函数：确认文案。fallbackUnavailable：回退上传不可用时后端给的说明（密码连接的服务器，/api/cli 的同名字段）——
// 这时只走官方安装器，不能再承诺「自动改为本机下载」。cacheVersion：会用上的团队缓存版本（cacheVersionFor）。
export function confirmText(id, action, cli, { fallbackUnavailable = null, cacheVersion = null, cacheDir = null } = {}) {
  const label = cli?.label || id;
  if (action === "rollback") {
    return `把 ${label} 切回上一个保留的版本（不删除任何版本，之后可再更新回来）。注意：CLI 自己的自动更新之后可能再次把它升到最新。`;
  }
  if (action === "publish") {
    return `在这台电脑上下载 ${label} ${cli?.latest || "最新版"} 的官方安装包（${APPROX_SIZE[id] || "体积较大"}），按官方清单核对校验和后上传到集群团队缓存${cacheDir ? ` ${cacheDir}` : ""}。之后同事安装时直接在集群内拷贝，几秒完成。每个工具保留最近 2 个版本。`;
  }
  if (cacheVersion) {
    const older = cli?.latest && cli.latest !== cacheVersion ? `（最新版是 ${cli.latest}，装好后可以再点更新）` : "";
    return `团队缓存里有 ${label} ${cacheVersion}${older}：将在集群内直接拷贝安装，通常几十秒完成，不走外网；校验和以官方清单为准，对不上就不用。缓存用不上时再经你的隧道运行官方安装器。旧版本保留，可回滚。`;
  }
  const target = cli?.latest ? ` ${cli.latest}` : "最新版";
  const verb = action === "update" ? `更新到${target}` : `安装${target}`;
  const fallback = fallbackUnavailable
    ? `${fallbackUnavailable}：官方安装器失败时不会自动改用本机下载。`
    : "失败或长时间没有进展会自动改为本机下载后上传。";
  return `将在集群上经你的隧道运行官方安装器，${verb}（${APPROX_SIZE[id] || "体积较大"}，隧道慢时可能要半小时以上；后台进行，可以关掉配置窗口）。${fallback}旧版本保留，可回滚。`;
}

const ACTION_LABEL = (action, cli) => (action === "install" ? "安装" : action === "update" ? `更新到 ${cli?.latest || "最新"}` : action === "publish" ? "发布到团队缓存" : "回滚");
const VERB = { update: "更新", publish: "发布" };
// 落盘 / 切软链期间（后端 job.cancellable=false）「取消」按钮上的说明。
const CANCEL_BLOCKED_TITLE = "正在切换版本（已经在改安装目录），这一步不能中途取消，请等它跑完";

// 纯函数：任务进度块。cancelConfirm：正在问「确认取消？」；cancelPending：取消请求已发出、还没回话。
// 取消与上面的安装 / 回滚一样是两步式：先点「取消」展开确认，再点「确认取消」才发请求。
export function buildJobHtml(job, { cancelConfirm = false, cancelPending = false } = {}) {
  if (!job) return "";
  const running = job.status === "running";
  // 取消已受理（后端在收尾）或请求在途：只显示「正在取消」，不再给进度与按钮。
  const cancelling = running && Boolean(job.cancelling || cancelPending);
  const verb = VERB[job.action] || "安装";
  const p = job.progress;
  const showProgress = running && !cancelling && p;
  const bar = showProgress
    ? `<div class="cli-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"${p.percent != null ? ` aria-valuenow="${p.percent}"` : ""}><span style="transform:scaleX(${p.percent != null ? p.percent / 100 : 1})"${p.percent == null ? ' class="is-indeterminate"' : ""}></span></div>`
    : "";
  const facts = [];
  if (showProgress) {
    facts.push(p.total ? `${formatBytes(p.bytes)} / ${formatBytes(p.total)}` : `已传 ${formatBytes(p.bytes)}`);
    if (p.speedBps) facts.push(`${formatBytes(p.speedBps)}/s`);
    const eta = formatEta(p.etaSec);
    if (eta) facts.push(`剩余${eta}`);
  }
  let head;
  if (cancelling) head = `${escapeHtml(job.label)}：正在取消`;
  else if (running) head = `${escapeHtml(job.label)}：${escapeHtml(job.phaseText || "进行中")}${job.path === "fallback" ? `<small class="cli-job-path">${escapeHtml(PATH_TEXT.fallback)}</small>` : ""}`;
  else if (job.status === "succeeded" && job.action === "publish") head = `${escapeHtml(job.label)} ${escapeHtml(job.installedVersion || "")} 已在团队缓存`;
  else if (job.status === "succeeded") head = `${escapeHtml(job.label)} ${escapeHtml(job.installedVersion || "")} 已就绪${job.path ? `<small class="cli-job-path">${escapeHtml(PATH_TEXT[job.path] || job.path)}</small>` : ""}`;
  else if (job.status === "cancelled") head = `${escapeHtml(job.label)} ${verb}已取消`;
  else head = `${escapeHtml(job.label)} ${verb}失败`;
  const lines = [];
  if (job.fellBack && job.fallbackReason) lines.push(`<li>首选路径没走通：${escapeHtml(job.fallbackReason)}</li>`);
  if (job.error) lines.push(`<li class="is-error">${escapeHtml(job.error)}</li>`);
  for (const w of job.warnings || []) lines.push(`<li class="is-warn">${escapeHtml(w)}</li>`);
  // 最后一条事件：进行中是「现在在干什么」，已取消是「清理了什么、集群上动没动」。
  const lastEvent = (job.events || []).at(-1);
  if ((running || job.status === "cancelled") && lastEvent) lines.push(`<li>${escapeHtml(lastEvent.text)}</li>`);
  let actions = "";
  if (running && !cancelling) {
    const blocked = job.cancellable === false;
    actions = cancelConfirm && !blocked
      ? `<div class="cli-confirm">
        <p>${escapeHtml(job.action === "publish" ? "取消这次发布？已经下载 / 上传的部分会丢弃，团队缓存里原有的版本不受影响。" : `取消这次${verb}？已经下载 / 上传的部分会丢弃，集群上现有的版本不受影响，之后可以重新${verb}。`)}</p>
        <div class="cli-confirm-actions">
          <button type="button" class="btn btn-secondary" data-cli-job-cancel-go>确认取消</button>
          <button type="button" class="text-btn" data-cli-job-cancel-no>${escapeHtml(`继续${verb}`)}</button>
        </div>
      </div>`
      : `<div class="cli-job-actions"><button type="button" class="text-btn" data-cli-job-cancel${blocked ? ` disabled title="${escapeHtml(CANCEL_BLOCKED_TITLE)}"` : ""}>取消</button></div>`;
  }
  return `<div class="cli-job is-${escapeHtml(job.status)}" aria-live="polite">
    <p class="cli-job-head">${head}</p>${bar}${facts.length ? `<p class="cli-job-facts">${escapeHtml(facts.join(" · "))}</p>` : ""}${lines.length ? `<ul class="cli-job-notes">${lines.join("")}</ul>` : ""}${actions}
  </div>`;
}

// 纯函数：整节内容。confirm = { id, action } | null；pending = 正在提交的 id；cancelConfirm / cancelPending 见 buildJobHtml。
// 纯函数：「团队缓存」一行。teamCache = GET /api/cli/team-cache 的结果（还没回来时为 null，不显示）。
export function buildTeamCacheHtml(teamCache, overview, { busy = false } = {}) {
  if (!teamCache || !overview?.eligible || teamCache.serverId !== overview.serverId) return "";
  const have = CLI_ORDER.filter((id) => teamCache.best?.[id]).map((id) => `${overview.clis?.[id]?.label || id} ${teamCache.best[id]}`);
  let text;
  if (teamCache.error && !have.length) text = `团队缓存：${teamCache.error}`;
  else if (have.length) text = `团队缓存里有 ${have.join("、")}：安装时直接在集群内拷贝，不走外网。`;
  else text = "团队缓存里还没有安装包：安装会经你的隧道下载，隧道慢时可能要半小时以上。";
  let admin = "";
  if (teamCache.isAdmin && teamCache.hub) {
    const buttons = CLI_ORDER.filter((id) => overview.clis?.[id]).map((id) => {
      const cli = overview.clis[id];
      const fresh = cli.latest && teamCache.best?.[id] === cli.latest;
      const label = fresh ? `${cli.label || id} 已是最新` : `发布 ${cli.label || id}${cli.latest ? ` ${cli.latest}` : " 最新版"}`;
      return `<button type="button" class="text-btn" data-cli-action="publish" data-cli-id="${escapeHtml(id)}"${busy || fresh ? " disabled" : ""}>${escapeHtml(label)}</button>`;
    }).join("");
    admin = `<div class="cli-actions cli-cache-admin"><span class="cli-cache-label">管理员：</span>${buttons}</div>`;
  } else if (teamCache.isAdmin && !teamCache.hub) {
    admin = '<small class="eg-hint">集群上还没有团队共享目录，先在「团队管理」里初始化。</small>';
  } else if (!have.length) {
    admin = '<small class="eg-hint">可以请管理员先把安装包发布到团队缓存，之后大家都能秒装。</small>';
  }
  return `<div class="cli-cache${have.length ? " has-cache" : ""}"><p class="cli-cache-text">${escapeHtml(text)}</p>${admin}</div>`;
}

export function buildCliHtml(overview, { confirm = null, pending = null, job = null, loading = false, error = "", cancelConfirm = false, cancelPending = false, teamCache = null } = {}) {
  if (error && !overview) return `<p class="incidents-empty">${escapeHtml(`读取失败：${error}；重新打开配置可重试`)}</p>`;
  if (!overview) return `<p class="incidents-empty">${loading ? "正在读取集群上的安装状态…" : "打开后读取集群上的安装状态…"}</p>`;
  if (!overview.eligible) return '<p class="incidents-empty">当前查看的服务器不支持（只支持团队集群）。</p>';
  const running = job?.status === "running" ? job : null;
  const busy = Boolean(running || overview.busy || pending);
  const rows = CLI_ORDER.filter((id) => overview.clis?.[id]).map((id) => {
    const cli = overview.clis[id];
    const actions = cliActions(cli);
    let tail;
    if (confirm?.id === id) {
      // 「直接用本机下载」只在装 / 更新时给；密码连接的服务器没有回退上传，不给。
      const official = confirm.action !== "rollback" && confirm.action !== "publish" && !overview.fallbackUnavailable;
      const cacheVersion = cacheVersionFor(id, confirm.action, cli, teamCache);
      tail = `<div class="cli-confirm">
        <p>${escapeHtml(confirmText(id, confirm.action, cli, { fallbackUnavailable: overview.fallbackUnavailable, cacheVersion, cacheDir: teamCache?.dir }))}</p>
        <div class="cli-confirm-actions">
          <button type="button" class="btn btn-primary" data-cli-go="${escapeHtml(id)}" data-cli-mode="auto"${pending ? " disabled" : ""}>${escapeHtml(`确认${ACTION_LABEL(confirm.action, cli)}`)}</button>
          ${official ? `<button type="button" class="text-btn" data-cli-go="${escapeHtml(id)}" data-cli-mode="local"${pending ? " disabled" : ""} title="跳过集群上的官方安装器，直接在本机下载官方安装包、校验后上传">直接用本机下载</button>` : ""}
          <button type="button" class="text-btn" data-cli-cancel>取消</button>
        </div>
      </div>`;
    } else {
      tail = actions.length
        ? `<div class="cli-actions">${actions.map((a) => `<button type="button" class="${a === "rollback" ? "text-btn" : "btn btn-secondary"}" data-cli-action="${a}" data-cli-id="${escapeHtml(id)}"${busy ? " disabled" : ""}>${escapeHtml(ACTION_LABEL(a, cli))}</button>`).join("")}</div>`
        : "";
    }
    return `<li class="cli-row">
      <div class="cli-row-text"><strong class="cli-name">${escapeHtml(cli.label || id)}</strong><small class="cli-state">${escapeHtml(describeCliState(cli))}</small></div>
      ${tail}
    </li>`;
  }).join("");
  const busyNote = !running && overview.busy ? `<p class="eg-hint">${escapeHtml(`这台服务器上正在进行${BUSY_KIND_TEXT[overview.busy.kind] || "安装"}，结束后才能再操作。`)}</p>` : "";
  return `<ul class="cli-list">${rows}</ul>${buildTeamCacheHtml(teamCache, overview, { busy })}${busyNote}${buildJobHtml(job, { cancelConfirm, cancelPending })}`;
}

export function createSettingsCli({
  doc, getJson, postJson, showToast, openDialog = null,
  // 安装 / 更新 / 回滚结束后通知 Agent 卡片重新拉 /api/cli（app/cli-controller.js）。
  onCliChanged = () => {},
  getServerId = () => null, onOverview = () => {},
  // 任务快照每次变化（开始 / 进度 / 结束）都告诉宿主：接入引导据此把高亮从「安装」挪到「正在安装」再到「登录」。
  onJobChange = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  // 同一套安装 / 更新界面也嵌在接入引导的最后一页（app/onboarding-guide.js）：换个宿主元素与所在浮层即可。
  bodyId = "settingsCliBody", dialogId = "dlgSettings", sectionId = "settingsCli",
  notifiedJobs = sharedNotifiedJobs,
}) {
  const $ = (id) => doc.getElementById(id);
  const isOpen = () => Boolean($(dialogId)?.open);
  let overview = null;
  let job = null;
  let loading = false;
  let error = "";
  let confirm = null;
  let pending = null;
  // 取消进行中的任务：cancelConfirm = 正在问「确认取消？」；cancelPending = 请求已发出、还没回话。
  let cancelConfirm = false;
  let cancelPending = false;
  let timer = null;
  let loadSeq = 0;
  let pollSeq = 0;
  let teamCache = null;
  let cacheSeq = 0;

  const errText = (err) => err?.serverMessage || err?.message || "未知错误";

  function render() {
    const body = $(bodyId);
    if (body) body.innerHTML = buildCliHtml(overview, { confirm, pending, job, loading, error, cancelConfirm, cancelPending, teamCache });
    onJobChange(job);
  }

  function stopPolling() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function schedulePoll() {
    stopPolling();
    if (job?.status === "running") timer = setTimer(poll, isOpen() ? CLI_JOB_POLL_MS : CLI_JOB_POLL_CLOSED_MS);
  }

  async function poll() {
    timer = null;
    if (job?.status !== "running") return;
    const seq = ++pollSeq;
    try {
      const next = await getJson(`/api/cli/jobs/${encodeURIComponent(job.jobId)}`);
      if (seq !== pollSeq || !next) return;
      const finished = next.status !== "running";
      job = next;
      render();
      if (finished) {
        await finishJob(next);
        return;
      }
    } catch {
      // 网络抖动：下一轮再取
    }
    schedulePoll();
  }

  // 结束提示只发一次：轮询、取消接口、重读概览可能先后都看到同一个任务的结束状态。
  function announce(j) {
    if (notifiedJobs.has(j.jobId)) return;
    notifiedJobs.add(j.jobId);
    if (notifiedJobs.size > 50) notifiedJobs.delete(notifiedJobs.values().next().value);
    notifyFinished(j);
    onCliChanged();
  }

  // 任务结束（轮询或取消接口看到的）：提示一次、通知 Agent 卡片、重读概览。
  async function finishJob(j) {
    cancelConfirm = false;
    announce(j);
    await load({ forceCache: true });
  }

  function notifyFinished(j) {
    const verb = VERB[j.action] || "安装";
    if (j.status === "succeeded" && j.action === "publish") {
      showToast({ type: "success", title: "团队缓存", message: `${j.label} ${j.installedVersion || ""} 已在团队缓存，同事安装时会直接在集群内拷贝。` });
    } else if (j.status === "succeeded") {
      showToast({ type: "success", title: "命令行工具", message: `${j.label} ${j.installedVersion || ""} 已就绪${j.path === "cache" ? "（从团队缓存拷贝）" : j.fellBack ? "（经本机下载）" : ""}。` });
    } else if (j.status === "cancelled") {
      showToast({ type: "info", title: "命令行工具", message: `${j.label} ${verb}已取消。` });
    } else {
      showToast({ type: "error", title: `${j.label} ${verb}失败`, message: j.error || "原因未知" });
    }
  }

  // 确认后取消进行中的任务。后端受理后会等收尾做完才回话（通常几秒，回话时任务已是「已取消」、锁已释放）；
  // 收尾拖得久（SSH 不通）就先回「正在取消」，这里接着轮询。临界阶段后端 409：任务照常进行，提示原因。
  async function cancelJob() {
    if (job?.status !== "running" || cancelPending) return;
    const jobId = job.jobId;
    cancelConfirm = false;
    cancelPending = true;
    render();
    try {
      const res = await postJson(`/api/cli/jobs/${encodeURIComponent(jobId)}/cancel`, {});
      const next = res?.job;
      if (next && job?.jobId === jobId) {
        pollSeq += 1; // 这份回话比在途的轮询新：让那次轮询的结果作废
        job = next;
        if (next.status !== "running") await finishJob(next);
      }
    } catch (err) {
      showToast({ type: "warn", title: "没有取消", message: errText(err) });
    } finally {
      cancelPending = false;
      render();
      schedulePoll();
    }
  }

  // 团队缓存与概览并行取，谁先回来先画；取不到只是少一行提示。
  async function loadTeamCache(serverId, force) {
    const seq = ++cacheSeq;
    const qs = [serverId ? `serverId=${encodeURIComponent(serverId)}` : "", force ? "force=1" : ""].filter(Boolean).join("&");
    try {
      const data = await getJson(`/api/cli/team-cache${qs ? `?${qs}` : ""}`, { timeoutMs: 30000 });
      if (seq !== cacheSeq) return;
      teamCache = data;
      render();
    } catch {
      // 老后端没有这个接口 / SSH 不通：不显示这一行
    }
  }

  async function load({ forceCache = false } = {}) {
    const seq = ++loadSeq;
    loading = true;
    render();
    loadTeamCache(getServerId(), forceCache);
    try {
      const serverId = getServerId();
      const data = await getJson(`/api/cli${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ""}`);
      if (seq !== loadSeq) return;
      overview = data;
      onOverview(data);
      error = "";
      // 后端记着的任务（含刚结束的）优先；本地已有更新的同一任务快照时保留本地的。
      const watching = job?.status === "running" ? job.jobId : null;
      if (data?.job && (!job || job.jobId !== data.job.jobId || (data.job.updatedAt || 0) >= (job.updatedAt || 0))) job = data.job;
      // 本地还当它在跑、概览里已经结束（两次轮询之间结束的）：这里看到也算数，照样提示。
      if (watching && job.jobId === watching && job.status !== "running") announce(job);
      // 从卡片直达的确认：现状已不需要这个动作（比如别处刚更新完）就收起，不弹过时的确认。
      if (confirm && confirm.action !== "publish" && !cliActions(data?.clis?.[confirm.id]).includes(confirm.action)) confirm = null;
    } catch (err) {
      if (seq !== loadSeq) return;
      error = errText(err);
    } finally {
      if (seq === loadSeq) {
        loading = false;
        render();
        schedulePoll();
      }
    }
  }

  async function go(id, mode) {
    if (!confirm || confirm.id !== id || pending) return;
    const action = confirm.action;
    pending = id;
    render();
    try {
      const serverId = overview?.serverId ?? undefined;
      if (action === "rollback") {
        const res = await postJson(`/api/cli/${encodeURIComponent(id)}/rollback`, { serverId });
        if (res?.ok) {
          showToast({ type: "success", title: "命令行工具", message: `${overview?.clis?.[id]?.label || id} 已切回 ${res.to}。` });
          onCliChanged();
        }
        else showToast({ type: "warn", title: "回滚没有完成", message: res?.error || "原因未知" });
        confirm = null;
        pending = null;
        await load();
        return;
      }
      const res = action === "publish"
        ? await postJson(`/api/cli/${encodeURIComponent(id)}/publish`, { serverId })
        : await postJson(`/api/cli/${encodeURIComponent(id)}/install`, { serverId, mode });
      job = res?.job || { jobId: res?.jobId, status: "running", label: overview?.clis?.[id]?.label || id, phaseText: "排队中" };
      confirm = null;
      cancelConfirm = false;
    } catch (err) {
      showToast({ type: "error", title: "命令行工具", message: errText(err) });
    } finally {
      pending = null;
      render();
      schedulePoll();
    }
  }

  function bind() {
    $(bodyId)?.addEventListener("click", (event) => {
      const t = event.target;
      const actionBtn = t?.closest?.("[data-cli-action]");
      if (actionBtn && !actionBtn.disabled) {
        confirm = { id: actionBtn.dataset.cliId, action: actionBtn.dataset.cliAction };
        render();
        return;
      }
      const goBtn = t?.closest?.("[data-cli-go]");
      if (goBtn && !goBtn.disabled) return go(goBtn.dataset.cliGo, goBtn.dataset.cliMode === "local" ? "local" : "auto");
      if (t?.closest?.("[data-cli-cancel]")) {
        confirm = null;
        render();
        return;
      }
      // 进行中任务的取消：第一步展开确认，「继续…」收起，「确认取消」才发请求。
      const jobCancel = t?.closest?.("[data-cli-job-cancel]");
      if (jobCancel && !jobCancel.disabled) {
        cancelConfirm = true;
        render();
        return;
      }
      if (t?.closest?.("[data-cli-job-cancel-no]")) {
        cancelConfirm = false;
        render();
        return;
      }
      if (t?.closest?.("[data-cli-job-cancel-go]")) return cancelJob();
    });
    $(dialogId)?.addEventListener("close", () => {
      confirm = null;
      cancelConfirm = false;
      // 任务还在跑就换成慢速接着盯（见 CLI_JOB_POLL_CLOSED_MS）；没有任务则停表。
      schedulePoll();
    });
  }

  function onOpen() {
    return load();
  }

  // 卡片直达：打开配置浮层（已开着就原地刷新）、展开并滚到本节，进入 { cli, action } 的确认。
  // 动作是否可做由 load() 按最新 /api/cli 复核（cliActions）；正在提交时不打断。
  function openFor({ cli, action = "install" } = {}) {
    if (!CLI_ORDER.includes(cli) || pending) return null;
    confirm = { id: cli, action: action === "update" ? "update" : "install" };
    const section = $(sectionId);
    if (section) section.open = true;
    let done;
    if (isOpen()) done = load();
    else if (openDialog) {
      openDialog(dialogId); // 打开回调（onOpen）里会 load()
      done = Promise.resolve();
    } else done = load();
    section?.scrollIntoView?.({ block: "nearest" });
    return done;
  }

  bind();
  return { onOpen, openFor, load, poll, go, cancelJob, getState: () => ({ overview, job, confirm, pending, cancelConfirm, cancelPending, teamCache }) };
}
