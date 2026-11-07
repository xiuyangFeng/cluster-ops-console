// scripts/hot-update/tunnel-guard.mjs —— 换包前的隧道保护预检（v2.54 终审）。
//
// 为什么必须在换包之前：supervisor 每拍按"绝对路径"重读 <现役 .app>/Contents/Resources/app/config.json
// （runtime-paths 在启动时算好的路径串，不是 inode）。原子换包一完成，哪怕旧 supervisor 还没被交接，
// 它下一拍读到的就是新包的 config.json；新 supervisor 首拍同理。v2.54 起团队 config.json 不再带
// server-01.remotePort——个人层还没写 portOverrides 时 resolveTunnelTargets 得空集，
// supervisor/reconcile.mjs 会把运行中的 7891 隧道当作"目标已移除"停掉，而交接后的 pid 比对
// （data-plane.mjs）只能事后打印"隧道 pid 发生变化"，回滚不了已经断掉的隧道。
//
// 做法：尚未动任何进程、尚未换包时，用"新包自己的代码"（loadLayeredConfig + resolveSupervisorConfig）
// 对"新包 config.json + 生产个人层 config.local.json"算出换包后的隧道目标集，与运行中隧道
// （tunnel.<id>.pid.json 里 pid 存活的记录 ∪ 运行快照 supervisor-state.json 的目标）逐条比签名：
// 有运行中隧道在新目标集里消失或签名变化 → 拒绝交接，打印原因与修法；--force 跳过。
//
// 全部 I/O 经 ctx（fs.readdir / fs.readFile / isAlive）与可注入的 resolveTargets，测试只用临时目录。
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNTIME_SNAPSHOT_FILENAME } from "../../work/monitor/lib/runtime-snapshot.mjs";

const TUNNEL_RECORD_RE = /^tunnel\.(.+)\.pid\.json$/;
// 隧道签名：-R 127.0.0.1:<远端>:127.0.0.1:<本地> <host>（supervisor/tunnel-spec.mjs buildTunnelSignature）。
const SIGNATURE_RE = /^-R 127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+) (\S+)$/;

export function parseTunnelSignature(signature) {
  const m = SIGNATURE_RE.exec(String(signature || "").trim());
  return m ? { remotePort: Number(m[1]), localPort: Number(m[2]), host: m[3] } : null;
}

