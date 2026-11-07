// 更新通道（v2.62）：自更新跟远端的哪个分支。
//
// 通道就是安装目录当前所在的分支，没有另外的配置项：
//   stable  稳定版——跟 origin/stable。发布方确认过一个版本后用 npm run release:promote 手动推进，推进了同事才收到。
//   main    开发版——跟 origin/main。发布方每次推送都会收到。
// 别的分支（或游离的提交）不属于任何通道，不自动更新。新装的同事由安装器放进稳定版（远端有 stable 分支时），
// 之后想换用 npm run update -- --channel stable|main；界面只显示、不切换。
//
// 这里只放两条通道的静态事实与几个取名的小函数，服务（./service.mjs）、命令行（scripts/self-update.mjs）与
// 推进稳定版的脚本（scripts/release-promote.mjs）都从这里取。两个安装器是单文件、不能 import，各自写了一份
// 同名的分支常量，scripts/installer.test.mjs 守着它们与这里一致。无依赖。
// 这个文件自己在仓库里的位置：一个提交里有它，就说明那个版本认识更新通道（v2.62 起）。更早的版本只认 main 分支——
// 工作台跑着它、目录却在 stable 上的话就永远不更新，也没有 --channel 可以换回来。所以稳定版不能指到那样的提交上
// （scripts/release-promote.mjs 推进前核对），换通道也不往那样的提交上换（service.mjs 的 switchChannel）。
export const CHANNEL_AWARE_FILE = "work/monitor/lib/self-update/channel.mjs";

export const UPDATE_REMOTE = "origin";
// 开发版的分支；也是不在任何通道上时拿来对照的那个分支（那时反正不给更新按钮，只为说明）。
export const UPDATE_BRANCH = "main";
export const STABLE_BRANCH = "stable";

// 顺序即给人看的顺序（稳定版在前）。id 与分支同名：命令行 --channel 后面跟的就是它。
export const UPDATE_CHANNELS = Object.freeze([
  Object.freeze({ id: STABLE_BRANCH, branch: STABLE_BRANCH, label: "稳定版" }),
  Object.freeze({ id: UPDATE_BRANCH, branch: UPDATE_BRANCH, label: "开发版" }),
]);

export const getChannel = (id) => UPDATE_CHANNELS.find((channel) => channel.id === id) ?? null;
// 分支名 → 它所属的通道；不在任何通道上（别的分支、游离的提交）→ null。
export const channelOfBranch = (branch) => UPDATE_CHANNELS.find((channel) => channel.branch === branch) ?? null;
// 分支名 → 本地记着的那条远端引用（git fetch 写的就是它）。
export const remoteRefOf = (branch) => `refs/remotes/${UPDATE_REMOTE}/${branch}`;
// 给人看的写法：「稳定版（stable）」。
export const channelText = (channel) => `${channel.label}（${channel.branch}）`;
// 切到某条通道的那条命令（在安装目录里执行）。
export const switchCommand = (id) => `npm run update -- --channel ${id}`;
