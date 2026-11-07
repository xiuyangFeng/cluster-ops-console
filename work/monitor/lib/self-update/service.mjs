// 自更新（v2.59）：源码安装（同事 git clone 后 npm run start）从 GitHub 取新版本。
//
// 跟远端的哪个分支由「更新通道」定（v2.62，./channel.mjs）：安装目录在 stable 分支上就跟 origin/stable——
// 发布方确认过一个版本、用 npm run release:promote 推进之后才动；在 main 分支上就跟 origin/main——发布方每次
// 推送都会收到。同事这边的工作台定期 git fetch 自己那条通道，远端的版本号比本地高就在界面上提示，
// 点一下才更新（不自动装）。更新 = 快进合并到刚才看到的那个提交，之后复用现成的两段：
//   · 磁盘上的版本号变了 → 「重启界面」（桌面壳 app.relaunch / 网页模式由 launch.mjs 重新拉起），隧道不断；
//   · 重启后守护进程还是旧代码 → 平滑交接（resumeAfterRestart 自动做一次，等价于横幅上那个按钮）。
//
// 只做快进、只认自己那条通道的远端分支、只在这些条件都成立时才给「更新」按钮（否则说明原因，不动任何东西）：
//   当前在 stable 或 main 分支；已入库的文件没有本地改动；本地没有远端没有的提交；package-lock.json 没变
//   （变了要 npm install，可能要下 Electron，交给人在终端做）；远端版本号确实更高；
//   这台电脑的 Node 满足目标版本的 engines.node（不满足的话更新过去启动器会拒绝启动）。
// 合并之前先在临时工作树里把目标版本的监控服务以 fixture 模式起一遍（./smoke.mjs），起不来就不合并。
// 换通道（switchChannel，只有命令行 npm run update -- --channel 一个入口）走的是同一套核对与自检。
//
// 打包的 .app（发布方自己那份，走 npm run app:update）与不是 git 仓库的目录不支持，status 里如实说明。
// 「不是仓库」只在 git 自己这么说时才下结论：目录归属被 git 拒绝（dubious ownership）给出放行命令，
// git 超时之类只算这一次没读出来；定时检查每一轮都重新看安装目录，处理完不用重启就能接上。
// 本模块不碰个人配置、端口与隧道；写盘只有 runtime/self-update.json（上一次更新的记录，回滚与重启后的交接用；
// 回退后还记着被退掉的那个提交，远端停在它上面期间不再提示装它）。
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { parseSourceVersion } from "../build-info.mjs";
import { compareVersions } from "../cli/catalog.mjs";
import { isNodeVersionSupported, nodeRangeText, parseNodeEngineRange, parseNodeVersion } from "../platform.mjs";
import { statusError } from "../status-error.mjs";
import { CHANNEL_AWARE_FILE, channelOfBranch, channelText, getChannel, remoteRefOf, STABLE_BRANCH, switchCommand, UPDATE_BRANCH, UPDATE_CHANNELS, UPDATE_REMOTE } from "./channel.mjs";
import { classifyFetchFailure, createGit, describeGitFailure, isGitSha, isMissingRemoteRef, redactUrlCredentials, sanitizeRemoteUrl } from "./git.mjs";
import { isNewerVersion } from "./release-check.mjs";
import { LAUNCHER_NODE_ENV, RESPAWN_ENV } from "./restart-code.mjs";
import { smokeSourceTree } from "./smoke.mjs";

export { UPDATE_BRANCH, UPDATE_REMOTE };
export const CHECK_INTERVAL_MS = 30 * 60_000;
export const FIRST_CHECK_DELAY_MS = 90_000;
// 两次自动检查之间至少隔这么久（界面每分钟读一次状态，不能每次都 fetch）。
export const MIN_CHECK_GAP_MS = 60_000;
export const FETCH_TIMEOUT_MS = 60_000;
export const MARKER_FILE = "self-update.json";
// 更新后多久之内的重启算「这次更新的重启」（之后不再自动交接守护进程，留给横幅）。
export const RESUME_WINDOW_MS = 15 * 60_000;
const RESUME_POLL_MS = 3000;
const RESUME_WAIT_MS = 90_000;
// 问远端「有没有稳定版分支」的那一次 ls-remote：刚 fetch 成功才问，所以给得短；问不到不算检查失败。
const STABLE_PROBE_TIMEOUT_MS = 20_000;
// ls-remote 的一行："<提交号>\trefs/heads/stable"。
const STABLE_HEAD_ROW = new RegExp(`^[0-9a-f]{40,64}\\s+refs/heads/${STABLE_BRANCH}$`);

// npm install 会自己改写锁文件（npm 11 会删掉可选依赖的 libc 字段），而安装说明第一步就是 npm install：
// 锁文件「有改动」不是人改的，不拦一键更新——合并 / 回退前先把它还原成入库的样子。每次发版锁文件里的
// 版本号都会变，不还原的话手动 git pull 也会被这份改动挡住，所以手动命令同样先还原。
const LOCK_FILE = "package-lock.json";
const MANUAL_UPDATE_COMMAND = `git checkout -- ${LOCK_FILE} && git pull --ff-only && npm install`;
// 换通道时两边依赖不一样的手动做法：本地没有那条分支时 git checkout 会照远端的建一条并跟上它。
const manualSwitchCommand = (branch) => `git checkout -- ${LOCK_FILE} && git checkout ${branch} && git pull --ff-only && npm install`;
// 回退后那一版被跳过（见 planUpdate 的 skipTarget）；这是不等发布方、照样装它的出口。只在命令行，界面上不给。
const FORCE_UPDATE_COMMAND = "npm run update -- --force";
const CHANNEL_BRANCHES_TEXT = UPDATE_CHANNELS.map((channel) => channel.branch).join(" / ");

// 这份安装在 stable 分支上，远端却没有这条分支（发布方还没建，或撤掉了）：不是连不上，是这条通道现在没有来源。
const missingStableError = () => ({
  code: "no-channel-branch",
  message: `远端没有 ${STABLE_BRANCH} 分支（发布方还没有发布过稳定版，或撤掉了它），这份安装现在收不到更新。要改跟开发版，在终端进安装目录执行 ${switchCommand(UPDATE_BRANCH)}`,
});

