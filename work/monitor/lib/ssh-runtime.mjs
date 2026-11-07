import { execFileWithInput, execFileWithTimeout } from "./exec.mjs";
import { createPasswordSshSession } from "./ssh-askpass.mjs";

// Credentials belong to an explicit server snapshot, never to an argv/host
// guess (two accounts may share an IP). Changed or removed targets fail closed.
const identity = (server) => JSON.stringify([
  server?.host, server?.sshPort || 22, server?.sshUser || "",
  server?.sshIdentityFile || "", server?.authRef || "",
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
  getConfig, credentialVault, helperDir, cwd,
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
    let session;
    try {
      const config = await getConfig();
      const current = config?.servers?.find((item) => item.id === (server?.id || serverId));
      const capturedIdentity = identity(current);
      if (!current || current.disabled || current.monitorEnabled === false
          || (server && identity(current) !== identity(server))) {
        return { code: 255, stdout: "", stderr: "config-changed: 服务器已停用或连接配置已变化，请重新执行", timedOut: false, truncated: false };
      }
      if (!current.authRef) return await run(command, withConnectTimeout(args), execOptions, current);
      const password = await credentialVault?.get(current.authRef);
      if (typeof password !== "string" || !password) {
        return { code: 255, stdout: "", stderr: "auth-required: 密码已过期或凭据不可用，请重新输入密码", timedOut: false, truncated: false };
      }
      // Vault access is asynchronous; do not send the credential to a target
      // that was edited while the lookup was in flight.
      const latest = (await getConfig())?.servers?.find((item) => item.id === current.id);
      if (!latest || latest.disabled || latest.monitorEnabled === false || identity(latest) !== capturedIdentity) {
        return { code: 255, stdout: "", stderr: "config-changed: 服务器连接配置已变化，请重新执行", timedOut: false, truncated: false };
      }
      session = await createSession({ password, helperDir, env: execOptions.env || process.env });
      const beforeSpawn = (await getConfig())?.servers?.find((item) => item.id === current.id);
      if (!beforeSpawn || beforeSpawn.disabled || beforeSpawn.monitorEnabled === false || identity(beforeSpawn) !== capturedIdentity) {
        return { code: 255, stdout: "", stderr: "config-changed: 服务器连接配置已变化，请重新执行", timedOut: false, truncated: false };
      }
      return await run(command, [...session.args, ...withConnectTimeout(args)], { ...execOptions, env: session.env }, current);
    } catch (error) {
      // Do not echo vault/askpass exception text: implementations may include
      // response bodies or a credential in an underlying exception.
      const message = error?.code === "password-unsupported"
        ? "password-unsupported: 此平台暂不支持密码 SSH，请使用密钥"
        : "auth-required: SSH 凭据暂不可用，请重新输入密码或检查凭据服务";
      return { code: 255, stdout: "", stderr: message, timedOut: false, truncated: false };
    } finally {
      await session?.dispose();
    }
  };
}
