// 代理 ↔ supervisor 进程间约定：身份头往返、与 supervisor 现有副本逐项一致（切换前的交叉校验）。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  buildProxyHealthHeaders,
  DRAINING_PROXY_RECORD_NAME,
  HANDOFF_WAITING_MARKER,
  parseProxyHealthHeaders,
  PROXY_HANDOFF_ENV,
  proxyReleaseRequestPath,
} from "./protocol.mjs";

test("身份头往返：build 出的头经 parse 还原 pid / 指纹 / 交接能力", () => {
  assert.deepEqual(parseProxyHealthHeaders(buildProxyHealthHeaders({ pid: 4242, component: "0123456789ab", handoff: true })), {
    pid: 4242,
    component: "0123456789ab",
    handoff: true,
  });
  assert.deepEqual(parseProxyHealthHeaders(buildProxyHealthHeaders({ pid: 7, component: "", handoff: false })), {
    pid: 7,
    component: "",
    handoff: false,
  });
  // 旧代理没有身份头：一律按未知处理。
  assert.deepEqual(parseProxyHealthHeaders({}), { pid: null, component: "", handoff: false });
  assert.deepEqual(parseProxyHealthHeaders(), { pid: null, component: "", handoff: false });
});

test("约定常量与释放请求路径", () => {
  assert.equal(PROXY_HANDOFF_ENV, "CODEX_PROXY_HANDOFF");
  assert.equal(HANDOFF_WAITING_MARKER, "[handoff] waiting for port");
  assert.equal(DRAINING_PROXY_RECORD_NAME, "local-proxy-draining");
  assert.equal(proxyReleaseRequestPath("/rt", "123"), path.join("/rt", "proxy-control", "release-123"));
});

test("非法身份头按保守处理（旧代理 / 伪造值都不给交接能力）", () => {
  assert.deepEqual(parseProxyHealthHeaders({ "x-codex-proxy-pid": "12.5", "x-codex-proxy-component": "ABC", "x-codex-proxy-handoff": "true" }), { pid: null, component: "", handoff: false });
});
