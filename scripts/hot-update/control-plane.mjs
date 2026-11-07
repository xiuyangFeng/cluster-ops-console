// scripts/hot-update/control-plane.mjs —— 控制面（Electron 主进程 + monitor-server）热重启：
// 经进程注册表的 desktop-main 记录找到桌面主进程（pid 存活 + 命令行校验），发 SIGUSR2 后
// 等 /api/build-info 报告新构建；时限内没起来就自动换回旧包再 SIGUSR2。
import path from "node:path";
import { DESKTOP_MAIN_RECORD } from "../../work/monitor/lib/control-plane-restart.mjs";
import { getBuildInfoApi } from "./api.mjs";
import { swapBack } from "./bundle.mjs";
import { APP_NAME, describeBuild, readBuildInfoFile } from "./layout.mjs";

const CONTROL_PLANE_TIMEOUT_MS = 45_000;

// 桌面主进程命令行：就是 .app 主二进制本身，后面只允许 Chromium/Electron 旗标（-psn_* 等），
// 不能带脚本参数——带 work/monitor/*.mjs 的是 ELECTRON_RUN_AS_NODE 跑的 monitor/supervisor/proxy。
export function isDesktopMainCommand(cmdline, appDir) {
  if (typeof cmdline !== "string" || !cmdline) return false;
  const bin = path.join(appDir, "Contents", "MacOS", APP_NAME);
  const trimmed = cmdline.trim();
  if (!trimmed.startsWith(bin)) return false;
  const rest = trimmed.slice(bin.length);
  if (rest && !rest.startsWith(" ")) return false;
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  return tokens.every((t) => t.startsWith("-") && !/\.(m?js|cjs)$/i.test(t) && !t.includes("work/"));
}

// 控制面是否已是期望构建：commit/version 必须一致；双方都有 builtAt 时也要一致（同 commit
// 重建）；startedAt 早于发信号时刻则说明还是旧进程在应答。
export function monitorMatchesBuild(monitorRunning, expected = {}, sinceMs) {
  const build = monitorRunning?.build;
  if (!build) return false;
  if (!expected.gitCommit && !expected.version) return false;
  if (expected.gitCommit && build.gitCommit !== expected.gitCommit) return false;
  if (expected.version && build.version !== expected.version) return false;
  if (expected.builtAt && build.builtAt && build.builtAt !== expected.builtAt) return false;
  if (Number.isFinite(sinceMs) && Number.isFinite(monitorRunning.startedAt) && monitorRunning.startedAt < sinceMs - 2000) return false;
  return true;
}

export async function findDesktopMain(ctx, layout) {
  let record;
  try {
    record = JSON.parse(await ctx.fs.readFile(path.join(layout.runtimeDir, `${DESKTOP_MAIN_RECORD}.pid.json`), "utf8"));
  } catch {
    return { running: false, reason: "no-record" };
  }
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 1) return { running: false, reason: "bad-record" };
  if (!ctx.isAlive(pid)) return { running: false, reason: "dead", pid };
  const res = await ctx.run("ps", ["-o", "command=", "-p", String(pid)]);
  const cmdline = String(res.stdout || "").trim();
  if (res.code !== 0 || !isDesktopMainCommand(cmdline, layout.appDir)) return { running: false, reason: "cmdline-mismatch", pid };
  return { running: true, pid };
}

async function waitForControlPlane(ctx, { expected, sinceMs, timeoutMs = CONTROL_PLANE_TIMEOUT_MS, intervalMs = 1000 }) {
  const deadline = ctx.now() + timeoutMs;
  let last = null;
  while (ctx.now() < deadline) {
    const info = await getBuildInfoApi(ctx);
    if (info) last = info;
    if (info && monitorMatchesBuild(info.monitorRunning, expected, sinceMs)) return { ok: true, info };
    await ctx.sleep(intervalMs);
  }
  return { ok: false, info: last };
}

export async function activateControlPlane(ctx, layout, opts, { expected, desktop, swap, parkDir }) {
  const { log } = ctx;
  if (desktop.running) {
    // 发信号前再校验一次（pid 复用防护）。
    const recheck = await findDesktopMain(ctx, layout);
    if (!recheck.running || recheck.pid !== desktop.pid) {
      log(`  ! 桌面进程状态已变化（${recheck.reason || `pid ${recheck.pid}`}），不发送信号；新包下次启动桌面时生效`);
      return { ok: true, activated: false };
    }
    const sinceMs = ctx.now();
    log(`→ 向桌面主进程 pid ${desktop.pid} 发送 SIGUSR2（只重启控制面，隧道/代理/supervisor 不动）`);
    ctx.kill(desktop.pid, "SIGUSR2");
    log(`→ 等待控制面报告新构建 ${describeBuild(expected)}（≤${Math.round(CONTROL_PLANE_TIMEOUT_MS / 1000)}s）…`);
    const waited = await waitForControlPlane(ctx, { expected, sinceMs });
    if (waited.ok) {
      log("✓ 控制面已切换到新构建");
      return { ok: true, activated: true, info: waited.info };
    }
    const seen = waited.info?.monitorRunning?.build;
    log(`✗ 控制面未在时限内切到新构建（最后看到: ${seen ? describeBuild(seen) : "无应答"}），开始自动回退`);
    await revertAfterFailure(ctx, layout, { swap, parkDir });
    return { ok: false, activated: false };
  }
  if (opts.launch) {
    const sinceMs = ctx.now();
    log("→ 桌面未运行，按 --launch 启动新版");
    await ctx.run("open", [layout.appDir]);
    const waited = await waitForControlPlane(ctx, { expected, sinceMs });
    if (waited.ok) {
      log("✓ 新版桌面已启动，控制面就绪");
      return { ok: true, activated: true, info: waited.info };
    }
    log("! 新版桌面未在时限内就绪；新包已落地，请手动打开检查（未自动回退：此前桌面并未运行）");
    return { ok: false, activated: false, launchedOnly: true };
  }
  log("· 桌面未运行：新包已就位，下次打开控制台即为新版（加 --launch 可立即启动）");
  return { ok: true, activated: false };
}

async function revertAfterFailure(ctx, layout, { swap, parkDir }) {
  const { log } = ctx;
  if (!swap.backupDir) {
    log("✗ 没有旧包可换回（首次安装），请手动检查");
    return;
  }
  await swapBack(ctx, layout, swap, parkDir);
  log(`↩ 已换回旧包；失败的新包移到 ${parkDir}`);
  const desktop = await findDesktopMain(ctx, layout);
  if (desktop.running) {
    log(`→ 向桌面主进程 pid ${desktop.pid} 发送 SIGUSR2，重启回旧控制面`);
    ctx.kill(desktop.pid, "SIGUSR2");
  } else {
    log("→ 桌面主进程已不在，重新打开旧版 .app");
    await ctx.run("open", [layout.appDir]);
  }
  const restored = await readBuildInfoFile(ctx, layout.appDir);
  const back = await waitForControlPlane(ctx, { expected: restored || {}, sinceMs: undefined });
  log(back.ok ? "✓ 旧控制面已恢复" : "! 旧控制面也未在时限内就绪，请手动检查桌面状态");
}
