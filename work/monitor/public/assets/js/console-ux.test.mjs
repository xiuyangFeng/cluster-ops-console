// W5 控制台易用性：前端纯函数测试（按钮文案常量、快捷键展示、命令面板别名搜索、服务器表单策略）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BUTTON_LABELS, isApplePlatform, modKeyLabel, shortcutList, QUIT_CONFIRM_TEXT } from "./ui-labels.js";
import { createCommandPalette, filterCommands, renderNoMatchHtml, renderShortcutHelpHtml } from "./command-palette.js";
import { describePortReassign, describePortReassignBlocked, passwordFieldPolicy, remotePortReferenceHint, suggestedRemotePort } from "./server-cards.js";
import { buildRuntimeSnapshot, buildThreeServerConfig } from "../../../lib/m1-fixtures.mjs";
import { buildConnectionTargetsProjection } from "../../../lib/runtime-snapshot.mjs";
import { fakeDialog, fakeElement, flush } from "./app/test-support.mjs";

const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("按钮文案常量与 index.html 实际按钮一致（横幅/提示引用的按钮必须真实存在）", () => {
  for (const key of ["start", "restart", "stop", "repair", "quit", "offlineInstall"]) {
    assert.ok(indexHtml.includes(BUTTON_LABELS[key]), `index.html 缺少按钮文案：${BUTTON_LABELS[key]}`);
  }
  assert.ok(indexHtml.includes(BUTTON_LABELS.control));
  assert.match(QUIT_CONFIRM_TEXT, /停止/);
});

test("快捷键：Apple 平台显示 ⌘，其余显示 Ctrl+", () => {
  assert.equal(isApplePlatform({ platform: "MacIntel" }), true);
  assert.equal(isApplePlatform({ userAgentData: { platform: "Windows" }, platform: "Win32" }), false);
  assert.equal(isApplePlatform(null), false);
  assert.equal(modKeyLabel(true), "⌘");
  assert.equal(modKeyLabel(false), "Ctrl+");
  assert.equal(shortcutList(false)[0].keys, "Ctrl+K");
  assert.ok(shortcutList(true).some((s) => s.keys === "?"));
});

test("命令面板：标题只显示中文，英文别名仍可搜索", () => {
  const cmds = [
    { title: "停止所有连接", aliases: "stop all connections danger", category: "通道控制" },
    { title: "查看状态变更时间线", aliases: "timeline dialog", category: "诊断浮层" },
    { title: "切换外观: 白色", category: "外观", aliases: "theme" },
  ];
  assert.deepEqual(filterCommands(cmds, "stop").map((c) => c.title), ["停止所有连接"]);
  assert.deepEqual(filterCommands(cmds, "时间线").map((c) => c.title), ["查看状态变更时间线"]);
  assert.equal(filterCommands(cmds, "").length, 3);
  assert.equal(filterCommands(cmds, "THEME").length, 1);
  for (const c of cmds) assert.doesNotMatch(c.title, /\([A-Za-z ]+\)/);
});

test("命令面板：快捷键帮助 HTML 转义且只读", () => {
  const html = renderShortcutHelpHtml([{ keys: "<K>", desc: "a&b" }]);
  assert.match(html, /&lt;K&gt;/);
  assert.match(html, /a&amp;b/);
  assert.doesNotMatch(html, /role="option"/);
});

test("服务器表单：win32 隐藏密码框并给出改用密钥提示", () => {
  assert.equal(passwordFieldPolicy("win32").enabled, false);
  assert.match(passwordFieldPolicy("win32").hint, /密钥/);
  assert.equal(passwordFieldPolicy("darwin").enabled, true);
  assert.equal(passwordFieldPolicy(null).enabled, true, "平台未知时不隐藏（旧后端兼容）");
});

