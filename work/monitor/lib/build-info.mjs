// build-info.mjs —— T05 运行、安装与构建版本的区分视图（纯逻辑 + 一次性读盘）。
//
// 设计（docs/reviews/2026-09-05/implementation/01 §8）：
//   - 唯一来源：scripts/build-macos-app.sh 写入 app 根的 build-info.json
//     {version,gitCommit,builtAt}。不另建第二套构建元信息，不在请求里 spawn git。
//   - monitorRunning：启动时读入并冻结；bundleOnDisk：同一 app 根的当前磁盘元信息，
//     读取失败为 unknown。"磁盘比运行包新"只说明进程未重启，不是发现新 release。
//   - supervisorRunning：来自有效运行快照（旧 supervisor / 无快照 → null，不猜）。
//   - compatibility：reasons 可同时多个；state ∈ aligned/restart-monitor/supervisor-older/unknown。
//   - clientBuild 只用于本次响应的比较（reload-ui 建议），不当成可信运行事实。

import { readFile } from "node:fs/promises";
import path from "node:path";

import { computeComponentHashes, diffComponents } from "./component-version.mjs";
import { sanitizeComponentHash } from "./runtime-snapshot.mjs";

const BUILD_INFO_FILENAME = "build-info.json";
const FIELD_MAX_CHARS = 128;
const COMPONENT_NAMES = ["supervisor", "proxy"];

// 组件指纹（热更新）：只收短十六进制串，其它按未知（""）处理——未知在比较时视为需要交接。
export function sanitizeComponents(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const name of COMPONENT_NAMES) out[name] = sanitizeComponentHash(raw[name]);
  return out;
}

// build-info.json 的原始内容（字符串或已解析对象）→ {version, gitCommit, builtAt[, components]}：
// 非字符串字段置空、截断防注入巨串；解析失败 / 非对象 → null。monitor 与 Electron 主进程共用。
export function parseBuildInfo(raw) {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const field of ["version", "gitCommit", "builtAt"]) {
    out[field] = typeof value[field] === "string" ? value[field].slice(0, FIELD_MAX_CHARS) : "";
  }
  const components = sanitizeComponents(value.components);
  if (components) out.components = components;
  return out;
}

async function readBuildInfoFile(appRoot, readFileImpl) {
  try {
    return parseBuildInfo(await readFileImpl(path.join(appRoot, BUILD_INFO_FILENAME), "utf8"));
  } catch {
    return null;
  }
}

// 源代码运行（同事 git clone 后 npm run start）没有 build-info.json：版本取 app 根 package.json 的 version。
// 只取版本号、不取提交号——有了它，「磁盘上的代码比运行中的新」在源码安装上同样判得出来（git pull 之后
// 出「重启界面」横幅，自更新靠它收尾），而开发时每提交一次并不会冒横幅（版本号没变）。读不到 → ""。
export function parseSourceVersion(raw) {
  try {
    const version = JSON.parse(raw)?.version;
    return typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : "";
  } catch {
    return "";
  }
}

async function readSourceVersion(appRoot, readFileImpl) {
  try {
    return parseSourceVersion(await readFileImpl(path.join(appRoot, "package.json"), "utf8"));
  } catch {
    return "";
  }
}

// 启动时调用一次：读 app 根的 build-info.json。读到 → mode=packaged；
// 读不到（源代码运行 / 老构建脚本）→ mode=source，版本取 package.json（也读不到则为空串）。
export async function freezeBuildInfo(appRoot, { readFileImpl = readFile } = {}) {
  const build = await readBuildInfoFile(appRoot, readFileImpl);
  if (build) return { ...build, mode: "packaged" };
  return { version: await readSourceVersion(appRoot, readFileImpl), gitCommit: "", builtAt: "", mode: "source" };
}

