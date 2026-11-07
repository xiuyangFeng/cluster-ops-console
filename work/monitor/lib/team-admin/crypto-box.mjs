// 团队管理配置信封加解密（零依赖，纯 node:crypto）：X25519 ECDH + HKDF-SHA256 + AES-256-GCM。
//
// 为什么在 Node 层做非对称信封：
//   - 管理员在集群上是普通账号，没有 root，不能直接写成员的 ~/.config/cluster-workbench/keys/；
//   - 下发文件落在公共目录 /public/agent-hub/assigned/<user>.enc（0644），任何集群用户都能读到字节，
//     所以 API key 绝不能以明文或固定口令存放；
//   - 成员端把私钥存在自己集群家目录 ~/.config/cluster-workbench/box.key（0600，内核保证仅本人可读），
//     公钥发在 /public/agent-hub/pubkeys/<user>.pub（0644，管理员按 stat 属主核验确系本人）。
//     这样成员换电脑（办公室/家里）登录同一个集群账号也能用同一把私钥解密，且集群无需安装 age / jq 等额外工具。

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

export const ENVELOPE_VERSION = 1;
const AAD_PREFIX = "cwb-team-assigned-v1";
const BASE64URL_RE = /^[A-Za-z0-9_-]{16,16384}$/;

// 脱敏 API Key：保留前 4 位与后 4 位（短密钥仅保留后 2 位），供界面回显与成员端 ACK 核对。
// 绝不在 summary、日志或状态快照里返回原始 key。
export function maskApiKey(apiKey) {
  if (typeof apiKey !== "string") return "";
  const trimmed = apiKey.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return `***${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

// 生成成员的 X25519 密钥对（DER 编码转 base64url 单行字符串，方便在 shell / JSON 中无损传输）。
export function generateMemberKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    publicKey: publicKey.toString("base64url"),
    privateKey: privateKey.toString("base64url"),
  };
}

export function parseMemberPublicKey(pubKeyStr) {
  if (typeof pubKeyStr !== "string") return null;
  const trimmed = pubKeyStr.trim();
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(trimmed)) return null;
  try {
    const keyObj = createPublicKey({
      key: Buffer.from(trimmed, "base64url"),
      format: "der",
      type: "spki",
    });
    return keyObj.asymmetricKeyType === "x25519" ? keyObj : null;
  } catch {
    return null;
  }
}

export function parseMemberPrivateKey(privKeyStr) {
  if (typeof privKeyStr !== "string") return null;
  const trimmed = privKeyStr.trim();
  if (!/^[A-Za-z0-9_-]{40,160}$/.test(trimmed)) return null;
  try {
    const keyObj = createPrivateKey({
      key: Buffer.from(trimmed, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    return keyObj.asymmetricKeyType === "x25519" ? keyObj : null;
  } catch {
    return null;
  }
}

export function isValidPublicKey(pubKeyStr) {
  return parseMemberPublicKey(pubKeyStr) !== null;
}

export function isValidPrivateKey(privKeyStr) {
  return parseMemberPrivateKey(privKeyStr) !== null;
}

// 从成员私钥导出对应的公钥字符串（用于校验集群上的 pubkeys/<me>.pub 是否与 ~/.config/.../box.key 匹配）。
export function derivePublicKeyFromPrivate(privKeyStr) {
  const privObj = parseMemberPrivateKey(privKeyStr);
  if (!privObj) return null;
  try {
    const pubObj = createPublicKey(privObj);
    return pubObj.export({ type: "spki", format: "der" }).toString("base64url");
  } catch {
    return null;
  }
}

function summarizeCliSpec(spec) {
  if (!spec || typeof spec !== "object") return null;
  if (spec.mode === "revoke") return { mode: "revoke" };
  if (spec.mode === "official") {
    return {
      mode: "official",
      keyMask: maskApiKey(spec.apiKey),
    };
  }
  if (spec.mode === "relay") {
    return {
      mode: "relay",
      baseUrl: typeof spec.baseUrl === "string" ? spec.baseUrl.trim() : "",
      providerId: typeof spec.providerId === "string" ? spec.providerId.trim() : null,
      providerName: typeof spec.providerName === "string" ? spec.providerName.trim() : null,
      keyMask: maskApiKey(spec.apiKey),
    };
  }
  return null;
}

// 信封外层摘要（不含任何明文密钥，且納入 AES-GCM AAD 防篡改）：让管理员在换电脑或刷新页面时也能看到已下发的配置概览。
export function buildEnvelopePublicSummary(payload) {
  if (!payload || typeof payload !== "object") return { codex: null, claude: null };
  return {
    codex: summarizeCliSpec(payload.codex),
    claude: summarizeCliSpec(payload.claude),
  };
}

function buildAadBuffer({ v, rev, assignedAt, summary }) {
  return Buffer.from(`${AAD_PREFIX}|${v}|${rev}|${assignedAt}|${JSON.stringify(summary || {})}`, "utf8");
}

// 用成员公钥将下发配置加密为 JSON 信封对象。
export function sealAssignedPayload(payload, memberPubKeyStr, { rev = 1, assignedAt = new Date().toISOString() } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("sealAssignedPayload: payload 必须是对象");
  }
  const memberPub = parseMemberPublicKey(memberPubKeyStr);
  if (!memberPub) {
    throw new Error("sealAssignedPayload: 无效的成员公钥");
  }
  const normalizedRev = Number.isInteger(rev) && rev >= 1 ? rev : 1;
  const normalizedAt = typeof assignedAt === "string" && assignedAt.trim() ? assignedAt.trim() : new Date().toISOString();
  const summary = buildEnvelopePublicSummary(payload);

  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: memberPub });
  const iv = randomBytes(12);
  const aad = buildAadBuffer({ v: ENVELOPE_VERSION, rev: normalizedRev, assignedAt: normalizedAt, summary });
  const aesKey = Buffer.from(hkdfSync("sha256", shared, iv, aad, 32));

  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: ENVELOPE_VERSION,
    rev: normalizedRev,
    assignedAt: normalizedAt,
    summary,
    ephPub: eph.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ct: ct.toString("base64url"),
  };
}

// 用成员私钥解开加密信封，还原原始 payload。任何密文或外层元数据（rev / assignedAt / summary）被改动都会抛错。
export function openAssignedEnvelope(envelope, memberPrivKeyStr) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("openAssignedEnvelope: 信封格式无效");
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`openAssignedEnvelope: 不支持的信封版本 ${JSON.stringify(envelope.v)}`);
  }
  const memberPriv = parseMemberPrivateKey(memberPrivKeyStr);
  if (!memberPriv) {
    throw new Error("openAssignedEnvelope: 无效的成员私钥");
  }
  const ephPub = parseMemberPublicKey(envelope.ephPub);
  if (!ephPub) {
    throw new Error("openAssignedEnvelope: 信封中的临时公钥无效");
  }
  if (
    typeof envelope.iv !== "string" || !BASE64URL_RE.test(envelope.iv) ||
    typeof envelope.tag !== "string" || !BASE64URL_RE.test(envelope.tag) ||
    typeof envelope.ct !== "string" || !/^[A-Za-z0-9_-]+$/.test(envelope.ct)
  ) {
    throw new Error("openAssignedEnvelope: 信封密文字段缺失或损坏");
  }
  const rev = Number(envelope.rev);
  const assignedAt = typeof envelope.assignedAt === "string" ? envelope.assignedAt : "";
  if (!Number.isInteger(rev) || rev < 1 || !assignedAt) {
    throw new Error("openAssignedEnvelope: 信封版本号或时间无效");
  }

  const iv = Buffer.from(envelope.iv, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  const ct = Buffer.from(envelope.ct, "base64url");
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("openAssignedEnvelope: IV 或认证标签长度异常");
  }

  const shared = diffieHellman({ privateKey: memberPriv, publicKey: ephPub });
  const aad = buildAadBuffer({ v: ENVELOPE_VERSION, rev, assignedAt, summary: envelope.summary });
  const aesKey = Buffer.from(hkdfSync("sha256", shared, iv, aad, 32));

  const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}
