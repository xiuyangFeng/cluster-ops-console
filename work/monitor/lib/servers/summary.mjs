// 服务器条目 → /api/servers 列表项的投影（纯函数）。前端服务器表格/表单按这个形状渲染，
// 改字段即改接口契约。凭据只投影成 authMethod / hasPersistedCredential，绝不回传引用本身。
import { isPersistedAuthRef } from "../credential-vault.mjs";

export function summarizeServer(server, { runtime, revision, hostKeyConfirmed } = {}) {
  const disabled = server?.disabled === true;
  const tunnelConfigured = server?.tunnel !== false;
  const tunnelEnabled = !disabled && tunnelConfigured;
  const lastTest = runtime?.lastTest || null;
  let state = "configured";
  if (disabled) state = "disabled";
  else if (runtime?.state) state = runtime.state;
  return {
    id: server.id,
    name: server.name || server.host || server.id,
    address: server.address || server.host,
    host: server.host,
    sshPort: server.sshPort || 22,
    sshUser: server.sshUser || null,
    sshIdentityFile: server.sshIdentityFile || "",
    remotePort: server.remotePort ?? null,
    localPort: server.localPort ?? null,
    source: server.source || "personal",
    disabled,
    tunnel: tunnelConfigured,
    monitorEnabled: !disabled,
    tunnelEnabled,
    authMethod: server.authRef ? (isPersistedAuthRef(server.authRef) ? "keychain" : "session-password") : (server.sshIdentityFile ? "identity-file" : "agent"),
    hasIdentityFile: Boolean(server.sshIdentityFile),
    hasPersistedCredential: isPersistedAuthRef(server.authRef),
    tags: Array.isArray(server.tags) ? server.tags : [],
    createdAt: server.createdAt || null,
    updatedAt: server.updatedAt || null,
    schemaVersion: server.schemaVersion || 1,
    revision: revision ?? null,
    state,
    lastTest: lastTest ? { code: lastTest.code, ok: lastTest.ok, checkedAt: lastTest.checkedAt } : null,
    hostKeyConfirmed: hostKeyConfirmed === true,
  };
}
