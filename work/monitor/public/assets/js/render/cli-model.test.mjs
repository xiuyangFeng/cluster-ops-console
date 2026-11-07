import assert from "node:assert/strict";
import test from "node:test";

import { cliIdForAgent, cliLoginText, cliStateForAgent, cliUpdateChip, cliVersionText } from "./cli-model.js";
import { buildAgentCardModel, buildAgentDrawerActionsHtml, buildAgentHeadline } from "./overview.js";

// /api/cli 契约（计划「数据契约」）：CliState + latest / updateAvailable。数值取 2026-10-07 kai 的实况。
const PAYLOAD = {
  serverId: "server-01",
  clis: {
    codex: {
      installed: true, version: "0.159.2", kind: "standalone", path: "/x/codex",
      login: "apikey", loginDetail: "中转站 cpa · api.relay-demo.example:9443 · 密钥变量 CPA_API_KEY",
      latest: "0.160.1", updateAvailable: true,
    },
    claude: {
      installed: true, version: "2.1.292", kind: "native", path: "/x/2.1.292",
      login: "subscription", loginDetail: "Max 订阅 · 经 ReClaude 代理", managedBy: "reclaude",
      latest: "2.1.292", updateAvailable: false,
    },
  },
  job: null,
};

const codexAgent = { id: "codex", kind: "codex", name: "Codex", health: "ready" };
const claudeCodeAgent = { id: "claude-code", kind: "claude-code", name: "Claude Code", health: "ready" };
const reclaudeAgent = { id: "claude-codewing", kind: "reclaude", name: "Claude CodeWing", health: "ready" };

test("cliStateForAgent：按 Agent kind 取对应 CLI；只认当前查看的服务器；reclaude / zcode 没有对应项", () => {
  assert.equal(cliStateForAgent(PAYLOAD, codexAgent, "server-01").version, "0.159.2");
  assert.equal(cliStateForAgent(PAYLOAD, claudeCodeAgent, "server-01").version, "2.1.292");
  assert.equal(cliStateForAgent(PAYLOAD, reclaudeAgent, "server-01"), null);
  assert.equal(cliStateForAgent(PAYLOAD, codexAgent, "server-02"), null, "切服后旧服务器的结果不串显");
  assert.equal(cliStateForAgent(null, codexAgent, "server-01"), null);
  assert.equal(cliStateForAgent({ serverId: "server-01" }, codexAgent, "server-01"), null);
  // 后端还没探测成功过（installed:null 的「状态未知」占位）：不拿占位覆盖适配器字段
  const unknown = { serverId: "server-01", clis: { codex: { installed: null, version: null, kind: null, login: "unknown", latest: "0.160.1", updateAvailable: false } } };
  assert.equal(cliStateForAgent(unknown, codexAgent, "server-01"), null);
  assert.equal(cliIdForAgent(codexAgent), "codex");
  assert.equal(cliIdForAgent(claudeCodeAgent), "claude");
  assert.equal(cliIdForAgent(reclaudeAgent), null);
});

test("展示文案：版本带安装形态、登录只用非密钥描述、可更新 chip 只在落后时出现", () => {
  const codex = PAYLOAD.clis.codex;
  assert.equal(cliVersionText(codex), "0.159.2 · 独立安装", "落后时版本行不重复说最新版（chip 说）");
  assert.equal(cliVersionText(PAYLOAD.clis.claude), "2.1.292 · 原生安装 · 已是最新");
  assert.equal(cliVersionText({ installed: false }), "未安装");
  assert.equal(cliVersionText({ installed: true, version: null, kind: "unknown" }), "版本未知 · 非官方布局");
  assert.equal(cliLoginText(codex), "中转站 cpa · api.relay-demo.example:9443 · 密钥变量 CPA_API_KEY");
  assert.equal(cliLoginText({ login: "none", loginDetail: null }), "未登录");
  assert.equal(cliLoginText({ login: "chatgpt", loginDetail: null }), "ChatGPT 账号");
  assert.equal(cliVersionText({ installed: true, version: "1.0.0" }), "1.0.0", "版本检测未就绪（无 latest）不写已是最新");
  assert.deepEqual(cliUpdateChip(codex), { text: "可更新到 0.160.1", tone: "info" });
  assert.deepEqual(cliUpdateChip(codex, "codex"), { text: "可更新到 0.160.1", tone: "info", manage: { cli: "codex", action: "update" } }, "chip 可点：直达命令行工具的更新确认");
  assert.equal(cliUpdateChip(PAYLOAD.clis.claude), null);
  assert.equal(cliUpdateChip({ installed: false, latest: "1.0.0", updateAvailable: true }), null, "未安装不提示更新");
});

