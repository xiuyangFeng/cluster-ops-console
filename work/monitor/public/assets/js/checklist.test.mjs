import assert from "node:assert/strict";
import test from "node:test";
// 模块可在 Node 导入本身即是回归验证（曾因顶层 document 引用直接 ReferenceError）。
// v2.15：renderChecklist/updateChecklistItem 被 chain.js 活链路取代，
// 清单卡文案逻辑抽为纯函数 buildChecklistModel（getDiagnosticMsg 逻辑不动）。
import { activeProbeBackoff, clusterEnvDrift, getDiagnosticMsg, buildChecklistModel, probeBackoffNote, renderAlertBanner, resolveBannerAction, activeTunnelFailure, shouldShowOnboarding, setupCommandFor } from "./render/checklist.js";
import { BUTTON_LABELS } from "./ui-labels.js";

// getDiagnosticMsg 的诊断分支矩阵。构造最小 status 骨架。
const base = {
  shouldBeRunning: true,
  supervisorUp: true,
  localProxyUp: true,
  tunnelUp: true,
  remotePortOpen: true,
  doctor: { summary: { ok: 5, fail: 0, warn: 0, notes: 0, raw: "5 ok" } },
};

test("waiting: 检测中提示", () => {
  const msg = getDiagnosticMsg({ ...base, health: "waiting" });
  assert.match(msg.title, /正在检测连接/);
});

test("stopped: shouldBeRunning=false 优先于 health", () => {
  const msg = getDiagnosticMsg({ ...base, health: "down", shouldBeRunning: false });
  assert.match(msg.title, /所有连接已停止/);
  // 文案引用的按钮必须真实存在：stopped 态横幅按钮即「▶ 启动所有连接」
  assert.ok(msg.body.includes(BUTTON_LABELS.start));
  assert.equal(msg.action.kind, "start");
  assert.ok(msg.action.label.includes(BUTTON_LABELS.start));
});

test("ready: 连接正常文案，无动作按钮", () => {
  const msg = getDiagnosticMsg({ ...base, health: "ready" });
  assert.match(msg.title, /连接正常/);
  assert.equal(msg.action.kind, "none");
});

test("degraded: 守护未启动的降级原因", () => {
  const msg = getDiagnosticMsg({ ...base, health: "degraded", supervisorUp: false });
  assert.match(msg.title, /不会自动恢复/);
  assert.match(msg.body, /守护进程/);
  assert.doesNotMatch(msg.body, /一级守护|信道/);
});

test("degraded: doctor 有 warn/fail 时给出计数", () => {
  const msg = getDiagnosticMsg({
    ...base,
    health: "degraded",
    doctor: { summary: { ok: 3, fail: 1, warn: 2, notes: 0, raw: "x" } },
  });
  assert.match(msg.body, /警告: 2 项/);
  assert.match(msg.body, /失败: 1 项/);
});

test("degraded: 无明确原因时回落通用降级文案", () => {
  const msg = getDiagnosticMsg({ ...base, health: "degraded" });
  assert.match(msg.body, /非致命配置告警/);
});

test("down: 本地代理挂 → 报端口号(取 activeServer 覆盖默认 8888)", () => {
  const msg = getDiagnosticMsg({
    ...base,
    health: "down",
    localProxyUp: false,
    activeServer: { host: "srv-a", localPort: 9999, remotePort: 7001 },
  });
  assert.match(msg.title, /本机代理没有运行/);
  assert.match(msg.body, /9999 端口/);
});

test("down: 隧道断 → 报 SSH 与主机名", () => {
  const msg = getDiagnosticMsg({ ...base, health: "down", tunnelUp: false, activeServer: { host: "srv-b" } });
  assert.match(msg.title, /SSH 隧道断开/);
  assert.equal(msg.action.kind, "repair");
  assert.match(msg.body, /srv-b/);
});

test("down: 远端端口未监听 → 报查看中服务器的远端端口；没有端口信息时不编造 7891", () => {
  const msg = getDiagnosticMsg({ ...base, health: "down", remotePortOpen: false, activeServer: { id: "server-01", host: "myserver", remotePort: 7893 } });
  assert.match(msg.title, /远端端口没有在监听/);
  assert.match(msg.body, /7893 端口/);
  // v2.54：缺省不再回落 7891（那是别人的端口）
  const bare = getDiagnosticMsg({ ...base, health: "down", remotePortOpen: false });
  assert.match(bare.title, /远端端口没有在监听/);
  assert.doesNotMatch(bare.body, /7891|null/);
});

