import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";

import { createJobsRoutes } from "./jobs.mjs";
import { createJobsService } from "../../jobs/service.mjs";
import { createJobWatchStore } from "../../jobs/watch-store.mjs";
import { statusError } from "../../status-error.mjs";

function fakeRes() {
  return { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, setHeader() {}, end(body) { this.body = body; } };
}

const NOW = Date.UTC(2026, 9, 3, 4, 0, 0);
const SNAPSHOT = {
  state: "ok", checkedAt: NOW, user: "kai", reason: null, total: 2, truncated: false,
  jobs: [
    { id: "16446", name: "lib_audit_d", state: "COMPLETED", stateRaw: "COMPLETED", exitCode: 0, signal: 0, submitAt: NOW - 7200_000, startAt: NOW - 7200_000, endAt: NOW - 3600_000, elapsedSec: 3600, nodes: "node06", partition: "CPU" },
    { id: "16447", name: "train_lora", state: "FAILED", stateRaw: "FAILED", exitCode: 137, signal: 0, submitAt: NOW - 5400_000, startAt: NOW - 5400_000, endAt: NOW - 1800_000, elapsedSec: 3600, nodes: "master", partition: "GPU" },
  ],
};

async function call(route, query, method = "GET") {
  const res = fakeRes();
  const handled = await route({ req: { method }, res, url: new URL(`http://x/api/jobs${query}`) });
  return { handled, res, body: res.body ? JSON.parse(res.body) : null };
}

test("GET /api/jobs：按服务器返回聚合后的近 48 小时历史（有问题的在前）", async () => {
  const asked = [];
  const route = createJobsRoutes({ jobsService: { getSnapshot: (id) => { asked.push(id); return id === "server-01" ? SNAPSHOT : null; } } });
  const { handled, res, body } = await call(route, "?serverId=server-01");
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    [body.schemaVersion, body.serverId, body.state, body.windowHours, body.user, body.checkedAt, body.total, body.kept, body.truncated],
    [1, "server-01", "ok", 48, "kai", NOW, 2, 2, false],
  );
  assert.deepEqual(body.summary, { ended: 2, completed: 1, failed: 1, cancelled: 0, other: 0, running: 0, pending: 0 });
  assert.deepEqual(body.rows.map((r) => [r.id, r.outcome]), [["16447", "failed"], ["16446", "completed"]]);
  assert.equal("stateRaw" in body.rows[0], false, "只带展示需要的字段");
  assert.deepEqual(asked, ["server-01"]);
});

test("GET /api/jobs：没有快照（未采集 / 不在采集范围）不是错误，state=none", async () => {
  const route = createJobsRoutes({ jobsService: { getSnapshot: () => null } });
  const { res, body } = await call(route, "?serverId=server-me");
  assert.equal(res.statusCode, 200);
  assert.equal(body.state, "none");
  assert.deepEqual(body.rows, []);
});

test("GET /api/jobs：serverId 缺失 / 非法 → 400，且不去查快照；无服务 → 503", async () => {
  let asked = 0;
  const route = createJobsRoutes({ jobsService: { getSnapshot: () => { asked += 1; return null; } } });
  for (const query of ["", "?serverId=", "?serverId=a%20b", "?serverId=..%2Fetc", `?serverId=${"x".repeat(65)}`]) {
    const { res } = await call(route, query);
    assert.equal(res.statusCode, 400, query);
  }
  assert.equal(asked, 0);
  const none = await call(createJobsRoutes({ jobsService: null }), "?serverId=server-01");
  assert.equal(none.res.statusCode, 503);
});

// ---- v2.49 失败作业诊断 ----

async function callPath(route, pathAndQuery) {
  const res = fakeRes();
  const handled = await route({ req: { method: "GET" }, res, url: new URL(`http://x${pathAndQuery}`) });
  return { handled, res, body: res.body ? JSON.parse(res.body) : null };
}

const failing = (id, name, minutesAgo) => ({ id, name, state: "FAILED", stateRaw: "FAILED", exitCode: 1, signal: 0, submitAt: NOW - 7200_000, startAt: NOW - 7200_000, endAt: NOW - minutesAgo * 60_000, elapsedSec: 60, nodes: "node03", partition: "CPU" });
const DIAG_SNAPSHOT = {
  ...SNAPSHOT,
  total: 5,
  jobs: [...SNAPSHOT.jobs, failing("201", "sweep_1", 10), failing("202", "sweep_2", 11), failing("203", "sweep_3", 12)],
};

