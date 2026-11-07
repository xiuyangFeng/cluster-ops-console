// T07 事件查询与个人提醒：GET /api/incidents（open|resolved 过滤、serverId、type、limit≤200、
// 稳定游标）；POST /api/incidents/:id/attention 只接受 acknowledge/snooze/unsnooze——偏好
// 不改变故障事实。
// GET /api/incidents/summary?days=14：已恢复事件按类型汇总（事件页「已恢复 · 按类型」）。
// days 是含今天在内的北京自然日数，1–31，缺省 / 非法时 14（由 store 兜底）；口径见 store.summarize。
// 汇总里每个类型的 key 可以原样作为 GET /api/incidents 的 type 参数，取这一类留存的全部逐条记录。
//
// 事件中心（2026-10-23）：
//   GET /api/incidents?state=…&group=cluster：同一类短时间内接连发生的事件合成「事件簇」（lib/incidents/clusters.mjs），
//     返回 { state, total（簇数）, incidentTotal, clusters[], overflow }；limit 按簇计。不带 group 时形状不变。
//   未解决列表的每条事件额外带 recurrence（这是短时间内第几次，之前没有就不带）。
//   GET /api/incidents/:id/context：事件前后经过（lib/incidents/context.mjs），只读本机已有记录；
//     断线账本 / 历史日文件 / 日志环任一取不到就当没有，不报错。事件不存在 404。
import { beijingDaysBetween } from "../../beijing-time.mjs";
import { clusterIncidents, recurrenceMap } from "../../incidents/clusters.mjs";
import { buildIncidentContext, contextWindow } from "../../incidents/context.mjs";
import { buildIncidentFingerprint } from "../../incidents/store.mjs";
import { readRequiredBody, respondOrError, sendErrorMessage, sendJson } from "../io.mjs";

const ITEM_PREFIX = "/api/incidents/";
const SUMMARY_PATH = "/api/incidents/summary";
const ATTENTION_SUFFIX = "/attention";
const CONTEXT_SUFFIX = "/context";
// 前后经过最多读几天的历史日文件（窗口两段各自跨零点时也够用）。
const CONTEXT_HISTORY_DAYS_MAX = 4;

