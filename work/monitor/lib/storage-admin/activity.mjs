// 只融合已有采样；不发 SSH，不将作业活动伪装成一次登录。
export const ACTIVITY_MAX_AGE_MS = 150_000;
const MAX_USERS = 3000;
const host = (value) => String(value || "").trim().toLowerCase().replace(/\.$/, "");
const fresh = (at, now) => Number.isFinite(at) && at > 0 && at <= now && now - at <= ACTIVITY_MAX_AGE_MS;

export function activityServer(target, config) {
  const servers = (config.servers || []).filter((s) => !s.disabled && s.monitorEnabled !== false);
  if (target.connectionId) return servers.find((s) => s.id === target.connectionId) || null;
  const matches = servers.filter((s) => [s.host, s.sshHostName, s.address?.host].some((h) => h && host(h) === host(target.host)) && (s.sshPort || 22) === target.port);
  return matches.find((s) => s.id === target.id) || (matches.length === 1 ? matches[0] : null);
}

export function observeUserActivity({ users = [], infoHost = "", resources, team, previous = {}, now = Date.now() } = {}) {
  const records = {}, byUid = {};
  const resourceHost = host(String(resources?.output || "").split("\n")[0]);
  const resourceReady = resources?.level === "ok" && fresh(resources.checkedAt, now) && host(infoHost) && resourceHost === host(infoHost);
  const teamReady = team && fresh(team.checkedAt, now);
  const jobs = resourceReady && resources.slurm?.state === "ok" && Array.isArray(resources.slurm.jobs) ? resources.slurm.jobs : [];
  const jobsByUser = new Map();
  for (const job of jobs) {
    if (!job || typeof job.user !== "string") continue;
    const counts = jobsByUser.get(job.user) || { running: 0, pending: 0 };
    if (["RUNNING", "COMPLETING"].includes(job.state)) counts.running++;
    else if (job.state === "PENDING") counts.pending++;
    jobsByUser.set(job.user, counts);
  }
  for (const user of users.slice(0, MAX_USERS)) {
    if (!Number.isInteger(user.uid) || user.uid < 0 || typeof user.name !== "string") continue;
    const prior = previous[user.uid];
    const priorSources = (Array.isArray(prior?.sources) ? prior.sources : []).filter((s) => ["ssh", "jobs", "agent"].includes(s));
    let record = priorSources.length && prior?.user === user.name && Number.isFinite(prior.at) && prior.at > 0 && prior.at <= now
      ? { user: user.name, at: prior.at, sources: priorSources } : null;
    const counts = jobsByUser.get(user.name);
    const sshOnline = Boolean(teamReady && team.sshUsers?.includes(user.name));
    const agentProcesses = teamReady ? Object.values(team.agentProcs?.[user.name] || {}).reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 0), 0) : 0;
    const runningJobs = counts?.running || 0, pendingJobs = counts?.pending || 0;
    const sources = [...(sshOnline ? ["ssh"] : []), ...(runningJobs || pendingJobs ? ["jobs"] : []), ...(agentProcesses ? ["agent"] : [])];
    const checkedAt = Math.max(sshOnline || agentProcesses ? team.checkedAt : 0, runningJobs || pendingJobs ? resources.checkedAt : 0);
    if (sources.length && (!record || checkedAt >= record.at)) record = { user: user.name, at: checkedAt, sources };
    if (record) records[user.uid] = record;
    if (record || sources.length) byUid[user.uid] = {
      active: sources.length > 0, sshOnline, runningJobs, pendingJobs, agentProcesses,
      checkedAt: checkedAt || null, expiresAt: checkedAt ? checkedAt + ACTIVITY_MAX_AGE_MS : null,
      lastObservedAt: record?.at || null, sources: record?.sources || [],
    };
  }
  return { records, byUid };
}
