// 一步安装器（install/install-workbench.sh、install/install-workbench.cmd）与两个启动脚本的私有 Node 回退。
//
// 全部在 os.tmpdir() 下的沙箱里跑：HOME / 安装目录 / 桌面都指进沙箱，仓库是现搭的本地 git 夹具
// （scripts/launch.mjs 是只打印一行的桩），Node 下载走本机起的 HTTP 夹具，不联网；每次运行安装器都带
// CWB_INSTALL_NO_LAUNCH=1——绝不启动真的工作台，也不碰真实的 HOME、桌面与配置。
// POSIX 半边在 macOS / Linux 上跑 bash 安装器；Windows 半边只在 Windows 上跑 .cmd（靠 CI 的 Windows job 验证）。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { isNodeVersionSupported } from "../work/monitor/lib/platform.mjs";
import { STABLE_BRANCH } from "../work/monitor/lib/self-update/channel.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SH_INSTALLER = path.join(rootDir, "install", "install-workbench.sh");
const CMD_INSTALLER = path.join(rootDir, "install", "install-workbench.cmd");
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const POSIX_ONLY = isWindows ? "bash 安装器只在 macOS / Linux 上跑" : false;
const WINDOWS_ONLY = isWindows ? false : ".cmd 安装器只在 Windows 上跑";
// 系统 ANSI 代码页（中文 Windows 是 936，GitHub 的英文 Windows runner 是 1252）。
function systemAnsiCodePage() {
  if (!isWindows) return null;
  try {
    const out = execFileSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "ACP"], { encoding: "utf8" });
    return Number(/ACP\s+REG_SZ\s+(\d+)/.exec(out)?.[1]) || null;
  } catch {
    return null;
  }
}

const read = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
const LAUNCHER_NAME = "集群运维工作台.command";
const SHORTCUT_NAME = "集群运维工作台.lnk";
const STUB_MARKER = "CWB_STUB_LAUNCH ";

// ---------------------------------------------------------------------------
// 静态检查（三个平台都跑）
// ---------------------------------------------------------------------------
const shText = read("install", "install-workbench.sh");
const cmdText = read("install", "install-workbench.cmd");
const pinnedSh = shText.match(/^NODE_VERSION="(\d+\.\d+\.\d+)"$/m)?.[1];
const pinnedCmd = cmdText.match(/^\$NodeVersion = '(\d+\.\d+\.\d+)'\r?$/m)?.[1];

// package.json engines 形如 ">=22.12.0 <27"。
function parseEngines() {
  const range = JSON.parse(read("package.json")).engines.node;
  const match = range.match(/^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/);
  assert.ok(match, `engines.node 的写法变了（${range}），安装器测试的解析要跟着改`);
  return { minMajor: Number(match[1]), minMinor: Number(match[2]), minPatch: Number(match[3]), maxMajor: Number(match[4]) };
}

