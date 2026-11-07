import assert from "node:assert/strict";
import test from "node:test";

import { agentOptionsSignature, createOverallWriter, resolveOverall, runPanelRenders, syncServerSelect } from "./render-pipeline.js";
import { fakeDocument, fakeElement } from "./test-support.mjs";

test("resolveOverall: summary v1 只描述数据通路，Agent 检查计数进悬停说明", () => {
  const status = {
    health: "degraded",
    summary: {
      schemaVersion: 1,
      transport: { state: "stopped", freshness: "fresh", reasonCode: "MANUAL_STOP", checkedAt: null },
      agentCounts: { attention: 2 },
    },
  };
  const overall = resolveOverall(status);
  assert.equal(overall.health, "stopped");
  assert.equal(overall.text, "已停止");
  assert.equal(overall.title, "transport stopped（fresh，MANUAL_STOP）· 检查于 — · 2 项 Agent 检查需处理");
  status.summary.transport.state = "bogus";
  assert.deepEqual([resolveOverall(status).health, resolveOverall(status).text], ["waiting", "未知"]);
});

test("agentOptionsSignature: 数量不变但换装/改名也要变", () => {
  const a = agentOptionsSignature([{ id: "codex", name: "Codex" }, { id: "claude" }]);
  assert.equal(a, "codex:Codex|claude:");
  assert.notEqual(agentOptionsSignature([{ id: "codex", name: "Codex" }, { id: "gemini" }]), a);
  assert.notEqual(agentOptionsSignature([{ id: "codex", name: "Codex 2" }, { id: "claude" }]), a);
  assert.equal(agentOptionsSignature(undefined), "");
});

test("createOverallWriter: 文案/健康态未变时不写（#overall 是 aria-live，重写会被反复播报）", () => {
  let writes = 0;
  const overall = fakeElement();
  let text = "";
  Object.defineProperty(overall, "textContent", { get: () => text, set: (v) => { writes += 1; text = v; } });
  const doc = fakeDocument({ overall });
  const setOverall = createOverallWriter(doc);
  setOverall("ready", "已连接");
  setOverall("ready", "已连接");
  assert.equal(writes, 1);
  assert.equal(doc.body.dataset.health, "ready");
  setOverall("down", "通信阻断");
  assert.equal(writes, 2);
  assert.equal(doc.body.dataset.health, "down");
});

test("runPanelRenders：按面板注册表顺序渲染，隐藏的面板整段跳过（不只是 CSS 藏起来）", () => {
  const calls = [];
  const renderers = {
    "servers.cluster": (s) => calls.push(["cluster", s.n]),
    "overview.serverBriefs": (s) => calls.push(["briefs", s.n]),
    "servers.resources": (s) => calls.push(["resources", s.n]),
  };
  assert.deepEqual(runPanelRenders(renderers, { n: 1 }), ["overview.serverBriefs", "servers.resources", "servers.cluster"]);
  assert.deepEqual(calls.map((c) => c[0]), ["briefs", "resources", "cluster"], "注册表顺序，与 renderers 的键序无关");
  calls.length = 0;
  const hidden = new Set(["servers.resources", "servers.cluster"]);
  assert.deepEqual(runPanelRenders(renderers, { n: 2 }, (id) => hidden.has(id)), ["overview.serverBriefs"]);
  assert.deepEqual(calls, [["briefs", 2]]);
});

test("syncServerSelect：从概览卡等入口切到 B 后，统一渲染把下拉框同步到最新 activeServerId", () => {
  const options = [{ value: "a" }, { value: "b" }];
  const select = fakeElement({ tag: "select", options, value: "a" });
  assert.equal(syncServerSelect(select, "b"), true);
  assert.equal(select.value, "b", "状态已是 B，下拉框不能停在 A");
  assert.equal(syncServerSelect(select, "b"), false, "已一致时不写");
  // 目标不在选项里（列表尚未加载 / 该服务器已停用）：不写，免得 select 变成空白选择
  assert.equal(syncServerSelect(select, "gone"), false);
  assert.equal(select.value, "b");
  assert.equal(syncServerSelect(select, ""), false);
  assert.equal(syncServerSelect(null, "a"), false);
});
