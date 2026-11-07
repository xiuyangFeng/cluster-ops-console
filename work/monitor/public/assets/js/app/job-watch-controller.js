// 当前服务器的关注列表。响应按服务器与请求代次隔离；迟到响应不能覆盖新服务器。
import { morphInnerHtml } from "../dom-utils.js";
import { buildWatchListHtml } from "../render/job-watch-view.js";
import { buildLogReaderHtml, captureLogScroll, restoreLogScroll, WATCH_LOG_OPTIONS } from "../render/log-readback-view.js";
import { createLogReadback } from "./log-readback.js";

export const JOB_WATCH_POLL_MS = 30000;

export function createJobWatchController({
  doc, getJson, postJson, showToast = () => {}, isVisible = () => true, onChange = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
} = {}) {
  let serverId = null;
  let enabled = true;
  let data = null;
  let error = "";
  let loading = false;
  let generation = 0;
  let revision = 0;
  let lastLoadedAt = 0;
  let pending = null;
  let timer = null;
  let mutation = false;
  const expanded = new Set();
  let root = null;
  // v2.51「进度依据」里的读取前一段：状态随服务器清空，读到 / 失败时重绘本列表。
  const readback = createLogReadback({ getJson, onChange: () => render() });
  const logReader = (job) => buildLogReaderHtml({ from: "watch", jobId: String(job.id), options: WATCH_LOG_OPTIONS, state: readback.view("watch", String(job.id)), progressCheckedAt: job.progress?.checkedAt ?? null });

  const active = () => Boolean(enabled && serverId && typeof getJson === "function" && isVisible());
  const url = (id = serverId) => `/api/jobs/watch?serverId=${encodeURIComponent(id)}`;
  const state = () => ({ data, error, loading, revision, serverId });
  const available = () => enabled && !data?.disabled && !data?.inactive;
  // 队列里的「已关注」只认手动关注：按规则自动关注（v2.62，带 auto）的作业仍可以点「关注」，改由手动组接管。
  const manualWatches = () => (data?.watches || []).filter((w) => !w.auto);
  const watchedIds = () => available() ? new Set(manualWatches().flatMap((w) => w.jobIds || []).map(String)) : null;
  const watchedGroups = () => new Set(manualWatches().map((w) => [...(w.jobIds || [])].map(String).sort().join(",")));

  function render() {
    if (!root) return;
    root.hidden = !available();
    const list = root.querySelector("[data-watch-list]");
    const scroll = captureLogScroll(list);
    morphInnerHtml(list, buildWatchListHtml(data, { expanded, now: now(), loading, error, logReader }));
    restoreLogScroll(list, scroll);
    const count = root.querySelector("[data-watch-count]");
    if (count) count.textContent = `${data?.watches?.length || 0} 项`;
    for (const key of ["silenceMinutes", "limitMinutes"]) {
      const input = root.querySelector(`[data-watch-setting="${key}"]`);
      if (input && input !== doc?.activeElement) input.value = String(data?.settings?.[key] || 30);
      if (input) input.disabled = mutation;
    }
  }

  function changed() { revision += 1; render(); onChange(); }
  function stop() { if (timer != null) clearTimer(timer); timer = null; }
  function schedule(delay = JOB_WATCH_POLL_MS) {
    stop();
    if (active()) timer = setTimer(() => { timer = null; if (active()) refresh(); }, Math.max(0, delay));
  }
  async function refresh() {
    if (mutation) return;
    if (!active()) { stop(); return; }
    if (pending) return pending;
    const target = serverId;
    const mine = generation;
    loading = true;
    const task = (async () => {
      try {
        const next = await getJson(url(target));
        if (mine !== generation) return;
        data = next;
        error = "";
        lastLoadedAt = now();
      } catch (err) {
        if (mine !== generation) return;
        error = err?.serverMessage || err?.message || "未知错误";
      } finally {
        if (mine === generation) {
          loading = false;
          pending = null;
          schedule();
          changed();
        }
      }
    })();
    pending = task;
    return task;
  }

  function setServer(id) {
    if (serverId === id) return;
    stop();
    generation += 1;
    serverId = id || null;
    readback.setServer(serverId);
    pending = null;
    mutation = false;
    data = null;
    error = "";
    loading = false;
    lastLoadedAt = 0;
    expanded.clear();
    revision += 1;
    render();
  }
  function setEnabled(value) {
    if (enabled === (value !== false)) return;
    enabled = value !== false;
    generation += 1;
    pending = null;
    loading = false;
    mutation = false;
    if (!enabled) { stop(); data = null; lastLoadedAt = 0; }
    changed();
    sync();
  }
  function sync() {
    if (mutation) return;
    if (!active()) {
      stop();
    } else if (timer == null && !pending) {
      const elapsed = lastLoadedAt > 0 ? now() - lastLoadedAt : JOB_WATCH_POLL_MS;
      if (data && !error && elapsed >= 0 && elapsed < JOB_WATCH_POLL_MS) schedule(JOB_WATCH_POLL_MS - elapsed);
      else refresh();
    }
  }

  async function mutate(body, success = "") {
    if (!enabled || !serverId || mutation || typeof postJson !== "function") return false;
    mutation = true;
    stop();
    // 写操作比在途轮询更新；旧读取即使后返回也不得把已关注按钮回滚。
    const mine = ++generation;
    const target = serverId;
    pending = null;
    render();
    try {
      const next = await postJson(url(target), body);
      if (mine !== generation) return false;
      data = next;
      error = "";
      lastLoadedAt = now();
      if (success) showToast({ type: "success", title: "作业关注", message: success });
      return true;
    } catch (err) {
      if (mine === generation) showToast({ type: "error", title: "作业关注", message: err?.serverMessage || err?.message || "保存失败" });
      return false;
    } finally {
      if (mine === generation) { mutation = false; loading = false; schedule(); changed(); }
    }
  }

  function watch(ids, label) {
    return mutate({ action: "watch", jobIds: ids, label: String(label || "").trim().slice(0, 80) }, "已关注；日志进度在下一轮采集后出现");
  }
  function bind(element) {
    root = element;
    if (!root || root.dataset.watchBound === "1") return;
    root.dataset.watchBound = "1";
    root.className = "jw-section";
    root.innerHTML = '<div class="cl-section-head"><h3>我关注的作业</h3><span class="cl-section-count" data-watch-count>0 项</span><span class="cl-section-hint">开始 · 结束 · 临近时限 · 疑似停滞</span></div>' +
      '<div data-watch-list></div><details class="jw-settings"><summary>提醒条件</summary><div class="jw-settings-fields">' +
      '<label>日志无更新 <input type="number" min="10" max="1440" step="1" required value="30" data-watch-setting="silenceMinutes" aria-label="日志静默检查分钟"> 分钟后检查</label>' +
      '<label>距时限 <input type="number" min="1" max="1440" step="1" required value="30" data-watch-setting="limitMinutes" aria-label="作业临近时限分钟"> 分钟提醒</label></div><p class="jw-note">仅对关注的作业生效；日志沉默不等于卡死。提醒受作业采集周期影响。</p></details>';
    root.addEventListener("click", (event) => {
      const target = event.target;
      const lr = target.closest?.("[data-lr-action]");
      if (lr) { if (!lr.disabled) readback.handleAction(lr.dataset); return; }
      const evidence = target.closest?.("[data-watch-evidence]");
      if (evidence) {
        const id = evidence.dataset.watchEvidence;
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        render();
        return;
      }
      const mute = target.closest?.("[data-watch-mute]");
      if (mute) mutate({ action: "mute", watchId: mute.dataset.watchMute, muted: mute.dataset.muted !== "true" });
      // 自动组的移除 = 停用产生它的那条规则（后端一并改规则），所以提示也照实说。
      const remove = target.closest?.("[data-watch-remove]");
      if (remove) mutate({ action: "unwatch", watchId: remove.dataset.watchRemove }, remove.dataset.watchAuto === "true" ? "已停用这条规则，名下的自动关注已撤掉" : "已取消关注");
    });
    root.addEventListener("change", (event) => {
      const setting = event.target.closest?.("[data-watch-setting]");
      if (!setting) return;
      if (setting.checkValidity && !setting.checkValidity()) { setting.reportValidity?.(); return; }
      mutate({ action: "settings", [setting.dataset.watchSetting]: Number(setting.value) });
    });
    render();
  }

  return { bind, state, watchedIds, watchedGroups, setServer, setEnabled, sync, stop, refresh, watch, mutate };
}
