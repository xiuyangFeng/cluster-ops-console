// ~/.ssh/config 的 User 解析（纯函数 + 薄读盘包装）。
// 原在 scripts/setup-wizard.mjs，抽到 lib 供 launch.mjs 首次运行检测与 /api/status.onboarding
// 共用同一套判定；向导仍从这里 re-export，既有导出与测试不变。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 从 ~/.ssh/config 文本中解析指定 Host 别名的 User。精确 Host 优先于 Host *。
// 绝不回落本机 OS 用户名——那会让 supervisor 的 `-l` 覆盖 ssh config 里正确的集群账号。
export function parseSshConfigUser(content, hostAlias) {
  if (!content || !hostAlias) return "";
  let exactUser = "";
  let wildcardUser = "";
  let currentPatterns = [];
  let currentUser = "";

  const considerSection = () => {
    if (!currentPatterns.length || !currentUser) return;
    if (currentPatterns.includes(hostAlias) && !exactUser) exactUser = currentUser;
    if (currentPatterns.includes("*") && !wildcardUser) wildcardUser = currentUser;
  };

  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    const hostMatch = line.match(/^\s*Host\s+(.+)$/i);
    if (hostMatch) {
      considerSection();
      currentPatterns = hostMatch[1].trim().split(/\s+/).filter(Boolean);
      currentUser = "";
      continue;
    }
    if (/^\s*Match\s+/i.test(line)) {
      considerSection();
      currentPatterns = [];
      currentUser = "";
      continue;
    }
    const userMatch = line.match(/^\s+User\s+(\S+)/i);
    if (userMatch) currentUser = userMatch[1];
  }
  considerSection();
  return exactUser || wildcardUser || "";
}

export function defaultSshConfigPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".ssh", "config");
}

// 读不到（不存在/无权限）一律按空处理：调用方把"解析不出 User"当作"需要配置"。
export function readSshConfigUser(hostAlias, { sshConfigPath = defaultSshConfigPath(), readFile = fs.readFileSync } = {}) {
  let content = "";
  try {
    content = readFile(sshConfigPath, "utf8");
  } catch {
    return "";
  }
  return parseSshConfigUser(content, hostAlias);
}
