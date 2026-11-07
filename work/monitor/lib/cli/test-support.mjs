// lib/cli 单测共用的夹具：在本机临时目录里造一个假的「集群 HOME」，用真实 /bin/sh 执行生成的远端命令
// （不 ssh、不碰真实 HOME、不联网）。fakebin 里放假的 uname（固定报 x86_64）与 curl（按 URL 吐出假的
// 官方安装脚本），假的官方安装器按环境变量决定成功 / 失败 / 卡住。
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { uploadViaSsh } from "./install.mjs";

export const sha256Of = (buf) => createHash("sha256").update(buf).digest("hex");

export function makeHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-home-"));
  const home = path.join(root, "home");
  const fixtures = path.join(root, "fixtures");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fixtures, { recursive: true });
  fs.mkdirSync(path.join(home, "fakebin"), { recursive: true });
  writeExec(path.join(home, "fakebin", "uname"), '#!/bin/sh\nif [ "$1" = "-m" ]; then echo x86_64; else /usr/bin/uname "$@"; fi\n');
  t?.after?.(() => {
    // 先停掉可能还在跑的假安装器（卡住用例），再删目录。
    spawnSync("pkill", ["-f", root]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, fixtures };
}

export function writeExec(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

export const envFor = (home, extra = {}) => ({ HOME: home, PATH: `${home}/fakebin:/usr/bin:/bin:/usr/sbin:/sbin`, LC_ALL: "C", ...extra });

// 同步执行一条远端命令串（wrapSh 的产物就是一条 `sh -c '…'`）。
export function runLocal(home, command, { input, env } = {}) {
  const res = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: envFor(home, env), input: input ?? "", timeout: 60000 });
  return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "", timedOut: Boolean(res.error && res.error.code === "ETIMEDOUT") };
}

// install.mjs 的 deps.remote：异步执行（官方路径的后台任务要在两次轮询之间真正跑起来）。
export function fakeRemote(home, { env, onCommand } = {}) {
  return (command) => new Promise((resolve) => {
    onCommand?.(command);
    const child = spawn("/bin/sh", ["-c", command], { env: envFor(home, env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr, timedOut: false }));
  });
}

// install.mjs 的 deps.upload：真实走 uploadViaSsh，只把 ssh 换成本机 sh（HOME 指向假家目录）。
export function fakeUpload(home, { env } = {}) {
  return ({ command, filePath, onProgress }) => uploadViaSsh({
    file: "/bin/sh",
    args: ["-c", command],
    filePath,
    onProgress,
    spawnImpl: (file, args, options) => spawn(file, args, { ...options, env: envFor(home, env) }),
  });
}

// 假 codex 官方包（package 布局）：bin/codex 报 "codex-cli <ver>"。
export function buildCodexPackage(fixtures, version, { omit = [] } = {}) {
  const dir = path.join(fixtures, `codex-src-${version}`);
  fs.rmSync(dir, { recursive: true, force: true });
  writeExec(path.join(dir, "bin", "codex"), `#!/bin/sh\necho "codex-cli ${version}"\n`);
  writeExec(path.join(dir, "bin", "codex-code-mode-host"), "#!/bin/sh\nexit 0\n");
  writeExec(path.join(dir, "codex-path", "rg"), "#!/bin/sh\nexit 0\n");
  writeExec(path.join(dir, "codex-resources", "bwrap"), "#!/bin/sh\nexit 0\n");
  fs.mkdirSync(path.join(dir, "codex-resources", "zsh"), { recursive: true });
  fs.writeFileSync(path.join(dir, "codex-package.json"), JSON.stringify({ layoutVersion: 1, version, target: "x86_64-unknown-linux-musl", entrypoint: "bin/codex" }));
  for (const rel of omit) fs.rmSync(path.join(dir, rel), { force: true });
  const fileName = "codex-package-x86_64-unknown-linux-musl.tar.gz";
  const out = path.join(fixtures, `${version}-${fileName}`);
  const res = spawnSync("tar", ["-czf", out, "-C", dir, "."]);
  if (res.status !== 0) throw new Error(`tar failed: ${res.stderr}`);
  const buf = fs.readFileSync(out);
  return { filePath: out, fileName, size: buf.length, sha256: sha256Of(buf), srcDir: dir };
}

// 假 Claude 原生二进制：sh 脚本报 "<ver> (Claude Code)"，补一行长注释让它超过 1MB（回滚只认 >1MB 的完整版本）。
export function buildClaudeBinary(fixtures, version) {
  const out = path.join(fixtures, `claude-${version}-linux-x64`);
  const pad = `# ${"x".repeat(1100 * 1024)}\n`;
  writeExec(out, `#!/bin/sh\necho "${version} (Claude Code)"\nexit 0\n${pad}`);
  const buf = fs.readFileSync(out);
  return { filePath: out, fileName: `claude-${version}-linux-x64`, size: buf.length, sha256: sha256Of(buf) };
}