test("钉死的 Node 版本：两个安装器一致，且落在 package.json engines 范围内", () => {
  assert.ok(pinnedSh, "install-workbench.sh 里没找到 NODE_VERSION");
  assert.equal(pinnedCmd, pinnedSh, "两个安装器钉的 Node 版本必须相同");
  const [major, minor, patch] = pinnedSh.split(".").map(Number);
  const { minMajor, minMinor, minPatch, maxMajor } = parseEngines();
  assert.ok(major < maxMajor, `钉的 ${pinnedSh} 超出 engines 上界 <${maxMajor}`);
  const aboveMin = major > minMajor || (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
  assert.ok(aboveMin, `钉的 ${pinnedSh} 低于 engines 下界 ${minMajor}.${minMinor}.${minPatch}`);
  // 运行时真正把关的是这个函数（launch.mjs 用它）：钉的版本过不了它，装完就起不来。
  assert.equal(isNodeVersionSupported(`v${pinnedSh}`), true);
  assert.equal(String(major), read(".nvmrc").trim(), "钉的大版本应当是 .nvmrc 推荐的那个");
});

test("每个平台的 SHA-256 都写死在安装器里，且注明出处是该版本的 SHASUMS256.txt", () => {
  const sh = Object.fromEntries([...shText.matchAll(/^\s+([a-z]+-[a-z0-9]+)\)\s+echo "([0-9a-f]{64})" ;;$/gm)].map((m) => [m[1], m[2]]));
  const cmd = Object.fromEntries([...cmdText.matchAll(/^\s+'(win-[a-z0-9]+)'\s*=\s*'([0-9a-f]{64})'\r?$/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(sh).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  assert.deepEqual(Object.keys(cmd).sort(), ["win-arm64", "win-x64"]);
  const all = [...Object.values(sh), ...Object.values(cmd)];
  assert.equal(new Set(all).size, all.length, "不同平台的包不可能同一个校验值，多半是抄错了行");
  for (const text of [shText, cmdText]) {
    assert.ok(text.includes(`https://nodejs.org/dist/v${pinnedSh}/SHASUMS256.txt`), "换 Node 版本时，校验值出处的注释要一起改");
  }
});

test("Node 版本闸门：start.sh、start-console.cmd 与两个安装器都和 package.json engines 一致", () => {
  const { minMajor, minMinor, maxMajor } = parseEngines();
  const expected = [minMajor, minMinor, maxMajor];
  for (const [name, text] of [["start.sh", read("start.sh")], ["install-workbench.sh", shText]]) {
    const got = ["NODE_MIN_MAJOR", "NODE_MIN_MINOR", "NODE_MAX_MAJOR"].map((key) => Number(text.match(new RegExp(`^${key}=(\\d+)$`, "m"))?.[1]));
    assert.deepEqual(got, expected, `${name} 的版本闸门与 engines 不一致`);
  }
  const gotCmd = ["NodeMinMajor", "NodeMinMinor", "NodeMaxMajor"].map((key) => Number(cmdText.match(new RegExp(`^\\$${key} = (\\d+)\\r?$`, "m"))?.[1]));
  assert.deepEqual(gotCmd, expected, "install-workbench.cmd 的版本闸门与 engines 不一致");
  const gate = read("start-console.cmd").match(/a===(\d+) && b>=(\d+)\) \|\| \(a>(\d+) && a<(\d+)\)/);
  assert.ok(gate, "start-console.cmd 里没找到版本闸门");
  assert.deepEqual([Number(gate[1]), Number(gate[2]), Number(gate[4])], expected, "start-console.cmd 的版本闸门与 engines 不一致");
  assert.equal(gate[3], gate[1]);
});

test("install-workbench.cmd：cmd 解析的头部是纯 ASCII、不用标签；PowerShell 部分避开 5.1 的三个坑", () => {
  const bytes = fs.readFileSync(CMD_INSTALLER);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "不能带 BOM：cmd 会把它当成第一条命令的一部分");
  const lines = cmdText.split(/\r?\n/);
  assert.equal(lines[0], "<# : batch portion", "第一行必须是 cmd / PowerShell 两读的开头");
  const end = lines.indexOf("#>");
  assert.ok(end > 0, "没找到头部结尾的 #>");
  const header = lines.slice(0, end + 1);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 这里要的就是「全部落在 ASCII 范围内」
  assert.ok(header.every((line) => /^[\x00-\x7f]*$/.test(line)), "cmd 解析的头部必须是纯 ASCII（中文只能出现在 PowerShell 部分）");
  // 同事从网页另存下来的文件可能是 LF 换行：cmd 在 LF 文件里找标签会出错，所以头部不许有 goto / call :label / 标签行。
  assert.ok(!header.some((line) => /^\s*:[A-Za-z]|\bgoto\b|\bcall\s+:/i.test(line)), "头部不要用标签和 goto");
  // cmd 每读一行都要重新打开文件、按字节偏移找位置；代码页切到 UTF-8 之后、文件又是 LF 换行时这个偏移会算错
  // （Windows runner 上实测：它接着去「执行」PowerShell 正文里的片段）。所以 cmd 要跑的东西全在第二行这一行里，
  // 用 & 串起来、以 exit /b 结尾——执行完它就不再读文件。
  assert.match(header[1], /^@echo off & .* && \(.*exit \/b 0\) \|\| \(.*exit \/b 1\)$/, "cmd 的全部命令在第二行这一行里，成功 / 失败各以写明数字的 exit /b 结束");
  assert.ok(header[1].includes("chcp 65001"), "头部要把控制台切到 UTF-8");
  assert.ok(!header.slice(2).some((line) => /^\s*(?:@|rem\b|set\b|if\b|exit\b|call\b|chcp\b|pause\b)/i.test(line)), "第二行之后不能再有要 cmd 执行的行");
  assert.ok(!/Get-FileHash\s+-/.test(cmdText), "校验值用 .NET 直接算：Get-FileHash 在从 PowerShell 7 启动的 5.1 里加载不了");

  const body = lines.slice(end + 1);
  assert.doesNotMatch(body.join("\n"), /[\u2018-\u201f\u2013-\u2015]/, "PowerShell 会把弯引号当字符串定界符、把长破折号当减号：一个都不能有");
  const code = body.filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /\$[A-Za-z_]\w*[\u3400-\u9fff]/, "变量后面紧跟汉字会被当成另一个变量名：用 -f 拼接");
  assert.doesNotMatch(code, /\$ErrorActionPreference\s*=\s*['"]Stop['"]/, "5.1 里设成 Stop 后，外部命令往 stderr 写一行就成了异常");
  // 5.1 没有的语法：空值合并、管道链。
  assert.doesNotMatch(code, /\?\?|&&|\|\|/, "这是 PowerShell 7 才有的语法，Windows PowerShell 5.1 读不了");

  // 中文 Windows（默认代码页 CP936/GBK）专门防护：
  // 1) 从 GitHub 网页单文件下载（Download raw file）拿到的是 LF 换行；cmd.exe 读第 1 行时会预读前 4096 字节缓冲区，
  //    若前 4096 字节内出现 UTF-8 多字节字符，CP936 DBCS 扫描器会算错 SetFilePointer 偏移并直接跳过第 2 行！
  const lfBytes = Buffer.from(cmdText.replace(/\r\n/g, "\n"), "utf8");
  const firstNonAsciiOffset = lfBytes.findIndex((b) => b > 0x7f);
  assert.ok(firstNonAsciiOffset > 8192, `install-workbench.cmd 前 8192 字节必须是纯 ASCII（当前首个非 ASCII 在偏移 ${firstNonAsciiOffset}）`);
  // 2) 任何一行都不能以非 ASCII 字符结尾（防止 UTF-8 尾字节 0x81..0xFE 在 CP936 下把紧随其后的 LF 0x0A 当成尾字节吞掉）。
  const nonAsciiEndLines = lines.map((line, i) => [i + 1, line]).filter(([, line]) => line.length > 0 && line.charCodeAt(line.length - 1) > 0x7f);
  assert.deepEqual(nonAsciiEndLines, [], "install-workbench.cmd 不能有以非 ASCII 字符结尾的行（防 CP936 吞换行符）");
});

test("三个 Windows 入口关闭继承的延迟展开，避免中文路径中的 ! 被吃掉", () => {
  for (const file of ["start-console.cmd", "install/install-workbench.cmd", "install/diagnose-workbench.cmd"]) {
    const text = read(file);
    assert.match(text, /setlocal DisableDelayedExpansion/i, file);
    const firstPath = text.search(/%~(?:f|dp)0|%USERPROFILE%|%LOCALAPPDATA%/i);
    assert.ok(text.indexOf("setlocal DisableDelayedExpansion") < firstPath, file);
  }
});

// LF 换行 + 带括号 / 感叹号 / & 的路径：原地安装并启动。代码页设成 936（中文 Windows 的默认）。
// shortcut：true = 必须建出快捷方式；false = 建不出来时安装器要打出警告并给出兜底的启动路径（安装照常完成）。
async function installInPlaceCp936(t, { appName, desktopName, shortcut = true }) {
  const ctx = makeSandbox(t, { lineEndings: "lf" });
  const app = path.join(ctx.home, appName);
  writeWorkbenchFiles(app, "1.0.0");
  fs.mkdirSync(path.join(app, "install"), { recursive: true });
  const installer = path.join(app, "install/install-workbench.cmd");
  fs.writeFileSync(installer, cmdText.replace(/\r\n/g, "\n"));
  const desktop = path.join(ctx.home, desktopName); fs.mkdirSync(desktop);
  const env = sandboxEnv(ctx, { CWB_INSTALL_DIR: "", CWB_DESKTOP_DIR: desktop, CWB_TEST_ENTRY: installer,
    PATH: `${fakeBin(t, sshStubs)}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` });
  // Delayed expansion inserts the value without rescanning its embedded exclamation marks.
  let res = await run("cmd.exe", ["/d", "/v:on", "/c", 'chcp 936>nul & "!CWB_TEST_ENTRY!"'], { env, verbatim: true });
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /安装完成。/);
  assert.equal(fs.existsSync(path.join(app, ".git")), false);
  if (shortcut) {
    assert.ok(fs.existsSync(path.join(desktop, SHORTCUT_NAME)), `桌面上没有快捷方式，安装器输出：\n${res.text}`);
  } else {
    assert.match(res.stdout, /没能创建桌面快捷方式/, res.text);
    // 只核对结尾：临时目录在 CI 上可能是短路径（RUNNER~1），安装器输出的是长路径。
    const startLine = res.stdout.split(/\r?\n/).find((line) => line.includes("启动方法：双击 "));
    assert.ok(startLine?.trim().endsWith(path.join(path.basename(app), "start-console.cmd")), res.text);
  }
  env.CWB_TEST_ENTRY = path.join(app, "start-console.cmd");
  res = await run("cmd.exe", ["/d", "/v:on", "/c", 'chcp 936>nul & "!CWB_TEST_ENTRY!" --no-open'], { env, verbatim: true });
  assert.equal(res.code, 0, res.text);
  assert.deepEqual(stubLaunchOutput(res).argv, ["--no-open"]);
}

test("Windows CP936 + LF + 带括号/感叹号/& 路径的 ZIP 原地安装和启动", { skip: WINDOWS_ONLY }, async t => {
  await installInPlaceCp936(t, { appName: "zhang san (lab)! & tools", desktopName: "desktop (1)! & test" });
});

// 快捷方式用 WScript.Shell 建，TargetPath 里有当前系统代码页表示不了的字符时它抛「Value does not fall within
// the expected range」。中文 Windows（936）能表示汉字，必须建出快捷方式；英文系统的 CI runner（1252）上建不出来，
// 这时要求安装器给出警告与兜底的启动路径，后半段从含汉字目录启动照样要测。
test("Windows CP936：路径里还有汉字时同样能原地安装和启动", { skip: WINDOWS_ONLY }, async t => {
  await installInPlaceCp936(t, { appName: "张三 (实验)! & tools", desktopName: "桌面 (1)! & test", shortcut: systemAnsiCodePage() === 936 });
});

test("install-workbench.cmd：系统版本/架构闸门、磁盘与安装位置告警、PAC 代理、首次运行提示、自检入口都在", () => {
  // .cmd 的真实分支只在 Windows 上跑：这些静态断言防止加固过的提示以后被改掉。
  // A. 系统版本与架构预检：Node.js 22 起只支持 Windows 10 1809（build 17763）及以上
  assert.match(cmdText, /HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion/);
  assert.match(cmdText, /CurrentBuildNumber/);
  assert.match(cmdText, /CurrentMajorVersionNumber/);
  assert.match(cmdText, /ProductName/);
  assert.match(cmdText, /17763/, "系统太旧的闸门要看 build 17763");
  assert.match(cmdText, /Node\.js 22 起只支持 Windows 10 1809/);
  assert.match(cmdText, /自己去 https:\/\/nodejs\.org 装 Node\.js 也起不来/);
  assert.match(cmdText, /32 位 Windows 没有对应的 Node\.js 预编译包/);
  // B. 磁盘空间：需要约 1 GB，可用空间低于 1024 MB 就停下
  assert.match(cmdText, /System\.IO\.DriveInfo/);
  assert.match(cmdText, /1 GB 空闲空间/);
  assert.match(cmdText, /-ge 1024\b/);
  // C. 安装位置告警（只告警）：Downloads 会被「存储感知」清理，OneDrive 会把 node.exe 变成在线占位
  assert.match(cmdText, /Downloads/);
  assert.match(cmdText, /OneDrive/);
  assert.match(cmdText, /set CWB_INSTALL_DIR=C:\\cluster-workbench/);
  // D. 代理：PAC（AutoConfigURL）提示 + netsh winhttp 作为 ProxyServer 之外的第二来源
  assert.match(cmdText, /AutoConfigURL/);
  assert.match(cmdText, /winhttp show proxy/);
  assert.match(cmdText, /set HTTPS_PROXY=http:\/\/127\.0\.0\.1:7890/);
  assert.match(cmdText, /git config --global http\.proxy/);
  // E. 首次运行：SmartScreen 蓝色窗口与安全软件拦截
  assert.match(cmdText, /Windows 已保护你的电脑/);
  assert.match(cmdText, /仍要运行/);
  assert.match(cmdText, /360 \/ 火绒/);
  // F. 收尾指向自检脚本，路径契约逐字
  assert.match(cmdText, /install\\diagnose-workbench\.cmd/);
  assert.match(cmdText, /把桌面上生成的报告发给维护者/);
  // G. 引导用户 set 环境变量之后，就不能再叫他「重新双击安装器」：set 只作用于当前窗口，
  //    新进程里没有这个变量，照做会再失败一次、而且看不出原因。仓库里早已验证过的正确
  //    写法是「把安装器拖进那个窗口回车」（见同文件里换安装目录那条）。真实场景两个：
  //    磁盘空间不够要换 CWB_INSTALL_DIR、PAC 代理要设 HTTPS_PROXY。
  assert.doesNotMatch(cmdText, /set (CWB_INSTALL_DIR|HTTPS?_PROXY)=[^\r\n]*重新双击/);
  assert.match(cmdText, /先执行下面两行[^\r\n]*再把安装器拖进那个窗口回车/, "PAC 分支必须让用户在当前窗口里运行安装器");
  for (const line of cmdText.split(/\r?\n/)) {
    if (/set CWB_INSTALL_DIR=/.test(line)) {
      assert.match(line, /拖进/, `set CWB_INSTALL_DIR 之后必须让用户在当前窗口里运行安装器：${line.trim()}`);
    }
  }

  // 新函数都要先定义、再在主流程里被调用；顺序是「首次运行提示 → 系统预检 → 安装位置 → 磁盘 → SSH → git → Node」。
  const callAt = (name) => {
    assert.match(cmdText, new RegExp(`^function ${name} \\{`, "m"), `${name} 必须先定义`);
    const call = cmdText.match(new RegExp(`^\\s+${name}\\r?$`, "m"));
    assert.ok(call, `${name} 必须在主流程里被调用`);
    return call.index;
  };
  const mainOrder = ["Show-FirstRunNotice", "Confirm-SystemSupport", "Confirm-InstallDir", "Confirm-InstallLocation", "Confirm-DiskSpace", "Confirm-Ssh", "Confirm-Git", "Confirm-Node"];
  const positions = mainOrder.map(callAt);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "主流程调用顺序变了：系统预检必须在准备 Node.js 之前");
  assert.match(cmdText, /^\s+Show-PacProxyHint\r?$/m, "git 连不上时要能提示 PAC 代理");
});

