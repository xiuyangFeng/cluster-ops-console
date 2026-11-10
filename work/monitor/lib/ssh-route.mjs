import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafeHost, assertSafePort, attachPersonalSsh } from "./ssh-args.mjs";
import { resolveKnownHostsIfPresent } from "./host-key-policy.mjs";

export const SSH_JUMP_EXTRA_TIMEOUT_MS = 10000;

export function sshEndpoint(server) {
  return assertSafeHost(server.sshHostName || server.address?.host || server.address || server.host);
}

export function resolveSshRoute(server, config) {
  const destination = attachPersonalSsh(server, config);
  if (!server.sshJumpServerId) return [destination];
  const jump = config.servers?.find((s) => s.id === server.sshJumpServerId);
  if (!jump || jump.disabled || jump.monitorEnabled === false || jump.id === server.id || jump.sshJumpServerId) {
    throw Object.assign(new Error("跳转连接不可用：请选择已启用的公网直连配置；不支持循环或多级跳转"), { code: "route-invalid" });
  }
  return [attachPersonalSsh(jump, config), destination];
}

// 只写 SSH 的地址、身份文件与认证策略，密码始终在 askpass 内存通道里。
// ProxyJump 的子 ssh 继承 -F，因此跳板与目标可以各用不同用户名、密钥或密码。
const quoted = (value) => {
  if (/[\r\n\0]/.test(String(value))) throw new Error("SSH 配置包含非法控制字符");
  return `"${String(value).replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
};

export function createJumpConfig(route, { helperDir, dataDir, homeDir = os.homedir() } = {}) {
  if (route.length < 2) return null;
  const [jump, destination] = route;
  if (!helperDir) throw new Error("跳转连接服务不可用");
  mkdirSync(helperDir, { recursive: true, mode: 0o700 });
  const alias = `codex-jump-${randomBytes(8).toString("hex")}`;
  const file = path.join(helperDir, `${alias}.conf`);
  const lines = [];
  for (const [server, host] of [[jump, alias], [destination, destination.host]]) {
    lines.push(`Host ${assertSafeHost(host)}`, `  HostName ${sshEndpoint(server)}`, `  Port ${assertSafePort(server.sshPort || 22)}`,
      "  StrictHostKeyChecking yes", "  UpdateHostKeys no", "  ForwardAgent no", "  ControlMaster no", "  ControlPath none", "  ConnectTimeout 10");
    if (server.sshUser) lines.push(`  User ${server.sshUser}`);
    if (server.sshIdentityFile) lines.push(`  IdentityFile ${quoted(server.sshIdentityFile)}`, "  IdentitiesOnly yes");
    const pin = resolveKnownHostsIfPresent(dataDir, server.id);
    if (pin) lines.push(`  UserKnownHostsFile ${quoted(pin)}`, "  GlobalKnownHostsFile /dev/null");
    lines.push(...(server.authRef ? ["  BatchMode no", "  NumberOfPasswordPrompts 1", "  PreferredAuthentications password", "  PasswordAuthentication yes", "  KbdInteractiveAuthentication no", "  PubkeyAuthentication no"] : ["  BatchMode yes"]));
  }
  const userConfig = path.join(homeDir, ".ssh", "config");
  if (existsSync(userConfig)) lines.push("Host *", `  Include ${quoted(userConfig)}`);
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
  return { args: ["-F", file, "-o", `ProxyJump=${alias}`, "-o", "ControlMaster=no", "-o", "ControlPath=none"], dispose: () => { try { unlinkSync(file); } catch {} } };
}
