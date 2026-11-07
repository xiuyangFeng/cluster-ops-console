// scripts/hot-update/orchestrate.mjs —— `npm run app:update` 的参数解析与主流程编排：
// 旁路构建 → 验签/冒烟 → 原子换包 → 控制面热重启 → 按需交接数据面 → 修剪备份；--rollback 走同一条
// 换包 + 热重启路径；--dry-run 只打印计划。所有副作用经 ctx（见 ../hot-update.mjs 的 createRealContext）。
import path from "node:path";
import { parseArgs as parseArgv } from "node:util";
import { diffComponents } from "../../work/monitor/lib/component-version.mjs";
import { getBuildInfoApi } from "./api.mjs";
import { BACKUP_KEEP, listBackups, pruneBackups, swapIn, uniqueDir } from "./bundle.mjs";
import { activateControlPlane, findDesktopMain } from "./control-plane.mjs";
import { LEGACY_DATA_PLANE_MESSAGE, planDataPlane, upgradeDataPlane } from "./data-plane.mjs";
import { APP_NAME, bundleResources, describeBuild, makeStamp, readBuildInfoFile, stagedAppPath, withAppDir } from "./layout.mjs";
import { guardTunnels } from "./tunnel-guard.mjs";

const USAGE = `用法: npm run app:update -- [选项]

  (无选项)            旁路构建 → 冒烟/验签 → 原子换包 → 控制面热重启 → 按需交接 supervisor
  --dry-run           只打印计划，不构建、不换包、不发信号
  --with-proxy        本地代理(8888)代码有变化时也做平滑交接（监听切换 <1s，旧连接继续排干）
  --no-data-plane     跳过数据面（supervisor/proxy）交接，只更新控制面
  --launch            桌面未运行时，换包后用 open 启动新版
  --install-only      只构建/验签/换包，不重启控制面：之后在控制台横幅点「重启界面（隧道不中断）」生效
                      （想挑时机切换时用；没有 45s 时限和自动回退）。跨 Electron 大版本升级不要用：
                      换包后旧进程再拉起的子进程会来自新版本，混版本可能白屏，应立即重启界面
  --rollback [id]     回滚到 dist/backup/ 中的某份备份（缺省最近一份），同样走换包 + 热重启
  --force             跳过换包前的隧道保护预检（预检发现运行中的隧道会消失或被重建时默认拒绝）
  --app <路径>        热更新指定位置的 .app（如 "/Applications/Codex Operations Console.app"）；
                      缺省为仓库目录下的那份。必须与仓库在同一个卷上（原子换包靠 rename）
  -h, --help          显示本帮助`;

const ARG_OPTIONS = {
  "dry-run": { type: "boolean" },
  "with-proxy": { type: "boolean" },
  "no-data-plane": { type: "boolean" },
  launch: { type: "boolean" },
  "install-only": { type: "boolean" },
  rollback: { type: "boolean" },
  force: { type: "boolean" },
  app: { type: "string" },
  help: { type: "boolean", short: "h" },
};

export function parseArgs(argv = []) {
  let parsed;
  try {
    parsed = parseArgv({ args: argv, options: ARG_OPTIONS, allowPositionals: true });
  } catch (err) {
    // strict 模式对未知旗标 / 给布尔旗标带值直接抛错，统一成"未知参数: <旗标>"。
    return { error: `未知参数: ${String(err.message).match(/'([^']+)'/)?.[1] ?? err.message}` };
  }
  const { values, positionals } = parsed;
  // 唯一允许的位置参数是 --rollback 的备份 id。
  if (positionals.length > (values.rollback ? 1 : 0)) return { error: `未知参数: ${positionals.at(-1)}` };
  const opts = {
    dryRun: Boolean(values["dry-run"]),
    withProxy: Boolean(values["with-proxy"]),
    noDataPlane: Boolean(values["no-data-plane"]),
    launch: Boolean(values.launch),
    installOnly: Boolean(values["install-only"]),
    rollback: Boolean(values.rollback),
    rollbackId: positionals[0] ?? "",
    force: Boolean(values.force),
    app: values.app ?? "",
    help: Boolean(values.help),
  };
  if (opts.app && !isAppBundlePath(opts.app)) return { error: `--app 须是绝对路径、以 ${APP_NAME}.app 结尾: ${opts.app}` };
  if (opts.rollbackId && !isSafeBackupId(opts.rollbackId)) return { error: `非法备份 id: ${opts.rollbackId}` };
  if (opts.withProxy && opts.noDataPlane) return { error: "--with-proxy 与 --no-data-plane 互斥" };
  if (opts.installOnly && opts.launch) return { error: "--install-only 与 --launch 互斥" };
  if (opts.installOnly && opts.withProxy) return { error: "--install-only 不重启控制面，也就不交接数据面，与 --with-proxy 互斥" };
  return { opts };
}