test("Agent 卡片：有 /api/cli 时显示版本 / 登录方式 / 可更新到 x；没有时回落适配器字段", () => {
  const status = {
    activeServerId: "server-01",
    agentsStatus: {
      codex: { health: "ready", summary: { ok: 18, fail: 0, warn: 0, notes: 0 } },
      "claude-code": { health: "ready", version: "2.1.291", loginDetail: "Max 订阅", endpoint: { ok: true, latencyMs: 361 } },
    },
    layers: { agents: {} },
  };
  const codexModel = buildAgentCardModel(status, codexAgent, 1_000_000, null, PAYLOAD);
  assert.deepEqual(codexModel.chips.at(-1), { text: "可更新到 0.160.1", tone: "info", manage: { cli: "codex", action: "update" } });
  const codexRows = Object.fromEntries(codexModel.drawer.rows.map((r) => [r.label, r.value]));
  assert.equal(codexRows.版本, "0.159.2 · 独立安装");
  assert.equal(codexRows.最新版本, undefined, "最新版本不再单列一行（chip 已说）");
  assert.match(codexRows.登录, /^中转站 cpa/);

  const claudeModel = buildAgentCardModel(status, claudeCodeAgent, 1_000_000, null, PAYLOAD);
  assert.equal(claudeModel.chips.length, 2, "已是最新不加 chip");
  assert.equal(claudeModel.latency, 361);
  const claudeRows = Object.fromEntries(claudeModel.drawer.rows.map((r) => [r.label, r.value]));
  assert.equal(claudeRows.版本, "2.1.292 · 原生安装 · 已是最新", "以 /api/cli 为准");

  // 接口未就绪 / 失败（payload 为 null）：回落适配器字段，不报错、不出 chip
  const fallback = buildAgentCardModel(status, claudeCodeAgent, 1_000_000, null, null);
  const fallbackRows = Object.fromEntries(fallback.drawer.rows.map((r) => [r.label, r.value]));
  assert.equal(fallbackRows.版本, "2.1.291");
  assert.equal(fallbackRows.登录, "Max 订阅");
  assert.equal(fallback.chips.length, 2);
  // 行标签集合各 Agent 同构
  const labels = (model) => model.drawer.rows.map((r) => r.label).join("|");
  assert.equal(labels(fallback), labels(codexModel));
});

test("未安装：灰色中性「未安装」（不是熔断、不是故障），chip 不报端点", () => {
  for (const agent of [codexAgent, claudeCodeAgent]) {
    const status = {
      agentsStatus: { [agent.id]: { health: "not-installed", installed: false, endpoint: { ok: null } } },
      layers: { agents: { [agent.id]: { level: "skipped", reason: "未安装（不计入健康）", checkedAt: 990_000 } } },
    };
    const notInstalled = { ...agent, health: "not-installed" };
    assert.deepEqual(buildAgentHeadline(status, notInstalled), { text: "未安装（可在 配置 → 命令行工具 安装）", tone: "idle" });
    const model = buildAgentCardModel(status, notInstalled, 1_000_000, null, null);
    assert.deepEqual(model.chips[0], { text: "未安装", tone: "idle" });
    assert.equal(model.health, "not-installed");
    assert.match(model.drawer.rows[0].value, /^未安装/);
  }
  // 熔断照旧是「检测暂停」
  const breaker = { agentsStatus: { codex: { health: "ready" } }, layers: { agents: { codex: { level: "skipped" } } } };
  assert.match(buildAgentHeadline(breaker, codexAgent).text, /熔断/);
});

