// 更新日志弹窗「版本详情」里的「更新」一行（v2.59 自更新）：现状的一句话 + 「检查更新」按钮。
import assert from "node:assert/strict";
import test from "node:test";

import { buildSelfUpdateRowHtml, buildUpdateChannelRowHtml, buildVersionDetailsHtml, describeSelfUpdate, describeUpdateChannel } from "./render/diagnostics.js";

const base = { supported: true, kind: "git", remote: "https://github.com/o/r.git", localVersion: "2.58.1", remoteVersion: null, available: false, canApply: false, blockers: [], checkedAt: null, error: null };

test("现状的一句话：没检查过 / 已是最新 / 有新版本 / 不能自动更新的原因 / 检查失败 / 不支持", () => {
  assert.equal(describeSelfUpdate(base), "当前 v2.58.1，还没检查过");
  assert.match(describeSelfUpdate({ ...base, checkedAt: new Date(2026, 9, 11, 9, 5).getTime() }), /^已是最新（v2\.58\.1）· 09:05 检查过$/);
  assert.equal(describeSelfUpdate({ ...base, available: true, canApply: true, remoteVersion: "2.59.0" }), "有新版本 v2.59.0（当前 v2.58.1）：点页面顶部横幅上的「更新」");
  assert.match(describeSelfUpdate({ ...base, available: true, remoteVersion: "2.59.0", blockers: [{ message: "这个版本改了依赖" }] }), /有新版本 v2\.59\.0（当前 v2\.58\.1）：这个版本改了依赖/);
  assert.equal(describeSelfUpdate({ ...base, error: { code: "offline", message: "连不上 GitHub" }, checkedAt: 1 }), "连不上 GitHub");
  assert.equal(describeSelfUpdate({ ...base, checking: true }), "正在检查…");
  assert.equal(describeSelfUpdate({ supported: false, unsupportedReason: "这个目录不是 git 仓库" }), "这个目录不是 git 仓库");
  assert.equal(describeSelfUpdate(null), "");
});

test("「更新」一行：源码与打包安装可检查更新；不是 git 仓库只说明；取不到状态时隐藏", () => {
  const row = buildSelfUpdateRowHtml(base);
  assert.match(row, /id="selfUpdateCheckBtn"/);
  assert.match(row, /id="selfUpdateStatus">当前 v2\.58\.1，还没检查过</);
  assert.match(row, /github\.com\/o\/r\.git/);
  const plain = buildSelfUpdateRowHtml({ supported: false, kind: "plain", unsupportedReason: "这个目录不是 git 仓库，没法自动更新" });
  assert.doesNotMatch(plain, /selfUpdateCheckBtn/);
  assert.match(plain, /不是 git 仓库/);
  assert.match(plain, /只支持 git clone 出来的安装目录/);
  // 处理完就能用的几种「不能更新」：按钮留着，修好点一下就接上（不用重启工作台）。
  const owner = buildSelfUpdateRowHtml({ supported: false, kind: "unsafe-owner", unsupportedReason: 'git 不信任这个目录。在终端执行一次 git config --global --add safe.directory "C:/Users/me/cluster workbench" 之后再检查更新' });
  assert.match(owner, /id="selfUpdateCheckBtn"/);
  assert.match(owner, /safe\.directory &quot;C:\/Users\/me\/cluster workbench&quot;/);
  assert.doesNotMatch(owner, /只支持 git clone/, "它就是 git clone 出来的");
  assert.match(buildSelfUpdateRowHtml({ supported: false, kind: "git", unsupportedReason: "这个仓库没有名为 origin 的远端" }), /selfUpdateCheckBtn/);
  assert.match(buildSelfUpdateRowHtml({ supported: false, kind: "no-git", unsupportedReason: "这台电脑上找不到 git 命令" }), /selfUpdateCheckBtn/);
  // 这一次没读出状态（还不知道支不支持）：把原因说出来，给按钮。
  const unknown = buildSelfUpdateRowHtml({ supported: null, kind: "unknown", error: { code: "inspect-failed", message: "读不到这个目录的 git 状态（git 没有在限定时间内返回），稍后会自动再查" } });
  assert.match(unknown, /id="selfUpdateStatus">读不到这个目录的 git 状态/);
  assert.match(unknown, /selfUpdateCheckBtn/);
  assert.match(buildSelfUpdateRowHtml({ supported: false, kind: "packaged", unsupportedReason: "x" }), /selfUpdateCheckBtn/);
  assert.equal(buildSelfUpdateRowHtml(null), "");
  assert.equal(buildSelfUpdateRowHtml({ error: "self-update unavailable" }), "", "503 的载荷不当成状态");
  // 远端地址来自 git 配置：转义后才进 HTML。
  assert.doesNotMatch(buildSelfUpdateRowHtml({ ...base, remote: '<img src=x onerror="1">' }), /<img/);
});

test("版本详情：带上自更新状态才多出「更新」一行；源码运行写明版本来源", () => {
  const info = { monitorRunning: { build: { version: "2.58.1", gitCommit: "" }, mode: "source" }, bundleOnDisk: { version: "2.58.1", gitCommit: "" }, compatibility: { state: "aligned", reasons: [] } };
  assert.doesNotMatch(buildVersionDetailsHtml(info), /selfUpdateCheckBtn/);
  const html = buildVersionDetailsHtml(info, { selfUpdate: base });
  assert.match(html, /selfUpdateCheckBtn/);
  assert.match(html, /源代码运行（版本取自 package\.json）/);
});

