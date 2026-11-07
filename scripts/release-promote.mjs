// scripts/release-promote.mjs —— `npm run release:promote`：把稳定版（origin/stable）推进到一个已经在 main 上的提交。
//
// 源码安装的同事默认跟稳定版（更新通道，见 work/monitor/lib/self-update/channel.mjs）：推 main 不再等于发给他们，
// 在这里推进一次才是。发布方在自己的仓库里用：
//   npm run release:promote                 推进到 origin/main 现在的位置
//   npm run release:promote -- v2.62.0      推进到某个标签 / 提交（必须已经在 origin/main 上）
//   npm run release:promote -- --dry-run    只核对并列出同事会收到什么，不推送（可以和上面两种一起用）
// 顺序：取远端的 main 与 stable（只读）→ 核对 → 列出同事会收到的版本 → 问一句 → git push origin <提交>:refs/heads/stable。
// 核对不过就不推，并说明是哪一条：
//   · 目标提交已经在 origin/main 上（没推过 main 的提交不能直接进稳定版）；
//   · 目标是 origin/stable 现在位置的后代（只快进：稳定版不回头、不分叉）；
//   · 目标的版本号比稳定版高（同事那边只看版本号，不高就不会提示任何人）；
//   · 目标那个版本认识更新通道（v2.62 起）：更早的工作台只认 main 分支，装在 stable 上就再也收不到更新。
// 远端还没有 stable 分支时，这一次就是创建它。
//
// 这是往远端推送的工具，所以：只在终端里回答了 y 之后才推，没有跳过确认的开关；推送是一条普通的 push——
// 不带 --force，引用规格前面不带 +，远端不接受（不是快进）就失败；--dry-run 一点都不动远端（取远端引用是只读的，
// 只更新本机记着的 origin/main、origin/stable）。不动工作区、不切分支、不打标签，工作区有没有改动都不影响。
// 退出码：0 已推进 / 不用推进 / --dry-run 核对通过；1 没推（原因已打印）；2 用法错误。
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSourceVersion } from "../work/monitor/lib/build-info.mjs";
import { compareVersions } from "../work/monitor/lib/cli/catalog.mjs";
import { CHANNEL_AWARE_FILE, remoteRefOf, STABLE_BRANCH, switchCommand, UPDATE_BRANCH, UPDATE_REMOTE } from "../work/monitor/lib/self-update/channel.mjs";
import { classifyFetchFailure, createGit, describeGitFailure, isGitSha, isMissingRemoteRef, sanitizeRemoteUrl } from "../work/monitor/lib/self-update/git.mjs";
import { lockNeedsInstall } from "../work/monitor/lib/self-update/service.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { askLine, confirmYes } from "./lib/prompt.mjs";

const USAGE = [
  "用法: npm run release:promote [-- <提交|标签>] [--dry-run]",
  "  不带参数推进到 origin/main 现在的位置；没有跳过确认或强制推送的开关。",
];
const NET_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;
const LOCK_FILE = "package-lock.json";
// 命令行给的提交 / 标签：只收这些字符、不以 - 开头（它会原样交给 git rev-parse，不能被当成选项）。
const REV_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@^~{}-]{0,199}$/;

const firstLine = (text) => String(text ?? "").split("\n").map((row) => row.trim()).find(Boolean) || "";
const short = (sha) => String(sha).slice(0, 7);

// CHANGELOG.md 的小节标题 → [{ version, title }]，按文件里的先后（新的在前）。两种写法都认：
// "### v2.61.1 · 2026-10-12" 与更早的 "### v2.20.0 (2026-09-01)"（后面可以还带着批次说明）。
export function parseChangelogHeadings(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(/^### (v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.-]).*)$/);
    if (match) out.push({ version: match[2], title: match[1].trim() });
  }
  return out;
}

// 同事这次会收到的那些小节：版本高于稳定版现在的版本、不超过目标版本。fromVersion 为空（第一次创建稳定版，
// 或读不到稳定版现在的版本）→ 只有目标那一版。
export function headingsToDeliver(headings, fromVersion, toVersion) {
  return (Array.isArray(headings) ? headings : []).filter(({ version }) => {
    const vsTarget = compareVersions(version, toVersion);
    if (vsTarget == null || vsTarget > 0) return false;
    return fromVersion ? (compareVersions(version, fromVersion) ?? 0) > 0 : vsTarget === 0;
  });
}

