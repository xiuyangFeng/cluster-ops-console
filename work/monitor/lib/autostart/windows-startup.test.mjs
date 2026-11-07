// Windows 的启动脚本只做字符串生成与识别，这里的用例在任何系统上都跑（这一轮没有 Windows 环境）。
import assert from "node:assert/strict";
import test from "node:test";

import { AUTOSTART_FLAG, AUTOSTART_MARKER } from "./launch-flag.mjs";
import {
  buildStartupCmd,
  isStartupRoot,
  parseStartupCmd,
  STARTUP_FILE_NAME,
  sameWindowsPath,
  startupTarget,
  windowsStartupDir,
} from "./windows-startup.mjs";

const HOME = "C:\\Users\\alice";
const ROOT = "C:\\Users\\alice\\cluster-workbench";
const lines = (text) => text.split("\r\n");
const isAscii = (text) => [...text].every((ch) => ch.codePointAt(0) < 0x80);
// 启动行：start "" /d "<目录>" /min <新窗口里执行的命令>
const startLine = (text) => lines(text).find((line) => line.startsWith("start "));
const NEW_WINDOW_COMMAND = "cmd /c .\\start-console.cmd --autostart";

test("windowsStartupDir：当前用户的「启动」文件夹；读不到 APPDATA 时为 null", () => {
  assert.equal(
    windowsStartupDir({ APPDATA: "C:\\Users\\alice\\AppData\\Roaming" }),
    "C:\\Users\\alice\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
  );
  assert.equal(windowsStartupDir({}), null);
  assert.equal(windowsStartupDir({ APPDATA: "  " }), null);
  assert.equal(windowsStartupDir(), null);
  assert.equal(STARTUP_FILE_NAME, "cluster-workbench-autostart.cmd");
});

test("buildStartupCmd：默认安装位置——纯 ASCII、CRLF、无 BOM；在安装目录里最小化启动 start-console.cmd 并带自启标志", () => {
  const text = buildStartupCmd({ repoRoot: ROOT, userProfile: HOME });
  assert.deepEqual(lines(text), [
    "@echo off",
    `rem ${AUTOSTART_MARKER}. Written by Cluster Workbench (Settings - Startup): starts the workbench minimized after sign-in.`,
    "rem Turn that switch off to delete this file; manual edits are overwritten the next time the switch is turned on.",
    'start "" /d "%USERPROFILE%\\cluster-workbench" /min cmd /c .\\start-console.cmd --autostart',
    "",
  ]);
  assert.ok(isAscii(text));
  assert.ok(text.startsWith("@echo off\r\n"), "第一行必须是 @echo off：前面多一个 BOM 它就不是命令了");
  assert.ok(!text.replaceAll("\r\n", "").includes("\n"), "只用 CRLF 换行");
  assert.ok(text.includes(AUTOSTART_FLAG));
  // 只写一个文件：不注册计划任务、不写注册表。
  assert.doesNotMatch(text, /schtasks|reg(\.exe)? add|powershell/i);
});

test("buildStartupCmd：中文用户名在默认位置下仍是纯 ASCII（路径由 cmd 运行时展开 %USERPROFILE%，不依赖文件编码）", () => {
  const text = buildStartupCmd({ repoRoot: "C:\\Users\\张三\\cluster-workbench", userProfile: "C:\\Users\\张三" });
  assert.ok(isAscii(text));
  assert.ok(!text.includes("chcp"), "用不到切代码页");
  assert.equal(startLine(text), `start "" /d "%USERPROFILE%\\cluster-workbench" /min ${NEW_WINDOW_COMMAND}`);
  // 用户目录的大小写、末尾分隔符、正斜杠写法不影响识别。
  for (const profile of ["c:\\users\\张三", "C:\\Users\\张三\\", "C:/Users/张三"]) {
    assert.equal(buildStartupCmd({ repoRoot: "C:\\Users\\张三\\cluster-workbench", userProfile: profile }), text, profile);
  }
  // 名字只是前缀相同的另一个目录不算在用户目录下。
  assert.equal(startLine(buildStartupCmd({ repoRoot: "C:\\Users\\alice2\\wb", userProfile: HOME })), `start "" /d "C:\\Users\\alice2\\wb" /min ${NEW_WINDOW_COMMAND}`);
  // 安装目录就是用户目录本身。
  assert.equal(startLine(buildStartupCmd({ repoRoot: HOME, userProfile: HOME })), `start "" /d "%USERPROFILE%" /min ${NEW_WINDOW_COMMAND}`);
});

