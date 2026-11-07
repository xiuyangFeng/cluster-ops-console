// 一份工作台的 SSH 预算（v2.57 评审后续）。
//
// 工作台是每人一份、各自经 SSH 轮询同一个登录节点，「每份工作台每分钟发多少次 SSH」是要省的资源。
// 这里按生产同一条装配路径（createChannelToolkit → registerProbes / registerLoadProbes /
// registerValidationProbes）注册探针，用假 SSH + 假时钟跑进稳态，按探针数出 30 分钟里实际发出的 ssh 次数。
// 改了任何探针的节奏、加了新探针，这张表都会变——那就是要重新掂量的时候（docs/architecture.md 有同一张表）。
//
// 说明：
//   · 假 SSH 零耗时，数出来的是名义上限。真实节奏 = 间隔 + 单次耗时（略低），±10% 抖动不改变均值。
//   · 只数调度器里的探针。界面触发的不在内：服务器页可见时「远端守护进程」面板每 60 秒一次（窗口隐藏或
//     不在服务器页时为 0），其余（目录扫描、作业回查、安装 / 登录、手动重测）都是用户点了才发。
//   · 调度器不感知窗口是否可见：窗口隐藏时后端探针节奏不变（省电只在前端——暂停渲染与动画、兜底轮询降频）。
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeAgentConfig } from "../monitor-core.mjs";
import { createDiagnosesStore, DIAGNOSES_FILE } from "./jobs/diagnoses-store.mjs";
import { createJobRegistry, REGISTRY_FILE } from "./jobs/registry.mjs";
import { createJobWatchStore, JOB_WATCH_FILE } from "./jobs/watch-store.mjs";
import { applyModulePreferences } from "./modules/catalog.mjs";
import { createProbeScheduler } from "./probe-scheduler.mjs";
import { createChannelToolkit } from "./probes.mjs";
import { createUsageStore } from "./usage/store.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WARMUP_MIN = 10; // 先跑进稳态（doctor / claude-code 连续 3 轮 ok 后降频）再计数
const WINDOW_MIN = 30;

// 新同事的典型配置：团队 config.json 原样（codex + claude-code 开，reclaude / zcode 团队默认关），
// 个人层只领了端口、没碰过模块开关（用量 / 作业 / 守护进程默认开）。
function typicalConfig() {
  const team = JSON.parse(readFileSync(path.join(REPO_ROOT, "config.json"), "utf8"));
  return applyModulePreferences(normalizeAgentConfig({ ...team, servers: team.servers.map((s) => ({ ...s, remotePort: 17891 })) }));
}

const CLI_OUTPUT = [
  "__CLI_BEGIN__", "user=u",
  "codex.installed=1", "codex.path=/h/.codex/packages/standalone/releases/0.159.2-x86_64-unknown-linux-musl/bin/codex", "codex.version=codex-cli 0.159.2", "codex.authFile=1", "codex.authTokens=1",
  "claude.installed=1", "claude.path=/h/.local/share/claude/versions/2.1.292", "claude.version=2.1.292 (Claude Code)", "claude.oauth=1", "claude.subscription=max",
  "endpoint=401 0.36", "__CLI_END__",
].join("\n");

// 各探针一份「一切正常」的远端输出（探针 id 由调度器的 run 包装经 AsyncLocalStorage 带进来）。
function healthyReply(id, nowMs) {
  if (id === "doctor") return "18 ok | 0 warn | 0 fail\n__CODEX_AUTH_BEGIN__\n__CODEX_AUTH_END__\n";
  if (id === "endpoint") return "HTTP/2 401\nrtt=0.3\n";
  if (id === "claude-code" || id.startsWith("cli:")) return CLI_OUTPUT;
  if (id.startsWith("usage:")) return `${JSON.stringify({ k: "end", complete: true, files: 0, pending: 0, bytes: 0, sec: 0.1, roots: {}, home: "/h" })}\n`;
  if (id.startsWith("jobs:")) return `now=${Math.floor(nowMs / 1000)}\ntz=+0800\nuser=u\nstate=ok\nrows=0\n`;
  return "ok\n";
}

