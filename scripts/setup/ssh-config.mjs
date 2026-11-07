// scripts/setup/ssh-config.mjs —— ~/.ssh 路径与 ~/.ssh/config 的 Host 段读写。
// upsert 是纯函数（剥旧段 + 追加新段，幂等；实现在 lib/ssh-config-block.mjs，与 App 内接入引导共用），
// 落盘统一走 tmp+rename 原子写，团队服务器步骤与个人服务器步骤共用同一套实现。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writePrivateFileAtomicSync } from "../../work/monitor/lib/atomic-file.mjs";
export { upsertSshConfigBlock } from "../../work/monitor/lib/ssh-config-block.mjs";
import { DRY_RUN, dryRunLog, logInfo, logWarning } from "./ui.mjs";

export const sshDir = path.join(os.homedir(), ".ssh");
export const sshConfigPath = path.join(sshDir, "config");

// 读 ssh config 全文；文件不存在或读不了按空串处理。
export function readSshConfigFile(filePath = sshConfigPath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

// ssh config 整份原子写回（文件 0600，写临时文件再 rename，失败清掉临时文件）。
// chmodDir:false —— ~/.ssh 是用户自己的目录，缺失时才按 0700 创建，已有目录的权限不去动。
export function writeSshConfigFile(filePath, content) {
  writePrivateFileAtomicSync(filePath, content, { chmodDir: false });
}

// 备份 ~/.ssh/config
export function backupSshConfig() {
  if (fs.existsSync(sshConfigPath)) {
    const timestamp = Date.now();
    const backupPath = `${sshConfigPath}.bak.${timestamp}`;
    if (DRY_RUN) {
      dryRunLog(`backup ${sshConfigPath} -> ${backupPath}`);
      return;
    }
    try {
      fs.copyFileSync(sshConfigPath, backupPath);
      logInfo(`已自动备份您现有的 SSH 配置文件到: ${backupPath}`);
    } catch (err) {
      logWarning(`备份 SSH 配置文件失败: ${err.message}`);
    }
  }
}