function diagService() {
  const asked = [];
  return {
    asked,
    getSnapshot: () => DIAG_SNAPSHOT,
    ready: async () => {},
    diagnosisOf: (serverId, jobId) => {
      asked.push(`${serverId}/${jobId}`);
      return jobId === "16447" || jobId === "202" ? { category: "python", headline: "KeyError: 'arm'", extra: "dropped" } : null;
    },
    listDiagnoses: async (serverId, opts) => ({ items: [{ jobId: "202", serverId, since: opts.since }], groups: [] }),
    getDiagnosisScript: async (serverId, jobId) => (serverId === "server-01" && jobId === "202" ? "#!/bin/bash\n" : null),
  };
}

test("GET /api/jobs：作业行带 diagnosis（顶层单条行与折叠组 children），没诊断的为 null", async () => {
  const service = diagService();
  const { body } = await callPath(createJobsRoutes({ jobsService: service }), "/api/jobs?serverId=server-01");
  const group = body.rows.find((r) => r.kind === "group");
  const single = body.rows.find((r) => r.kind === "job" && r.id === "16447");
  const completed = body.rows.find((r) => r.id === "16446");
  assert.deepEqual(single.diagnosis, { category: "python", headline: "KeyError: 'arm'" }, "只带 category / headline");
  assert.equal(completed.diagnosis, null);
  assert.equal("diagnosis" in group, false, "组本身不带，看 children");
  assert.deepEqual(group.children.map((c) => [c.id, c.diagnosis?.headline ?? null]), [["201", null], ["202", "KeyError: 'arm'"], ["203", null]]);
  assert.ok(service.asked.every((key) => key.startsWith("server-01/")));
  assert.equal(service.asked.includes("server-01/16446"), false, "完成的作业不查");
  // 旧服务（没有 diagnosisOf）照常工作，diagnosis 恒为 null。
  const legacy = await callPath(createJobsRoutes({ jobsService: { getSnapshot: () => SNAPSHOT } }), "/api/jobs?serverId=server-01");
  assert.ok(legacy.body.rows.every((r) => r.diagnosis === null));
});

test("GET /api/jobs/diagnoses 与 /script：契约、since、400、模块关闭", async () => {
  const route = createJobsRoutes({ jobsService: diagService() });
  const list = await callPath(route, "/api/jobs/diagnoses?serverId=server-01&since=1700000000000");
  assert.equal(list.res.statusCode, 200);
  assert.deepEqual(list.body, { items: [{ jobId: "202", serverId: "server-01", since: 1700000000000 }], groups: [] });
  assert.equal((await callPath(route, "/api/jobs/diagnoses?serverId=server-01")).body.items[0].since, null);
  const script = await callPath(route, "/api/jobs/diagnoses/script?serverId=server-01&jobId=202");
  assert.deepEqual(script.body, { jobId: "202", script: "#!/bin/bash\n" });
  assert.deepEqual((await callPath(route, "/api/jobs/diagnoses/script?serverId=server-01&jobId=18006_3")).body, { jobId: "18006_3", script: null });

  for (const bad of [
    "/api/jobs/diagnoses",
    "/api/jobs/diagnoses?serverId=a%20b",
    "/api/jobs/diagnoses?serverId=server-01&since=-1",
    "/api/jobs/diagnoses?serverId=server-01&since=abc",
    "/api/jobs/diagnoses/script?serverId=server-01",
    "/api/jobs/diagnoses/script?serverId=server-01&jobId=..%2Fx",
    "/api/jobs/diagnoses/script?serverId=..%2F&jobId=1",
  ]) {
    assert.equal((await callPath(route, bad)).res.statusCode, 400, bad);
  }

  const off = createJobsRoutes({ jobsService: diagService(), getConfig: async () => ({ modules: { jobs: false } }) });
  for (const p of ["/api/jobs?serverId=server-01", "/api/jobs/diagnoses?serverId=server-01", "/api/jobs/diagnoses/script?serverId=server-01&jobId=1", "/api/jobs/diagnoses?serverId=bad%20id"]) {
    const { res, body } = await callPath(off, p);
    assert.deepEqual([res.statusCode, body], [200, { disabled: true }], p);
  }
  assert.equal((await callPath(createJobsRoutes({ jobsService: null }), "/api/jobs/diagnoses?serverId=server-01")).res.statusCode, 503);
});

test("只认 GET：其它方法不归这组路由处理", async () => {
  const route = createJobsRoutes({ jobsService: { getSnapshot: () => SNAPSHOT } });
  const { handled, res } = await call(route, "?serverId=server-01", "POST");
  assert.equal(handled, false);
  assert.equal(res.statusCode, 0);
});

