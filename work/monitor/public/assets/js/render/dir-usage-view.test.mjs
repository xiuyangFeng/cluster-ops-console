import assert from "node:assert/strict";
import { test } from "node:test";

import { inEveryTimeZone } from "../../../../lib/test-timezones.mjs";
import { autoEndText, autoProgressText, buildDirUsageHtml, caveatTexts, coverageText } from "./dir-usage-view.js";

const NOW = Date.UTC(2026, 9, 6, 6, 0);
const scan = (over = {}) => ({
  root: "",
  label: "~",
  parent: null,
  home: "/public/newhome/cy",
  startedAt: NOW - 120000,
  updatedAt: NOW - 60000,
  runs: 2,
  complete: false,
  stop: "time",
  lastRun: { at: NOW - 60000, sec: 8.01, entries: 4304, stop: "time" },
  scanned: { entries: 20001, dirsDone: 2980, pendingDirs: 255, rootPartial: false, denied: 2, errors: 0, otherFs: 1, otherFsNames: ["mnt"], dropped: 0, hardlinks: 0 },
  totals: { blocks: 3 * 2 ** 30, size: 2.9 * 2 ** 30, files: 15000, dirs: 3000 },
  rootFiles: { blocks: 2 ** 20, size: 2 ** 20, files: 3 },
  children: [
    { name: ".claude", rel: ".claude", blocks: 2 * 2 ** 30, size: 2 ** 31, files: 9000, dirs: 900, partial: false,
      sub: [{ name: "projects", rel: ".claude/projects", blocks: 2 ** 30, size: 2 ** 30, files: 100, dirs: 3 }],
      subRest: { blocks: 2 ** 30, size: 2 ** 30, dirs: 4 } },
    { name: "<b>x</b>", rel: "<b>x</b>", blocks: 2 ** 20, size: 2 ** 20, files: 1, dirs: 0, partial: true, sub: [], subRest: { blocks: 0, size: 0, dirs: 0 } },
  ],
  childrenRest: { count: 0, blocks: 0, size: 0, overflow: false },
  topFiles: [{ path: "codex.tar.gz", rel: "codex.tar.gz", blocks: 254132224, size: 254126489, mtime: 1783652680 }],
  ...over,
});
const data = (over = {}) => ({ eligible: true, serverId: "s1", root: "", running: false, saved: [{ root: "", updatedAt: NOW, complete: false }], scan: scan(), ...over });

test("部分扫描：明确写「已扫描部分：N 个条目，覆盖 X 个目录」，并声明不是目录总量 / 个人配额", () => {
  const html = buildDirUsageHtml(data(), { now: NOW });
  assert.match(html, /已扫描部分：20,001 个条目，覆盖 2,980 个目录；还有 255 个目录未扫。/);
  assert.match(html, /已扫描部分合计：实际占用 3 GiB/);
  assert.match(html, /不是目录总量，也不是个人配额/);
  assert.match(html, /data-du-scan="continue"/);
  assert.match(html, /重新扫描/);
  assert.match(html, /未扫完/);
  assert.match(html, /2 处无权限，已跳过/);
  assert.match(html, /1 个目录在其他文件系统上，未计入（mnt）/);
  assert.match(html, /其余（直接文件及另外 4 个子目录）/);
  assert.match(html, /codex\.tar\.gz/);
  assert.match(html, /没有定时任务/);
  // 文件名一律转义
  assert.ok(!html.includes("<b>x</b>"));
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  const withCache = buildDirUsageHtml(data({
    scan: scan({
      knownCaches: [{ rel: ".cache/huggingface", label: "HuggingFace 模型与数据集缓存", hint: "清理提示", blocks: 2 ** 30, size: 2 ** 30, files: 42, dirs: 5 }],
    }),
  }), { now: NOW });
  assert.match(withCache, /常见缓存与环境占用[\s\S]*~\/\.cache\/huggingface · HuggingFace 模型与数据集缓存/);
});

test("扫完：只说合计，不出现「继续扫描」；子目录根显示上一级", () => {
  const done = scan({ complete: true, root: "Digital_twin", label: "~/Digital_twin", scanned: { ...scan().scanned, pendingDirs: 0, denied: 0, otherFs: 0, otherFsNames: [] } });
  const html = buildDirUsageHtml(data({ root: "Digital_twin", scan: done }), { now: NOW });
  assert.match(html, /已扫完 ~\/Digital_twin：20,001 个条目/);
  assert.match(html, /合计：实际占用/);
  assert.ok(!html.includes("不是目录总量"));
  assert.ok(!html.includes('data-du-scan="continue"'));
  assert.match(html, /data-du-root=""[^>]*>上一级/);
  assert.match(html, /本机还保存了：.*>~（未扫完）</);
  assert.equal(coverageText(done), "已扫完 ~/Digital_twin：20,001 个条目，2,980 个目录。");
  assert.deepEqual(caveatTexts(done), []);
});