test("down: 链路全通但端点测试失败", () => {
  const msg = getDiagnosticMsg({ ...base, health: "down", endpoint: { ok: false } });
  assert.match(msg.title, /外部 API 测试失败/);
});

test("down: 无具体归因时回落通用阻断文案", () => {
  const msg = getDiagnosticMsg({ ...base, health: "down" });
  assert.match(msg.title, /连接中断/);
  assert.ok(msg.body.includes(BUTTON_LABELS.repair), "引用的按钮文案必须与实际按钮一致");
});

test("down: 持续断开超 5 分钟 → 追加白名单提示(按服务端时钟)", () => {
  const downSince = 1_000_000_000_000;
  const msg = getDiagnosticMsg({
    ...base,
    health: "down",
    tunnelUp: false,
    updatedAt: new Date(downSince + 10 * 60e3).toISOString(),
    layers: { channel: { detail: { downSinceMs: downSince } } },
  });
  assert.match(msg.body, /白名单/);
  assert.match(msg.body, /约 10 分钟/);
});

test("未知 health: 回落自愈中文案", () => {
  const msg = getDiagnosticMsg({ ...base, health: "mystery" });
  assert.match(msg.title, /正在处理中/);
});

// DOM 缺省环境下渲染入口安全空转(getEl 全部返回 null 不抛异常)；
// buildChecklistModel 纯函数在 Node 直接产出链路主干 4 卡模型（chain.js 详情区消费）。
test("Node 环境: renderAlertBanner 不抛异常 / buildChecklistModel 产出 4 卡模型", () => {
  assert.doesNotThrow(() => renderAlertBanner("down", { title: "t", body: "b" }));
  const items = buildChecklistModel({ ...base, health: "ready" });
  assert.deepEqual(items.map((it) => it.key), ["supervisor", "proxy", "tunnel", "remote"]);
  // 全通态：supervisor/proxy/tunnel/remote 均 ok
  assert.ok(items.every((it) => it.state === "ok"));
  assert.equal(items[0].tag, "守护活跃");
});

// ---- W5：SSH 失败归因 / 首次运行引导 ----
const tunnelDown = (code) => ({
  ...base,
  health: "down",
  tunnelUp: false,
  activeServerId: "server-01",
  activeServer: { host: "myserver", remotePort: 7891 },
  tunnelFailures: code ? { "server-01": { code, nextAction: "x", at: 1 } } : {},
});

test("W5 down+auth: 引向接入引导重新装公钥，不建议一键修复；自己加的服务器引向服务器管理", () => {
  const msg = getDiagnosticMsg(tunnelDown("auth"));
  assert.match(msg.title, /认证失败/);
  assert.equal(msg.action.kind, "open-guide");
  assert.ok(msg.body.includes(msg.action.label), "文案引用的按钮就是右侧这个");
  assert.doesNotMatch(msg.body, /一键修复|npm run setup/);
  // 接入引导只管团队集群：个人服务器的同类问题去服务器管理
  const down = tunnelDown("auth");
  const personal = getDiagnosticMsg({ ...down, activeServer: { ...down.activeServer, source: "personal" } });
  assert.equal(personal.action.kind, "open-settings");
  assert.match(personal.body, /服务器管理/);
  const dns = getDiagnosticMsg(tunnelDown("dns"));
  assert.equal(dns.action.kind, "open-guide");
  const dnsDown = tunnelDown("dns");
  assert.equal(getDiagnosticMsg({ ...dnsDown, activeServer: { ...dnsDown.activeServer, source: "personal" } }).action.kind, "open-settings");
});

test("W5 down+hostkey: 动作为确认主机密钥", () => {
  const msg = getDiagnosticMsg(tunnelDown("hostkey"));
  assert.match(msg.title, /主机密钥/);
  assert.equal(msg.action.kind, "hostkey");
});

test("W5 down+timeout/refused: 提示可能不在白名单网络", () => {
  for (const code of ["timeout", "refused"]) {
    const msg = getDiagnosticMsg(tunnelDown(code));
    assert.match(msg.body, /可能不在服务器的 SSH 白名单/);
    assert.equal(msg.action.kind, "repair");
  }
});

test("W5 down+remote-port: 动作为重新分配端口", () => {
  const msg = getDiagnosticMsg(tunnelDown("remote-port"));
  assert.equal(msg.action.kind, "reassign-port");
  assert.match(msg.body, /7891/);
});

