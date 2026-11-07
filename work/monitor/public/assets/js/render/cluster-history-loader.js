// cluster-history-loader.js —— 「我的历史」的拉取与轮询（无 DOM；依赖全部注入，Node 可直接测）。
//
// 只在「该看」的时候拉：isActive() 由面板给出（作业列表切到「我的历史」+ 服务器页可见 + 窗口没隐藏）。
// 节奏跟随后端 5 分钟一轮的 sacct 采集（nextHistoryDelay：上次采集时刻 + 一轮间隔），不比它更勤；
// 到点发现不该拉就停表，不空转——重新可见时由 sync()（面板每次渲染入口都会调）续上并立即补拉一次。
//
// 失败作业诊断（v2.49）：每次拉历史顺带拉一次 GET /api/jobs/diagnoses（整份，不按行拉；近 48 小时没有
// 失败作业就不拉）；旧后端 404 / 模块关闭 { disabled } → diagnoses = null，界面不出现任何诊断。
// 提交脚本按需读（loadScript），按作业号缓存到换服务器为止。
// v2.51 回查结果里有失败作业时（面板调 ensureDiagnoses），即使近 48 小时没有失败也照样拉诊断，只读展示已有的诊断。
import { nextHistoryDelay } from "./cluster-history-model.js";

export function createHistoryLoader({
  getJson,
  isActive = () => true,
  onChange = null,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  now = () => Date.now(),
} = {}) {
  let serverId = null;
  let data = null;
  let diagnoses = null;
  let scripts = new Map();
  let error = "";
  let loading = false;
  let revision = 0;
  let seq = 0;
  let inFlight = null;
  let timer = null;
  let diagWanted = false; // 回查结果需要诊断（换服务器时清掉）
  let diagFetching = false;
  let diagTried = false; // 本服务器已为回查补拉过一次（失败 / 不可用时不在每帧渲染里反复拉，交给下一次历史刷新）

  const active = () => Boolean(serverId) && typeof getJson === "function" && isActive();

  function stop() {
    if (timer != null) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    stop();
    if (!active()) return;
    timer = setTimer(() => {
      timer = null;
      // 到点再看一次：这期间离开了服务器页 / 切回了当前队列 / 窗口被隐藏，就不拉也不再排。
      if (active()) run();
    }, nextHistoryDelay(data?.checkedAt, now()));
  }

  // 诊断整份：可用 → 响应；不可用（404 / 关闭 / 形状不对）→ null；临时失败 → undefined（沿用上次的）。
  async function fetchDiagnoses(target) {
    try {
      const res = await getJson(`/api/jobs/diagnoses?serverId=${encodeURIComponent(target)}`);
      return res && typeof res === "object" && !res.disabled && Array.isArray(res.items) ? res : null;
    } catch (err) {
      return err?.status === 404 ? null : undefined;
    }
  }

  // 返回 false：等待期间被取代（换了服务器），这份结果不要了。
  async function load() {
    const target = serverId;
    seq += 1;
    const mine = seq;
    loading = true;
    let next = null;
    let failure = "";
    let diag;
    try {
      next = await getJson(`/api/jobs?serverId=${encodeURIComponent(target)}`);
    } catch (err) {
      failure = err?.serverMessage || err?.message || "未知错误";
    }
    const usable = next && typeof next === "object" && !next.disabled;
    if (usable && mine === seq) diag = next.state === "ok" && (Number(next.summary?.failed) > 0 || diagWanted) ? await fetchDiagnoses(target) : null;
    if (mine !== seq) return false;
    loading = false;
    if (usable) {
      data = next;
      error = "";
      if (diag !== undefined) diagnoses = diag;
    } else {
      // 失败时保留上次取到的数据（界面说明「显示的是上次取到的数据」）。
      // { disabled: true }：「我的 Slurm 作业」模块已关闭（v2.47），通常面板已随之收起历史，这里兜住切换瞬间。
      error = next?.disabled ? "「我的 Slurm 作业」监控已关闭" : failure || "响应为空";
      if (next?.disabled) diagnoses = null;
    }
    return true;
  }

  // 拉一次；完成后先排好下一次再通知重绘——通知会触发面板渲染，渲染入口的 sync() 看到表已经在走，不会重复拉。
  function run() {
    if (inFlight) return inFlight;
    if (!serverId || typeof getJson !== "function") return Promise.resolve();
    stop();
    const current = (async () => {
      const applied = await load();
      if (!applied) return;
      inFlight = null;
      schedule();
      revision += 1;
      onChange?.();
    })();
    inFlight = current;
    return current;
  }

  return {
    // 查看的服务器变了：丢掉旧数据与在途请求的结果。
    setServer(id) {
      const next = id || null;
      if (next === serverId) return;
      serverId = next;
      seq += 1;
      inFlight = null;
      loading = false;
      data = null;
      diagnoses = null;
      diagWanted = false;
      diagTried = false;
      scripts = new Map();
      error = "";
      stop();
    },
    // 回查结果里有失败作业：确保诊断已拉过（只读本机诊断存储，不触发取证）；之后每次刷新历史也一并拉。
    async ensureDiagnoses() {
      diagWanted = true;
      if (diagnoses || diagFetching || diagTried || !serverId || typeof getJson !== "function") return;
      diagFetching = true;
      diagTried = true;
      const target = serverId;
      const res = await fetchDiagnoses(target);
      diagFetching = false;
      if (target !== serverId || res === undefined || res === null) return;
      diagnoses = res;
      revision += 1;
      onChange?.();
    },
    // 读一份提交脚本（展开「查看提交脚本」时由面板调）：已读到 / 正在读就不再发；失败可重试。
    // 结果进 scripts 缓存（{ state: "loading" | "ok" | "error", script, error }），每次变化都通知重绘。
    async loadScript(jobId) {
      const id = String(jobId ?? "");
      if (!id || !serverId || typeof getJson !== "function") return;
      const cache = scripts;
      const current = cache.get(id);
      if (current && (current.state === "loading" || current.state === "ok")) return;
      cache.set(id, { state: "loading" });
      revision += 1;
      onChange?.();
      let entry;
      try {
        const res = await getJson(`/api/jobs/diagnoses/script?serverId=${encodeURIComponent(serverId)}&jobId=${encodeURIComponent(id)}`);
        entry = { state: "ok", script: typeof res?.script === "string" && res.script ? res.script : null };
      } catch (err) {
        // 404：这份脚本没有（或后端不认这个作业号），与 script: null 同义。
        entry = err?.status === 404 ? { state: "ok", script: null } : { state: "error", error: err?.serverMessage || err?.message || "未知错误" };
      }
      // 等待期间换了服务器：缓存已整份换掉，这份结果不要了。
      if (cache !== scripts) return;
      cache.set(id, entry);
      revision += 1;
      onChange?.();
    },
    // 进入「我的历史」/ 手动刷新：立即拉一次，之后按采集节奏轮询。
    start: run,
    // 渲染入口调用：该拉而没在拉（刚回到服务器页 / 窗口重新可见）就续上。
    sync() {
      if (active() && timer == null && !inFlight) run();
    },
    stop,
    state: () => ({ serverId, data, diagnoses, scripts, error, loading, revision }),
  };
}