// 取 / 推远端没成时的一句原因。归类沿用 classifyFetchFailure，话换成这里的——那边的「稍后会自动再查」说的是
// 工作台的定时检查，这里没有人会自动再试。
function describeRemoteFailure(res) {
  const failure = classifyFetchFailure(res);
  if (failure.code === "timeout" || failure.code === "offline") return "连不上远端（超时或网络不通），检查网络或代理后再运行一次";
  if (failure.code === "auth") return failure.message;
  if (failure.code === "no-access") return "访问不到这个仓库，或没有它的权限：确认远端地址，以及登录的是发布方的 GitHub 账号";
  return describeGitFailure(`${res?.stderr || ""}\n${res?.stdout || ""}`, `git 退出码 ${res?.code ?? "未知"}`);
}

// git push 没成时的一句原因。远端不接受非快进时 git 说 "[rejected] … (non-fast-forward)" 或 "(fetch first)"。
function describePushFailure(res) {
  const text = `${res?.stderr || ""}\n${res?.stdout || ""}`;
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(text)) return `远端的 ${STABLE_BRANCH} 在核对之后被动过，这次推送不再是快进，远端没有接受。重新运行一次，按最新的情况核对`;
  if (/protected branch|\[remote rejected\]|pre-receive hook declined/i.test(text)) return `远端拒绝了这次推送（分支保护或服务器端的检查）：${describeGitFailure(text, "git push 失败")}`;
  return describeRemoteFailure(res);
}