const NO_REMOTE_TEXT = `这个仓库没有名为 ${UPDATE_REMOTE} 的远端，不知道从哪里取更新`;
const UNSUPPORTED_TEXT = Object.freeze({
  packaged: "这是安装包版本，不在原地自动更新：有新版本时到发布页下载新的安装包覆盖安装，配置与数据保留（发布方本机用 npm run app:update 升级）",
  plain: "这个目录不是 git 仓库，没法自动更新：重新 git clone 一份，或让发布方重新发一份",
  "no-git": "这台电脑上找不到 git 命令，没法自动更新",
});

// 安装形态 → 「为什么不能自动更新」的一句话。目录归属那一种要带上这个目录的那条命令，所以不是固定文字。
function unsupportedText(install) {
  if (install.kind === "unsafe-owner") {
    return `git 不信任这个目录（它的所有者不是当前用户，常见于用管理员身份 clone、或放在 exFAT / 网络盘上），读不了版本信息。在终端执行一次 ${install.command} 之后再检查更新`;
  }
  return UNSUPPORTED_TEXT[install.kind] || UNSUPPORTED_TEXT.plain;
}

// 这一次没读出安装目录的 git 状态（inspectInstall 的 kind: "unknown"）时的说法；next 是接下来会怎样。
const inspectFailedText = (install, next) => `读不到这个目录的 git 状态（${install.detail}），${next}`;

// 安装包版本发现新版本时的说明（没有一键更新按钮，只有「去下载」）。
export const PACKAGED_UPDATE_TEXT = "这是安装包版本：下载新的安装包覆盖安装即可，个人配置与运行数据不在安装目录里，不受影响。";