function isAppBundlePath(p) {
  return path.isAbsolute(p) && path.basename(p) === `${APP_NAME}.app` && path.normalize(p) === p.replace(/\/+$/, "");
}

function isSafeBackupId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..";
}

async function dryRunPlan(ctx, layout, opts, { mode, target }) {
  const { log } = ctx;
  const live = await readBuildInfoFile(ctx, layout.appDir);
  const desktop = await findDesktopMain(ctx, layout);
  const apiInfo = await getBuildInfoApi(ctx);
  log("[dry-run] 计划（不做任何改动）：");
  log(`  现役包: ${live ? describeBuild(live) : "不存在（将是首次安装）"}  ${layout.appDir}`);
  if (mode === "update") {
    const staged = stagedAppPath(layout, target.id);
    log(`  1. 旁路构建 → ${staged}`);
    const res = await ctx.run("bash", [layout.buildScript, "--output", staged, "--dry-run"]);
    for (const line of String(res.stdout || "").split("\n").filter(Boolean)) log(`       ${line}`);
    log("  2. staged 冒烟：fixture 模式跑 monitor-server（临时端口/临时数据目录），/api/session + /api/status-lite 须 200；codesign --verify");
  } else {
    log(`  1. 回滚目标 → ${target.path}（${describeBuild(target.info)}）`);
  }
  // 隧道保护预检（只读）：update 用源码树（即将构建的代码与 config.json），rollback 用备份包。
  log("  2.5 隧道保护预检（换包前；发现运行中的隧道会消失/被重建则拒绝，--force 跳过）：");
  await guardTunnels({ ...ctx, log: (line) => log(`       ${line}`) }, layout, {
    appRoot: mode === "update" ? layout.rootDir : bundleResources(target.path),
    planOnly: true,
    label: mode === "update" ? "源码树" : "备份包",
  });
  if (live) log(`  3. 原子换包：现役 .app → ${path.join(layout.backupRoot, `${live.version || "unknown"}-<时间戳>`)}，新包 → ${layout.appDir}`);
  else log(`  3. 无现役包：新包直接 rename 到 ${layout.appDir}`);
  if (opts.installOnly) log("  4. --install-only：不发信号；控制台横幅出现「重启界面（隧道不中断）」，点它生效");
  else if (desktop.running) log(`  4. 桌面 pid ${desktop.pid} 在运行 → SIGUSR2 热重启控制面，等待新构建（≤45s，失败自动回退）`);
  else log(`  4. 桌面未运行（${desktop.reason}）→ ${opts.launch ? "open 启动新版" : "不启动（可加 --launch）"}`);
  if (opts.noDataPlane) {
    log("  5. 跳过数据面（--no-data-plane）");
  } else if (apiInfo?.dataPlane?.running && mode === "update") {
    const next = await ctx.computeHashes(layout.rootDir);
    const pending = diffComponents(apiInfo.dataPlane.running, next);
    const plan = planDataPlane({ pending }, { withProxy: opts.withProxy });
    log(`  5. 数据面预测待交接: ${pending.length ? pending.join(", ") : "无"}；将交接: ${plan.components.length ? plan.components.join(", ") : "无"}`);
    for (const s of plan.skipped) log(`     跳过 ${s.name}（${s.reason}）`);
  } else {
    log("  5. 数据面：换包后按 /api/build-info 的 dataPlane.pending 决定（supervisor 默认交接，proxy 需 --with-proxy）");
  }
  log(`  6. 修剪备份保留 ${BACKUP_KEEP} 份，跳过仍有进程执行其二进制的目录`);
  return 0;
}

