import assert from "node:assert/strict";
import test from "node:test";
import { createJobNavigation } from "./job-navigation.js";

test("通知连续点击 B、A：等待在途切服，最终定位最新的 A 而不被 B 晚到覆盖", async () => {
  let active = "A";
  let resolveB;
  const changes = [], focused = [];
  const navigate = createJobNavigation({ state: { activeServerId: () => active },
    serverSwitch: { switchActiveServer: async (id) => { changes.push(id); if (id === "B") await new Promise((resolve) => { resolveB = resolve; }); active = id; } },
    panels: { isHidden: () => false }, viewTabs: { switchView: () => {} }, refresh: async () => {}, refreshWatches: async () => {},
    focusJob: (id) => focused.push([active, id]), openInbox: () => {}, toast: () => {},
  });
  const first = navigate("B", "1");
  await new Promise((resolve) => setImmediate(resolve));
  const second = navigate("A", "2");
  resolveB();
  await Promise.all([first, second]);
  assert.deepEqual(changes, ["B", "A"]);
  assert.deepEqual(focused, [["A", "2"]]);
});

test("隐藏作业面板时只打开收件箱，切服失败时不定位错误服务器", async () => {
  let inbox = 0, switches = 0, focuses = 0;
  let hidden = true;
  const navigate = createJobNavigation({ state: { activeServerId: () => "A" },
    serverSwitch: { switchActiveServer: async () => { switches++; } }, panels: { isHidden: () => hidden },
    viewTabs: { switchView: () => {} }, refresh: async () => {}, refreshWatches: async () => {}, focusJob: () => { focuses++; },
    openInbox: () => { inbox++; }, toast: () => {},
  });
  await navigate("B", "1");
  assert.deepEqual([inbox, switches, focuses], [1, 0, 0]);
  hidden = false;
  await navigate("B", "1");
  assert.deepEqual([switches, focuses], [1, 0]);
});

test("v2.62：失败提醒的定位目标原样交给 focusJob；不给目标时与原来一样", async () => {
  const focused = [];
  const navigate = createJobNavigation({ state: { activeServerId: () => "A" },
    serverSwitch: { switchActiveServer: async () => {} }, panels: { isHidden: () => false }, viewTabs: { switchView: () => {} },
    refresh: async () => {}, refreshWatches: async () => {}, focusJob: (...args) => focused.push(args), openInbox: () => {}, toast: () => {},
  });
  await navigate("A", "12", "history");
  await navigate("A", "7");
  assert.deepEqual(focused, [["12", "history"], ["7", null]]);
});
