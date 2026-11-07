import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createDesktopContext } from "./context.mjs";
import { createDiagnosticsSaver, DEFAULT_DIAGNOSTICS_FILENAME, DIAGNOSTICS_SAVE_MAX_BYTES, validateDiagnosticsSave } from "./diagnostics-save.mjs";

function makeHarness({ dialogResult = { canceled: false, filePath: "/picked/diag.json" }, downloads = "/Users/t/Downloads", withWindow = true } = {}) {
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform: "darwin", homeDir: "/Users/t" });
  const win = { isDestroyed: () => false };
  if (withWindow) ctx.state.mainWindow = win;
  const dialogs = [];
  const writes = [];
  const logs = [];
  const saver = createDiagnosticsSaver({
    ctx,
    app: { getPath: (name) => { if (name !== "downloads" || !downloads) throw new Error("no path"); return downloads; } },
    dialog: { showSaveDialog: async (...args) => { dialogs.push(args); return dialogResult; } },
    writeFile: async (file, text, options) => { writes.push({ file, text, options }); },
    homeDir: "/Users/t",
    logger: { info: (message, fields) => logs.push({ message, ...fields }) },
  });
  return { saver, dialogs, writes, logs, win };
}

test("validateDiagnosticsSave：内容必须是字符串且不过大；文件名只收安全字符，否则用默认名", () => {
  assert.throws(() => validateDiagnosticsSave(null), /内容无效/);
  assert.throws(() => validateDiagnosticsSave({ filename: "a.json", text: 1 }), /内容无效/);
  assert.throws(() => validateDiagnosticsSave({ text: "x".repeat(DIAGNOSTICS_SAVE_MAX_BYTES + 1) }), /过大/);
  assert.equal(validateDiagnosticsSave({ filename: "cluster-workbench-diagnostics-20261014-020509.json", text: "{}" }).filename, "cluster-workbench-diagnostics-20261014-020509.json");
  for (const bad of ["../../etc/passwd.json", "a/b.json", ".hidden.json", "x.sh", "", undefined, "名字.json"]) {
    assert.equal(validateDiagnosticsSave({ filename: bad, text: "{}" }).filename, DEFAULT_DIAGNOSTICS_FILENAME, String(bad));
  }
});

test("保存：默认放在「下载」，挂在主窗口上弹框；选好位置后写 0600 文件并记一条日志", async () => {
  const h = makeHarness();
  const result = await h.saver.saveDiagnosticsBundle({ filename: "diag.json", text: '{"a":1}' });
  assert.deepEqual(result, { saved: true, path: "/picked/diag.json" });
  assert.equal(h.dialogs.length, 1);
  const [parent, options] = h.dialogs[0];
  assert.equal(parent, h.win);
  // 默认位置用本机的 path.join 拼（Windows 上是反斜杠），期望值同样拼。
  assert.equal(options.defaultPath, path.join("/Users/t/Downloads", "diag.json"));
  assert.deepEqual(options.filters, [{ name: "JSON", extensions: ["json"] }]);
  assert.deepEqual(h.writes, [{ file: "/picked/diag.json", text: '{"a":1}', options: { mode: 0o600 } }]);
  assert.deepEqual(h.logs, [{ message: "诊断包已保存", event: "diagnostics-saved", origin: "main", bytes: 7 }]);
});

test("取消：不写文件；没有主窗口时不挂父窗口；取不到「下载」目录退回家目录", async () => {
  const canceled = makeHarness({ dialogResult: { canceled: true, filePath: "" } });
  assert.deepEqual(await canceled.saver.saveDiagnosticsBundle({ filename: "d.json", text: "{}" }), { saved: false, canceled: true });
  assert.deepEqual(canceled.writes, []);
  const orphan = makeHarness({ withWindow: false, downloads: null });
  await orphan.saver.saveDiagnosticsBundle({ filename: "d.json", text: "{}" });
  assert.equal(orphan.dialogs[0].length, 1, "只传选项");
  assert.equal(orphan.dialogs[0][0].defaultPath, path.join("/Users/t", "d.json"));
});
