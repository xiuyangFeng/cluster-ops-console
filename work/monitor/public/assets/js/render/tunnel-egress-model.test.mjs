// 「经隧道出网的程序」模型与 HTML 片段的纯函数测试（无 DOM）。
import assert from "node:assert/strict";
import test from "node:test";

import { buildTunnelEgressModel, egressBytesText, TUNNEL_EGRESS_EMPTY_TEXT } from "./tunnel-egress-model.js";
import { buildTunnelEgressHtml } from "./tunnel-egress-view.js";

const MiB = 1024 * 1024;
const egress = (over = {}) => ({
  state: "ok",
  port: 7891,
  detail: "full",
  total: { conns: 5, sentBytes: 1.2 * MiB + 30, recvBytes: 18 * MiB + 40 },
  others: { conns: 1, sentBytes: 30, recvBytes: 40 },
  programCount: 2,
  programs: [
    { name: "codex", conns: 3, sentBytes: 1.2 * MiB, recvBytes: 18 * MiB },
    { name: "claude", conns: 1, sentBytes: null, recvBytes: null },
  ],
  ...over,
});

test("egressBytesText：两边都有 / 只有一边 / 都没有", () => {
  assert.equal(egressBytesText(1.2 * MiB, 18 * MiB), "↑1.2 MiB ↓18 MiB");
  assert.equal(egressBytesText(null, 512), "↓512 B");
  assert.equal(egressBytesText(null, null), "");
  assert.equal(egressBytesText(-1, Number.NaN), "");
});

test("buildTunnelEgressModel：逐程序一行「名字 · N 条连接 · ↑… ↓…」，看不到进程的排最后，另有合计", () => {
  const model = buildTunnelEgressModel(egress(), { id: "server-01", remotePort: 7891 });
  assert.equal(model.visible, true);
  assert.equal(model.state, "ok");
  assert.equal(model.portText, "连着 127.0.0.1:7891 的连接");
  assert.deepEqual(model.rows.map((r) => r.text), [
    "codex · 3 条连接 · ↑1.2 MiB ↓18 MiB",
    "claude · 1 条连接",
    "看不到进程 · 1 条连接 · ↑30 B ↓40 B",
  ]);
  assert.deepEqual(model.rows.map((r) => r.other), [false, false, true]);
  assert.match(model.rows[2].title, /别的账号/);
  assert.match(model.rows[1].title, /没给出连接上的字节数/);
  assert.equal(model.total.text, "合计 · 5 条连接 · ↑1.2 MiB ↓18 MiB");
  assert.equal(model.more, "");
  assert.equal(model.notice, "");
});

test("buildTunnelEgressModel：程序多于列出的 → 另有 N 个未列出；没有看不到进程的连接就不出那一行", () => {
  const model = buildTunnelEgressModel(egress({ programCount: 25, others: { conns: 0, sentBytes: null, recvBytes: null } }));
  assert.equal(model.rows.length, 2);
  assert.equal(model.more, "另有 23 个程序未列出（只列连接最多的 2 个）");
});

test("buildTunnelEgressModel：没有连接 → 空状态文案；只有连接数（basic）；没有 ss → 不支持；查询失败", () => {
  const empty = buildTunnelEgressModel(egress({ total: { conns: 0, sentBytes: null, recvBytes: null }, programs: [], others: null }));
  assert.equal(empty.state, "empty");
  assert.equal(empty.notice, TUNNEL_EGRESS_EMPTY_TEXT);
  assert.equal(empty.notice, "此刻没有程序经隧道出网");
  assert.deepEqual(empty.rows, []);

  const basic = buildTunnelEgressModel(egress({ detail: "basic", total: { conns: 4, sentBytes: null, recvBytes: null }, programs: [], others: null }));
  assert.equal(basic.state, "basic");
  assert.match(basic.notice, /不支持列出进程/);
  assert.equal(basic.total.text, "合计 · 4 条连接");

  const absent = buildTunnelEgressModel({ state: "absent", port: 7891, programs: [] });
  assert.equal(absent.state, "unsupported");
  assert.match(absent.notice, /^不支持/);

  const failed = buildTunnelEgressModel({ state: "error", port: 7891, programs: [] });
  assert.equal(failed.state, "error");
  assert.match(failed.notice, /每分钟会自动重试/);
});

test("buildTunnelEgressModel：还没采到 / 旧采集脚本 / 没有端口 / 不建隧道的服务器 → 整块隐藏", () => {
  for (const value of [undefined, null, "x", {}, { state: "skip" }, { state: "weird" }]) {
    assert.equal(buildTunnelEgressModel(value).visible, false, JSON.stringify(value));
  }
  assert.equal(buildTunnelEgressModel(egress(), { id: "s", tunnel: false }).visible, false);
  assert.equal(buildTunnelEgressModel(egress(), { id: "s", tunnel: true }).visible, true);
});

test("buildTunnelEgressHtml：程序名转义；隐藏时空串；各状态都有标题", () => {
  assert.equal(buildTunnelEgressHtml({ visible: false }), "");
  const html = buildTunnelEgressHtml(buildTunnelEgressModel(egress({ programs: [{ name: "<b>x</b>", conns: 1, sentBytes: 1, recvBytes: 2 }], programCount: 1 })));
  assert.match(html, /<h3>经隧道出网的程序<\/h3>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /data-other="true"/);
  assert.match(html, /class="res-egress-total"[^>]*>合计 · 5 条连接/);

  const empty = buildTunnelEgressHtml(buildTunnelEgressModel(egress({ total: { conns: 0, sentBytes: null, recvBytes: null } })));
  assert.match(empty, /data-state="empty">此刻没有程序经隧道出网</);
  assert.doesNotMatch(empty, /res-egress-list/);
  assert.match(buildTunnelEgressHtml(buildTunnelEgressModel({ state: "error", port: 7891 })), /data-state="error"/);
});