test("未扫描 / 读取中 / 出错 / 不适用 / 扫描中各有明确文案", () => {
  assert.match(buildDirUsageHtml(data({ scan: null, root: "a/b", saved: [] })), /~\/a\/b 还没有扫描过。点一次就一轮接一轮自动扫到完成（每轮最多 2 万个条目或 8 秒/);
  assert.match(buildDirUsageHtml(data({ scan: null })), /data-du-scan="start"[^>]*>开始扫描/);
  assert.match(buildDirUsageHtml(null, { loading: true }), /正在读取本机保存的结果/);
  assert.match(buildDirUsageHtml(null, { error: "读取失败" }), /data-level="warn">读取失败/);
  assert.match(buildDirUsageHtml({ eligible: false }), /只对团队集群开放/);
  const busy = buildDirUsageHtml(data(), { busy: true, now: NOW });
  assert.match(busy, /正在发起扫描/);
  assert.ok(!/data-du-scan="continue"(?![^>]*disabled)/.test(busy), "扫描中按钮全部禁用");
});

test("自动续扫中：给进度与「停止」，不给别的扫描按钮、不让切目录；停下的原因如实说明；还没轮到的目录标「未开始」", () => {
  const auto = { root: "", running: true, stopping: false, rounds: 2, startedAt: NOW - 30000, endedAt: null, reason: null, error: null };
  assert.equal(autoProgressText(auto, scan()), "正在自动扫描 · 第 3 轮 · 已扫 20,001 个条目 · 约 537 条/秒 · 还有 255 个目录待扫");
  assert.equal(autoProgressText({ ...auto, stopping: true }, scan()), "正在停止（等这一轮扫完）…");
  const html = buildDirUsageHtml(data({ auto }), { now: NOW });
  assert.match(html, /du-busy">正在自动扫描 · 第 3 轮/);
  assert.match(html, /data-du-scan="stop">停止/);
  assert.doesNotMatch(html, /data-du-scan="(?:start|continue)"/);
  assert.ok(!/data-du-root="[^"]*"(?![^>]*disabled)/.test(html), "扫描期间不切目录");
  assert.match(buildDirUsageHtml(data({ auto: { ...auto, stopping: true } }), { now: NOW }), /data-du-scan="stop" disabled/);
  // 看着别的目录时，说明后台在扫的是哪一个。
  assert.match(buildDirUsageHtml(data({ root: "x", scan: scan({ root: "x" }), auto }), { now: NOW }), /正在自动扫描 · 第 3 轮（~）/);

  const failed = { ...auto, running: false, rounds: 4, reason: "error", error: "扫描超时（SSH 未在 25 秒内返回）", endedAt: NOW };
  assert.equal(autoEndText(failed), "自动扫描停在第 5 轮：扫描超时（SSH 未在 25 秒内返回）。已扫到的部分都留着，可以点「继续扫描」。");
  const ended = buildDirUsageHtml(data({ auto: failed }), { now: NOW });
  assert.match(ended, /data-level="warn">自动扫描停在第 5 轮/);
  assert.match(ended, /data-du-scan="continue">继续扫描/);
  assert.match(autoEndText({ ...failed, reason: "limit", error: null }), /已连续扫描 3 小时/);
  assert.equal(autoEndText({ ...failed, reason: "done" }), "");
  assert.equal(autoEndText({ ...failed, reason: "stopped" }), "");
  assert.equal(autoEndText(auto), "");

  const queued = scan();
  queued.children[1] = { ...queued.children[1], queued: true };
  assert.match(buildDirUsageHtml(data({ scan: queued }), { now: NOW }), /还没轮到这个目录[^>]*>未开始</);
});

test("扫描时刻与文件修改时刻按北京时间，与机器时区无关", async () => {
  await inEveryTimeZone((zone) => {
    const html = buildDirUsageHtml(data(), { now: NOW });
    // NOW = 北京时间 10-06 14:00；扫描完成于 1 分钟前。月份不补零、日期补零。
    assert.match(html, /扫描于 10-06 13:59（/, zone);
    // mtime 1783652680 = 北京时间 2026-07-10 11:04
    assert.match(html, /<span class="du-num du-wide du-mtime">7-10 11:04<\/span>/, zone);
    // 北京时间凌晨：在 UTC / 美洲时区还是前一天
    const early = buildDirUsageHtml(data({ scan: scan({ updatedAt: Date.UTC(2026, 9, 5, 16, 5) }) }), { now: NOW });
    assert.match(early, /扫描于 10-06 00:05（/, zone);
  });
});
