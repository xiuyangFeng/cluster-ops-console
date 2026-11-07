// install/diagnose-workbench.cmd（同事一键自检脚本）的静态断言。
//
// 为什么是纯静态：这个文件只在 Windows 上双击运行，开发机是 macOS，没有 pwsh 也没有
// cmd.exe 可以试跑。所以这里守的是那些「一旦写错、在同事机器上表现为秒退或乱码」的
// 结构性质，而不是行为。四条主线：
//   1. 中文 Windows（CP936/GBK）安全：纯 ASCII、无 BOM、CRLF、不用标签/goto。
//      —— 与 start-console.cmd 同一套纪律，见 scripts/installer.test.mjs 里的同类断言。
//   2. 绝不能出现括号块：块内 %变量% 是解析期展开，值里带 ')' 的路径
//      （解压出 "…-main (1)"、OneDrive 挪过的桌面）会提前闭合块，报告被静默截断。
//   3. 每个探测都容错：缺 node / git / ssh / curl / 日志目录都不能让报告生不出来。
//   4. 脱敏是硬要求：绝不读 config.local.json、私钥、代理凭据。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_NAME = "diagnose-workbench.cmd";
const scriptPath = path.join(rootDir, "install", SCRIPT_NAME);
const bytes = fs.readFileSync(scriptPath);
// latin1 是逐字节 1:1 映射，下面「纯 ASCII」断言才有意义。
// 绝不要用 toString("ascii")：它会清掉最高位，'中' 解出来是 0x64 0x38 0x2d，断言恒真。
const text = bytes.toString("latin1");
const lines = text.split("\r\n");
const REPORT_NAME = "workbench-selfcheck.txt";
// cmd 不执行 rem 行：注释里可以随便提 goto / 括号 / config.local.json，断言只看会跑的行。
const isComment = (line) => /^\s*(rem\b|::)/i.test(line);
const codeLines = lines.map((line, index) => ({ line, number: index + 1 })).filter((entry) => !isComment(entry.line));

test("测试自身：ASCII 判定必须用 latin1，toString('ascii') 会漏掉高位", () => {
  const sneaky = Buffer.from("中文", "utf8").toString("ascii");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 这里要的就是「全部落在 ASCII 范围内」
  const asciiOnly = /^[\x00-\x7f]*$/;
  assert.ok(asciiOnly.test(sneaky), "toString('ascii') 的输出必然是「假 ASCII」——这正是它不能用的原因");
  assert.ok(!asciiOnly.test(Buffer.from("中文", "utf8").toString("latin1")), "latin1 才能如实保留字节");
});

test(`${SCRIPT_NAME}：无 BOM、CRLF、100% 纯 ASCII`, () => {
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "不能带 BOM");
  assert.ok(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 这里要的就是「全部落在 ASCII 范围内」
    /^[\x00-\x7f]*$/.test(text),
    "必须 100% 纯 ASCII：中文 Windows 的 CP936 缓冲扫描器会因 UTF-8 多字节字符算错字节偏移",
  );
  assert.equal(text.match(/\r\n/g).length, lines.length - 1, "每一行都必须以 CRLF 结束");
  assert.ok(!/(^|[^\r])\n/.test(text), "不能有裸 LF（这一条是为了 LF 副本也能跑）");
  assert.ok(!/\r(?!\n)/.test(text), "不能有裸 CR");
  assert.equal(lines[0], "@echo off", "第一行必须是 @echo off");
});

test(`${SCRIPT_NAME}：不用标签和 goto（LF 副本里 cmd 找不到标签会直接跑飞）`, () => {
  assert.ok(
    !codeLines.some(({ line }) => /^\s*:[A-Za-z]|\bgoto\b|\bcall\s+:/i.test(line)),
    "不要用标签、goto、call :label",
  );
});

test(`${SCRIPT_NAME}：会跑的行里一个圆括号都不许有（括号块 + 解析期展开 = 静默截断）`, () => {
  // 这条是 M4 的回归闸：曾经用 ( ... ) >>报告 分组写报告，路径里带 ')' 时
  // cmd 会提前闭合块，报告缺段并报 ") was unexpected at this time."。
  // 现在每一行都自带重定向、全在顶层，括号出现在值里也就无害了。
  // 唯一允许出现圆括号的是 `for` 的语法本身（`for /f … in ('…')`、`for %%a in ("…")`）：
  // 那是单行语法，不跨行累积，路径里的括号只是普通字符。块级括号一个都不许有。
  const parenOutsideForHeader = ({ line }) => {
    if (!/[()]/.test(line)) return false;
    if (!/^\s*for\s/i.test(line)) return true;
    // for 的语法括号只可能在 `do` 之前；`do` 之后还出现括号就是真问题（例如 for 行尾塞了个 echo (…)）。
    const doAt = line.toLowerCase().indexOf(" do ");
    return doAt < 0 ? true : /[()]/.test(line.slice(doAt));
  };
  const offenders = codeLines.filter(parenOutsideForHeader);
  assert.deepEqual(offenders, [], "会跑的行里不允许出现 ( 或 )：改成每行自带 >>\"%SC_REPORT%\" 2>&1 的顶层写法");
  // 顶层重定向才是本脚本的写法：报告写入口必须逐行自带，而不是靠块级重定向。
  assert.ok(!/^\s*\)\s*>>/m.test(text), "不允许出现块级重定向收尾");
  assert.ok(codeLines.filter(({ line }) => line.includes(`>>"%SC_REPORT%"`)).length >= 60, "大多数报告行都要自带重定向");
});

