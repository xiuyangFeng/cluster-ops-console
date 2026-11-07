import assert from "node:assert/strict";
import test from "node:test";

import { CLAUDE_CODE_PROBE_ID } from "../agents/claude-code.mjs";
import { AGENT_PROBES_AFTER_CLI_CHANGE, createCliChangeRefresher } from "./refresh.mjs";

function harness({ registered = ["doctor", CLAUDE_CODE_PROBE_ID], failRefresh = false } = {}) {
  const calls = [];
  const logs = [];
  const refresh = createCliChangeRefresher({
    cliProbe: {
      refresh: async (serverId) => {
        calls.push(["cli.refresh", serverId]);
        if (failRefresh) throw new Error("ssh down");
      },
    },
    scheduler: {
      isRegistered: (id) => registered.includes(id),
      forceRun: async (id) => calls.push(["forceRun", id]),
    },
    log: (text) => logs.push(text),
  });
  return { refresh, calls, logs };
}

test("成功：重测 cli:<serverId> 并补跑对应 Agent 探针（codex → doctor，claude → claude-code）", async () => {
  assert.deepEqual(AGENT_PROBES_AFTER_CLI_CHANGE.codex, ["doctor"]);
  let h = harness();
  await h.refresh("server-01", { cli: "codex", ok: true });
  assert.deepEqual(h.calls, [["cli.refresh", "server-01"], ["forceRun", "doctor"]]);
  h = harness();
  await h.refresh("server-01", { cli: "claude", ok: true });
  assert.deepEqual(h.calls, [["cli.refresh", "server-01"], ["forceRun", CLAUDE_CODE_PROBE_ID]]);
});

test("失败 / 取消：只重测 CLI，不打扰 Agent 探针；没注册的 Agent 探针（被关掉）跳过", async () => {
  let h = harness();
  await h.refresh("server-01", { cli: "codex", ok: false });
  assert.deepEqual(h.calls, [["cli.refresh", "server-01"]]);
  h = harness({ registered: [] });
  await h.refresh("server-01", { cli: "claude", ok: true });
  assert.deepEqual(h.calls, [["cli.refresh", "server-01"]]);
});

test("刷新出错被吞掉（只记一行 warn），不向调用方抛", async () => {
  const h = harness({ failRefresh: true });
  await h.refresh("server-01", { cli: "codex" });
  assert.deepEqual(h.calls.map((c) => c[0]), ["cli.refresh", "forceRun"]);
  assert.equal(h.logs.length, 1);
});
