// scripts/self-update.mjs —— `npm run update`：在终端里检查并应用更新（与界面上的「更新」同一套逻辑，
// 见 work/monitor/lib/self-update/service.mjs）。界面打不开、或想先看一眼有没有新版本时用。
//   npm run update               有新版本就更新（先自检目标版本，再快进合并）
//   npm run update -- --check    只检查，不动任何东西
//   npm run update -- --rollback 回到上一次更新之前的版本；退掉的那一版随后被跳过，直到发布方推送新的提交
//   npm run update -- --force    同不带参数，但被跳过的那一版也照装（回退之后又想装回去时用）
//   npm run update -- --channel stable|main
//                                换更新通道（v2.62）：stable 只收发布方确认过的版本，main 是发布方每次推送都收。
//                                工作区干净才换；先取远端、自检那个版本，再切换分支，没成就什么都不动
// 跟的是当前所在分支对应的那条通道（见 work/monitor/lib/self-update/channel.mjs）。
// 只适用于 git clone 出来的安装目录；需要走代理时用 git 自己认的环境变量（https_proxy）。
// 退出码：0 成功 / 已是最新；1 没更新成（原因已打印）；2 用法错误。
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isPackagedApp, resolveRuntimePaths } from "../work/monitor/lib/runtime-paths.mjs";
import { channelText, getChannel, STABLE_BRANCH, switchCommand, UPDATE_BRANCH, UPDATE_CHANNELS } from "../work/monitor/lib/self-update/channel.mjs";
import { createSelfUpdateService } from "../work/monitor/lib/self-update/service.mjs";
import { isMainModule } from "./lib/is-main.mjs";

const RESTART_HINT = "工作台开着的话，界面顶部会出现「新版本已安装」，点「重启界面」（网页模式是「重启监控服务」）即可生效，隧道不断；没开的话下次 npm run start 就是新版本。";
const USAGE = `用法: npm run update [-- --check | -- --rollback | -- --force | -- --channel ${UPDATE_CHANNELS.map((channel) => channel.id).join("|")}]`;

// --channel stable / --channel=stable → "stable"；没带这个参数 → null；带了但写法不对（缺名字、和别的参数混用）→ undefined。
function parseChannelArg(args) {
  if (!args.some((a) => a === "--channel" || a.startsWith("--channel="))) return null;
  if (args.length === 1 && args[0].startsWith("--channel=")) return args[0].slice("--channel=".length) || undefined;
  if (args.length === 2 && args[0] === "--channel" && !args[1].startsWith("-")) return args[1];
  return undefined;
}

// 换通道：把服务的结论说成人话。
async function runChannelSwitch(id, { service, log }) {
  const channel = getChannel(id);
  const text = channelText(channel);
  log(`→ 换到${text}：先取远端的 ${channel.branch} 分支、自检那个版本，再切换（十几秒）…`);
  const res = await service.switchChannel(id);
  if (!res.changed) {
    log(`✓ 已经在${text}上，不用切换。`);
    return 0;
  }
  if (!res.codeChanged) {
    log(`✓ 已换到${text}（v${res.toVersion}）。两条通道现在是同一个提交，代码没有变化，不用重启。`);
  } else if (res.fromVersion === res.toVersion) {
    log(`✓ 已换到${text}（v${res.toVersion}）。版本号相同、代码有差别：重启工作台后生效。`);
  } else {
    log(`✓ 已换到${text}：v${res.fromVersion || "?"} → v${res.toVersion}。${RESTART_HINT}`);
  }
  log("  工作台开着的话，点左上角的版本号 →「检查更新」，那里显示的更新通道随即更新。");
  const other = UPDATE_CHANNELS.find((entry) => entry.id !== channel.id);
  if (other) log(`  想换回${channelText(other)}：${switchCommand(other.id)}`);
  return 0;
}

export async function runUpdateCli(argv = [], { service, log = (line) => console.log(line) } = {}) {
  const args = argv.filter((a) => a !== "--");
  const channelId = parseChannelArg(args);
  const known = new Set(["--check", "--rollback", "--force"]);
  const badUsage = channelId === null
    ? args.some((a) => !known.has(a)) || args.length > 1
    : !getChannel(channelId); // --channel 写法不对（undefined）或没有这条通道
  if (badUsage) {
    log(USAGE);
    return 2;
  }
  try {
    if (channelId) return await runChannelSwitch(channelId, { service, log });
    if (args[0] === "--rollback") {
      const res = await service.rollback();
      log(`✓ 已回到 v${res.toVersion}（刚才是 v${res.fromVersion}）。${RESTART_HINT}`);
      // 不说的话，人会奇怪「明明有新版本怎么不提示了」，也不知道还能装回去。稳定版等的是发布方下一次推进。
      const until = (await service.status?.())?.channel === STABLE_BRANCH ? "发布方发布新的稳定版后" : "发布方推送新的提交后";
      if (res.skipped) log(`  v${res.fromVersion} 这一版先跳过，不会马上又提示你装它；${until}恢复提示。仍然想装这一版：npm run update -- --force`);
      return 0;
    }
    // --force 只越过「回退后跳过这一版」，其余不能更新的原因（本地有改动、要先 npm install 等）照旧拦。
    const ignoreSkip = args[0] === "--force";
    // 先不联网地看一眼在哪条通道上：下面这行说的就是真正要取的那条分支（不在任何通道上时对照的是 main）。
    const tracked = getChannel((await service.status?.())?.channel)?.branch ?? UPDATE_BRANCH;
    log(`→ 检查更新（git fetch origin ${tracked}）…`);
    const st = await service.check({ force: true, ignoreSkip });
    if (st.supported === false) {
      log(`✗ ${st.unsupportedReason}`);
      return 1;
    }
    if (st.error) log(`  注意：${st.error.message}`);
    if (!st.available) {
      log(st.error ? "✗ 没能确认有没有新版本。" : `✓ 已经是最新版本（v${st.localVersion || "?"}）。`);
      return st.error ? 1 : 0;
    }
    log(`  有新版本 v${st.remoteVersion}（当前 v${st.localVersion || "?"}，落后 ${st.behind} 个提交）。`);
    if (!st.canApply) {
      for (const b of st.blockers) log(`✗ ${b.message}`);
      return 1;
    }
    if (args[0] === "--check") return 0;
    log("→ 自检新版本并更新（十几秒）…");
    const res = await service.apply({ ignoreSkip });
    log(`✓ 已更新到 v${res.toVersion}（原来是 v${res.fromVersion}）。${RESTART_HINT}`);
    log("  想回到原来的版本：npm run update -- --rollback");
    return 0;
  } catch (err) {
    log(`✗ ${err?.message || err}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const paths = resolveRuntimePaths({ appRoot: rootDir, env: process.env, homeDir: os.homedir() });
  const service = createSelfUpdateService({ rootDir, runtimeDir: paths.runtimeDir, packaged: isPackagedApp(rootDir), log: () => {} });
  runUpdateCli(process.argv.slice(2), { service })
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`更新异常中止: ${err?.stack || err?.message || err}`);
      process.exitCode = 1;
    });
}
