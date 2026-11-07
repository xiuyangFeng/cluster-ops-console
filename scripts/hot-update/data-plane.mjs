// scripts/hot-update/data-plane.mjs —— 数据面（supervisor / proxy）按需平滑交接：supervisor 代码变了才
// POST /api/data-plane/upgrade，proxy 需 --with-proxy 或交互确认；交接前后隧道 pid 必须不变，
// ssh 隧道本身从不重启。
import { postDataPlaneUpgrade } from "./api.mjs";

// 数据面交接计划：supervisor 默认交接；proxy 需 --with-proxy 或交互确认。
export function planDataPlane(dataPlane, { withProxy = false, proxyConfirmed = false } = {}) {
  const pending = Array.isArray(dataPlane?.pending) ? dataPlane.pending.filter((c) => c === "supervisor" || c === "proxy") : [];
  const components = [];
  const skipped = [];
  for (const name of ["supervisor", "proxy"]) {
    if (!pending.includes(name)) continue;
    if (name === "proxy" && !withProxy && !proxyConfirmed) {
      skipped.push({ name, reason: "proxy 交接需 --with-proxy" });
    } else {
      components.push(name);
    }
  }
  return { pending, components, skipped };
}

// 隧道 pid 对比：before 里的每条隧道 after 必须同 pid（新增隧道不算中断）。
// verified=false 表示交接前没有任何运行中的隧道——此时"没有 pid 变化"不能当作"隧道没断"
// （隧道在交接前就已经断了，常见于网络切换 / 休眠唤醒），调用方必须如实说明无法核对。
export function compareTunnelPids(before = {}, after = {}) {
  const changed = [];
  for (const [name, pid] of Object.entries(before || {})) {
    const next = after?.[name];
    if (next !== pid) changed.push({ name, before: pid, after: next ?? null });
  }
  const verified = Object.keys(before || {}).length > 0;
  return { unchanged: changed.length === 0, changed, verified };
}

function formatTunnelPids(map = {}) {
  const entries = Object.entries(map || {});
  if (!entries.length) return "(无)";
  return entries.map(([name, pid]) => `${name}=${pid}`).join(", ");
}

// 新 monitor 刚起来时启动期 autoRepair 会短暂占住互斥（isBusy → 409）：按退避重试，
// 5 次共约 15s；仍 409 才如实失败。其它状态码（含 200 + ok:false 的业务失败）不重试。
const DATA_PLANE_409_BACKOFF_MS = Object.freeze([1000, 2000, 3000, 4000, 5000]);

async function postDataPlaneUpgradeWithRetry(ctx, components, { backoffMs = DATA_PLANE_409_BACKOFF_MS } = {}) {
  let res = await postDataPlaneUpgrade(ctx, components);
  for (const delay of backoffMs) {
    if (res.status !== 409) break;
    ctx.log(`  · 控制面暂忙（${res.body?.error || "409"}），${Math.round(delay / 1000)}s 后重试…`);
    await ctx.sleep(delay);
    res = await postDataPlaneUpgrade(ctx, components);
  }
  return res;
}

export const LEGACY_DATA_PLANE_MESSAGE = "当前运行中的后台守护进程版本较旧，不支持无缝交接：请在方便时重启一次通道（会短暂断开），之后的所有升级都不中断。";