test("start-console.cmd：全文纯 ASCII、无 BOM、不用标签（防中文 Windows CP936 切 chcp 65001 后字节偏移错位秒退）", () => {
  const startCmdPath = path.join(rootDir, "start-console.cmd");
  const bytes = fs.readFileSync(startCmdPath);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "start-console.cmd 不能带 BOM");
  const text = bytes.toString("utf8");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 严格校验全文纯 ASCII
  assert.ok(/^[\x00-\x7f]*$/.test(text), "start-console.cmd 必须 100% 纯 ASCII，不能含任何中文或 UTF-8 多字节字符");
  const lines = text.split(/\r?\n/);
  assert.ok(!lines.some((line) => /^\s*:[A-Za-z]|\bgoto\b|\bcall\s+:/i.test(line)), "start-console.cmd 不要用标签和 goto（兼容 LF 副本）");
});

test("稳定版分支：两个安装器与自更新是同一个分支名；都是克隆完再看本地的 origin/stable、一步对一步；更新那一支没动", () => {
  assert.equal(shText.match(/^STABLE_BRANCH="([a-z]+)"$/m)?.[1], STABLE_BRANCH, "install-workbench.sh 的 STABLE_BRANCH 要与 channel.mjs 一致");
  assert.equal(cmdText.match(/^\$StableBranch = '([a-z]+)'\r?$/m)?.[1], STABLE_BRANCH, "install-workbench.cmd 的 $StableBranch 要与 channel.mjs 一致");

  // 函数体：从定义那一行到顶格的 }。
  const body = (text, head) => {
    const lines = text.split(/\r?\n/);
    const start = lines.indexOf(head);
    assert.ok(start >= 0, `没找到 ${head}`);
    return lines.slice(start, lines.indexOf("}", start) + 1).join("\n");
  };
  const gitSteps = (text) => [...text.matchAll(/git -C \S+ ([a-z-]+(?: --?[a-z-]+)*)/g)].map((match) => match[1]);
  const shSwitch = body(shText, "use_stable_branch() {");
  const cmdSwitch = body(cmdText, "function Switch-ToStableBranch {");
  // 看当前分支 → 看本地有没有 origin/<稳定版> → 建一条跟着它的同名分支并切过去。两边是同样的三条 git、同样的先后。
  assert.deepEqual(gitSteps(shSwitch), ["symbolic-ref --short -q", "rev-parse --verify -q", "checkout -q -b"]);
  assert.deepEqual(gitSteps(cmdSwitch), gitSteps(shSwitch), ".cmd 要与 .sh 逐步对应");
  for (const text of [shSwitch, cmdSwitch]) {
    assert.match(text, /refs\/remotes\/origin\//, "看的是 clone 记下来的远端分支");
    assert.match(text, /--track/, "新建的本地分支要跟着远端那条：重跑安装器的 git pull --ff-only 靠它");
    assert.match(text, /npm run update -- --channel/, "没切成时要说之后怎么切");
  }
  // 克隆之前不多联网：私有仓库会因此多问一遍账号，连不上时还多一种失败。两个安装器里都不该出现 ls-remote。
  assert.doesNotMatch(shText, /ls-remote/);
  assert.doesNotMatch(cmdText, /ls-remote/);

  // 调用只有一处：克隆成功之后、认目录之前（所以「已下载到 …（v…）」报的是稳定版的版本）。
  const shClone = body(shText, "clone_workbench() {");
  const cmdClone = body(cmdText, "function Get-Workbench {");
  assert.equal(shText.match(/^\s+use_stable_branch$/gm)?.length, 1);
  assert.equal(cmdText.match(/^\s+Switch-ToStableBranch\r?$/gm)?.length, 1);
  const inOrder = (text, parts) => parts.map((part) => text.indexOf(part)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]));
  assert.ok(inOrder(shClone, ["git clone", "\n  done\n", "\n  use_stable_branch\n", "classify_install_dir"]), "install-workbench.sh：克隆循环 → 切稳定版 → 认目录");
  assert.ok(inOrder(cmdClone, ["@('clone', $RepoUrl, $InstallDir)", "\n  Switch-ToStableBranch\n", "Get-InstallDirKind $InstallDir"]), "install-workbench.cmd：克隆循环 → 切稳定版 → 认目录");

  // 重复运行（已有安装）那一支只做 git pull --ff-only，跟的是当前分支的上游：不碰分支。
  for (const update of [body(shText, "update_workbench() {"), body(cmdText, "function Update-Workbench {")]) {
    assert.match(update, /pull['", ]+--ff-only/);
    assert.doesNotMatch(update, /checkout|stable/i);
  }
});

test("bash 脚本：变量后面紧跟中文时必须加花括号", () => {
  // macOS 自带的 bash 3.2 会把汉字的第一个字节并进变量名（"$VERSION，" 读成另一个不存在的变量，set -u 下直接报错退出）。
  for (const name of ["start.sh", path.join("install", "install-workbench.sh")]) {
    const offenders = read(name).split("\n")
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !/^\s*#/.test(line) && /\$[A-Za-z_][A-Za-z0-9_]*[^\x20-\x7e\s]/.test(line))
      .map(({ line, index }) => `${name}:${index + 1}: ${line.trim()}`);
    assert.deepEqual(offenders, [], "这些行里的变量要加花括号");
  }
});

test("bash -n：安装器与启动脚本没有语法错误", { skip: POSIX_ONLY }, () => {
  for (const file of [SH_INSTALLER, path.join(rootDir, "start.sh")]) {
    execFileSync("bash", ["-n", file], { stdio: ["ignore", "pipe", "pipe"] });
  }
  // macOS 自带的 bash 是 3.2：有它就再过一遍。
  if (isMac && fs.existsSync("/bin/bash")) {
    for (const file of [SH_INSTALLER, path.join(rootDir, "start.sh")]) execFileSync("/bin/bash", ["-n", file], { stdio: ["ignore", "pipe", "pipe"] });
  }
});

// ---------------------------------------------------------------------------
// 沙箱夹具
// ---------------------------------------------------------------------------
// 不读这台机器上的 git 配置：全局配置指到一个空文件（不能用 os.devNull，Windows 上 git 读不了 \\.\nul）。
const EMPTY_GIT_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cwb-installer-gitconfig-")), "gitconfig");
fs.writeFileSync(EMPTY_GIT_CONFIG, "");
after(() => fs.rmSync(path.dirname(EMPTY_GIT_CONFIG), { recursive: true, force: true }));

// 以当前环境为底：去掉代理变量（本机 HTTP 夹具不能被代理接走）、去掉外面带进来的 CWB_ / GIT_ 变量，再叠上覆盖项。
// Windows 的环境变量名不分大小写（PATH 实际叫 Path）：覆盖前先把同名的各种写法删掉。值为 undefined 表示删除。
function buildEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(https?|all|ftp|no)_proxy$/i.test(key) || /^(CWB|GIT)_/i.test(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (isWindows) {
      for (const existing of Object.keys(env)) if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    }
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

const GIT_ENV = buildEnv({
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
});
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", ...args], { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const pkgVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;

// 桩 launch.mjs：只打印一行（参数、是否经私有 Node 启动、实际的 node 路径）就退出，什么都不启动。
const STUB_LAUNCH = `console.log(${JSON.stringify(STUB_MARKER)} + JSON.stringify({ argv: process.argv.slice(2), privateNode: process.env.CWB_TEST_PRIVATE_NODE ?? null, execPath: process.execPath }));\n`;

function writeWorkbenchFiles(dir, version) {
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "codex-tunnel-monitor", version, type: "module" }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "scripts", "launch.mjs"), STUB_LAUNCH);
  // 两个启动脚本用仓库里的真文件：测的就是它们的私有 Node 回退。
  fs.copyFileSync(path.join(rootDir, "start.sh"), path.join(dir, "start.sh"));
  fs.copyFileSync(path.join(rootDir, "start-console.cmd"), path.join(dir, "start-console.cmd"));
}

function publish(ctx, version) {
  writeWorkbenchFiles(ctx.pub, version);
  git(ctx.pub, "add", "-A");
  git(ctx.pub, "commit", "-q", "-m", `v${version}`);
  git(ctx.pub, "push", "-q", "origin", "main");
}

// → 沙箱：远端裸仓库（已发布 v1.0.0）+ 假 HOME（含 Desktop、Downloads；安装器拷进 Downloads，像同事收到文件那样单独运行）。
function makeSandbox(t, { lineEndings } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cwb-installer-test-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const ctx = {
    base,
    remote: path.join(base, "remote.git"),
    pub: path.join(base, "publisher"),
    home: path.join(base, "home"),
    desktop: path.join(base, "home", "Desktop"),
    localAppData: path.join(base, "home", "AppData", "Local"),
    installDir: path.join(base, "home", "cluster-workbench"),
  };
  fs.mkdirSync(ctx.remote);
  git(ctx.remote, "init", "-q", "--bare", "-b", "main");
  git(base, "clone", "-q", ctx.remote, ctx.pub);
  git(ctx.pub, "checkout", "-q", "-b", "main");
  publish(ctx, "1.0.0");
  for (const dir of [ctx.desktop, ctx.localAppData, path.join(ctx.home, "Downloads")]) fs.mkdirSync(dir, { recursive: true });
  ctx.privateRoot = isWindows ? path.join(ctx.localAppData, "cluster-workbench") : path.join(ctx.home, ".cluster-workbench");
  ctx.privateNode = isWindows ? path.join(ctx.privateRoot, "node", "node.exe") : path.join(ctx.privateRoot, "node", "bin", "node");
  ctx.launcher = path.join(ctx.desktop, isWindows ? SHORTCUT_NAME : LAUNCHER_NAME);
  ctx.installer = path.join(ctx.home, "Downloads", path.basename(isWindows ? CMD_INSTALLER : SH_INSTALLER));
  let text = fs.readFileSync(isWindows ? CMD_INSTALLER : SH_INSTALLER, "utf8");
  if (lineEndings === "lf") text = text.replace(/\r\n/g, "\n");
  fs.writeFileSync(ctx.installer, text);
  return ctx;
}

