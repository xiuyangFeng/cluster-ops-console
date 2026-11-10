import path from "node:path";
import { DEDICATED_KEY_NAME } from "./local-key.mjs";

// 本机文件只能证明密钥是否存在，不能证明服务器已授权或网络可达。
export function localReadiness({ fs, homeDir, server, config = {} }) {
  const privateKey = path.join(homeDir, ".ssh", DEDICATED_KEY_NAME);
  const present = (file) => { try { return fs.existsSync(file); } catch { return false; } };
  const privatePresent = present(privateKey);
  const publicPresent = present(`${privateKey}.pub`);
  const identity = String(server?.sshIdentityFile || config.sshIdentityFile || "").trim();
  const configuredPath = identity.startsWith("~/") || identity.startsWith("~\\")
    ? path.join(homeDir, identity.slice(2)) : path.isAbsolute(identity) ? identity : null;
  const configuredIdentityMissing = Boolean(configuredPath && !server?.authRef && !present(configuredPath));
  return {
    privatePresent, publicPresent, configuredIdentityMissing,
    keyState: privatePresent ? publicPresent ? "ready" : "recover-public" : "create",
    // 导入配置不会带私钥。明确配置的密钥丢失时，即使账号和端口齐全也要重新接入。
    needsLocalSetup: configuredIdentityMissing,
  };
}
