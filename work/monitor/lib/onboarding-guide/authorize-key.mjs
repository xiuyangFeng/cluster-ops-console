// 接入引导「用一次密码把公钥装到服务器」：系统 ssh + askpass 通道（lib/ssh-askpass.mjs），公钥经标准输入送达。
// 密码只在本进程内存里走一趟——不进 argv、不进环境变量、不落盘、不进日志。
//
// 这一步直接连真实地址（-l 用户 -p 端口 主机），不依赖 ~/.ssh/config 的别名：别名段要等公钥装好、
// 免密验证通过之后才写。主机密钥此前已由用户核对并写进 known_hosts，所以全程 StrictHostKeyChecking=yes。
import { buildHostKeyArgs } from "../host-key-policy.mjs";
import { createPasswordSshSession } from "../ssh-askpass.mjs";
import { assertSafeHost, assertSafePort, assertSafeSshUser, classifySshFailure } from "../ssh-args.mjs";
import { wrapSh } from "../shell/wrap-sh.mjs";

export const KEY_ADDED = "CWB_KEY_ADDED";
export const KEY_PRESENT = "CWB_KEY_PRESENT";

// 远端：建 ~/.ssh（700）→ 读一行公钥 → 已有同一行就不重复追加 → 追加前给没有结尾换行的旧文件补一个换行。
// 退出码 11/12/13 分别是建目录 / 没收到公钥 / 写文件失败。tr -d '\r'：Windows 管道可能带回车。
export const AUTHORIZE_REMOTE_COMMAND = wrapSh([
  "umask 077",
  'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" || exit 11',
  'f="$HOME/.ssh/authorized_keys"',
  "IFS= read -r key || true",
  `key=$(printf '%s' "$key" | tr -d '\\r')`,
  '[ -n "$key" ] || exit 12',
  'touch "$f" && chmod 600 "$f" || exit 13',
  `if grep -qxF -- "$key" "$f" 2>/dev/null; then echo ${KEY_PRESENT}; exit 0; fi`,
  `if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf '\\n' >> "$f" || exit 13; fi`,
  `printf '%s\\n' "$key" >> "$f" || exit 13`,
  `echo ${KEY_ADDED}`,
]);

const REMOTE_EXIT_MESSAGES = {
  11: "服务器上建不了 ~/.ssh 目录（家目录不可写或配额已满）",
  12: "服务器没有收到公钥内容",
  13: "服务器上写不了 ~/.ssh/authorized_keys（文件不可写或配额已满）",
};

function connectionArgs({ hostName, port, user, knownHostsPath }) {
  return [
    // 不传 knownHostsPath = 用户自己的 ~/.ssh/known_hosts（引导把核对过的指纹写在那里）。
    ...buildHostKeyArgs({ knownHostsPath }),
    "-o", "ConnectTimeout=10",
    "-p", String(assertSafePort(port, "sshPort")),
    "-l", assertSafeSshUser(user),
    assertSafeHost(hostName, "hostName"),
  ];
}

// 用专用密钥免密登录一次（BatchMode：要密码就立即失败）。→ { ok, code, detail }
//   code: "ok" | "auth"（公钥还没装）| "timeout" | "refused" | "dns" | "hostkey" | "rate-limit" | "unknown"
export async function probeKeyLogin({ exec, hostName, port, user, privateKeyPath, knownHostsPath } = {}) {
  const res = await exec("ssh", [
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ControlMaster=no", "-o", "ControlPath=none",
    "-i", privateKeyPath,
    ...connectionArgs({ hostName, port, user, knownHostsPath }),
    "echo CWB_LOGIN_OK",
  ], { timeoutMs: 20000 });
  if (res.code === 0 && String(res.stdout || "").includes("CWB_LOGIN_OK")) return { ok: true, code: "ok", detail: "" };
  const text = `${res.stderr || ""}\n${res.stdout || ""}`;
  const classified = res.timedOut ? { code: "timeout" } : classifySshFailure(text);
  return { ok: false, code: classified?.code || "unknown", detail: lastLine(res.stderr) };
}

function lastLine(text) {
  return String(text || "").trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
}

// 用密码登录一次并追加公钥。→ { ok, code, detail, already }
//   code: "ok" | "wrong-password" | "timeout" | "refused" | "dns" | "hostkey" | "rate-limit"
//       | "remote-write"（服务器上写不进去）| "channel"（密码通道本身没走通，退到手动命令）
// createSession 可注入（测试）。任何路径结束时会话都被 dispose。
export async function installPublicKeyWithPassword({
  exec, password, publicKey, hostName, port, user, knownHostsPath, helperDir,
  platform = process.platform, env = process.env, createSession = createPasswordSshSession,
} = {}) {
  let session;
  try {
    session = await createSession({ password, helperDir, env, platform, allowWindows: true });
  } catch (error) {
    return { ok: false, code: "channel", detail: String(error?.code || "askpass"), already: false };
  }
  try {
    const res = await exec("ssh", [
      ...session.args,
      ...connectionArgs({ hostName, port, user, knownHostsPath }),
      AUTHORIZE_REMOTE_COMMAND,
    ], { input: `${publicKey}\n`, env: session.env, timeoutMs: 45000 });
    const stdout = String(res.stdout || "");
    if (res.code === 0 && (stdout.includes(KEY_ADDED) || stdout.includes(KEY_PRESENT))) {
      return { ok: true, code: "ok", detail: "", already: stdout.includes(KEY_PRESENT) };
    }
    if (REMOTE_EXIT_MESSAGES[res.code]) return { ok: false, code: "remote-write", detail: REMOTE_EXIT_MESSAGES[res.code], already: false };
    const text = `${res.stderr || ""}\n${stdout}`;
    if (/Permission denied/i.test(text)) return { ok: false, code: "wrong-password", detail: "", already: false };
    const classified = res.timedOut ? { code: "timeout" } : classifySshFailure(text);
    if (classified && classified.code !== "auth") return { ok: false, code: classified.code, detail: lastLine(res.stderr), already: false };
    // 既不是密码错、也不是网络 / 指纹问题：多半是这台电脑的 ssh 没去调 askpass（旧版 OpenSSH for Windows）。
    return { ok: false, code: "channel", detail: lastLine(res.stderr), already: false };
  } finally {
    await session.dispose();
  }
}

// 密码通道走不通时给人复制的一行命令：在自己的终端里输一次密码，效果与上面相同。
// publicKeyPath 用绝对路径：cmd 与 PowerShell 对 %USERPROFILE% / ~ 的展开规则不一样。
export function buildManualAuthorizeCommand({ publicKeyPath, hostName, port, user, platform = process.platform } = {}) {
  const target = `${assertSafeSshUser(user)}@${assertSafeHost(hostName, "hostName")}`;
  const remote = "umask 077; mkdir -p ~/.ssh; tr -d '\\r' >> ~/.ssh/authorized_keys";
  const reader = platform === "win32" ? "type" : "cat";
  return `${reader} "${publicKeyPath}" | ssh -p ${assertSafePort(port, "sshPort")} ${target} "${remote}"`;
}