function sandboxEnv(ctx, extra = {}) {
  return buildEnv({
    NO_PROXY: "127.0.0.1,localhost",
    GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    HOME: ctx.home,
    USERPROFILE: ctx.home,
    LOCALAPPDATA: ctx.localAppData,
    // 默认把「系统 Node」定为跑测试的这个 node（一定在支持范围内）；要测私有 Node 的用例再往前面插桩。
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    CWB_INSTALL_DIR: ctx.installDir,
    CWB_DESKTOP_DIR: ctx.desktop,
    CWB_REPO_URL: ctx.remote,
    CWB_INSTALL_NO_LAUNCH: "1",
    CWB_INSTALL_NO_PAUSE: "1",
    // 下载源默认指向本机一个没人监听的端口：哪条用例意外走到下载，也不会碰真实网络。
    CWB_NODE_DIST_BASE: "http://127.0.0.1:9/unused",
    CWB_NODE_DIST_MIRROR: "http://127.0.0.1:9/unused",
    ...extra,
  });
}

// verbatim：参数按原样拼成命令行交给 cmd.exe。默认情况下 Node 会把参数里的双引号转义成 \"，而 cmd 不认这种
// 转义——`"!CWB_TEST_ENTRY!"` 就成了文件名两头带反斜杠和引号，「不是内部或外部命令」。
function run(command, args, { env, cwd, timeoutMs = 180_000, verbatim = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: verbatim });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, text: `${stdout}\n${stderr}` }); });
  });
}

// 每次运行安装器都经这里：CWB_INSTALL_NO_LAUNCH=1 由 sandboxEnv 固定带上。
function runInstaller(ctx, extra = {}) {
  const env = sandboxEnv(ctx, extra);
  assert.equal(env.CWB_INSTALL_NO_LAUNCH, "1");
  return isWindows ? run("cmd.exe", ["/d", "/c", ctx.installer], { env, cwd: ctx.home }) : run("bash", [ctx.installer], { env, cwd: ctx.home });
}

// 桩 launch.mjs 打印的那一行 → 对象。
function stubLaunchOutput(result) {
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith(STUB_MARKER));
  assert.ok(line, `启动脚本没有走到 scripts/launch.mjs：\n${result.text}`);
  return JSON.parse(line.slice(STUB_MARKER.length));
}

// 假命令目录（放在 PATH 最前）。POSIX 写 sh 脚本，Windows 写 .cmd。
function fakeBin(t, scripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-installer-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(scripts)) {
    if (isWindows) fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n${body}\r\n`);
    else fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return dir;
}
const pathWith = (dir) => `${dir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`;
// 版本不在支持范围内的「系统 Node」。
const oldNode = (t) => fakeBin(t, { node: "echo v18.19.0" });

function which(name) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* 下一个目录 */ }
  }
  return null;
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// 只存不压的最小 zip（本地文件头 + 中央目录 + 结尾记录），.NET 的 ZipFile 读得了。只有 Windows 半边用。
function makeZip(entries) {
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// POSIX 上充当私有 Node 的壳脚本：带上 CWB_TEST_PRIVATE_NODE=1 再转给跑测试的这个 node——桩 launch.mjs 据此认出「是经私有 Node 启动的」。
const PRIVATE_NODE_WRAPPER = `#!/bin/sh\nCWB_TEST_PRIVATE_NODE=1\nexport CWB_TEST_PRIVATE_NODE\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`;

// 假的 Node 发行包，形状与官方的一致（顶层一个 node-v版本-平台 目录）。
//   POSIX：bin/node 是上面那个壳脚本。
//   Windows：node.exe 就是跑测试的这个 node.exe 的副本。
function makeNodeArchive(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-installer-node-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const top = `node-v${pinnedSh}-${isWindows ? "win" : process.platform}-${process.arch}`;
  let file;
  if (isWindows) {
    file = path.join(dir, `${top}.zip`);
    fs.writeFileSync(file, makeZip([{ name: `${top}/node.exe`, data: fs.readFileSync(process.execPath) }]));
  } else {
    fs.mkdirSync(path.join(dir, top, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, top, "bin", "node"), PRIVATE_NODE_WRAPPER, { mode: 0o755 });
    file = path.join(dir, `${top}.tar.gz`);
    execFileSync("tar", ["-czf", file, "-C", dir, top], { stdio: ["ignore", "pipe", "pipe"] });
  }
  return { file, sha256: sha256(file) };
}

// 本机 HTTP 夹具：/good/ 下任何路径都回那个发行包，其余 404。hits 记下被请求过的路径。
async function startDist(t, archive) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (!req.url.startsWith("/good/")) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": fs.statSync(archive.file).size });
    fs.createReadStream(archive.file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { hits, good: `${base}/good`, missing: `${base}/missing` };
}

// ---------------------------------------------------------------------------
// POSIX：bash 安装器
// ---------------------------------------------------------------------------
test("bash 安装器：全新安装（系统 Node 合格）→ 真的 git clone、桌面图标、不下载 Node、不启动；重跑走 git pull", { skip: POSIX_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  let res = await runInstaller(ctx);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /目录还不存在，稍后新建/);
  assert.match(res.stdout, /系统已有 Node\.js v\d+\.\d+\.\d+，直接使用/);
  assert.match(res.stdout, /已下载到 .*（v1\.0\.0）/);
  assert.match(res.stdout, /安装完成。/);
  assert.match(res.stdout, /这次没有启动工作台/);
  assert.doesNotMatch(res.stdout, /正在启动工作台/);
  assert.equal(pkgVersion(ctx.installDir), "1.0.0");
  assert.equal(git(ctx.installDir, "rev-parse", "--is-inside-work-tree"), "true", "必须是真正的 git clone，自动更新靠 git pull");
  assert.equal(git(ctx.installDir, "remote", "get-url", "origin"), ctx.remote);
  assert.equal(fs.existsSync(ctx.privateRoot), false, "系统 Node 合格时不该下载私有 Node");
  assert.equal(fs.existsSync(path.join(ctx.installDir, "node_modules")), false, "安装器不执行 npm install");

  if (isMac) {
    const launcher = fs.readFileSync(ctx.launcher, "utf8");
    assert.ok(fs.statSync(ctx.launcher).mode & 0o111, "桌面图标要有可执行位，双击才会运行");
    assert.match(launcher, /cluster-workbench-installer: managed launcher/);
    assert.ok(launcher.includes(`START_SCRIPT='${path.join(ctx.installDir, "start.sh")}'`), launcher);
    execFileSync("/bin/bash", ["-n", ctx.launcher]);
    assert.equal(res.stdout.match(/npm install/g)?.length, 1, "结尾只用一行提到 npm install");
    assert.match(res.stdout, /可选：想要独立的桌面窗口而不是浏览器标签页，之后在安装目录里执行一次 npm install$/m);
    // 双击桌面图标 → 安装目录的 start.sh → scripts/launch.mjs（这里是桩），参数原样传到。
    const started = await run("/bin/bash", [ctx.launcher, "--web"], { env: sandboxEnv(ctx) });
    assert.equal(started.code, 0, started.text);
    assert.deepEqual(stubLaunchOutput(started), { argv: ["--web"], privateNode: null, execPath: fs.realpathSync(process.execPath) });
  } else {
    assert.equal(fs.existsSync(ctx.launcher), false);
    assert.match(res.stdout, /Linux 上不放桌面图标。启动命令：bash .*start\.sh/);
    assert.doesNotMatch(res.stdout, /npm install/);
  }

  // 重跑、远端没有新提交：认出已有的安装，只 pull，不重新 clone。
  const untracked = path.join(ctx.installDir, "我的笔记.txt");
  fs.writeFileSync(untracked, "别动我\n");
  const head = git(ctx.installDir, "rev-parse", "HEAD");
  res = await runInstaller(ctx);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /这里已经装过工作台（v1\.0\.0），这次只更新到最新版本/);
  assert.match(res.stdout, /已经是最新版本（v1\.0\.0）/);
  assert.doesNotMatch(res.stdout, /正在下载/);
  assert.equal(git(ctx.installDir, "rev-parse", "HEAD"), head);

  // 发布方推了新版本：重跑快进到新版本；安装目录里自己的文件原样留着。
  publish(ctx, "1.1.0");
  res = await runInstaller(ctx);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /已更新到最新版本（v1\.1\.0）/);
  assert.match(res.stdout, /关掉它的窗口再重新打开，新版本才会生效/);
  assert.equal(pkgVersion(ctx.installDir), "1.1.0");
  assert.equal(git(ctx.installDir, "rev-parse", "HEAD"), git(ctx.pub, "rev-parse", "HEAD"));
  assert.equal(fs.readFileSync(untracked, "utf8"), "别动我\n");

  // 远端连不上（地址失效）：不算安装失败，沿用现有版本并说明原因。
  git(ctx.installDir, "remote", "set-url", "origin", path.join(ctx.base, "gone.git"));
  res = await runInstaller(ctx);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /没能更新到最新版本，继续使用现有的这一份（v1\.1\.0）/);
  assert.match(res.stdout, /和 CWB_REPO_URL 不一样；没有改动它/);
  assert.equal(git(ctx.installDir, "remote", "get-url", "origin"), path.join(ctx.base, "gone.git"), "安装器不擅自改更新来源");
});