export const readLink = (home, rel) => {
  try {
    return fs.readlinkSync(path.join(home, rel));
  } catch {
    return null;
  }
};

// 受管 env.sh（官方路径的前提）。extra 行用来把夹具路径传给假安装器。
export function writeEnvSh(home, extraLines = []) {
  const file = path.join(home, ".config", "cluster-workbench", "env.sh");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [`export PATH="${home}/fakebin:$HOME/.local/bin:$PATH"`, ...extraLines, ""].join("\n"), { mode: 0o600 });
}

// 假 curl：按 URL 把对应的假官方安装脚本写到 -o 指定的位置；其余 URL 失败。
// FAKE_INSTALLER_CODEX / FAKE_INSTALLER_CLAUDE 是两份假安装器的路径（经 env.sh 传入）。
export function installFakeCurl(home) {
  writeExec(path.join(home, "fakebin", "curl"), `#!/bin/sh
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    --connect-timeout|--retry|--max-time) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
case "$url" in
  https://chatgpt.com/codex/install.sh) cp "$FAKE_INSTALLER_CODEX" "$out" ;;
  https://claude.ai/install.sh) cp "$FAKE_INSTALLER_CLAUDE" "$out" ;;
  *) echo "fake curl: unexpected $url" >&2; exit 22 ;;
esac
`);
}

// 假 codex 官方安装器：模拟「下载到 $TMPDIR/tmp.x/」再按官方布局落盘。
// 下载文件的名字照真机上看到的来：官方 install.sh 实际把包下载到 tmp.XXXX/codex-package_SHA256SUMS
// （它的全局变量 archive_path 被校验清单那一步覆盖了），旁边还有个几字节的 profile.<pid>.tmp——
// 轮询不能按 *.tar.gz 认下载文件，「下载进度」那条用例就靠这个名字守着。
// FAKE_MODE=ok | fail（下载一半后退出 1）| hang（下载一半后一直睡、不再有任何输出）
//   | gate（下载完停住，等用例调 releaseFakeInstaller(home) 放行，最多等 30 秒）。
// gate 取代了原来的 slow（下载完固定睡 1 秒）：用例要断言「任务还在跑的时候」看到的东西（下载进度、
// 接管在跑的任务），机器一忙 1 秒就不够用——等用例亲眼看到之后再放行，不赌时序。
export const releaseFakeInstaller = (home) => fs.writeFileSync(path.join(home, "fake-installer-go"), "");

export function writeFakeCodexInstaller(fixtures, { version, srcDir }) {
  const file = path.join(fixtures, "fake-codex-install.sh");
  writeExec(file, `#!/bin/sh
echo "==> Installing Codex CLI"
echo "==> Downloading Codex CLI"
mkdir -p "$TMPDIR/tmp.fake"
printf 'profile\\n' > "$TMPDIR/tmp.fake/profile.$$.tmp"
dd if=/dev/zero of="$TMPDIR/tmp.fake/codex-package_SHA256SUMS" bs=1024 count=64 2>/dev/null
if [ "$FAKE_MODE" = fail ]; then echo "Download failed" >&2; exit 1; fi
if [ "$FAKE_MODE" = hang ]; then sleep 30; exit 1; fi
if [ "$FAKE_MODE" = gate ]; then n=0; while [ ! -e "$HOME/fake-installer-go" ] && [ "$n" -lt 600 ]; do sleep 0.05; n=$((n + 1)); done; fi
R="$HOME/.codex/packages/standalone"
N="${version}-x86_64-unknown-linux-musl"
mkdir -p "$R/releases" "$HOME/.local/bin"
rm -rf "$R/releases/$N"
cp -R "${srcDir}" "$R/releases/$N"
ln -sf bin/codex "$R/releases/$N/codex"
ln -sfn "$R/releases/$N" "$R/current"
printf '%s' "$N" > "$R/auto-update-version"
ln -sf "$R/current/bin/codex" "$HOME/.local/bin/codex"
echo "Codex CLI ${version} installed successfully."
`);
  return file;
}

export function writeFakeClaudeInstaller(fixtures, { version, binary }) {
  const file = path.join(fixtures, "fake-claude-install.sh");
  writeExec(file, `#!/bin/bash
mkdir -p "$HOME/.claude/downloads"
dd if=/dev/zero of="$HOME/.claude/downloads/claude-${version}-linux-x64" bs=1024 count=64 2>/dev/null
if [ "$FAKE_MODE" = fail ]; then echo "Checksum verification failed" >&2; exit 1; fi
if [ "$FAKE_MODE" = hang ]; then sleep 30; exit 1; fi
echo "Setting up Claude Code..."
V="$HOME/.local/share/claude/versions"
mkdir -p "$V" "$HOME/.local/bin"
cp "${binary}" "$V/${version}"
ln -sf "$V/${version}" "$HOME/.local/bin/claude"
rm -f "$HOME/.claude/downloads/claude-${version}-linux-x64"
echo "Installation complete!"
`);
  return file;
}
