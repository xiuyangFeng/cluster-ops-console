import assert from "node:assert/strict";
import test from "node:test";
import { buildGuideProgressHtml, guideProgress } from "./onboarding-progress.js";

const state = (phase, status = "waiting", id = "authorize") => ({ available: true, phase,
  steps: [{ id: "hostkey", title: "确认指纹", status: "done" }, { id, title: "公钥授权", status }, { id: "identity", title: "保存配置", status: "pending" }] });

test("根据实际阶段说明正在做什么、为什么做和下一步，进度不把等待算作完成", () => {
  const waiting = guideProgress(state("waiting"));
  assert.equal(waiting.completed, 1);
  assert.equal(waiting.percent, 33);
  assert.match(waiting.next, /输入一次集群账号密码/);
  assert.match(waiting.why, /公钥.*集群账号/);
  assert.match(guideProgress(state("running", "running", "key")).next, /本机密钥/);
  assert.match(guideProgress(state("paused", "pending")).next, /中断的位置/);
  const failed = state("failed", "failed"); failed.steps[1].error = { hint: "清理家目录后重试" };
  assert.equal(guideProgress(failed).next, "清理家目录后重试");
});

test("新电脑说明网络与账号的边界；私钥留本机，过期接入记录不冒充已就绪", () => {
  const fresh = { ...state("idle"), localReadiness: { keyState: "create", configuredIdentityMissing: true } };
  const html = buildGuideProgressHtml(fresh);
  assert.match(html, /仍需要你自己的账号和密码/);
  assert.match(html, /无需拷贝旧电脑的私钥/);
  assert.match(html, /本机尚无专用密钥/);
  const migrated = guideProgress({ ...fresh, phase: "done" });
  assert.equal(migrated.percent, 0);
  assert.match(migrated.title, /缺少登录密钥/);
  const malicious = state("failed", "failed"); malicious.steps[1].error = { hint: "<img src=x>" };
  assert.doesNotMatch(buildGuideProgressHtml(malicious), /<img/);
  assert.match(buildGuideProgressHtml(malicious), /&lt;img/);
});
