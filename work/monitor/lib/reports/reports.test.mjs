import assert from "node:assert/strict";
import test from "node:test";
import { createIncidentStore } from "../incidents/store.mjs";
import { buildTroubleshootingReport, redactReport, REPORT_MAX_BYTES } from "./model.mjs";
import { createReportService } from "./service.mjs";

const NOW = Date.UTC(2026, 9, 6, 2);
const config = { sshUser: "researcher", servers: [{ id: "s1", host: "cluster.example.test", name: "研究集群" }, { id: "s2", host: "second.invalid" }] };

test("报告脱敏覆盖私钥、header、JSON/shell 凭据、URL、主机和用户；保留诊断内容", () => {
  const raw = ['KeyError: arm', 'export OPENAI_API_KEY="sk-sensitive123456"', 'Authorization: Bearer abc.def-xyz', '{"access_token":"private-value"}',
    'https://alice:password@example.test/a?token=supersecret&x=1', '10.20.30.40 /home/researcher/run/log', 'ssh researcher@cluster.example.test',
    [['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '), 'private-key-data', ['-----END', 'OPENSSH PRIVATE KEY-----'].join(' ')].join('\n')].join("\n");
  const { text, count } = redactReport(raw, { hosts: ["cluster.example.test"], users: ["researcher"] });
  for (const secret of ["sk-sensitive", "abc.def", "private-value", "supersecret", "alice:password", "10.20.30.40", "researcher", "cluster.example.test", "private-key-data"]) assert.ok(!text.includes(secret), secret);
  assert.match(text, /KeyError: arm/);
  assert.ok(count >= 8);
});

