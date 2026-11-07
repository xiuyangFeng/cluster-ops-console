// 给 /api/status 注入一份确定性的「重」集群层（20 节点 + 300 作业 + GPU 卡 + 占用现场），让服务器页有真实规模的内容。
export function heavyLayer(nowMs) {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const users = ["kai", "lin", "wanglab", "zhao", "liu", "chen", "amy", "bob"];
  const nodes = Array.from({ length: 20 }, (_, i) => ({ name: `node${String(i + 1).padStart(2, "0")}`, source: "slurm", reachable: true, failure: null, state: i % 7 === 0 ? "idle" : i % 9 === 0 ? "drain" : "mixed", stateRaw: "MIXED", flags: [], partitions: [i < 8 ? "gpu" : "cpu"],
    cpus: { alloc: 40 + (i * 7) % 56, idle: 96 - (40 + (i * 7) % 56), other: 0, total: 96 }, load: 30 + rnd() * 60, memTotalMb: 512000, memFreeMb: 100000 + rnd() * 200000, memAllocMb: 200000, busyPct: null,
    gpus: i < 8 ? { total: 8, used: 3 + (i % 5), model: "a100" } : null, uptimeSec: 86400 * 30, reason: i % 9 === 0 ? "maintenance" : null }));
  const states = ["RUNNING", "RUNNING", "PENDING", "PENDING", "PENDING", "COMPLETING"];
  const jobs = Array.from({ length: 300 }, (_, i) => { const st = states[i % states.length]; const u = users[i % users.length];
    return { id: String(20000 + i), user: u, partition: i % 3 ? "gpu" : "cpu", state: st, elapsedSec: st === "RUNNING" ? Math.round(rnd() * 200000) : 0, timeLimitSec: 259200, nodes: 1 + (i % 11 === 0 ? 1 : 0), cpus: 8 + (i % 4) * 8, gpus: i % 3 ? 1 + (i % 4) : 0,
      memory: "64G", submitAt: nowMs - Math.round(rnd() * 3e8), startAt: st === "RUNNING" ? nowMs - 1e6 : null, waitSec: st === "PENDING" ? Math.round(rnd() * 90000) : null, reason: st === "PENDING" ? (i % 2 ? "Resources" : "Priority") : null,
      nodeList: st === "RUNNING" ? `node${String((i % 20) + 1).padStart(2, "0")}` : null, name: `xp_${["widen", "w128", "base", "abl"][i % 4]}_pf${i % 9}_v52e_${20261000 + (i % 13)}` }; });
  const gpu = Array.from({ length: 8 }, (_, i) => ({ index: i, name: "NVIDIA A100-SXM4-80GB", util: Math.round(rnd() * 100), memUsedMb: Math.round(rnd() * 80000), memTotalMb: 81920, temp: 40 + Math.round(rnd() * 40), users: [{ user: users[i % 4], memMb: 20000 }] }));
  return { level: "ok", reason: "ok", checkedAt: nowMs - 5000, cpu: 63, ram: 71, disk: 94, output: "", gpu, agentsInstalled: null, usage: null,
    slurm: { schemaVersion: 1, state: "ok", reason: null, version: "23.02", user: "kai", checkedAt: nowMs - 5000, remoteNow: nowMs - 5000, defaultPartition: "gpu", nodes, jobs, jobsTotal: 300, jobsTruncated: false, counts: { running: 100, pending: 150, other: 50 } },
    procTop: { sampled: nowMs - 6000, slurm: true, users: users.map((u, i) => ({ user: u, cpu: 400 - i * 40, memMb: 50000 - i * 4000, procs: 10 + i, slurmCpu: 200, slurmMemMb: 20000 })) } };
}
export async function enableHeavyStatus(send, on) {
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/status", requestStage: "Response" }] });
  on(async (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId } = m.params;
    try {
      const { body, base64Encoded } = await send("Fetch.getResponseBody", { requestId });
      const json = JSON.parse(base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body);
      const now = Date.now();
      if (json.layers?.resources) json.layers.resources[json.activeServerId] = heavyLayer(now);
      const out = Buffer.from(JSON.stringify(json));
      await send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json; charset=utf-8" }, { name: "cache-control", value: "no-store" }], body: out.toString("base64") });
    } catch { await send("Fetch.continueRequest", { requestId }).catch(() => {}); }
  });
}
