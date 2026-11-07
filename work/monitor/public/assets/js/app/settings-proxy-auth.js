// app/settings-proxy-auth.js —— 配置浮层「出网」一节里的「代理口令」（v2.62）：模式（关 / 只记录 / 强制）、
// 口令有没有写到集群、近 24 小时带 / 没带口令的请求、近 24 小时流量最多的目标。
//
// 数据来自 GET /api/egress 的 proxyAuth（./settings-egress.js 读回来后经 setStatus 交过来，这里不重复请求）
// 与 GET /api/egress/usage（只在有东西可看时才读）。动作：POST /api/egress/proxy-auth（改模式 / 换口令 /
// 停用旧口令）、POST /api/egress/proxy-auth/sync（把口令写到集群：先预览要改哪几个文件，确认了才写）。
// 骨架在 index.html（#egressAuth），这里只改动态部分。界面上从头到尾没有口令本身——接口也不给。
//
// 切到「强制」是这一节里唯一会让集群断网的动作：有风险时先把风险列出来，确认了才发（服务端同样把着这一关）。
import { escapeHtml, formatBytes, formatRelativeTime } from "../store.js";

// 改完后重读最终生效状态：本机代理约 2 秒热载一次口令文件，动作回显里往往还是「新设置几秒内生效」。
// 与「出网方式」保存后的重读同一个节奏；次数多一次，好越过服务端判「旧版本代理」之前的那段宽限。
export const AUTH_SETTLE_MS = 2500;
export const AUTH_SETTLE_TRIES = 4;

// 纯函数：本机代理是否已经有了定论（已生效 / 没在运行 / 确认是旧版本，都算）。
export const authSettled = (auth) => auth?.proxy?.state !== "pending";

export const AUTH_MODES = [
  { mode: "off", label: "关", hint: "不校验。集群登录节点上任何账号连上反向端口，都能经这台电脑出网。" },
  { mode: "observe", label: "只记录", hint: "照常放行，只记下每个请求带没带口令、去了哪。强制之前先用它看清还有谁没带。" },
  { mode: "enforce", label: "强制", hint: "没带对口令的请求一律拒绝。集群上的程序要从写过口令的配置里拿到口令才能出网。" },
];

const modeLabel = (mode) => AUTH_MODES.find((item) => item.mode === mode)?.label || mode || "";

// 强制之后不会自己好的东西：每次确认都原样列出来。
export const ENFORCE_NOTICE = "已经在运行的 codex / claude / 作业拿的是旧的环境变量，强制后会断网，需要重开。reclaude 的 systemd 配置、~/.npmrc、~/.curlrc、zcode 的设置，以及个人服务器上自己配的代理地址，工作台不会改，需要手动加上口令。";

// 纯函数：本机代理此刻按什么在跑（一句话；没什么可说时为空串）。
export function describeProxyApplied(auth) {
  const proxy = auth?.proxy;
  if (!proxy) return "";
  // 回报的还是另一个模式；刚从「关」打开时它还没有回报过（mode 为空），只说几秒内生效。
  if (proxy.state === "pending") return proxy.mode ? `还在按「${modeLabel(proxy.mode)}」运行，新设置几秒内生效` : "新设置几秒内生效";
  if (auth.mode === "off") return "";
  if (proxy.state === "applied") return `已按「${modeLabel(auth.mode)}」运行`;
  if (proxy.state === "unconfirmed") return "正在运行的是旧版本，不认识口令；平滑交接到新版本后才生效";
  if (proxy.state === "not-running") return "没有运行，启动后按这项设置生效";
  return "";
}