async function callWatch(route, query, body) {
  const req = Readable.from(body === undefined ? [] : [typeof body === "string" ? body : JSON.stringify(body)]);
  req.method = body === undefined ? "GET" : "POST";
  const res = fakeRes();
  const handled = await route({ req, res, url: new URL(`http://x/api/jobs/watch${query}`) });
  return { handled, status: res.statusCode, body: JSON.parse(res.body) };
}

test("关注API：全局通知/服务器视图、POST回完整对象、body上限与业务状态码", async () => {
  const received = [];
  const service = {
    getWatchView: async (serverId) => ({ serverId, watches: [], notifications: [] }),
    changeWatch: async (serverId, body) => {
      received.push([serverId, body]);
      if (body.action === "watch" && body.jobIds?.[0] === "99") throw statusError("只能关注本人作业", 409);
      return { serverId, watches: [{ id: "watch-1" }], notifications: [] };
    },
  };
  const route = createJobsRoutes({ jobsService: service });
  assert.equal((await callWatch(route, "")).body.serverId, null);
  assert.equal((await callWatch(route, "?serverId=server-01")).body.serverId, "server-01");
  const added = await callWatch(route, "?serverId=server-01", { action: "watch", jobIds: ["1"] });
  assert.equal(added.status, 200);
  assert.equal(added.body.watches[0].id, "watch-1");
  assert.deepEqual(received[0], ["server-01", { action: "watch", jobIds: ["1"] }]);
  assert.equal((await callWatch(route, "", { action: "ack", notificationId: "all" })).status, 200);
  assert.equal((await callWatch(route, "?serverId=server-01", { action: "watch", jobIds: ["99"] })).status, 409);
  for (const body of ["broken", "[]", JSON.stringify({ action: "watch", label: "x".repeat(20000) })]) assert.equal((await callWatch(route, "?serverId=server-01", body)).status, 400);
  assert.equal((await callWatch(route, "?serverId=")).status, 400);
  assert.equal((await callWatch(route, "?serverId=..%2Fx")).status, 400);
  const off = createJobsRoutes({ jobsService: service, getConfig: async () => ({ modules: { jobs: false } }) });
  assert.deepEqual((await callWatch(off, "")).body, { disabled: true });
});

test("提醒规则（v2.62）经同一对接口读写：GET 带 rules / suggestions，POST rules 保存；非法输入 400 且不生效", async () => {
  const snapshot = { ...SNAPSHOT, jobs: [...SNAPSHOT.jobs, { id: "16500", name: "cfdauto_setup_0001", state: "RUNNING", stateRaw: "RUNNING", exitCode: 0, signal: 0, submitAt: NOW - 600_000, startAt: NOW - 600_000, endAt: null, elapsedSec: 600, nodes: "node01", partition: "CPU" }] };
  const service = createJobsService({
    getConfig: async () => ({ servers: [{ id: "server-01", host: "myserver", name: "主集群服务器 (myserver)" }] }),
    execCollector: async () => ({ code: 0, stdout: `now=${Math.floor(NOW / 1000)}\ntz=+0800\nuser=kai\nstate=ok\n` }),
    probeSshFailureReason: () => "x", now: () => NOW, watchStore: createJobWatchStore({ now: () => NOW }),
  });
  const route = createJobsRoutes({ jobsService: { ...service, getSnapshot: () => snapshot } });
  const first = await callWatch(route, "?serverId=server-01");
  assert.deepEqual([first.status, first.body.rules, first.body.watches], [200, { failNotify: true, longRunMinutes: null, patterns: [] }, []]);
  assert.ok(Array.isArray(first.body.suggestions));
  const global = await callWatch(route, "");
  assert.deepEqual(global.body.servers.map((s) => [s.serverId, s.name, s.rules.failNotify]), [["server-01", "主集群服务器 (myserver)", true]]);

  const saved = await callWatch(route, "?serverId=server-01", { action: "rules", failNotify: false, longRunMinutes: 120, patterns: ["cfdauto_*", "xp_?"] });
  assert.deepEqual([saved.status, saved.body.rules], [200, { failNotify: false, longRunMinutes: 120, patterns: ["cfdauto_*", "xp_?"] }]);
  for (const body of [
    { action: "rules" },
    { action: "rules", failNotify: "no" },
    { action: "rules", longRunMinutes: 1 },
    { action: "rules", patterns: ["ok", "x".repeat(65)] },
    { action: "rules", patterns: Array.from({ length: 13 }, (_, i) => `p${i}`) },
    { action: "rules", patterns: ["line\nbreak"] },
  ]) {
    const rejected = await callWatch(route, "?serverId=server-01", body);
    assert.equal(rejected.status, 400, JSON.stringify(body));
    assert.equal(typeof rejected.body.error, "string");
  }
  assert.equal((await callWatch(route, "", { action: "rules", failNotify: true })).status, 400, "规则按服务器存，必须带 serverId");
  assert.equal((await callWatch(route, "?serverId=server-99", { action: "rules", failNotify: true })).status, 404);
  assert.deepEqual((await callWatch(route, "?serverId=server-01")).body.rules, { failNotify: false, longRunMinutes: 120, patterns: ["cfdauto_*", "xp_?"] }, "被拒的请求没有改动任何规则");

  // 单条增删（界面用的写法）：只动那一条；加已有的、删没有的都算成功；与整份替换同用 → 400。
  const added = await callWatch(route, "?serverId=server-01", { action: "rules", addPattern: " lora_* " });
  assert.deepEqual([added.status, added.body.rules.patterns], [200, ["cfdauto_*", "xp_?", "lora_*"]]);
  assert.deepEqual((await callWatch(route, "?serverId=server-01", { action: "rules", addPattern: "xp_?" })).body.rules.patterns, ["cfdauto_*", "xp_?", "lora_*"]);
  const removed = await callWatch(route, "?serverId=server-01", { action: "rules", removePattern: "cfdauto_*" });
  assert.deepEqual([removed.status, removed.body.rules], [200, { failNotify: false, longRunMinutes: 120, patterns: ["xp_?", "lora_*"] }]);
  assert.equal((await callWatch(route, "?serverId=server-01", { action: "rules", removePattern: "gone_*" })).status, 200);
  assert.equal((await callWatch(route, "?serverId=server-01", { action: "rules", patterns: ["a_*"], addPattern: "b_*" })).status, 400);
  assert.equal((await callWatch(route, "?serverId=server-01", { action: "rules", addPattern: "x".repeat(65) })).status, 400);
  assert.deepEqual((await callWatch(route, "?serverId=server-01")).body.rules.patterns, ["xp_?", "lora_*"]);
});