test("服务器表单：只在新增+建隧道+未填写时预填建议端口", () => {
  const payload = { suggestedPorts: { remotePort: 7893, localPort: 8893 } };
  assert.equal(suggestedRemotePort(payload, { tunnel: true }), 7893);
  assert.equal(suggestedRemotePort(payload, { tunnel: false }), null);
  assert.equal(suggestedRemotePort(payload, { tunnel: true, currentValue: "7900" }), null);
  assert.equal(suggestedRemotePort(payload, { tunnel: true, editing: true }), null);
  assert.equal(suggestedRemotePort({}, { tunnel: true }), null);
});

test("服务器表单：后端标 checked=false 时不预填，只给参考占位与警告", () => {
  const payload = { suggestedPorts: { remotePort: 7893, localPort: 8893, checked: false, warning: "未核对服务器上的端口占用，请手动填写反向端口" } };
  assert.equal(suggestedRemotePort(payload, { tunnel: true }), null);
  const hint = remotePortReferenceHint(payload);
  assert.match(hint.placeholder, /参考 7893/);
  assert.match(hint.title, /未核对服务器上的端口占用/);
  assert.equal(remotePortReferenceHint({ suggestedPorts: { remotePort: 7893 } }), null, "旧后端（无 checked）保持原预填行为");
});

test("重新分配端口：无自动建议时说明原因与出路", () => {
  const text = describePortReassignBlocked({ serverId: "box", suggested: null, probeError: "password-auth", warning: "未核对服务器上的端口占用，请手动填写反向端口" }, "腾讯云");
  assert.match(text, /腾讯云/);
  assert.match(text, /密码认证/);
  assert.match(text, /未核对服务器上的端口占用/);
  assert.match(describePortReassignBlocked({ probeError: "timeout" }), /探测失败（timeout）/);
});

test("重新分配端口确认文案：说明新旧端口、依据与影响范围", () => {
  const text = describePortReassign({ serverId: "box", current: { remotePort: 7892 }, suggested: { remotePort: 7895 }, probed: true, listening: [7893, 7894] }, "腾讯云");
  assert.match(text, /腾讯云/);
  assert.match(text, /7892 → 7895/);
  assert.match(text, /2 个占用已避开/);
  assert.match(text, /只重启这一条隧道/);
  assert.match(describePortReassign({ current: {}, suggested: { remotePort: 7893 }, probed: false, probeError: "timeout" }), /timeout/);
  // 个人服务器没有受管 env.sh：提醒手改；团队服务器会自动同步，并说明已在运行的进程不受益
  assert.match(text, /服务器上已按旧端口 7892 配置的代理变量需要改成 7895/);
  const team = describePortReassign({ serverId: "server-01", source: "team", current: { remotePort: 7891 }, suggested: { remotePort: 7893 }, probed: true, listening: [] });
  assert.match(team, /env\.sh）会自动改到 7893/);
  assert.match(team, /已经在运行的 codex \/ claude 和作业里还是旧端口 7891/);
});