// 只读的核对：取远端 → 定目标 → 逐条核对 → 整理同事会收到什么。git：lib/self-update/git.mjs 的 createGit（不交互）。
// → { ok: true, upToDate, create, remote, target, targetVersion, stable, stableVersion, commits, aheadOnMain, headings, depsChanged }
//   | { ok: false, code, message }
export async function planPromotion({ git, rev = null } = {}) {
  const refuse = (code, message) => ({ ok: false, code, message });
  const mainRef = remoteRefOf(UPDATE_BRANCH);
  const stableRef = remoteRefOf(STABLE_BRANCH);
  const shaOf = async (name) => {
    const res = await git(["rev-parse", "--verify", "-q", `${name}^{commit}`]);
    const sha = firstLine(res.stdout);
    return res.ok && isGitSha(sha) ? sha : null;
  };

  const url = await git(["remote", "get-url", UPDATE_REMOTE]);
  if (!url.ok) return refuse("no-remote", `这个目录不是带 ${UPDATE_REMOTE} 远端的 git 仓库，不知道往哪里推`);
  const remote = sanitizeRemoteUrl(url.stdout);

  const fetchedMain = await git(["fetch", "--quiet", "--no-tags", UPDATE_REMOTE, `+refs/heads/${UPDATE_BRANCH}:${mainRef}`], { timeoutMs: NET_TIMEOUT_MS });
  if (!fetchedMain.ok) return refuse("fetch-main", `没能取到远端的 ${UPDATE_BRANCH}：${isMissingRemoteRef(fetchedMain) ? `远端没有 ${UPDATE_BRANCH} 分支` : describeRemoteFailure(fetchedMain)}`);
  // 稳定版可以还不存在（第一次推进就是创建它）；别的取不到的情况一律不往下走——不拿本机记着的旧位置核对。
  const fetchedStable = await git(["fetch", "--quiet", "--no-tags", UPDATE_REMOTE, `+refs/heads/${STABLE_BRANCH}:${stableRef}`], { timeoutMs: NET_TIMEOUT_MS });
  const create = !fetchedStable.ok && isMissingRemoteRef(fetchedStable);
  if (!fetchedStable.ok && !create) return refuse("fetch-stable", `没能取到远端的 ${STABLE_BRANCH}：${describeRemoteFailure(fetchedStable)}`);

  const main = await shaOf(mainRef);
  if (!main) return refuse("internal", `读不到 ${UPDATE_REMOTE}/${UPDATE_BRANCH} 的提交`);
  const stable = create ? null : await shaOf(stableRef);
  if (!create && !stable) return refuse("internal", `读不到 ${UPDATE_REMOTE}/${STABLE_BRANCH} 的提交`);
  const target = rev ? await shaOf(rev) : main;
  if (!target) return refuse("bad-rev", `找不到 ${rev} 这个提交或标签（标签要先在这台电脑上打好）`);

  const onMain = await git(["merge-base", "--is-ancestor", target, main]);
  if (onMain.code === 1) return refuse("not-on-main", `${short(target)} 还不在 ${UPDATE_REMOTE}/${UPDATE_BRANCH} 上：稳定版只从已经推到 ${UPDATE_BRANCH} 的提交里选。先 git push ${UPDATE_REMOTE} ${UPDATE_BRANCH}`);
  if (!onMain.ok) return refuse("internal", `没能核对 ${short(target)} 在不在 ${UPDATE_BRANCH} 上：${describeGitFailure(onMain.stderr, "git merge-base 失败")}`);

  const pkg = await git(["show", `${target}:package.json`]);
  const targetVersion = pkg.ok ? parseSourceVersion(pkg.stdout) : "";
  if (!targetVersion) return refuse("bad-version", `读不到 ${short(target)} 的版本号（它的 package.json 里没有合法的 version）`);
  // 目标得认识更新通道（见 CHANNEL_AWARE_FILE）：稳定版指到更早的版本上，跟稳定版的安装跑着它就永远不更新。
  // 第一次创建 stable 时最容易踩：想让它从「上一个稳妥的版本」开始，而那一版还没有更新通道。
  const aware = await git(["cat-file", "-e", `${target}:${CHANNEL_AWARE_FILE}`]);
  if (aware.timedOut) return refuse("internal", `没能核对 ${short(target)} 认不认识更新通道，请再试一次`);
  if (!aware.ok) return refuse("too-old", `${short(target)}（v${targetVersion}）早于更新通道（v2.62）：那个版本的工作台只认 main 分支，稳定版指到它上面之后，跟稳定版的安装就再也收不到更新。选一个 v2.62.0 或更新的提交`);

  let stableVersion = "";
  if (stable) {
    const stablePkg = await git(["show", `${stable}:package.json`]);
    stableVersion = stablePkg.ok ? parseSourceVersion(stablePkg.stdout) : "";
  }
  const base = { ok: true, upToDate: false, create, remote, target, targetVersion, stable, stableVersion, commits: null, aheadOnMain: 0, headings: [], depsChanged: false };
  if (stable && stable === target) return { ...base, upToDate: true };

  if (stable) {
    const forward = await git(["merge-base", "--is-ancestor", stable, target]);
    if (forward.code === 1) {
      const older = await git(["merge-base", "--is-ancestor", target, stable]);
      return refuse("not-fast-forward", older.ok
        ? `${short(target)}（v${targetVersion}）比稳定版现在的位置旧：稳定版只往前推，不回退。要撤回一个稳定版，在 ${UPDATE_BRANCH} 上发一个修正版再推进`
        : `${short(target)} 不是稳定版现在位置（${short(stable)}）的后代，推过去不是快进：稳定版不分叉`);
    }
    if (!forward.ok) return refuse("internal", `没能核对是不是快进：${describeGitFailure(forward.stderr, "git merge-base 失败")}`);
    // 读不到稳定版现在的版本号时没法比高低（正常不会发生：每次推进都核对过目标的版本号），照快进处理。
    if (stableVersion && (compareVersions(targetVersion, stableVersion) ?? 0) <= 0) {
      return refuse("version-not-higher", `版本号没有比稳定版高（稳定版 v${stableVersion}，${short(target)} 是 v${targetVersion}）：同事那边只看版本号，推过去不会提示任何人。先在 ${UPDATE_BRANCH} 上发一个版本号更高的版本`);
    }
  }

  const [commits, ahead, changelog] = await Promise.all([
    stable ? git(["rev-list", "--count", `${stable}..${target}`]) : null,
    git(["rev-list", "--count", `${target}..${main}`]),
    git(["show", `${target}:CHANGELOG.md`]),
  ]);
  // 这段区间改没改依赖：改了的话同事那边不给一键更新，要在终端里做（docs/release.md）。只是版本号跟着变不算。
  let depsChanged = false;
  if (stable) {
    const [oldLock, newLock] = await Promise.all([git(["show", `${stable}:${LOCK_FILE}`]), git(["show", `${target}:${LOCK_FILE}`])]);
    depsChanged = oldLock.ok && newLock.ok && lockNeedsInstall(oldLock.stdout, newLock.stdout);
  }
  return {
    ...base,
    commits: commits?.ok ? Number(firstLine(commits.stdout)) || 0 : null,
    aheadOnMain: ahead.ok ? Number(firstLine(ahead.stdout)) || 0 : 0,
    headings: headingsToDeliver(changelog.ok ? parseChangelogHeadings(changelog.stdout) : [], stableVersion, targetVersion),
    depsChanged,
  };
}