// 纯函数：集群上那份受管配置带的是哪一个口令。
export function describeCluster(auth) {
  const cluster = auth?.cluster;
  if (!cluster || !auth.hasToken) return "";
  if (cluster.env === "absent") return "还没有工作台的受管配置，先完成接入引导";
  switch (cluster.credential) {
    case "current": return "已写入当前口令";
    case "previous": return "还是上一个口令（过渡期内仍可用），需要重新写入";
    case "other": return "带的不是这台电脑现在的口令，需要重新写入";
    case "none": return "还没有写入口令";
    case "unverified": return "已带口令，但集群上算不出指纹，核对不了是不是当前的";
    default: return cluster.error ? `没查到：${cluster.error}` : "还没有查到；点「把口令写到集群」会现查一次";
  }
}

// 纯函数（v2.64）：已经是「强制」、集群上却不是当前口令时的那句警告（GET /api/egress 的 proxyAuth.clusterAlert；
// 没有时为空串）。补写走同一个「把口令写到集群…」按钮，不另起入口。
export function describeClusterAlert(alert) {
  if (alert?.code !== "cluster-not-synced") return "";
  const effect = alert.credential === "previous" ? "过渡期一过，那里新开的终端就连不上外网" : "那里新开的终端连不上外网";
  return `现在是「强制」：${effect}。点下面的「把口令写到集群…」补写`;
}

const unauthenticated = (stats) => (stats?.missing || 0) + (stats?.bad || 0);

// 按未带口令目标的主机名给出常见客户端来源提示（纯函数，无额外提示时返回空串）。
export function inferTargetClientHint(target) {
  const host = String(target || "").replace(/:\d+$/, "").toLowerCase();
  if (!host) return "";
  if (host === "pypi.org" || host.endsWith(".pypi.org") || host.endsWith("pythonhosted.org")) return "pip";
  if (host === "registry.npmjs.org" || host.endsWith(".npmjs.org")) return "npm";
  if (host.endsWith("anaconda.org") || host.endsWith("anaconda.com") || host.endsWith("conda.io")) return "conda";
  if (host === "github.com" || host.endsWith(".github.com") || host.endsWith("githubusercontent.com")) return "git/gh";
  if (host === "huggingface.co" || host.endsWith(".huggingface.co")) return "hf/python";
  if (host.endsWith("anthropic.com") || host.endsWith("claude.ai")) return "claude";
  if (host.endsWith("openai.com") || host.endsWith("chatgpt.com")) return "codex";
  return "";
}

// 纯函数：没带口令的目标「chatgpt.com:443 5 次、api.openai.com:443 2 次，另有 3 个目标」。
// 若后端或调用方附带了 item.client（如 classifyClientAgent 识别出的客户端类型），一并在括号中标出。
export function describeUnauthenticatedTargets({ targets = [], moreTargets = 0 } = {}) {
  const named = targets
    .map((item) => {
      const clientTag = item.client ? `（${item.client}）` : "";
      return `${item.target}${clientTag} ${item.missing + item.bad} 次`;
    })
    .join("、");
  if (!named) return "";
  return moreTargets > 0 ? `${named}，另有 ${moreTargets} 个目标` : named;
}