// 磁盘元信息每次响应时重读（同一 app 根，文件极小；失败 → unknown，不用运行值顶替）。
// 没有 build-info.json 的源码安装同样回落 package.json 的版本号。
export async function readBundleBuildInfo(appRoot, { readFileImpl = readFile } = {}) {
  const build = await readBuildInfoFile(appRoot, readFileImpl);
  if (build && (build.version || build.gitCommit)) return build;
  const version = build ? "" : await readSourceVersion(appRoot, readFileImpl);
  return { version, gitCommit: "", builtAt: "", ...(build?.components ? { components: build.components } : {}) };
}

// 磁盘新包的数据面组件指纹：打包构建由 build-info.json 的 components 提供；
// 源代码模式（或老构建脚本没写 components）现场计算，按 ttlMs 缓存（/api/build-info 会被轮询）。
export function createBundleComponentsResolver({
  appRoot,
  compute = computeComponentHashes,
  now = Date.now,
  ttlMs = 5000,
} = {}) {
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;
  return async function resolveBundleComponents(bundleBuild) {
    const fromFile = sanitizeComponents(bundleBuild?.components);
    if (fromFile?.supervisor && fromFile.proxy) return { ...fromFile, source: "build-info" };
    if (cached && now() - cachedAt <= ttlMs) return { ...cached, source: "computed" };
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(() => compute(appRoot))
        .then((value) => {
          cached = sanitizeComponents(value) || { supervisor: "", proxy: "" };
          cachedAt = now();
          return cached;
        })
        .catch(() => ({ supervisor: "", proxy: "" }))
        .finally(() => {
          inFlight = null;
        });
    }
    return { ...(await inFlight), source: "computed" };
  };
}

// 数据面（supervisor / 本地代理）运行指纹与磁盘新包的对照（纯函数）。running 来自有效
// 运行快照（supervisor 冻结的自身指纹 + 它从代理 /proxy-health 读回的代理指纹）；
// 快照不可用 → running 全未知 → 两个组件都列入 pending（未知按需要交接处理）。
//
// snapshotAvailable / channelRunning 供前端与 CLI 区分"真的有旧代码在跑"与"通道停了 / 快照
// 暂不可用（两个组件全列 pending 只是因为未知）"——后者不该催用户升级。
// proxyHandoffSupported 同时要求 supervisor 声明能力、且运行中的代理报得出身份（组件指纹）：
// 旧版代理没有身份头，指纹恒为空、交接必被 supervisor 拒绝。
export function computeDataPlaneView({ supervisorSnapshot, bundleComponents, channelRunning } = {}) {
  const snapshotUsable = Boolean(supervisorSnapshot && supervisorSnapshot.stale !== true);
  const runningRaw = snapshotUsable ? sanitizeComponents(supervisorSnapshot.components) : null;
  const running = runningRaw || { supervisor: "", proxy: "" };
  const bundle = sanitizeComponents(bundleComponents) || { supervisor: "", proxy: "" };
  const capabilities = snapshotUsable && supervisorSnapshot.capabilities ? supervisorSnapshot.capabilities : {};
  return {
    running,
    bundle,
    pending: diffComponents(running, bundle),
    handoffSupported: capabilities.handoffExit === true,
    proxyHandoffSupported: capabilities.proxyHandoff === true && Boolean(runningRaw?.proxy),
    snapshotAvailable: snapshotUsable,
    ...(typeof channelRunning === "boolean" ? { channelRunning } : {}),
    proxyPid: snapshotUsable && Number.isInteger(supervisorSnapshot.proxyPid) ? supervisorSnapshot.proxyPid : null,
  };
}

