// 向导接线（源码级）：从 onboarding-quit-wiring.test.mjs 迁来，只断言向导自己的源码与导出。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// 向导入口 + scripts/setup/ 下拆出的全部步骤模块（不含测试）。
const wizardSources = () => [
  "scripts/setup-wizard.mjs",
  ...readdirSync(path.join(root, "scripts/setup"))
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .map((name) => `scripts/setup/${name}`),
];

test("向导的个人层路径尊重 CODEX_MONITOR_LOCAL_CONFIG_PATH（打包 .app 的个人层不在 cwd）", () => {
  const files = wizardSources();
  assert.ok(files.length > 5, `向导源码清单异常：${files.join(", ")}`);
  assert.ok(files.some((rel) => /process\.env\.CODEX_MONITOR_LOCAL_CONFIG_PATH/.test(read(rel))), "个人层路径必须尊重覆盖变量");
  for (const rel of files) {
    assert.doesNotMatch(read(rel), /path\.resolve\(process\.cwd\(\), "config\.local\.json"\)/, `${rel}：所有个人层读写都应经 defaultLocalConfigPath()`);
  }
});

test("reclaude drop-in 经 buildRemoteReplaceFileCommand 单条原子命令写入（E4：不再 mkdir + 裸 cat > 两次 SSH）", () => {
  const src = read("scripts/setup/routing.mjs");
  const start = src.indexOf("function configureReclaudeRouting");
  const end = src.indexOf("\n// ---- ", start);
  assert.ok(start > 0 && end > start, "reclaude 一步的源码边界没找到");
  const body = src.slice(start, end);
  assert.match(body, /buildRemoteReplaceFileCommand\(\{ targetFile: dropinPath, content: dropinContent \}\)/);
  // v2.57：执行器可注入（ssh = runSsh），调用点写成 ssh(…)。
  assert.match(body, /\bssh\(server\.host, writeDropin, \{ timeoutMs: SSH_WRITE_TIMEOUT_MS \}\)/);
  assert.doesNotMatch(body, /\b(?:runSsh|ssh)\([^\n]*`cat > /, "不得再用裸 cat > 覆盖目标文件");
  assert.doesNotMatch(body, /\b(?:runSsh|ssh)\(server\.host, `mkdir -p/, "建目录已并入原子命令");
});

test("v2.54 终审：routing.mjs 交给 SSH 执行器的命令一律经 wrapSh 包成 sh -c（对方登录 shell 可能是 tcsh / csh）", () => {
  const src = read("scripts/setup/routing.mjs");
  // 执行器可注入（ssh = runSsh），两种写法的调用点都要查。
  const calls = [...src.matchAll(/\b(?:runSsh|ssh)\(\s*server\.host,\s*([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 6, `SSH 调用数异常：${calls.join(" | ")}`);
  for (const arg of calls) {
    if (arg.startsWith("wrapSh(")) continue;
    assert.match(src, new RegExp(`const ${arg} = wrapSh\\(`), `SSH 的命令 ${arg} 没有经 wrapSh`);
  }
});

test("v2.54：向导的 codex 一步换成集群侧受管配置，不再写 codex 包装脚本 / .bashrc 代理块", () => {
  const src = read("scripts/setup/routing.mjs");
  const routing = src.slice(src.indexOf("export async function configureRouting"), src.indexOf("\n}\n", src.indexOf("export async function configureRouting")));
  assert.match(
    routing,
    /await configureClusterEnv\(server, remotePort, \{ noProxyExtra: readNoProxyExtra\(server\.id\), proxyAuth: readLocalProxyAuth\(\) \}\);/,
    "v2.57：带上个人层的内网直连名单；v2.64：带上本机的代理口令（重跑不冲掉集群上的口令）",
  );
  assert.match(routing, /configureReclaudeRouting\(server, remotePort\);/, "reclaude 一步保留");
  assert.match(routing, /configureZcodeRouting\(server, remotePort\);/, "zcode 一步保留");
  assert.doesNotMatch(src, /configureCodexRouting|renderCodexProxyEnv/);
  assert.match(read("scripts/setup-wizard.mjs"), /await configureRouting\(server01, remotePort\);/);
});

test("v2.57 第 2 期：向导顺序 集群侧配置 → CLI 检测 / 安装（5）→ 登录（6）→ 依赖检查（7），步骤编号连续", () => {
  const main = read("scripts/setup-wizard.mjs");
  const routing = main.indexOf("await configureRouting(server01, remotePort);");
  const install = main.indexOf("await installClis(server01);");
  const login = main.indexOf("await loginStep(server01, remotePort);");
  assert.ok(routing > 0 && install > routing && login > install, "集群侧配置之后先装 CLI，再登录");
  const headers = [
    ["scripts/setup/ssh-keys.mjs", "1"],
    ["scripts/setup/port-assignment.mjs", "3"],
    ["scripts/setup/routing.mjs", "4"],
    ["scripts/setup/cli-install.mjs", "5"],
    ["scripts/setup/cli-login.mjs", "6"],
    ["scripts/setup/summary.mjs", "7"],
  ];
  for (const [rel, n] of headers) {
    assert.match(read(rel), new RegExp(`logHeader\\("${n}\\. `), `${rel} 的步骤标题应是第 ${n} 步`);
  }
  // 入口文件头的步骤清单与之一致。
  assert.match(main, /cli-install\.mjs\s+5\. /);
  assert.match(main, /cli-login\.mjs\s+6\. /);
  assert.match(main, /summary\.mjs\s+7\. /);
});
