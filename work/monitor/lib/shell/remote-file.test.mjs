// 远端原子写文件命令：只在 os.tmpdir() 下的临时目录里真实执行（bash，umask 0002 模拟集群），
// 绝不碰真实 HOME。搬迁前就有的行为（标记块幂等、after-shebang、base64 往返）仍由
// scripts/setup-wizard.test.mjs 经 routing.mjs 的 re-export 覆盖，这里只测新增选项。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRemoteReplaceFileCommand,
  buildRemoteReplaceFileFromStdinCommand,
  buildRemoteStripBlockCommand,
  buildRemoteUpsertCommand,
} from "./remote-file.mjs";

const skip = process.platform === "win32";

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 与集群一致的 umask 0002；HOME 指向沙箱，命令里的 ~ 展开到这里。
function run(home, command, input) {
  return spawnSync("bash", ["-c", `umask 0002; ${command}`], {
    encoding: "utf8",
    input,
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
}

const mode = (p) => fs.statSync(p).mode & 0o777;

test("buildRemoteReplaceFileCommand: 默认参数的输出与搬迁前逐字一致（reclaude / zcode 两步不变）", () => {
  const cmd = buildRemoteReplaceFileCommand({ targetFile: "~/.zcode/v2/setting.json", content: "{}\n" });
  assert.equal(
    cmd,
    [
      "mkdir -p ~/.zcode/v2",
      "if [ -f ~/.zcode/v2/setting.json ]; then cp -p ~/.zcode/v2/setting.json ~/.zcode/v2/setting.json.bak.$(date +%s); fi",
      "printf '%s' 'e30K' | base64 -d > ~/.zcode/v2/setting.json.tmp.$$",
      "mv ~/.zcode/v2/setting.json.tmp.$$ ~/.zcode/v2/setting.json",
    ].join(" && \\\n"),
  );
});

test("buildRemoteReplaceFileCommand: mode / dirMode / backup:false → 目录 700、文件 600、不留备份与临时文件", { skip }, (t) => {
  const home = sandbox(t);
  const cmd = buildRemoteReplaceFileCommand({ targetFile: "~/.config/x/env.sh", content: "export A=1\n", mode: "600", dirMode: "700", backup: false });
  assert.match(cmd, /^umask 077 && \\\n/, "tmp 从创建起就不可被他人读");
  fs.mkdirSync(path.join(home, ".config", "x"), { recursive: true, mode: 0o755 });
  for (const content of ["export A=1\n", "export A=2\n"]) {
    const res = run(home, buildRemoteReplaceFileCommand({ targetFile: "~/.config/x/env.sh", content, mode: "600", dirMode: "700", backup: false }));
    assert.equal(res.status, 0, res.stderr);
  }
  const dir = path.join(home, ".config", "x");
  assert.equal(fs.readFileSync(path.join(dir, "env.sh"), "utf8"), "export A=2\n");
  assert.equal(mode(path.join(dir, "env.sh")), 0o600);
  assert.equal(mode(dir), 0o700, "已存在的 755 目录也被收紧");
  assert.deepEqual(fs.readdirSync(dir), ["env.sh"]);
});

test("buildRemoteReplaceFileCommand: 非法权限位抛错（不会拼进命令）", () => {
  assert.throws(() => buildRemoteReplaceFileCommand({ targetFile: "~/x", content: "", mode: "600; rm -rf ~" }), /mode 非法/);
  assert.throws(() => buildRemoteReplaceFileCommand({ targetFile: "~/x", content: "", dirMode: "u+rwx" }), /dirMode 非法/);
});

test("buildRemoteUpsertCommand: tmp 继承目标文件权限，umask 0002 下 600 的文件不会变成 664", { skip }, (t) => {
  const home = sandbox(t);
  const target = path.join(home, ".bashrc");
  fs.writeFileSync(target, "# mine\n", { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  const res = run(home, buildRemoteUpsertCommand({ targetFile: "~/.bashrc", blockContent: "echo hi\n", marker: "t-marker" }));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(mode(target), 0o600);
  assert.equal(fs.readFileSync(target, "utf8"), "# mine\n# >>> t-marker >>>\necho hi\n# <<< t-marker <<<\n");
});

test("buildRemoteUpsertCommand: marker 含引号等不安全字符时抛错", () => {
  assert.throws(() => buildRemoteUpsertCommand({ targetFile: "~/.bashrc", blockContent: "", marker: 'a" b' }), /不安全/);
});

test("buildRemoteStripBlockCommand: 有块才动（备份 + 剥离 + 权限不变），没有块时零副作用", { skip }, (t) => {
  const home = sandbox(t);
  const target = path.join(home, ".bashrc");
  const before = "A\n# >>> old >>>\nexport X=1\n# <<< old <<<\nB\n";
  fs.writeFileSync(target, before);
  fs.chmodSync(target, 0o640);
  const cmd = buildRemoteStripBlockCommand({ targetFile: "~/.bashrc", marker: "old" });

  let res = run(home, cmd);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), "A\nB\n");
  assert.equal(mode(target), 0o640);
  assert.equal(fs.readdirSync(home).filter((n) => n.includes(".bak.")).length, 1);

  res = run(home, cmd); // 第二次：块已不在
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readdirSync(home).filter((n) => n.includes(".bak.")).length, 1, "没有块时不再新增备份");
  assert.ok(!fs.readdirSync(home).some((n) => n.includes(".tmp.")));

  // 目标文件不存在：同样成功退出
  assert.equal(run(home, buildRemoteStripBlockCommand({ targetFile: "~/.nope", marker: "old" })).status, 0);
});

test("buildRemoteStripBlockCommand requireShebang: 原生二进制（非 #! 开头）即使含标记也原样不动", { skip }, (t) => {
  const home = sandbox(t);
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  const elf = path.join(home, ".local", "bin", "codex");
  const binary = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]), Buffer.from("\n# >>> old >>>\nx\n# <<< old <<<\n")]);
  fs.writeFileSync(elf, binary, { mode: 0o755 });
  const res = run(home, buildRemoteStripBlockCommand({ targetFile: "~/.local/bin/codex", marker: "old", requireShebang: true }));
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(fs.readFileSync(elf), binary);
  assert.deepEqual(fs.readdirSync(path.dirname(elf)), ["codex"]);

  fs.writeFileSync(elf, "#!/bin/sh\n# >>> old >>>\nexport X=1\n# <<< old <<<\nexec true\n");
  fs.chmodSync(elf, 0o755);
  assert.equal(run(home, buildRemoteStripBlockCommand({ targetFile: "~/.local/bin/codex", marker: "old", requireShebang: true })).status, 0);
  assert.equal(fs.readFileSync(elf, "utf8"), "#!/bin/sh\nexec true\n");
  assert.equal(mode(elf), 0o755, "包装脚本仍可执行");
});

