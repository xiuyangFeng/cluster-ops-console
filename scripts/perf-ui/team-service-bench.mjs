// 团队概览接口的等待时间（服务端）：模拟集群 ssh 采集耗时，按页面节奏（每 25 秒一次）连续请求，
// 记录每次 getOverview 要等多久。node scripts/perf-ui/team-service-bench.mjs <源码树> [--ssh=800] [--polls=6]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [tree] = process.argv.slice(2);
const opt = Object.fromEntries(process.argv.slice(3).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const SSH_MS = Number(opt.ssh || 800);
const POLLS = Number(opt.polls || 6);
const { createTeamAdminService } = await import(pathToFileURL(path.join(tree, "work/monitor/lib/team-admin/service.mjs")).href);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-svc-bench-"));
let clock = 1_800_000_000_000;
let surveys = 0;
const config = { activeServerId: "s1", adminUsers: ["kai"], servers: [{ id: "s1", name: "集群", host: "fixture.invalid", sshUser: "kai" }] };
const stdout = ["ME=kai", "NOW=1760000000", "HUB_BASE=ok", "HUB_OWNER=kai", "ROSTER-BEGIN", JSON.stringify({ v: 1, members: { kai: {} } }), "ROSTER-END"].join("\n");
const service = createTeamAdminService({
  getConfig: async () => config,
  getMergedConfig: () => config,
  runRemote: async () => {
    surveys += 1;
    await new Promise((r) => setTimeout(r, SSH_MS));
    return { code: 0, stdout };
  },
  pendingPath: path.join(dir, "pending.json"),
  version: "2.69.0",
  now: () => clock,
});
const waits = [];
for (let i = 0; i < POLLS; i += 1) {
  const t = performance.now();
  await service.getOverview({ serverId: "s1" });
  waits.push(Math.round(performance.now() - t));
  await new Promise((r) => setTimeout(r, SSH_MS + 50)); // 让后台采集有机会跑完
  clock += 25_000;
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ tree: path.basename(tree), sshMs: SSH_MS, waitsMs: waits, surveys }));
