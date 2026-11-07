// 远端反向端口探测（ssh 到服务器上看 remotePort 是否在监听）与密码隧道的取密码。
// runtimeDir 由调用方显式传入（supervisor 的运行时目录）：vault 端点文件与 askpass
// helper 目录都在它下面。
import path from "node:path";

import { execFileWithTimeout } from "../exec.mjs";
import { buildHostKeyArgs } from "../host-key-policy.mjs";
import {
  assertSafeHost,
  buildProbeControlArgs,
  buildRemotePortProbeCommand,
  buildSshIdentityArgs,
  buildSshPortArgs,
  SSH_CONTROL_ARGS,
} from "../ssh-args.mjs";
import { runWithPasswordSsh } from "../ssh-askpass.mjs";
import { readPasswordFromVaultEndpoints } from "../vault-endpoint-file.mjs";

// 注入了 credentialVault（测试 / 进程内调用）就用它；否则每次现读 vault 端点：
// runtimeDir/vault-endpoint.json（Electron 每次启动重写）优先，启动时环境变量兜底。
// "重启界面"后存活的 supervisor 环境变量里是旧实例的端口/token，只认 env 会让密码隧道
// 重连永久失败（见 lib/vault-endpoint-file.mjs）。
export async function readTunnelPassword(authRef, credentialVault, runtimeDir) {
  const password = credentialVault
    ? await credentialVault.get(authRef)
    : await readPasswordFromVaultEndpoints({ authRef, runtimeDir, env: process.env });
  if (!password) throw Object.assign(new Error("密码凭据已失效，请重新录入后重连"), { code: "auth-missing" });
  return password;
}

// 在隧道目标服务器上执行一条短命令（探测 / 残留会话回收共用同一套连接参数与密码认证）。
// 返回 execFileImpl 的原始结果（code / stdout / stderr / timedOut）。
export async function runRemoteCommand(config, command, { execFileImpl = execFileWithTimeout, timeoutMs = 6000, cwd, credentialVault, runtimeDir, askpassDir = runtimeDir ? path.join(runtimeDir, "askpass") : undefined, platform = process.platform } = {}) {
  // 探测 SSH 复用探针 ControlMaster（家目录路径，不是 runtimeDir / Application Support）。
  // 反向隧道本身仍不加 ControlMaster，见 buildTunnelArgs。
  // 钉扎了 known_hosts 时复用绑定到钉扎修订号的独立 socket（buildProbeControlArgs）——
  // 仅本探测命令；常驻隧道进程（buildTunnelArgs）依旧 -S none、绝不复用。
  const args = [
    ...(config.knownHostsPath
      ? buildProbeControlArgs({ platform, knownHostsPath: config.knownHostsPath, knownHostsRevision: config.knownHostsRevision, identity: config })
      : SSH_CONTROL_ARGS),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    ...buildHostKeyArgs({ knownHostsPath: config.knownHostsPath }),
    ...buildSshPortArgs(config.sshPort),
    ...buildSshIdentityArgs(config),
    assertSafeHost(config.host),
    command,
  ];
  const options = { timeoutMs, cwd };
  return config.authRef
    ? runWithPasswordSsh({ password: await readTunnelPassword(config.authRef, credentialVault, runtimeDir), helperDir: askpassDir, args, options, execFileImpl })
    : execFileImpl("ssh", args, options);
}

export async function remotePortOpen(config, options = {}) {
  const startedAt = Date.now();
  const result = await runRemoteCommand(config, buildRemotePortProbeCommand(config.remotePort), options);
  return {
    ok: result.code === 0 && !result.timedOut,
    durationMs: Date.now() - startedAt,
    timedOut: Boolean(result.timedOut),
  };
}
