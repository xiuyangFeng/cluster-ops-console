import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { shellSingleQuote } from "./quote.mjs";

test("shellSingleQuote: 整体单引号包裹，内部单引号写成 '\\''", () => {
  assert.equal(shellSingleQuote("plain"), "'plain'");
  assert.equal(shellSingleQuote("it's"), "'it'\\''s'");
  assert.equal(shellSingleQuote(""), "''");
  assert.equal(shellSingleQuote(42), "'42'");
});

test("shellSingleQuote: 经真实 sh 解析后逐字还原（含 $、反引号、分号、换行）", { skip: process.platform === "win32" }, () => {
  for (const raw of ["a b", "it's", "$HOME `id` ; rm -rf /", "line1\nline2", "'''", "中文 路径/x"]) {
    const out = execFileSync("/bin/sh", ["-c", `printf %s ${shellSingleQuote(raw)}`], { encoding: "utf8" });
    assert.equal(out, raw, JSON.stringify(raw));
  }
});