async function runUpdate(ctx, layout, opts) {
  const { log } = ctx;
  const version = JSON.parse(await ctx.fs.readFile(path.join(layout.rootDir, "package.json"), "utf8")).version;
  const stamp = makeStamp(new Date(ctx.now()));
  const id = `${version}-${stamp}`;
  if (opts.dryRun) return dryRunPlan(ctx, layout, opts, { mode: "update", target: { id } });

  const staged = stagedAppPath(layout, id);
  log(`→ [1/6] 旁路构建 v${version} → ${path.relative(layout.rootDir, staged)}（现役 .app 与运行中进程不受影响）`);
  const build = await ctx.run("bash", [layout.buildScript, "--output", staged], { inherit: true });
  if (build.code !== 0) {
    log(`✗ 构建失败（exit ${build.code}），未触碰现役 .app`);
    return 1;
  }
  const newInfo = await readBuildInfoFile(ctx, staged);
  if (!newInfo) {
    log("✗ staged 包缺少 build-info.json，中止（现役 .app 未改动）");
    return 1;
  }
  log(`✓ 构建完成 ${describeBuild(newInfo)}  指纹 supervisor=${newInfo.components?.supervisor || "?"} proxy=${newInfo.components?.proxy || "?"}`);

  return activateNewBundle(ctx, layout, opts, { incoming: staged, expected: newInfo, parkDir: `${staged}.failed-${stamp}`, stamp, verify: true, stagingDir: path.dirname(staged) });
}

async function runRollback(ctx, layout, opts) {
  const { log } = ctx;
  const backups = await listBackups(ctx, layout);
  if (!backups.length) {
    log(`✗ ${layout.backupRoot} 下没有可回滚的备份`);
    return 1;
  }
  log("可用备份（新→旧）：");
  for (const b of backups) log(`  - ${b.name}`);
  const target = opts.rollbackId ? backups.find((b) => b.name === opts.rollbackId) : backups[0];
  if (!target) {
    log(`✗ 找不到备份 ${opts.rollbackId}`);
    return 1;
  }
  const info = await readBuildInfoFile(ctx, target.path);
  log(`选中 ${target.name}：${describeBuild(info)}`);
  if (!info) {
    log("✗ 该备份缺少 build-info.json，无法确认控制面切换结果，中止");
    return 1;
  }
  const stamp = makeStamp(new Date(ctx.now()));
  if (opts.dryRun) return dryRunPlan(ctx, layout, opts, { mode: "rollback", target: { ...target, info } });
  return activateNewBundle(ctx, layout, opts, { incoming: target.path, expected: info, parkDir: target.path, stamp, verify: false });
}