export async function upgradeDataPlane(ctx, opts, buildInfo, expected) {
  const { log } = ctx;
  const dataPlane = buildInfo?.dataPlane;
  if (!dataPlane) {
    log("· 控制面未提供 dataPlane 信息（旧版控制面），跳过数据面交接");
    return { ok: true, skipped: true };
  }
  for (const name of ["supervisor", "proxy"]) {
    const seen = dataPlane.bundle?.[name];
    const want = expected?.components?.[name];
    if (seen && want && seen !== want) log(`! 控制面看到的磁盘 ${name} 指纹 ${seen} 与新包 ${want} 不一致（交接将以控制面所见为准）`);
  }
  const pending = Array.isArray(dataPlane.pending) ? dataPlane.pending : [];
  if (!pending.length) {
    log("· supervisor/proxy 代码无变化，数据面保持原进程（零扰动）");
    return { ok: true, skipped: true };
  }
  let proxyConfirmed = false;
  if (pending.includes("proxy") && !opts.withProxy && ctx.isTTY) {
    proxyConfirmed = await ctx.prompt(
      "本地代理(8888)代码有变化。代理交接时新旧监听切换有亚秒级窗口，已建立的连接会在旧进程里继续排干、不会被切断。现在交接代理吗？[y/N] ",
    );
  }
  const plan = planDataPlane(dataPlane, { withProxy: opts.withProxy, proxyConfirmed });
  for (const s of plan.skipped) log(`· 跳过 ${s.name} 交接（${s.reason}）；旧进程继续运行，后续可再运行 npm run app:update 交接`);
  if (!plan.components.length) return { ok: true, skipped: true };
  if (dataPlane.channelRunning === false) {
    log("· 通道当前已停止：无需交接，下次启动通道即直接运行新代码");
    return { ok: true, skipped: true };
  }
  // 字段缺失（更旧的控制面）按未知处理、照常尝试；明确 false 才判定旧 supervisor 无法交接。
  if (dataPlane.handoffSupported === false) {
    log(`! ${LEGACY_DATA_PLANE_MESSAGE}`);
    log("  （本次未发起交接：旧版守护进程没有交接退出逻辑，强行替换会断开隧道；数据面继续运行旧代码，不影响使用）");
    return { ok: true, skipped: true, warning: "legacy-supervisor" };
  }
  log(`→ 平滑交接数据面：${plan.components.join(" + ")}（ssh 隧道不重启）`);
  let res;
  try {
    res = await postDataPlaneUpgradeWithRetry(ctx, plan.components);
  } catch (err) {
    log(`✗ 数据面交接请求失败：${err.message}`);
    return { ok: false };
  }
  const body = res.body || {};
  for (const step of Array.isArray(body.steps) ? body.steps : []) {
    log(`  · ${typeof step === "string" ? step : JSON.stringify(step)}`);
  }
  const before = body.tunnels?.before || {};
  const after = body.tunnels?.after || {};
  log(`  隧道 pid 交接前: ${formatTunnelPids(before)}`);
  log(`  隧道 pid 交接后: ${formatTunnelPids(after)}`);
  if (body.proxy && (body.proxy.beforePid || body.proxy.afterPid)) log(`  代理 pid: ${body.proxy.beforePid ?? "?"} → ${body.proxy.afterPid ?? "?"}`);
  const cmp = compareTunnelPids(before, after);
  if (!body.ok || res.status >= 400) {
    log(`✗ 数据面交接未成功（HTTP ${res.status}${body.error ? `: ${body.error}` : ""}）`);
    const failed = (Array.isArray(body.steps) ? body.steps : []).find((step) => step && typeof step === "object" && step.ok === false);
    if (failed) log(`  失败步骤 ${failed.name}: ${failed.detail || ""}`);
    if (!cmp.unchanged) log(`✗ 隧道 pid 发生变化：${cmp.changed.map((c) => `${c.name} ${c.before}→${c.after}`).join(", ")}`);
    return { ok: false, tunnelsUnchanged: cmp.unchanged };
  }
  if (!cmp.unchanged) {
    log(`✗ 隧道 pid 发生变化（隧道被重建）：${cmp.changed.map((c) => `${c.name} ${c.before}→${c.after}`).join(", ")}`);
    return { ok: false, tunnelsUnchanged: false };
  }
  if (!cmp.verified) {
    log("! 交接前没有运行中的隧道，无法核对隧道连续性（隧道在交接前就已断开，常见于网络切换或休眠唤醒；交接本身没有停隧道）");
    log(`  交接后隧道：${formatTunnelPids(after)}——请在控制台确认隧道已恢复`);
    return { ok: true, tunnelsUnchanged: null, tunnelsVerified: false, components: plan.components };
  }
  log("✓ 隧道未中断（交接前后 pid 一致）");
  return { ok: true, tunnelsUnchanged: true, components: plan.components };
}
