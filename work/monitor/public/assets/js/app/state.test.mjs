import assert from "node:assert/strict";
import test from "node:test";

import { createAppState } from "./state.js";

test("createAppState: activeServerId 以运行状态为准，状态未到回落配置，都没有给空串", () => {
  const state = createAppState();
  assert.equal(state.activeServerId(), "");
  state.setConfig({ activeServerId: "from-config", servers: [] });
  assert.equal(state.activeServerId(), "from-config");
  state.setStatus({ activeServerId: "from-status" });
  assert.equal(state.activeServerId(), "from-status");
  state.setStatus({});
  assert.equal(state.activeServerId(), "from-config");
});

test("createAppState: 读写 status/config；方法脱离对象传递仍可用", () => {
  const { getStatus, getConfig, setStatus, setConfig, activeServerId } = createAppState();
  assert.equal(getStatus(), null);
  assert.equal(getConfig(), null);
  const status = { version: "1.0.0", activeServerId: "s1" };
  const config = { servers: [] };
  setStatus(status);
  setConfig(config);
  assert.equal(getStatus(), status);
  assert.equal(getConfig(), config);
  assert.equal(activeServerId(), "s1");
});