// ---- 更新通道（v2.62）----

test("更新通道一行：稳定版 / 开发版 / 不在任何通道上各说各的；远端有稳定版时才在开发版上补怎么切过去", () => {
  assert.deepEqual(describeUpdateChannel({ ...base, branch: "stable", channel: "stable", stableAvailable: true }), { value: "稳定版（stable）", note: "发布方确认过一个版本、推进稳定版之后才会收到更新", command: "" });
  // 发布方还没建稳定版：只说在哪条通道上，不给一条切不过去的命令。
  assert.deepEqual(describeUpdateChannel({ ...base, branch: "main", channel: "main", stableAvailable: false }), { value: "开发版（main，发布方每次推送都会收到）", note: "", command: "" });
  assert.deepEqual(describeUpdateChannel({ ...base, branch: "main", channel: "main", stableAvailable: true }), { value: "开发版（main，发布方每次推送都会收到）", note: "想只收发布方确认过的版本：在终端进安装目录执行", command: "npm run update -- --channel stable" });
  assert.deepEqual(describeUpdateChannel({ ...base, branch: "dev", channel: null, stableAvailable: false }), { value: "不在任何通道上（当前在 dev 分支上，不自动更新）", note: "切回 main 分支后恢复", command: "" });
  assert.deepEqual(describeUpdateChannel({ ...base, branch: null, channel: null, stableAvailable: true }), { value: "不在任何通道上（当前在游离的提交上，不自动更新）", note: "切回 stable 或 main 分支后恢复", command: "" });
});

test("更新通道一行：不是能自更新的 git 安装、更旧的后端（没有 channel 字段）、认不出的通道 → 不出这一行", () => {
  assert.equal(describeUpdateChannel(null), null);
  assert.equal(describeUpdateChannel(base), null, "载荷里没有 channel：旧后端");
  assert.equal(describeUpdateChannel({ ...base, channel: "beta" }), null);
  assert.equal(describeUpdateChannel({ supported: false, kind: "plain", channel: null }), null);
  assert.equal(describeUpdateChannel({ supported: false, kind: "git", channel: null, unsupportedReason: "这个仓库没有名为 origin 的远端" }), null);
  assert.equal(describeUpdateChannel({ supported: false, kind: "packaged", channel: null }), null);
  assert.equal(describeUpdateChannel({ supported: null, kind: "unknown", channel: null, error: { code: "inspect-failed", message: "读不到" } }), null);
  for (const su of [null, base, { supported: false, kind: "packaged", channel: null }, { error: "self-update unavailable" }]) assert.equal(buildUpdateChannelRowHtml(su), "");
});

test("版本详情：「更新通道」紧跟在「更新」一行后面、排在「建议」之前；分支名转义后才进 HTML", () => {
  const info = { monitorRunning: { build: { version: "2.58.1", gitCommit: "" }, mode: "source" }, bundleOnDisk: { version: "2.58.1", gitCommit: "" }, compatibility: { state: "aligned", reasons: [] } };
  const html = buildVersionDetailsHtml(info, { selfUpdate: { ...base, branch: "main", channel: "main", stableAvailable: true } });
  const at = ["selfUpdateCheckBtn", "selfUpdateChannelRow", "更新通道</span>", "开发版（main，发布方每次推送都会收到）", "<small>想只收发布方确认过的版本：在终端进安装目录执行 <code>npm run update -- --channel stable</code></small>", "建议</span>"].map((part) => html.indexOf(part));
  assert.ok(at.every((pos, i) => pos > 0 && (i === 0 || pos > at[i - 1])), JSON.stringify(at));
  assert.equal(html.match(/id="selfUpdateChannelRow"/g).length, 1);
  // 分支写在通道那一行里，「更新」一行的小字不再重复说是哪个分支。
  assert.match(buildSelfUpdateRowHtml(base), /<small>从 GitHub 取新版本（https:\/\/github\.com\/o\/r\.git）；发现新版本只提示，点了才更新，更新时隧道不断<\/small>/);
  // 没有说明的那种（开发版、远端还没有稳定版）不留空的小字行。
  const plain = buildUpdateChannelRowHtml({ ...base, branch: "main", channel: "main", stableAvailable: false });
  assert.match(plain, /开发版（main，发布方每次推送都会收到）<\/span>/);
  assert.doesNotMatch(plain, /<small>|<br>|<code>/);
  assert.doesNotMatch(buildUpdateChannelRowHtml({ ...base, branch: "stable", channel: "stable", stableAvailable: true }), /<code>/, "没有要敲的命令就没有 code");
  // 没有自更新状态（旧后端 / fixture 模式）：两行都不出。
  assert.doesNotMatch(buildVersionDetailsHtml(info), /selfUpdateChannelRow|更新通道/);
  // git 的分支名里可以有尖括号。
  const odd = buildUpdateChannelRowHtml({ ...base, branch: "<img src=x onerror=1>", channel: null });
  assert.doesNotMatch(odd, /<img/);
  assert.match(odd, /&lt;img src=x onerror=1&gt; 分支上/);
});