// v2.57 评审后续：装在只有交互 shell 才看得到的位置（后端 detail.offPath / CliState.offPath）不是「未安装」。
test("装了但不在非交互 PATH：根因行说出装在哪（黄色），详情给处理建议，版本行不写「未安装」；动作仍给「安装…」", () => {
  const offPath = "~/.nvm/versions/node/v22.11.0/bin/codex";
  const reason = `降级：已安装在 ${offPath}，但非交互 SSH 的 PATH 里找不到`;
  const status = {
    activeServerId: "server-01",
    agentsStatus: { codex: { health: "degraded", installed: false, offPath, degradedReason: reason, summary: { ok: 0, fail: 0, warn: 0, notes: 0, raw: "" }, endpoint: { ok: true, latencyMs: 300 } } },
    layers: { agents: { codex: { level: "warn", reason: "degraded", checkedAt: 990_000 } } },
  };
  const agent = { ...codexAgent, health: "degraded", summary: "0 项通过，0 项失败" };
  const cli = { serverId: "server-01", clis: { codex: { installed: false, version: null, kind: null, path: null, login: "chatgpt", loginDetail: "ChatGPT 账号", npmGlobal: false, offPath, latest: "0.160.1", updateAvailable: false } } };
  assert.deepEqual(buildAgentHeadline(status, agent), { text: reason, tone: "warn" });
  const model = buildAgentCardModel(status, agent, 1_000_000, null, cli);
  assert.deepEqual(model.chips[0], { text: "端点可达", tone: "ok" }, "端点照常展示，不是灰色的「未安装」");
  const rows = Object.fromEntries(model.drawer.rows.map((r) => [r.label, r.value]));
  assert.match(rows.诊断摘要, /^已安装在 ~\/\.nvm\/versions\/node\/v22\.11\.0\/bin\/codex，但非交互 SSH 的 PATH 里找不到。.*~\/\.bashrc.*安装…/);
  assert.doesNotMatch(rows.诊断摘要, /0 项通过/, "不拿空的 Doctor 计数当摘要");
  assert.equal(rows.版本, "已安装（不在非交互 SSH 的 PATH 里）");
  assert.equal(cliVersionText({ installed: false }), "未安装", "真没装照旧");
  assert.equal(cliVersionText({ installed: true, version: "0.160.1", kind: "standalone", offPath }), "0.160.1 · 独立安装", "装好之后残留的 offPath 不影响");
  // 处理办法之一就是用工作台装官方版：详情里的动作是「安装…」
  assert.match(buildAgentDrawerActionsHtml(agent, cli.clis.codex), /data-cli-manage="codex" data-cli-manage-action="install"/);
  // 没有 /api/cli 结果时同样成立（只靠适配器的 detail.offPath）
  const bare = Object.fromEntries(buildAgentCardModel(status, agent, 1_000_000, null, null).drawer.rows.map((r) => [r.label, r.value]));
  assert.match(bare.诊断摘要, /^已安装在 /);
});

test("Claude Code 未登录：根因行提示在集群上登录（不再是 reclaude 的设备登录文案）", () => {
  const status = { agentsStatus: { "claude-code": { health: "auth-required", login: "none" } }, layers: { agents: {} } };
  const headline = buildAgentHeadline(status, { ...claudeCodeAgent, health: "auth-required" });
  assert.equal(headline.tone, "warn");
  assert.match(headline.text, /尚未登录/);
  const reclaude = buildAgentHeadline({ agentsStatus: { "claude-codewing": { health: "auth-required" } }, layers: { agents: {} } }, { ...reclaudeAgent, health: "auth-required" });
  assert.equal(reclaude.text, "需登录：等待设备完成登录");
});

test("详情动作：没装给「安装…」（直达命令行工具确认），装了给「登录 / 切换账号…」；reclaude 没有；更新只在 chip 上", () => {
  const notInstalled = buildAgentDrawerActionsHtml({ ...codexAgent, health: "not-installed" }, null);
  assert.match(notInstalled, /data-cli-manage="codex" data-cli-manage-action="install"/);
  assert.doesNotMatch(notInstalled, /data-cli-login/);
  const installed = buildAgentDrawerActionsHtml(claudeCodeAgent, PAYLOAD.clis.claude);
  assert.match(installed, /data-cli-login="claude"/);
  assert.doesNotMatch(installed, /data-cli-manage/);
  assert.doesNotMatch(buildAgentDrawerActionsHtml(codexAgent, PAYLOAD.clis.codex), /data-cli-manage/, "可更新时详情里不再放第二个更新入口");
  assert.equal(buildAgentDrawerActionsHtml(reclaudeAgent, null), "");
});