// 发布方推进稳定版：把远端的 stable 指到发布方当前的提交（第一次即创建）。远端是沙箱里的裸仓库。
const promoteStable = (ctx) => git(ctx.pub, "push", "-q", "origin", `HEAD:refs/heads/${STABLE_BRANCH}`);
const currentBranch = (dir) => git(dir, "rev-parse", "--abbrev-ref", "HEAD");

test("bash 安装器：远端有稳定版分支 → 新装的这一份在 stable 上并跟着它；重跑不把 main 上的新版本拉下来，发布方推进后才更新", { skip: POSIX_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  promoteStable(ctx); // 稳定版停在 v1.0.0
  publish(ctx, "1.1.0"); // 发布方照常在 main 上往前走
  let res = await runInstaller(ctx);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /远端有稳定版分支，这一份跟稳定版（stable）：发布方确认过的版本才会收到。/);
  assert.match(res.stdout, /已下载到 .*（v1\.0\.0）/, "报的是稳定版的版本，不是 main 上最新的");
  assert.match(res.stdout, /安装完成。/);
  assert.doesNotMatch(res.text, /没能切到稳定版分支/);
  assert.equal(currentBranch(ctx.installDir), "stable");
  assert.equal(git(ctx.installDir, "rev-parse", "--abbrev-ref", "stable@{upstream}"), "origin/stable", "本地的 stable 跟着远端那条");
  assert.equal(pkgVersion(ctx.installDir), "1.0.0");
  assert.equal(git(ctx.installDir, "rev-parse", "HEAD"), git(ctx.pub, "rev-parse", "HEAD~1"));
  assert.equal(git(ctx.installDir, "status", "--porcelain"), "", "切完是干净的工作区");
  assert.equal(git(ctx.installDir, "remote", "get-url", "origin"), ctx.remote);

  // 重跑：git pull --ff-only 跟的是当前分支的上游，main 上的 v1.1.0 不会被拉下来；已有的安装不再提通道。
  res = await runInstaller(ctx);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /这里已经装过工作台（v1\.0\.0），这次只更新到最新版本/);
  assert.match(res.stdout, /已经是最新版本（v1\.0\.0）/);
  assert.doesNotMatch(res.stdout, /稳定版/);
  assert.deepEqual([currentBranch(ctx.installDir), pkgVersion(ctx.installDir)], ["stable", "1.0.0"]);

  // 发布方确认 v1.1.0 没问题，推进稳定版：重跑才快进过去，仍在 stable 上。
  promoteStable(ctx);
  res = await runInstaller(ctx);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /已更新到最新版本（v1\.1\.0）/);
  assert.deepEqual([currentBranch(ctx.installDir), pkgVersion(ctx.installDir)], ["stable", "1.1.0"]);

  // 远端的默认分支本身就是 stable：克隆下来已经在它上面，不用再切，也不该报「没能切到」。
  git(ctx.remote, "symbolic-ref", "HEAD", `refs/heads/${STABLE_BRANCH}`);
  const second = path.join(ctx.home, "second");
  res = await runInstaller(ctx, { CWB_INSTALL_DIR: second });
  assert.equal(res.code, 0, res.text);
  assert.doesNotMatch(res.text, /没能切到稳定版分支/);
  assert.deepEqual([currentBranch(second), pkgVersion(second)], ["stable", "1.1.0"]);
});

test("bash 安装器：远端没有稳定版分支 → 与以前一样留在默认分支，不提通道；有但切不过去 → 留在默认分支并说明，不算安装失败", { skip: POSIX_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  let res = await runInstaller(ctx);
  assert.equal(res.code, 0, res.text);
  assert.doesNotMatch(res.text, /稳定版|--channel/);
  assert.equal(currentBranch(ctx.installDir), "main");
  assert.equal(git(ctx.installDir, "for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/main", "本地只有默认分支");
  assert.match(res.stdout, /已下载到 .*（v1\.0\.0）/);

  // 远端有稳定版（v1.0.0），main 已经到 v1.1.0；假 git 让切分支那一步失败（磁盘满之类），其余命令照常。
  promoteStable(ctx);
  publish(ctx, "1.1.0");
  const failingCheckout = fakeBin(t, { git: `if [ "$3" = "checkout" ]; then echo "error: unable to create file app.txt: No space left on device" >&2; exit 1; fi\nexec "${which("git")}" "$@"` });
  const other = path.join(ctx.home, "other");
  res = await runInstaller(ctx, { CWB_INSTALL_DIR: other, PATH: pathWith(failingCheckout) });
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /没能切到稳定版分支（stable），这一份留在默认分支上：发布方每次推送都会收到。/);
  assert.match(res.stdout, /之后想换到稳定版，在安装目录里执行：npm run update -- --channel stable/);
  assert.doesNotMatch(res.stdout, /这一份跟稳定版/);
  assert.match(res.stdout, /已下载到 .*（v1\.1\.0）/);
  assert.match(res.stdout, /安装完成。/);
  assert.deepEqual([currentBranch(other), pkgVersion(other)], ["main", "1.1.0"]);
});

test("bash 安装器：安装位置已有别的东西 → 停下，不删不改；空目录可以直接装", { skip: POSIX_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  const snapshot = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

  // 普通文件夹
  fs.mkdirSync(ctx.installDir);
  fs.writeFileSync(path.join(ctx.installDir, "论文.txt"), "mine\n");
  let res = await runInstaller(ctx);
  assert.equal(res.code, 1, res.text);
  assert.match(res.stderr, /这个位置已经有别的东西，不是集群运维工作台/);
  assert.match(res.stderr, /安装器不会删除或覆盖它，什么都没有改动/);
  assert.match(res.stderr, /CWB_INSTALL_DIR=/);
  assert.deepEqual(snapshot(ctx.installDir), ["论文.txt"]);
  assert.equal(fs.readFileSync(path.join(ctx.installDir, "论文.txt"), "utf8"), "mine\n");
  assert.equal(fs.existsSync(ctx.launcher), false, "没装成就不该放桌面图标");
  assert.equal(fs.existsSync(ctx.privateRoot), false);

  // 别的项目的 git 仓库（有 .git、有 package.json，但不是工作台）
  const other = path.join(ctx.home, "other-project");
  fs.mkdirSync(other);
  git(other, "init", "-q");
  fs.writeFileSync(path.join(other, "package.json"), `${JSON.stringify({ name: "something-else", version: "9.9.9" })}\n`);
  const before = snapshot(other);
  res = await runInstaller(ctx, { CWB_INSTALL_DIR: other });
  assert.equal(res.code, 1, res.text);
  assert.match(res.stderr, /不是集群运维工作台/);
  assert.deepEqual(snapshot(other), before);

  // 同名的是个文件
  const file = path.join(ctx.home, "a-file");
  fs.writeFileSync(file, "x");
  res = await runInstaller(ctx, { CWB_INSTALL_DIR: file });
  assert.equal(res.code, 1, res.text);
  assert.equal(fs.readFileSync(file, "utf8"), "x");

  // 空目录：直接装进去
  const empty = path.join(ctx.home, "空 目录");
  fs.mkdirSync(empty);
  res = await runInstaller(ctx, { CWB_INSTALL_DIR: empty });
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /目录是空的，直接装在里面/);
  assert.equal(pkgVersion(empty), "1.0.0");
});

test("bash 安装器：系统 Node 不合格 → 下载私有 Node（主源失败换镜像，校验通过才解压）；启动脚本回退到它；重跑不再下载", { skip: POSIX_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  const archive = makeNodeArchive(t);
  const dist = await startDist(t, archive);
  const extra = { PATH: pathWith(oldNode(t)), CWB_NODE_DIST_BASE: dist.missing, CWB_NODE_DIST_MIRROR: dist.good, CWB_NODE_SHA256: archive.sha256 };

  let res = await runInstaller(ctx, extra);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /系统的 Node\.js v18\.19\.0 不在支持范围内/);
  assert.match(res.stdout, /不需要管理员权限，不改系统的 Node 和 PATH/);
  assert.match(res.stdout, /这个地址没有下载下来/);
  assert.match(res.stdout, /校验通过（SHA-256 与安装器里记录的一致）/);
  assert.match(res.stdout, /私有 Node\.js v\d+\.\d+\.\d+ 已就绪/);
  assert.equal(dist.hits.length, 2, "先官方站、再镜像，各请求一次");
  assert.match(dist.hits[0], new RegExp(`^/missing/v${pinnedSh.replaceAll(".", "\\.")}/node-v${pinnedSh.replaceAll(".", "\\.")}-(darwin|linux)-(arm64|x64)\\.tar\\.gz$`));
  assert.equal(dist.hits[1], dist.hits[0].replace("/missing/", "/good/"));
  assert.ok(fs.statSync(ctx.privateNode).mode & 0o111);
  assert.deepEqual(fs.readdirSync(ctx.privateRoot), ["node"], "下载暂存目录用完要清掉");
  assert.equal(pkgVersion(ctx.installDir), "1.0.0");
  if (isMac) assert.match(res.stdout, /执行一次 PATH=".*\/\.cluster-workbench\/node\/bin:\$PATH" npm install$/m);

  // start.sh：PATH 里的 node 版本不合格时改用私有 Node，参数原样传给 launch.mjs。
  const env = sandboxEnv(ctx, extra);
  let started = await run("bash", [path.join(ctx.installDir, "start.sh"), "--no-open"], { env });
  assert.equal(started.code, 0, started.text);
  assert.deepEqual(stubLaunchOutput(started), { argv: ["--no-open"], privateNode: "1", execPath: fs.realpathSync(process.execPath) });
  if (isMac) {
    started = await run("/bin/bash", [ctx.launcher], { env });
    assert.equal(started.code, 0, started.text);
    assert.equal(stubLaunchOutput(started).privateNode, "1", "桌面图标 → start.sh → 私有 Node");
  }
  // 系统 Node 合格时仍然优先用系统的（私有那份只是兜底）。
  started = await run("bash", [path.join(ctx.installDir, "start.sh")], { env: sandboxEnv(ctx) });
  assert.equal(stubLaunchOutput(started).privateNode, null);

  // 重跑：私有 Node 还在，直接用，不再请求下载。
  res = await runInstaller(ctx, extra);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /上次装好的私有 Node\.js v\d+\.\d+\.\d+ 还在，直接使用/);
  assert.equal(dist.hits.length, 2);

  // 私有 Node 坏了（文件还在但跑不起来）：重新下载并换掉。
  fs.writeFileSync(ctx.privateNode, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  res = await runInstaller(ctx, { ...extra, CWB_NODE_DIST_BASE: dist.good });
  assert.equal(res.code, 0, res.text);
  assert.equal(dist.hits.length, 3);
  assert.deepEqual(fs.readdirSync(ctx.privateRoot), ["node"]);
  started = await run("bash", [path.join(ctx.installDir, "start.sh")], { env });
  assert.equal(stubLaunchOutput(started).privateNode, "1");
});