test("GET /api/jobs/log-segment（v2.51）：参数严格校验后交给服务，带调度器槽位；身份失效回 409 + code", async () => {
  const asked = [];
  const slot = async () => () => {};
  const service = {
    readLogSegment: async (serverId, query, opts) => {
      asked.push([serverId, query, opts.acquireSshSlot === slot]);
      if (query.log === "stderr") throw statusError("日志文件已被替换", 409, { code: "rotated" });
      return { jobId: query.jobId, text: "a\n", next: null };
    },
  };
  const route = createJobsRoutes({ jobsService: service, acquireSshSlot: slot });
  const ok = await callPath(route, "/api/jobs/log-segment?serverId=server-01&jobId=18765&from=watch&log=stdout");
  assert.deepEqual([ok.res.statusCode, ok.body.text], [200, "a\n"]);
  assert.deepEqual(asked[0], ["server-01", { jobId: "18765", from: "watch", log: "stdout", cursor: null, fresh: false }, true]);
  const gone = await callPath(route, "/api/jobs/log-segment?serverId=server-01&jobId=18765&from=watch&log=stderr");
  assert.deepEqual([gone.res.statusCode, gone.body], [409, { error: "日志文件已被替换", code: "rotated" }]);
  for (const bad of [
    "/api/jobs/log-segment?serverId=server-01&jobId=1;ls&from=watch&log=stdout",
    "/api/jobs/log-segment?serverId=server-01&jobId=1&from=watch&log=/etc/passwd",
    "/api/jobs/log-segment?serverId=server-01&jobId=1&from=diagnosis&log=9",
    "/api/jobs/log-segment?serverId=server-01&jobId=1&from=watch&log=stdout&before=-1&ino=1&size=2",
    "/api/jobs/log-segment?serverId=a%20b&jobId=1&from=watch&log=stdout",
  ]) {
    const { res } = await callPath(route, bad);
    assert.equal(res.statusCode, 400, bad);
  }
  assert.equal(asked.length, 2, "不合格的请求不进服务");
  const off = createJobsRoutes({ jobsService: service, getConfig: async () => ({ modules: { jobs: false } }) });
  assert.deepEqual((await callPath(off, "/api/jobs/log-segment?serverId=server-01&jobId=1&from=watch&log=stdout")).body, { disabled: true });
  const legacy = createJobsRoutes({ jobsService: {} });
  assert.equal((await callPath(legacy, "/api/jobs/log-segment?serverId=server-01&jobId=1&from=watch&log=stdout")).res.statusCode, 503);
});