async function readJson(ctx, file) {
  try {
    return JSON.parse(await ctx.fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// 运行中的隧道：serverId → { signature, pid?, source }。
//   - tunnel.<id>.pid.json：pid 存活才算（死记录是上次没清的残留）；签名取记录里的 signature；
//   - supervisor-state.json：supervisor pid 存活时，它的 targets 就是"它此刻在保的隧道"，
//     pid.json 缺失（如正在退避重连）的目标同样会被新目标集影响，一并纳入。
export async function readRunningTunnels(ctx, runtimeDir) {
  const running = {};
  let names = [];
  try {
    names = await ctx.fs.readdir(runtimeDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const m = TUNNEL_RECORD_RE.exec(name);
    if (!m) continue;
    const meta = await readJson(ctx, path.join(runtimeDir, name));
    if (!meta || !Number.isInteger(meta.pid) || !ctx.isAlive(meta.pid)) continue;
    running[m[1]] = { signature: typeof meta.signature === "string" ? meta.signature : "", pid: meta.pid, source: "pid" };
  }
  const snapshot = await readJson(ctx, path.join(runtimeDir, RUNTIME_SNAPSHOT_FILENAME));
  if (snapshot && Number.isInteger(snapshot.pid) && ctx.isAlive(snapshot.pid) && snapshot.targets && typeof snapshot.targets === "object") {
    for (const [id, target] of Object.entries(snapshot.targets)) {
      const signature = typeof target?.signature === "string" ? target.signature : "";
      if (running[id]) {
        if (!running[id].signature && signature) running[id].signature = signature;
        continue;
      }
      if (signature) running[id] = { signature, source: "snapshot" };
    }
  }
  return running;
}

// 缺省实现：从新包（appRoot = 含 config.json 与 work/ 的目录）动态 import 它自己的配置代码算目标集。
// 返回 { tunnels: [{ id, signature, remotePort, localPort, host }], localConfigError }。
export async function importBundleTunnelTargets({ appRoot, configPath, localConfigPath, dataRoot }) {
  const libDir = path.join(appRoot, "work", "monitor", "lib");
  const loader = await import(pathToFileURL(path.join(libDir, "config-loader.mjs")).href);
  const supervisorConfig = await import(pathToFileURL(path.join(libDir, "supervisor", "config.mjs")).href);
  let tunnelSpec = null;
  try {
    tunnelSpec = await import(pathToFileURL(path.join(libDir, "supervisor", "tunnel-spec.mjs")).href);
  } catch {}
  let localConfigError = false;
  const parsed = loader.loadLayeredConfig({ configPath, localConfigPath, onLocalError: () => { localConfigError = true; } });
  const resolved = supervisorConfig.resolveSupervisorConfig(parsed, { dataRoot });
  const sign = (t) => (tunnelSpec?.buildTunnelSignature ? tunnelSpec.buildTunnelSignature(t) : `-R 127.0.0.1:${t.remotePort}:127.0.0.1:${t.localPort} ${t.host}`);
  return {
    localConfigError,
    tunnels: (resolved.tunnels || []).map((t) => ({ id: t.id, signature: sign(t), remotePort: t.remotePort, localPort: t.localPort, host: t.host })),
  };
}

// 纯函数：运行中隧道 vs 新目标集 → 问题列表（消失 / 签名变化）。新增目标不算问题。
export function compareTunnelTargets(running = {}, next = []) {
  const byId = new Map((next || []).map((t) => [t.id, t]));
  const problems = [];
  for (const [id, entry] of Object.entries(running || {})) {
    const target = byId.get(id);
    if (!target) problems.push({ id, kind: "missing", before: entry.signature, after: null });
    else if (entry.signature && target.signature !== entry.signature) problems.push({ id, kind: "changed", before: entry.signature, after: target.signature });
  }
  return problems;
}

function personalOverrides(personal) {
  const o = personal?.portOverrides;
  return o && typeof o === "object" && !Array.isArray(o) ? o : {};
}

// 每条问题的修法（给人看的一句）。消失且个人层没有该服务器的 portOverrides → 直接给要写入的值
// （取运行中隧道的签名：远端端口 + 本机代理端口，kai 即 {remotePort:7891, localPort:8888}）。
export function describeFix(problem, { personal, localConfigPath }) {
  const before = parseTunnelSignature(problem.before);
  if (problem.kind === "missing") {
    const has = Object.hasOwn(personalOverrides(personal), problem.id);
    if (!has && before) {
      return `个人层缺 portOverrides.${problem.id}：先在 ${localConfigPath} 写入 "portOverrides": { "${problem.id}": { "remotePort": ${before.remotePort}, "localPort": ${before.localPort} } }，再重跑热更新`;
    }
    return `新配置里 ${problem.id} 不再建隧道（被屏蔽 / tunnel:false / 端口无效）；确认个人层 ${localConfigPath} 里该服务器的设置后再重跑`;
  }
  return `新配置会把 ${problem.id} 的隧道改成 ${problem.after}（原 ${problem.before}），交接时会重建这条隧道；若不是有意改动，请先修正 ${localConfigPath} 里的端口`;
}

// 预检主入口。返回 { ok, skipped?, problems, running, next, error? }；不打印——由调用方决定措辞。
//   appRoot：新代码与新团队 config.json 所在目录（staged/备份包的 Contents/Resources/app，dry-run 时为源码根）。
export async function preflightTunnelTargets(ctx, layout, { appRoot, resolveTargets = ctx.resolveTunnelTargets || importBundleTunnelTargets } = {}) {
  const running = await readRunningTunnels(ctx, layout.runtimeDir);
  if (!Object.keys(running).length) return { ok: true, skipped: "no-running-tunnels", problems: [], running, next: [] };
  const configPath = path.join(appRoot, "config.json");
  let result;
  try {
    result = await resolveTargets({ appRoot, configPath, localConfigPath: layout.localConfigPath, dataRoot: layout.dataRoot });
  } catch (err) {
    return { ok: false, error: `无法用新包代码计算隧道目标：${err.message}`, problems: [], running, next: [] };
  }
  const next = Array.isArray(result?.tunnels) ? result.tunnels : [];
  const problems = compareTunnelTargets(running, next);
  return { ok: problems.length === 0, problems, running, next, localConfigError: result?.localConfigError === true };
}

// 预检 + 打印。返回 true = 可以继续。force 时照样检查、只把拒绝降级为警告；planOnly（dry-run）只说明结论。
export async function guardTunnels(ctx, layout, { appRoot, force = false, planOnly = false, label = "新包" } = {}) {
  const { log } = ctx;
  log(`→ 隧道保护预检：用${label}代码 + 当前个人层配置核对换包后的隧道目标`);
  const check = await preflightTunnelTargets(ctx, layout, { appRoot });
  if (check.skipped === "no-running-tunnels") {
    log("· 没有运行中的隧道，无需核对");
    return true;
  }
  if (check.ok) {
    log(`✓ 运行中的隧道在新配置下保持不变（${Object.keys(check.running).join(", ")}）`);
    return true;
  }
  const personal = await readJson(ctx, layout.localConfigPath);
  if (check.error) log(`✗ ${check.error}`);
  for (const p of check.problems) {
    const what = p.kind === "missing" ? "会从隧道目标里消失（supervisor 会停掉它）" : "的隧道签名会变化（会被重建）";
    log(`✗ 运行中的隧道 ${p.id}（${p.before || "签名未知"}）${what}`);
    log(`  修法：${describeFix(p, { personal, localConfigPath: layout.localConfigPath })}`);
  }
  if (check.localConfigError) log(`  注意：个人层 ${layout.localConfigPath} 解析失败，新代码会只按团队层计算——先修好这个文件`);
  if (planOnly) {
    log("! 实际运行时将拒绝热更新（除非加 --force）");
    return false;
  }
  if (force) {
    log("! --force：跳过隧道保护，继续热更新（上面列出的隧道会被停掉或重建）");
    return true;
  }
  log("✗ 已拒绝热更新：现役 .app 与运行中进程均未改动。修好后重跑；确需继续可加 --force");
  return false;
}
