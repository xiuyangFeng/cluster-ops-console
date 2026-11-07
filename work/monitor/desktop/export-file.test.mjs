import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDesktopContext } from "./context.mjs";
import { createExportFileSaver, EXPORT_FILE_MAX_BYTES, safeExportName } from "./export-file.mjs";

function setup(t, dialogResult) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-export-file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform: "darwin", homeDir: dir });
  const shown = [];
  const dialog = {
    showSaveDialog: async (...args) => {
      shown.push(args);
      return typeof dialogResult === "function" ? dialogResult(dir) : dialogResult;
    },
  };
  return { dir, ctx, shown, saver: createExportFileSaver({ ctx, dialog, homeDir: dir }) };
}

test("safeExportName：只留一层名字、去掉路径与控制字符，强制 .json", () => {
  assert.equal(safeExportName("cluster-workbench-config-20261014-0905.json"), "cluster-workbench-config-20261014-0905.json");
  assert.equal(safeExportName("../../etc/passwd"), "passwd.json");
  assert.equal(safeExportName("a\u0007b:c"), "abc.json");
  assert.equal(safeExportName(""), "cluster-workbench-config.json");
  assert.equal(safeExportName(".hidden"), "cluster-workbench-config.json");
});

test("保存：弹系统保存对话框（默认放在「下载」、只给 JSON 过滤器），写出 0600；取消就什么都不写", async (t) => {
  const { dir, shown, saver } = setup(t, (root) => ({ canceled: false, filePath: path.join(root, "out.json") }));
  const result = await saver.saveExportFile({ defaultName: "cfg.json", content: '{"a":1}' });
  assert.deepEqual(result, { saved: true, name: "out.json" });
  assert.equal(fs.readFileSync(path.join(dir, "out.json"), "utf8"), '{"a":1}');
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "out.json")).mode & 0o777, 0o600);
  const options = shown[0].at(-1);
  assert.equal(options.defaultPath, path.join(dir, "Downloads", "cfg.json"));
  assert.deepEqual(options.filters, [{ name: "JSON", extensions: ["json"] }]);
  assert.equal(shown[0].length, 1, "没有主窗口时不挂父窗口");

  const canceled = setup(t, { canceled: true, filePath: "" });
  assert.deepEqual(await canceled.saver.saveExportFile({ content: "{}" }), { saved: false, canceled: true });
});

test("保存：内容不是 JSON / 太大时不弹框；写不进时说明", async (t) => {
  const { shown, saver } = setup(t, { canceled: false, filePath: "/nonexistent-dir/x.json" });
  assert.equal((await saver.saveExportFile({ content: "not json" })).saved, false);
  assert.equal((await saver.saveExportFile({ content: `"${"x".repeat(EXPORT_FILE_MAX_BYTES)}"` })).saved, false);
  assert.equal((await saver.saveExportFile({})).saved, false);
  assert.equal(shown.length, 0);
  const failed = await saver.saveExportFile({ content: "{}" });
  assert.equal(failed.saved, false);
  assert.match(failed.error, /写不进 x\.json（ENOENT）/);
});