test("W5 activeTunnelFailure: 只取活跃服务器的归因", () => {
  assert.equal(activeTunnelFailure({ activeServerId: "a", tunnelFailures: { b: { code: "auth" } } }), null);
  assert.equal(activeTunnelFailure({ activeServerId: "b", tunnelFailures: { b: { code: "auth" } } }).code, "auth");
  assert.equal(activeTunnelFailure({}), null);
});

test("W5 onboarding: needs-setup 优先于停止/故障文案，连通后不再打扰", () => {
  const msg = getDiagnosticMsg({ ...base, tunnelUp: false, health: "down", shouldBeRunning: false, onboarding: "needs-setup" });
  assert.match(msg.title, /首次配置/);
  assert.match(msg.body, /集群用户名和密码/);
  assert.doesNotMatch(msg.body, /npm run setup|终端/, "不再把人引回终端");
  assert.equal(msg.onboarding, true);
  assert.equal(msg.action.kind, "open-guide");
  assert.ok(msg.body.includes(msg.action.label));
  assert.match(getDiagnosticMsg({ ...base, health: "ready", onboarding: "needs-setup" }).title, /连接正常/);
  assert.equal(getDiagnosticMsg({ ...base, tunnelUp: false, health: "down", onboarding: "no-servers" }).action.kind, "open-settings");
});

test("W5 resolveBannerAction: 未带 action 的旧调用方保持 down/degraded 显示一键修复", () => {
  assert.equal(resolveBannerAction("down", { title: "t", body: "b" }).kind, "repair");
  assert.equal(resolveBannerAction("stopped", { title: "t", body: "b" }).kind, "none");
  assert.equal(resolveBannerAction("down", { action: { kind: "none" } }).kind, "none");
});

test("修复轮 onboarding: 只在 down/已停止 且隧道没起来时出现，真实故障优先", () => {
  // degraded（隧道已通）→ 真实诊断
  const degraded = getDiagnosticMsg({ ...base, health: "degraded", supervisorUp: false, onboarding: "needs-setup" });
  assert.notEqual(degraded.onboarding, true);
  assert.match(degraded.title, /不会自动恢复/);
  // down 但隧道已通（远端端口没监听）→ 真实诊断
  const remote = getDiagnosticMsg({ ...base, health: "down", remotePortOpen: false, onboarding: "needs-setup" });
  assert.notEqual(remote.onboarding, true);
  assert.match(remote.title, /远端端口/);
  // 隧道断 + 需要配置 → 引导卡
  assert.equal(getDiagnosticMsg({ ...base, health: "down", tunnelUp: false, onboarding: "needs-setup" }).onboarding, true);
  // partial 同样引导，但标题区分
  const partial = getDiagnosticMsg({ ...base, health: "down", tunnelUp: false, onboarding: "partial" });
  assert.equal(partial.onboarding, true);
  assert.match(partial.title, /没有走完/);
  // ready 状态的 onboarding 不出卡
  assert.equal(shouldShowOnboarding({ ...base, health: "down", tunnelUp: false, onboarding: "ready" }), false);
  assert.equal(shouldShowOnboarding({ ...base, health: "waiting", tunnelUp: false, shouldBeRunning: true, onboarding: "needs-setup" }), false);
});

test("修复轮 onboarding: 打包 .app 与源码模式是同一个入口（接入引导自己写到正确的个人配置，不用再拼命令）", () => {
  const cmd = "CODEX_MONITOR_LOCAL_CONFIG_PATH='/d/config.local.json' npm run setup";
  const packaged = getDiagnosticMsg({ ...base, health: "down", tunnelUp: false, onboarding: "needs-setup", packaged: true, setupCommand: cmd });
  const src = getDiagnosticMsg({ ...base, health: "down", tunnelUp: false, onboarding: "needs-setup", setupCommand: cmd });
  assert.deepEqual(packaged, src);
  assert.equal(src.action.kind, "open-guide");
  assert.ok(!src.body.includes(cmd));
  assert.doesNotMatch(src.body, /源码目录|填写 SSH 用户名与端口/);
  // 命令行向导的精确命令仍然算得出来（排障报告等处使用）
  assert.equal(setupCommandFor({}), BUTTON_LABELS.setupCommand);
  assert.equal(setupCommandFor(null), BUTTON_LABELS.setupCommand);
  assert.equal(setupCommandFor({ setupCommand: cmd }), cmd);
});

