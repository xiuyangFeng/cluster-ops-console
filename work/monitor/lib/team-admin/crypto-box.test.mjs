import assert from "node:assert/strict";
import test from "node:test";

import {
  derivePublicKeyFromPrivate,
  generateMemberKeyPair,
  isValidPrivateKey,
  isValidPublicKey,
  maskApiKey,
  openAssignedEnvelope,
  sealAssignedPayload,
} from "./crypto-box.mjs";

test("generateMemberKeyPair 与 derivePublicKeyFromPrivate：生成单行 base64url X25519 密钥对并能互推", () => {
  const pair = generateMemberKeyPair();
  assert.equal(isValidPublicKey(pair.publicKey), true);
  assert.equal(isValidPrivateKey(pair.privateKey), true);
  assert.equal(derivePublicKeyFromPrivate(pair.privateKey), pair.publicKey);
  assert.equal(isValidPublicKey("not-a-key"), false);
  assert.equal(isValidPrivateKey("not-a-key"), false);
});

test("sealAssignedPayload / openAssignedEnvelope：完整加解密往返，且信封外层绝不出现原始 API key", () => {
  const alice = generateMemberKeyPair();
  const bob = generateMemberKeyPair();
  const secretCodex = "key-codex-demo-1234567890";
  const secretClaude = "key-claude-demo-9876543210";
  const payload = {
    codex: {
      mode: "relay",
      baseUrl: "https://relay.example.com:8443/v1",
      providerId: "team-hub",
      providerName: "团队中转站",
      apiKey: secretCodex,
      acknowledgePlaintext: false,
    },
    claude: {
      mode: "official",
      apiKey: secretClaude,
    },
  };

  const env = sealAssignedPayload(payload, alice.publicKey, { rev: 3, assignedAt: "2026-10-16T10:00:00.000Z" });
  const serialized = JSON.stringify(env);
  assert.equal(serialized.includes(secretCodex), false, "信封 JSON 中不得包含明文 codex key");
  assert.equal(serialized.includes(secretClaude), false, "信封 JSON 中不得包含明文 claude key");
  assert.equal(env.rev, 3);
  assert.equal(env.summary.codex.keyMask, "key-…7890");
  assert.equal(env.summary.claude.keyMask, "key-…3210");

  // 本人私钥可正常解开
  const opened = openAssignedEnvelope(env, alice.privateKey);
  assert.deepEqual(opened, payload);

  // 其他同事的私钥解不开
  assert.throws(() => openAssignedEnvelope(env, bob.privateKey));

  // 篡改外层版本号 rev 或 summary 会触发 GCM AAD 校验失败
  assert.throws(() => openAssignedEnvelope({ ...env, rev: 4 }, alice.privateKey));
  assert.throws(() => openAssignedEnvelope({ ...env, summary: { codex: null, claude: null } }, alice.privateKey));
});

test("maskApiKey：保留首尾脱敏，短串兜底", () => {
  assert.equal(maskApiKey("sk-abcdef123456"), "sk-a…3456");
  assert.equal(maskApiKey("short12"), "***12");
  assert.equal(maskApiKey(""), "");
});