test("报告 Markdown 将代码围栏作为原文，体积有界，缺数据如实标记", () => {
  const report = buildTroubleshootingReport({ kind: "job", server: config.servers[0], version: "2.50.0", generatedAt: NOW, job: { id: "123", state: "FAILED" },
    diagnosis: { headline: "错误", files: [{ path: "/home/person/stdout", tail: '```\n<img src="remote">\n```' }] }, availability: ["采集缺失"] });
  assert.match(report.markdown, /````text\n```/);
  assert.match(report.markdown, /未记录/);
  assert.match(report.markdown, /采集缺失/);
  assert.ok(Buffer.byteLength(report.markdown) <= REPORT_MAX_BYTES);
  assert.equal(report.filename, "job-123-report.md");
});

test("报告使用真实事件存储关联同服务器时间窗口；不读取其它服务器操作或默认脚本", async () => {
  const store = createIncidentStore({ now: () => NOW, openGate: {} });
  const target = store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", at: NOW - 10_000 });
  const other = store.observe({ serverId: "s2", component: "tunnel", reasonCode: "TUNNEL_DOWN", at: NOW - 10_000 });
  store.linkOperation(target.incidentId, "operation-one");
  store.linkOperation(other.incidentId, "private-operation-two");
  const reads = [];
  let scriptReads = 0;
  const service = createReportService({ getConfig: async () => config, incidentStore: store, now: () => NOW, version: "test",
    jobsService: { getSnapshot: () => ({ state: "ok", checkedAt: NOW, user: "researcher", jobs: [{ id: "9", name: "train", state: "FAILED", startAt: NOW - 600_000, endAt: NOW - 5_000 }] }),
      listDiagnoses: async () => ({ items: [{ jobId: "9", headline: "KeyError: arm", evidence: ["KeyError: arm"], endedAtMs: NOW - 5_000 }] }),
      getDiagnosisScript: async () => { scriptReads++; return "echo marker"; } },
    tunnelStability: { loadEvents: async () => [{ type: "down", serverId: "s1", at: NOW - 10_000, cause: "timeout" }, { type: "down", serverId: "s2", at: NOW - 10_000, detail: "secret-second" }] },
    readOperationLogs: async (id) => { reads.push(id); return [{ ts: "now", level: "info", message: "retry done" }]; },
  });
  const report = await service.build({ kind: "job", serverId: "s1", jobId: "9" });
  assert.match(report.markdown, /operation-one/);
  assert.match(report.markdown, /KeyError: arm/);
  assert.match(report.markdown, /timeout/);
  assert.ok(!report.markdown.includes("private-operation-two"));
  assert.ok(!report.markdown.includes("secret-second"));
  assert.deepEqual(reads, ["operation-one"]);
  assert.equal(scriptReads, 0);
  const scripted = await service.build({ kind: "job", serverId: "s1", jobId: "9", includeScript: true });
  assert.match(scripted.markdown, /echo marker/);
  await assert.rejects(service.build({ kind: "incident", serverId: "s2", incidentId: target.incidentId }), { status: 404 });
  await assert.rejects(service.build({ kind: "job", serverId: "missing", jobId: "9" }), { status: 404 });
});

test("模块关闭拒绝作业报告；日志读取失败仍能导出已有证据", async () => {
  const service = createReportService({ getConfig: async () => ({ ...config, modules: { jobs: false } }) });
  await assert.rejects(service.build({ kind: "job", serverId: "s1", jobId: "9" }), { status: 409 });
  const event = { incidentId: "incident", serverId: "s1", component: "tunnel", reasonCode: "TIMEOUT", firstSeenAt: NOW - 1000, lastSeenAt: NOW, relatedOperationIds: ["op"] };
  const partial = createReportService({ getConfig: async () => config, now: () => NOW,
    incidentStore: { getIncident: () => event, query: () => ({ incidents: [] }) },
    tunnelStability: { loadEvents: async () => { throw new Error("unreadable"); } },
    readOperationLogs: async () => { throw new Error("unreadable"); },
  });
  const result = await partial.build({ kind: "incident", serverId: "s1", incidentId: "incident" });
  assert.match(result.markdown, /TIMEOUT/);
  assert.match(result.markdown, /读取失败/);
});

test("完整隐藏多项 Cookie、CLI 凭据、IPv6 与大小写主机；时间不计入脱敏数", () => {
  const raw = [
    "Cookie: session=first-cookie; refresh=second-cookie; flag=third-cookie",
    "Set-Cookie: auth=fourth-cookie; Secure; HttpOnly",
    "tool --token command-secret --password 'space secret' --api-key=cli-key",
    "[2001:db8::abcd]:8080 fe80::1234%en0 ::ffff:192.0.2.128",
    "AKIAABCDEFGHIJKLMNOP hf_abcdefghijklmnopqrst",
    "AWS_SECRET_ACCESS_KEY=aws-secret-value secret_key=another-secret",
    "ssh u@CLUSTER.EXAMPLE.TEST 2026-10-06 08:30:21",
  ].join("\n");
  const redacted = redactReport(raw, { hosts: ["cluster.example.test"], users: ["u"] });
  for (const secret of ["first-cookie", "second-cookie", "third-cookie", "fourth-cookie", "command-secret", "space secret", "cli-key", "2001:db8", "fe80", "192.0.2.128", "AKIAABCDEFGHIJKLMNOP", "hf_abcdefghijklmnopqrst", "aws-secret-value", "another-secret", "CLUSTER.EXAMPLE.TEST", "ssh u@"]) {
    assert.ok(!redacted.text.includes(secret), secret);
  }
  const timestamp = redactReport("2026-10-06 08:30:21");
  assert.equal(timestamp.text, "2026-10-06 08:30:21");
  assert.equal(timestamp.count, 0);
});

test("共享处置 ID 不把其他服务器日志混入报告；公共步骤的已配置地址也脱敏", async () => {
  const incident = { incidentId: "event", serverId: "s1", component: "tunnel", firstSeenAt: NOW - 1000, lastSeenAt: NOW, relatedOperationIds: ["global-operation"] };
  const service = createReportService({ getConfig: async () => config, now: () => NOW,
    incidentStore: { getIncident: () => incident, query: () => ({ incidents: [] }) },
    readOperationLogs: async (_id, serverId) => {
      assert.equal(serverId, "s1");
      return [
        { ts: NOW, level: "info", serverId: "s2", message: "second-server-private-evidence" },
        { ts: NOW, level: "info", serverId: "s1", message: "first-server-step" },
        { ts: NOW, level: "info", message: "common-step second.invalid" },
      ];
    },
  });
  const report = await service.build({ kind: "incident", serverId: "s1", incidentId: "event" });
  assert.ok(!report.markdown.includes("second-server-private-evidence"));
  assert.ok(!report.markdown.includes("second.invalid"));
  assert.match(report.markdown, /first-server-step/);
  assert.match(report.markdown, /common-step/);
  assert.match(report.markdown, /2026-10-06 10:00:00 北京时间 info first-server-step/);
});

test("日志中的 Markdown 链接与 HTML 不会逃出标题/断线说明成为下载报告中的活动内容", () => {
  const report = buildTroubleshootingReport({ kind: "job", job: { id: "8" }, generatedAt: NOW,
    diagnosis: { headline: "<img src=https://invalid.test/x> ![x](https://invalid.test/image)" },
    disconnects: [{ at: NOW, detail: "<script>bad()</script>" }],
  });
  assert.doesNotMatch(report.markdown, /(?<!\\)<img/);
  assert.ok(!report.markdown.includes("![x]"));
  assert.doesNotMatch(report.markdown, /(?<!\\)<script>/);
  assert.match(report.markdown, /\\<img/);
});

test("真实报告先转义 Markdown 的诊断/断线说明仍隐藏带下划线的凭据键", () => {
  const report = buildTroubleshootingReport({ kind: "job", job: { id: "8" }, generatedAt: NOW,
    diagnosis: { headline: "AWS_SECRET_ACCESS_KEY=private OPENAI_API_KEY=non-sk-custom-value" },
    disconnects: [{ at: NOW, detail: "OPENAI_API_KEY=opaque-custom-value status_code=200" }],
  });
  for (const value of ["private", "non-sk-custom-value", "opaque-custom-value"]) assert.ok(!report.markdown.includes(value), value);
  assert.match(report.markdown, /AWS\\_SECRET\\_ACCESS\\_KEY=\[凭据已隐藏\]/);
  assert.match(report.markdown, /status\\_code=200/);
  assert.equal(report.redactions, 3);
});

test("同期隧道断线：账本里带 sleep 的那几次标成「本机休眠造成」，其余照旧是计划内 / 非计划内", () => {
  const report = buildTroubleshootingReport({ kind: "job", job: { id: "8" }, generatedAt: NOW,
    disconnects: [
      { at: NOW - 3000, cause: "closed", detail: "Connection closed by 192.0.2.10 port 22", planned: false, networkChange: true, sleep: true },
      { at: NOW - 2000, cause: "keepalive-timeout", detail: "", planned: false, sleep: false },
      { at: NOW - 1000, cause: "restart", planned: true, sleep: false },
      { at: NOW, cause: "remote-closed", planned: false }, // 旧版 supervisor 记的行没有 sleep 字段
    ],
  });
  const lines = report.markdown.split("\n").filter((line) => /· (计划内|非计划内|本机休眠造成)$/.test(line));
  assert.deepEqual(lines.map((line) => line.split(" · ").at(-1)), ["本机休眠造成", "非计划内", "计划内", "非计划内"]);
});