test(`${SCRIPT_NAME}：报告落到桌面、切 UTF-8 代码页、有 pause 与 --no-pause 逃生口`, () => {
  assert.ok(text.includes(`%SC_DESKTOP%\\${REPORT_NAME}`), `报告路径契约应当是桌面下的 ${REPORT_NAME}`);
  assert.ok(text.includes("Shell Folders"), "桌面目录要按注册表真实值取：OneDrive 重定向时 %USERPROFILE%\\Desktop 不是桌面");
  assert.ok(/chcp 65001/.test(text), "要先把控制台切到 UTF-8，重定向出来的报告才是 UTF-8");
  assert.ok(/--no-pause/.test(text), "要有给自动化用的 --no-pause");
  assert.ok(/if defined SC_PAUSE pause/.test(text), "结尾要在交互运行时停住，窗口不能一闪就没");
  assert.ok(!/%%\{/.test(text), "别用 curl -w 的 %%{...}（批处理里百分号会被吃掉）");
});

test(`${SCRIPT_NAME}：脱敏——不读 config.local.json、私钥与代理凭据`, () => {
  assert.ok(!/Get-Content/i.test(text), "这是纯 cmd 脚本，不该出现 PowerShell");
  // config.local.json 只允许作为「存在与否」被探测。
  for (const { line, number } of codeLines) {
    if (line.includes("config.local.json")) {
      assert.match(line, /^\s*(if (not )?exist|echo)\s/i, `第 ${number} 行碰了 config.local.json，只允许 if exist 判断存在性`);
      if (line.includes("config.local.json=YES")) {
        assert.ok(/content never read/i.test(line), `第 ${number} 行要写明内容不被读取`);
      }
    }
  }
  // 私钥只允许列文件名。
  for (const { line, number } of codeLines) {
    if (/\bid_\*|\bid_rsa|\bid_ed25519/.test(line)) {
      assert.match(line, /^\s*dir \/b\s/i, `第 ${number} 行碰了私钥文件，只允许 dir /b 列文件名`);
    }
  }
  // type 只能用来回显刚生成的报告，不能去读别的文件。
  for (const { line, number } of codeLines) {
    if (/^\s*type(\s|$)/i.test(line)) {
      assert.ok(line.includes("%SC_REPORT%"), `第 ${number} 行用 type 打印了报告以外的文件`);
    }
  }
  // 可能带凭据的注册表值：只报存在与否（值要丢弃），绝不原样进报告。
  for (const key of ["ProxyServer", "ProxyOverride", "AutoConfigURL"]) {
    const uses = codeLines.filter(({ line }) => line.includes(`/v ${key}`));
    assert.ok(uses.length > 0, `应当探测 ${key}`);
    for (const { line } of uses) {
      assert.match(line, />nul 2>&1/, `${key} 的值必须丢弃（>nul 2>&1），不能进报告`);
    }
  }
  // cmd 的环境变量名大小写不敏感：`if defined http_proxy` 对 HTTP_PROXY 同样成立，
  // 所以只按小写判一次，否则报告里会成对出现、分不出用户到底设的是哪个。
  for (const name of ["http_proxy", "https_proxy", "all_proxy"]) {
    assert.ok(text.includes(`if defined ${name}`), `${name} 只能用 if defined 报「已设置/未设置」`);
    assert.ok(!new RegExp(`echo %${name}%`, "i").test(text), `${name} 的值不能进报告`);
  }
  for (const upper of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    assert.ok(!new RegExp(`if defined ${upper}\\b`).test(text), `${upper} 与 ${upper.toLowerCase()} 是同一个变量，不要重复判`);
  }
});

test(`${SCRIPT_NAME}：每一项探测都容错，缺啥都不会让整份报告生不出来`, () => {
  assert.ok(/^echo\. >"%SC_REPORT%"$/m.test(text), "先创建报告文件，后面任何一步失败都还有东西可发");
  assert.ok(/where curl >nul 2>&1/.test(text), "curl 缺失时不能报错中断");
  assert.ok(/dir \/b \/o-d ".*" 2\^>nul/.test(text), "日志目录不存在时要静默跳过");
  assert.ok(/if not exist "%SC_DESKTOP%\\" set "SC_DESKTOP=%TEMP%"/.test(text), "桌面取不到时要退到 %TEMP%，而不是写不出去");
  assert.ok(/reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders" \/v Desktop 2\^>nul/.test(text));
  // errorlevel 判定：两条 if 的顺序有讲究——echo 会把 errorlevel 归零，
  // 所以「成功」那条必须先判，否则失败分支会跟着一起打印。
  const elPairs = [
    ["if not errorlevel 1 echo IsAdmin=yes", "if errorlevel 1 echo IsAdmin=no"],
    ["if not errorlevel 1 echo ProxyServerKey=present", "if errorlevel 1 echo ProxyServerKey=absent"],
  ];
  for (const [ok, bad] of elPairs) {
    const okIndex = lines.findIndex((line) => line.startsWith(ok));
    const badIndex = lines.findIndex((line) => line.startsWith(bad));
    assert.ok(okIndex >= 0 && badIndex >= 0, `缺少 errorlevel 分支：${ok} / ${bad}`);
    assert.ok(okIndex < badIndex, `「成功」分支必须排在前面：${ok}`);
  }
  // 报告至少要覆盖安装器会拦人的那几个点，否则同事跑完还是没线索。
  for (const probe of [
    "ver",
    "/v CurrentBuildNumber",
    "PROCESSOR_ARCHITEW6432",
    "where node",
    "cluster-workbench\\node\\node.exe",
    "where ssh",
    "ssh -V",
    "where git",
    "package.json",
    "\\.git",
    "work\\runtime",
    "known_hosts",
    "netstat -ano",
  ]) {
    assert.ok(text.includes(probe), `报告缺少 ${probe} 这一项`);
  }
});