test("bash 安装器：下载到的 Node 校验值不对 → 拒绝，不解压、不安装、不留半成品", { skip: POSIX_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  const archive = makeNodeArchive(t);
  const dist = await startDist(t, archive);
  const extra = { PATH: pathWith(oldNode(t)), CWB_NODE_DIST_BASE: dist.good, CWB_NODE_DIST_MIRROR: dist.good };

  // 期望值与文件对不上
  let res = await runInstaller(ctx, { ...extra, CWB_NODE_SHA256: "0".repeat(64) });
  assert.equal(res.code, 1, res.text);
  assert.equal(res.stdout.match(/下载到的文件校验值不对，已丢弃/g)?.length, 2, "两个源都试过、都被拒");
  assert.ok(res.stdout.includes(`实际 ${archive.sha256}`));
  assert.match(res.stderr, /Node\.js 没有下载成功，什么都没有安装/);
  assert.doesNotMatch(res.stdout, /校验通过/);
  assert.deepEqual(fs.readdirSync(ctx.privateRoot), [], "没通过校验的包不能留下，更不能解压");
  assert.equal(fs.existsSync(ctx.installDir), false, "Node 没准备好就不往下装");
  assert.equal(fs.existsSync(ctx.launcher), false);

  // 不给覆盖值：用的是安装器里写死的官方校验值，夹具包自然对不上——证明默认就在校验。
  res = await runInstaller(ctx, extra);
  assert.equal(res.code, 1, res.text);
  assert.match(res.stdout, /下载到的文件校验值不对，已丢弃（期望 [0-9a-f]{64}，实际 [0-9a-f]{64}）/);
  assert.equal(fs.existsSync(ctx.privateNode), false);

  // 两个源都连不上
  res = await runInstaller(ctx, { ...extra, CWB_NODE_DIST_BASE: dist.missing, CWB_NODE_DIST_MIRROR: dist.missing });
  assert.equal(res.code, 1, res.text);
  assert.equal(res.stdout.match(/这个地址没有下载下来/g)?.length, 2);
  assert.match(res.stderr, /检查网络后重新运行本安装器/);
});

test("bash 安装器：私有仓库没权限 / 连不上 → 说清怎么登录、怎么重试，不留半截目录", { skip: POSIX_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  const realGit = which("git");
  // 假 git：clone 时照 GitHub 的原话报错，其余命令转给真 git。默认仓库地址（GitHub）不会被真的访问。
  const failingGit = (stderr) => `if [ "$1" = "clone" ]; then printf '%s\\n' ${stderr.map((line) => `"${line}"`).join(" ")} >&2; exit 128; fi\nexec "${realGit}" "$@"`;
  const repoUrl = /DEFAULT_REPO_URL="([^"]+)"/.exec(fs.readFileSync(SH_INSTALLER, "utf8"))[1];
  const authFailure = failingGit(["remote: Repository not found.", `fatal: Authentication failed for '${repoUrl}/'`]);

  // 装了 gh：引导用 gh 登录
  let res = await runInstaller(ctx, { PATH: pathWith(fakeBin(t, { git: authFailure, gh: "exit 0" })), CWB_REPO_URL: undefined });
  assert.equal(res.code, 1, res.text);
  assert.ok(res.stdout.includes(`正在下载：${repoUrl}`), res.stdout);
  assert.match(res.stdout, /没有权限下载工作台仓库（它是私有仓库）/);
  assert.match(res.stdout, /加为仓库协作者/);
  assert.match(res.stdout, /gh auth login/);
  assert.match(res.stdout, /gh auth setup-git/);
  assert.equal(fs.existsSync(ctx.installDir), false);
  assert.equal(fs.existsSync(ctx.launcher), false);

  // 没装 gh（这台机器 PATH 里本来就有 gh 时测不到这一支）：引导用 personal access token
  res = await runInstaller(ctx, { PATH: pathWith(fakeBin(t, { git: authFailure })), CWB_REPO_URL: undefined });
  assert.equal(res.code, 1, res.text);
  assert.match(res.stdout, which("gh") ? /gh auth login/ : /Password 时粘贴 personal access token/);

  // 地址里带着口令：屏幕上不打出来
  res = await runInstaller(ctx, { PATH: pathWith(fakeBin(t, { git: authFailure })), CWB_REPO_URL: "https://someone:s3cret-token@github.com/x/y.git" });
  assert.equal(res.code, 1, res.text);
  assert.doesNotMatch(res.text, /s3cret-token/);
  assert.match(res.stdout, /正在下载：https:\/\/github\.com\/x\/y\.git/);

  // 网络不通
  const offline = failingGit(["fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com"]);
  res = await runInstaller(ctx, { PATH: pathWith(fakeBin(t, { git: offline })), CWB_REPO_URL: undefined });
  assert.equal(res.code, 1, res.text);
  assert.match(res.stdout, /连不上仓库所在的服务器/);
  assert.doesNotMatch(res.stdout, /没有权限下载/);

  // 仓库地址指到一个不是工作台的仓库：下载下来了但认不出，停下并保留目录
  const otherRemote = path.join(ctx.base, "other.git");
  fs.mkdirSync(otherRemote);
  git(otherRemote, "init", "-q", "--bare", "-b", "main");
  const otherPub = path.join(ctx.base, "other-pub");
  git(ctx.base, "clone", "-q", otherRemote, otherPub);
  git(otherPub, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(otherPub, "README.md"), "not the workbench\n");
  git(otherPub, "add", "-A");
  git(otherPub, "commit", "-q", "-m", "init");
  git(otherPub, "push", "-q", "origin", "main");
  res = await runInstaller(ctx, { CWB_REPO_URL: otherRemote });
  assert.equal(res.code, 1, res.text);
  assert.match(res.stderr, /下载下来的内容不像集群运维工作台/);
  assert.equal(fs.existsSync(path.join(ctx.installDir, "README.md")), true, "认不出的目录留着，不删");
  assert.equal(fs.existsSync(ctx.launcher), false);
});

test("bash 安装器：有人守着终端时，下载失败后按回车原地重试（前面几步不重做），输入 q 则退出", { skip: isMac ? false : "靠 macOS 的 script 分配伪终端，别的平台没验证过" }, async (t) => {
  const ctx = makeSandbox(t);
  const failedOnce = path.join(ctx.base, "failed-once");
  // 假 git：第一次 clone 报没权限，之后放行。
  const bin = fakeBin(t, { git: `if [ "$1" = "clone" ] && [ ! -e '${failedOnce}' ]; then : > '${failedOnce}'; echo "fatal: Authentication failed for 'https://github.com/x/y.git/'" >&2; exit 128; fi\nexec "${which("git")}" "$@"` });
  const env = sandboxEnv(ctx, { PATH: pathWith(bin) });
  // 在伪终端里跑安装器；看到重试提问就把 answer 敲进去。
  // 前面垫一个 cat：Node 给子进程的管道其实是 socket，script 对它做 tcgetattr 会直接报错退出。
  const drive = (answer) => new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", 'cat | script -q /dev/null /bin/bash "$0"', ctx.installer], { env, cwd: ctx.home, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let answeredAt = -1;
    let closeTimer = null;
    const closeInput = () => {
      clearTimeout(closeTimer);
      if (!child.stdin.writableEnded) child.stdin.end();
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      out += chunk;
      if (answeredAt < 0 && out.includes("输入 q 再回车则退出：")) {
        // 只写答案、先不关输入：紧跟着关掉的话，script 可能还没把这一行转进伪终端就先送出了 EOF（^D），
        // 安装器读到的是「输入结束」而不是回车（macOS runner 上实测）。等伪终端把敲的字回显出来再关。
        answeredAt = out.length;
        child.stdin.write(answer);
        closeTimer = setTimeout(closeInput, 5000);
      } else if (answeredAt >= 0 && out.length > answeredAt) {
        closeInput();
      }
    });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", (error) => { clearTimeout(timer); clearTimeout(closeTimer); reject(error); });
    child.on("close", () => { clearTimeout(timer); clearTimeout(closeTimer); resolve(out.replaceAll("\r", "")); });
  });

  let out = await drive("\n");
  assert.match(out, /没有权限下载工作台仓库/);
  assert.match(out, /处理好之后按回车重试（前面几步不会重做）/);
  assert.match(out, /已下载到 .*（v1\.0\.0）/);
  assert.match(out, /安装完成。/);
  assert.equal(out.match(/\[4\/6\] 准备 Node\.js/g)?.length, 1, "重试只重做下载这一步");
  assert.equal(out.match(/正在下载：/g)?.length, 2);
  assert.equal(pkgVersion(ctx.installDir), "1.0.0");

  fs.rmSync(ctx.installDir, { recursive: true, force: true });
  fs.rmSync(failedOnce);
  out = await drive("q\n");
  assert.match(out, /没有权限下载工作台仓库/);
  assert.doesNotMatch(out, /安装完成/);
  assert.equal(fs.existsSync(ctx.installDir), false);
});

