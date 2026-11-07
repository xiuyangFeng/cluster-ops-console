import { isServerEnabled } from "../config-loader.mjs";
import { isDataModuleEnabled } from "../modules/catalog.mjs";
import { buildTroubleshootingReport } from "./model.mjs";

const HOUR = 3600_000;
const fail = (message, status) => Object.assign(new Error(message), { status });
const overlaps = (item, start, end) => item.firstSeenAt <= end && (item.resolvedAt || item.lastSeenAt) >= start;

export function createReportService({ getConfig, jobsService, incidentStore, tunnelStability, readOperationLogs = async () => [], version, now = Date.now }) {
  async function build({ kind, serverId, jobId, incidentId, includeScript = false }) {
    const config = await getConfig();
    const server = isServerEnabled(config, serverId) ? config.servers.find((s) => s.id === serverId) : null;
    const incident = kind === "incident" ? incidentStore?.getIncident(incidentId) : null;
    // 只允许当前仍可见服务器；事件必须属于选定服务器，避免跨服务器串证据。
    if (!server && !(kind === "incident" && serverId === "global" && incident && !incident.serverId)) throw fail("服务器不存在或已停用", 404);
    if (kind === "incident" && (!incident || (incident.serverId || "global") !== serverId)) throw fail("事件不存在或不属于此服务器", 404);
    if (kind === "job" && !isDataModuleEnabled(config, "jobs")) throw fail("我的 Slurm 作业模块已关闭", 409);
    const generatedAt = now();
    const availability = [];
    let snapshot = null;
    let job = null;
    let diagnosis = null;
    let script = null;
    if (kind === "job") {
      await jobsService?.ready?.();
      snapshot = jobsService?.getSnapshot(serverId);
      job = snapshot?.jobs?.find((j) => j.id === jobId) || null;
      diagnosis = (await jobsService?.listDiagnoses?.(serverId, {}))?.items?.find((d) => d.jobId === jobId) || null;
      if (!job && !diagnosis) throw fail("本机没有此作业的记录", 404);
      if (includeScript) script = await jobsService?.getDiagnosisScript?.(serverId, jobId);
      if (snapshot?.truncated) availability.push("作业采集已截断，历史列表不完整。");
      if (snapshot?.state !== "ok") availability.push("当前作业采集不可用，报告使用本机保存的诊断。");
    }
    const targetAt = job?.endAt ?? diagnosis?.endedAtMs ?? incident?.lastSeenAt ?? generatedAt;
    const windowEnd = Math.min(generatedAt, targetAt + 15 * 60_000);
    const windowStart = Math.max(targetAt - 24 * HOUR, (job?.startAt ?? incident?.firstSeenAt ?? targetAt) - 15 * 60_000);
    const related = ["open", "resolved"].flatMap((state) => incidentStore?.query({ state, serverId: serverId === "global" ? undefined : serverId, limit: 200 })?.incidents || [])
      .filter((i) => (i.serverId || "global") === serverId && overlaps(i, windowStart, windowEnd))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 12);
    const selected = (incident ? [incident, ...related.filter((i) => i.incidentId !== incident.incidentId)] : related).slice(0, 12);
    let disconnects = [];
    try {
      const events = await tunnelStability?.loadEvents?.();
      if (!events) availability.push("隧道断线账本不可用。");
      disconnects = (events || []).filter((e) => e.type === "down" && e.serverId === serverId && e.at >= windowStart && e.at <= windowEnd).slice(-12);
    } catch { availability.push("隧道断线账本读取失败。"); }
    const operationIds = [...new Set(selected.flatMap((i) => i.relatedOperationIds || []))].slice(-4);
    const operations = [];
    for (const id of operationIds) {
      try {
        // A channel restart can link the same operation to several servers. Keep only
        // this server's steps plus unscoped common steps, never another server's facts.
        const entries = (await readOperationLogs(id, serverId)).filter((entry) => !entry.serverId || entry.serverId === serverId).slice(-20);
        operations.push({ id, entries });
      }
      catch { availability.push(`处置 ${id} 的日志读取失败。`); }
    }
    if (operations.length) availability.push("处置日志仅保留目标服务器及未标注服务器的公共步骤。");
    availability.push("同期记录最多覆盖目标结束/最近发生前 24 小时，及之后 15 分钟；最多 12 条事件、12 次断线、4 次处置。");
    return buildTroubleshootingReport({ kind, server, version, generatedAt, job, diagnosis, script, incident, incidents: selected, disconnects, operations, availability, snapshotAt: snapshot?.checkedAt,
      sensitive: { hosts: (config?.servers || []).flatMap((s) => [s.host, s.address, s.sshHostName]), users: [config?.sshUser, snapshot?.user, ...(config?.servers || []).map((s) => s.sshUser)] } });
  }
  return { build };
}
