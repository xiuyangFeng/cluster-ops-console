import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVITY_MAX_AGE_MS, activityServer, observeUserActivity } from "./activity.mjs";
import { createStorageAdminService } from "./service.mjs";
import { createStorageAdminStore } from "./store.mjs";

const NOW = Date.UTC(2026, 10, 11, 8);
const users = [{ uid: 1029, name: "example-user", lastLogin: NOW / 1000 - 44 * 86400 }];
const resources = { level: "ok", checkedAt: NOW - 1000, output: "master\nother", slurm: { state: "ok", jobs: [
  { user: "example-user", state: "RUNNING" }, { user: "example-user", state: "COMPLETING" }, { user: "other", state: "RUNNING" },
] } };
const observe = (extra = {}) => observeUserActivity({ users, infoHost: "master", resources, now: NOW, ...extra });

test("旧 lastlog 与两项运行作业同时保留；作业活动不伪造成新登录", () => {
  const out = observe();
  assert.equal(out.byUid[1029].runningJobs, 2);
  assert.equal(out.byUid[1029].active, true);
  assert.equal(out.byUid[1029].sshOnline, false);
  assert.equal(out.records[1029].at, resources.checkedAt, "使用真实采样时间，不使用页面打开时间");
  assert.deepEqual(out.records[1029].sources, ["jobs"]);
  assert.equal(users[0].lastLogin, NOW / 1000 - 44 * 86400);
});

test("团队 SSH/Agent 与 Slurm 排队活动融合，缺少证据不当作离线证明", () => {
  const out = observe({ resources: { ...resources, slurm: { state: "ok", jobs: [{ user: "example-user", state: "PENDING" }] } },
    team: { checkedAt: NOW - 500, sshUsers: ["example-user"], agentProcs: { "example-user": { codex: 2 } } } });
  assert.deepEqual([out.byUid[1029].sshOnline, out.byUid[1029].agentProcesses, out.byUid[1029].pendingJobs], [true, 2, 1]);
  assert.deepEqual(observe({ resources: null }).byUid, {});
});

test("过期、失败、未来或不同节点采样不冒充当前活动，已观测时间不会不断刷新", () => {
  const previous = observe().records;
  for (const bad of [{ ...resources, checkedAt: NOW - ACTIVITY_MAX_AGE_MS - 1 }, { ...resources, checkedAt: NOW + 1 }, { ...resources, level: "error" }, { ...resources, output: "node04\n" }]) {
    const out = observe({ resources: bad, previous });
    assert.equal(out.byUid[1029].active, false);
    assert.equal(out.byUid[1029].lastObservedAt, resources.checkedAt);
  }
  const staleTeam = observe({ resources: null, team: { checkedAt: NOW - ACTIVITY_MAX_AGE_MS - 1, sshUsers: ["example-user"] } });
  assert.deepEqual(staleTeam.byUid, {});
  assert.deepEqual(observe({ resources: null, users: [{ uid: 1029, name: "new-owner" }], previous }).byUid, {}, "UID 被新账号复用时不继承旧活动");
  assert.deepEqual(observe({ resources: null, previous: { 1029: { user: "example-user", at: NOW + 1 } } }).records, {});
});

test("节点活动匹配配置地址与端口，显式连接优先，歧义不猜，用户名区分大小写", () => {
  const a = { id: "master", host: "master-alias", sshHostName: "master.example", sshPort: 2222 };
  const config = { servers: [a, { id: "node04", host: "node04" }] };
  assert.equal(activityServer({ id: "disk", host: "master.example", port: 2222 }, config), a);
  assert.equal(activityServer({ id: "master", host: "other.example", port: 2222 }, config), null);
  assert.equal(activityServer({ host: "master.example", port: 22 }, config), null);
  config.servers.push({ ...a, id: "other-account" });
  assert.equal(activityServer({ host: "master.example", port: 2222 }, config), null);
  assert.equal(activityServer({ connectionId: "master" }, config), a);
  assert.deepEqual(observe({ users: [{ uid: 1029, name: "Example-user" }] }).byUid, {});
});

test("存储概览融合并保存活动观测，重启后保留；不新增 SSH，不混入换节点前的缓存", async () => {
  let clock = NOW, calls = 0;
  const config = { servers: [{ id: "master", host: "master", sshUser: "root" }], storageAdmin: { targets: [{ id: "disk", connectionId: "master", roots: ["/public"] }] } };
  const store = createStorageAdminStore({});
  const options = { getConfig: async () => config, isAdmin: () => true, store, now: () => clock,
    getActivityFacts: () => ({ resources }),
    exec: async () => { calls++; return { code: 0, stdout: JSON.stringify({ k: "info", v: 3, host: "master", roots: [{ path: "/public", children: [] }],
      mounts: [{ mount: "/public", size: 100, used: 50 }], users, jobs: [] }) }; } };
  const svc = createStorageAdminService(options);
  await svc.refresh("disk");
  await store.patchTarget("disk", { scans: [{ job: { id: "result123", root: "/public", state: "done" }, owners: [{ uid: 1029, bytes: 10, files: 1 }] }] });
  let row = (await svc.overview()).targets[0].users[0].rows[0];
  assert.equal(row.lastLogin, users[0].lastLogin);
  assert.equal(row.activity.runningJobs, 2);
  assert.equal(row.activity.sshOnline, false);
  clock += ACTIVITY_MAX_AGE_MS + 1;
  row = (await svc.overview()).targets[0].users[0].rows[0];
  assert.equal(row.activity.active, false);
  assert.equal(row.activity.lastObservedAt, resources.checkedAt);
  const restarted = createStorageAdminService({ ...options, getActivityFacts: () => null });
  assert.equal((await restarted.overview()).targets[0].users[0].rows[0].activity.lastObservedAt, resources.checkedAt);
  const saved = await store.getTarget("disk");
  await store.patchTarget("disk", { info: { ...saved.info, users: [{ uid: 1029, name: "new-owner", lastLogin: 0 }] },
    scans: [{ ...saved.scans[0], owners: [{ ...saved.scans[0].owners[0], name: "example-user" }] }] });
  const renamed = (await restarted.overview()).targets[0].users[0].rows[0];
  assert.equal(renamed.name, "new-owner", "当前 UID 账号名称优先于旧扫描保存的名字");
  assert.equal(renamed.activity, undefined);
  config.servers[0].host = "other-cluster";
  assert.deepEqual((await restarted.overview()).targets[0].users, []);
  assert.equal(calls, 1, "所有概览、观测与重启检查均未追加 SSH");
});
