import assert from "node:assert/strict";
import test from "node:test";
import { buildClusterPanelModel, describeReason, pendingStartEstimate, queueReasonAdvice } from "./cluster-model.js";
import { buildGroupedJobRowsHtml } from "./cluster-view.js";
import { inEveryTimeZone } from "../../../../lib/test-timezones.mjs";

const now = Date.parse("2026-10-23T23:58:00+08:00");
const startAt = Date.parse("2026-10-24T00:05:00+08:00");
test("Reason 分别给出等待、资源调整、个人 GPU 配额、依赖、挂起和未知原因建议", () => {
  for (const [reason, pattern] of [["Priority", /优先级.*回填/], ["Resources", /GPU 型号.*过量申请/], ["QOSMaxGRESPerUser", /个人.*正在使用的卡数/], ["Dependency", /afterok/], ["DependencyNeverSatisfied", /无法满足/], ["JobHeldAdmin", /联系管理员/], ["AssocGrpMemLimit", /账户资源限制/], ["FutureReason", /暂未收录/], ["", /尚未给出明确原因/], ["constructor", /暂未收录/]]) assert.match(queueReasonAdvice(reason), pattern, reason);
  assert.match(describeReason("QOSMaxGRESPerUser").text, /个人 GPU/);
});

test("预计开始证据等级：新鲜回填中等，条件阻塞低，过期/缺失/死锁不可作为承诺", () => {
  assert.equal(pendingStartEstimate({ reason: "Priority", startAt }, now, now).confidence, "medium");
  assert.equal(pendingStartEstimate({ reason: "Resources", startAt }, now, now).confidence, "medium");
  assert.equal(pendingStartEstimate({ reason: "QOSMaxGRESPerUser", startAt }, now, now).confidence, "low");
  assert.equal(pendingStartEstimate({ reason: "Dependency", startAt }, now, now).confidence, "low");
  const stale = pendingStartEstimate({ reason: "Priority", startAt }, now - 180001, now);
  assert.equal(stale.at, null);
  assert.match(stale.text, /采样已过期/);
  for (const at of [null, now - 120000, Date.parse("2099-01-01T00:00:00Z")]) {
    assert.equal(pendingStartEstimate({ reason: "Resources", startAt: at }, now, now).confidence, "unavailable");
  }
  assert.equal(pendingStartEstimate({ reason: "DependencyNeverSatisfied", startAt }, now, now).at, null);
  assert.equal(pendingStartEstimate({ startAt }, now + 60001, now).at, null);
  assert.equal(pendingStartEstimate({ startAt }, null, now).at, null);
});

test("跨日预计时刻一律北京时间；折叠组展开后每个本人作业有建议，原文全部转义", async () => {
  await inEveryTimeZone((zone) => {
    assert.match(pendingStartEstimate({ reason: "Resources", startAt }, now, now).text, /明天 00:05/, zone);
    const beforeMidnight = Date.parse("2026-10-23T23:59:00+08:00");
    const afterMidnight = Date.parse("2026-10-24T00:01:00+08:00");
    const crossed = pendingStartEstimate({ reason: "Resources", startAt }, beforeMidnight, afterMidnight);
    assert.match(crossed.text, /预计 00:05/, zone);
    assert.doesNotMatch(crossed.text, /明天/, zone);
    const jobs = Array.from({ length: 3 }, (_, i) => ({ id: String(10 + i), name: "train", user: "me", state: "PENDING", reason: i ? "Resources" : '<img src=x onerror="bad">', startAt }));
    jobs.push({ id: "99", user: "other", state: "PENDING", reason: "Priority", startAt });
    const layer = { level: "ok", checkedAt: now, slurm: { state: "ok", checkedAt: now, user: "me", nodes: [], jobs } };
    const model = buildClusterPanelModel({ layer, now });
    const group = model.jobRows.find((r) => r.kind === "group");
    const expanded = buildClusterPanelModel({ layer, now, view: { expanded: new Set([group.key]) } });
    const html = buildGroupedJobRowsHtml(expanded.jobRows);
    assert.equal((html.match(/原因与建议/g) || []).length, 3);
    assert.match(html, /data-confidence="medium"/);
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /<img/);
    assert.equal(model.jobs.find((j) => j.id === "99").startEstimate, null);
  });
});
