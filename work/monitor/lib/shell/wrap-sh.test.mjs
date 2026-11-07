// wrapSh：远端脚本统一包成 `sh -c '<脚本>'`。纯字符串断言 + 把结果交给本机各种"登录 shell"
// （bash / sh / dash / zsh / ksh / csh / tcsh，缺哪个跳过哪个）真实执行，确认无论对方登录 shell 怎么
// 解读外层，sh 跑的都是同一段程序。只用 os.tmpdir()，不碰真实 HOME。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { wrapSh } from "./wrap-sh.mjs";

const skip = process.platform === "win32";
const OUTER_SHELLS = ["/bin/bash", "/bin/sh", "/bin/dash", "/bin/zsh", "/bin/ksh", "/bin/csh", "/bin/tcsh"].filter((p) => !skip && fs.existsSync(p));

// 远端：`<登录 shell> -c <命令串>`（sshd 的做法）。HOME 指向沙箱，PATH 只留系统目录。
function runVia(shell, command, { home = os.tmpdir(), input = "" } = {}) {
  return spawnSync(shell, ["-c", command], { encoding: "utf8", input, env: { HOME: home, PATH: "/usr/bin:/bin" } });
}

test("wrapSh: 单行脚本 → sh -c 单引号包裹，内部单引号写成 '\\''", () => {
  assert.equal(wrapSh("echo hi"), "sh -c 'echo hi'");
  assert.equal(wrapSh(`printf '%s' "$HOME"`), `sh -c 'printf '\\''%s'\\'' "$HOME"'`);
  // csh 在 -c 下也做历史替换：! 一律放到引号外转义
  assert.equal(wrapSh("[ ! -L x ] && case a in *[!0-9]*) :;; esac"), "sh -c '[ '\\!' -L x ] && case a in *['\\!'0-9]*) :;; esac'");
});

test("wrapSh: 多行按 csh 也能接受的续行拼接——每个换行前都有 \\，必要时补分号", () => {
  const cmd = wrapSh([
    "owner() { id -un; }",
    "if [ -d /tmp ]; then",
    "  for f in /tmp/*; do",
    "    n=$(basename \"$f\")",
    "  done",
    "else",
    "  echo none",
    "fi",
    "",
    "a && \\",
    "b || \\",
    "c | \\",
    "d",
  ]);
  assert.equal(
    cmd,
    [
      "sh -c 'owner() { id -un; }; \\",
      "if [ -d /tmp ]; then \\",
      "  for f in /tmp/*; do \\",
      "    n=$(basename \"$f\"); \\",
      "  done; \\",
      "else \\",
      "  echo none; \\",
      "fi; \\",
      "a && \\",
      "b || \\",
      "c | \\",
      "d'",
    ].join("\n"),
  );
  assert.ok(cmd.split("\n").slice(0, -1).every((line) => line.endsWith("\\")), "没有裸换行");
  assert.equal(wrapSh("a && \\\nb"), wrapSh(["a && \\", "b"]), "字符串与行数组等价");
});

test("wrapSh: 整行注释、续行落在参数中间、末行续行一律拒绝", () => {
  assert.throws(() => wrapSh(["echo a", "# 注释", "echo b"]), /注释/);
  assert.throws(() => wrapSh(["awk '{print}' \\", "file"]), /续行只能落在/);
  assert.throws(() => wrapSh(["echo a && \\"]), /最后一行/);
  // 参数里出现 then / do / else 字样不算关键字：照样补分号
  assert.equal(wrapSh(["echo then", "echo do-else"]), "sh -c 'echo then; \\\necho do-else'");
});

// 覆盖：if/elif/else、for 通配无匹配、case、2>/dev/null、$(…)、单引号、'#!'、awk 的 \t、~ 与 $HOME、
// 标准输入透传。期望输出由 bash 直接执行原脚本得到（基准），各登录 shell 经 wrapSh 后必须逐字一致。
const PROBE_SCRIPT = [
  "d=\"$HOME/none\"",
  "if [ -d \"$d\" ]; then echo has; elif [ -d \"$HOME\" ]; then echo home-ok; else echo none; fi",
  "for f in \"$d\"/*; do",
  "  [ -e \"$f\" ] || continue",
  "  echo \"never $f\"",
  "done",
  "case x1 in ''|*[!0-9]*) echo not-num;; *) echo num;; esac",
  "ls /definitely-missing 2>/dev/null || echo missing-ok",
  "[ \"$(printf '#!')\" = '#!' ] && echo shebang-ok",
  "printf 'a\\tb\\n' | awk -F '\\t' '{ print $2 }'",
  "[ ~ = \"$HOME\" ] && echo tilde-ok",
  "[ \"$(echo $$)\" = \"$$\" ] && echo pid-stable",
  "cat",
];

test("wrapSh: 各种登录 shell（含 csh / tcsh）执行结果与 bash 直接跑原脚本逐字一致", { skip: OUTER_SHELLS.length === 0 }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wrap-sh-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const input = "来自标准输入的一行\n";
  const baseline = spawnSync("/bin/bash", ["-c", PROBE_SCRIPT.join("\n")], { encoding: "utf8", input, env: { HOME: home, PATH: "/usr/bin:/bin" } });
  assert.equal(baseline.status, 0, baseline.stderr);
  assert.match(baseline.stdout, /home-ok\nnot-num\nmissing-ok\nshebang-ok\nb\ntilde-ok\npid-stable\n来自标准输入的一行\n$/);
  const cmd = wrapSh(PROBE_SCRIPT);
  for (const shell of OUTER_SHELLS) {
    const res = runVia(shell, cmd, { home, input });
    assert.equal(res.status, 0, `${shell}: ${res.stderr}`);
    assert.equal(res.stdout, baseline.stdout, shell);
  }
});

test("wrapSh: 退出码原样带回；$$ 是这层 sh 的 pid，两次执行各不相同（临时文件名唯一）", { skip: OUTER_SHELLS.length === 0 }, () => {
  for (const shell of OUTER_SHELLS) {
    assert.equal(runVia(shell, wrapSh("false")).status, 1, shell);
    const a = runVia(shell, wrapSh("echo $$")).stdout.trim();
    const b = runVia(shell, wrapSh("echo $$")).stdout.trim();
    assert.match(a, /^\d+$/, shell);
    assert.notEqual(a, b, `${shell}: 每次 ssh 一个新 sh`);
  }
});
