// 架构文档的模块清单漂移守卫。
//
// 背景：docs/architecture.md 长期只列了 lib/ 里的十来个模块，而目录里已有 65 个——
// 文档与代码各自演化后，"照着文档读代码"会漏掉真正干活的大部分模块。补全清单只是
// 一次性的，真正防复发的是这条测试：新增 lib 模块必须同步登记进文档。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libDir = path.join(rootDir, "work", "monitor", "lib");
const docPath = path.join(rootDir, "docs", "architecture.md");

test("docs/architecture.md 完整登记 work/monitor/lib 下的每个模块", () => {
  const doc = readFileSync(docPath, "utf8");
  const modules = readdirSync(libDir)
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .sort();

  assert.ok(modules.length > 40, `lib 模块数量异常偏少（${modules.length}），目录是否被移动？`);

  const unlisted = modules.filter((name) => !doc.includes(`\`${name}\``));
  assert.deepEqual(
    unlisted,
    [],
    `以下模块未登记进 docs/architecture.md 的「完整模块清单」：${unlisted.join(", ")}`,
  );
});

test("docs/architecture.md 的模块清单不包含已删除的模块", () => {
  const doc = readFileSync(docPath, "utf8");
  const present = new Set(
    readdirSync(libDir).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs")),
  );
  // 只校验表格里的第一列（模块名），避免把叙述里提到的历史文件名误判为陈旧条目。
  const tableNames = [...doc.matchAll(/^\| `([a-z0-9-]+\.mjs)` \|/gm)].map((m) => m[1]);
  assert.ok(tableNames.length > 40, `未能解析出模块清单表格（解析到 ${tableNames.length} 行）`);

  const stale = tableNames.filter((name) => !present.has(name));
  assert.deepEqual(stale, [], `清单里这些模块已不存在：${stale.join(", ")}`);
});
