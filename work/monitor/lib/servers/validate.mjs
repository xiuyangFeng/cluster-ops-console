// 服务器条目的纯校验与整形（server-registry 新增 / 编辑共用；无 I/O、无状态）。
import { BASE_PORT_WRITE_MESSAGE, ConfigValidationError, isBlockedBasePortWrite } from "../config-loader.mjs";
import { assertSafeHost, assertSafePort, assertSafeSshUser } from "../ssh-args.mjs";
import { SERVER_ID_PATTERN as SAFE_ID_RE } from "../validators.mjs";

// 条目里绝不允许出现的明文凭据 / 远端命令字段：新增时逐个报错（顺序即报错顺序），
// 落盘与删除快照前再整体剥掉一遍。
const SECRET_FIELDS = ["password", "sshPassword", "privateKey", "identityData", "validationProfile", "sshpass"];

function slugId(name, host) {
  const raw = String(name || host || "server").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = raw && SAFE_ID_RE.test(raw) ? raw : `server-${Date.now().toString(36)}`;
  return base.slice(0, 48);
}

// 只写了 id + 开关/端口的条目：团队服务器的个人覆盖层，不是完整的个人服务器。
export function isOverrideOnly(entry) {
  return entry && !entry.host && !entry.address;
}

export function sanitizeEntry(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const out = { ...raw };
  for (const field of SECRET_FIELDS) delete out[field];
  return out;
}

// 新增 / 编辑提交的表单 → 规范化条目；任一字段不合规抛 ConfigValidationError（errors 逐字段）。
// legacy：编辑旧条目时传入原值——旧版没写 sshUser 的条目在身份未变时允许继续缺省；
// 也是 7891 豁免的依据（原值就是 7891 才能沿用，新增一律不收）。
export function validateServerInput(input = {}, { legacy = null, now = Date.now } = {}) {
  const errors = [];
  for (const field of SECRET_FIELDS) {
    if (Object.hasOwn(input, field)) errors.push({ field, message: "服务器配置不能携带明文凭据或远端命令" });
  }
  for (const field of ["disabled", "tunnel", "monitorEnabled", "tunnelEnabled"]) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") errors.push({ field, message: "开关必须是布尔值" });
  }
  const address = input.address || input.host;
  const name = input.name || address;
  if (!address) errors.push({ field: "address", message: "请填写地址或主机名" });
  if (input.sshPort !== undefined && input.sshPort !== null && input.sshPort !== "") {
    try { assertSafePort(input.sshPort, "sshPort"); } catch (err) { errors.push({ field: "sshPort", message: err.message }); }
  }
  try { if (address) assertSafeHost(String(address), "address"); } catch (err) { errors.push({ field: "address", message: err.message }); }
  const legacyIdentity = legacy && !legacy.sshUser && address === (legacy.address || legacy.host)
    && String(input.sshPort || 22) === String(legacy.sshPort || 22)
    && String(input.sshIdentityFile || "") === String(legacy.sshIdentityFile || "");
  if (!input.sshUser && !legacyIdentity) errors.push({ field: "sshUser", message: "个人服务器必须填写独立 SSH 用户名" });
  else if (input.sshUser) {
    try { assertSafeSshUser(String(input.sshUser).trim()); } catch (err) { errors.push({ field: "sshUser", message: err.message }); }
  }
  if (input.remotePort !== undefined && input.remotePort !== null && input.remotePort !== "") {
    try { assertSafePort(input.remotePort, "remotePort"); } catch (err) { errors.push({ field: "remotePort", message: err.message }); }
    if (isBlockedBasePortWrite(input.remotePort, legacy ? [Number(legacy.remotePort)] : [])) errors.push({ field: "remotePort", message: BASE_PORT_WRITE_MESSAGE });
  }
  if (input.localPort !== undefined && input.localPort !== null && input.localPort !== "") {
    try { assertSafePort(input.localPort, "localPort"); } catch (err) { errors.push({ field: "localPort", message: err.message }); }
  }
  if ((input.tunnel === true || input.tunnelEnabled === true) && !input.remotePort) errors.push({ field: "remotePort", message: "启用隧道必须填写反向端口" });
  if (input.id && !SAFE_ID_RE.test(String(input.id))) errors.push({ field: "id", message: "id 只允许字母/数字/下划线/点/连字符" });
  if (input.sshJumpServerId && (!SAFE_ID_RE.test(input.sshJumpServerId) || input.sshJumpServerId === input.id || input.tunnel === true || input.tunnelEnabled === true)) {
    errors.push({ field: "sshJumpServerId", message: "跳转请选择另一台公网直连配置；跳转连接仅用于监控，无需建立反向隧道" });
  }
  if (errors.length) throw new ConfigValidationError(errors[0].message || "服务器字段未通过校验", errors);
  return {
    id: input.id && SAFE_ID_RE.test(input.id) ? input.id : slugId(name, address),
    name: String(name),
    host: String(address),
    address: String(address),
    sshPort: input.sshPort ? Number(input.sshPort) : 22,
    ...(input.sshJumpServerId ? { sshJumpServerId: input.sshJumpServerId } : {}),
    ...(input.sshUser ? { sshUser: String(input.sshUser).trim() } : {}),
    sshIdentityFile: input.sshIdentityFile ? String(input.sshIdentityFile).trim() : undefined,
    ...(input.remotePort ? { remotePort: Number(input.remotePort) } : {}),
    localPort: input.localPort ? Number(input.localPort) : undefined,
    disabled: input.disabled === true || input.monitorEnabled === false,
    // 新增节点默认仅监控；需要反向隧道时由用户显式打开。
    tunnel: input.tunnel === true || input.tunnelEnabled === true,
    authRef: input.authRef || undefined,
    ...(input.description !== undefined ? { description: String(input.description) } : {}),
    tags: Array.isArray(input.tags) ? input.tags : [],
    createdAt: new Date(now()).toISOString(),
    updatedAt: new Date(now()).toISOString(),
    schemaVersion: 1,
  };
}