// 跑 WARMUP_MIN + WINDOW_MIN 分钟（假时钟，一拍一秒），返回计数窗口里每枚探针发出的 ssh 次数。
async function measure({ shouldBeRunning = true, channelOk = true } = {}) {
  const config = typicalConfig();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ssh-budget-"));
  let clock = Date.UTC(2026, 9, 8, 2, 0, 0);
  const now = () => clock;
  const current = new AsyncLocalStorage();
  const counts = {};
  const scheduler = createProbeScheduler({ now, jitterRatio: 0, sshConcurrency: 3 });
  const register = scheduler.registerProbe;
  scheduler.registerProbe = (spec) => register({ ...spec, run: () => current.run(spec.id, spec.run) });
  try {
    const toolkit = createChannelToolkit({
      rootDir: REPO_ROOT,
      dataDir: tmp,
      getConfig: async () => config,
      now,
      execFileImpl: async (cmd) => {
        if (cmd !== "ssh") return { code: 0, stdout: "", stderr: "" };
        const id = current.getStore() || "(unattributed)";
        counts[id] = (counts[id] || 0) + 1;
        return { code: 0, stdout: healthyReply(id, clock), stderr: "" };
      },
      usageStore: createUsageStore({ rootDir: path.join(tmp, "usage"), now }),
      jobsStores: {
        registry: createJobRegistry({ filePath: path.join(tmp, REGISTRY_FILE) }),
        diagnoses: createDiagnosesStore({ filePath: path.join(tmp, DIAGNOSES_FILE) }),
        watch: createJobWatchStore({ filePath: path.join(tmp, JOB_WATCH_FILE) }),
      },
    });
    const getShouldBeRunning = () => shouldBeRunning;
    const isChannelOk = () => channelOk;
    toolkit.registerProbes({ scheduler, config, getShouldBeRunning, isChannelOk, getTunnelUp: isChannelOk, onLogSignals: () => {} });
    toolkit.registerLoadProbes({ scheduler, servers: config.servers, getShouldBeRunning, modules: config.modules });
    toolkit.registerValidationProbes({ scheduler, servers: config.servers, activeServerId: config.activeServerId, getShouldBeRunning, getChannelUp: isChannelOk });

    const countFrom = clock + WARMUP_MIN * 60000;
    const end = countFrom + WINDOW_MIN * 60000;
    for (; clock < end; clock += 1000) {
      if (clock === countFrom) for (const id of Object.keys(counts)) delete counts[id];
      scheduler.tick();
      // 等这一拍发起的探针全部结算（用量入库走真实磁盘）再拨钟：等价于「探针零耗时」
      do {
        await new Promise((resolve) => setImmediate(resolve));
      } while (scheduler.getMetrics().inflightProbes > 0);
    }
    return counts;
  } finally {
    scheduler.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
}

const perMinute = (counts) => Number((Object.values(counts).reduce((sum, n) => sum + n, 0) / WINDOW_MIN).toFixed(2));

test("SSH 预算：典型配置（codex + claude-code，用量 / 作业默认开）稳态下每分钟约 10 次，按探针逐项钉住", async () => {
  const counts = await measure();
  assert.deepEqual(counts, {
    "log-signals": 180, //            10 秒一轮  6.00/分  日志信号 + 远端端口（通道恢复判定的数据源，不可关）
    "collect:slow:server-01": 30, //  60 秒一轮  1.00/分  负载 / 磁盘 / GPU / Slurm
    "usage:server-01": 30, //         60 秒一轮  1.00/分  Agent 用量（首轮回填期间 5 秒一轮）
    endpoint: 20, //                  90 秒一轮  0.67/分  ChatGPT 端点（固定节奏）
    "validation:server-01": 18, //     5 分钟一轮、每轮 3 次 ssh  0.60/分
    doctor: 6, //                     稳态 5 分钟  0.20/分（非稳态 90 秒）
    "claude-code": 6, //              稳态 5 分钟  0.20/分（非稳态 90 秒；v2.57.0 是固定 90 秒 = 0.67/分）
    "jobs:server-01": 6, //            5 分钟一轮  0.20/分（有新失败 / 关注中的作业时每轮多 1–2 次）
    "cli:server-01": 3, //            10 分钟一轮  0.10/分
  });
  assert.equal(perMinute(counts), 9.97);
});

test("SSH 预算：通道断开时 Agent 与验证探针被熔断（0 次），其余照常；手动停止通道后全部为 0", async () => {
  const down = await measure({ channelOk: false });
  assert.deepEqual(down, { "log-signals": 180, "collect:slow:server-01": 30, "usage:server-01": 30, "jobs:server-01": 6, "cli:server-01": 3 });
  assert.equal(perMinute(down), 8.3);
  assert.deepEqual(await measure({ shouldBeRunning: false }), {});
});
