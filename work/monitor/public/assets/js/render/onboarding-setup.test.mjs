import assert from "node:assert/strict";
import test from "node:test";
import { buildSetupRouteHtml, buildSetupLoginHtml, buildSetupCheckHtml, toolStartCommand } from "./onboarding-setup.js";

const guide = { server: { id: "team-1" }, result: { remotePort: 8123 } };
test("代理地址用本人端口；API 地址独立，未分配时不臆造 7891", () => {
  assert.match(buildSetupRouteHtml(guide), /http:\/\/127\.0\.0\.1:8123/);
  assert.match(buildSetupRouteHtml(guide), /这里不能填上面的代理端口/);
  assert.doesNotMatch(buildSetupRouteHtml({}), /127\.0\.0\.1:7891/);
});
test("安装后才允许登录，并锁定目标服务器、显式选择官方或中转", () => {
  const html = buildSetupLoginHtml(guide, { serverId: "team-1", clis: { codex: { installed: true }, claude: { installed: false } } });
  assert.match(html, /data-cli-server-id="team-1" data-cli-method="relay">/);
  assert.match(html, /data-cli-login="claude"[^>]+disabled/);
  assert.doesNotMatch(buildSetupLoginHtml(guide, { serverId: "another" }), /data-cli-login/);
  assert.match(buildSetupLoginHtml(guide, { serverId: "team-1", clis: {} }, { codex: { method: "relay", state: "succeeded" } }), /配置已保存/);
});
test("网络结果不冒充 API 认证；远端文本转义，启动命令不含凭证", () => {
  const html = buildSetupCheckHtml({ report: { full: { ok: true, message: "<done>" }, results: [{ target: "<host>", ok: false, message: "<error>" }] } });
  assert.match(html, /&lt;done&gt;/); assert.doesNotMatch(html, /<host>|<error>/);
  assert.match(html, /网络可达不等于 Key、额度或模型权限有效/);
  assert.equal(toolStartCommand("codex"), ". ~/.config/cluster-workbench/env.sh\ncodex");
  assert.equal(toolStartCommand("claude"), ". ~/.config/cluster-workbench/env.sh\nclaude");
});

test("下一步高亮：连接 → 安装 → 填 Key → 测试对话 → 完成，按现状推进", async () => {
  const { setupFocus, focusSelector } = await import("./onboarding-setup.js");
  const g = { phase: "done", server: { id: "team-1" } };
  assert.equal(setupFocus({ guide: { phase: "idle" } }).focus, "start");
  assert.equal(setupFocus({ guide: { phase: "waiting" } }).focus, "prompt");
  assert.equal(setupFocus({ guide: { phase: "failed" } }).focus, "retry");
  assert.equal(setupFocus({ guide: { phase: "running" } }).focus, "");
  assert.equal(setupFocus({ guide: g }).stage, 2, "概览还没回来");
  assert.equal(setupFocus({ guide: g, overview: { serverId: "other", clis: {} } }).focus, "", "别的服务器的概览不算");
  const none = { serverId: "team-1", clis: { codex: { installed: false }, claude: { installed: false } } };
  assert.equal(setupFocus({ guide: g, overview: none }).focus, "install");
  assert.equal(setupFocus({ guide: g, overview: { ...none, job: { status: "running", action: "install", label: "Codex" } } }).focus, "installing");
  assert.equal(setupFocus({ guide: g, overview: { ...none, job: { status: "running", action: "publish" } } }).focus, "install", "管理员的发布任务不算安装");
  const one = { serverId: "team-1", clis: { codex: { installed: false }, claude: { installed: true, login: "none" } } };
  const login = setupFocus({ guide: g, overview: one });
  assert.equal(login.focus, "login login-claude");
  assert.match(login.hint, /Claude Code 填 API 地址和 Key/);
  assert.equal(setupFocus({ guide: g, overview: one, completed: { claude: { state: "succeeded" } } }).focus, "smoke smoke-claude");
  const loggedIn = { serverId: "team-1", clis: { codex: { installed: true, login: "apikey" }, claude: { installed: true, login: "api" } } };
  assert.equal(setupFocus({ guide: g, overview: loggedIn, smoke: { codex: { result: { ok: false } } } }).focus, "smoke smoke-claude", "测过失败的先跳到没测的");
  assert.equal(setupFocus({ guide: g, overview: loggedIn, smoke: { claude: { result: { ok: true } } } }).focus, "finish");
  assert.equal(setupFocus({ guide: g, overview: loggedIn, smoke: { skipped: true } }).focus, "finish");
  assert.equal(focusSelector("login login-claude"), '[data-cli-login="claude"]');
  assert.equal(focusSelector("smoke smoke-codex"), '[data-ob-smoke="codex"]');
  assert.equal(focusSelector(""), null);
});

test("测试对话块：只给已装的工具；进行中禁用全部按钮；失败显示原因 / 建议 / 转义后的输出尾巴；通过后不再给「跳过」", async () => {
  const { buildSmokeHtml } = await import("./onboarding-setup.js");
  const overview = { clis: { codex: { installed: true }, claude: { installed: false } } };
  assert.match(buildSmokeHtml({ clis: {} }), /装好工具并填好 Key 之后/);
  const idle = buildSmokeHtml(overview, {});
  assert.match(idle, /data-ob-smoke="codex">给 Codex 发一条测试对话/);
  assert.doesNotMatch(idle, /data-ob-smoke="claude"/);
  assert.match(idle, /data-ob-smoke-skip/);
  assert.match(buildSmokeHtml(overview, { codex: { busy: true } }), /data-ob-smoke="codex" disabled>正在测试…/);
  const failed = buildSmokeHtml(overview, { codex: { result: { ok: false, message: "API Key 无效或已过期", hint: "核对 Key", tail: ["<401>"] } } });
  assert.match(failed, /API Key 无效或已过期/);
  assert.match(failed, /&lt;401&gt;/);
  const ok = buildSmokeHtml(overview, { codex: { result: { ok: true, message: "收到回复", seconds: 7 } } });
  assert.match(ok, /✓ 收到回复（用时 7 秒）/);
  assert.doesNotMatch(ok, /data-ob-smoke-skip/);
  assert.match(buildSetupCheckHtml({}, { overview, smoke: {} }), /data-ob-smoke="codex"/);
});