// 本机时刻「10月13日 14:05」（过渡期的截止时刻，给人看的）。
export function formatDeadline(ts) {
  const date = new Date(Number(ts));
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 纯函数：事实行（本机代理 / 集群 / 近 24 小时 / 没带口令的目标 / 换口令 / 文件问题）。没有内容的行不出。
// 已是「强制」而集群口令不同步时，集群那一行接上警告、以警告色显示（这一节里唯一用颜色的事实行）。
export function buildAuthFactsHtml(auth) {
  if (!auth) return "";
  const rows = [];
  if (auth.issue) {
    rows.push(["口令文件", auth.issue.state === "unreadable"
      ? "读不出来，这里先按「关」显示；本机代理保持它上一次读到的设置"
      : "内容损坏，这里先按「关」显示；重新选一次模式会生成新口令，之后要重新写到集群"]);
  }
  const applied = describeProxyApplied(auth);
  if (applied) rows.push(["本机代理", applied]);
  const cluster = describeCluster(auth);
  const alert = describeClusterAlert(auth.clusterAlert);
  if (cluster) rows.push([auth.cluster.serverName, alert ? `${cluster}。${alert}` : cluster, alert ? "is-warn" : ""]);
  const stats = auth.stats;
  if (stats?.since != null) {
    const denied = stats.denied > 0 ? `（已拒绝 ${stats.denied} 次）` : "";
    rows.push(["近 24 小时", `带口令 ${stats.authed} 次 · 没带 ${unauthenticated(stats)} 次${denied}`]);
    const targets = describeUnauthenticatedTargets(stats);
    if (targets) rows.push(["没带口令的目标", targets]);
  }
  if (auth.rotation) rows.push(["换口令", `上一个口令继续可用到 ${formatDeadline(auth.rotation.until)}`]);
  return rows.map(([label, value, cls]) => `<div class="eg-fact${cls ? ` ${cls}` : ""}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
}

// 纯函数：切到「强制」之前要确认的事 → 一条条人话。
export function describeRisks(risks = []) {
  return risks.map((risk) => {
    if (risk.code === "unauthenticated") {
      const targets = describeUnauthenticatedTargets(risk);
      return `近 24 小时还有 ${risk.requests} 次请求没带口令${targets ? `：${targets}` : ""}。强制后它们会被拒绝。`;
    }
    if (risk.code === "no-observation") return "还没有「只记录」的数据，看不出哪些程序没带口令。建议先开「只记录」用一段时间。";
    if (risk.code === "cluster-not-synced") {
      const state = { none: "还没有写入口令", previous: "还是上一个口令", other: "带的不是当前口令", unverified: "核对不了是不是当前口令" }[risk.credential] || "还没有查到带没带口令";
      return `${risk.serverName} 上的受管配置${state}：强制后那里新开的终端也连不上外网。先点「把口令写到集群」。`;
    }
    return "";
  }).filter(Boolean);
}

// 面板底部的按钮：一个主动作，外加「取消」（secondary 传 null 时只有主动作）。
function actions(primary, secondary = ["cancel", "取消"]) {
  const main = `<button type="button" class="btn btn-secondary" data-auth-action="${primary[0]}">${escapeHtml(primary[1])}</button>`;
  const other = secondary ? `<button type="button" class="text-btn" data-auth-action="${secondary[0]}">${escapeHtml(secondary[1])}</button>` : "";
  return `<div class="eg-actions">${main}${other}</div>`;
}
const paragraphs = (lines) => lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");

// 纯函数：确认面板。
export function buildEnforceConfirmHtml(risks = []) {
  return `<div class="eg-confirm">${paragraphs([...describeRisks(risks), ENFORCE_NOTICE])}${actions(["confirm-enforce", "仍然切到强制"])}</div>`;
}

export function buildRotateConfirmHtml(auth) {
  const lines = auth?.rotation
    ? [`上一次换口令的过渡期还没结束（到 ${formatDeadline(auth.rotation.until)}）。现在再换，仍在用上一个口令的程序会立刻断网。`]
    : ["换一个新口令。旧口令再接受 24 小时，这期间把新口令写到集群、重开用着旧口令的程序。"];
  return `<div class="eg-confirm">${paragraphs(lines)}${actions(auth?.rotation ? ["confirm-rotate-force", "仍然更换"] : ["confirm-rotate", "更换"])}</div>`;
}

const SETTINGS_SKIP = { "no-claude": "集群上没有 Claude Code", "reclaude-managed": "代理由 reclaude 接管", "not-managed": "里面的代理地址不是工作台写的", "invalid-json": "不是合法 JSON" };

// 纯函数：「把口令写到集群」的预览（要改哪几个文件、各改什么）。
export function describeSyncPlan(plan) {
  if (!plan) return [];
  const lines = [];
  const env = plan.env;
  if (env.action === "unchanged") lines.push(`${env.path}：已是当前口令，不改`);
  else {
    const what = { add: "加上口令", replace: "换成当前口令", keep: "口令不变" }[env.credential] || "重写";
    const port = env.port ? `，端口 ${env.port.from ?? "未知"} → ${env.port.to}` : "";
    lines.push(`${env.path}：${what}${port}（整份重写，权限 600）`);
  }
  const claude = plan.claude;
  if (claude.action === "write") lines.push(`${claude.path}：改 ${claude.changedKeys.length} 个代理键，其余内容不动（先备份，权限收到 600）`);
  else if (claude.action === "unchanged") lines.push(`${claude.path}：已是当前值，不改`);
  else if (claude.action === "error") lines.push(`${claude.path}：${claude.reason || "读取失败"}，这次不改`);
  else lines.push(`${claude.path}：不改（${SETTINGS_SKIP[claude.reason] || "不需要"}）`);
  if (Array.isArray(plan.legacyToolProxies) && plan.legacyToolProxies.length > 0) {
    for (const item of plan.legacyToolProxies) {
      lines.push(`~/${item.file}（第 ${item.line} 行）：检出独立代理 ${item.scheme}://127.0.0.1:${item.port}，不自动修改`);
    }
  }
  return lines;
}

