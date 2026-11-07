// 桌面作业提醒：独立于主窗口可见性轮询只读收件箱，跨重启去重。
// Electron API 由入口注入；点击仅导航，不改变远端作业。
// 提醒不一定属于某个关注组（v2.62 的失败提醒 watchId 为 null）：这里只用提醒自己的 id / serverId / jobIds / kind，
// 去重、免打扰、点击定位都不看 watchId。失败提醒点开带 view: "history"，页面直接定位到「我的历史」。
import * as nodeFs from "node:fs";
import path from "node:path";
import { writePrivateFileAtomicSync } from "../lib/atomic-file.mjs";

export const JOB_NOTICES_POLL_MS = 30000;
export const JOB_NOTICES_SEEN_FILE = "job-notices-seen.json";

export function createJobNoticesController({
  fetchNotifications, Notification, onNavigate = () => {}, runtimeDir = null,
  fs = nodeFs, now = Date.now, timers = globalThis, logger = console,
}) {
  const statePath = runtimeDir ? path.join(runtimeDir, JOB_NOTICES_SEEN_FILE) : null;
  let seen = new Set();
  let timer = null;
  let running = false;
  let inFlight = null;
  let generation = 0;
  // view 只在有值时才往下传：其余提醒的导航参数与原来一样。
  const navigate = (serverId, jobId, view = null) => {
    Promise.resolve().then(() => onNavigate(serverId, jobId, ...(view ? [view] : []))).catch((err) => logger.warn?.(`[job-notices] 无法打开作业：${err.message}`));
  };
  if (statePath) {
    try {
      const raw = fs.readFileSync(statePath, "utf8");
      if (raw.length <= 65536) {
        const value = JSON.parse(raw);
        if (Array.isArray(value.ids)) seen = new Set(value.ids.filter((id) => typeof id === "string" && id.length <= 160).slice(-500));
      }
    } catch {}
  }

  function remember(items) {
    for (const item of items) seen.add(item.id);
    seen = new Set([...seen].slice(-500));
    if (statePath) {
      try { writePrivateFileAtomicSync(statePath, `${JSON.stringify({ ids: [...seen] })}\n`, { fs, chmodDir: false }); }
      catch (err) { logger.warn?.(`[job-notices] 无法保存提醒去重记录：${err.message}`); }
    }
  }

  function deliver(payload) {
    if (payload?.disabled) return;
    const fresh = (Array.isArray(payload?.notifications) ? payload.notifications : [])
      .filter((item) => item && typeof item.id === "string" && item.id.length <= 160 && !seen.has(item.id));
    if (!fresh.length) return;
    // 先记去重再发：打开多个窗口、热重启或下一轮相同响应不会重放。
    remember(fresh);
    if (Number(payload?.settings?.quietUntil) > now()) return;
    if (Notification?.isSupported?.() === false || typeof Notification !== "function") return;
    const unread = fresh.filter((item) => !item.readAt);
    for (const item of unread.slice(0, 3)) {
      try {
        const notice = new Notification({ title: String(item.title || "作业提醒"), body: String(item.body || "") });
        notice.on("click", () => navigate(item.serverId, item.jobIds?.[0], item.kind === "failed" ? "history" : null));
        notice.show();
      } catch (err) { logger.warn?.(`[job-notices] 提醒发送失败：${err.message}`); }
    }
    if (unread.length > 3) {
      try {
        const notice = new Notification({ title: "还有作业提醒", body: `另有 ${unread.length - 3} 条提醒，可在「作业提醒」查看。` });
        notice.on("click", () => navigate(null, null));
        notice.show();
      } catch {}
    }
  }

  function schedule() {
    if (timer != null) timers.clearTimeout(timer);
    timer = null;
    if (running) timer = timers.setTimeout(() => { timer = null; poll(); }, JOB_NOTICES_POLL_MS);
    timer?.unref?.();
  }
  async function poll() {
    if (!running) return;
    if (inFlight) return inFlight;
    const mine = generation;
    const task = (async () => {
      try {
        const payload = await fetchNotifications();
        if (running && generation === mine) deliver(payload);
      } catch { /* 后台短暂重启：保留去重状态，下一轮重新连接。 */ }
      finally { if (generation === mine) { inFlight = null; schedule(); } }
    })();
    inFlight = task;
    return task;
  }
  function start() { if (running) return inFlight; running = true; return poll(); }
  function stop() { running = false; generation += 1; inFlight = null; if (timer != null) timers.clearTimeout(timer); timer = null; }
  return { start, stop, poll };
}

// 桌面入口只接一次此工厂；请求及导航的细节保留在此领域模块。
export function createDesktopJobNotices({ ctx, Notification, windows, fetchImpl = fetch }) {
  const { monitorBaseUrl, authToken, runtimePaths, state } = ctx;
  return createJobNoticesController({
    Notification,
    runtimeDir: runtimePaths.runtimeDir,
    fetchNotifications: async () => {
      const response = await fetchImpl(`${monitorBaseUrl}/api/jobs/watch`, {
        headers: { "x-auth-token": authToken }, signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`作业提醒 HTTP ${response.status}`);
      return response.json();
    },
    onNavigate: async (serverId, jobId, view = null) => {
      await windows.createMainWindow();
      windows.showMainWindow();
      const win = state.mainWindow;
      if (!win || win.isDestroyed()) return;
      const content = win.webContents;
      const send = () => {
        if (win.isDestroyed() || content.isDestroyed?.()) return;
        // 只有当前控制台页面能接收导航；绝不向其它来源的窗口透出服务器信息。
        let trusted = false;
        try { trusted = new URL(content.getURL()).origin === new URL(monitorBaseUrl).origin; } catch {}
        if (trusted) content.send("job-notice-open", { serverId: serverId || null, jobId: jobId || null, ...(view ? { view } : {}) });
      };
      if (content.isLoading?.() || !content.getURL().startsWith(monitorBaseUrl)) content.once("did-finish-load", send);
      else send();
    },
  });
}
