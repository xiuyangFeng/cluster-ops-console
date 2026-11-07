// 管理员存储视图：服务器端安装脚本（纯函数，无 IO）。
//
// 管理员在本机终端执行一次：ssh -p <端口> root@<主机> 'sh -s' < <安装脚本>（输入 root 密码，首次会问主机指纹）。
// 脚本以 root 运行、可重复执行（升级同样再跑一遍）：
//   1. 写入 /usr/local/lib/codex-storage-admin/storage-admin.py（root:root 0755）；
//   2. 写入 /etc/codex-storage-admin.json（允许扫描的根）；建状态目录 /var/lib/codex-storage-admin（0700）；
//   3. 在 /root/.ssh/authorized_keys 里登记本机专用公钥，带 restrict + command=：
//      这把密钥只能触发上面的只读脚本——开不了 shell、不能转发端口 / X11 / agent、不能分配终端。
//      按密钥本身识别：重跑时只删「这把密钥」的旧行再加，别的电脑登记的存储管理密钥与其它密钥都不碰
//      （管理员在 Mac 与 Windows 上各有一把时互不影响）。
// 卸载脚本只删本机这把；没有任何电脑的存储管理密钥了，才一并删掉脚本、配置与状态目录。
import { isSafeRoot } from "./config.mjs";

export const KEY_COMMENT = "codex-storage-admin";
export const REMOTE_SCRIPT_PATH = "/usr/local/lib/codex-storage-admin/storage-admin.py";
const HEREDOC_MARK = "CODEX_STORAGE_ADMIN_PY_EOF";
const PUBKEY_RE = /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) ([A-Za-z0-9+/]{40,800}={0,3})(?: .*)?$/;

// 公钥文件内容 → 「类型 base64」（丢掉原注释）；不像公钥 → null。
export function parsePublicKey(text) {
  const line = String(text ?? "").trim().split(/\r?\n/)[0] || "";
  const m = PUBKEY_RE.exec(line);
  return m ? `${m[1]} ${m[2]}` : null;
}

// 从远端脚本源码里读出 VERSION = N。
export function scriptVersion(source) {
  const m = /^VERSION = (\d+)$/m.exec(String(source ?? ""));
  return m ? Number(m[1]) : null;
}

export function buildInstallScript({ publicKey, roots, source }) {
  const key = parsePublicKey(publicKey);
  if (!key) throw new Error("公钥格式不对");
  if (!Array.isArray(roots) || !roots.length || !roots.every(isSafeRoot)) throw new Error("允许扫描的根目录不合法");
  const src = String(source ?? "");
  if (!src || src.split("\n").some((line) => line.trim() === HEREDOC_MARK)) throw new Error("脚本源码不可用");
  const conf = JSON.stringify({ roots });
  const version = scriptVersion(src);
  return [
    "#!/bin/sh",
    `# 集群运维工作台 · 管理员存储视图：服务器端安装（版本 ${version}）。以 root 执行，可重复执行。`,
    "set -eu",
    "[ \"$(id -u)\" = 0 ] || { echo '请以 root 执行' >&2; exit 1; }",
    "PY=$(command -v python3 || true)",
    "[ -n \"$PY\" ] || { echo '服务器上没有 python3' >&2; exit 1; }",
    "case \"$PY\" in *[!A-Za-z0-9/._-]*) echo \"python3 路径含特殊字符：$PY\" >&2; exit 1 ;; esac",
    "DIR=/usr/local/lib/codex-storage-admin",
    "install -d -o root -g root -m 0755 \"$DIR\"",
    `cat > "$DIR/storage-admin.py.new" <<'${HEREDOC_MARK}'`,
    src.endsWith("\n") ? src.slice(0, -1) : src,
    HEREDOC_MARK,
    "chown root:root \"$DIR/storage-admin.py.new\"",
    "chmod 0755 \"$DIR/storage-admin.py.new\"",
    "mv -f \"$DIR/storage-admin.py.new\" \"$DIR/storage-admin.py\"",
    "install -d -o root -g root -m 0700 /var/lib/codex-storage-admin",
    `printf '%s\\n' '${conf}' > /etc/codex-storage-admin.json.new`,
    "chmod 0644 /etc/codex-storage-admin.json.new",
    "mv -f /etc/codex-storage-admin.json.new /etc/codex-storage-admin.json",
    "install -d -o root -g root -m 0700 /root/.ssh",
    "AK=/root/.ssh/authorized_keys",
    "[ -f \"$AK\" ] || { : > \"$AK\"; chmod 0600 \"$AK\"; }",
    `grep -v -F '${key.split(" ")[1]}' "$AK" > "$AK.codex-new" || true`,
    `printf '%s\\n' "restrict,command=\\"$PY ${REMOTE_SCRIPT_PATH}\\" ${key} ${KEY_COMMENT}" >> "$AK.codex-new"`,
    "chmod 0600 \"$AK.codex-new\"",
    "mv -f \"$AK.codex-new\" \"$AK\"",
    "\"$PY\" \"$DIR/storage-admin.py\" info > /dev/null",
    `echo "✅ 管理员存储视图已安装（版本 ${version}，$(hostname)，允许扫描：${roots.join(" ")}）"`,
    "",
  ].join("\n");
}

export function buildUninstallScript(publicKey) {
  const key = parsePublicKey(publicKey);
  if (!key) throw new Error("公钥格式不对");
  return [
    "#!/bin/sh",
    "# 集群运维工作台 · 管理员存储视图：服务器端卸载（只移除本机这把专用密钥）。以 root 执行。",
    "set -eu",
    "AK=/root/.ssh/authorized_keys",
    `if [ -f "$AK" ]; then grep -v -F '${key.split(" ")[1]}' "$AK" > "$AK.codex-new" || true; chmod 0600 "$AK.codex-new"; mv -f "$AK.codex-new" "$AK"; fi`,
    `if [ -f "$AK" ] && grep -q ' ${KEY_COMMENT}$' "$AK"; then`,
    "  echo '✅ 已移除本机的专用密钥（还有别的电脑在用存储管理，服务器端脚本保留）'",
    "else",
    "  rm -rf /usr/local/lib/codex-storage-admin /var/lib/codex-storage-admin",
    "  rm -f /etc/codex-storage-admin.json",
    "  echo '✅ 已卸载管理员存储视图（专用密钥与服务器端脚本都已移除）'",
    "fi",
    "",
  ].join("\n");
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// 在本机终端执行的那一行。
// Windows：给「命令提示符」（cmd）的写法——PowerShell 不支持 < 重定向，cmd 不认单引号。
// Windows 自带的 OpenSSH 从控制台读密码与主机指纹确认，stdin 被重定向也不影响。
export function buildInstallCommand(target, scriptPath, { platform = process.platform } = {}) {
  const port = target.port && target.port !== 22 ? `-p ${target.port} ` : "";
  if (platform === "win32") return `ssh ${port}root@${target.host} "sh -s" < "${scriptPath}"`;
  return `ssh ${port}root@${target.host} 'sh -s' < ${shq(scriptPath)}`;
}