export function buildSyncPanelHtml(sync) {
  if (!sync) return "";
  const lines = describeSyncPlan(sync.plan);
  if (sync.status === "preview") {
    const nothing = sync.plan.env.action === "unchanged" && sync.plan.claude.action !== "write";
    const head = `将在 ${sync.serverName} 上：`;
    const tail = "只对新开的终端生效；已经在运行的程序要重开才拿得到口令。";
    return nothing
      ? `<div class="eg-confirm">${paragraphs([`${sync.serverName} 上已经是当前口令，不需要改。`, ...lines])}${actions(["cancel", "知道了"], null)}</div>`
      : `<div class="eg-confirm">${paragraphs([head, ...lines, tail])}${actions(["confirm-sync", "写入"])}</div>`;
  }
  const done = sync.status === "up-to-date" ? [`${sync.serverName} 上已经是当前口令。`] : [`已写到 ${sync.serverName}：${sync.changed.join("、") || "没有文件需要改"}。新开的终端生效。`];
  if (sync.warning) done.push(sync.warning);
  return `<div class="eg-confirm">${paragraphs(done)}</div>`;
}

// 纯函数：近 24 小时流量最多的目标（没有目标时为空串，整块不显示）。
export function buildUsageHtml(usage, now = Date.now()) {
  const targets = usage?.targets || [];
  if (!targets.length && !usage?.other) return "";
  // 没有「最近一次」时刻（0）的行显示破折号，不拿 1970 年去算「多少天前」。
  const last = (item) => (item.lastAt > 0 ? formatRelativeTime(item.lastAt, now) || "—" : "—");
  const row = (name, item, mono) => `<tr><td${mono ? ' class="eg-usage-target"' : ""}>${escapeHtml(name)}</td><td>${escapeHtml(String(item.connections))}</td><td>${escapeHtml(formatBytes(item.up))}</td><td>${escapeHtml(formatBytes(item.down))}</td><td>${escapeHtml(last(item))}</td></tr>`;
  const other = usage.other ? row(usage.other.targets > 0 ? `其它 ${usage.other.targets} 个目标` : "其它", usage.other, false) : "";
  return `<div class="eg-row-text"><strong class="eg-title">近 24 小时流量最多的目标</strong><small class="eg-hint">经这台电脑出网的连接，按目标合计；概览「数据链路」按去向汇总</small></div>
    <table class="eg-usage-table"><thead><tr><th>目标</th><th>连接</th><th>上行</th><th>下行</th><th>最近</th></tr></thead><tbody>${targets.map((item) => row(item.target, item, true)).join("")}${other}</tbody></table>`;
}