test("buildRemoteStripBlockCommand requireShebang: 先只读 2 字节确认是脚本，ELF 根本不被 grep（不白读上百 MB）", { skip }, (t) => {
  const home = sandbox(t);
  const cmd = buildRemoteStripBlockCommand({ targetFile: "~/.local/bin/codex", marker: "old", requireShebang: true });
  assert.ok(cmd.indexOf("head -c 2") < cmd.indexOf("grep -qxF"), "shebang 判定排在 grep 之前（&& 短路）");
  assert.ok(buildRemoteStripBlockCommand({ targetFile: "~/.bashrc", marker: "old" }).includes("grep -qxF"), "不要求 shebang 时照常 grep");
  assert.doesNotMatch(buildRemoteStripBlockCommand({ targetFile: "~/.bashrc", marker: "old" }), /head -c/);

  // 记录调用的 grep 垫片：放在 PATH 最前，转给真正的 grep。
  const realGrep = ["/usr/bin/grep", "/bin/grep"].find((p) => fs.existsSync(p));
  const shim = path.join(home, "shim");
  const log = path.join(home, "grep.log");
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, "grep"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec ${realGrep} "$@"\n`, { mode: 0o755 });
  const runWithShim = () => spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: { HOME: home, PATH: `${shim}:/usr/bin:/bin` } });

  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  const elf = path.join(home, ".local", "bin", "codex");
  fs.writeFileSync(elf, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]), Buffer.from("\n# >>> old >>>\nx\n# <<< old <<<\n")]), { mode: 0o755 });
  assert.equal(runWithShim().status, 0);
  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", "", "ELF 没被 grep 读过");

  fs.writeFileSync(elf, "#!/bin/sh\n# >>> old >>>\nexport X=1\n# <<< old <<<\nexec true\n");
  assert.equal(runWithShim().status, 0);
  assert.match(fs.readFileSync(log, "utf8"), /\.local\/bin\/codex/, "shell 包装脚本才 grep");
  assert.equal(fs.readFileSync(elf, "utf8"), "#!/bin/sh\nexec true\n");
});

test("buildRemoteReplaceFileFromStdinCommand: 内容走标准输入，命令串不含内容；既有 600 权限保留并留备份", { skip }, (t) => {
  const home = sandbox(t);
  const target = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{"old":true}\n', { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  const content = `${JSON.stringify({ env: { A: "密钥不该出现在命令里" } }, null, 2)}\n`;
  const cmd = buildRemoteReplaceFileFromStdinCommand({ targetFile: "~/.claude/settings.json", byteLength: Buffer.byteLength(content) });
  assert.doesNotMatch(cmd, /密钥/);
  assert.doesNotMatch(cmd, /cat\s*>\s*~\/\.claude\/settings\.json(?!\.)/, "绝不裸 cat > 目标文件");

  const res = run(home, cmd, content);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), content);
  assert.equal(mode(target), 0o600);
  const names = fs.readdirSync(path.dirname(target));
  assert.ok(names.some((n) => n.startsWith("settings.json.bak.")));
  assert.ok(!names.some((n) => n.includes(".tmp.")));
});

test("buildRemoteReplaceFileFromStdinCommand: 收到的字节数不符（断线截断）→ 非零退出、目标不变、不留临时文件", { skip }, (t) => {
  const home = sandbox(t);
  const target = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{"keep":1}\n');
  const full = '{"a":"0123456789"}\n';
  const res = run(home, buildRemoteReplaceFileFromStdinCommand({ targetFile: "~/.claude/settings.json", byteLength: Buffer.byteLength(full) }), full.slice(0, 8));
  assert.notEqual(res.status, 0);
  assert.equal(fs.readFileSync(target, "utf8"), '{"keep":1}\n');
  assert.ok(!fs.readdirSync(path.dirname(target)).some((n) => n.includes(".tmp.")));
});

test("buildRemoteReplaceFileFromStdinCommand: 目标不存在时以 600 新建（umask 077）", { skip }, (t) => {
  const home = sandbox(t);
  const res = run(home, buildRemoteReplaceFileFromStdinCommand({ targetFile: "~/.claude/settings.json", byteLength: 3 }), "{}\n");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(mode(path.join(home, ".claude", "settings.json")), 0o600);
  assert.throws(() => buildRemoteReplaceFileFromStdinCommand({ targetFile: "~/x", byteLength: -1 }), /byteLength/);
});

// ---- v2.57 终审：要求 600 时，tmp 必须在写入内容之前就是 600 ----

// 假 cat：shell 已按重定向把 tmp 建好 / 截断之后、读标准输入之前，记下目标目录里 tmp 文件此刻的权限。
// 之后到 mv 之间命令不再改 tmp 的权限，所以这一刻的权限就是"含 key 的内容落盘期间"的权限。
function installModeWatchingCat(home) {
  const bin = path.join(home, "fakebin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "cat"), `#!/bin/sh
for f in "$HOME"/.claude/settings.json.tmp.*; do
  if [ -f "$f" ]; then stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f"; fi
done >> "$HOME/tmp-modes.log"
exec /bin/cat "$@"
`, { mode: 0o755 });
}

function runWatched(home, command, input) {
  return spawnSync("bash", ["-c", `umask 0002; ${command}`], {
    encoding: "utf8",
    input,
    env: { HOME: home, PATH: `${home}/fakebin:/usr/bin:/bin` },
  });
}

const tmpModes = (home) => {
  const log = path.join(home, "tmp-modes.log");
  const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  fs.rmSync(log, { force: true });
  return lines;
};

test("buildRemoteReplaceFileFromStdinCommand: 不给 mode 时输出逐字不变（cluster-env 的 settings.json 合并写回沿用原权限）", () => {
  assert.equal(
    buildRemoteReplaceFileFromStdinCommand({ targetFile: "~/.claude/settings.json", byteLength: 12 }),
    "{ umask 077 && \\\nmkdir -p ~/.claude && \\\nif [ -f ~/.claude/settings.json ]; then cp -p ~/.claude/settings.json ~/.claude/settings.json.bak.$(date +%s).$$ && cp -p ~/.claude/settings.json ~/.claude/settings.json.tmp.$$; fi && \\\ncat > ~/.claude/settings.json.tmp.$$ && \\\n[ \"$(wc -c < ~/.claude/settings.json.tmp.$$)\" -eq 12 ] && \\\nmv ~/.claude/settings.json.tmp.$$ ~/.claude/settings.json; } || { rm -f ~/.claude/settings.json.tmp.$$; false; }",
  );
  assert.throws(() => buildRemoteReplaceFileFromStdinCommand({ targetFile: "~/x", byteLength: 1, mode: "u+rw" }), /mode 非法/);
});

test("buildRemoteReplaceFileFromStdinCommand mode: 写入内容之前 tmp 已是 600——原文件 664 也没有同组可读的窗口", { skip }, (t) => {
  const home = sandbox(t);
  installModeWatchingCat(home);
  const target = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const old = '{"old":true}\n';
  fs.writeFileSync(target, old);
  fs.chmodSync(target, 0o664);
  const content = '{"env":{"ANTHROPIC_API_KEY":"sk-new-key-12345678"}}\n';

  // 对照：不给 mode 时 tmp 继承原文件的 664——假 cat 确实看得到这个窗口。
  let res = runWatched(home, buildRemoteReplaceFileFromStdinCommand({ targetFile: "~/.claude/settings.json", byteLength: Buffer.byteLength(old) }), old);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(tmpModes(home), ["664"]);
  assert.equal(mode(target), 0o664);

  const backups = () => fs.readdirSync(path.dirname(target)).filter((n) => n.startsWith("settings.json.bak."));
  const controlBackups = new Set(backups());
  res = runWatched(home, buildRemoteReplaceFileFromStdinCommand({ targetFile: "~/.claude/settings.json", byteLength: Buffer.byteLength(content), mode: "600" }), content);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(tmpModes(home), ["600"], "cat 开始读标准输入时 tmp 已经是 600");
  assert.equal(fs.readFileSync(target, "utf8"), content);
  assert.equal(mode(target), 0o600, "mv 过来的就是 600，不靠事后 chmod");
  const names = fs.readdirSync(path.dirname(target));
  assert.ok(!names.some((n) => n.includes(".tmp.")), "不留临时文件");
  assert.ok(names.filter((n) => n.startsWith("settings.json.bak.")).some((n) => fs.readFileSync(path.join(path.dirname(target), n), "utf8") === old), "原文留了备份");
  // 这次写入留下的备份（旧文件是 664，可能已含 key）也收紧到 600；不给 mode 的那次备份保持 cp -p 的原权限。
  const newBackups = backups().filter((n) => !controlBackups.has(n));
  assert.equal(newBackups.length, 1);
  assert.equal(mode(path.join(path.dirname(target), newBackups[0])), 0o600, "带 mode 写入的备份不留 664");
  for (const n of controlBackups) assert.equal(mode(path.join(path.dirname(target), n)), 0o664, "不给 mode 时备份行为不变");

  // 断线截断：非零退出、目标（内容与权限）不变、不留 tmp。
  res = runWatched(home, buildRemoteReplaceFileFromStdinCommand({ targetFile: "~/.claude/settings.json", byteLength: 999, mode: "600" }), "{}\n");
  assert.notEqual(res.status, 0);
  assert.deepEqual(tmpModes(home), ["600"]);
  assert.equal(fs.readFileSync(target, "utf8"), content);
  assert.ok(!fs.readdirSync(path.dirname(target)).some((n) => n.includes(".tmp.")));
});

test("buildRemoteReplaceFileFromStdinCommand mode: 目标不存在时同样先建 600 的空 tmp 再写", { skip }, (t) => {
  const home = sandbox(t);
  installModeWatchingCat(home);
  const res = runWatched(home, buildRemoteReplaceFileFromStdinCommand({ targetFile: "~/.claude/settings.json", byteLength: 3, mode: "600" }), "{}\n");
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(tmpModes(home), ["600"]);
  assert.equal(mode(path.join(home, ".claude", "settings.json")), 0o600);
  assert.deepEqual(fs.readdirSync(path.join(home, ".claude")), ["settings.json"], "没有原文件就没有备份");
});