test("命令面板：复制命令执行时按此刻的查看选择复核（切换服务器后拒绝旧目标）；单隧道重启按运行快照能力显示", async () => {
  const saved = { navigator: globalThis.navigator, window: globalThis.window };
  const writes = [];
  try {
    Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (text) => { writes.push(text); } } }, configurable: true });
    globalThis.window = { addEventListener() {}, prompt() {} };
    const config = buildThreeServerConfig();
    const withSnapshot = (activeServerId, snapshot = buildRuntimeSnapshot()) => ({
      activeServerId,
      connectionTargets: buildConnectionTargetsProjection({ snapshot, snapshotState: snapshot ? "ok" : "missing", config }),
    });
    let status = withSnapshot("fixture-a");
    const dialogEl = fakeDialog({ querySelector: () => null });
    const inputEl = fakeElement({ tag: "input" });
    const listEl = fakeElement({ querySelector: () => null });
    const palette = createCommandPalette({ dialogEl, inputEl, listEl, onScopedRestart() {}, getStatus: () => status, getConfig: () => config });
    const search = (query) => {
      inputEl.value = query;
      return inputEl.dispatch("input");
    };
    const enter = async () => {
      await inputEl.dispatch("keydown", { key: "Enter" });
      await flush();
    };

    palette.open();
    assert.match(listEl.innerHTML, /重启此服务器的隧道/);
    await search("复制集群远端代理");
    await enter();
    assert.equal(writes.length, 1);
    assert.match(writes[0], /127\.0\.0\.1:17891;/);

    // 列表按 fixture-a 生成后，查看的服务器被切到 fixture-b，再执行同一条目 → 不复制旧目标。
    palette.open();
    await search("复制集群远端代理");
    status = withSnapshot("fixture-b");
    await enter();
    assert.equal(writes.length, 1);

    // 旧 supervisor（无运行快照 → 无能力声明）不出单隧道重启条目。
    status = withSnapshot("fixture-a", null);
    palette.open();
    assert.doesNotMatch(listEl.innerHTML, /重启此服务器的隧道/);
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: saved.navigator, configurable: true });
    globalThis.window = saved.window;
  }
});

test("命令面板：没有匹配时给紧凑型空状态（写出查询、举的英文别名真实可用）", async () => {
  const saved = { window: globalThis.window };
  try {
    globalThis.window = { addEventListener() {} };
    const dialogEl = fakeDialog({ querySelector: () => null });
    const inputEl = fakeElement({ tag: "input" });
    const listEl = fakeElement({ querySelector: () => null });
    createCommandPalette({ dialogEl, inputEl, listEl, getStatus: () => null, getConfig: () => null });
    const search = (query) => {
      inputEl.value = query;
      return inputEl.dispatch("input");
    };
    await search("zz<b>q");
    assert.match(listEl.innerHTML, /^<div class="cmd-empty"><div class="empty-state is-compact" data-tone="neutral">/);
    assert.match(listEl.innerHTML, /<p class="empty-state-title">没有匹配「zz&lt;b&gt;q」的命令<\/p>/);
    assert.match(listEl.innerHTML, /试试更短的关键词，或用英文别名（restart、logs）。/);
    assert.equal(inputEl.getAttribute("aria-expanded"), "false");
    // 文案里举的别名必须真的能搜到命令。
    for (const alias of ["restart", "logs"]) {
      await search(alias);
      assert.match(listEl.innerHTML, /class="cmd-item/, `别名 ${alias} 应能命中命令`);
    }
  } finally {
    globalThis.window = saved.window;
  }
  assert.match(renderNoMatchHtml("   "), /没有匹配的命令/);
  assert.match(renderNoMatchHtml("x".repeat(40)), new RegExp(`没有匹配「${"x".repeat(24)}…」的命令`), "超长查询截断");
});

test("「同步到集群」结果文案：成功 / 无需改 / 没有受管配置 / 失败", async () => {
  const { describeClusterEnvSync } = await import("./app/actions.js");
  const synced = describeClusterEnvSync({ status: "synced", state: { expectedPort: 7893, lastSync: { changed: ["~/.config/cluster-workbench/env.sh"], error: null } } });
  assert.equal(synced.type, "success");
  assert.match(synced.message, /改到端口 7893（~\/\.config\/cluster-workbench\/env\.sh）/);
  assert.match(synced.message, /只对新开的终端生效/);
  assert.equal(describeClusterEnvSync({ status: "synced", state: { expectedPort: 7893, lastSync: { changed: ["a"], error: "settings.json 没改成" } } }).type, "warn");
  assert.equal(describeClusterEnvSync({ status: "in-sync", state: { expectedPort: 7893 } }).type, "info");
  assert.match(describeClusterEnvSync({ status: "absent" }).message, /接入引导/);
  const failed = describeClusterEnvSync({ status: "failed", state: { lastSync: { error: "改写失败" } } });
  assert.equal(failed.type, "error");
  assert.match(failed.message, /改写失败/);
});