// interactive：标准输入是不是终端。不是终端就不问、也不推——确认只能是人在终端里答的那一句。
export async function runPromoteCli(argv = [], { git, ask = askLine, interactive = false, log = (line) => console.log(line) } = {}) {
  const args = argv.filter((a) => a !== "--");
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((a) => a !== "--dry-run");
  if (rest.length > 1 || rest.some((a) => !REV_PATTERN.test(a)) || args.filter((a) => a === "--dry-run").length > 1) {
    for (const line of USAGE) log(line);
    return 2;
  }
  let pushed = null;
  try {
    log(`→ 取远端的 ${UPDATE_BRANCH} 与 ${STABLE_BRANCH}（只读）…`);
    const plan = await planPromotion({ git, rev: rest[0] ?? null });
    if (!plan.ok) {
      log(`✗ ${plan.message}`);
      log("  没有推送。");
      return 1;
    }
    if (plan.upToDate) {
      log(`✓ 稳定版已经在 ${short(plan.target)}（v${plan.targetVersion}）上，不用推进。`);
      return 0;
    }

    if (plan.create) {
      log(`创建稳定版（${STABLE_BRANCH}）：v${plan.targetVersion}`);
      log(`  远端：${plan.remote}`);
      log(`  提交：${short(plan.target)}（远端还没有 ${STABLE_BRANCH} 分支，这一次创建它）`);
      log("之后新装的同事默认装这一版：");
    } else {
      log(`推进稳定版（${STABLE_BRANCH}）：${plan.stableVersion ? `v${plan.stableVersion}` : "版本未知"} → v${plan.targetVersion}`);
      log(`  远端：${plan.remote}`);
      log(`  提交：${short(plan.stable)} → ${short(plan.target)}（快进${plan.commits == null ? "" : ` ${plan.commits} 个提交`}）`);
      log("跟稳定版的同事会收到（最迟半小时后提示，点了才更新）：");
    }
    for (const heading of plan.headings) log(`  ${heading.title}`);
    if (!plan.headings.length) log(`  （${short(plan.target)} 的 CHANGELOG.md 里没有对应的小节：v${plan.targetVersion}）`);
    if (plan.create) log(`已经装好的同事仍在开发版（${UPDATE_BRANCH}）上，不会自己换过来；想换的人各自执行 ${switchCommand(STABLE_BRANCH)}。`);
    if (plan.depsChanged) log(`注意：这段区间改了依赖（${LOCK_FILE}）。同事那边不会一键更新，会提示在终端里更新——提前说一声。`);
    if (plan.aheadOnMain > 0) log(`注意：${UPDATE_REMOTE}/${UPDATE_BRANCH} 上在这个提交之后还有 ${plan.aheadOnMain} 个提交，不在这次推进里。`);

    if (dryRun) {
      log("（--dry-run：核对通过，没有推送。去掉 --dry-run 再运行一次才会推。）");
      return 0;
    }
    if (!interactive) {
      log("✗ 需要有人在终端里确认，这里的标准输入不是终端：没有推送。");
      return 1;
    }
    if (!(await confirmYes("确认推送？稳定版只往前走，推过去之后撤不回来。(y/N): ", ask))) {
      log("没有推送。");
      return 1;
    }
    // 一条普通的 push：不带 --force，引用规格前面不带 +。--no-follow-tags：只推这一条分支，本机没推过的标签不跟着出去。
    pushed = await git(["push", "--no-follow-tags", UPDATE_REMOTE, `${plan.target}:refs/heads/${STABLE_BRANCH}`], { timeoutMs: PUSH_TIMEOUT_MS });
    if (!pushed.ok) {
      log(`✗ 没有推送成功：${describePushFailure(pushed)}`);
      return 1;
    }
    const verify = await git(["ls-remote", UPDATE_REMOTE, `refs/heads/${STABLE_BRANCH}`], { timeoutMs: NET_TIMEOUT_MS });
    const landed = verify.ok && verify.stdout.split("\n").some((row) => row.trim() === `${plan.target}\trefs/heads/${STABLE_BRANCH}`);
    log(`✓ 稳定版已${plan.create ? "创建" : "推进"}：v${plan.targetVersion}（${short(plan.target)}）。${landed ? "" : "推送命令成功了，但没能回读确认远端的位置，稍后再看一眼。"}`);
    return 0;
  } catch (err) {
    log(`✗ ${err?.message || err}`);
    // 推送那一条已经发出去之后才出的错：不说「没有推送」，让人自己核对一次远端的位置。
    log(pushed ? "  推送命令已经发出，结果没能确认：用 --dry-run 再运行一次，看稳定版现在的位置。" : "  没有推送。");
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // 问到一半被关掉（Ctrl-D）时进程会直接结束：先按「没推」算，走完才改成真正的结果。
  process.exitCode = 1;
  runPromoteCli(process.argv.slice(2), { git: createGit({ root: rootDir }), interactive: Boolean(process.stdin.isTTY) })
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`推进稳定版异常中止，用 --dry-run 再运行一次核对稳定版现在的位置: ${err?.stack || err?.message || err}`);
      process.exitCode = 1;
    });
}
