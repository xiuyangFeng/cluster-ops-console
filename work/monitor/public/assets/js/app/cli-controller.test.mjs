import assert from "node:assert/strict";
import test from "node:test";

import { CLI_POLL_MS, createCliController } from "./cli-controller.js";

function harness({ responses, hidden = false } = {}) {
  const queue = [...responses];
  const requests = [];
  const delivered = [];
  const timers = [];
  let visibilityHandler = null;
  const state = { hidden };
  const controller = createCliController({
    getJson: async (url) => {
      requests.push(url);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    isHidden: () => state.hidden,
    onVisibilityChange: (fn) => { visibilityHandler = fn; },
    onCli: (payload) => delivered.push(payload),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  return { controller, requests, delivered, timers, state, fireVisibility: () => visibilityHandler?.() };
}

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const PAYLOAD = { serverId: "server-01", clis: { codex: { installed: true, version: "0.159.2" } } };

test("start：立即拉一次并交给 onCli，5 分钟一轮", async () => {
  const h = harness({ responses: [PAYLOAD] });
  h.controller.start();
  await h.controller.refresh();
  assert.deepEqual(h.requests, ["/api/cli"]);
  assert.deepEqual(h.delivered, [PAYLOAD]);
  assert.equal(h.timers.at(-1).ms, CLI_POLL_MS);
  assert.equal(CLI_POLL_MS, 300000);
});

test("接口不存在（404）：安静降级，交出 null，之后不再请求也不再排定时器", async () => {
  const h = harness({ responses: [httpError(404)] });
  h.controller.start();
  await h.controller.refresh();
  assert.equal(h.controller.isUnsupported(), true);
  assert.deepEqual(h.delivered, [null]);
  const timersBefore = h.timers.length;
  await h.controller.refresh();
  h.fireVisibility();
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.length, timersBefore);
});

test("其它失败保留上一份；切换查看的服务器立即补拉", async () => {
  const h = harness({ responses: [PAYLOAD, httpError(500), { ...PAYLOAD, serverId: "server-02" }] });
  await h.controller.refresh();
  await h.controller.refresh();
  assert.deepEqual(h.controller.getPayload(), PAYLOAD, "500 不清空");
  assert.equal(h.delivered.length, 1);
  h.controller.onStatus({ activeServerId: "server-01" });
  assert.equal(h.requests.length, 2, "首帧只记录");
  h.controller.onStatus({ activeServerId: "server-02" });
  await h.controller.refresh();
  assert.equal(h.controller.getPayload().serverId, "server-02");
});

test("页面隐藏时不排定时器；恢复可见补拉一次", async () => {
  const h = harness({ responses: [PAYLOAD, PAYLOAD], hidden: true });
  h.controller.start();
  await h.controller.refresh();
  assert.equal(h.timers.length, 0);
  h.state.hidden = false;
  h.fireVisibility();
  await h.controller.refresh();
  assert.equal(h.requests.length, 2);
  assert.equal(h.timers.length, 1);
});