// 兼容性判定（纯函数）。reasons：
//   restart-monitor   磁盘构建与 monitor 运行构建不同（覆盖升级后未重启）
//   supervisor-older  supervisor 构建比 monitor 旧，或运行快照声明的能力协议 < 1
//   versions-unknown  双方均无 commit/version 可比（源代码开发模式属正常）
//   supervisor-unknown 无有效运行快照（旧 supervisor），无法判断其构建
//   reload-ui         客户端自报的已加载版本与磁盘不一致（仅当调用方传入 clientBuild）
export function computeBuildCompatibility({
  monitorBuild,
  bundleBuild,
  supervisorBuild,
  supervisorCapabilities,
  clientBuild,
} = {}) {
  const reasons = [];
  const monitor = monitorBuild || {};
  const bundle = bundleBuild || {};
  const monitorCommit = typeof monitor.gitCommit === "string" ? monitor.gitCommit : "";
  const bundleCommit = typeof bundle.gitCommit === "string" ? bundle.gitCommit : "";
  if (monitorCommit && bundleCommit) {
    if (monitorCommit !== bundleCommit) reasons.push("restart-monitor");
  } else if (monitor.version && bundle.version) {
    if (monitor.version !== bundle.version) reasons.push("restart-monitor");
  } else {
    reasons.push("versions-unknown");
  }
  if (supervisorBuild) {
    const supervisorCommit = typeof supervisorBuild.gitCommit === "string" ? supervisorBuild.gitCommit : "";
    if (monitorCommit && supervisorCommit && supervisorCommit !== monitorCommit) {
      reasons.push("supervisor-older");
    } else if (!supervisorCommit && monitor.version && supervisorBuild.version && supervisorBuild.version !== monitor.version) {
      reasons.push("supervisor-older");
    }
    const protocol = Number(supervisorCapabilities?.controlProtocol);
    if (Number.isFinite(protocol) && protocol < 1) reasons.push("supervisor-older");
  } else {
    reasons.push("supervisor-unknown");
  }
  const client = typeof clientBuild === "string" ? clientBuild.slice(0, FIELD_MAX_CHARS) : "";
  if (client && bundle.version && client !== bundle.version) reasons.push("reload-ui");
  const actionable = ["restart-monitor", "supervisor-older"];
  const state = reasons.length === 0
    ? "aligned"
    : reasons.some((r) => actionable.includes(r))
      ? (reasons.includes("restart-monitor") ? "restart-monitor" : "supervisor-older")
      : "unknown";
  return { state, reasons };
}

// /api/build-info 响应组装（monitor-server 侧注入 startedAt 与快照 getter）。
export function assembleBuildInfoPayload({
  monitorBuild,
  startedAt,
  bundleBuild,
  supervisorSnapshot,
  clientBuild,
  bundleComponents,
  channelRunning,
} = {}) {
  const snapshotUsable = supervisorSnapshot && supervisorSnapshot.stale !== true;
  const supervisorBuild = snapshotUsable && supervisorSnapshot.build ? supervisorSnapshot.build : null;
  const supervisorCapabilities = snapshotUsable ? supervisorSnapshot.capabilities : null;
  const compatibility = computeBuildCompatibility({
    monitorBuild,
    bundleBuild,
    supervisorBuild,
    supervisorCapabilities,
    clientBuild,
  });
  const hasBuild = (build) => Boolean(build && (build.version || build.gitCommit));
  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    monitorRunning: {
      build: monitorBuild ? { version: monitorBuild.version, gitCommit: monitorBuild.gitCommit, builtAt: monitorBuild.builtAt || "" } : null,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      mode: monitorBuild?.mode === "packaged" ? "packaged" : "source",
    },
    bundleOnDisk: hasBuild(bundleBuild)
      ? { version: bundleBuild.version, gitCommit: bundleBuild.gitCommit, builtAt: bundleBuild.builtAt || "" }
      : { version: "", gitCommit: "", builtAt: "", unknown: true },
    supervisorRunning: supervisorBuild
      ? {
          build: { version: supervisorBuild.version || "", gitCommit: supervisorBuild.gitCommit || "" },
          capabilities: supervisorCapabilities || null,
          instanceId: snapshotUsable ? supervisorSnapshot.instanceId : null,
          observedAt: snapshotUsable ? supervisorSnapshot.observedAt : null,
        }
      : null,
    compatibility,
    dataPlane: computeDataPlaneView({ supervisorSnapshot, bundleComponents, channelRunning }),
  };
}
