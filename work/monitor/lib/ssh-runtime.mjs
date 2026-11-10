import { execFileWithInput, execFileWithTimeout } from "./exec.mjs";
import { createPasswordSshSession } from "./ssh-askpass.mjs";
import { createJumpConfig, resolveSshRoute, sshEndpoint } from "./ssh-route.mjs";

// Credentials belong to an explicit server snapshot, never to an argv/host
// guess (two accounts may share an IP). Changed or removed targets fail closed.
const identity = (server) => JSON.stringify([
  server?.host, server?.sshPort || 22, server?.sshUser || "",
  server?.sshIdentityFile || "", server?.authRef || "",
  server?.sshJumpServerId || "", server?.sshHostName || "",
]);

// 控制面发出的 ssh / scp 统一带连接超时（与隧道同一个 10 秒）：对面是网络黑洞时 ssh 自己在 10 秒内
// 以 255 退出，不必占着探针的并发名额等到 15–45 秒的执行超时才被杀。只管建连与握手，不限制命令时长。
// 调用方自己给了 ConnectTimeout 的不动（ssh 对同名选项取第一个）。
export const SSH_CONNECT_TIMEOUT_SEC = 10;

export function withConnectTimeout(args, seconds = SSH_CONNECT_TIMEOUT_SEC) {
  const list = Array.isArray(args) ? args : [];
  if (list.some((arg) => /^-?o?ConnectTimeout[= ]/i.test(String(arg)))) return list;
  return ["-o", `ConnectTimeout=${seconds}`, ...list];
}

export function createSshRuntimeExecutor({
  getConfig, credentialVault, helperDir, dataDir, cwd,
  createSession = createPasswordSshSession,
  execFileImpl = (command, args, options) => options.input == null
    ? execFileWithTimeout(command, args, options)
    : execFileWithInput(command, args, options),
  // 每次真实的 ssh 执行结束后回调 ({ server, result })——探针退避据此判断这台主机连不连得上
  // （server/probe-backoff.mjs）。本函数自己合成的结果（配置已变 / 凭据不可用）没有发过 ssh，不回调。
  onSshResult = null,
} = {}) {
  const run = async (command, args, options, current) => {
    const result = await execFileImpl(command, args, options);
    if (onSshResult && command === "ssh") {
      try {
        onSshResult({ server: current, result });
      } catch {}
    }
    return result;
  };
  return async function execute(command, args, { server, serverId, ...options } = {}) {
    const execOptions = { cwd, ...options };
    if (command !== "ssh" && command !== "scp") return execFileImpl(command, args, execOptions);
    let session, jumpConfig;
    try {
      const config = await getConfig();
      const current = config?.servers?.find((item) => item.id === (server?.id || serverId));
      if (!current || current.disabled || current.monitorEnabled === false
          || (server && identity(current) !== identity(server))) {
        return { code: 255, stdout: "", stderr: "config-changed: 服务器已停用或连接配置已变化，请重新执行", timedOut: false, truncated: false };
      }
      const route = resolveSshRoute(current, config);
      const capturedIdentity = JSON.stringify(route.map(identity));
      const stillCurrent = async () => {
        const latestConfig = await getConfig();
        const latest = latestConfig?.servers?.find((item) => item.id === current.id);
        return latest && !latest.disabled && latest.monitorEnabled !== false
          && JSON.stringify(resolveSshRoute(latest, latestConfig).map(identity)) === capturedIdentity;
      };
      const passwords = [];
      for (const target of route) {
        if (!target.authRef) continue;
        const password = await credentialVault?.get(target.authRef);
        if (typeof password !== "string" || !password) {
          return { code: 255, stdout: "", stderr: "auth-required: 密码已过期或凭据不可用，请重新输入密码", timedOut: false, truncated: false };
        }
        passwords.push({ password, user: target.sshUser, host: sshEndpoint(target) });
      }
      // Vault access is asynchronous; do not send the credential to a target
      // that was edited while the lookup was in flight.
      if (!await stillCurrent()) {
        return { code: 255, stdout: "", stderr: "config-changed: 服务器连接配置已变化，请重新执行", timedOut: false, truncated: false };
      }
      if (passwords.length) session = await createSession({
        ...(route.length > 1 ? { passwords } : { password: passwords[0].password }),
        helperDir, env: execOptions.env || process.env, allowWindows: true,
      });
      jumpConfig = createJumpConfig(route, { helperDir, dataDir });
      if (!await stillCurrent()) {
        return { code: 255, stdout: "", stderr: "config-changed: 服务器连接配置已变化，请重新执行", timedOut: false, truncated: false };
      }
      const result = await run(command, [
        ...(current.authRef ? session.args : []), ...(jumpConfig?.args || []), ...withConnectTimeout(args),
      ], { ...execOptions, ...(session ? { env: session.env } : {}) }, current);
      if (!await stillCurrent()) return { code: 255, stdout: "", stderr: "config-changed: 连接配置已变化，已丢弃旧账号的采集结果", timedOut: false, truncated: false };
      return result;
    } catch (error) {
      // Do not echo vault/askpass exception text: implementations may include
      // response bodies or a credential in an underlying exception.
      const message = error?.code === "route-invalid" ? "route-invalid: 跳转连接不可用，请选择已启用的公网直连配置"
        : error?.code === "password-unsupported"
        ? "password-unsupported: 此平台暂不支持密码 SSH，请使用密钥"
        : "auth-required: SSH 凭据暂不可用，请重新输入密码或检查凭据服务";
      return { code: 255, stdout: "", stderr: message, timedOut: false, truncated: false };
    } finally {
      await session?.dispose();
      jumpConfig?.dispose();
    }
  };
}
