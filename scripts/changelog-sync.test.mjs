// 更新日志的两个副本必须一致。
//
// 仓库里有两份更新日志：
//   CHANGELOG.md（权威、完整，人读）
//   work/monitor/public/assets/js/changelog-data.js（GUI 更新日志弹窗的结构化数据）
// 在此之前它们各自演化：GUI 有 4 个版本（v2.4.0/2.5.0/2.6.0/2.6.1）在 CHANGELOG.md 里
// 根本不存在；同一个 v2.10.0 在两边写着不同的日期（2026-07-24 vs 2026-07-30）。
// 版本与日期是发布事实，两边不一致时用户查到的"这个版本什么时候发的"取决于他看哪一屏。
// 这里把"GUI 不得凭空发明版本或日期"变成会失败的断言。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// CHANGELOG.md 的标题有两种历史形态：`### v2.27.0 · 2026-09-29` 与 `### v2.10.0 (2026-07-24)`。
// 分隔符是 U+00B7，用转义写以免源码编码差异导致静默匹配不上（曾因此少解析出 4 个版本）。
const MD_ENTRY_RE = /^### (v[\d.]+)\s*(?:\u00b7|\()\s*(\d{4}-\d{2}-\d{2})/gm;

function readChangelogMarkdown() {
  const src = readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
  return [...src.matchAll(MD_ENTRY_RE)].map((m) => ({ version: m[1], date: m[2] }));
}

async function readGuiChangelog() {
  const mod = await import("../work/monitor/public/assets/js/changelog-data.js");
  return mod.changelogData;
}

function assertDescendingByDate(entries, label) {
  for (let i = 1; i < entries.length; i += 1) {
    assert.ok(
      entries[i - 1].date >= entries[i].date,
      `${label} 的日期未按降序排列：${entries[i - 1].version}(${entries[i - 1].date}) 之后是 ${entries[i].version}(${entries[i].date})`,
    );
  }
}

test("changelog: CHANGELOG.md 能解析出完整版本列表且按日期降序", () => {
  const md = readChangelogMarkdown();
  assert.ok(md.length >= 45, `CHANGELOG.md 只解析出 ${md.length} 个版本，解析规则或文件结构是否被改动？`);
  const versions = md.map((e) => e.version);
  assert.equal(new Set(versions).size, versions.length, "CHANGELOG.md 存在重复版本标题");
  assertDescendingByDate(md, "CHANGELOG.md");
});

test("changelog: GUI 更新日志的每个版本都必须在 CHANGELOG.md 里存在且日期一致", async () => {
  const mdMap = new Map(readChangelogMarkdown().map((e) => [e.version, e.date]));
  const gui = await readGuiChangelog();

  const missing = gui.filter((e) => !mdMap.has(e.version)).map((e) => e.version);
  assert.deepEqual(missing, [], `这些版本只存在于 changelog-data.js，CHANGELOG.md 里没有：${missing.join(", ")}`);

  const mismatched = gui
    .filter((e) => mdMap.has(e.version) && mdMap.get(e.version) !== e.date)
    .map((e) => `${e.version}: changelog-data.js=${e.date} CHANGELOG.md=${mdMap.get(e.version)}`);
  assert.deepEqual(mismatched, [], `同一版本的日期在两个文件里不一致：\n${mismatched.join("\n")}`);
});

test("changelog: GUI 更新日志按日期降序，且结构与首条版本符合渲染契约", async () => {
  const gui = await readGuiChangelog();
  assert.ok(Array.isArray(gui) && gui.length > 0);
  assertDescendingByDate(gui, "changelog-data.js");

  const versions = gui.map((e) => e.version);
  assert.equal(new Set(versions).size, versions.length, "changelog-data.js 存在重复版本");

  const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  assert.equal(gui[0].version, `v${pkg.version}`, "GUI 首条必须是 package.json 的当前版本");

  for (const entry of gui) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `${entry.version} 的日期格式不合法`);
    assert.ok(Array.isArray(entry.changes) && entry.changes.length > 0, `${entry.version} 没有任何变更条目`);
    for (const change of entry.changes) {
      assert.ok(["feat", "fix", "perf"].includes(change.type), `${entry.version} 出现未知变更类型 ${change.type}`);
      assert.equal(typeof change.text, "string");
      assert.ok(change.text.length > 0, `${entry.version} 出现空变更文案`);
    }
  }
});

test("changelog: 两份日志的最新版本一致", async () => {
  const md = readChangelogMarkdown();
  const gui = await readGuiChangelog();
  assert.equal(gui[0].version, md[0].version, "GUI 与 CHANGELOG.md 的最新版本必须一致");
  assert.equal(gui[0].date, md[0].date, "GUI 与 CHANGELOG.md 的最新版本日期必须一致");
});