// reload()：动作成功后回调（配置浮层据此让「出网」一节重读 /api/egress，两边看到的是同一份）。
export function createSettingsProxyAuth({
  doc, getJson, postJson, showToast, reload = async () => {}, now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
  const getEl = (id) => doc.getElementById(id);
  let auth = null;
  let usage = null;
  let usageWanted = true; // 每次打开配置读一次使用记录；动作之后再读一次
  let pending = false;
  let panel = ""; // 确认 / 预览面板的 HTML（空串 = 不显示）
  let renderedPanel = null; // 已经写进 DOM 的那一份：内容没变不重写（重读状态时不打断正在看的确认面板）
  let settleTimer = null;

  const errText = (err) => err?.serverMessage || err?.message || "未知错误";

  function render() {
    const root = getEl("egressAuth");
    if (root) root.hidden = !auth;
    if (!auth) return;
    for (const btn of getEl("egressAuthModes")?.querySelectorAll?.("[data-auth-mode]") || []) {
      btn.setAttribute("aria-pressed", String(btn.dataset.authMode === auth.mode));
      btn.disabled = pending;
    }
    const hint = getEl("egressAuthHint");
    if (hint) hint.textContent = AUTH_MODES.find((item) => item.mode === auth.mode)?.hint || "";
    const facts = getEl("egressAuthFacts");
    if (facts) facts.innerHTML = buildAuthFactsHtml(auth);
    // 「写到集群」「换口令」只在有口令、且有集群可写时才有意义。
    const actionsRow = getEl("egressAuthActions");
    if (actionsRow) actionsRow.hidden = !auth.hasToken;
    const syncBtn = getEl("egressAuthSyncBtn");
    if (syncBtn) {
      syncBtn.hidden = !auth.cluster;
      syncBtn.disabled = pending;
    }
    const rotateBtn = getEl("egressAuthRotateBtn");
    if (rotateBtn) rotateBtn.disabled = pending;
    const retireBtn = getEl("egressAuthRetireBtn");
    if (retireBtn) {
      retireBtn.hidden = !auth.rotation;
      retireBtn.disabled = pending;
    }
    const box = getEl("egressAuthPanel");
    if (box) {
      box.hidden = !panel;
      if (panel !== renderedPanel) {
        box.innerHTML = panel;
        renderedPanel = panel;
      }
    }
    const table = getEl("egressUsage");
    if (table) {
      const html = buildUsageHtml(usage, now());
      table.hidden = !html;
      table.innerHTML = html;
    }
  }

  // 只在有东西可看时读使用记录（关着、也从没记过的时候不发这个请求）。
  async function loadUsage() {
    if (!auth || (auth.mode === "off" && auth.stats?.since == null)) {
      // 没有东西可看：上一次读到的表也收起来（记录过了 24 小时、或换了一份状态），不留一张过时的表。
      if (usage) {
        usage = null;
        render();
      }
      return;
    }
    if (!usageWanted) return;
    usageWanted = false;
    try {
      usage = await getJson("/api/egress/usage");
    } catch {
      usage = null;
    }
    render();
  }

  // ./settings-egress.js 每采用一份 /api/egress 的状态就交过来一次。
  function setStatus(status) {
    auth = status?.proxyAuth ?? null;
    render();
    return loadUsage();
  }

  function showPanel(html) {
    panel = html;
    render();
  }

  // 改完模式后隔几秒让「出网」一节重读，直到本机代理有了定论（最多 AUTH_SETTLE_TRIES 次，之后不再醒）。
  function scheduleSettle(attempt = 1) {
    if (settleTimer != null) clearTimer(settleTimer);
    settleTimer = null;
    if (authSettled(auth)) return;
    settleTimer = setTimer(async () => {
      settleTimer = null;
      await Promise.resolve(reload()).catch(() => {});
      if (attempt < AUTH_SETTLE_TRIES) scheduleSettle(attempt + 1);
    }, AUTH_SETTLE_MS);
  }

  // 改模式 / 换口令 / 停用旧口令共用：在飞期间禁用，成功用回显重渲并让「出网」一节重读。
  async function act(body, successText) {
    if (pending) return false;
    pending = true;
    panel = "";
    render();
    try {
      const result = await postJson("/api/egress/proxy-auth", body);
      usageWanted = true;
      await setStatus(result);
      showToast({ type: "success", title: "代理口令", message: successText(result) });
      Promise.resolve(reload()).catch(() => {});
      scheduleSettle();
      return true;
    } catch (err) {
      // 服务端说还得再确认（切换前状态变了）：重读一次，按最新的风险清单再问。
      if (err?.code === "confirm-required") {
        await Promise.resolve(reload()).catch(() => {});
        showPanel(buildEnforceConfirmHtml(auth?.enforceRisks || []));
      } else {
        showToast({ type: "error", title: "代理口令", message: `没有改成：${errText(err)}` });
      }
      return false;
    } finally {
      pending = false;
      render();
    }
  }

  const modeSaved = (mode) => (result) => {
    const created = result?.proxyAuthResult?.reset
      ? "原来的口令文件已损坏，重新生成了口令，需要重新写到集群。"
      : result?.proxyAuthResult?.created ? "已生成口令。" : "";
    return `${created}已改为「${modeLabel(mode)}」，本机代理几秒内生效`;
  };

  function setMode(mode, { confirmed = false } = {}) {
    if (!auth || !AUTH_MODES.some((item) => item.mode === mode) || mode === auth.mode) return false;
    if (mode === "enforce" && !confirmed) {
      // 每次切到强制都先停一下：有风险列风险，没有也把「不会自己好的东西」说一遍。
      showPanel(buildEnforceConfirmHtml(auth.enforceRisks || []));
      return false;
    }
    return act(mode === "enforce" ? { mode, confirm: true } : { mode }, modeSaved(mode));
  }

  async function sync({ confirm = false } = {}) {
    if (pending) return;
    pending = true;
    showPanel(`<div class="eg-confirm"><p>${confirm ? "正在写到集群…" : "正在读取集群上现在的配置…"}</p></div>`);
    try {
      const result = await postJson("/api/egress/proxy-auth/sync", confirm ? { confirm: true } : {});
      if (result?.proxyAuth) auth = result.proxyAuth;
      panel = buildSyncPanelHtml(result?.sync);
      if (confirm) Promise.resolve(reload()).catch(() => {});
    } catch (err) {
      panel = `<div class="eg-confirm"><p>${escapeHtml(errText(err))}</p></div>`;
    } finally {
      pending = false;
      render();
    }
  }

  function onAction(action) {
    if (action === "cancel") return showPanel("");
    if (action === "confirm-enforce") return setMode("enforce", { confirmed: true });
    if (action === "confirm-sync") return sync({ confirm: true });
    if (action === "confirm-rotate") return act({ rotate: true }, () => "已换成新口令，旧口令再接受 24 小时。把新口令写到集群");
    if (action === "confirm-rotate-force") return act({ rotate: true, force: true }, () => "已换成新口令。把新口令写到集群");
    return undefined;
  }

  function bind() {
    getEl("egressAuthModes")?.addEventListener("click", (event) => {
      const btn = event.target?.closest?.("[data-auth-mode]");
      if (btn && !btn.disabled) return setMode(btn.dataset.authMode);
      return undefined;
    });
    getEl("egressAuthSyncBtn")?.addEventListener("click", () => sync());
    getEl("egressAuthRotateBtn")?.addEventListener("click", () => showPanel(buildRotateConfirmHtml(auth)));
    getEl("egressAuthRetireBtn")?.addEventListener("click", () => act({ retirePrevious: true }, () => "上一个口令已停用"));
    getEl("egressAuthPanel")?.addEventListener("click", (event) => {
      const btn = event.target?.closest?.("[data-auth-action]");
      if (btn) return onAction(btn.dataset.authAction);
      return undefined;
    });
  }

  function onOpen() {
    usageWanted = true;
    panel = "";
  }

  bind();
  return { onOpen, setStatus, setMode, sync, onAction, getAuth: () => auth };
}