test("bash 安装器：没有可用的 git → macOS 请系统弹出命令行工具安装框，Linux 给出安装命令；都提示装完重跑", { skip: POSIX_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  const calls = path.join(ctx.base, "xcode-select.calls");
  const bin = fakeBin(t, { git: "exit 1", "xcode-select": `echo "$@" >> '${calls}'\nexit 0` });
  const res = await runInstaller(ctx, { PATH: pathWith(bin) });
  assert.equal(res.code, 1, res.text);
  assert.match(res.stderr, new RegExp(`装[完好]后重新运行本安装器：bash ${ctx.installer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  if (isMac) {
    assert.match(res.stderr, /这台 Mac 还没有 git（它包含在苹果的「命令行开发者工具」里）/);
    assert.equal(fs.readFileSync(calls, "utf8").trim(), "--install");
  } else {
    assert.match(res.stderr, /没有找到 git/);
    assert.match(res.stderr, /sudo apt install git/);
    assert.equal(fs.existsSync(calls), false);
  }
  assert.equal(fs.existsSync(ctx.installDir), false);
});

test("bash 安装器：桌面上已有同名文件但不是安装器放的 → 不覆盖；自己放的可以改写", { skip: isMac ? false : "桌面图标只在 macOS 上创建" }, async (t) => {
  const ctx = makeSandbox(t);
  fs.writeFileSync(ctx.launcher, "#!/bin/bash\necho 我自己写的\n");
  let res = await runInstaller(ctx);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /桌面上已有一个「集群运维工作台\.command」，不是本安装器放的，没有覆盖它/);
  assert.match(res.stdout, /以后启动：在终端执行 bash .*start\.sh/);
  assert.equal(fs.readFileSync(ctx.launcher, "utf8"), "#!/bin/bash\necho 我自己写的\n");

  // 安装器自己放的（带标记行）：指向旧位置的可以改写到新位置。
  fs.writeFileSync(ctx.launcher, "#!/bin/bash\n# cluster-workbench-installer: managed launcher\nSTART_SCRIPT='/old/place/start.sh'\n");
  res = await runInstaller(ctx);
  assert.equal(res.code, 0, res.text);
  assert.ok(fs.readFileSync(ctx.launcher, "utf8").includes(`START_SCRIPT='${path.join(ctx.installDir, "start.sh")}'`));

  // 安装目录带空格和单引号：写进图标的路径仍能原样读回。
  const odd = path.join(ctx.home, "it's my workbench");
  res = await runInstaller(ctx, { CWB_INSTALL_DIR: odd });
  assert.equal(res.code, 0, res.text);
  const started = await run("/bin/bash", [ctx.launcher, "--x"], { env: sandboxEnv(ctx) });
  assert.equal(started.code, 0, started.text);
  assert.deepEqual(stubLaunchOutput(started).argv, ["--x"]);

  // 安装目录后来被挪走：双击图标说清原因，而不是一闪而过。
  fs.renameSync(odd, path.join(ctx.home, "moved"));
  const broken = await run("/bin/bash", [ctx.launcher], { env: sandboxEnv(ctx) });
  assert.equal(broken.code, 1);
  assert.match(broken.stdout, /安装目录被移动或删除了/);

  // 桌面写不进去（系统没允许「终端」访问桌面文件夹）：只是没有图标，不算安装失败。
  fs.rmSync(ctx.launcher);
  fs.chmodSync(ctx.desktop, 0o555);
  try {
    res = await runInstaller(ctx);
  } finally {
    fs.chmodSync(ctx.desktop, 0o755);
  }
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /没能把图标放到桌面/);
  assert.match(res.stdout, /安装完成。/);
  assert.equal(fs.existsSync(ctx.launcher), false);
});

test("start.sh：哪里都没有 Node → 报错并指向安装器；只有私有 Node 时用它", { skip: POSIX_ONLY }, async (t) => {
  // 需要一个确定没有 node 的 PATH：系统目录里自带 node 的机器上测不了这一条。
  if (["/usr/bin/node", "/bin/node"].some((file) => fs.existsSync(file))) {
    t.skip("这台机器的 /usr/bin 或 /bin 里有 node，凑不出没有 Node 的 PATH");
    return;
  }
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cwb-installer-start-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const app = path.join(base, "app");
  const home = path.join(base, "home");
  writeWorkbenchFiles(app, "1.0.0");
  fs.mkdirSync(home);
  const env = buildEnv({ HOME: home, PATH: "/usr/bin:/bin" });

  let res = await run("/bin/bash", [path.join(app, "start.sh")], { env });
  assert.equal(res.code, 1, res.text);
  assert.match(res.stdout, /未检测到 Node\.js（需要 v22\.12\+，推荐 24）/);
  assert.match(res.stdout, /install\/install-workbench\.sh/);
  assert.doesNotMatch(res.stdout, new RegExp(STUB_MARKER));

  const privateNode = path.join(home, ".cluster-workbench", "node", "bin", "node");
  fs.mkdirSync(path.dirname(privateNode), { recursive: true });
  fs.writeFileSync(privateNode, PRIVATE_NODE_WRAPPER, { mode: 0o755 });
  res = await run("/bin/bash", [path.join(app, "start.sh"), "--web"], { env });
  assert.equal(res.code, 0, res.text);
  assert.deepEqual(stubLaunchOutput(res), { argv: ["--web"], privateNode: "1", execPath: fs.realpathSync(process.execPath) });

  // 私有 Node 版本也不合格（比如很久以前装的）：不用它，照旧报没有 Node。
  fs.writeFileSync(privateNode, "#!/bin/sh\necho v20.11.0\n", { mode: 0o755 });
  res = await run("/bin/bash", [path.join(app, "start.sh")], { env });
  assert.equal(res.code, 1, res.text);
  assert.match(res.stdout, /未检测到 Node\.js/);

  // 系统 Node 版本不合格、私有 Node 也用不了：补一句「可以跑安装器」，再照旧交给 launch.mjs 去报版本要求。
  res = await run("/bin/bash", [path.join(app, "start.sh")], { env: buildEnv({ HOME: home, PATH: `${oldNode(t)}:/usr/bin:/bin` }) });
  assert.match(res.stdout, /系统的 Node\.js 版本不在支持范围内。可以运行安装器 install\/install-workbench\.sh/);
  assert.match(res.stdout, /^v18\.19\.0$/m, "之后仍然把启动交给系统的 node（真实的 launch.mjs 会在这里报出版本要求）");
});

// ---------------------------------------------------------------------------
// Windows：.cmd 安装器（cmd 头部 + PowerShell 5.1 正文）
// ---------------------------------------------------------------------------
// OpenSSH 客户端用桩顶上：测的是安装器的流程，不依赖 runner 上装没装。
const sshStubs = { ssh: "exit /b 0", "ssh-keygen": "exit /b 0", "ssh-keyscan": "exit /b 0" };

test(".cmd 安装器：全新安装（系统 Node 不合格 → 私有 Node）、桌面快捷方式、中文输出是 UTF-8；重跑幂等；start-console.cmd 回退到私有 Node", { skip: WINDOWS_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  const archive = makeNodeArchive(t);
  const dist = await startDist(t, archive);
  const bin = fakeBin(t, { ...sshStubs, node: "echo v18.19.0" });
  const extra = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, CWB_NODE_DIST_BASE: dist.missing, CWB_NODE_DIST_MIRROR: dist.good, CWB_NODE_SHA256: archive.sha256 };

  let res = await runInstaller(ctx, extra);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /集群运维工作台 · 安装器/, "中文要按 UTF-8 原样输出");
  assert.match(res.stdout, /系统的 Node\.js v18\.19\.0 不在支持范围内/);
  assert.match(res.stdout, /这个地址没有下载下来/);
  assert.match(res.stdout, /校验通过（SHA-256 与安装器里记录的一致）/);
  assert.match(res.stdout, /私有 Node\.js v\d+\.\d+\.\d+ 已就绪/);
  assert.match(res.stdout, /已下载到 .*（v1\.0\.0）/);
  assert.match(res.stdout, /安装完成。/);
  assert.match(res.stdout, /这次没有启动工作台/);
  assert.equal(dist.hits.length, 2, "先官方站、再镜像，各请求一次");
  assert.match(dist.hits[1], new RegExp(`^/good/v${pinnedSh.replaceAll(".", "\\.")}/node-v${pinnedSh.replaceAll(".", "\\.")}-win-(x64|arm64)\\.zip$`));
  assert.ok(fs.existsSync(ctx.privateNode), "私有 Node 应当在 %LOCALAPPDATA%\\cluster-workbench\\node\\node.exe");
  assert.deepEqual(fs.readdirSync(ctx.privateRoot), ["node"], "下载暂存目录用完要清掉");
  assert.equal(pkgVersion(ctx.installDir), "1.0.0");
  assert.equal(git(ctx.installDir, "rev-parse", "--is-inside-work-tree"), "true", "必须是真正的 git clone");
  assert.equal(fs.existsSync(path.join(ctx.installDir, "node_modules")), false, "安装器不执行 npm install");
  const shortcut = fs.readFileSync(ctx.launcher);
  assert.ok(shortcut.includes(Buffer.from("start-console.cmd", "utf16le")) || shortcut.includes("start-console.cmd"), "快捷方式应当指向 start-console.cmd");
  assert.ok(shortcut.includes(Buffer.from("cluster-workbench-installer", "utf16le")) || shortcut.includes("cluster-workbench-installer"), "快捷方式备注里要有安装器的标记");

  // start-console.cmd：PATH 里没有 node 时改用私有 Node，参数原样传给 launch.mjs。
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const bare = sandboxEnv(ctx, { PATH: `${path.join(systemRoot, "System32")}${path.delimiter}${systemRoot}` });
  const started = await run("cmd.exe", ["/d", "/c", path.join(ctx.installDir, "start-console.cmd"), "--no-open"], { env: bare, cwd: ctx.home });
  const launched = stubLaunchOutput(started);
  assert.deepEqual(launched.argv, ["--no-open"]);
  assert.match(launched.execPath.toLowerCase(), /\\cluster-workbench\\node\\node\.exe$/, "应当是经私有 Node 启动的");

  // 重跑：已有安装只 pull；私有 Node 还在，不再下载；快捷方式是自己放的，可以改写。
  res = await runInstaller(ctx, extra);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /这里已经装过工作台（v1\.0\.0），这次只更新到最新版本/);
  assert.match(res.stdout, /已经是最新版本（v1\.0\.0）/);
  assert.match(res.stdout, /上次装好的私有 Node\.js v\d+\.\d+\.\d+ 还在，直接使用/);
  assert.match(res.stdout, /桌面上的「集群运维工作台」：以后双击它启动/);
  assert.equal(dist.hits.length, 2);

  publish(ctx, "1.1.0");
  res = await runInstaller(ctx, extra);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /已更新到最新版本（v1\.1\.0）/);
  assert.equal(pkgVersion(ctx.installDir), "1.1.0");
});

test(".cmd 安装器（另存成 LF 换行的副本）：安装位置已有别的东西 → 停下，不删不改", { skip: WINDOWS_ONLY }, async (t) => {
  const ctx = makeSandbox(t, { lineEndings: "lf" });
  fs.mkdirSync(ctx.installDir);
  fs.writeFileSync(path.join(ctx.installDir, "论文.txt"), "mine\n");
  const res = await runInstaller(ctx, { PATH: `${fakeBin(t, sshStubs)}${path.delimiter}${process.env.PATH}` });
  assert.equal(res.code, 1, res.text);
  assert.match(res.stdout, /这个位置已经有别的东西，不是集群运维工作台/);
  assert.match(res.stdout, /安装器不会删除或覆盖它，什么都没有改动/);
  assert.deepEqual(fs.readdirSync(ctx.installDir), ["论文.txt"]);
  assert.equal(fs.existsSync(ctx.launcher), false);
  assert.equal(fs.existsSync(ctx.privateRoot), false);
});

test(".cmd 安装器：下载到的 Node 校验值不对 → 拒绝，不解压、不安装", { skip: WINDOWS_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  const archive = makeNodeArchive(t);
  const dist = await startDist(t, archive);
  const bin = fakeBin(t, { ...sshStubs, node: "echo v18.19.0" });
  const res = await runInstaller(ctx, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, CWB_NODE_DIST_BASE: dist.good, CWB_NODE_DIST_MIRROR: dist.good, CWB_NODE_SHA256: "0".repeat(64) });
  assert.equal(res.code, 1, res.text);
  assert.equal(res.stdout.match(/下载到的文件校验值不对，已丢弃/g)?.length, 2, "两个源都试过、都被拒");
  assert.ok(res.stdout.includes(`实际 ${archive.sha256}`));
  assert.match(res.stdout, /Node\.js 没有下载成功，什么都没有安装/);
  assert.equal(fs.existsSync(ctx.privateNode), false);
  assert.deepEqual(fs.readdirSync(ctx.privateRoot), [], "没通过校验的包不能留下，更不能解压");
  assert.equal(fs.existsSync(ctx.installDir), false, "Node 没准备好就不往下装");
});

test(".cmd 安装器：系统 Node 合格就用系统的；桌面上不是自己放的同名快捷方式不覆盖", { skip: WINDOWS_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  fs.writeFileSync(ctx.launcher, "not a real shortcut");
  const res = await runInstaller(ctx, { PATH: `${fakeBin(t, sshStubs)}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` });
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /系统已有 Node\.js v\d+\.\d+\.\d+，直接使用/);
  assert.equal(fs.existsSync(ctx.privateRoot), false, "系统 Node 合格时不该下载私有 Node");
  assert.equal(pkgVersion(ctx.installDir), "1.0.0");
  assert.equal(fs.readFileSync(ctx.launcher, "utf8"), "not a real shortcut");
  assert.match(res.stdout, /以后启动：双击 .*start-console\.cmd/);
});

test(".cmd 安装器：远端有稳定版分支 → 新装的这一份在 stable 上并跟着它；重跑不把 main 上的新版本拉下来；没有稳定版分支时留在默认分支", { skip: WINDOWS_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  const extra = { PATH: `${fakeBin(t, sshStubs)}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  // 还没有稳定版分支：与以前一样留在默认分支，不提通道。
  const plain = path.join(ctx.home, "plain");
  let res = await runInstaller(ctx, { ...extra, CWB_INSTALL_DIR: plain });
  assert.equal(res.code, 0, res.text);
  assert.doesNotMatch(res.text, /稳定版|--channel/);
  assert.equal(currentBranch(plain), "main");

  promoteStable(ctx); // 稳定版停在 v1.0.0
  publish(ctx, "1.1.0"); // 发布方照常在 main 上往前走
  res = await runInstaller(ctx, extra);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /远端有稳定版分支，这一份跟稳定版（stable）：发布方确认过的版本才会收到。/);
  assert.match(res.stdout, /已下载到 .*（v1\.0\.0）/, "报的是稳定版的版本，不是 main 上最新的");
  assert.doesNotMatch(res.text, /没能切到稳定版分支/);
  assert.equal(currentBranch(ctx.installDir), "stable");
  assert.equal(git(ctx.installDir, "rev-parse", "--abbrev-ref", "stable@{upstream}"), "origin/stable");
  assert.equal(pkgVersion(ctx.installDir), "1.0.0");

  // 重跑：git pull --ff-only 跟的是当前分支的上游，main 上的 v1.1.0 不会被拉下来。
  res = await runInstaller(ctx, extra);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /已经是最新版本（v1\.0\.0）/);
  assert.deepEqual([currentBranch(ctx.installDir), pkgVersion(ctx.installDir)], ["stable", "1.0.0"]);

  promoteStable(ctx);
  res = await runInstaller(ctx, extra);
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /已更新到最新版本（v1\.1\.0）/);
  assert.deepEqual([currentBranch(ctx.installDir), pkgVersion(ctx.installDir)], ["stable", "1.1.0"]);
});

