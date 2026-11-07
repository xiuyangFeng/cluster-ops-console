// 接入引导用的本机专用密钥：始终是 ~/.ssh/id_ed25519_codextunnel（无口令），绝不读写任何默认密钥路径。
//
// 命令行向导会优先复用 id_ed25519 / id_rsa 等默认密钥；引导不这么做——默认密钥可能带口令
// （BatchMode 下永远过不去）、可能已被别的工具接管，专用密钥的行为才是确定的。
// 向导新建密钥时用的也是同一个文件名，两条路互相认得。
import nodeFs from "node:fs";
import path from "node:path";

export const DEDICATED_KEY_NAME = "id_ed25519_codextunnel";
// 写进公钥注释，authorized_keys 里一眼认得出是哪把（撤销时也按它找）。
export const DEDICATED_KEY_COMMENT = "cluster-workbench";

// OpenSSH 公钥行：类型 + base64 主体（最短的 ed25519 也有 68 个字符）+ 可选注释，单行。
const PUBLIC_KEY_LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+|sk-[\w@.-]+) [A-Za-z0-9+/]{32,}=*( [^\r\n]*)?$/;

export function parsePublicKeyLine(text) {
  const line = String(text || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  return PUBLIC_KEY_LINE.test(line) ? line : null;
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// exec：(cmd, args, { timeoutMs }) → { code, stdout, stderr, timedOut }（lib/exec.mjs 的形状，永不 reject）。
// 返回 { privateKeyPath, publicKeyPath, publicKey, created }。
//   私钥、公钥都在 → 直接用；只有私钥 → 从私钥重新推导公钥（不动私钥）；都没有 → 新建。
export async function ensureDedicatedKey({ sshDir, exec, fs = nodeFs } = {}) {
  if (!sshDir) throw new Error("ensureDedicatedKey 需要 sshDir");
  const privateKeyPath = path.join(sshDir, DEDICATED_KEY_NAME);
  const publicKeyPath = `${privateKeyPath}.pub`;
  // ~/.ssh 缺失时才按 0700 创建；已有目录的权限不去动（那是用户自己的目录）。
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });

  const readPublic = () => {
    try { return parsePublicKeyLine(fs.readFileSync(publicKeyPath, "utf8")); } catch { return null; }
  };
  let created = false;
  if (!fs.existsSync(privateKeyPath)) {
    // 只有 .pub 没有私钥：那份公钥没用，ssh-keygen 遇到已存在的 .pub 会停下来问，先挪走。
    if (fs.existsSync(publicKeyPath)) fs.renameSync(publicKeyPath, `${publicKeyPath}.orphan.${Date.now()}`);
    const made = await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", DEDICATED_KEY_COMMENT, "-f", privateKeyPath], { timeoutMs: 15000 });
    if (made.code !== 0 || !fs.existsSync(privateKeyPath)) {
      throw failure("keygen-failed", `生成密钥失败：${String(made.stderr || "").trim().split("\n").at(-1) || `ssh-keygen 退出码 ${made.code}`}`);
    }
    created = true;
  }
  let publicKey = readPublic();
  if (!publicKey) {
    const derived = await exec("ssh-keygen", ["-y", "-f", privateKeyPath], { timeoutMs: 10000 });
    publicKey = derived.code === 0 ? parsePublicKeyLine(derived.stdout) : null;
    if (!publicKey) {
      throw failure("pubkey-unreadable", `读不出 ${privateKeyPath} 的公钥（私钥可能带口令或已损坏）。可以把这两个文件改名后重试，引导会新建一把。`);
    }
    fs.writeFileSync(publicKeyPath, `${publicKey}\n`, { mode: 0o644 });
  }
  return { privateKeyPath, publicKeyPath, publicKey, created };
}