test("集群配置与隧道端口不一致：链路正常时也要单独亮出来，按钮是「同步到集群」", () => {
  const ready = { ...base, health: "ready", activeServer: { id: "server-01", host: "myserver", remotePort: 7893 } };
  const env = { serverId: "server-01", state: "drift", envPort: 7891, expectedPort: 7893, lastSync: null };
  const msg = getDiagnosticMsg({ ...ready, clusterEnv: env });
  assert.equal(msg.title, "集群上的代理配置和隧道端口不一致");
  assert.equal(msg.action.kind, "sync-cluster-env");
  assert.equal(msg.attention, true);
  assert.match(msg.body, /隧道现在用的是端口 7893/);
  assert.match(msg.body, /还指向端口 7891/);
  assert.equal(resolveBannerAction("ready", msg).kind, "sync-cluster-env");

  // 上次自动同步失败的原因带出来；文件认不出来时不编端口号
  const failed = getDiagnosticMsg({ ...ready, clusterEnv: { ...env, envPort: null, lastSync: { ok: false, error: "改写失败（Connection closed）" } } });
  assert.match(failed.body, /上次自动同步没成功：改写失败（Connection closed）/);
  assert.match(failed.body, /已被改得认不出来/);

  // 一致 / 没有受管配置 / 是另一台服务器的结论 / 还没查过：照常「连接正常」
  for (const clusterEnv of [{ ...env, state: "in-sync" }, { ...env, state: "absent" }, { ...env, serverId: "other" }, null, undefined]) {
    assert.equal(getDiagnosticMsg({ ...ready, clusterEnv }).title, "连接正常");
  }
  assert.equal(clusterEnvDrift({ clusterEnv: env }, null), null);
  // 链路真断了时让真实故障优先
  assert.notEqual(getDiagnosticMsg({ ...ready, health: "down", tunnelUp: false, clusterEnv: env }).action.kind, "sync-cluster-env");
});

test("探针退避：查看中的服务器探测已放慢时，断开横幅末尾补一句（带下次探测时刻）；别的服务器在退避、没开这项、链路正常时都不补", () => {
  const nextProbeAt = new Date(2026, 9, 12, 14, 3, 20).getTime();
  const backedOff = { enabled: true, servers: { "server-01": { since: nextProbeAt - 600_000, nextProbeAt, failures: 9, probing: false } } };
  const down = { ...base, health: "down", tunnelUp: false, remotePortOpen: false, activeServerId: "server-01", activeServer: { id: "server-01", host: "myserver", remotePort: 7891 } };
  const note = "服务器暂时连不上，探测已放慢（下次 14:03:20），连上后自动恢复正常节奏。";

  assert.equal(activeProbeBackoff({ ...down, probeBackoff: backedOff }).nextProbeAt, nextProbeAt);
  assert.equal(probeBackoffNote({ ...down, probeBackoff: backedOff }), note);
  const msg = getDiagnosticMsg({ ...down, probeBackoff: backedOff });
  assert.equal(msg.title, "SSH 隧道断开");
  assert.ok(msg.body.endsWith(` ${note}`));
  assert.equal(msg.action.kind, "repair", "按钮不变");
  assert.equal(msg.probeNow, true, "正文下方出「立即探测」");

  for (const probeBackoff of [undefined, null, { enabled: false, servers: {} }, { enabled: true, servers: {} }, { enabled: true, servers: { aliyun: backedOff.servers["server-01"] } }, { enabled: true, servers: { "server-01": { nextProbeAt: null } } }]) {
    assert.equal(activeProbeBackoff({ ...down, probeBackoff }), null);
    assert.equal(getDiagnosticMsg({ ...down, probeBackoff }).body.includes("探测已放慢"), false);
    assert.equal(getDiagnosticMsg({ ...down, probeBackoff }).probeNow, undefined, "没在退避就没有「立即探测」");
  }
  // 链路正常（退避只可能是刚恢复前的残留）：正常横幅不带这句。
  assert.equal(getDiagnosticMsg({ ...base, health: "ready", activeServerId: "server-01", probeBackoff: backedOff }).body.includes("探测已放慢"), false);
});

test("Windows 查询能力故障显示原因和下一次检查，不给重启所有连接按钮", () => {
  const msg = getDiagnosticMsg({ health: "waiting", shouldBeRunning: true, layers: { channel: { detail: { processQueryDiagnostic: { message: "系统 PowerShell 无法启动，保留现有连接", nextRetryAt: Date.now() + 300000 } } } } });
  assert.equal(msg.title, "Windows 进程检测暂不可用");
  assert.match(msg.body, /PowerShell.*保留现有连接.*下次检查/);
  assert.equal(msg.action.kind, "none");
});
