// 凭证运行时：credential vault 客户端 + SSH 执行器（askpass 取密码走 vault）。
// Electron 注入 CODEX_MONITOR_VAULT_URL/TOKEN 时连它的 vault；否则（Web 模式）在本进程起一个
// 内存 vault 并经 loopback HTTP 暴露给独立 supervisor。

import { randomBytes } from "node:crypto";
import path from "node:path";

import { createHttpVaultClient, createMemoryVault } from "../lib/credential-vault.mjs";
import { createSshRuntimeExecutor } from "../lib/ssh-runtime.mjs";
import { createVaultHttpServer } from "../lib/vault-ipc.mjs";

// fixture 模式（隔离实例：热更新的包冒烟、浏览器冒烟、自更新自检、界面预览）下 ssh / scp 的合成结果。
// 形状与 ssh-runtime 自己合成的「没发出去」结果相同：255、无输出、stderr 说明原因。
export const FIXTURE_SSH_BLOCKED = "fixture: fixture 模式不发起真实 SSH";

// fixture 模式的兜底闸：经执行器的 ssh / scp 一律不起进程，按上面的合成结果返回。
// 隔离实例读的团队配置里是真实主机——2026-10-12 一次界面预览就因为某个面板一可见就查状态，
// 对真实集群发了只读 SSH。各功能自己的 fixture 假数据是第一道，这里保证漏掉的也发不出去。
// 不回调 onSshResult：没有发过 ssh，不能当成探针退避的证据。
export function guardFixtureSsh(execute) {
  return async function executeGuarded(command, args, options) {
    if (command === "ssh" || command === "scp") {
      return { code: 255, stdout: "", stderr: FIXTURE_SSH_BLOCKED, timedOut: false, truncated: false };
    }
    return execute(command, args, options);
  };
}

// env 在生产中必须就是 process.env：自建 vault 的端点写回 env 后，supervisor 由
// channel-lifecycle 以 process.env 派生——这一步必须在任何 supervisor spawn 之前完成
// （start.mjs 在 listen / 守护巡检之前 await 本工厂）。
// onSshResult：每次真实 ssh 执行结束后的回调（探针退避的证据来源，见 server/probe-backoff.mjs）。
// fixtureMode：执行器套上 guardFixtureSsh。
export async function createCredentialRuntime({ env = process.env, getConfig, runtimeDir, dataDir, rootDir, onSshResult = null, fixtureMode = false }) {
  const credentialVault = env.CODEX_MONITOR_VAULT_URL && env.CODEX_MONITOR_VAULT_TOKEN
    ? createHttpVaultClient({
      baseUrl: env.CODEX_MONITOR_VAULT_URL,
      token: env.CODEX_MONITOR_VAULT_TOKEN,
    })
    : createMemoryVault();
  // Web 模式的内存 vault 也服务于独立 supervisor；只把引用和 loopback 通道
  // 传给子进程。重启后旧 mem: 引用失效，必须重新输入密码。
  let ownedVaultServer;
  if (!env.CODEX_MONITOR_VAULT_URL || !env.CODEX_MONITOR_VAULT_TOKEN) {
    const token = randomBytes(32).toString("hex");
    ownedVaultServer = createVaultHttpServer({ vault: credentialVault, token });
    const endpoint = await ownedVaultServer.listen();
    env.CODEX_MONITOR_VAULT_URL = endpoint.url;
    env.CODEX_MONITOR_VAULT_TOKEN = token;
  }
  const sshExecutor = createSshRuntimeExecutor({
    getConfig, credentialVault, dataDir,
    helperDir: path.join(runtimeDir, "askpass"), cwd: rootDir, onSshResult,
  });
  const executeRuntime = fixtureMode ? guardFixtureSsh(sshExecutor) : sshExecutor;

  return {
    credentialVault,
    executeRuntime,
    // 退出收尾：只关本进程自建的 vault 服务（Electron 的 vault 归主进程管）。
    closeOwnedVault() {
      if (!ownedVaultServer) return;
      ownedVaultServer.server.closeAllConnections();
      ownedVaultServer.server.close();
    },
  };
}
