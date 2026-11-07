// 全局作业收件箱：所有视图共用。系统通知仅由明确授权的浏览器或桌面主进程发送。
// v2.62：浮层里多一节「提醒规则」（失败提醒开关、长作业阈值、名字规则），按服务器保存；
// 提醒不一定属于某个关注组（失败提醒的 watchId 为 null），这里只按提醒自己的 id / serverId / jobIds 办事。
import { morphInnerHtml } from "../dom-utils.js";
import { applyRulesPatch, buildNotificationListHtml, buildRulesHtml, noticeTarget, syncRuleInputs } from "../render/job-watch-view.js";

export const JOB_NOTICE_SEEN_KEY = "jobNoticeSeenV1";
export const JOB_NOTICE_POLL_MS = 30000;

export function createJobNotificationsController({
  doc, getJson, postJson, showToast = () => {}, onNavigate = () => {}, nativeDelivery = false,
  BrowserNotification = globalThis.Notification, storage = globalThis.localStorage,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const el = (id) => doc.getElementById(id);
  let data = null;
  let error = "";
  let timer = null;
  let inFlight = null;
  let generation = 0;
  let stopped = true;
  let bound = false;
  let changing = false;
  let seen = new Set();
  // 展开着「提醒规则」的服务器（默认收起，收件箱才是这个浮层的主角）。
  const rulesOpen = new Set();
  function readSeen() {
    try {
      const values = JSON.parse(storage?.getItem(JOB_NOTICE_SEEN_KEY) || "[]");
      if (Array.isArray(values)) for (const id of values) if (typeof id === "string") seen.add(id);
    } catch {}
  }
  readSeen();
  // 失败提醒点开去「我的历史」，其余照旧；没有目标时不多传参数。
  const navigate = (notice) => onNavigate(notice.serverId, notice.jobIds?.[0], ...(noticeTarget(notice) ? [noticeTarget(notice)] : []));

  function deliver(next) {
    if (nativeDelivery || next?.disabled) return;
    readSeen();
    const fresh = (next?.notifications || []).filter((n) => !seen.has(n.id));
    for (const n of fresh) seen.add(n.id);
    seen = new Set([...seen].slice(-500));
    try { storage?.setItem(JOB_NOTICE_SEEN_KEY, JSON.stringify([...seen])); } catch {}
    // 免打扰时仍保留收件箱；之后不补发已静音的一批系统通知。
    if (Number(next?.settings?.quietUntil) > now()) return;
    for (const n of fresh.filter((n) => !n.readAt).slice(0, 3)) {
      if (BrowserNotification?.permission === "granted") {
        try {
          const notice = new BrowserNotification(n.title, { body: n.body || "", tag: `job:${n.id}` });
          notice.onclick = () => { globalThis.window?.focus(); navigate(n); notice.close?.(); };
        } catch { showToast({ type: "info", title: n.title, message: n.body || "" }); }
      } else showToast({ type: "info", title: n.title, message: n.body || "" });
    }
  }

  function render() {
    const button = el("jobNotificationsBtn");
    if (button) button.hidden = data?.disabled === true;
    const unread = (data?.notifications || []).filter((n) => !n.readAt).length;
    const count = el("jobNotificationsCount");
    if (count) { count.hidden = !unread; count.textContent = String(unread); }
    el("jobNotificationsBtn")?.setAttribute("aria-label", unread ? `作业提醒，${unread} 条未读` : "作业提醒");
    const body = el("jobNotificationsBody");
    if (!body) return;
    if (data?.disabled) {
      morphInnerHtml(body, '<p class="jw-note">我的 Slurm 作业模块已关闭。重新开启后可继续查看关注作业。</p>');
      return;
    }
    const quiet = Number(data?.settings?.quietUntil) > now();
    const permission = BrowserNotification?.permission || "unsupported";
    const browser = !nativeDelivery
      ? `<button type="button" class="text-btn" data-notices-browser${permission === "granted" || permission === "unsupported" || permission === "denied" ? " disabled" : ""}>${permission === "granted" ? "浏览器通知已开启" : permission === "denied" ? "浏览器通知被阻止，请在站点设置开启" : permission === "unsupported" ? "此浏览器不支持系统通知" : "开启浏览器通知"}</button>`
      : '<span class="jw-note">桌面通知已接入</span>';
    // 没动过规则的人收到的头一条失败提醒（后端标了 intro）还没读时，在最上面说明它从哪来、去哪关。
    const intro = (data?.notifications || []).some((n) => n.intro === true && !n.readAt);
    // 工具条下面的三条提示各占一个固定位置，没有时留一个隐藏的空 <p>：就地修补是按位置对齐的，提示行真的来去的话，
    // 它后面的规则表单会逐个错位、被整块换成新节点——正在打的规则和键盘焦点就丢了（一次轮询失败、免打扰到期都会触发）。
    const note = (text, attrs = "") => `<p class="jw-note"${text ? attrs : " hidden"}>${text}</p>`;
    // 就地修补保持关闭按钮、消息操作与规则输入框的键盘焦点；输入框的值在修补之后按数据设回去（syncRuleInputs）。
    morphInnerHtml(body, `<div class="jw-notice-toolbar"><button type="button" class="text-btn" data-notices-read-all${!unread || changing ? " disabled" : ""}>全部已读</button>` +
      `<button type="button" class="text-btn" data-notices-quiet${changing ? " disabled" : ""}>${quiet ? "结束免打扰" : "免打扰 1 小时"}</button>${browser}</div>` +
      note(intro ? "这是默认开启的失败提醒，可在提醒规则里关掉。" : "") +
      note(quiet ? "免打扰中，新的提醒仍记录在这里。" : "") +
      note(error ? "提醒暂时无法刷新；稍后会自动重试。" : "", ' data-level="warn"') +
      buildRulesHtml(data?.servers, { open: rulesOpen, busy: changing }) +
      buildNotificationListHtml(data, now()));
    syncRuleInputs(body, data?.servers, doc.activeElement);
  }

  function schedule() {
    if (timer != null) clearTimer(timer);
    timer = null;
    if (!stopped) timer = setTimer(() => { timer = null; refresh(); }, JOB_NOTICE_POLL_MS);
  }
  async function refresh() {
    if (stopped || changing) return;
    if (inFlight) return inFlight;
    const mine = generation;
    const task = (async () => {
      try {
        const next = await getJson("/api/jobs/watch");
        if (mine !== generation || stopped) return;
        data = next;
        error = "";
        deliver(next);
      } catch (err) { if (mine === generation) error = err?.message || "请求失败"; }
      finally {
        if (mine === generation) { inFlight = null; render(); schedule(); }
      }
    })();
    inFlight = task;
    return task;
  }
  async function mutate(body) {
    if (changing) return;
    changing = true;
    const mine = ++generation;
    inFlight = null;
    render();
    try {
      const next = await postJson("/api/jobs/watch", body);
      if (mine === generation) { data = next; error = ""; }
    } catch (err) { showToast({ type: "error", title: "作业提醒", message: err?.serverMessage || err?.message || "保存失败" }); }
    finally { if (mine === generation) { changing = false; render(); schedule(); } }
  }
  // 规则按服务器保存：回包是那台服务器的视图，只取规则与建议并进这里的全局数据，收件箱等下一次轮询。
  // patch 可以是对象，或 (当前规则) => 对象 | null（null = 不用保存）。保存成了返回 true。
  // 只发要改的那一项（开关、阈值、加一条 / 删一条名字规则）：这里手里的规则可能是半分钟前读到的，不整份发回去。
  async function mutateRules(serverId, patch) {
    const server = (data?.servers || []).find((s) => s.serverId === serverId);
    if (changing || !server) return false;
    const body = typeof patch === "function" ? patch(server.rules || {}) : patch;
    if (!body) return false;
    const withServer = (change) => ({ ...data, servers: data.servers.map((s) => (s.serverId === serverId ? { ...s, ...change(s) } : s)) });
    // 先按改后的样子显示：保存在途时渲染会按数据把开关设回去，数据还是旧的话开关就弹回旧值了。没存成再整个退回去。
    const before = data;
    const optimistic = withServer((s) => ({ rules: applyRulesPatch(s.rules, body) }));
    data = optimistic;
    changing = true;
    const mine = ++generation;
    inFlight = null;
    render();
    let saved = false;
    try {
      const next = await postJson(`/api/jobs/watch?serverId=${encodeURIComponent(serverId)}`, { action: "rules", ...body });
      if (mine === generation && Array.isArray(data?.servers)) {
        data = withServer((s) => ({ rules: next?.rules ?? s.rules, suggestions: next?.suggestions ?? s.suggestions }));
        // 自己存过规则之后，「这是默认开启的失败提醒」那句就不成立了（后端同时摘掉了提醒上的标记）：这里也摘掉，不等下一次轮询。
        if (Array.isArray(data.notifications)) {
          data.notifications = data.notifications.map((n) => {
            if (n.serverId !== serverId || !n.intro) return n;
            const { intro: _intro, ...rest } = n;
            return rest;
          });
        }
        saved = true;
      }
    } catch (err) {
      if (data === optimistic) data = before;
      showToast({ type: "error", title: "提醒规则", message: err?.serverMessage || err?.message || "保存失败" });
    }
    // 没存成时 render 会把开关、阈值按原来的规则设回去。
    finally { if (mine === generation) { changing = false; render(); schedule(); } }
    return saved;
  }
  function addPattern(serverId, raw) {
    const pattern = String(raw || "").trim();
    if (!pattern) return Promise.resolve(false);
    return mutateRules(serverId, (rules) => {
      const patterns = Array.isArray(rules.patterns) ? rules.patterns : [];
      if (patterns.includes(pattern)) { showToast({ type: "info", title: "提醒规则", message: `已经有这条规则：${pattern}` }); return null; }
      return { addPattern: pattern };
    });
  }
  async function requestBrowserPermission() {
    if (nativeDelivery || !BrowserNotification?.requestPermission) return;
    try { await BrowserNotification.requestPermission(); }
    catch { showToast({ type: "error", title: "浏览器通知", message: "无法申请通知权限，请检查浏览器站点设置" }); }
    render();
  }
  function open() {
    const dialog = el("jobNotificationsDialog");
    if (!dialog?.open) dialog?.showModal();
    render();
    refresh();
  }
  function bind() {
    if (bound) return;
    bound = true;
    el("jobNotificationsBtn")?.addEventListener("click", open);
    const body = el("jobNotificationsBody");
    body?.addEventListener("click", (event) => {
      const target = event.target;
      if (target.closest?.("[data-notices-browser]")) { requestBrowserPermission(); return; }
      if (target.closest?.("[data-notices-quiet]")) { mutate({ action: "settings", quietUntil: Number(data?.settings?.quietUntil) > now() ? 0 : now() + 3600000 }); return; }
      if (target.closest?.("[data-notices-read-all]")) { mutate({ action: "ack", notificationId: "all" }); return; }
      const read = target.closest?.("[data-notice-read]");
      if (read) { mutate({ action: "ack", notificationId: read.dataset.noticeRead }); return; }
      const link = target.closest?.("[data-notice-open]");
      if (link) {
        const notice = data?.notifications?.find((n) => n.id === link.dataset.noticeOpen);
        if (!notice) return;
        el("jobNotificationsDialog")?.close();
        navigate(notice);
        if (!notice.readAt) mutate({ action: "ack", notificationId: notice.id });
        return;
      }
      const toggle = target.closest?.("[data-rules-toggle]");
      if (toggle) {
        const id = toggle.dataset.rulesToggle;
        if (rulesOpen.has(id)) rulesOpen.delete(id); else rulesOpen.add(id);
        render();
        return;
      }
      const remove = target.closest?.("[data-rule-remove]");
      if (remove) { mutateRules(remove.dataset.ruleServer, { removePattern: remove.dataset.ruleRemove }); return; }
      const suggest = target.closest?.("[data-rule-suggest]");
      if (suggest) addPattern(suggest.dataset.ruleServer, suggest.dataset.ruleSuggest);
    });
    body?.addEventListener("change", (event) => {
      const fail = event.target.closest?.("[data-rule-fail]");
      if (fail) { mutateRules(fail.dataset.ruleFail, { failNotify: Boolean(fail.checked) }); return; }
      const long = event.target.closest?.("[data-rule-long]");
      if (!long) return;
      if (long.checkValidity && !long.checkValidity()) { long.reportValidity?.(); return; }
      const text = String(long.value ?? "").trim();
      mutateRules(long.dataset.ruleLong, { longRunMinutes: text === "" ? null : Number(text) });
    });
    body?.addEventListener("submit", async (event) => {
      const form = event.target.closest?.("[data-rule-add]");
      if (!form) return;
      event.preventDefault();
      const input = form.elements?.pattern;
      if (!(await addPattern(form.dataset.ruleAdd, input?.value)) || !input) return;
      // 保存期间输入框被禁用会丢焦点：加成之后清空并把焦点还回去，接着打下一条。
      input.value = "";
      input.focus?.();
    });
    render();
  }
  function start() { stopped = false; return refresh(); }
  function stop() { stopped = true; generation += 1; inFlight = null; changing = false; if (timer != null) clearTimer(timer); timer = null; }
  return { bind, start, stop, refresh, open, mutate, mutateRules, addPattern, requestBrowserPermission, state: () => ({ data, error }) };
}