async function activateNewBundle(ctx, layout, opts, { incoming, expected, parkDir, stamp, verify, stagingDir }) {
  const { log } = ctx;
  if (verify) {
    log("→ [2/6] 验签 staged 包（codesign --verify --deep --strict）");
    const sig = await ctx.run("codesign", ["--verify", "--deep", "--strict", incoming]);
    if (sig.code !== 0) {
      log(`✗ 验签失败，中止（现役 .app 未改动）：${String(sig.stderr || "").trim()}`);
      return 1;
    }
    log("→ 冒烟：staged monitor-server（fixture 模式、临时端口与数据目录）");
    const smoke = await ctx.smoke(incoming);
    if (!smoke.ok) {
      log(`✗ 冒烟失败，中止（现役 .app 未改动）：${smoke.detail || ""}`);
      return 1;
    }
    log("✓ 验签与冒烟通过");
  } else {
    const sig = await ctx.run("codesign", ["--verify", "--deep", "--strict", incoming]);
    if (sig.code !== 0) log("! 备份包验签未通过，继续回滚（若控制面起不来会自动换回）");
  }

  // 隧道保护预检：必须在换包之前——supervisor 按绝对路径重读现役 .app 里的 config.json，
  // 换包一完成旧 supervisor 下一拍就会按新配置收敛（见 tunnel-guard.mjs 顶部说明）。
  const tunnelsOk = await guardTunnels(ctx, layout, { appRoot: bundleResources(incoming), force: opts.force, label: verify ? "新包" : "备份包" });
  if (!tunnelsOk) return 1;

  const desktop = await findDesktopMain(ctx, layout);
  const liveInfo = await readBuildInfoFile(ctx, layout.appDir);
  const backupDir = await uniqueDir(ctx, path.join(layout.backupRoot, `${liveInfo?.version || "unknown"}-${stamp}`));
  log(`→ [3/6] 原子换包：现役 → ${path.relative(layout.rootDir, backupDir)}，新包 → ${APP_NAME}.app`);
  let swap;
  try {
    swap = await swapIn(ctx, layout, { incoming, backupDir });
  } catch (err) {
    log(`✗ 换包失败：${err.message}（现役 .app 已保持/恢复原样）`);
    return 1;
  }
  log(`✓ 换包完成（旧 supervisor/proxy 仍从 ${path.basename(backupDir)} 运行，不受影响）`);

  log("→ [4/6] 控制面");
  let activated;
  if (opts.installOnly) {
    log("· --install-only：不发重启信号（没有 45s 时限，也不会自动回退）");
    activated = { ok: true, activated: false };
  } else {
    activated = await activateControlPlane(ctx, layout, opts, { expected, desktop, swap, parkDir });
  }
  if (!activated.ok) {
    if (activated.launchedOnly) return 1;
    log("✗ 热更新失败，已回退到旧包；隧道未受影响");
    return 1;
  }

  log("→ [5/6] 数据面");
  let dataOk = true;
  let dataWarning = "";
  if (opts.noDataPlane) {
    log("· 跳过数据面交接（--no-data-plane）");
  } else if (!activated.activated) {
    log(opts.installOnly
      ? "· 控制面未重启，跳过数据面交接（重启界面后若有待升级的后台组件，横幅会提示「平滑升级」）"
      : "· 控制面未切到新构建，跳过数据面交接（旧 supervisor/proxy 继续运行）");
  } else {
    const info = (await getBuildInfoApi(ctx)) || activated.info;
    const result = await upgradeDataPlane(ctx, opts, info, expected);
    dataOk = result.ok;
    dataWarning = result.warning || "";
  }

  log(`→ [6/6] 修剪备份（保留 ${BACKUP_KEEP} 份）`);
  await pruneBackups(ctx, layout, { protect: [backupDir] });
  if (stagingDir) {
    try {
      await ctx.fs.rmdir(stagingDir);
    } catch {}
  }

  if (!dataOk) {
    log("! 控制面已更新，但数据面交接未完成；旧数据面进程继续运行。可稍后重试 npm run app:update");
    return 1;
  }
  if (dataWarning === "legacy-supervisor") log(`! 注意：控制面已更新；${LEGACY_DATA_PLANE_MESSAGE}`);
  if (opts.installOnly) {
    log(`✓ 已安装 ${describeBuild(expected)}（尚未生效）：在控制台横幅点「重启界面（隧道不中断）」切换`);
    log(`  回滚用 npm run app:update -- --rollback ${path.basename(backupDir)}`);
    return 0;
  }
  log(`✓ 完成：现役 ${describeBuild(expected)}；回滚用 npm run app:update -- --rollback ${path.basename(backupDir)}`);
  return 0;
}

export async function main(argv, ctx, layout) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    ctx.log(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { opts } = parsed;
  if (opts.help) {
    ctx.log(USAGE);
    return 0;
  }
  if (ctx.platform !== "darwin") {
    ctx.log("热更新只适用于 macOS 桌面 .app。Windows/Linux 走网页模式：git pull 后重启 npm start 即可（隧道由独立 supervisor 保持）。");
    return 2;
  }
  const target = opts.app ? withAppDir(layout, opts.app) : layout;
  return opts.rollback ? runRollback(ctx, target, opts) : runUpdate(ctx, target, opts);
}