test("ZIP 压缩包解压目录（无 .git、系统无可用 git）：在解压目录内运行 install/install-workbench 自动原地配置私有 Node 与桌面图标，不尝试 git clone", { skip: POSIX_ONLY }, async (t) => {
  const ctx = makeSandbox(t);
  const archive = makeNodeArchive(t);
  const dist = await startDist(t, archive);
  const extractedDir = path.join(ctx.home, "Downloads", "codex-tunnel-monitor-main");
  writeWorkbenchFiles(extractedDir, "2.72.0");
  fs.mkdirSync(path.join(extractedDir, "install"), { recursive: true });
  const inPlaceInstaller = path.join(extractedDir, "install", "install-workbench.sh");
  fs.copyFileSync(SH_INSTALLER, inPlaceInstaller);

  // 模拟电脑上既没有可用的 git，也没有合格的系統 Node，且不传 CWB_INSTALL_DIR（靠脚本所在位置自动定位解压目录）
  const bin = fakeBin(t, { git: "exit 1", node: "echo v18.19.0" });
  const env = sandboxEnv(ctx, {
    CWB_INSTALL_DIR: undefined,
    PATH: pathWith(bin),
    CWB_NODE_DIST_BASE: dist.good,
    CWB_NODE_DIST_MIRROR: dist.good,
    CWB_NODE_SHA256: archive.sha256,
  });
  const res = await run("bash", [inPlaceInstaller], { env, cwd: extractedDir });
  assert.equal(res.code, 0, res.text);
  assert.match(res.stdout, /这里是已解压的工作台目录（v2\.72\.0），直接在此位置配置运行环境/);
  assert.match(res.stdout, /当前使用已解压的工作台压缩包，无需安装 git 即可直接运行/);
  assert.match(res.stdout, /私有 Node\.js v\d+\.\d+\.\d+ 已就绪/);
  assert.match(res.stdout, /压缩包解压模式，无需联网克隆仓库/);
  assert.match(res.stdout, /安装完成。/);
  if (isMac) {
    assert.ok(fs.existsSync(ctx.launcher));
    assert.ok(fs.readFileSync(ctx.launcher, "utf8").includes(`START_SCRIPT='${path.join(extractedDir, "start.sh")}'`));
  }
});