test("buildStartupCmd：用户目录之外的位置写绝对路径；有非 ASCII 字符时先切到 UTF-8 代码页，且标记行仍在它之前", () => {
  const plain = buildStartupCmd({ repoRoot: "D:\\tools\\cluster workbench", userProfile: HOME });
  assert.deepEqual(lines(plain).slice(3), [`start "" /d "D:\\tools\\cluster workbench" /min ${NEW_WINDOW_COMMAND}`, ""]);
  assert.ok(!plain.includes("chcp"));

  const utf8 = lines(buildStartupCmd({ repoRoot: "D:\\工具\\工作台", userProfile: HOME }));
  assert.equal(utf8[3], "chcp 65001 >nul");
  assert.equal(utf8[4], `start "" /d "D:\\工具\\工作台" /min ${NEW_WINDOW_COMMAND}`);
  assert.ok(isAscii(utf8.slice(0, 4).join("\n")), "切代码页之前的行全是 ASCII");
  assert.ok(utf8[1].includes(AUTOSTART_MARKER));

  // 正斜杠、末尾分隔符归一。
  assert.equal(buildStartupCmd({ repoRoot: "D:/tools/wb/" }), buildStartupCmd({ repoRoot: "D:\\tools\\wb" }));
  assert.equal(startLine(buildStartupCmd({ repoRoot: "D:\\tools\\wb\\" })), `start "" /d "D:\\tools\\wb" /min ${NEW_WINDOW_COMMAND}`, "目录不以反斜杠结尾（紧挨着右引号的反斜杠容易被当成转义）");
});

