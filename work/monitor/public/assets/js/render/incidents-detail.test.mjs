// 「磁盘超阈值」事件卡片上的一句详情（v2.62 磁盘增长归因；文字由后端随 /api/incidents 给出）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeElement } from "../app/test-support.mjs";
import { buildIncidentListModel, buildIncidentRenderSignature, renderIncidentList } from "./incidents.js";

const NOW = Date.UTC(2026, 9, 12, 6, 0);
const TEXT = "近 24 小时你的作业目录增长约 1.1 TiB（占整盘同期增长的 57%），其中 cfd_auto_ad_repro_20261009 +1.1 TiB；按这个速度约 4 天写满。";
const disk = (over = {}) => ({
  incidentId: "inc-disk", serverId: "server-01", component: "filesystem", reasonCode: "DISK_THRESHOLD", severity: "warn", lifecycle: "open",
  firstSeenAt: NOW - 30 * 3600_000, lastSeenAt: NOW - 60_000, occurrences: 1800, attention: {},
  evidenceRefs: [{ kind: "disk-usage", usedPct: 91, at: NOW - 60_000 }], detail: { text: TEXT }, ...over,
});
const tunnel = { incidentId: "inc-tunnel", serverId: "server-01", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error", lifecycle: "open", firstSeenAt: NOW - 600_000, lastSeenAt: NOW - 60_000, occurrences: 2, attention: {}, detail: { text: "不该出现" } };
const payload = (incidents) => ({ state: "open", total: incidents.length, incidents });

function withDocument(container, fn) {
  const previous = globalThis.document;
  globalThis.document = { getElementById: (id) => (id === "incidentList" ? container : null) };
  try {
    return fn();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

test("模型：只有未解决的磁盘事件带详情；别的事件、已恢复的、畸形的都当没有", () => {
  const items = buildIncidentListModel(payload([disk(), tunnel, disk({ incidentId: "old", lifecycle: "resolved", resolvedAt: NOW }), disk({ incidentId: "bad", detail: { text: 42 } }), disk({ incidentId: "none", detail: undefined })]), { nowMs: NOW }).items;
  assert.deepEqual(items.map((item) => [item.incidentId, item.detailText]), [["inc-tunnel", ""], ["inc-disk", TEXT], ["old", ""], ["bad", ""], ["none", ""]], "未解决按需要处理 → 严重度 → 最近排");
  assert.equal(buildIncidentListModel(payload([disk({ detail: { text: `  ${"长".repeat(900)}  ` } })]), { nowMs: NOW }).items[0].detailText.length, 400, "过长的截断");
});

test("渲染签名：详情文字变了才重画", () => {
  const base = buildIncidentRenderSignature(payload([disk()]), { nowMs: NOW });
  assert.equal(buildIncidentRenderSignature(payload([disk()]), { nowMs: NOW + 1000 }), base);
  assert.notEqual(buildIncidentRenderSignature(payload([disk({ detail: { text: "按这个速度约 3 天写满。" } })]), { nowMs: NOW }), base);
  assert.notEqual(buildIncidentRenderSignature(payload([disk({ detail: undefined })]), { nowMs: NOW }), base);
  // 别的事件带了 detail 也不影响签名
  assert.equal(
    buildIncidentRenderSignature(payload([tunnel]), { nowMs: NOW }),
    buildIncidentRenderSignature(payload([{ ...tunnel, detail: { text: "换一句" } }]), { nowMs: NOW }),
  );
});

test("卡片：详情写在用量 / 持续时长下面、操作按钮上面，文字转义；没有详情时不多一行", () => {
  const container = fakeElement();
  withDocument(container, () => renderIncidentList(payload([disk({ detail: { text: `${TEXT}<b>x</b>` } }), tunnel]), { nowMs: NOW }));
  const html = container.innerHTML;
  assert.equal(html.match(/class="incident-detail"/g).length, 1, "只有磁盘事件多这一行");
  assert.match(html, /<span>当前 91%<\/span><span>已持续 1 天<\/span>[\s\S]*<\/div>\s*<p class="incident-detail">近 24 小时你的作业目录增长约 1\.1 TiB（占整盘同期增长的 57%），其中 cfd_auto_ad_repro_20261009 \+1\.1 TiB；按这个速度约 4 天写满。&lt;b&gt;x&lt;\/b&gt;<\/p>\s*<div class="incident-remedy" data-kind="advice">[\s\S]*?<\/div>\s*<div class="incident-actions">/, "详情之后是「下一步」，再是操作按钮");
  assert.ok(!html.includes("不该出现") && !html.includes("<b>x</b>"));

  const bare = fakeElement();
  withDocument(bare, () => renderIncidentList(payload([disk({ detail: undefined })]), { nowMs: NOW }));
  assert.ok(!bare.innerHTML.includes("incident-detail"));
  assert.match(bare.innerHTML, /<span>当前 91%<\/span>/);
});
