// scripts/setup/ssh-keys.mjs —— 向导第 1 步：检测 / 生成本地 SSH 密钥（E6：绝不覆盖既有私钥）。
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEDICATED_KEY_NAME } from "../../work/monitor/lib/onboarding-guide/local-key.mjs";
import { sshDir } from "./ssh-config.mjs";
import { askQuestion, DRY_RUN, dryRunLog, logError, logHeader, logInfo, logSuccess, logWarning } from "./ui.mjs";

// 候选默认密钥类型（按优先级检测，命中第一个可用的即用）。
const DEFAULT_KEY_TYPES = ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"];
// 确需新建密钥时使用的专属文件名（DEDICATED_KEY_NAME，与 App 内接入引导同一个）——绝不复用/覆盖任何
// 默认密钥路径，即便某个默认类型此前因权限或部分写入等原因处于奇怪状态，也不会被这里的新建流程碰到。

// 纯函数（E6 修复核心）：根据"私钥是否存在"和"公钥是否存在"决定该怎么处理，绝不返回会
// 覆盖既有私钥的动作。
//   - 两者都在 → "reuse"：直接复用，什么都不做。
//   - 只有私钥（.pub 缺失，常见于只同步了私钥的场景）→ "regen-pub"：从私钥重新推导公钥
//     （ssh-keygen -y -f 私钥），绝不重新生成/覆盖私钥本身。旧实现会把这种情况误判成"无密钥"，
//     进而在向导语境下诱导用户对 generateSshKey() 的 "是否生成新密钥？" 回答 y，
//     ssh-keygen 遇到已存在的私钥文件会询问是否覆盖——一旦用户顺手按下 y，仍在其他地方使用的
//     私钥就被静默覆盖了。
//   - 两者都不在 → "create-new"：确实需要新建，调用方必须用专属文件名（DEDICATED_KEY_NAME），
//     不得使用任何默认密钥路径。
export function decideKeyAction({ privateExists, publicExists }) {
  if (privateExists && publicExists) return "reuse";
  if (privateExists && !publicExists) return "regen-pub";
  return "create-new";
}

// 检测 SSH 密钥。返回 { privateKeyPath, publicKeyPath, isDedicated } | null。
export function checkSshKeys() {
  logHeader("1. 检测本地 SSH 密钥 (SSH Key)");
  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }

  for (const key of DEFAULT_KEY_TYPES) {
    const priv = path.join(sshDir, key);
    const pub = path.join(sshDir, `${key}.pub`);
    const privateExists = fs.existsSync(priv);
    const publicExists = fs.existsSync(pub);
    const action = decideKeyAction({ privateExists, publicExists });

    if (action === "reuse") {
      logSuccess(`检测到已有本地 SSH 密钥，公钥路径: ${pub}`);
      return { privateKeyPath: priv, publicKeyPath: pub, isDedicated: false };
    }

    if (action === "regen-pub") {
      logWarning(`检测到私钥 ${priv} 存在但缺少对应公钥，正在从既有私钥重新生成公钥（绝不覆盖私钥本身）...`);
      if (DRY_RUN) {
        dryRunLog(`ssh-keygen -y -f "${priv}" > "${pub}"`);
        return { privateKeyPath: priv, publicKeyPath: pub, isDedicated: false };
      }
      try {
        const pubContent = execSync(`ssh-keygen -y -f "${priv}"`, { encoding: "utf8" });
        fs.writeFileSync(pub, pubContent, { mode: 0o644 });
        logSuccess(`已从既有私钥重新生成公钥: ${pub}`);
        return { privateKeyPath: priv, publicKeyPath: pub, isDedicated: false };
      } catch (err) {
        logError(`从私钥重新生成公钥失败: ${err.message}，尝试下一个候选密钥类型...`);
      }
    }

    // action === "create-new"：这个候选类型的私钥根本不存在，继续看下一个候选类型。
  }

  logWarning("未检测到本地 SSH 私钥与公钥对。本应用需要 SSH 免密证书以维护隧道连接。");
  return null;
}

// 引导生成 SSH 密钥。始终使用专属文件名（DEDICATED_KEY_NAME），绝不写入任何默认密钥路径，
// 因此也绝不会覆盖用户可能仍在其他地方使用的默认私钥。
export async function generateSshKey() {
  const answer = await askQuestion("是否现在为您自动生成一个新的 Ed25519 SSH 密钥对？(Y/n): ");
  if (answer.toLowerCase() === "n") {
    logWarning("已跳过密钥生成。您后续需要手动配置 SSH 密钥，否则隧道可能无法建立。");
    return null;
  }

  const newKeyPath = path.join(sshDir, DEDICATED_KEY_NAME);
  if (fs.existsSync(newKeyPath)) {
    logWarning(`专属密钥 ${newKeyPath} 已存在，直接复用（不重新生成，不覆盖）。`);
    return { privateKeyPath: newKeyPath, publicKeyPath: `${newKeyPath}.pub`, isDedicated: true };
  }
  if (DRY_RUN) {
    dryRunLog(`ssh-keygen -t ed25519 -N "" -f "${newKeyPath}"`);
    return { privateKeyPath: newKeyPath, publicKeyPath: `${newKeyPath}.pub`, isDedicated: true };
  }
  logInfo(`正在生成专属 Ed25519 密钥对到 ${newKeyPath}（使用专属文件名，绝不覆盖系统默认密钥）...`);
  try {
    // -N "" 表示空密码，-f 指定路径
    execSync(`ssh-keygen -t ed25519 -N "" -f "${newKeyPath}"`, { stdio: "inherit" });
    logSuccess("SSH 密钥对生成成功！");
    return { privateKeyPath: newKeyPath, publicKeyPath: `${newKeyPath}.pub`, isDedicated: true };
  } catch (err) {
    logError(`生成 SSH 密钥失败: ${err.message}`);
    return null;
  }
}