// start 启动批处理时会把命令文本交给第二个 cmd.exe /K 再解析一遍，那一遍对引号的保留条件很苛刻：
// 恰好两个引号、中间有空白、且没有 & < > ( ) @ ^ | 。安装路径只要既有空格又有括号、或带 & ^，
// 「start "" /min "<路径>\start-console.cmd"」这种写法在新窗口里就会被从空格处截断。
// 所以安装目录只放在 /d 后面（由第一个 cmd 解析一次），新窗口里执行的命令不含安装路径、不含引号。
test("buildStartupCmd：安装路径不进第二次解析——新窗口里执行的命令固定是那几个词，路径里有空格 / 括号 / & ^ @ 也一样", () => {
  const cases = [
    ["C:\\Users\\Zhang San\\cluster-workbench (1)", "C:\\Users\\Zhang San", '%USERPROFILE%\\cluster-workbench (1)'],
    ["C:\\Program Files (x86)\\cluster-workbench", HOME, "C:\\Program Files (x86)\\cluster-workbench"],
    ["D:\\R&D\\wb", HOME, "D:\\R&D\\wb"],
    ["D:\\a^b\\wb", HOME, "D:\\a^b\\wb"],
    ["D:\\me@lab\\wb", HOME, "D:\\me@lab\\wb"],
    ["D:\\100%\\a&b^c (x)", HOME, "D:\\100%%\\a&b^c (x)"],
    ["C:\\Users\\alice\\50%off", HOME, "%USERPROFILE%\\50%%off"],
    ["D:\\工具 (新)\\工作台", HOME, "D:\\工具 (新)\\工作台"],
  ];
  for (const [repoRoot, userProfile, dir] of cases) {
    const line = startLine(buildStartupCmd({ repoRoot, userProfile }));
    assert.equal(line, `start "" /d "${dir}" /min ${NEW_WINDOW_COMMAND}`, repoRoot);
    // 整行只有两对引号：空标题与 /d 的目录。目录之后的部分与安装路径无关。
    assert.equal(line.split('"').length - 1, 4, repoRoot);
    assert.ok(line.endsWith(`" /min ${NEW_WINDOW_COMMAND}`), repoRoot);
  }
  // 新窗口里那条命令本身：没有引号、没有会被 cmd 特殊处理的字符、没有空格以外的分隔。
  assert.doesNotMatch(NEW_WINDOW_COMMAND, /["&<>()@^|%!]/);
});

test("isStartupRoot：只收带盘符的本机路径；网络路径、盘符根目录、双引号、控制字符、相对路径都拒绝", () => {
  assert.equal(isStartupRoot(ROOT), true);
  assert.equal(isStartupRoot("D:/tools/wb"), true);
  // cmd 不能把网络路径当作当前目录，start-console.cmd 自己的 cd /d 也进不去。
  assert.equal(isStartupRoot("\\\\nas\\share\\wb"), false);
  for (const bad of ["C:\\", "C:", 'D:\\a"b', "D:\\a\nb", "D:\\a\rb", "relative\\dir", "\\rooted-no-drive", "", null, undefined, 42]) {
    assert.equal(isStartupRoot(bad), false, JSON.stringify(bad));
    assert.throws(() => buildStartupCmd({ repoRoot: bad, userProfile: HOME }), /安装目录/, JSON.stringify(bad));
  }
  assert.throws(() => buildStartupCmd({ repoRoot: "\\\\nas\\share\\wb", userProfile: HOME }), /安装目录/);
});

test("parseStartupCmd：认标记、从 /d 的目录还原出启动的是哪一份（%USERPROFILE% 与 %% 都还原）；写进去再读回来一致", () => {
  for (const [repoRoot, userProfile] of [
    [ROOT, HOME],
    ["C:\\Users\\张三\\cluster-workbench", "C:\\Users\\张三"],
    ["C:\\Users\\Zhang San\\cluster-workbench (1)", "C:\\Users\\Zhang San"],
    ["D:\\工具\\工作台", HOME],
    ["D:\\100%\\a&b^c (x)", HOME],
    ["C:\\Users\\alice\\50%off", HOME],
    [HOME, HOME],
    ["D:\\tools\\wb", ""],
  ]) {
    const parsed = parseStartupCmd(buildStartupCmd({ repoRoot, userProfile }), { userProfile });
    assert.equal(parsed.managed, true, repoRoot);
    assert.equal(parsed.target, startupTarget(repoRoot), repoRoot);
  }
  assert.equal(startupTarget(ROOT), "C:\\Users\\alice\\cluster-workbench\\start-console.cmd");
  assert.deepEqual(parseStartupCmd('@echo off\r\nstart "" "C:\\other\\thing.exe"\r\n'), { managed: false, target: null }, "别人放的同名脚本");
  assert.deepEqual(parseStartupCmd(`rem ${AUTOSTART_MARKER}\r\n`), { managed: true, target: null }, "带标记但没有启动行");
  // 带标记但启动行不是现在这种写法（比如被人手改过）：认得出是我们的，但读不出它启动哪一份。
  assert.deepEqual(parseStartupCmd(`rem ${AUTOSTART_MARKER}\r\nstart "" /min "C:\\wb\\start-console.cmd" --autostart\r\n`), { managed: true, target: null });
  assert.deepEqual(parseStartupCmd(""), { managed: false, target: null });
  assert.deepEqual(parseStartupCmd(null), { managed: false, target: null });
});

test("sameWindowsPath：不分大小写、分隔符归一；不是字符串的不相等", () => {
  assert.equal(sameWindowsPath("C:\\Users\\Alice\\wb\\start-console.cmd", "c:/users/alice/wb/START-CONSOLE.CMD"), true);
  assert.equal(sameWindowsPath("C:\\a\\b", "C:\\a\\c"), false);
  assert.equal(sameWindowsPath(null, "C:\\a"), false);
  assert.equal(sameWindowsPath("C:\\a", undefined), false);
});