// describeDisk（可选）：(serverId) => { text }——未解决的「磁盘超阈值」事件带上一句详情
// detail: { text }（近 24 小时作业目录的增长 + 按这个速度几天写满，见 lib/disk-growth/detail.mjs）。
// 这是读接口现算的展示信息：不写回事件、不进指纹，取不到就不带。
// 前后经过的数据源（都可缺省）：loadLedger() → 断线账本事件；readHistoryDay(day) → 历史日文件条目；
// queryLogs({ since, until, limit }) → { entries }（lib/logger.mjs）。now 仅供测试注入。
export function createIncidentRoutes({ incidentStore, describeDisk = null, loadLedger = null, readHistoryDay = null, queryLogs = null, now = Date.now }) {
  const ATTENTION_ACTIONS = {
    acknowledge: (incidentId) => incidentStore.acknowledge(incidentId),
    snooze: (incidentId, data) => incidentStore.snooze(incidentId, data.durationMs),
    unsnooze: (incidentId) => incidentStore.unsnooze(incidentId),
  };

  async function withDiskDetail(result) {
    if (!describeDisk || !Array.isArray(result?.incidents)) return result;
    const incidents = await Promise.all(result.incidents.map(async (incident) => {
      if (incident?.reasonCode !== "DISK_THRESHOLD" || incident.lifecycle !== "open" || !incident.serverId) return incident;
      try {
        const text = (await describeDisk(incident.serverId))?.text;
        return typeof text === "string" && text ? { ...incident, detail: { text } } : incident;
      } catch {
        return incident;
      }
    }));
    return { ...result, incidents };
  }

  // 未解决事件：每条带上「短时间内第几次」（同指纹、紧挨着之前的已恢复事件）。
  function withRecurrence(result) {
    if (result?.state !== "open" || !Array.isArray(result.incidents) || !result.incidents.length || typeof incidentStore.list !== "function") return result;
    const recurrences = recurrenceMap(result.incidents, incidentStore.list({ state: "resolved" }));
    if (!recurrences.size) return result;
    return {
      ...result,
      incidents: result.incidents.map((incident) => (recurrences.has(incident.incidentId) ? { ...incident, recurrence: recurrences.get(incident.incidentId) } : incident)),
    };
  }

  // group=cluster：按簇返回（同一类、间隔 ≤15 分钟的事件合成一簇）。type / serverId 过滤同逐条。
  function clusters(params, state, limit) {
    const type = params.get("type") || "";
    const pool = incidentStore.list({ state, serverId: params.get("serverId") || undefined });
    const list = clusterIncidents(pool, { nowMs: now() });
    const filtered = type ? list.filter((cluster) => buildIncidentFingerprint(cluster) === type) : list;
    const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return {
      state,
      total: filtered.length,
      incidentTotal: filtered.reduce((sum, cluster) => sum + cluster.count, 0),
      clusters: filtered.slice(0, capped),
      overflow: state === "open" ? incidentStore.query({ state, limit: 1 }).overflow : { count: 0, lastAt: null },
    };
  }

  async function query(res, params) {
    // 注意：缺 limit 参数时 Number(null) === 0 是有限数，传给 store 的是 0（由 store 自行兜底）。
    const limitRaw = Number(params.get("limit"));
    const state = params.get("state") === "resolved" ? "resolved" : "open";
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
    if (params.get("group") === "cluster" && typeof incidentStore.list === "function") {
      sendJson(res, clusters(params, state, limit));
      return;
    }
    sendJson(res, withRecurrence(await withDiskDetail(incidentStore.query({
      state,
      serverId: params.get("serverId") || undefined,
      fingerprint: params.get("type") || undefined,
      limit,
      cursor: params.get("cursor") || undefined,
    }))));
  }

  // 前后经过：各数据源独立取，任一失败只当没有。
  async function context(res, pathname) {
    let incidentId = "";
    try {
      incidentId = decodeURIComponent(pathname.slice(ITEM_PREFIX.length, -CONTEXT_SUFFIX.length));
    } catch {
      return sendJson(res, { error: "incident not found" }, 404); // 畸形的 % 转义
    }
    const incident = typeof incidentStore.get === "function" ? incidentStore.get(incidentId) : null;
    if (!incident) return sendJson(res, { error: "incident not found" }, 404);
    const nowMs = now();
    const window = contextWindow(incident, { nowMs });
    if (!window) return sendJson(res, { error: "incident has no time" }, 404);
    const safely = async (fn, fallback) => {
      try {
        return (await fn()) ?? fallback;
      } catch {
        return fallback;
      }
    };
    const days = [...new Set(window.ranges.flatMap(([a, b]) => beijingDaysBetween(a, b, CONTEXT_HISTORY_DAYS_MAX)))].slice(-CONTEXT_HISTORY_DAYS_MAX);
    const [ledger, history, logs] = await Promise.all([
      loadLedger ? safely(loadLedger, []) : [],
      readHistoryDay ? safely(async () => (await Promise.all(days.map((day) => readHistoryDay(day).catch(() => [])))).flat(), []) : [],
      queryLogs ? safely(() => queryLogs({ since: window.from, until: window.to, limit: 500 })?.entries, []) : [],
    ]);
    const incidents = [...incidentStore.list({ state: "open" }), ...incidentStore.list({ state: "resolved" })];
    sendJson(res, buildIncidentContext({ incident, incidents, ledger, history, logs, nowMs }));
  }

  async function attention(req, res, pathname) {
    const incidentId = decodeURIComponent(pathname.slice(ITEM_PREFIX.length, -ATTENTION_SUFFIX.length));
    const data = await readRequiredBody(req, res);
    if (data == null) return;
    // 事件不存在等业务错误一律 404（不取 error.status）。
    await respondOrError(res, async () => {
      if (typeof data.action !== "string" || !Object.hasOwn(ATTENTION_ACTIONS, data.action)) {
        return sendJson(res, { error: "action must be acknowledge | snooze | unsnooze" }, 400);
      }
      const incident = ATTENTION_ACTIONS[data.action](incidentId, data);
      sendJson(res, {
        incidentId: incident.incidentId,
        lifecycle: incident.lifecycle,
        attention: { ...incident.attention },
      });
    }, (response, error) => sendErrorMessage(response, error, 404));
  }

  return async ({ req, res, url }) => {
    const { pathname } = url;
    if (req.method === "GET" && pathname === "/api/incidents") {
      await query(res, url.searchParams);
      return true;
    }
    if (req.method === "GET" && pathname === SUMMARY_PATH) {
      const days = Number(url.searchParams.get("days"));
      sendJson(res, incidentStore.summarize({ days: Number.isFinite(days) && days > 0 ? days : undefined }));
      return true;
    }
    if (req.method === "GET" && pathname.startsWith(ITEM_PREFIX) && pathname.endsWith(CONTEXT_SUFFIX)) {
      await context(res, pathname);
      return true;
    }
    if (req.method === "POST" && pathname.startsWith(ITEM_PREFIX) && pathname.endsWith(ATTENTION_SUFFIX)) {
      await attention(req, res, pathname);
      return true;
    }
    return false;
  };
}