const lines = (text) => String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
const sameDir = async (a, b) => {
  try {
    return (await fsp.realpath(a)) === (await fsp.realpath(b));
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

// 安装形态（只读，不联网）→ { kind, branch, head, version, dirty, lockDirty, remote }。
// dirty 不含锁文件；锁文件被改写单记在 lockDirty。kind：
//   "git"           可以自更新的安装目录
//   "packaged" / "plain" / "no-git"   打包的 App / 不是 git 仓库 / 找不到 git 命令
//   "unsafe-owner"  是仓库，但 git 因为目录归属拒绝读它（"dubious ownership"）；另带 command：放行这个目录的那条命令
//   "unknown"       这一次没读出来（git 超时或别的失败）；另带 detail。不是结论，调用方当作一次错误、下回再查
export async function inspectInstall({ rootDir, git, packaged = false, readFile = fsp.readFile } = {}) {
  let version = "";
  try {
    version = parseSourceVersion(await readFile(path.join(rootDir, "package.json"), "utf8"));
  } catch {}
  const base = { kind: "plain", branch: null, head: null, version, dirty: [], lockDirty: false, remote: null };
  if (packaged) return { ...base, kind: "packaged" };
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    // Windows 上用管理员身份 clone、或目录在 exFAT / 网络盘上时 git 会这样拒绝。放行要用 git 报出来的那个路径
    //（它自己规范过的写法，Windows 上是正斜杠）；加双引号是为了带空格的路径在 cmd / PowerShell / sh 里都能直接粘贴。
    const owner = top.stderr.match(/dubious ownership in repository at '(.+)'/i);
    if (owner) return { ...base, kind: "unsafe-owner", command: `git config --global --add safe.directory "${owner[1]}"` };
    // 只有 git 自己说「不是仓库」才下这个结论：它意味着「重新 clone 一份」，说错了代价很大。
    if (/not a git repository/i.test(top.stderr)) return base;
    if (/ENOENT|not found|not recognized/i.test(top.stderr)) return { ...base, kind: "no-git" };
    return { ...base, kind: "unknown", detail: top.timedOut ? "git 没有在限定时间内返回" : describeGitFailure(top.stderr, `git 退出码 ${top.code ?? "未知"}`) };
  }
  // 安装目录本身必须是仓库的根：解压在别人仓库里的一份拷贝不能拿外层仓库来「更新」。
  if (!(await sameDir(lines(top.stdout)[0] || "", rootDir))) return base;
  const [branch, head, status, remote] = await Promise.all([
    git(["symbolic-ref", "--short", "-q", "HEAD"]),
    git(["rev-parse", "HEAD"]),
    git(["status", "--porcelain", "--untracked-files=no"]),
    git(["remote", "get-url", UPDATE_REMOTE]),
  ]);
  const sha = lines(head.stdout)[0] || "";
  // status --porcelain 每行 "XY 路径"（X / Y 可能是空格，所以不能先 trim）；读不出来按「有改动」处理
  // （宁可不给更新按钮）。
  const changed = status.ok
    ? status.stdout.split("\n").filter((l) => l.length > 3).map((l) => l.slice(3).trim())
    : ["（读不到工作区状态）"];
  return {
    kind: "git",
    branch: branch.ok ? lines(branch.stdout)[0] || null : null,
    head: isGitSha(sha) ? sha : null,
    version,
    dirty: changed.filter((file) => file !== LOCK_FILE).slice(0, 50),
    lockDirty: changed.includes(LOCK_FILE),
    remote: remote.ok ? sanitizeRemoteUrl(remote.stdout) : null,
  };
}

// 纯函数：两份 package-lock.json 比下来要不要重新 npm install。发版时锁文件里根包的版本号总会跟着
// package.json 一起变（docs/release.md 第 1 步），那两处不算；其余任何差异（依赖、engines）都算。
// 读不出来 / 不是合法 JSON → 按要装处理（宁可让人在终端里更新一次）。
export function lockNeedsInstall(oldText, newText) {
  const normalize = (text) => {
    const lock = JSON.parse(text);
    if (!lock || typeof lock !== "object") throw new Error("not an object");
    const { version: _v, ...rest } = lock;
    const packages = rest.packages && typeof rest.packages === "object" ? { ...rest.packages } : rest.packages;
    if (packages?.[""] && typeof packages[""] === "object") {
      const { version: _rv, ...root } = packages[""];
      packages[""] = root;
    }
    return JSON.stringify({ ...rest, packages });
  };
  try {
    return normalize(oldText) !== normalize(newText);
  } catch {
    return true;
  }
}

// 目标版本的 package.json 原文 → engines.node 那一段（字符串）；没写 / 读不懂 → null。
function readEnginesNode(raw) {
  try {
    const range = JSON.parse(raw)?.engines?.node;
    return typeof range === "string" ? range : null;
  } catch {
    return null;
  }
}

// 纯函数：本地与远端的对照 → 给不给更新、为什么不给。
// requiredNode：目标版本 package.json 的 engines.node 原文；nodeVersion：现在跑着的 Node。目标版本的启动器
// （scripts/launch.mjs）会按它自己的范围拒绝启动，所以这里先对一遍——范围读不懂或没写就不拦。
// skipTarget：回退时记下的那个提交（更新记录里的 skipTarget）。远端还停在它上面就不给更新——否则刚回退完又被
// 提示装同一版，赶上「装完起不来」的版本就是个圈；远端换成任何别的提交后照常。排在最前面：界面只显示第一条原因。
// 所在的分支得是一条更新通道（stable / main，target 就是那条通道的远端分支）；别的分支不自动更新。
// stableAvailable：远端有没有稳定版分支——只影响 branch 那条原因的写法（没有时与只认 main 的时候一字不差）。
// → { available, canApply, blockers: [{ code, message, files?, command? }] }
export function planUpdate({ install, target, behind, ahead, remoteVersion, lockChanged, requiredNode = null, nodeVersion = null, skipTarget = null, stableAvailable = false } = {}) {
  const newer = (compareVersions(remoteVersion, install?.version) ?? 0) > 0;
  const available = Boolean(target) && behind > 0 && newer;
  const blockers = [];
  if (available) {
    const nodeRange = parseNodeEngineRange(requiredNode);
    const nodeUnfit = Boolean(nodeRange && parseNodeVersion(nodeVersion) && !isNodeVersionSupported(nodeVersion, nodeRange));
    if (skipTarget && skipTarget === target) {
      // 稳定版不是「推一次就变」：等的是发布方下一次推进。
      const until = install.branch === STABLE_BRANCH ? "发布方发布新的稳定版后" : "发布方推送新的提交后";
      blockers.push({ code: "skipped", message: `已回退到 v${install.version}，v${remoteVersion} 这一版先跳过：${until}会再提示更新。仍然想装这一版的话，在终端进安装目录执行 ${FORCE_UPDATE_COMMAND}`, command: FORCE_UPDATE_COMMAND });
    }
    if (!channelOfBranch(install.branch)) {
      const where = install.branch || "游离的提交";
      blockers.push({
        code: "branch",
        message: stableAvailable
          ? `当前不在 ${STABLE_BRANCH} 或 ${UPDATE_BRANCH} 分支（在 ${where} 上），不自动更新。切回其中一个后再试`
          : `当前不在 ${UPDATE_BRANCH} 分支（在 ${where} 上），不自动更新。切回 ${UPDATE_BRANCH} 后再试`,
      });
    }
    if (install.dirty.length) {
      blockers.push({ code: "dirty", message: `这个目录里有改过但没提交的文件（${install.dirty.slice(0, 3).join("、")}${install.dirty.length > 3 ? " 等" : ""}），不自动更新，免得把改动冲掉`, files: install.dirty.slice(0, 10) });
    }
    if (ahead > 0) {
      blockers.push({ code: "diverged", message: `本地有 ${ahead} 个远端没有的提交，没法直接快进，不自动更新` });
    }
    if (nodeUnfit) {
      blockers.push({ code: "node-version", message: `v${remoteVersion} 需要 Node.js ${nodeRangeText(nodeRange)}，这台电脑上是 ${String(nodeVersion).replace(/^v/i, "")}：更新过去会启动不了，所以不更新，现在的版本照常可用。先把 Node.js 换成这个范围内的版本（https://nodejs.org），重新打开工作台后再更新` });
    }
    // Node 不合适时不给「在终端里更新」那条命令：照着做会把代码换成起不来的版本（npm install 也会因 engine-strict
    // 失败），而且那条路没有更新记录、npm run update -- --rollback 退不回来。Node 换好之后再查，该提示照常提示。
    if (lockChanged && !nodeUnfit) {
      blockers.push({ code: "needs-install", message: `这个版本改了依赖，需要在终端里更新：进入安装目录执行 ${MANUAL_UPDATE_COMMAND}，再重启工作台`, command: MANUAL_UPDATE_COMMAND });
    }
  }
  return { available, canApply: available && blockers.length === 0, blockers };
}

export function createSelfUpdateService({
  rootDir,
  runtimeDir,
  packaged = false,
  getUpstream = async () => null,
  // 打包安装时查新版本：async () => { version, url } | null（见 ./release-check.mjs）；不给就不查。
  releaseLookup = null,
  git = createGit({ root: rootDir }),
  smoke = smokeSourceTree,
  env = process.env,
  // 本进程的 Node：拿它对目标版本的 engines.node（见 planUpdate）；env 里有启动器报的版本时用那个（见下）。
  nodeVersion = process.versions.node,
  log = () => {},
  now = Date.now,
  timers = globalThis,
  mkdtemp = (prefix) => fsp.mkdtemp(prefix),
  rm = (target) => fsp.rm(target, { recursive: true, force: true, maxRetries: 3 }),
} = {}) {
  const markerPath = runtimeDir ? path.join(runtimeDir, MARKER_FILE) : null;
  let state = null; // 最近一次检查的结论
  let checking = null; // 在途的检查（并发的调用共享）
  let applying = false;
  // 远端有没有稳定版分支：最近一次问到的结论（true / false）；还没问到过是 null（见 stableAvailableNow）。
  let stableOnRemote = null;
  let firstTimer = null;
  let intervalTimer = null;

  const respawn = env?.[RESPAWN_ENV] === "1";
  // 预检目标版本的 Node 要求时对哪个 Node：启动器报上来的那个优先（桌面模式下本进程跑在 Electron 自带的
  // Node 上，而拒绝启动的那道闸看的是启动器的 Node，见 restart-code.mjs）；没报（命令行、手工起的）就是本进程的。
  const launcherNode = parseNodeVersion(env?.[LAUNCHER_NODE_ENV]) ? env[LAUNCHER_NODE_ENV] : nodeVersion;

  async function upstream() {
    try {
      return (await getUpstream()) || null;
    } catch {
      return null;
    }
  }

  async function readMarker() {
    if (!markerPath) return null;
    try {
      const value = JSON.parse(await fsp.readFile(markerPath, "utf8"));
      return value && typeof value === "object" && isGitSha(value.from) && isGitSha(value.to) ? value : null;
    } catch {
      return null;
    }
  }

  async function writeMarker(value) {
    if (!markerPath) return;
    await fsp.mkdir(path.dirname(markerPath), { recursive: true });
    await writeFileAtomic(markerPath, `${JSON.stringify(value, null, 2)}\n`);
  }

  function publicState(extra = {}) {
    const s = state || {};
    return {
      supported: s.supported ?? null,
      kind: s.kind ?? null,
      unsupportedReason: s.unsupportedReason ?? null,
      branch: s.branch ?? null,
      // 更新通道（./channel.mjs）："stable" / "main"；不在任何通道的分支上、或不是 git 安装 → null。
      channel: s.channel ?? null,
      // 远端有稳定版分支（界面据此在开发版上补一句怎么切过去）。
      stableAvailable: s.stableAvailable === true,
      remote: s.remote ?? null,
      localVersion: s.localVersion ?? null,
      remoteVersion: s.remoteVersion ?? null,
      behind: s.behind ?? 0,
      available: s.available === true,
      // 安装包版本的新版本发布页（只在有新版本时给）：界面给「去下载」而不是「更新」。
      releaseUrl: s.releaseUrl ?? null,
      canApply: s.canApply === true && !applying,
      blockers: s.blockers ?? [],
      checkedAt: s.checkedAt ?? null,
      error: s.error ?? null,
      checking: Boolean(checking),
      applying,
      // 网页模式下有没有人会把监控服务重新拉起来（launch.mjs 起的才有）；桌面壳用它自己的「重启界面」。
      respawn,
      ...extra,
    };
  }

  // 远端有没有稳定版分支：问到过就用问到的；还没问到过（没联网检查过）就看本地有没有这条远端引用
  //（clone 会把远端的分支都记下来）。
  async function stableAvailableNow() {
    if (stableOnRemote != null) return stableOnRemote;
    return (await git(["rev-parse", "--verify", "-q", remoteRefOf(STABLE_BRANCH)])).ok;
  }

  // background：定时的那一轮。每轮都重新看一遍安装目录，但不在通道以外的分支上联网。
  // ignoreSkip：不理会回退时记下的「跳过这一版」（命令行 --force）。
  async function runCheck({ fetch = true, background = false, ignoreSkip = false } = {}) {
    const install = await inspectInstall({ rootDir, git, packaged });
    const channel = channelOfBranch(install.branch);
    const base = { kind: install.kind, branch: install.branch, channel: channel?.id ?? null, remote: install.remote, localVersion: install.version || null };
    if (install.kind === "unknown") {
      // 这一次没读出来：不下「不支持」的结论。之前的结论留着（没有就是「还不知道」），只带上这次的错误。
      state = { ...(state || { ...base, supported: null }), checkedAt: now(), error: { code: "inspect-failed", message: inspectFailedText(install, "稍后会自动再查") } };
      return state;
    }
    if (install.kind !== "git") {
      const unsupported = { ...base, supported: false, unsupportedReason: unsupportedText(install), checkedAt: now(), error: null };
      if (install.kind === "packaged" && typeof releaseLookup === "function") {
        // 没联网的那次（界面第一次取现状）不问 GitHub，也不冲掉上一次问到的结论。
        if (!fetch) {
          state = state?.kind === "packaged" ? state : { ...unsupported, checkedAt: null };
          return state;
        }
        try {
          const latest = await releaseLookup();
          const newer = Boolean(latest && isNewerVersion(latest.version, install.version));
          state = {
            ...unsupported,
            available: newer,
            remoteVersion: latest?.version ?? null,
            releaseUrl: newer ? latest.url : null,
            canApply: false,
            blockers: newer ? [{ code: "packaged", message: PACKAGED_UPDATE_TEXT }] : [],
          };
        } catch (err) {
          const previous = state?.kind === "packaged" ? state : unsupported;
          state = { ...previous, checkedAt: now(), error: { code: "release-check-failed", message: `没能查到新版本（${redactUrlCredentials(err?.message || err).slice(0, 160)}），稍后会自动再查` } };
        }
        return state;
      }
      state = unsupported;
      return state;
    }
    if (!install.remote) {
      state = { ...base, supported: false, unsupportedReason: NO_REMOTE_TEXT, checkedAt: now(), error: null };
      return state;
    }
    // 跟远端的哪个分支：在通道上就是同名的那条；不在任何通道上时仍拿 main 对照（那时不给更新按钮，只为说明）。
    const tracked = channel?.branch ?? UPDATE_BRANCH;
    const remoteRef = remoteRefOf(tracked);
    let error = null;
    // 不在通道上时反正不给更新按钮：定时的那一轮不为它联网（手动点「检查更新」照常 fetch）。
    const online = fetch && !(background && !channel);
    if (online) {
      const proxy = await upstream();
      const res = await git(["fetch", "--quiet", "--no-tags", UPDATE_REMOTE, `+refs/heads/${tracked}:${remoteRef}`], { timeoutMs: FETCH_TIMEOUT_MS, proxy });
      const missing = !res.ok && isMissingRemoteRef(res);
      // main 取不到一律照旧归因；只有稳定版把「远端没有这条分支」单独说清（它可以不存在）。
      if (!res.ok) error = missing && tracked === STABLE_BRANCH ? missingStableError() : classifyFetchFailure(res);
      if (tracked === STABLE_BRANCH) {
        // 跟的就是稳定版：这次 fetch 的结果就是答案。
        if (res.ok) stableOnRemote = true;
        else if (missing) stableOnRemote = false;
      } else if (res.ok) {
        // 另问一次远端有没有稳定版分支：只读的 ls-remote，没有时也是成功、只是没有输出。结论只用在
        // 界面上「怎么切到稳定版」那一句与 branch 那条原因的写法上；这次没问到不算检查失败，沿用上一次的。
        // 写全引用名、不带 --heads（新版 git 里它已改名 --branches）；输出再按整行核对一遍。
        const probe = await git(["ls-remote", UPDATE_REMOTE, `refs/heads/${STABLE_BRANCH}`], { timeoutMs: STABLE_PROBE_TIMEOUT_MS, proxy });
        if (probe.ok) stableOnRemote = lines(probe.stdout).some((row) => STABLE_HEAD_ROW.test(row));
      }
    }
    // 定时那一轮没联网的话不算「检查过」：界面上的检查时间仍是上一次真正 fetch 的时间。
    const checkedAt = background && !online ? state?.checkedAt ?? null : now();
    const idle = { ...base, supported: true, available: false, canApply: false, blockers: [], behind: 0, remoteVersion: null, target: null, head: install.head, checkedAt };
    // 远端说没有这条分支：本地留着的旧引用不再算数（不拿一条已经不存在的分支当「有更新」）。
    if (error?.code === "no-channel-branch") {
      state = { ...idle, stableAvailable: false, error };
      return state;
    }
    const stableAvailable = await stableAvailableNow();
    // 取不到新的也照样用本地已有的远端引用给结论（上次 fetch 到的），只是带上这次的错误。
    const rev = await git(["rev-parse", "--verify", "-q", remoteRef]);
    const target = lines(rev.stdout)[0] || "";
    if (!rev.ok || !isGitSha(target) || !install.head) {
      state = { ...idle, stableAvailable, error };
      return state;
    }
    const [behindRes, aheadRes, pkg, lockDiff] = await Promise.all([
      git(["rev-list", "--count", `${install.head}..${target}`]),
      git(["rev-list", "--count", `${target}..${install.head}`]),
      git(["show", `${target}:package.json`]),
      git(["diff", "--quiet", install.head, target, "--", "package-lock.json"]),
    ]);
    const behind = Number(lines(behindRes.stdout)[0]) || 0;
    const ahead = Number(lines(aheadRes.stdout)[0]) || 0;
    const remoteVersion = pkg.ok ? parseSourceVersion(pkg.stdout) || null : null;
    // diff --quiet：0 = 一字未改；否则取出两份内容细看（只是版本号跟着变不算要重装）。
    let lockChanged = false;
    if (lockDiff.code !== 0) {
      const [oldLock, newLock] = await Promise.all([git(["show", `${install.head}:package-lock.json`]), git(["show", `${target}:package-lock.json`])]);
      lockChanged = !(oldLock.ok && newLock.ok) || lockNeedsInstall(oldLock.stdout, newLock.stdout);
    }
    const skipTarget = ignoreSkip ? null : (await readMarker())?.skipTarget;
    const plan = planUpdate({ install, target, behind, ahead, remoteVersion, lockChanged, requiredNode: pkg.ok ? readEnginesNode(pkg.stdout) : null, nodeVersion: launcherNode, skipTarget: isGitSha(skipTarget) ? skipTarget : null, stableAvailable });
    state = { ...base, supported: true, ...plan, behind, ahead, remoteVersion, target, head: install.head, stableAvailable, checkedAt, error };
    return state;
  }

  // 检查更新。force：手动点的「检查更新」与应用前的复查，忽略最小间隔。background / ignoreSkip 见 runCheck。
  // 永不 reject。
  async function check({ force = false, background = false, ignoreSkip = false } = {}) {
    if (checking) return checking.then(() => publicState());
    if (!force && state?.checkedAt && now() - state.checkedAt < MIN_CHECK_GAP_MS) return publicState();
    checking = runCheck({ background, ignoreSkip }).catch((err) => {
      state = { ...(state || {}), checkedAt: now(), error: { code: "internal", message: `检查更新出错：${redactUrlCredentials(err?.message || err).slice(0, 200)}` } };
      return state;
    }).finally(() => {
      checking = null;
    });
    await checking;
    if (state?.available) log(`self-update: v${state.remoteVersion} available (local v${state.localVersion}, ${state.behind} commit(s) behind${state.canApply ? "" : `; blocked: ${state.blockers.map((b) => b.code).join(",")}`})`);
    return publicState();
  }

  // 不联网的现状（界面轮询用）；还没检查过就先做一次只读的本地检查。
  async function status() {
    if (!state && !checking) {
      checking = runCheck({ fetch: false }).catch(() => state).finally(() => {
        checking = null;
      });
      await checking;
      if (state) state.checkedAt = null; // 没联网的那次不算「检查过」
    }
    return publicState({ lastUpdate: await readMarker() });
  }

  // 被 npm 改写过的锁文件还原成入库的样子（见 LOCK_FILE）；没改过就什么都不做。
  async function restoreLockFile(install) {
    if (!install.lockDirty) return;
    const res = await git(["checkout", "--", LOCK_FILE]);
    if (!res.ok) throw statusError(`${LOCK_FILE} 被改动过、又没能还原，没有继续；在终端进这个目录执行 git checkout -- ${LOCK_FILE} 后再试`, 409, { code: "dirty" });
    log(`self-update: restored ${LOCK_FILE} (rewritten locally by npm) before changing commits`);
  }

  // 清掉自检用的临时工作树（应用与换通道共用）。tree 为空说明还没走到 git worktree add，只删临时目录。
  async function removeSmokeTree(tmp, tree) {
    if (tree) {
      await git(["worktree", "remove", "--force", tree], { timeoutMs: 30_000 }).catch(() => {});
      await rm(tmp).catch(() => {});
      await git(["worktree", "prune"]).catch(() => {});
    } else if (tmp) {
      await rm(tmp).catch(() => {});
    }
  }

  // 应用更新：复查 → 自检目标版本 → 快进合并 → 记下这次更新。成功后由调用方重启界面。
  // ignoreSkip：回退后被跳过的那一版也照装（命令行 --force；界面的接口不传）。装成之后写的是一份新的更新记录，
  // 「跳过」随之作废；没装成（自检没过等）则原样留着。
  async function apply({ ignoreSkip = false } = {}) {
    if (applying) throw statusError("更新正在进行，请稍候", 409, { code: "busy" });
    applying = true;
    let tmp = null;
    let tree = null;
    try {
      await check({ force: true, ignoreSkip });
      const s = state || {};
      // 刚才那次复查没读出安装目录的状态：手里的结论是更早的，不能照着它动手。
      if (s.error?.code === "inspect-failed") throw statusError(s.error.message, 409, { code: "inspect-failed" });
      if (s.supported === false) throw statusError(s.unsupportedReason || "当前安装方式不支持自动更新", 409, { code: "unsupported" });
      if (s.error && !s.available) throw statusError(s.error.message, 502, { code: s.error.code });
      if (!s.available) throw statusError("已经是最新版本", 409, { code: "up-to-date" });
      if (!s.canApply) throw statusError(s.blockers[0]?.message || "现在不能自动更新", 409, { code: s.blockers[0]?.code || "blocked" });
      // branch：刚才复查时所在的那条通道的分支（能走到这里说明它是 stable 或 main）。
      const { target, head, localVersion, remoteVersion, branch } = s;
      if (!isGitSha(target) || !isGitSha(head)) throw statusError("读不到要更新到的提交", 500, { code: "internal" });

      log(`self-update: applying v${localVersion} -> v${remoteVersion} (${head.slice(0, 7)} -> ${target.slice(0, 7)}); smoke-testing the target first`);
      tmp = await mkdtemp(path.join(os.tmpdir(), "cwb-update-"));
      tree = path.join(tmp, "tree");
      const added = await git(["worktree", "add", "--detach", "--quiet", tree, target], { timeoutMs: 120_000 });
      if (!added.ok) throw statusError(`没能取出新版本做自检：${describeGitFailure(added.stderr, "git worktree 失败")}`, 500, { code: "internal" });
      const smoked = await smoke(tree);
      if (!smoked?.ok) {
        log(`self-update: smoke test of ${target.slice(0, 7)} failed: ${smoked?.detail || "unknown"}`, { level: "warn" });
        throw statusError(`新版本 v${remoteVersion} 自检没有通过，没有更新，现在的版本照常可用。请把这句话转给发布的人：${String(smoked?.detail || "监控服务没有起来").slice(0, 400)}`, 422, { code: "smoke-failed" });
      }

      // 自检花了十几秒：动手前再确认工作区还是刚才检查时的样子。
      const again = await inspectInstall({ rootDir, git, packaged });
      if (again.head !== head || again.branch !== branch || again.dirty.length) {
        throw statusError("自检期间这个目录被改动了，没有更新；请再点一次", 409, { code: "changed" });
      }
      await restoreLockFile(again);
      const merged = await git(["merge", "--ff-only", "--quiet", target], { timeoutMs: 120_000 });
      if (!merged.ok) throw statusError(`快进合并没有成功，没有更新：${describeGitFailure(merged.stderr, "git merge 失败")}`, 409, { code: "merge-failed" });

      const marker = { from: head, to: target, fromVersion: localVersion, toVersion: remoteVersion, appliedAt: now(), handoff: "pending" };
      try {
        await writeMarker(marker);
      } catch (err) {
        log(`self-update: could not write ${MARKER_FILE}: ${err?.message || err}`, { level: "warn" });
      }
      log(`self-update: merged ${target.slice(0, 7)} (v${remoteVersion}); control plane restart required`);
      state = { ...s, available: false, canApply: false, blockers: [], behind: 0, head: target, localVersion: remoteVersion, checkedAt: now(), error: null };
      return { ok: true, fromVersion: localVersion, toVersion: remoteVersion, respawn };
    } finally {
      await removeSmokeTree(tmp, tree);
      applying = false;
    }
  }

  // 换更新通道（命令行 npm run update -- --channel stable|main 用；界面只显示、不切换）。
  // 只在两条通道之间换：当前得在其中一条的分支上，工作区干净（锁文件被 npm 改写不算，动手前还原）。
  // 顺序：取远端那条分支 → 核对（本地同名分支只能快进到它、那个版本认识更新通道、这台电脑的 Node 满足它、依赖没变）→
  // 自检那个版本 → 一条 git checkout -B 切过去（切不成时 git 自己什么都不动）。哪一步没过都不动工作区。
  // 不比版本号高低：从开发版换到稳定版通常就是回到较旧的那一版。不写更新记录——想回去再换一次即可，
  // --rollback 管的仍然是上一次「更新」。
  // → { ok, changed, channel, branch, fromBranch, fromVersion, toVersion, codeChanged, respawn }
  //   changed：这次真的换了分支（已经在那条通道上时为 false）；codeChanged：磁盘上的代码变了（两条通道
  //   正好在同一个提交上时为 false，不用重启）。
  async function switchChannel(id) {
    const channel = getChannel(id);
    if (!channel) throw statusError(`没有这个更新通道，可选：${CHANNEL_BRANCHES_TEXT}`, 400, { code: "bad-channel" });
    if (applying) throw statusError("更新正在进行，请稍候", 409, { code: "busy" });
    applying = true;
    let tmp = null;
    let tree = null;
    try {
      const install = await inspectInstall({ rootDir, git, packaged });
      if (install.kind === "unknown") throw statusError(inspectFailedText(install, "没有切换；请再试一次"), 409, { code: "inspect-failed" });
      if (install.kind !== "git") throw statusError(unsupportedText(install), 409, { code: "unsupported" });
      if (!install.remote) throw statusError(NO_REMOTE_TEXT, 409, { code: "unsupported" });
      const current = channelOfBranch(install.branch);
      const result = { ok: true, changed: false, channel: channel.id, branch: channel.branch, fromBranch: install.branch, fromVersion: install.version || null, toVersion: install.version || null, codeChanged: false, respawn };
      if (current?.id === channel.id) return result;
      // 不在任何一条通道上：那是人自己切过去的分支，本工具不替人离开它。
      if (!current || !install.head) {
        throw statusError(`当前在 ${install.branch || "游离的提交"} 上，不在 ${CHANNEL_BRANCHES_TEXT} 任何一条更新通道里，没有切换。先自己用 git 切回其中一个分支`, 409, { code: "branch" });
      }
      if (install.dirty.length) {
        throw statusError(`这个目录里有改过但没提交的文件（${install.dirty.slice(0, 3).join("、")}${install.dirty.length > 3 ? " 等" : ""}），没有切换，免得把改动冲掉`, 409, { code: "dirty", files: install.dirty.slice(0, 10) });
      }

      const remoteRef = remoteRefOf(channel.branch);
      const fetched = await git(["fetch", "--quiet", "--no-tags", UPDATE_REMOTE, `+refs/heads/${channel.branch}:${remoteRef}`], { timeoutMs: FETCH_TIMEOUT_MS, proxy: await upstream() });
      if (!fetched.ok) {
        if (isMissingRemoteRef(fetched)) {
          if (channel.branch === STABLE_BRANCH) stableOnRemote = false;
          throw statusError(`远端还没有 ${channel.branch} 分支${channel.branch === STABLE_BRANCH ? "（发布方还没有发布过稳定版）" : ""}，没有切换`, 409, { code: "no-channel-branch" });
        }
        const failure = classifyFetchFailure(fetched);
        throw statusError(`没能取到远端的 ${channel.branch} 分支，没有切换：${failure.message}`, 502, { code: failure.code });
      }
      if (channel.branch === STABLE_BRANCH) stableOnRemote = true;
      const target = lines((await git(["rev-parse", "--verify", "-q", remoteRef])).stdout)[0] || "";
      if (!isGitSha(target)) throw statusError("读不到要切换到的提交，没有切换", 500, { code: "internal" });

      // 本地已经有同名分支（以前换过通道，或 clone 时留下的）：它只能是远端那个提交的祖先——
      // checkout -B 会把它挪到远端那个提交上，上面有自己的提交的话就丢了。
      const local = lines((await git(["rev-parse", "--verify", "-q", `refs/heads/${channel.branch}`])).stdout)[0] || "";
      if (isGitSha(local) && local !== target) {
        const ancestor = await git(["merge-base", "--is-ancestor", local, target]);
        if (ancestor.code === 1) throw statusError(`本地的 ${channel.branch} 分支上有远端没有的提交，没法直接快进，没有切换`, 409, { code: "diverged" });
        if (!ancestor.ok) throw statusError(`没能核对本地的 ${channel.branch} 分支，没有切换：${describeGitFailure(ancestor.stderr, "git merge-base 失败")}`, 500, { code: "internal" });
      }

      const [pkg, lockDiff] = await Promise.all([
        git(["show", `${target}:package.json`]),
        git(["diff", "--quiet", install.head, target, "--", LOCK_FILE]),
      ]);
      const toVersion = pkg.ok ? parseSourceVersion(pkg.stdout) || null : null;
      if (!toVersion) throw statusError(`读不到 ${channel.branch} 分支上的版本号，没有切换`, 409, { code: "bad-target" });
      const name = `${channelText(channel)} v${toVersion}`;
      // 那个版本得认识更新通道（见 CHANNEL_AWARE_FILE）：更早的工作台只认 main 分支，换过去之后既不更新、也换不回来。
      const aware = await git(["cat-file", "-e", `${target}:${CHANNEL_AWARE_FILE}`]);
      if (!aware.ok) {
        throw statusError(aware.timedOut
          ? `没能核对 ${name} 认不认识更新通道，没有切换；请再试一次`
          : `${name} 还不认识更新通道（早于 v2.62）：换过去之后收不到更新、也换不回来，没有切换`, 409, { code: aware.timedOut ? "internal" : "too-old" });
      }
      // 与更新同一道预检：那个版本的启动器会按它自己的 engines.node 拒绝启动。
      const nodeRange = parseNodeEngineRange(readEnginesNode(pkg.stdout));
      if (nodeRange && parseNodeVersion(launcherNode) && !isNodeVersionSupported(launcherNode, nodeRange)) {
        throw statusError(`${name} 需要 Node.js ${nodeRangeText(nodeRange)}，这台电脑上是 ${String(launcherNode).replace(/^v/i, "")}：切过去会启动不了，没有切换`, 409, { code: "node-version" });
      }
      // 依赖不一样要 npm install（可能要下 Electron）：与更新一样交给人在终端做。只是版本号跟着变不算。
      let lockChanged = false;
      if (lockDiff.code !== 0) {
        const [oldLock, newLock] = await Promise.all([git(["show", `${install.head}:${LOCK_FILE}`]), git(["show", `${target}:${LOCK_FILE}`])]);
        lockChanged = !(oldLock.ok && newLock.ok) || lockNeedsInstall(oldLock.stdout, newLock.stdout);
      }
      if (lockChanged) {
        const command = manualSwitchCommand(channel.branch);
        throw statusError(`${name} 的依赖和现在这一版不一样，需要在终端里切：进入安装目录执行 ${command}，再重启工作台`, 409, { code: "needs-install", command });
      }

      const codeChanged = target !== install.head;
      if (codeChanged) {
        log(`self-update: switching channel ${current.id} -> ${channel.id} (v${install.version} -> v${toVersion}, ${install.head.slice(0, 7)} -> ${target.slice(0, 7)}); smoke-testing the target first`);
        tmp = await mkdtemp(path.join(os.tmpdir(), "cwb-update-"));
        tree = path.join(tmp, "tree");
        const added = await git(["worktree", "add", "--detach", "--quiet", tree, target], { timeoutMs: 120_000 });
        if (!added.ok) throw statusError(`没能取出 ${name} 做自检，没有切换：${describeGitFailure(added.stderr, "git worktree 失败")}`, 500, { code: "internal" });
        const smoked = await smoke(tree);
        if (!smoked?.ok) {
          log(`self-update: smoke test of ${target.slice(0, 7)} failed: ${smoked?.detail || "unknown"}`, { level: "warn" });
          throw statusError(`${name} 自检没有通过，没有切换，现在的版本照常可用。请把这句话转给发布的人：${String(smoked?.detail || "监控服务没有起来").slice(0, 400)}`, 422, { code: "smoke-failed" });
        }
      }

      // 取远端与自检要十几秒：动手前再确认工作区还是刚才的样子，那条远端引用也还指着刚才自检过的提交
      //（下面的 checkout 按引用名切：别处的 git fetch 把它挪到了更新的提交上的话，切过去的就不是自检过的那一个）。
      const again = await inspectInstall({ rootDir, git, packaged });
      const targetNow = lines((await git(["rev-parse", "--verify", "-q", remoteRef])).stdout)[0] || "";
      if (again.head !== install.head || again.branch !== install.branch || again.dirty.length || targetNow !== target) {
        throw statusError("准备期间这个目录被改动了，没有切换；请再试一次", 409, { code: "changed" });
      }
      await restoreLockFile(again);
      // -B：本地没有这条分支就照远端的建一条，有就快进过去（上面核对过只会是快进）；--track 让它跟着远端那条，
      // 之后在这个目录里手动 git pull 也是对的。一条命令里完成，切不成时分支与工作区都原样留着。
      const switched = await git(["checkout", "--quiet", "-B", channel.branch, "--track", `${UPDATE_REMOTE}/${channel.branch}`], { timeoutMs: 120_000 });
      if (!switched.ok) throw statusError(`没有切换成功：${describeGitFailure(switched.stderr, "git checkout 失败")}`, 409, { code: "checkout-failed" });
      log(`self-update: switched update channel ${current.id} -> ${channel.id} (${target.slice(0, 7)}, v${toVersion})${codeChanged ? "; control plane restart required" : ""}`);
      state = null;
      return { ...result, changed: true, toVersion, codeChanged };
    } finally {
      await removeSmokeTree(tmp, tree);
      applying = false;
    }
  }

  // 回到上一次更新之前的提交（命令行 npm run update -- --rollback 用）。只在「HEAD 还是那次更新到的提交、
  // 工作区干净」时做，用 reset --keep（有本地改动会拒绝，不会冲掉东西）。
  // → { ok, fromVersion, toVersion, skipped }；skipped：退掉的那一版已记为跳过。
  async function rollback() {
    const marker = await readMarker();
    if (!marker) throw statusError("没有可回退的更新记录", 409, { code: "no-marker" });
    const install = await inspectInstall({ rootDir, git, packaged });
    if (install.kind === "unknown") throw statusError(inspectFailedText(install, "没有回退；请再试一次"), 409, { code: "inspect-failed" });
    if (install.kind !== "git") throw statusError(unsupportedText(install), 409, { code: "unsupported" });
    if (install.head !== marker.to) throw statusError("当前的提交已经不是那次更新装上的版本，不自动回退", 409, { code: "moved" });
    if (install.dirty.length) throw statusError("这个目录里有改过但没提交的文件，不自动回退", 409, { code: "dirty" });
    await restoreLockFile(install);
    const res = await git(["reset", "--keep", "--quiet", marker.from], { timeoutMs: 60_000 });
    if (!res.ok) throw statusError(`回退没有成功：${describeGitFailure(res.stderr, "git reset 失败")}`, 409, { code: "reset-failed" });
    // 记下被退掉的那个提交：远端还停在它上面时不再提示更新（见 planUpdate 的 skipTarget）。
    // 没写成只是少了这层保护，回退本身已经完成；调用方据 skipped 决定怎么跟人说。
    let skipped = true;
    await writeMarker({ ...marker, handoff: "rolled-back", rolledBackAt: now(), skipTarget: marker.to }).catch(() => {
      skipped = false;
    });
    log(`self-update: rolled back ${marker.to.slice(0, 7)} -> ${marker.from.slice(0, 7)} (v${marker.fromVersion})${skipped ? `; ${marker.to.slice(0, 7)} will not be offered again until ${UPDATE_REMOTE}/${channelOfBranch(install.branch)?.branch ?? UPDATE_BRANCH} moves` : ""}`);
    state = null;
    return { ok: true, fromVersion: marker.toVersion, toVersion: marker.fromVersion, skipped };
  }

  // 更新后的那次重启：新控制面起来了、守护进程还是旧代码时，自动做一次平滑交接（等价于横幅上的按钮）。
  // 只管「刚刚那次更新」：记录里 handoff 仍是 pending、时间在窗口内、运行中的版本就是更新到的版本。
  // 代理不在这里交接（切换监听端口有亚秒级空档，留给人在横幅上点）。永不 reject。
  async function resumeAfterRestart({ getBuildInfo, upgrade, sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms)) } = {}) {
    const finish = async (marker, handoff, detail = null) => {
      await writeMarker({ ...marker, handoff, ...(detail ? { handoffDetail: String(detail).slice(0, 300) } : {}), handoffAt: now() }).catch(() => {});
      log(`self-update: post-restart supervisor handoff: ${handoff}${detail ? ` (${detail})` : ""}`, handoff === "failed" ? { level: "warn" } : undefined);
      return handoff;
    };
    try {
      const marker = await readMarker();
      if (marker?.handoff !== "pending") return null;
      if (now() - Number(marker.appliedAt) > RESUME_WINDOW_MS) return finish(marker, "expired");
      const first = await getBuildInfo();
      // 还没重启到新版本（更新后没点重启就被别的原因拉起来了）：保持 pending，下次启动再看。
      if (first?.monitorRunning?.build?.version !== marker.toVersion) return null;
      const deadline = now() + RESUME_WAIT_MS;
      for (;;) {
        const info = await getBuildInfo();
        const dp = info?.dataPlane || {};
        if (dp.channelRunning === false) return finish(marker, "not-needed", "通道没在运行，下次启动就是新代码");
        if (dp.snapshotAvailable !== false) {
          if (!Array.isArray(dp.pending) || !dp.pending.includes("supervisor")) return finish(marker, "not-needed");
          if (dp.handoffSupported === false) return finish(marker, "unsupported", "运行中的守护进程不支持平滑交接");
          const res = await upgrade({ components: ["supervisor"] });
          if (res?.status === 409) return null; // 另一处正在交接（横幅上有人点了）：不抢，记录留着
          return res?.body?.ok === true ? finish(marker, "done") : finish(marker, "failed", res?.body?.error || `HTTP ${res?.status ?? "?"}`);
        }
        if (now() >= deadline) return finish(marker, "timeout", "等不到守护进程的运行快照，改由界面横幅手动升级");
        await sleep(RESUME_POLL_MS);
      }
    } catch (err) {
      log(`self-update: post-restart handoff skipped: ${err?.message || err}`, { level: "warn" });
      return null;
    }
  }

  // 定时检查：启动后稍等一会儿查第一次，之后每半小时一次。每一轮都重新看一遍安装目录（本地几条 git，不联网），
  // 所以切回了 main、换了通道、给目录放行了归属、装上了 git，下一轮自己就接上，不用重启工作台；
  // 联网只在「git 安装且在一条通道的分支上」时做（见 runCheck 的 background）。打包安装不会在运行中变成别的形态，不查。
  function start() {
    if (firstTimer || intervalTimer) return;
    const tick = () => {
      // 打包安装：有发布页可查（releaseLookup）才定时问 GitHub Releases，否则什么都不做。
      if (packaged && typeof releaseLookup !== "function") return;
      check({ background: true }).catch(() => {});
    };
    firstTimer = timers.setTimeout(tick, FIRST_CHECK_DELAY_MS);
    intervalTimer = timers.setInterval(tick, CHECK_INTERVAL_MS);
    firstTimer?.unref?.();
    intervalTimer?.unref?.();
  }

  function stop() {
    if (firstTimer) timers.clearTimeout(firstTimer);
    if (intervalTimer) timers.clearInterval(intervalTimer);
    firstTimer = null;
    intervalTimer = null;
  }

  return { status, check, apply, rollback, switchChannel, resumeAfterRestart, start, stop, respawn };
}
